-- P1_080: Invoice / AR workflow hardening
-- Fixes FND-FIN-002, 005, 006, 007, 008, 009.
-- Source of truth: OSYSTIC Finance Management System Specification v1.3.
-- No new business columns are introduced; existing schema is preserved.

BEGIN;

-- ---------------------------------------------------------------------------
-- FND-FIN-005: atomic reversals for vendor bills and credit notes.
-- The existing reverse_journal_entry() is reused so the reversal journal is
-- created by the canonical accounting engine. Source status and GL reversal
-- are in the same transaction.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION finance.reverse_vendor_bill_atomic(
  p_vendor_bill_id uuid,
  p_reversal_date date,
  p_reason text
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'pg_catalog','finance','public','core'
AS $$
DECLARE
  v_org uuid := core.current_user_org_id();
  v_bill record;
  v_journal_id uuid;
  v_reversal_id uuid;
BEGIN
  IF v_org IS NULL OR NOT (core.is_finance_head() OR core.has_role('ACCOUNTANT')) THEN
    RAISE EXCEPTION 'Access denied';
  END IF;
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN
    RAISE EXCEPTION 'Reversal reason is mandatory';
  END IF;

  SELECT id, status, bill_number, organization_id
    INTO v_bill
  FROM finance.vendor_bills
  WHERE id = p_vendor_bill_id AND organization_id = v_org
  FOR UPDATE;

  IF NOT FOUND OR v_bill.status <> 'POSTED' THEN
    RAISE EXCEPTION 'Posted vendor bill not found or access denied';
  END IF;

  SELECT id INTO v_journal_id
  FROM finance.journal_entries
  WHERE source_type = 'VENDOR_BILL'
    AND source_id = p_vendor_bill_id
    AND organization_id = v_org
    AND status = 'POSTED'
    AND reversal_of_id IS NULL
  ORDER BY posted_at DESC NULLS LAST, created_at DESC
  LIMIT 1
  FOR UPDATE;

  IF v_journal_id IS NULL THEN
    RAISE EXCEPTION 'Posted vendor bill has no original journal entry';
  END IF;

  v_reversal_id := finance.reverse_journal_entry(v_journal_id, p_reversal_date, p_reason);

  UPDATE finance.vendor_bills
  SET status = 'REVERSED', updated_at = now()
  WHERE id = p_vendor_bill_id AND organization_id = v_org AND status = 'POSTED';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Vendor bill status update failed';
  END IF;

  RETURN v_reversal_id;
END;
$$;

CREATE OR REPLACE FUNCTION finance.reverse_credit_note_atomic(
  p_credit_note_id uuid,
  p_reversal_date date,
  p_reason text
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'pg_catalog','finance','public','core'
AS $$
DECLARE
  v_org uuid := core.current_user_org_id();
  v_cn record;
  v_journal_id uuid;
  v_reversal_id uuid;
BEGIN
  IF v_org IS NULL OR NOT (core.is_finance_head() OR core.has_role('ACCOUNTANT')) THEN
    RAISE EXCEPTION 'Access denied';
  END IF;
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN
    RAISE EXCEPTION 'Reversal reason is mandatory';
  END IF;

  SELECT id, status, organization_id, invoice_id, amount
    INTO v_cn
  FROM finance.credit_notes
  WHERE id = p_credit_note_id AND organization_id = v_org
  FOR UPDATE;

  IF NOT FOUND OR v_cn.status <> 'POSTED' THEN
    RAISE EXCEPTION 'Posted credit note not found or access denied';
  END IF;

  SELECT id INTO v_journal_id
  FROM finance.journal_entries
  WHERE source_type = 'CREDIT_NOTE'
    AND source_id = p_credit_note_id
    AND organization_id = v_org
    AND status = 'POSTED'
    AND reversal_of_id IS NULL
  ORDER BY posted_at DESC NULLS LAST, created_at DESC
  LIMIT 1
  FOR UPDATE;

  IF v_journal_id IS NULL THEN
    RAISE EXCEPTION 'Posted credit note has no original journal entry';
  END IF;

  v_reversal_id := finance.reverse_journal_entry(v_journal_id, p_reversal_date, p_reason);

  UPDATE finance.credit_notes
  SET status = 'REVERSED', updated_at = now()
  WHERE id = p_credit_note_id AND organization_id = v_org AND status = 'POSTED';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Credit note status update failed';
  END IF;

  RETURN v_reversal_id;
END;
$$;

-- ---------------------------------------------------------------------------
-- FND-FIN-006 + FND-FIN-007: atomic credit-note and refund posting.
-- Invoice total_amount is never changed by an adjustment. The invoice
-- outstanding balance is the subledger balance affected by the adjustment.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION finance.post_credit_note_atomic(
  p_cn_id uuid,
  p_period_id uuid,
  p_transaction_date date
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'pg_catalog','finance','public','core'
AS $$
DECLARE
  v_org uuid := core.current_user_org_id();
  v_cn record;
  v_invoice record;
  v_ar uuid;
  v_revenue uuid;
  v_journal_id uuid;
  v_reference text;
  v_new_outstanding numeric(18,2);
  v_new_base_outstanding numeric(18,2);
  v_new_status text;
  v_lines jsonb;
BEGIN
  IF v_org IS NULL OR NOT (core.is_finance_head() OR core.has_role('ACCOUNTANT')) THEN
    RAISE EXCEPTION 'Access denied';
  END IF;

  SELECT * INTO v_cn
  FROM finance.credit_notes
  WHERE id = p_cn_id AND organization_id = v_org
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Credit note not found or access denied'; END IF;
  IF v_cn.status <> 'APPROVED' THEN RAISE EXCEPTION 'Only APPROVED credit notes can be posted'; END IF;
  IF v_cn.invoice_id IS NULL THEN RAISE EXCEPTION 'Only invoice credit notes are supported by this AR posting flow'; END IF;

  SELECT id, total_amount, outstanding_amount, base_outstanding_amount, currency, exchange_rate, organization_id, status
    INTO v_invoice
  FROM public.invoices
  WHERE id = v_cn.invoice_id AND organization_id = v_org
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Linked invoice not found or access denied'; END IF;
  IF v_cn.amount > COALESCE(v_invoice.outstanding_amount, 0) + 0.01 THEN
    RAISE EXCEPTION 'Credit note amount % exceeds invoice outstanding amount %', v_cn.amount, v_invoice.outstanding_amount;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM finance.accounting_periods WHERE id=p_period_id AND organization_id=v_org AND status='OPEN') THEN
    RAISE EXCEPTION 'Posting period is not OPEN';
  END IF;

  SELECT id INTO v_ar FROM finance.chart_of_accounts
  WHERE code='1210' AND account_type='ASSET' AND is_active=true AND organization_id=v_org
  LIMIT 1;
  SELECT id INTO v_revenue FROM finance.chart_of_accounts
  WHERE code='4110' AND account_type='REVENUE' AND is_active=true AND organization_id=v_org
  LIMIT 1;
  IF v_ar IS NULL OR v_revenue IS NULL THEN RAISE EXCEPTION 'Required AR/Revenue control accounts are not configured for this organization'; END IF;

  IF EXISTS (SELECT 1 FROM finance.journal_entries WHERE source_type='CREDIT_NOTE' AND source_id=p_cn_id AND organization_id=v_org) THEN
    RAISE EXCEPTION 'Credit note is already posted';
  END IF;

  v_lines := jsonb_build_array(
    jsonb_build_object('account_id',v_revenue,'debit_amount',v_cn.amount,'credit_amount',0,'description','Revenue reversal: Credit Note '||coalesce(v_cn.credit_note_number,p_cn_id::text)),
    jsonb_build_object('account_id',v_ar,'debit_amount',0,'credit_amount',v_cn.amount,'description','Receivable reduction: Credit Note '||coalesce(v_cn.credit_note_number,p_cn_id::text))
  );

  v_journal_id := finance.post_journal_entry(
    'Credit Note: '||coalesce(v_cn.credit_note_number,p_cn_id::text),
    p_transaction_date,p_period_id,v_lines,v_cn.currency,coalesce(v_cn.exchange_rate,1),'CREDIT_NOTE',p_cn_id,NULL,NULL
  );

  v_new_outstanding := greatest(0, coalesce(v_invoice.outstanding_amount,0) - v_cn.amount);
  v_new_base_outstanding := greatest(0, coalesce(v_invoice.base_outstanding_amount,0) - (v_cn.amount * coalesce(v_invoice.exchange_rate,1)));
  v_new_status := CASE WHEN v_new_outstanding <= 0.01 THEN 'CREDITED' ELSE v_invoice.status END;

  UPDATE public.invoices
  SET outstanding_amount=v_new_outstanding,
      base_outstanding_amount=v_new_base_outstanding,
      status=v_new_status
  WHERE id=v_invoice.id AND organization_id=v_org;

  UPDATE finance.credit_notes
  SET status='POSTED', journal_entry_id=v_journal_id, posted_by=auth.uid(), posted_at=now(), updated_at=now()
  WHERE id=p_cn_id AND organization_id=v_org AND status='APPROVED';

  IF NOT FOUND THEN RAISE EXCEPTION 'Credit note status update failed'; END IF;

  SELECT reference INTO v_reference FROM finance.journal_entries WHERE id=v_journal_id;
  RETURN jsonb_build_object('journal_id',v_journal_id,'reference',v_reference,'outstanding_amount',v_new_outstanding);
END;
$$;

CREATE OR REPLACE FUNCTION finance.post_invoice_refund_atomic(
  p_refund_id uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'pg_catalog','finance','public','core'
AS $$
DECLARE
  v_org uuid := core.current_user_org_id();
  v_refund record;
  v_invoice record;
  v_cash uuid;
  v_revenue uuid;
  v_period uuid;
  v_journal_id uuid;
  v_reference text;
  v_new_outstanding numeric(18,2);
  v_new_base_outstanding numeric(18,2);
  v_new_status text;
  v_lines jsonb;
BEGIN
  IF v_org IS NULL OR NOT (core.is_finance_head() OR core.has_role('ACCOUNTANT')) THEN
    RAISE EXCEPTION 'Access denied';
  END IF;

  SELECT * INTO v_refund
  FROM finance.invoice_refunds
  WHERE id=p_refund_id AND organization_id=v_org
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Refund not found or access denied'; END IF;
  IF v_refund.status <> 'APPROVED' THEN RAISE EXCEPTION 'Only APPROVED refunds can be posted'; END IF;

  SELECT id,total_amount,outstanding_amount,base_outstanding_amount,currency,exchange_rate,amount_paid,status,organization_id
    INTO v_invoice
  FROM public.invoices
  WHERE id=v_refund.invoice_id AND organization_id=v_org
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Linked invoice not found or access denied'; END IF;
  IF v_refund.amount > coalesce(v_invoice.amount_paid,0) + 0.01 THEN
    RAISE EXCEPTION 'Refund amount % exceeds amount already paid %',v_refund.amount,v_invoice.amount_paid;
  END IF;

  SELECT id INTO v_period
  FROM finance.accounting_periods
  WHERE organization_id=v_org AND status='OPEN'
  ORDER BY start_date DESC LIMIT 1;
  IF v_period IS NULL THEN RAISE EXCEPTION 'No OPEN accounting period found'; END IF;

  SELECT linked_ledger_account_id INTO v_cash
  FROM finance.financial_accounts
  WHERE id=v_refund.financial_account_id AND organization_id=v_org AND is_active=true;
  IF v_cash IS NULL THEN RAISE EXCEPTION 'Refund financial account is missing, inactive, or not linked to a ledger account'; END IF;

  SELECT id INTO v_revenue FROM finance.chart_of_accounts
  WHERE code='4110' AND account_type='REVENUE' AND is_active=true AND organization_id=v_org LIMIT 1;
  IF v_revenue IS NULL THEN RAISE EXCEPTION 'Revenue account 4110 is not configured for this organization'; END IF;

  IF EXISTS (SELECT 1 FROM finance.journal_entries WHERE source_type='INVOICE_REFUND' AND source_id=p_refund_id AND organization_id=v_org) THEN
    RAISE EXCEPTION 'Refund is already posted';
  END IF;

  v_lines := jsonb_build_array(
    jsonb_build_object('account_id',v_revenue,'debit_amount',v_refund.amount,'credit_amount',0,'description','Refund: '||v_refund.refund_number),
    jsonb_build_object('account_id',v_cash,'debit_amount',0,'credit_amount',v_refund.amount,'description','Cash refund: '||v_refund.refund_number)
  );

  v_journal_id := finance.post_journal_entry(
    'Invoice refund '||v_refund.refund_number,
    current_date,v_period,v_lines,v_refund.currency,coalesce(v_refund.exchange_rate,1),'INVOICE_REFUND',p_refund_id,NULL,NULL
  );

  -- Do not rewrite invoice total_amount. The subledger balance is adjusted
  -- through outstanding_amount only, preserving the original billed amount.
  v_new_outstanding := greatest(0,coalesce(v_invoice.outstanding_amount,0)-v_refund.amount);
  v_new_base_outstanding := greatest(0,coalesce(v_invoice.base_outstanding_amount,0)-(v_refund.amount*coalesce(v_invoice.exchange_rate,1)));
  v_new_status := CASE WHEN v_new_outstanding <= 0.01 THEN 'REFUNDED' ELSE v_invoice.status END;

  UPDATE public.invoices
  SET outstanding_amount=v_new_outstanding,
      base_outstanding_amount=v_new_base_outstanding,
      status=v_new_status
  WHERE id=v_invoice.id AND organization_id=v_org;

  UPDATE finance.invoice_refunds
  SET status='POSTED',journal_entry_id=v_journal_id,posted_at=now(),updated_at=now()
  WHERE id=p_refund_id AND organization_id=v_org AND status='APPROVED';
  IF NOT FOUND THEN RAISE EXCEPTION 'Refund status update failed'; END IF;

  SELECT reference INTO v_reference FROM finance.journal_entries WHERE id=v_journal_id;
  RETURN jsonb_build_object('journal_id',v_journal_id,'reference',v_reference,'outstanding_amount',v_new_outstanding);
END;
$$;

REVOKE ALL ON FUNCTION finance.reverse_vendor_bill_atomic(uuid,date,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION finance.reverse_vendor_bill_atomic(uuid,date,text) TO authenticated;
REVOKE ALL ON FUNCTION finance.reverse_credit_note_atomic(uuid,date,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION finance.reverse_credit_note_atomic(uuid,date,text) TO authenticated;
REVOKE ALL ON FUNCTION finance.post_credit_note_atomic(uuid,uuid,date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION finance.post_credit_note_atomic(uuid,uuid,date) TO authenticated;
REVOKE ALL ON FUNCTION finance.post_invoice_refund_atomic(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION finance.post_invoice_refund_atomic(uuid) TO authenticated;

COMMIT;
