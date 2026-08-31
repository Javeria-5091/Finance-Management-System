-- =============================================================================
-- Migration: P1_086_multi_currency_fx_reports.sql
-- Purpose:   Implements the 3 missing reports from Spec Section 13.2
--            "Multi-Currency and FX" report group, identified as gaps
--            MF-03, MF-04, MF-05:
--
--   MF-03  Original-currency ledgers report
--          -> reporting.general_ledger_multi_currency
--             Same rows as reporting.general_ledger, but keeps the
--             transaction's ORIGINAL currency amounts (not just the
--             base/PKR-converted amounts) alongside the applied rate,
--             so a ledger can be viewed "as it happened" in USD/AED/etc.
--
--   MF-04  Manual-rate history report
--          -> reporting.exchange_rate_history
--             Full audit history of finance.exchange_rates: who entered
--             each rate, who approved it, evidence reference, and
--             whether it is locked -- satisfies the "manual-rate history"
--             requirement.
--
--   MF-05  PKR conversion report with rate-method labeling
--          -> reporting.pkr_conversion
--             Per journal-line breakdown of original currency -> PKR,
--             labeling each line with the applied rate method:
--             ACTUAL_PLATFORM_BANK_RATE, APPROVED_ACCOUNTING_RATE,
--             PENDING_APPROVAL, PENDING_CONVERSION, or BASE_CURRENCY.
--             Also surfaces the rate date/period used.
--
-- Safety:    Purely additive. Creates 3 new views only; does not alter
--            any existing table, view, or RLS policy. All 3 views are
--            declared security_invoker = true (per the pattern fixed in
--            P1_020) so they inherit the RLS/org-isolation already
--            enforced on finance.journal_entries, finance.journal_lines,
--            and finance.exchange_rates (incl. the org boundary added in
--            P1_056) -- no separate org-scoping logic is duplicated here.
-- Spec refs: §13.2 (Multi-Currency and FX reports)
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- MF-03: Original-currency ledgers report
-- -----------------------------------------------------------------------------
CREATE OR REPLACE VIEW reporting.general_ledger_multi_currency AS
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
  je.organization_id,
  jl.id AS line_id,
  jl.line_number,
  jl.account_id,
  coa.code AS account_code,
  coa.name AS account_name,
  coa.account_type,
  coa.normal_balance,
  jl.description AS line_description,

  -- Original transaction currency amounts (as entered)
  je.currency AS original_currency,
  jl.debit_amount AS original_debit,
  jl.credit_amount AS original_credit,

  -- Base/PKR amounts (as already used by reporting.general_ledger)
  je.base_currency,
  COALESCE(jl.base_debit, jl.debit_amount) AS base_debit,
  COALESCE(jl.base_credit, jl.credit_amount) AS base_credit,

  -- Rate actually applied to this journal entry at posting time
  je.exchange_rate AS applied_exchange_rate,

  -- Running balance, kept in BASE currency (PKR) so it stays meaningful
  -- when an account is posted to in more than one currency; original-
  -- currency columns above still let the report reconstruct the entry
  -- exactly as it was recorded in its own currency.
  SUM(
    CASE WHEN coa.normal_balance = 'DEBIT'
      THEN COALESCE(jl.base_debit, jl.debit_amount) - COALESCE(jl.base_credit, jl.credit_amount)
      ELSE COALESCE(jl.base_credit, jl.credit_amount) - COALESCE(jl.base_debit, jl.debit_amount)
    END
  ) OVER (
    PARTITION BY jl.account_id
    ORDER BY je.transaction_date, je.reference, jl.line_number
    ROWS UNBOUNDED PRECEDING
  ) AS running_balance_base
FROM finance.journal_lines jl
JOIN finance.journal_entries je ON je.id = jl.journal_entry_id
JOIN finance.chart_of_accounts coa ON coa.id = jl.account_id
WHERE je.status = 'POSTED'
  AND je.currency <> je.base_currency;

ALTER VIEW reporting.general_ledger_multi_currency SET (security_invoker = true);
GRANT SELECT ON reporting.general_ledger_multi_currency TO authenticated;

COMMENT ON VIEW reporting.general_ledger_multi_currency IS
  'MF-03 (Spec 13.2): Original-currency ledgers report. Restricts reporting.general_ledger to entries actually posted in a foreign currency and keeps their original-currency amounts alongside the PKR-converted amounts and the applied rate, so foreign-currency transactions can be reviewed in the currency they were recorded in.';

