-- ==========================================
-- PHASE 6: BANKING PERMISSIONS
-- USER triggers only disabled (FK triggers stay active)
-- ==========================================

-- 0. DISABLE ONLY USER TRIGGERS (audit triggers)
ALTER TABLE core.permissions DISABLE TRIGGER USER;
ALTER TABLE core.role_permissions DISABLE TRIGGER USER;


-- 1. INSERT BANKING PERMISSIONS
INSERT INTO core.permissions (code, name, module, action, is_system, description)
VALUES
  ('BANK_READ',      'View Banking',                'banking', 'read',      true, 'View financial accounts, statements, reconciliation, and transfers'),
  ('BANK_CREATE',    'Create Banking Records',       'banking', 'create',    true, 'Create financial accounts, import statements, create transfers'),
  ('BANK_UPDATE',    'Edit Banking Records',         'banking', 'update',    true, 'Edit financial account details, update transfer details'),
  ('BANK_DELETE',    'Deactivate Banking Records',    'banking', 'delete',    true, 'Deactivate financial accounts, cancel transfers'),
  ('BANK_RECONCILE', 'Reconcile Bank Statements',   'banking', 'reconcile', true, 'Auto-match, manual match, exclude, unmatch statement lines'),
  ('BANK_POST',      'Post Banking to Ledger',       'banking', 'post',      true, 'Post bank transfers to the general ledger'),
  ('BANK_APPROVE',   'Approve Banking Actions',      'banking', 'approve',   true, 'Approve bank transfers, especially dual-approval transfers')
ON CONFLICT (code) DO NOTHING;


-- 2. CEO — ALL BANKING PERMISSIONS
INSERT INTO core.role_permissions (role_id, permission_id, data_scope, amount_limit)
SELECT r.id, p.id, 'ALL', NULL
FROM core.roles r
CROSS JOIN core.permissions p
WHERE r.name = 'CEO' AND p.code LIKE 'BANK_%'
ON CONFLICT (role_id, permission_id, effective_from) DO NOTHING;


-- 3. FINANCE HEAD — ALL BANKING PERMISSIONS
INSERT INTO core.role_permissions (role_id, permission_id, data_scope, amount_limit)
SELECT r.id, p.id, 'ALL', NULL
FROM core.roles r
CROSS JOIN core.permissions p
WHERE r.name = 'FINANCE_HEAD' AND p.code LIKE 'BANK_%'
ON CONFLICT (role_id, permission_id, effective_from) DO NOTHING;


-- 4. ACCOUNTANT — READ, CREATE, UPDATE, RECONCILE
INSERT INTO core.role_permissions (role_id, permission_id, data_scope, amount_limit)
SELECT r.id, p.id, 'ALL', NULL
FROM core.roles r
CROSS JOIN core.permissions p
WHERE r.name = 'ACCOUNTANT'
  AND p.code IN ('BANK_READ', 'BANK_CREATE', 'BANK_UPDATE', 'BANK_RECONCILE')
ON CONFLICT (role_id, permission_id, effective_from) DO NOTHING;


-- 5. HOD — READ ONLY
INSERT INTO core.role_permissions (role_id, permission_id, data_scope, amount_limit)
SELECT r.id, p.id, 'ALL', NULL
FROM core.roles r
CROSS JOIN core.permissions p
WHERE r.name = 'HOD' AND p.code = 'BANK_READ'
ON CONFLICT (role_id, permission_id, effective_from) DO NOTHING;


-- 6. PROJECT MANAGER — READ ONLY
INSERT INTO core.role_permissions (role_id, permission_id, data_scope, amount_limit)
SELECT r.id, p.id, 'ALL', NULL
FROM core.roles r
CROSS JOIN core.permissions p
WHERE r.name = 'PROJECT_MANAGER' AND p.code = 'BANK_READ'
ON CONFLICT (role_id, permission_id, effective_from) DO NOTHING;


-- 7. RE-ENABLE USER TRIGGERS
ALTER TABLE core.permissions ENABLE TRIGGER USER;
ALTER TABLE core.role_permissions ENABLE TRIGGER USER;


-- ==========================================
-- VERIFICATION
-- ==========================================

SELECT code, name, module FROM core.permissions WHERE module = 'banking' ORDER BY code;

SELECT r.display_name AS role, p.code AS permission
FROM core.role_permissions rp
JOIN core.roles r ON r.id = rp.role_id
JOIN core.permissions p ON p.id = rp.permission_id
WHERE p.module = 'banking'
ORDER BY r.level DESC, p.code;