-- =====================================================================
-- Finance Management System — Critical Fix
--   FND-RLS-02 (P1): public.calculate_payroll_run is a SECURITY DEFINER
--   RPC with no auth.uid() / permission / same-org check, and is granted
--   to `anon`. p_org_id and p_actor are ordinary client parameters, so it
--   trusts whatever the caller sends for both "which tenant" and "who did
--   this".
--
-- The Next.js route (src/app/api/finance/payroll/route.ts) does check
-- PAYROLL_UPDATE and scope the run to auth.orgId before calling this RPC
-- -- but that route is not the only way to reach a PostgREST RPC. Anyone
-- who can reach Supabase's REST endpoint directly (anon key is public by
-- design) can POST /rest/v1/rpc/calculate_payroll_run with any
-- p_run_id/p_org_id/p_actor and skip the app layer entirely. The database
-- function itself must not trust its caller.
-- =====================================================================

BEGIN;

CREATE OR REPLACE FUNCTION "public"."calculate_payroll_run"("p_run_id" "uuid", "p_org_id" "uuid", "p_actor" "uuid") RETURNS "public"."payroll_runs"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'public', 'core'
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
  -- FND-RLS-02 FIX: authenticate and authorize inside the function itself,
  -- rather than trusting the caller's p_org_id/p_actor or relying on an
  -- application-layer check that a direct PostgREST/RPC call bypasses.

  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'calculate_payroll_run: must be called by an authenticated user'
      USING ERRCODE = '28000';
  END IF;

  -- p_org_id must be the caller's own organization -- never trust it as a
  -- free client parameter, or any authenticated user could recalculate
  -- another tenant's payroll by guessing/enumerating org UUIDs.
  IF p_org_id IS DISTINCT FROM core.current_user_org_id() THEN
    RAISE EXCEPTION 'calculate_payroll_run: p_org_id does not match the caller''s organization'
      USING ERRCODE = '42501';
  END IF;

  -- p_actor must be the caller themselves -- never let a client stamp an
  -- arbitrary calculated_by.
  IF p_actor IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'calculate_payroll_run: p_actor must match the authenticated caller'
      USING ERRCODE = '42501';
  END IF;

  -- Same permission the app route already enforces
  -- (src/app/api/finance/payroll/route.ts requires PAYROLL_UPDATE for the
  -- 'calculate' action) -- now also enforced here, so it can't be
  -- bypassed by calling the RPC directly.
  IF NOT core.has_permission(auth.uid(), 'PAYROLL_UPDATE') THEN
    RAISE EXCEPTION 'calculate_payroll_run: PAYROLL_UPDATE permission required'
      USING ERRCODE = '42501';
  END IF;

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

ALTER FUNCTION "public"."calculate_payroll_run"("p_run_id" "uuid", "p_org_id" "uuid", "p_actor" "uuid") OWNER TO "postgres";

COMMENT ON FUNCTION "public"."calculate_payroll_run"("p_run_id" "uuid", "p_org_id" "uuid", "p_actor" "uuid") IS
  'FND-RLS-02 fix: now requires auth.uid() IS NOT NULL, p_org_id = core.current_user_org_id(), p_actor = auth.uid(), and core.has_permission(auth.uid(),''PAYROLL_UPDATE'') before touching any payroll data. Previously trusted p_org_id/p_actor as ordinary client parameters with no auth check at all, and was grantable to anon.';

-- Defense-in-depth: an anon caller now fails the auth.uid() IS NULL check
-- inside the function regardless of grants, but there is no legitimate
-- reason for anon to hold EXECUTE on this at all. Revoke it.
REVOKE ALL ON FUNCTION "public"."calculate_payroll_run"("p_run_id" "uuid", "p_org_id" "uuid", "p_actor" "uuid") FROM "anon";

GRANT ALL ON FUNCTION "public"."calculate_payroll_run"("p_run_id" "uuid", "p_org_id" "uuid", "p_actor" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."calculate_payroll_run"("p_run_id" "uuid", "p_org_id" "uuid", "p_actor" "uuid") TO "service_role";

COMMIT;

-- ---------------------------------------------------------------------
-- Verification:
--   1) As anon (no session): rpc call now fails at auth.uid() IS NULL
--      (and, independently, is no longer GRANTed at all).
--   2) As an authenticated EMPLOYEE without PAYROLL_UPDATE, on a DRAFT
--      run that exists in their own org:
--        select public.calculate_payroll_run('<run-id>', '<own-org-id>', auth.uid());
--        -- expect: ERROR  PAYROLL_UPDATE permission required
--   3) As an authenticated user WITH PAYROLL_UPDATE, passing a foreign
--      org's id as p_org_id:
--        select public.calculate_payroll_run('<run-id>', '<other-org-id>', auth.uid());
--        -- expect: ERROR  p_org_id does not match the caller's organization
--   4) As an authenticated user WITH PAYROLL_UPDATE, passing someone
--      else's uuid as p_actor:
--        select public.calculate_payroll_run('<run-id>', '<own-org-id>', '<other-user-id>');
--        -- expect: ERROR  p_actor must match the authenticated caller
--   5) Normal path (own org, own uid, has PAYROLL_UPDATE, run is DRAFT)
--      still succeeds exactly as before.
-- ---------------------------------------------------------------------