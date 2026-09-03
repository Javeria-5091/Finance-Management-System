-- =============================================================================
-- Migration: P1_101_seed_admin_migration_permission.sql
-- Purpose  : SEC-01 (P1, HIGH) support migration.
--
--            The frontend already references a dedicated permission code,
--            'ADMIN_MIGRATION', to gate the "Data Migration" nav item
--            (src/components/sections/Sidebar.tsx) and it is declared in
--            src/context/PermissionContext.tsx's PermCode union — but it was
--            NEVER inserted into core.permissions, and consequently was
--            never granted to any role via core.role_permissions.
--
--            supabase/functions/data-processing/migrate-historical-data
--            (SEC-01 fix, same audit finding) now calls
--            core.has_permission(auth.uid(), 'ADMIN_MIGRATION') as its
--            server-side authorization check for this destructive,
--            GL-posting action. Without this migration, has_permission()
--            would return false for every caller except CEO (which the
--            edge function and src/lib/api-auth.ts both special-case as a
--            superuser, consistent with existing project convention),
--            leaving the feature usable by CEO only.
--
--            This migration seeds the permission and grants it, initially,
--            to CEO only (least privilege — this action posts irreversible
--            POSTED journal entries across an organization's entire
--            unmigrated income/expense history). Organization admins can
--            extend it to other roles/users afterwards via the existing
--            Admin > Users & Roles / Permission Overrides screens
--            (core.role_permissions / core.permission_overrides), the same
--            mechanism already used for every other permission in the
--            system -- this migration does not need to, and does not,
--            grant it more broadly than that.
--
-- Safety   : Purely additive (INSERT ... ON CONFLICT DO NOTHING). No
--            existing rows are modified or removed.
-- =============================================================================

INSERT INTO core.permissions (code, name, module, action, is_system, description)
VALUES (
  'ADMIN_MIGRATION',
  'Run Historical Data Migration',
  'admin',
  'migrate',
  true,
  'Post an organization''s unmigrated legacy income/expense records to the General Ledger as POSTED journal entries. Highly privileged and irreversible; distinct from ADMIN_AUDIT (read-only) and ADMIN_USERS (user/role administration).'
)
ON CONFLICT (code) DO NOTHING;

-- Grant to CEO only, matching this action's severity. (CEO also already
-- bypasses has_permission() entirely in application code, so this grant is
-- primarily so that CEO shows up correctly in the Admin > Users & Roles /
-- Permission Overrides UI, and so that any other role explicitly given
-- CEO-equivalent "ALL" permissions in the future picks this one up too.)
INSERT INTO core.role_permissions (role_id, permission_id, data_scope)
SELECT r.id, p.id, 'ALL'
FROM core.roles r
CROSS JOIN core.permissions p
WHERE r.name = 'CEO'
  AND p.code = 'ADMIN_MIGRATION'
ON CONFLICT (role_id, permission_id, effective_from) DO NOTHING;

COMMENT ON COLUMN core.permissions.code IS 'Unique permission code referenced by core.has_permission() and the application''s PermCode union (src/context/PermissionContext.tsx). ADMIN_MIGRATION added in migration P1_101 (SEC-01 fix) to gate supabase/functions/data-processing/migrate-historical-data server-side.';