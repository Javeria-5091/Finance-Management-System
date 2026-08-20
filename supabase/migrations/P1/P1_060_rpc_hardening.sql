-- =============================================================================
-- Migration P1_060: Posting-Engine Hardening (Remediation ISS-02 / ISS-09)
-- =============================================================================
-- PURPOSE
--   ISS-02 (CRITICAL): finance.post_journal_entry, finance.post_invoice_ar,
--   finance.post_vendor_bill, finance.approve_and_post_journal_entry are all
--   SECURITY DEFINER and (with the exception of approve_and_post_journal_entry,
--   which already has a role check) contain NO internal role/organization
--   check. They are directly callable by any authenticated Supabase user via
--   the standard PostgREST RPC endpoint (confirmed: schema.sql grants EXECUTE
--   to "authenticated" by default on all four). They are "safe" today only
--   because every calling Next.js API route happens to gate access first --
--   but nothing in the database itself stops a client from calling
--   finance.post_journal_entry directly, bypassing every application-layer
--   permission/MFA/org check, and force-posting to any organization's ledger.
--
--   ISS-09 (MEDIUM): finance.enforce_maker_checker() only fires for
--   expenses/incomes/invoices/vendor_bills/journal_entries -- it is not wired
--   to finance.bank_transfers or finance.profit_distributions, both of which
--   the specification (5.8, 5.13) explicitly requires dual/maker-checker
--   approval for.
--
-- WHY NOT "REVOKE EXECUTE ... FROM authenticated; GRANT ... TO service_role"
--   This was considered (and is the audit's suggested primary option) but
--   does NOT match how this codebase actually calls these functions: every
--   API route uses getAuthSupabase(), which builds a Supabase client from the
--   INCOMING USER'S OWN SESSION COOKIE (see src/lib/api-auth.ts,
--   createServerClient with the anon key + user cookies) -- not a
--   service-role client. RPC calls from these routes execute in Postgres AS
--   the calling user, under the "authenticated" role, with auth.uid() set to
--   that user. Revoking EXECUTE from "authenticated" would break every
--   legitimate posting route in the application, not just direct/malicious
--   RPC calls. The correct fix for this codebase's architecture is
--   defense-in-depth: keep EXECUTE granted to authenticated (as already
--   required for the app to function), and add an in-function authorization
--   check so a direct/bypassing RPC call is rejected the same way the app
--   layer would reject it.
--
-- WHY A SINGLE HARD-CODED PERMISSION CODE INSIDE post_journal_entry IS WRONG
--   finance.post_journal_entry is called by more than ten different API
--   routes, gated by different permission codes depending on business
--   context: post-invoice (APPROVE_INVOICE), post-vendor-bill/post-expense
--   (APPROVE_EXPENSE), post-journal (APPROVE_JOURNAL),
--   opening-balance (JOURNAL_CREATE), post-income (APPROVE_INCOME),
--   profit-distribution (EQUITY_MANAGE), year-end-close (PERIOD_CLOSE),
--   credit-notes/payment-reversals/payment-receipts (APPROVE_INVOICE).
--   Hard-coding any ONE of those permission codes inside post_journal_entry
--   would silently break every other legitimate caller. The safe,
--   already-established alternative (used by approve_and_post_journal_entry
--   itself, and matching spec Appendix A's role table -- posting to the
--   ledger is an accounting-engine operation, and only CEO/Finance
--   Head/Accountant ever have "Full"/"Config" rights on journals, invoices,
--   bills, or equity per Appendix A) is a ROLE-level check:
--     core.is_finance_head() OR core.has_role('ACCOUNTANT')
--   This is strictly a defense-in-depth backstop underneath the
--   application's own finer-grained permission checks -- it does not replace
--   them, and does not change what any legitimate existing caller can do,
--   because every one of the API routes above already requires the caller to
--   hold Finance-Head-or-above-equivalent rights for its own specific
--   permission code.
--
-- ORGANIZATION SCOPING
--   Each function is also updated to verify that the specific record being
--   posted (period, invoice, bill, journal) belongs to the caller's own
--   organization via core.same_org(), independently of what the caller
--   claims -- closing the direct-RPC cross-organization posting vector
--   described in ISS-02.
--
-- SAFETY
--   - CREATE OR REPLACE FUNCTION only; no signature changes, so every
--     existing call site (which already exists and already works) continues
--     to compile and run unmodified.
--   - No data is altered. No behavior changes for any caller that was already
--     legitimately authorized -- these callers already hold
--     Finance-Head/Accountant-or-above rights per the application-layer
--     permission codes listed above, and already only ever act within their
--     own organization's records (spot-checked: post-invoice/route.ts fetches
--     the invoice with `.eq('organization_id', orgId)` before calling the
--     RPC). The new checks reject ONLY requests that the application itself
--     would already have rejected, plus any request that bypasses the
--     application entirely.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- STEP 1: finance.post_journal_entry — add role + period-organization check
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION "finance"."post_journal_entry"(
  "p_description" "text",
  "p_transaction_date" "date",
  "p_period_id" "uuid",
  "p_lines" "jsonb",
  "p_currency" "text" DEFAULT 'PKR'::"text",
  "p_exchange_rate" numeric DEFAULT 1.0000,
  "p_source_type" "text" DEFAULT 'MANUAL'::"text",
  "p_source_id" "uuid" DEFAULT NULL::"uuid",
  "p_project_id" "uuid" DEFAULT NULL::"uuid",
  "p_department_id" "uuid" DEFAULT NULL::"uuid"
) RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'finance', 'core', 'public'
    AS $$
