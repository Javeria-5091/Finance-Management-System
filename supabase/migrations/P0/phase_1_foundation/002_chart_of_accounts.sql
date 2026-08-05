-- ==========================================
-- PHASE 1 - STEP 1.3: Chart of Accounts
-- FINAL CORRECTED VERSION
-- ==========================================

-- Purani table aur views delete karo (Fresh start)
DROP VIEW IF EXISTS finance.account_type_summary CASCADE;
DROP VIEW IF EXISTS finance.postable_accounts CASCADE;
DROP VIEW IF EXISTS finance.coa_tree CASCADE;
DROP TABLE IF EXISTS finance.chart_of_accounts CASCADE;

-- ==========================================
-- TABLE CREATION
-- ==========================================
CREATE TABLE finance.chart_of_accounts (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    
    code TEXT NOT NULL,
    name TEXT NOT NULL,
    parent_id UUID REFERENCES finance.chart_of_accounts(id) ON DELETE SET NULL,
    
    account_type TEXT NOT NULL CHECK (account_type IN (
        'ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 
        'COST_OF_SALES', 'OPERATING_EXPENSE', 
        'OTHER_INCOME', 'OTHER_EXPENSE'
    )),
    
    normal_balance TEXT NOT NULL CHECK (normal_balance IN ('DEBIT', 'CREDIT')),
    currency TEXT DEFAULT 'PKR',
    is_active BOOLEAN DEFAULT true,
    posting_allowed BOOLEAN DEFAULT true,
    is_control_account BOOLEAN DEFAULT false,
    report_mapping TEXT,
    description TEXT,
    display_order INTEGER DEFAULT 0,
    level INTEGER DEFAULT 0 CHECK (level BETWEEN 0 AND 10),
    
    CONSTRAINT coa_code_unique UNIQUE (code),
    CONSTRAINT coa_name_not_empty CHECK (TRIM(name) != ''),
    CONSTRAINT coa_level_0_no_parent CHECK (
        (level = 0 AND parent_id IS NULL) OR (level > 0)
    )
);

-- Indexes
CREATE INDEX idx_coa_code ON finance.chart_of_accounts(code);
CREATE INDEX idx_coa_account_type ON finance.chart_of_accounts(account_type);
CREATE INDEX idx_coa_parent_id ON finance.chart_of_accounts(parent_id);
CREATE INDEX idx_coa_is_active ON finance.chart_of_accounts(is_active);
CREATE INDEX idx_coa_level ON finance.chart_of_accounts(level);

-- Trigger
CREATE TRIGGER coa_updated_at
    BEFORE UPDATE ON finance.chart_of_accounts
    FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();

-- ==========================================
-- SEED DATA - LEVEL 0 (Root Categories)
-- ==========================================
INSERT INTO finance.chart_of_accounts (
    code, name, account_type, normal_balance, level, 
    is_control_account, display_order, created_by
) VALUES
('1000', 'CURRENT ASSETS', 'ASSET', 'DEBIT', 0, false, 1, (SELECT id FROM auth.users LIMIT 1)),
('1500', 'NON-CURRENT ASSETS', 'ASSET', 'DEBIT', 0, false, 2, (SELECT id FROM auth.users LIMIT 1)),
('2000', 'CURRENT LIABILITIES', 'LIABILITY', 'CREDIT', 0, false, 3, (SELECT id FROM auth.users LIMIT 1)),
('2500', 'NON-CURRENT LIABILITIES', 'LIABILITY', 'CREDIT', 0, false, 4, (SELECT id FROM auth.users LIMIT 1)),
('3000', 'EQUITY', 'EQUITY', 'CREDIT', 0, false, 5, (SELECT id FROM auth.users LIMIT 1)),
('4000', 'REVENUE', 'REVENUE', 'CREDIT', 0, false, 6, (SELECT id FROM auth.users LIMIT 1)),
('5000', 'COST OF SALES', 'COST_OF_SALES', 'DEBIT', 0, false, 7, (SELECT id FROM auth.users LIMIT 1)),
('6000', 'OPERATING EXPENSES', 'OPERATING_EXPENSE', 'DEBIT', 0, false, 8, (SELECT id FROM auth.users LIMIT 1)),
('7000', 'OTHER INCOME', 'OTHER_INCOME', 'CREDIT', 0, false, 9, (SELECT id FROM auth.users LIMIT 1)),
('7100', 'OTHER EXPENSES', 'OTHER_EXPENSE', 'DEBIT', 0, false, 10, (SELECT id FROM auth.users LIMIT 1));

-- ==========================================
-- SEED DATA - LEVEL 1 (Sub-Categories)
-- ==========================================
INSERT INTO finance.chart_of_accounts (
    code, name, account_type, normal_balance, level, parent_id, 
    is_control_account, display_order, created_by
) VALUES
-- Current Assets Children
('1100', 'Cash & Bank', 'ASSET', 'DEBIT', 1, (SELECT id FROM finance.chart_of_accounts WHERE code='1000'), false, 1, (SELECT id FROM auth.users LIMIT 1)),
('1200', 'Accounts Receivable', 'ASSET', 'DEBIT', 1, (SELECT id FROM finance.chart_of_accounts WHERE code='1000'), true, 2, (SELECT id FROM auth.users LIMIT 1)),
('1300', 'Advances & Prepayments', 'ASSET', 'DEBIT', 1, (SELECT id FROM finance.chart_of_accounts WHERE code='1000'), false, 3, (SELECT id FROM auth.users LIMIT 1)),
('1400', 'Tax Receivables', 'ASSET', 'DEBIT', 1, (SELECT id FROM finance.chart_of_accounts WHERE code='1000'), true, 4, (SELECT id FROM auth.users LIMIT 1)),

