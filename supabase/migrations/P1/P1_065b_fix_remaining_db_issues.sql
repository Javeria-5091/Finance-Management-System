-- =====================================================================
-- OSYSTIC Finance Management System
-- DATABASE-LAYER AUDIT FIX SCRIPT
-- Generated against: schema.sql (17,997 lines) from the uploaded
--                     Finance-Management-System-source.zip
-- Reference: OSYSTIC Finance System Pre-Submission Audit Report
--            (28 issues, dated 2026-08-24)
--
-- HOW THIS FILE WAS BUILT
-- ------------------------
-- Every finding below was re-checked against your ACTUAL schema.sql
-- (not just copy-pasted from the report), because several of the
-- report's 28 issues turned out to already be fixed in this codebase
-- (via earlier P1_xxx migrations), and a couple were described
-- slightly differently than how the real code behaves. So:
--
--   * Issues that are GENUINELY still open  -> fixed below.
--   * Issues that were ALREADY fixed in schema.sql -> left alone,
--     but noted so you have a full paper trail against the 28 items.
--   * Issues that are frontend/API-layer only (not database) -> not
--     in this file at all, since they can't be fixed in SQL.
--
-- This script is IDEMPOTENT: it is safe to run multiple times and
-- safe to run even if some fixes are already partially applied.
-- Run it against your live Supabase DB (SQL Editor or `psql`/CLI),
-- ideally on a staging copy first.
-- =====================================================================


-- =====================================================================
-- BUG-001 (CRITICAL) — Vendor payment GL posting omits discount line
-- =====================================================================
-- Verified: finance.post_vendor_payment() currently has NO concept of an
-- early-payment / settlement discount at all — vendor_payment_allocations
-- has no discount column, so a discounted payment silently leaves AP
-- open by the discount amount (debit AP for the bill portion but credit
-- Bank for less), which unbalances the journal.
--
-- Fix: add discount columns to the allocation table, auto-create a
-- "Purchase Discounts Received" GL account per organization if one
-- doesn't already exist, and rewrite post_vendor_payment() to post a
-- third balancing line whenever a discount was taken.
-- =====================================================================

ALTER TABLE finance.vendor_payment_allocations
    ADD COLUMN IF NOT EXISTS discount_amount numeric(18,2) NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS base_discount_amount numeric(18,2) NOT NULL DEFAULT 0;

ALTER TABLE finance.vendor_payment_allocations
    DROP CONSTRAINT IF EXISTS vendor_payment_allocations_discount_amount_check;
ALTER TABLE finance.vendor_payment_allocations
    ADD CONSTRAINT vendor_payment_allocations_discount_amount_check
    CHECK (discount_amount >= 0);

-- Auto-provision a "Purchase Discounts Received" account for every
-- organization that doesn't already have a discount-type account.
INSERT INTO finance.chart_of_accounts
    (code, name, account_type, normal_balance, currency, is_active,
     posting_allowed, is_control_account, description, display_order,
     level, organization_id)
SELECT
    '4910', 'Purchase Discounts Received', 'OTHER_INCOME', 'CREDIT', 'PKR',
    true, true, false,
    'Early-payment / settlement discounts taken on vendor bills. Auto-created by BUG-001 database audit fix.',
    0, 0, o.id
FROM core.organizations o
WHERE NOT EXISTS (
    SELECT 1 FROM finance.chart_of_accounts c
    WHERE c.organization_id = o.id
      AND (c.code = '4910' OR c.name ILIKE '%discount%')
);

CREATE OR REPLACE FUNCTION "finance"."post_vendor_payment"("p_payment_id" "uuid", "p_period_id" "uuid", "p_transaction_date" "date") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'finance', 'public'
    AS $$
DECLARE
    v_pay RECORD;
    v_fy_id UUID;
    v_ap_account UUID;
    v_bank_account UUID;
    v_wht_payable UUID;
    v_discount_account UUID;
    v_total_allocated NUMERIC(18,2);
    v_total_withholding NUMERIC(18,2);
    v_total_discount NUMERIC(18,2);
    v_total_bill_amount NUMERIC(18,2);
    v_lines JSONB := '[]'::JSONB;
