-- =====================================================================
-- Finance Management System — Critical Fix
--   AC-02 (P1): Reversed entries are inverted, not neutralized, in every
--   financial statement.
--
-- Root cause: finance.reverse_journal_entry() implements a textbook
-- reversing entry — it creates a brand-new POSTED journal with every
-- line's debit_amount/credit_amount swapped from the original (see the
-- INSERT ... SELECT v_reversal_id, ..., credit_amount, debit_amount, ...
-- in that function) — which is the correct way to make an offsetting
-- entry. But it ALSO flips the original entry's own status away from
-- POSTED to REVERSED:
--
--   UPDATE finance.journal_entries SET status='REVERSED', ... WHERE id=p_journal_id;
--
-- Every reporting query in the system aggregates the GL with a plain
-- "WHERE je.status = 'POSTED'" filter. The moment the original flips to
-- REVERSED, that filter silently drops it out of every statement, while
-- the new reversal line (status='POSTED', debit/credit swapped) is still
-- counted. The reports end up showing only the swapped-sign reversal
-- entry on its own — the exact INVERSE of the original transaction —
-- instead of the two entries netting to zero, which is what a reversal
-- is supposed to produce.
--
-- Concretely: post a PKR 100,000 expense (Dr Expense 100,000 / Cr Bank
-- 100,000), then reverse it. Trial balance / P&L / cash flow / GL today
-- show Cr Expense 100,000 / Dr Bank 100,000 — i.e. the business looks
-- like it received the expense back as income, rather than showing zero
-- net movement on both accounts, which is what actually happened.
--
-- Fix: this is a reporting-layer fix, not a change to
-- reverse_journal_entry's posting logic (which is already correct — the
-- swapped-line reversal entry is the standard, audit-safe way to cancel
-- a posting without ever deleting or mutating historical GL rows). Every
-- report that aggregates finance.journal_entries by status now treats
-- REVERSED the same as POSTED for GL-inclusion purposes: an original
-- entry that has been reversed represents a real posting that happened
-- and was then exactly cancelled by its reversal counterpart, so BOTH
-- must be counted for the pair to net to the zero it's supposed to.
-- REVERSED remains a distinct, filterable status everywhere else (it is
-- unaffected by this change) — including finance.journal_entries' own
-- je_update RLS policy, which already treats POSTED and REVERSED as
-- equally immutable (AC-01 migration), and the journal entries list UI,
-- which still greys out rows with status = 'REVERSED'.
--
-- Locations fixed (all six named in the ticket):
--   1. reporting.trial_balance          (view)
--   2. reporting.general_ledger         (view)
--   3. reporting.general_ledger_multi_currency (view)
--   4. reporting.get_profit_and_loss    (function)
--   5. reporting.get_cash_flow          (function — 5 separate JOINs)
--   6. reporting.get_trial_balance      (function)
--
-- finance.reverse_journal_entry itself is annotated in place (no logic
-- change) so a future reader doesn't "fix" the reports back to
-- POSTED-only without understanding why REVERSED must stay included.
--
-- NOTE — found but out of scope for this ticket: the exact same
-- "status = 'POSTED'" GL-inclusion pattern also appears, unfixed, in
-- several reporting/dashboard functions not named here — among them
-- reporting.get_ceo_metrics, reporting.get_project_profitability,
-- reporting.get_statement_of_changes_in_equity, and the CFO/tax
-- dashboard and cash-flow-forecast functions (schema.sql, roughly lines
-- 7600–10020 in this dump). Those were left untouched since they
-- weren't part of AC-02's listed locations, but they have the identical
-- defect and will show the same inverted-not-neutralized numbers for
-- any reversed journal. Recommend a follow-up ticket to sweep the rest.
-- =====================================================================

BEGIN;