-- Non-Current Assets Children
('1510', 'Fixed Assets', 'ASSET', 'DEBIT', 1, (SELECT id FROM finance.chart_of_accounts WHERE code='1500'), false, 5, (SELECT id FROM auth.users LIMIT 1)),
('1520', 'Intangible Assets', 'ASSET', 'DEBIT', 1, (SELECT id FROM finance.chart_of_accounts WHERE code='1500'), false, 6, (SELECT id FROM auth.users LIMIT 1)),
('1530', 'Accumulated Depreciation', 'ASSET', 'CREDIT', 1, (SELECT id FROM finance.chart_of_accounts WHERE code='1500'), true, 7, (SELECT id FROM auth.users LIMIT 1)),

-- Current Liabilities Children
('2100', 'Accounts Payable', 'LIABILITY', 'CREDIT', 1, (SELECT id FROM finance.chart_of_accounts WHERE code='2000'), true, 1, (SELECT id FROM auth.users LIMIT 1)),
('2200', 'Tax Payables', 'LIABILITY', 'CREDIT', 1, (SELECT id FROM finance.chart_of_accounts WHERE code='2000'), true, 2, (SELECT id FROM auth.users LIMIT 1)),
('2300', 'Payroll Payables', 'LIABILITY', 'CREDIT', 1, (SELECT id FROM finance.chart_of_accounts WHERE code='2000'), true, 3, (SELECT id FROM auth.users LIMIT 1)),
('2400', 'Owner Payables', 'LIABILITY', 'CREDIT', 1, (SELECT id FROM finance.chart_of_accounts WHERE code='2000'), false, 4, (SELECT id FROM auth.users LIMIT 1)),
('2600', 'Accrued Expenses', 'LIABILITY', 'CREDIT', 1, (SELECT id FROM finance.chart_of_accounts WHERE code='2000'), false, 5, (SELECT id FROM auth.users LIMIT 1)),

-- Non-Current Liabilities Children
('2510', 'Long-term Loans', 'LIABILITY', 'CREDIT', 1, (SELECT id FROM finance.chart_of_accounts WHERE code='2500'), false, 6, (SELECT id FROM auth.users LIMIT 1)),

-- Equity Children
('3100', 'Owner Capital', 'EQUITY', 'CREDIT', 1, (SELECT id FROM finance.chart_of_accounts WHERE code='3000'), false, 1, (SELECT id FROM auth.users LIMIT 1)),
('3200', 'Retained Earnings', 'EQUITY', 'CREDIT', 1, (SELECT id FROM finance.chart_of_accounts WHERE code='3000'), true, 2, (SELECT id FROM auth.users LIMIT 1)),
('3300', 'Reserves', 'EQUITY', 'CREDIT', 1, (SELECT id FROM finance.chart_of_accounts WHERE code='3000'), false, 3, (SELECT id FROM auth.users LIMIT 1)),
('3400', 'Current Year Profit/Loss', 'EQUITY', 'CREDIT', 1, (SELECT id FROM finance.chart_of_accounts WHERE code='3000'), true, 4, (SELECT id FROM auth.users LIMIT 1)),

-- Revenue Children
('4100', 'Service Revenue', 'REVENUE', 'CREDIT', 1, (SELECT id FROM finance.chart_of_accounts WHERE code='4000'), false, 1, (SELECT id FROM auth.users LIMIT 1)),
('4200', 'Other Income', 'REVENUE', 'CREDIT', 1, (SELECT id FROM finance.chart_of_accounts WHERE code='4000'), false, 2, (SELECT id FROM auth.users LIMIT 1)),

-- Cost of Sales Children
('5100', 'Direct Project Costs', 'COST_OF_SALES', 'DEBIT', 1, (SELECT id FROM finance.chart_of_accounts WHERE code='5000'), false, 1, (SELECT id FROM auth.users LIMIT 1)),
('5200', 'Platform Fees', 'COST_OF_SALES', 'DEBIT', 1, (SELECT id FROM finance.chart_of_accounts WHERE code='5000'), false, 2, (SELECT id FROM auth.users LIMIT 1)),

-- Operating Expenses Children
('6100', 'Software & Subscriptions', 'OPERATING_EXPENSE', 'DEBIT', 1, (SELECT id FROM finance.chart_of_accounts WHERE code='6000'), false, 1, (SELECT id FROM auth.users LIMIT 1)),
('6200', 'Office Expenses', 'OPERATING_EXPENSE', 'DEBIT', 1, (SELECT id FROM finance.chart_of_accounts WHERE code='6000'), false, 2, (SELECT id FROM auth.users LIMIT 1)),
('6300', 'Bank & Payment Charges', 'OPERATING_EXPENSE', 'DEBIT', 1, (SELECT id FROM finance.chart_of_accounts WHERE code='6000'), false, 3, (SELECT id FROM auth.users LIMIT 1)),
('6400', 'Professional Fees', 'OPERATING_EXPENSE', 'DEBIT', 1, (SELECT id FROM finance.chart_of_accounts WHERE code='6000'), false, 4, (SELECT id FROM auth.users LIMIT 1)),
('6500', 'Depreciation Expense', 'OPERATING_EXPENSE', 'DEBIT', 1, (SELECT id FROM finance.chart_of_accounts WHERE code='6000'), false, 5, (SELECT id FROM auth.users LIMIT 1)),
('6600', 'Travel & Transport', 'OPERATING_EXPENSE', 'DEBIT', 1, (SELECT id FROM finance.chart_of_accounts WHERE code='6000'), false, 6, (SELECT id FROM auth.users LIMIT 1)),
('6700', 'Marketing & Advertising', 'OPERATING_EXPENSE', 'DEBIT', 1, (SELECT id FROM finance.chart_of_accounts WHERE code='6000'), false, 7, (SELECT id FROM auth.users LIMIT 1)),

