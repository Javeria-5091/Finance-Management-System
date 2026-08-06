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

-- =============================================================================
-- SEED: Asset Categories — 10 Default Categories
-- =============================================================================
-- Run this in Supabase SQL Editor.
-- Prerequisites:
--   1. P1_001_fixed_assets_and_depreciation.sql must be applied
--   2. P1_002_payroll_permissions.sql (the ALTER/DROP NOT NULL part) must be applied
-- =============================================================================

BEGIN;

-- STEP 1: Ensure linked account columns are nullable (if not already done)
ALTER TABLE finance.asset_categories
    ALTER COLUMN linked_asset_account_id DROP NOT NULL,
    ALTER COLUMN linked_depreciation_account_id DROP NOT NULL,
    ALTER COLUMN linked_expense_account_id DROP NOT NULL;

ALTER TABLE finance.fixed_assets
    ALTER COLUMN exchange_rate_id DROP NOT NULL;

-- STEP 2: Get a valid user ID for created_by (required NOT NULL)
-- This finds the first authenticated user — works in SQL editor.
DO $$
DECLARE
    v_user_id UUID;
BEGIN
    SELECT id INTO v_user_id FROM auth.users LIMIT 1;

    IF v_user_id IS NULL THEN
        RAISE EXCEPTION 'No users found in auth.users table. Please create at least one user first.';
    END IF;

    -- STEP 3: Insert 10 default asset categories (skip if already exist)
    INSERT INTO finance.asset_categories (
        code, name, description,
        depreciation_method, useful_life_months, residual_value_pct,
        capitalization_threshold,
        linked_asset_account_id, linked_depreciation_account_id, linked_expense_account_id,
        active, created_by
    ) VALUES
        ('IT-EQ', 'IT Equipment', 'Computers, laptops, servers, networking gear',
            'straight_line', 36, 10, 50000, NULL, NULL, NULL, true, v_user_id),
        ('VEH', 'Vehicles', 'Cars, motorcycles, delivery vans',
            'straight_line', 60, 15, 100000, NULL, NULL, NULL, true, v_user_id),
        ('FF', 'Furniture & Fixtures', 'Desks, chairs, cabinets, partitions',
            'straight_line', 120, 10, 25000, NULL, NULL, NULL, true, v_user_id),
        ('OFF-EQ', 'Office Equipment', 'Printers, scanners, AC units, generators',
            'straight_line', 60, 10, 25000, NULL, NULL, NULL, true, v_user_id),
        ('MCH', 'Machinery', 'Production machinery, industrial equipment',
            'declining_balance', 120, 5, 100000, NULL, NULL, NULL, true, v_user_id),
        ('BLD', 'Buildings', 'Office buildings, warehouses, factories',
            'straight_line', 300, 0, 500000, NULL, NULL, NULL, true, v_user_id),
        ('LND', 'Land', 'Plots, land — no depreciation',
            'straight_line', 0, 100, 0, NULL, NULL, NULL, true, v_user_id),
        ('ELC', 'Electrical Equipment', 'UPS, transformers, wiring installations',
            'straight_line', 60, 5, 25000, NULL, NULL, NULL, true, v_user_id),
        ('PHV', 'Plumbing & HVAC', 'Water systems, heating, ventilation',
            'straight_line', 120, 10, 50000, NULL, NULL, NULL, true, v_user_id),
        ('SW', 'Software Licenses', 'ERP, CRM, development tools licenses',
            'straight_line', 36, 0, 10000, NULL, NULL, NULL, true, v_user_id)
    ON CONFLICT (code) DO NOTHING;

    RAISE NOTICE 'Asset categories seeded successfully for user: %', v_user_id;
END $$;

-- STEP 4: Optional — Link categories to default Chart of Accounts accounts
-- This finds the first matching accounts from finance.chart_of_accounts
DO $$
DECLARE
    v_asset_acc UUID;
    v_dep_acc UUID;
    v_exp_acc UUID;
BEGIN
    -- Find default accounts (adjust names to match your Chart of Accounts)
    SELECT id INTO v_asset_acc FROM finance.chart_of_accounts WHERE code ILIKE '1500%' OR name ILIKE '%fixed asset%' OR name ILIKE '%property plant%' LIMIT 1;
    SELECT id INTO v_dep_acc FROM finance.chart_of_accounts WHERE code ILIKE '1510%' OR name ILIKE '%accumulated depreciation%' OR name ILIKE '%depreciation%' LIMIT 1;
    SELECT id INTO v_exp_acc FROM finance.chart_of_accounts WHERE code ILIKE '6200%' OR name ILIKE '%depreciation expense%' OR name ILIKE '%depr. expense%' LIMIT 1;

    IF v_asset_acc IS NOT NULL AND v_dep_acc IS NOT NULL AND v_exp_acc IS NOT NULL THEN
        UPDATE finance.asset_categories
        SET linked_asset_account_id = v_asset_acc,
            linked_depreciation_account_id = v_dep_acc,
            linked_expense_account_id = v_exp_acc
        WHERE linked_asset_account_id IS NULL;

        RAISE NOTICE 'Linked all categories to COA accounts: asset=%, dep=%, exp=%', v_asset_acc, v_dep_acc, v_exp_acc;
    ELSE
        RAISE NOTICE 'Could not find all 3 COA accounts. Categories created with NULL linked accounts. Link them manually via the Asset Category edit screen.';
    END IF;
END $$;

COMMIT;

-- =============================================================================
-- VERIFICATION (run this separately to confirm)
-- =============================================================================
-- SELECT code, name, useful_life_months, residual_value_pct, depreciation_method,
--        linked_asset_account_id IS NOT NULL as has_asset_acc,
--        linked_depreciation_account_id IS NOT NULL as has_dep_acc,
--        linked_expense_account_id IS NOT NULL as has_exp_acc
-- FROM finance.asset_categories
-- WHERE active = true ORDER BY code;
