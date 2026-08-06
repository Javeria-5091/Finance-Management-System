-- =============================================================================
-- P1.001b: Fixed Assets — Permissions & Role Mappings
-- Must match core.permissions + core.role_permissions schema (same as P0)
-- Run AFTER the main P1_001_fixed_assets_and_depreciation.sql
-- =============================================================================

-- Disable triggers during bulk insert
ALTER TABLE core.permissions DISABLE TRIGGER USER;
ALTER TABLE core.role_permissions DISABLE TRIGGER USER;

-- ==========================================
-- 1. ADD FIXED ASSET PERMISSIONS
-- ==========================================
INSERT INTO core.permissions (code, name, module, action, is_system, description)
VALUES
  ('FIXED_ASSET_READ',      'View Fixed Assets',            'fixed_asset',      'read',     true, 'View asset register and details'),
  ('FIXED_ASSET_CREATE',    'Create Fixed Asset',            'fixed_asset',      'create',   true, 'Add new fixed asset record'),
  ('FIXED_ASSET_UPDATE',    'Edit Fixed Asset',              'fixed_asset',      'update',   true, 'Update asset information and parameters'),
  ('FIXED_ASSET_DELETE',    'Delete Fixed Asset',            'fixed_asset',      'delete',   true, 'Delete/deactivate asset record'),
  ('FIXED_ASSET_CAPITALIZE','Capitalize Fixed Asset',        'fixed_asset',      'approve',  true, 'Approve and capitalize pending asset'),
  ('FIXED_ASSET_DISPOSE',   'Dispose Fixed Asset',           'fixed_asset',      'update',   true, 'Record asset disposal or sale'),
  ('FIXED_ASSET_DEPR_READ',    'View Depreciation',          'depreciation',     'read',     true, 'View depreciation schedule and reports'),
  ('FIXED_ASSET_DEPR_GENERATE','Generate Depreciation',      'depreciation',     'create',   true, 'Run depreciation calculation for a period'),
  ('FIXED_ASSET_DEPR_POST',    'Post Depreciation',          'depreciation',     'post',     true, 'Post depreciation to general ledger'),
  ('FIXED_ASSET_VERIFY_READ',  'View Asset Verifications',   'asset_verification','read',     true, 'View verification records'),
  ('FIXED_ASSET_VERIFY_CREATE','Create Asset Verification',  'asset_verification','create',   true, 'Start new physical verification'),
  ('FIXED_ASSET_VERIFY_UPDATE','Update Asset Verification',  'asset_verification','update',   true, 'Record verification results'),
  ('FIXED_ASSET_CATEGORY_READ',  'View Asset Categories',    'fixed_asset',      'read',     true, 'View asset category list'),
  ('FIXED_ASSET_CATEGORY_CREATE','Create Asset Category',    'fixed_asset',      'create',   true, 'Add new asset category'),
  ('FIXED_ASSET_CATEGORY_UPDATE','Edit Asset Category',      'fixed_asset',      'update',   true, 'Update category parameters')
ON CONFLICT (code) DO NOTHING;

-- ==========================================
-- 2. ADD ROLE-PERMISSION MAPPINGS
-- ==========================================

-- Admin: ALL fixed asset permissions
INSERT INTO core.role_permissions (role_id, permission_id, data_scope, amount_limit)
SELECT r.id, p.id, 'ALL', NULL
FROM core.roles r CROSS JOIN core.permissions p
WHERE r.name = 'Admin'
  AND (
    p.code LIKE 'FIXED_ASSET_%'
  )
ON CONFLICT (role_id, permission_id, effective_from) DO NOTHING;

-- CEO: ALL fixed asset permissions
INSERT INTO core.role_permissions (role_id, permission_id, data_scope, amount_limit)
SELECT r.id, p.id, 'ALL', NULL
FROM core.roles r CROSS JOIN core.permissions p
WHERE r.name = 'CEO'
  AND (
    p.code LIKE 'FIXED_ASSET_%'
  )
ON CONFLICT (role_id, permission_id, effective_from) DO NOTHING;

