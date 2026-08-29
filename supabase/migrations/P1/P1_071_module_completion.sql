-- OSYSTIC Finance Management System
-- Phase 1 completion: Purchase Requests, Expense Split Coding,
-- Recurring Vendor Bills, Vendor Payment Batches, Tax workflow hardening,
-- and remaining critical database security fixes.

BEGIN;

-- ================================================================
-- CRITICAL SECURITY HARDENING
-- ================================================================
-- C-01: the legacy arbitrary-SQL helper is not required by the current
-- application (AI uses execute_ai_readonly_query). Remove every grant.
REVOKE ALL ON FUNCTION public.execute_sql_query(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.execute_sql_query(text) FROM anon;
REVOKE ALL ON FUNCTION public.execute_sql_query(text) FROM authenticated;
REVOKE ALL ON FUNCTION public.execute_sql_query(text) FROM service_role;

-- C-02: depreciation helpers are SECURITY DEFINER only because they are
-- called by controlled accounting workflows. They must derive the tenant
-- from the asset and reject cross-organization access.
CREATE OR REPLACE FUNCTION finance.fn_add_accumulated_depreciation(
  p_asset_id uuid,
  p_amount numeric(18,2)
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO pg_catalog, finance, core, public
AS $$
DECLARE
  v_org_id uuid;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'Depreciation amount must be greater than zero';
  END IF;

  SELECT organization_id INTO v_org_id
  FROM finance.fixed_assets
  WHERE id = p_asset_id
  FOR UPDATE;

  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'Asset not found';
  END IF;
  IF v_org_id IS DISTINCT FROM core.current_user_org_id() THEN
    RAISE EXCEPTION 'Access denied: asset belongs to another organization';
  END IF;

  UPDATE finance.fixed_assets
  SET accumulated_depreciation = accumulated_depreciation + p_amount,
      net_book_value = GREATEST(base_cost - (accumulated_depreciation + p_amount), 0),
      updated_at = now()
  WHERE id = p_asset_id;
END;
$$;

CREATE OR REPLACE FUNCTION finance.fn_subtract_accumulated_depreciation(
  p_asset_id uuid,
  p_amount numeric(18,2)
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO pg_catalog, finance, core, public
AS $$
DECLARE
  v_org_id uuid;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'Depreciation amount must be greater than zero';
  END IF;

  SELECT organization_id INTO v_org_id
  FROM finance.fixed_assets
  WHERE id = p_asset_id
  FOR UPDATE;

  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'Asset not found';
  END IF;
  IF v_org_id IS DISTINCT FROM core.current_user_org_id() THEN
    RAISE EXCEPTION 'Access denied: asset belongs to another organization';
  END IF;

  UPDATE finance.fixed_assets
  SET accumulated_depreciation = GREATEST(accumulated_depreciation - p_amount, 0),
      net_book_value = GREATEST(base_cost - GREATEST(accumulated_depreciation - p_amount, 0), 0),
      updated_at = now()
  WHERE id = p_asset_id;
END;
$$;

-- C-03: explicitly pin the primary posting function.
ALTER FUNCTION finance.post_journal_entry(
  text, date, uuid, jsonb, text, numeric, text, uuid, uuid, uuid
) SET search_path TO pg_catalog, finance, core, public;

-- C-05: explicitly pin the payroll summary view to security invoker.
ALTER VIEW IF EXISTS public.v_payroll_summary SET (security_invoker = true);

-- C-04: current pre-submission reporting RPCs require an explicit org id;
-- enforce the invariant at execution time for every current signature.
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS sig
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'reporting'
      AND p.proname IN (
        'get_profit_and_loss','get_balance_sheet','get_cash_flow',
        'get_statement_of_changes_in_equity','get_trial_balance'
      )
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM anon', r.sig);
  END LOOP;
END $$;

-- ================================================================
-- MODULE 1: EXPENSE SPLIT CODING
-- ================================================================
CREATE TABLE IF NOT EXISTS finance.expense_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  expense_id uuid NOT NULL REFERENCES public.expenses(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES core.organizations(id),
  line_number integer NOT NULL CHECK (line_number > 0),
  account_id uuid NOT NULL REFERENCES finance.chart_of_accounts(id),
  project_id uuid REFERENCES public.projects(id),
  department_id uuid,
  cost_center_id uuid,
  amount numeric(18,2) NOT NULL CHECK (amount > 0),
  currency text NOT NULL DEFAULT 'PKR',
  base_amount numeric(18,2) NOT NULL CHECK (base_amount > 0),
  description text,
  created_by uuid REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (expense_id, line_number)
);
CREATE INDEX IF NOT EXISTS idx_expense_alloc_org_expense
  ON finance.expense_allocations(organization_id, expense_id);
ALTER TABLE finance.expense_allocations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS expense_alloc_select ON finance.expense_allocations;
DROP POLICY IF EXISTS expense_alloc_insert ON finance.expense_allocations;
DROP POLICY IF EXISTS expense_alloc_update ON finance.expense_allocations;
DROP POLICY IF EXISTS expense_alloc_delete ON finance.expense_allocations;
CREATE POLICY expense_alloc_select ON finance.expense_allocations FOR SELECT TO authenticated
  USING (organization_id = core.current_user_org_id());
CREATE POLICY expense_alloc_insert ON finance.expense_allocations FOR INSERT TO authenticated
  WITH CHECK (organization_id = core.current_user_org_id());
CREATE POLICY expense_alloc_update ON finance.expense_allocations FOR UPDATE TO authenticated
  USING (organization_id = core.current_user_org_id()) WITH CHECK (organization_id = core.current_user_org_id());
CREATE POLICY expense_alloc_delete ON finance.expense_allocations FOR DELETE TO authenticated
  USING (organization_id = core.current_user_org_id());

-- Purchase-request permissions were not present in the baseline permission seed.
INSERT INTO core.permissions (code, name, module, action, is_system, description) VALUES
  ('PURCHASE_REQUEST_READ','View Purchase Requests','purchase_request','read',true,'View organization purchase requests'),
  ('PURCHASE_REQUEST_CREATE','Create Purchase Request','purchase_request','create',true,'Create a purchase request'),
  ('PURCHASE_REQUEST_UPDATE','Update Purchase Request','purchase_request','update',true,'Submit/cancel purchase requests'),
  ('PURCHASE_REQUEST_APPROVE','Approve Purchase Request','purchase_request','approve',true,'Approve or reject purchase requests')
ON CONFLICT (code) DO NOTHING;

-- Give create/read/update to normal finance users; approval remains restricted
-- to Finance Head/CEO. Existing permission/RBAC functions still enforce the
-- final decision at request time.
INSERT INTO core.role_permissions (role_id, permission_id, data_scope, effective_from)
SELECT r.id, p.id, 'ALL', CURRENT_DATE
FROM core.roles r CROSS JOIN core.permissions p
WHERE p.code IN ('PURCHASE_REQUEST_READ','PURCHASE_REQUEST_CREATE','PURCHASE_REQUEST_UPDATE')
  AND r.name IN ('CEO','FINANCE_HEAD','ACCOUNTANT','HOD','PROJECT_MANAGER','EMPLOYEE')
  AND NOT EXISTS (SELECT 1 FROM core.role_permissions rp WHERE rp.role_id=r.id AND rp.permission_id=p.id AND rp.effective_to IS NULL);
INSERT INTO core.role_permissions (role_id, permission_id, data_scope, effective_from)
SELECT r.id, p.id, 'ALL', CURRENT_DATE
FROM core.roles r CROSS JOIN core.permissions p
WHERE p.code = 'PURCHASE_REQUEST_APPROVE'
  AND r.name IN ('CEO','FINANCE_HEAD')
  AND NOT EXISTS (SELECT 1 FROM core.role_permissions rp WHERE rp.role_id=r.id AND rp.permission_id=p.id AND rp.effective_to IS NULL);

-- ================================================================
-- MODULE 2: PURCHASE REQUESTS
-- ================================================================
CREATE TABLE IF NOT EXISTS finance.purchase_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES core.organizations(id),
  request_number text NOT NULL,
  description text NOT NULL CHECK (btrim(description) <> ''),
  amount numeric(18,2) NOT NULL CHECK (amount > 0),
  currency text NOT NULL DEFAULT 'PKR' CHECK (currency ~ '^[A-Z]{3}$'),
  category text,
  vendor_id uuid REFERENCES finance.vendors(id),
  project_id uuid REFERENCES public.projects(id),
  required_date date,
  justification text,
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','SUBMITTED','APPROVED','REJECTED','CANCELLED')),
  requested_by uuid NOT NULL REFERENCES auth.users(id),
  submitted_by uuid REFERENCES auth.users(id),
  submitted_at timestamptz,
  approved_by uuid REFERENCES auth.users(id),
  approved_at timestamptz,
  rejection_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, request_number)
);
CREATE INDEX IF NOT EXISTS idx_purchase_requests_org_status
  ON finance.purchase_requests(organization_id, status, created_at DESC);
ALTER TABLE finance.purchase_requests ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS purchase_requests_select ON finance.purchase_requests;
DROP POLICY IF EXISTS purchase_requests_insert ON finance.purchase_requests;
DROP POLICY IF EXISTS purchase_requests_update ON finance.purchase_requests;
CREATE POLICY purchase_requests_select ON finance.purchase_requests FOR SELECT TO authenticated
  USING (organization_id = core.current_user_org_id());
CREATE POLICY purchase_requests_insert ON finance.purchase_requests FOR INSERT TO authenticated
  WITH CHECK (organization_id = core.current_user_org_id() AND requested_by = auth.uid());
CREATE POLICY purchase_requests_update ON finance.purchase_requests FOR UPDATE TO authenticated
  USING (organization_id = core.current_user_org_id()) WITH CHECK (organization_id = core.current_user_org_id());

-- ================================================================
-- MODULE 3: RECURRING VENDOR BILLS + PAYMENT BATCHES
-- ================================================================
CREATE TABLE IF NOT EXISTS finance.recurring_vendor_bills (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES core.organizations(id),
  template_name text NOT NULL CHECK (btrim(template_name) <> ''),
  vendor_id uuid NOT NULL REFERENCES finance.vendors(id),
  frequency text NOT NULL CHECK (frequency IN ('MONTHLY','QUARTERLY','YEARLY')),
  next_run_date date NOT NULL,
  end_date date,
  currency text NOT NULL DEFAULT 'PKR' CHECK (currency ~ '^[A-Z]{3}$'),
  exchange_rate numeric(18,6) NOT NULL DEFAULT 1 CHECK (exchange_rate > 0),
  due_days integer NOT NULL DEFAULT 30 CHECK (due_days >= 0),
  project_id uuid REFERENCES public.projects(id),
  description text,
  template_lines jsonb NOT NULL DEFAULT '[]'::jsonb,
  last_generated_date date,
  is_active boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (jsonb_typeof(template_lines) = 'array'),
  CHECK (end_date IS NULL OR end_date >= next_run_date)
);
CREATE INDEX IF NOT EXISTS idx_recurring_vendor_bills_org_next_run
  ON finance.recurring_vendor_bills(organization_id, next_run_date) WHERE is_active;
ALTER TABLE finance.recurring_vendor_bills ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS recurring_vendor_bills_select ON finance.recurring_vendor_bills;
DROP POLICY IF EXISTS recurring_vendor_bills_insert ON finance.recurring_vendor_bills;
DROP POLICY IF EXISTS recurring_vendor_bills_update ON finance.recurring_vendor_bills;
CREATE POLICY recurring_vendor_bills_select ON finance.recurring_vendor_bills FOR SELECT TO authenticated
  USING (organization_id = core.current_user_org_id());
CREATE POLICY recurring_vendor_bills_insert ON finance.recurring_vendor_bills FOR INSERT TO authenticated
  WITH CHECK (organization_id = core.current_user_org_id());
CREATE POLICY recurring_vendor_bills_update ON finance.recurring_vendor_bills FOR UPDATE TO authenticated
  USING (organization_id = core.current_user_org_id()) WITH CHECK (organization_id = core.current_user_org_id());

CREATE TABLE IF NOT EXISTS finance.vendor_payment_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES core.organizations(id),
  batch_number text NOT NULL,
  payment_date date NOT NULL,
  financial_account_id uuid NOT NULL REFERENCES finance.financial_accounts(id),
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','SUBMITTED','APPROVED','POSTED','CANCELLED')),
  total_amount numeric(18,2) NOT NULL CHECK (total_amount > 0),
  payment_count integer NOT NULL DEFAULT 0 CHECK (payment_count > 0),
  risk_flags jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_by uuid REFERENCES auth.users(id),
  submitted_by uuid REFERENCES auth.users(id),
  submitted_at timestamptz,
  approved_by uuid REFERENCES auth.users(id),
  approved_at timestamptz,
  posted_by uuid REFERENCES auth.users(id),
  posted_at timestamptz,
  cancellation_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, batch_number)
);
CREATE INDEX IF NOT EXISTS idx_vendor_payment_batches_org_status
  ON finance.vendor_payment_batches(organization_id, status, created_at DESC);
