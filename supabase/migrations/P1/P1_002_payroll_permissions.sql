-- =============================================================================
--  SEED PAYROLL PERMISSIONS into core.permissions
-- ★★★ FIX #3: This file now contains ACTUAL payroll permissions (was asset categories) ★★★
-- =============================================================================

-- Insert Payroll module permissions
INSERT INTO core.permissions (id, code, name, module, action, is_system, description)
VALUES
  (gen_random_uuid(), 'PAYROLL_READ',               'Payroll: Read',               'PAYROLL', 'READ',    true, 'View payroll employees, runs, and reports'),
  (gen_random_uuid(), 'PAYROLL_CREATE',             'Payroll: Create',             'PAYROLL', 'CREATE',  true, 'Create payroll employees, runs, and entries'),
  (gen_random_uuid(), 'PAYROLL_UPDATE',             'Payroll: Update',             'PAYROLL', 'UPDATE',  true, 'Edit payroll records, compensation, deductions'),
  (gen_random_uuid(), 'PAYROLL_DELETE',             'Payroll: Delete',             'PAYROLL', 'DELETE',  true, 'Remove payroll employees and records'),
  (gen_random_uuid(), 'PAYROLL_APPROVE',            'Payroll: Approve',            'PAYROLL', 'APPROVE', true, 'Approve payroll runs, advances, and commissions'),
  (gen_random_uuid(), 'PAYROLL_POST',               'Payroll: Post to GL',         'PAYROLL', 'POST',    true, 'Post approved payroll to general ledger'),
  (gen_random_uuid(), 'PAYROLL_ADVANCE_READ',       'Advance: Read',               'PAYROLL_ADVANCE', 'READ',    true, 'View payroll advance requests'),
  (gen_random_uuid(), 'PAYROLL_ADVANCE_CREATE',     'Advance: Create',             'PAYROLL_ADVANCE', 'CREATE',  true, 'Create payroll advance requests'),
  (gen_random_uuid(), 'PAYROLL_ADVANCE_APPROVE',    'Advance: Approve',            'PAYROLL_ADVANCE', 'APPROVE', true, 'Approve or reject advance requests'),
  (gen_random_uuid(), 'PAYROLL_COMMISSION_READ',    'Commission: Read',            'PAYROLL_COMMISSION', 'READ',    true, 'View payroll commission records'),
  (gen_random_uuid(), 'PAYROLL_COMMISSION_CREATE',  'Commission: Create',           'PAYROLL_COMMISSION', 'CREATE',  true, 'Create commission entries'),
  (gen_random_uuid(), 'PAYROLL_COMMISSION_APPROVE', 'Commission: Approve',          'PAYROLL_COMMISSION', 'APPROVE', true, 'Approve commission payouts'),
  (gen_random_uuid(), 'PAYROLL_REIMBURSEMENT_READ',       'Reimbursement: Read',       'PAYROLL_REIMBURSEMENT', 'READ',    true, 'View reimbursement claims'),
  (gen_random_uuid(), 'PAYROLL_REIMBURSEMENT_CREATE',     'Reimbursement: Create',     'PAYROLL_REIMBURSEMENT', 'CREATE',  true, 'Submit reimbursement claims'),
  (gen_random_uuid(), 'PAYROLL_REIMBURSEMENT_APPROVE',    'Reimbursement: Approve',    'PAYROLL_REIMBURSEMENT', 'APPROVE', true, 'Approve reimbursement claims')
ON CONFLICT (code) DO NOTHING;

-- =============================================================================
-- STEP 4: MAP PAYROLL PERMISSIONS TO ROLES
-- =============================================================================

