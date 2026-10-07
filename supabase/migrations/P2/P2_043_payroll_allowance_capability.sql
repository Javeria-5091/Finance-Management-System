-- =============================================================================
-- Migration: P2_043_payroll_allowance_capability.sql
-- Implements: DEF-07 follow-up, CTO-approved direction (decision received
-- 7 Oct 2026) -- "configurable compensation components/types", NOT
-- hardcoded housing/medical/conveyance columns.
--
-- WHAT THIS BUILDS
--   - Housing / Medical / Conveyance / Other allowance, each configurable as
--     either a FIXED PKR amount or a PERCENTAGE of basic salary.
--   - A company-level default per allowance type (public.payroll_allowance_
--     policy), with a per-employee override using the SAME mechanism
--     already used for salary itself (public.payroll_compensation), so no
--     parallel/duplicate audit or effective-dating logic is introduced.
--   - Both are effective-dated (reuses the existing effective_from/
--     effective_to pattern already used everywhere else in payroll), so a
--     change is a new row, never an overwrite of payroll history.
--   - calculate_payroll_run() now resolves each employee's allowances
--     (employee override -> company default -> zero) and both calculates
--     and stores them in payroll_lines.housing_allow / medical_allow /
--     conveyance_allow / other_allowances -- these columns already existed
--     but were always hardcoded to 0.
--
-- WHAT THIS DELIBERATELY DOES NOT DO
--   Per the CTO's explicit instruction, no allowance amount or percentage
--   is invented or seeded for OSYSTIC here. With no policy and no employee
--   override configured, every allowance resolves to 0, exactly as
--   instructed ("if an employee has no allowance configuration, the
--   calculated allowance can remain zero"). Actual values are entered later
--   through Settings once approved.
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Company-level default allowance policy (effective-dated, one row per
--    allowance type per organization per effective period).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "public"."payroll_allowance_policy" (
    "id" uuid DEFAULT gen_random_uuid() NOT NULL,
    "organization_id" uuid NOT NULL,
    "allowance_type" character varying(30) NOT NULL,
    "calculation_method" character varying(20) DEFAULT 'FIXED' NOT NULL,
    "amount" numeric(14,2) NOT NULL,
    "is_active" boolean DEFAULT true NOT NULL,
    "effective_from" date DEFAULT CURRENT_DATE NOT NULL,
    "effective_to" date,
    "notes" text,
    "created_by" uuid,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT "payroll_allowance_policy_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "payroll_allowance_policy_type_check" CHECK (
      ("allowance_type")::text = ANY (ARRAY[
        'HOUSING_ALLOWANCE','MEDICAL_ALLOWANCE','CONVEYANCE_ALLOWANCE','OTHER_ALLOWANCE'
      ]::text[])
    ),
    CONSTRAINT "payroll_allowance_policy_method_check" CHECK (
      ("calculation_method")::text = ANY (ARRAY['FIXED','PERCENT_OF_BASIC']::text[])
    ),
    CONSTRAINT "payroll_allowance_policy_amount_check" CHECK ("amount" >= 0),
    CONSTRAINT "payroll_allowance_policy_dates_chk" CHECK ("effective_to" IS NULL OR "effective_to" >= "effective_from")
);

ALTER TABLE "public"."payroll_allowance_policy" OWNER TO "postgres";
COMMENT ON TABLE "public"."payroll_allowance_policy" IS
  'Company-level default allowance rule per type (CTO-approved direction, 7 Oct 2026). A per-employee row in payroll_compensation with the matching compensation_type overrides this for that employee. No rows are seeded by this migration -- resolves to zero until Settings is used to configure one.';

ALTER TABLE "public"."payroll_allowance_policy" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "payroll_allowance_policy_select" ON "public"."payroll_allowance_policy";
CREATE POLICY "payroll_allowance_policy_select" ON "public"."payroll_allowance_policy"
  FOR SELECT TO authenticated
  USING (core.same_org(organization_id) AND core.has_permission(auth.uid(), 'PAYROLL_READ'));

DROP POLICY IF EXISTS "payroll_allowance_policy_write" ON "public"."payroll_allowance_policy";
CREATE POLICY "payroll_allowance_policy_write" ON "public"."payroll_allowance_policy"
  FOR ALL TO authenticated
  USING (core.same_org(organization_id) AND core.has_permission(auth.uid(), 'PAYROLL_UPDATE'))
  WITH CHECK (core.same_org(organization_id) AND core.has_permission(auth.uid(), 'PAYROLL_UPDATE'));

