-- =============================================================================
-- 025c_project_profitability_tax_views.sql
--
-- PROBLEM: src/app/api/chat/route.ts references two AI tool views
-- (reporting.v_project_profitability, reporting.v_tax_computation_summary)
-- that were never actually created in any migration — only
-- reporting.v_cash_position exists (025b_reporting_views.sql). This means
-- the "get_project_profitability" and "get_tax_summary" AI tools have been
-- broken since they were added, and P1_007_ai_security_hardening.sql fails
-- because it tries to GRANT SELECT on views that don't exist yet.
--
-- FIX: create both missing views here, using the same conventions as
-- v_cash_position — security_invoker = true, ledger (finance.journal_lines /
-- finance.journal_entries) as the source of truth for profitability (per
-- Spec 4.1 / 5.3), and finance.tax_reconciliations as the source of truth
-- for tax figures (per Spec 5.12.1 / 10.2).
--
-- Run this BEFORE (re-)running P1_007_ai_security_hardening.sql.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Project profitability — revenue and direct cost pulled from POSTED
--    journal lines linked to the project, grouped by chart-of-accounts type.
--    (Spec 5.3 acceptance: "A project report reconciles its operational
--    records to the related ledger revenue and costs.")
-- -----------------------------------------------------------------------------
CREATE OR REPLACE VIEW reporting.v_project_profitability
WITH (security_invoker = true) AS
WITH proj_gl AS (
  SELECT
    p.id                                                              AS project_id,
    p.name                                                            AS project_name,
    p.client_name,
    p.status                                                          AS project_status,
    p.user_id,
    COALESCE(
      SUM(jl.base_credit - jl.base_debit)
        FILTER (WHERE je.status = 'POSTED' AND coa.account_type = 'REVENUE'),
      0
    )                                                                 AS revenue,
    COALESCE(
      SUM(jl.base_debit - jl.base_credit)
        FILTER (WHERE je.status = 'POSTED'
                 AND coa.account_type IN ('COST_OF_SALES', 'OPERATING_EXPENSE')),
      0
    )                                                                 AS direct_cost
  FROM public.projects p
  LEFT JOIN finance.journal_entries je ON je.project_id = p.id
  LEFT JOIN finance.journal_lines   jl ON jl.journal_entry_id = je.id
  LEFT JOIN finance.chart_of_accounts coa ON coa.id = jl.account_id
  GROUP BY p.id, p.name, p.client_name, p.status, p.user_id
)
SELECT
  pg.project_id,
  pg.project_name,
  pg.client_name,
  pg.project_status,
  pg.user_id,
  pg.revenue,
  pg.direct_cost,
  (pg.revenue - pg.direct_cost)                                      AS gross_profit,
  CASE
    WHEN pg.revenue <> 0
      THEN ROUND(((pg.revenue - pg.direct_cost) / pg.revenue) * 100, 2)
    ELSE NULL
  END                                                                 AS margin_percent,
  org.id                                                              AS organization_id,
  org.base_currency,
  now()                                                                AS data_as_of
FROM proj_gl pg
CROSS JOIN core.organizations org;

GRANT SELECT ON reporting.v_project_profitability TO postgres, authenticated;

-- -----------------------------------------------------------------------------
-- 2. Tax computation summary — straight read of the approved/draft tax
--    reconciliation record, joined to the rule-set version that was used.
--    (Spec 5.12.1 acceptance: PBT, adjustments, taxable income, rule-set
--    version, estimated tax, credits, payable/refund, and profit after tax
--    must all reconcile and be auditable.)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE VIEW reporting.v_tax_computation_summary
WITH (security_invoker = true) AS
SELECT
  tr.id                                                               AS tax_reconciliation_id,
  tr.tax_year,
  tr.fiscal_year_id,
  tr.accounting_profit_before_tax,
  tr.taxable_income,
  (tr.taxable_income - tr.accounting_profit_before_tax)               AS net_tax_adjustments,
  tr.gross_tax_liability,
  tr.withholding_credits,
  tr.advance_tax_credits,
  tr.other_tax_credits,
  tr.net_tax_payable,
  tr.profit_after_tax,
  tr.effective_tax_rate,
  tr.status,
  tr.filing_date,
  tr.filing_reference,
  tr.payment_date,
  tr.tax_rule_set_id,
  trs.name                                                            AS tax_rule_set_name,
  trs.version                                                         AS tax_rule_set_version,
  org.id                                                               AS organization_id,
  org.base_currency,
  now()                                                                AS data_as_of
FROM finance.tax_reconciliations tr
LEFT JOIN finance.tax_rule_sets trs ON trs.id = tr.tax_rule_set_id
CROSS JOIN core.organizations org;

GRANT SELECT ON reporting.v_tax_computation_summary TO postgres, authenticated;

-- =============================================================================
-- NOTE: this view intentionally does NOT filter by status, so it will show
-- Draft/Estimated computations too. Per Spec 5.12.1 / 9.8.1, the AI response
-- built from this view must always surface tr.status to the user and label
-- unapproved figures as Draft/Estimated — never present them as filed/final.
-- =============================================================================