BEGIN
    SELECT * INTO v_pay FROM finance.vendor_payments WHERE id = p_payment_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Payment not found'; END IF;

    SELECT fiscal_year_id INTO v_fy_id FROM finance.accounting_periods WHERE id = p_period_id;
    IF v_fy_id IS NULL THEN RAISE EXCEPTION 'Invalid period'; END IF;

    SELECT id INTO v_ap_account FROM finance.chart_of_accounts WHERE code = '2110' LIMIT 1;
    IF v_ap_account IS NULL THEN RAISE EXCEPTION 'AP account 2110 not found'; END IF;

    SELECT id INTO v_bank_account FROM finance.chart_of_accounts WHERE code = '1110' LIMIT 1;
    IF v_bank_account IS NULL THEN RAISE EXCEPTION 'Bank account 1110 not found'; END IF;

    SELECT id INTO v_wht_payable FROM finance.chart_of_accounts WHERE code = '2210' LIMIT 1;

    -- BUG-001 FIX: resolve the discount account (falls back to name match
    -- in case an org already had a differently-coded discount account
    -- before this migration ran).
    SELECT id INTO v_discount_account
    FROM finance.chart_of_accounts
    WHERE code = '4910' OR name ILIKE '%discount%'
    ORDER BY (code = '4910') DESC
    LIMIT 1;

    SELECT
        COALESCE(SUM(vpa.allocated_amount), 0),
        COALESCE(SUM(
            (SELECT COALESCE(SUM(COALESCE(bl.base_withholding_amount, bl.withholding_amount, 0)), 0)
             FROM finance.vendor_bill_lines bl
             WHERE bl.vendor_bill_id = vpa.vendor_bill_id)
        ), 0),
        COALESCE(SUM(vpa.discount_amount), 0),
        COALESCE(SUM(vb.total_amount), 0)
    INTO v_total_allocated, v_total_withholding, v_total_discount, v_total_bill_amount
    FROM finance.vendor_payment_allocations vpa
    JOIN finance.vendor_bills vb ON vb.id = vpa.vendor_bill_id
    WHERE vpa.vendor_payment_id = p_payment_id;

    IF v_total_discount > 0 AND v_discount_account IS NULL THEN
        RAISE EXCEPTION 'A discount was taken on this payment but no "Purchase Discounts Received" GL account exists. Run the BUG-001 fix migration or create one manually before posting.';
    END IF;

    -- Debit AP for the FULL bill amount being cleared (allocated + discount)
    IF (v_total_allocated + v_total_discount) > 0 THEN
        v_lines := jsonb_build_object(
            'account_id', v_ap_account,
            'debit_amount', v_total_allocated + v_total_discount,
            'credit_amount', 0,
            'description', 'AP Cleared: ' || v_pay.payment_number
        );
    END IF;

    -- Credit Bank for the NET cash actually paid out
    IF v_total_allocated > 0 THEN
        v_lines := v_lines || jsonb_build_object(
            'account_id', v_bank_account,
            'debit_amount', 0,
            'credit_amount', v_total_allocated,
            'description', 'Paid to Vendor: ' || v_pay.payment_number
        );
    END IF;

    -- BUG-001 FIX: Credit Purchase Discounts Received so the journal
    -- balances (debit AP = credit Bank + credit Discount Received).
    IF v_total_discount > 0 THEN
        v_lines := v_lines || jsonb_build_object(
            'account_id', v_discount_account,
            'debit_amount', 0,
            'credit_amount', v_total_discount,
            'description', 'Early Payment Discount Taken: ' || v_pay.payment_number
        );
    END IF;

    -- Credit WHT Payable (deposit withholding tax)
    IF v_total_withholding > 0 AND v_wht_payable IS NOT NULL THEN
        v_lines := v_lines || jsonb_build_object(
            'account_id', v_wht_payable,
            'debit_amount', 0,
            'credit_amount', v_total_withholding,
            'description', 'WHT Deposited: ' || v_pay.payment_number
        );
    END IF;

    RETURN finance.post_journal_entry(
        'Vendor Payment: ' || v_pay.payment_number,
        p_transaction_date, p_period_id,
        v_lines,
        'PKR', 1.0000,
        'VENDOR_PAYMENT', p_payment_id,
        NULL, NULL
    );
