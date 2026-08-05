

-- Disable triggers during bulk insert
ALTER TABLE core.permissions DISABLE TRIGGER USER;
ALTER TABLE core.role_permissions DISABLE TRIGGER USER;

-- ==========================================
-- 1. ADD MISSING PERMISSIONS (Invoices, Bills, Projects, etc.)
-- ==========================================
INSERT INTO core.permissions (code, name, module, action, is_system, description)
VALUES
  -- INVOICE / AR MODULE
  ('INVOICE_CREATE',   'Create Invoice',              'invoice',      'create',   true, 'Create sales invoices and credit notes'),
  ('INVOICE_READ',     'View Invoices',               'invoice',      'read',     true, 'View invoice list and details'),
  ('INVOICE_UPDATE',   'Edit Invoice',                'invoice',      'update',   true, 'Edit draft invoices'),
  ('INVOICE_DELETE',   'Delete Invoice',              'invoice',      'delete',   true, 'Delete draft invoices'),
  ('INVOICE_SUBMIT',  'Submit Invoice',              'invoice',      'submit',   true, 'Submit invoice for verification'),
  ('INVOICE_VERIFY',  'Verify Invoice',              'invoice',      'verify',   true, 'Verify invoice coding and amounts'),
  ('INVOICE_APPROVE', 'Approve Invoice',             'invoice',      'approve',  true, 'Approve invoice for issuance'),
  ('INVOICE_POST',    'Post Invoice to Ledger',      'invoice',      'post',     true, 'Post approved invoice to GL'),
  ('INVOICE_REVERSE', 'Reverse Posted Invoice',      'invoice',      'reverse',  true, 'Reverse a posted invoice'),
  ('INVOICE_EXPORT',  'Export Invoices',             'invoice',      'export',   true, 'Export invoice list to CSV/Excel'),

  -- VENDOR / AP MODULE
  ('VENDOR_CREATE',   'Create Vendor',              'vendor',      'create',   true, 'Add new vendor master record'),
  ('VENDOR_READ',     'View Vendors',               'vendor',      'read',     true, 'View vendor list and details'),
  ('VENDOR_UPDATE',   'Edit Vendor',                'vendor',      'update',   true, 'Update vendor information'),
  ('VENDOR_DELETE',   'Deactivate Vendor',          'vendor',      'delete',   true, 'Deactivate vendor record'),

  -- VENDOR BILLS
  ('VENDOR_BILL_CREATE',   'Create Vendor Bill',       'vendor_bill', 'create',   true, 'Enter vendor bill with line items'),
  ('VENDOR_BILL_READ',     'View Vendor Bills',        'vendor_bill', 'read',     true, 'View bill list and details'),
  ('VENDOR_BILL_UPDATE',   'Edit Vendor Bill',         'vendor_bill', 'update',   true, 'Edit draft bills'),
  ('VENDOR_BILL_DELETE',   'Delete Vendor Bill',       'vendor_bill', 'delete',   true, 'Delete draft bills'),
  ('VENDOR_BILL_SUBMIT',  'Submit Vendor Bill',       'vendor_bill', 'submit',   true, 'Submit bill for verification'),
  ('VENDOR_BILL_VERIFY',  'Verify Vendor Bill',       'vendor_bill', 'verify',   true, 'Verify bill coding and amounts'),
  ('VENDOR_BILL_APPROVE', 'Approve Vendor Bill',      'vendor_bill', 'approve',  true, 'Approve bill for payment'),
  ('VENDOR_BILL_POST',    'Post Vendor Bill to GL',   'vendor_bill', 'post',     true, 'Post approved bill to GL'),
  ('VENDOR_BILL_REVERSE', 'Reverse Posted Bill',      'vendor_bill', 'reverse',  true, 'Reverse a posted bill'),

  -- VENDOR PAYMENTS
  ('VENDOR_PAYMENT_CREATE',  'Create Vendor Payment',   'vendor_payment', 'create',  true, 'Create payment to vendor'),
  ('VENDOR_PAYMENT_READ',    'View Vendor Payments',    'vendor_payment', 'read',    true, 'View payment list'),
  ('VENDOR_PAYMENT_UPDATE',  'Edit Vendor Payment',    'vendor_payment', 'update',  true, 'Edit draft payment'),
  ('VENDOR_PAYMENT_APPROVE', 'Approve Vendor Payment',   'vendor_payment', 'approve', true, 'Approve payment for posting'),
  ('VENDOR_PAYMENT_POST',    'Post Vendor Payment',    'vendor_payment', 'post',    true, 'Post payment to GL'),

  -- PAYMENT RECEIPTS
  ('PAYMENT_RECEIPT_CREATE', 'Create Payment Receipt',  'payment_receipt', 'create', true, 'Record client payment received'),
  ('PAYMENT_RECEIPT_READ',   'View Payment Receipts',  'payment_receipt', 'read',   true, 'View receipt list'),
  ('PAYMENT_RECEIPT_UPDATE', 'Edit Payment Receipt',  'payment_receipt', 'update', true, 'Edit draft receipt'),
  ('PAYMENT_RECEIPT_POST',   'Post Payment Receipt',   'payment_receipt', 'post',   true, 'Post receipt to GL'),

  -- CREDIT NOTES
  ('CREDIT_NOTE_CREATE', 'Create Credit Note',         'credit_note', 'create', true, 'Create credit note for invoice adjustment'),
  ('CREDIT_NOTE_READ',   'View Credit Notes',         'credit_note', 'read',   true, 'View credit note list'),
  ('CREDIT_NOTE_UPDATE', 'Edit Credit Note',           'credit_note', 'update', true, 'Edit draft credit note'),
  ('CREDIT_NOTE_POST',   'Post Credit Note to GL',     'credit_note', 'post',   true, 'Post credit note to GL'),

  -- PROJECT MODULE
  ('PROJECT_CREATE', 'Create Project',               'project', 'create', true, 'Create new project with client and budget'),
  ('PROJECT_READ',   'View Projects',               'project', 'read',   true, 'View project list and details'),
  ('PROJECT_UPDATE', 'Edit Project',                'project', 'update', true, 'Update project information'),
  ('PROJECT_DELETE', 'Delete Project',              'project', 'delete', true, 'Delete/Archive project'),

  -- BUDGET MODULE
  ('BUDGET_CREATE',  'Create Budget',               'budget', 'create', true, 'Create annual/project/department budget'),
  ('BUDGET_READ',    'View Budgets',               'budget', 'read',   true, 'View budget list and variance reports'),
  ('BUDGET_UPDATE',  'Edit Budget',                'budget', 'update', true, 'Edit budget amounts and revisions'),
  ('BUDGET_DELETE',  'Delete Budget',              'budget', 'delete', true, 'Delete budget'),
  ('BUDGET_APPROVE', 'Approve Budget',             'budget', 'approve', true, 'Approve budget for activation'),

  -- BANK TRANSFER (specific, separate from general BANK_POST)
  ('BANK_TRANSFER',  'Create Bank Transfer',       'banking', 'create', true, 'Transfer between financial accounts'),
  ('BANK_TRANSFER_APPROVE', 'Approve Bank Transfer','banking', 'approve', true, 'Approve high-value or cross-currency transfers')
