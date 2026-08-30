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


-- ============================================================================
-- BUG-014 FIX (part 1 of 2)
-- finance.compute_tax_liability gets a defense-in-depth organization check
-- (was previously fetching the reconciliation by id alone, with no org scope
-- inside the function itself — the route.ts caller already checks org
-- ownership before invoking, but the DB function should not rely solely on
-- that, matching the pattern used elsewhere e.g. finance.reverse_journal_entry).
--
-- BUG-015 FIX
-- PBT was computed from jl.credit_amount/jl.debit_amount (original transaction-
-- currency numerals) instead of jl.base_credit/jl.base_debit (the PKR-consolidated
-- amounts already stored on every posted line). Any USD/EUR invoice or expense
-- therefore mixed foreign-currency numbers directly into what is supposed to be
-- a PKR Profit Before Tax, corrupting taxable income, gross tax, net payable and
-- profit-after-tax for any organization with non-PKR activity (spec 5.12: PKR is
-- the ledger and fiscal-statement currency).
-- ============================================================================

CREATE OR REPLACE FUNCTION "finance"."compute_tax_liability"("p_tax_recon_id" "uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'finance', 'public', 'core'
    AS $$
DECLARE
    v_recon RECORD;
    v_pbt NUMERIC(18,2) := 0;
    v_total_adj NUMERIC(18,2) := 0;
    v_taxable_income NUMERIC(18,2);
    v_gross_tax NUMERIC(18,2) := 0;
    v_remaining_income NUMERIC(18,2);
    v_slab_income NUMERIC(18,2);
    v_slab RECORD;
    v_rule_status TEXT;
BEGIN
    -- BUG-014 defense-in-depth: scope to the caller's organization at the database
    -- level too, not only in the API route, matching the pattern used elsewhere
    -- (e.g. finance.reverse_journal_entry) for server-side-enforced controls.
    SELECT * INTO v_recon FROM finance.tax_reconciliations
    WHERE id = p_tax_recon_id AND organization_id = core.current_user_org_id();
    IF NOT FOUND THEN RAISE EXCEPTION 'Tax reconciliation not found or access denied'; END IF;

    SELECT status INTO v_rule_status FROM finance.tax_rule_sets WHERE id = v_recon.tax_rule_set_id;
    IF v_rule_status IS NULL THEN RAISE EXCEPTION 'Tax rule set not found'; END IF;
    IF v_rule_status NOT IN ('APPROVED', 'LOCKED') THEN
        RAISE EXCEPTION 'Tax rule set must be APPROVED or LOCKED, current: %', v_rule_status;
    END IF;

    -- BUG-015 FIX: PBT must be consolidated PKR (spec 5.12: PKR is the ledger and
    -- fiscal-statement currency), so this uses base_credit/base_debit (the PKR-converted
    -- amounts stored on every posted line) instead of credit_amount/debit_amount (the
    -- original transaction-currency amounts). Mixing transaction-currency numerals
    -- directly into PBT corrupted every downstream figure for any non-PKR activity.
    -- PBT = Revenue Net - Expense Net (in base currency)
    -- Revenue Net = credit - debit (revenue increases on credit side)
    -- Expense Net = debit - credit (expenses increase on debit side)
    SELECT
        COALESCE(SUM(CASE WHEN coa.account_type IN ('REVENUE','OTHER_INCOME')
                          THEN jl.base_credit - jl.base_debit ELSE 0 END), 0)
        -
        COALESCE(SUM(CASE WHEN coa.account_type IN ('OTHER_EXPENSE','OPERATING_EXPENSE','COST_OF_SALES')
                          THEN jl.base_debit - jl.base_credit ELSE 0 END), 0)
    INTO v_pbt
    FROM finance.journal_lines jl
    JOIN finance.journal_entries je ON je.id = jl.journal_entry_id
    JOIN finance.chart_of_accounts coa ON coa.id = jl.account_id
    JOIN finance.accounting_periods ap ON ap.id = je.period_id
    WHERE ap.fiscal_year_id = v_recon.fiscal_year_id
      AND je.status = 'POSTED'
      AND coa.account_type IN ('REVENUE','COST_OF_SALES','OPERATING_EXPENSE','OTHER_INCOME','OTHER_EXPENSE');

    -- Sum adjustments
    SELECT COALESCE(SUM(amount), 0) INTO v_total_adj
    FROM finance.tax_adjustments
    WHERE tax_reconciliation_id = p_tax_recon_id;

    v_taxable_income := v_pbt + v_total_adj;

    -- Apply Tax Slabs progressively
    v_remaining_income := v_taxable_income;

    FOR v_slab IN
        SELECT * FROM finance.tax_slabs
        WHERE tax_rule_set_id = v_recon.tax_rule_set_id
        ORDER BY sort_order ASC, income_from ASC
    LOOP
        IF v_remaining_income <= 0 THEN EXIT; END IF;

        v_slab_income := LEAST(
            v_remaining_income,
            COALESCE(v_slab.income_to, 999999999999) - v_slab.income_from + 1
        );
        v_slab_income := GREATEST(v_slab_income, 0);

        v_gross_tax := v_gross_tax + (v_slab_income * v_slab.tax_rate / 100.0) + v_slab.fixed_amount;
        v_remaining_income := v_remaining_income - v_slab_income;
    END LOOP;

    UPDATE finance.tax_reconciliations SET
         accounting_profit_before_tax = v_pbt,
        taxable_income = v_taxable_income,
        gross_tax_liability = v_gross_tax,
        net_tax_payable = GREATEST(v_gross_tax - v_recon.withholding_credits - v_recon.advance_tax_credits - v_recon.other_tax_credits, 0),
        profit_after_tax = v_pbt - GREATEST(v_gross_tax - v_recon.withholding_credits - v_recon.advance_tax_credits - v_recon.other_tax_credits, 0),
        effective_tax_rate = CASE 
            WHEN v_pbt > 0 
            THEN ROUND(GREATEST(v_gross_tax - v_recon.withholding_credits - v_recon.advance_tax_credits - v_recon.other_tax_credits, 0) / v_pbt * 100, 2) 
            ELSE 0 
        END,
        status = 'CALCULATED',
        updated_at = NOW()
    WHERE id = p_tax_recon_id;
END;
 $$;


ALTER FUNCTION "finance"."compute_tax_liability"("p_tax_recon_id" "uuid") OWNER TO "postgres";

-- ============================================================================
-- BUG-014 FIX (part 2 of 2) — see approve_tax_reconciliation below.
-- ============================================================================

-- ============================================================================
-- BUG-014 FIX (part 2 of 2): finance.approve_tax_reconciliation did not exist
-- anywhere in the dump or migrations, so every PATCH {"action":"approve"} call
-- from src/app/api/finance/tax/reconciliation/route.ts failed. This creates it,
-- enforcing server-side exactly what spec 12.5.1 step 7 and Appendix A require:
-- only CEO/Finance Head may approve (Accountant's row in Appendix A is "Config",
-- not full approval authority), the reconciliation must actually be calculated
-- and reviewed first (CALCULATED/UNDER_REVIEW), and the accountant who created
-- it cannot also be the one who approves it (spec 7.1 Accountant: "Cannot
-- normally approve own entries" — maker-checker).
-- ============================================================================

CREATE OR REPLACE FUNCTION "finance"."approve_tax_reconciliation"("p_recon_id" "uuid", "p_user_id" "uuid", "p_organization_id" "uuid" DEFAULT NULL::"uuid")
RETURNS "finance"."tax_reconciliations"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'finance', 'public', 'core'
    AS $$
DECLARE
  v_recon RECORD;
  v_org uuid := COALESCE(p_organization_id, core.current_user_org_id());
  v_result finance.tax_reconciliations;
BEGIN
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'Organization context is required';
  END IF;

  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'Approving user is required';
  END IF;

  IF NOT core.is_finance_head() THEN
    RAISE EXCEPTION 'Only CEO or Finance Head may approve a tax reconciliation';
  END IF;

  SELECT * INTO v_recon
  FROM finance.tax_reconciliations
  WHERE id = p_recon_id AND organization_id = v_org
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Tax reconciliation not found or access denied';
  END IF;

  IF v_recon.status NOT IN ('CALCULATED', 'UNDER_REVIEW') THEN
    RAISE EXCEPTION 'Tax reconciliation must be CALCULATED or UNDER_REVIEW to approve, current: %', v_recon.status;
  END IF;

  IF v_recon.created_by IS NOT NULL AND v_recon.created_by = p_user_id THEN
    RAISE EXCEPTION 'Maker-checker: the user who created this reconciliation cannot also approve it';
  END IF;

  UPDATE finance.tax_reconciliations
  SET status = 'ACCOUNTANT_APPROVED',
      accountant_approved_by = p_user_id,
      approved_at = now(),
      rejection_reason = NULL,
      updated_at = now()
  WHERE id = p_recon_id
  RETURNING * INTO v_result;

  RETURN v_result;
END;
$$;

ALTER FUNCTION "finance"."approve_tax_reconciliation"("p_recon_id" "uuid", "p_user_id" "uuid", "p_organization_id" "uuid") OWNER TO "postgres";

GRANT EXECUTE ON FUNCTION "finance"."approve_tax_reconciliation"("p_recon_id" "uuid", "p_user_id" "uuid", "p_organization_id" "uuid") TO "authenticated";


-- ============================================================================
-- BUG-014 FIX (part 3 of 3 — the actual "unguarded direct UPDATE" hole)
-- The evidence line "ACCOUNTANT_APPROVED reachable only through an unguarded
-- direct UPDATE from the UI" traces to finance.tax_reconciliations' own RLS
-- UPDATE policy (tr_update_restricted): it allows ANY of CEO/admin, Finance
-- Head, OR a plain ACCOUNTANT to UPDATE the row with no restriction on which
-- status it can be moved to. That let an accountant set
-- status='ACCOUNTANT_APPROVED' directly via a normal PostgREST UPDATE, self-
-- approving their own reconciliation — exactly the maker-checker bypass spec
-- 7.1 ("Accountant... Cannot normally approve own entries") forbids.
--
-- This narrows the policy to block status='ACCOUNTANT_APPROVED' from ANY
-- direct client UPDATE, regardless of role. finance.approve_tax_reconciliation()
-- (added above) is SECURITY DEFINER and runs as the table owner, which bypasses
-- RLS entirely, so it is unaffected by this restriction — it remains the only
-- path into ACCOUNTANT_APPROVED. No other status value or column is touched,
-- so any other existing direct-update workflow (e.g. recording a filing) is
-- left exactly as permissive as before.
-- ============================================================================

DROP POLICY IF EXISTS "tr_update_restricted" ON "finance"."tax_reconciliations";

CREATE POLICY "tr_update_restricted" ON "finance"."tax_reconciliations"
    FOR UPDATE
    USING (((core.is_ceo_or_admin() OR core.is_finance_head() OR core.has_role('ACCOUNTANT'::text)) AND core.same_org(organization_id)))
    WITH CHECK (
        ((core.is_ceo_or_admin() OR core.is_finance_head() OR core.has_role('ACCOUNTANT'::text)) AND core.same_org(organization_id))
        AND status IS DISTINCT FROM 'ACCOUNTANT_APPROVED'
    );


-- ############################################################################
-- BUG-025 / BUG-026 FIXES (Banking: bank transfers + reconciliation)
-- ############################################################################

CREATE OR REPLACE FUNCTION "finance"."fn_set_dual_approval"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$ DECLARE v_min NUMERIC; v_flag BOOLEAN;
BEGIN
    -- BUG-025 FIX: this previously only ever looked at min_dual_approval_amount,
    -- so an account with requires_dual_approval = TRUE but no configured
    -- min_dual_approval_amount (NULL, defaulted to a practically-unreachable
    -- 999999999999 fallback) could NEVER actually trigger dual approval on a
    -- transfer -- the account-level "always needs dual approval" flag was
    -- effectively dead. BOOL_OR now also propagates that flag directly: if
    -- either the source or destination account is flagged, the transfer
    -- requires dual approval regardless of amount. The existing amount-
    -- threshold behavior (v_min) is unchanged.
    SELECT MIN(COALESCE(min_dual_approval_amount, 999999999999)), BOOL_OR(COALESCE(requires_dual_approval, false))
    INTO v_min, v_flag FROM finance.financial_accounts WHERE id IN (NEW.from_account_id, NEW.to_account_id);
    IF COALESCE(v_flag, false) OR NEW.from_amount >= v_min THEN NEW.requires_dual_approval := TRUE; END IF;
    RETURN NEW;
END;
 $$;


ALTER FUNCTION "finance"."fn_set_dual_approval"() OWNER TO "postgres";
CREATE OR REPLACE FUNCTION "finance"."post_bank_transfer"("p_transfer_id" "uuid", "p_period_id" "uuid", "p_transaction_date" "date") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'finance', 'public', 'core'
    AS $$
DECLARE
    v_org uuid;
    v_t RECORD;
    v_fy_id UUID;
    v_from_ledger UUID;
    v_to_ledger UUID;
    v_fx_gain UUID;
    v_fx_loss UUID;
    v_lines JSONB := '[]'::JSONB;
    v_fx_diff NUMERIC(18,2);
    v_from_base NUMERIC(18,2);
    v_to_base NUMERIC(18,2);
    v_from_rate NUMERIC(18,6);
    v_to_rate NUMERIC(18,6);
BEGIN
    -- BUG-025 FIX (four issues in this one check, all from the same missing
    -- guard block):
    -- 1) No organization scoping at all -- any authenticated user of any org
    --    could post an arbitrary transfer by id (see BUG-026 for the same
    --    pattern on the reconciliation-matching functions).
    -- 2) No role/permission check at all.
    -- 3) 'SUBMITTED' was an accepted status for posting, meaning a transfer
    --    that was never actually approved could still be posted.
    -- 4) requires_dual_approval / second_approved_by were never checked, so
    --    even a transfer correctly left at SUBMITTED pending its second
    --    approval could be posted by calling this function directly.
    v_org := core.current_user_org_id();
    IF v_org IS NULL THEN RAISE EXCEPTION 'Organization context is required'; END IF;
    IF NOT (core.is_finance_head() OR core.has_role('ACCOUNTANT')) THEN
        RAISE EXCEPTION 'Access denied';
    END IF;

    SELECT * INTO v_t FROM finance.bank_transfers
    WHERE id = p_transfer_id AND organization_id = v_org
    FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Transfer not found or access denied'; END IF;
    IF v_t.status <> 'APPROVED' THEN RAISE EXCEPTION 'Must be approved, status: %', v_t.status; END IF;
    IF v_t.requires_dual_approval AND v_t.second_approved_by IS NULL THEN
        RAISE EXCEPTION 'This transfer requires a second approval before it can be posted';
    END IF;

    SELECT fiscal_year_id INTO v_fy_id FROM finance.accounting_periods WHERE id = p_period_id;
    IF v_fy_id IS NULL THEN RAISE EXCEPTION 'Invalid period'; END IF;

    SELECT linked_ledger_account_id INTO v_from_ledger FROM finance.financial_accounts WHERE id = v_t.from_account_id;
    SELECT linked_ledger_account_id INTO v_to_ledger FROM finance.financial_accounts WHERE id = v_t.to_account_id;

    --  BUG FIX: 4210 = Exchange Gain (exists), 7121 = Realized FX Loss (exists, was 7210)
    SELECT id INTO v_fx_gain FROM finance.chart_of_accounts WHERE code = '4210' LIMIT 1;
    SELECT id INTO v_fx_loss FROM finance.chart_of_accounts WHERE code = '7121' LIMIT 1;

    -- From side to PKR base
    IF v_t.from_currency = 'PKR' THEN v_from_base := v_t.from_amount; v_from_rate := 1;
    ELSE
        --  BUG FIX: rate_date NOT effective_date
        SELECT rate INTO v_from_rate FROM finance.exchange_rates
        WHERE from_currency = v_t.from_currency AND to_currency = 'PKR'
        ORDER BY rate_date DESC LIMIT 1;
        IF v_from_rate IS NULL THEN v_from_rate := v_t.exchange_rate; END IF;
        v_from_base := ROUND(v_t.from_amount * v_from_rate, 2);
    END IF;

    -- To side to PKR base
    IF v_t.to_currency = 'PKR' THEN v_to_base := v_t.to_amount; v_to_rate := 1;
    ELSE
        --  BUG FIX: rate_date NOT effective_date
        SELECT rate INTO v_to_rate FROM finance.exchange_rates
        WHERE from_currency = v_t.to_currency AND to_currency = 'PKR'
        ORDER BY rate_date DESC LIMIT 1;
        IF v_to_rate IS NULL THEN v_to_rate := 1 / v_t.exchange_rate; END IF;
        v_to_base := ROUND(v_t.to_amount * v_to_rate, 2);
    END IF;

    -- Same currency
    IF v_t.from_currency = v_t.to_currency THEN
        v_lines := v_lines || jsonb_build_object('account_id', v_to_ledger, 'debit_amount', v_t.to_amount, 'credit_amount', 0, 'description', 'Transfer TO: ' || v_t.transfer_number);
        v_lines := v_lines || jsonb_build_object('account_id', v_from_ledger, 'debit_amount', 0, 'credit_amount', v_t.from_amount, 'description', 'Transfer FROM: ' || v_t.transfer_number);
    ELSE
        v_fx_diff := v_to_base - v_from_base;
        v_lines := v_lines || jsonb_build_object('account_id', v_to_ledger, 'debit_amount', v_to_base, 'credit_amount', 0, 'description', 'Transfer TO: ' || v_t.transfer_number || ' (' || v_t.to_amount || ' ' || v_t.to_currency || ')');
        v_lines := v_lines || jsonb_build_object('account_id', v_from_ledger, 'debit_amount', 0, 'credit_amount', v_from_base, 'description', 'Transfer FROM: ' || v_t.transfer_number || ' (' || v_t.from_amount || ' ' || v_t.from_currency || ')');
        IF v_fx_diff > 0 AND v_fx_gain IS NOT NULL THEN
            v_lines := v_lines || jsonb_build_object('account_id', v_fx_gain, 'debit_amount', 0, 'credit_amount', v_fx_diff, 'description', 'FX Gain: ' || v_t.transfer_number);
        ELSIF v_fx_diff < 0 AND v_fx_loss IS NOT NULL THEN
            v_lines := v_lines || jsonb_build_object('account_id', v_fx_loss, 'debit_amount', ABS(v_fx_diff), 'credit_amount', 0, 'description', 'FX Loss: ' || v_t.transfer_number);
        END IF;
    END IF;

    --  CORRECT PARAMETER ORDER
    RETURN finance.post_journal_entry('Bank Transfer: ' || v_t.transfer_number, p_transaction_date, p_period_id, v_lines, 'PKR', 1.0000, 'BANK_TRANSFER', p_transfer_id, NULL, NULL);
