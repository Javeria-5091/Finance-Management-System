/*
 OSYSTIC Finance Management System
 Safe database correction patch

 SOURCE OF TRUTH:
   schema.sql from the supplied current ZIP.

 IMPORTANT:
   - This file is a corrective patch for the CURRENT database schema.
   - Outdated migration files are NOT used as the source of truth.
   - No application/API/service/frontend code is modified here.
   - No existing data is deleted.
   - Organization isolation is fail-closed and is strengthened for new objects.

 Run this patch only after taking a current database backup/snapshot.
*/

BEGIN;

/* ================================================================
   1. EXACT JOURNAL BALANCE
   Audit DB-008 confirmed that the current function accepts a 0.01
   imbalance. Financial posting must be exact at the stored precision.
   ================================================================ */

CREATE OR REPLACE FUNCTION finance.check_journal_balance()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_journal_id uuid;
  v_total_debit numeric(18,2);
  v_total_credit numeric(18,2);
  v_total_base_debit numeric(18,2);
  v_total_base_credit numeric(18,2);
BEGIN
  v_journal_id := COALESCE(NEW.journal_entry_id, OLD.journal_entry_id);

  SELECT
    COALESCE(SUM(debit_amount), 0),
    COALESCE(SUM(credit_amount), 0),
    COALESCE(SUM(COALESCE(base_debit, debit_amount)), 0),
    COALESCE(SUM(COALESCE(base_credit, credit_amount)), 0)
  INTO
    v_total_debit,
    v_total_credit,
    v_total_base_debit,
    v_total_base_credit
  FROM finance.journal_lines
  WHERE journal_entry_id = v_journal_id;

  IF v_total_debit <> v_total_credit THEN
    RAISE EXCEPTION
      'Journal entry % is unbalanced in transaction currency: debit % != credit %',
      v_journal_id, v_total_debit, v_total_credit
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_total_base_debit <> v_total_base_credit THEN
    RAISE EXCEPTION
      'Journal entry % is unbalanced in base (PKR) currency: base debit % != base credit %',
      v_journal_id, v_total_base_debit, v_total_base_credit
      USING ERRCODE = 'check_violation';
  END IF;

  UPDATE finance.journal_entries
  SET total_debit = v_total_debit,
      total_credit = v_total_credit
  WHERE id = v_journal_id;

  RETURN NULL;
END;
$$;

/* ================================================================
   2. SECURITY-DEFINER AI USAGE FUNCTION
   Audit DB-010 confirmed an unsafe search_path and an organization
   spoofing/cost-manipulation path.
   ================================================================ */

CREATE OR REPLACE FUNCTION ai.increment_usage(
  p_user_id uuid,
  p_organization_id uuid,
  p_tokens integer,
  p_cost numeric
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO pg_catalog, ai, core, public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF p_user_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'Cannot record AI usage for another user';
  END IF;

  IF NOT core.same_org(p_organization_id) THEN
    RAISE EXCEPTION 'Cannot record AI usage for another organization';
  END IF;

  INSERT INTO ai.ai_user_cost_tracking
    (user_id, organization_id, period_date, request_count, total_tokens, estimated_cost)
  VALUES
    (p_user_id, p_organization_id, CURRENT_DATE, 1,
     GREATEST(COALESCE(p_tokens, 0), 0),
     GREATEST(COALESCE(p_cost, 0), 0))
  ON CONFLICT (user_id, organization_id, period_date)
  DO UPDATE SET
    request_count = ai.ai_user_cost_tracking.request_count + 1,
    total_tokens = ai.ai_user_cost_tracking.total_tokens + GREATEST(COALESCE(p_tokens, 0), 0),
    estimated_cost = ai.ai_user_cost_tracking.estimated_cost + GREATEST(COALESCE(p_cost, 0), 0),
    updated_at = now();
END;
$$;

REVOKE ALL ON FUNCTION ai.increment_usage(uuid, uuid, integer, numeric) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ai.increment_usage(uuid, uuid, integer, numeric) TO authenticated;

/* ================================================================
   3. REMOVE CONFIRMED DUPLICATE TRIGGERS
   The current schema contains duplicate trigger registrations that
   execute the same business function more than once for the same event.
   Keep one canonical trigger per behavior.
   ================================================================ */

DROP TRIGGER IF EXISTS trg_bt_dual_approval ON finance.bank_transfers;
DROP TRIGGER IF EXISTS trg_fa_validate_ledger ON finance.financial_accounts;
DROP TRIGGER IF EXISTS trg_sl_prevent_double_match ON finance.statement_lines;
DROP TRIGGER IF EXISTS trg_asset_nbv ON finance.fixed_assets;
DROP TRIGGER IF EXISTS trg_fixed_assets_ts ON finance.fixed_assets;

/* Redundant timestamp triggers: keep the module-specific canonical trigger. */
DROP TRIGGER IF EXISTS trg_updated_at ON public.commissions;
DROP TRIGGER IF EXISTS trg_updated_at ON public.contractors;
DROP TRIGGER IF EXISTS trg_updated_at ON public.payroll_advances;
DROP TRIGGER IF EXISTS trg_updated_at ON public.payroll_commissions;
DROP TRIGGER IF EXISTS trg_updated_at ON public.payroll_compensation;
DROP TRIGGER IF EXISTS trg_updated_at ON public.payroll_deductions;
DROP TRIGGER IF EXISTS trg_updated_at ON public.payroll_employees;
DROP TRIGGER IF EXISTS trg_updated_at ON public.payroll_lines;
DROP TRIGGER IF EXISTS trg_updated_at ON public.payroll_reimbursements;
DROP TRIGGER IF EXISTS trg_updated_at ON public.payroll_runs;
DROP TRIGGER IF EXISTS trg_updated_at ON public.subscriptions;

/* ================================================================
   4. TAX CODES — required by the specification and already referenced
      by journal/vendor line structures in the current schema.
   ================================================================ */

CREATE TABLE IF NOT EXISTS finance.tax_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES core.organizations(id) ON DELETE RESTRICT,
  code text NOT NULL,
  name text NOT NULL,
  tax_type text NOT NULL DEFAULT 'TAX',
  rate numeric(8,4) NOT NULL DEFAULT 0,
  recoverable_account_id uuid REFERENCES finance.chart_of_accounts(id) ON DELETE RESTRICT,
  payable_account_id uuid REFERENCES finance.chart_of_accounts(id) ON DELETE RESTRICT,
  effective_from date NOT NULL DEFAULT CURRENT_DATE,
  effective_to date,
  is_active boolean NOT NULL DEFAULT true,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tax_codes_rate_check CHECK (rate >= 0),
  CONSTRAINT tax_codes_dates_check CHECK (effective_to IS NULL OR effective_to >= effective_from),
  CONSTRAINT tax_codes_code_not_empty CHECK (btrim(code) <> ''),
  CONSTRAINT tax_codes_name_not_empty CHECK (btrim(name) <> ''),
  CONSTRAINT tax_codes_org_code_key UNIQUE (organization_id, code)
);