-- ── 1. reporting.trial_balance ──────────────────────────────────────
CREATE OR REPLACE VIEW "reporting"."trial_balance" WITH ("security_invoker"='true') AS
 SELECT "je"."organization_id",
    "je"."fiscal_year_id",
    "je"."period_id",
    "jl"."account_id",
    "coa"."code" AS "account_code",
    "coa"."name" AS "account_name",
    "coa"."account_type",
    "coa"."normal_balance",
    "sum"("jl"."debit_amount") AS "debit",
    "sum"("jl"."credit_amount") AS "credit",
    "sum"(COALESCE("jl"."base_debit", "jl"."debit_amount")) AS "base_debit",
    "sum"(COALESCE("jl"."base_credit", "jl"."credit_amount")) AS "base_credit",
    "sum"((COALESCE("jl"."base_debit", "jl"."debit_amount") - COALESCE("jl"."base_credit", "jl"."credit_amount"))) AS "signed_base_balance"
   FROM (("finance"."journal_entries" "je"
     JOIN "finance"."journal_lines" "jl" ON (("jl"."journal_entry_id" = "je"."id")))
     JOIN "finance"."chart_of_accounts" "coa" ON (("coa"."id" = "jl"."account_id")))
  WHERE ("je"."status" = ANY (ARRAY['POSTED'::"text", 'REVERSED'::"text"]))
  GROUP BY "je"."organization_id", "je"."fiscal_year_id", "je"."period_id", "jl"."account_id", "coa"."code", "coa"."name", "coa"."account_type", "coa"."normal_balance";

COMMENT ON VIEW "reporting"."trial_balance" IS
  'AC-02 FIX (P1): now includes REVERSED alongside POSTED. A reversed '
  'journal and its offsetting reversal entry are both real GL postings '
  'that together net to zero; excluding the REVERSED original left only '
  'the swapped-sign reversal counted, showing the exact inverse of the '
  'original transaction instead of zero.';


-- ── 2. reporting.general_ledger ─────────────────────────────────────
CREATE OR REPLACE VIEW "reporting"."general_ledger" WITH ("security_invoker"='true') AS
 SELECT "je"."id" AS "journal_entry_id",
    "je"."reference" AS "journal_reference",
    "je"."description" AS "journal_description",
    "je"."transaction_date",
    "je"."posting_date",
    "je"."period_id",
    "je"."fiscal_year_id",
    "je"."project_id",
    "je"."source_type",
    "je"."source_id",
    "jl"."id" AS "line_id",
    "jl"."line_number",
    "jl"."account_id",
    "coa"."code" AS "account_code",
    "coa"."name" AS "account_name",
    "coa"."account_type",
    "coa"."normal_balance",
    "jl"."description" AS "line_description",
    "jl"."debit_amount",
    "jl"."credit_amount",
    COALESCE("jl"."base_debit", "jl"."debit_amount") AS "base_debit",
    COALESCE("jl"."base_credit", "jl"."credit_amount") AS "base_credit",
    "jl"."currency",
    "jl"."exchange_rate",
    "sum"(
        CASE
            WHEN ("coa"."normal_balance" = 'DEBIT'::"text") THEN (COALESCE("jl"."base_debit", "jl"."debit_amount") - COALESCE("jl"."base_credit", "jl"."credit_amount"))
            ELSE (COALESCE("jl"."base_credit", "jl"."credit_amount") - COALESCE("jl"."base_debit", "jl"."debit_amount"))
        END) OVER (PARTITION BY "jl"."account_id" ORDER BY "je"."transaction_date", "je"."reference", "jl"."line_number" ROWS UNBOUNDED PRECEDING) AS "running_balance"
   FROM (("finance"."journal_lines" "jl"
     JOIN "finance"."journal_entries" "je" ON (("je"."id" = "jl"."journal_entry_id")))
     JOIN "finance"."chart_of_accounts" "coa" ON (("coa"."id" = "jl"."account_id")))
  WHERE ("je"."status" = ANY (ARRAY['POSTED'::"text", 'REVERSED'::"text"]));

COMMENT ON VIEW "reporting"."general_ledger" IS
  'AC-02 FIX (P1): includes REVERSED alongside POSTED so a reversed '
  'journal and its offsetting reversal entry both appear and net to '
  'zero in the running balance, instead of the running balance jumping '
  'by the inverse of the original transaction.';


