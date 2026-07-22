-- ==========================================
-- PHASE 4: AR POSTING ENGINE
-- Yeh functions automatically GL entries create karte hain
-- ==========================================

-- 1. INVOICE ISSUANCE POSTING
-- Dr. Accounts Receivable (Client) / Cr. Revenue + Tax
CREATE OR REPLACE FUNCTION finance.post_invoice_ar(
  p_invoice_id UUID,
  p_period_id UUID,
  p_transaction_date DATE
) RETURNS UUID AS $$ DECLARE
  v_inv RECORD;
  v_fy_id UUID;
  v_lines JSONB := '[]'::JSONB;
  v_dr_account UUID := '12100000-0000-0000-0000-000000000000'; -- Fallback AR account
  v_rev_account UUID := '41100000-0000-0000-0000-000000000000'; -- Fallback Revenue
  v_tax_account UUID := '22100000-0000-0000-0000-000000000000'; -- Fallback Tax Payable
BEGIN
  -- Fetch invoice details
  SELECT * INTO v_inv FROM public.invoices WHERE id = p_invoice_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Invoice not found'; END IF;
  
  -- Get fiscal year
  SELECT fiscal_year_id INTO v_fy_id FROM finance.accounting_periods WHERE id = p_period_id;
  IF v_fy_id IS NULL THEN RAISE EXCEPTION 'Invalid period'; END IF;

  -- Try to get actual mapped accounts from COA (Best Practice)
  SELECT id INTO v_dr_account FROM finance.chart_of_accounts WHERE code = '1210' LIMIT 1;
  SELECT id INTO v_rev_account FROM finance.chart_of_accounts WHERE code = '4110' LIMIT 1;
  SELECT id INTO v_tax_account FROM finance.chart_of_accounts WHERE code = '2210' LIMIT 1;

  -- Build journal lines
  -- Line 1: Debit AR
  v_lines := v_lines || jsonb_build_object(
    'account_id', v_dr_account,
    'debit_amount', v_inv.base_total_amount,
    'credit_amount', 0,
    'description', 'AR: ' || COALESCE(v_inv.invoice_number, 'N/A') || ' - ' || v_inv.client_name
  );

  -- Line 2: Credit Revenue (Total - Tax)
  IF v_inv.base_total_amount - v_inv.base_tax_amount > 0 THEN
    v_lines := v_lines || jsonb_build_object(
      'account_id', v_rev_account,
      'debit_amount', 0,
      'credit_amount', v_inv.base_total_amount - v_inv.base_tax_amount,
      'description', 'Revenue: ' || COALESCE(v_inv.invoice_number, 'N/A')
    );
  END IF;

  -- Line 3: Credit Tax Payable (If tax exists)
  IF v_inv.base_tax_amount > 0 THEN
    v_lines := v_lines || jsonb_build_object(
      'account_id', v_tax_account,
      'debit_amount', 0,
      'credit_amount', v_inv.base_tax_amount,
      'description', 'Tax on Inv: ' || COALESCE(v_inv.invoice_number, 'N/A')
    );
  END IF;

  -- Call the master posting engine from Phase 2
  RETURN finance.post_journal_entry(
    'AR Invoice: ' || COALESCE(v_inv.invoice_number, v_inv.id::text),
    p_transaction_date,
    p_period_id,
    'PKR', 1.0000, -- Always posted in base currency for AR
    'INVOICE', p_invoice_id,
    v_inv.project_id,
    NULL,
    v_lines
  );
END;
 $$ LANGUAGE plpgsql SECURITY DEFINER;

-- 2. PAYMENT RECEIPT POSTING
-- Dr. Bank / Cr. Accounts Receivable
CREATE OR REPLACE FUNCTION finance.post_payment_receipt(
  p_receipt_id UUID,
  p_period_id UUID,
  p_transaction_date DATE
) RETURNS UUID AS $$ DECLARE
  v_receipt RECORD;
  v_fy_id UUID;
  v_bank_account UUID := '11100000-0000-0000-0000-000000000000'; -- Fallback Bank
  v_ar_account UUID := '12100000-0000-0000-0000-000000000000'; -- Fallback AR
  v_lines JSONB := '[]'::JSONB;
