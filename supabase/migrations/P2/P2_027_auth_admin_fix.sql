-- =====================================================================
-- Finance Management System — Critical Fix
--   AUTH-01 (P1): Admin "invite" is broken three independent ways; no
--   auth account is ever created.
--
-- The three independent breakages, confirmed against this checkout:
--
--   1. No auth account is ever created. src/app/api/admin/users/route.ts
--      (POST, action === 'invite') never calls Supabase's admin auth API
--      at all — it goes straight to inserting a public.profiles row.
--      There is no credential, no auth.users row, no way for the
--      invited person to ever sign in.
--
--   2. public.profiles.user_id is NOT NULL with a FOREIGN KEY to
--      auth.users(id) ON DELETE CASCADE. The invite handler's INSERT
--      into profiles never sets user_id at all — so even ignoring bug
--      #1, this INSERT fails outright with a NOT NULL violation (23502)
--      every single time; a profile literally cannot exist without a
--      real, already-created auth user.
--
--   3. core.user_roles requires role_id (uuid NOT NULL, FK to
--      core.roles(id)) — there is no "role" text column on this table
--      at all. There is also no "organization_id" or "assigned_by"
--      column on core.user_roles. The handler's insert
--      ({ user_id: profile.id, role, assigned_by, organization_id, ... })
--      references four things that don't exist on this table (role,
--      assigned_by, organization_id as columns, and profile.id as a
--      valid user_roles.user_id) and would fail outright even if bug
--      #2 didn't already stop it first. Separately, user_roles.user_id
--      has its own FK to auth.users(id) — profile.id (the profiles
--      table's own surrogate PK) is never a valid auth.users id, so
--      even a column-name-corrected version of this insert would still
--      fail on that FK.
--
-- A fourth, related defect found while fixing this (not separately
-- ticketed, but this ticket cannot be fully closed without it): the
-- only RLS policy that allows writing to core.user_roles,
-- "ur_manage_org_scoped", requires
-- `core.same_org(r.organization_id)` to be true for the role being
-- granted -- and core.same_org() is deliberately written to return
-- FALSE whenever its argument is NULL (see its own COMMENT). Every
-- canonical role in core.roles was seeded with organization_id = NULL
-- (system-wide roles -- see
-- supabase/migrations/P0/phase_3_permissions/011b_force_seed_roles.sql
-- and P1_018_rbac_consistency_fixes.sql). That means a plain,
-- request-scoped INSERT into core.user_roles referencing any of those
-- roles can NEVER satisfy this policy's WITH CHECK, for any
-- organization -- role assignment through ordinary RLS-bound writes is
-- structurally impossible today, independent of the column-naming bugs
-- above.
--
-- Fix: this migration adds a single SECURITY DEFINER RPC,
-- core.admin_assign_user_role(), that performs its own permission and
-- org-membership checks in code (ADMIN_USERS permission, target user in
-- caller's own org) and then writes core.user_roles directly, bypassing
-- the table's RLS the same sanctioned way core.admin_set_user_role()
-- and the various finance *_atomic RPCs already do in this codebase.
-- It resolves role_id by name, preferring an org-specific core.roles
-- row and falling back to the global/system-seeded one, and keeps the
-- legacy public.profiles.role text column in sync (using the existing
-- core.profiles_guard_bypass mechanism, exactly like
-- core.admin_set_user_role() does) since some legacy code paths still
-- read that column as a fallback.
--
-- src/app/api/admin/users/route.ts is updated separately (same PR) to:
--   * actually call supabase.auth.admin.inviteUserByEmail() (via a
--     service-role client, the same pattern already used in
--     src/app/api/health/route.ts) before ever touching profiles,
--   * insert profiles with the real auth user's id in user_id,
--   * roll back (delete) the just-created auth user if the profile
--     insert fails, so a partial invite never leaves an orphaned auth
--     account with no profile,
--   * call core.admin_assign_user_role() instead of a raw
--     core.user_roles insert, for both the "invite" and "assign_role"
--     actions.
-- =====================================================================

BEGIN;

CREATE OR REPLACE FUNCTION "core"."admin_assign_user_role"(
  "p_user_id" "uuid",
  "p_organization_id" "uuid",
  "p_role_name" "text",
  "p_effective_from" "date" DEFAULT CURRENT_DATE,
  "p_effective_to" "date" DEFAULT NULL
) RETURNS "core"."user_roles"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'core', 'public'
    AS $$
DECLARE
  v_role_id uuid;
  v_result core.user_roles;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF NOT core.has_permission(auth.uid(), 'ADMIN_USERS') THEN
    RAISE EXCEPTION 'Insufficient privileges to assign roles' USING ERRCODE = '42501';
  END IF;

  IF NOT core.same_org(p_organization_id) THEN
    RAISE EXCEPTION 'Cannot assign roles outside your organization';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE user_id = p_user_id AND organization_id = p_organization_id
  ) THEN
    RAISE EXCEPTION 'Target user not found in your organization';
  END IF;

  -- AUTH-01 FIX: prefer an org-specific core.roles row; fall back to the
  -- global/system-seeded role of the same name. core.same_org() treats
  -- a NULL organization_id as "no match" by design, so ur_manage_org_scoped
  -- can never be satisfied by a plain client-side insert referencing one
  -- of the system-seeded (organization_id IS NULL) roles -- this
  -- SECURITY DEFINER function is the sanctioned way around that, the
  -- same way core.admin_set_user_role() already bypasses RLS for
  -- profile.role changes.
  SELECT id INTO v_role_id
  FROM core.roles
  WHERE name = p_role_name
    AND (organization_id = p_organization_id OR organization_id IS NULL)
  ORDER BY (organization_id = p_organization_id) DESC
  LIMIT 1;

  IF v_role_id IS NULL THEN
    RAISE EXCEPTION 'Role % is not configured', p_role_name;
  END IF;

  -- One active role at a time, matching the existing application intent
  -- (the previous, broken assign_role handler deactivated old roles
  -- before inserting the new one).
  UPDATE core.user_roles
  SET is_active = false,
      effective_to = LEAST(COALESCE(effective_to, CURRENT_DATE), CURRENT_DATE)
  WHERE user_id = p_user_id AND is_active = true;

  INSERT INTO core.user_roles (user_id, role_id, effective_from, effective_to, is_active, created_by)
  VALUES (p_user_id, v_role_id, COALESCE(p_effective_from, CURRENT_DATE), p_effective_to, true, auth.uid())
  RETURNING * INTO v_result;

  -- Keep the legacy profiles.role text column in sync -- some code paths
  -- (see migration 018's comment on core.has_role()) still fall back to
  -- it for users not fully migrated to core.user_roles.
  PERFORM set_config('core.profiles_guard_bypass', 'on', true);
  UPDATE public.profiles SET role = p_role_name
  WHERE user_id = p_user_id AND organization_id = p_organization_id;
  PERFORM set_config('core.profiles_guard_bypass', 'off', true);

  RETURN v_result;
END;
$$;

ALTER FUNCTION "core"."admin_assign_user_role"("p_user_id" "uuid", "p_organization_id" "uuid", "p_role_name" "text", "p_effective_from" "date", "p_effective_to" "date") OWNER TO "postgres";

COMMENT ON FUNCTION "core"."admin_assign_user_role"("p_user_id" "uuid", "p_organization_id" "uuid", "p_role_name" "text", "p_effective_from" "date", "p_effective_to" "date") IS
  'AUTH-01 FIX (P1): SECURITY DEFINER replacement for the raw '
  'core.user_roles inserts in src/app/api/admin/users/route.ts, which '
  'referenced nonexistent columns (role, assigned_by, organization_id), '
  'used profiles.id instead of the real auth.users id for user_id (that '
  'column has its own FK to auth.users), and could never satisfy '
  'ur_manage_org_scoped''s RLS check for any of the system-seeded '
  '(organization_id IS NULL) roles because core.same_org() treats NULL '
  'as no-match by design. This function does its own permission/org '
  'checks, resolves role_id by name (org-specific row preferred, global '
  'fallback), writes core.user_roles directly, and keeps the legacy '
  'profiles.role text column in sync via the existing '
  'core.profiles_guard_bypass mechanism.';

GRANT ALL ON FUNCTION "core"."admin_assign_user_role"("p_user_id" "uuid", "p_organization_id" "uuid", "p_role_name" "text", "p_effective_from" "date", "p_effective_to" "date") TO "authenticated";

COMMIT;