ALTER TABLE finance.tax_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE finance.tax_codes FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tax_codes_select_org ON finance.tax_codes;
DROP POLICY IF EXISTS tax_codes_insert_org ON finance.tax_codes;
DROP POLICY IF EXISTS tax_codes_update_org ON finance.tax_codes;
DROP POLICY IF EXISTS tax_codes_delete_org ON finance.tax_codes;

CREATE POLICY tax_codes_select_org ON finance.tax_codes
  FOR SELECT TO authenticated
  USING (core.same_org(organization_id));
CREATE POLICY tax_codes_insert_org ON finance.tax_codes
  FOR INSERT TO authenticated
  WITH CHECK (core.same_org(organization_id) AND (core.is_finance_head() OR core.has_role('ACCOUNTANT')));
CREATE POLICY tax_codes_update_org ON finance.tax_codes
  FOR UPDATE TO authenticated
  USING (core.same_org(organization_id) AND (core.is_finance_head() OR core.has_role('ACCOUNTANT')))
  WITH CHECK (core.same_org(organization_id) AND (core.is_finance_head() OR core.has_role('ACCOUNTANT')));
CREATE POLICY tax_codes_delete_org ON finance.tax_codes
  FOR DELETE TO authenticated
  USING (core.same_org(organization_id) AND core.is_finance_head());

GRANT SELECT, INSERT, UPDATE, DELETE ON finance.tax_codes TO authenticated;
GRANT ALL ON finance.tax_codes TO service_role;

DROP TRIGGER IF EXISTS tax_codes_updated_at ON finance.tax_codes;
CREATE TRIGGER tax_codes_updated_at
  BEFORE UPDATE ON finance.tax_codes
  FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();

DROP TRIGGER IF EXISTS tax_codes_audit ON finance.tax_codes;
CREATE TRIGGER tax_codes_audit
  AFTER INSERT OR UPDATE OR DELETE ON finance.tax_codes
  FOR EACH ROW EXECUTE FUNCTION audit.trigger_audit_log();

/* Existing nullable tax-code references are linked to the new canonical table.
   The constraint is validated only if current data is clean; otherwise the
   whole transaction aborts instead of silently changing data. */
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM finance.journal_lines jl
    LEFT JOIN finance.tax_codes tc ON tc.id = jl.tax_code_id
    WHERE jl.tax_code_id IS NOT NULL AND tc.id IS NULL
  ) THEN
    RAISE EXCEPTION 'Cannot add journal_lines.tax_code_id FK: orphan tax_code_id values exist';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM finance.vendor_bill_lines vbl
    LEFT JOIN finance.tax_codes tc ON tc.id = vbl.tax_code_id
    WHERE vbl.tax_code_id IS NOT NULL AND tc.id IS NULL
  ) THEN
    RAISE EXCEPTION 'Cannot add vendor_bill_lines.tax_code_id FK: orphan tax_code_id values exist';
  END IF;
