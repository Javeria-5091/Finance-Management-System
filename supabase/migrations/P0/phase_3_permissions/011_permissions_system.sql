-- ==========================================
-- PHASE 3 - STEP 3.1 & 3.2: Permissions, Roles, and Mappings
-- ==========================================

-- 1. PERMISSIONS TABLE
CREATE TABLE IF NOT EXISTS core.permissions (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    code TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    module TEXT NOT NULL,
    action TEXT NOT NULL,
    description TEXT,
    is_system BOOLEAN DEFAULT false,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL
);

-- 2. ROLES TABLE
CREATE TABLE IF NOT EXISTS core.roles (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    description TEXT,
    is_system BOOLEAN DEFAULT false,
    level INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL
);

-- 3. ROLE_PERMISSIONS TABLE (The Matrix)
CREATE TABLE IF NOT EXISTS core.role_permissions (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    role_id UUID NOT NULL REFERENCES core.roles(id) ON DELETE CASCADE,
    permission_id UUID NOT NULL REFERENCES core.permissions(id) ON DELETE CASCADE,
    data_scope TEXT NOT NULL DEFAULT 'ALL' CHECK (data_scope IN ('OWN', 'DEPARTMENT', 'PROJECT', 'ALL')),
    amount_limit NUMERIC(18,2), -- NULL means unlimited
    effective_from DATE NOT NULL DEFAULT CURRENT_DATE,
    effective_to DATE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    CONSTRAINT rp_unique UNIQUE (role_id, permission_id, effective_from)
);

