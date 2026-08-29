-- OSYSTIC Phase 3: Commissions + Payroll hardening (CORRECTED)
-- Completes the commission server boundary and strengthens payroll accounting/security.
--
-- CORRECTION NOTE (vs original P2_005):
-- The original script tried to DROP POLICY on names that never existed
-- ("Authenticated insert/select/update/delete on commissions"), so those
-- DROPs silently no-op'd. It then CREATEd differently-named policies
-- alongside the real pre-existing ones (commissions_*_org_scoped).
-- Because Postgres OR's multiple PERMISSIVE policies together for the same
-- command, the new commissions_select_org policy (same_org only, no role
-- check) widened SELECT access to every authenticated same-org user,
-- bypassing the existing finance_head/accountant restriction.
-- This version replaces the actual existing policies by their real names
-- instead of adding parallel ones, so there is exactly one policy per
-- command and no accidental access widening.

BEGIN;

-- 1) Commission org integrity + useful composite indexes
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.commissions'::regclass
      AND conname = 'commissions_org_required'
  ) THEN
    ALTER TABLE public.commissions
      ADD CONSTRAINT commissions_org_required CHECK (organization_id IS NOT NULL);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_commissions_org_status_created
  ON public.commissions (organization_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_commissions_org_project
  ON public.commissions (organization_id, project_id);

-- Replace the ACTUAL existing commission policies (by their real names) so
-- there is exactly one policy per command -- no parallel/duplicate policy,
-- no accidental widening of access via OR'd permissive policies.
DROP POLICY IF EXISTS commissions_insert_org_scoped ON public.commissions;
DROP POLICY IF EXISTS commissions_select_org_scoped ON public.commissions;
DROP POLICY IF EXISTS commissions_update_org_scoped ON public.commissions;
DROP POLICY IF EXISTS commissions_delete_org_scoped ON public.commissions;
-- Also drop these in case an earlier run of the original (uncorrected)
-- script already created them on this database.
DROP POLICY IF EXISTS commissions_insert_org ON public.commissions;
DROP POLICY IF EXISTS commissions_select_org ON public.commissions;
DROP POLICY IF EXISTS commissions_update_org ON public.commissions;
DROP POLICY IF EXISTS commissions_delete_org ON public.commissions;

CREATE POLICY commissions_insert_org ON public.commissions FOR INSERT TO authenticated
  WITH CHECK (core.same_org(organization_id) AND (core.is_finance_head() OR core.has_role('ACCOUNTANT')));
CREATE POLICY commissions_select_org ON public.commissions FOR SELECT TO authenticated
  USING (core.same_org(organization_id) AND (core.is_finance_head() OR core.has_role('ACCOUNTANT')));
CREATE POLICY commissions_update_org ON public.commissions FOR UPDATE TO authenticated
  USING (core.same_org(organization_id) AND (core.is_finance_head() OR core.has_role('ACCOUNTANT')))
  WITH CHECK (core.same_org(organization_id) AND (core.is_finance_head() OR core.has_role('ACCOUNTANT')));
CREATE POLICY commissions_delete_org ON public.commissions FOR DELETE TO authenticated
  USING (core.same_org(organization_id) AND core.is_finance_head());

-- 2) Payroll sensitive-data views must execute as the querying user.
DO $$
BEGIN
  IF to_regclass('public.v_payroll_summary') IS NOT NULL THEN
    EXECUTE 'ALTER VIEW public.v_payroll_summary SET (security_invoker = true)';
  END IF;
END $$;

-- 3) Prevent impossible payroll monetary values.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.payroll_lines'::regclass
      AND conname = 'payroll_lines_nonnegative_check'
  ) THEN
    ALTER TABLE public.payroll_lines
      ADD CONSTRAINT payroll_lines_nonnegative_check CHECK (
        basic_salary >= 0 AND housing_allow >= 0 AND medical_allow >= 0 AND
        conveyance_allow >= 0 AND other_allowances >= 0 AND overtime_pay >= 0 AND
        commission_pay >= 0 AND bonus_pay >= 0 AND gross_pay >= 0 AND
        tax_deduction >= 0 AND provident_fund >= 0 AND eobi >= 0 AND
        advance_deduction >= 0 AND other_deductions >= 0 AND total_deductions >= 0 AND
        net_pay >= 0 AND employer_cost >= 0
      );
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.payroll_runs'::regclass
      AND conname = 'payroll_runs_amounts_nonnegative_check'
  ) THEN
    ALTER TABLE public.payroll_runs
      ADD CONSTRAINT payroll_runs_amounts_nonnegative_check CHECK (
        total_gross_pay >= 0 AND total_deductions >= 0 AND total_net_pay >= 0 AND total_employer_cost >= 0
      );
  END IF;
END $$;

-- 4) Payroll commission values must be nonnegative.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.payroll_commissions'::regclass
      AND conname = 'payroll_commissions_amounts_check'
  ) THEN
    ALTER TABLE public.payroll_commissions
      ADD CONSTRAINT payroll_commissions_amounts_check CHECK (
        base_amount >= 0 AND commission_rate >= 0 AND commission_amount >= 0
      );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_payroll_commissions_org_status_period
  ON public.payroll_commissions (organization_id, status, period_month);

-- 5) Payroll employee/compensation/advance/reimbursement org indexes.
CREATE INDEX IF NOT EXISTS idx_payroll_employees_org_status
  ON public.payroll_employees (organization_id, status);
CREATE INDEX IF NOT EXISTS idx_payroll_compensation_employee_effective
  ON public.payroll_compensation (employee_id, effective_from DESC);
CREATE INDEX IF NOT EXISTS idx_payroll_advances_org_status
  ON public.payroll_advances (organization_id, approval_status);
CREATE INDEX IF NOT EXISTS idx_payroll_reimbursements_org_status
  ON public.payroll_reimbursements (organization_id, status);

COMMIT;