END;
$$;

ALTER TABLE finance.journal_lines
  DROP CONSTRAINT IF EXISTS journal_lines_tax_code_id_fkey;
ALTER TABLE finance.journal_lines
  ADD CONSTRAINT journal_lines_tax_code_id_fkey
  FOREIGN KEY (tax_code_id) REFERENCES finance.tax_codes(id) ON DELETE RESTRICT;

ALTER TABLE finance.vendor_bill_lines
  DROP CONSTRAINT IF EXISTS vendor_bill_lines_tax_code_id_fkey;
ALTER TABLE finance.vendor_bill_lines
  ADD CONSTRAINT vendor_bill_lines_tax_code_id_fkey
  FOREIGN KEY (tax_code_id) REFERENCES finance.tax_codes(id) ON DELETE RESTRICT;

/* ================================================================
   5. CURRENCY SETTINGS — organization/currency precision controls.
   ================================================================ */

CREATE TABLE IF NOT EXISTS finance.currency_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES core.organizations(id) ON DELETE RESTRICT,
  currency text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  decimals smallint NOT NULL DEFAULT 2,
  rounding_method text NOT NULL DEFAULT 'HALF_UP',
  rounding_account_id uuid REFERENCES finance.chart_of_accounts(id) ON DELETE RESTRICT,
  tolerance numeric(18,6) NOT NULL DEFAULT 0,
  display_format text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT currency_settings_currency_check CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT currency_settings_decimals_check CHECK (decimals BETWEEN 0 AND 6),
  CONSTRAINT currency_settings_tolerance_check CHECK (tolerance >= 0),
  CONSTRAINT currency_settings_rounding_method_check CHECK (rounding_method IN ('HALF_UP','HALF_EVEN','DOWN','UP','FLOOR','CEILING')),
  CONSTRAINT currency_settings_org_currency_key UNIQUE (organization_id, currency)
);

ALTER TABLE finance.currency_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE finance.currency_settings FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS currency_settings_select_org ON finance.currency_settings;
DROP POLICY IF EXISTS currency_settings_insert_org ON finance.currency_settings;
DROP POLICY IF EXISTS currency_settings_update_org ON finance.currency_settings;
DROP POLICY IF EXISTS currency_settings_delete_org ON finance.currency_settings;

CREATE POLICY currency_settings_select_org ON finance.currency_settings
  FOR SELECT TO authenticated
  USING (core.same_org(organization_id));
CREATE POLICY currency_settings_insert_org ON finance.currency_settings
  FOR INSERT TO authenticated
  WITH CHECK (core.same_org(organization_id) AND (core.is_finance_head() OR core.has_role('ACCOUNTANT')));
CREATE POLICY currency_settings_update_org ON finance.currency_settings
  FOR UPDATE TO authenticated
  USING (core.same_org(organization_id) AND (core.is_finance_head() OR core.has_role('ACCOUNTANT')))
  WITH CHECK (core.same_org(organization_id) AND (core.is_finance_head() OR core.has_role('ACCOUNTANT')));
CREATE POLICY currency_settings_delete_org ON finance.currency_settings
  FOR DELETE TO authenticated
  USING (core.same_org(organization_id) AND core.is_finance_head());

GRANT SELECT, INSERT, UPDATE, DELETE ON finance.currency_settings TO authenticated;
GRANT ALL ON finance.currency_settings TO service_role;

DROP TRIGGER IF EXISTS currency_settings_updated_at ON finance.currency_settings;
CREATE TRIGGER currency_settings_updated_at
  BEFORE UPDATE ON finance.currency_settings
  FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();

DROP TRIGGER IF EXISTS currency_settings_audit ON finance.currency_settings;
CREATE TRIGGER currency_settings_audit
  AFTER INSERT OR UPDATE OR DELETE ON finance.currency_settings
  FOR EACH ROW EXECUTE FUNCTION audit.trigger_audit_log();

/* ================================================================
   6. INVOICE LINES — P0 specification requirement and confirmed
      application dependency (post-invoice selects invoice_lines(*)).
   ================================================================ */