-- Other Income Children
('7010', 'Exchange Gain', 'OTHER_INCOME', 'CREDIT', 1, (SELECT id FROM finance.chart_of_accounts WHERE code='7000'), false, 1, (SELECT id FROM auth.users LIMIT 1)),
('7020', 'Interest Income', 'OTHER_INCOME', 'CREDIT', 1, (SELECT id FROM finance.chart_of_accounts WHERE code='7000'), false, 2, (SELECT id FROM auth.users LIMIT 1)),
('7030', 'Gain on Asset Disposal', 'OTHER_INCOME', 'CREDIT', 1, (SELECT id FROM finance.chart_of_accounts WHERE code='7000'), false, 3, (SELECT id FROM auth.users LIMIT 1)),

-- Other Expenses Children
('7110', 'Income Tax Expense', 'OTHER_EXPENSE', 'DEBIT', 1, (SELECT id FROM finance.chart_of_accounts WHERE code='7100'), false, 1, (SELECT id FROM auth.users LIMIT 1)),
('7120', 'Exchange Loss', 'OTHER_EXPENSE', 'DEBIT', 1, (SELECT id FROM finance.chart_of_accounts WHERE code='7100'), false, 2, (SELECT id FROM auth.users LIMIT 1)),
('7130', 'Loss on Asset Disposal', 'OTHER_EXPENSE', 'DEBIT', 1, (SELECT id FROM finance.chart_of_accounts WHERE code='7100'), false, 3, (SELECT id FROM auth.users LIMIT 1)),
('7140', 'Penalty & Fines', 'OTHER_EXPENSE', 'DEBIT', 1, (SELECT id FROM finance.chart_of_accounts WHERE code='7100'), false, 4, (SELECT id FROM auth.users LIMIT 1));

-- ==========================================
-- SEED DATA - LEVEL 2 (Detail Accounts)
-- ==========================================
INSERT INTO finance.chart_of_accounts (
    code, name, account_type, normal_balance, level, parent_id, 
    posting_allowed, report_mapping, display_order, created_by
) VALUES
-- ===== CASH & BANK (1100) =====
('1110', 'Bank Account - PKR', 'ASSET', 'DEBIT', 2, (SELECT id FROM finance.chart_of_accounts WHERE code='1100'), true, 'BALANCE_SHEET_CURRENT_ASSETS', 1, (SELECT id FROM auth.users LIMIT 1)),
('1120', 'JazzCash', 'ASSET', 'DEBIT', 2, (SELECT id FROM finance.chart_of_accounts WHERE code='1100'), true, 'BALANCE_SHEET_CURRENT_ASSETS', 2, (SELECT id FROM auth.users LIMIT 1)),
('1130', 'EasyPaisa', 'ASSET', 'DEBIT', 2, (SELECT id FROM finance.chart_of_accounts WHERE code='1100'), true, 'BALANCE_SHEET_CURRENT_ASSETS', 3, (SELECT id FROM auth.users LIMIT 1)),
('1140', 'Wise', 'ASSET', 'DEBIT', 2, (SELECT id FROM finance.chart_of_accounts WHERE code='1100'), true, 'BALANCE_SHEET_CURRENT_ASSETS', 4, (SELECT id FROM auth.users LIMIT 1)),
('1150', 'Payoneer', 'ASSET', 'DEBIT', 2, (SELECT id FROM finance.chart_of_accounts WHERE code='1100'), true, 'BALANCE_SHEET_CURRENT_ASSETS', 5, (SELECT id FROM auth.users LIMIT 1)),
('1160', 'Freelancer Platform', 'ASSET', 'DEBIT', 2, (SELECT id FROM finance.chart_of_accounts WHERE code='1100'), true, 'BALANCE_SHEET_CURRENT_ASSETS', 6, (SELECT id FROM auth.users LIMIT 1)),
('1170', 'Upwork Platform', 'ASSET', 'DEBIT', 2, (SELECT id FROM finance.chart_of_accounts WHERE code='1100'), true, 'BALANCE_SHEET_CURRENT_ASSETS', 7, (SELECT id FROM auth.users LIMIT 1)),
('1180', 'Petty Cash', 'ASSET', 'DEBIT', 2, (SELECT id FROM finance.chart_of_accounts WHERE code='1100'), true, 'BALANCE_SHEET_CURRENT_ASSETS', 8, (SELECT id FROM auth.users LIMIT 1)),

