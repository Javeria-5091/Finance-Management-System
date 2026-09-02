-- ============================================================================
-- P1_096_delegations_runtime_enforcement.sql
--
-- AUD-P1-008 FIX: core.delegations (schema.sql:11421) has a full schema, RLS
-- (21368+) and admin CRUD (/api/admin/delegations + settings/delegations
-- page), but was never consulted by either permission-resolution entry
-- point:
--   - core.has_permission()      (schema.sql:1269)  — used directly inside
--     ~15 RLS policies across the schema, and by core.can_approve_amount()
--     and core.has_permission_with_limit()'s base-permission check.
--   - public.get_my_permissions() (schema.sql:9153) — the RPC every request
--     actually goes through: src/lib/api-auth.ts requirePermission() and
--     src/context/PermissionContext.tsx both call it directly, so this is
--     what api-auth.ts and the UI's hasPermission() ultimately check.
--
-- A delegation therefore stored and audited a grant it never enforced: an
-- admin could delegate APPROVE_INVOICE from A to B and B would still be
-- denied. This patch makes both resolvers treat an ACTIVE, currently-
-- in-window delegation as an additional source of grant, on top of role
-- assignments and per-user overrides, while leaving every existing grant
-- path byte-for-byte the same (strict additive OR-branch / UNION ALL —
-- no existing row, priority, or ordering is touched).
--
-- Rules preserved / added:
--   1. An explicit per-user DENY override for the delegate still wins over
--      everything, including an active delegation (checked exactly like it
--      already is for role grants and ALLOW overrides).
--   2. Only delegations with status = 'ACTIVE' AND CURRENT_DATE within
--      [effective_from, effective_to] count — revoked/expired/future rows
--      are inert, same as the admin UI already assumes. The date check is
--      kept even though status is checked too, because nothing in this
--      codebase currently flips status to 'EXPIRED' automatically.
--   3. A delegation is scoped to the delegate's current organization
--      (core.current_user_org_id()), mirroring the same tenant-isolation
--      pattern already used for user_permission_overrides ALLOW rows in
--      both functions being patched here.
--   4. get_my_permissions() needs a data_scope for each delegated
--      permission, which core.delegations does not store (it delegates a
--      specific permission_ids array, not a role_permissions row). We use
--      the delegator's (from_user_id) own current effective scope for that
--      permission via core.get_data_scope(), falling back to the most
--      conservative scope ('OWN') if the delegator no longer holds it
--      directly — this models "B can act with A's coverage", not "B gets
--      unlimited access", and never grants more than a same-org ALLOW
--      override already could. Delegated grants are placed at priority 15
--      (between role grants=10 and explicit ALLOW overrides=20), so an
--      admin's explicit per-user override always has the final say, and a
--      delegation only supplements — never downgrades — a permission the
--      delegate already holds via role.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. core.has_permission(p_user_id, p_permission_code)
--    Adds a third OR-branch: an ACTIVE, in-window, same-org delegation to
--    p_user_id that includes this permission. Untouched: the leading DENY
--    NOT EXISTS gate, the role-grant EXISTS branch, and the ALLOW-override
--    EXISTS branch.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION "core"."has_permission"("p_user_id" "uuid", "p_permission_code" "text") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'core', 'public'
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
      -- AUD-P1-008: an active, in-window delegation grants the same as a
      -- per-user ALLOW override would.
      OR EXISTS (
        SELECT 1
        FROM core.delegations d
        JOIN core.permissions p ON p.id = ANY(d.permission_ids)
        WHERE d.to_user_id = p_user_id
          AND p.code = p_permission_code
          AND d.status = 'ACTIVE'
          AND CURRENT_DATE >= d.effective_from
          AND CURRENT_DATE <= d.effective_to
          AND d.organization_id = core.current_user_org_id()
      )
    );
$$;


ALTER FUNCTION "core"."has_permission"("p_user_id" "uuid", "p_permission_code" "text") OWNER TO "postgres";


COMMENT ON FUNCTION "core"."has_permission"("p_user_id" "uuid", "p_permission_code" "text") IS 'AUD-P1-008 fix: now also grants when an ACTIVE, in-window, same-org core.delegations row hands p_permission_code to p_user_id, in addition to role assignments and per-user ALLOW overrides. A per-user DENY override still wins over all three.';


-- ---------------------------------------------------------------------------
-- 2. public.get_my_permissions()
--    Adds a delegated_grants CTE (mirrors allow_overrides' shape) and unions
--    it into the same "grants" set that role_grants/allow_overrides already
--    feed into, so the existing DENY-override NOT EXISTS filter and the
--    DISTINCT ON (code) / priority-ordering logic apply to it unchanged.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION "public"."get_my_permissions"() RETURNS TABLE("permission_code" "text", "permission_name" "text", "module" "text", "data_scope" "text")
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'public', 'core'
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
  -- AUD-P1-008: permissions handed to auth.uid() via an ACTIVE, in-window,
  -- same-org delegation. data_scope is not stored on core.delegations (it
  -- delegates specific permission_ids, not a role_permissions row), so we
  -- inherit the delegator's own current effective scope for that permission,
  -- falling back to the most conservative scope ('OWN') if the delegator no
  -- longer holds it directly.
  delegated_grants AS (
    SELECT p.code, p.name, p.module,
           COALESCE(NULLIF(core.get_data_scope(d.from_user_id, p.code), 'NONE'), 'OWN') AS data_scope,
           15 AS priority, d.effective_from
    FROM core.delegations d
    JOIN core.permissions p ON p.id = ANY(d.permission_ids)
    WHERE d.to_user_id = auth.uid()
      AND d.status = 'ACTIVE'
      AND CURRENT_DATE >= d.effective_from
      AND CURRENT_DATE <= d.effective_to
      AND d.organization_id = core.current_user_org_id()
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
      SELECT * FROM delegated_grants
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


ALTER FUNCTION "public"."get_my_permissions"() OWNER TO "postgres";


COMMENT ON FUNCTION "public"."get_my_permissions"() IS 'AUD-P1-008 fix: now also returns permissions granted via an ACTIVE, in-window, same-org core.delegations row (delegated_grants CTE), subject to the same per-user DENY override as role grants and ALLOW overrides. This is the RPC src/lib/api-auth.ts requirePermission() and src/context/PermissionContext.tsx both call, so this closes the gap end-to-end for both API routes and the UI.';
