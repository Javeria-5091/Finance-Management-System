-- =============================================================================
-- Migration P1_057: Fix callable financial-statement RPCs (BUG-001) and
--                    fiscal-year -> accounting_periods cascade delete (BUG-017)
-- =============================================================================
-- PURPOSE
--   BUG-001 (re-scoped after verification against the CURRENT codebase):
--   The audit described this as "P&L/Balance Sheet/Cash Flow SECURITY
--   DEFINER functions lack organization filtering". That is true of
--   reporting.get_profit_and_loss / get_balance_sheet / get_cash_flow
--   (defined in P0/phase_8_reports and re-defined, still without org
--   filtering, in P0/Fix_ALL_P0_BUGS.sql) -- BUT those functions are not
--   the actual problem in production, because:
--     1. supabase/config.toml only exposes `public` and `graphql_public`
--        to PostgREST (`schemas = ["public", "graphql_public"]`). The
--        `reporting` schema is never reachable via supabase.rpc() at all.
--     2. src/services/report.service.ts actually calls
--        supabase.rpc('profit_and_loss', ...), supabase.rpc('balance_sheet'),
--        and supabase.rpc('cash_flow', ...) -- unqualified names, expected
--        to resolve in `public`. No function with those names exists
--        anywhere in the migration history. Every CEO/CFO dashboard call
--        to these three reports currently fails with a PostgREST
--        "function not found" error.
--     3. The expected return shape (src/types/reports.types.ts: PLData /
--        BSData / CFData) is a single nested JSON object per statement,
--        not the flat row-set the `reporting.*` functions return -- so
--        even a correctly-scoped, correctly-named function using the old
--        row-set shape would still fail to deserialize on the frontend.
--
--   This migration creates the three functions the frontend actually
--   calls, in `public` (so PostgREST can see them), returning the JSON
--   shape the frontend actually expects, with organization scoping
--   resolved server-side via core.current_user_org_id() (the caller can
--   never override this by passing a different org id -- there is no
--   org id parameter). It supersedes reporting.get_profit_and_loss/
--   get_balance_sheet/get_cash_flow, which are left in place (harmless,
--   unreachable) rather than dropped, in case another consumer depends on
--   the reporting schema directly via a service-role connection.
--
--   Grouping is done by finance.chart_of_accounts.account_type (REVENUE,
--   COST_OF_SALES, OPERATING_EXPENSE, OTHER_INCOME, OTHER_EXPENSE / ASSET,
--   LIABILITY, EQUITY), not by report_mapping. NOTE FOR REVIEW: the
--   report_mapping seed data itself is inconsistent between migrations --
--   phase_8_reports/025_add_report_mapping.sql maps LIABILITY accounts in
--   the 21xx range to 'BALANCE_SHEET_RECEIVABLES' (should almost certainly
--   be PAYABLES for a liability), and Fix_ALL_P0_BUGS.sql's "fix" for the
--   report-mapping mismatch bug changed the CASE match target to
--   'PL_REVENUE' etc, which does NOT match the 'PROFIT_LOSS_REVENUE' etc
--   values 025 actually writes -- re-introducing the bug it claimed to
--   fix. Grouping by account_type sidesteps both problems and needs no
--   seed-data cleanup to be correct; report_mapping seed data should be
--   reconciled separately as a follow-up (flagged, not fixed, here).
--
--   BUG-017: finance.accounting_periods.fiscal_year_id currently has
--   ON DELETE CASCADE back to finance.fiscal_years. Deleting a fiscal
--   year silently deletes every accounting period under it -- and, via
--   RESTRICT on journal_entries.period_id (the default, already in
--   place), that delete only succeeds once no journal is posted to any
--   of those periods, which is precisely the case where the periods
--   are "just setup, no history yet" and their loss is least likely to
--   be noticed until reporting breaks. This contradicts spec 4.3 ("all
--   monetary/period controls") and 10.5 ("financial history is
--   retained"). Fixed using the same RESTRICT + explicit business-
--   readable trigger pattern already used in P1_028 for
--   financial_accounts/invoices.
--
-- SAFETY
--   Additive/corrective only. No data is deleted or altered. The FK
--   change can only make a delete that used to cascade silently instead
--   fail loudly (or succeed unchanged when the fiscal year has zero
--   periods).
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------
-- PART A (BUG-017): fiscal_years -> accounting_periods cascade delete
-- -----------------------------------------------------------------------

ALTER TABLE "finance"."accounting_periods"
  DROP CONSTRAINT IF EXISTS "accounting_periods_fiscal_year_id_fkey";

ALTER TABLE "finance"."accounting_periods"
  ADD CONSTRAINT "accounting_periods_fiscal_year_id_fkey"
  FOREIGN KEY ("fiscal_year_id")
  REFERENCES "finance"."fiscal_years"("id")
  ON DELETE RESTRICT;

CREATE OR REPLACE FUNCTION "finance"."prevent_used_fiscal_year_deletion"()
  RETURNS "trigger"
  LANGUAGE "plpgsql"
  AS $$
DECLARE
  v_period_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO v_period_count
  FROM finance.accounting_periods
  WHERE fiscal_year_id = OLD.id;

  IF v_period_count > 0 THEN
    RAISE EXCEPTION
      'Cannot delete fiscal year "%": it has % accounting period(s). Periods (and any journals posted to them) must never be silently cascade-deleted. Hard-close or archive the fiscal year instead of deleting it.',
      OLD.name, v_period_count
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  RETURN OLD;
END;
$$;

ALTER FUNCTION "finance"."prevent_used_fiscal_year_deletion"() OWNER TO "postgres";

DROP TRIGGER IF EXISTS "trg_prevent_used_fiscal_year_deletion" ON "finance"."fiscal_years";

CREATE TRIGGER "trg_prevent_used_fiscal_year_deletion"
  BEFORE DELETE ON "finance"."fiscal_years"
  FOR EACH ROW
  EXECUTE FUNCTION "finance"."prevent_used_fiscal_year_deletion"();

-- -----------------------------------------------------------------------
-- PART B (BUG-001): public.profit_and_loss / balance_sheet / cash_flow
-- -----------------------------------------------------------------------

-- P&L: public.profit_and_loss(p_start date, p_end date) -> PLData JSON
CREATE OR REPLACE FUNCTION "public"."profit_and_loss"(
  "p_start" DATE DEFAULT NULL,
  "p_end" DATE DEFAULT NULL
)
RETURNS JSON
LANGUAGE "plpgsql"
STABLE
SECURITY DEFINER
SET "search_path" TO 'pg_catalog', 'public', 'finance', 'core'
AS $$
DECLARE
  v_org_id UUID := core.current_user_org_id();
  v_start DATE := COALESCE(p_start, date_trunc('year', CURRENT_DATE)::date);
  v_end DATE := COALESCE(p_end, CURRENT_DATE);
  v_result JSON;
BEGIN
  IF v_org_id IS NULL THEN
    RETURN json_build_object(
      'revenue', '[]'::json, 'cost_of_sales', '[]'::json,
      'operating_expenses', '[]'::json, 'other_income', '[]'::json,
      'other_expenses', '[]'::json
    );
  END IF;

  WITH lines AS (
    SELECT
      coa.account_type,
      coa.code,
      coa.name AS account_name,
      COALESCE(SUM(jl.base_debit), 0) AS debit_total,
      COALESCE(SUM(jl.base_credit), 0) AS credit_total,
      CASE
        WHEN coa.normal_balance = 'DEBIT'
          THEN COALESCE(SUM(jl.base_debit), 0) - COALESCE(SUM(jl.base_credit), 0)
        ELSE COALESCE(SUM(jl.base_credit), 0) - COALESCE(SUM(jl.base_debit), 0)
      END AS total
    FROM finance.chart_of_accounts coa
    JOIN finance.journal_lines jl ON jl.account_id = coa.id
    JOIN finance.journal_entries je ON je.id = jl.journal_entry_id
    JOIN finance.accounting_periods ap ON ap.id = je.period_id
    WHERE je.status = 'POSTED'
      AND je.organization_id = v_org_id
      AND coa.organization_id = v_org_id
      AND ap.start_date >= v_start
      AND ap.end_date <= v_end
      AND coa.is_active = true
      AND coa.account_type IN ('REVENUE', 'COST_OF_SALES', 'OPERATING_EXPENSE', 'OTHER_INCOME', 'OTHER_EXPENSE')
    GROUP BY coa.id, coa.account_type, coa.code, coa.name, coa.normal_balance
    HAVING CASE
      WHEN coa.normal_balance = 'DEBIT'
        THEN COALESCE(SUM(jl.base_debit), 0) - COALESCE(SUM(jl.base_credit), 0)
      ELSE COALESCE(SUM(jl.base_credit), 0) - COALESCE(SUM(jl.base_debit), 0)
    END != 0
  )
  SELECT json_build_object(
    'revenue', COALESCE((SELECT json_agg(json_build_object('code', code, 'account_name', account_name, 'total', total, 'debit_total', debit_total, 'credit_total', credit_total) ORDER BY code) FROM lines WHERE account_type = 'REVENUE'), '[]'::json),
    'cost_of_sales', COALESCE((SELECT json_agg(json_build_object('code', code, 'account_name', account_name, 'total', total, 'debit_total', debit_total, 'credit_total', credit_total) ORDER BY code) FROM lines WHERE account_type = 'COST_OF_SALES'), '[]'::json),
    'operating_expenses', COALESCE((SELECT json_agg(json_build_object('code', code, 'account_name', account_name, 'total', total, 'debit_total', debit_total, 'credit_total', credit_total) ORDER BY code) FROM lines WHERE account_type = 'OPERATING_EXPENSE'), '[]'::json),
    'other_income', COALESCE((SELECT json_agg(json_build_object('code', code, 'account_name', account_name, 'total', total, 'debit_total', debit_total, 'credit_total', credit_total) ORDER BY code) FROM lines WHERE account_type = 'OTHER_INCOME'), '[]'::json),
    'other_expenses', COALESCE((SELECT json_agg(json_build_object('code', code, 'account_name', account_name, 'total', total, 'debit_total', debit_total, 'credit_total', credit_total) ORDER BY code) FROM lines WHERE account_type = 'OTHER_EXPENSE'), '[]'::json)
  ) INTO v_result;

  RETURN v_result;
END;
$$;

ALTER FUNCTION "public"."profit_and_loss"(DATE, DATE) OWNER TO "postgres";
REVOKE ALL ON FUNCTION "public"."profit_and_loss"(DATE, DATE) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "public"."profit_and_loss"(DATE, DATE) TO "authenticated";

COMMENT ON FUNCTION "public"."profit_and_loss"(DATE, DATE) IS
  'Org-scoped P&L for the calling user''s organization only (resolved via core.current_user_org_id(), not caller-supplied). Fixes BUG-001: previously the frontend called a function (public.profit_and_loss) that did not exist -- reporting.get_profit_and_loss existed but lives in a schema PostgREST never exposes and returns a different shape.';

-- Balance Sheet: public.balance_sheet() -> BSData JSON (as-of CURRENT_DATE)
CREATE OR REPLACE FUNCTION "public"."balance_sheet"()
RETURNS JSON
LANGUAGE "plpgsql"
STABLE
SECURITY DEFINER
SET "search_path" TO 'pg_catalog', 'public', 'finance', 'core'
AS $$
DECLARE
  v_org_id UUID := core.current_user_org_id();
  v_as_of DATE := CURRENT_DATE;
  v_result JSON;
BEGIN
  IF v_org_id IS NULL THEN
    RETURN json_build_object('assets', '[]'::json, 'liabilities', '[]'::json, 'equity', '[]'::json);
  END IF;

  WITH lines AS (
    SELECT
      coa.account_type,
      coa.code,
      coa.name AS account_name,
      CASE
        WHEN coa.normal_balance = 'DEBIT'
          THEN COALESCE(SUM(jl.base_debit), 0) - COALESCE(SUM(jl.base_credit), 0)
        ELSE COALESCE(SUM(jl.base_credit), 0) - COALESCE(SUM(jl.base_debit), 0)
      END AS total
    FROM finance.chart_of_accounts coa
    LEFT JOIN finance.journal_lines jl ON jl.account_id = coa.id
    LEFT JOIN finance.journal_entries je ON je.id = jl.journal_entry_id
      AND je.status = 'POSTED' AND je.organization_id = v_org_id
    LEFT JOIN finance.accounting_periods ap ON ap.id = je.period_id AND ap.end_date <= v_as_of
    WHERE coa.organization_id = v_org_id
      AND coa.is_active = true
      AND coa.account_type IN ('ASSET', 'LIABILITY', 'EQUITY')
    GROUP BY coa.id, coa.account_type, coa.code, coa.name, coa.normal_balance
    HAVING CASE
      WHEN coa.normal_balance = 'DEBIT'
        THEN COALESCE(SUM(jl.base_debit), 0) - COALESCE(SUM(jl.base_credit), 0)
      ELSE COALESCE(SUM(jl.base_credit), 0) - COALESCE(SUM(jl.base_debit), 0)
    END != 0
  )
  SELECT json_build_object(
    'assets', COALESCE((SELECT json_agg(json_build_object('code', code, 'account_name', account_name, 'account_type', account_type, 'total', total) ORDER BY code) FROM lines WHERE account_type = 'ASSET'), '[]'::json),
    'liabilities', COALESCE((SELECT json_agg(json_build_object('code', code, 'account_name', account_name, 'account_type', account_type, 'total', total) ORDER BY code) FROM lines WHERE account_type = 'LIABILITY'), '[]'::json),
    'equity', COALESCE((SELECT json_agg(json_build_object('code', code, 'account_name', account_name, 'account_type', account_type, 'total', total) ORDER BY code) FROM lines WHERE account_type = 'EQUITY'), '[]'::json)
  ) INTO v_result;

  RETURN v_result;
END;
$$;

ALTER FUNCTION "public"."balance_sheet"() OWNER TO "postgres";
REVOKE ALL ON FUNCTION "public"."balance_sheet"() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "public"."balance_sheet"() TO "authenticated";

COMMENT ON FUNCTION "public"."balance_sheet"() IS
  'Org-scoped Balance Sheet as-of CURRENT_DATE for the calling user''s organization only. Fixes BUG-001 (see public.profit_and_loss comment for full context).';

-- Cash Flow: public.cash_flow(p_start date, p_end date) -> CFData JSON
CREATE OR REPLACE FUNCTION "public"."cash_flow"(
  "p_start" DATE DEFAULT NULL,
  "p_end" DATE DEFAULT NULL
)
RETURNS JSON
LANGUAGE "plpgsql"
STABLE
SECURITY DEFINER
SET "search_path" TO 'pg_catalog', 'public', 'finance', 'core'
AS $$
DECLARE
  v_org_id UUID := core.current_user_org_id();
  v_start DATE := COALESCE(p_start, date_trunc('year', CURRENT_DATE)::date);
  v_end DATE := COALESCE(p_end, CURRENT_DATE);
  v_cash_balance NUMERIC;
  v_result JSON;
BEGIN
  IF v_org_id IS NULL THEN
    RETURN json_build_object('operating', '[]'::json, 'investing', '[]'::json, 'financing', '[]'::json, 'cash_balance', 0);
  END IF;

  -- Cash & bank sub-accounts are seeded as code 11xx under the "Cash and
  -- Bank" (1100) parent -- see phase_1_foundation/002_chart_of_accounts.sql.
  -- Receivables (12xx) are deliberately excluded by this LIKE pattern.
  SELECT COALESCE(SUM(
    CASE WHEN coa.normal_balance = 'DEBIT'
      THEN COALESCE(jl.base_debit, 0) - COALESCE(jl.base_credit, 0)
      ELSE COALESCE(jl.base_credit, 0) - COALESCE(jl.base_debit, 0)
    END
  ), 0)
  INTO v_cash_balance
  FROM finance.chart_of_accounts coa
  LEFT JOIN finance.journal_lines jl ON jl.account_id = coa.id
  LEFT JOIN finance.journal_entries je ON je.id = jl.journal_entry_id
    AND je.status = 'POSTED' AND je.organization_id = v_org_id
  LEFT JOIN finance.accounting_periods ap ON ap.id = je.period_id AND ap.end_date <= v_end
  WHERE coa.organization_id = v_org_id
    AND coa.account_type = 'ASSET'
    AND coa.code LIKE '11%';

  WITH operating AS (
    SELECT
      coa.name AS account_name,
      coa.account_type,
      SUM(CASE WHEN coa.normal_balance = 'CREDIT' THEN jl.base_credit ELSE -jl.base_debit END) AS total
    FROM finance.journal_lines jl
    JOIN finance.journal_entries je ON je.id = jl.journal_entry_id
      AND je.status = 'POSTED' AND je.organization_id = v_org_id
    JOIN finance.accounting_periods ap ON ap.id = je.period_id
    JOIN finance.chart_of_accounts coa ON coa.id = jl.account_id AND coa.organization_id = v_org_id
    WHERE ap.start_date >= v_start AND ap.end_date <= v_end
      AND coa.account_type IN ('REVENUE', 'COST_OF_SALES', 'OPERATING_EXPENSE')
    GROUP BY coa.name, coa.account_type
    HAVING SUM(CASE WHEN coa.normal_balance = 'CREDIT' THEN jl.base_credit ELSE -jl.base_debit END) != 0

    UNION ALL

    SELECT
      'Change in ' || coa.name AS account_name,
      coa.account_type,
      -1 * (COALESCE(SUM(jl.base_debit), 0) - COALESCE(SUM(jl.base_credit), 0)) AS total
    FROM finance.journal_lines jl
    JOIN finance.journal_entries je ON je.id = jl.journal_entry_id
      AND je.status = 'POSTED' AND je.organization_id = v_org_id
    JOIN finance.accounting_periods ap ON ap.id = je.period_id
    JOIN finance.chart_of_accounts coa ON coa.id = jl.account_id AND coa.organization_id = v_org_id
    WHERE ap.start_date >= v_start AND ap.end_date <= v_end
      AND coa.account_type IN ('ASSET', 'LIABILITY')
      AND coa.code NOT LIKE '11%'   -- cash/bank movements are the plug, not a working-capital line
      AND coa.code NOT LIKE '15%'   -- fixed assets are investing, not operating
    GROUP BY coa.name, coa.account_type
    HAVING (COALESCE(SUM(jl.base_debit), 0) - COALESCE(SUM(jl.base_credit), 0)) != 0
  ),
  investing AS (
    SELECT
      coa.name AS account_name,
      coa.account_type,
      -1 * (COALESCE(SUM(jl.base_debit), 0) - COALESCE(SUM(jl.base_credit), 0)) AS total
    FROM finance.journal_lines jl
    JOIN finance.journal_entries je ON je.id = jl.journal_entry_id
      AND je.status = 'POSTED' AND je.organization_id = v_org_id
    JOIN finance.accounting_periods ap ON ap.id = je.period_id
    JOIN finance.chart_of_accounts coa ON coa.id = jl.account_id AND coa.organization_id = v_org_id
    WHERE ap.start_date >= v_start AND ap.end_date <= v_end
      AND coa.account_type = 'ASSET' AND coa.code LIKE '15%'
    GROUP BY coa.name, coa.account_type
    HAVING (COALESCE(SUM(jl.base_debit), 0) - COALESCE(SUM(jl.base_credit), 0)) != 0
  ),
  financing AS (
    SELECT
      coa.name AS account_name,
      coa.account_type,
      CASE WHEN coa.normal_balance = 'CREDIT'
        THEN COALESCE(SUM(jl.base_credit), 0) - COALESCE(SUM(jl.base_debit), 0)
        ELSE -1 * (COALESCE(SUM(jl.base_debit), 0) - COALESCE(SUM(jl.base_credit), 0))
      END AS total
    FROM finance.journal_lines jl
    JOIN finance.journal_entries je ON je.id = jl.journal_entry_id
      AND je.status = 'POSTED' AND je.organization_id = v_org_id
    JOIN finance.accounting_periods ap ON ap.id = je.period_id
    JOIN finance.chart_of_accounts coa ON coa.id = jl.account_id AND coa.organization_id = v_org_id
    WHERE ap.start_date >= v_start AND ap.end_date <= v_end
      AND coa.account_type = 'EQUITY'
    GROUP BY coa.name, coa.account_type, coa.normal_balance
    HAVING CASE WHEN coa.normal_balance = 'CREDIT'
      THEN COALESCE(SUM(jl.base_credit), 0) - COALESCE(SUM(jl.base_debit), 0)
      ELSE -1 * (COALESCE(SUM(jl.base_debit), 0) - COALESCE(SUM(jl.base_credit), 0))
    END != 0
  )
  SELECT json_build_object(
    'operating', COALESCE((SELECT json_agg(json_build_object('account_name', account_name, 'account_type', account_type, 'total', total) ORDER BY account_name) FROM operating), '[]'::json),
    'investing', COALESCE((SELECT json_agg(json_build_object('account_name', account_name, 'account_type', account_type, 'total', total) ORDER BY account_name) FROM investing), '[]'::json),
    'financing', COALESCE((SELECT json_agg(json_build_object('account_name', account_name, 'account_type', account_type, 'total', total) ORDER BY account_name) FROM financing), '[]'::json),
    'cash_balance', v_cash_balance
  ) INTO v_result;

  RETURN v_result;
END;
$$;

ALTER FUNCTION "public"."cash_flow"(DATE, DATE) OWNER TO "postgres";
REVOKE ALL ON FUNCTION "public"."cash_flow"(DATE, DATE) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "public"."cash_flow"(DATE, DATE) TO "authenticated";

COMMENT ON FUNCTION "public"."cash_flow"(DATE, DATE) IS
  'Org-scoped indirect-method Cash Flow for the calling user''s organization only. cash_balance is the as-of-p_end balance of code 11xx (cash/bank) accounts. Fixes BUG-001 (see public.profit_and_loss comment for full context).';

COMMIT;


