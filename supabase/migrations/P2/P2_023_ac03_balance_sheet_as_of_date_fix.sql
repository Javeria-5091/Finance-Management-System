-- =====================================================================
-- Finance Management System — Critical Fix
--   AC-03 (P1): reporting.get_balance_sheet ignores the as-of date
--   parameter.
--
-- Root cause: the "as of" filter is written as a condition on a LEFT
-- JOIN's ON clause:
--
--   LEFT JOIN finance.journal_lines jl ON jl.account_id = coa.id
--   LEFT JOIN finance.journal_entries je ON je.id = jl.journal_entry_id AND je.status = 'POSTED'
--   LEFT JOIN finance.accounting_periods ap ON ap.id = je.period_id AND ap.end_date <= p_as_of_date
--
-- With a LEFT JOIN, a failing ON condition does not remove the row —
-- it only nulls out the *right-hand* table's columns (here, ap.*) for
-- that row. The journal_lines/journal_entries side of the row, and
-- critically jl.base_debit/jl.base_credit, are already fixed by the
-- earlier LEFT JOINs and are completely unaffected by whether ap
-- matched. So "ap.end_date <= p_as_of_date" never actually excludes a
-- single journal line from the SUM() — every posted line for the
-- account, past AND future relative to p_as_of_date, gets summed
-- every time. A balance sheet "as of" any date returns the exact same
-- numbers as a balance sheet as of today.
--
-- This is the identical class of bug already fixed once in this
-- codebase for reporting.get_trial_balance (see the FND-GL-01 comment
-- on that function): a filter condition placed on a LEFT JOIN's ON
-- clause is a dead condition unless something downstream actually
-- requires the joined row to be non-NULL.
--
-- Fix: change journal_entries and accounting_periods from LEFT JOIN to
-- INNER JOIN, so a non-matching status or a period ending after
-- p_as_of_date genuinely removes that journal line from the sums,
-- instead of silently passing it through. finance.chart_of_accounts
-- LEFT JOIN finance.journal_lines is left as a LEFT JOIN (harmless —
-- accounts with zero qualifying activity as of the given date still
-- end up excluded by the existing "!= 0" HAVING clause either way, so
-- this doesn't change which rows are ultimately returned).
--
-- Also folded in here (same function, same lines, AC-02-class defect):
-- je.status = 'POSTED' is widened to je.status IN ('POSTED', 'REVERSED'),
-- for the same reason as AC-02 (reporting/reversal neutralization) —
-- a reversed journal and its offsetting reversal entry must both be
-- counted so the pair nets to zero on the balance sheet too, instead
-- of the reversed original dropping out while its swapped-sign
-- reversal stays counted.
-- =====================================================================

BEGIN;

CREATE OR REPLACE FUNCTION "reporting"."get_balance_sheet"("p_as_of_date" "date", "p_organization_id" "uuid") RETURNS TABLE("section_order" integer, "section" "text", "code" "text", "account_name" "text", "net_amount" numeric)
    LANGUAGE "sql" STABLE
    SET "search_path" TO 'pg_catalog', 'reporting', 'public'
    AS $$
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
        WHEN coa.normal_balance = 'DEBIT' THEN COALESCE(SUM(jl.base_debit), 0) - COALESCE(SUM(jl.base_credit), 0)
        ELSE COALESCE(SUM(jl.base_credit), 0) - COALESCE(SUM(jl.base_debit), 0)
    END AS net_amount
FROM finance.chart_of_accounts coa
LEFT JOIN finance.journal_lines jl ON jl.account_id = coa.id
-- AC-03 FIX: INNER JOIN (was LEFT JOIN) so a non-matching status actually
-- removes the line from the sums instead of silently passing it through.
-- Also widened POSTED-only to POSTED-or-REVERSED (AC-02-class fix).
INNER JOIN finance.journal_entries je ON je.id = jl.journal_entry_id AND je.status IN ('POSTED', 'REVERSED')
-- AC-03 FIX: INNER JOIN (was LEFT JOIN) so "ap.end_date <= p_as_of_date"
-- actually excludes lines from a period ending after the as-of date,
-- instead of the condition only nulling out ap.* while jl.base_debit/
-- base_credit stay in the SUM() regardless.
INNER JOIN finance.accounting_periods ap ON ap.id = je.period_id AND ap.end_date <= p_as_of_date
WHERE coa.is_active = true
  AND coa.organization_id = p_organization_id
  AND p_organization_id = core.current_user_org_id()
  AND coa.account_type IN ('ASSET', 'LIABILITY', 'EQUITY')
GROUP BY coa.id, coa.report_mapping, coa.account_type, coa.code, coa.name, coa.normal_balance
HAVING CASE
    WHEN coa.normal_balance = 'DEBIT' THEN COALESCE(SUM(jl.base_debit), 0) - COALESCE(SUM(jl.base_credit), 0)
    ELSE COALESCE(SUM(jl.base_credit), 0) - COALESCE(SUM(jl.base_debit), 0)
END != 0
ORDER BY section_order, coa.code;
$$;

COMMENT ON FUNCTION "reporting"."get_balance_sheet"("p_as_of_date" "date", "p_organization_id" "uuid") IS
  'AC-03 FIX (P1): journal_entries and accounting_periods changed from '
  'LEFT JOIN to INNER JOIN. Previously "ap.end_date <= p_as_of_date" sat '
  'on a LEFT JOIN''s ON clause, so a non-matching period only nulled out '
  'ap.* while jl.base_debit/base_credit — already fixed by the prior '
  'LEFT JOINs — stayed in the SUM() regardless; the as-of date parameter '
  'had no effect and every call returned today''s balance sheet. Same '
  'defect class as the FND-GL-01 fix on reporting.get_trial_balance. '
  'Also widened je.status from POSTED-only to POSTED-or-REVERSED '
  '(AC-02-class fix) so a reversed journal nets to zero against its '
  'offsetting reversal entry here too.';

COMMIT;