-- PE-01..PE-06 fixes
-- This migration is intentionally additive/replacement-only: it changes only the
-- payroll/equity paths required for the PE audit findings.

CREATE OR REPLACE FUNCTION "finance"."calculate_reserve"("p_profit" numeric, "p_on_date" date DEFAULT CURRENT_DATE, "p_organization_id" uuid DEFAULT NULL::uuid) RETURNS numeric
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'finance', 'core'
    AS $$
DECLARE
  v_org uuid := core.current_user_org_id();
  v_date date := COALESCE(p_on_date, CURRENT_DATE);
  v_policy finance.reserve_policies%ROWTYPE;
  v_reserve numeric(18,2) := 0;
  v_current_reserve numeric(18,2) := 0;
  v_base_payout numeric(18,2) := 0;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication is required';
  END IF;
  IF v_org IS NULL OR p_organization_id IS DISTINCT FROM v_org THEN
    RAISE EXCEPTION 'Organization context does not match the caller';
  END IF;
  IF p_profit IS NULL OR p_profit < 0 THEN
    RAISE EXCEPTION 'Profit must be a non-negative amount';
  END IF;

  SELECT * INTO v_policy
    FROM finance.reserve_policies
   WHERE organization_id = v_org
     AND effective_from <= v_date
     AND (effective_to IS NULL OR effective_to >= v_date)
   ORDER BY effective_from DESC, created_at DESC NULLS LAST
   LIMIT 1;

  IF NOT FOUND OR v_policy.policy_type = 'DISABLED' THEN
    RETURN 0;
  END IF;

  IF v_policy.policy_type = 'FIXED_AMOUNT' THEN
    v_reserve := GREATEST(COALESCE(v_policy.fixed_amount, 0), 0);
  ELSIF v_policy.policy_type = 'PERCENT_OF_PROFIT' THEN
    v_reserve := GREATEST(COALESCE(p_profit, 0) * COALESCE(v_policy.percentage, 0) / 100, 0);
  ELSIF v_policy.policy_type = 'PERCENT_OF_PAYOUT' THEN
    -- Reserve is the configured percentage of the amount available for payout.
    -- payout = profit - reserve, so solve reserve = profit * pct/(100+pct).
    IF COALESCE(v_policy.percentage, 0) >= 100 THEN
      RAISE EXCEPTION 'PERCENT_OF_PAYOUT policy percentage must be below 100';
    END IF;
    v_reserve := GREATEST(
      COALESCE(p_profit, 0) * COALESCE(v_policy.percentage, 0) /
      (100 + COALESCE(v_policy.percentage, 0)), 0
    );
  ELSIF v_policy.policy_type = 'TARGET_BALANCE' THEN
    SELECT COALESCE(SUM(
      CASE WHEN coa.normal_balance = 'CREDIT'
           THEN COALESCE(jl.base_credit, 0) - COALESCE(jl.base_debit, 0)
           ELSE COALESCE(jl.base_debit, 0) - COALESCE(jl.base_credit, 0)
      END), 0)
      INTO v_current_reserve
      FROM finance.chart_of_accounts coa
      JOIN finance.journal_lines jl ON jl.account_id = coa.id
      JOIN finance.journal_entries je
        ON je.id = jl.journal_entry_id
       AND je.organization_id = v_org
       AND je.status = 'POSTED'
       AND je.transaction_date <= v_date
     WHERE coa.organization_id = v_org
       AND coa.code = '3310';
    v_reserve := GREATEST(COALESCE(v_policy.target_balance, 0) - v_current_reserve, 0);
  ELSIF v_policy.policy_type = 'HYBRID' THEN
    v_base_payout := GREATEST(
      COALESCE(p_profit, 0) - GREATEST(COALESCE(v_policy.fixed_amount, 0), 0), 0
    );
    v_reserve := GREATEST(COALESCE(v_policy.fixed_amount, 0), 0)
               + GREATEST(v_base_payout * COALESCE(v_policy.percentage, 0) / 100, 0);
  END IF;

  RETURN ROUND(LEAST(v_reserve, p_profit), 2);
END;
$$;


ALTER FUNCTION "finance"."calculate_reserve"("p_profit" numeric, "p_on_date" date, "p_organization_id" uuid) OWNER TO "postgres";


