

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
-- 4. DASHBOARD RPC FUNCTIONS (Real Data)
-- Yeh sirf data aggregate karte hain, RLS already filter karega
-- ==========================================

-- CEO Dashboard KPIs
CREATE OR REPLACE FUNCTION reporting.ceo_dashboard_kpis()
RETURNS JSON AS $$ DECLARE
  v_period_id UUID;
BEGIN
  SELECT id INTO v_period_id FROM finance.accounting_periods WHERE status = 'OPEN' ORDER BY start_date DESC LIMIT 1;
  
  RETURN json_build_object(
    'reconciled_cash', COALESCE((SELECT SUM(opening_balance) FROM finance.financial_accounts WHERE is_active = true), 0),
    'net_profit_mtd', COALESCE((
      SELECT SUM(CASE WHEN ca.normal_balance = 'CREDIT' THEN jl.credit_amount - jl.debit_amount ELSE jl.debit_amount - jl.credit_amount END)
      FROM finance.journal_lines jl
      JOIN finance.chart_of_accounts ca ON ca.id = jl.account_id
      JOIN finance.journal_entries je ON je.id = jl.journal_entry_id
      WHERE je.period_id = v_period_id AND je.status = 'POSTED'
        AND ca.account_type IN ('REVENUE','COST_OF_SALES','OPERATING_EXPENSE','OTHER_INCOME','OTHER_EXPENSE')
    ), 0),
    'revenue_mtd', COALESCE((
      SELECT SUM(jl.credit_amount - jl.debit_amount)
      FROM finance.journal_lines jl JOIN finance.chart_of_accounts ca ON ca.id = jl.account_id
      JOIN finance.journal_entries je ON je.id = jl.journal_entry_id
      WHERE je.period_id = v_period_id AND je.status = 'POSTED' AND ca.account_type = 'REVENUE'
    ), 0),
    'expenses_mtd', COALESCE((
      SELECT SUM(jl.debit_amount - jl.credit_amount)
      FROM finance.journal_lines jl JOIN finance.chart_of_accounts ca ON ca.id = jl.account_id
      JOIN finance.journal_entries je ON je.id = jl.journal_entry_id
      WHERE je.period_id = v_period_id AND je.status = 'POSTED'
        AND ca.account_type IN ('COST_OF_SALES','OPERATING_EXPENSE','OTHER_EXPENSE')
    ), 0),
    'accounts_receivable', COALESCE((SELECT SUM(COALESCE(outstanding_amount, 0)) FROM public.invoices WHERE status IN ('ISSUED','PARTIALLY_PAID','OVERDUE')), 0),
    'accounts_payable', COALESCE((SELECT SUM(COALESCE(outstanding_amount, 0)) FROM finance.vendor_bills WHERE status IN ('POSTED','PARTIALLY_PAID')), 0),
    'reserve_balance', COALESCE((SELECT SUM(jl.credit_amount - jl.debit_amount) FROM finance.journal_lines jl JOIN finance.chart_of_accounts ca ON ca.id = jl.account_id WHERE ca.code LIKE '33%' AND ca.is_active = true), 0),
    'pending_approvals', (
      COALESCE((SELECT COUNT(*) FROM public.invoices WHERE status = 'SUBMITTED'), 0) +
      COALESCE((SELECT COUNT(*) FROM finance.vendor_bills WHERE status IN ('SUBMITTED','VERIFIED')), 0) +
      COALESCE((SELECT COUNT(*) FROM public.expenses WHERE status = 'SUBMITTED'), 0)
    ),
    'unreconciled_lines', COALESCE((SELECT COUNT(*) FROM finance.statement_lines WHERE reconciliation_status = 'UNRECONCILED'), 0)
  );
END;
 $$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

-- Pending Approvals List
CREATE OR REPLACE FUNCTION reporting.pending_approvals_list()
RETURNS JSON AS $$ BEGIN
  RETURN COALESCE(json_agg(row_to_json(t)), '[]'::JSON) FROM (
    SELECT id, 'INVOICE' as module_type, invoice_number as reference, client_name as description, total_amount as amount, created_by, created_at, 'high' as urgency
    FROM public.invoices WHERE status = 'SUBMITTED'
    UNION ALL
    SELECT id, 'VENDOR_BILL' as module_type, bill_number as reference, COALESCE((SELECT name FROM finance.vendors v WHERE v.id = vb.vendor_id), 'Unknown'), total_amount, created_by, created_at, 'medium' as urgency
    FROM finance.vendor_bills vb WHERE status IN ('SUBMITTED','VERIFIED')
    UNION ALL
    SELECT id, 'EXPENSE' as module_type, title as reference, category, amount, created_by, created_at, 'low' as urgency
    FROM public.expenses WHERE status = 'SUBMITTED'
    ORDER BY created_at DESC LIMIT 20
  ) t;
END;
 $$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

