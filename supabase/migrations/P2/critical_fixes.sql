-- =====================================================================
-- OSYSTIC Finance Management System — Critical Audit Fixes
-- Run this single script directly against your live Supabase database
-- (SQL Editor, or `psql`/`supabase db execute`).
--
-- Covers, from the pre-submission audit report:
--   C-01  JSONB array/object merge bug (7 posting functions)
--   C-02  post_profit_distribution wrong parameter order
--         + identical bug in post_distribution_payment (bonus find)
--   C-04  Missing finance.post_payment_receipt_atomic() RPC
--   C-05  post_vendor_payment unbalanced journal when WHT > 0
--   C-07  core.organizations RLS — cross-tenant write
--   C-08  core.delegations RLS — cross-tenant admin read
--   C-09  finance.mark_overdue_invoices — unscoped cross-tenant write
--   C-10  finance.mark_paid_invoices — unscoped cross-tenant write
--   C-12  cash_flow() ignores contra-entries
--
-- All statements are idempotent (CREATE OR REPLACE / DROP POLICY IF
-- EXISTS + CREATE POLICY), so this script is safe to run more than once.
-- C-03 (vendor bill WHT imbalance) and C-06 (storage bucket) are NOT
-- database changes — see the separate route.ts files and the storage
-- migration file provided alongside this script.
-- C-11 (per-session MFA) is not included — it needs new session-token
-- infrastructure, not a schema change, and is out of scope here.
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- C-09: finance.mark_overdue_invoices — add org scoping + role check
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION "finance"."mark_overdue_invoices"() RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'finance', 'public'
    AS $$ 
DECLARE
  v_count INTEGER := 0;
  v_org_id UUID;
BEGIN
  -- C-09 fix: scope to caller's own organization and require an authorized
  -- role, so this SECURITY DEFINER function can no longer touch every
  -- organization's invoices when called by any authenticated user.
  v_org_id := core.current_user_org_id();
  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'Access denied: no organization context for caller';
  END IF;
  IF NOT (core.is_finance_head() OR core.has_role('ACCOUNTANT')) THEN
    RAISE EXCEPTION 'Insufficient privileges to mark invoices overdue';
  END IF;

  -- Sirf un invoices ko OVERDUE mark karo jo ISSUED ya PARTIALLY_PAID hain
  -- AUR unka due_date ho chuka ho aur outstanding_amount > 0 ho
  UPDATE public.invoices
  SET status = 'OVERDUE'
  WHERE id IN (
    SELECT id FROM public.invoices
    WHERE status IN ('ISSUED', 'PARTIALLY_PAID')
      AND due_date < CURRENT_DATE
      AND outstanding_amount > 0
      AND organization_id = v_org_id
  );
  
  GET DIAGNOSTICS v_count = ROW_COUNT; -- Fixed the syntax here as well
  
  RETURN v_count;
END;
$$;


ALTER FUNCTION "finance"."mark_overdue_invoices"() OWNER TO "postgres";

REVOKE ALL ON FUNCTION "finance"."mark_overdue_invoices"() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "finance"."mark_overdue_invoices"() TO "authenticated";


-e 
-- ---------------------------------------------------------------------
-- C-10: finance.mark_paid_invoices — add org scoping + role check
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION "finance"."mark_paid_invoices"() RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'finance', 'public'
    AS $$ 
DECLARE
  v_count INTEGER := 0;
  v_org_id UUID;
BEGIN
  -- C-10 fix: scope to caller's own organization and require an authorized
  -- role, matching the C-09 fix applied to mark_overdue_invoices().
  v_org_id := core.current_user_org_id();
  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'Access denied: no organization context for caller';
  END IF;
  IF NOT (core.is_finance_head() OR core.has_role('ACCOUNTANT')) THEN
    RAISE EXCEPTION 'Insufficient privileges to mark invoices paid';
  END IF;

  -- Agar outstanding 0 se kam ya barabar hai toh PAID kar do
  UPDATE public.invoices
  SET status = 'PAID'
  WHERE id IN (
    SELECT id FROM public.invoices
    WHERE status IN ('ISSUED', 'PARTIALLY_PAID', 'OVERDUE')
      AND outstanding_amount <= 0
      AND organization_id = v_org_id
  );
  
  GET DIAGNOSTICS v_count = ROW_COUNT; -- Fixed the syntax here as well
  RETURN v_count;
END;
$$;