ON CONFLICT (code) DO NOTHING;

-- Re-enable triggers
ALTER TABLE core.permissions ENABLE TRIGGER USER;
ALTER TABLE core.role_permissions ENABLE TRIGGER USER;

-- ==========================================
-- 2. ADD MISSING ROLE-PERMISSION MAPPINGS
-- ==========================================

-- Disable triggers again for mappings
ALTER TABLE core.role_permissions DISABLE TRIGGER USER;

-- CEO: ALL new permissions
INSERT INTO core.role_permissions (role_id, permission_id, data_scope, amount_limit)
SELECT r.id, p.id, 'ALL', NULL
FROM core.roles r CROSS JOIN core.permissions p
WHERE r.name = 'CEO'
  AND p.code LIKE 'INVOICE_%'
  OR p.code LIKE 'VENDOR_%'
  OR p.code LIKE 'PAYMENT_RECEIPT_%'
  OR p.code LIKE 'CREDIT_NOTE_%'
  OR p.code LIKE 'PROJECT_%'
  OR p.code LIKE 'BUDGET_%'
  OR p.code = 'BANK_TRANSFER'
  OR p.code = 'BANK_TRANSFER_APPROVE'
ON CONFLICT (role_id, permission_id, effective_from) DO NOTHING;

-- FINANCE HEAD: ALL new permissions
INSERT INTO core.role_permissions (role_id, permission_id, data_scope, amount_limit)
SELECT r.id, p.id, 'ALL', NULL
FROM core.roles r CROSS JOIN core.permissions p
WHERE r.name = 'FINANCE_HEAD'
  AND p.code LIKE 'INVOICE_%'
  OR p.code LIKE 'VENDOR_%'
  OR p.code LIKE 'PAYMENT_RECEIPT_%'
  OR p.code LIKE 'CREDIT_NOTE_%'
  OR p.code LIKE 'PROJECT_%'
  OR p.code LIKE 'BUDGET_%'
  OR p.code = 'BANK_TRANSFER'
  OR p.code = 'BANK_TRANSFER_APPROVE'
ON CONFLICT (role_id, permission_id, effective_from) DO NOTHING;

