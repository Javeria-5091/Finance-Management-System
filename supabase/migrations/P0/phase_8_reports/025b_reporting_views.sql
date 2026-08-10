-- =============================================================================
-- reporting_views.sql
-- Creates the reporting schema and the v_cash_position view that the AI
-- tool registry (get_cash_position) reads from.
--
-- IMPORTANT CONTEXT / DECISIONS MADE HERE:
-- 1. Your finance tables (journal_entries, journal_lines, chart_of_accounts,
--    finance.financial_accounts) currently have NO organization_id column.
--    Only core.organizations, public.profiles, ai.*, and
--    finance.opening_balance_imports have it.
-- 2. You confirmed core.organizations has exactly 1 row (OSYSTIC itself),
--    so this view attaches that single organization_id to every row via
--    CROSS JOIN. This works correctly TODAY but will break the moment a
--    second organization is added — at that point journal_entries/
--    journal_lines/chart_of_accounts/finance.financial_accounts must get
--    a real organization_id column (per spec section 10.5) and this view
--    must filter on it properly instead of cross-joining.
-- 3. Balance is computed as opening_balance + posted journal movement,
--    NOT from a stale "current_balance" column, per spec 4.1 (ledger is
--    the source of truth) — finance.financial_accounts doesn't even have
--    a current_balance column, only opening_balance.
-- 4. Only journal_entries with status = 'posted' count toward the balance,
--    per spec 4.2 (draft/submitted/verified/approved entries are not yet
--    real ledger movement).
-- =============================================================================

CREATE SCHEMA IF NOT EXISTS reporting;

CREATE OR REPLACE VIEW reporting.v_cash_position
WITH (security_invoker = true) AS
SELECT
  fa.id                                                          AS account_id,
  fa.account_name,
  fa.institution_name,
  fa.account_type,
  fa.currency,
  fa.opening_balance,
  fa.opening_balance
    + COALESCE(SUM(jl.debit_amount)  FILTER (WHERE je.status = 'posted'), 0)
    - COALESCE(SUM(jl.credit_amount) FILTER (WHERE je.status = 'posted'), 0)
                                                                  AS current_balance,
  fa.opening_balance
    + COALESCE(SUM(jl.base_debit)  FILTER (WHERE je.status = 'posted'), 0)
    - COALESCE(SUM(jl.base_credit) FILTER (WHERE je.status = 'posted'), 0)
                                                                  AS current_balance_base,
  org.base_currency,
  fa.is_active,
  fa.is_default,
  org.id                                                         AS organization_id,
  now()                                                          AS data_as_of
FROM finance.financial_accounts fa
LEFT JOIN finance.journal_lines   jl ON jl.account_id = fa.linked_ledger_account_id
LEFT JOIN finance.journal_entries je ON je.id = jl.journal_entry_id
CROSS JOIN core.organizations org
WHERE fa.is_active = true
GROUP BY
  fa.id, fa.account_name, fa.institution_name, fa.account_type, fa.currency,
  fa.opening_balance, fa.is_active, fa.is_default, org.id, org.base_currency;

-- Make sure the function owner (SECURITY DEFINER role behind
-- execute_ai_readonly_query) can read this view. If you still get a
-- permission error after this, run:
--   SELECT rolname FROM pg_roles r JOIN pg_proc p ON p.proowner = r.oid
--   WHERE p.proname = 'execute_ai_readonly_query';
-- and GRANT SELECT ON reporting.v_cash_position TO <that_role>;
GRANT USAGE ON SCHEMA reporting TO postgres, authenticated, anon;
GRANT SELECT ON reporting.v_cash_position TO postgres, authenticated;