ALTER FUNCTION "finance"."mark_paid_invoices"() OWNER TO "postgres";
-e 
REVOKE ALL ON FUNCTION "finance"."mark_paid_invoices"() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "finance"."mark_paid_invoices"() TO "authenticated";

-e 
-- ---------------------------------------------------------------------
-- C-01: JSONB merge bug fix (part 1/7) — post_bank_transfer
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION "finance"."post_bank_transfer"("p_transfer_id" "uuid", "p_period_id" "uuid", "p_transaction_date" "date") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'finance', 'public'
    AS $$
DECLARE
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
    SELECT * INTO v_t FROM finance.bank_transfers WHERE id = p_transfer_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Transfer not found'; END IF;
    IF v_t.status NOT IN ('APPROVED','SUBMITTED') THEN RAISE EXCEPTION 'Must be approved, status: %', v_t.status; END IF;

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


-e 
-- ---------------------------------------------------------------------
-- C-01: JSONB merge bug fix (part 2/7, bonus find) — post_credit_note
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION "finance"."post_credit_note"("p_cn_id" "uuid", "p_period_id" "uuid", "p_transaction_date" "date") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'finance', 'public'
    AS $$
DECLARE
    v_cn RECORD;
    v_fy_id UUID;
    v_rev_account UUID;
    v_ar_account UUID;
    v_lines JSONB := '[]'::JSONB;
BEGIN
    SELECT * INTO v_cn FROM finance.credit_notes WHERE id = p_cn_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Credit Note not found'; END IF;

    SELECT fiscal_year_id INTO v_fy_id FROM finance.accounting_periods WHERE id = p_period_id;
    IF v_fy_id IS NULL THEN RAISE EXCEPTION 'Invalid period'; END IF;

    SELECT id INTO v_rev_account FROM finance.chart_of_accounts WHERE code = '4110' LIMIT 1;
    SELECT id INTO v_ar_account FROM finance.chart_of_accounts WHERE code = '1210' LIMIT 1;

    v_lines := v_lines || jsonb_build_object(
        'account_id', v_rev_account,
        'debit_amount', v_cn.base_amount,
        'credit_amount', 0,
        'description', 'Credit Note: ' || COALESCE(v_cn.credit_note_number, v_cn.id::text) || ' - ' || v_cn.reason
    );

    v_lines := v_lines || jsonb_build_object(
        'account_id', v_ar_account,
        'debit_amount', 0,
        'credit_amount', v_cn.base_amount,
        'description', 'AR Adjustment: CN ' || COALESCE(v_cn.credit_note_number, v_cn.id::text)
    );

    --  CORRECT PARAMETER ORDER
    RETURN finance.post_journal_entry(
        'Credit Note: ' || COALESCE(v_cn.credit_note_number, v_cn.id::text),
        p_transaction_date,
        p_period_id,
        v_lines,
        'PKR', 1.0000,
        'CREDIT_NOTE', p_cn_id,
        NULL, NULL
    );
END;
$$;


ALTER FUNCTION "finance"."post_credit_note"("p_cn_id" "uuid", "p_period_id" "uuid", "p_transaction_date" "date") OWNER TO "postgres";


-e 
-- ---------------------------------------------------------------------
-- C-01 + C-02: JSONB merge bug + wrong param order (part 3/7, bonus find)
-- post_distribution_payment
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION "finance"."post_distribution_payment"("p_line_id" "uuid", "p_period_id" "uuid", "p_transaction_date" "date", "p_bank_account_id" "uuid") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'finance', 'public'
    AS $$ DECLARE
    v_line RECORD; v_lines JSONB := '[]'::JSONB;
    v_payable UUID; v_bank_ledger UUID; v_owner_name TEXT;
BEGIN
    SELECT * INTO v_line FROM finance.distribution_lines WHERE id = p_line_id;
    IF v_line.payment_status != 'PENDING' THEN RAISE EXCEPTION 'Already paid'; END IF;

    SELECT name INTO v_owner_name FROM finance.owners WHERE id = v_line.owner_id;
    SELECT id INTO v_payable FROM finance.chart_of_accounts WHERE code = '2410' LIMIT 1;
    SELECT linked_ledger_account_id INTO v_bank_ledger FROM finance.financial_accounts WHERE id = p_bank_account_id;

    v_lines := v_lines || jsonb_build_object('account_id', v_payable, 'debit_amount', v_line.final_amount, 'credit_amount', 0, 'description', 'Payout to ' || v_owner_name);
    v_lines := v_lines || jsonb_build_object('account_id', v_bank_ledger, 'debit_amount', 0, 'credit_amount', v_line.final_amount, 'description', 'Payout to ' || v_owner_name);

    RETURN finance.post_journal_entry('Owner Payout', p_transaction_date, p_period_id, v_lines, 'PKR', 1.0, 'DISTRIBUTION_PAYMENT', p_line_id, NULL, NULL);
