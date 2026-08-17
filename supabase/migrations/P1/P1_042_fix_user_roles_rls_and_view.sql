-- 042_fix_user_roles_rls_and_view.sql
-- Fixes: core.user_roles.ur_select had no organization scoping (any
-- authenticated user could read every org's role assignments), and
-- public.user_roles view lacked security_invoker while being granted
-- to anon, bypassing even that weak check entirely.

BEGIN;

-- ur_manage already correctly gates on core.has_permission(...); leave as-is.
-- ur_select is the broken one -- replace it.
DROP POLICY IF EXISTS "ur_select" ON core.user_roles;

CREATE POLICY "ur_select" ON core.user_roles
  FOR SELECT
  USING (
    -- Users can always see their own role assignments...
    user_id = auth.uid()
    OR
    -- ...and users with ADMIN_USERS permission can see assignments for
    -- users in their own organization only (never cross-org).
    (
      core.has_permission(auth.uid(), 'ADMIN_USERS')
      AND EXISTS (
        SELECT 1
        FROM public.profiles p
        WHERE p.user_id = core.user_roles.user_id
          AND core.same_org(p.organization_id)
      )
    )
  );

COMMENT ON POLICY "ur_select" ON core.user_roles IS
  'Fixed migration 032 (Compliance Audit Critical R1): previously USING (auth.uid() IS NOT NULL) with no org check, exposing all organizations'' role assignments to any authenticated user.';

-- Fix the view: it was defined without security_invoker, so it executed
-- as the view owner (postgres) regardless of the querying user's RLS
-- entitlement, and was additionally GRANTed to anon.
CREATE OR REPLACE VIEW public.user_roles
WITH (security_invoker = true) AS
 SELECT id,
    user_id,
    role_id,
    effective_from,
    effective_to,
    delegated_from,
    is_active,
    created_at,
    updated_at,
    created_by
   FROM core.user_roles;

-- Anonymous (unauthenticated) users should never see role assignment data.
REVOKE ALL ON TABLE public.user_roles FROM anon;
-- authenticated retains access, now correctly gated by the fixed RLS
-- policy on the underlying core.user_roles table via security_invoker.
GRANT SELECT ON TABLE public.user_roles TO authenticated;
GRANT ALL ON TABLE public.user_roles TO service_role;

COMMENT ON VIEW public.user_roles IS
  'Fixed migration 032 (Compliance Audit Critical R1): added security_invoker so the underlying core.user_roles RLS policy is actually enforced for the querying user, and revoked anon access.';

COMMIT;