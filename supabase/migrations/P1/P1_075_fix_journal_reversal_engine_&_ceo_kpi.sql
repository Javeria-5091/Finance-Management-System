-- ============================================================================
-- Fix script — run this whole file once in the Supabase SQL Editor.
-- Fixes BUG-003 (journal reversal engine) and BUG-004 (reporting schema
-- not exposed to PostgREST). BUG-002 is a TypeScript fix (route.ts), not SQL —
-- see the separately-delivered route.ts.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- BUG-003 FIX
-- finance.journal_lines has NO organization_id column (verified against the
-- live table definition and against finance.post_journal_entry, which already
-- inserts into journal_lines WITHOUT organization_id in the same schema).
-- reverse_journal_entry's INSERT referenced organization_id, which does not
-- exist on journal_lines, so every call raised:
--   column "organization_id" of relation "journal_lines" does not exist
-- This CREATE OR REPLACE is byte-for-byte the existing function with only the
-- organization_id column removed from the journal_lines INSERT/SELECT —
-- nothing else about its logic, checks, or security changes.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION "finance"."reverse_journal_entry"("p_journal_id" "uuid", "p_reversal_date" "date", "p_reason" "text") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'finance', 'public', 'core'
    AS $$
DECLARE v_original record; v_reversal_id uuid; v_ref text; v_period_status text; v_org uuid := core.current_user_org_id();
BEGIN
  IF v_org IS NULL OR NOT (core.is_finance_head() OR core.has_role('ACCOUNTANT')) THEN RAISE EXCEPTION 'Access denied'; END IF;
  SELECT * INTO v_original FROM finance.journal_entries WHERE id=p_journal_id AND organization_id=v_org FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Journal not found or access denied'; END IF;
  IF v_original.status<>'POSTED' OR v_original.reversal_of_id IS NOT NULL THEN RAISE EXCEPTION 'Only original POSTED journal entries can be reversed'; END IF;
  IF p_reason IS NULL OR btrim(p_reason)='' THEN RAISE EXCEPTION 'Reversal reason is mandatory'; END IF;
  SELECT status INTO v_period_status FROM finance.accounting_periods WHERE id=v_original.period_id AND organization_id=v_org;
  IF v_period_status IS NULL OR v_period_status <> 'OPEN' THEN RAISE EXCEPTION 'Journal reversal requires an OPEN accounting period'; END IF;

  v_ref := finance.get_next_number('JOURNAL_ENTRY',v_org);
  UPDATE finance.journal_entries SET status='REVERSED',reversed_by=auth.uid(),reversed_at=now(),reversal_reason=p_reason WHERE id=p_journal_id;
  INSERT INTO finance.journal_entries(
    reference,description,status,transaction_date,posting_date,period_id,fiscal_year_id,currency,exchange_rate,base_currency,
    total_debit,total_credit,source_type,source_id,project_id,department_id,reversal_of_id,reversal_reason,created_by,posted_by,posted_at,organization_id
  ) VALUES(
    v_ref,'REVERSAL: '||v_original.description,'POSTED',p_reversal_date,current_date,v_original.period_id,v_original.fiscal_year_id,
    v_original.currency,v_original.exchange_rate,v_original.base_currency,v_original.total_credit,v_original.total_debit,
    'REVERSAL',p_journal_id,v_original.project_id,v_original.department_id,p_journal_id,p_reason,auth.uid(),auth.uid(),now(),v_org
  ) RETURNING id INTO v_reversal_id;

  -- BUG-003 FIX: organization_id removed — journal_lines has no such column.
  INSERT INTO finance.journal_lines(
    journal_entry_id,line_number,account_id,description,debit_amount,credit_amount,currency,exchange_rate,base_debit,base_credit,project_id,department_id,created_by
  )
  SELECT v_reversal_id,line_number,account_id,'REVERSAL: '||coalesce(description,''),credit_amount,debit_amount,currency,exchange_rate,base_credit,base_debit,project_id,department_id,auth.uid()
  FROM finance.journal_lines WHERE journal_entry_id=p_journal_id;

  RETURN v_reversal_id;
END;
$$;

