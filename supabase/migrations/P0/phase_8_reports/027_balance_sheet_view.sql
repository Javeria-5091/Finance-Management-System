-- ==========================================
-- PHASE 8: BALANCE SHEET REPORT
-- ==========================================
CREATE OR REPLACE FUNCTION reporting.get_balance_sheet(
    p_as_of_date DATE
)
RETURNS TABLE (
    section_order INT,
    section TEXT,
    code TEXT,
    account_name TEXT,
    net_amount NUMERIC
) AS $$ SELECT 
    CASE coa.account_type
        WHEN 'ASSET' THEN 1
        WHEN 'LIABILITY' THEN 2
        WHEN 'EQUITY' THEN 3
    END AS section_order,
    COALESCE(coa.report_mapping, coa.account_type) AS section,
    coa.code,
    coa.name AS account_name,
    CASE 
        WHEN coa.normal_balance = 'DEBIT' THEN COALESCE(SUM(jl.base_debit), 0) - COALESCE(SUM(jl.base_credit), 0)
        ELSE COALESCE(SUM(jl.base_credit), 0) - COALESCE(SUM(jl.base_debit), 0)
    END AS net_amount
FROM finance.chart_of_accounts coa
LEFT JOIN finance.journal_lines jl ON jl.account_id = coa.id
LEFT JOIN finance.journal_entries je ON je.id = jl.journal_entry_id AND je.status = 'POSTED'
LEFT JOIN finance.accounting_periods ap ON ap.id = je.period_id AND ap.end_date <= p_as_of_date
WHERE coa.is_active = true 
  AND coa.account_type IN ('ASSET', 'LIABILITY', 'EQUITY')
GROUP BY coa.id, coa.report_mapping, coa.account_type, coa.code, coa.name, coa.normal_balance
HAVING CASE 
    WHEN coa.normal_balance = 'DEBIT' THEN COALESCE(SUM(jl.base_debit), 0) - COALESCE(SUM(jl.base_credit), 0)
    ELSE COALESCE(SUM(jl.base_credit), 0) - COALESCE(SUM(jl.base_debit), 0)
END != 0
ORDER BY section_order, coa.code;
 $$ LANGUAGE sql STABLE SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION reporting.get_balance_sheet(DATE) TO authenticated;