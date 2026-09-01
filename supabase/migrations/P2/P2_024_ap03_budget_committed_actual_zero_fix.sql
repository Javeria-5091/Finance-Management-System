-- =====================================================================
-- Finance Management System — Critical Fix
--   AP-03 (P1): Budget "Committed" and "Actual" are always zero.
--
-- Evidence:
--   src/services/budget-check.service.ts:194-213 (getBudgetAmounts) reads
--   committed from finance.budget_lines.committed_amount and actual from
--   reporting.budget_gl_actual.actual_spent. Both are correctly wired on
--   the READ side:
--     - finance.budget_lines.committed_amount is trigger-maintained
--       (trg_sync_budget_line_committed_amount, schema.sql:18217) as
--       SUM(amount) of OPEN finance.budget_commitments rows for that
--       budget line.
--     - reporting.budget_gl_actual (schema.sql:14827) computes actual_spent
--       straight from finance.journal_lines/journal_entries posted against
--       a budget line's account_id, inside the budget's date range.
--
--   Neither has a WRITE side anywhere in the app:
--     1. finance.budget_lines is never populated when a budget is
--        approved. src/app/api/finance/budgets/[id]/route.ts only ever
--        flips public.budgets.status -> 'APPROVED'; it never creates the
--        finance.budget_lines row (keyed to budgets.control_account_id)
--        that reporting.budget_gl_actual needs to find any GL activity at
--        all. Without that row, actual_spent has nothing to join to and
--        getBudgetAmounts()'s `actual` is always 0, no matter how much is
--        posted to the control account.
--     2. finance.budget_commitments is never inserted into by any route.
--        src/app/api/finance/purchase-requests/[id]/route.ts approves a
--        purchase request (the one place in the app that represents a
--        firm, not-yet-posted spend commitment — see the
--        'PURCHASE_REQUEST' source_type on budget_commitments) but never
--        writes an encumbrance row, so
--        finance.sync_budget_line_committed_amount()'s SUM(...) always
--        sums zero rows and committed_amount never leaves 0. (Confirmed by
--        src/app/api/projects/[id]/route.ts's closure guard, which
--        already reads finance.budget_commitments expecting open
--        encumbrances to show up there — it just never gets any.)
--
-- Fix:
--   1. finance.ensure_budget_line(p_budget_id) — SECURITY DEFINER helper
--      that upserts the finance.budget_lines row for a budget's
--      control_account_id (insert if missing, keep budgeted_amount in
--      sync with public.budgets.total_amount otherwise). No-ops (returns
--      NULL) for budgets with no control_account_id configured, so
--      existing budgets that were never set up for GL tracking don't
--      start throwing on approval.
--      Called from src/app/api/finance/budgets/[id]/route.ts on the
--      'approve' action, and from finance.approve_budget_revision_atomic
--      so a revised total_amount keeps the budget line's budgeted_amount
--      in sync too.
--   2. finance.create_budget_commitment(...) — SECURITY DEFINER helper
--      that resolves/creates the budget line via ensure_budget_line(),
--      then inserts an OPEN finance.budget_commitments row. The existing
--      trg_sync_budget_line_committed_amount trigger does the rest.
--      Called from src/app/api/finance/purchase-requests/[id]/route.ts
--      on the 'approve' action.
--   3. finance.release_budget_commitments_by_source(...) — SECURITY
--      DEFINER helper that releases (status='RELEASED') any OPEN
--      commitments tied to a given source record. Called from the same
--      purchase-request route on 'reject'/'cancel', so a request that
--      never becomes real spend stops holding budget.
--
-- Scope note: finance.budget_commitments.source_type also allows
-- 'VENDOR_BILL' and 'MANUAL' for future encumbrance sources (e.g. an
-- approved-but-unposted vendor bill, or a manually booked reservation).
-- Nothing in the current app creates those yet, so this migration does
-- not invent that workflow — it only wires up the one source (approved
-- purchase requests) the app already models end-to-end.
-- =====================================================================

BEGIN;