BEGIN
  SELECT * INTO v_receipt FROM finance.payment_receipts WHERE id = p_receipt_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Receipt not found'; END IF;
  
  SELECT fiscal_year_id INTO v_fy_id FROM finance.accounting_periods WHERE id = p_period_id;
  IF v_fy_id IS NULL THEN RAISE EXCEPTION 'Invalid period'; END IF;

  -- Try to get actual Bank account (Hardcoded to PKR for now, Phase 6 will make it dynamic)
  SELECT id INTO v_bank_account FROM finance.chart_of_accounts WHERE code = '1110' LIMIT 1;
  SELECT id INTO v_ar_account FROM finance.chart_of_accounts WHERE code = '1210' LIMIT 1;

  -- Build journal lines
  v_lines := jsonb_build_object(
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

  -- Call Phase 2 posting engine
  RETURN finance.post_journal_entry(
    'Payment Receipt: ' || COALESCE(v_receipt.receipt_number, v_receipt.id::text),
    p_transaction_date,
    p_period_id,
    'PKR', 1.0000,
    'PAYMENT', p_receipt_id,
    v_receipt.project_id,
    NULL,
    v_lines
  );
END;
 $$ LANGUAGE plpgsql SECURITY DEFINER;

-- 3. CREDIT NOTE POSTING
-- Dr. Revenue / Cr. Accounts Receivable (Reverses the effect of an invoice partially)
CREATE OR REPLACE FUNCTION finance.post_credit_note(
  p_cn_id UUID,
  p_period_id UUID,
  p_transaction_date DATE
) RETURNS UUID AS $$ DECLARE
  v_cn RECORD;
  v_fy_id UUID;
  v_rev_account UUID := '41100000-0000-0000-0000-000000000000';
  v_ar_account UUID := '12100000-0000-0000-0000-000000000000';
  v_lines JSONB := '[]'::JSONB;
BEGIN
  SELECT * INTO v_cn FROM finance.credit_notes WHERE id = p_cn_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Credit Note not found'; END IF;
  
  SELECT fiscal_year_id INTO v_fy_id FROM finance.accounting_periods WHERE id = p_period_id;
  IF v_fy_id IS NULL THEN RAISE EXCEPTION 'Invalid period'; END IF;

  SELECT id INTO v_rev_account FROM finance.chart_of_accounts WHERE code = '4110' LIMIT 1;
  SELECT id INTO v_ar_account FROM finance.chart_of_accounts WHERE code = '1210' LIMIT 1;

  -- Debit Revenue (Reduce income)
  v_lines := jsonb_build_object(
    'account_id', v_rev_account,
    'debit_amount', v_cn.base_amount,
    'credit_amount', 0,
    'description', 'Credit Note: ' || COALESCE(v_cn.credit_note_number, v_cn.id::text) || ' - ' || v_cn.reason
  );

  -- Credit AR (Reduce receivable)
  v_lines := v_lines || jsonb_build_object(
    'account_id', v_ar_account,
    'debit_amount', 0,
    'credit_amount', v_cn.base_amount,
    'description', 'AR Adjustment: CN ' || COALESCE(v_cn.credit_note_number, v_cn.id::text)
  );

  RETURN finance.post_journal_entry(
    'Credit Note: ' || COALESCE(v_cn.credit_note_number, v_cn.id::text),
    p_transaction_date,
    p_period_id,
    'PKR', 1.0000,
    'CREDIT_NOTE', p_cn_id,
    NULL, NULL,
    v_lines
  );
END;
 $$ LANGUAGE plpgsql SECURITY DEFINER;

-- ==========================================
-- AUDIT TRIGGERS FOR PHASE 4 TABLES
-- ==========================================
CREATE TRIGGER pr_audit AFTER INSERT OR UPDATE ON finance.payment_receipts
    FOR EACH ROW EXECUTE FUNCTION audit.trigger_audit_log();
CREATE TRIGGER pa_audit AFTER INSERT OR UPDATE OR DELETE ON finance.payment_allocations
    FOR EACH ROW EXECUTE FUNCTION audit.trigger_audit_log();
CREATE TRIGGER cn_audit AFTER INSERT OR UPDATE ON finance.credit_notes
    FOR EACH ROW EXECUTE FUNCTION audit.trigger_audit_log();
CREATE TRIGGER fx_audit AFTER INSERT OR UPDATE ON finance.exchange_rates
    FOR EACH ROW EXECUTE FUNCTION audit.trigger_audit_log();