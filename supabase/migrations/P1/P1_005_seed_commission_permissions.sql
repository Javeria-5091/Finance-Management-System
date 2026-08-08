-- =============================================================================
-- OSYSTIC — Commissions Module: Permission Seed SQL
-- =============================================================================
-- Standalone file — run after the migration SQL.
-- Inserts permissions into core.permissions and maps to roles via core.role_permissions.
-- =============================================================================

-- ─── 1. PERMISSIONS ───

INSERT INTO core.permissions (id, code, name, module, action, is_system, description)
VALUES
  (gen_random_uuid(), 'COMMISSION_READ',    'Commission: Read',    'COMMISSION', 'READ',    true, 'View commissions and summary reports'),
  (gen_random_uuid(), 'COMMISSION_CREATE',  'Commission: Create',  'COMMISSION', 'CREATE',  true, 'Create new commission records'),
  (gen_random_uuid(), 'COMMISSION_UPDATE',  'Commission: Update',  'COMMISSION', 'UPDATE',  true, 'Edit commission details, cancel commissions'),
  (gen_random_uuid(), 'COMMISSION_DELETE',  'Commission: Delete',  'COMMISSION', 'DELETE',  true, 'Delete draft/pending/cancelled commission records'),
  (gen_random_uuid(), 'COMMISSION_APPROVE', 'Commission: Approve', 'COMMISSION', 'APPROVE', true, 'Approve pending commissions and mark as paid')
ON CONFLICT (code) DO NOTHING;

-- ─── 2. ROLE PERMISSIONS ───

-- CEO: All
INSERT INTO core.role_permissions (role_id, permission_id, data_scope, amount_limit)
SELECT r.id, p.id, 'ALL'::text, NULL::numeric
FROM core.roles r CROSS JOIN core.permissions p
WHERE r.name = 'CEO' AND p.code IN (
  'COMMISSION_READ','COMMISSION_CREATE','COMMISSION_UPDATE','COMMISSION_DELETE','COMMISSION_APPROVE'
)
ON CONFLICT DO NOTHING;

-- CFO: All except DELETE
INSERT INTO core.role_permissions (role_id, permission_id, data_scope, amount_limit)
SELECT r.id, p.id, 'ALL'::text, NULL::numeric
FROM core.roles r CROSS JOIN core.permissions p
WHERE r.name = 'CFO' AND p.code IN (
  'COMMISSION_READ','COMMISSION_CREATE','COMMISSION_UPDATE','COMMISSION_APPROVE'
)
ON CONFLICT DO NOTHING;

-- FINANCE_HEAD: Same as CFO
INSERT INTO core.role_permissions (role_id, permission_id, data_scope, amount_limit)
SELECT r.id, p.id, 'ALL'::text, NULL::numeric
FROM core.roles r CROSS JOIN core.permissions p
WHERE r.name = 'FINANCE_HEAD' AND p.code IN (
  'COMMISSION_READ','COMMISSION_CREATE','COMMISSION_UPDATE','COMMISSION_APPROVE'
)
ON CONFLICT DO NOTHING;

-- ACCOUNTANT: Read + Create/Update (no DELETE, no APPROVE)
INSERT INTO core.role_permissions (role_id, permission_id, data_scope, amount_limit)
SELECT r.id, p.id, 'ALL'::text, NULL::numeric
FROM core.roles r CROSS JOIN core.permissions p
WHERE r.name = 'ACCOUNTANT' AND p.code IN (
  'COMMISSION_READ','COMMISSION_CREATE','COMMISSION_UPDATE'
)
ON CONFLICT DO NOTHING;

-- HOD: Read only, DEPARTMENT scope
INSERT INTO core.role_permissions (role_id, permission_id, data_scope, amount_limit)
SELECT r.id, p.id, 'DEPARTMENT'::text, NULL::numeric
FROM core.roles r CROSS JOIN core.permissions p
WHERE r.name = 'HOD' AND p.code IN ('COMMISSION_READ')
ON CONFLICT DO NOTHING;

-- PROJECT_MANAGER: Read only, PROJECT scope
INSERT INTO core.role_permissions (role_id, permission_id, data_scope, amount_limit)
SELECT r.id, p.id, 'PROJECT'::text, NULL::numeric
FROM core.roles r CROSS JOIN core.permissions p
WHERE r.name = 'PROJECT_MANAGER' AND p.code IN ('COMMISSION_READ')
ON CONFLICT DO NOTHING;