ALTER TABLE finance.vendor_payment_batches ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS vendor_payment_batches_select ON finance.vendor_payment_batches;
DROP POLICY IF EXISTS vendor_payment_batches_insert ON finance.vendor_payment_batches;
DROP POLICY IF EXISTS vendor_payment_batches_update ON finance.vendor_payment_batches;
CREATE POLICY vendor_payment_batches_select ON finance.vendor_payment_batches FOR SELECT TO authenticated
  USING (organization_id = core.current_user_org_id());
CREATE POLICY vendor_payment_batches_insert ON finance.vendor_payment_batches FOR INSERT TO authenticated
  WITH CHECK (organization_id = core.current_user_org_id());
CREATE POLICY vendor_payment_batches_update ON finance.vendor_payment_batches FOR UPDATE TO authenticated
  USING (organization_id = core.current_user_org_id()) WITH CHECK (organization_id = core.current_user_org_id());

CREATE TABLE IF NOT EXISTS finance.vendor_payment_batch_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id uuid NOT NULL REFERENCES finance.vendor_payment_batches(id) ON DELETE CASCADE,
  vendor_payment_id uuid NOT NULL REFERENCES finance.vendor_payments(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES core.organizations(id),
  amount numeric(18,2) NOT NULL CHECK (amount > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (batch_id, vendor_payment_id)
);
CREATE INDEX IF NOT EXISTS idx_vendor_payment_batch_lines_org
  ON finance.vendor_payment_batch_lines(organization_id, batch_id);
ALTER TABLE finance.vendor_payment_batch_lines ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS vendor_payment_batch_lines_select ON finance.vendor_payment_batch_lines;
DROP POLICY IF EXISTS vendor_payment_batch_lines_insert ON finance.vendor_payment_batch_lines;
CREATE POLICY vendor_payment_batch_lines_select ON finance.vendor_payment_batch_lines FOR SELECT TO authenticated
  USING (organization_id = core.current_user_org_id());
CREATE POLICY vendor_payment_batch_lines_insert ON finance.vendor_payment_batch_lines FOR INSERT TO authenticated
  WITH CHECK (organization_id = core.current_user_org_id());

-- Audit every new operational record. The audit trigger already exists in the
-- platform and captures actor, organization and before/after state.
DROP TRIGGER IF EXISTS purchase_requests_audit ON finance.purchase_requests;
CREATE TRIGGER purchase_requests_audit AFTER INSERT OR UPDATE OR DELETE ON finance.purchase_requests
  FOR EACH ROW EXECUTE FUNCTION audit.trigger_audit_log();
DROP TRIGGER IF EXISTS expense_allocations_audit ON finance.expense_allocations;
CREATE TRIGGER expense_allocations_audit AFTER INSERT OR UPDATE OR DELETE ON finance.expense_allocations
  FOR EACH ROW EXECUTE FUNCTION audit.trigger_audit_log();
DROP TRIGGER IF EXISTS recurring_vendor_bills_audit ON finance.recurring_vendor_bills;
CREATE TRIGGER recurring_vendor_bills_audit AFTER INSERT OR UPDATE OR DELETE ON finance.recurring_vendor_bills
  FOR EACH ROW EXECUTE FUNCTION audit.trigger_audit_log();
DROP TRIGGER IF EXISTS vendor_payment_batches_audit ON finance.vendor_payment_batches;
CREATE TRIGGER vendor_payment_batches_audit AFTER INSERT OR UPDATE OR DELETE ON finance.vendor_payment_batches
  FOR EACH ROW EXECUTE FUNCTION audit.trigger_audit_log();
DROP TRIGGER IF EXISTS vendor_payment_batch_lines_audit ON finance.vendor_payment_batch_lines;
CREATE TRIGGER vendor_payment_batch_lines_audit AFTER INSERT OR UPDATE OR DELETE ON finance.vendor_payment_batch_lines
  FOR EACH ROW EXECUTE FUNCTION audit.trigger_audit_log();

-- ================================================================
-- TAX MODULE: canonical tenant FK + workflow RPCs
-- ================================================================
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tax_returns_organization_id_fkey') THEN ALTER TABLE finance.tax_returns DROP CONSTRAINT tax_returns_organization_id_fkey; END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tax_computations_organization_id_fkey') THEN ALTER TABLE finance.tax_computations DROP CONSTRAINT tax_computations_organization_id_fkey; END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tax_credits_and_withholding_organization_id_fkey') THEN ALTER TABLE finance.tax_credits_and_withholding DROP CONSTRAINT tax_credits_and_withholding_organization_id_fkey; END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tax_payments_and_refunds_organization_id_fkey') THEN ALTER TABLE finance.tax_payments_and_refunds DROP CONSTRAINT tax_payments_and_refunds_organization_id_fkey; END IF;
END $$;