-- -----------------------------------------------------------------------------
-- MF-04: Manual-rate history report
-- -----------------------------------------------------------------------------
CREATE OR REPLACE VIEW reporting.exchange_rate_history AS
SELECT
  er.id,
  er.organization_id,
  er.from_currency,
  er.to_currency,
  er.rate,
  er.rate_date,
  er.rate_time,
  er.rate_type,
  er.source_platform,
  er.evidence_reference,
  er.entered_by,
  enterer.full_name AS entered_by_name,
  enterer.email AS entered_by_email,
  er.approved_by,
  approver.full_name AS approved_by_name,
  approver.email AS approved_by_email,
  er.approved_at,
  er.is_locked,
  CASE
    WHEN er.rate_type = 'MANUAL' AND er.approved_by IS NULL THEN 'PENDING_APPROVAL'
    WHEN er.rate_type = 'MANUAL' AND er.approved_by IS NOT NULL THEN 'APPROVED'
    ELSE 'N/A'
  END AS approval_status,
  er.created_at,
  er.updated_at
FROM finance.exchange_rates er
LEFT JOIN public.profiles enterer ON enterer.user_id = er.entered_by
LEFT JOIN public.profiles approver ON approver.user_id = er.approved_by;

ALTER VIEW reporting.exchange_rate_history SET (security_invoker = true);
GRANT SELECT ON reporting.exchange_rate_history TO authenticated;

COMMENT ON VIEW reporting.exchange_rate_history IS
  'MF-04 (Spec 13.2): Manual-rate history report. Full history of finance.exchange_rates (platform/bank/manual/payment-channel rates), with who entered/approved each rate and its evidence reference, per Spec 5.12.';

-- -----------------------------------------------------------------------------
-- MF-05: PKR conversion report with rate-method labeling
-- -----------------------------------------------------------------------------
CREATE OR REPLACE VIEW reporting.pkr_conversion AS
SELECT
  je.id AS journal_entry_id,
  je.reference AS journal_reference,
  je.description AS journal_description,
  je.transaction_date,
  je.posting_date,
  je.period_id,
  je.fiscal_year_id,
  je.organization_id,
  jl.id AS line_id,
  jl.account_id,
  coa.code AS account_code,
  coa.name AS account_name,

  je.currency AS original_currency,
  je.base_currency,
  jl.debit_amount AS original_debit,
  jl.credit_amount AS original_credit,
  COALESCE(jl.base_debit, jl.debit_amount) AS pkr_debit,
  COALESCE(jl.base_credit, jl.credit_amount) AS pkr_credit,

  je.exchange_rate AS applied_rate,
  -- Rate date/period used, per spec wording ("rate date or period")
  je.transaction_date AS rate_date,
  je.period_id AS rate_period_id,

  matched_rate.rate_type AS matched_rate_type,
  matched_rate.rate AS matched_rate_value,
  matched_rate.approved_by AS matched_rate_approved_by,
  matched_rate.evidence_reference AS matched_rate_evidence,

  -- Whether this amount reflects an actual platform/bank rate, an
  -- approved accounting (manual) rate, or is still pending conversion
  -- evidence, per Spec 13.2 wording exactly.
  CASE
    WHEN je.currency = je.base_currency THEN 'BASE_CURRENCY'
    WHEN matched_rate.rate_type IN ('PLATFORM', 'BANK', 'PAYMENT_CHANNEL') THEN 'ACTUAL_PLATFORM_BANK_RATE'
    WHEN matched_rate.rate_type = 'MANUAL' AND matched_rate.approved_by IS NOT NULL THEN 'APPROVED_ACCOUNTING_RATE'
    WHEN matched_rate.rate_type = 'MANUAL' AND matched_rate.approved_by IS NULL THEN 'PENDING_APPROVAL'
    ELSE 'PENDING_CONVERSION'
  END AS rate_method
FROM finance.journal_lines jl
JOIN finance.journal_entries je ON je.id = jl.journal_entry_id
JOIN finance.chart_of_accounts coa ON coa.id = jl.account_id
LEFT JOIN LATERAL (
  SELECT er.rate_type, er.rate, er.approved_by, er.evidence_reference
  FROM finance.exchange_rates er
  WHERE er.organization_id = je.organization_id
    AND er.from_currency = je.currency
    AND er.to_currency = je.base_currency
    AND er.rate_date = je.transaction_date
  ORDER BY
    (er.rate = je.exchange_rate) DESC,
    CASE er.rate_type
      WHEN 'PLATFORM' THEN 1
      WHEN 'BANK' THEN 2
      WHEN 'PAYMENT_CHANNEL' THEN 3
      WHEN 'MANUAL' THEN 4
      ELSE 5
    END,
    er.approved_at DESC NULLS LAST
  LIMIT 1
) matched_rate ON true
WHERE je.status = 'POSTED';

ALTER VIEW reporting.pkr_conversion SET (security_invoker = true);
GRANT SELECT ON reporting.pkr_conversion TO authenticated;

COMMENT ON VIEW reporting.pkr_conversion IS
  'MF-05 (Spec 13.2): PKR conversion report. Shows, per journal line, the applied rate method (actual platform/bank rate, approved accounting rate, or pending conversion), and the rate date/period used, by matching each journal entry against finance.exchange_rates on currency pair + rate_date.';

COMMIT;
