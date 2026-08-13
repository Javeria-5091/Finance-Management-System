-- ============================================================================
-- P2_001_transaction_wrappers.sql
-- ============================================================================
-- Issue:  C7 - Production Readiness - Transaction Wrappers
-- Author: DB Migration
-- Date:   2025
--
-- Description:
--   Wraps the most critical multi-step financial posting operations in
--   proper PostgreSQL subtransactions (BEGIN/EXCEPTION/END blocks) so that
--   journal entry creation and source-record status updates are atomic.
--
--   Without these wrappers, a failure after the journal is posted but before
--   the source record is updated would leave the system in an inconsistent
--   state (journal exists but source still shows APPROVED).
--
--   Each function uses a PL/pgSQL EXCEPTION block so that any error triggers
--   an automatic ROLLBACK of the journal entry, preventing orphaned GL data.
--
-- Functions created:
--   1. finance.post_expense_transaction
--   2. finance.post_income_transaction
--   3. finance.post_vendor_bill_transaction
--   4. finance.post_invoice_transaction
--   5. finance.post_year_end_close_transaction
--
-- Dependencies:
--   - finance.post_journal_entry  (P0/phase_2_double_entry/009)
--   - finance.post_vendor_bill    (P0/phase_5_ap_vendors/018)
--   - finance.post_invoice_ar     (P0/phase_4_ar_currency/016)
--   - finance.chart_of_accounts   (P0/phase_1_foundation/002)
--   - finance.accounting_periods  (P0/phase_1_foundation/003)
--   - public.expenses             (P0/phase_2_double_entry/010)
--   - public.incomes              (P0/phase_2_double_entry/010)
--   - finance.vendor_bills        (P0/phase_5_ap_vendors/017)
--   - public.invoices             (P0/phase_4_ar_currency/013)
--   - finance.fiscal_years        (P0/phase_1_foundation/003)
-- ============================================================================
 
 
-- ============================================================================
-- 1. finance.post_expense_transaction
-- ============================================================================
-- Posts an expense to the general ledger and atomically updates the expense
-- record to POSTED status.
--
-- Journal logic:
--   - If vendor_id is set:  DR Expense Account / CR Accounts Payable (2110)
--   - If no vendor:         DR Expense Account / CR Cash/Bank (1110)
--
-- On any error the entire operation (journal + status update) is rolled back.
-- ============================================================================
CREATE OR REPLACE FUNCTION finance.post_expense_transaction(
  p_expense_id  UUID,
  p_period_id   UUID,
  p_posted_by   UUID,
  p_org_id      UUID
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_expense         RECORD;
  v_journal_id      UUID;
  v_cash_account    UUID;
  v_ap_account      UUID;
  v_cr_account      UUID;
  v_lines           JSONB := '[]'::JSONB;
  v_error_message   TEXT;
BEGIN
  -- ------------------------------------------------------------------------
  -- Pre-flight validations (outside the EXCEPTION block so constraint
  -- violations here surface as clear errors, not catch-all rollbacks)
  -- ------------------------------------------------------------------------
  IF p_expense_id IS NULL THEN
    RAISE EXCEPTION 'p_expense_id is required';
  END IF;
  IF p_period_id IS NULL THEN
    RAISE EXCEPTION 'p_period_id is required';
  END IF;
 
  SELECT * INTO v_expense
  FROM public.expenses
  WHERE id = p_expense_id;
 
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Expense % not found', p_expense_id;
  END IF;
 
  IF v_expense.status != 'APPROVED' THEN
    RAISE EXCEPTION 'Expense must be APPROVED before posting (current: %)', v_expense.status;
  END IF;
 
  IF v_expense.account_id IS NULL THEN
    RAISE EXCEPTION 'Expense has no account_id assigned';
  END IF;
 
  -- Resolve credit account: AP for vendor expenses, Cash for direct payments
  SELECT id INTO v_ap_account
  FROM finance.chart_of_accounts
  WHERE code = '2110' AND organization_id = p_org_id
  LIMIT 1;
 
  SELECT id INTO v_cash_account
  FROM finance.chart_of_accounts
  WHERE code = '1110' AND organization_id = p_org_id
  LIMIT 1;
 
  v_cr_account := CASE
    WHEN v_expense.vendor_id IS NOT NULL AND v_ap_account IS NOT NULL THEN v_ap_account
    WHEN v_cash_account IS NOT NULL THEN v_cash_account
    ELSE RAISE EXCEPTION 'Neither AP (2110) nor Cash (1110) account found for org %', p_org_id
  END;
 
  -- Build journal lines
  v_lines := v_lines || jsonb_build_object(
    'account_id',     v_expense.account_id,
    'debit_amount',   COALESCE(v_expense.base_amount, v_expense.amount),
    'credit_amount',  0,
    'description',    'Expense: ' || COALESCE(v_expense.description, v_expense.reference_number, v_expense.id::text)
  );
 
  v_lines := v_lines || jsonb_build_object(
    'account_id',     v_cr_account,
    'debit_amount',   0,
    'credit_amount',  COALESCE(v_expense.base_amount, v_expense.amount),
    'description',    CASE
                         WHEN v_expense.vendor_id IS NOT NULL
                           THEN 'AP: Expense ' || COALESCE(v_expense.reference_number, v_expense.id::text)
                         ELSE 'Cash Payment: ' || COALESCE(v_expense.reference_number, v_expense.id::text)
                       END
  );
 
  -- ========================================================================
  -- CRITICAL SECTION: Journal post + status update in EXCEPTION block
  -- ========================================================================
  BEGIN
    -- Post the journal entry (atomic within finance.post_journal_entry)
    v_journal_id := finance.post_journal_entry(
      p_description     => 'Expense: ' || COALESCE(v_expense.description, v_expense.reference_number, v_expense.id::text),
      p_transaction_date => COALESCE(v_expense.expense_date, v_expense.created_at::date, CURRENT_DATE),
      p_period_id        => p_period_id,
      p_lines            => v_lines,
      p_currency         => COALESCE(v_expense.currency, 'PKR'),
      p_exchange_rate    => COALESCE(v_expense.exchange_rate, 1.0000),
      p_source_type      => 'EXPENSE',
      p_source_id        => p_expense_id,
      p_project_id       => v_expense.project_id
    );
 
    -- Update the expense record to POSTED
    UPDATE public.expenses
    SET status           = 'POSTED',
        journal_entry_id = v_journal_id,
        period_id        = p_period_id,
        posted_at        = NOW(),
        posted_by        = p_posted_by
    WHERE id = p_expense_id;
 
    RETURN v_journal_id;
 
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_error_message = MESSAGE_TEXT;
    RAISE EXCEPTION 'post_expense_transaction failed for expense %: %', p_expense_id, v_error_message;
  END;
END;
$$;
 
COMMENT ON FUNCTION finance.post_expense_transaction IS
  'Atomically posts an expense to the GL and updates its status to POSTED. Rolls back on any error.';
 
 
-- ============================================================================
-- 2. finance.post_income_transaction
-- ============================================================================
-- Posts an income record to the general ledger and atomically updates the
-- income record to POSTED status.
--
-- Journal logic:
--   DR Cash/Bank (1110) / CR Revenue Account
--
-- On any error the entire operation is rolled back.
-- ============================================================================
CREATE OR REPLACE FUNCTION finance.post_income_transaction(
  p_income_id   UUID,
  p_period_id   UUID,
  p_posted_by   UUID,
  p_org_id      UUID
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_income          RECORD;
  v_journal_id      UUID;
  v_cash_account    UUID;
  v_lines           JSONB := '[]'::JSONB;
  v_error_message   TEXT;
BEGIN
  -- ------------------------------------------------------------------------
  -- Pre-flight validations
  -- ------------------------------------------------------------------------
  IF p_income_id IS NULL THEN
    RAISE EXCEPTION 'p_income_id is required';
  END IF;
  IF p_period_id IS NULL THEN
    RAISE EXCEPTION 'p_period_id is required';
  END IF;
 
  SELECT * INTO v_income
  FROM public.incomes
  WHERE id = p_income_id;
 
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Income % not found', p_income_id;
  END IF;
 
  IF v_income.status != 'APPROVED' THEN
    RAISE EXCEPTION 'Income must be APPROVED before posting (current: %)', v_income.status;
  END IF;
 
  IF v_income.account_id IS NULL THEN
    RAISE EXCEPTION 'Income has no account_id assigned';
  END IF;
 
  -- Resolve debit (cash/bank) account
  SELECT id INTO v_cash_account
  FROM finance.chart_of_accounts
  WHERE code = '1110' AND organization_id = p_org_id
  LIMIT 1;
 
  IF v_cash_account IS NULL THEN
    RAISE EXCEPTION 'Cash/Bank account (1110) not found for org %', p_org_id;
  END IF;
 
  -- Build journal lines
  v_lines := v_lines || jsonb_build_object(
    'account_id',     v_cash_account,
    'debit_amount',   COALESCE(v_income.base_amount, v_income.amount),
    'credit_amount',  0,
    'description',    'Cash Receipt: ' || COALESCE(v_income.description, v_income.reference_number, v_income.id::text)
  );
 
  v_lines := v_lines || jsonb_build_object(
    'account_id',     v_income.account_id,
    'debit_amount',   0,
    'credit_amount',  COALESCE(v_income.base_amount, v_income.amount),
    'description',    'Income: ' || COALESCE(v_income.description, v_income.reference_number, v_income.id::text)
  );
 
  -- ========================================================================
  -- CRITICAL SECTION
  -- ========================================================================
  BEGIN
    v_journal_id := finance.post_journal_entry(
      p_description     => 'Income: ' || COALESCE(v_income.description, v_income.reference_number, v_income.id::text),
      p_transaction_date => COALESCE(v_income.income_date, v_income.created_at::date, CURRENT_DATE),
      p_period_id        => p_period_id,
      p_lines            => v_lines,
      p_currency         => COALESCE(v_income.currency, 'PKR'),
      p_exchange_rate    => COALESCE(v_income.exchange_rate, 1.0000),
      p_source_type      => 'INCOME',
      p_source_id        => p_income_id,
      p_project_id       => v_income.project_id
    );
 
    UPDATE public.incomes
    SET status           = 'POSTED',
        journal_entry_id = v_journal_id,
        period_id        = p_period_id,
        posted_at        = NOW(),
        posted_by        = p_posted_by
    WHERE id = p_income_id;
 
    RETURN v_journal_id;
 
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_error_message = MESSAGE_TEXT;
    RAISE EXCEPTION 'post_income_transaction failed for income %: %', p_income_id, v_error_message;
  END;
END;
$$;
 
COMMENT ON FUNCTION finance.post_income_transaction IS
  'Atomically posts an income record to the GL and updates its status to POSTED. Rolls back on any error.';
 
 
-- ============================================================================
-- 3. finance.post_vendor_bill_transaction
-- ============================================================================
-- Posts a vendor bill to the GL using the existing finance.post_vendor_bill
-- function (which builds lines for expense + WHT + AP) and then atomically
-- updates the vendor bill status to POSTED.
--
-- Without this wrapper, a failure after post_vendor_bill succeeds but before
-- the status UPDATE runs would leave a posted journal with an APPROVED bill.
-- ============================================================================
CREATE OR REPLACE FUNCTION finance.post_vendor_bill_transaction(
  p_vendor_bill_id  UUID,
  p_period_id       UUID,
  p_posted_by       UUID,
  p_org_id          UUID
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_bill            RECORD;
  v_journal_id      UUID;
  v_error_message   TEXT;
BEGIN
  -- ------------------------------------------------------------------------
  -- Pre-flight validations
  -- ------------------------------------------------------------------------
  IF p_vendor_bill_id IS NULL THEN
    RAISE EXCEPTION 'p_vendor_bill_id is required';
  END IF;
  IF p_period_id IS NULL THEN
    RAISE EXCEPTION 'p_period_id is required';
  END IF;
 
  SELECT * INTO v_bill
  FROM finance.vendor_bills
  WHERE id = p_vendor_bill_id;
 
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Vendor bill % not found', p_vendor_bill_id;
  END IF;
 
  IF v_bill.status != 'APPROVED' THEN
    RAISE EXCEPTION 'Vendor bill must be APPROVED before posting (current: %)', v_bill.status;
  END IF;
 
  -- ========================================================================
  -- CRITICAL SECTION: post_journal_entry (via post_vendor_bill) + status update
  -- ========================================================================
  BEGIN
    -- Delegate to the existing AP posting function which calls
    -- finance.post_journal_entry internally with properly built lines
    -- (DR expense accounts, DR WHT, CR AP)
    v_journal_id := finance.post_vendor_bill(
      p_bill_id         => p_vendor_bill_id,
      p_period_id       => p_period_id,
      p_transaction_date => v_bill.bill_date
    );
 
    -- Atomically update the bill status
    UPDATE finance.vendor_bills
    SET status      = 'POSTED',
        posted_at   = NOW(),
        posted_by   = p_posted_by
    WHERE id = p_vendor_bill_id;
 
    RETURN v_journal_id;
 
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_error_message = MESSAGE_TEXT;
    RAISE EXCEPTION 'post_vendor_bill_transaction failed for bill %: %', p_vendor_bill_id, v_error_message;
  END;
END;
$$;
 
COMMENT ON FUNCTION finance.post_vendor_bill_transaction IS
  'Atomically posts a vendor bill via post_vendor_bill and updates its status to POSTED. Rolls back on any error.';
 
 
-- ============================================================================
-- 4. finance.post_invoice_transaction
-- ============================================================================
-- Posts an invoice to the GL using the existing finance.post_invoice_ar
-- function (DR AR / CR Revenue + Tax) and then atomically links the
-- resulting journal_entry_id back to the invoice record.
--
-- The invoice status lifecycle (DRAFT -> ISSUED) is separate from the GL
-- posting, so we set journal_entry_id and posted_at without changing the
-- invoice.status (invoices move to ISSUED before posting, and to PARTIALLY_PAID
-- or PAID upon payment receipt, not upon GL posting).
-- ============================================================================
CREATE OR REPLACE FUNCTION finance.post_invoice_transaction(
  p_invoice_id  UUID,
  p_period_id   UUID,
  p_posted_by   UUID,
  p_org_id      UUID
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_invoice         RECORD;
  v_journal_id      UUID;
  v_error_message   TEXT;
BEGIN
  -- ------------------------------------------------------------------------
  -- Pre-flight validations
  -- ------------------------------------------------------------------------
  IF p_invoice_id IS NULL THEN
    RAISE EXCEPTION 'p_invoice_id is required';
  END IF;
  IF p_period_id IS NULL THEN
    RAISE EXCEPTION 'p_period_id is required';
  END IF;
 
  SELECT * INTO v_invoice
  FROM public.invoices
  WHERE id = p_invoice_id;
 
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invoice % not found', p_invoice_id;
  END IF;
 
  IF v_invoice.status NOT IN ('APPROVED', 'ISSUED') THEN
    RAISE EXCEPTION 'Invoice must be APPROVED or ISSUED before GL posting (current: %)', v_invoice.status;
  END IF;
 
  -- ========================================================================
  -- CRITICAL SECTION: post_invoice_ar + journal link update
  -- ========================================================================
  BEGIN
    -- Delegate to the existing AR posting function which calls
    -- finance.post_journal_entry internally
    -- (DR Accounts Receivable, CR Revenue, CR Tax Payable)
    v_journal_id := finance.post_invoice_ar(
      p_invoice_id       => p_invoice_id,
      p_period_id        => p_period_id,
      p_transaction_date => COALESCE(v_invoice.issue_date, v_invoice.created_at::date, CURRENT_DATE)
    );
 
    -- Link the journal back to the invoice
    UPDATE public.invoices
    SET journal_entry_id = v_journal_id,
        period_id        = p_period_id,
        issued_at        = COALESCE(issued_at, NOW()),
        issued_by        = COALESCE(issued_by, p_posted_by)
    WHERE id = p_invoice_id;
 
    RETURN v_journal_id;
 
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_error_message = MESSAGE_TEXT;
    RAISE EXCEPTION 'post_invoice_transaction failed for invoice %: %', p_invoice_id, v_error_message;
  END;
END;
$$;
 
COMMENT ON FUNCTION finance.post_invoice_transaction IS
  'Atomically posts an invoice to the GL via post_invoice_ar and links the journal_entry_id. Rolls back on any error.';
 
 
-- ============================================================================
-- 5. finance.post_year_end_close_transaction
-- ============================================================================
-- Posts the year-end closing journal entry (e.g., close revenue/expense
-- accounts to retained earnings) and atomically sets the fiscal year status
-- to HARD_CLOSED.
--
-- This is the most critical transaction wrapper because:
--   a) The closing journal must not exist without the FY being closed.
--   b) The FY must not be closed without the closing journal being posted.
--   c) A partial failure would corrupt the entire year's financials.
--
-- Parameters:
--   p_fiscal_year_id  - The fiscal year being closed
--   p_posted_by       - User performing the close
--   p_org_id          - Organization scope for account lookups
--   p_journal_lines   - JSONB array of journal line objects (same format as
--                       finance.post_journal_entry p_lines parameter)
--   p_description     - Description for the closing journal entry
--   p_period_id       - The final period of the fiscal year
-- ============================================================================
CREATE OR REPLACE FUNCTION finance.post_year_end_close_transaction(
  p_fiscal_year_id  UUID,
  p_posted_by       UUID,
  p_org_id          UUID,
  p_journal_lines   JSONB,
  p_description     TEXT,
  p_period_id       UUID
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_fy              RECORD;
  v_journal_id      UUID;
  v_error_message   TEXT;
  v_line_count      INTEGER;
BEGIN
  -- ------------------------------------------------------------------------
  -- Pre-flight validations
  -- ------------------------------------------------------------------------
  IF p_fiscal_year_id IS NULL THEN
    RAISE EXCEPTION 'p_fiscal_year_id is required';
  END IF;
  IF p_posted_by IS NULL THEN
    RAISE EXCEPTION 'p_posted_by is required';
  END IF;
  IF p_journal_lines IS NULL THEN
    RAISE EXCEPTION 'p_journal_lines is required';
  END IF;
  IF p_period_id IS NULL THEN
    RAISE EXCEPTION 'p_period_id is required';
  END IF;
 
  -- Fetch and validate fiscal year
  SELECT * INTO v_fy
  FROM finance.fiscal_years
  WHERE id = p_fiscal_year_id;
 
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Fiscal year % not found', p_fiscal_year_id;
  END IF;
 
  IF v_fy.status != 'OPEN' THEN
    RAISE EXCEPTION 'Fiscal year must be OPEN to close (current status: %)', v_fy.status;
  END IF;
 
  -- Validate period belongs to this fiscal year
  IF NOT EXISTS (
    SELECT 1 FROM finance.accounting_periods
    WHERE id = p_period_id AND fiscal_year_id = p_fiscal_year_id
  ) THEN
    RAISE EXCEPTION 'Period % does not belong to fiscal year %', p_period_id, p_fiscal_year_id;
  END IF;
 
  -- Validate journal lines are non-empty
  v_line_count := jsonb_array_length(p_journal_lines);
  IF v_line_count < 2 THEN
    RAISE EXCEPTION 'Year-end closing journal must have at least 2 lines (got %)', v_line_count;
  END IF;
 
  -- ========================================================================
  -- CRITICAL SECTION: post closing journal + hard-close fiscal year
  -- ========================================================================
  BEGIN
    -- Post the closing journal entry
    v_journal_id := finance.post_journal_entry(
      p_description     => COALESCE(p_description, 'Year-End Close: ' || v_fy.name),
      p_transaction_date => v_fy.end_date,
      p_period_id        => p_period_id,
      p_lines            => p_journal_lines,
      p_currency         => 'PKR',
      p_exchange_rate    => 1.0000,
      p_source_type      => 'YEAR_END_CLOSE',
      p_source_id        => p_fiscal_year_id
    );
 
    -- Hard-close the fiscal year
    UPDATE finance.fiscal_years
    SET status     = 'HARD_CLOSED',
        closed_by  = p_posted_by,
        closed_at  = NOW()
    WHERE id = p_fiscal_year_id;
 
    -- Soft-close all periods in the fiscal year that are still OPEN
    UPDATE finance.accounting_periods
    SET status            = 'SOFT_CLOSED',
        closed_by         = p_posted_by,
        closed_at         = NOW(),
        reopening_reason  = NULL
    WHERE fiscal_year_id = p_fiscal_year_id
      AND status IN ('OPEN', 'PENDING');
 
    RETURN v_journal_id;
 
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_error_message = MESSAGE_TEXT;
    RAISE EXCEPTION 'post_year_end_close_transaction failed for FY %: %', p_fiscal_year_id, v_error_message;
  END;
END;
$$;
 
COMMENT ON FUNCTION finance.post_year_end_close_transaction IS
  'Atomically posts the year-end closing journal and hard-closes the fiscal year. Rolls back on any error.';
 

