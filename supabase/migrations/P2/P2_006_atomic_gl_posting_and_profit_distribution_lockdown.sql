-- ═══════════════════════════════════════════════════════════════════════
-- P2_005: Atomic GL posting for income/expense/invoice/vendor-bill
--         + lockdown of the insecure finance.post_profit_distribution RPC
-- ═══════════════════════════════════════════════════════════════════════
-- Apply this migration to the database (e.g. via the Supabase CLI /
-- migration runner) to fix FND-FIN-001 and FND-ACCT-001.
--
-- NOTE: schema.sql (the consolidated dump) is intentionally left
-- untouched by this change, per instruction. Once this migration has been
-- applied to the actual database, regenerate schema.sql from it in the
-- normal way (e.g. `supabase db dump`) rather than hand-editing the dump.
-- ═══════════════════════════════════════════════════════════════════════
--
-- FND-FIN-001 (P0, financial / data-integrity)
-- ---------------------------------------------------------------------
-- Spec §11.3 requires that posting a source document to the GL be a single
-- atomic operation: one SECURITY DEFINER RPC creates the journal entry AND
-- marks the source record POSTED in one DB transaction, exactly as
-- finance.post_payment_receipt_atomic already does.
--
-- src/app/api/finance/post-income/route.ts, post-expense/route.ts,
-- post-invoice/route.ts and post-vendor-bill/route.ts instead did this as
-- TWO separate PostgREST calls: (1) rpc('post_journal_entry', ...) which
-- commits the journal header+lines, then (2) a plain .update() on the
-- source table (incomes / expenses / invoices / finance.vendor_bills) to
-- set status = 'POSTED' and link journal_entry_id. Those two calls have no
-- transactional link to each other. If the process crashes, the network
-- drops, or the second call otherwise fails between steps 1 and 2, the
-- journal entry is permanently committed while the source row is left
-- status = APPROVED with journal_entry_id = NULL -- a GL entry with no
-- reachable source, and a source record that finance.reverse_income_atomic
-- / finance.reverse_expense_atomic (which both require
-- status = 'POSTED' AND journal_entry_id IS NOT NULL) can never reverse.
--
-- Fix: add one atomic wrapper RPC per module -- post_income_atomic,
-- post_expense_atomic, post_invoice_atomic, post_vendor_bill_atomic --
-- that, in a single PL/pgSQL function (and therefore a single DB
-- transaction), (a) re-validates the source row under FOR UPDATE lock,
-- (b) calls the existing finance.post_journal_entry() to create the
-- journal, and (c) updates the source row to POSTED/linked. If any step
-- raises, Postgres rolls back the whole function call, including the
-- journal insert -- an orphan journal can no longer be created.
--
-- Deliberately NOT changed: the app-side account resolution, budget
-- checking, and WHT/split-line construction in each route (BUG-013/
-- BUG-014/FC-02 etc. fixes already applied there). That logic is read-only
-- and already exercised/tested; duplicating it into SQL would be a much
-- larger, higher-regression-risk change for no additional correctness
-- benefit. Only the final "create journal + mark posted" step -- the part
-- that was actually non-atomic -- moves into the DB.
--
-- FND-ACCT-001 (P0, security / data-integrity / financial)
-- ---------------------------------------------------------------------
-- finance.post_profit_distribution was created (024_ownership_reserves.sql)
-- and later patched for a parameter-order bug (critical_fixes.sql) but,
-- unlike every sibling posting RPC, NEVER had a
-- `REVOKE ALL ... FROM PUBLIC` applied to it. Postgres grants EXECUTE on
-- newly created functions to PUBLIC by default, so this SECURITY DEFINER
-- function has been directly callable via PostgREST by any authenticated
-- user this whole time -- and src/services/tax-equity.service.ts's
-- postProfitDistribution() does exactly that
-- (db.rpc('post_profit_distribution', ...)), bypassing the real, atomic,
-- WHT-aware posting flow entirely.
--
-- The function body itself: looks up the distribution with
-- `WHERE id = p_distribution_id` (no organization_id filter at all), and
-- resolves all three GL accounts with `WHERE code = 'xxxx' LIMIT 1` (no
-- organization_id filter either) -- so a caller in Org A can post a
-- distribution belonging to Org B into whichever organization's chart of
-- accounts Postgres happens to return first. It also never computes
-- withholding tax, never writes an audit log entry, and never checks that
-- the fiscal year/period is still open before posting -- all of which the
-- real /api/finance/profit-distribution route (distribution-wht.service.ts
-- + finance.post_journal_entry) already does correctly today.
--
-- grep across the repo confirms finance.post_profit_distribution has
-- exactly one caller anywhere in the app:
-- src/services/tax-equity.service.ts:435. Nothing else -- not the atomic
-- route, not any other migration -- depends on it being directly
-- callable. It is safe to lock down without touching the working, correct
-- posting path.
--
-- Fix (defense in depth, two layers, matching this codebase's own
-- established pattern e.g. P1_060_rpc_hardening.sql):
--   1. REVOKE EXECUTE FROM PUBLIC (and do not re-grant to `authenticated`)
--      -- this alone closes the direct-RPC bypass, since nothing
--      legitimate calls this function anymore once the frontend fix (in
--      this same change set) routes through /api/finance/profit-distribution
--      instead.
--   2. Harden the function body itself with the same org-scoping and role
--      check every other finance.post_* RPC has, so that even if EXECUTE
--      is ever mistakenly re-granted in the future, it fails closed
--      instead of cross-tenant posting. This does not change its
--      behavior for the (only, now-removed) caller in any functional way
--      -- it only adds guards that a correctly-scoped call already
--      satisfies.
-- ═══════════════════════════════════════════════════════════════════════