END;
$$;

ALTER FUNCTION "finance"."post_vendor_payment"("p_payment_id" "uuid", "p_period_id" "uuid", "p_transaction_date" "date") OWNER TO "postgres";

COMMENT ON FUNCTION "finance"."post_vendor_payment"("p_payment_id" "uuid", "p_period_id" "uuid", "p_transaction_date" "date")
    IS 'BUG-001 fix (database audit): now posts vendor_payment_allocations.discount_amount to a Purchase Discounts Received GL line so debit AP always equals credit Bank + credit Discount, keeping the journal balanced.';


-- =====================================================================
-- BUG-002 (CRITICAL) — Organization isolation gap in audit_log view
-- =====================================================================
-- ALREADY FIXED in this codebase. public.v_audit_log is defined with
-- security_invoker = true, and the underlying audit.audit_log table has
-- RLS enabled with organization-scoped SELECT policies
-- (audit_log_select_auditor / _full / _limited / _own, all using
-- core.same_org(organization_id)). No action needed. Left here only so
-- the 28-item list is fully accounted for.
-- =====================================================================


-- =====================================================================
-- BUG-003 (CRITICAL) — Reporting currency conversion SECURITY INVOKER bug
-- =====================================================================
-- NOT APPLICABLE to this codebase as-is: there is no
-- finance.get_reporting_rate() function, and in fact NO function in the
-- whole schema is declared SECURITY INVOKER (0 matches) — every posting
-- and reporting function is SECURITY DEFINER with a fixed search_path.
-- Multi-currency reports read pre-converted base_debit/base_credit
-- values stored on finance.journal_lines at posting time, not a
-- live conversion function, so this specific failure mode doesn't exist
-- here. No action taken. If you later add a live rate-lookup function,
-- declare it SECURITY DEFINER with SET search_path exactly like
-- finance.post_journal_entry() does.
-- =====================================================================


-- =====================================================================
-- BUG-005 (CRITICAL) — Reverse journal entry bypasses fiscal period lock
-- =====================================================================
-- PARTIALLY already mitigated: finance.journal_entries has a table-level
-- trigger (trg_prevent_closed_period_posting, BEFORE INSERT OR UPDATE)
-- that calls finance.prevent_closed_period_posting(), which DOES fire
-- for the INSERT that reverse_journal_entry() performs and blocks
-- HARD_CLOSED periods (and SOFT_CLOSED when status = 'POSTED').
--
-- However, that protection is implicit and easy to break by future
-- refactors (e.g. anyone who disables the trigger for a bulk job).
-- Fix: add an EXPLICIT, redundant check directly inside
-- reverse_journal_entry() as defense-in-depth, with a clear message.
-- =====================================================================

CREATE OR REPLACE FUNCTION "finance"."reverse_journal_entry"("p_journal_id" "uuid", "p_reversal_date" "date", "p_reason" "text") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'finance', 'public'
    AS $$
DECLARE
  v_original RECORD;
  v_reversal_id UUID;
  v_ref TEXT;
  v_period_status TEXT;