DECLARE
  v_journal_id UUID;
  v_ref TEXT;
  v_fiscal_year_id UUID;
  v_period_org_id UUID;
  v_total_dr NUMERIC(18,2) := 0;
  v_total_cr NUMERIC(18,2) := 0;
  v_line_num INTEGER := 0;
  v_line JSONB;
  v_is_manual BOOLEAN;
BEGIN
  -- ─── P1_060 SECURITY FIX (ISS-02, Critical): in-function authorization ───
  -- Defense-in-depth backstop matching approve_and_post_journal_entry's own
  -- existing check. See migration header for why this is a role check and
  -- not a single hard-coded permission code.
  IF NOT (core.is_finance_head() OR core.has_role('ACCOUNTANT')) THEN
    RAISE EXCEPTION 'Insufficient privileges to post journal entries. Requires Finance Head, CEO, or Accountant.';
  END IF;

  v_is_manual := (COALESCE(p_source_type, 'MANUAL') = 'MANUAL');

  -- 1. Get Fiscal Year + organization from Period, and verify the period
  --    belongs to the caller's own organization (P1_060 SECURITY FIX).
  SELECT fiscal_year_id, organization_id INTO v_fiscal_year_id, v_period_org_id
  FROM finance.accounting_periods WHERE id = p_period_id;

  IF v_fiscal_year_id IS NULL THEN
    RAISE EXCEPTION 'Invalid period_id: %', p_period_id;
  END IF;

  IF NOT core.same_org(v_period_org_id) THEN
    RAISE EXCEPTION 'Access denied: accounting period % does not belong to your organization', p_period_id;
  END IF;

  -- 2. Validate & Calculate Totals.
  --    This early check is kept for a fast, friendly error message before
  --    we build any rows. finance.check_journal_balance() (attached as a
  --    deferred constraint trigger in migration 028) remains the actual
  --    authoritative, unbypassable enforcement at COMMIT time.
  IF jsonb_array_length(p_lines) < 2 THEN
    RAISE EXCEPTION 'Journal must have at least 2 lines';
  END IF;

  FOR v_line IN SELECT * FROM jsonb_array_elements(p_lines) LOOP
    v_total_dr := v_total_dr + COALESCE((v_line->>'debit_amount')::NUMERIC(18,2), 0);
    v_total_cr := v_total_cr + COALESCE((v_line->>'credit_amount')::NUMERIC(18,2), 0);
  END LOOP;

  IF ABS(v_total_dr - v_total_cr) > 0.01 THEN
    RAISE EXCEPTION 'Journal unbalanced: DR=% CR=%', v_total_dr, v_total_cr;
  END IF;

  -- 3. Get Reference (P1_059 already dropped the unscoped 1-arg overload, so
  --    this now unambiguously resolves to the org-scoped version, defaulting
  --    p_organization_id to core.current_user_org_id()).
  v_ref := finance.get_next_number('JOURNAL_ENTRY');

  -- 4. Insert Header.
  --    System-sourced (non-MANUAL) postings: already approved via their own
  --    module workflow -> insert directly as POSTED, approved_by left NULL
  --    (no separate journal-level approver; see header comment).
  --    Manual postings: insert as DRAFT, only created_by set. Must be
  --    completed via finance.approve_and_post_journal_entry() below.
  IF v_is_manual THEN
    INSERT INTO finance.journal_entries (
      reference, description, status, transaction_date,
      period_id, fiscal_year_id, currency, exchange_rate, base_currency,
      total_debit, total_credit, source_type, source_id, project_id, department_id,
      created_by, organization_id
    ) VALUES (
      v_ref, p_description, 'DRAFT', p_transaction_date,
      p_period_id, v_fiscal_year_id, p_currency, p_exchange_rate, 'PKR',
      v_total_dr, v_total_cr, p_source_type, p_source_id, p_project_id, p_department_id,
      auth.uid(), v_period_org_id
    ) RETURNING id INTO v_journal_id;
  ELSE
    INSERT INTO finance.journal_entries (
      reference, description, status, transaction_date, posting_date,
      period_id, fiscal_year_id, currency, exchange_rate, base_currency,
      total_debit, total_credit, source_type, source_id, project_id, department_id,
      created_by, posted_by, posted_at, organization_id
    ) VALUES (
      v_ref, p_description, 'POSTED', p_transaction_date, CURRENT_DATE,
      p_period_id, v_fiscal_year_id, p_currency, p_exchange_rate, 'PKR',
      v_total_dr, v_total_cr, p_source_type, p_source_id, p_project_id, p_department_id,
      auth.uid(), auth.uid(), NOW(), v_period_org_id
    ) RETURNING id INTO v_journal_id;
  END IF;

  -- 5. Insert Lines (unchanged)
  FOR v_line IN SELECT * FROM jsonb_array_elements(p_lines) LOOP
    v_line_num := v_line_num + 1;

    INSERT INTO finance.journal_lines (
      journal_entry_id, line_number, account_id, description,
      debit_amount, credit_amount, currency, exchange_rate,
      base_debit, base_credit, project_id, department_id, created_by
    ) VALUES (
      v_journal_id, v_line_num,
      (v_line->>'account_id')::UUID,
      v_line->>'description',
      COALESCE((v_line->>'debit_amount')::NUMERIC(18,2), 0),
      COALESCE((v_line->>'credit_amount')::NUMERIC(18,2), 0),
      p_currency, p_exchange_rate,
      COALESCE((v_line->>'debit_amount')::NUMERIC(18,2), 0) * p_exchange_rate,
      COALESCE((v_line->>'credit_amount')::NUMERIC(18,2), 0) * p_exchange_rate,
      COALESCE((v_line->>'project_id')::UUID, p_project_id),
      p_department_id, auth.uid()
    );
  END LOOP;

  RETURN v_journal_id;
