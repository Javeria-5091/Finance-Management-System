-- =============================================================================
-- Migration 030: Organization-scoped RLS on priority tables
-- =============================================================================
-- PURPOSE
--   Rewrites the RLS policies on the tables explicitly named in Compliance
--   Audit Finding 2.1 (finance.journal_entries, finance.chart_of_accounts,
--   finance.financial_accounts, finance.vendors, finance.vendor_bills,
--   finance.fiscal_years, finance.taxpayer_profile, core.roles,
--   core.approval_limits) so that, in addition to their existing role-based
--   checks, a row is only visible/writable when it belongs to the caller's
--   own organization (core.same_org()).
--
--   Every existing policy is DROPped and CREATEd fresh with the identical
--   role-based logic it had before, ONLY with "AND core.same_org(organization_id)"
--   added. No role/permission behavior is changed or loosened -- this
--   migration can only make access MORE restrictive, never less, because
--   core.same_org() is fail-closed (see migration 027).
--
--   finance.journal_lines is intentionally NOT touched: its existing
--   policies (jl_select/jl_insert/jl_update/jl_delete) already gate access
--   through an EXISTS subquery against finance.journal_entries, and Postgres
--   RLS evaluates the referenced table's own policies inside that subquery
--   under the same calling role -- so once journal_entries is org-scoped
--   below, journal_lines automatically inherits it with zero additional
--   code and zero duplication risk.
--
-- ISSUES FIXED
--   - Spec Section 17 (Multi-Tenancy / Organization Isolation)
--   - Spec Section 18 (RLS/Security Audit)
--
-- SCOPE NOTE (deliberately not "everything")
--   This migration covers the tables named in the audit finding plus the
--   ones that share the exact same simple role-based pattern with a 1:1
--   mapping (journal_entries, chart_of_accounts, financial_accounts,
--   vendors, vendor_bills, fiscal_years, taxpayer_profile, roles,
--   approval_limits). The remaining Tier-1 tables from migration 028/029
--   (vendor_payments, credit_notes, payment_receipts, exchange_rates,
--   platforms, fee_rules, owners, ownership_history, reserve_policies,
--   profit_distributions, capital_transactions, tax_rule_sets, tax_slabs,
--   tax_adjustments, tax_reconciliations, asset_categories, fixed_assets,
--   asset_verifications, bank_statements, bank_transfers, budget_lines,
--   budget_revisions, numbering_sequences, attachments, and the core
--   approval/delegation tables) now HAVE organization_id populated and
--   ready to use, but their RLS policies have NOT been rewritten in this
--   migration -- doing all ~300 remaining policies safely requires
--   reviewing each one's existing role logic individually rather than
--   templating blindly, which this response flags explicitly as a tracked
--   follow-up (see "Post-Migration Re-Audit" / Issue 2.1 status = PARTIALLY
--   FIXED) rather than silently claiming it is done.
--
-- SAFETY
--   Uses DROP POLICY IF EXISTS + CREATE POLICY so it is re-runnable. Does
--   not touch RLS enablement (already ON for all these tables) or any
--   service_role policy.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- finance.journal_entries
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "je_delete" ON "finance"."journal_entries";
CREATE POLICY "je_delete" ON "finance"."journal_entries" FOR DELETE
  USING ("core"."is_finance_head"() AND ("status" = 'DRAFT'::"text") AND "core"."same_org"("organization_id"));

DROP POLICY IF EXISTS "je_insert" ON "finance"."journal_entries";
CREATE POLICY "je_insert" ON "finance"."journal_entries" FOR INSERT
  WITH CHECK (("core"."is_finance_head"() OR "core"."has_role"('ACCOUNTANT'::"text")) AND "core"."same_org"("organization_id"));

DROP POLICY IF EXISTS "je_select" ON "finance"."journal_entries";
CREATE POLICY "je_select" ON "finance"."journal_entries" FOR SELECT
  USING (("core"."is_finance_head"() OR "core"."has_role"('ACCOUNTANT'::"text") OR "core"."has_role"('VIEWER'::"text")) AND "core"."same_org"("organization_id"));