END;
 $$;


ALTER FUNCTION "finance"."post_distribution_payment"("p_line_id" "uuid", "p_period_id" "uuid", "p_transaction_date" "date", "p_bank_account_id" "uuid") OWNER TO "postgres";


-e 
-- ---------------------------------------------------------------------
-- C-01: JSONB merge bug fix (part 4/7) — post_invoice_ar
-- ---------------------------------------------------------------------
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
    v_lines := v_lines || jsonb_build_object(
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


ALTER FUNCTION "finance"."post_invoice_ar"("p_invoice_id" "uuid", "p_period_id" "uuid", "p_transaction_date" "date") OWNER TO "postgres";


-e 
-- ---------------------------------------------------------------------
-- C-01: JSONB merge bug fix (part 5/7) — post_payment_receipt
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION "finance"."post_payment_receipt"("p_receipt_id" "uuid", "p_period_id" "uuid", "p_transaction_date" "date") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'finance', 'public'
    AS $$
DECLARE
    v_receipt RECORD;
    v_fy_id UUID;
    v_bank_account UUID;
    v_ar_account UUID;
    v_lines JSONB := '[]'::JSONB;
BEGIN
    SELECT * INTO v_receipt FROM finance.payment_receipts WHERE id = p_receipt_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Receipt not found'; END IF;

    SELECT fiscal_year_id INTO v_fy_id FROM finance.accounting_periods WHERE id = p_period_id;
    IF v_fy_id IS NULL THEN RAISE EXCEPTION 'Invalid period'; END IF;

    SELECT id INTO v_bank_account FROM finance.chart_of_accounts WHERE code = '1110' LIMIT 1;
    SELECT id INTO v_ar_account FROM finance.chart_of_accounts WHERE code = '1210' LIMIT 1;

    IF v_bank_account IS NULL THEN RAISE EXCEPTION 'Bank account 1110 not found'; END IF;
    IF v_ar_account IS NULL THEN RAISE EXCEPTION 'AR account 1210 not found'; END IF;

    v_lines := v_lines || jsonb_build_object(
        'account_id', v_bank_account,
        'debit_amount', v_receipt.base_amount,
        'credit_amount', 0,
        'description', 'Payment Received: ' || COALESCE(v_receipt.receipt_number, v_receipt.id::text)
    );

    v_lines := v_lines || jsonb_build_object(
        'account_id', v_ar_account,
        'debit_amount', 0,
        'credit_amount', v_receipt.base_amount,
        'description', 'AR Cleared: ' || COALESCE(v_receipt.receipt_number, v_receipt.id::text)
    );

    --  CORRECT PARAMETER ORDER
    RETURN finance.post_journal_entry(
        'Payment Receipt: ' || COALESCE(v_receipt.receipt_number, v_receipt.id::text),
        p_transaction_date,
        p_period_id,
        v_lines,
        'PKR', 1.0000,
        'PAYMENT', p_receipt_id,
        v_receipt.project_id,
        NULL
    );
END;
$$;


ALTER FUNCTION "finance"."post_payment_receipt"("p_receipt_id" "uuid", "p_period_id" "uuid", "p_transaction_date" "date") OWNER TO "postgres";
-e 
-- ---------------------------------------------------------------------
-- C-04: finance.post_payment_receipt_atomic — this RPC did not exist,
-- so every POST to /api/finance/payment-receipts always failed.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION "finance"."post_payment_receipt_atomic"(
    "p_client_id" "uuid",
    "p_amount" numeric,
    "p_currency" "text" DEFAULT 'PKR'::"text",
    "p_exchange_rate" numeric DEFAULT 1.0000,
    "p_payment_date" "date" DEFAULT CURRENT_DATE,
    "p_payment_method" "text" DEFAULT 'BANK_TRANSFER'::"text",
    "p_reference" "text" DEFAULT NULL::"text",
    "p_financial_account_id" "uuid" DEFAULT NULL::"uuid",
    "p_notes" "text" DEFAULT NULL::"text",
    "p_allocations" "jsonb" DEFAULT '[]'::"jsonb"
) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'finance', 'public', 'core'
    AS $$
DECLARE
  v_org_id UUID := core.current_user_org_id();
  v_receipt_id UUID;
  v_receipt_number TEXT;
  v_period_id UUID;
  v_journal_id UUID;
  v_alloc JSONB;
  v_invoice RECORD;
  v_alloc_amount NUMERIC(18,2);
  v_base_alloc_amount NUMERIC(18,2);
  v_total_allocated NUMERIC(18,2) := 0;
BEGIN
  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'Access denied: no organization context for caller';
  END IF;

  IF NOT (core.is_finance_head() OR core.has_role('ACCOUNTANT')) THEN
    RAISE EXCEPTION 'Insufficient privileges to record a payment receipt';
  END IF;

  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'Payment amount must be greater than zero';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.clients WHERE id = p_client_id AND organization_id = v_org_id) THEN
    RAISE EXCEPTION 'Client not found in your organization';
  END IF;

  IF p_financial_account_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM finance.financial_accounts WHERE id = p_financial_account_id AND organization_id = v_org_id
  ) THEN
    RAISE EXCEPTION 'Financial account not found in your organization';
  END IF;

  SELECT id INTO v_period_id
  FROM finance.accounting_periods
  WHERE status = 'OPEN' AND organization_id = v_org_id
  ORDER BY start_date DESC
  LIMIT 1;
  IF v_period_id IS NULL THEN
    RAISE EXCEPTION 'No OPEN accounting period found';
  END IF;

  v_receipt_number := finance.get_next_number('PMT-RC', v_org_id);
  IF v_receipt_number IS NULL THEN
    v_receipt_number := 'PMT-RC-' || to_char(now(), 'YYYYMMDDHH24MISS');
  END IF;

  INSERT INTO finance.payment_receipts (
    receipt_number, payment_date, amount, currency, exchange_rate,
    base_amount, client_id, financial_account_id, payment_method,
    reference, description, status, period_id, created_by, organization_id
  ) VALUES (
    v_receipt_number, p_payment_date, p_amount, COALESCE(p_currency, 'PKR'), COALESCE(p_exchange_rate, 1),
    ROUND(p_amount * COALESCE(p_exchange_rate, 1), 2), p_client_id, p_financial_account_id, COALESCE(p_payment_method, 'BANK_TRANSFER'),
    p_reference, p_notes, 'DRAFT', v_period_id, auth.uid(), v_org_id
  ) RETURNING id INTO v_receipt_id;

  IF p_allocations IS NOT NULL THEN
    FOR v_alloc IN SELECT * FROM jsonb_array_elements(p_allocations)
    LOOP
      SELECT * INTO v_invoice FROM public.invoices
      WHERE id = (v_alloc->>'invoice_id')::UUID AND organization_id = v_org_id
      FOR UPDATE;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'Invoice % not found in your organization', (v_alloc->>'invoice_id');
      END IF;

      v_alloc_amount := (v_alloc->>'amount')::NUMERIC(18,2);
      IF v_alloc_amount IS NULL OR v_alloc_amount <= 0 THEN
        RAISE EXCEPTION 'Invalid allocation amount for invoice %', v_invoice.invoice_number;
      END IF;
      IF v_alloc_amount > (v_invoice.total_amount - COALESCE(v_invoice.amount_paid, 0)) THEN
        RAISE EXCEPTION 'Allocation exceeds outstanding balance for invoice %', v_invoice.invoice_number;
      END IF;

      v_base_alloc_amount := ROUND(v_alloc_amount * COALESCE(p_exchange_rate, 1), 2);
      v_total_allocated := v_total_allocated + v_alloc_amount;

      INSERT INTO finance.payment_allocations (
        payment_receipt_id, invoice_id, allocated_amount, base_allocated_amount, allocated_by
      ) VALUES (
        v_receipt_id, v_invoice.id, v_alloc_amount, v_base_alloc_amount, auth.uid()
      );

      UPDATE public.invoices
      SET amount_paid = COALESCE(amount_paid, 0) + v_alloc_amount,
          base_amount_paid = COALESCE(base_amount_paid, 0) + v_base_alloc_amount,
          outstanding_amount = GREATEST(total_amount - (COALESCE(amount_paid, 0) + v_alloc_amount), 0),
          base_outstanding_amount = GREATEST(base_total_amount - (COALESCE(base_amount_paid, 0) + v_base_alloc_amount), 0),
          status = CASE
                     WHEN (COALESCE(amount_paid, 0) + v_alloc_amount) >= total_amount THEN 'PAID'
                     ELSE 'PARTIALLY_PAID'
                   END
      WHERE id = v_invoice.id;
    END LOOP;
  END IF;

  IF ABS(v_total_allocated - p_amount) > 0.01 THEN
    RAISE EXCEPTION 'Total allocations (%) must equal payment amount (%)', v_total_allocated, p_amount;
  END IF;

  v_journal_id := finance.post_payment_receipt(v_receipt_id, v_period_id, p_payment_date);

  UPDATE finance.payment_receipts
  SET status = 'POSTED', journal_entry_id = v_journal_id, posted_by = auth.uid(), posted_at = now()
  WHERE id = v_receipt_id;

  RETURN jsonb_build_object(
    'receipt_id', v_receipt_id,
    'journal_id', v_journal_id,
    'receipt_number', v_receipt_number
  );
