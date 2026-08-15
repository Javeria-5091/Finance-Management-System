-- =============================================================================
-- Migration: 016_fix_accounting_integrity.sql
-- Purpose:   Fix Critical finding C-1 and part of High finding H-3 from the
--            Schema Compliance Audit: remove the duplicate, non-deferred
--            "trg_journal_balance" trigger that breaks every multi-line
--            journal posting, and remove other confirmed duplicate triggers
--            that run the same business logic twice on the same event.
--            Also close gap M-3: nothing currently prevents posting to a
--            chart_of_accounts row where posting_allowed = false or
--            is_active = false (spec Section 5.2).
--
-- Issues fixed (see previous audit report for evidence/line numbers):
--   C-1  finance.journal_lines had two triggers calling check_journal_balance():
--        trg_check_journal_balance (correct: CONSTRAINT TRIGGER ... DEFERRABLE
--        INITIALLY DEFERRED) and trg_journal_balance (incorrect: plain AFTER
--        ROW trigger that fires immediately and aborts multi-line inserts).
--   H-3  Duplicate triggers on: vendor_payment_allocations, payment_allocations,
--        statement_lines, bank_transfers, journal_lines (posted-edit),
--        ownership_history, journal_entries/vendor_bills (maker-checker),
--        and the *_uat tax "updated_at" triggers.
--   M-3  No enforcement that journal_lines.account_id references an account
--        with posting_allowed = true and is_active = true.
--
-- Safety: purely additive/subtractive at the trigger level. No table is
-- dropped, no column is dropped, no data is modified. Removing a duplicate
-- trigger cannot cause data loss; at worst it removes redundant re-validation
-- that a sibling trigger (kept) already performs identically.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------
-- 1. THE CRITICAL FIX: remove the non-deferred duplicate journal-balance
--    trigger. Keep only the deferred constraint trigger
--    "trg_check_journal_balance", which allows a balanced multi-line
--    journal to be built up across several single-row INSERTs inside one
--    transaction and only validates at COMMIT time.
-- -----------------------------------------------------------------------
DROP TRIGGER IF EXISTS "trg_journal_balance" ON "finance"."journal_lines";

-- Defensive re-assert: make sure the correct deferred trigger exists and is
-- actually deferred (idempotent; safe to re-run).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'finance'
      AND c.relname = 'journal_lines'
      AND t.tgname = 'trg_check_journal_balance'
  ) THEN
    CREATE CONSTRAINT TRIGGER "trg_check_journal_balance"
      AFTER INSERT OR DELETE OR UPDATE ON "finance"."journal_lines"
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION "finance"."check_journal_balance"();
  END IF;
END $$;

-- -----------------------------------------------------------------------
-- 2. Remove confirmed duplicate triggers (same function, same table,
--    same/overlapping event). In each pair we keep the more complete
--    definition (the one covering the superset of events) and drop the
--    redundant one.
-- -----------------------------------------------------------------------

-- vendor_payment_allocations: keep trg_auto_update_bill_status, drop trg_alloc_bill_status
DROP TRIGGER IF EXISTS "trg_alloc_bill_status" ON "finance"."vendor_payment_allocations";

-- payment_allocations: keep trg_auto_update_invoice_status, drop trg_alloc_status_update
DROP TRIGGER IF EXISTS "trg_alloc_status_update" ON "finance"."payment_allocations";

-- statement_lines: keep trg_stmt_line_count / trg_stmt_recon_status (cover UPDATE too),
-- drop the narrower trg_sl_line_count / trg_sl_recon_status
DROP TRIGGER IF EXISTS "trg_sl_line_count" ON "finance"."statement_lines";
DROP TRIGGER IF EXISTS "trg_sl_recon_status" ON "finance"."statement_lines";

-- bank_transfers: keep trg_gen_bt_number, drop trg_bt_gen_number
DROP TRIGGER IF EXISTS "trg_bt_gen_number" ON "finance"."bank_transfers";