END;
$$;

COMMENT ON FUNCTION "finance"."post_journal_entry"("p_description" "text", "p_transaction_date" "date", "p_period_id" "uuid", "p_lines" "jsonb", "p_currency" "text", "p_exchange_rate" numeric, "p_source_type" "text", "p_source_id" "uuid", "p_project_id" "uuid", "p_department_id" "uuid") IS
  'P1_060 SECURITY FIX (ISS-02, Critical): added in-function role check (Finance Head/CEO/Accountant) and organization-match check against p_period_id, so this SECURITY DEFINER function can no longer be used to post to another organization''s ledger or bypass authorization via a direct PostgREST RPC call. Also now populates journal_entries.organization_id (previously relied on the caller/trigger; explicit here for defense-in-depth). Previously fixed in migration 029 (MANUAL journals insert as DRAFT, not self-approved).';

-- -----------------------------------------------------------------------------
-- STEP 2 (ISS-08 follow-through, idempotent): P1_059 already drops the
-- unscoped 1-arg finance.get_next_number(text) overload. This is repeated
-- here, defensively and idempotently (IF EXISTS), only so that P1_060 does
-- not depend on migration ordering -- applying P1_060 alone, or re-running it
-- after P1_059, is always safe and has the same end state either way.
-- -----------------------------------------------------------------------------

DROP FUNCTION IF EXISTS finance.get_next_number(text);

