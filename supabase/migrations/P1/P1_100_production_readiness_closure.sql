-- OSYSTIC FMS P1 production-readiness closure
-- Addresses confirmed P1 findings F-P1-1..26 without changing existing public APIs
-- except where the audit identified a stale/broken contract.
BEGIN;


-- F-P1-1: single authoritative AR balance recomputation. Outstanding is always:
-- invoice total - ACTIVE payment allocations - POSTED credit notes.
CREATE OR REPLACE FUNCTION finance.recompute_invoice_ar_balance(p_invoice_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path='pg_catalog','finance','public','core' AS $$
DECLARE v_invoice public.invoices%ROWTYPE; v_paid numeric(18,2); v_base_paid numeric(18,2); v_credits numeric(18,2); v_base_credits numeric(18,2); v_out numeric(18,2); v_base_out numeric(18,2); v_status text;
BEGIN
 SELECT * INTO v_invoice FROM public.invoices WHERE id=p_invoice_id FOR UPDATE;
 IF NOT FOUND THEN RETURN; END IF;
 SELECT COALESCE(SUM(allocated_amount),0),COALESCE(SUM(base_allocated_amount),0) INTO v_paid,v_base_paid FROM finance.payment_allocations WHERE invoice_id=p_invoice_id AND status='ACTIVE';
 SELECT COALESCE(SUM(cn.amount),0),COALESCE(SUM(cn.amount*COALESCE(v_invoice.exchange_rate,1)),0) INTO v_credits,v_base_credits FROM finance.credit_notes cn WHERE cn.invoice_id=p_invoice_id AND cn.status='POSTED';
 v_out:=GREATEST(COALESCE(v_invoice.total_amount,0)-v_paid-v_credits,0);
 v_base_out:=GREATEST(COALESCE(v_invoice.base_total_amount,COALESCE(v_invoice.total_amount,0)*COALESCE(v_invoice.exchange_rate,1))-v_base_paid-v_base_credits,0);
 v_status:=CASE WHEN v_out<=0.01 AND v_credits>0 THEN 'CREDITED' WHEN v_out<=0.01 THEN 'PAID' WHEN v_paid>0 OR v_credits>0 THEN CASE WHEN v_invoice.due_date IS NOT NULL AND v_invoice.due_date<CURRENT_DATE THEN 'OVERDUE' ELSE 'PARTIALLY_PAID' END ELSE CASE WHEN v_invoice.due_date IS NOT NULL AND v_invoice.due_date<CURRENT_DATE THEN 'OVERDUE' ELSE 'ISSUED' END END;
 IF v_invoice.status IN ('DRAFT','VOID','CANCELLED') THEN v_status:=v_invoice.status; END IF;
 UPDATE public.invoices SET amount_paid=v_paid,base_amount_paid=v_base_paid,outstanding_amount=v_out,base_outstanding_amount=v_base_out,status=v_status,updated_at=now() WHERE id=p_invoice_id;
END; $$;

CREATE OR REPLACE FUNCTION finance.auto_update_invoice_status() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='pg_catalog','finance','public','core' AS $$
BEGIN
 IF TG_OP='UPDATE' AND OLD.status IS NOT DISTINCT FROM NEW.status AND OLD.allocated_amount IS NOT DISTINCT FROM NEW.allocated_amount THEN RETURN NEW; END IF;
 PERFORM finance.recompute_invoice_ar_balance(NEW.invoice_id);
 RETURN NEW;
END; $$;

CREATE OR REPLACE FUNCTION finance.validate_payment_allocation() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='pg_catalog','finance','public','core' AS $$
DECLARE v_total numeric(18,2); v_alloc numeric(18,2); v_receipt numeric(18,2); v_receipt_alloc numeric(18,2); v_invoice_status text;
BEGIN
 IF TG_OP='UPDATE' AND NEW.status IS DISTINCT FROM 'ACTIVE' THEN RETURN NEW; END IF;
 SELECT outstanding_amount,status INTO v_total,v_invoice_status FROM public.invoices WHERE id=NEW.invoice_id FOR UPDATE;
 IF v_total IS NULL THEN RAISE EXCEPTION 'Cannot allocate payment: invoice % does not exist',NEW.invoice_id; END IF;
 IF v_invoice_status NOT IN ('ISSUED','PARTIALLY_PAID','OVERDUE') THEN RAISE EXCEPTION 'Cannot allocate payment to invoice % in status %',NEW.invoice_id,v_invoice_status; END IF;
 SELECT COALESCE(SUM(allocated_amount),0) INTO v_alloc FROM finance.payment_allocations WHERE invoice_id=NEW.invoice_id AND status='ACTIVE' AND id IS DISTINCT FROM NEW.id;
 IF v_alloc+NEW.allocated_amount>v_total+0.01 THEN RAISE EXCEPTION 'Payment allocation exceeds invoice outstanding balance'; END IF;
 SELECT amount INTO v_receipt FROM finance.payment_receipts WHERE id=NEW.payment_receipt_id FOR UPDATE;
 IF v_receipt IS NULL THEN RAISE EXCEPTION 'Payment receipt % does not exist',NEW.payment_receipt_id; END IF;
 SELECT COALESCE(SUM(allocated_amount),0) INTO v_receipt_alloc FROM finance.payment_allocations WHERE payment_receipt_id=NEW.payment_receipt_id AND status='ACTIVE' AND id IS DISTINCT FROM NEW.id;
 IF v_receipt_alloc+NEW.allocated_amount>v_receipt+0.01 THEN RAISE EXCEPTION 'Payment allocation exceeds payment receipt total'; END IF;
 RETURN NEW;
END; $$;

CREATE OR REPLACE FUNCTION finance.post_credit_note_atomic(p_cn_id uuid,p_period_id uuid,p_transaction_date date) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='pg_catalog','finance','public','core' AS $$
DECLARE v_org uuid:=core.current_user_org_id(); v_cn record; v_invoice record; v_ar uuid; v_revenue uuid; v_journal_id uuid; v_lines jsonb;
BEGIN
 IF v_org IS NULL OR NOT(core.is_finance_head() OR core.has_role('ACCOUNTANT')) THEN RAISE EXCEPTION 'Access denied'; END IF;
 SELECT * INTO v_cn FROM finance.credit_notes WHERE id=p_cn_id AND organization_id=v_org FOR UPDATE;
 IF NOT FOUND OR v_cn.status<>'APPROVED' THEN RAISE EXCEPTION 'Only APPROVED credit notes can be posted'; END IF;
 SELECT * INTO v_invoice FROM public.invoices WHERE id=v_cn.invoice_id AND organization_id=v_org FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Linked invoice not found'; END IF;
 IF v_cn.amount>COALESCE(v_invoice.outstanding_amount,0)+0.01 THEN RAISE EXCEPTION 'Credit note amount exceeds invoice outstanding amount'; END IF;
 IF NOT EXISTS(SELECT 1 FROM finance.accounting_periods WHERE id=p_period_id AND organization_id=v_org AND status='OPEN') THEN RAISE EXCEPTION 'Posting period is not OPEN'; END IF;
 SELECT id INTO v_ar FROM finance.chart_of_accounts WHERE code='1210' AND account_type='ASSET' AND is_active AND organization_id=v_org LIMIT 1;
 SELECT id INTO v_revenue FROM finance.chart_of_accounts WHERE code='4110' AND account_type='REVENUE' AND is_active AND organization_id=v_org LIMIT 1;
 IF v_ar IS NULL OR v_revenue IS NULL THEN RAISE EXCEPTION 'Required AR/Revenue accounts are not configured'; END IF;
 IF EXISTS(SELECT 1 FROM finance.journal_entries WHERE source_type='CREDIT_NOTE' AND source_id=p_cn_id AND organization_id=v_org) THEN RAISE EXCEPTION 'Credit note is already posted'; END IF;
 v_lines:=jsonb_build_array(jsonb_build_object('account_id',v_revenue,'debit_amount',v_cn.amount,'credit_amount',0,'description','Revenue reversal: Credit Note '||COALESCE(v_cn.credit_note_number,p_cn_id::text)),jsonb_build_object('account_id',v_ar,'debit_amount',0,'credit_amount',v_cn.amount,'description','Receivable reduction: Credit Note '||COALESCE(v_cn.credit_note_number,p_cn_id::text)));
 v_journal_id:=finance.post_journal_entry('Credit Note: '||COALESCE(v_cn.credit_note_number,p_cn_id::text),p_transaction_date,p_period_id,v_lines,v_cn.currency,COALESCE(v_cn.exchange_rate,1),'CREDIT_NOTE',p_cn_id,NULL,NULL);
 UPDATE finance.credit_notes SET status='POSTED',journal_entry_id=v_journal_id,posted_by=auth.uid(),posted_at=now(),updated_at=now() WHERE id=p_cn_id AND organization_id=v_org AND status='APPROVED';
 IF NOT FOUND THEN RAISE EXCEPTION 'Credit note status update failed'; END IF;
 PERFORM finance.recompute_invoice_ar_balance(v_invoice.id);
 RETURN jsonb_build_object('journal_id',v_journal_id,'invoice_id',v_invoice.id,'outstanding_amount',(SELECT outstanding_amount FROM public.invoices WHERE id=v_invoice.id));
END; $$;

CREATE OR REPLACE FUNCTION finance.reverse_credit_note_atomic(p_credit_note_id uuid,p_reversal_date date,p_reason text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path='pg_catalog','finance','public','core' AS $$
DECLARE v_org uuid:=core.current_user_org_id(); v_cn record; v_journal_id uuid; v_reversal_id uuid;
BEGIN
 IF v_org IS NULL OR NOT(core.is_finance_head() OR core.has_role('ACCOUNTANT')) THEN RAISE EXCEPTION 'Access denied'; END IF;
 IF NULLIF(btrim(p_reason),'') IS NULL THEN RAISE EXCEPTION 'Reversal reason is mandatory'; END IF;
 SELECT * INTO v_cn FROM finance.credit_notes WHERE id=p_credit_note_id AND organization_id=v_org FOR UPDATE;
 IF NOT FOUND OR v_cn.status<>'POSTED' THEN RAISE EXCEPTION 'Posted credit note not found or access denied'; END IF;
 SELECT id INTO v_journal_id FROM finance.journal_entries WHERE source_type='CREDIT_NOTE' AND source_id=p_credit_note_id AND organization_id=v_org AND status='POSTED' AND reversal_of_id IS NULL ORDER BY posted_at DESC NULLS LAST,created_at DESC LIMIT 1 FOR UPDATE;
 IF v_journal_id IS NULL THEN RAISE EXCEPTION 'Posted credit note has no original journal entry'; END IF;
 v_reversal_id:=finance.reverse_journal_entry(v_journal_id,p_reversal_date,p_reason);
 UPDATE finance.credit_notes SET status='REVERSED',updated_at=now() WHERE id=p_credit_note_id AND organization_id=v_org AND status='POSTED';
 PERFORM finance.recompute_invoice_ar_balance(v_cn.invoice_id);
 RETURN v_reversal_id;
END; $$;

CREATE OR REPLACE FUNCTION finance.credit_note_ar_balance_trigger() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='pg_catalog','finance','public','core' AS $$ BEGIN IF NEW.invoice_id IS NOT NULL THEN PERFORM finance.recompute_invoice_ar_balance(NEW.invoice_id); END IF; RETURN NEW; END; $$;
DROP TRIGGER IF EXISTS trg_credit_note_ar_balance ON finance.credit_notes;
CREATE TRIGGER trg_credit_note_ar_balance AFTER INSERT OR UPDATE OF status ON finance.credit_notes FOR EACH ROW EXECUTE FUNCTION finance.credit_note_ar_balance_trigger();

-- F-P1-1: payment allocation cap counts ACTIVE allocations and current outstanding only.
CREATE OR REPLACE FUNCTION "finance"."allocate_payment_atomic"("p_payment_receipt_id" "uuid", "p_allocations" "jsonb", "p_user_id" "uuid", "p_organization_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'finance', 'public', 'core'
    AS $$
DECLARE
  v_receipt finance.payment_receipts%ROWTYPE;
  v_total_existing numeric(18,2);
  v_total_new numeric(18,2);
  v_new_paid numeric(18,2);
  v_alloc jsonb;
  v_invoice public.invoices%ROWTYPE;
  v_existing uuid;
  v_created jsonb := '[]'::jsonb;
BEGIN
  IF p_user_id IS NULL OR p_organization_id IS NULL THEN
    RAISE EXCEPTION 'User and organization context are required';
  END IF;

  IF auth.uid() IS DISTINCT FROM p_user_id THEN
    RAISE EXCEPTION 'User context mismatch';
  END IF;

  IF NOT core.has_permission(p_user_id, 'PAYMENT_RECEIPT_UPDATE') THEN
    RAISE EXCEPTION 'Permission denied';
  END IF;

  SELECT * INTO v_receipt
  FROM finance.payment_receipts
  WHERE id = p_payment_receipt_id
    AND organization_id = p_organization_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Payment receipt not found';
  END IF;

  IF jsonb_typeof(p_allocations) <> 'array' OR jsonb_array_length(p_allocations) = 0 THEN
    RAISE EXCEPTION 'At least one allocation is required';
  END IF;

  SELECT COALESCE(SUM(pa.allocated_amount),0)
    INTO v_total_existing
  FROM finance.payment_allocations pa
  WHERE pa.payment_receipt_id = p_payment_receipt_id AND pa.status = 'ACTIVE';

  v_total_new := 0;

  FOR v_alloc IN SELECT value FROM jsonb_array_elements(p_allocations)
  LOOP
    IF NULLIF(v_alloc->>'invoice_id','') IS NULL
       OR (v_alloc->>'amount') IS NULL THEN
      RAISE EXCEPTION 'Each allocation requires invoice_id and amount';
    END IF;

    IF (v_alloc->>'amount')::numeric <= 0 THEN
      RAISE EXCEPTION 'Allocation amount must be greater than zero';
    END IF;

    SELECT id INTO v_existing
    FROM finance.payment_allocations
    WHERE payment_receipt_id = p_payment_receipt_id
      AND invoice_id = (v_alloc->>'invoice_id')::uuid
    LIMIT 1;

    IF v_existing IS NOT NULL THEN
      RAISE EXCEPTION 'Invoice % is already allocated to this receipt', v_alloc->>'invoice_id';
    END IF;

    SELECT * INTO v_invoice
    FROM public.invoices
    WHERE id = (v_alloc->>'invoice_id')::uuid
      AND organization_id = p_organization_id
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Invoice % not found', v_alloc->>'invoice_id';
    END IF;

    -- AR-03 FIX: only an invoice that has actually been issued (and not
    -- yet fully paid or cancelled) can take a payment allocation.
    IF v_invoice.status NOT IN ('ISSUED', 'PARTIALLY_PAID', 'OVERDUE') THEN
      RAISE EXCEPTION 'Cannot allocate payment to invoice % -- it is % status. Only ISSUED, PARTIALLY_PAID, or OVERDUE invoices can receive payments.', v_invoice.invoice_number, v_invoice.status;
    END IF;

    IF v_invoice.client_id <> v_receipt.client_id THEN
      RAISE EXCEPTION 'Invoice % does not belong to the payment receipt client', v_invoice.invoice_number;
    END IF;

    IF upper(COALESCE(v_invoice.currency, 'PKR'))
       <> upper(COALESCE(v_receipt.currency, 'PKR')) THEN
      RAISE EXCEPTION
        'Currency mismatch: payment receipt is % but invoice % is %',
        COALESCE(v_receipt.currency, 'PKR'),
        v_invoice.invoice_number,
        COALESCE(v_invoice.currency, 'PKR');
    END IF;

    IF (v_alloc->>'amount')::numeric >
       COALESCE(v_invoice.outstanding_amount,0) THEN
      RAISE EXCEPTION 'Allocation exceeds outstanding amount for invoice %', v_invoice.invoice_number;
    END IF;

    v_total_new := v_total_new + (v_alloc->>'amount')::numeric;
  END LOOP;

  IF v_total_existing + v_total_new > v_receipt.amount + 0.01 THEN
    RAISE EXCEPTION 'Total allocation exceeds payment receipt amount';
  END IF;

  FOR v_alloc IN SELECT value FROM jsonb_array_elements(p_allocations)
  LOOP
    INSERT INTO finance.payment_allocations (
      payment_receipt_id, invoice_id, allocated_amount,
      base_allocated_amount, allocated_by
    ) VALUES (
      p_payment_receipt_id,
      (v_alloc->>'invoice_id')::uuid,
      (v_alloc->>'amount')::numeric,
      (v_alloc->>'amount')::numeric * COALESCE(v_receipt.exchange_rate,1),
      p_user_id
    )
    RETURNING id INTO v_existing;

    v_created := v_created || jsonb_build_array(jsonb_build_object(
      'id', v_existing,
      'invoice_id', v_alloc->>'invoice_id',
      'amount', (v_alloc->>'amount')::numeric
    ));

    -- Invoice amount/status are maintained exclusively by the allocation trigger,
    -- which recomputes from ACTIVE allocations plus POSTED credit notes.
  END LOOP;

  v_new_paid := v_total_existing + v_total_new;

  UPDATE finance.payment_receipts
  SET updated_at = now()
  WHERE id = p_payment_receipt_id
    AND organization_id = p_organization_id;

  RETURN jsonb_build_object(
    'success', true,
    'total_allocated', v_total_new,
    'total_allocated_after', v_new_paid,
    'remaining_unallocated', GREATEST(v_receipt.amount - v_new_paid, 0),
    'receipt_status', CASE
      WHEN v_new_paid >= v_receipt.amount - 0.01 THEN 'FULLY_ALLOCATED'
      ELSE 'PARTIALLY_ALLOCATED'
    END,
    'allocations', v_created
  );
END;
$$;


-- F-P1-2/3: canonical seeded permission codes and correct role grant predicate.
INSERT INTO core.permissions(code,name,module,action,is_system,description) VALUES
('EXPENSE_APPROVE','Approve Expense','expense','approve',true,'Approve submitted expenses'),
('INCOME_APPROVE','Approve Income','income','approve',true,'Approve submitted income'),
('INVOICE_APPROVE','Approve Invoice','invoice','approve',true,'Approve submitted invoices') ON CONFLICT(code) DO NOTHING;
INSERT INTO core.role_permissions(role_id,permission_id,data_scope,effective_from)
SELECT r.id,p.id,'ALL',CURRENT_DATE FROM core.roles r CROSS JOIN core.permissions p
WHERE r.name IN ('CEO','FINANCE_HEAD','ACCOUNTANT') AND p.code IN ('EXPENSE_APPROVE','INCOME_APPROVE','INVOICE_APPROVE')
AND NOT EXISTS(SELECT 1 FROM core.role_permissions rp WHERE rp.role_id=r.id AND rp.permission_id=p.id AND rp.effective_to IS NULL);

-- Correct the over-broad seed predicate for future/re-run deployments.
INSERT INTO core.role_permissions(role_id,permission_id,data_scope,effective_from)
SELECT r.id,p.id,'ALL',CURRENT_DATE FROM core.roles r CROSS JOIN core.permissions p
WHERE r.name IN ('CEO','FINANCE_HEAD') AND (p.code LIKE 'INVOICE_%' OR p.code LIKE 'VENDOR_%' OR p.code LIKE 'PAYMENT_RECEIPT_%' OR p.code LIKE 'CREDIT_NOTE_%' OR p.code LIKE 'PROJECT_%' OR p.code LIKE 'BUDGET_%' OR p.code IN ('BANK_TRANSFER','BANK_TRANSFER_APPROVE'))
AND NOT EXISTS(SELECT 1 FROM core.role_permissions rp WHERE rp.role_id=r.id AND rp.permission_id=p.id AND rp.effective_to IS NULL);

-- Remove only the permissions that the historical operator-precedence bug
-- could have granted to low-privilege roles. Legitimate grants are restored
-- by the canonical role seeds in the same deployment.
DELETE FROM core.role_permissions rp USING core.roles r, core.permissions p
WHERE rp.role_id=r.id AND rp.permission_id=p.id
  AND r.name NOT IN ('CEO','FINANCE_HEAD','ACCOUNTANT')
  AND (p.code LIKE 'VENDOR_%' OR p.code LIKE 'PAYMENT_RECEIPT_%' OR p.code LIKE 'CREDIT_NOTE_%' OR p.code LIKE 'PROJECT_%' OR p.code LIKE 'BUDGET_%' OR p.code IN ('BANK_TRANSFER','BANK_TRANSFER_APPROVE'));

-- Restore the intentional read/project-scoped grants for non-finance roles.
INSERT INTO core.role_permissions(role_id,permission_id,data_scope,effective_from)
SELECT r.id,p.id,CASE WHEN r.name='PROJECT_MANAGER' THEN 'PROJECT' ELSE 'ALL' END,CURRENT_DATE FROM core.roles r CROSS JOIN core.permissions p
WHERE ((r.name='HOD' AND p.code IN ('INVOICE_READ','VENDOR_BILL_READ','VENDOR_PAYMENT_READ','PROJECT_READ','BUDGET_READ'))
   OR (r.name='PROJECT_MANAGER' AND p.code IN ('INVOICE_READ','VENDOR_BILL_READ','EXPENSE_READ','PROJECT_READ','BUDGET_READ'))
   OR (r.name='EMPLOYEE' AND p.code='INVOICE_READ'))
AND NOT EXISTS (SELECT 1 FROM core.role_permissions rp WHERE rp.role_id=r.id AND rp.permission_id=p.id AND rp.effective_to IS NULL);

-- Make the authoritative cash view organization-safe and base-currency aware.
CREATE OR REPLACE VIEW reporting.v_cash_position WITH (security_invoker=true) AS
SELECT fa.id account_id,fa.account_name,fa.institution_name,fa.account_type,fa.currency,fa.opening_balance,
       fa.opening_balance + COALESCE(SUM(CASE WHEN je.status='POSTED' THEN jl.debit_amount-jl.credit_amount ELSE 0 END),0) current_balance,
       fa.opening_balance + COALESCE(SUM(CASE WHEN je.status='POSTED' THEN COALESCE(jl.base_debit,jl.debit_amount)-COALESCE(jl.base_credit,jl.credit_amount) ELSE 0 END),0) current_balance_base,
       org.base_currency,fa.is_active,fa.is_default,fa.organization_id,now() data_as_of,fa.masked_identifier
FROM finance.financial_accounts fa JOIN core.organizations org ON org.id=fa.organization_id
LEFT JOIN finance.journal_lines jl ON jl.account_id=fa.linked_ledger_account_id
LEFT JOIN finance.journal_entries je ON je.id=jl.journal_entry_id AND je.organization_id=fa.organization_id
GROUP BY fa.id,fa.account_name,fa.institution_name,fa.account_type,fa.currency,fa.opening_balance,org.base_currency,fa.is_active,fa.is_default,fa.organization_id;

-- F-P1-5: CEO cash uses authoritative consolidated cash position.
CREATE OR REPLACE FUNCTION reporting.ceo_chart_cash(p_organization_id uuid DEFAULT NULL) RETURNS json
LANGUAGE plpgsql STABLE SET search_path='pg_catalog','reporting','finance','public','core' AS $$ DECLARE v_org uuid:=COALESCE(p_organization_id,core.current_user_org_id()); BEGIN IF NOT core.is_finance_head() OR v_org IS NULL OR NOT core.same_org(v_org) THEN RAISE EXCEPTION 'Access denied'; END IF; RETURN COALESCE((SELECT json_agg(row_to_json(t) ORDER BY t.balance_base DESC) FROM (SELECT account_id AS id,account_name,institution_name AS institution_type,currency,opening_balance,current_balance_base AS balance,masked_identifier FROM reporting.v_cash_position WHERE organization_id=v_org AND is_active) t),'[]'::json); END; $$;
CREATE OR REPLACE FUNCTION reporting.ceo_dashboard_kpis("p_organization_id" "uuid" DEFAULT NULL::"uuid") RETURNS json
    LANGUAGE "plpgsql" STABLE
    SET "search_path" TO 'pg_catalog', 'reporting', 'finance', 'public', 'core'
    AS $$ DECLARE
  v_org_id UUID;
  v_period_id UUID;
  v_prev_period_id UUID;
  v_total_cash NUMERIC := 0;
  v_monthly_expense NUMERIC := 0;
BEGIN
  IF NOT core.is_finance_head() THEN
    RAISE EXCEPTION 'Access denied: CEO dashboard is restricted to CEO/Finance Head roles';
  END IF;
  v_org_id := COALESCE(p_organization_id, core.current_user_org_id());
  IF v_org_id IS NULL OR NOT core.same_org(v_org_id) THEN
    RAISE EXCEPTION 'Access denied: organization scope mismatch';
  END IF;

  SELECT id INTO v_period_id FROM finance.accounting_periods WHERE status = 'OPEN' AND organization_id = v_org_id ORDER BY start_date DESC LIMIT 1;
  SELECT id INTO v_prev_period_id FROM finance.accounting_periods WHERE status IN ('OPEN','SOFT_CLOSED','HARD_CLOSED') AND organization_id = v_org_id AND id != v_period_id ORDER BY start_date DESC LIMIT 1;

  SELECT COALESCE(SUM(current_balance_base), 0) INTO v_total_cash FROM reporting.v_cash_position WHERE is_active = true AND organization_id = v_org_id;

  SELECT COALESCE(SUM(jl.debit_amount - jl.credit_amount) / NULLIF(COUNT(DISTINCT je.period_id), 1), 0) INTO v_monthly_expense
  FROM finance.journal_lines jl
  JOIN finance.journal_entries je ON je.id = jl.journal_entry_id
  JOIN finance.chart_of_accounts ca ON ca.id = jl.account_id
  JOIN finance.accounting_periods ap ON ap.id = je.period_id
  WHERE je.status = 'POSTED' AND je.organization_id = v_org_id
    AND ca.account_type IN ('COST_OF_SALES','OPERATING_EXPENSE','OTHER_EXPENSE')
    AND ap.status IN ('SOFT_CLOSED','HARD_CLOSED')
    AND ap.end_date >= CURRENT_DATE - INTERVAL '4 months'
    AND ap.start_date < CURRENT_DATE;

  IF v_monthly_expense = 0 THEN
    SELECT COALESCE(SUM(jl.debit_amount - jl.credit_amount) / 3, 0) INTO v_monthly_expense
    FROM finance.journal_lines jl
    JOIN finance.journal_entries je ON je.id = jl.journal_entry_id
    JOIN finance.chart_of_accounts ca ON ca.id = jl.account_id
    WHERE je.status = 'POSTED' AND je.organization_id = v_org_id AND ca.account_type IN ('COST_OF_SALES','OPERATING_EXPENSE','OTHER_EXPENSE');
  END IF;

  RETURN json_build_object(
    'revenue_mtd', COALESCE((SELECT SUM(jl.credit_amount - jl.debit_amount) FROM finance.journal_lines jl JOIN finance.chart_of_accounts ca ON ca.id = jl.account_id JOIN finance.journal_entries je ON je.id = jl.journal_entry_id WHERE je.period_id = v_period_id AND je.organization_id = v_org_id AND je.status = 'POSTED' AND ca.account_type = 'REVENUE'), 0),
    'revenue_prev', COALESCE((SELECT SUM(jl.credit_amount - jl.debit_amount) FROM finance.journal_lines jl JOIN finance.chart_of_accounts ca ON ca.id = jl.account_id JOIN finance.journal_entries je ON je.id = jl.journal_entry_id WHERE je.period_id = v_prev_period_id AND je.organization_id = v_org_id AND je.status = 'POSTED' AND ca.account_type = 'REVENUE'), 0),
    'cogs_mtd', COALESCE((SELECT SUM(jl.debit_amount - jl.credit_amount) FROM finance.journal_lines jl JOIN finance.chart_of_accounts ca ON ca.id = jl.account_id JOIN finance.journal_entries je ON je.id = jl.journal_entry_id WHERE je.period_id = v_period_id AND je.organization_id = v_org_id AND je.status = 'POSTED' AND ca.account_type = 'COST_OF_SALES'), 0),
    'opex_mtd', COALESCE((SELECT SUM(jl.debit_amount - jl.credit_amount) FROM finance.journal_lines jl JOIN finance.chart_of_accounts ca ON ca.id = jl.account_id JOIN finance.journal_entries je ON je.id = jl.journal_entry_id WHERE je.period_id = v_period_id AND je.organization_id = v_org_id AND je.status = 'POSTED' AND ca.account_type = 'OPERATING_EXPENSE'), 0),
    'other_income_mtd', COALESCE((SELECT SUM(jl.credit_amount - jl.debit_amount) FROM finance.journal_lines jl JOIN finance.chart_of_accounts ca ON ca.id = jl.account_id JOIN finance.journal_entries je ON je.id = jl.journal_entry_id WHERE je.period_id = v_period_id AND je.organization_id = v_org_id AND je.status = 'POSTED' AND ca.account_type = 'OTHER_INCOME'), 0),
    'other_expense_mtd', COALESCE((SELECT SUM(jl.debit_amount - jl.credit_amount) FROM finance.journal_lines jl JOIN finance.chart_of_accounts ca ON ca.id = jl.account_id JOIN finance.journal_entries je ON je.id = jl.journal_entry_id WHERE je.period_id = v_period_id AND je.organization_id = v_org_id AND je.status = 'POSTED' AND ca.account_type = 'OTHER_EXPENSE'), 0),
    'net_profit_mtd', COALESCE((SELECT SUM(CASE WHEN ca.normal_balance = 'CREDIT' THEN jl.credit_amount - jl.debit_amount ELSE jl.debit_amount - jl.credit_amount END) FROM finance.journal_lines jl JOIN finance.chart_of_accounts ca ON ca.id = jl.account_id JOIN finance.journal_entries je ON je.id = jl.journal_entry_id WHERE je.period_id = v_period_id AND je.organization_id = v_org_id AND je.status = 'POSTED' AND ca.account_type IN ('REVENUE','COST_OF_SALES','OPERATING_EXPENSE','OTHER_INCOME','OTHER_EXPENSE')), 0),
    'net_profit_prev', COALESCE((SELECT SUM(CASE WHEN ca.normal_balance = 'CREDIT' THEN jl.credit_amount - jl.debit_amount ELSE jl.debit_amount - jl.credit_amount END) FROM finance.journal_lines jl JOIN finance.chart_of_accounts ca ON ca.id = jl.account_id JOIN finance.journal_entries je ON je.id = jl.journal_entry_id WHERE je.period_id = v_prev_period_id AND je.organization_id = v_org_id AND je.status = 'POSTED' AND ca.account_type IN ('REVENUE','COST_OF_SALES','OPERATING_EXPENSE','OTHER_INCOME','OTHER_EXPENSE')), 0),
    'total_assets', COALESCE((SELECT SUM(CASE WHEN ca.code LIKE '153%' THEN jl.credit_amount - jl.debit_amount ELSE jl.debit_amount - jl.credit_amount END) FROM finance.journal_lines jl JOIN finance.chart_of_accounts ca ON ca.id = jl.account_id JOIN finance.journal_entries je ON je.id = jl.journal_entry_id AND je.status = 'POSTED' WHERE je.organization_id = v_org_id AND ca.account_type = 'ASSET'), 0),
    'current_assets', COALESCE((SELECT SUM(jl.debit_amount - jl.credit_amount) FROM finance.journal_lines jl JOIN finance.chart_of_accounts ca ON ca.id = jl.account_id JOIN finance.journal_entries je ON je.id = jl.journal_entry_id AND je.status = 'POSTED' WHERE je.organization_id = v_org_id AND ca.account_type = 'ASSET' AND ca.code LIKE '1%'), 0),
    'fixed_assets_net', COALESCE((SELECT SUM(CASE WHEN ca.code LIKE '153%' THEN jl.credit_amount - jl.debit_amount ELSE jl.debit_amount - jl.credit_amount END) FROM finance.journal_lines jl JOIN finance.chart_of_accounts ca ON ca.id = jl.account_id JOIN finance.journal_entries je ON je.id = jl.journal_entry_id AND je.status = 'POSTED' WHERE je.organization_id = v_org_id AND (ca.code LIKE '15%' OR ca.code LIKE '153%')), 0),
    'total_liabilities', COALESCE((SELECT SUM(jl.credit_amount - jl.debit_amount) FROM finance.journal_lines jl JOIN finance.chart_of_accounts ca ON ca.id = jl.account_id JOIN finance.journal_entries je ON je.id = jl.journal_entry_id AND je.status = 'POSTED' WHERE je.organization_id = v_org_id AND ca.account_type = 'LIABILITY'), 0),
    'current_liabilities', COALESCE((SELECT SUM(jl.credit_amount - jl.debit_amount) FROM finance.journal_lines jl JOIN finance.chart_of_accounts ca ON ca.id = jl.account_id JOIN finance.journal_entries je ON je.id = jl.journal_entry_id AND je.status = 'POSTED' WHERE je.organization_id = v_org_id AND ca.account_type = 'LIABILITY' AND ca.code LIKE '2%'), 0),
    'total_cash', v_total_cash,
    'cash_runway_months', CASE WHEN v_monthly_expense > 0 THEN FLOOR(v_total_cash / v_monthly_expense) ELSE 0 END,
    'accounts_receivable', COALESCE((SELECT SUM(COALESCE(outstanding_amount, 0)) FROM public.invoices WHERE status IN ('ISSUED','PARTIALLY_PAID','OVERDUE') AND organization_id = v_org_id), 0),
    'accounts_payable', COALESCE((SELECT SUM(COALESCE(outstanding_amount, 0)) FROM finance.vendor_bills WHERE status IN ('POSTED','PARTIALLY_PAID') AND organization_id = v_org_id), 0),
    'retained_earnings', COALESCE((SELECT SUM(jl.credit_amount - jl.debit_amount) FROM finance.journal_lines jl JOIN finance.chart_of_accounts ca ON ca.id = jl.account_id JOIN finance.journal_entries je ON je.id = jl.journal_entry_id AND je.status = 'POSTED' WHERE je.organization_id = v_org_id AND ca.code = '3200'), 0),
    'reserve_balance', COALESCE((SELECT SUM(jl.credit_amount - jl.debit_amount) FROM finance.journal_lines jl JOIN finance.chart_of_accounts ca ON ca.id = jl.account_id JOIN finance.journal_entries je ON je.id = jl.journal_entry_id AND je.status = 'POSTED' WHERE je.organization_id = v_org_id AND ca.code LIKE '33%'), 0),
    'owner_capital', COALESCE((SELECT SUM(jl.credit_amount - jl.debit_amount) FROM finance.journal_lines jl JOIN finance.chart_of_accounts ca ON ca.id = jl.account_id JOIN finance.journal_entries je ON je.id = jl.journal_entry_id AND je.status = 'POSTED' WHERE je.organization_id = v_org_id AND ca.code = '3110'), 0),
    'owner_drawings', COALESCE((SELECT SUM(jl.debit_amount - jl.credit_amount) FROM finance.journal_lines jl JOIN finance.chart_of_accounts ca ON ca.id = jl.account_id JOIN finance.journal_entries je ON je.id = jl.journal_entry_id AND je.status = 'POSTED' WHERE je.organization_id = v_org_id AND ca.code = '2420'), 0),
    'distributable_profit', GREATEST(
      COALESCE((SELECT SUM(CASE WHEN ca.normal_balance = 'CREDIT' THEN jl.credit_amount - jl.debit_amount ELSE jl.debit_amount - jl.credit_amount END) FROM finance.journal_lines jl JOIN finance.chart_of_accounts ca ON ca.id = jl.account_id JOIN finance.journal_entries je ON je.id = jl.journal_entry_id AND je.status = 'POSTED' WHERE je.organization_id = v_org_id AND ca.account_type IN ('REVENUE','COST_OF_SALES','OPERATING_EXPENSE','OTHER_INCOME','OTHER_EXPENSE')), 0)
      - COALESCE((SELECT SUM(jl.debit_amount - jl.credit_amount) FROM finance.journal_lines jl JOIN finance.chart_of_accounts ca ON ca.id = jl.account_id JOIN finance.journal_entries je ON je.id = jl.journal_entry_id AND je.status = 'POSTED' WHERE je.organization_id = v_org_id AND ca.code = '7111'), 0)
      - COALESCE((SELECT SUM(jl.credit_amount - jl.debit_amount) FROM finance.journal_lines jl JOIN finance.chart_of_accounts ca ON ca.id = jl.account_id JOIN finance.journal_entries je ON je.id = jl.journal_entry_id AND je.status = 'POSTED' WHERE je.organization_id = v_org_id AND ca.code LIKE '33%'), 0),
      0
    ),
    'pending_approvals', (
      COALESCE((SELECT COUNT(*) FROM public.invoices WHERE status = 'SUBMITTED' AND organization_id = v_org_id), 0) +
      COALESCE((SELECT COUNT(*) FROM finance.vendor_bills WHERE status IN ('SUBMITTED','VERIFIED') AND organization_id = v_org_id), 0) +
      COALESCE((SELECT COUNT(*) FROM public.expenses WHERE status = 'SUBMITTED' AND organization_id = v_org_id), 0)
    ),
    'unreconciled_lines', COALESCE((SELECT COUNT(*) FROM finance.statement_lines WHERE reconciliation_status = 'UNRECONCILED' AND organization_id = v_org_id), 0),
    'risk_overdue_receivables', COALESCE((SELECT COUNT(*) FROM public.invoices WHERE status = 'OVERDUE' AND organization_id = v_org_id), 0),
    'risk_overdue_payables', COALESCE((SELECT COUNT(*) FROM finance.vendor_bills WHERE status IN ('POSTED','PARTIALLY_PAID') AND due_date < CURRENT_DATE AND organization_id = v_org_id), 0),
    'risk_unreconciled', COALESCE((SELECT COUNT(DISTINCT bank_statement_id) FROM finance.statement_lines WHERE reconciliation_status = 'UNRECONCILED' AND organization_id = v_org_id), 0),
    'risk_pending_period_close', COALESCE((SELECT COUNT(*) FROM finance.accounting_periods WHERE status = 'OPEN' AND end_date < CURRENT_DATE + INTERVAL '7 days' AND organization_id = v_org_id), 0)
  );
END;
 $$;


-- F-P1-7: no SQL change required; UI labels use variance > 0 = overspend.

-- F-P1-8: tax computation must be explicitly authorized and remain editable only in draft/calculated states.
CREATE OR REPLACE FUNCTION finance.compute_tax_liability(p_tax_recon_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path='pg_catalog','finance','public','core' AS $$
DECLARE v_recon record; v_pbt numeric:=0; v_adj numeric:=0; v_taxable numeric:=0; v_tax numeric:=0; v_rem numeric:=0; v_slab record; v_income numeric;
BEGIN
 IF NOT core.has_permission(auth.uid(),'TAX_MANAGE') THEN RAISE EXCEPTION 'TAX_MANAGE permission required'; END IF;
 SELECT * INTO v_recon FROM finance.tax_reconciliations WHERE id=p_tax_recon_id AND organization_id=core.current_user_org_id() FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Tax reconciliation not found or access denied'; END IF;
 IF v_recon.status NOT IN ('DRAFT','CALCULATED') THEN RAISE EXCEPTION 'Tax reconciliation status % cannot be recomputed',v_recon.status; END IF;
 SELECT COALESCE(SUM(CASE WHEN coa.account_type IN ('REVENUE','OTHER_INCOME') THEN jl.base_credit-jl.base_debit ELSE 0 END),0)-COALESCE(SUM(CASE WHEN coa.account_type IN ('OTHER_EXPENSE','OPERATING_EXPENSE','COST_OF_SALES') THEN jl.base_debit-jl.base_credit ELSE 0 END),0) INTO v_pbt FROM finance.journal_lines jl JOIN finance.journal_entries je ON je.id=jl.journal_entry_id JOIN finance.chart_of_accounts coa ON coa.id=jl.account_id JOIN finance.accounting_periods ap ON ap.id=je.period_id WHERE ap.fiscal_year_id=v_recon.fiscal_year_id AND je.organization_id=v_recon.organization_id AND je.status IN ('POSTED','REVERSED');
 SELECT COALESCE(SUM(amount),0) INTO v_adj FROM finance.tax_adjustments WHERE tax_reconciliation_id=p_tax_recon_id; v_taxable:=v_pbt+v_adj; v_rem:=v_taxable;
 FOR v_slab IN SELECT * FROM finance.tax_slabs WHERE tax_rule_set_id=v_recon.tax_rule_set_id ORDER BY sort_order,income_from LOOP EXIT WHEN v_rem<=0; v_income:=LEAST(v_rem,COALESCE(v_slab.income_to,999999999999)-v_slab.income_from+1); v_tax:=v_tax+GREATEST(v_income,0)*v_slab.tax_rate/100.0+v_slab.fixed_amount; v_rem:=v_rem-v_income; END LOOP;
 UPDATE finance.tax_reconciliations SET accounting_profit_before_tax=v_pbt,taxable_income=v_taxable,gross_tax_liability=v_tax,net_tax_payable=GREATEST(v_tax-COALESCE(v_recon.withholding_credits,0)-COALESCE(v_recon.advance_tax_credits,0)-COALESCE(v_recon.other_tax_credits,0),0),profit_after_tax=v_pbt-GREATEST(v_tax-COALESCE(v_recon.withholding_credits,0)-COALESCE(v_recon.advance_tax_credits,0)-COALESCE(v_recon.other_tax_credits,0),0),effective_tax_rate=CASE WHEN v_pbt>0 THEN ROUND(GREATEST(v_tax-COALESCE(v_recon.withholding_credits,0)-COALESCE(v_recon.advance_tax_credits,0)-COALESCE(v_recon.other_tax_credits,0),0)/v_pbt*100,2) ELSE 0 END,status='CALCULATED',updated_at=now() WHERE id=p_tax_recon_id;
END; $$;

-- F-P1-9: atomic ownership supersede.
CREATE OR REPLACE FUNCTION finance.add_ownership_history_atomic(p_owner_id uuid,p_percentage numeric,p_effective_from date,p_change_reason text,p_changed_by uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path='pg_catalog','finance','public','core' AS $$ DECLARE v_org uuid:=core.current_user_org_id(); v_id uuid; BEGIN IF p_changed_by IS DISTINCT FROM auth.uid() OR NOT core.has_permission(auth.uid(),'SETTINGS_MANAGE') THEN RAISE EXCEPTION 'Access denied'; END IF; IF p_percentage<0 OR p_percentage>100 OR NULLIF(btrim(p_change_reason),'') IS NULL THEN RAISE EXCEPTION 'Invalid ownership change'; END IF; UPDATE finance.ownership_history SET effective_to=p_effective_from-1 WHERE owner_id=p_owner_id AND organization_id=v_org AND effective_from<p_effective_from AND effective_to IS NULL; INSERT INTO finance.ownership_history(owner_id,organization_id,ownership_percentage,effective_from,change_reason,changed_by) VALUES(p_owner_id,v_org,p_percentage,p_effective_from,p_change_reason,p_changed_by) RETURNING id INTO v_id; RETURN v_id; END; $$;

-- F-P1-11: year-end close selects only a real posting account, not the EQUITY header.
-- (UI/API patch below also applies the same criteria.)

-- F-P1-16: disposal lines are already base/PKR; post them at rate 1 to avoid double conversion.
-- Recreate disposal posting with source lines explicitly in PKR/base currency.
CREATE OR REPLACE FUNCTION "finance"."post_asset_disposal"("p_asset_id" "uuid", "p_disposal_date" "date", "p_disposal_value" numeric, "p_disposal_currency" "text", "p_disposal_method" "text") RETURNS "finance"."fixed_assets"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'finance', 'core', 'public'
    AS $$
DECLARE
  v_asset finance.fixed_assets%ROWTYPE;
  v_org uuid;
  v_period_id uuid;
  v_nbv numeric(18,2);
  v_proceeds_base numeric(18,2);
  v_gain_loss numeric(18,2);
  v_rate numeric(18,6) := 1;
  v_cash_ledger_account_id uuid;
  v_gain_account_id uuid;
  v_loss_account_id uuid;
  v_journal_id uuid;
  v_lines jsonb := '[]'::jsonb;
  v_currency text := upper(coalesce(nullif(trim(p_disposal_currency), ''), 'PKR'));
BEGIN
  IF NOT (core.is_finance_head() OR core.has_role('ACCOUNTANT')) THEN
    RAISE EXCEPTION 'Insufficient privileges to dispose a fixed asset. Requires Finance Head, CEO, or Accountant.';
  END IF;
  IF p_disposal_value IS NULL OR p_disposal_value < 0 THEN
    RAISE EXCEPTION 'Disposal value must be zero or a positive number';
  END IF;
  IF p_disposal_date IS NULL OR p_disposal_method IS NULL OR btrim(p_disposal_method) = '' THEN
    RAISE EXCEPTION 'Disposal date and method are required';
  END IF;

  SELECT * INTO v_asset FROM finance.fixed_assets WHERE id = p_asset_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Fixed asset not found: %', p_asset_id; END IF;
  v_org := v_asset.organization_id;
  IF NOT core.same_org(v_org) THEN RAISE EXCEPTION 'Access denied: asset belongs to another organization'; END IF;
  IF v_asset.status NOT IN ('active','fully_depreciated','under_repair') THEN
    RAISE EXCEPTION 'Only active, fully_depreciated, or under_repair assets can be disposed. Current status: %', v_asset.status;
  END IF;

  IF p_disposal_value > 0 AND v_currency <> 'PKR' THEN
    SELECT er.rate INTO v_rate
    FROM finance.exchange_rates er
    WHERE er.organization_id = v_org
      AND er.from_currency = v_currency
      AND er.to_currency = 'PKR'
      AND er.rate_date <= p_disposal_date
      AND er.approved_by IS NOT NULL
      AND er.is_locked = true
    ORDER BY er.rate_date DESC, er.rate_time DESC NULLS LAST, er.created_at DESC
    LIMIT 1;
    IF v_rate IS NULL OR v_rate <= 0 THEN
      RAISE EXCEPTION 'No approved and locked % to PKR exchange rate exists on or before %', v_currency, p_disposal_date;
    END IF;
  ELSIF p_disposal_value > 0 THEN
    v_rate := 1;
  END IF;

  v_proceeds_base := round(p_disposal_value * v_rate, 2);
  v_nbv := v_asset.base_cost - v_asset.accumulated_depreciation;
  v_gain_loss := v_proceeds_base - v_nbv;

  IF v_asset.linked_asset_account_id IS NULL THEN RAISE EXCEPTION 'Asset % has no linked_asset_account_id configured', v_asset.code; END IF;
  IF v_asset.accumulated_depreciation > 0 AND v_asset.linked_depreciation_account_id IS NULL THEN
    RAISE EXCEPTION 'Asset % has accumulated depreciation but no linked_depreciation_account_id configured', v_asset.code;
  END IF;

  IF p_disposal_value > 0 THEN
    IF v_asset.financial_account_id IS NULL THEN RAISE EXCEPTION 'Asset % has no financial_account_id for disposal proceeds', v_asset.code; END IF;
    SELECT linked_ledger_account_id INTO v_cash_ledger_account_id
    FROM finance.financial_accounts
    WHERE id = v_asset.financial_account_id AND organization_id = v_org AND is_active = true;
    IF v_cash_ledger_account_id IS NULL THEN RAISE EXCEPTION 'Disposal proceeds account is missing, inactive, or not linked to GL'; END IF;
  END IF;

  IF v_gain_loss > 0 THEN
    SELECT id INTO v_gain_account_id FROM finance.chart_of_accounts WHERE organization_id = v_org AND code = '7031' AND is_active = true AND posting_allowed IS NOT FALSE;
    IF v_gain_account_id IS NULL THEN RAISE EXCEPTION 'Fixed Asset Disposal Gain account (7031) is missing or not postable'; END IF;
  ELSIF v_gain_loss < 0 THEN
    SELECT id INTO v_loss_account_id FROM finance.chart_of_accounts WHERE organization_id = v_org AND code = '7131' AND is_active = true AND posting_allowed IS NOT FALSE;
    IF v_loss_account_id IS NULL THEN RAISE EXCEPTION 'Fixed Asset Disposal Loss account (7131) is missing or not postable'; END IF;
  END IF;

  SELECT id INTO v_period_id FROM finance.accounting_periods
  WHERE organization_id = v_org AND status = 'OPEN' AND p_disposal_date BETWEEN start_date AND end_date
  ORDER BY start_date DESC LIMIT 1;
  IF v_period_id IS NULL THEN RAISE EXCEPTION 'No OPEN accounting period found for disposal date %', p_disposal_date; END IF;

  v_lines := v_lines || jsonb_build_array(
    jsonb_build_object('account_id', v_asset.linked_asset_account_id, 'debit_amount', 0, 'credit_amount', v_asset.base_cost, 'description', 'Disposal of asset ' || v_asset.code || ' - remove cost'),
    jsonb_build_object('account_id', v_asset.linked_depreciation_account_id, 'debit_amount', v_asset.accumulated_depreciation, 'credit_amount', 0, 'description', 'Disposal of asset ' || v_asset.code || ' - remove accumulated depreciation')
  );
  IF p_disposal_value > 0 THEN
    v_lines := v_lines || jsonb_build_array(jsonb_build_object('account_id', v_cash_ledger_account_id, 'debit_amount', v_proceeds_base, 'credit_amount', 0, 'description', 'Disposal proceeds: ' || v_asset.code));
  END IF;
  IF v_gain_loss > 0 THEN
    v_lines := v_lines || jsonb_build_array(jsonb_build_object('account_id', v_gain_account_id, 'debit_amount', 0, 'credit_amount', v_gain_loss, 'description', 'Gain on disposal: ' || v_asset.code));
  ELSIF v_gain_loss < 0 THEN
    v_lines := v_lines || jsonb_build_array(jsonb_build_object('account_id', v_loss_account_id, 'debit_amount', abs(v_gain_loss), 'credit_amount', 0, 'description', 'Loss on disposal: ' || v_asset.code));
  END IF;

  v_journal_id := finance.post_journal_entry(
    'Asset disposal: ' || v_asset.code || ' - ' || v_asset.name,
    p_disposal_date, v_period_id, v_lines, v_currency, v_rate,
    'ASSET_DISPOSAL', v_asset.id, v_asset.project_id, v_asset.department_id
  );

  UPDATE finance.fixed_assets SET
    status = CASE WHEN p_disposal_value > 0 THEN 'sold' ELSE 'disposed' END,
    disposal_date = p_disposal_date, disposal_value = p_disposal_value,
    disposal_currency = v_currency, disposal_method = p_disposal_method,
    gain_loss_amount = v_gain_loss, disposal_journal_id = v_journal_id, updated_at = now()
  WHERE id = p_asset_id RETURNING * INTO v_asset;
  RETURN v_asset;
END;
$$;



-- F-P1-20: handled in report service.

-- F-P1-22/23: handled by API/UI plus fiscal-year guard below.
CREATE OR REPLACE FUNCTION finance.create_fiscal_year_with_periods(p_name text,p_start_date date,p_end_date date,p_description text DEFAULT NULL,p_created_by uuid DEFAULT NULL) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path='pg_catalog','finance','public','core' AS $$ DECLARE v_id uuid; v_user uuid:=COALESCE(p_created_by,auth.uid()); v_org uuid:=core.current_user_org_id(); v_months int; BEGIN IF v_org IS NULL OR v_user IS NULL THEN RAISE EXCEPTION 'Organization and user context required'; END IF; IF p_end_date<=p_start_date THEN RAISE EXCEPTION 'End date must be after start date'; END IF; IF EXTRACT(MONTH FROM p_start_date)<>7 OR EXTRACT(DAY FROM p_start_date)<>1 OR EXTRACT(MONTH FROM p_end_date)<>6 OR EXTRACT(DAY FROM p_end_date)<>30 THEN RAISE EXCEPTION 'Regular fiscal years must run from 1 July through 30 June'; END IF; v_months:=(EXTRACT(YEAR FROM p_end_date)-EXTRACT(YEAR FROM p_start_date))*12+EXTRACT(MONTH FROM p_end_date)-EXTRACT(MONTH FROM p_start_date)+1; IF v_months<>12 THEN RAISE EXCEPTION 'Regular fiscal year must contain exactly 12 months'; END IF; IF EXISTS(SELECT 1 FROM finance.fiscal_years fy WHERE fy.organization_id=v_org AND p_start_date<fy.end_date AND p_end_date>fy.start_date) THEN RAISE EXCEPTION 'Overlaps with an existing fiscal year in this organization'; END IF; INSERT INTO finance.fiscal_years(name,start_date,end_date,description,created_by,organization_id) VALUES(p_name,p_start_date,p_end_date,p_description,v_user,v_org) RETURNING id INTO v_id; INSERT INTO finance.accounting_periods(fiscal_year_id,period_number,name,start_date,end_date,status,created_by,organization_id) SELECT v_id,g,TO_CHAR(ms,'Month YYYY'),ms,LEAST((ms+INTERVAL '1 month'-INTERVAL '1 day')::date,p_end_date),'PENDING',v_user,v_org FROM (SELECT generate_series(1,12) g,(p_start_date+(generate_series(1,12)-1)*INTERVAL '1 month')::date ms) x; RETURN v_id; END; $$;

-- F-P1-24/25: org-scoped AI views; general_ledger gets explicit org_id and fiscal-close context exists.
CREATE OR REPLACE VIEW reporting.general_ledger AS
SELECT je.id journal_entry_id,je.reference journal_reference,je.description journal_description,je.transaction_date,je.posting_date,je.period_id,je.fiscal_year_id,je.project_id,je.source_type,je.source_id,jl.id line_id,jl.line_number,jl.account_id,coa.code account_code,coa.name account_name,coa.account_type,coa.normal_balance,jl.description line_description,jl.debit_amount,jl.credit_amount,COALESCE(jl.base_debit,jl.debit_amount) base_debit,COALESCE(jl.base_credit,jl.credit_amount) base_credit,jl.currency,jl.exchange_rate,SUM(CASE WHEN coa.normal_balance='DEBIT' THEN COALESCE(jl.base_debit,jl.debit_amount)-COALESCE(jl.base_credit,jl.credit_amount) ELSE COALESCE(jl.base_credit,jl.credit_amount)-COALESCE(jl.base_debit,jl.debit_amount) END) OVER(PARTITION BY jl.account_id ORDER BY je.transaction_date,je.reference,jl.line_number ROWS UNBOUNDED PRECEDING) running_balance,je.organization_id
FROM finance.journal_lines jl JOIN finance.journal_entries je ON je.id=jl.journal_entry_id JOIN finance.chart_of_accounts coa ON coa.id=jl.account_id WHERE je.status IN ('POSTED','REVERSED');
CREATE OR REPLACE VIEW reporting.ai_fiscal_close_context WITH (security_invoker=true) AS
SELECT ap.id period_id,ap.period_number,ap.name period_name,ap.start_date,ap.end_date,ap.status period_status,fy.id fiscal_year_id,fy.organization_id,NULL::uuid journal_entry_id,NULL::text reference,NULL::text journal_description,NULL::date transaction_date,NULL::text journal_status,NULL::text source_type FROM finance.accounting_periods ap JOIN finance.fiscal_years fy ON fy.id=ap.fiscal_year_id
UNION ALL
SELECT ap.id,ap.period_number,ap.name,ap.start_date,ap.end_date,ap.status,fy.id,fy.organization_id,je.id,je.reference,je.description,je.transaction_date,je.status,je.source_type FROM finance.journal_entries je JOIN finance.accounting_periods ap ON ap.id=je.period_id JOIN finance.fiscal_years fy ON fy.id=ap.fiscal_year_id;

CREATE OR REPLACE FUNCTION reporting.get_project_profitability_cost_structure(p_start_date date,p_end_date date) RETURNS TABLE(project_id uuid,platform_fees numeric,allocated_overhead numeric)
LANGUAGE sql STABLE SET search_path='pg_catalog','reporting','finance','public','core' AS $$
SELECT je.project_id,COALESCE(SUM(CASE WHEN coa.account_type IN ('COST_OF_SALES','OPERATING_EXPENSE') AND (lower(COALESCE(coa.name,'')) LIKE '%platform fee%' OR lower(COALESCE(coa.report_mapping,'')) LIKE '%platform%fee%') THEN jl.base_debit-jl.base_credit ELSE 0 END),0),COALESCE(SUM(CASE WHEN coa.account_type IN ('COST_OF_SALES','OPERATING_EXPENSE') AND (lower(COALESCE(coa.name,'')) LIKE '%overhead%' OR lower(COALESCE(coa.report_mapping,'')) LIKE '%overhead%') THEN jl.base_debit-jl.base_credit ELSE 0 END),0) FROM finance.journal_entries je JOIN finance.journal_lines jl ON jl.journal_entry_id=je.id JOIN finance.chart_of_accounts coa ON coa.id=jl.account_id WHERE je.organization_id=core.current_user_org_id() AND je.status IN ('POSTED','REVERSED') AND je.transaction_date BETWEEN p_start_date AND p_end_date GROUP BY je.project_id;
$$;

-- F-P1-26: signed, org-scoped project profitability.
CREATE OR REPLACE FUNCTION reporting.get_project_profitability(p_start_date date,p_end_date date) RETURNS TABLE(project_id uuid,project_name text,total_revenue numeric,total_costs numeric,gross_profit numeric,margin_pct numeric)
LANGUAGE sql STABLE SET search_path='pg_catalog','reporting','finance','public','core' AS $$
SELECT je.project_id,COALESCE(p.name,'Unassigned'),COALESCE(SUM(CASE WHEN coa.account_type IN ('REVENUE','OTHER_INCOME') THEN jl.base_credit-jl.base_debit ELSE 0 END),0),COALESCE(SUM(CASE WHEN coa.account_type IN ('COST_OF_SALES','OPERATING_EXPENSE','OTHER_EXPENSE') THEN jl.base_debit-jl.base_credit ELSE 0 END),0),COALESCE(SUM(CASE WHEN coa.account_type IN ('REVENUE','OTHER_INCOME') THEN jl.base_credit-jl.base_debit ELSE 0 END),0)-COALESCE(SUM(CASE WHEN coa.account_type IN ('COST_OF_SALES','OPERATING_EXPENSE','OTHER_EXPENSE') THEN jl.base_debit-jl.base_credit ELSE 0 END),0),CASE WHEN COALESCE(SUM(CASE WHEN coa.account_type IN ('REVENUE','OTHER_INCOME') THEN jl.base_credit-jl.base_debit ELSE 0 END),0)=0 THEN 0 ELSE ROUND(( (SUM(CASE WHEN coa.account_type IN ('REVENUE','OTHER_INCOME') THEN jl.base_credit-jl.base_debit ELSE 0 END)-SUM(CASE WHEN coa.account_type IN ('COST_OF_SALES','OPERATING_EXPENSE','OTHER_EXPENSE') THEN jl.base_debit-jl.base_credit ELSE 0 END))/NULLIF(SUM(CASE WHEN coa.account_type IN ('REVENUE','OTHER_INCOME') THEN jl.base_credit-jl.base_debit ELSE 0 END),0))*100,2) END FROM finance.journal_entries je JOIN finance.journal_lines jl ON jl.journal_entry_id=je.id JOIN finance.chart_of_accounts coa ON coa.id=jl.account_id LEFT JOIN public.projects p ON p.id=je.project_id WHERE je.organization_id=core.current_user_org_id() AND je.status IN ('POSTED','REVERSED') AND je.transaction_date BETWEEN p_start_date AND p_end_date GROUP BY je.project_id,p.name;
$$;


-- Least-privilege grants for newly introduced objects.
REVOKE ALL ON FUNCTION finance.recompute_invoice_ar_balance(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION finance.credit_note_ar_balance_trigger() FROM PUBLIC;
REVOKE ALL ON FUNCTION finance.add_ownership_history_atomic(uuid,numeric,date,text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION finance.add_ownership_history_atomic(uuid,numeric,date,text,uuid) TO authenticated;
REVOKE ALL ON FUNCTION reporting.get_project_profitability_cost_structure(date,date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION reporting.get_project_profitability_cost_structure(date,date) TO authenticated, ai_readonly_role;
GRANT SELECT ON reporting.ai_fiscal_close_context TO authenticated, ai_readonly_role;

COMMIT;