GRANT SELECT, INSERT, UPDATE ON "public"."payroll_allowance_policy" TO "authenticated";

-- ---------------------------------------------------------------------------
-- 2. Per-employee override: reuse payroll_compensation (same effective-dating
--    and audit pattern as salary itself) rather than a parallel mechanism.
--    Add the 4 allowance types to the allowed compensation_type values, and
--    add calculation_method so an employee-specific allowance can also be a
--    percentage of their own basic salary, not only a fixed PKR amount.
-- ---------------------------------------------------------------------------
ALTER TABLE "public"."payroll_compensation"
  ADD COLUMN IF NOT EXISTS "calculation_method" character varying(20) DEFAULT 'FIXED' NOT NULL;

ALTER TABLE "public"."payroll_compensation"
  DROP CONSTRAINT IF EXISTS "payroll_compensation_calculation_method_check";
ALTER TABLE "public"."payroll_compensation"
  ADD CONSTRAINT "payroll_compensation_calculation_method_check"
  CHECK (("calculation_method")::text = ANY (ARRAY['FIXED','PERCENT_OF_BASIC']::text[]));

ALTER TABLE "public"."payroll_compensation"
  DROP CONSTRAINT IF EXISTS "payroll_compensation_compensation_type_check";
ALTER TABLE "public"."payroll_compensation"
  ADD CONSTRAINT "payroll_compensation_compensation_type_check" CHECK (
    ("compensation_type")::text = ANY (ARRAY[
      'MONTHLY_SALARY','HOURLY_RATE','DAILY_RATE','PROJECT_BASED','COMMISSION_ONLY','FIXED_CONTRACT',
      'HOUSING_ALLOWANCE','MEDICAL_ALLOWANCE','CONVEYANCE_ALLOWANCE','OTHER_ALLOWANCE'
    ]::text[])
  );

COMMENT ON COLUMN "public"."payroll_compensation"."calculation_method" IS
  'FIXED = amount is a PKR value. PERCENT_OF_BASIC = amount is a percentage applied to the employee''s own basic-salary compensation row. Only meaningful for the four *_ALLOWANCE compensation_type rows; salary rows are always FIXED.';

-- ---------------------------------------------------------------------------
-- 3. Resolver: employee override (payroll_compensation) -> company default
--    (payroll_allowance_policy) -> zero. SECURITY INVOKER is fine here: it
--    is only ever called from calculate_payroll_run(), which is already
--    SECURITY DEFINER and already authorization-checked.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION "public"."resolve_payroll_allowance"(
  "p_employee_id" uuid,
  "p_org_id" uuid,
  "p_allowance_type" character varying,
  "p_period_start" date,
  "p_period_end" date,
  "p_basic" numeric
) RETURNS numeric(14,2)
LANGUAGE plpgsql
STABLE
SET search_path TO 'pg_catalog', 'public'
AS $$
DECLARE
  v_method character varying(20);
  v_amount numeric(14,2);
BEGIN
  -- Employee-specific override wins if one is active for this period.
  SELECT calculation_method, amount INTO v_method, v_amount
  FROM public.payroll_compensation
  WHERE employee_id = p_employee_id
    AND is_active = true
    AND compensation_type = p_allowance_type
    AND effective_from <= p_period_end
    AND (effective_to IS NULL OR effective_to >= p_period_start)
  ORDER BY effective_from DESC
  LIMIT 1;

  IF NOT FOUND THEN
    -- Fall back to the company-level default for this organization.
    SELECT calculation_method, amount INTO v_method, v_amount
    FROM public.payroll_allowance_policy
    WHERE organization_id = p_org_id
      AND allowance_type = p_allowance_type
      AND is_active = true
      AND effective_from <= p_period_end
      AND (effective_to IS NULL OR effective_to >= p_period_start)
    ORDER BY effective_from DESC
    LIMIT 1;
  END IF;

  IF NOT FOUND THEN
    RETURN 0;
  END IF;

  IF v_method = 'PERCENT_OF_BASIC' THEN
    RETURN ROUND(COALESCE(p_basic, 0) * COALESCE(v_amount, 0) / 100.0, 2);
  ELSE
    RETURN COALESCE(v_amount, 0);
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION "public"."resolve_payroll_allowance"(uuid, uuid, character varying, date, date, numeric) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "public"."resolve_payroll_allowance"(uuid, uuid, character varying, date, date, numeric) TO authenticated;

