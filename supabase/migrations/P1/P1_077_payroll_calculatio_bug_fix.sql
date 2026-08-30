-- ═════════════════════════════════════════════════════════════════════
--  BUG-011 FIX: Payroll calculation never existed in the database.
--
--  Audit evidence: src/app/api/finance/payroll/route.ts already calls
--  supabase.rpc('calculate_payroll_run', ...) for the 'calculate' action,
--  but that function was never defined anywhere in the schema — so every
--  call failed with "function calculate_payroll_run(...) does not exist"
--  and no payroll_runs row could ever leave DRAFT. This migration adds
--  the missing function.
--
--  Companion gap found while fixing this: src/services/payroll.service.ts
--  calls supabase.rpc('set_payroll_compensation_atomic', ...) to save an
--  employee's salary/rate, and that function ALSO does not exist anywhere
--  in the schema. Without it nobody can ever set compensation, so even a
--  working calculate_payroll_run() would find zero active compensation
--  rows to calculate from. Both are fixed together here since BUG-011
--  ("payroll calculation does not exist") is not actually fixable without
--  a working compensation writer.
-- ═════════════════════════════════════════════════════════════════════

-- ---------------------------------------------------------------------
-- 1. set_payroll_compensation_atomic — single active compensation record
--    per employee at a time (closes any currently-active row the day
--    before the new one starts, then inserts the new one).
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_payroll_compensation_atomic(
  p_employee_id UUID,
  p_compensation JSONB
) RETURNS public.payroll_compensation
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $$
DECLARE
  v_org_id UUID;
  v_effective_from DATE;
  v_row public.payroll_compensation;
BEGIN
  SELECT organization_id INTO v_org_id
  FROM public.payroll_employees
  WHERE id = p_employee_id;

  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'Employee % not found', p_employee_id;
  END IF;

  -- Org isolation: caller must belong to the same org as the employee.
  IF v_org_id IS DISTINCT FROM (
    SELECT organization_id FROM public.profiles WHERE user_id = auth.uid()
  ) THEN
    RAISE EXCEPTION 'Not authorized to set compensation for this employee';
  END IF;

  v_effective_from := COALESCE((p_compensation->>'effective_from')::DATE, CURRENT_DATE);

  IF COALESCE((p_compensation->>'amount')::NUMERIC, -1) < 0 THEN
    RAISE EXCEPTION 'Compensation amount must be zero or greater';
  END IF;

  -- Close out any currently-active compensation the day before the new
  -- record starts, so payroll calculation always finds at most one
  -- active row per employee for a given date.
  UPDATE public.payroll_compensation
  SET is_active = false,
      effective_to = LEAST(COALESCE(effective_to, v_effective_from - 1), v_effective_from - 1),
      updated_at = now()
  WHERE employee_id = p_employee_id
    AND is_active = true;

  INSERT INTO public.payroll_compensation (
    employee_id, organization_id, compensation_type, amount, currency,
    effective_from, effective_to, is_active, project_id, notes, created_by
  ) VALUES (
    p_employee_id, v_org_id,
    COALESCE(p_compensation->>'compensation_type', 'MONTHLY_SALARY'),
    (p_compensation->>'amount')::NUMERIC,
    COALESCE(p_compensation->>'currency', 'PKR'),
    v_effective_from,
    (p_compensation->>'effective_to')::DATE,
    true,
    (p_compensation->>'project_id')::UUID,
    p_compensation->>'notes',
    COALESCE((p_compensation->>'created_by')::UUID, auth.uid())
  )
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$$;

GRANT EXECUTE ON FUNCTION public.set_payroll_compensation_atomic(UUID, JSONB) TO authenticated;