BEGIN
  -- 1. Fetch original
  SELECT * INTO v_original
  FROM finance.journal_entries WHERE id = p_journal_id;

  IF NOT FOUND THEN RAISE EXCEPTION 'Journal not found'; END IF;
  IF v_original.status != 'POSTED' THEN RAISE EXCEPTION 'Can only reverse POSTED entries'; END IF;
  IF v_original.reversal_of_id IS NOT NULL THEN RAISE EXCEPTION 'This is already a reversal'; END IF;
  IF p_reason IS NULL OR TRIM(p_reason) = '' THEN RAISE EXCEPTION 'Reversal reason is mandatory'; END IF;

  -- BUG-005 FIX: explicit fiscal-period-lock check, in addition to the
  -- table trigger. Reversal always posts into the ORIGINAL entry's
  -- period (see INSERT below), so that is the period we must validate.
  SELECT status INTO v_period_status
  FROM finance.accounting_periods
  WHERE id = v_original.period_id;

  IF v_period_status IS NULL THEN
    RAISE EXCEPTION 'Cannot reverse journal %: its accounting period no longer exists', p_journal_id;
  END IF;

  IF v_period_status = 'HARD_CLOSED' THEN
    RAISE EXCEPTION 'Cannot reverse journal %: fiscal period is HARD CLOSED', p_journal_id;
  END IF;

  IF v_period_status = 'SOFT_CLOSED' THEN
    RAISE EXCEPTION 'Cannot reverse journal %: fiscal period is SOFT CLOSED. Reopen the period or post the reversal into a later open period.', p_journal_id;
  END IF;

  v_ref := finance.get_next_number('JOURNAL_ENTRY');

  -- 2. Mark original as REVERSED
  UPDATE finance.journal_entries
  SET status = 'REVERSED', reversed_by = auth.uid(), reversed_at = NOW(), reversal_reason = p_reason
  WHERE id = p_journal_id;

  -- 3. Create Reversal Header (Swapped totals)
  INSERT INTO finance.journal_entries (
    reference, description, status, transaction_date, posting_date,
    period_id, fiscal_year_id, currency, exchange_rate, base_currency,
    total_debit, total_credit, source_type, source_id, project_id, department_id,
    reversal_of_id, reversal_reason,
    created_by, posted_by, posted_at
  ) VALUES (
    v_ref, 'REVERSAL: ' || v_original.description, 'POSTED', p_reversal_date, CURRENT_DATE,
    v_original.period_id, v_original.fiscal_year_id, v_original.currency, v_original.exchange_rate, v_original.base_currency,
    v_original.total_credit, v_original.total_debit, -- SWAPPED
    'REVERSAL', p_journal_id, v_original.project_id, v_original.department_id,
    p_journal_id, p_reason,
    auth.uid(), auth.uid(), NOW()
  ) RETURNING id INTO v_reversal_id;

  -- 4. Create Reversal Lines (Swapped Dr/Cr)
  INSERT INTO finance.journal_lines (
    journal_entry_id, line_number, account_id, description,
    debit_amount, credit_amount, currency, exchange_rate, base_debit, base_credit,
    project_id, department_id, created_by
  )
  SELECT
    v_reversal_id, line_number, account_id, 'REVERSAL: ' || COALESCE(description, ''),
    credit_amount, debit_amount, -- SWAPPED
    currency, exchange_rate, base_credit, base_debit, -- SWAPPED
    project_id, department_id, auth.uid()
  FROM finance.journal_lines WHERE journal_entry_id = p_journal_id;

  RETURN v_reversal_id;
END;
$$;

ALTER FUNCTION "finance"."reverse_journal_entry"("p_journal_id" "uuid", "p_reversal_date" "date", "p_reason" "text") OWNER TO "postgres";

COMMENT ON FUNCTION "finance"."reverse_journal_entry"("p_journal_id" "uuid", "p_reversal_date" "date", "p_reason" "text")
    IS 'BUG-005 fix (database audit): added an explicit fiscal-period-lock check as defense-in-depth alongside the existing trg_prevent_closed_period_posting table trigger.';


-- =====================================================================
-- BUG-006 (HIGH) — Vendor bill FX gain/loss / currency handling
-- =====================================================================
-- Verified the ACTUAL bug is more fundamental than the report describes:
-- finance.post_vendor_bill() hard-codes the journal currency as 'PKR'
-- and the exchange rate as 1.0000, completely ignoring
-- vendor_bills.currency / vendor_bills.exchange_rate. For any bill not
-- issued in the base currency, this silently drops all FX information
-- from the GL posting.
--
-- Fix: post using the bill's own currency and exchange rate so the
-- resulting journal (and any base_debit/base_credit conversion done by
-- post_journal_entry / triggers) reflects the real FX exposure.
-- =====================================================================

