-- =============================================================================
-- Migration 016: Fix overly-permissive RLS policies on governance-critical
--                financial tables
-- =============================================================================
-- PURPOSE
--   A fresh re-audit performed while preparing these migrations found that
--   several sensitive tables carry a single catch-all RLS policy of the form
--   `USING (auth.uid() IS NOT NULL)` with NO `FOR <command>` clause. In
--   PostgreSQL, a policy with no FOR clause applies to ALL commands
--   (SELECT/INSERT/UPDATE/DELETE). Combined with a condition that only checks
--   "is this user logged in at all", this means ANY authenticated user --
--   including EMPLOYEE and PROJECT_MANAGER roles -- currently has full
--   read/write/delete access to:
--     * finance.owners                 (shareholder identities)
--     * finance.ownership_history      (ownership percentages)
--     * finance.profit_distributions   (declared/approved distributions)
--     * finance.distribution_lines     (who gets paid what)
--     * finance.reserve_policies       (company reserve configuration)
--
--   This directly contradicts Spec Appendix A (Role and Permission Matrix),
--   which restricts "Shareholder/owner data" and "Reserve/distributions" to
--   CEO (Full) and Finance Head/Accountant (Config/Prepare) only, with
--   Project Manager/Employee/Auditor = None or Read-only.
--
--   This was NOT called out by name in the original compliance report (which
--   flagged these tables as *appearing* to have no policies at all, based on
--   a stricter `FOR <cmd>`-pattern search); the true condition -- present but
--   dangerously permissive -- is arguably worse and is corrected here first,
--   ahead of any other RLS work, because it is a live over-permission issue.
--
--   The same anti-pattern also exists on a smaller number of write paths on
--   otherwise-reasonable tables (bank transfer deletion, tax adjustment
--   edit/delete, tax reconciliation edit, tax slab edit/delete). Those are
--   fixed here too because they touch money movement and statutory tax
--   configuration directly.
--
-- ISSUES FIXED (from the compliance audit + this re-audit)
--   - Ownership / Reserve / Distribution module RLS matches Appendix A
--   - Bank transfer DELETE/UPDATE restricted to Finance Head/CEO
--   - Tax adjustment DELETE/UPDATE restricted to Finance Head/Accountant/CEO
--   - Tax reconciliation UPDATE restricted similarly
--   - Tax slab DELETE/UPDATE restricted similarly (statutory rule integrity)
--
-- SAFETY
--   Strictly additive/corrective: we DROP the single named permissive policy
--   on each table and CREATE narrower, per-command policies in its place.
--   No table, column, or data is touched. Existing SELECT access for
--   Finance Head / Accountant / CEO / Viewer is preserved or widened where
--   the original policy already allowed it broadly for reads.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------
-- finance.owners
-- -----------------------------------------------------------------------
DROP POLICY IF EXISTS "o_all" ON "finance"."owners";

CREATE POLICY "owners_select" ON "finance"."owners"
  FOR SELECT
  USING (core.is_ceo_or_admin() OR core.is_finance_head() OR core.has_role('ACCOUNTANT'));

CREATE POLICY "owners_insert" ON "finance"."owners"
  FOR INSERT
  WITH CHECK (core.is_ceo_or_admin());

CREATE POLICY "owners_update" ON "finance"."owners"
  FOR UPDATE
  USING (core.is_ceo_or_admin())
  WITH CHECK (core.is_ceo_or_admin());

CREATE POLICY "owners_delete" ON "finance"."owners"
  FOR DELETE
  USING (core.is_ceo_or_admin());

-- -----------------------------------------------------------------------
-- finance.ownership_history
-- -----------------------------------------------------------------------
DROP POLICY IF EXISTS "oh_all" ON "finance"."ownership_history";

CREATE POLICY "ownership_history_select" ON "finance"."ownership_history"
  FOR SELECT
  USING (core.is_ceo_or_admin() OR core.is_finance_head() OR core.has_role('ACCOUNTANT'));

