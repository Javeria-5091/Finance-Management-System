-- ==========================================
-- PHASE 2 - STEP 2.2: General Ledger & Trial Balance
-- ==========================================

-- GENERAL LEDGER VIEW (Reads ONLY posted entries, calculates running balance)
CREATE OR REPLACE VIEW reporting.general_ledger AS
SELECT 
  je.id AS journal_entry_id,
  je.reference AS journal_reference,
  je.description AS journal_description,
  je.transaction_date,
  je.posting_date,
  je.period_id,
  je.fiscal_year_id,
  je.project_id,
  je.source_type,
  je.source_id,
  jl.id AS line_id,
  jl.line_number,
  jl.account_id,
  coa.code AS account_code,
  coa.name AS account_name,
  coa.account_type,
  coa.normal_balance,
  jl.description AS line_description,
  jl.debit_amount,
  jl.credit_amount,
  COALESCE(jl.base_debit, jl.debit_amount) AS base_debit,
  COALESCE(jl.base_credit, jl.credit_amount) AS base_credit,
  jl.currency,
  jl.exchange_rate,
  -- Running Balance Calculation
  SUM(
    CASE WHEN coa.normal_balance = 'DEBIT' 
      THEN COALESCE(jl.base_debit, jl.debit_amount) - COALESCE(jl.base_credit, jl.credit_amount)
      ELSE COALESCE(jl.base_credit, jl.credit_amount) - COALESCE(jl.base_debit, jl.debit_amount)
    END
  ) OVER (
    PARTITION BY jl.account_id 
    ORDER BY je.transaction_date, je.reference, jl.line_number
    ROWS UNBOUNDED PRECEDING
  ) AS running_balance
FROM finance.journal_lines jl
JOIN finance.journal_entries je ON je.id = jl.journal_entry_id
JOIN finance.chart_of_accounts coa ON coa.id = jl.account_id
WHERE je.status = 'POSTED';

GRANT SELECT ON reporting.general_ledger TO authenticated;

-- TRIAL BALANCE FUNCTION 
-- (Views cannot take parameters easily, so we use a Table-Valued Function)
CREATE OR REPLACE FUNCTION reporting.get_trial_balance(p_period_ids UUID[])
RETURNS TABLE (
  account_id UUID,
  code TEXT,
  name TEXT,
  account_type TEXT,
  normal_balance TEXT,
  total_debit NUMERIC(18,2),
  total_credit NUMERIC(18,2),
  net_balance NUMERIC(18,2)
) AS $$ BEGIN
  RETURN QUERY
  SELECT 
    coa.id,
    coa.code,
    coa.name,
    coa.account_type,
    coa.normal_balance,
    COALESCE(SUM(COALESCE(jl.base_debit, jl.debit_amount)), 0) AS total_debit,
    COALESCE(SUM(COALESCE(jl.base_credit, jl.credit_amount)), 0) AS total_credit,
    CASE 
      WHEN coa.normal_balance = 'DEBIT' 
        THEN COALESCE(SUM(COALESCE(jl.base_debit, jl.debit_amount)), 0) - COALESCE(SUM(COALESCE(jl.base_credit, jl.credit_amount)), 0)
      ELSE COALESCE(SUM(COALESCE(jl.base_credit, jl.credit_amount)), 0) - COALESCE(SUM(COALESCE(jl.base_debit, jl.debit_amount)), 0)
    END AS net_balance
  FROM finance.chart_of_accounts coa
  LEFT JOIN finance.journal_lines jl ON jl.account_id = coa.id
  LEFT JOIN finance.journal_entries je ON je.id = jl.journal_entry_id 
    AND je.status = 'POSTED'
    AND je.period_id = ANY(p_period_ids)
  WHERE coa.is_active = true
    AND coa.posting_allowed = true
  GROUP BY coa.id, coa.code, coa.name, coa.account_type, coa.normal_balance
  HAVING COALESCE(SUM(COALESCE(jl.base_debit, jl.debit_amount)), 0) > 0 
      OR COALESCE(SUM(COALESCE(jl.base_credit, jl.credit_amount)), 0) > 0
  ORDER BY coa.code;
END;
 $$ LANGUAGE plpgsql STABLE SECURITY DEFINER;