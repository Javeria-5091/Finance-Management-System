-- =============================================================================
-- Migration 018: Protect financial/reconciliation history from cascade
--                deletes; block deletion of accounts/invoices with posted
--                history
-- =============================================================================
-- PURPOSE
--   The compliance audit found two `ON DELETE CASCADE` foreign keys that let
--   a normal delete of a parent row silently destroy financial history:
--     * bank_statements.financial_account_id -> finance.financial_accounts
--       (deleting a financial account cascades away ALL imported bank
--        statements and, transitively, all statement_lines / reconciliation
--        history for that account)
--     * credit_notes.invoice_id -> public.invoices
--       (deleting an invoice cascades away its credit notes)
--
--   This directly contradicts spec 5.8 ("Accounts used by posted
--   transactions cannot be deleted") and spec 10.5 / 24 (financial history
--   must be retained / immutable). The only existing guard was a role check
--   (`fa_delete ... USING (core.is_finance_head())`) -- a permission check,
--   not a usage check. A Finance Head performing an entirely ordinary
--   "delete this account" action could destroy reconciliation history.
--
-- ISSUES FIXED
--   - Spec 5.8: "Accounts used by posted transactions cannot be deleted"
--   - Spec 10.5 / 24: financial history is retained / immutable
--
-- APPROACH
--   1. Change both foreign keys from ON DELETE CASCADE to ON DELETE RESTRICT
--      (Postgres default is already effectively RESTRICT/NO ACTION, but we
--      state it explicitly so the intent is visible in the schema itself).
--   2. Add explicit BEFORE DELETE trigger functions that raise a clear,
--      business-readable error identifying *why* the delete was blocked and
--      *what* still references the row, rather than relying solely on the
--      less informative generic foreign-key-violation error. This also
--      covers the case where a future FK is added elsewhere without an
--      explicit RESTRICT.
--
-- SAFETY
--   Non-destructive. This migration can only make deletes that were
--   previously silently destructive now fail loudly instead -- it cannot
--   remove or alter any existing row. If any existing application workflow
--   currently *relies on* the cascade behavior (e.g. a "delete test account"
--   admin utility), that workflow will now receive an error instead of a
--   silent cascade; see Section E (Application Code Changes Required) in the
--   final response for the corresponding recommended app-side change
--   (deactivate via is_active/deleted_at instead of hard delete).
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------
-- 1. Tighten the two identified cascade-delete foreign keys
-- -----------------------------------------------------------------------

ALTER TABLE "finance"."bank_statements"
  DROP CONSTRAINT IF EXISTS "bank_statements_financial_account_id_fkey";

ALTER TABLE "finance"."bank_statements"
  ADD CONSTRAINT "bank_statements_financial_account_id_fkey"
  FOREIGN KEY ("financial_account_id")
  REFERENCES "finance"."financial_accounts"("id")
  ON DELETE RESTRICT;

ALTER TABLE "finance"."credit_notes"
  DROP CONSTRAINT IF EXISTS "credit_notes_invoice_id_fkey";

ALTER TABLE "finance"."credit_notes"
  ADD CONSTRAINT "credit_notes_invoice_id_fkey"
  FOREIGN KEY ("invoice_id")
  REFERENCES "public"."invoices"("id")
  ON DELETE RESTRICT;

-- -----------------------------------------------------------------------
-- 2. finance.financial_accounts -- explicit, business-readable delete guard
--    Blocks deletion if the account has ANY bank statements, bank
--    transfers, or is used as the settlement account on a tax payment/
--    refund. (Journal postings never reference financial_accounts directly
--    -- they post to finance.chart_of_accounts via linked_ledger_account_id
--    -- so that path is already protected independently by the default
--    RESTRICT behavior on journal_lines_account_id_fkey.)
-- -----------------------------------------------------------------------

CREATE OR REPLACE FUNCTION "finance"."prevent_used_financial_account_deletion"()
  RETURNS "trigger"
  LANGUAGE "plpgsql"
  AS $$
