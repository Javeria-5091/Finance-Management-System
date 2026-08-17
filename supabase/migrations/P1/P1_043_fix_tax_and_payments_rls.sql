-- 043_fix_tax_and_payments_rls.sql
-- Fixes: finance.tax_computations / tax_credits_and_withholding /
-- tax_payments_and_refunds / tax_returns each had SELECT/INSERT/UPDATE/
-- DELETE policies of the form:
--   organization_id = (SELECT id FROM core.organization_config LIMIT 1)
-- with NO reference to the querying user at all -- every authenticated
-- user could read and write every organization's tax data.
-- Also tightens public.payments, whose only SELECT policy was
-- "auth.uid() IS NOT NULL" with no org scope.
--
-- Role model follows spec Appendix A ("Tax reports, rules, adjustments
-- and filing"): CEO=Full, Finance Head=Full, Accountant=Config
-- (create/verify, not necessarily final file/approve), everyone else=None,
-- Auditor=Read.

BEGIN;

-- ---------- finance.tax_computations ----------
DROP POLICY IF EXISTS "tax_comp_delete" ON finance.tax_computations;
DROP POLICY IF EXISTS "tax_comp_insert" ON finance.tax_computations;
DROP POLICY IF EXISTS "tax_comp_select" ON finance.tax_computations;
DROP POLICY IF EXISTS "tax_comp_update" ON finance.tax_computations;
-- tax_comp_service (service_role) is correct as-is; left untouched.

CREATE POLICY "tax_comp_select" ON finance.tax_computations
  FOR SELECT TO authenticated
  USING (
    organization_id = core.current_user_org_config_id()
    AND (core.is_ceo_or_admin() OR core.is_finance_head()
         OR core.has_role('ACCOUNTANT') OR core.has_role('AUDITOR'))
  );

CREATE POLICY "tax_comp_insert" ON finance.tax_computations
  FOR INSERT TO authenticated
  WITH CHECK (
    organization_id = core.current_user_org_config_id()
    AND (core.is_ceo_or_admin() OR core.is_finance_head() OR core.has_role('ACCOUNTANT'))
  );

CREATE POLICY "tax_comp_update" ON finance.tax_computations
  FOR UPDATE TO authenticated
  USING (
    organization_id = core.current_user_org_config_id()
    AND (core.is_ceo_or_admin() OR core.is_finance_head() OR core.has_role('ACCOUNTANT'))
  );

CREATE POLICY "tax_comp_delete" ON finance.tax_computations
  FOR DELETE TO authenticated
  USING (
    organization_id = core.current_user_org_config_id()
    AND (core.is_ceo_or_admin() OR core.is_finance_head())
  );

-- ---------- finance.tax_credits_and_withholding ----------
DROP POLICY IF EXISTS "tax_cw_delete" ON finance.tax_credits_and_withholding;
DROP POLICY IF EXISTS "tax_cw_insert" ON finance.tax_credits_and_withholding;
DROP POLICY IF EXISTS "tax_cw_select" ON finance.tax_credits_and_withholding;
DROP POLICY IF EXISTS "tax_cw_update" ON finance.tax_credits_and_withholding;

CREATE POLICY "tax_cw_select" ON finance.tax_credits_and_withholding
  FOR SELECT TO authenticated
  USING (
    organization_id = core.current_user_org_config_id()
    AND (core.is_ceo_or_admin() OR core.is_finance_head()
         OR core.has_role('ACCOUNTANT') OR core.has_role('AUDITOR'))
  );

CREATE POLICY "tax_cw_insert" ON finance.tax_credits_and_withholding
  FOR INSERT TO authenticated
  WITH CHECK (
    organization_id = core.current_user_org_config_id()
    AND (core.is_ceo_or_admin() OR core.is_finance_head() OR core.has_role('ACCOUNTANT'))
  );

CREATE POLICY "tax_cw_update" ON finance.tax_credits_and_withholding
  FOR UPDATE TO authenticated
  USING (
    organization_id = core.current_user_org_config_id()
    AND (core.is_ceo_or_admin() OR core.is_finance_head() OR core.has_role('ACCOUNTANT'))
  );

CREATE POLICY "tax_cw_delete" ON finance.tax_credits_and_withholding
  FOR DELETE TO authenticated
  USING (
    organization_id = core.current_user_org_config_id()
    AND (core.is_ceo_or_admin() OR core.is_finance_head())
  );

-- ---------- finance.tax_payments_and_refunds ----------
DROP POLICY IF EXISTS "tax_pay_delete" ON finance.tax_payments_and_refunds;
DROP POLICY IF EXISTS "tax_pay_insert" ON finance.tax_payments_and_refunds;
DROP POLICY IF EXISTS "tax_pay_select" ON finance.tax_payments_and_refunds;
DROP POLICY IF EXISTS "tax_pay_update" ON finance.tax_payments_and_refunds;

CREATE POLICY "tax_pay_select" ON finance.tax_payments_and_refunds
  FOR SELECT TO authenticated
  USING (
    organization_id = core.current_user_org_config_id()
    AND (core.is_ceo_or_admin() OR core.is_finance_head()
         OR core.has_role('ACCOUNTANT') OR core.has_role('AUDITOR'))
  );

CREATE POLICY "tax_pay_insert" ON finance.tax_payments_and_refunds
  FOR INSERT TO authenticated
  WITH CHECK (
    organization_id = core.current_user_org_config_id()
    AND (core.is_ceo_or_admin() OR core.is_finance_head() OR core.has_role('ACCOUNTANT'))
  );

CREATE POLICY "tax_pay_update" ON finance.tax_payments_and_refunds
  FOR UPDATE TO authenticated
  USING (
    organization_id = core.current_user_org_config_id()
    AND (core.is_ceo_or_admin() OR core.is_finance_head() OR core.has_role('ACCOUNTANT'))
  );

CREATE POLICY "tax_pay_delete" ON finance.tax_payments_and_refunds
  FOR DELETE TO authenticated
  USING (
    organization_id = core.current_user_org_config_id()
    AND (core.is_ceo_or_admin() OR core.is_finance_head())
  );

-- ---------- finance.tax_returns ----------
DROP POLICY IF EXISTS "tax_ret_delete" ON finance.tax_returns;
DROP POLICY IF EXISTS "tax_ret_insert" ON finance.tax_returns;
DROP POLICY IF EXISTS "tax_ret_select" ON finance.tax_returns;
DROP POLICY IF EXISTS "tax_ret_update" ON finance.tax_returns;

CREATE POLICY "tax_ret_select" ON finance.tax_returns
  FOR SELECT TO authenticated
  USING (
    organization_id = core.current_user_org_config_id()
    AND (core.is_ceo_or_admin() OR core.is_finance_head()
         OR core.has_role('ACCOUNTANT') OR core.has_role('AUDITOR'))
  );

CREATE POLICY "tax_ret_insert" ON finance.tax_returns
  FOR INSERT TO authenticated
  WITH CHECK (
    organization_id = core.current_user_org_config_id()
    AND (core.is_ceo_or_admin() OR core.is_finance_head() OR core.has_role('ACCOUNTANT'))
  );

CREATE POLICY "tax_ret_update" ON finance.tax_returns
  FOR UPDATE TO authenticated
  USING (
    organization_id = core.current_user_org_config_id()
    AND (core.is_ceo_or_admin() OR core.is_finance_head() OR core.has_role('ACCOUNTANT'))
  );

-- Filing/deletion of a tax return record is CEO/Finance Head only per
-- spec Appendix A ("Tax reports... and filing: CEO Full, Finance Head Full").
CREATE POLICY "tax_ret_delete" ON finance.tax_returns
  FOR DELETE TO authenticated
  USING (
    organization_id = core.current_user_org_config_id()
    AND (core.is_ceo_or_admin() OR core.is_finance_head())
  );

-- ---------- public.payments ----------
-- Leave "Admin can manage payments" and "Users with permission can manage
-- payments" (auth.uid() = user_id) alone -- both are reasonably scoped.
-- Replace only the blanket "Anyone authenticated can view payments".
DROP POLICY IF EXISTS "Anyone authenticated can view payments" ON public.payments;

CREATE POLICY "org_scoped_view_payments" ON public.payments
  FOR SELECT TO authenticated
  USING (
    -- own payments always visible
    user_id = auth.uid()
    OR
    -- otherwise must be finance/admin AND same org (falls back to
    -- visible-if-organization_id is NULL only for is_admin(), since
    -- legacy rows predating org assignment shouldn't become invisible
    -- to admins performing the eventual consolidation/cleanup).
    public.is_admin()
    OR (
      (core.is_ceo_or_admin() OR core.is_finance_head() OR core.has_role('ACCOUNTANT'))
      AND organization_id = core.current_user_org_config_id()
    )
  );

COMMENT ON POLICY "org_scoped_view_payments" ON public.payments IS
  'Fixed migration 033 (Compliance Audit R7): replaced "auth.uid() IS NOT NULL" (any authenticated user, any org) with owner/admin/org-scoped-finance-role access.';

COMMIT;