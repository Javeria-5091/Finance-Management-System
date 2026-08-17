-- =============================================================================
-- Migration 019: Extend closed-period posting protection to source/
--                operational documents (not just journal_entries)
-- =============================================================================
-- PURPOSE
--   The compliance audit found that finance.prevent_closed_period_posting()
--   was only attached to finance.journal_entries. The operational documents
--   that feed the ledger -- expenses, incomes, invoices, vendor bills,
--   credit notes, payment receipts, vendor payments -- had no equivalent
--   protection, even though every one of them already carries a `period_id`
--   column and a `status` column with the same vocabulary the function
--   already understands. This meant a HARD_CLOSED period could still be
--   silently modified by editing the source document directly, even though
--   the corresponding journal_entries row was protected.
--
-- ISSUES FIXED
--   - Spec 4.3: "Closed periods reject new or changed postings."
--   - Spec 10.5: "Closed periods reject new or changed postings unless a
--     controlled reopen/adjustment process is used" -- now enforced at the
--     operational-document level, not only at the ledger level.
--
-- APPROACH
--   finance.prevent_closed_period_posting() is a generic function -- it only
--   reads NEW.period_id and NEW.status, neither of which is hardcoded to any
--   one table. It is safe and correct to attach the SAME existing function,
--   unmodified, to the additional tables below rather than write seven new
--   near-duplicate functions.
--
--   One nuance: public.invoices does not use the same status vocabulary as
--   journal_entries (its `status` column defaults to 'Draft' and has no
--   CHECK constraint tying it to the 'DRAFT'/'POSTED'/etc. vocabulary used
--   elsewhere). The function's HARD_CLOSED branch does not depend on
--   `status` at all, so it fully protects invoices regardless of the status
--   value used. Its SOFT_CLOSED branch only fires when status = 'POSTED'
--   exactly, so for invoices that branch is a no-op today. This is
--   documented here rather than silently assumed to work -- if the
--   application later introduces a 'POSTED' status value for invoices, the
--   soft-close protection will start applying automatically with no further
--   migration needed.
--
-- SAFETY
--   Purely additive triggers. NEW.period_id is NULL for any row that has
--   not yet been assigned to a period (e.g. an early DRAFT expense/invoice
--   before approval) -- the function's lookup returns no match in that case
--   and both IF branches evaluate false, so the row passes through
--   unaffected. Existing rows already in closed periods are not touched by
--   this migration; only future INSERT/UPDATE operations are affected.
-- =============================================================================

BEGIN;

DROP TRIGGER IF EXISTS "trg_prevent_closed_period_posting" ON "public"."expenses";
CREATE TRIGGER "trg_prevent_closed_period_posting"
  BEFORE INSERT OR UPDATE ON "public"."expenses"
  FOR EACH ROW
  EXECUTE FUNCTION "finance"."prevent_closed_period_posting"();

DROP TRIGGER IF EXISTS "trg_prevent_closed_period_posting" ON "public"."incomes";
CREATE TRIGGER "trg_prevent_closed_period_posting"
  BEFORE INSERT OR UPDATE ON "public"."incomes"
  FOR EACH ROW
  EXECUTE FUNCTION "finance"."prevent_closed_period_posting"();

DROP TRIGGER IF EXISTS "trg_prevent_closed_period_posting" ON "public"."invoices";
CREATE TRIGGER "trg_prevent_closed_period_posting"
  BEFORE INSERT OR UPDATE ON "public"."invoices"
  FOR EACH ROW
  EXECUTE FUNCTION "finance"."prevent_closed_period_posting"();

DROP TRIGGER IF EXISTS "trg_prevent_closed_period_posting" ON "finance"."vendor_bills";
CREATE TRIGGER "trg_prevent_closed_period_posting"
  BEFORE INSERT OR UPDATE ON "finance"."vendor_bills"
  FOR EACH ROW
  EXECUTE FUNCTION "finance"."prevent_closed_period_posting"();

DROP TRIGGER IF EXISTS "trg_prevent_closed_period_posting" ON "finance"."credit_notes";
CREATE TRIGGER "trg_prevent_closed_period_posting"
  BEFORE INSERT OR UPDATE ON "finance"."credit_notes"
  FOR EACH ROW
  EXECUTE FUNCTION "finance"."prevent_closed_period_posting"();

DROP TRIGGER IF EXISTS "trg_prevent_closed_period_posting" ON "finance"."payment_receipts";
CREATE TRIGGER "trg_prevent_closed_period_posting"
  BEFORE INSERT OR UPDATE ON "finance"."payment_receipts"
  FOR EACH ROW
  EXECUTE FUNCTION "finance"."prevent_closed_period_posting"();

DROP TRIGGER IF EXISTS "trg_prevent_closed_period_posting" ON "finance"."vendor_payments";
CREATE TRIGGER "trg_prevent_closed_period_posting"
  BEFORE INSERT OR UPDATE ON "finance"."vendor_payments"
  FOR EACH ROW
  EXECUTE FUNCTION "finance"."prevent_closed_period_posting"();

COMMIT;