-- ===== ACCOUNTS RECEIVABLE (1200) =====
('1210', 'Client Receivables', 'ASSET', 'DEBIT', 2, (SELECT id FROM finance.chart_of_accounts WHERE code='1200'), true, 'BALANCE_SHEET_CURRENT_ASSETS', 1, (SELECT id FROM auth.users LIMIT 1)),
('1220', 'Platform Receivables', 'ASSET', 'DEBIT', 2, (SELECT id FROM finance.chart_of_accounts WHERE code='1200'), true, 'BALANCE_SHEET_CURRENT_ASSETS', 2, (SELECT id FROM auth.users LIMIT 1)),
('1230', 'Staff Advances', 'ASSET', 'DEBIT', 2, (SELECT id FROM finance.chart_of_accounts WHERE code='1200'), true, 'BALANCE_SHEET_CURRENT_ASSETS', 3, (SELECT id FROM auth.users LIMIT 1)),

-- ===== ADVANCES & PREPAYMENTS (1300) =====
('1310', 'Prepaid Subscriptions', 'ASSET', 'DEBIT', 2, (SELECT id FROM finance.chart_of_accounts WHERE code='1300'), true, 'BALANCE_SHEET_CURRENT_ASSETS', 1, (SELECT id FROM auth.users LIMIT 1)),
('1320', 'Vendor Advances', 'ASSET', 'DEBIT', 2, (SELECT id FROM finance.chart_of_accounts WHERE code='1300'), true, 'BALANCE_SHEET_CURRENT_ASSETS', 2, (SELECT id FROM auth.users LIMIT 1)),

-- ===== TAX RECEIVABLES (1400) =====
('1410', 'Withholding Tax Receivable', 'ASSET', 'DEBIT', 2, (SELECT id FROM finance.chart_of_accounts WHERE code='1400'), true, 'BALANCE_SHEET_CURRENT_ASSETS', 1, (SELECT id FROM auth.users LIMIT 1)),
('1420', 'Advance Tax Paid', 'ASSET', 'DEBIT', 2, (SELECT id FROM finance.chart_of_accounts WHERE code='1400'), true, 'BALANCE_SHEET_CURRENT_ASSETS', 2, (SELECT id FROM auth.users LIMIT 1)),

-- ===== FIXED ASSETS (1510) =====
('1511', 'Office Equipment', 'ASSET', 'DEBIT', 2, (SELECT id FROM finance.chart_of_accounts WHERE code='1510'), true, 'BALANCE_SHEET_NON_CURRENT_ASSETS', 1, (SELECT id FROM auth.users LIMIT 1)),
('1512', 'Computers & Laptops', 'ASSET', 'DEBIT', 2, (SELECT id FROM finance.chart_of_accounts WHERE code='1510'), true, 'BALANCE_SHEET_NON_CURRENT_ASSETS', 2, (SELECT id FROM auth.users LIMIT 1)),
('1513', 'Furniture & Fixtures', 'ASSET', 'DEBIT', 2, (SELECT id FROM finance.chart_of_accounts WHERE code='1510'), true, 'BALANCE_SHEET_NON_CURRENT_ASSETS', 3, (SELECT id FROM auth.users LIMIT 1)),

-- ===== INTANGIBLE ASSETS (1520) =====
('1521', 'Software Licenses', 'ASSET', 'DEBIT', 2, (SELECT id FROM finance.chart_of_accounts WHERE code='1520'), true, 'BALANCE_SHEET_NON_CURRENT_ASSETS', 1, (SELECT id FROM auth.users LIMIT 1)),
('1522', 'Domain Names', 'ASSET', 'DEBIT', 2, (SELECT id FROM finance.chart_of_accounts WHERE code='1520'), true, 'BALANCE_SHEET_NON_CURRENT_ASSETS', 2, (SELECT id FROM auth.users LIMIT 1)),

-- ===== ACCUMULATED DEPRECIATION (1530) =====
('1531', 'Accum. Depreciation - Equipment', 'ASSET', 'CREDIT', 2, (SELECT id FROM finance.chart_of_accounts WHERE code='1530'), true, 'BALANCE_SHEET_NON_CURRENT_ASSETS_CONTRA', 1, (SELECT id FROM auth.users LIMIT 1)),
('1532', 'Accum. Depreciation - Computers', 'ASSET', 'CREDIT', 2, (SELECT id FROM finance.chart_of_accounts WHERE code='1530'), true, 'BALANCE_SHEET_NON_CURRENT_ASSETS_CONTRA', 2, (SELECT id FROM auth.users LIMIT 1)),

-- ===== ACCOUNTS PAYABLE (2100) =====
('2110', 'Vendor Payables', 'LIABILITY', 'CREDIT', 2, (SELECT id FROM finance.chart_of_accounts WHERE code='2100'), true, 'BALANCE_SHEET_CURRENT_LIABILITIES', 1, (SELECT id FROM auth.users LIMIT 1)),
('2120', 'Platform Fee Payable', 'LIABILITY', 'CREDIT', 2, (SELECT id FROM finance.chart_of_accounts WHERE code='2100'), true, 'BALANCE_SHEET_CURRENT_LIABILITIES', 2, (SELECT id FROM auth.users LIMIT 1)),
('2130', 'Contractor Payables', 'LIABILITY', 'CREDIT', 2, (SELECT id FROM finance.chart_of_accounts WHERE code='2100'), true, 'BALANCE_SHEET_CURRENT_LIABILITIES', 3, (SELECT id FROM auth.users LIMIT 1)),

