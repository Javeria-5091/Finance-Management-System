-- ==========================================
-- FIX: Add report_mapping to chart_of_accounts
-- Yeh column Phase 8 ke sab report views require but Phase 2 mein missing tha
-- ==========================================

-- Add column (safe — if already exists, no error)
DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'finance'
          AND table_name = 'chart_of_accounts'
          AND column_name = 'report_mapping'
    ) THEN
        ALTER TABLE finance.chart_of_accounts ADD COLUMN report_mapping TEXT;
    END IF;
END $$;

-- Populate report_mapping based on existing account_type and code patterns
UPDATE finance.chart_of_accounts SET report_mapping = CASE
    -- Revenue accounts (4xxx)
    WHEN account_type = 'REVENUE' AND code LIKE '41%' THEN 'PROFIT_LOSS_REVENUE'
    WHEN account_type = 'OTHER_INCOME' AND code LIKE '42%' THEN 'PROFIT_LOSS_OTHER_INCOME'
    -- Cost of Sales (5xxx)
    WHEN account_type = 'COST_OF_SALES' AND code LIKE '51%' THEN 'PROFIT_LOSS_COS'
    -- Operating Expenses (6xxx)
    WHEN account_type = 'OPERATING_EXPENSE' AND code LIKE '61%' THEN 'PROFIT_LOSS_OP_EXPENSE'
    WHEN account_type = 'OTHER_EXPENSE' AND code LIKE '62%' THEN 'PROFIT_LOSS_OTHER_EXPENSE'
    -- Assets (1xxx)
    WHEN account_type = 'ASSET' AND code LIKE '11%' THEN 'BALANCE_SHEET_CURRENT_ASSETS'
    WHEN account_type = 'ASSET' AND code LIKE '15%' THEN 'BALANCE_SHEET_FIXED_ASSETS'
    -- Liabilities (2xxx)
    WHEN account_type = 'LIABILITY' AND code LIKE '21%' THEN 'BALANCE_SHEET_RECEIVABLES'
    WHEN account_type = 'LIABILITY' AND code LIKE '22%' THEN 'BALANCE_SHEET_PAYABLES'
    WHEN account_type = 'LIABILITY' AND code LIKE '24%' THEN 'PROFIT_DISTRIBUTION_PAYABLE'
    WHEN account_type = 'LIABILITY' AND code LIKE '25%' THEN 'TAX_PAYABLE'
    WHEN account_type = 'LIABILITY' AND code LIKE '26%' THEN 'TAX_PAYABLE'
    WHEN account_type = 'LIABILITY' AND code LIKE '27%' THEN 'WHT_PAYABLE'
    -- Equity (3xxx)
    WHEN account_type = 'EQUITY' AND code LIKE '31%' THEN 'BALANCE_SHEET_EQUITY'
    WHEN account_type = 'EQUITY' AND code LIKE '32%' THEN 'BALANCE_SHEET_RETAINED_EARNINGS'
    WHEN account_type = 'EQUITY' AND code LIKE '33%' THEN 'PROFIT_DISTRIBUTION_PAYABLE'
    WHEN account_type = 'EQUITY' AND code LIKE '34%' THEN 'CURRENT_YEAR_PROFIT'
    ELSE NULL
END;

-- Verify the mapping
SELECT account_type, code, report_mapping
FROM finance.chart_of_accounts
WHERE report_mapping IS NOT NULL
ORDER BY code;