END;
$$;


ALTER FUNCTION "finance"."post_payment_receipt_atomic"("p_client_id" "uuid", "p_amount" numeric, "p_currency" "text", "p_exchange_rate" numeric, "p_payment_date" "date", "p_payment_method" "text", "p_reference" "text", "p_financial_account_id" "uuid", "p_notes" "text", "p_allocations" "jsonb") OWNER TO "postgres";

REVOKE ALL ON FUNCTION "finance"."post_payment_receipt_atomic"("p_client_id" "uuid", "p_amount" numeric, "p_currency" "text", "p_exchange_rate" numeric, "p_payment_date" "date", "p_payment_method" "text", "p_reference" "text", "p_financial_account_id" "uuid", "p_notes" "text", "p_allocations" "jsonb") FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "finance"."post_payment_receipt_atomic"("p_client_id" "uuid", "p_amount" numeric, "p_currency" "text", "p_exchange_rate" numeric, "p_payment_date" "date", "p_payment_method" "text", "p_reference" "text", "p_financial_account_id" "uuid", "p_notes" "text", "p_allocations" "jsonb") TO "authenticated";


-e 
-- ---------------------------------------------------------------------
-- C-01 + C-02: JSONB merge bug + wrong param order — post_profit_distribution
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION "finance"."post_profit_distribution"("p_distribution_id" "uuid", "p_period_id" "uuid", "p_transaction_date" "date") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'finance', 'public'
    AS $$ DECLARE
    v_dist RECORD; v_lines JSONB := '[]'::JSONB;
    v_pnl UUID; v_reserve UUID; v_payable UUID;