-- Helper: Get permission ID by code
-- (Supabase SQL doesn't have variables, so we use CTEs or subqueries)

-- CEO: All Payroll permissions, scope ALL
INSERT INTO core.role_permissions (role_id, permission_id, data_scope, amount_limit)
SELECT
  r.id,
  p.id,
  'ALL' as data_scope,
  NULL::numeric as amount_limit
FROM core.roles r
CROSS JOIN core.permissions p
WHERE r.name = 'CEO'
  AND p.code IN (
    'PAYROLL_READ', 'PAYROLL_CREATE', 'PAYROLL_UPDATE', 'PAYROLL_DELETE',
    'PAYROLL_APPROVE', 'PAYROLL_POST',
    'PAYROLL_ADVANCE_READ', 'PAYROLL_ADVANCE_CREATE', 'PAYROLL_ADVANCE_APPROVE',
    'PAYROLL_COMMISSION_READ', 'PAYROLL_COMMISSION_CREATE', 'PAYROLL_COMMISSION_APPROVE',
    'PAYROLL_REIMBURSEMENT_READ', 'PAYROLL_REIMBURSEMENT_CREATE', 'PAYROLL_REIMBURSEMENT_APPROVE'
  )
ON CONFLICT DO NOTHING;

-- CFO: All except DELETE, scope ALL
INSERT INTO core.role_permissions (role_id, permission_id, data_scope, amount_limit)
SELECT
  r.id,
  p.id,
  'ALL' as data_scope,
  NULL::numeric as amount_limit
FROM core.roles r
CROSS JOIN core.permissions p
WHERE r.name = 'CFO'
  AND p.code IN (
    'PAYROLL_READ', 'PAYROLL_CREATE', 'PAYROLL_UPDATE',
    'PAYROLL_APPROVE', 'PAYROLL_POST',
    'PAYROLL_ADVANCE_READ', 'PAYROLL_ADVANCE_CREATE', 'PAYROLL_ADVANCE_APPROVE',
    'PAYROLL_COMMISSION_READ', 'PAYROLL_COMMISSION_CREATE', 'PAYROLL_COMMISSION_APPROVE',
    'PAYROLL_REIMBURSEMENT_READ', 'PAYROLL_REIMBURSEMENT_CREATE', 'PAYROLL_REIMBURSEMENT_APPROVE'
  )
ON CONFLICT DO NOTHING;

-- FINANCE_HEAD: Same as CFO
INSERT INTO core.role_permissions (role_id, permission_id, data_scope, amount_limit)
SELECT
  r.id,
  p.id,
  'ALL' as data_scope,
  NULL::numeric as amount_limit
FROM core.roles r
CROSS JOIN core.permissions p
WHERE r.name = 'FINANCE_HEAD'
  AND p.code IN (
    'PAYROLL_READ', 'PAYROLL_CREATE', 'PAYROLL_UPDATE',
    'PAYROLL_APPROVE', 'PAYROLL_POST',
    'PAYROLL_ADVANCE_READ', 'PAYROLL_ADVANCE_CREATE', 'PAYROLL_ADVANCE_APPROVE',
    'PAYROLL_COMMISSION_READ', 'PAYROLL_COMMISSION_CREATE', 'PAYROLL_COMMISSION_APPROVE',
    'PAYROLL_REIMBURSEMENT_READ', 'PAYROLL_REIMBURSEMENT_CREATE', 'PAYROLL_REIMBURSEMENT_APPROVE'
  )
ON CONFLICT DO NOTHING;

-- ACCOUNTANT: Read + Create/Update (no delete, no approve, no post)
INSERT INTO core.role_permissions (role_id, permission_id, data_scope, amount_limit)
SELECT
  r.id,
  p.id,
  'ALL' as data_scope,
  NULL::numeric as amount_limit
FROM core.roles r
CROSS JOIN core.permissions p
WHERE r.name = 'ACCOUNTANT'
  AND p.code IN (
    'PAYROLL_READ', 'PAYROLL_CREATE', 'PAYROLL_UPDATE',
    'PAYROLL_ADVANCE_READ', 'PAYROLL_ADVANCE_CREATE',
    'PAYROLL_COMMISSION_READ', 'PAYROLL_COMMISSION_CREATE',
    'PAYROLL_REIMBURSEMENT_READ', 'PAYROLL_REIMBURSEMENT_CREATE'
  )
ON CONFLICT DO NOTHING;

-- HOD: Read only
INSERT INTO core.role_permissions (role_id, permission_id, data_scope, amount_limit)
SELECT
  r.id,
  p.id,
  'DEPARTMENT' as data_scope,
  NULL::numeric as amount_limit
FROM core.roles r
CROSS JOIN core.permissions p
WHERE r.name = 'HOD'
  AND p.code IN (
    'PAYROLL_READ',
    'PAYROLL_ADVANCE_READ',
    'PAYROLL_COMMISSION_READ',
    'PAYROLL_REIMBURSEMENT_READ'
  )
ON CONFLICT DO NOTHING;

-- PROJECT_MANAGER: Read only, scope PROJECT
INSERT INTO core.role_permissions (role_id, permission_id, data_scope, amount_limit)
SELECT
  r.id,
  p.id,
  'PROJECT' as data_scope,
  NULL::numeric as amount_limit
FROM core.roles r
CROSS JOIN core.permissions p
WHERE r.name = 'PROJECT_MANAGER'
  AND p.code IN ('PAYROLL_READ')
ON CONFLICT DO NOTHING;

-- =============================================================================
-- DONE!
-- Asset categories seeded (10 categories)
-- Payroll permissions seeded (15 permissions)
-- Role-permission mappings created for all roles
-- =============================================================================