-- Unreconciled Summary
CREATE OR REPLACE FUNCTION reporting.unreconciled_summary()
RETURNS JSON AS $$ BEGIN
  RETURN COALESCE(json_agg(row_to_json(t)), '[]'::JSON) FROM (
    SELECT fa.id as account_id, fa.account_name, fa.institution_type, COUNT(sl.id) as unreconciled_count, COALESCE(SUM(sl.amount), 0) as unreconciled_amount, MAX(bs.statement_date) as last_statement_date
    FROM finance.financial_accounts fa
    LEFT JOIN finance.bank_statements bs ON bs.financial_account_id = fa.id
    LEFT JOIN finance.statement_lines sl ON sl.bank_statement_id = bs.id AND sl.reconciliation_status = 'UNRECONCILED'
    WHERE fa.is_active = true GROUP BY fa.id, fa.account_name, fa.institution_type HAVING COUNT(sl.id) > 0
  ) t;
END;
 $$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

-- Project Profitability
CREATE OR REPLACE FUNCTION reporting.project_profitability()
RETURNS JSON AS $$ BEGIN
  RETURN COALESCE(json_agg(row_to_json(t)), '[]'::JSON) FROM (
    SELECT p.id, p.name as project_name, p.client_name,
      COALESCE(inv.total_revenue, 0) as revenue, COALESCE(exp.total_costs, 0) as costs,
      COALESCE(inv.total_revenue, 0) - COALESCE(exp.total_costs, 0) as gross_profit,
      CASE WHEN COALESCE(inv.total_revenue, 0) > 0 THEN ROUND(((COALESCE(inv.total_revenue, 0) - COALESCE(exp.total_costs, 0)) / COALESCE(inv.total_revenue, 0)) * 100, 1) ELSE 0 END as margin,
      p.status
    FROM public.projects p
    LEFT JOIN (SELECT project_id, SUM(base_total_amount) as total_revenue FROM public.invoices WHERE status NOT IN ('DRAFT','VOID','REVERSED') GROUP BY project_id) inv ON inv.project_id = p.id
    LEFT JOIN (SELECT project_id, SUM(amount) as total_costs FROM public.expenses WHERE status NOT IN ('REJECTED') GROUP BY project_id) exp ON exp.project_id = p.id
    ORDER BY (COALESCE(inv.total_revenue, 0) - COALESCE(exp.total_costs, 0)) DESC LIMIT 10
  ) t;
END;
 $$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

-- Aging Summary
CREATE OR REPLACE FUNCTION reporting.receivable_aging_summary()
RETURNS JSON AS $$ DECLARE v_result JSON;
BEGIN
  SELECT json_build_object(
    'current', COALESCE((SELECT SUM(current_amount) FROM reporting.receivable_aging), 0),
    'overdue_1_30', COALESCE((SELECT SUM(overdue_1_30_days) FROM reporting.receivable_aging), 0),
    'overdue_31_60', COALESCE((SELECT SUM(overdue_31_60_days) FROM reporting.receivable_aging), 0),
    'overdue_61_90', COALESCE((SELECT SUM(overdue_61_90_days) FROM reporting.receivable_aging), 0),
    'overdue_over_90', COALESCE((SELECT SUM(overdue_over_90_days) FROM reporting.receivable_aging), 0),
    'total', COALESCE((SELECT SUM(outstanding_base_amount) FROM reporting.receivable_aging), 0)
  ) INTO v_result;
  RETURN v_result;
END;
 $$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

-- Cash Distribution
CREATE OR REPLACE FUNCTION reporting.cash_distribution()
RETURNS JSON AS $$ BEGIN
  RETURN COALESCE(json_agg(row_to_json(t)), '[]'::JSON) FROM (
    SELECT id, account_name, institution_type, currency, masked_identifier, opening_balance as balance
    FROM finance.financial_accounts WHERE is_active = true ORDER BY opening_balance DESC
  ) t;
END;
 $$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

-- Revenue vs Expenses Monthly
CREATE OR REPLACE FUNCTION reporting.revenue_expense_monthly()
RETURNS JSON AS $$ BEGIN
  RETURN COALESCE(json_agg(row_to_json(t)), '[]'::JSON) FROM (
    SELECT TO_CHAR(ap.start_date, 'Mon YYYY') as month, TO_CHAR(ap.start_date, 'YY-MM') as month_short,
      COALESCE(SUM(CASE WHEN ca.account_type = 'REVENUE' THEN jl.credit_amount - jl.debit_amount ELSE 0 END), 0) as revenue,
      COALESCE(SUM(CASE WHEN ca.account_type IN ('COST_OF_SALES','OPERATING_EXPENSE','OTHER_EXPENSE') THEN jl.debit_amount - jl.credit_amount ELSE 0 END), 0) as expenses
    FROM finance.accounting_periods ap
    LEFT JOIN finance.journal_entries je ON je.period_id = ap.id AND je.status = 'POSTED'
    LEFT JOIN finance.journal_lines jl ON jl.journal_entry_id = je.id
    LEFT JOIN finance.chart_of_accounts ca ON ca.id = jl.account_id
    WHERE ap.start_date >= CURRENT_DATE - INTERVAL '6 months'
    GROUP BY ap.id, ap.start_date ORDER BY ap.start_date LIMIT 6
  ) t;
END;
 $$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

-- ==========================================
-- VERIFICATION QUERY (Run separately to check)
-- ==========================================
-- SELECT r.display_name as role, COUNT(rp.permission_id) as total_permissions
-- FROM core.roles r LEFT JOIN core.role_permissions rp ON rp.role_id = r.id
-- GROUP BY r.display_name ORDER BY MIN(r.level) DESC;