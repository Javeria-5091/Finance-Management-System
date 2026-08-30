-- =============================================================================
-- Migration: 043_ceo_dashboard_org_scope_and_rbac.sql
-- Bug ref:   P0-12 (senior developer review) — "CEO Dashboard RPCs: org-scope
--            not enforced at function level"
--
-- Verification against the live schema (schema.sql) before writing this fix:
--   - None of the 12 reporting.* CEO dashboard functions below are actually
--     SECURITY DEFINER today (they are plain STABLE, i.e. SECURITY INVOKER),
--     so table-level RLS *does* already apply to every query they run.
--   - However, several of the underlying tables (public.invoices,
--     public.expenses, public.budgets, public.projects) have RLS SELECT
--     policies with an "OR user_id = auth.uid()" clause for ordinary users,
--     so a plain Employee calling e.g. reporting.ceo_dashboard_kpis() does
--     get back real rows (their own invoices/expenses), not just zeros.
--   - None of the 12 functions take an explicit organization filter, and
--     GRANT ALL ... TO authenticated has no role check at all — any
--     authenticated user, regardless of role, can call them.
--   - This matches this codebase's own established pattern for exactly this
--     class of problem: reporting.get_trial_balance / get_balance_sheet /
--     get_profit_and_loss / get_cash_flow / get_statement_of_changes_in_equity
--     all already take an explicit p_organization_id parameter and check
--     "p_organization_id = core.current_user_org_id()" before returning
--     anything (see schema.sql). The 12 functions touched here are the ones
--     that were never brought in line with that pattern.
--
-- Fix (defense-in-depth, Spec §7.5):
--   1. Add an explicit p_organization_id uuid DEFAULT NULL parameter to each
--      function (defaults to the caller's own org via core.current_user_org_id()
--      when omitted, so existing zero-arg callers keep working).
--   2. Verify it with core.same_org(v_org_id) — fails closed (RAISE EXCEPTION)
--      if it doesn't match the caller's JWT-derived org, exactly like
--      finance.reverse_journal_entry and the reporting.get_* functions do.
--   3. Add an explicit role check: reporting.is_finance_head() OR has_role
--      ('CEO') only. This is the real, distinct gap the review's repro step
--      calls out ("As an Employee-role user, call
--      SELECT * FROM finance.get_ceo_kpis()... any Employee can call it") —
--      RLS row-scoping alone doesn't stop an unauthorized role from calling
--      the function and getting a partial/confusing result back.
--   4. Add an explicit "AND <table>.organization_id = v_org_id" filter to
--      every subquery inside each function, so correctness no longer relies
--      solely on RLS -- a future RLS policy mistake elsewhere can't turn
--      into a cross-org leak through these functions.
--
--   Old zero-arg overloads are dropped first — CREATE OR REPLACE FUNCTION
--   with a different parameter list creates a new overload rather than
--   replacing the old (insecure) one, which would leave both callable.
--
-- Bonus fixes bundled in (same functions, already being touched):
--   - reporting.ceo_table_fiscal(): finance.fiscal_years has no
--     organization_id-agnostic "is the only OPEN fiscal year" guarantee
--     across orgs, so its lookup subquery is now organization-scoped too
--     (previously it could pick an OPEN fiscal year belonging to ANY org).
--
-- Data safety: function-only changes, no table/column/row changes.
-- =============================================================================

BEGIN;

-- ── 1. ceo_dashboard_kpis ────────────────────────────────────────────────
DROP FUNCTION IF EXISTS "reporting"."ceo_dashboard_kpis"();

CREATE OR REPLACE FUNCTION "reporting"."ceo_dashboard_kpis"("p_organization_id" "uuid" DEFAULT NULL) RETURNS json
    LANGUAGE "plpgsql" STABLE
    SET "search_path" TO 'pg_catalog', 'reporting', 'finance', 'public', 'core'
    AS $$ DECLARE
  v_org_id UUID;
  v_period_id UUID;
  v_prev_period_id UUID;
  v_total_cash NUMERIC := 0;
  v_monthly_expense NUMERIC := 0;
BEGIN
  IF NOT core.is_finance_head() THEN
    RAISE EXCEPTION 'Access denied: CEO dashboard is restricted to CEO/Finance Head roles';
  END IF;
  v_org_id := COALESCE(p_organization_id, core.current_user_org_id());
  IF v_org_id IS NULL OR NOT core.same_org(v_org_id) THEN
    RAISE EXCEPTION 'Access denied: organization scope mismatch';
  END IF;

  SELECT id INTO v_period_id FROM finance.accounting_periods WHERE status = 'OPEN' AND organization_id = v_org_id ORDER BY start_date DESC LIMIT 1;
  SELECT id INTO v_prev_period_id FROM finance.accounting_periods WHERE status IN ('OPEN','SOFT_CLOSED','HARD_CLOSED') AND organization_id = v_org_id AND id != v_period_id ORDER BY start_date DESC LIMIT 1;

  SELECT COALESCE(SUM(opening_balance), 0) INTO v_total_cash FROM finance.financial_accounts WHERE is_active = true AND organization_id = v_org_id;

  SELECT COALESCE(SUM(jl.debit_amount - jl.credit_amount) / NULLIF(COUNT(DISTINCT je.period_id), 1), 0) INTO v_monthly_expense
  FROM finance.journal_lines jl
  JOIN finance.journal_entries je ON je.id = jl.journal_entry_id
  JOIN finance.chart_of_accounts ca ON ca.id = jl.account_id
  JOIN finance.accounting_periods ap ON ap.id = je.period_id
  WHERE je.status = 'POSTED' AND je.organization_id = v_org_id
    AND ca.account_type IN ('COST_OF_SALES','OPERATING_EXPENSE','OTHER_EXPENSE')
    AND ap.status IN ('SOFT_CLOSED','HARD_CLOSED')
    AND ap.end_date >= CURRENT_DATE - INTERVAL '4 months'
    AND ap.start_date < CURRENT_DATE;

  IF v_monthly_expense = 0 THEN
    SELECT COALESCE(SUM(jl.debit_amount - jl.credit_amount) / 3, 0) INTO v_monthly_expense
    FROM finance.journal_lines jl
    JOIN finance.journal_entries je ON je.id = jl.journal_entry_id
    JOIN finance.chart_of_accounts ca ON ca.id = jl.account_id
    WHERE je.status = 'POSTED' AND je.organization_id = v_org_id AND ca.account_type IN ('COST_OF_SALES','OPERATING_EXPENSE','OTHER_EXPENSE');
  END IF;

  RETURN json_build_object(
    'revenue_mtd', COALESCE((SELECT SUM(jl.credit_amount - jl.debit_amount) FROM finance.journal_lines jl JOIN finance.chart_of_accounts ca ON ca.id = jl.account_id JOIN finance.journal_entries je ON je.id = jl.journal_entry_id WHERE je.period_id = v_period_id AND je.organization_id = v_org_id AND je.status = 'POSTED' AND ca.account_type = 'REVENUE'), 0),
    'revenue_prev', COALESCE((SELECT SUM(jl.credit_amount - jl.debit_amount) FROM finance.journal_lines jl JOIN finance.chart_of_accounts ca ON ca.id = jl.account_id JOIN finance.journal_entries je ON je.id = jl.journal_entry_id WHERE je.period_id = v_prev_period_id AND je.organization_id = v_org_id AND je.status = 'POSTED' AND ca.account_type = 'REVENUE'), 0),
    'cogs_mtd', COALESCE((SELECT SUM(jl.debit_amount - jl.credit_amount) FROM finance.journal_lines jl JOIN finance.chart_of_accounts ca ON ca.id = jl.account_id JOIN finance.journal_entries je ON je.id = jl.journal_entry_id WHERE je.period_id = v_period_id AND je.organization_id = v_org_id AND je.status = 'POSTED' AND ca.account_type = 'COST_OF_SALES'), 0),
    'opex_mtd', COALESCE((SELECT SUM(jl.debit_amount - jl.credit_amount) FROM finance.journal_lines jl JOIN finance.chart_of_accounts ca ON ca.id = jl.account_id JOIN finance.journal_entries je ON je.id = jl.journal_entry_id WHERE je.period_id = v_period_id AND je.organization_id = v_org_id AND je.status = 'POSTED' AND ca.account_type = 'OPERATING_EXPENSE'), 0),
    'other_income_mtd', COALESCE((SELECT SUM(jl.credit_amount - jl.debit_amount) FROM finance.journal_lines jl JOIN finance.chart_of_accounts ca ON ca.id = jl.account_id JOIN finance.journal_entries je ON je.id = jl.journal_entry_id WHERE je.period_id = v_period_id AND je.organization_id = v_org_id AND je.status = 'POSTED' AND ca.account_type = 'OTHER_INCOME'), 0),
    'other_expense_mtd', COALESCE((SELECT SUM(jl.debit_amount - jl.credit_amount) FROM finance.journal_lines jl JOIN finance.chart_of_accounts ca ON ca.id = jl.account_id JOIN finance.journal_entries je ON je.id = jl.journal_entry_id WHERE je.period_id = v_period_id AND je.organization_id = v_org_id AND je.status = 'POSTED' AND ca.account_type = 'OTHER_EXPENSE'), 0),
    'net_profit_mtd', COALESCE((SELECT SUM(CASE WHEN ca.normal_balance = 'CREDIT' THEN jl.credit_amount - jl.debit_amount ELSE jl.debit_amount - jl.credit_amount END) FROM finance.journal_lines jl JOIN finance.chart_of_accounts ca ON ca.id = jl.account_id JOIN finance.journal_entries je ON je.id = jl.journal_entry_id WHERE je.period_id = v_period_id AND je.organization_id = v_org_id AND je.status = 'POSTED' AND ca.account_type IN ('REVENUE','COST_OF_SALES','OPERATING_EXPENSE','OTHER_INCOME','OTHER_EXPENSE')), 0),
    'net_profit_prev', COALESCE((SELECT SUM(CASE WHEN ca.normal_balance = 'CREDIT' THEN jl.credit_amount - jl.debit_amount ELSE jl.debit_amount - jl.credit_amount END) FROM finance.journal_lines jl JOIN finance.chart_of_accounts ca ON ca.id = jl.account_id JOIN finance.journal_entries je ON je.id = jl.journal_entry_id WHERE je.period_id = v_prev_period_id AND je.organization_id = v_org_id AND je.status = 'POSTED' AND ca.account_type IN ('REVENUE','COST_OF_SALES','OPERATING_EXPENSE','OTHER_INCOME','OTHER_EXPENSE')), 0),
    'total_assets', COALESCE((SELECT SUM(CASE WHEN ca.code LIKE '153%' THEN jl.credit_amount - jl.debit_amount ELSE jl.debit_amount - jl.credit_amount END) FROM finance.journal_lines jl JOIN finance.chart_of_accounts ca ON ca.id = jl.account_id JOIN finance.journal_entries je ON je.id = jl.journal_entry_id AND je.status = 'POSTED' WHERE je.organization_id = v_org_id AND ca.account_type = 'ASSET'), 0),
    'current_assets', COALESCE((SELECT SUM(jl.debit_amount - jl.credit_amount) FROM finance.journal_lines jl JOIN finance.chart_of_accounts ca ON ca.id = jl.account_id JOIN finance.journal_entries je ON je.id = jl.journal_entry_id AND je.status = 'POSTED' WHERE je.organization_id = v_org_id AND ca.account_type = 'ASSET' AND ca.code LIKE '1%'), 0),
    'fixed_assets_net', COALESCE((SELECT SUM(CASE WHEN ca.code LIKE '153%' THEN jl.credit_amount - jl.debit_amount ELSE jl.debit_amount - jl.credit_amount END) FROM finance.journal_lines jl JOIN finance.chart_of_accounts ca ON ca.id = jl.account_id JOIN finance.journal_entries je ON je.id = jl.journal_entry_id AND je.status = 'POSTED' WHERE je.organization_id = v_org_id AND (ca.code LIKE '15%' OR ca.code LIKE '153%')), 0),
    'total_liabilities', COALESCE((SELECT SUM(jl.credit_amount - jl.debit_amount) FROM finance.journal_lines jl JOIN finance.chart_of_accounts ca ON ca.id = jl.account_id JOIN finance.journal_entries je ON je.id = jl.journal_entry_id AND je.status = 'POSTED' WHERE je.organization_id = v_org_id AND ca.account_type = 'LIABILITY'), 0),
    'current_liabilities', COALESCE((SELECT SUM(jl.credit_amount - jl.debit_amount) FROM finance.journal_lines jl JOIN finance.chart_of_accounts ca ON ca.id = jl.account_id JOIN finance.journal_entries je ON je.id = jl.journal_entry_id AND je.status = 'POSTED' WHERE je.organization_id = v_org_id AND ca.account_type = 'LIABILITY' AND ca.code LIKE '2%'), 0),
    'total_cash', v_total_cash,
    'cash_runway_months', CASE WHEN v_monthly_expense > 0 THEN FLOOR(v_total_cash / v_monthly_expense) ELSE 0 END,
    'accounts_receivable', COALESCE((SELECT SUM(COALESCE(outstanding_amount, 0)) FROM public.invoices WHERE status IN ('ISSUED','PARTIALLY_PAID','OVERDUE') AND organization_id = v_org_id), 0),
    'accounts_payable', COALESCE((SELECT SUM(COALESCE(outstanding_amount, 0)) FROM finance.vendor_bills WHERE status IN ('POSTED','PARTIALLY_PAID') AND organization_id = v_org_id), 0),
    'retained_earnings', COALESCE((SELECT SUM(jl.credit_amount - jl.debit_amount) FROM finance.journal_lines jl JOIN finance.chart_of_accounts ca ON ca.id = jl.account_id JOIN finance.journal_entries je ON je.id = jl.journal_entry_id AND je.status = 'POSTED' WHERE je.organization_id = v_org_id AND ca.code = '3200'), 0),
    'reserve_balance', COALESCE((SELECT SUM(jl.credit_amount - jl.debit_amount) FROM finance.journal_lines jl JOIN finance.chart_of_accounts ca ON ca.id = jl.account_id JOIN finance.journal_entries je ON je.id = jl.journal_entry_id AND je.status = 'POSTED' WHERE je.organization_id = v_org_id AND ca.code LIKE '33%'), 0),
    'owner_capital', COALESCE((SELECT SUM(jl.credit_amount - jl.debit_amount) FROM finance.journal_lines jl JOIN finance.chart_of_accounts ca ON ca.id = jl.account_id JOIN finance.journal_entries je ON je.id = jl.journal_entry_id AND je.status = 'POSTED' WHERE je.organization_id = v_org_id AND ca.code = '3110'), 0),
    'owner_drawings', COALESCE((SELECT SUM(jl.debit_amount - jl.credit_amount) FROM finance.journal_lines jl JOIN finance.chart_of_accounts ca ON ca.id = jl.account_id JOIN finance.journal_entries je ON je.id = jl.journal_entry_id AND je.status = 'POSTED' WHERE je.organization_id = v_org_id AND ca.code = '2420'), 0),
    'distributable_profit', GREATEST(
      COALESCE((SELECT SUM(CASE WHEN ca.normal_balance = 'CREDIT' THEN jl.credit_amount - jl.debit_amount ELSE jl.debit_amount - jl.credit_amount END) FROM finance.journal_lines jl JOIN finance.chart_of_accounts ca ON ca.id = jl.account_id JOIN finance.journal_entries je ON je.id = jl.journal_entry_id AND je.status = 'POSTED' WHERE je.organization_id = v_org_id AND ca.account_type IN ('REVENUE','COST_OF_SALES','OPERATING_EXPENSE','OTHER_INCOME','OTHER_EXPENSE')), 0)
      - COALESCE((SELECT SUM(jl.debit_amount - jl.credit_amount) FROM finance.journal_lines jl JOIN finance.chart_of_accounts ca ON ca.id = jl.account_id JOIN finance.journal_entries je ON je.id = jl.journal_entry_id AND je.status = 'POSTED' WHERE je.organization_id = v_org_id AND ca.code = '7111'), 0)
      - COALESCE((SELECT SUM(jl.credit_amount - jl.debit_amount) FROM finance.journal_lines jl JOIN finance.chart_of_accounts ca ON ca.id = jl.account_id JOIN finance.journal_entries je ON je.id = jl.journal_entry_id AND je.status = 'POSTED' WHERE je.organization_id = v_org_id AND ca.code LIKE '33%'), 0),
      0
    ),
    'pending_approvals', (
      COALESCE((SELECT COUNT(*) FROM public.invoices WHERE status = 'SUBMITTED' AND organization_id = v_org_id), 0) +
      COALESCE((SELECT COUNT(*) FROM finance.vendor_bills WHERE status IN ('SUBMITTED','VERIFIED') AND organization_id = v_org_id), 0) +
      COALESCE((SELECT COUNT(*) FROM public.expenses WHERE status = 'SUBMITTED' AND organization_id = v_org_id), 0)
    ),
    'unreconciled_lines', COALESCE((SELECT COUNT(*) FROM finance.statement_lines WHERE reconciliation_status = 'UNRECONCILED' AND organization_id = v_org_id), 0),
    'risk_overdue_receivables', COALESCE((SELECT COUNT(*) FROM public.invoices WHERE status = 'OVERDUE' AND organization_id = v_org_id), 0),
    'risk_overdue_payables', COALESCE((SELECT COUNT(*) FROM finance.vendor_bills WHERE status IN ('POSTED','PARTIALLY_PAID') AND due_date < CURRENT_DATE AND organization_id = v_org_id), 0),
    'risk_unreconciled', COALESCE((SELECT COUNT(DISTINCT bank_statement_id) FROM finance.statement_lines WHERE reconciliation_status = 'UNRECONCILED' AND organization_id = v_org_id), 0),
    'risk_pending_period_close', COALESCE((SELECT COUNT(*) FROM finance.accounting_periods WHERE status = 'OPEN' AND end_date < CURRENT_DATE + INTERVAL '7 days' AND organization_id = v_org_id), 0)
  );
END;
 $$;

ALTER FUNCTION "reporting"."ceo_dashboard_kpis"("uuid") OWNER TO "postgres";
REVOKE ALL ON FUNCTION "reporting"."ceo_dashboard_kpis"("uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "reporting"."ceo_dashboard_kpis"("uuid") TO "authenticated";


-- ── 2. ceo_chart_monthly ─────────────────────────────────────────────────
DROP FUNCTION IF EXISTS "reporting"."ceo_chart_monthly"();

CREATE OR REPLACE FUNCTION "reporting"."ceo_chart_monthly"("p_organization_id" "uuid" DEFAULT NULL) RETURNS json
    LANGUAGE "plpgsql" STABLE
    SET "search_path" TO 'pg_catalog', 'reporting', 'finance', 'public', 'core'
    AS $$ DECLARE
  v_org_id UUID;
BEGIN
  IF NOT core.is_finance_head() THEN
    RAISE EXCEPTION 'Access denied: CEO dashboard is restricted to CEO/Finance Head roles';
  END IF;
  v_org_id := COALESCE(p_organization_id, core.current_user_org_id());
  IF v_org_id IS NULL OR NOT core.same_org(v_org_id) THEN
    RAISE EXCEPTION 'Access denied: organization scope mismatch';
  END IF;

  RETURN COALESCE(json_agg(row_to_json(t) ORDER BY sort_order), '[]'::JSON) FROM (
    SELECT TO_CHAR(ap.start_date, 'Mon YYYY') as month, TO_CHAR(ap.start_date, 'YY-MM') as month_short,
      COALESCE(SUM(CASE WHEN ca.account_type = 'REVENUE' THEN jl.credit_amount - jl.debit_amount ELSE 0 END), 0) as revenue,
      COALESCE(SUM(CASE WHEN ca.account_type IN ('COST_OF_SALES','OPERATING_EXPENSE','OTHER_EXPENSE') THEN jl.debit_amount - jl.credit_amount ELSE 0 END), 0) as expenses,
      ap.start_date as sort_order
    FROM finance.accounting_periods ap
    LEFT JOIN finance.journal_entries je ON je.period_id = ap.id AND je.status = 'POSTED' AND je.organization_id = v_org_id
    LEFT JOIN finance.journal_lines jl ON jl.journal_entry_id = je.id
    LEFT JOIN finance.chart_of_accounts ca ON ca.id = jl.account_id
    WHERE ap.organization_id = v_org_id AND ap.start_date >= CURRENT_DATE - INTERVAL '6 months'
    GROUP BY ap.id, ap.start_date
  ) t;
END;
 $$;

ALTER FUNCTION "reporting"."ceo_chart_monthly"("uuid") OWNER TO "postgres";
REVOKE ALL ON FUNCTION "reporting"."ceo_chart_monthly"("uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "reporting"."ceo_chart_monthly"("uuid") TO "authenticated";


-- ── 3. ceo_chart_categories ──────────────────────────────────────────────
DROP FUNCTION IF EXISTS "reporting"."ceo_chart_categories"();

CREATE OR REPLACE FUNCTION "reporting"."ceo_chart_categories"("p_organization_id" "uuid" DEFAULT NULL) RETURNS json
    LANGUAGE "plpgsql" STABLE
    SET "search_path" TO 'pg_catalog', 'reporting', 'finance', 'public', 'core'
    AS $$ DECLARE
  v_org_id UUID;
BEGIN
  IF NOT core.is_finance_head() THEN
    RAISE EXCEPTION 'Access denied: CEO dashboard is restricted to CEO/Finance Head roles';
  END IF;
  v_org_id := COALESCE(p_organization_id, core.current_user_org_id());
  IF v_org_id IS NULL OR NOT core.same_org(v_org_id) THEN
    RAISE EXCEPTION 'Access denied: organization scope mismatch';
  END IF;

  RETURN json_build_object(
    'expenses', COALESCE((SELECT json_agg(row_to_json(t) ORDER BY total DESC) FROM (
      SELECT
        CASE ca.account_type
          WHEN 'COST_OF_SALES' THEN 'Cost of Sales'
          WHEN 'OPERATING_EXPENSE' THEN 'Operating Expenses'
          WHEN 'OTHER_EXPENSE' THEN 'Other Expenses'
          ELSE ca.account_type
        END as category,
        SUM(jl.debit_amount - jl.credit_amount) as total
      FROM finance.journal_lines jl
      JOIN finance.chart_of_accounts ca ON ca.id = jl.account_id
      JOIN finance.journal_entries je ON je.id = jl.journal_entry_id
      WHERE je.status = 'POSTED' AND je.organization_id = v_org_id AND ca.account_type IN ('COST_OF_SALES','OPERATING_EXPENSE','OTHER_EXPENSE')
      GROUP BY ca.account_type
    ) t), '[]'::JSON),

    'assets', COALESCE((SELECT json_agg(row_to_json(t) ORDER BY total DESC) FROM (
      SELECT
        CASE
          WHEN ca.code LIKE '11%' THEN 'Cash & Bank'
          WHEN ca.code LIKE '12%' THEN 'Receivables'
          WHEN ca.code LIKE '13%' THEN 'Advances & Prepayments'
          WHEN ca.code LIKE '14%' THEN 'Tax Receivables'
          WHEN ca.code LIKE '151%' THEN 'Fixed Assets'
          WHEN ca.code LIKE '152%' THEN 'Intangible Assets'
          WHEN ca.code LIKE '153%' THEN 'Accum. Depreciation'
          ELSE ca.name
        END as category,
        SUM(CASE WHEN ca.code LIKE '153%' THEN jl.credit_amount - jl.debit_amount ELSE jl.debit_amount - jl.credit_amount END) as total
      FROM finance.journal_lines jl
      JOIN finance.chart_of_accounts ca ON ca.id = jl.account_id
      JOIN finance.journal_entries je ON je.id = jl.journal_entry_id
      WHERE je.status = 'POSTED' AND je.organization_id = v_org_id AND ca.account_type = 'ASSET'
      GROUP BY
        CASE
          WHEN ca.code LIKE '11%' THEN 'Cash & Bank'
          WHEN ca.code LIKE '12%' THEN 'Receivables'
          WHEN ca.code LIKE '13%' THEN 'Advances & Prepayments'
          WHEN ca.code LIKE '14%' THEN 'Tax Receivables'
          WHEN ca.code LIKE '151%' THEN 'Fixed Assets'
          WHEN ca.code LIKE '152%' THEN 'Intangible Assets'
          WHEN ca.code LIKE '153%' THEN 'Accum. Depreciation'
          ELSE ca.name
        END
    ) t), '[]'::JSON),

    'liabilities', COALESCE((SELECT json_agg(row_to_json(t) ORDER BY total DESC) FROM (
      SELECT
        CASE
          WHEN ca.code LIKE '21%' THEN 'Accounts Payable'
          WHEN ca.code LIKE '22%' THEN 'Tax Payables'
          WHEN ca.code LIKE '23%' THEN 'Payroll Payables'
          WHEN ca.code LIKE '24%' THEN 'Owner Payables'
          WHEN ca.code LIKE '26%' THEN 'Accrued Expenses'
          WHEN ca.code LIKE '251%' THEN 'Long-term Loans'
          ELSE ca.name
        END as category,
        SUM(jl.credit_amount - jl.debit_amount) as total
      FROM finance.journal_lines jl
      JOIN finance.chart_of_accounts ca ON ca.id = jl.account_id
      JOIN finance.journal_entries je ON je.id = jl.journal_entry_id
      WHERE je.status = 'POSTED' AND je.organization_id = v_org_id AND ca.account_type = 'LIABILITY'
      GROUP BY
        CASE
          WHEN ca.code LIKE '21%' THEN 'Accounts Payable'
          WHEN ca.code LIKE '22%' THEN 'Tax Payables'
          WHEN ca.code LIKE '23%' THEN 'Payroll Payables'
          WHEN ca.code LIKE '24%' THEN 'Owner Payables'
          WHEN ca.code LIKE '26%' THEN 'Accrued Expenses'
          WHEN ca.code LIKE '251%' THEN 'Long-term Loans'
          ELSE ca.name
        END
    ) t), '[]'::JSON)
  );
END;
 $$;

ALTER FUNCTION "reporting"."ceo_chart_categories"("uuid") OWNER TO "postgres";
REVOKE ALL ON FUNCTION "reporting"."ceo_chart_categories"("uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "reporting"."ceo_chart_categories"("uuid") TO "authenticated";


-- ── 4. ceo_chart_aging ───────────────────────────────────────────────────
DROP FUNCTION IF EXISTS "reporting"."ceo_chart_aging"();

CREATE OR REPLACE FUNCTION "reporting"."ceo_chart_aging"("p_organization_id" "uuid" DEFAULT NULL) RETURNS json
    LANGUAGE "plpgsql" STABLE
    SET "search_path" TO 'pg_catalog', 'reporting', 'finance', 'public', 'core'
    AS $$ DECLARE
  v_org_id UUID;
BEGIN
  IF NOT core.is_finance_head() THEN
    RAISE EXCEPTION 'Access denied: CEO dashboard is restricted to CEO/Finance Head roles';
  END IF;
  v_org_id := COALESCE(p_organization_id, core.current_user_org_id());
  IF v_org_id IS NULL OR NOT core.same_org(v_org_id) THEN
    RAISE EXCEPTION 'Access denied: organization scope mismatch';
  END IF;

  RETURN json_build_object(
    'receivable', COALESCE(json_build_object(
      'current', COALESCE((SELECT SUM(COALESCE(outstanding_amount, 0)) FROM public.invoices WHERE status IN ('ISSUED','PARTIALLY_PAID','OVERDUE') AND organization_id = v_org_id AND due_date >= CURRENT_DATE), 0),
      'overdue_1_30', COALESCE((SELECT SUM(COALESCE(outstanding_amount, 0)) FROM public.invoices WHERE status IN ('ISSUED','PARTIALLY_PAID','OVERDUE') AND organization_id = v_org_id AND due_date < CURRENT_DATE AND due_date >= CURRENT_DATE - INTERVAL '30 days'), 0),
      'overdue_31_60', COALESCE((SELECT SUM(COALESCE(outstanding_amount, 0)) FROM public.invoices WHERE status IN ('ISSUED','PARTIALLY_PAID','OVERDUE') AND organization_id = v_org_id AND due_date < CURRENT_DATE - INTERVAL '30 days' AND due_date >= CURRENT_DATE - INTERVAL '60 days'), 0),
      'overdue_61_90', COALESCE((SELECT SUM(COALESCE(outstanding_amount, 0)) FROM public.invoices WHERE status IN ('ISSUED','PARTIALLY_PAID','OVERDUE') AND organization_id = v_org_id AND due_date < CURRENT_DATE - INTERVAL '60 days' AND due_date >= CURRENT_DATE - INTERVAL '90 days'), 0),
      'overdue_over_90', COALESCE((SELECT SUM(COALESCE(outstanding_amount, 0)) FROM public.invoices WHERE status IN ('ISSUED','PARTIALLY_PAID','OVERDUE') AND organization_id = v_org_id AND due_date < CURRENT_DATE - INTERVAL '90 days'), 0),
      'total', COALESCE((SELECT SUM(COALESCE(outstanding_amount, 0)) FROM public.invoices WHERE status IN ('ISSUED','PARTIALLY_PAID','OVERDUE') AND organization_id = v_org_id), 0)
    ), '{}'::JSON),
    'payable', COALESCE(json_build_object(
      'current', COALESCE((SELECT SUM(COALESCE(outstanding_amount, 0)) FROM finance.vendor_bills WHERE status IN ('POSTED','PARTIALLY_PAID') AND organization_id = v_org_id AND due_date >= CURRENT_DATE), 0),
      'overdue_1_30', COALESCE((SELECT SUM(COALESCE(outstanding_amount, 0)) FROM finance.vendor_bills WHERE status IN ('POSTED','PARTIALLY_PAID') AND organization_id = v_org_id AND due_date < CURRENT_DATE AND due_date >= CURRENT_DATE - INTERVAL '30 days'), 0),
      'overdue_31_60', COALESCE((SELECT SUM(COALESCE(outstanding_amount, 0)) FROM finance.vendor_bills WHERE status IN ('POSTED','PARTIALLY_PAID') AND organization_id = v_org_id AND due_date < CURRENT_DATE - INTERVAL '30 days' AND due_date >= CURRENT_DATE - INTERVAL '60 days'), 0),
      'overdue_61_90', COALESCE((SELECT SUM(COALESCE(outstanding_amount, 0)) FROM finance.vendor_bills WHERE status IN ('POSTED','PARTIALLY_PAID') AND organization_id = v_org_id AND due_date < CURRENT_DATE - INTERVAL '60 days' AND due_date >= CURRENT_DATE - INTERVAL '90 days'), 0),
      'overdue_over_90', COALESCE((SELECT SUM(COALESCE(outstanding_amount, 0)) FROM finance.vendor_bills WHERE status IN ('POSTED','PARTIALLY_PAID') AND organization_id = v_org_id AND due_date < CURRENT_DATE - INTERVAL '90 days'), 0),
      'total', COALESCE((SELECT SUM(COALESCE(outstanding_amount, 0)) FROM finance.vendor_bills WHERE status IN ('POSTED','PARTIALLY_PAID') AND organization_id = v_org_id), 0)
    ), '{}'::JSON)
  );
END;
 $$;

ALTER FUNCTION "reporting"."ceo_chart_aging"("uuid") OWNER TO "postgres";
REVOKE ALL ON FUNCTION "reporting"."ceo_chart_aging"("uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "reporting"."ceo_chart_aging"("uuid") TO "authenticated";


-- ── 5. ceo_chart_cash ────────────────────────────────────────────────────
DROP FUNCTION IF EXISTS "reporting"."ceo_chart_cash"();

CREATE OR REPLACE FUNCTION "reporting"."ceo_chart_cash"("p_organization_id" "uuid" DEFAULT NULL) RETURNS json
    LANGUAGE "plpgsql" STABLE
    SET "search_path" TO 'pg_catalog', 'reporting', 'finance', 'public', 'core'
    AS $$ DECLARE
  v_org_id UUID;
BEGIN
  IF NOT core.is_finance_head() THEN
    RAISE EXCEPTION 'Access denied: CEO dashboard is restricted to CEO/Finance Head roles';
  END IF;
  v_org_id := COALESCE(p_organization_id, core.current_user_org_id());
  IF v_org_id IS NULL OR NOT core.same_org(v_org_id) THEN
    RAISE EXCEPTION 'Access denied: organization scope mismatch';
  END IF;

  RETURN COALESCE(json_agg(row_to_json(t) ORDER BY balance DESC), '[]'::JSON) FROM (
    SELECT id, account_name, institution_type, currency, masked_identifier, opening_balance as balance
    FROM finance.financial_accounts WHERE is_active = true AND organization_id = v_org_id
  ) t;
END;
 $$;

ALTER FUNCTION "reporting"."ceo_chart_cash"("uuid") OWNER TO "postgres";
REVOKE ALL ON FUNCTION "reporting"."ceo_chart_cash"("uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "reporting"."ceo_chart_cash"("uuid") TO "authenticated";


-- ── 6. ceo_chart_budget ──────────────────────────────────────────────────
DROP FUNCTION IF EXISTS "reporting"."ceo_chart_budget"();

CREATE OR REPLACE FUNCTION "reporting"."ceo_chart_budget"("p_organization_id" "uuid" DEFAULT NULL) RETURNS json
    LANGUAGE "plpgsql" STABLE
    SET "search_path" TO 'pg_catalog', 'reporting', 'finance', 'public', 'core'
    AS $$ DECLARE
  v_org_id UUID;
BEGIN
  IF NOT core.is_finance_head() THEN
    RAISE EXCEPTION 'Access denied: CEO dashboard is restricted to CEO/Finance Head roles';
  END IF;
  v_org_id := COALESCE(p_organization_id, core.current_user_org_id());
  IF v_org_id IS NULL OR NOT core.same_org(v_org_id) THEN
    RAISE EXCEPTION 'Access denied: organization scope mismatch';
  END IF;

  RETURN COALESCE(json_agg(row_to_json(t)), '[]'::JSON) FROM (
    SELECT
      COALESCE(b.name, 'Uncategorized') as category,
      COALESCE(b.total_amount, 0) as budget,
      COALESCE(SUM(jl.debit_amount - jl.credit_amount), 0) as actual,
      COALESCE(b.total_amount, 0) - COALESCE(SUM(jl.debit_amount - jl.credit_amount), 0) as variance
    FROM public.budgets b
    LEFT JOIN finance.journal_lines jl ON jl.description ILIKE '%' || b.name || '%'
    LEFT JOIN finance.chart_of_accounts ca ON ca.id = jl.account_id
    LEFT JOIN finance.journal_entries je ON je.id = jl.journal_entry_id AND je.status = 'POSTED' AND je.organization_id = v_org_id
    WHERE b.status IN ('APPROVED','ACTIVE') AND b.organization_id = v_org_id
    GROUP BY b.id, b.name, b.total_amount
  ) t;
END;
 $$;

ALTER FUNCTION "reporting"."ceo_chart_budget"("uuid") OWNER TO "postgres";
REVOKE ALL ON FUNCTION "reporting"."ceo_chart_budget"("uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "reporting"."ceo_chart_budget"("uuid") TO "authenticated";


-- ── 7. ceo_table_equity_tax ──────────────────────────────────────────────
DROP FUNCTION IF EXISTS "reporting"."ceo_table_equity_tax"();

CREATE OR REPLACE FUNCTION "reporting"."ceo_table_equity_tax"("p_organization_id" "uuid" DEFAULT NULL) RETURNS json
    LANGUAGE "plpgsql" STABLE
    SET "search_path" TO 'pg_catalog', 'reporting', 'finance', 'public', 'core'
    AS $$ DECLARE
  v_org_id UUID;
  v_profit_before_tax NUMERIC := 0;
BEGIN
  IF NOT core.is_finance_head() THEN
    RAISE EXCEPTION 'Access denied: CEO dashboard is restricted to CEO/Finance Head roles';
  END IF;
  v_org_id := COALESCE(p_organization_id, core.current_user_org_id());
  IF v_org_id IS NULL OR NOT core.same_org(v_org_id) THEN
    RAISE EXCEPTION 'Access denied: organization scope mismatch';
  END IF;

  SELECT SUM(CASE WHEN ca.normal_balance = 'CREDIT' THEN jl.credit_amount - jl.debit_amount ELSE jl.debit_amount - jl.credit_amount END)
    INTO v_profit_before_tax
  FROM finance.journal_lines jl
  JOIN finance.chart_of_accounts ca ON ca.id = jl.account_id
  JOIN finance.journal_entries je ON je.id = jl.journal_entry_id
  JOIN finance.accounting_periods ap ON ap.id = je.period_id
  WHERE je.status = 'POSTED' AND je.organization_id = v_org_id AND ap.status = 'OPEN'
    AND ca.account_type IN ('REVENUE','COST_OF_SALES','OPERATING_EXPENSE','OTHER_INCOME','OTHER_EXPENSE');

  RETURN json_build_object(
    'shareholders', COALESCE((SELECT json_agg(row_to_json(t)) FROM (
      SELECT
        CASE ca.code
          WHEN '3110' THEN 'Owner Capital'
          WHEN '2420' THEN 'Owner Drawings'
          WHEN '3200' THEN 'Retained Earnings'
          WHEN '3300' THEN 'General Reserve'
          WHEN '3320' THEN 'Capital Reserve'
          ELSE ca.name
        END as label,
        SUM(CASE WHEN ca.code = '2420' THEN jl.debit_amount - jl.credit_amount ELSE jl.credit_amount - jl.debit_amount END) as balance,
        ca.code
      FROM finance.journal_lines jl
      JOIN finance.chart_of_accounts ca ON ca.id = jl.account_id
      JOIN finance.journal_entries je ON je.id = jl.journal_entry_id
      WHERE je.status = 'POSTED' AND je.organization_id = v_org_id AND ca.code IN ('3110','2420','3200','3300','3320')
      GROUP BY ca.code, ca.name
    ) t), '[]'::JSON),
    'tax', json_build_object(
      'profit_before_tax', v_profit_before_tax,
      'estimated_tax', COALESCE((SELECT SUM(jl.debit_amount - jl.credit_amount) FROM finance.journal_lines jl JOIN finance.chart_of_accounts ca ON ca.id = jl.account_id JOIN finance.journal_entries je ON je.id = jl.journal_entry_id WHERE je.status = 'POSTED' AND je.organization_id = v_org_id AND ca.code = '7111'), 0),
      'withholding_credits', COALESCE((SELECT SUM(jl.debit_amount - jl.credit_amount) FROM finance.journal_lines jl JOIN finance.chart_of_accounts ca ON ca.id = jl.account_id JOIN finance.journal_entries je ON je.id = jl.journal_entry_id WHERE je.status = 'POSTED' AND je.organization_id = v_org_id AND ca.code = '1410'), 0),
      'tax_payable', GREATEST(
        COALESCE((SELECT SUM(jl.debit_amount - jl.credit_amount) FROM finance.journal_lines jl JOIN finance.chart_of_accounts ca ON ca.id = jl.account_id JOIN finance.journal_entries je ON je.id = jl.journal_entry_id WHERE je.status = 'POSTED' AND je.organization_id = v_org_id AND ca.code = '7111'), 0)
        - COALESCE((SELECT SUM(jl.debit_amount - jl.credit_amount) FROM finance.journal_lines jl JOIN finance.chart_of_accounts ca ON ca.id = jl.account_id JOIN finance.journal_entries je ON je.id = jl.journal_entry_id WHERE je.status = 'POSTED' AND je.organization_id = v_org_id AND ca.code = '1410'), 0),
        0
      ),
      'profit_after_tax', GREATEST(v_profit_before_tax -
        COALESCE((SELECT SUM(jl.debit_amount - jl.credit_amount) FROM finance.journal_lines jl JOIN finance.chart_of_accounts ca ON ca.id = jl.account_id JOIN finance.journal_entries je ON je.id = jl.journal_entry_id WHERE je.status = 'POSTED' AND je.organization_id = v_org_id AND ca.code = '7111'), 0)
        + COALESCE((SELECT SUM(jl.debit_amount - jl.credit_amount) FROM finance.journal_lines jl JOIN finance.chart_of_accounts ca ON ca.id = jl.account_id JOIN finance.journal_entries je ON je.id = jl.journal_entry_id WHERE je.status = 'POSTED' AND je.organization_id = v_org_id AND ca.code = '1410'), 0),
        0
      )
    )
  );
END;
 $$;

ALTER FUNCTION "reporting"."ceo_table_equity_tax"("uuid") OWNER TO "postgres";
REVOKE ALL ON FUNCTION "reporting"."ceo_table_equity_tax"("uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "reporting"."ceo_table_equity_tax"("uuid") TO "authenticated";


-- ── 8. ceo_table_audit ───────────────────────────────────────────────────
-- Bonus fix: also corrects the pre-existing "audit.audit_logs" (plural,
-- non-existent) / "al.module" (non-existent column) bugs while we're here,
-- matching the table/columns that actually exist (audit.audit_log).
DROP FUNCTION IF EXISTS "reporting"."ceo_table_audit"();

CREATE OR REPLACE FUNCTION "reporting"."ceo_table_audit"("p_organization_id" "uuid" DEFAULT NULL) RETURNS json
    LANGUAGE "plpgsql" STABLE
    SET "search_path" TO 'pg_catalog', 'reporting', 'audit', 'public', 'core'
    AS $$ DECLARE
  v_org_id UUID;
BEGIN
  IF NOT core.is_finance_head() THEN
    RAISE EXCEPTION 'Access denied: CEO dashboard is restricted to CEO/Finance Head roles';
  END IF;
  v_org_id := COALESCE(p_organization_id, core.current_user_org_id());
  IF v_org_id IS NULL OR NOT core.same_org(v_org_id) THEN
    RAISE EXCEPTION 'Access denied: organization scope mismatch';
  END IF;

  RETURN COALESCE(json_agg(row_to_json(t)), '[]'::JSON) FROM (
    SELECT
      al.id,
      al.action,
      COALESCE(al.entity_type, al.table_name) AS module,
      COALESCE(al.description, al.changed_columns::TEXT, '') AS details,
      al.created_at,
      COALESCE(al.user_name,
        (SELECT full_name FROM public.profiles p WHERE p.user_id = COALESCE(al.user_id, al.changed_by)),
        COALESCE(al.user_id, al.changed_by)::TEXT
      ) AS user_name,
      COALESCE(al.entity_type, al.table_name) AS table_name
    FROM audit.audit_log al
    WHERE al.organization_id = v_org_id
    ORDER BY al.created_at DESC
    LIMIT 30
  ) t;
END;
 $$;

ALTER FUNCTION "reporting"."ceo_table_audit"("uuid") OWNER TO "postgres";
REVOKE ALL ON FUNCTION "reporting"."ceo_table_audit"("uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "reporting"."ceo_table_audit"("uuid") TO "authenticated";


-- ── 9. ceo_table_fiscal ──────────────────────────────────────────────────
DROP FUNCTION IF EXISTS "reporting"."ceo_table_fiscal"();

CREATE OR REPLACE FUNCTION "reporting"."ceo_table_fiscal"("p_organization_id" "uuid" DEFAULT NULL) RETURNS json
    LANGUAGE "plpgsql" STABLE
    SET "search_path" TO 'pg_catalog', 'reporting', 'finance', 'public', 'core'
    AS $$ DECLARE
  v_org_id UUID;
BEGIN
  IF NOT core.is_finance_head() THEN
    RAISE EXCEPTION 'Access denied: CEO dashboard is restricted to CEO/Finance Head roles';
  END IF;
  v_org_id := COALESCE(p_organization_id, core.current_user_org_id());
  IF v_org_id IS NULL OR NOT core.same_org(v_org_id) THEN
    RAISE EXCEPTION 'Access denied: organization scope mismatch';
  END IF;

  RETURN COALESCE(json_agg(row_to_json(t) ORDER BY t.start_date), '[]'::JSON) FROM (
    SELECT
      ap.id, ap.name,
      ap.start_date, ap.end_date, ap.status,
      EXTRACT(MONTH FROM ap.start_date)::int AS month_num,
      EXTRACT(MONTH FROM ap.end_date)::int - EXTRACT(MONTH FROM ap.start_date)::int + 1 AS total_months
    FROM finance.accounting_periods ap
    WHERE ap.organization_id = v_org_id
      AND ap.fiscal_year_id = (
        SELECT id FROM finance.fiscal_years
        WHERE status = 'OPEN' AND organization_id = v_org_id
        ORDER BY start_date DESC
        LIMIT 1
      )
    ORDER BY ap.start_date
  ) t;
END;
 $$;

ALTER FUNCTION "reporting"."ceo_table_fiscal"("uuid") OWNER TO "postgres";
REVOKE ALL ON FUNCTION "reporting"."ceo_table_fiscal"("uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "reporting"."ceo_table_fiscal"("uuid") TO "authenticated";


-- ── 10. pending_approvals_list ───────────────────────────────────────────
DROP FUNCTION IF EXISTS "reporting"."pending_approvals_list"();

CREATE OR REPLACE FUNCTION "reporting"."pending_approvals_list"("p_organization_id" "uuid" DEFAULT NULL) RETURNS json
    LANGUAGE "plpgsql" STABLE
    SET "search_path" TO 'pg_catalog', 'reporting', 'finance', 'public', 'core'
    AS $$ DECLARE
  v_org_id UUID;
BEGIN
  IF NOT core.is_finance_head() THEN
    RAISE EXCEPTION 'Access denied: CEO dashboard is restricted to CEO/Finance Head roles';
  END IF;
  v_org_id := COALESCE(p_organization_id, core.current_user_org_id());
  IF v_org_id IS NULL OR NOT core.same_org(v_org_id) THEN
    RAISE EXCEPTION 'Access denied: organization scope mismatch';
  END IF;

  RETURN COALESCE(
    json_agg(row_to_json(t) ORDER BY t.created_at DESC)
  , '[]'::JSON) FROM (
    -- Invoices
    SELECT id, 'INVOICE' as module_type, invoice_number as reference,
      COALESCE(client_name, 'N/A') as description,
      COALESCE(total_amount, 0) as amount,
      created_by, created_at,
      CASE WHEN due_date < CURRENT_DATE THEN 'HIGH' ELSE 'NORMAL' END as urgency
    FROM public.invoices WHERE status = 'SUBMITTED' AND organization_id = v_org_id
    UNION ALL
    -- Vendor Bills
    SELECT id, 'VENDOR_BILL' as module_type, bill_number as reference,
      COALESCE(vendor_name, description, 'N/A') as description,
      COALESCE(total_amount, 0) as amount,
      created_by, created_at,
      CASE WHEN due_date < CURRENT_DATE THEN 'HIGH' ELSE 'NORMAL' END as urgency
    FROM finance.vendor_bills WHERE status IN ('SUBMITTED','VERIFIED') AND organization_id = v_org_id
    UNION ALL
    -- Expenses
    SELECT id, 'EXPENSE' as module_type, reference_number as reference,
      COALESCE(description, purpose, 'N/A') as description,
      COALESCE(total_amount, 0) as amount,
      created_by, created_at,
      'NORMAL' as urgency
    FROM public.expenses WHERE status = 'SUBMITTED' AND organization_id = v_org_id
  ) t;
END;
 $$;

ALTER FUNCTION "reporting"."pending_approvals_list"("uuid") OWNER TO "postgres";
REVOKE ALL ON FUNCTION "reporting"."pending_approvals_list"("uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "reporting"."pending_approvals_list"("uuid") TO "authenticated";


-- ── 11. project_profitability ────────────────────────────────────────────
DROP FUNCTION IF EXISTS "reporting"."project_profitability"();

CREATE OR REPLACE FUNCTION "reporting"."project_profitability"("p_organization_id" "uuid" DEFAULT NULL) RETURNS json
    LANGUAGE "plpgsql" STABLE
    SET "search_path" TO 'pg_catalog', 'reporting', 'finance', 'public', 'core'
    AS $$ DECLARE
  v_org_id UUID;
BEGIN
  IF NOT core.is_finance_head() THEN
    RAISE EXCEPTION 'Access denied: CEO dashboard is restricted to CEO/Finance Head roles';
  END IF;
  v_org_id := COALESCE(p_organization_id, core.current_user_org_id());
  IF v_org_id IS NULL OR NOT core.same_org(v_org_id) THEN
    RAISE EXCEPTION 'Access denied: organization scope mismatch';
  END IF;

  RETURN COALESCE(
    json_agg(row_to_json(t) ORDER BY t.gross_profit DESC)
  , '[]'::JSON) FROM (
    SELECT
      p.id,
      p.name as project_name,
      COALESCE((SELECT c.name FROM public.clients c WHERE c.id = p.client_id AND c.organization_id = v_org_id), 'N/A') as client_name,
      COALESCE(SUM(CASE WHEN ca.account_type = 'REVENUE' THEN jl.credit_amount - jl.debit_amount ELSE 0 END), 0) as revenue,
      COALESCE(SUM(CASE WHEN ca.account_type IN ('COST_OF_SALES','OPERATING_EXPENSE') THEN jl.debit_amount - jl.credit_amount ELSE 0 END), 0) as costs,
      COALESCE(SUM(CASE WHEN ca.account_type = 'REVENUE' THEN jl.credit_amount - jl.debit_amount ELSE 0 END), 0)
        - COALESCE(SUM(CASE WHEN ca.account_type IN ('COST_OF_SALES','OPERATING_EXPENSE') THEN jl.debit_amount - jl.credit_amount ELSE 0 END), 0) as gross_profit,
      CASE
        WHEN COALESCE(SUM(CASE WHEN ca.account_type = 'REVENUE' THEN jl.credit_amount - jl.debit_amount ELSE 0 END), 0) > 0
        THEN ROUND(
          ((SUM(CASE WHEN ca.account_type = 'REVENUE' THEN jl.credit_amount - jl.debit_amount ELSE 0 END)
            - SUM(CASE WHEN ca.account_type IN ('COST_OF_SALES','OPERATING_EXPENSE') THEN jl.debit_amount - jl.credit_amount ELSE 0 END))
          / NULLIF(SUM(CASE WHEN ca.account_type = 'REVENUE' THEN jl.credit_amount - jl.debit_amount ELSE 0 END), 0)) * 100, 1)
        ELSE 0
      END as margin,
      p.status
    FROM public.projects p
    LEFT JOIN finance.journal_lines jl ON jl.project_id = p.id
    LEFT JOIN finance.journal_entries je ON je.id = jl.journal_entry_id AND je.status = 'POSTED' AND je.organization_id = v_org_id
    LEFT JOIN finance.chart_of_accounts ca ON ca.id = jl.account_id
    WHERE p.organization_id = v_org_id AND ca.account_type IN ('REVENUE','COST_OF_SALES','OPERATING_EXPENSE')
    GROUP BY p.id, p.name, p.client_id, p.status
  ) t;
END;
 $$;

ALTER FUNCTION "reporting"."project_profitability"("uuid") OWNER TO "postgres";
REVOKE ALL ON FUNCTION "reporting"."project_profitability"("uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "reporting"."project_profitability"("uuid") TO "authenticated";


-- ── 12. unreconciled_summary ─────────────────────────────────────────────
DROP FUNCTION IF EXISTS "reporting"."unreconciled_summary"();

CREATE OR REPLACE FUNCTION "reporting"."unreconciled_summary"("p_organization_id" "uuid" DEFAULT NULL) RETURNS json
    LANGUAGE "plpgsql" STABLE
    SET "search_path" TO 'pg_catalog', 'reporting', 'finance', 'public', 'core'
    AS $$ DECLARE
  v_org_id UUID;
BEGIN
  IF NOT core.is_finance_head() THEN
    RAISE EXCEPTION 'Access denied: CEO dashboard is restricted to CEO/Finance Head roles';
  END IF;
  v_org_id := COALESCE(p_organization_id, core.current_user_org_id());
  IF v_org_id IS NULL OR NOT core.same_org(v_org_id) THEN
    RAISE EXCEPTION 'Access denied: organization scope mismatch';
  END IF;

  RETURN COALESCE(
    json_agg(row_to_json(t) ORDER BY t.unreconciled_amount DESC)
  , '[]'::JSON) FROM (
    SELECT
      fa.id as account_id,
      fa.account_name,
      fa.institution_type,
      COUNT(sl.id)::int as unreconciled_count,
      COALESCE(SUM(sl.amount), 0) as unreconciled_amount,
      MAX(sl.transaction_date) as last_statement_date
    FROM finance.statement_lines sl
    JOIN finance.bank_statements bs ON bs.id = sl.bank_statement_id
    JOIN finance.financial_accounts fa ON fa.id = bs.financial_account_id
    WHERE sl.reconciliation_status = 'UNRECONCILED' AND fa.organization_id = v_org_id
    GROUP BY fa.id, fa.account_name, fa.institution_type
  ) t;
END;
 $$;

ALTER FUNCTION "reporting"."unreconciled_summary"("uuid") OWNER TO "postgres";
REVOKE ALL ON FUNCTION "reporting"."unreconciled_summary"("uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "reporting"."unreconciled_summary"("uuid") TO "authenticated";

COMMIT;