BEGIN
    SELECT * INTO v_dist FROM finance.profit_distributions WHERE id = p_distribution_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Distribution not found'; END IF;
    IF v_dist.status != 'APPROVED' THEN RAISE EXCEPTION 'Must be APPROVED'; END IF;

    SELECT id INTO v_pnl FROM finance.chart_of_accounts WHERE code = '3400' LIMIT 1;
    SELECT id INTO v_reserve FROM finance.chart_of_accounts WHERE code = '3310' LIMIT 1;
    SELECT id INTO v_payable FROM finance.chart_of_accounts WHERE code = '2410' LIMIT 1;

    v_lines := v_lines || jsonb_build_object('account_id', v_pnl, 'debit_amount', v_dist.total_available_profit, 'credit_amount', 0, 'description', 'Close P&L & Transfer to Reserves/Distributions');
    
    IF v_dist.reserve_amount > 0 THEN
        v_lines := v_lines || jsonb_build_object('account_id', v_reserve, 'debit_amount', 0, 'credit_amount', v_dist.reserve_amount, 'description', 'Transfer to Reserves');
    END IF;
    
    IF v_dist.distributable_amount > 0 THEN
        v_lines := v_lines || jsonb_build_object('account_id', v_payable, 'debit_amount', 0, 'credit_amount', v_dist.distributable_amount, 'description', 'Profit Distribution Payable');
    END IF;

    RETURN finance.post_journal_entry('Profit Distribution', p_transaction_date, p_period_id, v_lines, 'PKR', 1.0, 'PROFIT_DISTRIBUTION', p_distribution_id, NULL, NULL);
END;
 $$;


ALTER FUNCTION "finance"."post_profit_distribution"("p_distribution_id" "uuid", "p_period_id" "uuid", "p_transaction_date" "date") OWNER TO "postgres";