CREATE OR REPLACE FUNCTION "finance"."post_vendor_bill"("p_bill_id" "uuid", "p_period_id" "uuid", "p_transaction_date" "date") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'finance', 'core', 'public'
    AS $$
DECLARE
    v_bill RECORD;
    v_fy_id UUID;
    v_lines JSONB := '[]'::JSONB;
    v_ap_account UUID;
    v_wht_account UUID;
    v_line RECORD;
    v_total_debit NUMERIC(18,2) := 0;
    v_total_credit NUMERIC(18,2) := 0;
BEGIN
    IF NOT (core.is_finance_head() OR core.has_role('ACCOUNTANT')) THEN
        RAISE EXCEPTION 'Insufficient privileges to post a vendor bill to the general ledger. Requires Finance Head, CEO, or Accountant.';
    END IF;

    SELECT * INTO v_bill FROM finance.vendor_bills WHERE id = p_bill_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Bill not found'; END IF;

    IF NOT core.same_org(v_bill.organization_id) THEN
        RAISE EXCEPTION 'Access denied: vendor bill % does not belong to your organization', p_bill_id;
    END IF;

    IF v_bill.status != 'APPROVED' THEN
        RAISE EXCEPTION 'Bill must be APPROVED before posting, current: %', v_bill.status;
    END IF;

    SELECT fiscal_year_id INTO v_fy_id FROM finance.accounting_periods WHERE id = p_period_id;
    IF v_fy_id IS NULL THEN RAISE EXCEPTION 'Invalid period'; END IF;

    SELECT id INTO v_ap_account FROM finance.chart_of_accounts WHERE code = '2110' LIMIT 1;
    IF v_ap_account IS NULL THEN RAISE EXCEPTION 'AP account 2110 not found'; END IF;

    SELECT id INTO v_wht_account FROM finance.chart_of_accounts WHERE code = '1401' LIMIT 1;
    IF v_wht_account IS NULL THEN RAISE EXCEPTION 'WHT Receivable account 1401 not found'; END IF;

    FOR v_line IN (
        SELECT id, account_id, line_total AS line_amount, description,
               COALESCE(withholding_amount, 0) AS wht_amount
        FROM finance.vendor_bill_lines
        WHERE vendor_bill_id = p_bill_id
        ORDER BY line_number
    ) LOOP
        v_lines := v_lines || jsonb_build_object(
            'account_id', v_line.account_id,
            'debit_amount', v_line.line_amount - v_line.wht_amount,
            'credit_amount', 0,
            'description', v_line.description
        );
        v_total_debit := v_total_debit + (v_line.line_amount - v_line.wht_amount);

        IF v_line.wht_amount > 0 THEN
            v_lines := v_lines || jsonb_build_object(
                'account_id', v_wht_account,
                'debit_amount', v_line.wht_amount,
                'credit_amount', 0,
                'description', 'WHT on Bill ' || v_bill.bill_number
            );
            v_total_debit := v_total_debit + v_line.wht_amount;
        END IF;
    END LOOP;

    v_lines := v_lines || jsonb_build_object(
        'account_id', v_ap_account,
        'debit_amount', 0,
        'credit_amount', v_bill.total_amount,
        'description', 'AP: ' || v_bill.bill_number || ' - ' || COALESCE((SELECT name FROM finance.vendors WHERE id = v_bill.vendor_id), '')
    );
    v_total_credit := v_bill.total_amount;

    IF ABS(v_total_debit - v_total_credit) > 0.02 THEN
        RAISE EXCEPTION 'Journal unbalanced: DR=% CR=%', v_total_debit, v_total_credit;
    END IF;

    -- BUG-006 FIX: use the bill's OWN currency and exchange rate instead
    -- of hard-coding 'PKR' / 1.0000, so FX exposure on foreign-currency
    -- bills (line amounts already include tax via line_total, and the
    -- AP credit is the tax-inclusive total_amount) is correctly recorded
    -- in the journal rather than silently discarded.
    RETURN finance.post_journal_entry(
        'AP Bill: ' || v_bill.bill_number,
        p_transaction_date, p_period_id,
        v_lines,
        COALESCE(v_bill.currency, 'PKR'), COALESCE(v_bill.exchange_rate, 1.0000),
        'VENDOR_BILL', p_bill_id,
        v_bill.project_id, NULL
    );
