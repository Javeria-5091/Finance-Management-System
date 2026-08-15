-- ============================================================================
-- Migration: 028_attach_orphaned_triggers.sql
-- Purpose:   ROOT-CAUSE FIX. `grep -c "CREATE TRIGGER" schema.sql` returns 0
--            for the entire 14,585-line file: there are 28 correctly-written
--            trigger FUNCTIONS in this schema (balance checks, immutability
--            guards, maker-checker, auto status rollups, single-default
--            enforcement, ownership-percentage validation, payment-allocation
--            validation, updated_at stamping, new-user profile creation...)
--            and NONE of them are wired to a table via CREATE TRIGGER.
--            This single gap explains Critical #1 (balance) and several
--            other findings from the prior audit, plus additional issues
--            this pass uncovered (posted-entry immutability not enforced,
--            maker-checker not enforced, new user signups never get a
--            public.profiles row, invoice/bill paid-status never
--            auto-updates, reconciliation status never rolls up, etc.).
--
-- Approach:  Every trigger below is attached to the table its own function
--            body actually references (verified by reading each function,
--            not guessed from its name). Nothing here changes the logic of
--            any function — CREATE OR REPLACE FUNCTION is not used in this
--            migration; only CREATE TRIGGER wiring is added.
--
-- Non-destructive: adds triggers only. Existing rows are not altered by
-- this migration itself. Some triggers (maker-checker, posted-edit
-- protection, closed-period protection, balance check) WILL start
-- rejecting writes that were previously silently allowed — that is the
-- point of this migration. See the pre-flight checks at the bottom; run
-- them first in a non-prod environment.
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- 1. Double-entry balance enforcement (Critical #1)
-- ----------------------------------------------------------------------------
DROP TRIGGER IF EXISTS "trg_check_journal_balance" ON "finance"."journal_lines";
CREATE CONSTRAINT TRIGGER "trg_check_journal_balance"
    AFTER INSERT OR UPDATE OR DELETE ON "finance"."journal_lines"
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW
    EXECUTE FUNCTION "finance"."check_journal_balance"();

-- ----------------------------------------------------------------------------
-- 2. Posted-entry immutability (spec 4.2: "Posted -> No direct edit/delete")
-- ----------------------------------------------------------------------------
DROP TRIGGER IF EXISTS "trg_prevent_posted_edit" ON "finance"."journal_lines";
CREATE TRIGGER "trg_prevent_posted_edit"
    BEFORE UPDATE OR DELETE ON "finance"."journal_lines"
    FOR EACH ROW
    EXECUTE FUNCTION "finance"."prevent_posted_edit"();

-- ----------------------------------------------------------------------------
-- 3. Closed-period posting protection (Critical #4)
-- ----------------------------------------------------------------------------
DROP TRIGGER IF EXISTS "trg_prevent_closed_period_posting" ON "finance"."journal_entries";
CREATE TRIGGER "trg_prevent_closed_period_posting"
    BEFORE INSERT OR UPDATE ON "finance"."journal_entries"
    FOR EACH ROW
    EXECUTE FUNCTION "finance"."prevent_closed_period_posting"();

-- ----------------------------------------------------------------------------
-- 4. Maker-checker: creator cannot be approver (Critical #5)
--    The function itself only acts on tables named
--    ('expenses','incomes','invoices','vendor_bills','journal_entries') and
--    is a no-op (RETURN NEW) for anything else, so it's safe to attach
--    broadly to those five tables specifically.
-- ----------------------------------------------------------------------------
DROP TRIGGER IF EXISTS "trg_maker_checker" ON "finance"."journal_entries";
CREATE TRIGGER "trg_maker_checker"
    BEFORE INSERT OR UPDATE ON "finance"."journal_entries"
    FOR EACH ROW
    EXECUTE FUNCTION "finance"."enforce_maker_checker"();

DROP TRIGGER IF EXISTS "trg_maker_checker" ON "finance"."vendor_bills";
CREATE TRIGGER "trg_maker_checker"
    BEFORE INSERT OR UPDATE ON "finance"."vendor_bills"
    FOR EACH ROW
    EXECUTE FUNCTION "finance"."enforce_maker_checker"();

DROP TRIGGER IF EXISTS "trg_maker_checker" ON "public"."invoices";
CREATE TRIGGER "trg_maker_checker"
    BEFORE INSERT OR UPDATE ON "public"."invoices"
    FOR EACH ROW
    EXECUTE FUNCTION "finance"."enforce_maker_checker"();

DROP TRIGGER IF EXISTS "trg_maker_checker" ON "public"."expenses";
CREATE TRIGGER "trg_maker_checker"
    BEFORE INSERT OR UPDATE ON "public"."expenses"
    FOR EACH ROW
    EXECUTE FUNCTION "finance"."enforce_maker_checker"();

DROP TRIGGER IF EXISTS "trg_maker_checker" ON "public"."incomes";
CREATE TRIGGER "trg_maker_checker"
    BEFORE INSERT OR UPDATE ON "public"."incomes"
    FOR EACH ROW
    EXECUTE FUNCTION "finance"."enforce_maker_checker"();

-- NOTE: this migration attaches enforce_maker_checker BEFORE migration 029
-- patches finance.post_journal_entry(). If you apply 028 without 029, the
-- system-generated posting RPCs (post_invoice_ar, post_credit_note, etc.,
-- which currently set approved_by = created_by = the same auth.uid()) will
-- start failing with MAKER_CHECKER_VIOLATION. Apply 028 and 029 together.

-- ----------------------------------------------------------------------------
-- 5. Financial-account integrity
-- ----------------------------------------------------------------------------
DROP TRIGGER IF EXISTS "trg_fa_single_default" ON "finance"."financial_accounts";
CREATE TRIGGER "trg_fa_single_default"
    BEFORE INSERT OR UPDATE OF "is_default" ON "finance"."financial_accounts"
    FOR EACH ROW
    WHEN (NEW.is_default IS TRUE)
    EXECUTE FUNCTION "finance"."fn_enforce_single_default_fa"();

DROP TRIGGER IF EXISTS "trg_fa_validate_ledger" ON "finance"."financial_accounts";
CREATE TRIGGER "trg_fa_validate_ledger"
    BEFORE INSERT OR UPDATE OF "linked_ledger_account_id" ON "finance"."financial_accounts"
    FOR EACH ROW
    EXECUTE FUNCTION "finance"."fn_validate_fa_ledger"();

DROP TRIGGER IF EXISTS "trg_fa_updated_at" ON "finance"."financial_accounts";
CREATE TRIGGER "trg_fa_updated_at"
    BEFORE UPDATE ON "finance"."financial_accounts"
    FOR EACH ROW
    EXECUTE FUNCTION "finance"."fn_fa_updated_at"();

-- ----------------------------------------------------------------------------
-- 6. Bank transfers
-- ----------------------------------------------------------------------------
DROP TRIGGER IF EXISTS "trg_bt_gen_number" ON "finance"."bank_transfers";
CREATE TRIGGER "trg_bt_gen_number"
    BEFORE INSERT ON "finance"."bank_transfers"
    FOR EACH ROW
    EXECUTE FUNCTION "finance"."fn_gen_bt_number"();

DROP TRIGGER IF EXISTS "trg_bt_dual_approval" ON "finance"."bank_transfers";
CREATE TRIGGER "trg_bt_dual_approval"
    BEFORE INSERT OR UPDATE OF "from_amount" ON "finance"."bank_transfers"
    FOR EACH ROW
    EXECUTE FUNCTION "finance"."fn_set_dual_approval"();

DROP TRIGGER IF EXISTS "trg_bt_updated_at" ON "finance"."bank_transfers";
CREATE TRIGGER "trg_bt_updated_at"
    BEFORE UPDATE ON "finance"."bank_transfers"
    FOR EACH ROW
    EXECUTE FUNCTION "finance"."fn_bt_updated_at"();

-- ----------------------------------------------------------------------------
-- 7. Bank statement reconciliation roll-ups
-- ----------------------------------------------------------------------------
DROP TRIGGER IF EXISTS "trg_sl_prevent_double_match" ON "finance"."statement_lines";
CREATE TRIGGER "trg_sl_prevent_double_match"
    BEFORE INSERT OR UPDATE OF "matched_journal_line_id" ON "finance"."statement_lines"
    FOR EACH ROW
    EXECUTE FUNCTION "finance"."fn_prevent_double_match"();

DROP TRIGGER IF EXISTS "trg_sl_line_count" ON "finance"."statement_lines";
CREATE TRIGGER "trg_sl_line_count"
    AFTER INSERT OR DELETE ON "finance"."statement_lines"
    FOR EACH ROW
    EXECUTE FUNCTION "finance"."fn_stmt_line_count"();

DROP TRIGGER IF EXISTS "trg_sl_recon_status" ON "finance"."statement_lines";
CREATE TRIGGER "trg_sl_recon_status"
    AFTER INSERT OR UPDATE OR DELETE ON "finance"."statement_lines"
    FOR EACH ROW
    EXECUTE FUNCTION "finance"."fn_stmt_recon_status"();

DROP TRIGGER IF EXISTS "trg_sl_updated_at" ON "finance"."statement_lines";
CREATE TRIGGER "trg_sl_updated_at"
    BEFORE UPDATE ON "finance"."statement_lines"
    FOR EACH ROW
    EXECUTE FUNCTION "finance"."fn_bs_sl_updated_at"();

-- ----------------------------------------------------------------------------
-- 8. Fixed assets: net book value roll-forward
-- ----------------------------------------------------------------------------
DROP TRIGGER IF EXISTS "trg_asset_nbv" ON "finance"."fixed_assets";
CREATE TRIGGER "trg_asset_nbv"
    BEFORE INSERT OR UPDATE OF "accumulated_depreciation", "base_cost" ON "finance"."fixed_assets"
    FOR EACH ROW
    EXECUTE FUNCTION "finance"."fn_update_asset_nbv"();

-- ----------------------------------------------------------------------------
-- 9. Ownership percentage guard (defense in depth alongside the existing
--    CHECK constraint and the SUM validation already in the schema)
-- ----------------------------------------------------------------------------
DROP TRIGGER IF EXISTS "trg_ownership_pct_total" ON "finance"."ownership_history";
CREATE TRIGGER "trg_ownership_pct_total"
    BEFORE INSERT OR UPDATE ON "finance"."ownership_history"
    FOR EACH ROW
    EXECUTE FUNCTION "finance"."validate_ownership_percentage_total"();

-- ----------------------------------------------------------------------------
-- 10. Payment allocation cannot exceed outstanding balance (spec 10.5)
-- ----------------------------------------------------------------------------
DROP TRIGGER IF EXISTS "trg_validate_payment_allocation" ON "finance"."payment_allocations";
CREATE TRIGGER "trg_validate_payment_allocation"
    BEFORE INSERT OR UPDATE ON "finance"."payment_allocations"
    FOR EACH ROW
    EXECUTE FUNCTION "finance"."validate_payment_allocation"();

DROP TRIGGER IF EXISTS "trg_validate_vendor_payment_allocation" ON "finance"."vendor_payment_allocations";
CREATE TRIGGER "trg_validate_vendor_payment_allocation"
    BEFORE INSERT OR UPDATE ON "finance"."vendor_payment_allocations"
    FOR EACH ROW
    EXECUTE FUNCTION "finance"."validate_vendor_payment_allocation"();

-- ----------------------------------------------------------------------------
-- 11. Auto status roll-up: invoice / vendor bill paid status and outstanding
--     balance (spec 5.6/5.7 "post ... maintain payable/payment status")
-- ----------------------------------------------------------------------------
DROP TRIGGER IF EXISTS "trg_auto_update_invoice_status" ON "finance"."payment_allocations";
CREATE TRIGGER "trg_auto_update_invoice_status"
    AFTER INSERT OR UPDATE OR DELETE ON "finance"."payment_allocations"
    FOR EACH ROW
    EXECUTE FUNCTION "finance"."auto_update_invoice_status"();

DROP TRIGGER IF EXISTS "trg_auto_update_bill_status" ON "finance"."vendor_payment_allocations";
CREATE TRIGGER "trg_auto_update_bill_status"
    AFTER INSERT OR UPDATE OR DELETE ON "finance"."vendor_payment_allocations"
    FOR EACH ROW
    EXECUTE FUNCTION "finance"."auto_update_bill_status"();

-- ----------------------------------------------------------------------------
-- 12. Tax table timestamps
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  t text;
BEGIN
  FOR t IN
    SELECT c.relname FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'updated_at' AND NOT a.attisdropped
    WHERE n.nspname = 'finance' AND c.relname LIKE 'tax_%' AND c.relkind = 'r'
  LOOP
    EXECUTE format(
      'DROP TRIGGER IF EXISTS trg_tax_updated_at ON finance.%I; '
      'CREATE TRIGGER trg_tax_updated_at BEFORE UPDATE ON finance.%I '
      'FOR EACH ROW EXECUTE FUNCTION finance.fn_tax_updated_at();',
      t, t
    );
  END LOOP;
END $$;

-- ----------------------------------------------------------------------------
-- 13. New-user signup -> public.profiles row (standard Supabase pattern).
--     Without this, every new auth.users signup previously got NO profile
--     row at all, and core.has_role()'s legacy fallback treats a missing
--     profile as role = 'VIEWER' only (i.e. effectively no access at all
--     until an admin manually inserts a profiles row). This is a functional
--     bug independent of the security audit.
-- ----------------------------------------------------------------------------
DROP TRIGGER IF EXISTS "trg_handle_new_user" ON "auth"."users";
CREATE TRIGGER "trg_handle_new_user"
    AFTER INSERT ON "auth"."users"
    FOR EACH ROW
    EXECUTE FUNCTION "public"."handle_new_user"();

-- ----------------------------------------------------------------------------
-- 14. Invoice client_name sync (denormalized display column)
-- ----------------------------------------------------------------------------
DROP TRIGGER IF EXISTS "trg_sync_invoice_client_name" ON "public"."invoices";
CREATE TRIGGER "trg_sync_invoice_client_name"
    BEFORE INSERT OR UPDATE OF "client_id" ON "public"."invoices"
    FOR EACH ROW
    EXECUTE FUNCTION "public"."sync_invoice_client_name"();

-- ----------------------------------------------------------------------------
-- 15. Generic updated_at stamping for every remaining table that HAS an
--     updated_at column but did not get a specific trigger above. This is
--     applied dynamically (rather than hand-listing ~80 tables) using the
--     correct convention per schema: core.set_updated_at for core/finance,
--     public.payroll_update_timestamp for payroll_* tables, public.update_
--     updated_at for the rest of public. Tables already wired above are
--     skipped automatically because DROP TRIGGER IF EXISTS + CREATE TRIGGER
--     with the SAME trigger name ("trg_updated_at") would conflict with the
--     specific triggers created above (which use different names), so this
--     block only touches tables that don't already have "trg_updated_at".
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  r RECORD;
  v_fn text;
BEGIN
  FOR r IN
    SELECT n.nspname AS schema_name, c.relname AS table_name
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'updated_at' AND NOT a.attisdropped
    WHERE n.nspname IN ('core','finance','public')
      AND c.relkind = 'r'
      AND NOT EXISTS (
        SELECT 1 FROM pg_trigger tg
        WHERE tg.tgrelid = c.oid AND NOT tg.tgisinternal
          AND tg.tgname LIKE '%updated_at%'
      )
  LOOP
    IF r.schema_name = 'public' AND r.table_name LIKE 'payroll_%' THEN
      v_fn := 'public.payroll_update_timestamp()';
    ELSIF r.schema_name = 'public' THEN
      v_fn := 'public.update_updated_at()';
    ELSE
      v_fn := 'core.set_updated_at()';
    END IF;

    EXECUTE format(
      'DROP TRIGGER IF EXISTS trg_updated_at ON %I.%I; '
      'CREATE TRIGGER trg_updated_at BEFORE UPDATE ON %I.%I '
      'FOR EACH ROW EXECUTE FUNCTION %s;',
      r.schema_name, r.table_name, r.schema_name, r.table_name, v_fn
    );
  END LOOP;
END $$;

COMMIT;

-- ----------------------------------------------------------------------------
-- PRE-FLIGHT CHECKS — run these BEFORE applying in production.
-- ----------------------------------------------------------------------------
-- 1. Existing unbalanced journals (will become permanently locked once
--    trg_check_journal_balance is live — any future touch to their lines
--    will re-trigger and fail until a qualified accountant corrects them):
--
-- SELECT je.id, je.reference, je.status
-- FROM finance.journal_entries je
-- JOIN finance.journal_lines jl ON jl.journal_entry_id = je.id
-- GROUP BY je.id, je.reference, je.status
-- HAVING ABS(SUM(jl.debit_amount) - SUM(jl.credit_amount)) > 0.01;
--
-- 2. Existing rows where creator = approver (will not be blocked
--    retroactively -- the trigger only fires on future INSERT/UPDATE -- but
--    surface them for a manual review pass):
--
-- SELECT id, reference, created_by, approved_by FROM finance.journal_entries
--   WHERE approved_by IS NOT NULL AND approved_by = created_by
-- UNION ALL
-- SELECT id::text, invoice_number, user_id::text, approved_by::text FROM public.invoices
--   WHERE approved_by IS NOT NULL AND approved_by = user_id;
--
-- 3. Existing POSTED journal_entries whose lines might already be
--    inconsistent with a HARD_CLOSED period (won't be touched by this
--    migration, but worth knowing about before it becomes unmodifiable):
--
-- SELECT je.id, je.reference, ap.status AS period_status
-- FROM finance.journal_entries je
-- JOIN finance.accounting_periods ap ON ap.id = je.period_id
-- WHERE ap.status = 'HARD_CLOSED' AND je.posted_at > ap.closed_at;