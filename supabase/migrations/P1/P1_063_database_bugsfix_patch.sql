-- OSYSTIC Finance Management System — SAFE database bug-fix patch (corrected)
BEGIN;

-- BUG-005: execute_sql_query is callable only from a service_role JWT context.
-- CORRECTED: the dangerous-keyword regex used \\b, which is a PCRE word
-- boundary Postgres's POSIX-ERE `~*` operator does not support -- it silently
-- never matched (tested: 'DROP TABLE foo' ~* '\\b(DROP|...)\\b' returns
-- FALSE). Postgres's own word-boundary syntax is \m / \M.
CREATE OR REPLACE FUNCTION "public"."execute_sql_query"("query_string" "text") RETURNS json
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'public'
    AS $$
DECLARE
  result JSON;
  lower_query TEXT;
BEGIN
  IF COALESCE(current_setting('request.jwt.claim.role', true), '') <> 'service_role' THEN
    RAISE EXCEPTION 'Access denied: service_role required';
  END IF;

  lower_query := LOWER(TRIM(query_string));
  IF NOT (LEFT(lower_query, 6) = 'select' OR LEFT(lower_query, 4) = 'with') THEN
    RAISE EXCEPTION 'Only SELECT queries are allowed';
  END IF;
  IF lower_query ~* '\m(drop|delete|update|insert|alter|create|truncate|grant|revoke)\M' THEN
    RAISE EXCEPTION 'Dangerous operation not allowed';
  END IF;

  BEGIN
    EXECUTE format('SELECT json_agg(t) FROM (%s) t', query_string) INTO result;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'SQL Error: %', SQLERRM;
  END;
  RETURN COALESCE(result, '[]'::JSON);
END;
$$;

-- BUG-001: make all 25 reporting functions SECURITY INVOKER so underlying RLS applies.
-- CORRECTED: no RETURNS clause belongs in ALTER FUNCTION -- identity arguments only.
ALTER FUNCTION "reporting"."cash_distribution"() SECURITY INVOKER;
ALTER FUNCTION "reporting"."ceo_chart_aging"() SECURITY INVOKER;
ALTER FUNCTION "reporting"."ceo_chart_budget"() SECURITY INVOKER;
ALTER FUNCTION "reporting"."ceo_chart_cash"() SECURITY INVOKER;
ALTER FUNCTION "reporting"."ceo_chart_categories"() SECURITY INVOKER;
ALTER FUNCTION "reporting"."ceo_chart_monthly"() SECURITY INVOKER;
ALTER FUNCTION "reporting"."ceo_dashboard_kpis"() SECURITY INVOKER;
ALTER FUNCTION "reporting"."ceo_table_audit"() SECURITY INVOKER;
ALTER FUNCTION "reporting"."ceo_table_equity_tax"() SECURITY INVOKER;
ALTER FUNCTION "reporting"."ceo_table_fiscal"() SECURITY INVOKER;
ALTER FUNCTION "reporting"."get_balance_sheet"("p_as_of_date" "date") SECURITY INVOKER;
ALTER FUNCTION "reporting"."get_cash_flow"("p_start_date" "date", "p_end_date" "date") SECURITY INVOKER;
ALTER FUNCTION "reporting"."get_ceo_metrics"() SECURITY INVOKER;
ALTER FUNCTION "reporting"."get_profit_and_loss"("p_start_date" "date", "p_end_date" "date") SECURITY INVOKER;
ALTER FUNCTION "reporting"."get_project_profitability"("p_start_date" "date", "p_end_date" "date") SECURITY INVOKER;
ALTER FUNCTION "reporting"."get_statement_of_changes_in_equity"("p_period_start" "date", "p_period_end" "date") SECURITY INVOKER;
ALTER FUNCTION "reporting"."get_trial_balance"("p_period_ids" "uuid"[]) SECURITY INVOKER;
ALTER FUNCTION "reporting"."pending_approvals_list"() SECURITY INVOKER;
ALTER FUNCTION "reporting"."project_profitability"() SECURITY INVOKER;
ALTER FUNCTION "reporting"."receivable_aging_summary"() SECURITY INVOKER;
ALTER FUNCTION "reporting"."revenue_expense_monthly"() SECURITY INVOKER;
ALTER FUNCTION "reporting"."transaction_detail"("p_id" "uuid") SECURITY INVOKER;
ALTER FUNCTION "reporting"."transaction_list"("p_search" "text", "p_type" "text", "p_status" "text", "p_project_id" "uuid", "p_date_from" "date", "p_date_to" "date", "p_limit" integer, "p_offset" integer) SECURITY INVOKER;
ALTER FUNCTION "reporting"."transaction_summary"() SECURITY INVOKER;
ALTER FUNCTION "reporting"."unreconciled_summary"() SECURITY INVOKER;

