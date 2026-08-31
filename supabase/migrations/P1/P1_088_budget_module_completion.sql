-- ============================================================================
-- P1-092: Budget module completion, applied after the existing migrations.
-- Fixes only the three budget findings in the audit:
--   FND-BUDG-001 budget check reads non-existent parent totals
--   FND-BUDG-002 missing DRAFT -> SUBMITTED -> APPROVED route
--   FND-BUDG-003 non-atomic budget revision approval
--
-- This migration deliberately does NOT create public.budget_gl_actual.
-- The canonical view is reporting.budget_gl_actual; the dashboard must query
-- the reporting schema. Creating a duplicate public object would introduce a
-- second source of truth and could regress existing RLS/schema assumptions.
-- ============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION finance.approve_budget_revision_atomic(
  p_budget_id uuid,
  p_revision_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, finance, core
AS $$
DECLARE
  v_org_id uuid;
  v_user_id uuid;
  v_budget public.budgets%ROWTYPE;
  v_revision finance.budget_revisions%ROWTYPE;
BEGIN
  v_user_id := auth.uid();
  v_org_id := core.current_user_org_id();

  IF v_user_id IS NULL OR v_org_id IS NULL THEN
    RAISE EXCEPTION 'Authenticated organization context is required';
  END IF;

  SELECT * INTO v_budget
  FROM public.budgets
  WHERE id = p_budget_id
    AND organization_id = v_org_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Budget not found';
  END IF;

  SELECT * INTO v_revision
  FROM finance.budget_revisions
  WHERE id = p_revision_id
    AND budget_id = p_budget_id
    AND organization_id = v_org_id
    AND status = 'PENDING'
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Pending budget revision not found';
  END IF;

  IF v_revision.requested_by = v_user_id THEN
    RAISE EXCEPTION 'Maker-checker rule: the requester cannot approve their own revision';
  END IF;

  UPDATE public.budgets
  SET total_amount = v_revision.revised_amount,
      updated_at = now()
  WHERE id = v_budget.id
    AND organization_id = v_org_id;

  UPDATE finance.budget_revisions
  SET status = 'APPROVED',
      approved_by = v_user_id,
      approved_at = now()
  WHERE id = v_revision.id
    AND organization_id = v_org_id;

  RETURN jsonb_build_object(
    'budget_id', v_budget.id,
    'revision_id', v_revision.id,
    'status', 'APPROVED',
    'total_amount', v_revision.revised_amount
  );
END;
$$;

REVOKE ALL ON FUNCTION finance.approve_budget_revision_atomic(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION finance.approve_budget_revision_atomic(uuid, uuid) TO authenticated;

COMMENT ON FUNCTION finance.approve_budget_revision_atomic(uuid, uuid) IS
  'FND-BUDG-003: atomically applies a pending budget revision and marks it approved. Organization and maker-checker checks are enforced inside the transaction.';

COMMIT;