END;
$$;


ALTER FUNCTION "finance"."post_bank_transfer"("p_transfer_id" "uuid", "p_period_id" "uuid", "p_transaction_date" "date") OWNER TO "postgres";
-- ============================================================================
-- BUG-025 FIX (part 2): finance.update_bank_transfer_status did not exist
-- anywhere in the dump or migrations, so src/services/bank.service.ts's
-- updateTransferStatus() always failed and every transfer dead-ended at
-- DRAFT (submit/approve/reject/cancel all broken). This function is called
-- directly from the browser client (there is no server-side API route in
-- front of it), so it is the sole enforcement point and does everything
-- server-side: organization scoping, role checks, and the DRAFT ->
-- SUBMITTED -> APPROVED state machine including dual approval.
--
-- Dual approval itself is recorded using the columns that already exist
-- (approved_by/approved_at for the first approval, second_approved_by/
-- second_approved_at for the second) rather than a new status value --
-- bank_transfers_status_check does not have a "PENDING_SECOND_APPROVAL"
-- state, so when requires_dual_approval is true, the first APPROVED call
-- only records approved_by and leaves status at SUBMITTED; status only
-- becomes APPROVED once both approvals are recorded.
--
-- This does NOT duplicate the creator<>approver / first-approver<>second-
-- approver checks: finance.enforce_maker_checker is already wired to
-- bank_transfers (BEFORE INSERT OR UPDATE) and enforces exactly that at the
-- database level on every UPDATE regardless of caller, so those checks
-- would fire even without this function.
-- ============================================================================

