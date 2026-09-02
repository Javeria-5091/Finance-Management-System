-- ============================================================================
-- P1_096_aud_p1_001_transfer_ceo_role.sql
--
-- AUD-P1-001 FIX: src/app/dashboard/admin/users-roles/page.tsx (executeCEOTransfer,
-- line 553) calls supabase.schema('core').rpc('transfer_ceo_role', {...}) to move
-- the CEO role from one user to another. That function does not exist anywhere in
-- schema.sql or any of the 118 prior migrations, so PostgREST rejects every call
-- with PGRST202 before any logic runs. CEO succession has never been possible
-- from the product -- the request fails at the network layer, both CEOs remain
-- unchanged, and the admin only sees a generic error toast.
--
-- This migration adds core.transfer_ceo_role(p_new_ceo_user_id, p_outgoing_role_id,
-- p_reason) as a single SECURITY DEFINER function so the whole transfer -- retiring
-- the outgoing CEO's grant, giving them their new role, granting the incoming CEO
-- the CEO role, and keeping the legacy public.profiles.role column in sync -- runs
-- as one transaction. Any failure anywhere inside it rolls back the entire
-- operation, so the organization can never be left without a CEO or with two
-- active CEOs, matching what the frontend's comment at page.tsx:535-543 already
-- assumed existed. The function independently re-verifies the caller actually
-- holds an active CEO grant in core.user_roles (never trusting the client's own
-- isCurrentUserCEO() check), that the target user is in the caller's organization,
-- and that the outgoing role is a real, non-CEO role available to that
-- organization -- then records a single audit.log_action entry for the transfer.
-- ============================================================================

CREATE OR REPLACE FUNCTION "core"."transfer_ceo_role"(
    "p_new_ceo_user_id" "uuid",
    "p_outgoing_role_id" "uuid",
    "p_reason" "text" DEFAULT NULL::"text"
) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'core', 'public', 'audit'
    AS $$
DECLARE
  v_caller_id uuid := auth.uid();
  v_org uuid;
  v_ceo_role_id uuid;
  v_old_ceo_user_role_id uuid;
  v_outgoing_role_name text;
  v_outgoing_role_org uuid;
  v_new_ceo_org uuid;
  v_result jsonb;
