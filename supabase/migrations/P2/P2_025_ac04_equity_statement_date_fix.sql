-- =====================================================================
-- Finance Management System — Critical Fix
--   AC-04 (P1): reporting.get_statement_of_changes_in_equity's date
--   parameters (p_period_start / p_period_end) are ineffective.
--
-- Root cause: same defect class as AC-03 (reporting.get_balance_sheet)
-- and the previously-fixed FND-GL-01 bug on reporting.get_trial_balance
-- — a filter condition placed on a LEFT JOIN's ON clause instead of
-- being enforced by a join that actually requires a match.
--
-- In BOTH the "opening" and "movement" CTEs:
--
--   FROM finance.chart_of_accounts coa
--   LEFT JOIN finance.journal_lines jl ON jl.account_id = coa.id
--   LEFT JOIN finance.journal_entries je
--     ON je.id = jl.journal_entry_id
--    AND je.status = 'POSTED'
--    AND je.transaction_date < p_period_start   -- (or the >= / <= range for movement)
--
-- jl is joined to coa with NO date condition at all — every journal
-- line ever posted to that equity account is already fixed as a row
-- before je is even considered. Because the je join is a LEFT JOIN,
-- a transaction_date that fails the date test doesn't remove the row;
-- it only nulls out je.* for that row, while jl.base_credit/base_debit
-- (unaffected by je matching or not) stay in the SUM(). The result:
-- "opening" sums every equity journal line ever posted, regardless of
-- p_period_start, and "movement" sums every equity journal line ever
-- posted, regardless of p_period_start/p_period_end — the two CTEs
-- produce (nearly) identical totals no matter what dates are passed in,
-- and closing_balance = opening + movement roughly double-counts every
-- historical equity movement instead of splitting it into "before the
-- period" vs "during the period".
--
-- Fix: change journal_entries from LEFT JOIN to INNER JOIN in both
-- CTEs, so the status and date conditions genuinely exclude
-- non-matching lines instead of just nulling out je.* while the SUM()
-- stays unaffected. finance.chart_of_accounts LEFT JOIN
-- finance.journal_lines is left as-is (harmless — an equity account
-- with no qualifying activity in a given window still ends up with
-- opening_balance/period_movement = 0 via the COALESCE(..., 0) in the
-- final SELECT either way).
--
-- Also folded in here (this function was explicitly flagged as an
-- AC-02-class follow-up when that ticket was fixed): je.status =
-- 'POSTED' is widened to je.status IN ('POSTED', 'REVERSED') in both
-- CTEs, so a reversed equity journal nets to zero against its
-- offsetting reversal entry instead of the reversed original dropping
-- out while the swapped-sign reversal stays counted.
--
-- Incidental no-op cleanup: both CTEs repeated
-- "AND coa.organization_id = p_organization_id" twice in their WHERE
-- clause (functionally inert, just noise) — removed the duplicate
-- while rewriting this function.
-- =====================================================================

BEGIN;

CREATE OR REPLACE FUNCTION "reporting"."get_statement_of_changes_in_equity"("p_period_start" "date", "p_period_end" "date", "p_organization_id" "uuid") RETURNS TABLE("account_id" "uuid", "code" "text", "account_name" "text", "opening_balance" numeric, "period_movement" numeric, "closing_balance" numeric)
    LANGUAGE "sql" STABLE
    SET "search_path" TO 'pg_catalog', 'reporting', 'finance', 'public'
    AS $$
WITH opening AS (
  SELECT
    coa.id AS account_id,
    COALESCE(SUM(jl.base_credit), 0) - COALESCE(SUM(jl.base_debit), 0) AS opening_balance
  FROM finance.chart_of_accounts coa
  LEFT JOIN finance.journal_lines jl ON jl.account_id = coa.id
  INNER JOIN finance.journal_entries je
    ON je.id = jl.journal_entry_id
   AND je.status IN ('POSTED', 'REVERSED')
   AND je.transaction_date < p_period_start
  WHERE coa.account_type = 'EQUITY'
    AND coa.organization_id = p_organization_id
    AND p_organization_id = core.current_user_org_id()
  GROUP BY coa.id
),
movement AS (
  SELECT
    coa.id AS account_id,
    COALESCE(SUM(jl.base_credit), 0) - COALESCE(SUM(jl.base_debit), 0) AS period_movement
  FROM finance.chart_of_accounts coa
  LEFT JOIN finance.journal_lines jl ON jl.account_id = coa.id
  INNER JOIN finance.journal_entries je
    ON je.id = jl.journal_entry_id
   AND je.status IN ('POSTED', 'REVERSED')
   AND je.transaction_date >= p_period_start
   AND je.transaction_date <= p_period_end
  WHERE coa.account_type = 'EQUITY'
    AND coa.organization_id = p_organization_id
  GROUP BY coa.id
)
SELECT
  coa.id AS account_id,
  coa.code,
  coa.name AS account_name,
  COALESCE(o.opening_balance, 0) AS opening_balance,
  COALESCE(m.period_movement, 0) AS period_movement,
  COALESCE(o.opening_balance, 0) + COALESCE(m.period_movement, 0) AS closing_balance
FROM finance.chart_of_accounts coa
LEFT JOIN opening o ON o.account_id = coa.id
LEFT JOIN movement m ON m.account_id = coa.id
WHERE coa.account_type = 'EQUITY'
  AND coa.organization_id = p_organization_id
  AND coa.is_active = true
ORDER BY coa.code;
$$;

COMMENT ON FUNCTION "reporting"."get_statement_of_changes_in_equity"("p_period_start" "date", "p_period_end" "date", "p_organization_id" "uuid") IS
  'AC-04 FIX (P1): journal_entries changed from LEFT JOIN to INNER JOIN '
  'in both the opening and movement CTEs. Previously the transaction_date '
  '(and status) conditions sat on a LEFT JOIN''s ON clause, so a '
  'non-matching date only nulled out je.* while jl.base_debit/base_credit '
  '-- already fixed by the unconditional LEFT JOIN to journal_lines -- '
  'stayed in the SUM() regardless; p_period_start/p_period_end had no '
  'real effect and opening/movement both summed every equity line ever '
  'posted. Same defect class as AC-03 (get_balance_sheet) and the '
  'earlier FND-GL-01 fix on get_trial_balance. Also widened je.status '
  'from POSTED-only to POSTED-or-REVERSED (AC-02-class fix) so a '
  'reversed equity journal nets to zero against its offsetting reversal '
  'entry. Incidental cleanup: removed a duplicated, functionally-inert '
  '"organization_id = p_organization_id" condition in each CTE''s WHERE.';

COMMIT;