CREATE OR REPLACE FUNCTION "finance"."update_bank_transfer_status"("p_transfer_id" "uuid", "p_status" "text", "p_rejection_reason" "text" DEFAULT NULL::"text")
RETURNS "finance"."bank_transfers"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'finance', 'public', 'core'
    AS $$
DECLARE
  v_org uuid := core.current_user_org_id();
  v_user uuid := auth.uid();
  v_transfer RECORD;
  v_result finance.bank_transfers;
BEGIN
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'Organization context is required';
  END IF;
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;
  IF p_status NOT IN ('SUBMITTED', 'APPROVED', 'REJECTED', 'CANCELLED') THEN
    RAISE EXCEPTION 'Unsupported status transition: %', p_status;
  END IF;

  SELECT * INTO v_transfer
  FROM finance.bank_transfers
  WHERE id = p_transfer_id AND organization_id = v_org
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Bank transfer not found or access denied';
  END IF;

  IF p_status = 'SUBMITTED' THEN
    IF v_transfer.status <> 'DRAFT' THEN
      RAISE EXCEPTION 'Only a DRAFT transfer can be submitted, current: %', v_transfer.status;
    END IF;
    IF NOT (core.has_role('ACCOUNTANT') OR core.is_finance_head()) THEN
      RAISE EXCEPTION 'Access denied';
    END IF;

    UPDATE finance.bank_transfers SET status = 'SUBMITTED'
    WHERE id = p_transfer_id RETURNING * INTO v_result;

  ELSIF p_status = 'APPROVED' THEN
    IF v_transfer.status <> 'SUBMITTED' THEN
      RAISE EXCEPTION 'Only a SUBMITTED transfer can be approved, current: %', v_transfer.status;
    END IF;
    IF NOT core.is_finance_head() THEN
      RAISE EXCEPTION 'Only CEO or Finance Head may approve a bank transfer';
    END IF;

    IF v_transfer.approved_by IS NULL THEN
      -- First approval leg. enforce_maker_checker blocks creator == approver.
      IF v_transfer.requires_dual_approval THEN
        UPDATE finance.bank_transfers SET approved_by = v_user, approved_at = now()
        WHERE id = p_transfer_id RETURNING * INTO v_result; -- status stays SUBMITTED, awaiting second approval
      ELSE
        UPDATE finance.bank_transfers SET status = 'APPROVED', approved_by = v_user, approved_at = now()
        WHERE id = p_transfer_id RETURNING * INTO v_result;
      END IF;
    ELSE
      IF NOT v_transfer.requires_dual_approval THEN
        RAISE EXCEPTION 'This transfer has already received its required approval';
      END IF;
      IF v_transfer.second_approved_by IS NOT NULL THEN
        RAISE EXCEPTION 'This transfer has already received its second approval';
      END IF;
      -- Second approval leg. enforce_maker_checker blocks creator/first-approver == second approver.
      UPDATE finance.bank_transfers SET status = 'APPROVED', second_approved_by = v_user, second_approved_at = now()
      WHERE id = p_transfer_id RETURNING * INTO v_result;
    END IF;

  ELSIF p_status = 'REJECTED' THEN
    IF v_transfer.status <> 'SUBMITTED' THEN
      RAISE EXCEPTION 'Only a SUBMITTED transfer can be rejected, current: %', v_transfer.status;
    END IF;
    IF NOT core.is_finance_head() THEN
      RAISE EXCEPTION 'Only CEO or Finance Head may reject a bank transfer';
    END IF;
    IF p_rejection_reason IS NULL OR btrim(p_rejection_reason) = '' THEN
      RAISE EXCEPTION 'Rejection reason is mandatory';
    END IF;

    UPDATE finance.bank_transfers
    SET status = 'REJECTED', rejected_by = v_user, rejected_at = now(), rejection_reason = p_rejection_reason
    WHERE id = p_transfer_id RETURNING * INTO v_result;

  ELSIF p_status = 'CANCELLED' THEN
    IF v_transfer.status NOT IN ('DRAFT', 'SUBMITTED') THEN
      RAISE EXCEPTION 'An APPROVED or POSTED transfer cannot be cancelled directly, current: %', v_transfer.status;
    END IF;
    IF NOT (v_transfer.created_by = v_user OR core.is_finance_head()) THEN
      RAISE EXCEPTION 'Access denied';
    END IF;

    UPDATE finance.bank_transfers
    SET status = 'CANCELLED', rejection_reason = COALESCE(p_rejection_reason, rejection_reason)
    WHERE id = p_transfer_id RETURNING * INTO v_result;
  END IF;

  RETURN v_result;
