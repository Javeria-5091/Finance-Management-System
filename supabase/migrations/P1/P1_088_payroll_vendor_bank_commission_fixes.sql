-- ============================================================================
-- OSYSTIC Finance Management System
-- P1-078: Payroll GL waterfall, payroll service/API routing, vendor-payment
-- organization isolation, and bank-transfer dual-approval hardening.
--
-- This migration is intentionally additive/targeted. It does not change
-- unrelated workflows.
-- ============================================================================

-- --------------------------------------------------------------------------
-- 1) Payroll source linkage + standard payroll accounts
-- --------------------------------------------------------------------------
ALTER TABLE public.payroll_runs
  ADD COLUMN IF NOT EXISTS journal_entry_id uuid;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='payroll_runs_journal_entry_id_fkey') THEN
    ALTER TABLE public.payroll_runs ADD CONSTRAINT payroll_runs_journal_entry_id_fkey FOREIGN KEY (journal_entry_id) REFERENCES finance.journal_entries(id);
  END IF;
END $$;

DO $$
DECLARE
  v_org record;
  v_parent_expense uuid;
  v_parent_payroll uuid;
  v_parent_assets uuid;
BEGIN
  FOR v_org IN SELECT id FROM core.organizations LOOP
    SELECT id INTO v_parent_expense
      FROM finance.chart_of_accounts
     WHERE organization_id = v_org.id AND code = '6000'
     LIMIT 1;

    IF v_parent_expense IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM finance.chart_of_accounts
       WHERE organization_id = v_org.id AND code = '6800'
    ) THEN
      INSERT INTO finance.chart_of_accounts
        (code,name,account_type,normal_balance,parent_id,level,posting_allowed,is_control_account,is_active,report_mapping,display_order,organization_id)
      VALUES
        ('6800','Salaries & Wages','OPERATING_EXPENSE','DEBIT',v_parent_expense,2,true,false,true,'PROFIT_AND_LOSS_OPERATING_EXPENSES',80,v_org.id);
    END IF;

    SELECT id INTO v_parent_payroll
      FROM finance.chart_of_accounts
     WHERE organization_id = v_org.id AND code = '2300'
     LIMIT 1;

    IF v_parent_payroll IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM finance.chart_of_accounts
       WHERE organization_id = v_org.id AND code = '2340'
    ) THEN
      INSERT INTO finance.chart_of_accounts
        (code,name,account_type,normal_balance,parent_id,level,posting_allowed,is_control_account,is_active,report_mapping,display_order,organization_id)
      VALUES
        ('2340','Employee Deductions Payable','LIABILITY','CREDIT',v_parent_payroll,2,true,true,true,'BALANCE_SHEET_CURRENT_LIABILITIES',4,v_org.id);
    END IF;
  END LOOP;
END $$;