-- ===== TAX PAYABLES (2200) =====
('2210', 'Income Tax Payable', 'LIABILITY', 'CREDIT', 2, (SELECT id FROM finance.chart_of_accounts WHERE code='2200'), true, 'BALANCE_SHEET_CURRENT_LIABILITIES', 1, (SELECT id FROM auth.users LIMIT 1)),
('2220', 'Sales Tax Payable', 'LIABILITY', 'CREDIT', 2, (SELECT id FROM finance.chart_of_accounts WHERE code='2200'), true, 'BALANCE_SHEET_CURRENT_LIABILITIES', 2, (SELECT id FROM auth.users LIMIT 1)),

-- ===== PAYROLL PAYABLES (2300) =====
('2310', 'Salary Payable', 'LIABILITY', 'CREDIT', 2, (SELECT id FROM finance.chart_of_accounts WHERE code='2300'), true, 'BALANCE_SHEET_CURRENT_LIABILITIES', 1, (SELECT id FROM auth.users LIMIT 1)),
('2320', 'Commission Payable', 'LIABILITY', 'CREDIT', 2, (SELECT id FROM finance.chart_of_accounts WHERE code='2300'), true, 'BALANCE_SHEET_CURRENT_LIABILITIES', 2, (SELECT id FROM auth.users LIMIT 1)),
('2330', 'Bonus Payable', 'LIABILITY', 'CREDIT', 2, (SELECT id FROM finance.chart_of_accounts WHERE code='2300'), true, 'BALANCE_SHEET_CURRENT_LIABILITIES', 3, (SELECT id FROM auth.users LIMIT 1)),

-- ===== OWNER PAYABLES (2400) =====
('2410', 'Profit Distribution Payable', 'LIABILITY', 'CREDIT', 2, (SELECT id FROM finance.chart_of_accounts WHERE code='2400'), true, 'BALANCE_SHEET_CURRENT_LIABILITIES', 1, (SELECT id FROM auth.users LIMIT 1)),
('2420', 'Owner Drawings', 'LIABILITY', 'CREDIT', 2, (SELECT id FROM finance.chart_of_accounts WHERE code='2400'), true, 'BALANCE_SHEET_EQUITY', 2, (SELECT id FROM auth.users LIMIT 1)),

-- ===== ACCRUED EXPENSES (2600) - FIXED CODES =====
('2610', 'Accrued Rent', 'LIABILITY', 'CREDIT', 2, (SELECT id FROM finance.chart_of_accounts WHERE code='2600'), true, 'BALANCE_SHEET_CURRENT_LIABILITIES', 1, (SELECT id FROM auth.users LIMIT 1)),
('2620', 'Accrued Utilities', 'LIABILITY', 'CREDIT', 2, (SELECT id FROM finance.chart_of_accounts WHERE code='2600'), true, 'BALANCE_SHEET_CURRENT_LIABILITIES', 2, (SELECT id FROM auth.users LIMIT 1)),

-- ===== EQUITY - OWNER CAPITAL (3100) =====
('3110', 'Shawaiz Arif Capital', 'EQUITY', 'CREDIT', 2, (SELECT id FROM finance.chart_of_accounts WHERE code='3100'), true, 'BALANCE_SHEET_EQUITY', 1, (SELECT id FROM auth.users LIMIT 1)),

-- ===== EQUITY - RESERVES (3300) =====
('3310', 'General Reserve', 'EQUITY', 'CREDIT', 2, (SELECT id FROM finance.chart_of_accounts WHERE code='3300'), true, 'BALANCE_SHEET_EQUITY', 1, (SELECT id FROM auth.users LIMIT 1)),
('3320', 'Capital Reserve', 'EQUITY', 'CREDIT', 2, (SELECT id FROM finance.chart_of_accounts WHERE code='3300'), true, 'BALANCE_SHEET_EQUITY', 2, (SELECT id FROM auth.users LIMIT 1)),

-- ===== REVENUE - SERVICE (4100) =====
('4110', 'Project Revenue', 'REVENUE', 'CREDIT', 2, (SELECT id FROM finance.chart_of_accounts WHERE code='4100'), true, 'PROFIT_LOSS_REVENUE', 1, (SELECT id FROM auth.users LIMIT 1)),
('4120', 'Consulting Revenue', 'REVENUE', 'CREDIT', 2, (SELECT id FROM finance.chart_of_accounts WHERE code='4100'), true, 'PROFIT_LOSS_REVENUE', 2, (SELECT id FROM auth.users LIMIT 1)),
('4130', 'Maintenance Revenue', 'REVENUE', 'CREDIT', 2, (SELECT id FROM finance.chart_of_accounts WHERE code='4100'), true, 'PROFIT_LOSS_REVENUE', 3, (SELECT id FROM auth.users LIMIT 1)),

-- ===== REVENUE - OTHER (4200) =====
('4210', 'Exchange Gain', 'REVENUE', 'CREDIT', 2, (SELECT id FROM finance.chart_of_accounts WHERE code='4200'), true, 'PROFIT_LOSS_OTHER_INCOME', 1, (SELECT id FROM auth.users LIMIT 1)),
('4220', 'Interest Income', 'REVENUE', 'CREDIT', 2, (SELECT id FROM finance.chart_of_accounts WHERE code='4200'), true, 'PROFIT_LOSS_OTHER_INCOME', 2, (SELECT id FROM auth.users LIMIT 1)),

