-- =============================================================================
-- Migration 017: Add RLS policies for tables with RLS enabled but ZERO
--                policies defined
-- =============================================================================
-- PURPOSE
--   The compliance audit found 8 tables with `ENABLE ROW LEVEL SECURITY` but
--   no `CREATE POLICY` at all. In Postgres this means every request from a
--   normal (non-owner, non-service_role) session is denied outright:
--     core.approval_actions, core.approval_requests, core.approval_steps,
--     core.employee_links, core.integration_events,
--     finance.attendance_period_snapshots, finance.budget_revisions,
--     finance.dimensions
--
--   Three of these (approval_actions/approval_requests/approval_steps) are
--   the entire maker-checker / approval-workflow object model required by
--   spec Section 7.3 and 12.9. Without policies, approvers cannot see or act
--   on pending approvals through a normal authenticated session.
--
-- ISSUES FIXED
--   - Spec 7.3/12.9: approval workflow readable/actionable by participants
--   - Spec Appendix D.2: employee_links / integration_events readable by
--     Finance Head/CEO for monitoring cross-module integration health
--   - Spec 5.9: attendance_period_snapshots readable by authorized
--     payroll/finance roles; remains INSERT-only / immutable once written,
--     consistent with its own "must never be edited" table comment
--   - Spec 5.4: budget_revisions visible to the same audience as budgets,
--     with approval restricted to Finance Head/CEO
--   - Spec 5.1: dimensions (departments/cost centers) readable by all
--     authenticated users (low-sensitivity lookup data used on every
--     transaction form), writable only by Finance Head/CEO
--
-- SAFETY
--   Purely additive: only CREATE POLICY statements, no drops, no data
--   changes. Where a table's own design intent is "immutable after insert"
--   (attendance_period_snapshots, approval_actions), we deliberately do NOT
--   add UPDATE/DELETE policies -- default-deny is the correct, intentional
--   behavior there, not a gap.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------
-- core.approval_requests
-- -----------------------------------------------------------------------
CREATE POLICY "approval_requests_select" ON "core"."approval_requests"
  FOR SELECT
  USING (
    requested_by = auth.uid()
    OR core.is_ceo_or_admin()
    OR core.is_finance_head()
    OR EXISTS (
      SELECT 1 FROM core.approval_steps s
      WHERE s.approval_request_id = approval_requests.id
        AND s.assigned_user_id = auth.uid()
    )
  );

CREATE POLICY "approval_requests_insert" ON "core"."approval_requests"
  FOR INSERT
  WITH CHECK (requested_by = auth.uid());

CREATE POLICY "approval_requests_update" ON "core"."approval_requests"
  FOR UPDATE
  USING (
    core.is_ceo_or_admin()
    OR core.is_finance_head()
    OR EXISTS (
      SELECT 1 FROM core.approval_steps s
      WHERE s.approval_request_id = approval_requests.id
        AND s.assigned_user_id = auth.uid()
    )
  )
  WITH CHECK (
    core.is_ceo_or_admin()
    OR core.is_finance_head()
    OR EXISTS (
      SELECT 1 FROM core.approval_steps s
      WHERE s.approval_request_id = approval_requests.id
        AND s.assigned_user_id = auth.uid()
    )
  );
-- No DELETE policy: approval requests are part of the audit trail and must
-- not be removable through the normal application path (spec 8: "Normal
-- users cannot update or delete audit events" -- approvals are treated the
-- same way here). Cancellation is a status transition (status='CANCELLED'
-- via UPDATE), not a row deletion.

-- -----------------------------------------------------------------------
-- core.approval_steps
-- -----------------------------------------------------------------------
CREATE POLICY "approval_steps_select" ON "core"."approval_steps"
  FOR SELECT
  USING (
    assigned_user_id = auth.uid()
    OR core.is_ceo_or_admin()
    OR core.is_finance_head()
    OR EXISTS (
      SELECT 1 FROM core.approval_requests r
      WHERE r.id = approval_steps.approval_request_id
        AND r.requested_by = auth.uid()
    )
  );

CREATE POLICY "approval_steps_insert" ON "core"."approval_steps"
  FOR INSERT
  WITH CHECK (core.is_ceo_or_admin() OR core.is_finance_head());

CREATE POLICY "approval_steps_update" ON "core"."approval_steps"
  FOR UPDATE
  USING (
    assigned_user_id = auth.uid()
    OR core.is_ceo_or_admin()
    OR core.is_finance_head()
  )
  WITH CHECK (
    assigned_user_id = auth.uid()
    OR core.is_ceo_or_admin()
    OR core.is_finance_head()
  );
-- No DELETE policy: approval steps are part of the immutable workflow trail.

-- -----------------------------------------------------------------------
-- core.approval_actions (immutable log of individual approve/reject actions)
-- -----------------------------------------------------------------------
CREATE POLICY "approval_actions_select" ON "core"."approval_actions"
  FOR SELECT
  USING (
    actor_user_id = auth.uid()
    OR core.is_ceo_or_admin()
    OR core.is_finance_head()
    OR EXISTS (
      SELECT 1 FROM core.approval_steps s
      JOIN core.approval_requests r ON r.id = s.approval_request_id
      WHERE s.id = approval_actions.approval_step_id
        AND r.requested_by = auth.uid()
    )
  );