-- ─────────────────────────────────────────────────────────────────────
-- 1. finance.post_income_atomic
-- ─────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION "finance"."post_income_atomic"(
  "p_income_id" "uuid",
  "p_period_id" "uuid",
  "p_transaction_date" "date",
  "p_description" "text",
  "p_lines" "jsonb",
  "p_currency" "text" DEFAULT 'PKR'::"text",
  "p_exchange_rate" numeric DEFAULT 1.0000,
  "p_project_id" "uuid" DEFAULT NULL::"uuid"
) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'finance', 'core', 'public'
    AS $$
DECLARE
  v_org uuid := core.current_user_org_id();
  v_income record;
  v_journal_id uuid;
  v_ref text;
BEGIN
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'Access denied: no organization context for caller';
  END IF;

  IF NOT (core.is_finance_head() OR core.has_role('ACCOUNTANT')) THEN
    RAISE EXCEPTION 'Insufficient privileges to post income to the general ledger';
  END IF;

  SELECT * INTO v_income
  FROM public.incomes
  WHERE id = p_income_id AND organization_id = v_org
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Income not found in your organization';
  END IF;

  IF v_income.status <> 'APPROVED' THEN
    RAISE EXCEPTION 'Only APPROVED incomes can be posted. Current: %', v_income.status;
  END IF;

  -- Idempotency guard re-checked under the row lock above, closing the
  -- race between the caller's earlier check and this call.
  IF EXISTS (
    SELECT 1 FROM finance.journal_entries
    WHERE source_type = 'INCOME' AND source_id = p_income_id
  ) THEN
    RAISE EXCEPTION 'Already posted to GL';
  END IF;

  -- Same-transaction journal creation: if post_journal_entry raises for
  -- any reason, the whole function aborts and nothing below runs.
  v_journal_id := finance.post_journal_entry(
    p_description, p_transaction_date, p_period_id, p_lines,
    COALESCE(p_currency, 'PKR'), COALESCE(p_exchange_rate, 1),
    'INCOME', p_income_id, p_project_id, NULL
  );

  UPDATE public.incomes
  SET status = 'POSTED',
      journal_entry_id = v_journal_id,
      posted_at = now()
  WHERE id = p_income_id
    AND organization_id = v_org
    AND status = 'APPROVED';

  IF NOT FOUND THEN
    -- Row changed under us since the lock was taken; abort so the journal
    -- insert above rolls back too instead of leaving an orphan.
    RAISE EXCEPTION 'Income status update failed while posting to GL';
  END IF;

  SELECT reference INTO v_ref FROM finance.journal_entries WHERE id = v_journal_id;

  RETURN jsonb_build_object('journal_id', v_journal_id, 'reference', v_ref);