DECLARE
  v_statement_count INTEGER;
  v_transfer_count INTEGER;
  v_tax_payment_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO v_statement_count
  FROM finance.bank_statements
  WHERE financial_account_id = OLD.id;

  SELECT COUNT(*) INTO v_transfer_count
  FROM finance.bank_transfers
  WHERE from_account_id = OLD.id OR to_account_id = OLD.id;

  SELECT COUNT(*) INTO v_tax_payment_count
  FROM finance.tax_payments_and_refunds
  WHERE financial_account_id = OLD.id;

  IF v_statement_count > 0 OR v_transfer_count > 0 OR v_tax_payment_count > 0 THEN
    RAISE EXCEPTION
      'Cannot delete financial account "%": it has % bank statement(s), % transfer(s), and % tax payment/refund record(s) attached. Deactivate the account (is_active = false) instead of deleting it.',
      OLD.account_name, v_statement_count, v_transfer_count, v_tax_payment_count
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  RETURN OLD;
END;
$$;

ALTER FUNCTION "finance"."prevent_used_financial_account_deletion"() OWNER TO "postgres";

DROP TRIGGER IF EXISTS "trg_prevent_used_financial_account_deletion" ON "finance"."financial_accounts";

CREATE TRIGGER "trg_prevent_used_financial_account_deletion"
  BEFORE DELETE ON "finance"."financial_accounts"
  FOR EACH ROW
  EXECUTE FUNCTION "finance"."prevent_used_financial_account_deletion"();

-- -----------------------------------------------------------------------
-- 3. public.invoices -- explicit, business-readable delete guard
--    Blocks deletion once an invoice has been issued/posted (i.e. has a
--    linked journal entry) or has any payment allocation / credit note.
--    A pure DRAFT invoice with no postings or payments may still be
--    deleted normally.
-- -----------------------------------------------------------------------

CREATE OR REPLACE FUNCTION "public"."prevent_posted_invoice_deletion"()
  RETURNS "trigger"
  LANGUAGE "plpgsql"
  AS $$
DECLARE
  v_credit_note_count INTEGER;
  v_allocation_count INTEGER;
BEGIN
  IF OLD.journal_entry_id IS NOT NULL THEN
    RAISE EXCEPTION
      'Cannot delete invoice "%": it has already been posted to the general ledger (journal_entry_id = %). Void or reverse it instead.',
      OLD.invoice_number, OLD.journal_entry_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  SELECT COUNT(*) INTO v_credit_note_count
  FROM finance.credit_notes
  WHERE invoice_id = OLD.id;

  IF v_credit_note_count > 0 THEN
    RAISE EXCEPTION
      'Cannot delete invoice "%": it has % linked credit note(s).',
      OLD.invoice_number, v_credit_note_count
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  SELECT COUNT(*) INTO v_allocation_count
  FROM finance.payment_allocations
  WHERE invoice_id = OLD.id;

  IF v_allocation_count > 0 THEN
    RAISE EXCEPTION
      'Cannot delete invoice "%": it has % payment allocation(s) applied.',
      OLD.invoice_number, v_allocation_count
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  RETURN OLD;
END;
$$;

ALTER FUNCTION "public"."prevent_posted_invoice_deletion"() OWNER TO "postgres";

DROP TRIGGER IF EXISTS "trg_prevent_posted_invoice_deletion" ON "public"."invoices";

CREATE TRIGGER "trg_prevent_posted_invoice_deletion"
  BEFORE DELETE ON "public"."invoices"
  FOR EACH ROW
  EXECUTE FUNCTION "public"."prevent_posted_invoice_deletion"();

COMMIT;

-- =============================================================================
-- NOTE ON public.financial_accounts (the legacy duplicate table)
--   This migration deliberately does NOT modify public.financial_accounts.
--   That table's proper long-term fate is tied to the duplicate-table
--   decision described in 022_multitenancy_and_duplicate_table_notes.sql /
--   the final response (Section D/E) -- it needs a product decision on
--   which of the two financial_accounts tables is canonical before further
--   schema changes are made to the legacy one. No FK currently cascades
--   away history from it (it has no inbound foreign keys at all in the
--   current schema), so it does not carry the same immediate data-loss risk
--   as finance.financial_accounts did.
-- =============================================================================