BEGIN
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'transfer_ceo_role: authentication required';
  END IF;

  IF p_new_ceo_user_id IS NULL THEN
    RAISE EXCEPTION 'transfer_ceo_role: p_new_ceo_user_id is required';
  END IF;

  IF p_outgoing_role_id IS NULL THEN
    RAISE EXCEPTION 'transfer_ceo_role: p_outgoing_role_id is required';
  END IF;

  IF p_new_ceo_user_id = v_caller_id THEN
    RAISE EXCEPTION 'transfer_ceo_role: cannot transfer the CEO role to yourself';
  END IF;

  v_org := core.current_user_org_id();
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'transfer_ceo_role: caller has no organization';
  END IF;

  -- Resolve the org's CEO role. Prefer an org-specific core.roles row, fall
  -- back to the global/system-seeded 'CEO' role -- same resolution order as
  -- core.admin_assign_user_role.
  SELECT id INTO v_ceo_role_id
  FROM core.roles
  WHERE name = 'CEO'
    AND (organization_id = v_org OR organization_id IS NULL)
  ORDER BY (organization_id = v_org) DESC
  LIMIT 1;

  IF v_ceo_role_id IS NULL THEN
    RAISE EXCEPTION 'transfer_ceo_role: CEO role is not configured for this organization';
  END IF;

  -- The caller must hold an active, in-effect CEO grant in core.user_roles.
  -- Deliberately does NOT fall back to public.profiles.role (same reasoning
  -- as core.admin_set_user_role) -- this is re-checked server-side and never
  -- trusts the client's own isCurrentUserCEO() logic. Locked FOR UPDATE so a
  -- concurrent transfer or role edit can't race this one.
  SELECT ur.id INTO v_old_ceo_user_role_id
  FROM core.user_roles ur
  WHERE ur.user_id = v_caller_id
    AND ur.role_id = v_ceo_role_id
    AND ur.is_active = true
    AND CURRENT_DATE >= ur.effective_from
    AND (ur.effective_to IS NULL OR ur.effective_to >= CURRENT_DATE)
  FOR UPDATE;

  IF v_old_ceo_user_role_id IS NULL THEN
    RAISE EXCEPTION 'transfer_ceo_role: only the current CEO may transfer the CEO role'
      USING ERRCODE = '42501';
  END IF;

  -- Target must be a real user in the caller's own organization.
  SELECT organization_id INTO v_new_ceo_org
  FROM public.profiles
  WHERE user_id = p_new_ceo_user_id;

  IF v_new_ceo_org IS NULL OR v_new_ceo_org <> v_org THEN
    RAISE EXCEPTION 'transfer_ceo_role: target user is not in your organization';
  END IF;

  -- Outgoing role must be a real, non-CEO role visible to this org.
  SELECT r.name, r.organization_id INTO v_outgoing_role_name, v_outgoing_role_org
  FROM core.roles r
  WHERE r.id = p_outgoing_role_id;

  IF v_outgoing_role_name IS NULL THEN
    RAISE EXCEPTION 'transfer_ceo_role: outgoing role not found';
  END IF;

  IF p_outgoing_role_id = v_ceo_role_id THEN
    RAISE EXCEPTION 'transfer_ceo_role: outgoing role cannot be CEO';
  END IF;

  IF v_outgoing_role_org IS NOT NULL AND v_outgoing_role_org <> v_org THEN
    RAISE EXCEPTION 'transfer_ceo_role: outgoing role is not available in your organization';
  END IF;

  -- Also lock whatever active role row(s) the incoming CEO currently holds,
  -- so the full transfer is serialized against concurrent role changes for
  -- both users involved.
  PERFORM 1
  FROM core.user_roles ur
  WHERE ur.user_id = p_new_ceo_user_id AND ur.is_active = true
  FOR UPDATE;

  -- 1. Retire the outgoing CEO's CEO grant.
  UPDATE core.user_roles
  SET is_active = false,
      effective_to = CURRENT_DATE
  WHERE id = v_old_ceo_user_role_id;

  -- 2. Give the outgoing CEO their new role.
  INSERT INTO core.user_roles (user_id, role_id, effective_from, is_active, created_by)
  VALUES (v_caller_id, p_outgoing_role_id, CURRENT_DATE, true, v_caller_id);

  -- 3. Deactivate whatever active role(s) the incoming CEO currently holds --
  -- one active role at a time, matching core.admin_assign_user_role.
  UPDATE core.user_roles
  SET is_active = false,
      effective_to = CURRENT_DATE
  WHERE user_id = p_new_ceo_user_id AND is_active = true;

  -- 4. Grant the incoming CEO the CEO role.
  INSERT INTO core.user_roles (user_id, role_id, effective_from, is_active, created_by)
  VALUES (p_new_ceo_user_id, v_ceo_role_id, CURRENT_DATE, true, v_caller_id);

  -- 5. Best-effort sync of the legacy public.profiles.role text column, same
  -- mechanism as core.admin_assign_user_role / core.admin_set_user_role. Only
  -- written when the value is one profiles_role_check actually allows, so an
  -- org-specific role name never trips that constraint.
  PERFORM set_config('core.profiles_guard_bypass', 'on', true);

  UPDATE public.profiles SET role = 'CEO'
  WHERE user_id = p_new_ceo_user_id AND organization_id = v_org;

  IF v_outgoing_role_name = ANY (ARRAY['CEO','FINANCE_HEAD','ACCOUNTANT','PROJECT_MANAGER','EMPLOYEE','VIEWER','Admin','AUDITOR','HOD','TECHNICAL_ADMIN']) THEN
    UPDATE public.profiles SET role = v_outgoing_role_name
    WHERE user_id = v_caller_id AND organization_id = v_org;
  END IF;

  PERFORM set_config('core.profiles_guard_bypass', 'off', true);

  -- 6. Single audit trail entry covering both sides of the transfer.
  PERFORM audit.log_action(
    p_user_id := v_caller_id,
    p_action := 'CEO_ROLE_TRANSFERRED',
    p_entity_type := 'core.user_roles',
    p_entity_id := p_new_ceo_user_id,
    p_description := 'CEO role transferred',
    p_old_values := jsonb_build_object('ceo_user_id', v_caller_id),
    p_new_values := jsonb_build_object(
      'ceo_user_id', p_new_ceo_user_id,
      'outgoing_user_id', v_caller_id,
      'outgoing_role_id', p_outgoing_role_id,
      'outgoing_role_name', v_outgoing_role_name
    ),
    p_reason := p_reason,
    p_source_module := 'admin.users_roles',
    p_status := 'success',
    p_severity := 'warning'
  );

  v_result := jsonb_build_object(
    'old_ceo_user_id', v_caller_id,
    'new_ceo_user_id', p_new_ceo_user_id,
    'outgoing_role_id', p_outgoing_role_id,
    'outgoing_role_name', v_outgoing_role_name,
    'transferred_at', now()
  );

  RETURN v_result;
END;
$$;

ALTER FUNCTION "core"."transfer_ceo_role"("p_new_ceo_user_id" "uuid", "p_outgoing_role_id" "uuid", "p_reason" "text") OWNER TO "postgres";

COMMENT ON FUNCTION "core"."transfer_ceo_role"("p_new_ceo_user_id" "uuid", "p_outgoing_role_id" "uuid", "p_reason" "text") IS 'AUD-P1-001 fix: previously did not exist, so the CEO-transfer UI at src/app/dashboard/admin/users-roles/page.tsx:553 always failed with PGRST202 (function not found) and CEO succession could not be performed from the product at all. Runs the entire transfer -- retire outgoing CEO grant, assign outgoing CEO their new role, grant incoming CEO the CEO role, sync legacy public.profiles.role, write one audit.log_action entry -- as a single SECURITY DEFINER transaction; any failure inside rolls back the whole operation, so the organization can never end up with zero or two active CEOs. Independently re-verifies the caller holds an active core.user_roles CEO grant, never trusting the client.';

REVOKE ALL ON FUNCTION "core"."transfer_ceo_role"("p_new_ceo_user_id" "uuid", "p_outgoing_role_id" "uuid", "p_reason" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "core"."transfer_ceo_role"("p_new_ceo_user_id" "uuid", "p_outgoing_role_id" "uuid", "p_reason" "text") TO "authenticated";