COMMENT ON FUNCTION "finance"."calculate_reserve"("p_profit" numeric, "p_on_date" date, "p_organization_id" uuid) IS 'PE-02 fix: implements reserve calculation from the organization-scoped effective reserve policy. Supports DISABLED, FIXED_AMOUNT, PERCENT_OF_PROFIT, PERCENT_OF_PAYOUT, TARGET_BALANCE and HYBRID policies and never silently falls through because the RPC is missing.';


CREATE OR REPLACE FUNCTION "finance"."post_payroll_run_atomic"("p_payroll_run_id" "uuid", "p_period_id" "uuid" DEFAULT NULL::"uuid", "p_salary_expense_account_id" "uuid" DEFAULT NULL::"uuid", "p_salary_payable_account_id" "uuid" DEFAULT NULL::"uuid", "p_tax_payable_account_id" "uuid" DEFAULT NULL::"uuid", "p_deductions_payable_account_id" "uuid" DEFAULT NULL::"uuid", "p_staff_advance_account_id" "uuid" DEFAULT NULL::"uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'finance', 'core', 'public'
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
  v_line RECORD;
  v_advance_row RECORD;
  v_remaining numeric(18,2);
  v_take numeric(18,2);
  v_commission_total numeric(18,2);
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

  -- PE-04 FIX: settle the source subledgers in the same transaction as the GL posting.
  -- calculate_payroll_run only previews advance recovery; posting must persist the
  -- exact recovered amount and mark the approved commissions included in this run
  -- as paid. Any mismatch raises and rolls the journal back.
  FOR v_line IN
    SELECT employee_id, advance_deduction, commission_pay
      FROM public.payroll_lines
     WHERE payroll_run_id = p_payroll_run_id
       AND organization_id = v_org
     ORDER BY employee_id, id
  LOOP
    v_remaining := ROUND(COALESCE(v_line.advance_deduction, 0), 2);

    IF v_remaining > 0 THEN
      FOR v_advance_row IN
        SELECT id, remaining_balance, total_deducted
          FROM public.payroll_advances
         WHERE employee_id = v_line.employee_id
           AND organization_id = v_org
           AND approval_status IN ('APPROVED', 'PARTIALLY_RECOVERED')
           AND remaining_balance > 0
           AND (start_deduction_month IS NULL OR start_deduction_month <= v_run.payroll_period)
         ORDER BY request_date ASC, id ASC
         FOR UPDATE
      LOOP
        EXIT WHEN v_remaining <= 0;
        v_take := LEAST(v_remaining, COALESCE(v_advance_row.remaining_balance, 0));
        IF v_take > 0 THEN
          UPDATE public.payroll_advances
             SET total_deducted = ROUND(COALESCE(total_deducted, 0) + v_take, 2),
                 remaining_balance = ROUND(GREATEST(COALESCE(remaining_balance, 0) - v_take, 0), 2),
                 approval_status = CASE
                   WHEN ROUND(GREATEST(COALESCE(remaining_balance, 0) - v_take, 0), 2) <= 0
                     THEN 'FULLY_RECOVERED'
                   ELSE 'PARTIALLY_RECOVERED'
                 END,
                 updated_at = now()
           WHERE id = v_advance_row.id
             AND organization_id = v_org;
          v_remaining := ROUND(v_remaining - v_take, 2);
        END IF;
      END LOOP;

      IF v_remaining > 0.01 THEN
        RAISE EXCEPTION 'Payroll advance recovery exceeds outstanding approved advances for employee %', v_line.employee_id;
      END IF;
    END IF;

    IF COALESCE(v_line.commission_pay, 0) > 0 THEN
      SELECT COALESCE(SUM(commission_amount), 0)
        INTO v_commission_total
        FROM public.payroll_commissions
       WHERE employee_id = v_line.employee_id
         AND organization_id = v_org
         AND status = 'APPROVED'
         AND period_month = v_run.payroll_period;

      IF ROUND(v_commission_total, 2) <> ROUND(v_line.commission_pay, 2) THEN
        RAISE EXCEPTION 'Payroll commission settlement does not reconcile for employee %: payroll %, approved commissions %',
          v_line.employee_id, v_line.commission_pay, v_commission_total;
      END IF;

      UPDATE public.payroll_commissions
         SET status = 'PAID',
             paid_date = v_run.period_end,
             updated_at = now()
       WHERE employee_id = v_line.employee_id
         AND organization_id = v_org
         AND status = 'APPROVED'
         AND period_month = v_run.payroll_period;
    END IF;
  END LOOP;

  UPDATE public.payroll_runs
     SET status='POSTED', journal_entry_id=v_journal, posted_by=auth.uid(), posted_at=now(), updated_at=now()
   WHERE id=p_payroll_run_id AND organization_id=v_org AND status='APPROVED';
  IF NOT FOUND THEN RAISE EXCEPTION 'Payroll source status update failed; GL posting rolled back'; END IF;

  RETURN jsonb_build_object('journal_id',v_journal,'payroll_run_id',p_payroll_run_id,'status','POSTED');
END;
$$;


ALTER FUNCTION "finance"."post_payroll_run_atomic"("p_payroll_run_id" "uuid", "p_period_id" "uuid", "p_salary_expense_account_id" "uuid", "p_salary_payable_account_id" "uuid", "p_tax_payable_account_id" "uuid", "p_deductions_payable_account_id" "uuid", "p_staff_advance_account_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "finance"."post_profit_distribution_atomic"(
    "p_distribution_id" "uuid",
    "p_period_id" "uuid",
    "p_transaction_date" "date",
    "p_description" "text",
    "p_currency" "text",
    "p_exchange_rate" numeric,
    "p_lines" "jsonb"
) RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'finance', 'core', 'public'
    AS $$
DECLARE
  v_org uuid := core.current_user_org_id();
  v_dist finance.profit_distributions%ROWTYPE;
  v_period finance.accounting_periods%ROWTYPE;
  v_existing uuid;
  v_journal uuid;
BEGIN
  IF auth.uid() IS NULL OR v_org IS NULL THEN
    RAISE EXCEPTION 'Authentication and organization context are required';
  END IF;
  IF NOT core.has_permission(auth.uid(), 'EQUITY_POST') THEN
    RAISE EXCEPTION 'EQUITY_POST permission required';
  END IF;
  IF p_lines IS NULL OR jsonb_typeof(p_lines) <> 'array' OR jsonb_array_length(p_lines) = 0 THEN
    RAISE EXCEPTION 'At least one journal line is required';
  END IF;

  SELECT * INTO v_dist
    FROM finance.profit_distributions
   WHERE id = p_distribution_id
     AND organization_id = v_org
   FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Distribution not found in your organization'; END IF;
  IF v_dist.status <> 'APPROVED' THEN RAISE EXCEPTION 'Only APPROVED distributions can be posted'; END IF;

  SELECT * INTO v_period
    FROM finance.accounting_periods
   WHERE id = p_period_id
     AND organization_id = v_org
   FOR SHARE;
  IF NOT FOUND OR v_period.status <> 'OPEN' THEN
    RAISE EXCEPTION 'Accounting period is not OPEN or does not belong to your organization';
  END IF;

  IF EXISTS (
    SELECT 1 FROM finance.journal_entries
     WHERE organization_id = v_org
       AND source_type = 'PROFIT_DISTRIBUTION'
       AND source_id = p_distribution_id
  ) THEN
    RAISE EXCEPTION 'Profit distribution is already posted to the GL';
  END IF;

  v_journal := finance.post_journal_entry(
    COALESCE(NULLIF(p_description, ''), 'Profit Distribution'),
    p_transaction_date,
    p_period_id,
    p_lines,
    COALESCE(NULLIF(p_currency, ''), 'PKR'),
    COALESCE(p_exchange_rate, 1),
    'PROFIT_DISTRIBUTION',
    p_distribution_id,
    NULL,
    NULL
  );

  UPDATE finance.profit_distributions
     SET status = 'POSTED',
         posted_by = auth.uid(),
         posted_at = now(),
         journal_entry_id = v_journal,
         period_id = p_period_id,
         updated_at = now()
   WHERE id = p_distribution_id
     AND organization_id = v_org
     AND status = 'APPROVED';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Profit distribution status update failed; GL posting rolled back';
  END IF;

  RETURN v_journal;
END;
$$;


ALTER FUNCTION "finance"."post_profit_distribution_atomic"("p_distribution_id" "uuid", "p_period_id" "uuid", "p_transaction_date" "date", "p_description" "text", "p_currency" "text", "p_exchange_rate" numeric, "p_lines" "jsonb") OWNER TO "postgres";


COMMENT ON FUNCTION "finance"."post_profit_distribution_atomic"("p_distribution_id" "uuid", "p_period_id" "uuid", "p_transaction_date" "date", "p_description" "text", "p_currency" "text", "p_exchange_rate" numeric, "p_lines" "jsonb") IS 'PE-05 fix: atomically posts the prepared profit-distribution journal and finalizes the source header to POSTED with posted_by, posted_at, period_id and journal_entry_id. Any failure rolls back both the journal and header update.';


CREATE OR REPLACE FUNCTION "finance"."transition_profit_distribution"("p_distribution_id" "uuid", "p_status" "text", "p_reason" "text" DEFAULT NULL::"text") RETURNS "finance"."profit_distributions"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'finance', 'core', 'public'
    AS $$
DECLARE
  v_org uuid := core.current_user_org_id();
  v_user uuid := auth.uid();
  v_dist finance.profit_distributions%ROWTYPE;
  v_now timestamptz := now();
  v_reason text := NULLIF(btrim(COALESCE(p_reason, '')), '');
BEGIN
  IF v_user IS NULL OR v_org IS NULL THEN RAISE EXCEPTION 'Authentication and organization context are required'; END IF;
  IF p_status NOT IN ('DECLARED','APPROVED','CANCELLED') THEN
    RAISE EXCEPTION 'Unsupported profit distribution transition: %', p_status;
  END IF;

  SELECT * INTO v_dist
    FROM finance.profit_distributions
   WHERE id = p_distribution_id AND organization_id = v_org
   FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Distribution not found in your organization'; END IF;

  IF p_status = 'DECLARED' THEN
    IF NOT core.has_permission(v_user, 'EQUITY_MANAGE') THEN RAISE EXCEPTION 'EQUITY_MANAGE permission required'; END IF;
    IF v_dist.status <> 'DRAFT' THEN RAISE EXCEPTION 'Only DRAFT distributions can be declared'; END IF;
    UPDATE finance.profit_distributions
       SET status='DECLARED', declared_by=v_user, declared_at=v_now, updated_at=v_now
     WHERE id=v_dist.id AND organization_id=v_org AND status='DRAFT';
  ELSIF p_status = 'APPROVED' THEN
    IF NOT core.has_permission(v_user, 'EQUITY_APPROVE') THEN RAISE EXCEPTION 'EQUITY_APPROVE permission required'; END IF;
    IF v_dist.status <> 'DECLARED' THEN RAISE EXCEPTION 'Only DECLARED distributions can be approved'; END IF;
    IF v_dist.declared_by IS NOT NULL AND v_dist.declared_by = v_user THEN
      RAISE EXCEPTION 'MAKER_CHECKER_VIOLATION: declarer cannot approve their own distribution';
    END IF;
    UPDATE finance.profit_distributions
       SET status='APPROVED', approved_by=v_user, approved_at=v_now, updated_at=v_now
     WHERE id=v_dist.id AND organization_id=v_org AND status='DECLARED';
  ELSIF p_status = 'CANCELLED' THEN
    IF NOT core.has_permission(v_user, 'EQUITY_MANAGE') THEN RAISE EXCEPTION 'EQUITY_MANAGE permission required'; END IF;
    IF v_dist.status NOT IN ('DRAFT','DECLARED') THEN RAISE EXCEPTION 'Only DRAFT or DECLARED distributions can be cancelled'; END IF;
    IF v_reason IS NULL THEN RAISE EXCEPTION 'Cancellation reason is required'; END IF;
    UPDATE finance.profit_distributions
       SET status='CANCELLED',
           notes = concat_ws(E'\n', v_dist.notes, 'Cancelled: ' || v_reason),
           updated_at=v_now
     WHERE id=v_dist.id AND organization_id=v_org AND status IN ('DRAFT','DECLARED');
  END IF;

  IF NOT FOUND THEN RAISE EXCEPTION 'Profit distribution transition failed; refresh and retry'; END IF;
  SELECT * INTO v_dist FROM finance.profit_distributions WHERE id=v_dist.id AND organization_id=v_org;
  RETURN v_dist;
END;
$$;


ALTER FUNCTION "finance"."transition_profit_distribution"("p_distribution_id" "uuid", "p_status" "text", "p_reason" "text") OWNER TO "postgres";


COMMENT ON FUNCTION "finance"."transition_profit_distribution"("p_distribution_id" "uuid", "p_status" "text", "p_reason" "text") IS 'PE-06 fix: server-side, organization-scoped profit-distribution workflow with explicit state transitions, permission checks and maker-checker approval. Direct table UPDATE is revoked from authenticated users.';




REVOKE UPDATE ON TABLE finance.profit_distributions FROM authenticated;
GRANT EXECUTE ON FUNCTION finance.calculate_reserve(numeric, date, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION finance.post_profit_distribution_atomic(uuid, uuid, date, text, text, numeric, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION finance.transition_profit_distribution(uuid, text, text) TO authenticated;