END;
$$;

ALTER FUNCTION "finance"."post_vendor_bill"("p_bill_id" "uuid", "p_period_id" "uuid", "p_transaction_date" "date") OWNER TO "postgres";

COMMENT ON FUNCTION "finance"."post_vendor_bill"("p_bill_id" "uuid", "p_period_id" "uuid", "p_transaction_date" "date")
    IS 'BUG-006 fix (database audit): posts using vendor_bills.currency / vendor_bills.exchange_rate instead of hard-coded PKR/1.0, so foreign-currency bills carry correct FX information into the journal. Retains the P1_060 role/org-ownership checks.';


-- =====================================================================
-- BUG-015 (MEDIUM) — Missing FK on journal_lines.account_id
-- =====================================================================
-- ALREADY FIXED: constraint journal_lines_account_id_fkey already exists
-- (FOREIGN KEY (account_id) REFERENCES finance.chart_of_accounts(id)).
-- No action needed.
-- =====================================================================


-- =====================================================================
-- BUG-016 (MEDIUM) — Approval limit thresholds stored as text
-- =====================================================================
-- ALREADY FIXED: core.approval_limits.max_amount is already numeric,
-- with CHECK (max_amount IS NULL OR max_amount >= 0). No text column
-- exists for this. No action needed.
-- =====================================================================


-- =====================================================================
-- BUG-019 (MEDIUM) — Budget vs actual view diverges from spec
--                     (missing committed/encumbered amount)
-- =====================================================================
-- Verified: reporting.budget_vs_actual currently only compares posted
-- actuals against the budget total and has no concept of committed
-- (approved-but-unpaid) vendor bill spend against the same project.
-- Fix: extend the view with a committed_amount column and recompute
-- remaining_amount / utilization_pct to include it, matching spec.
-- =====================================================================

CREATE OR REPLACE VIEW "reporting"."budget_vs_actual" WITH ("security_invoker"='true') AS
 SELECT "b"."id" AS "budget_id",
    "b"."name" AS "budget_name",
    "b"."category" AS "budget_category",
    "b"."total_amount" AS "budgeted_amount",
    "b"."start_date",
    "b"."end_date",
    COALESCE("sum"(
        CASE
            WHEN ("coa"."normal_balance" = 'DEBIT'::"text") THEN (COALESCE("jl"."base_debit", "jl"."debit_amount") - COALESCE("jl"."base_credit", "jl"."credit_amount"))
            ELSE (COALESCE("jl"."base_credit", "jl"."credit_amount") - COALESCE("jl"."base_debit", "jl"."debit_amount"))
        END), (0)::numeric) AS "actual_amount",
    ("b"."total_amount"
        - COALESCE("sum"(
            CASE
                WHEN ("coa"."normal_balance" = 'DEBIT'::"text") THEN (COALESCE("jl"."base_debit", "jl"."debit_amount") - COALESCE("jl"."base_credit", "jl"."credit_amount"))
                ELSE (COALESCE("jl"."base_credit", "jl"."credit_amount") - COALESCE("jl"."base_debit", "jl"."debit_amount"))
            END), (0)::numeric)
        - COALESCE((
            SELECT SUM(vb.total_amount - vb.amount_paid)
            FROM finance.vendor_bills vb
            WHERE vb.project_id = "p"."id"
              AND vb.status = 'APPROVED'
        ), 0::numeric)
    ) AS "remaining_amount",
        CASE
            WHEN ("b"."total_amount" = (0)::numeric) THEN (0)::numeric
            ELSE "round"((((COALESCE("sum"(
            CASE
                WHEN ("coa"."normal_balance" = 'DEBIT'::"text") THEN (COALESCE("jl"."base_debit", "jl"."debit_amount") - COALESCE("jl"."base_credit", "jl"."credit_amount"))
                ELSE (COALESCE("jl"."base_credit", "jl"."credit_amount") - COALESCE("jl"."base_debit", "jl"."debit_amount"))
            END), (0)::numeric)
            + COALESCE((
                SELECT SUM(vb.total_amount - vb.amount_paid)
                FROM finance.vendor_bills vb
                WHERE vb.project_id = "p"."id"
                  AND vb.status = 'APPROVED'
            ), 0::numeric)) / "b"."total_amount") * (100)::numeric), 2)
        END AS "utilization_pct",
    "p"."id" AS "project_id",
    "p"."name" AS "project_name",
    -- BUG-019 FIX: committed = APPROVED-but-not-yet-fully-paid vendor
    -- bills against the same project (outstanding balance only).
    -- Appended as the LAST column (Postgres only allows CREATE OR REPLACE
    -- VIEW to ADD trailing columns, not insert them in the middle).
    COALESCE((
        SELECT SUM(vb.total_amount - vb.amount_paid)
        FROM finance.vendor_bills vb
        WHERE vb.project_id = "p"."id"
          AND vb.status = 'APPROVED'
    ), 0::numeric) AS "committed_amount"
   FROM (((("public"."budgets" "b"
     LEFT JOIN "public"."projects" "p" ON (("p"."budget_id" = "b"."id")))
     LEFT JOIN "finance"."journal_entries" "je" ON ((("je"."project_id" = "p"."id") AND ("je"."status" = 'POSTED'::"text") AND ("je"."source_type" = 'EXPENSE'::"text"))))
     LEFT JOIN "finance"."journal_lines" "jl" ON (("jl"."journal_entry_id" = "je"."id")))
     LEFT JOIN "finance"."chart_of_accounts" "coa" ON ((("coa"."id" = "jl"."account_id") AND ("coa"."account_type" = ANY (ARRAY['EXPENSE'::"text", 'COST_OF_SALES'::"text"])))))
  GROUP BY "b"."id", "b"."name", "b"."category", "b"."total_amount", "b"."start_date", "b"."end_date", "p"."id", "p"."name";