-- --------------------------------------------------------------------------
-- 2) Atomic payroll posting.
--    The journal and source-row POSTED/link update execute in one DB
--    transaction because the RPC calls post_journal_entry and then updates
--    payroll_runs before the function returns.
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION finance.post_payroll_run_atomic(
  p_payroll_run_id uuid,
  p_period_id uuid DEFAULT NULL,
  p_salary_expense_account_id uuid DEFAULT NULL,
  p_salary_payable_account_id uuid DEFAULT NULL,
  p_tax_payable_account_id uuid DEFAULT NULL,
  p_deductions_payable_account_id uuid DEFAULT NULL,
  p_staff_advance_account_id uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'pg_catalog','finance','core','public'
AS $$
DECLARE
  v_org uuid := core.current_user_org_id();
  v_run public.payroll_runs%ROWTYPE;
  v_period uuid;
  v_expense uuid;
  v_salary_payable uuid;
  v_tax_payable uuid;
  v_deduction_payable uuid;
  v_staff_advance uuid;
  v_journal uuid;
  v_lines jsonb := '[]'::jsonb;
  v_total_gross numeric(18,2);
  v_total_deductions numeric(18,2);
  v_total_net numeric(18,2);
  v_tax numeric(18,2);
  v_pf numeric(18,2);
  v_eobi numeric(18,2);
  v_advance numeric(18,2);
  v_other numeric(18,2);
  v_existing uuid;
BEGIN
  IF v_org IS NULL THEN RAISE EXCEPTION 'Organization context is required'; END IF;
  IF NOT (core.is_finance_head() OR core.has_role('ACCOUNTANT')) THEN
    RAISE EXCEPTION 'Insufficient privileges to post payroll';
  END IF;

  SELECT * INTO v_run
    FROM public.payroll_runs
   WHERE id = p_payroll_run_id
     AND organization_id = v_org
   FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Payroll run not found in your organization'; END IF;
  IF v_run.status <> 'APPROVED' THEN
    RAISE EXCEPTION 'Only APPROVED payroll runs can be posted. Current: %', v_run.status;
  END IF;

  SELECT id INTO v_existing
    FROM finance.journal_entries
   WHERE organization_id = v_org
     AND source_type = 'PAYROLL_RUN'
     AND source_id = p_payroll_run_id
   LIMIT 1;
  IF v_existing IS NOT NULL THEN
    RAISE EXCEPTION 'Payroll run is already posted to the GL';
  END IF;

  v_period := p_period_id;
  IF v_period IS NULL THEN
    SELECT id INTO v_period
      FROM finance.accounting_periods
     WHERE organization_id = v_org
       AND status = 'OPEN'
       AND start_date <= v_run.period_end
       AND end_date >= v_run.period_end
     ORDER BY start_date DESC
     LIMIT 1;
  END IF;
  IF v_period IS NULL THEN RAISE EXCEPTION 'No OPEN accounting period covers payroll period_end'; END IF;
  IF NOT EXISTS (SELECT 1 FROM finance.accounting_periods WHERE id=v_period AND organization_id=v_org AND status='OPEN') THEN
    RAISE EXCEPTION 'Invalid or inaccessible accounting period';
  END IF;

  IF p_salary_expense_account_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM finance.chart_of_accounts WHERE id=p_salary_expense_account_id AND organization_id=v_org AND is_active=true AND posting_allowed=true) THEN RAISE EXCEPTION 'Salary expense account is not valid for your organization'; END IF;
  IF p_salary_payable_account_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM finance.chart_of_accounts WHERE id=p_salary_payable_account_id AND organization_id=v_org AND is_active=true AND posting_allowed=true) THEN RAISE EXCEPTION 'Salary payable account is not valid for your organization'; END IF;
  IF p_tax_payable_account_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM finance.chart_of_accounts WHERE id=p_tax_payable_account_id AND organization_id=v_org AND is_active=true AND posting_allowed=true) THEN RAISE EXCEPTION 'Tax payable account is not valid for your organization'; END IF;
  IF p_deductions_payable_account_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM finance.chart_of_accounts WHERE id=p_deductions_payable_account_id AND organization_id=v_org AND is_active=true AND posting_allowed=true) THEN RAISE EXCEPTION 'Deductions payable account is not valid for your organization'; END IF;
  IF p_staff_advance_account_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM finance.chart_of_accounts WHERE id=p_staff_advance_account_id AND organization_id=v_org AND is_active=true AND posting_allowed=true) THEN RAISE EXCEPTION 'Staff advance account is not valid for your organization'; END IF;

  v_expense := p_salary_expense_account_id;
  IF v_expense IS NULL THEN
    SELECT id INTO v_expense FROM finance.chart_of_accounts
     WHERE organization_id=v_org AND code='6800' AND is_active=true AND posting_allowed=true LIMIT 1;
  END IF;
  IF v_expense IS NULL THEN RAISE EXCEPTION 'Salaries & Wages account (6800) is not configured'; END IF;

  v_salary_payable := p_salary_payable_account_id;
  IF v_salary_payable IS NULL THEN
    SELECT id INTO v_salary_payable FROM finance.chart_of_accounts
     WHERE organization_id=v_org AND code='2310' AND is_active=true AND posting_allowed=true LIMIT 1;
  END IF;
  IF v_salary_payable IS NULL THEN RAISE EXCEPTION 'Salary Payable account (2310) is not configured'; END IF;

  v_total_gross := COALESCE(v_run.total_gross_pay,0);
  v_total_deductions := COALESCE(v_run.total_deductions,0);
  v_total_net := COALESCE(v_run.total_net_pay,0);

  SELECT
    COALESCE(SUM(tax_deduction),0),
    COALESCE(SUM(provident_fund),0),
    COALESCE(SUM(eobi),0),
    COALESCE(SUM(advance_deduction),0),
    COALESCE(SUM(other_deductions),0)
  INTO v_tax,v_pf,v_eobi,v_advance,v_other
  FROM public.payroll_lines
  WHERE payroll_run_id=p_payroll_run_id AND organization_id=v_org;

  IF ROUND(v_tax+v_pf+v_eobi+v_advance+v_other,2) <> ROUND(v_total_deductions,2) THEN
    RAISE EXCEPTION 'Payroll deduction components do not reconcile to total deductions';
  END IF;
  IF ROUND(v_total_gross-v_total_deductions,2) <> ROUND(v_total_net,2) THEN
    RAISE EXCEPTION 'Payroll gross less deductions does not reconcile to net pay';
  END IF;

  IF v_total_gross > 0 THEN
    v_lines := v_lines || jsonb_build_object('account_id',v_expense,'debit_amount',v_total_gross,'credit_amount',0,'description','Payroll gross salary expense');
  END IF;
  IF v_total_net > 0 THEN
    v_lines := v_lines || jsonb_build_object('account_id',v_salary_payable,'debit_amount',0,'credit_amount',v_total_net,'description','Net salary payable');
  END IF;

  IF v_tax > 0 THEN
    v_tax_payable := p_tax_payable_account_id;
    IF v_tax_payable IS NULL THEN
      SELECT id INTO v_tax_payable FROM finance.chart_of_accounts
       WHERE organization_id=v_org AND code='2210' AND is_active=true AND posting_allowed=true LIMIT 1;
    END IF;
    IF v_tax_payable IS NULL THEN RAISE EXCEPTION 'Income Tax Payable account (2210) is required for payroll tax deductions'; END IF;
    v_lines := v_lines || jsonb_build_object('account_id',v_tax_payable,'debit_amount',0,'credit_amount',v_tax,'description','Employee income tax payable');
  END IF;

  IF (v_pf + v_eobi + v_other) > 0 THEN
    v_deduction_payable := p_deductions_payable_account_id;
    IF v_deduction_payable IS NULL THEN
      SELECT id INTO v_deduction_payable FROM finance.chart_of_accounts
       WHERE organization_id=v_org AND code='2340' AND is_active=true AND posting_allowed=true LIMIT 1;
    END IF;
    IF v_deduction_payable IS NULL THEN RAISE EXCEPTION 'Employee Deductions Payable account (2340) is required for non-tax payroll deductions'; END IF;
    v_lines := v_lines || jsonb_build_object('account_id',v_deduction_payable,'debit_amount',0,'credit_amount',v_pf+v_eobi+v_other,'description','Employee deductions payable');
  END IF;

  IF v_advance > 0 THEN
    v_staff_advance := p_staff_advance_account_id;
    IF v_staff_advance IS NULL THEN
      SELECT id INTO v_staff_advance FROM finance.chart_of_accounts
       WHERE organization_id=v_org AND code='1230' AND is_active=true AND posting_allowed=true LIMIT 1;
    END IF;
    IF v_staff_advance IS NULL THEN RAISE EXCEPTION 'Staff Advances account (1230) is required for advance recovery'; END IF;
    v_lines := v_lines || jsonb_build_object('account_id',v_staff_advance,'debit_amount',0,'credit_amount',v_advance,'description','Staff advance recovered through payroll');
  END IF;

  v_journal := finance.post_journal_entry(
    'Payroll ' || v_run.payroll_period,
    v_run.period_end,
    v_period,
    v_lines,
    'PKR',1,'PAYROLL_RUN',p_payroll_run_id,NULL,NULL
  );

  UPDATE public.payroll_runs
     SET status='POSTED', journal_entry_id=v_journal, posted_by=auth.uid(), posted_at=now(), updated_at=now()
   WHERE id=p_payroll_run_id AND organization_id=v_org AND status='APPROVED';
  IF NOT FOUND THEN RAISE EXCEPTION 'Payroll source status update failed; GL posting rolled back'; END IF;

  RETURN jsonb_build_object('journal_id',v_journal,'payroll_run_id',p_payroll_run_id,'status','POSTED');