-- 4. USER_ROLES TABLE
CREATE TABLE IF NOT EXISTS core.user_roles (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    role_id UUID NOT NULL REFERENCES core.roles(id) ON DELETE CASCADE,
    effective_from DATE NOT NULL DEFAULT CURRENT_DATE,
    effective_to DATE,
    delegated_from UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    CONSTRAINT ur_user_role_unique UNIQUE (user_id, role_id, effective_from)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_perm_code ON core.permissions(code);
CREATE INDEX IF NOT EXISTS idx_rp_role ON core.role_permissions(role_id);
CREATE INDEX IF NOT EXISTS idx_ur_user ON core.user_roles(user_id);
CREATE INDEX IF NOT EXISTS idx_ur_role ON core.user_roles(role_id);

-- ==========================================
-- SEED DATA: PERMISSIONS
-- ==========================================
INSERT INTO core.permissions (code, name, module, action, is_system) VALUES
-- Income Module
('INCOME_CREATE', 'Create Income', 'income', 'create', true),
('INCOME_READ', 'View Income', 'income', 'read', true),
('INCOME_UPDATE', 'Edit Income', 'income', 'update', true),
('INCOME_DELETE', 'Delete Income', 'income', 'delete', true),
('INCOME_SUBMIT', 'Submit Income', 'income', 'submit', true),
('INCOME_VERIFY', 'Verify Income', 'income', 'verify', true),
('INCOME_APPROVE', 'Approve Income', 'income', 'approve', true),
('INCOME_POST', 'Post Income to Ledger', 'income', 'post', true),
('INCOME_REVERSE', 'Reverse Posted Income', 'income', 'reverse', true),
('INCOME_EXPORT', 'Export Income', 'income', 'export', true),
-- Expense Module
('EXPENSE_CREATE', 'Create Expense', 'expense', 'create', true),
('EXPENSE_READ', 'View Expense', 'expense', 'read', true),
('EXPENSE_UPDATE', 'Edit Expense', 'expense', 'update', true),
('EXPENSE_DELETE', 'Delete Expense', 'expense', 'delete', true),
('EXPENSE_SUBMIT', 'Submit Expense', 'expense', 'submit', true),
('EXPENSE_VERIFY', 'Verify Expense', 'expense', 'verify', true),
('EXPENSE_APPROVE', 'Approve Expense', 'expense', 'approve', true),
('EXPENSE_POST', 'Post Expense to Ledger', 'expense', 'post', true),
('EXPENSE_REVERSE', 'Reverse Posted Expense', 'expense', 'reverse', true),
('EXPENSE_EXPORT', 'Export Expense', 'expense', 'export', true),
-- Journal Module
('JOURNAL_CREATE', 'Create Journal Entry', 'journal', 'create', true),
('JOURNAL_READ', 'View Journal Entry', 'journal', 'read', true),
('JOURNAL_UPDATE', 'Edit Journal Entry', 'journal', 'update', true),
('JOURNAL_DELETE', 'Delete Journal Entry', 'journal', 'delete', true),
('JOURNAL_SUBMIT', 'Submit Journal', 'journal', 'submit', true),
('JOURNAL_VERIFY', 'Verify Journal', 'journal', 'verify', true),
('JOURNAL_APPROVE', 'Approve Journal', 'journal', 'approve', true),
('JOURNAL_POST', 'Post Journal to Ledger', 'journal', 'post', true),
('JOURNAL_REVERSE', 'Reverse Journal', 'journal', 'reverse', true),
('JOURNAL_EXPORT', 'Export Journal', 'journal', 'export', true),
-- Accounting Module
('COA_READ', 'View Chart of Accounts', 'accounting', 'read', true),
('COA_MANAGE', 'Manage Chart of Accounts', 'accounting', 'manage', true),
('PERIOD_READ', 'View Fiscal Calendar', 'accounting', 'read', true),
('PERIOD_CLOSE', 'Close Accounting Period', 'accounting', 'close', true),
('PERIOD_REOPEN', 'Reopen Accounting Period', 'accounting', 'reopen', true),
-- Reports Module
('REPORT_READ', 'View Reports', 'reports', 'read', true),
('REPORT_EXPORT', 'Export Reports', 'reports', 'export', true),
-- Admin Module
('ADMIN_USERS', 'Manage Users & Roles', 'admin', 'manage', true),
('ADMIN_AUDIT', 'View Audit Log', 'admin', 'audit', true),
('ADMIN_CONFIG', 'Change Organization Config', 'admin', 'config', true)
ON CONFLICT (code) DO NOTHING;

-- ==========================================
-- SEED DATA: ROLES
-- ==========================================
INSERT INTO core.roles (name, display_name, description, is_system, level) VALUES
('CEO', 'CEO / Founder', 'Full access. Final approvals.', true, 100),
('FINANCE_HEAD', 'Finance Head / CFO', 'Company-wide finance management.', true, 90),
('ACCOUNTANT', 'Accountant', 'Create, verify, post transactions.', true, 70),
('HOD', 'Head of Department', 'Department level management.', true, 50),
('PROJECT_MANAGER', 'Project Manager', 'Project level view.', true, 40),
('EMPLOYEE', 'Employee', 'Submit own expenses.', true, 20),
('VIEWER', 'Viewer', 'Read-only access.', true, 10)
ON CONFLICT (name) DO NOTHING;

-- ==========================================
-- SEED DATA: CEO GETS ALL PERMISSIONS
-- ==========================================
INSERT INTO core.role_permissions (role_id, permission_id, data_scope, amount_limit)
SELECT 
  (SELECT id FROM core.roles WHERE name = 'CEO'),
  id, 'ALL', NULL
FROM core.permissions
ON CONFLICT (role_id, permission_id, effective_from) DO NOTHING;

-- ==========================================
-- MIGRATE OLD PROFILES TO NEW USER_ROLES
-- ==========================================
-- Maps old boolean role to new system
INSERT INTO core.user_roles (user_id, role_id, created_by)
SELECT 
  p.user_id, 
  (SELECT id FROM core.roles WHERE name = 
    CASE 
      WHEN p.role IN ('Admin', 'CEO') THEN 'CEO'
      WHEN p.role = 'HOD' THEN 'FINANCE_HEAD'
      WHEN p.role = 'Program Manager' THEN 'ACCOUNTANT'
      WHEN p.role = 'Project Manager' THEN 'PROJECT_MANAGER'
      ELSE 'EMPLOYEE'
    END
  ),
  p.user_id
FROM public.profiles p
WHERE NOT EXISTS (
  SELECT 1 FROM core.user_roles ur WHERE ur.user_id = p.user_id
)
ON CONFLICT (user_id, role_id, effective_from) DO NOTHING;