-- =====================================================================
-- Finance Management System — Critical Fix
--   FND-GL-02 (P0): finance.get_pnl_accounts ignores POSTED-status,
--                    fiscal-year, and org filters (dead LEFT JOIN) --
--                    same bug class as FND-GL-01, but this one feeds the
--                    year-end close, so it posts unapproved data as a
--                    real, POSTED retained-earnings journal.
--
-- Safe to run more than once (CREATE OR REPLACE).
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- FND-GL-02: journal_entries status/fiscal_year/org predicate was attached
-- as an ON-condition of a LEFT JOIN, so a non-matching journal_entries row
-- did NOT remove the corresponding journal_lines row from the result --
-- it only nulled out je.*. Since the SUM only ever reads jl.base_debit /
-- jl.base_credit (never je.*), DRAFT / SUBMITTED / REVERSED lines, and
-- lines from every other fiscal year, were being summed into the P&L
-- balances that src/app/api/year-end-close/route.ts then posts as a
-- POSTED closing journal to Retained Earnings.
--
-- Fix: same as FND-GL-01 -- make finance.journal_entries an INNER JOIN
-- carrying the same predicate, so a non-matching entry actually drops
-- that line from the SUM instead of silently passing it through.
--
-- This is safe for the year-end-close caller: it already skips any
-- account whose |balance| <= 0.01 before building closing journal lines,
-- so an account that now returns zero rows (no POSTED lines this fiscal
-- year) behaves identically to previously returning a zero balance.
-- ---------------------------------------------------------------------

CREATE OR REPLACE FUNCTION "finance"."get_pnl_accounts"("p_fiscal_year_id" "uuid", "p_organization_id" "uuid", "p_account_type" "text") RETURNS TABLE("account_id" "uuid", "code" "text", "name" "text", "balance" numeric)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'finance', 'public', 'core'
    AS $$
BEGIN
  IF p_organization_id IS DISTINCT FROM core.current_user_org_id() THEN RAISE EXCEPTION 'Access denied'; END IF;
  IF p_account_type NOT IN ('REVENUE','EXPENSE') THEN RAISE EXCEPTION 'Invalid P&L account type'; END IF;
  RETURN QUERY
  SELECT coa.id,coa.code,coa.name,
    CASE WHEN p_account_type='REVENUE' THEN
      coalesce(sum(coalesce(jl.base_credit,jl.credit_amount)-coalesce(jl.base_debit,jl.debit_amount)),0)
    ELSE
      coalesce(sum(coalesce(jl.base_debit,jl.debit_amount)-coalesce(jl.base_credit,jl.credit_amount)),0)
    END AS balance
  FROM finance.chart_of_accounts coa
  LEFT JOIN finance.journal_lines jl ON jl.account_id=coa.id
  -- FND-GL-02 fix: INNER JOIN (was LEFT JOIN) so status/fiscal_year/org
  -- actually filter which lines get summed.
  INNER JOIN finance.journal_entries je ON je.id=jl.journal_entry_id
    AND je.status='POSTED' AND je.fiscal_year_id=p_fiscal_year_id AND je.organization_id=p_organization_id
  WHERE coa.organization_id=p_organization_id AND ((p_account_type='REVENUE' AND coa.account_type IN ('REVENUE','OTHER_INCOME')) OR (p_account_type='EXPENSE' AND coa.account_type IN ('COST_OF_SALES','OPERATING_EXPENSE','OTHER_EXPENSE')))
  GROUP BY coa.id,coa.code,coa.name
  ORDER BY coa.code;
END;
$$;

ALTER FUNCTION "finance"."get_pnl_accounts"("p_fiscal_year_id" "uuid", "p_organization_id" "uuid", "p_account_type" "text") OWNER TO "postgres";

COMMENT ON FUNCTION "finance"."get_pnl_accounts"("p_fiscal_year_id" "uuid", "p_organization_id" "uuid", "p_account_type" "text") IS
  'FND-GL-02 fix: journal_entries status/fiscal_year/org predicate moved onto an INNER JOIN so it actually filters journal_lines, instead of being a dead condition on a LEFT JOIN. Previously fed DRAFT/SUBMITTED/REVERSED and cross-fiscal-year lines into the year-end close''s P&L balances, which were then posted as a real retained-earnings journal.';

COMMIT;

-- ---------------------------------------------------------------------
-- Verification (run manually):
--
-- 1) Post one DRAFT (unposted) journal entry with a REVENUE or EXPENSE
--    line in the fiscal year you're about to close, and confirm it is
--    NOT included in the balance returned here:
--      select * from finance.get_pnl_accounts('<fiscal_year_id>', '<org_id>', 'REVENUE');
--      select * from finance.get_pnl_accounts('<fiscal_year_id>', '<org_id>', 'EXPENSE');
--
-- 2) Compare totals before/after this fix against a manual query filtered
--    to je.status = 'POSTED' AND je.fiscal_year_id = '<fiscal_year_id>'
--    to confirm they now match exactly.
--
-- 3) Re-run the year-end close flow (/api/year-end-close) and confirm the
--    generated closing journal amount changed if you had any non-POSTED
--    or wrong-fiscal-year activity sitting in journal_lines.
-- ---------------------------------------------------------------------