-e 
-- ---------------------------------------------------------------------
-- C-01 + C-05: JSONB merge bug + WHT-imbalance fix — post_vendor_payment
-- ---------------------------------------------------------------------
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

    -- Debit AP for the FULL bill amount being cleared (allocated + discount + withholding).
    -- C-05 fix: withholding must be included here too, since it is credited to WHT
    -- Payable below; omitting it left the journal unbalanced by v_total_withholding.
    IF (v_total_allocated + v_total_discount + v_total_withholding) > 0 THEN
        v_lines := v_lines || jsonb_build_object(
            'account_id', v_ap_account,
            'debit_amount', v_total_allocated + v_total_discount + v_total_withholding,
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


COMMENT ON FUNCTION "finance"."post_vendor_payment"("p_payment_id" "uuid", "p_period_id" "uuid", "p_transaction_date" "date") IS 'BUG-001 fix (database audit): now posts vendor_payment_allocations.discount_amount to a Purchase Discounts Received GL line so debit AP always equals credit Bank + credit Discount, keeping the journal balanced.';
-e 
-- ---------------------------------------------------------------------
-- C-12: cash_flow() — operating section ignored contra-entries
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION "public"."cash_flow"("p_start" "date" DEFAULT NULL::"date", "p_end" "date" DEFAULT NULL::"date") RETURNS json
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
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
      -- C-12 fix: net both sides of every account instead of summing only one
      -- side. Previously a revenue account only summed credits (ignoring debit
      -- contra-entries like sales returns) and an expense account only summed
      -- debits (ignoring credit contra-entries like purchase returns), so those
      -- returns were silently dropped from the cash flow statement. For this
      -- operating-activities cash-flow sign convention, "credit_total -
      -- debit_total" is the correct net contribution for BOTH a credit-normal
      -- revenue account (net revenue) and a debit-normal expense account
      -- (negative of net expense) -- the sign flip is already built in.
      (COALESCE(SUM(jl.base_credit), 0) - COALESCE(SUM(jl.base_debit), 0)) AS total
    FROM finance.journal_lines jl
    JOIN finance.journal_entries je ON je.id = jl.journal_entry_id
      AND je.status = 'POSTED' AND je.organization_id = v_org_id
    JOIN finance.accounting_periods ap ON ap.id = je.period_id
    JOIN finance.chart_of_accounts coa ON coa.id = jl.account_id AND coa.organization_id = v_org_id
    WHERE ap.start_date >= v_start AND ap.end_date <= v_end
      AND coa.account_type IN ('REVENUE', 'COST_OF_SALES', 'OPERATING_EXPENSE')
    GROUP BY coa.name, coa.account_type
    HAVING (COALESCE(SUM(jl.base_credit), 0) - COALESCE(SUM(jl.base_debit), 0)) != 0

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


ALTER FUNCTION "public"."cash_flow"("p_start" "date", "p_end" "date") OWNER TO "postgres";

-- ---------------------------------------------------------------------
-- C-07: core.organizations RLS — was USING no organization filter at
-- all (any CEO/Admin, from ANY org, could write to ANY organization's
-- row). Now restricted to UPDATE only and scoped with core.same_org(id).
-- ---------------------------------------------------------------------
DROP POLICY IF EXISTS "Admins manage organizations" ON "core"."organizations";

CREATE POLICY "Admins manage organizations" ON "core"."organizations" FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."user_id" = "auth"."uid"()) AND ("p"."role" = ANY (ARRAY['CEO'::"text", 'Admin'::"text"]))))) AND "core"."same_org"("id")) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."user_id" = "auth"."uid"()) AND ("p"."role" = ANY (ARRAY['CEO'::"text", 'Admin'::"text"]))))) AND "core"."same_org"("id"));

-- ---------------------------------------------------------------------
-- C-08: core.delegations SELECT — the ADMIN_USERS branch had no
-- organization filter, so any org's ADMIN_USERS holder could read every
-- organization's delegations. Added core.same_org(organization_id).
-- ---------------------------------------------------------------------
DROP POLICY IF EXISTS "delegations_select_own" ON "core"."delegations";

CREATE POLICY "delegations_select_own" ON "core"."delegations" FOR SELECT USING ((("from_user_id" = "auth"."uid"()) OR ("to_user_id" = "auth"."uid"()) OR ("core"."has_permission"("auth"."uid"(), 'ADMIN_USERS'::"text") AND "core"."same_org"("organization_id"))));

COMMIT;

-- =====================================================================
-- End of script. After running, verify with:
--   SELECT proname FROM pg_proc WHERE proname = 'post_payment_receipt_atomic';
--   SELECT polname FROM pg_policies WHERE polname IN ('Admins manage organizations','delegations_select_own');
-- =====================================================================