-- ── 3. reporting.general_ledger_multi_currency ──────────────────────
CREATE OR REPLACE VIEW "reporting"."general_ledger_multi_currency" WITH ("security_invoker"='true') AS
 SELECT "je"."id" AS "journal_entry_id",
    "je"."reference" AS "journal_reference",
    "je"."description" AS "journal_description",
    "je"."transaction_date",
    "je"."posting_date",
    "je"."period_id",
    "je"."fiscal_year_id",
    "je"."project_id",
    "je"."source_type",
    "je"."source_id",
    "je"."organization_id",
    "jl"."id" AS "line_id",
    "jl"."line_number",
    "jl"."account_id",
    "coa"."code" AS "account_code",
    "coa"."name" AS "account_name",
    "coa"."account_type",
    "coa"."normal_balance",
    "jl"."description" AS "line_description",
    "je"."currency" AS "original_currency",
    "jl"."debit_amount" AS "original_debit",
    "jl"."credit_amount" AS "original_credit",
    "je"."base_currency",
    COALESCE("jl"."base_debit", "jl"."debit_amount") AS "base_debit",
    COALESCE("jl"."base_credit", "jl"."credit_amount") AS "base_credit",
    "je"."exchange_rate" AS "applied_exchange_rate",
    "sum"(
        CASE
            WHEN ("coa"."normal_balance" = 'DEBIT'::"text") THEN (COALESCE("jl"."base_debit", "jl"."debit_amount") - COALESCE("jl"."base_credit", "jl"."credit_amount"))
            ELSE (COALESCE("jl"."base_credit", "jl"."credit_amount") - COALESCE("jl"."base_debit", "jl"."debit_amount"))
        END) OVER (PARTITION BY "jl"."account_id" ORDER BY "je"."transaction_date", "je"."reference", "jl"."line_number" ROWS UNBOUNDED PRECEDING) AS "running_balance_base"
   FROM (("finance"."journal_lines" "jl"
     JOIN "finance"."journal_entries" "je" ON (("je"."id" = "jl"."journal_entry_id")))
     JOIN "finance"."chart_of_accounts" "coa" ON (("coa"."id" = "jl"."account_id")))
  WHERE (("je"."status" = ANY (ARRAY['POSTED'::"text", 'REVERSED'::"text"])) AND ("je"."currency" <> "je"."base_currency"));

COMMENT ON VIEW "reporting"."general_ledger_multi_currency" IS
  'MF-03 (Spec 13.2): Original-currency ledgers report. Restricts '
  'reporting.general_ledger to entries actually posted in a foreign '
  'currency and keeps their original-currency amounts alongside the PKR-'
  'converted amounts and the applied rate, so foreign-currency '
  'transactions can be reviewed in the currency they were recorded in. '
  'AC-02 FIX (P1): includes REVERSED alongside POSTED, same reasoning '
  'as reporting.general_ledger.';


-- ── 4. reporting.get_profit_and_loss ────────────────────────────────
CREATE OR REPLACE FUNCTION "reporting"."get_profit_and_loss"("p_start_date" "date", "p_end_date" "date", "p_organization_id" "uuid") RETURNS TABLE("section_order" integer, "section" "text", "code" "text", "account_name" "text", "debit_total" numeric, "credit_total" numeric, "net_amount" numeric)
    LANGUAGE "sql" STABLE
    SET "search_path" TO 'pg_catalog', 'reporting', 'public'
    AS $$
SELECT
    CASE coa.report_mapping
        WHEN 'PL_REVENUE' THEN 1
        WHEN 'PL_COS' THEN 2
        WHEN 'PL_OP_EXPENSE' THEN 3
        WHEN 'PL_OTHER_INCOME' THEN 4
        WHEN 'PL_OTHER_EXPENSE' THEN 5
        ELSE 6
    END AS section_order,
    COALESCE(coa.report_mapping, coa.account_type) AS section,
    coa.code,
    coa.name AS account_name,
    COALESCE(SUM(jl.base_debit), 0) AS debit_total,
    COALESCE(SUM(jl.base_credit), 0) AS credit_total,
    CASE
        WHEN coa.normal_balance = 'DEBIT' THEN COALESCE(SUM(jl.base_debit), 0) - COALESCE(SUM(jl.base_credit), 0)
        ELSE COALESCE(SUM(jl.base_credit), 0) - COALESCE(SUM(jl.base_debit), 0)
    END AS net_amount
