-- ═══════════════════════════════════════════════════════════════
-- 6 MISSING PERMISSIONS — core schema (FINAL CORRECT VERSION)
-- ═══════════════════════════════════════════════════════════════
-- Run in Supabase SQL Editor
-- ═══════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────
-- 1. ADD 6 PERMISSIONS
--    columns: code, name, module, action, is_system
-- ─────────────────────────────────────────────
INSERT INTO core.permissions (code, name, module, action, is_system)
VALUES
  ('CLIENT_READ',   'View clients list and details',   'clients',    'read',   true),
  ('CLIENT_CREATE', 'Create new clients',              'clients',    'create', true),
  ('CLIENT_UPDATE', 'Edit existing clients',           'clients',    'update', true),
  ('CLIENT_DELETE', 'Delete clients',                  'clients',    'delete', true),
  ('GL_READ',       'View general ledger reports',     'accounting', 'read',   true),
  ('TAX_CREATE',    'Create and file tax returns',     'tax',        'create', true)
ON CONFLICT (code) DO NOTHING;

-- ─────────────────────────────────────────────
-- 2. ASSIGN ALL 6 TO CEO
--    role_permissions has UNIQUE(role_id, permission_id, effective_from)
-- ─────────────────────────────────────────────
INSERT INTO core.role_permissions (role_id, permission_id, data_scope, amount_limit)
SELECT 
  (SELECT id FROM core.roles WHERE name = 'CEO'),
  id, 'ALL', NULL
FROM core.permissions
WHERE code IN ('CLIENT_READ','CLIENT_CREATE','CLIENT_UPDATE','CLIENT_DELETE','GL_READ','TAX_CREATE')
ON CONFLICT (role_id, permission_id, effective_from) DO NOTHING;

-- ─────────────────────────────────────────────
-- 3. VERIFY — should show 6 rows, all ASSIGNED
-- ─────────────────────────────────────────────
SELECT 
  p.code AS permission, 
  p.module,
  CASE WHEN rp.id IS NOT NULL THEN 'ASSIGNED' ELSE 'MISSING' END AS ceo_status
FROM core.permissions p
LEFT JOIN core.role_permissions rp 
  ON rp.permission_id = p.id 
  AND rp.role_id = (SELECT id FROM core.roles WHERE name = 'CEO')
WHERE p.code IN ('CLIENT_READ','CLIENT_CREATE','CLIENT_UPDATE','CLIENT_DELETE','GL_READ','TAX_CREATE')
ORDER BY p.module, p.code;