-- journal_lines posted-edit protection: keep trg_prevent_posted_edit, drop trg_prevent_posted_line_edit
DROP TRIGGER IF EXISTS "trg_prevent_posted_line_edit" ON "finance"."journal_lines";

-- ownership_history percentage-total validation: keep trg_validate_ownership_percentage,
-- drop trg_ownership_pct_total
DROP TRIGGER IF EXISTS "trg_ownership_pct_total" ON "finance"."ownership_history";

-- maker-checker: trg_maker_checker (BEFORE INSERT OR UPDATE) is a superset of
-- chk_maker_checker (BEFORE UPDATE only); drop the redundant subset trigger
-- on all three tables where both exist.
DROP TRIGGER IF EXISTS "chk_maker_checker" ON "finance"."journal_entries";
DROP TRIGGER IF EXISTS "chk_maker_checker" ON "finance"."vendor_bills";
DROP TRIGGER IF EXISTS "chk_maker_checker" ON "public"."expenses";
DROP TRIGGER IF EXISTS "chk_maker_checker" ON "public"."incomes";
DROP TRIGGER IF EXISTS "chk_maker_checker" ON "public"."invoices";

-- Tax "updated_at" duplicate triggers: keep the single canonical
-- "trg_tax_updated_at" on each table (already present per-table with that
-- exact name) and drop the short-named legacy duplicates.
DROP TRIGGER IF EXISTS "ta_uat"        ON "finance"."tax_adjustments";
DROP TRIGGER IF EXISTS "tax_comp_uat"  ON "finance"."tax_computations";
DROP TRIGGER IF EXISTS "tax_cw_uat"    ON "finance"."tax_credits_and_withholding";
DROP TRIGGER IF EXISTS "tax_pay_uat"   ON "finance"."tax_payments_and_refunds";
DROP TRIGGER IF EXISTS "tax_ret_uat"   ON "finance"."tax_returns";
DROP TRIGGER IF EXISTS "tp_uat"        ON "finance"."taxpayer_profile";
DROP TRIGGER IF EXISTS "tr_uat"        ON "finance"."tax_reconciliations";
DROP TRIGGER IF EXISTS "trs_uat"       ON "finance"."tax_rule_sets";
DROP TRIGGER IF EXISTS "tsl_uat"       ON "finance"."tax_slabs";
DROP TRIGGER IF EXISTS "dl_uat"        ON "finance"."distribution_lines";
DROP TRIGGER IF EXISTS "o_uat"         ON "finance"."owners";
DROP TRIGGER IF EXISTS "oh_uat"        ON "finance"."ownership_history";
DROP TRIGGER IF EXISTS "pd_uat"        ON "finance"."profit_distributions";
DROP TRIGGER IF EXISTS "rp_uat"        ON "finance"."reserve_policies";

-- -----------------------------------------------------------------------
-- 3. Close gap M-3: enforce that journal lines can only post to accounts
--    that allow posting and are active. This is enforced as a BEFORE
--    INSERT/UPDATE trigger on finance.journal_lines so it applies no
--    matter which code path inserts a line (post_journal_entry() and any
--    future caller).
-- -----------------------------------------------------------------------
CREATE OR REPLACE FUNCTION "finance"."enforce_postable_account"()
RETURNS "trigger"
LANGUAGE plpgsql
SET search_path TO 'pg_catalog', 'finance', 'public'
AS $$
DECLARE
  v_posting_allowed boolean;
  v_is_active boolean;
  v_code text;
BEGIN
  SELECT posting_allowed, is_active, code
    INTO v_posting_allowed, v_is_active, v_code
  FROM finance.chart_of_accounts
  WHERE id = NEW.account_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Journal line references unknown account_id %', NEW.account_id;
  END IF;

  IF v_posting_allowed IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Account % (posting_allowed = false, typically a summary/parent account) cannot receive postings', v_code;
  END IF;

  IF v_is_active IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Account % is inactive and cannot receive postings', v_code;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "trg_enforce_postable_account" ON "finance"."journal_lines";