FROM finance.chart_of_accounts coa
JOIN finance.journal_lines jl ON jl.account_id = coa.id
JOIN finance.journal_entries je ON je.id = jl.journal_entry_id
JOIN finance.accounting_periods ap ON ap.id = je.period_id
WHERE je.status IN ('POSTED', 'REVERSED')
  AND ap.start_date >= p_start_date
  AND ap.end_date <= p_end_date
  AND coa.is_active = true
  AND coa.organization_id = p_organization_id
  AND p_organization_id = core.current_user_org_id()
  AND coa.account_type IN ('REVENUE', 'COST_OF_SALES', 'OPERATING_EXPENSE', 'OTHER_INCOME', 'OTHER_EXPENSE')
GROUP BY coa.id, coa.report_mapping, coa.account_type, coa.code, coa.name, coa.normal_balance
ORDER BY section_order, coa.code;
$$;

COMMENT ON FUNCTION "reporting"."get_profit_and_loss"("p_start_date" "date", "p_end_date" "date", "p_organization_id" "uuid") IS
  'AC-02 FIX (P1): status filter widened from POSTED-only to POSTED or '
  'REVERSED so a reversed journal nets to zero against its offsetting '
  'reversal entry instead of dropping out and leaving only the inverse '
  'of the original transaction in the P&L.';


-- ── 5. reporting.get_cash_flow ──────────────────────────────────────
CREATE OR REPLACE FUNCTION "reporting"."get_cash_flow"("p_start_date" "date", "p_end_date" "date", "p_organization_id" "uuid") RETURNS TABLE("section" "text", "account_name" "text", "amount" numeric)
    LANGUAGE "sql" STABLE
    SET "search_path" TO 'pg_catalog', 'reporting', 'public'
    AS $$