-- ---------------------------------------------------------------------
-- 2. calculate_payroll_run — the actual missing piece from BUG-011.
--    DRAFT -> CALCULATED: builds one payroll_lines row per ACTIVE
--    employee with active compensation as of the run's period, and sets
--    the run's totals.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.calculate_payroll_run(
  p_run_id UUID,
  p_org_id UUID,
  p_actor UUID
) RETURNS public.payroll_runs
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $$
DECLARE
  v_run public.payroll_runs;
  v_emp RECORD;
  v_comp RECORD;
  v_basic NUMERIC(14,2);
  v_commission NUMERIC(14,2);
  v_tax NUMERIC(14,2);
  v_pf NUMERIC(14,2);
  v_eobi NUMERIC(14,2);
  v_advance NUMERIC(14,2);
  v_other_ded NUMERIC(14,2);
  v_ded RECORD;
  v_gross NUMERIC(14,2);
  v_total_ded NUMERIC(14,2);
  v_net NUMERIC(14,2);
  v_ded_snapshot JSONB;
  v_lines_written INT := 0;
BEGIN
  SELECT * INTO v_run FROM public.payroll_runs WHERE id = p_run_id AND organization_id = p_org_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Payroll run not found';
  END IF;
  IF v_run.status <> 'DRAFT' THEN
    RAISE EXCEPTION 'Only DRAFT payroll runs can be calculated (current status: %)', v_run.status;
  END IF;

  -- Idempotent: wipe any partial lines from a previous failed attempt.
  DELETE FROM public.payroll_lines WHERE payroll_run_id = p_run_id;

  FOR v_emp IN
    SELECT * FROM public.payroll_employees
    WHERE organization_id = p_org_id AND status = 'ACTIVE'
  LOOP
    -- Most recent compensation record active on/covering the run's period end.
    SELECT * INTO v_comp
    FROM public.payroll_compensation
    WHERE employee_id = v_emp.id
      AND is_active = true
      AND effective_from <= v_run.period_end
      AND (effective_to IS NULL OR effective_to >= v_run.period_start)
    ORDER BY effective_from DESC
    LIMIT 1;

    IF NOT FOUND THEN
      -- No active compensation on record — cannot pay this employee.
      -- Skip rather than fabricate a salary; spec 5.9 requires an
      -- explicit compensation record for every paid employee.
      CONTINUE;
    END IF;

    -- NOTE: this system does not (yet) track hourly/daily attendance, so
    -- HOURLY_RATE / DAILY_RATE / PROJECT_BASED / COMMISSION_ONLY /
    -- FIXED_CONTRACT compensation types are all treated as the flat
    -- per-period amount, same as MONTHLY_SALARY. Time-based proration is
    -- a separate feature, not part of this bug fix.
    v_basic := COALESCE(v_comp.amount, 0);

    -- Approved commissions earned for this specific payroll period.
    SELECT COALESCE(SUM(commission_amount), 0) INTO v_commission
    FROM public.payroll_commissions
    WHERE employee_id = v_emp.id
      AND organization_id = p_org_id
      AND status = 'APPROVED'
      AND period_month = v_run.payroll_period;

    v_gross := v_basic + v_commission;

    -- Recurring deduction rules active for this period.
    v_tax := 0; v_pf := 0; v_eobi := 0; v_other_ded := 0;
    v_ded_snapshot := '[]'::JSONB;
    FOR v_ded IN
      SELECT * FROM public.payroll_deductions
      WHERE employee_id = v_emp.id
        AND is_active = true
        AND effective_from <= v_run.period_end
        AND (effective_to IS NULL OR effective_to >= v_run.period_start)
    LOOP
      DECLARE
        v_amt NUMERIC(14,2);
      BEGIN
        v_amt := COALESCE(v_ded.amount, 0) + COALESCE(v_ded.percentage, 0) / 100.0 * v_gross;
        IF v_ded.deduction_type = 'TAX' THEN v_tax := v_tax + v_amt;
        ELSIF v_ded.deduction_type = 'PROVIDENT_FUND' THEN v_pf := v_pf + v_amt;
        ELSIF v_ded.deduction_type = 'EOBI' THEN v_eobi := v_eobi + v_amt;
        ELSE v_other_ded := v_other_ded + v_amt;
        END IF;
        v_ded_snapshot := v_ded_snapshot || jsonb_build_object(
          'deduction_type', v_ded.deduction_type, 'amount', v_amt
        );
      END;
    END LOOP;

    -- Outstanding salary advances due for recovery this period. This is a
    -- preview only (payroll_advances.remaining_balance is NOT decremented
    -- here) — balances are adjusted when the run is POSTED, so a run can
    -- be recalculated freely while still in DRAFT/CALCULATED without
    -- double-deducting.
    SELECT COALESCE(SUM(LEAST(COALESCE(monthly_deduction, remaining_balance), remaining_balance)), 0)
    INTO v_advance
    FROM public.payroll_advances
    WHERE employee_id = v_emp.id
      AND organization_id = p_org_id
      AND approval_status IN ('APPROVED', 'PARTIALLY_RECOVERED')
      AND remaining_balance > 0
      AND (start_deduction_month IS NULL OR start_deduction_month <= v_run.payroll_period);

    v_total_ded := v_tax + v_pf + v_eobi + v_advance + v_other_ded;
    -- Safety clamp: never let deductions exceed gross pay (would violate
    -- the payroll_lines_nonnegative_check constraint on net_pay).
    IF v_total_ded > v_gross THEN
      v_total_ded := v_gross;
    END IF;
    v_net := v_gross - v_total_ded;

    INSERT INTO public.payroll_lines (
      payroll_run_id, employee_id, organization_id,
      basic_salary, housing_allow, medical_allow, conveyance_allow, other_allowances,
      overtime_pay, commission_pay, bonus_pay,
      gross_pay, tax_deduction, provident_fund, eobi, advance_deduction, other_deductions,
      total_deductions, net_pay, employer_cost,
      payment_status, bank_name, bank_account,
      employee_name, employee_code, designation, department,
      compensation_snapshot, deduction_snapshot
    ) VALUES (
      p_run_id, v_emp.id, p_org_id,
      v_basic, 0, 0, 0, 0,
      0, v_commission, 0,
      v_gross, v_tax, v_pf, v_eobi, v_advance, v_other_ded,
      v_total_ded, v_net, v_gross,
      'PENDING', v_emp.bank_name, v_emp.bank_account,
      v_emp.name, v_emp.employee_code, v_emp.designation, v_emp.department,
      to_jsonb(v_comp), v_ded_snapshot
    );

    v_lines_written := v_lines_written + 1;
  END LOOP;

  IF v_lines_written = 0 THEN
    RAISE EXCEPTION 'No ACTIVE employees with active compensation found for period % — cannot calculate payroll. Set compensation for at least one employee first.', v_run.payroll_period;
  END IF;

  UPDATE public.payroll_runs
  SET status = 'CALCULATED',
      total_gross_pay = (SELECT COALESCE(SUM(gross_pay), 0) FROM public.payroll_lines WHERE payroll_run_id = p_run_id),
      total_deductions = (SELECT COALESCE(SUM(total_deductions), 0) FROM public.payroll_lines WHERE payroll_run_id = p_run_id),
      total_net_pay = (SELECT COALESCE(SUM(net_pay), 0) FROM public.payroll_lines WHERE payroll_run_id = p_run_id),
      total_employer_cost = (SELECT COALESCE(SUM(employer_cost), 0) FROM public.payroll_lines WHERE payroll_run_id = p_run_id),
      total_employees = v_lines_written,
      calculated_by = p_actor,
      calculated_at = now(),
      updated_at = now()
  WHERE id = p_run_id AND organization_id = p_org_id
  RETURNING * INTO v_run;

  RETURN v_run;
END;
$$;

GRANT EXECUTE ON FUNCTION public.calculate_payroll_run(UUID, UUID, UUID) TO authenticated;