-- CFO: ALL except delete
INSERT INTO core.role_permissions (role_id, permission_id, data_scope, amount_limit)
SELECT r.id, p.id, 'ALL', NULL
FROM core.roles r CROSS JOIN core.permissions p
WHERE r.name = 'CFO'
  AND p.code LIKE 'FIXED_ASSET_%'
  AND p.code NOT IN ('FIXED_ASSET_DELETE')
ON CONFLICT (role_id, permission_id, effective_from) DO NOTHING;

-- FINANCE_HEAD: ALL except delete + capitalize
INSERT INTO core.role_permissions (role_id, permission_id, data_scope, amount_limit)
SELECT r.id, p.id, 'ALL', NULL
FROM core.roles r CROSS JOIN core.permissions p
WHERE r.name = 'FINANCE_HEAD'
  AND (
    p.code IN (
      'FIXED_ASSET_READ', 'FIXED_ASSET_CREATE', 'FIXED_ASSET_UPDATE',
      'FIXED_ASSET_CAPITALIZE', 'FIXED_ASSET_DISPOSE',
      'FIXED_ASSET_DEPR_READ', 'FIXED_ASSET_DEPR_GENERATE', 'FIXED_ASSET_DEPR_POST',
      'FIXED_ASSET_VERIFY_READ', 'FIXED_ASSET_VERIFY_CREATE', 'FIXED_ASSET_VERIFY_UPDATE',
      'FIXED_ASSET_CATEGORY_READ', 'FIXED_ASSET_CATEGORY_CREATE', 'FIXED_ASSET_CATEGORY_UPDATE'
    )
  )
ON CONFLICT (role_id, permission_id, effective_from) DO NOTHING;

-- ACCOUNTANT: Create/Read/Update assets + Read/Generate depreciation + Read categories
INSERT INTO core.role_permissions (role_id, permission_id, data_scope, amount_limit)
SELECT r.id, p.id, 'ALL', NULL
FROM core.roles r CROSS JOIN core.permissions p
WHERE r.name = 'ACCOUNTANT'
  AND p.code IN (
    'FIXED_ASSET_READ', 'FIXED_ASSET_CREATE', 'FIXED_ASSET_UPDATE',
    'FIXED_ASSET_DEPR_READ', 'FIXED_ASSET_DEPR_GENERATE',
    'FIXED_ASSET_VERIFY_READ',
    'FIXED_ASSET_CATEGORY_READ'
  )
ON CONFLICT (role_id, permission_id, effective_from) DO NOTHING;

-- HOD: Read only
INSERT INTO core.role_permissions (role_id, permission_id, data_scope, amount_limit)
SELECT r.id, p.id, 'ALL', NULL
FROM core.roles r CROSS JOIN core.permissions p
WHERE r.name = 'HOD'
  AND p.code IN (
    'FIXED_ASSET_READ',
    'FIXED_ASSET_DEPR_READ',
    'FIXED_ASSET_CATEGORY_READ'
  )
ON CONFLICT (role_id, permission_id, effective_from) DO NOTHING;

-- PROJECT_MANAGER: Read only (own project assets)
INSERT INTO core.role_permissions (role_id, permission_id, data_scope, amount_limit)
SELECT r.id, p.id, 'PROJECT', NULL
FROM core.roles r CROSS JOIN core.permissions p
WHERE r.name = 'PROJECT_MANAGER'
  AND p.code IN (
    'FIXED_ASSET_READ',
    'FIXED_ASSET_DEPR_READ'
  )
ON CONFLICT (role_id, permission_id, effective_from) DO NOTHING;

-- Re-enable triggers
ALTER TABLE core.permissions ENABLE TRIGGER USER;
ALTER TABLE core.role_permissions ENABLE TRIGGER USER;

-- ==========================================
-- VERIFICATION QUERY (uncomment to check)
-- ==========================================
-- SELECT r.display_name as role, COUNT(rp.permission_id) as total_permissions
-- FROM core.roles r
-- LEFT JOIN core.role_permissions rp ON rp.role_id = r.id
-- LEFT JOIN core.permissions p ON p.id = rp.permission_id
-- WHERE p.code LIKE 'FIXED_ASSET_%'
-- GROUP BY r.display_name ORDER BY MIN(r.level) DESC;