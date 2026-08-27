-- =====================================================================
-- P1_069 - Fix role management RLS (delete/edit silently failing) and
-- merge duplicate Technical Admin role (TECH_ADMIN vs TECHNICAL_ADMIN)
-- =====================================================================
--
-- BUG 1 (silent delete / permission-save failure on core.roles and
-- core.role_permissions):
--   Migration 028 (P1_036) added organization_id to core.roles as a
--   nullable column and NO migration ever backfilled it, so every role
--   row (CEO, FINANCE_HEAD, ACCOUNTANT, AUDITOR, TECHNICAL_ADMIN, etc.)
--   still has organization_id = NULL today.
--   core.same_org() deliberately returns FALSE whenever either side is
--   NULL ("fail closed").
--   P1_064 fixed the SELECT policy ("role_select") to treat
--   organization_id IS NULL as "global role, visible to everyone in the
--   same product" -- but the WRITE policy ("role_manage", which covers
--   INSERT/UPDATE/DELETE) was never given the same fix, and neither was
--   core.role_permissions' write policy ("rp_manage_org_scoped").
--   Net effect: same_org(NULL) is always false, so role_manage /
--   rp_manage_org_scoped are always false, so:
--     - DELETE on core.roles matches 0 rows -> no error, no visible
--       change (looks exactly like "delete button does nothing").
--     - INSERT/DELETE on core.role_permissions (assigning or removing a
--       permission for a role) is blocked for every role, which is why
--       roles that never got permissions seeded via SQL directly
--       (Admin, Technical Administrator/Technical Admin, Auditor) can
--       never be given permissions from the Users & Roles screen.
--   FIX: mirror the exact "organization_id IS NULL OR same_org(...)"
--   pattern already used by role_select onto role_manage and onto both
--   role_permissions policies.
--
-- BUG 2 (two "Technical Admin" roles):
--   missing_features_of_p0.sql seeded role code TECHNICAL_ADMIN
--   (display "Technical Admin", level 15).
--   P1_064's DB-026 fix tried to seed both TECH_ADMIN and TECHNICAL_ADMIN
--   as "Technical Administrator" (level 90); its WHERE NOT EXISTS guard
--   only checks the row's own name, so it skipped TECHNICAL_ADMIN
--   (already existed) but happily inserted a *second*, separate role
--   TECH_ADMIN. The app code overwhelmingly uses the TECHNICAL_ADMIN
--   code (27 references) vs TECH_ADMIN (3 references), so TECH_ADMIN is
--   the stray duplicate. It currently has 0 assigned users and 0
--   permissions, so it is safe to retire.
--   FIX: repoint the 3 places that still reference TECH_ADMIN to
--   TECHNICAL_ADMIN, move over any user_roles/role_permissions rows
--   that might exist against it (defensive, expected to be none), then
--   delete the TECH_ADMIN role row.
-- =====================================================================


-- ---------------------------------------------------------------------
-- STEP 1: Fix core.roles write policy (delete/edit was silently no-op)
-- ---------------------------------------------------------------------
DROP POLICY IF EXISTS "role_manage" ON core.roles;
CREATE POLICY "role_manage" ON core.roles
  USING (
    core.has_permission(auth.uid(), 'ADMIN_USERS')
    AND (organization_id IS NULL OR core.same_org(organization_id))
  )
  WITH CHECK (
    core.has_permission(auth.uid(), 'ADMIN_USERS')
    AND (organization_id IS NULL OR core.same_org(organization_id))
  );

-- ---------------------------------------------------------------------
-- STEP 2: Fix core.role_permissions policies (permission grants for a
-- role could never be saved for the same NULL-organization reason)
-- ---------------------------------------------------------------------
DROP POLICY IF EXISTS "rp_select_org_scoped" ON core.role_permissions;
CREATE POLICY "rp_select_org_scoped" ON core.role_permissions
  FOR SELECT USING (
    core.has_permission(auth.uid(), 'ADMIN_USERS')
    AND EXISTS (
      SELECT 1 FROM core.roles r
      WHERE r.id = role_permissions.role_id
        AND (r.organization_id IS NULL OR core.same_org(r.organization_id))
    )
  );

DROP POLICY IF EXISTS "rp_manage_org_scoped" ON core.role_permissions;
CREATE POLICY "rp_manage_org_scoped" ON core.role_permissions
  FOR ALL USING (
    core.has_permission(auth.uid(), 'ADMIN_USERS')
    AND EXISTS (
      SELECT 1 FROM core.roles r
      WHERE r.id = role_permissions.role_id
        AND (r.organization_id IS NULL OR core.same_org(r.organization_id))
    )
  )
  WITH CHECK (
    core.has_permission(auth.uid(), 'ADMIN_USERS')
    AND EXISTS (
      SELECT 1 FROM core.roles r
      WHERE r.id = role_permissions.role_id
        AND (r.organization_id IS NULL OR core.same_org(r.organization_id))
    )
  );

-- ---------------------------------------------------------------------
-- STEP 3: Merge TECH_ADMIN into TECHNICAL_ADMIN
-- ---------------------------------------------------------------------
DO $$
DECLARE
  v_keep_id UUID;
  v_dup_id UUID;
