-- =============================================================================
-- Migration: P2_038_hod_department_approval_inbox.sql
-- Fixes:     DEF-01 (submitted expense not visible to HOD)
--            DEF-02 (approvals inbox missing)  -- DB half; page is in src/app/dashboard/approvals
--            DEF-03 (approve / reject / escalate chain blocked as a result)
--
-- Spec reference: Implementation Spec v1.3
--   7.1  HOD data scope = "Assigned department"; rights = "approve within limit"
--   7.3  Expense approval limits are configurable; amounts above the approver's
--        limit escalate to the next level
--   12.1 Expense workflow: submit -> verifier -> amount-based approver
--
-- ROOT CAUSES (all confirmed in code):
--   1. expenses_select_org_scoped had no HOD condition, so a HOD could never
--      read another user's expense (and the workflow API, which runs on the
--      caller's RLS client, could not even load the record).
--   2. expenses_update_org_scoped only allowed the owner or CEO/FINANCE_HEAD,
--      so even a visible expense could not be approved/rejected by a HOD.
--   3. reporting.pending_approvals_list() is CEO/FINANCE_HEAD only and there
--      was no inbox function for HOD.
--
-- DESIGN NOTES
--   * "In the HOD's scope" = the expense owner is in the HOD's department
--     (profiles.department_id) OR reports directly to the HOD
--     (profiles.manager_id).  Drafts of other people are never visible.
--   * public.profiles is RLS-restricted (own row / admin), so the scope check
--     is a SECURITY DEFINER helper; a plain subquery inside a policy would
--     silently return nothing.
--   * The HOD may only touch SUBMITTED/VERIFIED rows and may only move them to
--     VERIFIED/APPROVED/REJECTED.  Amount/title/etc. are already frozen after
--     DRAFT by trg_expenses_immutable_after_draft (P2_037).
--   * Approval LIMITS are not touched: /api/finance/workflow still calls
--     core.can_approve_amount().  Above-limit requests stay in the inbox of the
--     next role (Finance Head / CEO) = escalation.
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 0. Permissions the HOD needs for the approval flow (idempotent).
--    Seed/migrations granted EXPENSE_APPROVE only to CEO / FINANCE_HEAD /
--    ACCOUNTANT (P1_100) and gave HOD no expense permission at all, so even
--    with RLS fixed /api/finance/workflow answered 403 for a HOD.
--      EXPENSE_READ    - see expenses (RLS narrows this to the department)
--      EXPENSE_APPROVE - approve (monetary limit still checked separately by
--                        core.can_approve_amount / core.approval_limits)
--      EXPENSE_UPDATE  - required by the workflow "reject" transition; the
--                        RLS policy above only lets a HOD change the status of
--                        in-scope SUBMITTED/VERIFIED rows, and the EXP-02
--                        trigger freezes amount/title/etc.
--    NOTE: no approval LIMIT is invented here. Limits are configuration
--    (Settings > Approval Limits, core.approval_limits, spec 7.3).
-- ---------------------------------------------------------------------------
INSERT INTO core.role_permissions (role_id, permission_id, data_scope, amount_limit)
SELECT r.id, p.id, 'DEPARTMENT', NULL
FROM core.roles r
CROSS JOIN core.permissions p
WHERE r.name = 'HOD'
  AND p.code IN ('EXPENSE_READ', 'EXPENSE_APPROVE', 'EXPENSE_UPDATE')
