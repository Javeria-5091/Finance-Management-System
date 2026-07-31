-- ==========================================
-- PHASE 8: PROJECT PROFITABILITY
-- ==========================================
CREATE OR REPLACE FUNCTION reporting.get_project_profitability(
    p_start_date DATE,
    p_end_date DATE
)
RETURNS TABLE (
    project_id UUID,
    project_name TEXT,
    total_revenue NUMERIC,
    total_costs NUMERIC,
    gross_profit NUMERIC,
    margin_pct NUMERIC
) AS $$ SELECT 
    je.project_id,
    COALESCE(p.name, 'Unassigned') AS project_name,
    COALESCE(SUM(CASE WHEN coa.account_type = 'REVENUE' THEN jl.base_credit ELSE 0 END), 0) AS total_revenue,
    COALESCE(SUM(CASE WHEN coa.account_type IN ('COST_OF_SALES', 'OPERATING_EXPENSE') THEN jl.base_debit ELSE 0 END), 0) AS total_costs,
    COALESCE(SUM(CASE WHEN coa.account_type = 'REVENUE' THEN jl.base_credit ELSE 0 END), 0) - 
    COALESCE(SUM(CASE WHEN coa.account_type IN ('COST_OF_SALES', 'OPERATING_EXPENSE') THEN jl.base_debit ELSE 0 END), 0) AS gross_profit,
    CASE 
        WHEN SUM(CASE WHEN coa.account_type = 'REVENUE' THEN jl.base_credit ELSE 0 END) = 0 THEN 0
        ELSE ROUND(
            ((SUM(CASE WHEN coa.account_type = 'REVENUE' THEN jl.base_credit ELSE 0 END) - 
              SUM(CASE WHEN coa.account_type IN ('COST_OF_SALES', 'OPERATING_EXPENSE') THEN jl.base_debit ELSE 0 END)) / 
             NULLIF(SUM(CASE WHEN coa.account_type = 'REVENUE' THEN jl.base_credit ELSE 0 END), 0)) * 100, 2
        )
    END AS margin_pct
FROM finance.journal_lines jl
JOIN finance.journal_entries je ON je.id = jl.journal_entry_id AND je.status = 'POSTED'
JOIN finance.accounting_periods ap ON ap.id = je.period_id
JOIN finance.chart_of_accounts coa ON coa.id = jl.account_id
LEFT JOIN public.projects p ON p.id = je.project_id 
WHERE ap.start_date >= p_start_date AND ap.end_date <= p_end_date
  AND coa.account_type IN ('REVENUE', 'COST_OF_SALES', 'OPERATING_EXPENSE')
GROUP BY je.project_id, p.name
ORDER BY gross_profit DESC;
 $$ LANGUAGE sql STABLE SECURITY DEFINER;

-- CEO Metrics RPC (Used by Dashboard)
CREATE OR REPLACE FUNCTION reporting.get_ceo_metrics()
RETURNS TABLE (
    total_cash NUMERIC,
    total_receivables NUMERIC,
    total_payables NUMERIC,
    current_month_pl NUMERIC
) AS $$ WITH gl_balances AS (
    SELECT 
        coa.report_mapping,
        coa.normal_balance,
        SUM(jl.base_debit) AS total_dr,
        SUM(jl.base_credit) AS total_cr
    FROM finance.chart_of_accounts coa
    JOIN finance.journal_lines jl ON jl.account_id = coa.id
    JOIN finance.journal_entries je ON je.id = jl.journal_entry_id AND je.status = 'POSTED'
    WHERE coa.report_mapping IN ('BALANCE_SHEET_CASH', 'BALANCE_SHEET_RECEIVABLES', 'BALANCE_SHEET_PAYABLES')
    GROUP BY coa.report_mapping, coa.normal_balance
),
current_month_pl AS (
    SELECT 
        SUM(CASE WHEN coa.normal_balance = 'CREDIT' THEN jl.base_credit ELSE -jl.base_debit END) AS pl
    FROM finance.journal_lines jl
    JOIN finance.journal_entries je ON je.id = jl.journal_entry_id AND je.status = 'POSTED'
    JOIN finance.accounting_periods ap ON ap.id = je.period_id
    JOIN finance.chart_of_accounts coa ON coa.id = jl.account_id
    WHERE coa.account_type IN ('REVENUE', 'COST_OF_SALES', 'OPERATING_EXPENSE')
      AND CURRENT_DATE BETWEEN ap.start_date AND ap.end_date
)
SELECT 
    COALESCE((SELECT CASE WHEN normal_balance='DEBIT' THEN total_dr - total_cr ELSE total_cr - total_dr END FROM gl_balances WHERE report_mapping = 'BALANCE_SHEET_CASH'), 0),
    COALESCE((SELECT CASE WHEN normal_balance='DEBIT' THEN total_dr - total_cr ELSE total_cr - total_dr END FROM gl_balances WHERE report_mapping = 'BALANCE_SHEET_RECEIVABLES'), 0),
    COALESCE((SELECT CASE WHEN normal_balance='DEBIT' THEN total_dr - total_cr ELSE total_cr - total_dr END FROM gl_balances WHERE report_mapping = 'BALANCE_SHEET_PAYABLES'), 0),
    COALESCE((SELECT pl FROM current_month_pl), 0);
 $$ LANGUAGE sql STABLE SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION reporting.get_project_profitability(DATE, DATE) TO authenticated;
GRANT EXECUTE ON FUNCTION reporting.get_ceo_metrics() TO authenticated;