-- ===== COST OF SALES - DIRECT (5100) =====
('5110', 'Developer/Contractor Cost', 'COST_OF_SALES', 'DEBIT', 2, (SELECT id FROM finance.chart_of_accounts WHERE code='5100'), true, 'PROFIT_LOSS_COS', 1, (SELECT id FROM auth.users LIMIT 1)),
('5120', 'Direct Software/API Cost', 'COST_OF_SALES', 'DEBIT', 2, (SELECT id FROM finance.chart_of_accounts WHERE code='5100'), true, 'PROFIT_LOSS_COS', 2, (SELECT id FROM auth.users LIMIT 1)),
('5130', 'Direct Hosting Costs', 'COST_OF_SALES', 'DEBIT', 2, (SELECT id FROM finance.chart_of_accounts WHERE code='5100'), true, 'PROFIT_LOSS_COS', 3, (SELECT id FROM auth.users LIMIT 1)),

-- ===== COST OF SALES - PLATFORM (5200) =====
('5210', 'Freelancer Platform Fee', 'COST_OF_SALES', 'DEBIT', 2, (SELECT id FROM finance.chart_of_accounts WHERE code='5200'), true, 'PROFIT_LOSS_COS', 1, (SELECT id FROM auth.users LIMIT 1)),
('5220', 'Upwork Platform Fee', 'COST_OF_SALES', 'DEBIT', 2, (SELECT id FROM finance.chart_of_accounts WHERE code='5200'), true, 'PROFIT_LOSS_COS', 2, (SELECT id FROM auth.users LIMIT 1)),
('5230', 'Payment Gateway Fee', 'COST_OF_SALES', 'DEBIT', 2, (SELECT id FROM finance.chart_of_accounts WHERE code='5200'), true, 'PROFIT_LOSS_COS', 3, (SELECT id FROM auth.users LIMIT 1)),
('5240', 'Fiverr Platform Fee', 'COST_OF_SALES', 'DEBIT', 2, (SELECT id FROM finance.chart_of_accounts WHERE code='5200'), true, 'PROFIT_LOSS_COS', 4, (SELECT id FROM auth.users LIMIT 1)),

-- ===== OPERATING EXPENSES - SOFTWARE (6100) =====
('6110', 'AI API Costs', 'OPERATING_EXPENSE', 'DEBIT', 2, (SELECT id FROM finance.chart_of_accounts WHERE code='6100'), true, 'PROFIT_LOSS_OP_EXPENSE', 1, (SELECT id FROM auth.users LIMIT 1)),
('6120', 'Supabase Costs', 'OPERATING_EXPENSE', 'DEBIT', 2, (SELECT id FROM finance.chart_of_accounts WHERE code='6100'), true, 'PROFIT_LOSS_OP_EXPENSE', 2, (SELECT id FROM auth.users LIMIT 1)),
('6130', 'Domain & Hosting', 'OPERATING_EXPENSE', 'DEBIT', 2, (SELECT id FROM finance.chart_of_accounts WHERE code='6100'), true, 'PROFIT_LOSS_OP_EXPENSE', 3, (SELECT id FROM auth.users LIMIT 1)),
('6140', 'Other Software Subscriptions', 'OPERATING_EXPENSE', 'DEBIT', 2, (SELECT id FROM finance.chart_of_accounts WHERE code='6100'), true, 'PROFIT_LOSS_OP_EXPENSE', 4, (SELECT id FROM auth.users LIMIT 1)),
('6150', 'GitHub/Version Control', 'OPERATING_EXPENSE', 'DEBIT', 2, (SELECT id FROM finance.chart_of_accounts WHERE code='6100'), true, 'PROFIT_LOSS_OP_EXPENSE', 5, (SELECT id FROM auth.users LIMIT 1)),

-- ===== OPERATING EXPENSES - OFFICE (6200) =====
('6210', 'Rent', 'OPERATING_EXPENSE', 'DEBIT', 2, (SELECT id FROM finance.chart_of_accounts WHERE code='6200'), true, 'PROFIT_LOSS_OP_EXPENSE', 1, (SELECT id FROM auth.users LIMIT 1)),
('6220', 'Utilities', 'OPERATING_EXPENSE', 'DEBIT', 2, (SELECT id FROM finance.chart_of_accounts WHERE code='6200'), true, 'PROFIT_LOSS_OP_EXPENSE', 2, (SELECT id FROM auth.users LIMIT 1)),
('6230', 'Internet', 'OPERATING_EXPENSE', 'DEBIT', 2, (SELECT id FROM finance.chart_of_accounts WHERE code='6200'), true, 'PROFIT_LOSS_OP_EXPENSE', 3, (SELECT id FROM auth.users LIMIT 1)),
('6240', 'Office Supplies', 'OPERATING_EXPENSE', 'DEBIT', 2, (SELECT id FROM finance.chart_of_accounts WHERE code='6200'), true, 'PROFIT_LOSS_OP_EXPENSE', 4, (SELECT id FROM auth.users LIMIT 1)),
('6250', 'Printing & Stationery', 'OPERATING_EXPENSE', 'DEBIT', 2, (SELECT id FROM finance.chart_of_accounts WHERE code='6200'), true, 'PROFIT_LOSS_OP_EXPENSE', 5, (SELECT id FROM auth.users LIMIT 1)),