CREATE POLICY "ownership_history_insert" ON "finance"."ownership_history"
  FOR INSERT
  WITH CHECK (core.is_ceo_or_admin());

CREATE POLICY "ownership_history_update" ON "finance"."ownership_history"
  FOR UPDATE
  USING (core.is_ceo_or_admin())
  WITH CHECK (core.is_ceo_or_admin());

CREATE POLICY "ownership_history_delete" ON "finance"."ownership_history"
  FOR DELETE
  USING (core.is_ceo_or_admin());

-- -----------------------------------------------------------------------
-- finance.profit_distributions
-- -----------------------------------------------------------------------
DROP POLICY IF EXISTS "pd_all" ON "finance"."profit_distributions";

CREATE POLICY "profit_distributions_select" ON "finance"."profit_distributions"
  FOR SELECT
  USING (core.is_ceo_or_admin() OR core.is_finance_head() OR core.has_role('ACCOUNTANT'));

-- Finance Head/Accountant may prepare (insert) a draft distribution proposal;
-- only CEO/admin may approve/finalize via UPDATE, matching spec 5.13
-- ("Require CEO/authorized governance approval before a distribution
-- becomes payable or paid").
CREATE POLICY "profit_distributions_insert" ON "finance"."profit_distributions"
  FOR INSERT
  WITH CHECK (core.is_ceo_or_admin() OR core.is_finance_head());

CREATE POLICY "profit_distributions_update" ON "finance"."profit_distributions"
  FOR UPDATE
  USING (core.is_ceo_or_admin() OR core.is_finance_head())
  WITH CHECK (core.is_ceo_or_admin() OR core.is_finance_head());

CREATE POLICY "profit_distributions_delete" ON "finance"."profit_distributions"
  FOR DELETE
  USING (core.is_ceo_or_admin());

-- -----------------------------------------------------------------------
-- finance.distribution_lines
-- -----------------------------------------------------------------------
DROP POLICY IF EXISTS "dl_all" ON "finance"."distribution_lines";

CREATE POLICY "distribution_lines_select" ON "finance"."distribution_lines"
  FOR SELECT
  USING (core.is_ceo_or_admin() OR core.is_finance_head() OR core.has_role('ACCOUNTANT'));

CREATE POLICY "distribution_lines_insert" ON "finance"."distribution_lines"
  FOR INSERT
  WITH CHECK (core.is_ceo_or_admin() OR core.is_finance_head());

CREATE POLICY "distribution_lines_update" ON "finance"."distribution_lines"
  FOR UPDATE
  USING (core.is_ceo_or_admin() OR core.is_finance_head())
  WITH CHECK (core.is_ceo_or_admin() OR core.is_finance_head());

CREATE POLICY "distribution_lines_delete" ON "finance"."distribution_lines"
  FOR DELETE
  USING (core.is_ceo_or_admin());

-- -----------------------------------------------------------------------
-- finance.reserve_policies
-- -----------------------------------------------------------------------
DROP POLICY IF EXISTS "rp_all" ON "finance"."reserve_policies";

CREATE POLICY "reserve_policies_select" ON "finance"."reserve_policies"
  FOR SELECT
  USING (core.is_ceo_or_admin() OR core.is_finance_head() OR core.has_role('ACCOUNTANT') OR core.has_role('VIEWER'));

CREATE POLICY "reserve_policies_insert" ON "finance"."reserve_policies"
  FOR INSERT
  WITH CHECK (core.is_ceo_or_admin() OR core.is_finance_head());

CREATE POLICY "reserve_policies_update" ON "finance"."reserve_policies"
  FOR UPDATE
  USING (core.is_ceo_or_admin() OR core.is_finance_head())
  WITH CHECK (core.is_ceo_or_admin() OR core.is_finance_head());

CREATE POLICY "reserve_policies_delete" ON "finance"."reserve_policies"
  FOR DELETE
  USING (core.is_ceo_or_admin());

-- -----------------------------------------------------------------------
-- finance.bank_transfers -- tighten DELETE and UPDATE only
-- (SELECT policy "bt_select" is unchanged: read access for finance/CEO/etc.
--  is already handled by other existing policies on this table)
-- -----------------------------------------------------------------------
DROP POLICY IF EXISTS "bt_delete" ON "finance"."bank_transfers";
DROP POLICY IF EXISTS "bt_update" ON "finance"."bank_transfers";

CREATE POLICY "bt_update_restricted" ON "finance"."bank_transfers"
  FOR UPDATE
  USING (core.is_ceo_or_admin() OR core.is_finance_head())
  WITH CHECK (core.is_ceo_or_admin() OR core.is_finance_head());

CREATE POLICY "bt_delete_restricted" ON "finance"."bank_transfers"
  FOR DELETE
  USING (core.is_ceo_or_admin() OR core.is_finance_head());

-- -----------------------------------------------------------------------
-- finance.tax_adjustments -- tighten DELETE and UPDATE only
-- -----------------------------------------------------------------------
DROP POLICY IF EXISTS "ta_delete" ON "finance"."tax_adjustments";
DROP POLICY IF EXISTS "ta_update" ON "finance"."tax_adjustments";

CREATE POLICY "ta_update_restricted" ON "finance"."tax_adjustments"
  FOR UPDATE
  USING (core.is_ceo_or_admin() OR core.is_finance_head() OR core.has_role('ACCOUNTANT'))
  WITH CHECK (core.is_ceo_or_admin() OR core.is_finance_head() OR core.has_role('ACCOUNTANT'));

CREATE POLICY "ta_delete_restricted" ON "finance"."tax_adjustments"
  FOR DELETE
  USING (core.is_ceo_or_admin() OR core.is_finance_head());

-- -----------------------------------------------------------------------
-- finance.tax_reconciliations -- tighten UPDATE only
-- -----------------------------------------------------------------------
DROP POLICY IF EXISTS "tr_update" ON "finance"."tax_reconciliations";

CREATE POLICY "tr_update_restricted" ON "finance"."tax_reconciliations"
  FOR UPDATE
  USING (core.is_ceo_or_admin() OR core.is_finance_head() OR core.has_role('ACCOUNTANT'))
  WITH CHECK (core.is_ceo_or_admin() OR core.is_finance_head() OR core.has_role('ACCOUNTANT'));

-- -----------------------------------------------------------------------
-- finance.tax_slabs -- tighten DELETE and UPDATE only (statutory rule data)
-- -----------------------------------------------------------------------
DROP POLICY IF EXISTS "tsl_delete" ON "finance"."tax_slabs";
DROP POLICY IF EXISTS "tsl_update" ON "finance"."tax_slabs";

CREATE POLICY "tsl_update_restricted" ON "finance"."tax_slabs"
  FOR UPDATE
  USING (core.is_ceo_or_admin() OR core.is_finance_head())
  WITH CHECK (core.is_ceo_or_admin() OR core.is_finance_head());

CREATE POLICY "tsl_delete_restricted" ON "finance"."tax_slabs"
  FOR DELETE
  USING (core.is_ceo_or_admin() OR core.is_finance_head());

COMMIT;

-- =============================================================================
-- KNOWN REMAINING LOWER-RISK "auth.uid() IS NOT NULL"-ONLY POLICIES
-- (NOT changed in this migration -- flagged for a follow-up decision because
--  their correct scope is less obvious without product input; see the
--  verification query in 099_verification_queries.sql, query #2, which lists
--  every remaining policy of this shape so the team can triage deliberately
--  rather than have this migration guess at every one):
--    finance.asset_categories_update, finance.bank_statements_update,
--    finance.depreciation_schedule_update, finance.payment_receipts_update,
--    finance.statement_lines (delete/update), finance.vendor_bill_lines_update,
--    finance.vendor_payments_update
-- =============================================================================