ALTER FUNCTION "finance"."reverse_journal_entry"("p_journal_id" "uuid", "p_reversal_date" "date", "p_reason" "text") OWNER TO "postgres";

COMMENT ON FUNCTION "finance"."reverse_journal_entry"("p_journal_id" "uuid", "p_reversal_date" "date", "p_reason" "text") IS 'BUG-005 fix (database audit): added an explicit fiscal-period-lock check as defense-in-depth alongside the existing trg_prevent_closed_period_posting table trigger. BUG-003 fix: removed organization_id from the journal_lines INSERT/SELECT — that column does not exist on journal_lines (it is scoped only via journal_entry_id -> journal_entries.organization_id, already enforced by the org-scoped lookup on v_original above).';


-- ----------------------------------------------------------------------------
-- BUG-004 FIX
-- report.service.ts / dashboard.service.ts call supabase.schema('reporting')
-- for every financial statement, aging, GL, trial balance, project-profitability
-- and CEO/CFO dashboard query. The reporting.* functions/views and their
-- GRANTs to authenticated/anon already exist correctly — the only problem is
-- that PostgREST was never told "reporting" is an exposed schema, so every
-- one of those calls fails with PGRST106 ("The schema must be one of the
-- following: public, graphql_public").
--
-- You develop against schema.sql via `supabase db dump`, which means your
-- actual project is a hosted/managed Supabase project — so `supabase/config.toml`
-- (a *local CLI* file) does not control the live project's exposed schemas.
-- Two ways to actually apply this fix on the live project — do ONE of them:
--
--   (A) Recommended — Supabase Dashboard → Project Settings → Data API →
--       "Exposed schemas" → add `reporting` to the list → Save.
--       This is the officially supported path and keeps the Dashboard in sync.
--
--   (B) SQL Editor equivalent (use only if you don't want to go through the
--       Dashboard) — run the two statements below. NOTE: once you run this
--       manually, the Dashboard's "Exposed schemas" field takes a back seat —
--       if someone later edits it from the Dashboard, re-run this or use
--       `ALTER ROLE authenticator RESET pgrst.db_schemas;` first to go back to
--       Dashboard-managed control.
-- ----------------------------------------------------------------------------

ALTER ROLE authenticator SET pgrst.db_schemas = 'public, graphql_public, reporting';
NOTIFY pgrst, 'reload config';
NOTIFY pgrst, 'reload schema';


-- ============================================================================
-- BUG-005 FIX
-- reporting.ceo_dashboard_kpis(): 10 of its balance-sheet KPI subqueries
-- (total_assets, current_assets, fixed_assets_net, total_liabilities,
-- current_liabilities, retained_earnings, reserve_balance, owner_capital,
-- owner_drawings, distributable_profit) joined journal_entries with
--   JOIN finance.journal_entries je ON je.status = 'POSTED'
-- i.e. NO je.id = jl.journal_entry_id condition. Every journal_lines row
-- matched every posted journal_entries row (Cartesian cross-join), so each
-- of these sums was multiplied by the total count of posted journal entries.
--
-- Fix: add the missing "je.id = jl.journal_entry_id" join condition, exactly
-- matching the pattern already used correctly a few lines above in the same
-- function for revenue_mtd/cogs_mtd/opex_mtd/net_profit_mtd etc. Nothing
-- else in the function (period logic, cash, receivables/payables, pending
-- approvals, risk counters) is touched.
-- ============================================================================

CREATE OR REPLACE FUNCTION "reporting"."ceo_dashboard_kpis"() RETURNS json
    LANGUAGE "plpgsql" STABLE
    SET "search_path" TO 'pg_catalog', 'reporting', 'public'
    AS $$ DECLARE
  v_period_id UUID;
  v_prev_period_id UUID;
  v_total_cash NUMERIC := 0;
  v_monthly_expense NUMERIC := 0;
BEGIN
  SELECT id INTO v_period_id FROM finance.accounting_periods WHERE status = 'OPEN' ORDER BY start_date DESC LIMIT 1;
  SELECT id INTO v_prev_period_id FROM finance.accounting_periods WHERE status IN ('OPEN','SOFT_CLOSED','HARD_CLOSED') AND id != v_period_id ORDER BY start_date DESC LIMIT 1;
  
  SELECT COALESCE(SUM(opening_balance), 0) INTO v_total_cash FROM finance.financial_accounts WHERE is_active = true;
  
  SELECT COALESCE(SUM(jl.debit_amount - jl.credit_amount) / NULLIF(COUNT(DISTINCT je.period_id), 1), 0) INTO v_monthly_expense
  FROM finance.journal_lines jl
  JOIN finance.journal_entries je ON je.id = jl.journal_entry_id
  JOIN finance.chart_of_accounts ca ON ca.id = jl.account_id
  JOIN finance.accounting_periods ap ON ap.id = je.period_id
  WHERE je.status = 'POSTED'
    AND ca.account_type IN ('COST_OF_SALES','OPERATING_EXPENSE','OTHER_EXPENSE')
    AND ap.status IN ('SOFT_CLOSED','HARD_CLOSED')
    AND ap.end_date >= CURRENT_DATE - INTERVAL '4 months'
    AND ap.start_date < CURRENT_DATE;
    
  IF v_monthly_expense = 0 THEN
    SELECT COALESCE(SUM(jl.debit_amount - jl.credit_amount) / 3, 0) INTO v_monthly_expense
    FROM finance.journal_lines jl
    JOIN finance.journal_entries je ON je.id = jl.journal_entry_id
    JOIN finance.chart_of_accounts ca ON ca.id = jl.account_id
    WHERE je.status = 'POSTED' AND ca.account_type IN ('COST_OF_SALES','OPERATING_EXPENSE','OTHER_EXPENSE');
  END IF;

  RETURN json_build_object(
    'revenue_mtd', COALESCE((SELECT SUM(jl.credit_amount - jl.debit_amount) FROM finance.journal_lines jl JOIN finance.chart_of_accounts ca ON ca.id = jl.account_id JOIN finance.journal_entries je ON je.id = jl.journal_entry_id WHERE je.period_id = v_period_id AND je.status = 'POSTED' AND ca.account_type = 'REVENUE'), 0),
    'revenue_prev', COALESCE((SELECT SUM(jl.credit_amount - jl.debit_amount) FROM finance.journal_lines jl JOIN finance.chart_of_accounts ca ON ca.id = jl.account_id JOIN finance.journal_entries je ON je.id = jl.journal_entry_id WHERE je.period_id = v_prev_period_id AND je.status = 'POSTED' AND ca.account_type = 'REVENUE'), 0),
    'cogs_mtd', COALESCE((SELECT SUM(jl.debit_amount - jl.credit_amount) FROM finance.journal_lines jl JOIN finance.chart_of_accounts ca ON ca.id = jl.account_id JOIN finance.journal_entries je ON je.id = jl.journal_entry_id WHERE je.period_id = v_period_id AND je.status = 'POSTED' AND ca.account_type = 'COST_OF_SALES'), 0),
    'opex_mtd', COALESCE((SELECT SUM(jl.debit_amount - jl.credit_amount) FROM finance.journal_lines jl JOIN finance.chart_of_accounts ca ON ca.id = jl.account_id JOIN finance.journal_entries je ON je.id = jl.journal_entry_id WHERE je.period_id = v_period_id AND je.status = 'POSTED' AND ca.account_type = 'OPERATING_EXPENSE'), 0),
    'other_income_mtd', COALESCE((SELECT SUM(jl.credit_amount - jl.debit_amount) FROM finance.journal_lines jl JOIN finance.chart_of_accounts ca ON ca.id = jl.account_id JOIN finance.journal_entries je ON je.id = jl.journal_entry_id WHERE je.period_id = v_period_id AND je.status = 'POSTED' AND ca.account_type = 'OTHER_INCOME'), 0),
    'other_expense_mtd', COALESCE((SELECT SUM(jl.debit_amount - jl.credit_amount) FROM finance.journal_lines jl JOIN finance.chart_of_accounts ca ON ca.id = jl.account_id JOIN finance.journal_entries je ON je.id = jl.journal_entry_id WHERE je.period_id = v_period_id AND je.status = 'POSTED' AND ca.account_type = 'OTHER_EXPENSE'), 0),
    'net_profit_mtd', COALESCE((SELECT SUM(CASE WHEN ca.normal_balance = 'CREDIT' THEN jl.credit_amount - jl.debit_amount ELSE jl.debit_amount - jl.credit_amount END) FROM finance.journal_lines jl JOIN finance.chart_of_accounts ca ON ca.id = jl.account_id JOIN finance.journal_entries je ON je.id = jl.journal_entry_id WHERE je.period_id = v_period_id AND je.status = 'POSTED' AND ca.account_type IN ('REVENUE','COST_OF_SALES','OPERATING_EXPENSE','OTHER_INCOME','OTHER_EXPENSE')), 0),
    'net_profit_prev', COALESCE((SELECT SUM(CASE WHEN ca.normal_balance = 'CREDIT' THEN jl.credit_amount - jl.debit_amount ELSE jl.debit_amount - jl.credit_amount END) FROM finance.journal_lines jl JOIN finance.chart_of_accounts ca ON ca.id = jl.account_id JOIN finance.journal_entries je ON je.id = jl.journal_entry_id WHERE je.period_id = v_prev_period_id AND je.status = 'POSTED' AND ca.account_type IN ('REVENUE','COST_OF_SALES','OPERATING_EXPENSE','OTHER_INCOME','OTHER_EXPENSE')), 0),
    'total_assets', COALESCE((SELECT SUM(CASE WHEN ca.code LIKE '153%' THEN jl.credit_amount - jl.debit_amount ELSE jl.debit_amount - jl.credit_amount END) FROM finance.journal_lines jl JOIN finance.chart_of_accounts ca ON ca.id = jl.account_id JOIN finance.journal_entries je ON je.id = jl.journal_entry_id AND je.status = 'POSTED' WHERE ca.account_type = 'ASSET'), 0),
    'current_assets', COALESCE((SELECT SUM(jl.debit_amount - jl.credit_amount) FROM finance.journal_lines jl JOIN finance.chart_of_accounts ca ON ca.id = jl.account_id JOIN finance.journal_entries je ON je.id = jl.journal_entry_id AND je.status = 'POSTED' WHERE ca.account_type = 'ASSET' AND ca.code LIKE '1%'), 0),
    'fixed_assets_net', COALESCE((SELECT SUM(CASE WHEN ca.code LIKE '153%' THEN jl.credit_amount - jl.debit_amount ELSE jl.debit_amount - jl.credit_amount END) FROM finance.journal_lines jl JOIN finance.chart_of_accounts ca ON ca.id = jl.account_id JOIN finance.journal_entries je ON je.id = jl.journal_entry_id AND je.status = 'POSTED' WHERE ca.code LIKE '15%' OR ca.code LIKE '153%'), 0),
    'total_liabilities', COALESCE((SELECT SUM(jl.credit_amount - jl.debit_amount) FROM finance.journal_lines jl JOIN finance.chart_of_accounts ca ON ca.id = jl.account_id JOIN finance.journal_entries je ON je.id = jl.journal_entry_id AND je.status = 'POSTED' WHERE ca.account_type = 'LIABILITY'), 0),
    'current_liabilities', COALESCE((SELECT SUM(jl.credit_amount - jl.debit_amount) FROM finance.journal_lines jl JOIN finance.chart_of_accounts ca ON ca.id = jl.account_id JOIN finance.journal_entries je ON je.id = jl.journal_entry_id AND je.status = 'POSTED' WHERE ca.account_type = 'LIABILITY' AND ca.code LIKE '2%'), 0),
    'total_cash', v_total_cash,
    'cash_runway_months', CASE WHEN v_monthly_expense > 0 THEN FLOOR(v_total_cash / v_monthly_expense) ELSE 0 END,
    'accounts_receivable', COALESCE((SELECT SUM(COALESCE(outstanding_amount, 0)) FROM public.invoices WHERE status IN ('ISSUED','PARTIALLY_PAID','OVERDUE')), 0),
    'accounts_payable', COALESCE((SELECT SUM(COALESCE(outstanding_amount, 0)) FROM finance.vendor_bills WHERE status IN ('POSTED','PARTIALLY_PAID')), 0),
    'retained_earnings', COALESCE((SELECT SUM(jl.credit_amount - jl.debit_amount) FROM finance.journal_lines jl JOIN finance.chart_of_accounts ca ON ca.id = jl.account_id JOIN finance.journal_entries je ON je.id = jl.journal_entry_id AND je.status = 'POSTED' WHERE ca.code = '3200'), 0),
    'reserve_balance', COALESCE((SELECT SUM(jl.credit_amount - jl.debit_amount) FROM finance.journal_lines jl JOIN finance.chart_of_accounts ca ON ca.id = jl.account_id JOIN finance.journal_entries je ON je.id = jl.journal_entry_id AND je.status = 'POSTED' WHERE ca.code LIKE '33%'), 0),
    'owner_capital', COALESCE((SELECT SUM(jl.credit_amount - jl.debit_amount) FROM finance.journal_lines jl JOIN finance.chart_of_accounts ca ON ca.id = jl.account_id JOIN finance.journal_entries je ON je.id = jl.journal_entry_id AND je.status = 'POSTED' WHERE ca.code = '3110'), 0),
    'owner_drawings', COALESCE((SELECT SUM(jl.debit_amount - jl.credit_amount) FROM finance.journal_lines jl JOIN finance.chart_of_accounts ca ON ca.id = jl.account_id JOIN finance.journal_entries je ON je.id = jl.journal_entry_id AND je.status = 'POSTED' WHERE ca.code = '2420'), 0),
    'distributable_profit', GREATEST(
      COALESCE((SELECT SUM(CASE WHEN ca.normal_balance = 'CREDIT' THEN jl.credit_amount - jl.debit_amount ELSE jl.debit_amount - jl.credit_amount END) FROM finance.journal_lines jl JOIN finance.chart_of_accounts ca ON ca.id = jl.account_id JOIN finance.journal_entries je ON je.id = jl.journal_entry_id AND je.status = 'POSTED' WHERE ca.account_type IN ('REVENUE','COST_OF_SALES','OPERATING_EXPENSE','OTHER_INCOME','OTHER_EXPENSE')), 0)
      - COALESCE((SELECT SUM(jl.debit_amount - jl.credit_amount) FROM finance.journal_lines jl JOIN finance.chart_of_accounts ca ON ca.id = jl.account_id JOIN finance.journal_entries je ON je.id = jl.journal_entry_id AND je.status = 'POSTED' WHERE ca.code = '7111'), 0)
      - COALESCE((SELECT SUM(jl.credit_amount - jl.debit_amount) FROM finance.journal_lines jl JOIN finance.chart_of_accounts ca ON ca.id = jl.account_id JOIN finance.journal_entries je ON je.id = jl.journal_entry_id AND je.status = 'POSTED' WHERE ca.code LIKE '33%'), 0),
      0
    ),
    'pending_approvals', (
      COALESCE((SELECT COUNT(*) FROM public.invoices WHERE status = 'SUBMITTED'), 0) +
      COALESCE((SELECT COUNT(*) FROM finance.vendor_bills WHERE status IN ('SUBMITTED','VERIFIED')), 0) +
      COALESCE((SELECT COUNT(*) FROM public.expenses WHERE status = 'SUBMITTED'), 0)
    ),
    'unreconciled_lines', COALESCE((SELECT COUNT(*) FROM finance.statement_lines WHERE reconciliation_status = 'UNRECONCILED'), 0),
    'risk_overdue_receivables', COALESCE((SELECT COUNT(*) FROM public.invoices WHERE status = 'OVERDUE'), 0),
    'risk_overdue_payables', COALESCE((SELECT COUNT(*) FROM finance.vendor_bills WHERE status IN ('POSTED','PARTIALLY_PAID') AND due_date < CURRENT_DATE), 0),
    'risk_unreconciled', COALESCE((SELECT COUNT(DISTINCT bank_statement_id) FROM finance.statement_lines WHERE reconciliation_status = 'UNRECONCILED'), 0),
    'risk_pending_period_close', COALESCE((SELECT COUNT(*) FROM finance.accounting_periods WHERE status = 'OPEN' AND end_date < CURRENT_DATE + INTERVAL '7 days'), 0)
  );
END;
 $$;


ALTER FUNCTION "reporting"."ceo_dashboard_kpis"() OWNER TO "postgres";