-- -----------------------------------------------------------------------------
-- STEP 3: finance.post_invoice_ar — add role + invoice-organization check
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION "finance"."post_invoice_ar"("p_invoice_id" "uuid", "p_period_id" "uuid", "p_transaction_date" "date") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'finance', 'core', 'public'
    AS $$
DECLARE
    v_inv RECORD;
    v_fy_id UUID;
    v_lines JSONB := '[]'::JSONB;
    v_dr_account UUID;
    v_rev_account UUID;
    v_tax_account UUID;
BEGIN
    -- ─── P1_060 SECURITY FIX (ISS-02, Critical) ───
    IF NOT (core.is_finance_head() OR core.has_role('ACCOUNTANT')) THEN
        RAISE EXCEPTION 'Insufficient privileges to post an invoice to the general ledger. Requires Finance Head, CEO, or Accountant.';
    END IF;

    SELECT * INTO v_inv FROM public.invoices WHERE id = p_invoice_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Invoice not found'; END IF;

    -- P1_060 SECURITY FIX: verify the invoice belongs to the caller's own
    -- organization before posting anything to the ledger on its behalf.
    IF NOT core.same_org(v_inv.organization_id) THEN
        RAISE EXCEPTION 'Access denied: invoice % does not belong to your organization', p_invoice_id;
    END IF;

    SELECT fiscal_year_id INTO v_fy_id FROM finance.accounting_periods WHERE id = p_period_id;
    IF v_fy_id IS NULL THEN RAISE EXCEPTION 'Invalid period'; END IF;

    SELECT id INTO v_dr_account FROM finance.chart_of_accounts WHERE code = '1210' LIMIT 1;
    SELECT id INTO v_rev_account FROM finance.chart_of_accounts WHERE code = '4110' LIMIT 1;
    SELECT id INTO v_tax_account FROM finance.chart_of_accounts WHERE code = '2210' LIMIT 1;

    IF v_dr_account IS NULL THEN RAISE EXCEPTION 'AR account 1210 not found'; END IF;
    IF v_rev_account IS NULL THEN RAISE EXCEPTION 'Revenue account 4110 not found'; END IF;

    -- Line 1: Debit AR (full invoice amount)
    v_lines := jsonb_build_object(
        'account_id', v_dr_account,
        'debit_amount', v_inv.base_total_amount,
        'credit_amount', 0,
        'description', 'AR: ' || COALESCE(v_inv.invoice_number, 'N/A') || ' - ' || COALESCE(v_inv.client_name, '')
    );

    -- Line 2: Credit Revenue (Total - Tax)
    IF v_inv.base_total_amount - COALESCE(v_inv.base_tax_amount, 0) > 0 THEN
        v_lines := v_lines || jsonb_build_object(
            'account_id', v_rev_account,
            'debit_amount', 0,
            'credit_amount', v_inv.base_total_amount - COALESCE(v_inv.base_tax_amount, 0),
            'description', 'Revenue: ' || COALESCE(v_inv.invoice_number, 'N/A')
        );
    END IF;

    -- Line 3: Credit Tax Payable
    IF COALESCE(v_inv.base_tax_amount, 0) > 0 AND v_tax_account IS NOT NULL THEN
        v_lines := v_lines || jsonb_build_object(
            'account_id', v_tax_account,
            'debit_amount', 0,
            'credit_amount', v_inv.base_tax_amount,
            'description', 'Tax on Inv: ' || COALESCE(v_inv.invoice_number, 'N/A')
        );
    END IF;

    -- CORRECT PARAMETER ORDER: p_lines is 4th parameter
    RETURN finance.post_journal_entry(
        'AR Invoice: ' || COALESCE(v_inv.invoice_number, v_inv.id::text),
        p_transaction_date,
        p_period_id,
        v_lines,                    --  p_lines = 4th position
        'PKR', 1.0000,              -- p_currency, p_exchange_rate
        'INVOICE', p_invoice_id,     -- p_source_type, p_source_id
        v_inv.project_id,            -- p_project_id
        NULL                        -- p_department_id
    );
END;
$$;

COMMENT ON FUNCTION "finance"."post_invoice_ar"("p_invoice_id" "uuid", "p_period_id" "uuid", "p_transaction_date" "date") IS
  'P1_060 SECURITY FIX (ISS-02, Critical): added in-function role check (Finance Head/CEO/Accountant) and organization-match check against the invoice being posted. Previously contained only existence checks (IF NOT FOUND), no authorization of any kind.';