CREATE TABLE IF NOT EXISTS finance.invoice_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id uuid NOT NULL REFERENCES public.invoices(id) ON DELETE RESTRICT,
  organization_id uuid NOT NULL REFERENCES core.organizations(id) ON DELETE RESTRICT,
  line_number integer NOT NULL,
  description text NOT NULL,
  quantity numeric(18,4) NOT NULL DEFAULT 1,
  unit_price numeric(18,2) NOT NULL DEFAULT 0,
  line_subtotal numeric(18,2) NOT NULL DEFAULT 0,
  discount_amount numeric(18,2) NOT NULL DEFAULT 0,
  tax_code_id uuid REFERENCES finance.tax_codes(id) ON DELETE RESTRICT,
  tax_rate numeric(8,4) NOT NULL DEFAULT 0,
  tax_amount numeric(18,2) NOT NULL DEFAULT 0,
  line_total numeric(18,2) NOT NULL DEFAULT 0,
  base_line_subtotal numeric(18,2) NOT NULL DEFAULT 0,
  base_tax_amount numeric(18,2) NOT NULL DEFAULT 0,
  base_line_total numeric(18,2) NOT NULL DEFAULT 0,
  account_id uuid REFERENCES finance.chart_of_accounts(id) ON DELETE RESTRICT,
  project_id uuid REFERENCES public.projects(id) ON DELETE SET NULL,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT invoice_lines_number_check CHECK (line_number > 0),
  CONSTRAINT invoice_lines_quantity_check CHECK (quantity > 0),
  CONSTRAINT invoice_lines_amounts_check CHECK (
    unit_price >= 0 AND line_subtotal >= 0 AND discount_amount >= 0 AND
    tax_rate >= 0 AND tax_amount >= 0 AND line_total >= 0 AND
    base_line_subtotal >= 0 AND base_tax_amount >= 0 AND base_line_total >= 0
  ),
  CONSTRAINT invoice_lines_invoice_line_key UNIQUE (invoice_id, line_number)
);

CREATE INDEX IF NOT EXISTS invoice_lines_invoice_id_idx ON finance.invoice_lines(invoice_id);
CREATE INDEX IF NOT EXISTS invoice_lines_org_id_idx ON finance.invoice_lines(organization_id);

CREATE OR REPLACE FUNCTION finance.enforce_invoice_line_org()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO pg_catalog, finance, public
AS $$
DECLARE v_org uuid;
BEGIN
  SELECT organization_id INTO v_org FROM public.invoices WHERE id = NEW.invoice_id;
  IF v_org IS NULL OR NEW.organization_id IS DISTINCT FROM v_org THEN
    RAISE EXCEPTION 'Invoice line organization does not match parent invoice';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS invoice_lines_org_guard ON finance.invoice_lines;
CREATE TRIGGER invoice_lines_org_guard
  BEFORE INSERT OR UPDATE ON finance.invoice_lines
  FOR EACH ROW EXECUTE FUNCTION finance.enforce_invoice_line_org();

DROP TRIGGER IF EXISTS invoice_lines_updated_at ON finance.invoice_lines;
CREATE TRIGGER invoice_lines_updated_at
  BEFORE UPDATE ON finance.invoice_lines
  FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();

DROP TRIGGER IF EXISTS invoice_lines_audit ON finance.invoice_lines;
CREATE TRIGGER invoice_lines_audit
  AFTER INSERT OR UPDATE OR DELETE ON finance.invoice_lines
  FOR EACH ROW EXECUTE FUNCTION audit.trigger_audit_log();

ALTER TABLE finance.invoice_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE finance.invoice_lines FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS invoice_lines_select_org ON finance.invoice_lines;
DROP POLICY IF EXISTS invoice_lines_insert_org ON finance.invoice_lines;
DROP POLICY IF EXISTS invoice_lines_update_org ON finance.invoice_lines;
DROP POLICY IF EXISTS invoice_lines_delete_org ON finance.invoice_lines;

CREATE POLICY invoice_lines_select_org ON finance.invoice_lines
  FOR SELECT TO authenticated USING (core.same_org(organization_id));
CREATE POLICY invoice_lines_insert_org ON finance.invoice_lines
  FOR INSERT TO authenticated
  WITH CHECK (core.same_org(organization_id));
CREATE POLICY invoice_lines_update_org ON finance.invoice_lines
  FOR UPDATE TO authenticated
  USING (core.same_org(organization_id)) WITH CHECK (core.same_org(organization_id));
CREATE POLICY invoice_lines_delete_org ON finance.invoice_lines
  FOR DELETE TO authenticated USING (core.same_org(organization_id));

GRANT SELECT, INSERT, UPDATE, DELETE ON finance.invoice_lines TO authenticated;
GRANT ALL ON finance.invoice_lines TO service_role;

/* ================================================================
   7. EXPENSE LINES — P0 split-coding requirement.
   ================================================================ */