CREATE TRIGGER "trg_enforce_postable_account"
  BEFORE INSERT OR UPDATE OF "account_id" ON "finance"."journal_lines"
  FOR EACH ROW EXECUTE FUNCTION "finance"."enforce_postable_account"();

COMMIT;

-- =============================================================================
-- Rollback notes (manual, if ever needed):
--   - Re-create "trg_journal_balance" as it was (NOT recommended — this
--     restores the bug):
--       CREATE OR REPLACE TRIGGER "trg_journal_balance"
--         AFTER INSERT OR DELETE OR UPDATE ON "finance"."journal_lines"
--         FOR EACH ROW EXECUTE FUNCTION "finance"."check_journal_balance"();
--   - Each dropped duplicate trigger can be restored individually from the
--     original schema.sql if a functional regression is ever traced back to
--     this migration (none is expected, since the surviving trigger in each
--     pair covers a superset of the dropped trigger's events).
-- =============================================================================

-- =============================================================================
-- Migration: 018_fix_fiscal_period_integrity.sql
-- Purpose:   Fix High finding H-4 from the Schema Compliance Audit.
--
-- Issue fixed:
--   H-4  finance.fiscal_years had only a start_date < end_date CHECK; no
--        protection against two fiscal years with overlapping date ranges.
--        finance.accounting_periods had a period_number range CHECK (1-12)
--        and start_date < end_date, but no UNIQUE(fiscal_year_id,
--        period_number) and no protection against two periods in the same
--        fiscal year with overlapping date ranges (spec Section 10.5:
--        "A fiscal year must contain non-overlapping accounting periods").
--
-- Safety: this migration is written to FAIL LOUDLY with a diagnostic
-- message if existing data already violates the constraints being added,
-- rather than let a bare ALTER TABLE ... ADD CONSTRAINT fail with a
-- generic Postgres error. No data is changed by this migration; if the
-- pre-check finds a conflict, the transaction aborts and NO constraint is
-- added, so the database is left exactly as it was. Correcting the
-- underlying data is then a manual decision (see report Section D).
-- =============================================================================

BEGIN;

-- Needed for the EXCLUDE (date range overlap) constraints below.
CREATE EXTENSION IF NOT EXISTS "btree_gist" WITH SCHEMA "extensions";

-- -----------------------------------------------------------------------
-- 1. Pre-check: overlapping fiscal years.
-- -----------------------------------------------------------------------
DO $$
DECLARE
  v_conflict RECORD;
  v_found boolean := false;
BEGIN
  FOR v_conflict IN
    SELECT a.id AS id_a, a.name AS name_a, a.start_date AS start_a, a.end_date AS end_a,
           b.id AS id_b, b.name AS name_b, b.start_date AS start_b, b.end_date AS end_b
    FROM finance.fiscal_years a
    JOIN finance.fiscal_years b
      ON a.id < b.id
     AND daterange(a.start_date, a.end_date, '[]') && daterange(b.start_date, b.end_date, '[]')
  LOOP
    v_found := true;
    RAISE WARNING 'Overlapping fiscal years: % (% to %) overlaps % (% to %)',
      v_conflict.name_a, v_conflict.start_a, v_conflict.end_a,
      v_conflict.name_b, v_conflict.start_b, v_conflict.end_b;
  END LOOP;

  IF v_found THEN
    RAISE EXCEPTION 'Migration 018 aborted: existing overlapping fiscal_years rows found (see WARNINGs above). Resolve the date ranges manually, then re-run this migration.';
  END IF;
END $$;

-- -----------------------------------------------------------------------
-- 2. Pre-check: duplicate period_number within the same fiscal year.
-- -----------------------------------------------------------------------
DO $$
DECLARE
  v_conflict RECORD;
  v_found boolean := false;
BEGIN
  FOR v_conflict IN
    SELECT fiscal_year_id, period_number, COUNT(*) AS cnt
    FROM finance.accounting_periods
    GROUP BY fiscal_year_id, period_number
    HAVING COUNT(*) > 1
  LOOP
    v_found := true;
    RAISE WARNING 'Duplicate period_number % in fiscal_year_id % (% rows)',
      v_conflict.period_number, v_conflict.fiscal_year_id, v_conflict.cnt;
  END LOOP;

  IF v_found THEN
    RAISE EXCEPTION 'Migration 018 aborted: duplicate (fiscal_year_id, period_number) rows found in finance.accounting_periods (see WARNINGs above). Resolve manually, then re-run.';
  END IF;
END $$;

-- -----------------------------------------------------------------------
-- 3. Pre-check: overlapping period date ranges within the same fiscal year.
-- -----------------------------------------------------------------------
DO $$
DECLARE
  v_conflict RECORD;
  v_found boolean := false;
BEGIN
  FOR v_conflict IN
    SELECT a.id AS id_a, a.name AS name_a, a.start_date AS start_a, a.end_date AS end_a,
           b.id AS id_b, b.name AS name_b, b.start_date AS start_b, b.end_date AS end_b,
           a.fiscal_year_id
    FROM finance.accounting_periods a
    JOIN finance.accounting_periods b
      ON a.fiscal_year_id = b.fiscal_year_id
     AND a.id < b.id
     AND daterange(a.start_date, a.end_date, '[]') && daterange(b.start_date, b.end_date, '[]')
  LOOP
    v_found := true;
    RAISE WARNING 'Overlapping periods in fiscal_year_id %: % (% to %) overlaps % (% to %)',
      v_conflict.fiscal_year_id, v_conflict.name_a, v_conflict.start_a, v_conflict.end_a,
      v_conflict.name_b, v_conflict.start_b, v_conflict.end_b;
  END LOOP;

  IF v_found THEN
    RAISE EXCEPTION 'Migration 018 aborted: overlapping accounting_periods date ranges found (see WARNINGs above). Resolve manually, then re-run.';
  END IF;
END $$;

-- -----------------------------------------------------------------------
-- 4. All pre-checks passed (or this is a fresh/clean database) — add the
--    actual constraints.
-- -----------------------------------------------------------------------

-- 4a. No two fiscal years may have overlapping date ranges.
ALTER TABLE "finance"."fiscal_years"
  DROP CONSTRAINT IF EXISTS "fy_no_overlapping_ranges";
ALTER TABLE "finance"."fiscal_years"
  ADD CONSTRAINT "fy_no_overlapping_ranges"
  EXCLUDE USING gist (daterange("start_date", "end_date", '[]') WITH &&);

-- 4b. period_number must be unique within a fiscal year.
ALTER TABLE "finance"."accounting_periods"
  DROP CONSTRAINT IF EXISTS "ap_unique_period_number_per_fy";
ALTER TABLE "finance"."accounting_periods"
  ADD CONSTRAINT "ap_unique_period_number_per_fy"
  UNIQUE ("fiscal_year_id", "period_number");

-- 4c. No two periods within the same fiscal year may have overlapping
--     date ranges.
ALTER TABLE "finance"."accounting_periods"
  DROP CONSTRAINT IF EXISTS "ap_no_overlapping_ranges_per_fy";
ALTER TABLE "finance"."accounting_periods"
  ADD CONSTRAINT "ap_no_overlapping_ranges_per_fy"
  EXCLUDE USING gist (
    "fiscal_year_id" WITH =,
    daterange("start_date", "end_date", '[]') WITH &&
  );

COMMIT;

-- =============================================================================
-- If this migration aborts with "Migration 018 aborted: ...": do NOT
-- re-run it blindly. Run the corresponding SELECT from the pre-check block
-- above manually to see the exact offending rows, correct the dates (or
-- merge/delete the duplicate period, whichever is business-correct) with
-- the finance team's sign-off, and only then re-run this file.
-- =============================================================================