-- P1_090: Auth/RBAC hardening for FND-AUTH-001..004
-- Source: OSYSTIC Finance Management System Complete Implementation Specification v1.3
-- No frontend-only bypasses: DB authorization remains the source of truth.

BEGIN;

-- The admin profile endpoint/UI already expects this field and the specification
-- requires an active/inactive user status. Keep this additive and backward-safe.
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS employment_status text NOT NULL DEFAULT 'ACTIVE';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.profiles'::regclass
      AND conname = 'profiles_employment_status_check'
  ) THEN
    ALTER TABLE public.profiles
      ADD CONSTRAINT profiles_employment_status_check
      CHECK (employment_status IN ('ACTIVE','INACTIVE','TERMINATED'));
  END IF;
END $$;

-- Canonical permission resolver: role grants + explicit user ALLOW overrides,
-- with an effective DENY override always winning. This is what API routes call.
CREATE OR REPLACE FUNCTION public.get_my_permissions()
RETURNS TABLE(
  permission_code text,
  permission_name text,
  module text,
  data_scope text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, core
AS $$
  WITH role_grants AS (
    SELECT p.code, p.name, p.module, rp.data_scope,
           10 AS priority, rp.effective_from
    FROM core.user_roles ur
    JOIN core.role_permissions rp ON rp.role_id = ur.role_id
    JOIN core.permissions p ON p.id = rp.permission_id
    WHERE ur.user_id = auth.uid()
      AND ur.is_active = true
      AND CURRENT_DATE >= ur.effective_from
      AND (ur.effective_to IS NULL OR ur.effective_to >= CURRENT_DATE)
      AND CURRENT_DATE >= rp.effective_from
      AND (rp.effective_to IS NULL OR rp.effective_to >= CURRENT_DATE)
  ),
  allow_overrides AS (
    SELECT p.code, p.name, p.module, upo.data_scope,
           20 AS priority, upo.effective_from
    FROM core.user_permission_overrides upo
    JOIN core.permissions p ON p.id = upo.permission_id
    JOIN public.profiles pr ON pr.user_id = upo.user_id
    WHERE upo.user_id = auth.uid()
      AND upo.override_type = 'ALLOW'
      AND CURRENT_DATE >= upo.effective_from
      AND (upo.effective_to IS NULL OR upo.effective_to >= CURRENT_DATE)
      AND pr.organization_id = core.current_user_org_id()
  ),
  effective AS (
    SELECT DISTINCT ON (code)
      code, name, module, data_scope
    FROM (
      SELECT * FROM role_grants
      UNION ALL
      SELECT * FROM allow_overrides
    ) grants
    WHERE NOT EXISTS (
      SELECT 1
      FROM core.user_permission_overrides deny
      JOIN core.permissions dp ON dp.id = deny.permission_id
      WHERE deny.user_id = auth.uid()
        AND deny.override_type = 'DENY'
        AND dp.code = grants.code
        AND CURRENT_DATE >= deny.effective_from
        AND (deny.effective_to IS NULL OR deny.effective_to >= CURRENT_DATE)
    )
    ORDER BY code, priority DESC, effective_from DESC
  )
  SELECT code AS permission_code, name AS permission_name, module, data_scope
  FROM effective
  ORDER BY module, code;
$$;

-- Keep DB-side permission checks consistent with the same override semantics.
CREATE OR REPLACE FUNCTION core.has_permission(p_user_id uuid, p_permission_code text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, core, public
AS $$
  SELECT
    NOT EXISTS (
      SELECT 1
      FROM core.user_permission_overrides upo
      JOIN core.permissions p ON p.id = upo.permission_id
      WHERE upo.user_id = p_user_id
        AND p.code = p_permission_code
        AND upo.override_type = 'DENY'
        AND CURRENT_DATE >= upo.effective_from
        AND (upo.effective_to IS NULL OR upo.effective_to >= CURRENT_DATE)
    )
    AND (
      EXISTS (
        SELECT 1
        FROM core.user_roles ur
        JOIN core.role_permissions rp ON rp.role_id = ur.role_id
        JOIN core.permissions p ON p.id = rp.permission_id
        WHERE ur.user_id = p_user_id
          AND p.code = p_permission_code
          AND ur.is_active = true
          AND CURRENT_DATE >= ur.effective_from
          AND (ur.effective_to IS NULL OR ur.effective_to >= CURRENT_DATE)
          AND CURRENT_DATE >= rp.effective_from
          AND (rp.effective_to IS NULL OR rp.effective_to >= CURRENT_DATE)
      )
      OR EXISTS (
        SELECT 1
        FROM core.user_permission_overrides upo
        JOIN core.permissions p ON p.id = upo.permission_id
        JOIN public.profiles pr ON pr.user_id = upo.user_id
        WHERE upo.user_id = p_user_id
          AND p.code = p_permission_code
          AND upo.override_type = 'ALLOW'
          AND CURRENT_DATE >= upo.effective_from
          AND (upo.effective_to IS NULL OR upo.effective_to >= CURRENT_DATE)
          AND pr.organization_id = core.current_user_org_id()
      )
    );
$$;

-- Canonical admin user listing. The caller must have ADMIN_USERS and all returned
-- profiles are constrained to the caller's organization.
CREATE OR REPLACE FUNCTION core.admin_list_users()
RETURNS TABLE(
  user_id uuid,
  email text,
  full_name text,
  profile_role text,
  department_id uuid,
  department_name text,
  manager_id uuid,
  manager_name text,
  employment_status text,
  has_profile boolean
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, core, finance
AS $$
DECLARE
  v_org uuid := core.current_user_org_id();
BEGIN
  IF v_org IS NULL OR NOT core.has_permission(auth.uid(), 'ADMIN_USERS') THEN
    RAISE EXCEPTION 'Access denied: ADMIN_USERS permission required';
  END IF;

  RETURN QUERY
  SELECT
    u.id,
    u.email::text,
    COALESCE(p.full_name, '')::text,
    p.role,
    p.department_id,
    d.name,
    p.manager_id,
    m.full_name,
    COALESCE(p.employment_status, 'ACTIVE'),
    (p.id IS NOT NULL)
  FROM auth.users u
  JOIN public.profiles p ON p.user_id = u.id
  LEFT JOIN finance.dimensions d
    ON d.id = p.department_id
   AND d.organization_id = v_org
   AND d.type = 'DEPARTMENT'
  LEFT JOIN public.profiles m
    ON m.user_id = p.manager_id
   AND m.organization_id = v_org
  WHERE p.organization_id = v_org
  ORDER BY COALESCE(p.full_name, u.email);
END;
$$;

-- Secure admin profile update: target user, manager and department must all
-- belong to the same organization; self-manager is rejected.
CREATE OR REPLACE FUNCTION core.admin_update_user_profile(
  p_user_id uuid,
  p_department_id uuid DEFAULT NULL,
  p_manager_id uuid DEFAULT NULL,
  p_employment_status text DEFAULT NULL,
  p_clear_department boolean DEFAULT false,
  p_clear_manager boolean DEFAULT false
)
RETURNS public.profiles
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, core, finance, audit
AS $$
DECLARE
  v_org uuid := core.current_user_org_id();
  v_target public.profiles;
  v_status text;
BEGIN
  IF v_org IS NULL OR NOT core.has_permission(auth.uid(), 'ADMIN_USERS') THEN
    RAISE EXCEPTION 'Access denied: ADMIN_USERS permission required';
  END IF;

  SELECT * INTO v_target
  FROM public.profiles
  WHERE user_id = p_user_id
    AND organization_id = v_org
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Target user is not in the current organization';
  END IF;

  IF p_manager_id IS NOT NULL AND p_manager_id = p_user_id THEN
    RAISE EXCEPTION 'A user cannot be their own manager';
  END IF;

  IF p_department_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM finance.dimensions d
    WHERE d.id = p_department_id
      AND d.organization_id = v_org
      AND d.type = 'DEPARTMENT'
      AND d.is_active = true
  ) THEN
    RAISE EXCEPTION 'Department is not active or does not belong to the organization';
  END IF;

  IF p_manager_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.profiles m
    WHERE m.user_id = p_manager_id
      AND m.organization_id = v_org
  ) THEN
    RAISE EXCEPTION 'Manager is not in the current organization';
  END IF;

  v_status := COALESCE(p_employment_status, v_target.employment_status, 'ACTIVE');
  IF v_status NOT IN ('ACTIVE','INACTIVE','TERMINATED') THEN
    RAISE EXCEPTION 'employment_status must be ACTIVE, INACTIVE, or TERMINATED';
  END IF;

  UPDATE public.profiles
  SET department_id = CASE WHEN p_clear_department THEN NULL ELSE COALESCE(p_department_id, department_id) END,
      manager_id = CASE WHEN p_clear_manager THEN NULL ELSE COALESCE(p_manager_id, manager_id) END,
      employment_status = v_status
  WHERE user_id = p_user_id
    AND organization_id = v_org
  RETURNING * INTO v_target;

  PERFORM audit.log_action(
    p_user_id := auth.uid(),
    p_action := 'ADMIN_USER_PROFILE_UPDATED',
    p_entity_type := 'public.profiles',
    p_entity_id := v_target.id,
    p_description := 'Admin updated user department, manager, or employment status',
    p_old_values := jsonb_build_object(
      'department_id', CASE WHEN p_clear_department THEN v_target.department_id ELSE NULL END,
      'manager_id', CASE WHEN p_clear_manager THEN v_target.manager_id ELSE NULL END
    ),
    p_new_values := jsonb_build_object(
      'department_id', v_target.department_id,
      'manager_id', v_target.manager_id,
      'employment_status', v_target.employment_status
    ),
    p_source_module := 'admin.user_profile',
    p_status := 'success',
    p_severity := 'medium'
  );

  RETURN v_target;
END;
$$;

-- Approval-limit vocabulary must match both the admin API and workflow.
ALTER TABLE core.approval_limits
  DROP CONSTRAINT IF EXISTS approval_limits_transaction_type_chk;
ALTER TABLE core.approval_limits
  ADD CONSTRAINT approval_limits_transaction_type_chk CHECK (
    transaction_type = ANY (ARRAY[
      'EXPENSE','INCOME','INVOICE','PURCHASE','VENDOR_PAYMENT','VENDOR_BILL',
      'BUDGET_REVISION','JOURNAL_ENTRY','BANK_TRANSFER','SALARY_PAYROLL',
      'OWNER_DISTRIBUTION','PERIOD_REOPEN','INVOICE_CREDIT_NOTE','RESERVE_ALLOCATION'
    ])
  );

GRANT EXECUTE ON FUNCTION public.get_my_permissions() TO authenticated;
GRANT EXECUTE ON FUNCTION core.has_permission(uuid,text) TO authenticated;
GRANT EXECUTE ON FUNCTION core.admin_list_users() TO authenticated;
GRANT EXECUTE ON FUNCTION core.admin_update_user_profile(uuid,uuid,uuid,text,boolean,boolean) TO authenticated;

COMMIT;
