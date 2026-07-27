-- ==========================================
-- PHASE 7: TAX, EQUITY, SETTINGS PERMISSIONS
-- Pattern: Same as Phase 6 permissions file
-- ==========================================

-- 0. DISABLE USER TRIGGERS (prevent trigger errors during bulk insert)
ALTER TABLE core.permissions DISABLE TRIGGER USER;
ALTER TABLE core.role_permissions DISABLE TRIGGER USER;


-- ==========================================
-- 1. INSERT NEW PERMISSIONS INTO core.permissions
-- ==========================================
INSERT INTO core.permissions (code, name, module, action, is_system, description)
VALUES
  -- TAX MODULE
  ('TAX_READ',      'View Tax Configuration',       'tax',      'read',      true, 'View taxpayer profile, rule sets, and tax reconciliations'),
  ('TAX_MANAGE',    'Manage Tax Configuration',    'tax',      'create',    true, 'Create/edit taxpayer profile, rule sets, slabs, and adjustments'),
  ('TAX_APPROVE',   'Approve Tax',              'tax',      'approve',   true, 'Approve tax reconciliations and mark as filed/paid'),

  -- EQUITY MODULE
  ('EQUITY_READ',    'View Equity',                'equity',    'read',      true, 'View profit distributions, ownership structure, and reserves'),
  ('EQUITY_MANAGE',  'Manage Equity',             'equity',    'create',    true, 'Create/declare profit distributions, update ownership'),
  ('EQUITY_APPROVE', 'Approve Equity Actions',      'equity',    'approve',   true, 'CEO approve profit distributions'),
  ('EQUITY_POST',   'Post Equity to Ledger',      'equity',    'post',      true, 'Post profit distributions to general ledger'),

  -- SETTINGS MODULE
  ('SETTINGS_READ',   'View Settings',             'settings', 'read',      true, 'View organization settings, exchange rates, ownership & reserves'),
  ('SETTINGS_MANAGE', 'Manage Settings',          'settings', 'create',    true, 'Edit organization settings, exchange rates, reserve policies')
ON CONFLICT (code) DO NOTHING;


-- ==========================================
-- 2. CEO — ALL NEW PERMISSIONS
-- ==========================================
INSERT INTO core.role_permissions (role_id, permission_id, data_scope, amount_limit)
SELECT r.id, p.id, 'ALL', NULL
FROM core.roles r
CROSS JOIN core.permissions p
WHERE r.name = 'CEO'
  AND p.code IN (
    'TAX_READ', 'TAX_MANAGE', 'TAX_APPROVE',
    'EQUITY_READ', 'EQUITY_MANAGE', 'EQUITY_APPROVE', 'EQUITY_POST',
    'SETTINGS_READ', 'SETTINGS_MANAGE'
  )
ON CONFLICT (role_id, permission_id, effective_from) DO NOTHING;


-- ==========================================
-- 3. FINANCE HEAD — TAX + EQUITY + SETTINGS
-- ==========================================
INSERT INTO core.role_permissions (role_id, permission_id, data_scope, amount_limit)
SELECT r.id, p.id, 'ALL', NULL
FROM core.roles r
CROSS JOIN core.permissions p
WHERE r.name = 'FINANCE_HEAD'
  AND p.code IN (
    'TAX_READ', 'TAX_MANAGE', 'TAX_APPROVE',
    'EQUITY_READ', 'EQUITY_MANAGE', 'EQUITY_APPROVE',
    'SETTINGS_READ', 'SETTINGS_MANAGE'
  )
ON CONFLICT (role_id, permission_id, effective_from) DO NOTHING;


-- ==========================================
-- 4. ACCOUNTANT — TAX + EQUITY READ + SETTINGS READ
-- ==========================================
INSERT INTO core.role_permissions (role_id, permission_id, data_scope, amount_limit)
SELECT r.id, p.id, 'ALL', NULL
FROM core.roles r
CROSS JOIN core.permissions p
WHERE r.name = 'ACCOUNTANT'
  AND p.code IN (
    'TAX_READ', 'TAX_MANAGE', 'TAX_APPROVE',
    'EQUITY_READ', 'SETTINGS_READ'
  )
ON CONFLICT (role_id, permission_id, effective_from) DO NOTHING;


-- ==========================================
-- 5. HOD — TAX + EQUITY READ
-- ==========================================
INSERT INTO core.role_permissions (role_id, permission_id, data_scope, amount_limit)
SELECT r.id, p.id, 'ALL', NULL
FROM core.roles r
CROSS JOIN core.permissions p
WHERE r.name = 'HOD'
  AND p.code IN (
    'TAX_READ',
    'EQUITY_READ'
  )
ON CONFLICT (role_id, permission_id, effective_from) DO NOTHING;


-- ==========================================
-- 6. PROJECT MANAGER — EQUITY READ
-- ==========================================
INSERT INTO core.role_permissions (role_id, permission_id, data_scope, amount_limit)
SELECT r.id, p.id, 'ALL', NULL
FROM core.roles r
CROSS JOIN core.permissions p
WHERE r.name = 'PROJECT_MANAGER'
  AND p.code = 'EQUITY_READ'
ON CONFLICT (role_id, permission_id, effective_from) DO NOTHING;


-- ==========================================
-- 7. RE-ENABLE USER TRIGGERS
-- ==========================================
ALTER TABLE core.permissions ENABLE TRIGGER USER;
ALTER TABLE core.role_permissions ENABLE TRIGGER USER;
