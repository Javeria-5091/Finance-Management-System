-- ==========================================
-- FORCIBLE SEED DATA & VERIFICATION
-- ==========================================

INSERT INTO core.roles (name, display_name, description, is_system, level) VALUES
('CEO', 'CEO / Founder', 'Full access with audit. Final approvals.', true, 100),
('FINANCE_HEAD', 'Finance Head / CFO', 'Company-wide finance management and approvals.', true, 90),
('ACCOUNTANT', 'Accountant', 'Create, verify, post transactions. Cannot approve own entries.', true, 70),
('HOD', 'Head of Department', 'Department-level view and expense submission.', true, 50),
('PROJECT_MANAGER', 'Project Manager', 'Project-level income, expense, budget view.', true, 40),
('EMPLOYEE', 'Employee', 'Submit own expenses and reimbursements.', true, 20),
('VIEWER', 'Viewer', 'Read-only access to assigned data.', true, 10)
ON CONFLICT (name) DO NOTHING;

-- 2. CEO PERMISSIONS (All)
INSERT INTO core.role_permissions (role_id, permission_id, data_scope)
SELECT (SELECT id FROM core.roles WHERE name = 'CEO'), id, 'ALL'
FROM core.permissions
ON CONFLICT (role_id, permission_id, effective_from) DO NOTHING;

-- 3. FINANCE HEAD PERMISSIONS
INSERT INTO core.role_permissions (role_id, permission_id, data_scope)
SELECT (SELECT id FROM core.roles WHERE name = 'FINANCE_HEAD'), id, 'ALL'
FROM core.permissions
WHERE code NOT IN ('ADMIN_USERS', 'ADMIN_AUDIT', 'ADMIN_CONFIG', 'PERIOD_REOPEN')
ON CONFLICT (role_id, permission_id, effective_from) DO NOTHING;

-- 4. ACCOUNTANT PERMISSIONS
INSERT INTO core.role_permissions (role_id, permission_id, data_scope)
SELECT (SELECT id FROM core.roles WHERE name = 'ACCOUNTANT'), id, 'ALL'
FROM core.permissions
WHERE code IN (
  'INCOME_CREATE', 'INCOME_READ', 'INCOME_UPDATE', 'INCOME_SUBMIT', 'INCOME_VERIFY', 'INCOME_POST',
  'EXPENSE_CREATE', 'EXPENSE_READ', 'EXPENSE_UPDATE', 'EXPENSE_SUBMIT', 'EXPENSE_VERIFY', 'EXPENSE_POST',
  'JOURNAL_CREATE', 'JOURNAL_READ', 'JOURNAL_UPDATE', 'JOURNAL_SUBMIT', 'JOURNAL_VERIFY', 'JOURNAL_POST',
  'COA_READ', 'PERIOD_READ', 'REPORT_READ'
)
ON CONFLICT (role_id, permission_id, effective_from) DO NOTHING;

-- 5. EMPLOYEE PERMISSIONS
INSERT INTO core.role_permissions (role_id, permission_id, data_scope)
VALUES
  ((SELECT id FROM core.roles WHERE name = 'EMPLOYEE'), (SELECT id FROM core.permissions WHERE code = 'EXPENSE_CREATE'), 'OWN'),
  ((SELECT id FROM core.roles WHERE name = 'EMPLOYEE'), (SELECT id FROM core.permissions WHERE code = 'EXPENSE_READ'), 'OWN'),
  ((SELECT id FROM core.roles WHERE name = 'EMPLOYEE'), (SELECT id FROM core.permissions WHERE code = 'EXPENSE_UPDATE'), 'OWN'),
  ((SELECT id FROM core.roles WHERE name = 'EMPLOYEE'), (SELECT id FROM core.permissions WHERE code = 'INCOME_READ'), 'ALL')
ON CONFLICT (role_id, permission_id, effective_from) DO NOTHING;

-- 6. PROFILES TABLE SYNC (Fallback ke liye)
UPDATE public.profiles p
SET role = r.name
FROM core.user_roles ur
JOIN core.roles r ON r.id = ur.role_id
WHERE p.user_id = ur.user_id AND ur.is_active = true;


SELECT 
  r.name as role_code, 
  r.display_name, 
  COUNT(rp.permission_id) as total_permissions 
FROM core.roles r
LEFT JOIN core.role_permissions rp ON rp.role_id = r.id
GROUP BY r.name, r.display_name
ORDER BY r.level DESC;