END;
$$;

ALTER FUNCTION "finance"."update_bank_transfer_status"("p_transfer_id" "uuid", "p_status" "text", "p_rejection_reason" "text") OWNER TO "postgres";

GRANT EXECUTE ON FUNCTION "finance"."update_bank_transfer_status"("p_transfer_id" "uuid", "p_status" "text", "p_rejection_reason" "text") TO "authenticated";

CREATE OR REPLACE FUNCTION "finance"."auto_match_statement_lines"("p_statement_id" "uuid") RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'finance', 'public', 'core'
    AS $$
DECLARE
    v_matched INTEGER := 0;
    v_ledger UUID;
    v_row_count INTEGER;
    v_org uuid;
BEGIN
    -- BUG-026 FIX: this SECURITY DEFINER function took no organization
    -- parameter, had no REVOKE (Postgres defaults EXECUTE to PUBLIC on new
    -- functions), and definer execution bypasses RLS -- so any authenticated
    -- user of ANY organization could call this with an arbitrary
    -- p_statement_id and auto-match another tenant's bank statement. The
    -- organization is now taken from the caller's own session
    -- (core.current_user_org_id()), matching the pattern used elsewhere in
    -- this schema (e.g. finance.reverse_journal_entry), and checked against
    -- the statement's actual organization_id before anything is touched.
    v_org := core.current_user_org_id();
    IF v_org IS NULL THEN RAISE EXCEPTION 'Organization context is required'; END IF;

    SELECT fa.linked_ledger_account_id INTO v_ledger
    FROM finance.bank_statements bs JOIN finance.financial_accounts fa ON fa.id = bs.financial_account_id
    WHERE bs.id = p_statement_id AND bs.organization_id = v_org;
    IF v_ledger IS NULL THEN RAISE EXCEPTION 'Statement not found or access denied'; END IF;

    -- Round 1: exact amount + same date
    UPDATE finance.statement_lines sl SET
        reconciliation_status = 'MATCHED', matched_journal_line_id = jl.id,
        matched_at = NOW(), matched_by = auth.uid(), match_method = 'AUTO_AMOUNT_DATE'
    FROM finance.journal_lines jl JOIN finance.journal_entries je ON je.id = jl.journal_entry_id
    WHERE sl.bank_statement_id = p_statement_id AND sl.reconciliation_status = 'UNRECONCILED'
      AND jl.account_id = v_ledger AND je.status = 'POSTED'  --  FIXED: uppercase
      AND jl.id NOT IN (SELECT matched_journal_line_id FROM finance.statement_lines WHERE matched_journal_line_id IS NOT NULL AND reconciliation_status IN ('MATCHED','MANUAL_MATCH'))
      AND sl.transaction_date = je.transaction_date
      AND ((sl.amount > 0 AND jl.debit_amount = sl.amount) OR (sl.amount < 0 AND jl.credit_amount = ABS(sl.amount)));
    GET DIAGNOSTICS v_row_count = ROW_COUNT;
    v_matched := v_matched + v_row_count;

    -- Round 2: exact amount + reference match (±3 days)
    UPDATE finance.statement_lines sl SET
        reconciliation_status = 'MATCHED', matched_journal_line_id = jl.id,
        matched_at = NOW(), matched_by = auth.uid(), match_method = 'AUTO_AMOUNT_REF'
    FROM finance.journal_lines jl JOIN finance.journal_entries je ON je.id = jl.journal_entry_id
    WHERE sl.bank_statement_id = p_statement_id AND sl.reconciliation_status = 'UNRECONCILED'
      AND sl.reference IS NOT NULL AND sl.reference != ''
      AND jl.account_id = v_ledger AND je.status = 'POSTED'  --  FIXED: uppercase
      AND jl.id NOT IN (SELECT matched_journal_line_id FROM finance.statement_lines WHERE matched_journal_line_id IS NOT NULL AND reconciliation_status IN ('MATCHED','MANUAL_MATCH'))
      AND sl.transaction_date BETWEEN je.transaction_date - 3 AND je.transaction_date + 3
      AND je.description ILIKE '%' || sl.reference || '%'
      AND ((sl.amount > 0 AND jl.debit_amount = sl.amount) OR (sl.amount < 0 AND jl.credit_amount = ABS(sl.amount)));
    GET DIAGNOSTICS v_row_count = ROW_COUNT;
    v_matched := v_matched + v_row_count;

    -- Round 3: exact amount only (±7 days)
    UPDATE finance.statement_lines sl SET
        reconciliation_status = 'MATCHED', matched_journal_line_id = jl.id,
        matched_at = NOW(), matched_by = auth.uid(), match_method = 'AUTO_AMOUNT_DESC'
    FROM finance.journal_lines jl JOIN finance.journal_entries je ON je.id = jl.journal_entry_id
    WHERE sl.bank_statement_id = p_statement_id AND sl.reconciliation_status = 'UNRECONCILED'
      AND jl.account_id = v_ledger AND je.status = 'POSTED'  --  FIXED: uppercase
      AND jl.id NOT IN (SELECT matched_journal_line_id FROM finance.statement_lines WHERE matched_journal_line_id IS NOT NULL AND reconciliation_status IN ('MATCHED','MANUAL_MATCH'))
      AND sl.transaction_date BETWEEN je.transaction_date - 7 AND je.transaction_date + 7
      AND ((sl.amount > 0 AND jl.debit_amount = sl.amount) OR (sl.amount < 0 AND jl.credit_amount = ABS(sl.amount)));
    GET DIAGNOSTICS v_row_count = ROW_COUNT;
    v_matched := v_matched + v_row_count;

    -- Round 4: by transaction_identifier
    UPDATE finance.statement_lines sl SET
        reconciliation_status = 'MATCHED', matched_journal_line_id = jl.id,
        matched_at = NOW(), matched_by = auth.uid(), match_method = 'AUTO_IDENTIFIER'
    FROM finance.journal_lines jl JOIN finance.journal_entries je ON je.id = jl.journal_entry_id
    WHERE sl.bank_statement_id = p_statement_id AND sl.reconciliation_status = 'UNRECONCILED'
      AND sl.transaction_identifier IS NOT NULL AND sl.transaction_identifier != ''
      AND jl.account_id = v_ledger AND je.status = 'POSTED'  --  FIXED: uppercase
      AND jl.id NOT IN (SELECT matched_journal_line_id FROM finance.statement_lines WHERE matched_journal_line_id IS NOT NULL AND reconciliation_status IN ('MATCHED','MANUAL_MATCH'))
      AND je.reference ILIKE '%' || sl.transaction_identifier || '%';
    GET DIAGNOSTICS v_row_count = ROW_COUNT;
    v_matched := v_matched + v_row_count;

    RETURN v_matched;
