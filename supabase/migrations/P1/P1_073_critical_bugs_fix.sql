-- ================================================================
-- OSYSTIC Finance — Confirmed Critical Fixes 003/004/005
-- Scope deliberately limited to the three confirmed DB blockers.
-- ================================================================

-- BUG-003: PMT-RC numbering sequence.
-- One organization-scoped global sequence per organization is enough for
-- finance.get_next_number('PMT-RC', organization_id).
INSERT INTO finance.numbering_sequences
  (sequence_type, prefix, current_number, padding, reset_per_period, format, organization_id, created_by)
SELECT
  'PMT-RC', 'PMT-RC-', 0, 4, false, '{PREFIX}{NUMBER}', o.id, NULL
FROM core.organizations o
WHERE NOT EXISTS (
  SELECT 1
  FROM finance.numbering_sequences ns
  WHERE ns.organization_id = o.id
    AND ns.sequence_type = 'PMT-RC'
    AND ns.fiscal_year_id IS NULL
);

-- BUG-004: Fiscal-year creation must carry the caller's organization into
-- both the fiscal year and generated periods. The caller's org is resolved
-- server-side; it is never accepted as an arbitrary client-supplied value.
CREATE OR REPLACE FUNCTION finance.create_fiscal_year_with_periods(
  p_name text,
  p_start_date date,
  p_end_date date,
  p_description text DEFAULT NULL,
  p_created_by uuid DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO pg_catalog, finance, public, core
AS $$
DECLARE
  v_fy_id uuid;
  v_month_count integer;
  v_user_id uuid := COALESCE(p_created_by, auth.uid());
  v_org_id uuid := core.current_user_org_id();
BEGIN
  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'Organization context is required';
  END IF;

  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Authenticated user is required';
  END IF;

  IF p_end_date <= p_start_date THEN
    RAISE EXCEPTION 'End date must be after start date';
  END IF;

  v_month_count :=
    (EXTRACT(YEAR FROM p_end_date) - EXTRACT(YEAR FROM p_start_date)) * 12
    + EXTRACT(MONTH FROM p_end_date) - EXTRACT(MONTH FROM p_start_date) + 1;

  IF v_month_count < 1 OR v_month_count > 24 THEN
    RAISE EXCEPTION 'Fiscal year must be between 1 and 24 months';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM finance.fiscal_years fy
    WHERE fy.organization_id = v_org_id
      AND p_start_date < fy.end_date
      AND p_end_date > fy.start_date
  ) THEN
    RAISE EXCEPTION 'Overlaps with an existing fiscal year in this organization';
  END IF;

  PERFORM set_config('app.current_user_id', v_user_id::text, true);

  INSERT INTO finance.fiscal_years
    (name, start_date, end_date, description, created_by, organization_id)
  VALUES
    (p_name, p_start_date, p_end_date, p_description, v_user_id, v_org_id)
  RETURNING id INTO v_fy_id;

  INSERT INTO finance.accounting_periods
    (fiscal_year_id, period_number, name, start_date, end_date,
     status, created_by, organization_id)
  SELECT
    v_fy_id,
    gs.period_num,
    TO_CHAR(gs.month_start, 'Month YYYY'),
    gs.month_start,
    LEAST(
      (gs.month_start + INTERVAL '1 month' - INTERVAL '1 day')::date,
      p_end_date
    ),
    'PENDING',
    v_user_id,
    v_org_id
  FROM (
    SELECT
      generate_series(1, v_month_count) AS period_num,
      (p_start_date + (generate_series(1, v_month_count) - 1) * INTERVAL '1 month')::date AS month_start
  ) gs;

  RETURN v_fy_id;
END;
$$;

-- BUG-005: the service calls finance.close_period but the function did not
-- exist. This implementation keeps the existing service contract and enforces
-- organization + role + valid status transitions inside the SECURITY DEFINER.
CREATE OR REPLACE FUNCTION finance.close_period(
  p_period_id uuid,
  p_closed_by uuid DEFAULT NULL,
  p_status text DEFAULT 'SOFT_CLOSED',
  p_reason text DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO pg_catalog, finance, public, core
AS $$
DECLARE
  v_period finance.accounting_periods%ROWTYPE;
  v_user_id uuid := COALESCE(p_closed_by, auth.uid());
  v_org_id uuid := core.current_user_org_id();
BEGIN
  IF v_org_id IS NULL OR v_user_id IS NULL THEN
    RAISE EXCEPTION 'Authentication and organization context are required';
  END IF;

  IF NOT core.is_finance_head() THEN
    RAISE EXCEPTION 'Only CEO or Finance Head may close an accounting period';
  END IF;

  IF p_status NOT IN ('SOFT_CLOSED', 'HARD_CLOSED') THEN
    RAISE EXCEPTION 'Invalid close status: %. Expected SOFT_CLOSED or HARD_CLOSED', p_status;
  END IF;

  IF NULLIF(btrim(COALESCE(p_reason, '')), '') IS NULL THEN
    RAISE EXCEPTION 'A reason is required to close a period';
  END IF;

  SELECT ap.*
  INTO v_period
  FROM finance.accounting_periods ap
  WHERE ap.id = p_period_id
    AND ap.organization_id = v_org_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Accounting period not found or access denied';
  END IF;

  IF v_period.status NOT IN ('OPEN', 'SOFT_CLOSED') THEN
    RAISE EXCEPTION 'Period cannot be closed from status %', v_period.status;
  END IF;

  IF v_period.status = 'SOFT_CLOSED' AND p_status = 'SOFT_CLOSED' THEN
    RAISE EXCEPTION 'Period is already SOFT_CLOSED';
  END IF;

  PERFORM set_config('app.current_user_id', v_user_id::text, true);

  UPDATE finance.accounting_periods
  SET status = p_status,
      closed_by = v_user_id,
      closed_at = NOW(),
      reopening_reason = p_reason,
      updated_at = NOW()
  WHERE id = v_period.id
    AND organization_id = v_org_id;
END;
$$;

GRANT EXECUTE ON FUNCTION finance.close_period(uuid, uuid, text, text) TO authenticated;