-- Existing tax rows stored organization_config.id. Convert those values to the
-- canonical organizations.id before adding the new FK. Do not guess a mapping.
UPDATE finance.tax_returns tr SET organization_id = oc.organization_id
FROM core.organization_config oc WHERE tr.organization_id = oc.id AND oc.organization_id IS NOT NULL;
UPDATE finance.tax_computations tc SET organization_id = oc.organization_id
FROM core.organization_config oc WHERE tc.organization_id = oc.id AND oc.organization_id IS NOT NULL;
UPDATE finance.tax_credits_and_withholding tw SET organization_id = oc.organization_id
FROM core.organization_config oc WHERE tw.organization_id = oc.id AND oc.organization_id IS NOT NULL;
UPDATE finance.tax_payments_and_refunds tp SET organization_id = oc.organization_id
FROM core.organization_config oc WHERE tp.organization_id = oc.id AND oc.organization_id IS NOT NULL;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM finance.tax_returns WHERE organization_id IS NULL) THEN RAISE EXCEPTION 'Cannot migrate tax_returns: organization mapping is missing'; END IF;
  IF EXISTS (SELECT 1 FROM finance.tax_computations WHERE organization_id IS NULL) THEN RAISE EXCEPTION 'Cannot migrate tax_computations: organization mapping is missing'; END IF;
  IF EXISTS (SELECT 1 FROM finance.tax_credits_and_withholding WHERE organization_id IS NULL) THEN RAISE EXCEPTION 'Cannot migrate tax_credits_and_withholding: organization mapping is missing'; END IF;
  IF EXISTS (SELECT 1 FROM finance.tax_payments_and_refunds WHERE organization_id IS NULL) THEN RAISE EXCEPTION 'Cannot migrate tax_payments_and_refunds: organization mapping is missing'; END IF;