END;
$$;


ALTER FUNCTION "finance"."auto_match_statement_lines"("p_statement_id" "uuid") OWNER TO "postgres";
CREATE OR REPLACE FUNCTION "finance"."detect_duplicate_statement_lines"("p_statement_id" "uuid") RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'finance', 'public', 'core'
    AS $$ DECLARE v_count INT; v_org uuid;
BEGIN
    -- BUG-026 FIX: same cross-tenant gap as auto_match_statement_lines -- no
    -- organization check at all on a SECURITY DEFINER function with no
    -- REVOKE. Scoped to the caller's own organization before touching
    -- anything.
    v_org := core.current_user_org_id();
    IF v_org IS NULL THEN RAISE EXCEPTION 'Organization context is required'; END IF;
    IF NOT EXISTS (SELECT 1 FROM finance.bank_statements WHERE id = p_statement_id AND organization_id = v_org) THEN
        RAISE EXCEPTION 'Statement not found or access denied';
    END IF;

    UPDATE finance.statement_lines sl SET reconciliation_status = 'DUPLICATE', exclusion_reason = 'Auto-detected duplicate'
    WHERE sl.bank_statement_id = p_statement_id AND sl.reconciliation_status = 'UNRECONCILED'
      AND EXISTS (
          SELECT 1 FROM finance.statement_lines sl2
          JOIN finance.bank_statements bs2 ON bs2.id = sl2.bank_statement_id
          WHERE bs2.financial_account_id = (SELECT financial_account_id FROM finance.bank_statements WHERE id = p_statement_id)
            AND bs2.organization_id = v_org
            AND sl2.id != sl.id AND sl2.amount = sl.amount AND sl2.transaction_date = sl.transaction_date
            AND (sl2.description = sl.description OR SIMILARITY(sl2.description, sl.description) > 0.85)
            AND sl2.reconciliation_status NOT IN ('DUPLICATE','EXCLUDED')
      );
    GET DIAGNOSTICS v_count = ROW_COUNT;
    RETURN v_count;