DROP POLICY IF EXISTS "je_update" ON "finance"."journal_entries";
CREATE POLICY "je_update" ON "finance"."journal_entries" FOR UPDATE
  USING (("core"."is_finance_head"() OR "core"."has_role"('ACCOUNTANT'::"text")) AND ("status" = 'DRAFT'::"text") AND "core"."same_org"("organization_id"));

-- ---------------------------------------------------------------------------
-- finance.chart_of_accounts
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "coa_insert" ON "finance"."chart_of_accounts";
CREATE POLICY "coa_insert" ON "finance"."chart_of_accounts" FOR INSERT
  WITH CHECK (("core"."is_ceo_or_admin"() OR "core"."is_finance_head"()) AND "core"."same_org"("organization_id"));

DROP POLICY IF EXISTS "coa_select_active" ON "finance"."chart_of_accounts";
CREATE POLICY "coa_select_active" ON "finance"."chart_of_accounts" FOR SELECT
  USING ((("auth"."uid"() IS NOT NULL) AND (("is_active" = true) OR "core"."is_ceo_or_admin"() OR "core"."is_finance_head"())) AND "core"."same_org"("organization_id"));

DROP POLICY IF EXISTS "coa_update" ON "finance"."chart_of_accounts";
CREATE POLICY "coa_update" ON "finance"."chart_of_accounts" FOR UPDATE
  USING (("core"."is_ceo_or_admin"() OR "core"."is_finance_head"()) AND "core"."same_org"("organization_id"));

-- ---------------------------------------------------------------------------
-- finance.financial_accounts
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "fa_delete" ON "finance"."financial_accounts";
CREATE POLICY "fa_delete" ON "finance"."financial_accounts" FOR DELETE
  USING ("core"."is_finance_head"() AND "core"."same_org"("organization_id"));

DROP POLICY IF EXISTS "fa_insert" ON "finance"."financial_accounts";
CREATE POLICY "fa_insert" ON "finance"."financial_accounts" FOR INSERT
  WITH CHECK (("core"."is_finance_head"() OR "core"."has_role"('ACCOUNTANT'::"text")) AND "core"."same_org"("organization_id"));

DROP POLICY IF EXISTS "fa_select" ON "finance"."financial_accounts";
CREATE POLICY "fa_select" ON "finance"."financial_accounts" FOR SELECT
  USING (("core"."is_finance_head"() OR "core"."has_role"('ACCOUNTANT'::"text") OR "core"."has_role"('VIEWER'::"text")) AND "core"."same_org"("organization_id"));

DROP POLICY IF EXISTS "fa_update" ON "finance"."financial_accounts";
CREATE POLICY "fa_update" ON "finance"."financial_accounts" FOR UPDATE
  USING (("core"."is_finance_head"() OR "core"."has_role"('ACCOUNTANT'::"text")) AND "core"."same_org"("organization_id"));

-- ---------------------------------------------------------------------------
-- finance.vendors
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "v_insert" ON "finance"."vendors";
CREATE POLICY "v_insert" ON "finance"."vendors" FOR INSERT
  WITH CHECK (("core"."is_finance_head"() OR "core"."has_role"('ACCOUNTANT'::"text")) AND "core"."same_org"("organization_id"));

DROP POLICY IF EXISTS "v_select" ON "finance"."vendors";
CREATE POLICY "v_select" ON "finance"."vendors" FOR SELECT
  USING (("core"."is_finance_head"() OR "core"."has_role"('ACCOUNTANT'::"text") OR "core"."has_role"('PROJECT_MANAGER'::"text") OR "core"."has_role"('VIEWER'::"text")) AND "core"."same_org"("organization_id"));

DROP POLICY IF EXISTS "v_update" ON "finance"."vendors";
CREATE POLICY "v_update" ON "finance"."vendors" FOR UPDATE
  USING (("core"."is_finance_head"() OR "core"."has_role"('ACCOUNTANT'::"text")) AND "core"."same_org"("organization_id"));

-- ---------------------------------------------------------------------------
-- finance.vendor_bills
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "vb_insert" ON "finance"."vendor_bills";
CREATE POLICY "vb_insert" ON "finance"."vendor_bills" FOR INSERT
  WITH CHECK (("core"."is_finance_head"() OR "core"."has_role"('ACCOUNTANT'::"text")) AND "core"."same_org"("organization_id"));

