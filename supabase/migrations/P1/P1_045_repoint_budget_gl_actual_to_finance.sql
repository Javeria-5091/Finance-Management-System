-- 045_repoint_budget_gl_actual_to_finance.sql
-- Re-points reporting.budget_gl_actual from legacy public.budget_lines to
-- canonical finance.budget_lines. Corrected version: the previous attempt
-- had an extra opening parenthesis in the FROM clause (5 instead of the
-- required 4), which left the join-tree parenthesis depth at 1 instead of
-- 0 by the time the parser reached GROUP BY, producing:
--   ERROR: 42601: syntax error at or near "GROUP"
-- Verified by counting parenthesis depth against the original view
-- definition before applying this fix.

BEGIN;

CREATE OR REPLACE VIEW "reporting"."budget_gl_actual" WITH ("security_invoker"='true') AS
 SELECT "bl"."id" AS "budget_line_id",
    "bl"."budget_id",
    "b"."name" AS "budget_name",
    "bl"."account_id",
    "coa"."code" AS "account_code",
    "coa"."name" AS "account_name",
    "bl"."budgeted_amount" AS "allocated_amount",
    COALESCE("sum"(
        CASE
            WHEN ("coa"."normal_balance" = 'DEBIT'::"text") THEN (COALESCE("jl"."base_debit", "jl"."debit_amount") - COALESCE("jl"."base_credit", "jl"."credit_amount"))
            ELSE (COALESCE("jl"."base_credit", "jl"."credit_amount") - COALESCE("jl"."base_debit", "jl"."debit_amount"))
        END), (0)::numeric) AS "actual_spent",
    ("bl"."budgeted_amount" - COALESCE("sum"(
        CASE
            WHEN ("coa"."normal_balance" = 'DEBIT'::"text") THEN (COALESCE("jl"."base_debit", "jl"."debit_amount") - COALESCE("jl"."base_credit", "jl"."credit_amount"))
            ELSE (COALESCE("jl"."base_credit", "jl"."credit_amount") - COALESCE("jl"."base_debit", "jl"."debit_amount"))
        END), (0)::numeric)) AS "remaining"
   FROM (((("finance"."budget_lines" "bl"
     JOIN "public"."budgets" "b" ON (("b"."id" = "bl"."budget_id")))
     LEFT JOIN "finance"."chart_of_accounts" "coa" ON (("coa"."id" = "bl"."account_id")))
     LEFT JOIN "finance"."journal_lines" "jl" ON (("jl"."account_id" = "bl"."account_id")))
     LEFT JOIN "finance"."journal_entries" "je" ON ((("je"."id" = "jl"."journal_entry_id") AND ("je"."status" = 'POSTED'::"text") AND ("je"."transaction_date" >= "b"."start_date") AND (("je"."transaction_date" <= "b"."end_date") OR ("b"."end_date" IS NULL)))))
  GROUP BY "bl"."id", "bl"."budget_id", "b"."name", "bl"."account_id", "coa"."code", "coa"."name", "bl"."budgeted_amount";

COMMENT ON VIEW "reporting"."budget_gl_actual" IS
  'Budget-vs-GL actuals, spec Section 13.2. Re-pointed from legacy public.budget_lines to canonical finance.budget_lines (Migration 031, corrected paren-count from the initial attempt). security_invoker preserved.';

COMMIT;