-- ── 1. finance.ensure_budget_line — upsert the GL-tracking budget line
--       for a budget's control account ─────────────────────────────────
CREATE OR REPLACE FUNCTION "finance"."ensure_budget_line"("p_budget_id" "uuid") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'finance', 'core', 'public'
    AS $$
DECLARE
  v_org uuid := core.current_user_org_id();
  v_budget public.budgets%ROWTYPE;
  v_line_id uuid;
BEGIN
  IF v_org IS NULL THEN RAISE EXCEPTION 'Organization context is required'; END IF;

  SELECT * INTO v_budget
  FROM public.budgets
  WHERE id = p_budget_id AND organization_id = v_org
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Budget not found in your organization'; END IF;

  -- Budgets created before a control account was configured (or that will
  -- never post to GL) simply can't be tracked at the account level. Return
  -- NULL rather than raising, so approving/revising them still succeeds —
  -- the caller can surface this as a soft warning.
  IF v_budget.control_account_id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT id INTO v_line_id
  FROM finance.budget_lines
  WHERE budget_id = v_budget.id
    AND account_id = v_budget.control_account_id
    AND organization_id = v_org
  FOR UPDATE;

  IF FOUND THEN
    UPDATE finance.budget_lines
    SET budgeted_amount = v_budget.total_amount
    WHERE id = v_line_id;
  ELSE
    INSERT INTO finance.budget_lines (budget_id, account_id, organization_id, budgeted_amount)
    VALUES (v_budget.id, v_budget.control_account_id, v_org, v_budget.total_amount)
    RETURNING id INTO v_line_id;
  END IF;

  RETURN v_line_id;
END;
$$;

ALTER FUNCTION "finance"."ensure_budget_line"("uuid") OWNER TO "postgres";

COMMENT ON FUNCTION "finance"."ensure_budget_line"("uuid") IS
  'AP-03 FIX: creates/updates the finance.budget_lines row (keyed to the budget''s control_account_id) that reporting.budget_gl_actual and finance.budget_commitments both depend on. Returns NULL (no-op) if the budget has no control_account_id. Called on budget approval and budget revision approval.';