ALTER VIEW "reporting"."budget_vs_actual" OWNER TO "postgres";

COMMENT ON VIEW "reporting"."budget_vs_actual"
    IS 'BUG-019 fix (database audit): added committed_amount (approved-but-unpaid vendor bills on the same project) so remaining_amount/utilization_pct reflect true available budget, per spec.';

-- Re-grant, since CREATE OR REPLACE VIEW does not always preserve grants
-- across a column-set change on some Postgres/Supabase setups.
GRANT SELECT ON TABLE "reporting"."budget_vs_actual" TO "service_role";
GRANT SELECT ON TABLE "reporting"."budget_vs_actual" TO "ai_readonly_role";
GRANT SELECT ON TABLE "reporting"."budget_vs_actual" TO "authenticated";


-- =====================================================================
-- BUG-020 (MEDIUM) — CHECK constraint syntax error in exchange_rates
-- =====================================================================
-- The table structure has since changed (no valid_from/valid_to columns
-- any more — it uses rate_date + rate_time instead), so the specific
-- malformed constraint described in the report no longer exists.
-- However, there is currently NO constraint at all guaranteeing
-- exchange_rates.rate is positive. Fix: add that guard.
-- =====================================================================

ALTER TABLE finance.exchange_rates
    DROP CONSTRAINT IF EXISTS exchange_rates_rate_positive_check;
ALTER TABLE finance.exchange_rates
    ADD CONSTRAINT exchange_rates_rate_positive_check
    CHECK (rate > 0);


-- =====================================================================
-- BUG-022 (MEDIUM) — Credit note may exceed outstanding invoice balance
-- =====================================================================
-- This is an API-route-level validation gap (src/app/api/finance/
-- credit-notes/route.ts) — not something the current schema exposes a
-- clean DB hook for (finance.credit_notes is not FK-linked 1:1 to a
-- single invoice balance check trigger in this schema). Recommend
-- fixing in the API route as the audit report suggests; not included
-- in this SQL file.
-- =====================================================================