-- -----------------------------------------------------------------------------
-- STEP 4: finance.post_vendor_bill — add role + bill-organization check
-- -----------------------------------------------------------------------------

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
    -- ─── P1_060 SECURITY FIX (ISS-02, Critical) ───
    IF NOT (core.is_finance_head() OR core.has_role('ACCOUNTANT')) THEN
        RAISE EXCEPTION 'Insufficient privileges to post a vendor bill to the general ledger. Requires Finance Head, CEO, or Accountant.';
    END IF;

    SELECT * INTO v_bill FROM finance.vendor_bills WHERE id = p_bill_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Bill not found'; END IF;

    -- P1_060 SECURITY FIX: verify the bill belongs to the caller's own organization.
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

    --  CORRECT PARAMETER ORDER
    RETURN finance.post_journal_entry(
        'AP Bill: ' || v_bill.bill_number,
        p_transaction_date, p_period_id,
        v_lines,
        'PKR', 1.0000,
        'VENDOR_BILL', p_bill_id,
        v_bill.project_id, NULL
    );
END;
$$;

COMMENT ON FUNCTION "finance"."post_vendor_bill"("p_bill_id" "uuid", "p_period_id" "uuid", "p_transaction_date" "date") IS
  'P1_060 SECURITY FIX (ISS-02, Critical): added in-function role check (Finance Head/CEO/Accountant) and organization-match check against the vendor bill being posted. Previously contained no authorization of any kind.';

-- -----------------------------------------------------------------------------
-- STEP 5: finance.approve_and_post_journal_entry — already had a role check;
-- add the missing organization-match check for defense-in-depth consistency
-- with the other three posting functions.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION "finance"."approve_and_post_journal_entry"("p_journal_id" "uuid") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'finance', 'core', 'public'
    AS $$
DECLARE
  v_status TEXT;
  v_source_type TEXT;
  v_org_id UUID;
BEGIN
  IF NOT (core.is_finance_head() OR core.has_role('ACCOUNTANT')) THEN
    RAISE EXCEPTION 'Only Finance Head or Accountant may approve and post a journal entry';
  END IF;

  SELECT status, source_type, organization_id INTO v_status, v_source_type, v_org_id
  FROM finance.journal_entries WHERE id = p_journal_id FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Journal entry % not found', p_journal_id;
  END IF;

  -- P1_060 SECURITY FIX (ISS-02, Critical): verify the journal entry belongs
  -- to the caller's own organization before approving/posting it.
  IF NOT core.same_org(v_org_id) THEN
    RAISE EXCEPTION 'Access denied: journal entry % does not belong to your organization', p_journal_id;
  END IF;

  IF v_status <> 'DRAFT' THEN
    RAISE EXCEPTION 'Journal entry % is not in DRAFT status (current: %)', p_journal_id, v_status;
  END IF;

  IF COALESCE(v_source_type, 'MANUAL') <> 'MANUAL' THEN
    RAISE EXCEPTION 'System-sourced journal entries post automatically and cannot be approved through this function';
  END IF;

  -- The trg_maker_checker + trg_prevent_closed_period_posting triggers on
  -- finance.journal_entries, and trg_check_journal_balance on
  -- finance.journal_lines, all fire on this UPDATE and enforce their rules.
  UPDATE finance.journal_entries
  SET status = 'POSTED',
      submitted_by = COALESCE(submitted_by, auth.uid()),
      submitted_at = COALESCE(submitted_at, NOW()),
      verified_by = COALESCE(verified_by, auth.uid()),
      verified_at = COALESCE(verified_at, NOW()),
      approved_by = auth.uid(),
      approved_at = NOW(),
      posted_by = auth.uid(),
      posted_at = NOW(),
      posting_date = CURRENT_DATE
  WHERE id = p_journal_id;

  RETURN p_journal_id;
END;
$$;

COMMENT ON FUNCTION "finance"."approve_and_post_journal_entry"("p_journal_id" "uuid") IS
  'P1_060 SECURITY FIX (ISS-02, Critical): added organization-match check (this function already had the correct Finance Head/Accountant role check from migration 029; only the organization-scoping was missing). Completes the maker-checker approval + posting step for a MANUAL journal left in DRAFT by finance.post_journal_entry(). Enforces creator <> approver via trg_maker_checker.';