WITH pnl_changes AS (
    -- Operating Activities: P&L items
    SELECT
        'OPERATING' AS section,
        coa.name AS account_name,
        SUM(CASE WHEN coa.normal_balance = 'CREDIT' THEN jl.base_credit ELSE -jl.base_debit END) AS amount
    FROM finance.journal_lines jl
    JOIN finance.journal_entries je ON je.id = jl.journal_entry_id AND je.status IN ('POSTED', 'REVERSED')
    JOIN finance.accounting_periods ap ON ap.id = je.period_id
    JOIN finance.chart_of_accounts coa ON coa.id = jl.account_id
    WHERE ap.start_date >= p_start_date AND ap.end_date <= p_end_date
      AND coa.organization_id = p_organization_id
      AND coa.account_type IN ('REVENUE', 'COST_OF_SALES', 'OPERATING_EXPENSE')
    GROUP BY coa.name
    HAVING SUM(CASE WHEN coa.normal_balance = 'CREDIT' THEN jl.base_credit ELSE -jl.base_debit END) != 0

    UNION ALL

    -- Working Capital Changes (Receivables/Payables)
    SELECT
        'OPERATING' AS section,
        'Change in ' || coa.name AS account_name,
        -1 * (COALESCE(SUM(jl.base_debit), 0) - COALESCE(SUM(jl.base_credit), 0)) AS amount
    FROM finance.journal_lines jl
    JOIN finance.journal_entries je ON je.id = jl.journal_entry_id AND je.status IN ('POSTED', 'REVERSED')
    JOIN finance.accounting_periods ap ON ap.id = je.period_id
    JOIN finance.chart_of_accounts coa ON coa.id = jl.account_id
    WHERE ap.start_date >= p_start_date AND ap.end_date <= p_end_date
      AND coa.organization_id = p_organization_id
      AND coa.code LIKE '12%'  -- Receivables
    GROUP BY coa.name
    HAVING (COALESCE(SUM(jl.base_debit), 0) - COALESCE(SUM(jl.base_credit), 0)) != 0

    UNION ALL

    -- Working Capital: Payables
    SELECT
        'OPERATING' AS section,
        'Change in ' || coa.name AS account_name,
        (COALESCE(SUM(jl.base_credit), 0) - COALESCE(SUM(jl.base_debit), 0)) AS amount
    FROM finance.journal_lines jl
    JOIN finance.journal_entries je ON je.id = jl.journal_entry_id AND je.status IN ('POSTED', 'REVERSED')
    JOIN finance.accounting_periods ap ON ap.id = je.period_id
    JOIN finance.chart_of_accounts coa ON coa.id = jl.account_id
    WHERE ap.start_date >= p_start_date AND ap.end_date <= p_end_date
      AND coa.organization_id = p_organization_id
      AND coa.code LIKE '21%'  -- Payables
    GROUP BY coa.name
    HAVING (COALESCE(SUM(jl.base_credit), 0) - COALESCE(SUM(jl.base_debit), 0)) != 0

    UNION ALL

    -- Investing Activities (Fixed Assets - non-depreciation)
    SELECT
        'INVESTING' AS section,
        coa.name AS account_name,
        -1 * (COALESCE(SUM(jl.base_debit), 0) - COALESCE(SUM(jl.base_credit), 0)) AS amount
    FROM finance.journal_lines jl
    JOIN finance.journal_entries je ON je.id = jl.journal_entry_id AND je.status IN ('POSTED', 'REVERSED')
    JOIN finance.accounting_periods ap ON ap.id = je.period_id
    JOIN finance.chart_of_accounts coa ON coa.id = jl.account_id
    WHERE ap.start_date >= p_start_date AND ap.end_date <= p_end_date
      AND coa.organization_id = p_organization_id
      AND coa.code LIKE '151%'
    GROUP BY coa.name
    HAVING (COALESCE(SUM(jl.base_debit), 0) - COALESCE(SUM(jl.base_credit), 0)) != 0

    UNION ALL

    -- Financing Activities (Equity + Long-term Liabilities)
    SELECT
        'FINANCING' AS section,
        coa.name AS account_name,
        CASE WHEN coa.normal_balance = 'CREDIT'
             THEN COALESCE(SUM(jl.base_credit), 0) - COALESCE(SUM(jl.base_debit), 0)
             ELSE -1 * (COALESCE(SUM(jl.base_debit), 0) - COALESCE(SUM(jl.base_credit), 0))
        END AS amount
    FROM finance.journal_lines jl
    JOIN finance.journal_entries je ON je.id = jl.journal_entry_id AND je.status IN ('POSTED', 'REVERSED')
    JOIN finance.accounting_periods ap ON ap.id = je.period_id
    JOIN finance.chart_of_accounts coa ON coa.id = jl.account_id
    WHERE ap.start_date >= p_start_date AND ap.end_date <= p_end_date
      AND coa.organization_id = p_organization_id
      AND (coa.account_type = 'EQUITY' OR coa.code LIKE '251%')
    GROUP BY coa.name, coa.normal_balance
    HAVING CASE WHEN coa.normal_balance = 'CREDIT'
           THEN COALESCE(SUM(jl.base_credit), 0) - COALESCE(SUM(jl.base_debit), 0)
           ELSE -1 * (COALESCE(SUM(jl.base_debit), 0) - COALESCE(SUM(jl.base_credit), 0))
    END != 0
)
SELECT * FROM pnl_changes
WHERE p_organization_id = core.current_user_org_id()
ORDER BY
    CASE section WHEN 'OPERATING' THEN 1 WHEN 'INVESTING' THEN 2 WHEN 'FINANCING' THEN 3 END,
    account_name;
$$;

COMMENT ON FUNCTION "reporting"."get_cash_flow"("p_start_date" "date", "p_end_date" "date", "p_organization_id" "uuid") IS
  'AC-02 FIX (P1): all five JOIN conditions widened from '
  'je.status = ''POSTED'' to je.status IN (''POSTED'', ''REVERSED'') so a '
  'reversed journal nets to zero against its offsetting reversal entry '
  'in every section (operating, working capital, investing, financing) '
  'instead of showing the inverse of the original transaction.';