CREATE TABLE IF NOT EXISTS finance.expense_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  expense_id uuid NOT NULL REFERENCES public.expenses(id) ON DELETE RESTRICT,
  organization_id uuid NOT NULL REFERENCES core.organizations(id) ON DELETE RESTRICT,
  line_number integer NOT NULL,
  description text NOT NULL,
  quantity numeric(18,4) NOT NULL DEFAULT 1,
  unit_price numeric(18,2) NOT NULL DEFAULT 0,
  amount numeric(18,2) NOT NULL DEFAULT 0,
  currency text NOT NULL DEFAULT 'PKR',
  exchange_rate numeric(18,6) NOT NULL DEFAULT 1,
  base_amount numeric(18,2) NOT NULL DEFAULT 0,
  account_id uuid REFERENCES finance.chart_of_accounts(id) ON DELETE RESTRICT,
  project_id uuid REFERENCES public.projects(id) ON DELETE SET NULL,
  department_id uuid REFERENCES finance.dimensions(id) ON DELETE SET NULL,
  cost_center_id uuid REFERENCES finance.dimensions(id) ON DELETE SET NULL,
  tax_code_id uuid REFERENCES finance.tax_codes(id) ON DELETE RESTRICT,
  tax_rate numeric(8,4) NOT NULL DEFAULT 0,
  tax_amount numeric(18,2) NOT NULL DEFAULT 0,
  vendor_id uuid REFERENCES finance.vendors(id) ON DELETE SET NULL,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT expense_lines_number_check CHECK (line_number > 0),
  CONSTRAINT expense_lines_quantity_check CHECK (quantity > 0),
  CONSTRAINT expense_lines_amounts_check CHECK (
    unit_price >= 0 AND amount >= 0 AND exchange_rate > 0 AND
    base_amount >= 0 AND tax_rate >= 0 AND tax_amount >= 0
  ),
  CONSTRAINT expense_lines_currency_check CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT expense_lines_expense_line_key UNIQUE (expense_id, line_number)
);

CREATE INDEX IF NOT EXISTS expense_lines_expense_id_idx ON finance.expense_lines(expense_id);
CREATE INDEX IF NOT EXISTS expense_lines_org_id_idx ON finance.expense_lines(organization_id);

CREATE OR REPLACE FUNCTION finance.enforce_expense_line_org()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO pg_catalog, finance, public
AS $$
DECLARE v_org uuid;
BEGIN
  SELECT organization_id INTO v_org FROM public.expenses WHERE id = NEW.expense_id;
  IF v_org IS NULL OR NEW.organization_id IS DISTINCT FROM v_org THEN
    RAISE EXCEPTION 'Expense line organization does not match parent expense';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS expense_lines_org_guard ON finance.expense_lines;
CREATE TRIGGER expense_lines_org_guard
  BEFORE INSERT OR UPDATE ON finance.expense_lines
  FOR EACH ROW EXECUTE FUNCTION finance.enforce_expense_line_org();

DROP TRIGGER IF EXISTS expense_lines_updated_at ON finance.expense_lines;
CREATE TRIGGER expense_lines_updated_at
  BEFORE UPDATE ON finance.expense_lines
  FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();

DROP TRIGGER IF EXISTS expense_lines_audit ON finance.expense_lines;
CREATE TRIGGER expense_lines_audit
  AFTER INSERT OR UPDATE OR DELETE ON finance.expense_lines
  FOR EACH ROW EXECUTE FUNCTION audit.trigger_audit_log();

ALTER TABLE finance.expense_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE finance.expense_lines FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS expense_lines_select_org ON finance.expense_lines;
DROP POLICY IF EXISTS expense_lines_insert_org ON finance.expense_lines;
DROP POLICY IF EXISTS expense_lines_update_org ON finance.expense_lines;
DROP POLICY IF EXISTS expense_lines_delete_org ON finance.expense_lines;

CREATE POLICY expense_lines_select_org ON finance.expense_lines
  FOR SELECT TO authenticated USING (core.same_org(organization_id));
CREATE POLICY expense_lines_insert_org ON finance.expense_lines
  FOR INSERT TO authenticated WITH CHECK (core.same_org(organization_id));
CREATE POLICY expense_lines_update_org ON finance.expense_lines
  FOR UPDATE TO authenticated
  USING (core.same_org(organization_id)) WITH CHECK (core.same_org(organization_id));
CREATE POLICY expense_lines_delete_org ON finance.expense_lines
  FOR DELETE TO authenticated USING (core.same_org(organization_id));

GRANT SELECT, INSERT, UPDATE, DELETE ON finance.expense_lines TO authenticated;
GRANT ALL ON finance.expense_lines TO service_role;

/* ================================================================
   8. PLATFORM SETTLEMENT TABLES — P0 database structure.
   ================================================================ */

