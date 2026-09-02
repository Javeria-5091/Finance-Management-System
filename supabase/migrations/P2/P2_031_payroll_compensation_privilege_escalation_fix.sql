-- =====================================================================
-- Finance Management System — Critical Fix
--   F-P0-2 (P0): public.set_payroll_compensation_atomic is SECURITY
--   DEFINER and only checks org membership, not role/permission. Since
--   it is SECURITY DEFINER it bypasses the payroll_compensation RLS
--   insert/update policies (which correctly restrict writes to
--   FINANCE_HEAD/ACCOUNTANT). It was also GRANTed to anon.
--
--   Result: any authenticated user in the organization (EMPLOYEE,
--   VIEWER, TECH_ADMIN, HOD, PM, ...) could call the RPC directly with
--   any employee id and any amount and have it paid out by the next
--   payroll run -- a self-service salary override.
--
-- Fix:
--   1. Add a role check (core.is_finance_head() OR
--      core.has_role('ACCOUNTANT')) inside the function body, matching
--      the convention used by every other sensitive finance RPC in
--      this schema (see equity/fixed-asset/tax-reconciliation
--      functions).
--   2. Revoke the EXECUTE grant from anon -- this RPC has no business
--      being callable by unauthenticated callers at all.
-- =====================================================================

CREATE OR REPLACE FUNCTION "public"."set_payroll_compensation_atomic"("p_employee_id" "uuid", "p_compensation" "jsonb") RETURNS "public"."payroll_compensation"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'public'
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

  -- F-P0-2 fix: role check. This function is SECURITY DEFINER, so it
  -- bypasses the payroll_compensation RLS insert/update policies -- the
  -- org check above is NOT a substitute for a permission check. Only
  -- CEO/FINANCE_HEAD/ACCOUNTANT may write compensation; every other role
  -- (EMPLOYEE, VIEWER, TECH_ADMIN, HOD, PM, etc.) must be rejected here.
  IF NOT (core.is_finance_head() OR core.has_role('ACCOUNTANT')) THEN
    RAISE EXCEPTION 'Only CEO, Finance Head, or Accountant may set employee compensation';
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

ALTER FUNCTION "public"."set_payroll_compensation_atomic"("p_employee_id" "uuid", "p_compensation" "jsonb") OWNER TO "postgres";

-- anon must never be able to call this RPC.
REVOKE ALL ON FUNCTION "public"."set_payroll_compensation_atomic"("p_employee_id" "uuid", "p_compensation" "jsonb") FROM "anon";
GRANT ALL ON FUNCTION "public"."set_payroll_compensation_atomic"("p_employee_id" "uuid", "p_compensation" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."set_payroll_compensation_atomic"("p_employee_id" "uuid", "p_compensation" "jsonb") TO "service_role";