END $$;

ALTER TABLE finance.tax_returns ADD CONSTRAINT tax_returns_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES core.organizations(id);
ALTER TABLE finance.tax_computations ADD CONSTRAINT tax_computations_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES core.organizations(id);
ALTER TABLE finance.tax_credits_and_withholding ADD CONSTRAINT tax_credits_and_withholding_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES core.organizations(id);
ALTER TABLE finance.tax_payments_and_refunds ADD CONSTRAINT tax_payments_and_refunds_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES core.organizations(id);

-- Rebuild tax RLS with the caller's actual organization, not a global
-- organization_config row.
DROP POLICY IF EXISTS tax_ret_select ON finance.tax_returns;
DROP POLICY IF EXISTS tax_ret_insert ON finance.tax_returns;
DROP POLICY IF EXISTS tax_ret_update ON finance.tax_returns;
DROP POLICY IF EXISTS tax_ret_delete ON finance.tax_returns;
CREATE POLICY tax_ret_select ON finance.tax_returns FOR SELECT TO authenticated
  USING (organization_id = core.current_user_org_id());
CREATE POLICY tax_ret_insert ON finance.tax_returns FOR INSERT TO authenticated
  WITH CHECK (organization_id = core.current_user_org_id());
CREATE POLICY tax_ret_update ON finance.tax_returns FOR UPDATE TO authenticated
  USING (organization_id = core.current_user_org_id()) WITH CHECK (organization_id = core.current_user_org_id());