CREATE TABLE IF NOT EXISTS finance.settlement_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES core.organizations(id) ON DELETE RESTRICT,
  platform_id uuid REFERENCES finance.platforms(id) ON DELETE RESTRICT,
  financial_account_id uuid REFERENCES finance.financial_accounts(id) ON DELETE SET NULL,
  settlement_reference text NOT NULL,
  settlement_date date NOT NULL,
  currency text NOT NULL DEFAULT 'PKR',
  gross_amount numeric(18,2) NOT NULL DEFAULT 0,
  expected_fee_amount numeric(18,2) NOT NULL DEFAULT 0,
  actual_fee_amount numeric(18,2) NOT NULL DEFAULT 0,
  withholding_amount numeric(18,2) NOT NULL DEFAULT 0,
  withdrawal_fee_amount numeric(18,2) NOT NULL DEFAULT 0,
  net_amount numeric(18,2) NOT NULL DEFAULT 0,
  exchange_rate numeric(18,6),
  base_net_amount numeric(18,2),
  status text NOT NULL DEFAULT 'DRAFT',
  evidence_attachment_id uuid REFERENCES finance.attachments(id) ON DELETE SET NULL,
  notes text,
  created_by uuid,
  approved_by uuid,
  approved_at timestamptz,
  posted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT settlement_batches_amounts_check CHECK (
    gross_amount >= 0 AND expected_fee_amount >= 0 AND actual_fee_amount >= 0 AND
    withholding_amount >= 0 AND withdrawal_fee_amount >= 0 AND net_amount >= 0
  ),
  CONSTRAINT settlement_batches_currency_check CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT settlement_batches_status_check CHECK (status IN ('DRAFT','SUBMITTED','VERIFIED','APPROVED','POSTED','RECONCILED','REJECTED','REVERSED')),
  CONSTRAINT settlement_batches_org_reference_key UNIQUE (organization_id, settlement_reference)
);

CREATE TABLE IF NOT EXISTS finance.settlement_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  settlement_batch_id uuid NOT NULL REFERENCES finance.settlement_batches(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES core.organizations(id) ON DELETE RESTRICT,
  line_number integer NOT NULL,
  line_type text NOT NULL,
  source_type text,
  source_id uuid,
  project_id uuid REFERENCES public.projects(id) ON DELETE SET NULL,
  client_id uuid REFERENCES public.clients(id) ON DELETE SET NULL,
  currency text NOT NULL DEFAULT 'PKR',
  amount numeric(18,2) NOT NULL DEFAULT 0,
  rate numeric(18,6),
  base_amount numeric(18,2),
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT settlement_lines_number_check CHECK (line_number > 0),
  CONSTRAINT settlement_lines_amount_check CHECK (amount >= 0),
  CONSTRAINT settlement_lines_currency_check CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT settlement_lines_batch_line_key UNIQUE (settlement_batch_id, line_number)
);

CREATE INDEX IF NOT EXISTS settlement_batches_org_id_idx ON finance.settlement_batches(organization_id);
CREATE INDEX IF NOT EXISTS settlement_lines_org_id_idx ON finance.settlement_lines(organization_id);
CREATE INDEX IF NOT EXISTS settlement_lines_batch_id_idx ON finance.settlement_lines(settlement_batch_id);

CREATE OR REPLACE FUNCTION finance.enforce_settlement_line_org()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO pg_catalog, finance, public
AS $$
DECLARE v_org uuid;
BEGIN
  SELECT organization_id INTO v_org
  FROM finance.settlement_batches
  WHERE id = NEW.settlement_batch_id;
  IF v_org IS NULL OR NEW.organization_id IS DISTINCT FROM v_org THEN
    RAISE EXCEPTION 'Settlement line organization does not match parent settlement batch';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS settlement_lines_org_guard ON finance.settlement_lines;
CREATE TRIGGER settlement_lines_org_guard
  BEFORE INSERT OR UPDATE ON finance.settlement_lines
  FOR EACH ROW EXECUTE FUNCTION finance.enforce_settlement_line_org();

DROP TRIGGER IF EXISTS settlement_batches_updated_at ON finance.settlement_batches;
CREATE TRIGGER settlement_batches_updated_at
  BEFORE UPDATE ON finance.settlement_batches
  FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();
DROP TRIGGER IF EXISTS settlement_lines_updated_at ON finance.settlement_lines;
CREATE TRIGGER settlement_lines_updated_at
  BEFORE UPDATE ON finance.settlement_lines
  FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();

DROP TRIGGER IF EXISTS settlement_batches_audit ON finance.settlement_batches;
CREATE TRIGGER settlement_batches_audit
  AFTER INSERT OR UPDATE OR DELETE ON finance.settlement_batches
  FOR EACH ROW EXECUTE FUNCTION audit.trigger_audit_log();
DROP TRIGGER IF EXISTS settlement_lines_audit ON finance.settlement_lines;
CREATE TRIGGER settlement_lines_audit
  AFTER INSERT OR UPDATE OR DELETE ON finance.settlement_lines
  FOR EACH ROW EXECUTE FUNCTION audit.trigger_audit_log();

