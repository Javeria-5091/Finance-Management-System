CREATE OR REPLACE FUNCTION reporting.get_balance_sheet(
  p_as_of_date date,
  p_organization_id uuid
) RETURNS TABLE(
  section_order integer,
  section text,
  code text,
  account_name text,
  net_amount numeric
)
LANGUAGE sql
STABLE
SET search_path TO pg_catalog, reporting, public
AS $$
  -- Balance-sheet accounts.
  SELECT
    CASE coa.account_type
      WHEN 'ASSET' THEN 1
      WHEN 'LIABILITY' THEN 2
      WHEN 'EQUITY' THEN 3
    END AS section_order,
    COALESCE(coa.report_mapping, coa.account_type) AS section,
    coa.code,
    coa.name AS account_name,
    CASE
      WHEN coa.normal_balance = 'DEBIT'
        THEN COALESCE(SUM(jl.base_debit), 0) - COALESCE(SUM(jl.base_credit), 0)
      ELSE COALESCE(SUM(jl.base_credit), 0) - COALESCE(SUM(jl.base_debit), 0)
    END AS net_amount
  FROM finance.chart_of_accounts coa
  JOIN finance.journal_lines jl ON jl.account_id = coa.id
  JOIN finance.journal_entries je
    ON je.id = jl.journal_entry_id
   AND je.organization_id = p_organization_id
   AND je.status IN ('POSTED', 'REVERSED')
  JOIN finance.accounting_periods ap
    ON ap.id = je.period_id
   AND ap.organization_id = p_organization_id
   AND ap.end_date <= p_as_of_date
  WHERE coa.is_active = true
    AND coa.organization_id = p_organization_id
    AND p_organization_id = core.current_user_org_id()
    AND coa.account_type IN ('ASSET', 'LIABILITY', 'EQUITY')
  GROUP BY coa.id, coa.report_mapping, coa.account_type, coa.code, coa.name, coa.normal_balance
  HAVING CASE
    WHEN coa.normal_balance = 'DEBIT'
      THEN COALESCE(SUM(jl.base_debit), 0) - COALESCE(SUM(jl.base_credit), 0)
    ELSE COALESCE(SUM(jl.base_credit), 0) - COALESCE(SUM(jl.base_debit), 0)
  END != 0

  UNION ALL

  -- Current-year earnings are the signed YTD P&L balance. They are presented
  -- as a single equity row so the Balance Sheet remains balanced before a
  -- year-end close transfers P&L into retained earnings. Once P&L has been
  -- closed, its posted balance is zero and this row naturally contributes
  -- zero, preventing double-counting.
  SELECT
    3 AS section_order,
    'EQUITY'::text AS section,
    'CURRENT-YEAR-EARNINGS'::text AS code,
    'Current Year Earnings'::text AS account_name,
    ROUND(
      COALESCE(SUM(
        CASE
          WHEN coa.account_type IN ('REVENUE', 'OTHER_INCOME')
            THEN COALESCE(jl.base_credit, 0) - COALESCE(jl.base_debit, 0)
          ELSE COALESCE(jl.base_debit, 0) - COALESCE(jl.base_credit, 0)
        END
      ), 0),
      2
    ) AS net_amount
  FROM finance.chart_of_accounts coa
  JOIN finance.journal_lines jl ON jl.account_id = coa.id
  JOIN finance.journal_entries je
    ON je.id = jl.journal_entry_id
   AND je.organization_id = p_organization_id
   AND je.status IN ('POSTED', 'REVERSED')
  JOIN finance.accounting_periods ap
    ON ap.id = je.period_id
   AND ap.organization_id = p_organization_id
   AND ap.end_date <= p_as_of_date
  JOIN finance.fiscal_years fy
    ON fy.id = ap.fiscal_year_id
   AND fy.organization_id = p_organization_id
   AND p_as_of_date BETWEEN fy.start_date AND fy.end_date
  WHERE coa.is_active = true
    AND coa.organization_id = p_organization_id
    AND p_organization_id = core.current_user_org_id()
    AND coa.account_type IN (
      'REVENUE',
      'COST_OF_SALES',
      'OPERATING_EXPENSE',
      'OTHER_INCOME',
      'OTHER_EXPENSE'
    )
  HAVING ROUND(
    COALESCE(SUM(
      CASE
        WHEN coa.account_type IN ('REVENUE', 'OTHER_INCOME')
          THEN COALESCE(jl.base_credit, 0) - COALESCE(jl.base_debit, 0)
        ELSE COALESCE(jl.base_debit, 0) - COALESCE(jl.base_credit, 0)
      END
    ), 0),
    2
  ) != 0

  ORDER BY section_order, code;
$$;

ALTER FUNCTION reporting.get_balance_sheet(date, uuid) OWNER TO postgres;

COMMENT ON FUNCTION reporting.get_balance_sheet(date, uuid) IS
'AC-04 fix: includes signed current-year P&L as Current Year Earnings under Equity so Assets = Liabilities + Equity before year-end close. The row naturally becomes zero after P&L is closed into retained earnings, avoiding double-counting.';
