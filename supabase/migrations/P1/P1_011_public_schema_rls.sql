-- ============================================================================
-- P0 FIX: Enable RLS on ALL public schema operational tables
-- Gap Report Bug 3.4: Public schema tables had NO RLS enabled.
-- If anon key leaks or authenticated user queries DB directly,
-- they could access other organizations' data.
-- ============================================================================

-- Helper: Get current user's organization_id from their active role
-- (Reusable across all policies)
CREATE OR REPLACE FUNCTION core.get_current_org_id()
RETURNS UUID AS $$
  SELECT organization_id
  FROM core.user_roles
  WHERE user_id = auth.uid()
    AND is_active = true
    AND effective_from <= now()
    AND (effective_to IS NULL OR effective_to >= now())
  LIMIT 1;
$$ LANGUAGE sql STABLE SECURITY DEFINER;

-- ─── Enable RLS on all public schema operational tables ───

ALTER TABLE public.incomes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.expenses ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.budgets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.contractors ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.commissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payroll ENABLE ROW LEVEL SECURITY;

-- ─── Organization-level isolation policies ───
-- Users can only see data belonging to their own organization.

CREATE POLICY incomes_org_isolation ON public.incomes
  FOR ALL USING (organization_id = core.get_current_org_id());

CREATE POLICY expenses_org_isolation ON public.expenses
  FOR ALL USING (organization_id = core.get_current_org_id());

CREATE POLICY invoices_org_isolation ON public.invoices
  FOR ALL USING (organization_id = core.get_current_org_id());

CREATE POLICY budgets_org_isolation ON public.budgets
  FOR ALL USING (organization_id = core.get_current_org_id());

CREATE POLICY projects_org_isolation ON public.projects
  FOR ALL USING (organization_id = core.get_current_org_id());

CREATE POLICY payments_org_isolation ON public.payments
  FOR ALL USING (organization_id = core.get_current_org_id());

CREATE POLICY clients_org_isolation ON public.clients
  FOR ALL USING (organization_id = core.get_current_org_id());

CREATE POLICY subscriptions_org_isolation ON public.subscriptions
  FOR ALL USING (organization_id = core.get_current_org_id());

CREATE POLICY contractors_org_isolation ON public.contractors
  FOR ALL USING (organization_id = core.get_current_org_id());

CREATE POLICY commissions_org_isolation ON public.commissions
  FOR ALL USING (organization_id = core.get_current_org_id());

CREATE POLICY payroll_org_isolation ON public.payroll
  FOR ALL USING (organization_id = core.get_current_org_id());

-- ─── Service role bypass (for admin operations) ───
-- Service role can access all data (needed for migrations, admin tasks)
CREATE POLICY incomes_service_role ON public.incomes
  FOR ALL TO authenticated USING (true);

COMMENT ON FUNCTION core.get_current_org_id() IS 'Returns the organization_id of the current user from their active role. Used by RLS policies for org-level isolation.';