ALTER TABLE finance.settlement_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE finance.settlement_batches FORCE ROW LEVEL SECURITY;
ALTER TABLE finance.settlement_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE finance.settlement_lines FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS settlement_batches_select_org ON finance.settlement_batches;
DROP POLICY IF EXISTS settlement_batches_insert_org ON finance.settlement_batches;
DROP POLICY IF EXISTS settlement_batches_update_org ON finance.settlement_batches;
DROP POLICY IF EXISTS settlement_batches_delete_org ON finance.settlement_batches;
DROP POLICY IF EXISTS settlement_lines_select_org ON finance.settlement_lines;
DROP POLICY IF EXISTS settlement_lines_insert_org ON finance.settlement_lines;
DROP POLICY IF EXISTS settlement_lines_update_org ON finance.settlement_lines;
DROP POLICY IF EXISTS settlement_lines_delete_org ON finance.settlement_lines;

CREATE POLICY settlement_batches_select_org ON finance.settlement_batches
  FOR SELECT TO authenticated USING (core.same_org(organization_id));
CREATE POLICY settlement_batches_insert_org ON finance.settlement_batches
  FOR INSERT TO authenticated WITH CHECK (core.same_org(organization_id));
CREATE POLICY settlement_batches_update_org ON finance.settlement_batches
  FOR UPDATE TO authenticated USING (core.same_org(organization_id)) WITH CHECK (core.same_org(organization_id));
CREATE POLICY settlement_batches_delete_org ON finance.settlement_batches
  FOR DELETE TO authenticated USING (core.same_org(organization_id));

CREATE POLICY settlement_lines_select_org ON finance.settlement_lines
  FOR SELECT TO authenticated USING (core.same_org(organization_id));
CREATE POLICY settlement_lines_insert_org ON finance.settlement_lines
  FOR INSERT TO authenticated WITH CHECK (core.same_org(organization_id));
CREATE POLICY settlement_lines_update_org ON finance.settlement_lines
  FOR UPDATE TO authenticated USING (core.same_org(organization_id)) WITH CHECK (core.same_org(organization_id));
CREATE POLICY settlement_lines_delete_org ON finance.settlement_lines
  FOR DELETE TO authenticated USING (core.same_org(organization_id));

GRANT SELECT, INSERT, UPDATE, DELETE ON finance.settlement_batches TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON finance.settlement_lines TO authenticated;
GRANT ALL ON finance.settlement_batches TO service_role;
GRANT ALL ON finance.settlement_lines TO service_role;

/* ================================================================
   9. FINANCIAL STATEMENT / REPORTING VIEWS
   Security-invoker views ensure the caller's RLS context is retained.
   ================================================================ */

CREATE OR REPLACE VIEW reporting.trial_balance
WITH (security_invoker = true)
AS
SELECT
  je.organization_id,
  je.fiscal_year_id,
  je.period_id,
  jl.account_id,
  coa.code AS account_code,
  coa.name AS account_name,
  coa.account_type,
  coa.normal_balance,
  SUM(jl.debit_amount) AS debit,
  SUM(jl.credit_amount) AS credit,
  SUM(COALESCE(jl.base_debit, jl.debit_amount)) AS base_debit,
  SUM(COALESCE(jl.base_credit, jl.credit_amount)) AS base_credit,
  SUM(COALESCE(jl.base_debit, jl.debit_amount) - COALESCE(jl.base_credit, jl.credit_amount)) AS signed_base_balance
FROM finance.journal_entries je
JOIN finance.journal_lines jl ON jl.journal_entry_id = je.id
JOIN finance.chart_of_accounts coa ON coa.id = jl.account_id
WHERE je.status = 'POSTED'
GROUP BY je.organization_id, je.fiscal_year_id, je.period_id,
         jl.account_id, coa.code, coa.name, coa.account_type, coa.normal_balance;

CREATE OR REPLACE VIEW reporting.pnl
WITH (security_invoker = true)
AS
SELECT
  organization_id,
  fiscal_year_id,
  period_id,
  account_id,
  account_code,
  account_name,
  account_type,
  debit,
  credit,
  base_debit,
  base_credit,
  CASE
    WHEN account_type IN ('REVENUE','OTHER_INCOME') THEN base_credit - base_debit
    ELSE base_debit - base_credit
  END AS amount
FROM reporting.trial_balance
WHERE account_type IN ('REVENUE','COST_OF_SALES','OPERATING_EXPENSE','OTHER_INCOME','OTHER_EXPENSE');

CREATE OR REPLACE VIEW reporting.balance_sheet
WITH (security_invoker = true)
AS
SELECT
  organization_id,
  fiscal_year_id,
  period_id,
  account_id,
  account_code,
  account_name,
  account_type,
  debit,
  credit,
  base_debit,
  base_credit,
  CASE
    WHEN account_type IN ('ASSET','OTHER_EXPENSE') THEN base_debit - base_credit
    ELSE base_credit - base_debit
  END AS amount
