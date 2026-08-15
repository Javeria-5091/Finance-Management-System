-- =============================================================================
-- Migration: 019_fix_reporting_views.sql
-- Purpose:   Fix Medium finding M-4 from the Schema Compliance Audit.
--
-- Issue fixed:
--   M-4  reporting.v_asset_register and reporting.v_depreciation_summary
--        were declared without WITH (security_invoker = 'true'), so they
--        run with the view owner's privileges rather than the querying
--        user's, bypassing the invoking user's RLS restrictions (spec
--        Section 7.5 / 9.5: "Use security-invoker views so underlying
--        permissions and RLS apply to the invoking user").
--
--        NOTE: public.v_payroll_summary was found to have the same issue
--        at its FIRST definition in schema.sql, but schema.sql later
--        redefines it a second time (CREATE OR REPLACE VIEW ...) WITH
--        security_invoker='true' — since CREATE OR REPLACE is applied in
--        file order, the final, currently-active definition of
--        public.v_payroll_summary is already correct. No migration is
--        needed for it; this is confirmed here rather than assumed.
--
-- Safety: CREATE OR REPLACE VIEW cannot change a view's output column
-- names, order, or types without failing — since we are reusing the exact
-- original SELECT list unchanged (only adding the security_invoker
-- option), this is a safe, non-breaking, in-place replacement. No data is
-- touched; views have no storage of their own.
-- =============================================================================

BEGIN;

CREATE OR REPLACE VIEW "reporting"."v_asset_register" WITH ("security_invoker"='true') AS
 SELECT "fa"."id",
    "fa"."code",
    "fa"."name",
    "ac"."name" AS "category_name",
    "fa"."purchase_date",
    "fa"."purchase_cost",
    "fa"."currency" AS "currency_code",
    "fa"."base_cost",
    "fa"."accumulated_depreciation",
    "fa"."net_book_value",
    "fa"."serial_number",
    "fa"."location",
    "fa"."status",
    COALESCE("fa"."useful_life_months", "ac"."useful_life_months") AS "useful_life_months",
    COALESCE("fa"."residual_value_pct", "ac"."residual_value_pct") AS "residual_value_pct",
    "p"."name" AS "project_name",
    "fa"."disposal_date",
    "fa"."disposal_value",
    "fa"."gain_loss_amount"
   FROM (("finance"."fixed_assets" "fa"
     JOIN "finance"."asset_categories" "ac" ON (("ac"."id" = "fa"."category_id")))
     LEFT JOIN "public"."projects" "p" ON (("p"."id" = "fa"."project_id")))
  WHERE (("fa"."status")::"text" <> 'pending_capitalization'::"text");

ALTER VIEW "reporting"."v_asset_register" OWNER TO "postgres";

CREATE OR REPLACE VIEW "reporting"."v_depreciation_summary" WITH ("security_invoker"='true') AS
 SELECT "ds"."fiscal_year_id",
    "fy"."name" AS "fiscal_year_name",
    "ds"."period_id",
    "ap"."name" AS "period_name",
    "ap"."start_date",
    "ap"."end_date",
    "count"(DISTINCT "ds"."asset_id") AS "assets_depreciated",
    "sum"("ds"."depreciation_amount") AS "total_depreciation",
    "sum"("ds"."opening_nbv") AS "total_opening_nbv",
    "sum"("ds"."closing_nbv") AS "total_closing_nbv",
    "count"(*) FILTER (WHERE (("ds"."status")::"text" = 'posted'::"text")) AS "posted_count",
    "count"(*) FILTER (WHERE (("ds"."status")::"text" = 'calculated'::"text")) AS "pending_count"
   FROM (("finance"."depreciation_schedule" "ds"
     JOIN "finance"."fiscal_years" "fy" ON (("fy"."id" = "ds"."fiscal_year_id")))
     JOIN "finance"."accounting_periods" "ap" ON (("ap"."id" = "ds"."period_id")))
  GROUP BY "ds"."fiscal_year_id", "fy"."name", "ds"."period_id", "ap"."name", "ap"."start_date", "ap"."end_date"
  ORDER BY "fy"."name", "ap"."start_date";

ALTER VIEW "reporting"."v_depreciation_summary" OWNER TO "postgres";

COMMIT;

-- -----------------------------------------------------------------------
-- Post-migration check: confirm every reporting.* / finance.* / public.*
-- view now has security_invoker = true. Expected result: zero rows.
-- -----------------------------------------------------------------------
-- SELECT n.nspname AS schema, c.relname AS view_name
-- FROM pg_class c
-- JOIN pg_namespace n ON n.oid = c.relnamespace
-- WHERE c.relkind = 'v'
--   AND n.nspname IN ('reporting','finance','public','core','audit')
--   AND COALESCE(c.reloptions::text, '') NOT LIKE '%security_invoker=true%';