ON CONFLICT (role_id, permission_id, effective_from) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 1. Scope helper: is the calling user a HOD responsible for p_target_user_id?
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION core.is_hod_for_user(p_target_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'core', 'public'
AS $$
  SELECT core.has_role('HOD')
     AND p_target_user_id IS NOT NULL
     AND p_target_user_id <> auth.uid()
     AND EXISTS (
       SELECT 1
       FROM public.profiles me
       JOIN public.profiles emp
         ON emp.organization_id = me.organization_id
       WHERE me.user_id  = auth.uid()
         AND emp.user_id = p_target_user_id
         AND me.organization_id IS NOT NULL
         AND (
              (me.department_id IS NOT NULL AND emp.department_id = me.department_id)
           OR  emp.manager_id = me.user_id
         )
     );
$$;

REVOKE ALL ON FUNCTION core.is_hod_for_user(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.is_hod_for_user(uuid) TO authenticated;

COMMENT ON FUNCTION core.is_hod_for_user(uuid) IS
  'DEF-01: true when the caller holds the HOD role and p_target_user_id is in the caller''s department or reports directly to the caller (same organization).';

-- ---------------------------------------------------------------------------
-- 2. expenses SELECT: original rule + HOD department scope (non-draft only)
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "expenses_select_org_scoped" ON "public"."expenses";
CREATE POLICY "expenses_select_org_scoped" ON "public"."expenses"
  FOR SELECT TO "authenticated"
  USING (
    "core"."same_org"("organization_id")
    AND (
         "core"."is_finance_head"()
      OR "core"."has_role"('ACCOUNTANT'::"text")
      OR "core"."has_role"('VIEWER'::"text")
      OR ("user_id" = "auth"."uid"())
      OR (
           ("project_id" IS NOT NULL)
           AND EXISTS (
             SELECT 1 FROM "public"."projects" "p"
             WHERE "p"."id" = "expenses"."project_id"
               AND "p"."user_id" = "auth"."uid"()
           )
         )
      -- DEF-01: HOD sees non-draft expenses of people in their scope
      OR ("core"."is_hod_for_user"("user_id") AND "status" <> 'DRAFT')
    )
  );

-- ---------------------------------------------------------------------------
-- 3. expenses UPDATE: original rule + HOD may move in-scope SUBMITTED/VERIFIED
--    rows to VERIFIED / APPROVED / REJECTED (status transition only; value
--    fields are frozen by trg_expenses_immutable_after_draft).
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "expenses_update_org_scoped" ON "public"."expenses";
CREATE POLICY "expenses_update_org_scoped" ON "public"."expenses"
  FOR UPDATE TO "authenticated"
  USING (
    "core"."same_org"("organization_id")
    AND "journal_entry_id" IS NULL
    AND (
         ("auth"."uid"() = "user_id")
      OR "public"."is_admin"()
      OR ("core"."is_hod_for_user"("user_id") AND "status" IN ('SUBMITTED', 'VERIFIED'))
    )
  )
  WITH CHECK (
    "core"."same_org"("organization_id")
    AND "journal_entry_id" IS NULL
    AND (
         ("auth"."uid"() = "user_id")
      OR "public"."is_admin"()
      OR ("core"."is_hod_for_user"("user_id") AND "status" IN ('VERIFIED', 'APPROVED', 'REJECTED'))
    )
  );

-- ---------------------------------------------------------------------------
-- 4. Approvals inbox for the current user
--    SECURITY DEFINER (needs requester names, which profiles RLS hides from a
--    HOD), therefore the scope is enforced explicitly below.
--    Scope:  CEO / FINANCE_HEAD -> whole organization
--            HOD                -> own department / direct reports
--            everyone else      -> nothing
--    can_approve tells the UI whether the caller may act on the row now
--    (maker-checker + monetary limit).  false + not own = "escalated".
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION reporting.my_pending_approvals()
RETURNS json
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'reporting', 'core', 'public'
AS $$
DECLARE
  v_org uuid;
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  v_org := core.current_user_org_id();
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'Access denied: no organization';
  END IF;

  IF NOT (core.has_role('CEO') OR core.has_permission(v_uid, 'EXPENSE_APPROVE')) THEN
    RETURN '[]'::json;
  END IF;

  RETURN COALESCE((
    SELECT json_agg(row_to_json(t) ORDER BY t.submitted_at NULLS LAST, t.created_at)
    FROM (
      SELECT
        e.id,
        'EXPENSE'::text                       AS module_type,
        e.title,
        e.amount,
        COALESCE(e.currency, 'PKR')           AS currency,
        e.status,
        e.expense_date,
        e.created_at,
        e.submitted_at,
        e.user_id                             AS requester_id,
        COALESCE(NULLIF(p.full_name, ''), p.email, 'Unknown') AS requester_name,
        (e.user_id = v_uid)                   AS is_own,
        (
          e.user_id <> v_uid
          AND (
                core.has_role('CEO')
             OR core.can_approve_amount(v_uid, 'EXPENSE_APPROVE', 'EXPENSE', e.amount, COALESCE(e.currency, 'PKR'))
          )
        )                                     AS can_approve
      FROM public.expenses e
      LEFT JOIN public.profiles p ON p.user_id = e.user_id
      WHERE e.organization_id = v_org
        AND e.status IN ('SUBMITTED', 'VERIFIED')
        AND (
              core.is_finance_head()
           OR core.is_hod_for_user(e.user_id)
        )
    ) t
  ), '[]'::json);
END;
$$;

REVOKE ALL ON FUNCTION reporting.my_pending_approvals() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION reporting.my_pending_approvals() TO authenticated;

COMMENT ON FUNCTION reporting.my_pending_approvals() IS
  'DEF-02: approvals inbox. CEO/FINANCE_HEAD see the whole organization, HOD sees own department/direct reports, others get an empty list. can_approve reflects maker-checker and the configured monetary limit.';

COMMIT;