END;
$$;

REVOKE ALL ON FUNCTION finance.post_payroll_run_atomic(uuid,uuid,uuid,uuid,uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION finance.post_payroll_run_atomic(uuid,uuid,uuid,uuid,uuid,uuid,uuid) TO authenticated;

-- --------------------------------------------------------------------------
-- 3) Vendor payment RPC: enforce org on source row, period, all COA lookups,
--    allocations and vendor bills. SECURITY DEFINER must never trust only id.
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION finance.post_vendor_payment(
  p_payment_id uuid, p_period_id uuid, p_transaction_date date
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'pg_catalog','finance','core','public'
AS $$
DECLARE
  v_org uuid := core.current_user_org_id();
  v_pay RECORD;
  v_ap_account uuid;
  v_bank_account uuid;
  v_wht_payable uuid;
  v_discount_account uuid;
  v_total_allocated numeric(18,2);
  v_total_withholding numeric(18,2);
  v_total_discount numeric(18,2);
  v_lines jsonb := '[]'::jsonb;
BEGIN
  IF v_org IS NULL THEN RAISE EXCEPTION 'Organization context is required'; END IF;
  IF NOT (core.is_finance_head() OR core.has_role('ACCOUNTANT')) THEN RAISE EXCEPTION 'Insufficient privileges to post vendor payment'; END IF;

  SELECT * INTO v_pay FROM finance.vendor_payments
   WHERE id=p_payment_id AND organization_id=v_org FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Payment not found in your organization'; END IF;
  IF v_pay.status <> 'APPROVED' THEN RAISE EXCEPTION 'Only APPROVED vendor payments can be posted'; END IF;

  IF NOT EXISTS (SELECT 1 FROM finance.accounting_periods WHERE id=p_period_id AND organization_id=v_org AND status='OPEN') THEN
    RAISE EXCEPTION 'Invalid or inaccessible accounting period';
  END IF;

  SELECT id INTO v_ap_account FROM finance.chart_of_accounts WHERE organization_id=v_org AND code='2110' AND is_active=true AND posting_allowed=true LIMIT 1;
  IF v_ap_account IS NULL THEN RAISE EXCEPTION 'AP account 2110 not found for organization'; END IF;

  SELECT id INTO v_bank_account FROM finance.chart_of_accounts
   WHERE organization_id=v_org AND code='1110' AND is_active=true AND posting_allowed=true LIMIT 1;
  IF v_bank_account IS NULL THEN RAISE EXCEPTION 'Bank/cash ledger account is not configured for organization'; END IF;

  SELECT id INTO v_wht_payable FROM finance.chart_of_accounts WHERE organization_id=v_org AND code='2210' AND is_active=true AND posting_allowed=true LIMIT 1;
  SELECT id INTO v_discount_account FROM finance.chart_of_accounts
   WHERE organization_id=v_org AND (code='4910' OR name ILIKE '%discount%') AND is_active=true AND posting_allowed=true
   ORDER BY (code='4910') DESC LIMIT 1;

  -- AP-01 FIX (applied retroactively for migration-history consistency;
  -- the live-DB fix ships in supabase/migrations/P2/P2_017_ap01_vendor_payment_posting_fix.sql):
  -- finance.vendor_payment_allocations has no organization_id column and
  -- never did. Org membership of each allocation is established solely
  -- via the JOIN to finance.vendor_bills.organization_id below.
  SELECT
    COALESCE(SUM(vpa.allocated_amount),0),
    COALESCE(SUM((SELECT COALESCE(SUM(COALESCE(bl.base_withholding_amount,bl.withholding_amount,0)),0)
      FROM finance.vendor_bill_lines bl WHERE bl.vendor_bill_id=vpa.vendor_bill_id AND bl.organization_id=v_org)),0),
    COALESCE(SUM(vpa.discount_amount),0)
  INTO v_total_allocated,v_total_withholding,v_total_discount
  FROM finance.vendor_payment_allocations vpa
  JOIN finance.vendor_bills vb ON vb.id=vpa.vendor_bill_id AND vb.organization_id=v_org
  WHERE vpa.vendor_payment_id=p_payment_id;

  IF EXISTS (
    SELECT 1 FROM finance.vendor_payment_allocations vpa
    JOIN finance.vendor_bills vb ON vb.id = vpa.vendor_bill_id
    WHERE vpa.vendor_payment_id = p_payment_id
      AND vb.organization_id IS DISTINCT FROM v_org
  ) THEN
    RAISE EXCEPTION 'Vendor payment allocation organization mismatch';
  END IF;

  IF v_total_discount > 0 AND v_discount_account IS NULL THEN RAISE EXCEPTION 'Discount GL account is not configured for organization'; END IF;
  IF v_total_withholding > 0 AND v_wht_payable IS NULL THEN RAISE EXCEPTION 'Withholding Tax Payable account is not configured for organization'; END IF;

  IF v_total_allocated+v_total_discount+v_total_withholding > 0 THEN
    v_lines := v_lines || jsonb_build_object('account_id',v_ap_account,'debit_amount',v_total_allocated+v_total_discount+v_total_withholding,'credit_amount',0,'description','AP Cleared: '||v_pay.payment_number);
  END IF;
  IF v_total_allocated > 0 THEN
    v_lines := v_lines || jsonb_build_object('account_id',v_bank_account,'debit_amount',0,'credit_amount',v_total_allocated,'description','Paid to Vendor: '||v_pay.payment_number);
  END IF;
  IF v_total_discount > 0 THEN
    v_lines := v_lines || jsonb_build_object('account_id',v_discount_account,'debit_amount',0,'credit_amount',v_total_discount,'description','Early Payment Discount Taken: '||v_pay.payment_number);
  END IF;
  IF v_total_withholding > 0 THEN
    v_lines := v_lines || jsonb_build_object('account_id',v_wht_payable,'debit_amount',0,'credit_amount',v_total_withholding,'description','WHT Deposited: '||v_pay.payment_number);
  END IF;

  RETURN finance.post_journal_entry('Vendor Payment: '||v_pay.payment_number,p_transaction_date,p_period_id,v_lines,'PKR',1,'VENDOR_PAYMENT',p_payment_id,NULL,NULL);
END;
$$;

-- --------------------------------------------------------------------------
-- 4) Make the DB trigger the final authority for bank-transfer dual approval.
--    It already exists; replace it with org-scoped source/destination lookup.
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION finance.fn_set_dual_approval()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_min numeric;
  v_flag boolean;
  v_org uuid;
BEGIN
  v_org := COALESCE(NEW.organization_id, core.current_user_org_id());
  SELECT MIN(COALESCE(min_dual_approval_amount,999999999999::numeric)),
         BOOL_OR(COALESCE(requires_dual_approval,false))
    INTO v_min,v_flag
    FROM finance.financial_accounts
   WHERE organization_id=v_org
     AND id IN (NEW.from_account_id,NEW.to_account_id);

  NEW.requires_dual_approval := COALESCE(v_flag,false)
    OR (v_min IS NOT NULL AND NEW.from_amount >= v_min);
  RETURN NEW;
END;
$$;