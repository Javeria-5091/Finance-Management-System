BEGIN;

-- P2-007: atomic commission commands must independently reject unapproved/unlocked FX,
-- even when called directly instead of through the API.
CREATE OR REPLACE FUNCTION finance.approve_commission_atomic(
  p_commission_id uuid,p_period_id uuid,p_transaction_date date,p_description text,
  p_currency text,p_exchange_rate numeric,p_lines jsonb
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO pg_catalog,finance,public,core AS $$
DECLARE v_org uuid:=core.current_user_org_id(); v_comm public.commissions%ROWTYPE; v_period finance.accounting_periods%ROWTYPE; v_journal uuid;
BEGIN
 IF auth.uid() IS NULL OR v_org IS NULL THEN RAISE EXCEPTION 'Authentication and organization context are required'; END IF;
 IF NOT core.has_permission(auth.uid(),'COMMISSION_APPROVE') THEN RAISE EXCEPTION 'COMMISSION_APPROVE permission required'; END IF;
 SELECT * INTO v_comm FROM public.commissions WHERE id=p_commission_id AND organization_id=v_org FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Commission not found in your organization'; END IF;
 IF v_comm.status<>'PENDING' OR v_comm.accrual_journal_id IS NOT NULL THEN RAISE EXCEPTION 'Commission is not pending or was already accrued'; END IF;
 IF v_comm.created_by=auth.uid() THEN RAISE EXCEPTION 'Maker-checker: requester cannot approve own commission'; END IF;
 SELECT * INTO v_period FROM finance.accounting_periods WHERE id=p_period_id AND organization_id=v_org FOR SHARE;
 IF NOT FOUND OR v_period.status<>'OPEN' THEN RAISE EXCEPTION 'Accounting period is not OPEN'; END IF;
 IF upper(coalesce(p_currency,'PKR'))<>'PKR' AND NOT EXISTS(SELECT 1 FROM finance.exchange_rates WHERE organization_id=v_org AND from_currency=upper(p_currency) AND to_currency='PKR' AND rate=p_exchange_rate AND approved_by IS NOT NULL AND is_locked=true AND rate_date<=p_transaction_date) THEN RAISE EXCEPTION 'Exchange rate is not approved and locked for this organization/date'; END IF;
 IF p_exchange_rate IS NULL OR p_exchange_rate<=0 THEN RAISE EXCEPTION 'Exchange rate must be positive'; END IF;
 IF p_lines IS NULL OR jsonb_typeof(p_lines)<>'array' OR jsonb_array_length(p_lines)=0 THEN RAISE EXCEPTION 'Commission journal lines are required'; END IF;
 v_journal:=finance.post_journal_entry(coalesce(nullif(p_description,''),'Commission accrual'),p_transaction_date,p_period_id,p_lines,coalesce(nullif(p_currency,''),'PKR'),p_exchange_rate,'COMMISSION_ACCRUAL',p_commission_id,NULL,NULL);
 UPDATE public.commissions SET status='APPROVED',approved_by=auth.uid(),approved_at=now(),accrual_journal_id=v_journal,updated_at=now() WHERE id=p_commission_id AND organization_id=v_org AND status='PENDING' AND accrual_journal_id IS NULL;
 IF NOT FOUND THEN RAISE EXCEPTION 'Commission approval update failed; GL posting rolled back'; END IF;
 RETURN v_journal;
END; $$;

CREATE OR REPLACE FUNCTION finance.pay_commission_atomic(
  p_commission_id uuid,p_period_id uuid,p_transaction_date date,p_financial_account_id uuid,
  p_payment_ref text,p_description text,p_currency text,p_exchange_rate numeric,p_lines jsonb
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO pg_catalog,finance,public,core AS $$
DECLARE v_org uuid:=core.current_user_org_id(); v_comm public.commissions%ROWTYPE; v_period finance.accounting_periods%ROWTYPE; v_account finance.financial_accounts%ROWTYPE; v_journal uuid;
BEGIN
 IF auth.uid() IS NULL OR v_org IS NULL THEN RAISE EXCEPTION 'Authentication and organization context are required'; END IF;
 IF NOT core.has_permission(auth.uid(),'COMMISSION_APPROVE') THEN RAISE EXCEPTION 'COMMISSION_APPROVE permission required'; END IF;
 SELECT * INTO v_comm FROM public.commissions WHERE id=p_commission_id AND organization_id=v_org FOR UPDATE;
 IF NOT FOUND OR v_comm.status<>'APPROVED' OR v_comm.payment_journal_id IS NOT NULL THEN RAISE EXCEPTION 'Commission is not payable or was already paid'; END IF;
 SELECT * INTO v_account FROM finance.financial_accounts WHERE id=p_financial_account_id AND organization_id=v_org AND is_active=true FOR SHARE;
 IF NOT FOUND OR v_account.linked_ledger_account_id IS NULL THEN RAISE EXCEPTION 'Financial account is invalid or has no linked GL account'; END IF;
 SELECT * INTO v_period FROM finance.accounting_periods WHERE id=p_period_id AND organization_id=v_org FOR SHARE;
 IF NOT FOUND OR v_period.status<>'OPEN' THEN RAISE EXCEPTION 'Accounting period is not OPEN'; END IF;
 IF upper(coalesce(p_currency,'PKR'))<>'PKR' AND NOT EXISTS(SELECT 1 FROM finance.exchange_rates WHERE organization_id=v_org AND from_currency=upper(p_currency) AND to_currency='PKR' AND rate=p_exchange_rate AND approved_by IS NOT NULL AND is_locked=true AND rate_date<=p_transaction_date) THEN RAISE EXCEPTION 'Exchange rate is not approved and locked for this organization/date'; END IF;
 IF p_exchange_rate IS NULL OR p_exchange_rate<=0 THEN RAISE EXCEPTION 'Exchange rate must be positive'; END IF;
 IF p_lines IS NULL OR jsonb_typeof(p_lines)<>'array' OR jsonb_array_length(p_lines)=0 THEN RAISE EXCEPTION 'Commission payment journal lines are required'; END IF;
 v_journal:=finance.post_journal_entry(coalesce(nullif(p_description,''),'Commission payment'),p_transaction_date,p_period_id,p_lines,coalesce(nullif(p_currency,''),'PKR'),p_exchange_rate,'COMMISSION_PAYMENT',p_commission_id,NULL,NULL);
 UPDATE public.commissions SET status='PAID',payment_date=p_transaction_date,payment_ref=p_payment_ref,payment_journal_id=v_journal,updated_at=now() WHERE id=p_commission_id AND organization_id=v_org AND status='APPROVED' AND payment_journal_id IS NULL;
 IF NOT FOUND THEN RAISE EXCEPTION 'Commission payment update failed; GL posting rolled back'; END IF;
 RETURN v_journal;
END; $$;

-- P2-010: replace the duplicate-allocation validation hole with bill-level aggregation.
CREATE OR REPLACE FUNCTION finance.create_vendor_payment_atomic(
  p_vendor_id uuid,p_payment_date date,p_payment_method text,p_financial_account_id uuid,
  p_reference text,p_description text,p_allocations jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO pg_catalog,finance,public,core AS $$
DECLARE v_org uuid:=core.current_user_org_id(); v_vendor finance.vendors%ROWTYPE; v_fin finance.financial_accounts%ROWTYPE;
 v_bill finance.vendor_bills%ROWTYPE; v_item record; v_total numeric(18,2):=0; v_currency text; v_rate numeric(18,4):=1; v_payment_id uuid; v_payment_number text;
BEGIN
 IF auth.uid() IS NULL OR v_org IS NULL THEN RAISE EXCEPTION 'Authentication and organization context are required'; END IF;
 IF NOT core.has_permission(auth.uid(),'VENDOR_PAYMENT_CREATE') THEN RAISE EXCEPTION 'VENDOR_PAYMENT_CREATE permission required'; END IF;
 IF p_allocations IS NULL OR jsonb_typeof(p_allocations)<>'array' OR jsonb_array_length(p_allocations)=0 THEN RAISE EXCEPTION 'At least one allocation is required'; END IF;
 SELECT * INTO v_vendor FROM finance.vendors WHERE id=p_vendor_id AND organization_id=v_org AND is_active FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Vendor not found or inactive'; END IF;
 IF p_financial_account_id IS NOT NULL THEN SELECT * INTO v_fin FROM finance.financial_accounts WHERE id=p_financial_account_id AND organization_id=v_org AND is_active FOR SHARE; IF NOT FOUND THEN RAISE EXCEPTION 'Financial account not found or inactive'; END IF; END IF;
 FOR v_item IN SELECT (x->>'vendor_bill_id')::uuid bill_id, round((x->>'allocated_amount')::numeric,2) alloc_amount FROM jsonb_array_elements(p_allocations) x LOOP
   IF v_item.alloc_amount<=0 THEN RAISE EXCEPTION 'Allocation must be greater than zero'; END IF;
 END LOOP;
 FOR v_item IN SELECT (x->>'vendor_bill_id')::uuid bill_id, round(sum((x->>'allocated_amount')::numeric),2) alloc_amount FROM jsonb_array_elements(p_allocations) x GROUP BY (x->>'vendor_bill_id')::uuid LOOP
   SELECT * INTO v_bill FROM finance.vendor_bills WHERE id=v_item.bill_id AND organization_id=v_org AND vendor_id=p_vendor_id FOR UPDATE;
   IF NOT FOUND THEN RAISE EXCEPTION 'Vendor bill % not found in your organization',v_item.bill_id; END IF;
   IF v_bill.status NOT IN ('POSTED','PARTIALLY_PAID') OR coalesce(v_bill.outstanding_amount,0)<=0 THEN RAISE EXCEPTION 'Vendor bill % is not payable',v_bill.bill_number; END IF;
   IF v_item.alloc_amount>v_bill.outstanding_amount+0.01 THEN RAISE EXCEPTION 'Allocation exceeds outstanding balance for bill %',v_bill.bill_number; END IF;
   IF v_currency IS NULL THEN v_currency=upper(coalesce(v_bill.currency,'PKR')); ELSIF v_currency<>upper(coalesce(v_bill.currency,'PKR')) THEN RAISE EXCEPTION 'All allocated bills must share the same currency'; END IF;
   v_total:=v_total+v_item.alloc_amount;
 END LOOP;
 v_total:=round(v_total,2); IF v_total<=0 THEN RAISE EXCEPTION 'Payment amount must be greater than zero'; END IF;
 IF v_currency<>'PKR' THEN SELECT rate INTO v_rate FROM finance.exchange_rates WHERE organization_id=v_org AND from_currency=v_currency AND to_currency='PKR' AND approved_by IS NOT NULL AND is_locked=true AND rate_date<=p_payment_date ORDER BY rate_date DESC,approved_at DESC NULLS LAST LIMIT 1; IF v_rate IS NULL OR v_rate<=0 THEN RAISE EXCEPTION 'No approved and locked exchange rate found for % -> PKR on or before %',v_currency,p_payment_date; END IF; END IF;
 v_payment_number:=finance.get_next_number('VENDOR_PAYMENT',v_org); IF v_payment_number IS NULL THEN v_payment_number='VP-'||to_char(clock_timestamp(),'YYYYMMDDHH24MISSMS'); END IF;
 INSERT INTO finance.vendor_payments(payment_number,payment_date,amount,currency,exchange_rate,base_amount,vendor_id,financial_account_id,payment_method,reference,description,status,is_batch,created_by,organization_id) VALUES(v_payment_number,p_payment_date,v_total,v_currency,v_rate,round(v_total*v_rate,2),p_vendor_id,p_financial_account_id,p_payment_method,p_reference,p_description,'DRAFT',false,auth.uid(),v_org) RETURNING id INTO v_payment_id;
 FOR v_item IN SELECT (x->>'vendor_bill_id')::uuid bill_id, round((x->>'allocated_amount')::numeric,2) alloc_amount FROM jsonb_array_elements(p_allocations) x LOOP
   INSERT INTO finance.vendor_payment_allocations(vendor_payment_id,vendor_bill_id,allocated_amount,base_allocated_amount,allocated_by) VALUES(v_payment_id,v_item.bill_id,v_item.alloc_amount,round(v_item.alloc_amount*v_rate,2),auth.uid());
 END LOOP;
 RETURN jsonb_build_object('payment_id',v_payment_id,'payment_number',v_payment_number,'amount',v_total,'currency',v_currency,'exchange_rate',v_rate,'base_amount',round(v_total*v_rate,2));
END; $$;

-- P2-022: make employee identity unique per organization at the database level.
CREATE UNIQUE INDEX IF NOT EXISTS uq_shared_people_org_external_reference ON core.shared_people(organization_id,external_reference) WHERE external_reference IS NOT NULL AND person_type='EMPLOYEE';

COMMIT;
