-- ============================================================================
-- P1_097_aud_p1_002_tax_computations_rls_fix.sql
--
-- AUD-P1-002 FIX: all four authenticated-role RLS policies on
-- finance.tax_computations (tax_comp_select/insert/update/delete) compare
-- "organization_id" (a FK to core.organizations.id -- see the
-- tax_computations_organization_id_fkey constraint) against
-- core.current_user_org_config_id(), which returns a core.organization_config
-- row id -- a completely different UUID space. "organization_id =
-- current_user_org_config_id()" can therefore never be true for any row, for
-- any user, so every authenticated SELECT/INSERT/UPDATE/DELETE on this table
-- is unconditionally denied (fail-closed -- no data leak, but the tax
-- computation feature is entirely dead).
--
-- Every other finance table scopes by organization via core.same_org(...)
-- (see e.g. finance.tax_codes_select_org, finance.platforms_select_org_scoped,
-- finance.profit_distributions_select_org_scoped), which correctly compares
-- organization_id against core.current_user_org_id() -- the matching UUID
-- space -- and fails closed (false) if either side is NULL. This migration
-- replaces the broken "organization_id = core.current_user_org_config_id()"
-- predicate on all four policies with core.same_org("organization_id"),
-- and changes nothing else: role requirements (is_ceo_or_admin /
-- is_finance_head / ACCOUNTANT / AUDITOR) are preserved verbatim per policy,
-- as is tax_comp_service for service_role, so no access is widened beyond
-- what each policy already intended to grant its own organization.
-- ============================================================================

BEGIN;

DROP POLICY IF EXISTS "tax_comp_delete" ON "finance"."tax_computations";
CREATE POLICY "tax_comp_delete" ON "finance"."tax_computations" FOR DELETE TO "authenticated"
  USING (("core"."same_org"("organization_id") AND ("core"."is_ceo_or_admin"() OR "core"."is_finance_head"())));

DROP POLICY IF EXISTS "tax_comp_insert" ON "finance"."tax_computations";
CREATE POLICY "tax_comp_insert" ON "finance"."tax_computations" FOR INSERT TO "authenticated"
  WITH CHECK (("core"."same_org"("organization_id") AND ("core"."is_ceo_or_admin"() OR "core"."is_finance_head"() OR "core"."has_role"('ACCOUNTANT'::"text"))));

DROP POLICY IF EXISTS "tax_comp_select" ON "finance"."tax_computations";
CREATE POLICY "tax_comp_select" ON "finance"."tax_computations" FOR SELECT TO "authenticated"
  USING (("core"."same_org"("organization_id") AND ("core"."is_ceo_or_admin"() OR "core"."is_finance_head"() OR "core"."has_role"('ACCOUNTANT'::"text") OR "core"."has_role"('AUDITOR'::"text"))));

DROP POLICY IF EXISTS "tax_comp_update" ON "finance"."tax_computations";
CREATE POLICY "tax_comp_update" ON "finance"."tax_computations" FOR UPDATE TO "authenticated"
  USING (("core"."same_org"("organization_id") AND ("core"."is_ceo_or_admin"() OR "core"."is_finance_head"() OR "core"."has_role"('ACCOUNTANT'::"text"))));

-- tax_comp_service (service_role, USING true / WITH CHECK true) is untouched
-- -- it never referenced the broken predicate.

COMMIT;