-- ===== OPERATING EXPENSES - BANK (6300) =====
('6310', 'Bank Charges', 'OPERATING_EXPENSE', 'DEBIT', 2, (SELECT id FROM finance.chart_of_accounts WHERE code='6300'), true, 'PROFIT_LOSS_OP_EXPENSE', 1, (SELECT id FROM auth.users LIMIT 1)),
('6320', 'Withdrawal Fees', 'OPERATING_EXPENSE', 'DEBIT', 2, (SELECT id FROM finance.chart_of_accounts WHERE code='6300'), true, 'PROFIT_LOSS_OP_EXPENSE', 2, (SELECT id FROM auth.users LIMIT 1)),
('6330', 'Payment Processing Fees', 'OPERATING_EXPENSE', 'DEBIT', 2, (SELECT id FROM finance.chart_of_accounts WHERE code='6300'), true, 'PROFIT_LOSS_OP_EXPENSE', 3, (SELECT id FROM auth.users LIMIT 1)),
('6340', 'Wire Transfer Fees', 'OPERATING_EXPENSE', 'DEBIT', 2, (SELECT id FROM finance.chart_of_accounts WHERE code='6300'), true, 'PROFIT_LOSS_OP_EXPENSE', 4, (SELECT id FROM auth.users LIMIT 1)),

-- ===== OPERATING EXPENSES - PROFESSIONAL (6400) =====
('6410', 'Legal & Professional Fees', 'OPERATING_EXPENSE', 'DEBIT', 2, (SELECT id FROM finance.chart_of_accounts WHERE code='6400'), true, 'PROFIT_LOSS_OP_EXPENSE', 1, (SELECT id FROM auth.users LIMIT 1)),
('6420', 'Audit Fees', 'OPERATING_EXPENSE', 'DEBIT', 2, (SELECT id FROM finance.chart_of_accounts WHERE code='6400'), true, 'PROFIT_LOSS_OP_EXPENSE', 2, (SELECT id FROM auth.users LIMIT 1)),
('6430', 'Consulting Fees', 'OPERATING_EXPENSE', 'DEBIT', 2, (SELECT id FROM finance.chart_of_accounts WHERE code='6400'), true, 'PROFIT_LOSS_OP_EXPENSE', 3, (SELECT id FROM auth.users LIMIT 1)),

-- ===== OPERATING EXPENSES - DEPRECIATION (6500) =====
('6510', 'Depreciation - Equipment', 'OPERATING_EXPENSE', 'DEBIT', 2, (SELECT id FROM finance.chart_of_accounts WHERE code='6500'), true, 'PROFIT_LOSS_OP_EXPENSE', 1, (SELECT id FROM auth.users LIMIT 1)),
('6520', 'Depreciation - Computers', 'OPERATING_EXPENSE', 'DEBIT', 2, (SELECT id FROM finance.chart_of_accounts WHERE code='6500'), true, 'PROFIT_LOSS_OP_EXPENSE', 2, (SELECT id FROM auth.users LIMIT 1)),

-- ===== OPERATING EXPENSES - TRAVEL (6600) =====
('6610', 'Local Travel', 'OPERATING_EXPENSE', 'DEBIT', 2, (SELECT id FROM finance.chart_of_accounts WHERE code='6600'), true, 'PROFIT_LOSS_OP_EXPENSE', 1, (SELECT id FROM auth.users LIMIT 1)),
('6620', 'Outstation Travel', 'OPERATING_EXPENSE', 'DEBIT', 2, (SELECT id FROM finance.chart_of_accounts WHERE code='6600'), true, 'PROFIT_LOSS_OP_EXPENSE', 2, (SELECT id FROM auth.users LIMIT 1)),
('6630', 'Transportation', 'OPERATING_EXPENSE', 'DEBIT', 2, (SELECT id FROM finance.chart_of_accounts WHERE code='6600'), true, 'PROFIT_LOSS_OP_EXPENSE', 3, (SELECT id FROM auth.users LIMIT 1)),

-- ===== OPERATING EXPENSES - MARKETING (6700) =====
('6710', 'Digital Marketing', 'OPERATING_EXPENSE', 'DEBIT', 2, (SELECT id FROM finance.chart_of_accounts WHERE code='6700'), true, 'PROFIT_LOSS_OP_EXPENSE', 1, (SELECT id FROM auth.users LIMIT 1)),
('6720', 'Brand & Design', 'OPERATING_EXPENSE', 'DEBIT', 2, (SELECT id FROM finance.chart_of_accounts WHERE code='6700'), true, 'PROFIT_LOSS_OP_EXPENSE', 2, (SELECT id FROM auth.users LIMIT 1)),

-- ===== OTHER INCOME =====
('7011', 'Realized Exchange Gain', 'OTHER_INCOME', 'CREDIT', 2, (SELECT id FROM finance.chart_of_accounts WHERE code='7010'), true, 'PROFIT_LOSS_OTHER_INCOME', 1, (SELECT id FROM auth.users LIMIT 1)),
('7012', 'Unrealized Exchange Gain', 'OTHER_INCOME', 'CREDIT', 2, (SELECT id FROM finance.chart_of_accounts WHERE code='7010'), true, 'PROFIT_LOSS_OTHER_INCOME', 2, (SELECT id FROM auth.users LIMIT 1)),
('7021', 'Bank Interest', 'OTHER_INCOME', 'CREDIT', 2, (SELECT id FROM finance.chart_of_accounts WHERE code='7020'), true, 'PROFIT_LOSS_OTHER_INCOME', 1, (SELECT id FROM auth.users LIMIT 1)),
('7031', 'Fixed Asset Disposal Gain', 'OTHER_INCOME', 'CREDIT', 2, (SELECT id FROM finance.chart_of_accounts WHERE code='7030'), true, 'PROFIT_LOSS_OTHER_INCOME', 1, (SELECT id FROM auth.users LIMIT 1)),