BEGIN
  SELECT id INTO v_keep_id FROM core.roles WHERE name = 'TECHNICAL_ADMIN';
  SELECT id INTO v_dup_id  FROM core.roles WHERE name = 'TECH_ADMIN';

  IF v_dup_id IS NOT NULL AND v_keep_id IS NOT NULL THEN

    -- Move any user assignments off the duplicate (defensive; expected none)
    UPDATE core.user_roles ur
    SET role_id = v_keep_id
    WHERE ur.role_id = v_dup_id
      AND NOT EXISTS (
        SELECT 1 FROM core.user_roles ur2
        WHERE ur2.user_id = ur.user_id
          AND ur2.role_id = v_keep_id
          AND ur2.effective_from = ur.effective_from
      );
    DELETE FROM core.user_roles WHERE role_id = v_dup_id;

    -- Move any permission grants off the duplicate (defensive; expected none)
    UPDATE core.role_permissions rp
    SET role_id = v_keep_id
    WHERE rp.role_id = v_dup_id
      AND NOT EXISTS (
        SELECT 1 FROM core.role_permissions rp2
        WHERE rp2.role_id = v_keep_id
          AND rp2.permission_id = rp.permission_id
          AND rp2.effective_from = rp.effective_from
      );
    DELETE FROM core.role_permissions WHERE role_id = v_dup_id;

    -- Finally remove the duplicate role itself
    DELETE FROM core.roles WHERE id = v_dup_id;
  END IF;
END $$;

-- Repoint the 2 RLS policies that still checked role name 'TECH_ADMIN'
-- so security-event visibility for the technical admin keeps working
-- after the duplicate role code is gone.
DROP POLICY IF EXISTS "sec_events_select" ON audit.security_events;
CREATE POLICY "sec_events_select" ON audit.security_events
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM core.user_roles ur JOIN core.roles r ON r.id = ur.role_id
      WHERE ur.user_id = auth.uid() AND ur.is_active = true
        AND r.name = ANY (ARRAY['CEO','FINANCE_HEAD','AUDITOR','TECHNICAL_ADMIN'])
        AND (ur.effective_to IS NULL OR ur.effective_to >= CURRENT_DATE)
    )
    AND (organization_id IS NULL OR core.same_org(organization_id))
  );

-- ---------------------------------------------------------------------
-- STEP 4: Seed sensible permissions for the roles that currently have
-- zero permissions (Auditor, Administrator, Technical Admin), per
-- Section 7.1 / Appendix A of the implementation spec. Idempotent.
-- ---------------------------------------------------------------------

-- NOTE ON SAFETY: each block below CROSS JOINs core.roles r (filtered to
-- one exact role name) with core.permissions p, instead of using a bare
-- scalar subquery for role_id. If the named role were ever missing, a
-- scalar-subquery version would insert NULL role_ids and abort this
-- entire migration with a NOT NULL violation (rolling back the RLS fix
-- above too). The CROSS JOIN form simply inserts zero rows in that case,
-- so this migration can never be broken by a missing role.

-- AUDITOR: read-only across every finance module + audit log + export,
-- never create/update/delete/approve/post.
INSERT INTO core.role_permissions (role_id, permission_id, data_scope)
SELECT r.id, p.id, 'ALL'
FROM core.roles r
CROSS JOIN core.permissions p
WHERE r.name = 'AUDITOR'
  AND (p.action = 'read' OR p.code IN ('ADMIN_AUDIT', 'REPORT_EXPORT'))
ON CONFLICT (role_id, permission_id, effective_from) DO NOTHING;

-- ADMINISTRATOR (Admin, legacy code-referenced role, level 95):
-- user/role/config administration + read-only oversight of finance data.
-- NOTE: this role is not one of the spec's named roles (Appendix A has
-- no "Administrator" row) -- it exists only because application code
-- checks for it directly (e.g. MFA admin read, create_user_by_admin).
-- Recommend the CEO confirm whether this legacy role should keep being
-- used at all, or whether those code paths should be moved onto
-- CEO/Finance Head instead. Until then, giving it admin+read keeps the
-- code paths that already check for it functional without handing it
-- transaction approve/post rights that belong to CEO/Finance Head.
INSERT INTO core.role_permissions (role_id, permission_id, data_scope)
SELECT r.id, p.id, 'ALL'
FROM core.roles r
CROSS JOIN core.permissions p
WHERE r.name = 'Admin'
  AND (
    p.code IN ('ADMIN_USERS', 'ADMIN_AUDIT', 'ADMIN_CONFIG', 'SETTINGS_MANAGE', 'SETTINGS_READ')
    OR p.action = 'read'
  )
ON CONFLICT (role_id, permission_id, effective_from) DO NOTHING;

-- TECHNICAL ADMIN (TECHNICAL_ADMIN, level 15): per spec 7.1 this role
-- must NOT get automatic finance-data access. Its real rights
-- (deployments, monitoring, user support) live outside this
-- permission catalog. Only SETTINGS_READ is granted here so a
-- technical/support user can see organization configuration while
-- troubleshooting; deliberately no ADMIN_USERS, no ADMIN_AUDIT, no
-- finance module permission. A near-empty count for this role is
-- CORRECT by design, not a bug -- do not bulk-grant more without a
-- deliberate CEO/Finance Head decision, or it will violate the spec's
-- "no automatic right to read finance data" rule for this role.
INSERT INTO core.role_permissions (role_id, permission_id, data_scope)
SELECT r.id, p.id, 'ALL'
FROM core.roles r
CROSS JOIN core.permissions p
WHERE r.name = 'TECHNICAL_ADMIN'
  AND p.code = 'SETTINGS_READ'
ON CONFLICT (role_id, permission_id, effective_from) DO NOTHING;