REVOKE ALL ON FUNCTION "finance"."ensure_budget_line"("uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "finance"."ensure_budget_line"("uuid") TO "authenticated";
GRANT ALL ON FUNCTION "finance"."ensure_budget_line"("uuid") TO "service_role";


-- ── 2. finance.create_budget_commitment — open an encumbrance against a
--       budget's line, creating the line on demand ─────────────────────
CREATE OR REPLACE FUNCTION "finance"."create_budget_commitment"(
    "p_budget_id" "uuid",
    "p_source_type" "text",
    "p_source_reference" "text",
    "p_amount" numeric,
    "p_description" "text" DEFAULT NULL
) RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'finance', 'core', 'public'
    AS $$
DECLARE
  v_org uuid := core.current_user_org_id();
  v_user uuid := auth.uid();
  v_budget public.budgets%ROWTYPE;
  v_line_id uuid;
  v_commitment_id uuid;
BEGIN
  IF v_org IS NULL OR v_user IS NULL THEN
    RAISE EXCEPTION 'Authenticated organization context is required';
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'Commitment amount must be positive';
  END IF;
  IF p_source_type NOT IN ('PURCHASE_REQUEST', 'VENDOR_BILL', 'MANUAL') THEN
    RAISE EXCEPTION 'Invalid commitment source type: %', p_source_type;
  END IF;

  SELECT * INTO v_budget
  FROM public.budgets
  WHERE id = p_budget_id AND organization_id = v_org AND status = 'APPROVED';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'No APPROVED budget found for this organization';
  END IF;

  v_line_id := finance.ensure_budget_line(p_budget_id);
  IF v_line_id IS NULL THEN
    RAISE EXCEPTION 'Budget "%" has no control account configured — cannot track a commitment against it. Set a control account on the budget first.', COALESCE(v_budget.name, v_budget.id::text);
  END IF;

  INSERT INTO finance.budget_commitments (
    budget_line_id, organization_id, source_type, source_reference,
    amount, base_amount, status, description, created_by
  ) VALUES (
    v_line_id, v_org, p_source_type, p_source_reference,
    p_amount, p_amount, 'OPEN', p_description, v_user
  )
  RETURNING id INTO v_commitment_id;

  RETURN v_commitment_id;
END;
$$;

ALTER FUNCTION "finance"."create_budget_commitment"("uuid", "text", "text", numeric, "text") OWNER TO "postgres";

COMMENT ON FUNCTION "finance"."create_budget_commitment"("uuid", "text", "text", numeric, "text") IS
  'AP-03 FIX: opens an OPEN finance.budget_commitments encumbrance row against the resolved budget line (creating the line if needed), giving finance.budget_lines.committed_amount (trigger-maintained) a real source. base_amount == amount: the sources wired to this function today (purchase_requests) carry no FX/exchange_rate column, so no conversion is available or assumed.';

REVOKE ALL ON FUNCTION "finance"."create_budget_commitment"("uuid", "text", "text", numeric, "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "finance"."create_budget_commitment"("uuid", "text", "text", numeric, "text") TO "authenticated";
GRANT ALL ON FUNCTION "finance"."create_budget_commitment"("uuid", "text", "text", numeric, "text") TO "service_role";


-- ── 3. finance.release_budget_commitments_by_source — release open
--       encumbrances tied to a source record (e.g. a rejected/cancelled
--       purchase request) ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION "finance"."release_budget_commitments_by_source"(
    "p_source_type" "text",
    "p_source_reference" "text",
    "p_release_reason" "text"
) RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'finance', 'core', 'public'
    AS $$
DECLARE
  v_org uuid := core.current_user_org_id();
  v_user uuid := auth.uid();
  v_reason text := NULLIF(BTRIM(COALESCE(p_release_reason, '')), '');
  v_count integer;
BEGIN
  IF v_org IS NULL OR v_user IS NULL THEN
    RAISE EXCEPTION 'Authenticated organization context is required';
  END IF;
  IF v_reason IS NULL THEN
    RAISE EXCEPTION 'A release reason is required';
  END IF;

  UPDATE finance.budget_commitments
  SET status = 'RELEASED',
      released_by = v_user,
      released_at = now(),
      release_reason = v_reason,
      updated_at = now()
  WHERE organization_id = v_org
    AND source_type = p_source_type
    AND source_reference = p_source_reference
    AND status = 'OPEN';

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

ALTER FUNCTION "finance"."release_budget_commitments_by_source"("text", "text", "text") OWNER TO "postgres";

COMMENT ON FUNCTION "finance"."release_budget_commitments_by_source"("text", "text", "text") IS
  'AP-03 FIX: releases OPEN finance.budget_commitments rows for a given source record (e.g. source_type=PURCHASE_REQUEST, source_reference=<purchase_request id>) so a rejected/cancelled commitment stops holding budget. Companion to finance.create_budget_commitment.';

REVOKE ALL ON FUNCTION "finance"."release_budget_commitments_by_source"("text", "text", "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "finance"."release_budget_commitments_by_source"("text", "text", "text") TO "authenticated";
GRANT ALL ON FUNCTION "finance"."release_budget_commitments_by_source"("text", "text", "text") TO "service_role";


-- ── 4. Keep finance.budget_lines.budgeted_amount in sync when a budget
--       revision is approved (previously only public.budgets.total_amount
--       was updated) ───────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION "finance"."approve_budget_revision_atomic"("p_budget_id" "uuid", "p_revision_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'finance', 'core'
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

  -- AP-03 FIX: propagate the revised total to the tracked budget line (if
  -- one exists / can be created) so committed/actual reporting reflects
  -- the new ceiling immediately instead of the stale pre-revision amount.
  PERFORM finance.ensure_budget_line(v_budget.id);

  RETURN jsonb_build_object(
    'budget_id', v_budget.id,
    'revision_id', v_revision.id,
    'status', 'APPROVED',
    'total_amount', v_revision.revised_amount
  );
END;
$$;

ALTER FUNCTION "finance"."approve_budget_revision_atomic"("p_budget_id" "uuid", "p_revision_id" "uuid") OWNER TO "postgres";

COMMIT;