-- ---------------------------------------------------------------------------
-- 3.5 CRITICAL FIX found while building this: set_payroll_compensation_atomic
--    closed out EVERY currently-active compensation row for the employee
--    (WHERE employee_id = ... AND is_active = true, with no compensation_type
--    filter) whenever ANY new compensation row was set. That was harmless
--    while an employee could only ever have one row (salary) at a time, but
--    now that an employee can have a salary row AND one or more allowance
--    rows active simultaneously, this would have silently closed out the
--    employee's SALARY the moment an allowance was set (or closed out an
--    allowance the moment salary was changed). Scoped the close-out to the
--    same compensation_type only. Also added calculation_method to the
--    INSERT so the Settings UI can save FIXED vs PERCENT_OF_BASIC.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION "public"."set_payroll_compensation_atomic"("p_employee_id" "uuid", "p_compensation" "jsonb") RETURNS "public"."payroll_compensation"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'public'
    AS $$
DECLARE
  v_org_id UUID;
  v_effective_from DATE;
  v_type TEXT;
  v_row public.payroll_compensation;
BEGIN
  SELECT organization_id INTO v_org_id
  FROM public.payroll_employees
  WHERE id = p_employee_id;

  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'Employee % not found', p_employee_id;
  END IF;

  IF v_org_id IS DISTINCT FROM (
    SELECT organization_id FROM public.profiles WHERE user_id = auth.uid()
  ) THEN
    RAISE EXCEPTION 'Not authorized to set compensation for this employee';
  END IF;

  IF NOT (core.is_finance_head() OR core.has_role('ACCOUNTANT')) THEN
    RAISE EXCEPTION 'Only CEO, Finance Head, or Accountant may set employee compensation';
  END IF;

  v_type := COALESCE(p_compensation->>'compensation_type', 'MONTHLY_SALARY');
  v_effective_from := COALESCE((p_compensation->>'effective_from')::DATE, CURRENT_DATE);

  IF COALESCE((p_compensation->>'amount')::NUMERIC, -1) < 0 THEN
    RAISE EXCEPTION 'Compensation amount must be zero or greater';
  END IF;

  -- P2_043 FIX: only close out a prior row of the SAME compensation_type.
  -- An employee's salary and their allowances are independent, concurrently
  -- active records, not a single slot being replaced.
  UPDATE public.payroll_compensation
  SET is_active = false,
      effective_to = LEAST(COALESCE(effective_to, v_effective_from - 1), v_effective_from - 1),
      updated_at = now()
  WHERE employee_id = p_employee_id
    AND compensation_type = v_type
    AND is_active = true;

  INSERT INTO public.payroll_compensation (
    employee_id, organization_id, compensation_type, calculation_method, amount, currency,
    effective_from, effective_to, is_active, project_id, notes, created_by
  ) VALUES (
    p_employee_id, v_org_id,
    v_type,
    COALESCE(NULLIF(p_compensation->>'calculation_method', ''), 'FIXED'),
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

COMMENT ON FUNCTION "public"."set_payroll_compensation_atomic"("p_employee_id" "uuid", "p_compensation" "jsonb") IS
  'P2_043 fix: closing out a prior compensation row is now scoped to the same compensation_type, so setting an allowance no longer closes out the employee''s salary (or vice versa). Also now accepts calculation_method (FIXED / PERCENT_OF_BASIC).';

-- ---------------------------------------------------------------------------
-- 4. calculate_payroll_run(): resolve and store real allowance amounts
--    instead of the hardcoded 0, 0, 0, 0. Every other line of this function
--    is unchanged from its previous version -- only the allowance handling
--    and v_gross are new.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION "public"."calculate_payroll_run"("p_run_id" "uuid", "p_org_id" "uuid", "p_actor" "uuid") RETURNS "public"."payroll_runs"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'public', 'core'
    AS $$
DECLARE
  v_run public.payroll_runs;
  v_emp RECORD;
  v_comp RECORD;
  v_basic NUMERIC(14,2);
  v_housing NUMERIC(14,2);
  v_medical NUMERIC(14,2);
  v_conveyance NUMERIC(14,2);
  v_other_allow NUMERIC(14,2);
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

  IF p_org_id IS DISTINCT FROM core.current_user_org_id() THEN
    RAISE EXCEPTION 'calculate_payroll_run: p_org_id does not match the caller''s organization'
      USING ERRCODE = '42501';
  END IF;

  IF p_actor IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'calculate_payroll_run: p_actor must match the authenticated caller'
      USING ERRCODE = '42501';
  END IF;

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

  DELETE FROM public.payroll_lines WHERE payroll_run_id = p_run_id;

  FOR v_emp IN
    SELECT * FROM public.payroll_employees
    WHERE organization_id = p_org_id AND status = 'ACTIVE'
  LOOP
    SELECT * INTO v_comp
    FROM public.payroll_compensation
    WHERE employee_id = v_emp.id
      AND is_active = true
      AND compensation_type NOT IN ('HOUSING_ALLOWANCE','MEDICAL_ALLOWANCE','CONVEYANCE_ALLOWANCE','OTHER_ALLOWANCE')
      AND effective_from <= v_run.period_end
      AND (effective_to IS NULL OR effective_to >= v_run.period_start)
    ORDER BY effective_from DESC
    LIMIT 1;

    IF NOT FOUND THEN
      CONTINUE;
    END IF;

    v_basic := COALESCE(v_comp.amount, 0);

    -- P2_043: resolve each allowance (employee override -> company default
    -- -> zero), as PKR or % of this employee's own basic salary.
    v_housing    := public.resolve_payroll_allowance(v_emp.id, p_org_id, 'HOUSING_ALLOWANCE',    v_run.period_start, v_run.period_end, v_basic);
    v_medical    := public.resolve_payroll_allowance(v_emp.id, p_org_id, 'MEDICAL_ALLOWANCE',    v_run.period_start, v_run.period_end, v_basic);
    v_conveyance := public.resolve_payroll_allowance(v_emp.id, p_org_id, 'CONVEYANCE_ALLOWANCE', v_run.period_start, v_run.period_end, v_basic);
    v_other_allow:= public.resolve_payroll_allowance(v_emp.id, p_org_id, 'OTHER_ALLOWANCE',      v_run.period_start, v_run.period_end, v_basic);

    SELECT COALESCE(SUM(commission_amount), 0) INTO v_commission
    FROM public.payroll_commissions
    WHERE employee_id = v_emp.id
      AND organization_id = p_org_id
      AND status = 'APPROVED'
      AND period_month = v_run.payroll_period;

    v_gross := v_basic + v_housing + v_medical + v_conveyance + v_other_allow + v_commission;

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

    SELECT COALESCE(SUM(LEAST(COALESCE(monthly_deduction, remaining_balance), remaining_balance)), 0)
    INTO v_advance
    FROM public.payroll_advances
    WHERE employee_id = v_emp.id
      AND organization_id = p_org_id
      AND approval_status IN ('APPROVED', 'PARTIALLY_RECOVERED')
      AND remaining_balance > 0
      AND (start_deduction_month IS NULL OR start_deduction_month <= v_run.payroll_period);

    v_total_ded := v_tax + v_pf + v_eobi + v_advance + v_other_ded;
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
      v_basic, v_housing, v_medical, v_conveyance, v_other_allow,
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

COMMENT ON FUNCTION "public"."calculate_payroll_run"("p_run_id" "uuid", "p_org_id" "uuid", "p_actor" "uuid") IS
  'P2_043: now resolves and stores real housing/medical/conveyance/other allowances via resolve_payroll_allowance() (employee override in payroll_compensation, else company default in payroll_allowance_policy, else zero), instead of always writing zero. The basic-compensation lookup now explicitly excludes the four *_ALLOWANCE compensation_type rows so they are never mistaken for the employee''s basic salary. All other logic (RLS/permission checks, commissions, deductions, advances, snapshotting) is unchanged from the prior version.';

COMMIT;

-- ---------------------------------------------------------------------------
-- Example (NOT run by this migration) of how a company-wide default would
-- be configured later, once approved -- e.g. a flat PKR 15,000 housing
-- allowance for everyone, with no override needed per employee:
--
-- INSERT INTO public.payroll_allowance_policy
--   (organization_id, allowance_type, calculation_method, amount, created_by)
-- VALUES
--   ('<org-id>', 'HOUSING_ALLOWANCE', 'FIXED', 15000.00, '<user-id>');
--
-- Or a per-employee override at 10% of that one employee's own basic salary:
--
-- INSERT INTO public.payroll_compensation
--   (employee_id, organization_id, compensation_type, calculation_method, amount, created_by)
-- VALUES
--   ('<employee-id>', '<org-id>', 'HOUSING_ALLOWANCE', 'PERCENT_OF_BASIC', 10, '<user-id>');
-- ---------------------------------------------------------------------------