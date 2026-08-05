-- ==========================================
-- PHASE 8: PROFIT & LOSS REPORT
-- ==========================================
CREATE SCHEMA IF NOT EXISTS reporting;

CREATE OR REPLACE FUNCTION reporting.get_profit_and_loss(
    p_start_date DATE,
    p_end_date DATE
)
RETURNS TABLE (
    section_order INT,
    section TEXT,
    code TEXT,
    account_name TEXT,
    debit_total NUMERIC,
    credit_total NUMERIC,
    net_amount NUMERIC
) AS $$ SELECT 
    CASE coa.report_mapping
        WHEN 'PROFIT_LOSS_REVENUE' THEN 1
        WHEN 'PROFIT_LOSS_COS' THEN 2
        WHEN 'PROFIT_LOSS_OP_EXPENSE' THEN 3
        WHEN 'PROFIT_LOSS_OTHER_INCOME' THEN 4
        WHEN 'PROFIT_LOSS_OTHER_EXPENSE' THEN 5
        ELSE 6
    END AS section_order,
    COALESCE(coa.report_mapping, coa.account_type) AS section,
    coa.code,
    coa.name AS account_name,
    COALESCE(SUM(jl.base_debit), 0) AS debit_total,
    COALESCE(SUM(jl.base_credit), 0) AS credit_total,
    CASE 
        WHEN coa.normal_balance = 'DEBIT' THEN COALESCE(SUM(jl.base_debit), 0) - COALESCE(SUM(jl.base_credit), 0)
        ELSE COALESCE(SUM(jl.base_credit), 0) - COALESCE(SUM(jl.base_debit), 0)
    END AS net_amount
FROM finance.chart_of_accounts coa
JOIN finance.journal_lines jl ON jl.account_id = coa.id
JOIN finance.journal_entries je ON je.id = jl.journal_entry_id
JOIN finance.accounting_periods ap ON ap.id = je.period_id
WHERE je.status = 'POSTED' 
  AND ap.start_date >= p_start_date 
  AND ap.end_date <= p_end_date
  AND coa.is_active = true 
  AND coa.account_type IN ('REVENUE', 'COST_OF_SALES', 'OPERATING_EXPENSE', 'OTHER_INCOME', 'OTHER_EXPENSE')
GROUP BY coa.id, coa.report_mapping, coa.account_type, coa.code, coa.name, coa.normal_balance
ORDER BY section_order, coa.code;
 $$ LANGUAGE sql STABLE SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION reporting.get_profit_and_loss(DATE, DATE) TO authenticated;