END;
 $$;


ALTER FUNCTION "finance"."detect_duplicate_statement_lines"("p_statement_id" "uuid") OWNER TO "postgres";
CREATE OR REPLACE FUNCTION "finance"."unmatch_statement_line"("p_line_id" "uuid", "p_reason" "text" DEFAULT NULL::"text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'finance', 'public', 'core'
    AS $$ DECLARE v_sl RECORD; v_org uuid;
BEGIN
    -- BUG-026 FIX: same cross-tenant gap as auto_match_statement_lines/
    -- detect_duplicate_statement_lines -- no organization check at all,
    -- letting any authenticated user of any org unmatch an arbitrary
    -- statement line by id. Scoped via the line's parent bank_statement.
    v_org := core.current_user_org_id();
    IF v_org IS NULL THEN RAISE EXCEPTION 'Organization context is required'; END IF;

    SELECT sl.* INTO v_sl
    FROM finance.statement_lines sl
    JOIN finance.bank_statements bs ON bs.id = sl.bank_statement_id
    WHERE sl.id = p_line_id AND bs.organization_id = v_org;
    IF NOT FOUND THEN RAISE EXCEPTION 'Line not found or access denied'; END IF;
    IF v_sl.reconciliation_status NOT IN ('MATCHED','MANUAL_MATCH') THEN RAISE EXCEPTION 'Can only unmatch matched lines'; END IF;
    UPDATE finance.statement_lines SET reconciliation_status = 'UNRECONCILED', matched_journal_line_id = NULL, matched_at = NULL, matched_by = NULL, match_method = NULL WHERE id = p_line_id;
END;
 $$;


ALTER FUNCTION "finance"."unmatch_statement_line"("p_line_id" "uuid", "p_reason" "text") OWNER TO "postgres";
-- ============================================================================
-- BUG-026 FIX (part 2): finance.finalize_bank_reconciliation did not exist
-- anywhere in the dump or migrations, so src/app/api/finance/banking/
-- reconciliation/route.ts's POST always failed and no statement could ever
-- be marked as formally reconciliation-approved (spec 12.4: "...unmatched
-- resolution -> reconciliation approval -> period report").
--
-- Note: finance.fn_stmt_recon_status (an existing trigger on statement_lines)
-- already keeps bank_statements.reconciliation_status mechanically in sync
-- with line-level matching (COMPLETED once every line is MATCHED/
-- MANUAL_MATCH/EXCLUDED) -- that part of the workflow already worked. What
-- was missing is the explicit human "reconciliation approval" act itself:
-- recording WHO approved the reconciliation and WHEN (reconciled_by/
-- reconciled_at), which the route.ts already gates behind BANK_RECONCILE
-- permission + MFA. This function is that approval step. It requires the
-- mechanical precondition (no lines left UNRECONCILED) to already be true --
-- it does not resolve lines itself, it only records approval once they are
-- resolved.
-- ============================================================================

CREATE OR REPLACE FUNCTION "finance"."finalize_bank_reconciliation"("p_statement_id" "uuid", "p_user_id" "uuid", "p_organization_id" "uuid" DEFAULT NULL::"uuid")
RETURNS "finance"."bank_statements"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'finance', 'public', 'core'
    AS $$
DECLARE
  v_org uuid := COALESCE(p_organization_id, core.current_user_org_id());
  v_statement RECORD;
  v_unresolved integer;
  v_result finance.bank_statements;
BEGIN
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'Organization context is required';
  END IF;
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'Approving user is required';
  END IF;
  IF NOT (core.is_finance_head() OR core.has_role('ACCOUNTANT')) THEN
    RAISE EXCEPTION 'Access denied';
  END IF;

  SELECT * INTO v_statement
  FROM finance.bank_statements
  WHERE id = p_statement_id AND organization_id = v_org
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Bank statement not found or access denied';
  END IF;

  IF v_statement.reconciliation_status = 'COMPLETED' AND v_statement.reconciled_by IS NOT NULL THEN
    RAISE EXCEPTION 'This statement has already been reconciled and approved';
  END IF;

  SELECT COUNT(*) INTO v_unresolved
  FROM finance.statement_lines
  WHERE bank_statement_id = p_statement_id AND reconciliation_status = 'UNRECONCILED';

  IF v_unresolved > 0 THEN
    RAISE EXCEPTION 'Cannot finalize: % statement line(s) are still unresolved (unmatched, not excluded, not flagged as duplicate)', v_unresolved;
  END IF;

  UPDATE finance.bank_statements
  SET reconciliation_status = 'COMPLETED',
      reconciled_by = p_user_id,
      reconciled_at = now(),
      updated_at = now()
  WHERE id = p_statement_id
  RETURNING * INTO v_result;

  RETURN v_result;
END;
$$;

ALTER FUNCTION "finance"."finalize_bank_reconciliation"("p_statement_id" "uuid", "p_user_id" "uuid", "p_organization_id" "uuid") OWNER TO "postgres";

GRANT EXECUTE ON FUNCTION "finance"."finalize_bank_reconciliation"("p_statement_id" "uuid", "p_user_id" "uuid", "p_organization_id" "uuid") TO "authenticated";

-- ============================================================================
-- BUG-026 FIX (part 3): these four SECURITY DEFINER functions had no
-- explicit REVOKE, so Postgres' default (EXECUTE granted to PUBLIC on newly
-- created functions) applied -- combined with definer execution bypassing
-- RLS, this meant EVERY authenticated user, in ANY organization, could
-- invoke them directly (e.g. via supabase.rpc(...) from the browser) against
-- arbitrary IDs, before the org-scoping fixes above even run. The org checks
-- added above are the real fix; this closes the same hole the way the rest
-- of this schema already does for other sensitive definer functions (see
-- e.g. finance.allocate_payment_atomic, finance.post_payment_receipt_atomic).
-- ============================================================================

REVOKE ALL ON FUNCTION "finance"."auto_match_statement_lines"("p_statement_id" "uuid") FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "finance"."auto_match_statement_lines"("p_statement_id" "uuid") TO "authenticated";

REVOKE ALL ON FUNCTION "finance"."detect_duplicate_statement_lines"("p_statement_id" "uuid") FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "finance"."detect_duplicate_statement_lines"("p_statement_id" "uuid") TO "authenticated";

REVOKE ALL ON FUNCTION "finance"."unmatch_statement_line"("p_line_id" "uuid", "p_reason" "text") FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "finance"."unmatch_statement_line"("p_line_id" "uuid", "p_reason" "text") TO "authenticated";

REVOKE ALL ON FUNCTION "finance"."post_bank_transfer"("p_transfer_id" "uuid", "p_period_id" "uuid", "p_transaction_date" "date") FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "finance"."post_bank_transfer"("p_transfer_id" "uuid", "p_period_id" "uuid", "p_transaction_date" "date") TO "authenticated";