-- =====================================================================
-- BUG-024 (LOW) — CHECK constraints created as NOT VALID
-- =====================================================================
-- Verified: 48 NOT VALID constraints exist (mostly the
-- "<table>_org_required_going_forward" backfill constraints from the
-- organization-isolation migrations, plus a couple of amount/status
-- checks on invoices). Fix: validate every NOT VALID check constraint
-- in the finance/core/public schemas. Each one is validated in its own
-- sub-transaction (SAVEPOINT) so a single table with legacy bad data
-- doesn't block the rest — any failures are reported via NOTICE so you
-- know exactly which table/rows still need manual data cleanup.
-- =====================================================================

DO $$
DECLARE
    r RECORD;
    v_failed_count INTEGER := 0;
    v_ok_count INTEGER := 0;
BEGIN
    FOR r IN
        SELECT
            n.nspname AS schema_name,
            t.relname AS table_name,
            c.conname AS constraint_name
        FROM pg_constraint c
        JOIN pg_class t ON t.oid = c.conrelid
        JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE c.contype = 'c'
          AND c.convalidated = false
          AND n.nspname IN ('finance', 'core', 'public', 'audit', 'reporting')
        ORDER BY n.nspname, t.relname, c.conname
    LOOP
        BEGIN
            EXECUTE format(
                'ALTER TABLE %I.%I VALIDATE CONSTRAINT %I',
                r.schema_name, r.table_name, r.constraint_name
            );
            v_ok_count := v_ok_count + 1;
        EXCEPTION WHEN check_violation THEN
            v_failed_count := v_failed_count + 1;
            RAISE NOTICE 'BUG-024: could NOT validate %.%.% - existing rows violate this constraint. Clean up the offending data, then run: ALTER TABLE %.% VALIDATE CONSTRAINT %;',
                r.schema_name, r.table_name, r.constraint_name,
                r.schema_name, r.table_name, r.constraint_name;
        END;
    END LOOP;

    RAISE NOTICE 'BUG-024: validated % of % NOT VALID check constraints (% need manual data cleanup before they can be validated).',
        v_ok_count, v_ok_count + v_failed_count, v_failed_count;
END $$;


-- =====================================================================
-- BUG-025 (LOW) — AI assistant role grants exceed read-only scope
-- =====================================================================
-- ALREADY FIXED: ai_readonly_role currently has only USAGE (schema) and
-- SELECT (table/view) grants across the whole schema.sql — no INSERT/
-- UPDATE grants exist anywhere for this role. No action needed.
-- =====================================================================


-- =====================================================================
-- BUG-026 (LOW) — Duplicate audit trigger definitions
-- =====================================================================
-- ALREADY FIXED: each core transaction table (journal_entries,
-- vendor_bills, invoices, expenses, approval_limits, etc.) has exactly
-- one AFTER INSERT OR DELETE OR UPDATE trigger calling
-- audit.trigger_audit_log(). No duplicates found. No action needed.
-- =====================================================================


-- =====================================================================
-- SUMMARY / WHAT THIS FILE DID NOT TOUCH
-- =====================================================================
-- Not included here because they are frontend/API code, not SQL:
--   BUG-004 (MFA middleware matcher), BUG-007 (invoice line tax calc,
--   frontend), BUG-008 (attachment upload trusting client org_id),
--   BUG-009 (income form validation schema), BUG-010 (invoice number
--   retry-on-conflict handling), BUG-011 (audit log API query filter),
--   BUG-012 (payment route org check), BUG-013 (dashboard cash widget),
--   BUG-014 (budget check cache invalidation), BUG-017 (dashboard
--   loading state), BUG-018 (payment allocation client match — could be
--   a DB CHECK/trigger too if you want one added), BUG-021 (currency
--   formatting utility), BUG-022 (see note above), BUG-023 (notification
--   channel validation), BUG-027 (dead code), BUG-028 (filter state).
--
-- If you'd like, I can also add a DB-level trigger for BUG-018
-- (cross-client payment allocation) and a CHECK/trigger for BUG-022
-- (credit note vs. outstanding invoice balance) as belt-and-suspenders
-- protection even though the primary fix belongs in the API routes —
-- just ask.
-- =====================================================================