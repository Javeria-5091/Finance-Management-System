-- =============================================================================
-- Migration P1_062: Organization Isolation — Batch 2
-- =============================================================================
-- PURPOSE
--   P1_059 (Batch 1) closed cross-organization exposure on the payroll/*,
--   commissions, contractors, subscriptions, incomes, fee_tiers,
--   fee_computation_log tables. This migration is a full re-audit of the
--   CURRENT schema.sql against every finance/core table and closes the
--   remaining cross-organization isolation gaps found:
--
--   GROUP A — "auth.uid() IS NOT NULL"-only policies on tables that already
--   HAVE an organization_id column, so the column is simply never checked.
--   Any authenticated user of ANY organization can read/write these rows.
--   Includes finance.attachments (receipts/invoices/contracts evidence),
--   finance.payment_receipts, finance.vendor_payments, finance.bank_statements,
--   finance.bank_transfers, finance.credit_notes, finance.accounting_periods,
--   finance.asset_categories, finance.asset_verifications, finance.budget_lines,
--   finance.tax_adjustments, finance.tax_reconciliations, finance.tax_slabs,
--   finance.numbering_sequences, finance.dimensions, finance.platforms,
--   finance.fee_rules, core.organization_config, core.organization_modules.
--
--   GROUP B — policies with a broad role check (CEO/Finance
--   Head/Accountant/Viewer) but NO organization predicate at all, even
--   though organization_id exists on the table. Includes finance.fixed_assets,
--   finance.capital_transactions (shareholder capital/owner loans/drawings),
--   finance.owners, finance.ownership_history, finance.profit_distributions,
--   finance.reserve_policies, finance.tax_rule_sets, finance.budget_revisions.
--
--   GROUP C — child tables with NO organization_id column of their own,
--   whose policies do not join back to their org-owning parent, so they
--   are effectively unscoped. Includes finance.depreciation_schedule
--   (-> fixed_assets), finance.statement_lines (-> bank_statements),
--   finance.vendor_bill_lines (-> vendor_bills), finance.distribution_lines
--   (-> profit_distributions), core.employee_links (-> shared_people).
--
--   GROUP D — a logic bug, not just a missing predicate:
--   core.budget_policies_org_isolation compares "organization_id" to a
--   subquery that selects budget_policies.organization_id FROM
--   core.user_roles with no join back to core.user_roles.organization_id
--   -- because budget_policies is never referenced inside the subquery's
--   FROM clause, Postgres resolves it as a correlated reference to the
--   OUTER row, so the condition degenerates to "organization_id =
--   organization_id" (always true) as long as the caller holds ANY active
--   role in ANY organization. This is a full cross-org bypass.
--
--   GROUP E — cross-organization privilege-escalation surfaces. These
--   control WHO can act as WHOM, so a gap here is worse than a data leak:
--   an ADMIN_USERS-permissioned user in Organization A can currently grant
--   roles, permission overrides, or delegations that are NOT limited to
--   Organization A, i.e. they can grant themselves (or anyone) elevated
--   access inside a DIFFERENT organization. Includes core.role_permissions,
--   core.user_roles, core.user_permission_overrides, core.delegations,
--   core.shared_people.
--
-- APPROACH
--   - Every existing over-permissive policy is explicitly DROPped (RLS
--     policies are OR'd together, so leaving a `true`/unscoped policy in
--     place while adding a correct one alongside it fixes nothing).
--   - No table is altered, no column is dropped, no data is deleted.
--   - Every new predicate uses the existing core.same_org() /
--     core.current_user_org_id() helpers already used everywhere else in
--     this schema, so behavior is consistent with every table that was
--     already correctly scoped (e.g. finance.invoices, finance.vendor_bills).
--   - core.same_org() fails closed on NULL, so any historical row whose
--     organization_id was never backfilled becomes invisible rather than
--     cross-organization-visible -- strictly safer than today, and matches
--     the exact pattern P1_059 already used for this same reason.
--   - Role/data-scope logic (who *within* an org may act) is preserved
--     exactly as it exists today; only the missing organization boundary is
--     added. No permission is granted that did not already exist within an
--     organization.
--   - Idempotent: DROP POLICY IF EXISTS before every CREATE POLICY, so this
--     migration is safe to re-run.
-- =============================================================================


-- =============================================================================
-- GROUP A — tables with organization_id but policy checks only auth.uid()
-- =============================================================================

-- finance.accounting_periods ---------------------------------------------------
DROP POLICY IF EXISTS "ap_select" ON "finance"."accounting_periods";
CREATE POLICY "ap_select_org_scoped" ON "finance"."accounting_periods"
  FOR SELECT USING ((("auth"."uid"() IS NOT NULL) AND "core"."same_org"("organization_id")));

-- finance.asset_categories ------------------------------------------------------
DROP POLICY IF EXISTS "asset_categories_select" ON "finance"."asset_categories";
DROP POLICY IF EXISTS "asset_categories_insert" ON "finance"."asset_categories";
DROP POLICY IF EXISTS "asset_categories_update" ON "finance"."asset_categories";
CREATE POLICY "asset_categories_select_org_scoped" ON "finance"."asset_categories"
  FOR SELECT USING ((("auth"."uid"() IS NOT NULL) AND "core"."same_org"("organization_id")));
CREATE POLICY "asset_categories_insert_org_scoped" ON "finance"."asset_categories"
  FOR INSERT WITH CHECK ((("auth"."uid"() IS NOT NULL) AND "core"."same_org"("organization_id")));
CREATE POLICY "asset_categories_update_org_scoped" ON "finance"."asset_categories"
  FOR UPDATE USING ((("auth"."uid"() IS NOT NULL) AND "core"."same_org"("organization_id")))
  WITH CHECK ((("auth"."uid"() IS NOT NULL) AND "core"."same_org"("organization_id")));

-- finance.asset_verifications -----------------------------------------------
DROP POLICY IF EXISTS "asset_verifications_select" ON "finance"."asset_verifications";
DROP POLICY IF EXISTS "asset_verifications_insert" ON "finance"."asset_verifications";
DROP POLICY IF EXISTS "asset_verifications_update" ON "finance"."asset_verifications";
CREATE POLICY "asset_verifications_select_org_scoped" ON "finance"."asset_verifications"
  FOR SELECT USING ((("auth"."uid"() IS NOT NULL) AND "core"."same_org"("organization_id")));
CREATE POLICY "asset_verifications_insert_org_scoped" ON "finance"."asset_verifications"
  FOR INSERT WITH CHECK ((("auth"."uid"() IS NOT NULL) AND "core"."same_org"("organization_id")));
CREATE POLICY "asset_verifications_update_org_scoped" ON "finance"."asset_verifications"
  FOR UPDATE USING ((("auth"."uid"() IS NOT NULL) AND "core"."same_org"("organization_id")))
  WITH CHECK ((("auth"."uid"() IS NOT NULL) AND "core"."same_org"("organization_id")));

-- finance.attachments (receipts / invoices / contracts / evidence files) -------
DROP POLICY IF EXISTS "att_select" ON "finance"."attachments";
DROP POLICY IF EXISTS "att_insert" ON "finance"."attachments";
CREATE POLICY "att_select_org_scoped" ON "finance"."attachments"
  FOR SELECT USING ((("auth"."uid"() IS NOT NULL) AND "core"."same_org"("organization_id")));
CREATE POLICY "att_insert_org_scoped" ON "finance"."attachments"
  FOR INSERT WITH CHECK ((("auth"."uid"() IS NOT NULL) AND "core"."same_org"("organization_id")));

-- finance.budget_lines ------------------------------------------------------
DROP POLICY IF EXISTS "bl_select" ON "finance"."budget_lines";
DROP POLICY IF EXISTS "bl_insert" ON "finance"."budget_lines";
CREATE POLICY "bl_select_org_scoped" ON "finance"."budget_lines"
  FOR SELECT USING ((("auth"."uid"() IS NOT NULL) AND "core"."same_org"("organization_id")));
CREATE POLICY "bl_insert_org_scoped" ON "finance"."budget_lines"
  FOR INSERT WITH CHECK ((("auth"."uid"() IS NOT NULL) AND "core"."same_org"("organization_id")));

-- finance.bank_statements ------------------------------------------------------
DROP POLICY IF EXISTS "bs_select" ON "finance"."bank_statements";
DROP POLICY IF EXISTS "bs_insert" ON "finance"."bank_statements";
DROP POLICY IF EXISTS "bs_update" ON "finance"."bank_statements";
CREATE POLICY "bs_select_org_scoped" ON "finance"."bank_statements"
  FOR SELECT USING ((("auth"."uid"() IS NOT NULL) AND "core"."same_org"("organization_id")));
CREATE POLICY "bs_insert_org_scoped" ON "finance"."bank_statements"
  FOR INSERT WITH CHECK ((("auth"."uid"() IS NOT NULL) AND "core"."same_org"("organization_id")));
CREATE POLICY "bs_update_org_scoped" ON "finance"."bank_statements"
  FOR UPDATE USING ((("auth"."uid"() IS NOT NULL) AND "core"."same_org"("organization_id")))
  WITH CHECK ((("auth"."uid"() IS NOT NULL) AND "core"."same_org"("organization_id")));

-- finance.bank_transfers ------------------------------------------------------
DROP POLICY IF EXISTS "bt_select" ON "finance"."bank_transfers";
DROP POLICY IF EXISTS "bt_insert" ON "finance"."bank_transfers";
CREATE POLICY "bt_select_org_scoped" ON "finance"."bank_transfers"
  FOR SELECT USING ((("auth"."uid"() IS NOT NULL) AND "core"."same_org"("organization_id")));
CREATE POLICY "bt_insert_org_scoped" ON "finance"."bank_transfers"
  FOR INSERT WITH CHECK ((("auth"."uid"() IS NOT NULL) AND "core"."same_org"("organization_id")));

-- finance.credit_notes ------------------------------------------------------
DROP POLICY IF EXISTS "cn_select" ON "finance"."credit_notes";
DROP POLICY IF EXISTS "cn_insert" ON "finance"."credit_notes";
CREATE POLICY "cn_select_org_scoped" ON "finance"."credit_notes"
  FOR SELECT USING ((("auth"."uid"() IS NOT NULL) AND "core"."same_org"("organization_id")));
CREATE POLICY "cn_insert_org_scoped" ON "finance"."credit_notes"
  FOR INSERT WITH CHECK ((("auth"."uid"() IS NOT NULL) AND "core"."same_org"("organization_id")));

-- finance.dimensions (departments / cost centers / business units) ------------
DROP POLICY IF EXISTS "dimensions_select" ON "finance"."dimensions";
CREATE POLICY "dimensions_select_org_scoped" ON "finance"."dimensions"
  FOR SELECT USING ((("auth"."uid"() IS NOT NULL) AND "core"."same_org"("organization_id")));

-- finance.numbering_sequences ------------------------------------------------------
DROP POLICY IF EXISTS "ns_select" ON "finance"."numbering_sequences";
CREATE POLICY "ns_select_org_scoped" ON "finance"."numbering_sequences"
  FOR SELECT USING ((("auth"."uid"() IS NOT NULL) AND "core"."same_org"("organization_id")));

-- finance.platforms / finance.fee_rules ----------------------------------------
-- NOTE: organization_id is nullable on these two tables. Per spec 5.12 the
-- platform/fee directory is configured per organization, so we scope it the
-- same fail-closed way as every other table. If OSYSTIC later wants a
-- shared, cross-org platform catalog, that is a deliberate product decision
-- requiring a separate "is_global" flag and policy -- not something this
-- isolation fix should invent implicitly.
DROP POLICY IF EXISTS "org_read_platforms" ON "finance"."platforms";
CREATE POLICY "platforms_select_org_scoped" ON "finance"."platforms"
  FOR SELECT USING ((("auth"."uid"() IS NOT NULL) AND "core"."same_org"("organization_id")));

DROP POLICY IF EXISTS "org_read_fee_rules" ON "finance"."fee_rules";
CREATE POLICY "fee_rules_select_org_scoped" ON "finance"."fee_rules"
  FOR SELECT USING ((("auth"."uid"() IS NOT NULL) AND "core"."same_org"("organization_id")));

-- finance.payment_receipts ------------------------------------------------------
DROP POLICY IF EXISTS "pr_select" ON "finance"."payment_receipts";
DROP POLICY IF EXISTS "pr_insert" ON "finance"."payment_receipts";
DROP POLICY IF EXISTS "pr_update" ON "finance"."payment_receipts";
CREATE POLICY "pr_select_org_scoped" ON "finance"."payment_receipts"
  FOR SELECT USING ((("auth"."uid"() IS NOT NULL) AND "core"."same_org"("organization_id")));
CREATE POLICY "pr_insert_org_scoped" ON "finance"."payment_receipts"
  FOR INSERT WITH CHECK ((("auth"."uid"() IS NOT NULL) AND "core"."same_org"("organization_id")));
CREATE POLICY "pr_update_org_scoped" ON "finance"."payment_receipts"
  FOR UPDATE USING ((("auth"."uid"() IS NOT NULL) AND "core"."same_org"("organization_id")))
  WITH CHECK ((("auth"."uid"() IS NOT NULL) AND "core"."same_org"("organization_id")));

-- finance.tax_adjustments / tax_reconciliations / tax_slabs -------------------
-- (NOTE: these are distinct from finance.tax_computations / tax_returns /
-- tax_credits_and_withholding / tax_payments_and_refunds, whose
-- organization_id legitimately references core.organization_config(id) and
-- are already correctly scoped via core.current_user_org_config_id().)
DROP POLICY IF EXISTS "ta_select" ON "finance"."tax_adjustments";
DROP POLICY IF EXISTS "ta_insert" ON "finance"."tax_adjustments";
CREATE POLICY "ta_select_org_scoped" ON "finance"."tax_adjustments"
  FOR SELECT USING ((("auth"."uid"() IS NOT NULL) AND "core"."same_org"("organization_id")));
CREATE POLICY "ta_insert_org_scoped" ON "finance"."tax_adjustments"
  FOR INSERT WITH CHECK ((("auth"."uid"() IS NOT NULL) AND "core"."same_org"("organization_id")));

DROP POLICY IF EXISTS "tr_select" ON "finance"."tax_reconciliations";
DROP POLICY IF EXISTS "tr_insert" ON "finance"."tax_reconciliations";
CREATE POLICY "tr_select_org_scoped" ON "finance"."tax_reconciliations"
  FOR SELECT USING ((("auth"."uid"() IS NOT NULL) AND "core"."same_org"("organization_id")));
CREATE POLICY "tr_insert_org_scoped" ON "finance"."tax_reconciliations"
  FOR INSERT WITH CHECK ((("auth"."uid"() IS NOT NULL) AND "core"."same_org"("organization_id")));

DROP POLICY IF EXISTS "tsl_select" ON "finance"."tax_slabs";
DROP POLICY IF EXISTS "tsl_insert" ON "finance"."tax_slabs";
CREATE POLICY "tsl_select_org_scoped" ON "finance"."tax_slabs"
  FOR SELECT USING ((("auth"."uid"() IS NOT NULL) AND "core"."same_org"("organization_id")));
CREATE POLICY "tsl_insert_org_scoped" ON "finance"."tax_slabs"
  FOR INSERT WITH CHECK ((("auth"."uid"() IS NOT NULL) AND "core"."same_org"("organization_id")));

-- finance.vendor_payments ------------------------------------------------------
DROP POLICY IF EXISTS "vp_select" ON "finance"."vendor_payments";
DROP POLICY IF EXISTS "vp_insert" ON "finance"."vendor_payments";
DROP POLICY IF EXISTS "vp_update" ON "finance"."vendor_payments";
CREATE POLICY "vp_select_org_scoped" ON "finance"."vendor_payments"
  FOR SELECT USING ((("auth"."uid"() IS NOT NULL) AND "core"."same_org"("organization_id")));
CREATE POLICY "vp_insert_org_scoped" ON "finance"."vendor_payments"
  FOR INSERT WITH CHECK ((("auth"."uid"() IS NOT NULL) AND "core"."same_org"("organization_id")));
CREATE POLICY "vp_update_org_scoped" ON "finance"."vendor_payments"
  FOR UPDATE USING ((("auth"."uid"() IS NOT NULL) AND "core"."same_org"("organization_id")))
  WITH CHECK ((("auth"."uid"() IS NOT NULL) AND "core"."same_org"("organization_id")));

-- core.organization_config / core.organization_modules ------------------------
DROP POLICY IF EXISTS "org_config_select" ON "core"."organization_config";
CREATE POLICY "org_config_select_org_scoped" ON "core"."organization_config"
  FOR SELECT USING ((("auth"."uid"() IS NOT NULL) AND "core"."same_org"("organization_id")));

DROP POLICY IF EXISTS "org_modules_select" ON "core"."organization_modules";
CREATE POLICY "org_modules_select_org_scoped" ON "core"."organization_modules"
  FOR SELECT USING ((("auth"."uid"() IS NOT NULL) AND "core"."same_org"("organization_id")));


-- =============================================================================
-- GROUP B — role-gated policies missing the organization predicate entirely
-- =============================================================================

-- finance.fixed_assets ------------------------------------------------------
DROP POLICY IF EXISTS "fixed_assets_select" ON "finance"."fixed_assets";
DROP POLICY IF EXISTS "fixed_assets_insert" ON "finance"."fixed_assets";
DROP POLICY IF EXISTS "fixed_assets_update" ON "finance"."fixed_assets";
DROP POLICY IF EXISTS "fixed_assets_delete" ON "finance"."fixed_assets";
CREATE POLICY "fixed_assets_select_org_scoped" ON "finance"."fixed_assets"
  FOR SELECT USING (("core"."same_org"("organization_id") AND ("core"."is_finance_head"() OR "core"."has_role"('ACCOUNTANT'::"text") OR "core"."has_role"('VIEWER'::"text"))));
CREATE POLICY "fixed_assets_insert_org_scoped" ON "finance"."fixed_assets"
  FOR INSERT WITH CHECK (("core"."same_org"("organization_id") AND ("core"."is_finance_head"() OR "core"."has_role"('ACCOUNTANT'::"text"))));
CREATE POLICY "fixed_assets_update_org_scoped" ON "finance"."fixed_assets"
  FOR UPDATE USING (("core"."same_org"("organization_id") AND ("core"."is_finance_head"() OR "core"."has_role"('ACCOUNTANT'::"text"))))
  WITH CHECK (("core"."same_org"("organization_id") AND ("core"."is_finance_head"() OR "core"."has_role"('ACCOUNTANT'::"text"))));
CREATE POLICY "fixed_assets_delete_org_scoped" ON "finance"."fixed_assets"
  FOR DELETE USING (("core"."same_org"("organization_id") AND ("auth"."uid"() = "created_by") AND (("status")::"text" = 'pending_capitalization'::"text") AND ("core"."is_finance_head"() OR "core"."has_role"('ACCOUNTANT'::"text"))));

-- finance.capital_transactions (shareholder capital / owner loans / drawings) -
DROP POLICY IF EXISTS "capital_txn_select" ON "finance"."capital_transactions";
DROP POLICY IF EXISTS "capital_txn_insert" ON "finance"."capital_transactions";
DROP POLICY IF EXISTS "capital_txn_update" ON "finance"."capital_transactions";
DROP POLICY IF EXISTS "capital_txn_delete" ON "finance"."capital_transactions";
CREATE POLICY "capital_txn_select_org_scoped" ON "finance"."capital_transactions"
  FOR SELECT USING (("core"."same_org"("organization_id") AND ("core"."is_finance_head"() OR "core"."has_role"('ACCOUNTANT'::"text") OR "core"."has_role"('CEO'::"text") OR "core"."has_role"('VIEWER'::"text"))));
CREATE POLICY "capital_txn_insert_org_scoped" ON "finance"."capital_transactions"
  FOR INSERT WITH CHECK (("core"."same_org"("organization_id") AND ("core"."is_finance_head"() OR "core"."has_role"('ACCOUNTANT'::"text"))));
CREATE POLICY "capital_txn_update_org_scoped" ON "finance"."capital_transactions"
  FOR UPDATE USING (("core"."same_org"("organization_id") AND ("core"."is_finance_head"() OR "core"."has_role"('ACCOUNTANT'::"text"))))
  WITH CHECK (("core"."same_org"("organization_id") AND ("core"."is_finance_head"() OR "core"."has_role"('ACCOUNTANT'::"text"))));
CREATE POLICY "capital_txn_delete_org_scoped" ON "finance"."capital_transactions"
  FOR DELETE USING (("core"."same_org"("organization_id") AND "core"."is_finance_head"()));

-- finance.owners ------------------------------------------------------
DROP POLICY IF EXISTS "owners_select" ON "finance"."owners";
DROP POLICY IF EXISTS "owners_insert" ON "finance"."owners";
DROP POLICY IF EXISTS "owners_update" ON "finance"."owners";
DROP POLICY IF EXISTS "owners_delete" ON "finance"."owners";
CREATE POLICY "owners_select_org_scoped" ON "finance"."owners"
  FOR SELECT USING (("core"."same_org"("organization_id") AND ("core"."is_ceo_or_admin"() OR "core"."is_finance_head"() OR "core"."has_role"('ACCOUNTANT'::"text"))));
CREATE POLICY "owners_insert_org_scoped" ON "finance"."owners"
  FOR INSERT WITH CHECK (("core"."same_org"("organization_id") AND "core"."is_ceo_or_admin"()));
CREATE POLICY "owners_update_org_scoped" ON "finance"."owners"
  FOR UPDATE USING (("core"."same_org"("organization_id") AND "core"."is_ceo_or_admin"()))
  WITH CHECK (("core"."same_org"("organization_id") AND "core"."is_ceo_or_admin"()));
CREATE POLICY "owners_delete_org_scoped" ON "finance"."owners"
  FOR DELETE USING (("core"."same_org"("organization_id") AND "core"."is_ceo_or_admin"()));

-- finance.ownership_history ------------------------------------------------------
DROP POLICY IF EXISTS "ownership_history_select" ON "finance"."ownership_history";
DROP POLICY IF EXISTS "ownership_history_insert" ON "finance"."ownership_history";
DROP POLICY IF EXISTS "ownership_history_update" ON "finance"."ownership_history";
DROP POLICY IF EXISTS "ownership_history_delete" ON "finance"."ownership_history";
CREATE POLICY "ownership_history_select_org_scoped" ON "finance"."ownership_history"
  FOR SELECT USING (("core"."same_org"("organization_id") AND ("core"."is_ceo_or_admin"() OR "core"."is_finance_head"() OR "core"."has_role"('ACCOUNTANT'::"text"))));
CREATE POLICY "ownership_history_insert_org_scoped" ON "finance"."ownership_history"
  FOR INSERT WITH CHECK (("core"."same_org"("organization_id") AND "core"."is_ceo_or_admin"()));
CREATE POLICY "ownership_history_update_org_scoped" ON "finance"."ownership_history"
  FOR UPDATE USING (("core"."same_org"("organization_id") AND "core"."is_ceo_or_admin"()))
  WITH CHECK (("core"."same_org"("organization_id") AND "core"."is_ceo_or_admin"()));
CREATE POLICY "ownership_history_delete_org_scoped" ON "finance"."ownership_history"
  FOR DELETE USING (("core"."same_org"("organization_id") AND "core"."is_ceo_or_admin"()));

-- finance.profit_distributions ------------------------------------------------------
DROP POLICY IF EXISTS "profit_distributions_select" ON "finance"."profit_distributions";
DROP POLICY IF EXISTS "profit_distributions_insert" ON "finance"."profit_distributions";
DROP POLICY IF EXISTS "profit_distributions_update" ON "finance"."profit_distributions";
DROP POLICY IF EXISTS "profit_distributions_delete" ON "finance"."profit_distributions";
CREATE POLICY "profit_distributions_select_org_scoped" ON "finance"."profit_distributions"
  FOR SELECT USING (("core"."same_org"("organization_id") AND ("core"."is_ceo_or_admin"() OR "core"."is_finance_head"() OR "core"."has_role"('ACCOUNTANT'::"text"))));
CREATE POLICY "profit_distributions_insert_org_scoped" ON "finance"."profit_distributions"
  FOR INSERT WITH CHECK (("core"."same_org"("organization_id") AND ("core"."is_ceo_or_admin"() OR "core"."is_finance_head"())));
CREATE POLICY "profit_distributions_update_org_scoped" ON "finance"."profit_distributions"
  FOR UPDATE USING (("core"."same_org"("organization_id") AND ("core"."is_ceo_or_admin"() OR "core"."is_finance_head"())))
  WITH CHECK (("core"."same_org"("organization_id") AND ("core"."is_ceo_or_admin"() OR "core"."is_finance_head"())));
CREATE POLICY "profit_distributions_delete_org_scoped" ON "finance"."profit_distributions"
  FOR DELETE USING (("core"."same_org"("organization_id") AND "core"."is_ceo_or_admin"()));

-- finance.reserve_policies ------------------------------------------------------
DROP POLICY IF EXISTS "reserve_policies_select" ON "finance"."reserve_policies";
DROP POLICY IF EXISTS "reserve_policies_insert" ON "finance"."reserve_policies";
DROP POLICY IF EXISTS "reserve_policies_update" ON "finance"."reserve_policies";
DROP POLICY IF EXISTS "reserve_policies_delete" ON "finance"."reserve_policies";
CREATE POLICY "reserve_policies_select_org_scoped" ON "finance"."reserve_policies"
  FOR SELECT USING (("core"."same_org"("organization_id") AND ("core"."is_ceo_or_admin"() OR "core"."is_finance_head"() OR "core"."has_role"('ACCOUNTANT'::"text") OR "core"."has_role"('VIEWER'::"text"))));
CREATE POLICY "reserve_policies_insert_org_scoped" ON "finance"."reserve_policies"
  FOR INSERT WITH CHECK (("core"."same_org"("organization_id") AND ("core"."is_ceo_or_admin"() OR "core"."is_finance_head"())));
CREATE POLICY "reserve_policies_update_org_scoped" ON "finance"."reserve_policies"
  FOR UPDATE USING (("core"."same_org"("organization_id") AND ("core"."is_ceo_or_admin"() OR "core"."is_finance_head"())))
  WITH CHECK (("core"."same_org"("organization_id") AND ("core"."is_ceo_or_admin"() OR "core"."is_finance_head"())));
CREATE POLICY "reserve_policies_delete_org_scoped" ON "finance"."reserve_policies"
  FOR DELETE USING (("core"."same_org"("organization_id") AND "core"."is_ceo_or_admin"()));

-- finance.tax_rule_sets ------------------------------------------------------
DROP POLICY IF EXISTS "trs_select" ON "finance"."tax_rule_sets";
DROP POLICY IF EXISTS "trs_insert" ON "finance"."tax_rule_sets";
DROP POLICY IF EXISTS "trs_update" ON "finance"."tax_rule_sets";
CREATE POLICY "trs_select_org_scoped" ON "finance"."tax_rule_sets"
  FOR SELECT USING (("core"."same_org"("organization_id") AND ("core"."is_finance_head"() OR "core"."has_role"('ACCOUNTANT'::"text"))));
CREATE POLICY "trs_insert_org_scoped" ON "finance"."tax_rule_sets"
  FOR INSERT WITH CHECK (("core"."same_org"("organization_id") AND ("core"."is_finance_head"() OR "core"."has_role"('ACCOUNTANT'::"text"))));
CREATE POLICY "trs_update_org_scoped" ON "finance"."tax_rule_sets"
  FOR UPDATE USING (("core"."same_org"("organization_id") AND ("core"."is_finance_head"() OR "core"."has_role"('ACCOUNTANT'::"text"))))
  WITH CHECK (("core"."same_org"("organization_id") AND ("core"."is_finance_head"() OR "core"."has_role"('ACCOUNTANT'::"text"))));

-- finance.budget_revisions ------------------------------------------------------
DROP POLICY IF EXISTS "budget_revisions_select" ON "finance"."budget_revisions";
DROP POLICY IF EXISTS "budget_revisions_insert" ON "finance"."budget_revisions";
DROP POLICY IF EXISTS "budget_revisions_update" ON "finance"."budget_revisions";
CREATE POLICY "budget_revisions_select_org_scoped" ON "finance"."budget_revisions"
  FOR SELECT USING (("core"."same_org"("organization_id") AND ("core"."is_ceo_or_admin"() OR "core"."is_finance_head"() OR "core"."has_role"('ACCOUNTANT'::"text") OR "core"."has_role"('VIEWER'::"text") OR ("requested_by" = "auth"."uid"()) OR (EXISTS ( SELECT 1
   FROM "public"."budgets" "b"
  WHERE (("b"."id" = "budget_revisions"."budget_id") AND (("b"."user_id" = "auth"."uid"()) OR (EXISTS ( SELECT 1
           FROM "public"."projects" "p"
          WHERE (("p"."id" = "b"."project_id") AND ("p"."user_id" = "auth"."uid"())))))))))));
CREATE POLICY "budget_revisions_insert_org_scoped" ON "finance"."budget_revisions"
  FOR INSERT WITH CHECK (("core"."same_org"("organization_id") AND (("requested_by" = "auth"."uid"()) OR "core"."is_finance_head"() OR "core"."is_ceo_or_admin"())));
CREATE POLICY "budget_revisions_update_org_scoped" ON "finance"."budget_revisions"
  FOR UPDATE USING (("core"."same_org"("organization_id") AND ("core"."is_ceo_or_admin"() OR "core"."is_finance_head"())))
  WITH CHECK (("core"."same_org"("organization_id") AND ("core"."is_ceo_or_admin"() OR "core"."is_finance_head"())));


-- =============================================================================
-- GROUP C — child tables with no organization_id column: scope via parent
-- =============================================================================

-- finance.depreciation_schedule -> finance.fixed_assets(organization_id) ------
DROP POLICY IF EXISTS "depreciation_schedule_select" ON "finance"."depreciation_schedule";
DROP POLICY IF EXISTS "depreciation_schedule_insert" ON "finance"."depreciation_schedule";
DROP POLICY IF EXISTS "depreciation_schedule_update" ON "finance"."depreciation_schedule";
DROP POLICY IF EXISTS "depreciation_schedule_delete" ON "finance"."depreciation_schedule";
CREATE POLICY "depreciation_schedule_select_org_scoped" ON "finance"."depreciation_schedule"
  FOR SELECT USING ((("auth"."uid"() IS NOT NULL) AND (EXISTS ( SELECT 1 FROM "finance"."fixed_assets" "fa"
    WHERE ("fa"."id" = "depreciation_schedule"."asset_id") AND "core"."same_org"("fa"."organization_id")))));
CREATE POLICY "depreciation_schedule_insert_org_scoped" ON "finance"."depreciation_schedule"
  FOR INSERT WITH CHECK ((("auth"."uid"() IS NOT NULL) AND (EXISTS ( SELECT 1 FROM "finance"."fixed_assets" "fa"
    WHERE ("fa"."id" = "depreciation_schedule"."asset_id") AND "core"."same_org"("fa"."organization_id")))));
CREATE POLICY "depreciation_schedule_update_org_scoped" ON "finance"."depreciation_schedule"
  FOR UPDATE USING ((("auth"."uid"() IS NOT NULL) AND (EXISTS ( SELECT 1 FROM "finance"."fixed_assets" "fa"
    WHERE ("fa"."id" = "depreciation_schedule"."asset_id") AND "core"."same_org"("fa"."organization_id")))));
CREATE POLICY "depreciation_schedule_delete_org_scoped" ON "finance"."depreciation_schedule"
  FOR DELETE USING ((("auth"."uid"() = "created_by") AND (("status")::"text" = 'calculated'::"text") AND (EXISTS ( SELECT 1 FROM "finance"."fixed_assets" "fa"
    WHERE ("fa"."id" = "depreciation_schedule"."asset_id") AND "core"."same_org"("fa"."organization_id")))));

-- finance.statement_lines -> finance.bank_statements(organization_id) ---------
DROP POLICY IF EXISTS "sl_select" ON "finance"."statement_lines";
DROP POLICY IF EXISTS "sl_insert" ON "finance"."statement_lines";
DROP POLICY IF EXISTS "sl_update" ON "finance"."statement_lines";
DROP POLICY IF EXISTS "sl_delete" ON "finance"."statement_lines";
CREATE POLICY "sl_select_org_scoped" ON "finance"."statement_lines"
  FOR SELECT USING ((("auth"."uid"() IS NOT NULL) AND (EXISTS ( SELECT 1 FROM "finance"."bank_statements" "bs"
    WHERE ("bs"."id" = "statement_lines"."bank_statement_id") AND "core"."same_org"("bs"."organization_id")))));
CREATE POLICY "sl_insert_org_scoped" ON "finance"."statement_lines"
  FOR INSERT WITH CHECK ((("auth"."uid"() IS NOT NULL) AND (EXISTS ( SELECT 1 FROM "finance"."bank_statements" "bs"
    WHERE ("bs"."id" = "statement_lines"."bank_statement_id") AND "core"."same_org"("bs"."organization_id")))));
CREATE POLICY "sl_update_org_scoped" ON "finance"."statement_lines"
  FOR UPDATE USING ((("auth"."uid"() IS NOT NULL) AND (EXISTS ( SELECT 1 FROM "finance"."bank_statements" "bs"
    WHERE ("bs"."id" = "statement_lines"."bank_statement_id") AND "core"."same_org"("bs"."organization_id")))));
CREATE POLICY "sl_delete_org_scoped" ON "finance"."statement_lines"
  FOR DELETE USING ((("auth"."uid"() IS NOT NULL) AND (EXISTS ( SELECT 1 FROM "finance"."bank_statements" "bs"
    WHERE ("bs"."id" = "statement_lines"."bank_statement_id") AND "core"."same_org"("bs"."organization_id")))));

-- finance.vendor_bill_lines -> finance.vendor_bills(organization_id) ----------
DROP POLICY IF EXISTS "vbl_select" ON "finance"."vendor_bill_lines";
DROP POLICY IF EXISTS "vbl_insert" ON "finance"."vendor_bill_lines";
DROP POLICY IF EXISTS "vbl_update" ON "finance"."vendor_bill_lines";
CREATE POLICY "vbl_select_org_scoped" ON "finance"."vendor_bill_lines"
  FOR SELECT USING ((("auth"."uid"() IS NOT NULL) AND (EXISTS ( SELECT 1 FROM "finance"."vendor_bills" "vb"
    WHERE ("vb"."id" = "vendor_bill_lines"."vendor_bill_id") AND "core"."same_org"("vb"."organization_id")))));
CREATE POLICY "vbl_insert_org_scoped" ON "finance"."vendor_bill_lines"
  FOR INSERT WITH CHECK ((("auth"."uid"() IS NOT NULL) AND (EXISTS ( SELECT 1 FROM "finance"."vendor_bills" "vb"
    WHERE ("vb"."id" = "vendor_bill_lines"."vendor_bill_id") AND "core"."same_org"("vb"."organization_id")))));
CREATE POLICY "vbl_update_org_scoped" ON "finance"."vendor_bill_lines"
  FOR UPDATE USING ((("auth"."uid"() IS NOT NULL) AND (EXISTS ( SELECT 1 FROM "finance"."vendor_bills" "vb"
    WHERE ("vb"."id" = "vendor_bill_lines"."vendor_bill_id") AND "core"."same_org"("vb"."organization_id")))));

-- finance.distribution_lines -> finance.profit_distributions(organization_id) -
DROP POLICY IF EXISTS "distribution_lines_select" ON "finance"."distribution_lines";
DROP POLICY IF EXISTS "distribution_lines_insert" ON "finance"."distribution_lines";
DROP POLICY IF EXISTS "distribution_lines_update" ON "finance"."distribution_lines";
DROP POLICY IF EXISTS "distribution_lines_delete" ON "finance"."distribution_lines";
CREATE POLICY "distribution_lines_select_org_scoped" ON "finance"."distribution_lines"
  FOR SELECT USING ((("core"."is_ceo_or_admin"() OR "core"."is_finance_head"() OR "core"."has_role"('ACCOUNTANT'::"text")) AND (EXISTS ( SELECT 1 FROM "finance"."profit_distributions" "pd"
    WHERE ("pd"."id" = "distribution_lines"."profit_distribution_id") AND "core"."same_org"("pd"."organization_id")))));
CREATE POLICY "distribution_lines_insert_org_scoped" ON "finance"."distribution_lines"
  FOR INSERT WITH CHECK ((("core"."is_ceo_or_admin"() OR "core"."is_finance_head"()) AND (EXISTS ( SELECT 1 FROM "finance"."profit_distributions" "pd"
    WHERE ("pd"."id" = "distribution_lines"."profit_distribution_id") AND "core"."same_org"("pd"."organization_id")))));
CREATE POLICY "distribution_lines_update_org_scoped" ON "finance"."distribution_lines"
  FOR UPDATE USING ((("core"."is_ceo_or_admin"() OR "core"."is_finance_head"()) AND (EXISTS ( SELECT 1 FROM "finance"."profit_distributions" "pd"
    WHERE ("pd"."id" = "distribution_lines"."profit_distribution_id") AND "core"."same_org"("pd"."organization_id")))));
CREATE POLICY "distribution_lines_delete_org_scoped" ON "finance"."distribution_lines"
  FOR DELETE USING (("core"."is_ceo_or_admin"() AND (EXISTS ( SELECT 1 FROM "finance"."profit_distributions" "pd"
    WHERE ("pd"."id" = "distribution_lines"."profit_distribution_id") AND "core"."same_org"("pd"."organization_id")))));

-- core.employee_links -> core.shared_people(organization_id) ------------------
DROP POLICY IF EXISTS "employee_links_select" ON "core"."employee_links";
DROP POLICY IF EXISTS "employee_links_insert" ON "core"."employee_links";
DROP POLICY IF EXISTS "employee_links_update" ON "core"."employee_links";
CREATE POLICY "employee_links_select_org_scoped" ON "core"."employee_links"
  FOR SELECT USING ((("core"."is_ceo_or_admin"() OR "core"."is_finance_head"()) AND (EXISTS ( SELECT 1 FROM "core"."shared_people" "sp"
    WHERE ("sp"."id" = "employee_links"."shared_person_id") AND "core"."same_org"("sp"."organization_id")))));
CREATE POLICY "employee_links_insert_org_scoped" ON "core"."employee_links"
  FOR INSERT WITH CHECK ((("core"."is_ceo_or_admin"() OR "core"."is_finance_head"()) AND (EXISTS ( SELECT 1 FROM "core"."shared_people" "sp"
    WHERE ("sp"."id" = "employee_links"."shared_person_id") AND "core"."same_org"("sp"."organization_id")))));
CREATE POLICY "employee_links_update_org_scoped" ON "core"."employee_links"
  FOR UPDATE USING ((("core"."is_ceo_or_admin"() OR "core"."is_finance_head"()) AND (EXISTS ( SELECT 1 FROM "core"."shared_people" "sp"
    WHERE ("sp"."id" = "employee_links"."shared_person_id") AND "core"."same_org"("sp"."organization_id")))));


-- =============================================================================
-- GROUP D — logic bug: tautological organization check
-- =============================================================================

-- core.budget_policies: the OLD policy compared organization_id to a
-- subquery selecting budget_policies.organization_id FROM core.user_roles
-- with no correlation to core.user_roles.organization_id -- Postgres treats
-- the unqualified reference as the OUTER row, so it degenerated to
-- "organization_id = organization_id" (always true) for anyone with any
-- active role. Replaced with a direct, correct same_org() check.
DROP POLICY IF EXISTS "budget_policies_org_isolation" ON "core"."budget_policies";
CREATE POLICY "budget_policies_org_isolation_fixed" ON "core"."budget_policies"
  USING ("core"."same_org"("organization_id"))
  WITH CHECK ("core"."same_org"("organization_id"));


-- =============================================================================
-- GROUP E — cross-organization privilege-escalation surfaces
-- =============================================================================

-- core.role_permissions: role_permissions has no organization_id of its own;
-- it is scoped through core.roles.organization_id. The OLD policies gated
-- purely on core.has_permission(auth.uid(), 'ADMIN_USERS') with NO org
-- check, so an ADMIN_USERS user in Org A could read or rewrite the
-- permission grants of a role belonging to Org B.
DROP POLICY IF EXISTS "rp_manage" ON "core"."role_permissions";
DROP POLICY IF EXISTS "rp_select" ON "core"."role_permissions";
CREATE POLICY "rp_select_org_scoped" ON "core"."role_permissions"
  FOR SELECT USING (("core"."has_permission"("auth"."uid"(), 'ADMIN_USERS'::"text") AND (EXISTS ( SELECT 1 FROM "core"."roles" "r"
    WHERE ("r"."id" = "role_permissions"."role_id") AND "core"."same_org"("r"."organization_id")))));
CREATE POLICY "rp_manage_org_scoped" ON "core"."role_permissions"
  FOR ALL USING (("core"."has_permission"("auth"."uid"(), 'ADMIN_USERS'::"text") AND (EXISTS ( SELECT 1 FROM "core"."roles" "r"
    WHERE ("r"."id" = "role_permissions"."role_id") AND "core"."same_org"("r"."organization_id")))))
  WITH CHECK (("core"."has_permission"("auth"."uid"(), 'ADMIN_USERS'::"text") AND (EXISTS ( SELECT 1 FROM "core"."roles" "r"
    WHERE ("r"."id" = "role_permissions"."role_id") AND "core"."same_org"("r"."organization_id")))));

-- core.user_roles: ur_select was already fixed in migration 032 (per its
-- inline comment), but ur_manage -- which governs INSERT/UPDATE/DELETE, i.e.
-- granting or revoking a role from a user -- still had NO organization
-- check. This is the most severe single gap in this migration: it let an
-- ADMIN_USERS user in Org A insert a core.user_roles row granting ANY role
-- (including a CEO role belonging to Org B) to ANY user_id, which is a
-- direct cross-organization account takeover path. Fixed by requiring BOTH
-- that the role being granted belongs to the caller's organization AND that
-- the target user's own profile organization matches the caller's.
DROP POLICY IF EXISTS "ur_manage" ON "core"."user_roles";
CREATE POLICY "ur_manage_org_scoped" ON "core"."user_roles"
  FOR ALL USING (("core"."has_permission"("auth"."uid"(), 'ADMIN_USERS'::"text")
    AND (EXISTS ( SELECT 1 FROM "core"."roles" "r" WHERE ("r"."id" = "user_roles"."role_id") AND "core"."same_org"("r"."organization_id")))
    AND (EXISTS ( SELECT 1 FROM "public"."profiles" "p" WHERE ("p"."user_id" = "user_roles"."user_id") AND "core"."same_org"("p"."organization_id")))))
  WITH CHECK (("core"."has_permission"("auth"."uid"(), 'ADMIN_USERS'::"text")
    AND (EXISTS ( SELECT 1 FROM "core"."roles" "r" WHERE ("r"."id" = "user_roles"."role_id") AND "core"."same_org"("r"."organization_id")))
    AND (EXISTS ( SELECT 1 FROM "public"."profiles" "p" WHERE ("p"."user_id" = "user_roles"."user_id") AND "core"."same_org"("p"."organization_id")))));

-- core.user_permission_overrides: no organization_id column of its own;
-- scoped via the target user's own profile organization. The OLD
-- upo_manage/upo_select_own policies let any ADMIN_USERS user read or set a
-- per-user permission ALLOW/DENY override for a user in ANY organization.
DROP POLICY IF EXISTS "upo_manage" ON "core"."user_permission_overrides";
DROP POLICY IF EXISTS "upo_select_own" ON "core"."user_permission_overrides";
CREATE POLICY "upo_select_own_org_scoped" ON "core"."user_permission_overrides"
  FOR SELECT USING ((("user_id" = "auth"."uid"()) OR ("core"."has_permission"("auth"."uid"(), 'ADMIN_USERS'::"text") AND (EXISTS ( SELECT 1 FROM "public"."profiles" "p"
    WHERE ("p"."user_id" = "user_permission_overrides"."user_id") AND "core"."same_org"("p"."organization_id"))))));
CREATE POLICY "upo_manage_org_scoped" ON "core"."user_permission_overrides"
  FOR ALL USING (("core"."has_permission"("auth"."uid"(), 'ADMIN_USERS'::"text") AND (EXISTS ( SELECT 1 FROM "public"."profiles" "p"
    WHERE ("p"."user_id" = "user_permission_overrides"."user_id") AND "core"."same_org"("p"."organization_id")))))
  WITH CHECK (("core"."has_permission"("auth"."uid"(), 'ADMIN_USERS'::"text") AND (EXISTS ( SELECT 1 FROM "public"."profiles" "p"
    WHERE ("p"."user_id" = "user_permission_overrides"."user_id") AND "core"."same_org"("p"."organization_id")))));

-- core.delegations: delegations_manage (ALL commands) and delegations_create_own
-- had no organization predicate even though core.delegations.organization_id
-- exists. An ADMIN_USERS user in Org A could create/modify/revoke a
-- delegation of permissions between two users regardless of organization.
DROP POLICY IF EXISTS "delegations_manage" ON "core"."delegations";
DROP POLICY IF EXISTS "delegations_create_own" ON "core"."delegations";
CREATE POLICY "delegations_manage_org_scoped" ON "core"."delegations"
  FOR ALL USING (("core"."has_permission"("auth"."uid"(), 'ADMIN_USERS'::"text") AND "core"."same_org"("organization_id")))
  WITH CHECK (("core"."has_permission"("auth"."uid"(), 'ADMIN_USERS'::"text") AND "core"."same_org"("organization_id")));
CREATE POLICY "delegations_create_own_org_scoped" ON "core"."delegations"
  FOR INSERT WITH CHECK (((("from_user_id" = "auth"."uid"()) OR "core"."has_permission"("auth"."uid"(), 'ADMIN_USERS'::"text")) AND "core"."same_org"("organization_id")));

-- core.shared_people: cross-module identity anchor for the future
-- Employee/Payroll integration (spec Appendix D). shared_people_manage and
-- shared_people_select_self had no organization check, so an ADMIN_USERS
-- user in Org A could read or edit the shared identity record of a person
-- in Org B (name, employment reference, status).
DROP POLICY IF EXISTS "shared_people_manage" ON "core"."shared_people";
DROP POLICY IF EXISTS "shared_people_select_self" ON "core"."shared_people";
CREATE POLICY "shared_people_select_self_org_scoped" ON "core"."shared_people"
  FOR SELECT USING ((("auth_user_id" = "auth"."uid"()) OR ("core"."has_permission"("auth"."uid"(), 'ADMIN_USERS'::"text") AND "core"."same_org"("organization_id"))));
CREATE POLICY "shared_people_manage_org_scoped" ON "core"."shared_people"
  FOR ALL USING (("core"."has_permission"("auth"."uid"(), 'ADMIN_USERS'::"text") AND "core"."same_org"("organization_id")))
  WITH CHECK (("core"."has_permission"("auth"."uid"(), 'ADMIN_USERS'::"text") AND "core"."same_org"("organization_id")));


-- =============================================================================
-- End of P1_062
-- =============================================================================