-- ── 6. reporting.get_trial_balance ──────────────────────────────────
CREATE OR REPLACE FUNCTION "reporting"."get_trial_balance"("p_period_ids" "uuid"[], "p_organization_id" "uuid") RETURNS TABLE("account_id" "uuid", "code" "text", "name" "text", "account_type" "text", "normal_balance" "text", "total_debit" numeric, "total_credit" numeric, "net_balance" numeric)
    LANGUAGE "plpgsql" STABLE
    SET "search_path" TO 'pg_catalog', 'reporting', 'public'
    AS $$ BEGIN
  RETURN QUERY
  SELECT
    coa.id,
    coa.code,
    coa.name,
    coa.account_type,
    coa.normal_balance,
    COALESCE(SUM(COALESCE(jl.base_debit, jl.debit_amount)), 0) AS total_debit,
    COALESCE(SUM(COALESCE(jl.base_credit, jl.credit_amount)), 0) AS total_credit,
    CASE
      WHEN coa.normal_balance = 'DEBIT'
        THEN COALESCE(SUM(COALESCE(jl.base_debit, jl.debit_amount)), 0) - COALESCE(SUM(COALESCE(jl.base_credit, jl.credit_amount)), 0)
      ELSE COALESCE(SUM(COALESCE(jl.base_credit, jl.credit_amount)), 0) - COALESCE(SUM(COALESCE(jl.base_debit, jl.debit_amount)), 0)
    END AS net_balance
  FROM finance.chart_of_accounts coa
  LEFT JOIN finance.journal_lines jl ON jl.account_id = coa.id
  -- FND-GL-01 fix: INNER JOIN (was LEFT JOIN) so a non-matching status/period
  -- actually removes the line from the sums instead of silently passing it
  -- through with je.* = NULL.
  -- AC-02 FIX (P1): status widened from POSTED-only to POSTED or REVERSED —
  -- a reversed journal and its offsetting reversal entry must both be
  -- counted so the pair nets to zero, instead of the REVERSED original
  -- dropping out and leaving only the inverse of the original transaction.
  INNER JOIN finance.journal_entries je ON je.id = jl.journal_entry_id
    AND je.status IN ('POSTED', 'REVERSED')
    AND je.period_id = ANY(p_period_ids)
  WHERE coa.is_active = true
    AND coa.organization_id = p_organization_id
    AND p_organization_id = core.current_user_org_id()
    AND coa.posting_allowed = true
  GROUP BY coa.id, coa.code, coa.name, coa.account_type, coa.normal_balance
  HAVING COALESCE(SUM(COALESCE(jl.base_debit, jl.debit_amount)), 0) > 0
      OR COALESCE(SUM(COALESCE(jl.base_credit, jl.credit_amount)), 0) > 0
  ORDER BY coa.code;
END;
 $$;

COMMENT ON FUNCTION "reporting"."get_trial_balance"("p_period_ids" "uuid"[], "p_organization_id" "uuid") IS
  'FND-GL-01 fix: INNER JOIN (was LEFT JOIN) so a non-matching status or '
  'period actually removes the line from the sums instead of silently '
  'passing it through with je.* = NULL. AC-02 FIX (P1): status widened '
  'from POSTED-only to POSTED or REVERSED so a reversed journal nets to '
  'zero against its offsetting reversal entry.';


-- ── Documentation-only annotation on the source of the status flip ──
COMMENT ON FUNCTION "finance"."reverse_journal_entry"("p_journal_id" "uuid", "p_reversal_date" "date", "p_reason" "text") IS
  'BUG-005 fix (database audit): added an explicit fiscal-period-lock '
  'check as defense-in-depth alongside the existing '
  'trg_prevent_closed_period_posting table trigger. BUG-003 fix: removed '
  'organization_id from the journal_lines INSERT/SELECT -- that column '
  'does not exist on journal_lines (it is scoped only via '
  'journal_entry_id -> journal_entries.organization_id, already enforced '
  'by the org-scoped lookup on v_original above). AC-02 NOTE (P1): this '
  'function correctly creates an offsetting reversal entry with '
  'debit_amount/credit_amount swapped on every line (do not change that '
  '-- it is the standard, audit-safe way to cancel a posting without '
  'mutating history), but it also flips the ORIGINAL entry''s status to '
  'REVERSED. Every reporting query that aggregates the GL must treat '
  'REVERSED the same as POSTED (see reporting.trial_balance, '
  'reporting.general_ledger, reporting.general_ledger_multi_currency, '
  'reporting.get_profit_and_loss, reporting.get_cash_flow, '
  'reporting.get_trial_balance) or the original silently drops out of '
  'every statement while its swapped-sign reversal stays counted, '
  'showing the inverse of the original transaction instead of zero. Do '
  'not "fix" those reports back to POSTED-only.';

COMMIT;