-- ACCOUNTANT: Create/Read/Update/Submit/Verify/Post for transactional, Read for others
INSERT INTO core.role_permissions (role_id, permission_id, data_scope, amount_limit)
SELECT r.id, p.id, 'ALL', NULL
FROM core.roles r CROSS JOIN core.permissions p
WHERE r.name = 'ACCOUNTANT'
  AND (
    p.code IN ('INVOICE_CREATE','INVOICE_READ','INVOICE_UPDATE','INVOICE_SUBMIT','INVOICE_VERIFY','INVOICE_POST',
               'VENDOR_CREATE','VENDOR_READ','VENDOR_UPDATE',
               'VENDOR_BILL_CREATE','VENDOR_BILL_READ','VENDOR_BILL_UPDATE','VENDOR_BILL_SUBMIT','VENDOR_BILL_VERIFY','VENDOR_BILL_POST',
               'VENDOR_PAYMENT_CREATE','VENDOR_PAYMENT_READ','VENDOR_PAYMENT_UPDATE',
               'PAYMENT_RECEIPT_CREATE','PAYMENT_RECEIPT_READ','PAYMENT_RECEIPT_UPDATE','PAYMENT_RECEIPT_POST',
               'CREDIT_NOTE_CREATE','CREDIT_NOTE_READ','CREDIT_NOTE_UPDATE','CREDIT_NOTE_POST',
               'PROJECT_READ','BUDGET_READ')
  )
ON CONFLICT (role_id, permission_id, effective_from) DO NOTHING;

-- HOD: Read for invoices/bills/projects/budgets, own expense approve
INSERT INTO core.role_permissions (role_id, permission_id, data_scope, amount_limit)
SELECT r.id, p.id, 'ALL', NULL
FROM core.roles r CROSS JOIN core.permissions p
WHERE r.name = 'HOD'
  AND p.code IN ('INVOICE_READ','VENDOR_BILL_READ','VENDOR_PAYMENT_READ','PROJECT_READ','BUDGET_READ')
ON CONFLICT (role_id, permission_id, effective_from) DO NOTHING;

-- PROJECT MANAGER: Read invoices/bills/expenses for projects
INSERT INTO core.role_permissions (role_id, permission_id, data_scope, amount_limit)
SELECT r.id, p.id, 'PROJECT', NULL
FROM core.roles r CROSS JOIN core.permissions p
WHERE r.name = 'PROJECT_MANAGER'
  AND p.code IN ('INVOICE_READ','VENDOR_BILL_READ','EXPENSE_READ','PROJECT_READ','BUDGET_READ')
ON CONFLICT (role_id, permission_id, effective_from) DO NOTHING;

-- EMPLOYEE: Read own invoices
INSERT INTO core.role_permissions (role_id, permission_id, data_scope, amount_limit)
SELECT r.id, p.id, 'OWN', NULL
FROM core.roles r CROSS JOIN core.permissions p
WHERE r.name = 'EMPLOYEE'
  AND p.code IN ('INVOICE_READ')
ON CONFLICT (role_id, permission_id, effective_from) DO NOTHING;

-- Re-enable triggers
ALTER TABLE core.role_permissions ENABLE TRIGGER USER;

CREATE OR REPLACE FUNCTION public.get_my_permissions()
RETURNS JSON AS $$ DECLARE
  v_result JSON := '{}'::JSON;
  v_role_name TEXT;
  v_max_limit NUMERIC(18,2);
BEGIN
  -- Get role name
  SELECT r.display_name INTO v_role_name
  FROM core.user_roles ur
  JOIN core.roles r ON r.id = ur.role_id
  WHERE ur.user_id = auth.uid() AND ur.is_active = true
    AND (ur.effective_to IS NULL OR ur.effective_to >= CURRENT_DATE)
  ORDER BY r.level DESC
  LIMIT 1;

  -- Get max approval limit across all roles
  SELECT COALESCE(MAX(rp.amount_limit), 0) INTO v_max_limit
  FROM core.user_roles ur
  JOIN core.role_permissions rp ON rp.role_id = ur.role_id
  WHERE ur.user_id = auth.uid() AND ur.is_active = true
    AND (ur.effective_to IS NULL OR ur.effective_to >= CURRENT_DATE)
    AND rp.amount_limit IS NOT NULL;

  -- Build flat permission object from core.get_user_permissions()
  SELECT json_object_agg(code, true) INTO v_result
  FROM core.get_user_permissions(auth.uid());

  -- Add role and limit
  v_result := json_build_object(
    'role', COALESCE(v_role_name, 'User'),
    'approval_limit', v_max_limit
  ) || v_result;

  RETURN v_result;
END;
 $$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

-- ==========================================
-- VERIFICATION QUERY (Run separately to check)
-- ==========================================
-- SELECT r.display_name as role, COUNT(rp.permission_id) as total_permissions
-- FROM core.roles r LEFT JOIN core.role_permissions rp ON rp.role_id = r.id
-- GROUP BY r.display_name ORDER BY MIN(r.level) DESC;