CREATE POLICY "approval_actions_insert" ON "core"."approval_actions"
  FOR INSERT
  WITH CHECK (actor_user_id = auth.uid());
-- No UPDATE/DELETE policy by design: this is an append-only action log,
-- matching the table's own comment ("Immutable log of individual
-- approve/reject/escalate/delegate actions").

-- -----------------------------------------------------------------------
-- core.employee_links (Appendix D shared-identity integration table)
-- -----------------------------------------------------------------------
CREATE POLICY "employee_links_select" ON "core"."employee_links"
  FOR SELECT
  USING (core.is_ceo_or_admin() OR core.is_finance_head());

CREATE POLICY "employee_links_insert" ON "core"."employee_links"
  FOR INSERT
  WITH CHECK (core.is_ceo_or_admin() OR core.is_finance_head());

CREATE POLICY "employee_links_update" ON "core"."employee_links"
  FOR UPDATE
  USING (core.is_ceo_or_admin() OR core.is_finance_head())
  WITH CHECK (core.is_ceo_or_admin() OR core.is_finance_head());
-- No DELETE policy: a shared cross-module identity link should not be
-- silently removed (would orphan future HR/payroll integration events).

-- -----------------------------------------------------------------------
-- core.integration_events (Appendix D versioned cross-module event bus)
-- -----------------------------------------------------------------------
CREATE POLICY "integration_events_select" ON "core"."integration_events"
  FOR SELECT
  USING (core.is_ceo_or_admin() OR core.is_finance_head());
-- No INSERT/UPDATE/DELETE policy for `authenticated`: these events are
-- system-generated by the integration/event-bus service, which is expected
-- to run under the Supabase `service_role` key (bypasses RLS by design).
-- Normal authenticated sessions should only ever need to read them for
-- monitoring/troubleshooting.

-- -----------------------------------------------------------------------
-- finance.attendance_period_snapshots (locked payroll input snapshot)
-- -----------------------------------------------------------------------
CREATE POLICY "attendance_period_snapshots_select" ON "finance"."attendance_period_snapshots"
  FOR SELECT
  USING (core.is_ceo_or_admin() OR core.is_finance_head() OR core.has_role('ACCOUNTANT'));

CREATE POLICY "attendance_period_snapshots_insert" ON "finance"."attendance_period_snapshots"
  FOR INSERT
  WITH CHECK (core.is_ceo_or_admin() OR core.is_finance_head());
-- No UPDATE/DELETE policy by design: the table's own comment states
-- "Once locked=true, snapshot_payload must never be edited" -- default-deny
-- on UPDATE/DELETE is the correct enforcement of that rule, not a gap.

-- -----------------------------------------------------------------------
-- finance.budget_revisions
-- -----------------------------------------------------------------------
CREATE POLICY "budget_revisions_select" ON "finance"."budget_revisions"
  FOR SELECT
  USING (
    core.is_ceo_or_admin()
    OR core.is_finance_head()
    OR core.has_role('ACCOUNTANT')
    OR core.has_role('VIEWER')
    OR requested_by = auth.uid()
    OR EXISTS (
      SELECT 1 FROM public.budgets b
      WHERE b.id = budget_revisions.budget_id
        AND (b.user_id = auth.uid()
             OR EXISTS (
               SELECT 1 FROM public.projects p
               WHERE p.id = b.project_id AND p.user_id = auth.uid()
             ))
    )
  );

CREATE POLICY "budget_revisions_insert" ON "finance"."budget_revisions"
  FOR INSERT
  WITH CHECK (requested_by = auth.uid() OR core.is_finance_head() OR core.is_ceo_or_admin());

CREATE POLICY "budget_revisions_update" ON "finance"."budget_revisions"
  FOR UPDATE
  USING (core.is_ceo_or_admin() OR core.is_finance_head())
  WITH CHECK (core.is_ceo_or_admin() OR core.is_finance_head());
-- No DELETE policy: revision history must be preserved (spec 5.4:
-- "Maintain complete budget revision history and reasons").

-- -----------------------------------------------------------------------
-- finance.dimensions (departments / cost centers / business units)
-- -----------------------------------------------------------------------
-- Low-sensitivity lookup data referenced on almost every transaction form;
-- broad read access is appropriate, admin-only write.
CREATE POLICY "dimensions_select" ON "finance"."dimensions"
  FOR SELECT
  USING (auth.uid() IS NOT NULL);

CREATE POLICY "dimensions_insert" ON "finance"."dimensions"
  FOR INSERT
  WITH CHECK (core.is_ceo_or_admin() OR core.is_finance_head());

CREATE POLICY "dimensions_update" ON "finance"."dimensions"
  FOR UPDATE
  USING (core.is_ceo_or_admin() OR core.is_finance_head())
  WITH CHECK (core.is_ceo_or_admin() OR core.is_finance_head());

CREATE POLICY "dimensions_delete" ON "finance"."dimensions"
  FOR DELETE
  USING (core.is_ceo_or_admin() OR core.is_finance_head());

COMMIT;