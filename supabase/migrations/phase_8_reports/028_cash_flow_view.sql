-- ==========================================
-- PHASE 8: CASH FLOW (Indirect Method)
-- ==========================================
CREATE OR REPLACE FUNCTION reporting.get_cash_flow(
    p_start_date DATE,
    p_end_date DATE
)
RETURNS TABLE (
    section TEXT,
    account_name TEXT,
    amount NUMERIC
) AS $$ WITH pnl_changes AS (
    -- Operating Activities: P&L items adjusted for non-cash
    SELECT 
        'OPERATING' AS section,
        coa.name AS account_name,
        SUM(CASE WHEN coa.normal_balance = 'CREDIT' THEN jl.base_credit ELSE -jl.base_debit END) AS amount
    FROM finance.journal_lines jl
    JOIN finance.journal_entries je ON je.id = jl.journal_entry_id AND je.status = 'POSTED'
    JOIN finance.accounting_periods ap ON ap.id = je.period_id
    JOIN finance.chart_of_accounts coa ON coa.id = jl.account_id
    WHERE ap.start_date >= p_start_date AND ap.end_date <= p_end_date
      AND coa.account_type IN ('REVENUE', 'COST_OF_SALES', 'OPERATING_EXPENSE')
    GROUP BY coa.name
    HAVING SUM(CASE WHEN coa.normal_balance = 'CREDIT' THEN jl.base_credit ELSE -jl.base_debit END) != 0
    
    UNION ALL
    
    -- Working Capital Changes (Receivables/Payables)
    SELECT 
        'OPERATING' AS section,
        'Change in ' || coa.name AS account_name,
        -1 * (COALESCE(SUM(jl.base_debit), 0) - COALESCE(SUM(jl.base_credit), 0)) AS amount
    FROM finance.journal_lines jl
    JOIN finance.journal_entries je ON je.id = jl.journal_entry_id AND je.status = 'POSTED'
    JOIN finance.accounting_periods ap ON ap.id = je.period_id
    JOIN finance.chart_of_accounts coa ON coa.id = jl.account_id
    WHERE ap.start_date >= p_start_date AND ap.end_date <= p_end_date
      AND coa.report_mapping IN ('BALANCE_SHEET_RECEIVABLES', 'BALANCE_SHEET_PAYABLES')
    GROUP BY coa.name
    HAVING (COALESCE(SUM(jl.base_debit), 0) - COALESCE(SUM(jl.base_credit), 0)) != 0
    
    UNION ALL
    
    -- Investing Activities (Fixed Assets)
    SELECT 
        'INVESTING' AS section,
        coa.name AS account_name,
        -1 * (COALESCE(SUM(jl.base_debit), 0) - COALESCE(SUM(jl.base_credit), 0)) AS amount
    FROM finance.journal_lines jl
    JOIN finance.journal_entries je ON je.id = jl.journal_entry_id AND je.status = 'POSTED'
    JOIN finance.accounting_periods ap ON ap.id = je.period_id
    JOIN finance.chart_of_accounts coa ON coa.id = jl.account_id
    WHERE ap.start_date >= p_start_date AND ap.end_date <= p_end_date
      AND coa.report_mapping = 'BALANCE_SHEET_FIXED_ASSETS'
    GROUP BY coa.name
    HAVING (COALESCE(SUM(jl.base_debit), 0) - COALESCE(SUM(jl.base_credit), 0)) != 0
    
    UNION ALL
    
    -- Financing Activities (Loans, Capital, Distributions)
    SELECT 
        'FINANCING' AS section,
        coa.name AS account_name,
        CASE WHEN coa.normal_balance = 'CREDIT' 
             THEN COALESCE(SUM(jl.base_credit), 0) - COALESCE(SUM(jl.base_debit), 0)
             ELSE -1 * (COALESCE(SUM(jl.base_debit), 0) - COALESCE(SUM(jl.base_credit), 0)) 
        END AS amount
    FROM finance.journal_lines jl
    JOIN finance.journal_entries je ON je.id = jl.journal_entry_id AND je.status = 'POSTED'
    JOIN finance.accounting_periods ap ON ap.id = je.period_id
    JOIN finance.chart_of_accounts coa ON coa.id = jl.account_id
    WHERE ap.start_date >= p_start_date AND ap.end_date <= p_end_date
      AND coa.account_type = 'EQUITY'
    GROUP BY coa.name, coa.normal_balance
    HAVING CASE WHEN coa.normal_balance = 'CREDIT' 
           THEN COALESCE(SUM(jl.base_credit), 0) - COALESCE(SUM(jl.base_debit), 0)
           ELSE -1 * (COALESCE(SUM(jl.base_debit), 0) - COALESCE(SUM(jl.base_credit), 0)) 
    END != 0
)
SELECT * FROM pnl_changes
ORDER BY 
    CASE section WHEN 'OPERATING' THEN 1 WHEN 'INVESTING' THEN 2 WHEN 'FINANCING' THEN 3 END,
    account_name;
 $$ LANGUAGE sql STABLE SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION reporting.get_cash_flow(DATE, DATE) TO authenticated;