END;
$$;

ALTER FUNCTION "finance"."post_income_atomic"("p_income_id" "uuid", "p_period_id" "uuid", "p_transaction_date" "date", "p_description" "text", "p_lines" "jsonb", "p_currency" "text", "p_exchange_rate" numeric, "p_project_id" "uuid") OWNER TO "postgres";

COMMENT ON FUNCTION "finance"."post_income_atomic"("p_income_id" "uuid", "p_period_id" "uuid", "p_transaction_date" "date", "p_description" "text", "p_lines" "jsonb", "p_currency" "text", "p_exchange_rate" numeric, "p_project_id" "uuid") IS 'FND-FIN-001 fix: atomic replacement for the previous post_journal_entry-then-separate-UPDATE two-step in src/app/api/finance/post-income/route.ts. Creates the journal via finance.post_journal_entry() and marks the income POSTED in the same DB transaction, so a failure partway through cannot leave an orphaned journal / un-postable income behind.';

REVOKE ALL ON FUNCTION "finance"."post_income_atomic"("p_income_id" "uuid", "p_period_id" "uuid", "p_transaction_date" "date", "p_description" "text", "p_lines" "jsonb", "p_currency" "text", "p_exchange_rate" numeric, "p_project_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "finance"."post_income_atomic"("p_income_id" "uuid", "p_period_id" "uuid", "p_transaction_date" "date", "p_description" "text", "p_lines" "jsonb", "p_currency" "text", "p_exchange_rate" numeric, "p_project_id" "uuid") TO "authenticated";


-- ─────────────────────────────────────────────────────────────────────
-- 2. finance.post_expense_atomic
-- ─────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION "finance"."post_expense_atomic"(
  "p_expense_id" "uuid",
  "p_period_id" "uuid",
  "p_transaction_date" "date",
  "p_description" "text",
  "p_lines" "jsonb",
  "p_currency" "text" DEFAULT 'PKR'::"text",
  "p_exchange_rate" numeric DEFAULT 1.0000,
  "p_project_id" "uuid" DEFAULT NULL::"uuid"
) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'finance', 'core', 'public'
    AS $$
DECLARE
  v_org uuid := core.current_user_org_id();
  v_expense record;
  v_journal_id uuid;
  v_ref text;
BEGIN
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'Access denied: no organization context for caller';
  END IF;

  IF NOT (core.is_finance_head() OR core.has_role('ACCOUNTANT')) THEN
    RAISE EXCEPTION 'Insufficient privileges to post an expense to the general ledger';
  END IF;

  SELECT * INTO v_expense
  FROM public.expenses
  WHERE id = p_expense_id AND organization_id = v_org
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Expense not found in your organization';
  END IF;

  IF v_expense.status <> 'APPROVED' THEN
    RAISE EXCEPTION 'Only APPROVED expenses can be posted. Current: %', v_expense.status;
  END IF;

  IF EXISTS (
    SELECT 1 FROM finance.journal_entries
    WHERE source_type = 'EXPENSE' AND source_id = p_expense_id
  ) THEN
    RAISE EXCEPTION 'Already posted to GL';
  END IF;

  v_journal_id := finance.post_journal_entry(
    p_description, p_transaction_date, p_period_id, p_lines,
    COALESCE(p_currency, 'PKR'), COALESCE(p_exchange_rate, 1),
    'EXPENSE', p_expense_id, p_project_id, NULL
  );

  UPDATE public.expenses
  SET status = 'POSTED',
      journal_entry_id = v_journal_id,
      posted_at = now()
  WHERE id = p_expense_id
    AND organization_id = v_org
    AND status = 'APPROVED';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Expense status update failed while posting to GL';
  END IF;

  SELECT reference INTO v_ref FROM finance.journal_entries WHERE id = v_journal_id;

  RETURN jsonb_build_object('journal_id', v_journal_id, 'reference', v_ref);
END;
$$;

ALTER FUNCTION "finance"."post_expense_atomic"("p_expense_id" "uuid", "p_period_id" "uuid", "p_transaction_date" "date", "p_description" "text", "p_lines" "jsonb", "p_currency" "text", "p_exchange_rate" numeric, "p_project_id" "uuid") OWNER TO "postgres";

COMMENT ON FUNCTION "finance"."post_expense_atomic"("p_expense_id" "uuid", "p_period_id" "uuid", "p_transaction_date" "date", "p_description" "text", "p_lines" "jsonb", "p_currency" "text", "p_exchange_rate" numeric, "p_project_id" "uuid") IS 'FND-FIN-001 fix: atomic replacement for the previous post_journal_entry-then-separate-UPDATE two-step in src/app/api/finance/post-expense/route.ts. Creates the journal via finance.post_journal_entry() and marks the expense POSTED in the same DB transaction.';

REVOKE ALL ON FUNCTION "finance"."post_expense_atomic"("p_expense_id" "uuid", "p_period_id" "uuid", "p_transaction_date" "date", "p_description" "text", "p_lines" "jsonb", "p_currency" "text", "p_exchange_rate" numeric, "p_project_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "finance"."post_expense_atomic"("p_expense_id" "uuid", "p_period_id" "uuid", "p_transaction_date" "date", "p_description" "text", "p_lines" "jsonb", "p_currency" "text", "p_exchange_rate" numeric, "p_project_id" "uuid") TO "authenticated";


-- ─────────────────────────────────────────────────────────────────────
-- 3. finance.post_invoice_atomic
-- ─────────────────────────────────────────────────────────────────────
-- NOTE: public.invoices' status CHECK constraint has no 'POSTED' value and
-- the table has no posted_by/posted_at columns (see the existing comment
-- in post-invoice/route.ts, confirmed against schema.sql) -- so, matching
-- the pre-existing (correct) behavior, this does NOT change invoice
-- status. It only atomically links journal_entry_id + period_id.
CREATE OR REPLACE FUNCTION "finance"."post_invoice_atomic"(
  "p_invoice_id" "uuid",
  "p_period_id" "uuid",
  "p_transaction_date" "date",
  "p_description" "text",
  "p_lines" "jsonb",
  "p_currency" "text" DEFAULT 'PKR'::"text",
  "p_exchange_rate" numeric DEFAULT 1.0000,
  "p_project_id" "uuid" DEFAULT NULL::"uuid"
) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'finance', 'core', 'public'
    AS $$
DECLARE
  v_org uuid := core.current_user_org_id();
  v_invoice record;
  v_journal_id uuid;
  v_ref text;
BEGIN
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'Access denied: no organization context for caller';
  END IF;

  IF NOT (core.is_finance_head() OR core.has_role('ACCOUNTANT')) THEN
    RAISE EXCEPTION 'Insufficient privileges to post an invoice to the general ledger';
  END IF;

  SELECT * INTO v_invoice
  FROM public.invoices
  WHERE id = p_invoice_id AND organization_id = v_org
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invoice not found in your organization';
  END IF;

  IF v_invoice.status NOT IN ('ISSUED', 'APPROVED') THEN
    RAISE EXCEPTION 'Only ISSUED or APPROVED invoices can be posted. Current: %', v_invoice.status;
  END IF;

  IF v_invoice.journal_entry_id IS NOT NULL OR EXISTS (
    SELECT 1 FROM finance.journal_entries
    WHERE source_type = 'INVOICE' AND source_id = p_invoice_id
  ) THEN
    RAISE EXCEPTION 'Already posted to GL';
  END IF;

  v_journal_id := finance.post_journal_entry(
    p_description, p_transaction_date, p_period_id, p_lines,
    COALESCE(p_currency, 'PKR'), COALESCE(p_exchange_rate, 1),
    'INVOICE', p_invoice_id, p_project_id, NULL
  );

  UPDATE public.invoices
  SET journal_entry_id = v_journal_id,
      period_id = p_period_id
  WHERE id = p_invoice_id
    AND organization_id = v_org
    AND journal_entry_id IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invoice could not be linked to its GL journal';
  END IF;

  SELECT reference INTO v_ref FROM finance.journal_entries WHERE id = v_journal_id;

  RETURN jsonb_build_object('journal_id', v_journal_id, 'reference', v_ref);
END;
$$;

ALTER FUNCTION "finance"."post_invoice_atomic"("p_invoice_id" "uuid", "p_period_id" "uuid", "p_transaction_date" "date", "p_description" "text", "p_lines" "jsonb", "p_currency" "text", "p_exchange_rate" numeric, "p_project_id" "uuid") OWNER TO "postgres";

COMMENT ON FUNCTION "finance"."post_invoice_atomic"("p_invoice_id" "uuid", "p_period_id" "uuid", "p_transaction_date" "date", "p_description" "text", "p_lines" "jsonb", "p_currency" "text", "p_exchange_rate" numeric, "p_project_id" "uuid") IS 'FND-FIN-001 fix: atomic replacement for the previous post_journal_entry-then-separate-UPDATE two-step in src/app/api/finance/post-invoice/route.ts. Creates the journal via finance.post_journal_entry() and links journal_entry_id/period_id on the invoice in the same DB transaction.';

REVOKE ALL ON FUNCTION "finance"."post_invoice_atomic"("p_invoice_id" "uuid", "p_period_id" "uuid", "p_transaction_date" "date", "p_description" "text", "p_lines" "jsonb", "p_currency" "text", "p_exchange_rate" numeric, "p_project_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "finance"."post_invoice_atomic"("p_invoice_id" "uuid", "p_period_id" "uuid", "p_transaction_date" "date", "p_description" "text", "p_lines" "jsonb", "p_currency" "text", "p_exchange_rate" numeric, "p_project_id" "uuid") TO "authenticated";


-- ─────────────────────────────────────────────────────────────────────
-- 4. finance.post_vendor_bill_atomic
-- ─────────────────────────────────────────────────────────────────────
-- NOTE: finance.vendor_bills has posted_by/posted_at columns but no
-- journal_entry_id column (confirmed against schema.sql) -- the link to
-- the journal remains via journal_entries.source_type='VENDOR_BILL' /
-- source_id=<bill id>, matching the pre-existing behavior.
CREATE OR REPLACE FUNCTION "finance"."post_vendor_bill_atomic"(
  "p_bill_id" "uuid",
  "p_period_id" "uuid",
  "p_transaction_date" "date",
  "p_description" "text",
  "p_lines" "jsonb",
  "p_currency" "text" DEFAULT 'PKR'::"text",
  "p_exchange_rate" numeric DEFAULT 1.0000,
  "p_project_id" "uuid" DEFAULT NULL::"uuid"
) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'finance', 'core', 'public'
    AS $$
DECLARE
  v_org uuid := core.current_user_org_id();
  v_bill record;
  v_journal_id uuid;
  v_ref text;
BEGIN
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'Access denied: no organization context for caller';
  END IF;

  IF NOT (core.is_finance_head() OR core.has_role('ACCOUNTANT')) THEN
    RAISE EXCEPTION 'Insufficient privileges to post a vendor bill to the general ledger';
  END IF;

  SELECT * INTO v_bill
  FROM finance.vendor_bills
  WHERE id = p_bill_id AND organization_id = v_org
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Vendor bill not found in your organization';
  END IF;

  IF v_bill.status <> 'APPROVED' THEN
    RAISE EXCEPTION 'Only APPROVED vendor bills can be posted. Current: %', v_bill.status;
  END IF;

  IF EXISTS (
    SELECT 1 FROM finance.journal_entries
    WHERE source_type = 'VENDOR_BILL' AND source_id = p_bill_id
  ) THEN
    RAISE EXCEPTION 'Already posted to GL';
  END IF;

  v_journal_id := finance.post_journal_entry(
    p_description, p_transaction_date, p_period_id, p_lines,
    COALESCE(p_currency, 'PKR'), COALESCE(p_exchange_rate, 1),
    'VENDOR_BILL', p_bill_id, p_project_id, NULL
  );

  UPDATE finance.vendor_bills
  SET status = 'POSTED',
      posted_by = auth.uid(),
      posted_at = now()
  WHERE id = p_bill_id
    AND organization_id = v_org
    AND status = 'APPROVED';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Vendor bill status update failed while posting to GL';
  END IF;

  SELECT reference INTO v_ref FROM finance.journal_entries WHERE id = v_journal_id;

  RETURN jsonb_build_object('journal_id', v_journal_id, 'reference', v_ref);
END;
$$;

ALTER FUNCTION "finance"."post_vendor_bill_atomic"("p_bill_id" "uuid", "p_period_id" "uuid", "p_transaction_date" "date", "p_description" "text", "p_lines" "jsonb", "p_currency" "text", "p_exchange_rate" numeric, "p_project_id" "uuid") OWNER TO "postgres";

COMMENT ON FUNCTION "finance"."post_vendor_bill_atomic"("p_bill_id" "uuid", "p_period_id" "uuid", "p_transaction_date" "date", "p_description" "text", "p_lines" "jsonb", "p_currency" "text", "p_exchange_rate" numeric, "p_project_id" "uuid") IS 'FND-FIN-001 fix: atomic replacement for the previous post_journal_entry-then-separate-UPDATE two-step in src/app/api/finance/post-vendor-bill/route.ts. Creates the journal via finance.post_journal_entry() and marks the vendor bill POSTED in the same DB transaction.';

REVOKE ALL ON FUNCTION "finance"."post_vendor_bill_atomic"("p_bill_id" "uuid", "p_period_id" "uuid", "p_transaction_date" "date", "p_description" "text", "p_lines" "jsonb", "p_currency" "text", "p_exchange_rate" numeric, "p_project_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "finance"."post_vendor_bill_atomic"("p_bill_id" "uuid", "p_period_id" "uuid", "p_transaction_date" "date", "p_description" "text", "p_lines" "jsonb", "p_currency" "text", "p_exchange_rate" numeric, "p_project_id" "uuid") TO "authenticated";


-- ═══════════════════════════════════════════════════════════════════════
-- 5. FND-ACCT-001: lock down finance.post_profit_distribution
-- ═══════════════════════════════════════════════════════════════════════
-- Harden the function body (org check, role check, org-scoped account
-- lookups -- defense in depth in case EXECUTE is ever re-granted) and,
-- critically, REVOKE EXECUTE FROM PUBLIC so it can no longer be invoked
-- directly via PostgREST at all. The correct posting path
-- (/api/finance/profit-distribution -> distribution-wht.service.ts ->
-- finance.post_journal_entry) is unaffected -- it never called this
-- function.
CREATE OR REPLACE FUNCTION "finance"."post_profit_distribution"("p_distribution_id" "uuid", "p_period_id" "uuid", "p_transaction_date" "date") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'finance', 'core', 'public'
    AS $$
DECLARE
    v_org uuid := core.current_user_org_id();
    v_dist RECORD; v_lines JSONB := '[]'::JSONB;
    v_pnl UUID; v_reserve UUID; v_payable UUID;
    v_period_org uuid;
BEGIN
    -- FND-ACCT-001 FIX: this function was never locked down like its
    -- sibling posting RPCs (no REVOKE ... FROM PUBLIC anywhere in the
    -- schema), so it was directly callable via PostgREST by any
    -- authenticated user with none of the checks below. It is now also
    -- revoked from PUBLIC at the grant level (below); these in-function
    -- checks are defense in depth so it fails closed even if EXECUTE is
    -- ever mistakenly re-granted in the future.
    IF v_org IS NULL THEN
        RAISE EXCEPTION 'Access denied: no organization context for caller';
    END IF;

    IF NOT (core.is_finance_head() OR core.has_role('ACCOUNTANT')) THEN
        RAISE EXCEPTION 'Insufficient privileges to post a profit distribution to the general ledger';
    END IF;

    -- FND-ACCT-001 FIX: previously `WHERE id = p_distribution_id` with no
    -- organization filter -- a caller in any organization could post any
    -- other organization's distribution. Now scoped + row-locked.
    SELECT * INTO v_dist
    FROM finance.profit_distributions
    WHERE id = p_distribution_id AND organization_id = v_org
    FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Distribution not found in your organization'; END IF;
    IF v_dist.status != 'APPROVED' THEN RAISE EXCEPTION 'Must be APPROVED'; END IF;

    SELECT organization_id INTO v_period_org FROM finance.accounting_periods WHERE id = p_period_id;
    IF v_period_org IS NULL OR v_period_org <> v_org THEN
        RAISE EXCEPTION 'Access denied: accounting period % does not belong to your organization', p_period_id;
    END IF;

    IF EXISTS (
      SELECT 1 FROM finance.journal_entries
      WHERE source_type = 'PROFIT_DISTRIBUTION' AND source_id = p_distribution_id
    ) THEN
      RAISE EXCEPTION 'Already posted to GL';
    END IF;

    -- FND-ACCT-001 FIX: previously `WHERE code = 'xxxx' LIMIT 1` with no
    -- organization filter on all three lookups -- could resolve to
    -- another organization's chart of accounts.
    SELECT id INTO v_pnl FROM finance.chart_of_accounts WHERE code = '3400' AND organization_id = v_org LIMIT 1;
    SELECT id INTO v_reserve FROM finance.chart_of_accounts WHERE code = '3310' AND organization_id = v_org LIMIT 1;
    SELECT id INTO v_payable FROM finance.chart_of_accounts WHERE code = '2410' AND organization_id = v_org LIMIT 1;

    IF v_pnl IS NULL THEN RAISE EXCEPTION 'Retained earnings account 3400 not found in your organization'; END IF;

    v_lines := v_lines || jsonb_build_object('account_id', v_pnl, 'debit_amount', v_dist.total_available_profit, 'credit_amount', 0, 'description', 'Close P&L & Transfer to Reserves/Distributions');

    IF v_dist.reserve_amount > 0 THEN
        IF v_reserve IS NULL THEN RAISE EXCEPTION 'Reserve account 3310 not found in your organization'; END IF;
        v_lines := v_lines || jsonb_build_object('account_id', v_reserve, 'debit_amount', 0, 'credit_amount', v_dist.reserve_amount, 'description', 'Transfer to Reserves');
    END IF;

    IF v_dist.distributable_amount > 0 THEN
        IF v_payable IS NULL THEN RAISE EXCEPTION 'Distribution payable account 2410 not found in your organization'; END IF;
        v_lines := v_lines || jsonb_build_object('account_id', v_payable, 'debit_amount', 0, 'credit_amount', v_dist.distributable_amount, 'description', 'Profit Distribution Payable');
    END IF;

    RETURN finance.post_journal_entry('Profit Distribution', p_transaction_date, p_period_id, v_lines, 'PKR', 1.0, 'PROFIT_DISTRIBUTION', p_distribution_id, NULL, NULL);
END;
$$;

ALTER FUNCTION "finance"."post_profit_distribution"("p_distribution_id" "uuid", "p_period_id" "uuid", "p_transaction_date" "date") OWNER TO "postgres";

COMMENT ON FUNCTION "finance"."post_profit_distribution"("p_distribution_id" "uuid", "p_period_id" "uuid", "p_transaction_date" "date") IS 'FND-ACCT-001 FIX: added org-scoping (distribution lookup + all three chart-of-accounts lookups + period ownership) and the role check every sibling post_* RPC already has. Also REVOKEd from PUBLIC (see grants below) -- this function has no legitimate direct caller; it was never routed through by the real posting flow at /api/finance/profit-distribution, which computes WHT via distribution-wht.service.ts and posts via finance.post_journal_entry directly. The only previous caller, src/services/tax-equity.service.ts postProfitDistribution(), has been changed in this same fix to call that atomic, WHT-aware, audited route instead.';

REVOKE ALL ON FUNCTION "finance"."post_profit_distribution"("p_distribution_id" "uuid", "p_period_id" "uuid", "p_transaction_date" "date") FROM PUBLIC;