-- -----------------------------------------------------------------------------
-- STEP 6 (ISS-09): extend finance.enforce_maker_checker() to cover
-- bank_transfers and profit_distributions, and attach the trigger.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION "finance"."enforce_maker_checker"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'finance', 'public'
    AS $$
DECLARE
  v_creator_id UUID;
  v_approver_id UUID;
  v_second_approver_id UUID;
  v_table TEXT;
  v_schema TEXT;
BEGIN
  v_table := TG_TABLE_NAME;
  v_schema := TG_TABLE_SCHEMA;

  -- Get creator and approver IDs based on table
  -- public.expenses, public.incomes, public.invoices use `user_id` as creator
  -- finance.vendor_bills, finance.journal_entries use `created_by` as creator
  -- P1_060 (ISS-09, Medium): finance.bank_transfers and
  -- finance.profit_distributions added -- both are spec-flagged (5.8, 5.13)
  -- as requiring dual/maker-checker approval and were previously not wired
  -- to this trigger at all.
  IF v_table IN ('expenses', 'incomes', 'invoices') THEN
    v_creator_id := COALESCE(OLD.user_id, NEW.user_id);
    v_approver_id := NEW.approved_by;
  ELSIF v_table IN ('vendor_bills', 'journal_entries') THEN
    v_creator_id := COALESCE(OLD.created_by, NEW.created_by);
    v_approver_id := NEW.approved_by;
  ELSIF v_table = 'bank_transfers' THEN
    v_creator_id := COALESCE(OLD.created_by, NEW.created_by);
    v_approver_id := NEW.approved_by;
    v_second_approver_id := NEW.second_approved_by;
  ELSIF v_table = 'profit_distributions' THEN
    v_creator_id := COALESCE(OLD.declared_by, NEW.declared_by);
    v_approver_id := NEW.approved_by;
  ELSE
    RETURN NEW;
  END IF;

  -- Enforce: creator cannot be the approver
  IF v_approver_id IS NOT NULL AND v_creator_id IS NOT NULL AND v_approver_id = v_creator_id THEN
    RAISE EXCEPTION 'MAKER_CHECKER_VIOLATION: Creator (user %) cannot approve their own record in %',
      v_creator_id, v_table;
  END IF;

  -- P1_060 (ISS-09): bank_transfers additionally supports a documented
  -- second/dual approver (second_approved_by). Enforce that the second
  -- approver is distinct from both the creator and the first approver, so
  -- "dual approval" cannot be satisfied by the same person twice.
  IF v_table = 'bank_transfers' AND v_second_approver_id IS NOT NULL THEN
    IF v_creator_id IS NOT NULL AND v_second_approver_id = v_creator_id THEN
      RAISE EXCEPTION 'MAKER_CHECKER_VIOLATION: Creator (user %) cannot be the second approver on a bank transfer', v_creator_id;
    END IF;
    IF v_approver_id IS NOT NULL AND v_second_approver_id = v_approver_id THEN
      RAISE EXCEPTION 'MAKER_CHECKER_VIOLATION: The first and second approver on a bank transfer must be different users (user %)', v_approver_id;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION "finance"."enforce_maker_checker"() IS
  'P1_060 SECURITY FIX (ISS-09, Medium): extended to cover finance.bank_transfers (including dual/second-approver distinctness) and finance.profit_distributions, both spec-flagged (5.8, 5.13) as requiring maker-checker/dual approval and previously not wired to this trigger at all. Original expenses/incomes/invoices/vendor_bills/journal_entries behavior is unchanged.';

DROP TRIGGER IF EXISTS "trg_maker_checker" ON "finance"."bank_transfers";
CREATE TRIGGER "trg_maker_checker" BEFORE INSERT OR UPDATE ON "finance"."bank_transfers"
  FOR EACH ROW EXECUTE FUNCTION "finance"."enforce_maker_checker"();

DROP TRIGGER IF EXISTS "trg_maker_checker" ON "finance"."profit_distributions";
CREATE TRIGGER "trg_maker_checker" BEFORE INSERT OR UPDATE ON "finance"."profit_distributions"
  FOR EACH ROW EXECUTE FUNCTION "finance"."enforce_maker_checker"();

-- =============================================================================
-- END P1_060
-- =============================================================================