-- BUG-013: close PUBLIC/anon execution of reporting functions.
-- CORRECTED from the original patch in two ways:
--   1. Same RETURNS-clause / DEFAULT-clause syntax fix as above.
--   2. Grant to `authenticated`, not `service_role`-only. Verified against
--      the live schema that these functions currently grant EXECUTE to
--      PUBLIC (i.e. reachable by the unauthenticated anon role too) -- that
--      real bug is fixed by removing PUBLIC. But `authenticated` has no
--      other path to call these RPCs today, and now that BUG-001 has made
--      them SECURITY INVOKER, RLS correctly scopes what each authenticated
--      caller can see -- restricting to service_role-only would very likely
--      break every in-app reporting/dashboard screen that calls these RPCs
--      as the logged-in user. Confirm your specific reporting routes' auth
--      pattern before applying; if any of them genuinely are service-role
--      only backend jobs, drop authenticated from that one function's GRANT.
REVOKE ALL ON FUNCTION "reporting"."cash_distribution"() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "reporting"."cash_distribution"() TO "authenticated";
REVOKE ALL ON FUNCTION "reporting"."ceo_chart_aging"() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "reporting"."ceo_chart_aging"() TO "authenticated";
REVOKE ALL ON FUNCTION "reporting"."ceo_chart_budget"() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "reporting"."ceo_chart_budget"() TO "authenticated";
REVOKE ALL ON FUNCTION "reporting"."ceo_chart_cash"() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "reporting"."ceo_chart_cash"() TO "authenticated";
REVOKE ALL ON FUNCTION "reporting"."ceo_chart_categories"() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "reporting"."ceo_chart_categories"() TO "authenticated";
REVOKE ALL ON FUNCTION "reporting"."ceo_chart_monthly"() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "reporting"."ceo_chart_monthly"() TO "authenticated";
REVOKE ALL ON FUNCTION "reporting"."ceo_dashboard_kpis"() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "reporting"."ceo_dashboard_kpis"() TO "authenticated";
REVOKE ALL ON FUNCTION "reporting"."ceo_table_audit"() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "reporting"."ceo_table_audit"() TO "authenticated";
REVOKE ALL ON FUNCTION "reporting"."ceo_table_equity_tax"() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "reporting"."ceo_table_equity_tax"() TO "authenticated";
REVOKE ALL ON FUNCTION "reporting"."ceo_table_fiscal"() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "reporting"."ceo_table_fiscal"() TO "authenticated";
REVOKE ALL ON FUNCTION "reporting"."get_balance_sheet"("p_as_of_date" "date") FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "reporting"."get_balance_sheet"("p_as_of_date" "date") TO "authenticated";
REVOKE ALL ON FUNCTION "reporting"."get_cash_flow"("p_start_date" "date", "p_end_date" "date") FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "reporting"."get_cash_flow"("p_start_date" "date", "p_end_date" "date") TO "authenticated";
REVOKE ALL ON FUNCTION "reporting"."get_ceo_metrics"() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "reporting"."get_ceo_metrics"() TO "authenticated";
REVOKE ALL ON FUNCTION "reporting"."get_profit_and_loss"("p_start_date" "date", "p_end_date" "date") FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "reporting"."get_profit_and_loss"("p_start_date" "date", "p_end_date" "date") TO "authenticated";
REVOKE ALL ON FUNCTION "reporting"."get_project_profitability"("p_start_date" "date", "p_end_date" "date") FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "reporting"."get_project_profitability"("p_start_date" "date", "p_end_date" "date") TO "authenticated";
REVOKE ALL ON FUNCTION "reporting"."get_statement_of_changes_in_equity"("p_period_start" "date", "p_period_end" "date") FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "reporting"."get_statement_of_changes_in_equity"("p_period_start" "date", "p_period_end" "date") TO "authenticated";
REVOKE ALL ON FUNCTION "reporting"."get_trial_balance"("p_period_ids" "uuid"[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "reporting"."get_trial_balance"("p_period_ids" "uuid"[]) TO "authenticated";
REVOKE ALL ON FUNCTION "reporting"."pending_approvals_list"() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "reporting"."pending_approvals_list"() TO "authenticated";
REVOKE ALL ON FUNCTION "reporting"."project_profitability"() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "reporting"."project_profitability"() TO "authenticated";
REVOKE ALL ON FUNCTION "reporting"."receivable_aging_summary"() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "reporting"."receivable_aging_summary"() TO "authenticated";
REVOKE ALL ON FUNCTION "reporting"."revenue_expense_monthly"() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "reporting"."revenue_expense_monthly"() TO "authenticated";
REVOKE ALL ON FUNCTION "reporting"."transaction_detail"("p_id" "uuid") FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "reporting"."transaction_detail"("p_id" "uuid") TO "authenticated";
REVOKE ALL ON FUNCTION "reporting"."transaction_list"("p_search" "text", "p_type" "text", "p_status" "text", "p_project_id" "uuid", "p_date_from" "date", "p_date_to" "date", "p_limit" integer, "p_offset" integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "reporting"."transaction_list"("p_search" "text", "p_type" "text", "p_status" "text", "p_project_id" "uuid", "p_date_from" "date", "p_date_to" "date", "p_limit" integer, "p_offset" integer) TO "authenticated";
REVOKE ALL ON FUNCTION "reporting"."transaction_summary"() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "reporting"."transaction_summary"() TO "authenticated";
REVOKE ALL ON FUNCTION "reporting"."unreconciled_summary"() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "reporting"."unreconciled_summary"() TO "authenticated";

-- BUG-014: reporting views are read-only. (Unchanged -- verified safe.)
REVOKE ALL ON TABLE "reporting"."general_ledger" FROM "authenticated";
GRANT SELECT ON TABLE "reporting"."general_ledger" TO "authenticated";
REVOKE ALL ON TABLE "reporting"."budget_vs_actual" FROM "authenticated";
GRANT SELECT ON TABLE "reporting"."budget_vs_actual" TO "authenticated";
REVOKE ALL ON TABLE "reporting"."budget_category_summary" FROM "authenticated";
GRANT SELECT ON TABLE "reporting"."budget_category_summary" TO "authenticated";
REVOKE ALL ON TABLE "reporting"."budget_gl_actual" FROM "authenticated";
GRANT SELECT ON TABLE "reporting"."budget_gl_actual" TO "authenticated";
REVOKE ALL ON TABLE "reporting"."payable_aging" FROM "authenticated";
GRANT SELECT ON TABLE "reporting"."payable_aging" TO "authenticated";
REVOKE ALL ON TABLE "reporting"."receivable_aging" FROM "authenticated";
GRANT SELECT ON TABLE "reporting"."receivable_aging" TO "authenticated";
REVOKE ALL ON TABLE "reporting"."reconciliation_summary" FROM "authenticated";
GRANT SELECT ON TABLE "reporting"."reconciliation_summary" TO "authenticated";
REVOKE ALL ON TABLE "reporting"."unreconciled_lines" FROM "authenticated";
GRANT SELECT ON TABLE "reporting"."unreconciled_lines" TO "authenticated";
REVOKE ALL ON TABLE "reporting"."v_asset_register" FROM "authenticated";
GRANT SELECT ON TABLE "reporting"."v_asset_register" TO "authenticated";
REVOKE ALL ON TABLE "reporting"."v_cash_position" FROM "authenticated";
GRANT SELECT ON TABLE "reporting"."v_cash_position" TO "authenticated";
REVOKE ALL ON TABLE "reporting"."v_depreciation_summary" FROM "authenticated";
GRANT SELECT ON TABLE "reporting"."v_depreciation_summary" TO "authenticated";
REVOKE ALL ON TABLE "reporting"."v_legacy_archive_status" FROM "authenticated";
GRANT SELECT ON TABLE "reporting"."v_legacy_archive_status" TO "authenticated";
REVOKE ALL ON TABLE "reporting"."v_project_profitability" FROM "authenticated";
GRANT SELECT ON TABLE "reporting"."v_project_profitability" TO "authenticated";
REVOKE ALL ON TABLE "reporting"."v_tax_computation_summary" FROM "authenticated";
GRANT SELECT ON TABLE "reporting"."v_tax_computation_summary" TO "authenticated";

-- BUG-015/016: invoice status vocabulary + non-negative amounts.
-- CORRECTED: also fix the column default so it matches the new constraint --
-- otherwise any future insert relying on the default ('Draft') fails
-- immediately (verified: current default is 'Draft', constraint only allows
-- uppercase 'DRAFT').
ALTER TABLE ONLY "public"."invoices"
  ALTER COLUMN "status" SET DEFAULT 'DRAFT';
ALTER TABLE ONLY "public"."invoices"
  ADD CONSTRAINT "invoices_status_check" CHECK (("status" = ANY (ARRAY['DRAFT'::text, 'PENDING_APPROVAL'::text, 'ISSUED'::text, 'PARTIALLY_PAID'::text, 'PAID'::text, 'OVERDUE'::text, 'VOID'::text, 'CREDITED'::text, 'REFUNDED'::text]))) NOT VALID;
ALTER TABLE ONLY "public"."invoices"
  ADD CONSTRAINT "invoices_amounts_non_negative_check" CHECK (("amount" >= 0 AND "subtotal" >= 0 AND "tax_amount" >= 0 AND "discount_amount" >= 0 AND "total_amount" >= 0 AND "base_subtotal" >= 0 AND "base_tax_amount" >= 0 AND "base_discount_amount" >= 0 AND "base_total_amount" >= 0 AND "amount_paid" >= 0 AND "base_amount_paid" >= 0 AND "outstanding_amount" >= 0 AND "base_outstanding_amount" >= 0)) NOT VALID;
-- Note (informational, not a blocker): NOT VALID skips validating rows that
-- already exist. Any pre-existing invoice with a non-uppercase status or a
-- negative amount will remain un-validated until you run
-- `ALTER TABLE public.invoices VALIDATE CONSTRAINT invoices_status_check;`
-- (and the amounts one) as a deliberate follow-up once you've reviewed/fixed
-- any offending historical rows.

-- BUG-066: remove duplicate public entry from affected function search_path settings.
-- (Unchanged -- verified safe: all 7 functions exist and currently have the
-- exact duplicate "pg_catalog, public, public" this corrects.)
ALTER FUNCTION "public"."create_user_by_admin"("p_email" "text", "p_password" "text", "p_role" "text", "p_full_name" "text") SET search_path = pg_catalog, public;
ALTER FUNCTION "public"."ensure_profile_exists"("target_user_id" "uuid") SET search_path = pg_catalog, public;
ALTER FUNCTION "public"."execute_sql_query"("query_string" "text") SET search_path = pg_catalog, public;
ALTER FUNCTION "public"."get_my_permissions"() SET search_path = pg_catalog, public;
ALTER FUNCTION "public"."get_my_user_roles"() SET search_path = pg_catalog, public;
ALTER FUNCTION "public"."get_user_permissions"("p_user_id" "uuid") SET search_path = pg_catalog, public;
ALTER FUNCTION "public"."handle_new_user"() SET search_path = pg_catalog, public;
ALTER FUNCTION "public"."user_has_role"("p_role_name" "text") SET search_path = pg_catalog, public;

COMMIT;