DROP POLICY IF EXISTS "vb_select" ON "finance"."vendor_bills";
CREATE POLICY "vb_select" ON "finance"."vendor_bills" FOR SELECT
  USING (("core"."is_finance_head"() OR "core"."has_role"('ACCOUNTANT'::"text") OR "core"."has_role"('PROJECT_MANAGER'::"text") OR "core"."has_role"('VIEWER'::"text")) AND "core"."same_org"("organization_id"));

DROP POLICY IF EXISTS "vb_update" ON "finance"."vendor_bills";
CREATE POLICY "vb_update" ON "finance"."vendor_bills" FOR UPDATE
  USING (("core"."is_finance_head"() OR "core"."has_role"('ACCOUNTANT'::"text")) AND "core"."same_org"("organization_id"));

-- ---------------------------------------------------------------------------
-- finance.fiscal_years
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "fy_insert" ON "finance"."fiscal_years";
CREATE POLICY "fy_insert" ON "finance"."fiscal_years" FOR INSERT
  WITH CHECK ("core"."is_finance_head"() AND "core"."same_org"("organization_id"));

DROP POLICY IF EXISTS "fy_select" ON "finance"."fiscal_years";
CREATE POLICY "fy_select" ON "finance"."fiscal_years" FOR SELECT
  USING (("auth"."uid"() IS NOT NULL) AND "core"."same_org"("organization_id"));

DROP POLICY IF EXISTS "fy_update" ON "finance"."fiscal_years";
CREATE POLICY "fy_update" ON "finance"."fiscal_years" FOR UPDATE
  USING ("core"."is_finance_head"() AND "core"."same_org"("organization_id"));

-- ---------------------------------------------------------------------------
-- finance.taxpayer_profile
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "tp_select" ON "finance"."taxpayer_profile";
CREATE POLICY "tp_select" ON "finance"."taxpayer_profile" FOR SELECT
  USING (("core"."is_finance_head"() OR "core"."has_role"('ACCOUNTANT'::"text")) AND "core"."same_org"("organization_id"));

DROP POLICY IF EXISTS "tp_update" ON "finance"."taxpayer_profile";
CREATE POLICY "tp_update" ON "finance"."taxpayer_profile" FOR UPDATE
  USING ("core"."is_finance_head"() AND "core"."same_org"("organization_id"));

-- NOTE: no "tp_insert"/"tp_delete" policy existed in the original schema
-- for finance.taxpayer_profile -- not added here, consistent with
-- "preserve policies that are already correct" / do not invent new access
-- paths that weren't there before.

-- ---------------------------------------------------------------------------
-- core.roles
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "role_manage" ON "core"."roles";
CREATE POLICY "role_manage" ON "core"."roles"
  USING ("core"."has_permission"("auth"."uid"(), 'ADMIN_USERS'::"text") AND "core"."same_org"("organization_id"))
  WITH CHECK ("core"."has_permission"("auth"."uid"(), 'ADMIN_USERS'::"text") AND "core"."same_org"("organization_id"));

DROP POLICY IF EXISTS "role_select" ON "core"."roles";
CREATE POLICY "role_select" ON "core"."roles" FOR SELECT
  USING (("auth"."uid"() IS NOT NULL) AND "core"."same_org"("organization_id"));

-- ---------------------------------------------------------------------------
-- core.approval_limits
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "approval_limits_manage" ON "core"."approval_limits";
CREATE POLICY "approval_limits_manage" ON "core"."approval_limits"
  USING ("core"."has_permission"("auth"."uid"(), 'ADMIN_USERS'::"text") AND "core"."same_org"("organization_id"))
  WITH CHECK ("core"."has_permission"("auth"."uid"(), 'ADMIN_USERS'::"text") AND "core"."same_org"("organization_id"));

DROP POLICY IF EXISTS "approval_limits_select_own" ON "core"."approval_limits";
CREATE POLICY "approval_limits_select_own" ON "core"."approval_limits" FOR SELECT
  USING ((("user_id" = "auth"."uid"()) OR "core"."has_permission"("auth"."uid"(), 'ADMIN_USERS'::"text")) AND "core"."same_org"("organization_id"));
  