CREATE POLICY tax_ret_delete ON finance.tax_returns FOR DELETE TO authenticated
  USING (organization_id = core.current_user_org_id());

DROP POLICY IF EXISTS tax_cw_select ON finance.tax_credits_and_withholding;
DROP POLICY IF EXISTS tax_cw_insert ON finance.tax_credits_and_withholding;
DROP POLICY IF EXISTS tax_cw_update ON finance.tax_credits_and_withholding;
DROP POLICY IF EXISTS tax_cw_delete ON finance.tax_credits_and_withholding;
CREATE POLICY tax_cw_select ON finance.tax_credits_and_withholding FOR SELECT TO authenticated
  USING (organization_id = core.current_user_org_id());
CREATE POLICY tax_cw_insert ON finance.tax_credits_and_withholding FOR INSERT TO authenticated
  WITH CHECK (organization_id = core.current_user_org_id());
CREATE POLICY tax_cw_update ON finance.tax_credits_and_withholding FOR UPDATE TO authenticated
  USING (organization_id = core.current_user_org_id()) WITH CHECK (organization_id = core.current_user_org_id());
CREATE POLICY tax_cw_delete ON finance.tax_credits_and_withholding FOR DELETE TO authenticated
  USING (organization_id = core.current_user_org_id());

DROP POLICY IF EXISTS tax_pay_select ON finance.tax_payments_and_refunds;
DROP POLICY IF EXISTS tax_pay_insert ON finance.tax_payments_and_refunds;
DROP POLICY IF EXISTS tax_pay_update ON finance.tax_payments_and_refunds;
DROP POLICY IF EXISTS tax_pay_delete ON finance.tax_payments_and_refunds;
CREATE POLICY tax_pay_select ON finance.tax_payments_and_refunds FOR SELECT TO authenticated
  USING (organization_id = core.current_user_org_id());
CREATE POLICY tax_pay_insert ON finance.tax_payments_and_refunds FOR INSERT TO authenticated
  WITH CHECK (organization_id = core.current_user_org_id());
CREATE POLICY tax_pay_update ON finance.tax_payments_and_refunds FOR UPDATE TO authenticated
  USING (organization_id = core.current_user_org_id()) WITH CHECK (organization_id = core.current_user_org_id());
CREATE POLICY tax_pay_delete ON finance.tax_payments_and_refunds FOR DELETE TO authenticated
  USING (organization_id = core.current_user_org_id());

COMMIT;