-- ===== OTHER EXPENSES =====
('7111', 'Current Income Tax', 'OTHER_EXPENSE', 'DEBIT', 2, (SELECT id FROM finance.chart_of_accounts WHERE code='7110'), true, 'PROFIT_LOSS_TAX', 1, (SELECT id FROM auth.users LIMIT 1)),
('7112', 'Deferred Tax Expense', 'OTHER_EXPENSE', 'DEBIT', 2, (SELECT id FROM finance.chart_of_accounts WHERE code='7110'), true, 'PROFIT_LOSS_TAX', 2, (SELECT id FROM auth.users LIMIT 1)),
('7121', 'Realized Exchange Loss', 'OTHER_EXPENSE', 'DEBIT', 2, (SELECT id FROM finance.chart_of_accounts WHERE code='7120'), true, 'PROFIT_LOSS_OTHER_EXPENSE', 1, (SELECT id FROM auth.users LIMIT 1)),
('7122', 'Unrealized Exchange Loss', 'OTHER_EXPENSE', 'DEBIT', 2, (SELECT id FROM finance.chart_of_accounts WHERE code='7120'), true, 'PROFIT_LOSS_OTHER_EXPENSE', 2, (SELECT id FROM auth.users LIMIT 1)),
('7131', 'Fixed Asset Disposal Loss', 'OTHER_EXPENSE', 'DEBIT', 2, (SELECT id FROM finance.chart_of_accounts WHERE code='7130'), true, 'PROFIT_LOSS_OTHER_EXPENSE', 1, (SELECT id FROM auth.users LIMIT 1)),
('7141', 'Tax Penalties', 'OTHER_EXPENSE', 'DEBIT', 2, (SELECT id FROM finance.chart_of_accounts WHERE code='7140'), true, 'PROFIT_LOSS_OTHER_EXPENSE', 1, (SELECT id FROM auth.users LIMIT 1)),
('7142', 'Late Payment Charges', 'OTHER_EXPENSE', 'DEBIT', 2, (SELECT id FROM finance.chart_of_accounts WHERE code='7140'), true, 'PROFIT_LOSS_OTHER_EXPENSE', 2, (SELECT id FROM auth.users LIMIT 1));

-- ==========================================
-- VIEWS
-- ==========================================
CREATE OR REPLACE VIEW finance.coa_tree AS
WITH RECURSIVE coa_hierarchy AS (
    SELECT 
        id::TEXT, code::TEXT, name, parent_id::TEXT, account_type, normal_balance,
        is_active, posting_allowed, is_control_account, report_mapping,
        level, display_order,
        ARRAY[id::TEXT] AS path_ids,
        ARRAY[code::TEXT] AS path_codes,
        0::INTEGER AS depth
    FROM finance.chart_of_accounts
    WHERE parent_id IS NULL
    UNION ALL
    SELECT 
        c.id::TEXT, c.code::TEXT, c.name, c.parent_id::TEXT, c.account_type, c.normal_balance,
        c.is_active, c.posting_allowed, c.is_control_account, c.report_mapping,
        c.level, c.display_order,
        ch.path_ids || c.id::TEXT,
        ch.path_codes || c.code::TEXT,
        (ch.depth + 1)::INTEGER
    FROM finance.chart_of_accounts c
    JOIN coa_hierarchy ch ON c.parent_id::TEXT = ch.id
)
SELECT * FROM coa_hierarchy ORDER BY path_codes;

CREATE OR REPLACE VIEW finance.postable_accounts AS
SELECT id, code, name, account_type, normal_balance, currency, is_control_account, report_mapping
FROM finance.chart_of_accounts
WHERE is_active = true AND posting_allowed = true AND level >= 2
ORDER BY code;

CREATE OR REPLACE VIEW finance.account_type_summary AS
SELECT 
    account_type,
    COUNT(*) AS total_accounts,
    COUNT(*) FILTER (WHERE is_active = true) AS active_accounts,
    COUNT(*) FILTER (WHERE posting_allowed = true) AS postable_accounts
FROM finance.chart_of_accounts
GROUP BY account_type ORDER BY account_type;

-- ==========================================
-- RLS
-- ==========================================
ALTER TABLE finance.chart_of_accounts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "coa_select_active" ON finance.chart_of_accounts
    FOR SELECT USING (auth.uid() IS NOT NULL AND (is_active = true OR core.is_ceo_or_admin() OR core.is_finance_head()));

CREATE POLICY "coa_insert" ON finance.chart_of_accounts
    FOR INSERT WITH CHECK (core.is_ceo_or_admin() OR core.is_finance_head());

CREATE POLICY "coa_update" ON finance.chart_of_accounts
    FOR UPDATE USING (core.is_ceo_or_admin() OR core.is_finance_head());

GRANT SELECT ON finance.coa_tree TO authenticated;
GRANT SELECT ON finance.postable_accounts TO authenticated;
GRANT SELECT ON finance.account_type_summary TO authenticated;