FROM reporting.trial_balance
WHERE account_type IN ('ASSET','LIABILITY','EQUITY');

CREATE OR REPLACE VIEW reporting.changes_in_equity
WITH (security_invoker = true)
AS
SELECT
  organization_id,
  fiscal_year_id,
  period_id,
  account_id,
  account_code,
  account_name,
  debit,
  credit,
  base_debit,
  base_credit,
  base_credit - base_debit AS equity_change
FROM reporting.trial_balance
WHERE account_type = 'EQUITY';

CREATE OR REPLACE VIEW reporting.cash_flow
WITH (security_invoker = true)
AS
SELECT
  organization_id,
  fiscal_year_id,
  period_id,
  account_id,
  account_code,
  account_name,
  account_type,
  report_mapping,
  base_debit,
  base_credit,
  base_debit - base_credit AS net_cash_movement
FROM (
  SELECT
    tb.*,
    coa.report_mapping
  FROM reporting.trial_balance tb
  JOIN finance.chart_of_accounts coa ON coa.id = tb.account_id
  WHERE tb.account_type = 'ASSET'
) q
WHERE q.report_mapping IS NOT NULL
  AND (
    upper(q.report_mapping) LIKE '%CASH%'
    OR upper(q.report_mapping) LIKE '%BANK%'
    OR upper(q.report_mapping) LIKE '%WALLET%'
  );

GRANT SELECT ON reporting.trial_balance TO authenticated;
GRANT SELECT ON reporting.pnl TO authenticated;
GRANT SELECT ON reporting.balance_sheet TO authenticated;
GRANT SELECT ON reporting.changes_in_equity TO authenticated;
GRANT SELECT ON reporting.cash_flow TO authenticated;

/* ================================================================
   10. SAFE VALIDATION — no data mutation.
   These assertions fail the transaction if the newly created schema
   is structurally inconsistent.
   ================================================================ */

DO $$
BEGIN
  IF to_regclass('finance.invoice_lines') IS NULL THEN
    RAISE EXCEPTION 'Validation failed: finance.invoice_lines missing';
  END IF;
  IF to_regclass('finance.expense_lines') IS NULL THEN
    RAISE EXCEPTION 'Validation failed: finance.expense_lines missing';
  END IF;
  IF to_regclass('finance.tax_codes') IS NULL THEN
    RAISE EXCEPTION 'Validation failed: finance.tax_codes missing';
  END IF;
  IF to_regclass('finance.currency_settings') IS NULL THEN
    RAISE EXCEPTION 'Validation failed: finance.currency_settings missing';
  END IF;
  IF to_regclass('finance.settlement_batches') IS NULL OR
     to_regclass('finance.settlement_lines') IS NULL THEN
    RAISE EXCEPTION 'Validation failed: settlement tables missing';
  END IF;
  IF to_regclass('reporting.trial_balance') IS NULL OR
     to_regclass('reporting.pnl') IS NULL OR
     to_regclass('reporting.balance_sheet') IS NULL OR
     to_regclass('reporting.cash_flow') IS NULL OR
     to_regclass('reporting.changes_in_equity') IS NULL THEN
    RAISE EXCEPTION 'Validation failed: required reporting views missing';
  END IF;
END;
$$;

COMMIT;

/* ================================================================
   POST-RUN NON-DESTRUCTIVE VALIDATION QUERIES
   Run separately after the patch to inspect the live database.
   ================================================================

-- 1. Remaining nullable organization_id values in organization-owned tables
SELECT table_schema, table_name
FROM information_schema.columns
WHERE column_name = 'organization_id'
  AND is_nullable = 'YES'
ORDER BY table_schema, table_name;

-- 2. Remaining duplicate trigger registrations with the same function/event
SELECT n.nspname AS schema_name,
       c.relname AS table_name,
       t.tgname AS trigger_name,
       p.proname AS function_name
FROM pg_trigger t
JOIN pg_class c ON c.oid = t.tgrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
JOIN pg_proc p ON p.oid = t.tgfoid
WHERE NOT t.tgisinternal
ORDER BY n.nspname, c.relname, p.proname, t.tgname;

-- 3. Verify all FK targets exist
SELECT conname, conrelid::regclass AS table_name, confrelid::regclass AS referenced_table
FROM pg_constraint
WHERE contype = 'f'
ORDER BY conrelid::regclass::text, conname;

-- 4. Verify reporting views are security-invoker
SELECT schemaname, viewname, viewowner
FROM pg_views
WHERE schemaname = 'reporting'
ORDER BY viewname;

-- 5. Verify organization isolation for new tables
SELECT schemaname, tablename, rowsecurity, forcerowsecurity
FROM pg_tables
WHERE schemaname = 'finance'
  AND tablename IN ('invoice_lines','expense_lines','tax_codes','currency_settings','settlement_batches','settlement_lines')
ORDER BY tablename;

*/