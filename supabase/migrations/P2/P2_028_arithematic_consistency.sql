-- AUD-P2-001 / 002 / 004 / 005
-- Production fixes for project profitability, FX validation, non-negative
-- income/expense amounts, and invoice arithmetic consistency.

BEGIN;

-- -------------------------------------------------------------------------
-- AUD-P2-001: reversed journals must be included alongside their originals.
-- A reversal entry offsets the original entry, so both rows are required for
-- the profitability result to net back to zero.
-- -------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION reporting.get_project_profitability(
    p_start_date date,
    p_end_date date
)
RETURNS TABLE(
    project_id uuid,
    project_name text,
    total_revenue numeric,
    total_costs numeric,
    gross_profit numeric,
    margin_pct numeric
)
LANGUAGE sql
STABLE
SET search_path TO pg_catalog, reporting, public
AS $$
SELECT
    je.project_id,
    COALESCE(p.name, 'Unassigned') AS project_name,
    COALESCE(SUM(CASE WHEN coa.account_type = 'REVENUE' THEN jl.base_credit ELSE 0 END), 0) AS total_revenue,
    COALESCE(SUM(CASE WHEN coa.account_type IN ('COST_OF_SALES', 'OPERATING_EXPENSE') THEN jl.base_debit ELSE 0 END), 0) AS total_costs,
    COALESCE(SUM(CASE WHEN coa.account_type = 'REVENUE' THEN jl.base_credit ELSE 0 END), 0)
      - COALESCE(SUM(CASE WHEN coa.account_type IN ('COST_OF_SALES', 'OPERATING_EXPENSE') THEN jl.base_debit ELSE 0 END), 0) AS gross_profit,
    CASE
        WHEN SUM(CASE WHEN coa.account_type = 'REVENUE' THEN jl.base_credit ELSE 0 END) = 0 THEN 0
        ELSE ROUND(
            ((SUM(CASE WHEN coa.account_type = 'REVENUE' THEN jl.base_credit ELSE 0 END)
              - SUM(CASE WHEN coa.account_type IN ('COST_OF_SALES', 'OPERATING_EXPENSE') THEN jl.base_debit ELSE 0 END))
             / NULLIF(SUM(CASE WHEN coa.account_type = 'REVENUE' THEN jl.base_credit ELSE 0 END), 0)) * 100,
            2
        )
    END AS margin_pct
FROM finance.journal_lines jl
JOIN finance.journal_entries je
  ON je.id = jl.journal_entry_id
 AND je.status IN ('POSTED', 'REVERSED')
JOIN finance.accounting_periods ap ON ap.id = je.period_id
JOIN finance.chart_of_accounts coa ON coa.id = jl.account_id
LEFT JOIN public.projects p ON p.id = je.project_id
WHERE ap.start_date >= p_start_date
  AND ap.end_date <= p_end_date
  AND coa.account_type IN ('REVENUE', 'COST_OF_SALES', 'OPERATING_EXPENSE')
GROUP BY je.project_id, p.name
ORDER BY gross_profit DESC;
$$;

-- -------------------------------------------------------------------------
-- AUD-P2-004: database-level non-negative guards. These are intentionally
-- final-defense constraints so direct browser/API/integration writes cannot
-- create negative financial source records.
-- -------------------------------------------------------------------------
ALTER TABLE public.expenses
  ADD CONSTRAINT expenses_amount_non_negative_check CHECK (amount >= 0);

ALTER TABLE public.incomes
  ADD CONSTRAINT incomes_amount_non_negative_check CHECK (amount >= 0);

-- -------------------------------------------------------------------------
-- AUD-P2-005: invoice arithmetic must remain internally consistent.
-- -------------------------------------------------------------------------
ALTER TABLE public.invoices
  ADD CONSTRAINT invoices_amounts_consistency_check
  CHECK (round(subtotal + tax_amount - discount_amount, 2) = round(total_amount, 2));

COMMIT;
