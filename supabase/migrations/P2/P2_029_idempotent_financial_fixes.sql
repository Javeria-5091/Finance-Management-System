-- AUD-P2-006..010
-- Atomic/idempotent financial command fixes. These functions deliberately
-- wrap the existing posting primitives so prior P2-001..005 fixes remain intact.


CREATE OR REPLACE FUNCTION finance.get_payment_receipt_idempotency(
  p_idempotency_key text,
  p_request_hash text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'pg_catalog','finance','public','core'
AS $$
DECLARE
  v_org uuid := core.current_user_org_id();
  v_existing core.idempotency_keys%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL OR v_org IS NULL THEN RAISE EXCEPTION 'Authentication and organization context are required'; END IF;
  IF p_idempotency_key IS NULL OR btrim(p_idempotency_key) = '' THEN RAISE EXCEPTION 'Idempotency-Key is required'; END IF;
  SELECT * INTO v_existing FROM core.idempotency_keys
   WHERE scope='PAYMENT_RECEIPT' AND key=p_idempotency_key AND organization_id=v_org;
  IF NOT FOUND THEN RETURN jsonb_build_object('exists',false); END IF;
  IF v_existing.request_hash IS DISTINCT FROM p_request_hash THEN
    RAISE EXCEPTION 'Idempotency-Key was already used with a different request';
  END IF;
  IF v_existing.response_snapshot IS NULL THEN
    RETURN jsonb_build_object('exists',true,'ready',false);
  END IF;
  RETURN v_existing.response_snapshot || jsonb_build_object('idempotent_replay',true);
END;
$$;

REVOKE ALL ON FUNCTION finance.get_payment_receipt_idempotency(text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION finance.get_payment_receipt_idempotency(text,text) TO authenticated;

CREATE OR REPLACE FUNCTION finance.post_payment_receipt_idempotent(
  p_client_id uuid,
  p_amount numeric,
  p_currency text DEFAULT 'PKR',
  p_exchange_rate numeric DEFAULT 1,
  p_payment_date date DEFAULT CURRENT_DATE,
  p_payment_method text DEFAULT 'BANK_TRANSFER',
  p_reference text DEFAULT NULL,
  p_financial_account_id uuid DEFAULT NULL,
  p_notes text DEFAULT NULL,
  p_allocations jsonb DEFAULT '[]'::jsonb,
  p_idempotency_key text DEFAULT NULL,
  p_request_hash text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'pg_catalog','finance','public','core'
AS $$
DECLARE
  v_org uuid := core.current_user_org_id();
  v_existing core.idempotency_keys%ROWTYPE;
  v_result jsonb;
BEGIN
  IF auth.uid() IS NULL OR v_org IS NULL THEN
    RAISE EXCEPTION 'Authentication and organization context are required';
  END IF;
  IF NOT (core.has_permission(auth.uid(), 'APPROVE_INVOICE') OR core.is_finance_head() OR core.has_role('ACCOUNTANT')) THEN
    RAISE EXCEPTION 'Insufficient privileges to record a payment receipt';
  END IF;
  IF p_idempotency_key IS NULL OR btrim(p_idempotency_key) = '' THEN
    RAISE EXCEPTION 'Idempotency-Key is required';
  END IF;
  IF length(p_idempotency_key) > 200 THEN
    RAISE EXCEPTION 'Idempotency-Key is too long';
  END IF;

  INSERT INTO core.idempotency_keys(scope, key, request_hash, organization_id)
  VALUES ('PAYMENT_RECEIPT', p_idempotency_key, p_request_hash, v_org)
  ON CONFLICT (scope, key, organization_id) DO NOTHING;

  SELECT * INTO v_existing
    FROM core.idempotency_keys
   WHERE scope = 'PAYMENT_RECEIPT'
     AND key = p_idempotency_key
     AND organization_id = v_org
   FOR UPDATE;

  IF v_existing.response_snapshot IS NOT NULL THEN
    IF v_existing.request_hash IS DISTINCT FROM p_request_hash THEN
      RAISE EXCEPTION 'Idempotency-Key was already used with a different request';
    END IF;
    RETURN v_existing.response_snapshot || jsonb_build_object('idempotent_replay', true);
  END IF;

  v_result := finance.post_payment_receipt_atomic(
    p_client_id, p_amount, p_currency, p_exchange_rate, p_payment_date,
    p_payment_method, p_reference, p_financial_account_id, p_notes, p_allocations
  );

  v_result := v_result || jsonb_build_object('idempotent_replay', false);
  UPDATE core.idempotency_keys
     SET response_snapshot = v_result
   WHERE id = v_existing.id;

  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION finance.approve_commission_atomic(
  p_commission_id uuid,
  p_period_id uuid,
  p_transaction_date date,
  p_description text,
  p_currency text,
  p_exchange_rate numeric,
  p_lines jsonb
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'pg_catalog','finance','public','core'
AS $$
DECLARE
  v_org uuid := core.current_user_org_id();
  v_comm public.commissions%ROWTYPE;
  v_period finance.accounting_periods%ROWTYPE;
  v_journal uuid;
BEGIN
  IF auth.uid() IS NULL OR v_org IS NULL THEN RAISE EXCEPTION 'Authentication and organization context are required'; END IF;
  IF NOT core.has_permission(auth.uid(), 'COMMISSION_APPROVE') THEN RAISE EXCEPTION 'COMMISSION_APPROVE permission required'; END IF;
  SELECT * INTO v_comm FROM public.commissions WHERE id=p_commission_id AND organization_id=v_org FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Commission not found in your organization'; END IF;
  IF v_comm.status <> 'PENDING' THEN RAISE EXCEPTION 'Only PENDING commissions can be approved'; END IF;
  IF v_comm.created_by = auth.uid() THEN RAISE EXCEPTION 'Maker-checker: requester cannot approve own commission'; END IF;
  IF v_comm.accrual_journal_id IS NOT NULL THEN RAISE EXCEPTION 'Commission accrual is already posted'; END IF;
  SELECT * INTO v_period FROM finance.accounting_periods WHERE id=p_period_id AND organization_id=v_org FOR SHARE;
  IF NOT FOUND OR v_period.status <> 'OPEN' THEN RAISE EXCEPTION 'Accounting period is not OPEN or does not belong to your organization'; END IF;
  IF p_lines IS NULL OR jsonb_typeof(p_lines) <> 'array' OR jsonb_array_length(p_lines)=0 THEN RAISE EXCEPTION 'Commission journal lines are required'; END IF;

  v_journal := finance.post_journal_entry(
    COALESCE(NULLIF(p_description,''),'Commission accrual'), p_transaction_date,
    p_period_id, p_lines, COALESCE(NULLIF(p_currency,''),'PKR'),
    COALESCE(p_exchange_rate,1), 'COMMISSION_ACCRUAL', p_commission_id, NULL, NULL
  );

  UPDATE public.commissions
     SET status='APPROVED', approved_by=auth.uid(), approved_at=now(), accrual_journal_id=v_journal, updated_at=now()
   WHERE id=p_commission_id AND organization_id=v_org AND status='PENDING' AND accrual_journal_id IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'Commission approval update failed; GL posting rolled back'; END IF;
  RETURN v_journal;
END;
$$;

CREATE OR REPLACE FUNCTION finance.pay_commission_atomic(
  p_commission_id uuid,
  p_period_id uuid,
  p_transaction_date date,
  p_financial_account_id uuid,
  p_payment_ref text,
  p_description text,
  p_currency text,
  p_exchange_rate numeric,
  p_lines jsonb
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'pg_catalog','finance','public','core'
AS $$
DECLARE
  v_org uuid := core.current_user_org_id();
  v_comm public.commissions%ROWTYPE;
  v_period finance.accounting_periods%ROWTYPE;
  v_account finance.financial_accounts%ROWTYPE;
  v_journal uuid;
BEGIN
  IF auth.uid() IS NULL OR v_org IS NULL THEN RAISE EXCEPTION 'Authentication and organization context are required'; END IF;
  IF NOT core.has_permission(auth.uid(), 'COMMISSION_APPROVE') THEN RAISE EXCEPTION 'COMMISSION_APPROVE permission required'; END IF;
  SELECT * INTO v_comm FROM public.commissions WHERE id=p_commission_id AND organization_id=v_org FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Commission not found in your organization'; END IF;
  IF v_comm.status <> 'APPROVED' THEN RAISE EXCEPTION 'Only APPROVED commissions can be paid'; END IF;
  IF v_comm.payment_journal_id IS NOT NULL THEN RAISE EXCEPTION 'Commission payment is already posted'; END IF;
  SELECT * INTO v_account FROM finance.financial_accounts WHERE id=p_financial_account_id AND organization_id=v_org AND is_active FOR SHARE;
  IF NOT FOUND OR v_account.linked_ledger_account_id IS NULL THEN RAISE EXCEPTION 'Financial account is missing, inactive, or has no linked GL account'; END IF;
  SELECT * INTO v_period FROM finance.accounting_periods WHERE id=p_period_id AND organization_id=v_org FOR SHARE;
  IF NOT FOUND OR v_period.status <> 'OPEN' THEN RAISE EXCEPTION 'Accounting period is not OPEN or does not belong to your organization'; END IF;
  IF p_lines IS NULL OR jsonb_typeof(p_lines) <> 'array' OR jsonb_array_length(p_lines)=0 THEN RAISE EXCEPTION 'Commission payment journal lines are required'; END IF;

  v_journal := finance.post_journal_entry(
    COALESCE(NULLIF(p_description,''),'Commission payment'), p_transaction_date,
    p_period_id, p_lines, COALESCE(NULLIF(p_currency,''),'PKR'),
    COALESCE(p_exchange_rate,1), 'COMMISSION_PAYMENT', p_commission_id, NULL, NULL
  );

  UPDATE public.commissions
     SET status='PAID', payment_date=p_transaction_date, payment_ref=p_payment_ref, payment_journal_id=v_journal, updated_at=now()
   WHERE id=p_commission_id AND organization_id=v_org AND status='APPROVED' AND payment_journal_id IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'Commission payment update failed; GL posting rolled back'; END IF;
  RETURN v_journal;
END;
$$;

CREATE OR REPLACE FUNCTION finance.post_capital_transaction_atomic(
  p_transaction_id uuid,
  p_period_id uuid
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'pg_catalog','finance','public','core'
AS $$
DECLARE
  v_org uuid := core.current_user_org_id();
  v_tx finance.capital_transactions%ROWTYPE;
  v_period finance.accounting_periods%ROWTYPE;
  v_fin finance.financial_accounts%ROWTYPE;
  v_equity finance.chart_of_accounts%ROWTYPE;
  v_journal uuid;
  v_amount numeric;
  v_lines jsonb;
BEGIN
  IF auth.uid() IS NULL OR v_org IS NULL THEN RAISE EXCEPTION 'Authentication and organization context are required'; END IF;
  IF NOT core.has_permission(auth.uid(), 'EQUITY_MANAGE') THEN RAISE EXCEPTION 'EQUITY_MANAGE permission required'; END IF;
  SELECT * INTO v_tx FROM finance.capital_transactions WHERE id=p_transaction_id AND organization_id=v_org FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Capital transaction not found'; END IF;
  IF v_tx.status <> 'APPROVED' THEN RAISE EXCEPTION 'Only APPROVED capital transactions can be posted. Current: %', v_tx.status; END IF;
  IF v_tx.journal_entry_id IS NOT NULL THEN RETURN v_tx.journal_entry_id; END IF;
  SELECT * INTO v_period FROM finance.accounting_periods WHERE id=p_period_id AND organization_id=v_org FOR SHARE;
  IF NOT FOUND OR v_period.status <> 'OPEN' THEN RAISE EXCEPTION 'Accounting period is not OPEN or does not belong to your organization'; END IF;
  SELECT * INTO v_fin FROM finance.financial_accounts WHERE id=v_tx.financial_account_id AND organization_id=v_org AND is_active FOR SHARE;
  IF NOT FOUND OR v_fin.linked_ledger_account_id IS NULL THEN RAISE EXCEPTION 'Bank/cash account is missing, inactive, or has no linked GL ledger account'; END IF;
  SELECT * INTO v_equity FROM finance.chart_of_accounts WHERE id=v_tx.equity_account_id AND organization_id=v_org AND is_active AND COALESCE(posting_allowed,true) FOR SHARE;
  IF NOT FOUND OR v_equity.account_type NOT IN ('EQUITY','LIABILITY') THEN RAISE EXCEPTION 'Equity/loan account is missing, inactive, or not postable'; END IF;
  v_amount := v_tx.amount;
  IF v_tx.transaction_type IN ('CAPITAL_CONTRIBUTION','OWNER_LOAN_ADVANCE') THEN
    v_lines := jsonb_build_array(
      jsonb_build_object('account_id',v_fin.linked_ledger_account_id,'debit_amount',v_amount,'credit_amount',0,'description',v_tx.transaction_type||': cash leg'),
      jsonb_build_object('account_id',v_equity.id,'debit_amount',0,'credit_amount',v_amount,'description',v_tx.transaction_type||': equity leg')
    );
  ELSE
    v_lines := jsonb_build_array(
      jsonb_build_object('account_id',v_equity.id,'debit_amount',v_amount,'credit_amount',0,'description',v_tx.transaction_type||': equity leg'),
      jsonb_build_object('account_id',v_fin.linked_ledger_account_id,'debit_amount',0,'credit_amount',v_amount,'description',v_tx.transaction_type||': cash leg')
    );
  END IF;
  v_journal := finance.post_journal_entry(COALESCE(NULLIF(v_tx.description,''),'Capital transaction: '||v_tx.transaction_type),v_tx.transaction_date,p_period_id,v_lines,COALESCE(v_tx.currency,'PKR'),1,'CAPITAL_TRANSACTION',p_transaction_id,NULL,NULL);
  UPDATE finance.capital_transactions
     SET status='POSTED', journal_entry_id=v_journal, posted_by=auth.uid(), posted_at=now(), updated_at=now()
   WHERE id=p_transaction_id AND organization_id=v_org AND status='APPROVED' AND journal_entry_id IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'Capital transaction status update failed; GL posting rolled back'; END IF;
  RETURN v_journal;
END;
$$;

CREATE OR REPLACE FUNCTION finance.create_vendor_payment_atomic(
  p_vendor_id uuid,
  p_payment_date date,
  p_payment_method text,
  p_financial_account_id uuid,
  p_reference text,
  p_description text,
  p_allocations jsonb
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'pg_catalog','finance','public','core'
AS $$
DECLARE
  v_org uuid := core.current_user_org_id();
  v_vendor finance.vendors%ROWTYPE;
  v_fin finance.financial_accounts%ROWTYPE;
  v_bill finance.vendor_bills%ROWTYPE;
  v_alloc jsonb;
  v_bill_id uuid;
  v_alloc_amount numeric(18,2);
  v_total numeric(18,2) := 0;
  v_currency text;
  v_rate numeric(18,4) := 1;
  v_payment_id uuid;
  v_payment_number text;
BEGIN
  IF auth.uid() IS NULL OR v_org IS NULL THEN RAISE EXCEPTION 'Authentication and organization context are required'; END IF;
  IF NOT core.has_permission(auth.uid(), 'VENDOR_PAYMENT_CREATE') THEN RAISE EXCEPTION 'VENDOR_PAYMENT_CREATE permission required'; END IF;
  IF p_allocations IS NULL OR jsonb_typeof(p_allocations) <> 'array' OR jsonb_array_length(p_allocations)=0 THEN RAISE EXCEPTION 'At least one allocation is required'; END IF;
  SELECT * INTO v_vendor FROM finance.vendors WHERE id=p_vendor_id AND organization_id=v_org AND is_active FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Vendor not found or inactive'; END IF;
  IF p_financial_account_id IS NOT NULL THEN
    SELECT * INTO v_fin FROM finance.financial_accounts WHERE id=p_financial_account_id AND organization_id=v_org AND is_active FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Financial account not found or inactive'; END IF;
  END IF;

  FOR v_alloc IN SELECT * FROM jsonb_array_elements(p_allocations) LOOP
    v_bill_id := (v_alloc->>'vendor_bill_id')::uuid;
    v_alloc_amount := round((v_alloc->>'allocated_amount')::numeric,2);
    SELECT * INTO v_bill FROM finance.vendor_bills WHERE id=v_bill_id AND organization_id=v_org AND vendor_id=p_vendor_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Vendor bill % not found in your organization',v_bill_id; END IF;
    IF v_bill.status NOT IN ('POSTED','PARTIALLY_PAID') OR COALESCE(v_bill.outstanding_amount,0) <= 0 THEN RAISE EXCEPTION 'Vendor bill % is not payable in its current state',v_bill.bill_number; END IF;
    IF v_alloc_amount <= 0 OR v_alloc_amount > v_bill.outstanding_amount + 0.01 THEN RAISE EXCEPTION 'Allocation exceeds outstanding balance for bill %',v_bill.bill_number; END IF;
    IF v_currency IS NULL THEN v_currency := upper(COALESCE(v_bill.currency,'PKR')); ELSE IF v_currency <> upper(COALESCE(v_bill.currency,'PKR')) THEN RAISE EXCEPTION 'All allocated bills must share the same currency'; END IF; END IF;
    v_total := v_total + v_alloc_amount;
  END LOOP;
  v_total := round(v_total,2);
  IF v_total <= 0 THEN RAISE EXCEPTION 'Payment amount must be greater than zero'; END IF;

  IF v_currency <> 'PKR' THEN
    SELECT rate INTO v_rate FROM finance.exchange_rates
     WHERE organization_id=v_org AND from_currency=v_currency AND to_currency='PKR'
       AND approved_by IS NOT NULL AND is_locked=true AND rate_date <= p_payment_date
     ORDER BY rate_date DESC, approved_at DESC NULLS LAST LIMIT 1;
    IF v_rate IS NULL OR v_rate <= 0 THEN RAISE EXCEPTION 'No approved and locked exchange rate found for % -> PKR on or before %',v_currency,p_payment_date; END IF;
  END IF;

  v_payment_number := finance.get_next_number('VENDOR_PAYMENT',v_org);
  IF v_payment_number IS NULL THEN v_payment_number := 'VP-'||to_char(clock_timestamp(),'YYYYMMDDHH24MISSMS'); END IF;
  INSERT INTO finance.vendor_payments(payment_number,payment_date,amount,currency,exchange_rate,base_amount,vendor_id,financial_account_id,payment_method,reference,description,status,is_batch,created_by,organization_id)
  VALUES(v_payment_number,p_payment_date,v_total,v_currency,v_rate,round(v_total*v_rate,2),p_vendor_id,p_financial_account_id,p_payment_method,p_reference,p_description,'DRAFT',false,auth.uid(),v_org)
  RETURNING id INTO v_payment_id;

  FOR v_alloc IN SELECT * FROM jsonb_array_elements(p_allocations) LOOP
    v_bill_id := (v_alloc->>'vendor_bill_id')::uuid;
    v_alloc_amount := round((v_alloc->>'allocated_amount')::numeric,2);
    INSERT INTO finance.vendor_payment_allocations(vendor_payment_id,vendor_bill_id,allocated_amount,base_allocated_amount,allocated_by)
    VALUES(v_payment_id,v_bill_id,v_alloc_amount,round(v_alloc_amount*v_rate,2),auth.uid());
  END LOOP;

  RETURN jsonb_build_object('payment_id',v_payment_id,'payment_number',v_payment_number,'amount',v_total,'currency',v_currency,'exchange_rate',v_rate,'base_amount',round(v_total*v_rate,2));
END;
$$;

CREATE OR REPLACE FUNCTION finance.create_profit_distribution_from_posted_pnl(
  p_fiscal_year_id uuid
) RETURNS finance.profit_distributions
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'pg_catalog','finance','public','core'
AS $$
DECLARE
  v_org uuid := core.current_user_org_id();
  v_revenue numeric := 0;
  v_expense numeric := 0;
  v_profit numeric(18,2);
  v_reserve numeric(18,2);
  v_dist finance.profit_distributions%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL OR v_org IS NULL THEN RAISE EXCEPTION 'Authentication and organization context are required'; END IF;
  IF NOT core.has_permission(auth.uid(),'EQUITY_MANAGE') THEN RAISE EXCEPTION 'EQUITY_MANAGE permission required'; END IF;
  IF NOT EXISTS (SELECT 1 FROM finance.fiscal_years WHERE id=p_fiscal_year_id AND organization_id=v_org) THEN RAISE EXCEPTION 'Fiscal year not found in your organization'; END IF;
  SELECT COALESCE(sum(balance),0) INTO v_revenue FROM finance.get_pnl_accounts(p_fiscal_year_id,v_org,'REVENUE');
  SELECT COALESCE(sum(balance),0) INTO v_expense FROM finance.get_pnl_accounts(p_fiscal_year_id,v_org,'EXPENSE');
  v_profit := round(v_revenue - v_expense,2);
  IF v_profit < 0 THEN RAISE EXCEPTION 'Posted P&L is a loss (%); profit distribution cannot be created',v_profit; END IF;
  v_reserve := round(COALESCE(finance.calculate_reserve(v_profit,CURRENT_DATE,v_org),0),2);
  v_reserve := LEAST(GREATEST(v_reserve,0),v_profit);

  INSERT INTO finance.profit_distributions(fiscal_year_id,total_available_profit,reserve_amount,distributable_amount,status,created_by,organization_id)
  VALUES(p_fiscal_year_id,v_profit,v_reserve,round(v_profit-v_reserve,2),'DRAFT',auth.uid(),v_org)
  RETURNING * INTO v_dist;
  RETURN v_dist;
END;
$$;

REVOKE ALL ON FUNCTION finance.post_payment_receipt_idempotent(uuid,numeric,text,numeric,date,text,text,uuid,text,jsonb,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION finance.post_payment_receipt_idempotent(uuid,numeric,text,numeric,date,text,text,uuid,text,jsonb,text,text) TO authenticated;
REVOKE ALL ON FUNCTION finance.approve_commission_atomic(uuid,uuid,date,text,text,numeric,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION finance.approve_commission_atomic(uuid,uuid,date,text,text,numeric,jsonb) TO authenticated;
REVOKE ALL ON FUNCTION finance.pay_commission_atomic(uuid,uuid,date,uuid,text,text,text,numeric,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION finance.pay_commission_atomic(uuid,uuid,date,uuid,text,text,text,numeric,jsonb) TO authenticated;
REVOKE ALL ON FUNCTION finance.post_capital_transaction_atomic(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION finance.post_capital_transaction_atomic(uuid,uuid) TO authenticated;
REVOKE ALL ON FUNCTION finance.create_vendor_payment_atomic(uuid,date,text,uuid,text,text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION finance.create_vendor_payment_atomic(uuid,date,text,uuid,text,text,jsonb) TO authenticated;
REVOKE ALL ON FUNCTION finance.create_profit_distribution_from_posted_pnl(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION finance.create_profit_distribution_from_posted_pnl(uuid) TO authenticated;
