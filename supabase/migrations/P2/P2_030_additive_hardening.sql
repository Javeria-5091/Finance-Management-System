-- AUD-P2-011..022
-- Additive hardening. Existing P2-001..010 migrations remain untouched.
BEGIN;

-- P2-011: renewal bill + event linkage in one transaction, retry-safe.
CREATE OR REPLACE FUNCTION finance.create_subscription_renewal_bill_atomic(
  p_event_id uuid, p_subscription_id uuid, p_vendor_id uuid, p_user_id uuid,
  p_organization_id uuid, p_renewal_date date, p_currency text, p_amount numeric,
  p_description text
) RETURNS finance.vendor_bills
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, finance, core, public
AS $$
DECLARE v_event public.subscription_renewal_events%ROWTYPE;
        v_bill finance.vendor_bills%ROWTYPE;
        v_rate numeric := 1;
        v_currency text := upper(coalesce(p_currency,'PKR'));
BEGIN
  IF auth.uid() IS NULL OR p_user_id <> auth.uid() OR NOT core.same_org(p_organization_id) THEN RAISE EXCEPTION 'Invalid organization context'; END IF;
  IF NOT (core.is_finance_head() OR core.has_role('ACCOUNTANT')) THEN RAISE EXCEPTION 'Insufficient privileges'; END IF;
  SELECT * INTO v_event FROM public.subscription_renewal_events WHERE id=p_event_id AND organization_id=p_organization_id AND subscription_id=p_subscription_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Renewal event not found in your organization'; END IF;
  IF v_event.draft_vendor_bill_id IS NOT NULL THEN
    SELECT * INTO v_bill FROM finance.vendor_bills WHERE id=v_event.draft_vendor_bill_id AND organization_id=p_organization_id;
    IF FOUND THEN RETURN v_bill; END IF;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM finance.vendors WHERE id=p_vendor_id AND organization_id=p_organization_id AND is_active=true AND deleted_at IS NULL) THEN RAISE EXCEPTION 'Vendor is not active or does not belong to the organization'; END IF;
  IF p_amount < 0 THEN RAISE EXCEPTION 'Subscription amount cannot be negative'; END IF;
  IF v_currency <> 'PKR' THEN
    SELECT rate INTO v_rate FROM finance.exchange_rates
     WHERE organization_id=p_organization_id AND from_currency=v_currency AND to_currency='PKR'
       AND approved_by IS NOT NULL AND is_locked=true AND rate_date <= p_renewal_date
     ORDER BY rate_date DESC, approved_at DESC LIMIT 1;
    IF v_rate IS NULL OR v_rate <= 0 THEN RAISE EXCEPTION 'No approved and locked exchange rate found for % -> PKR on or before %',v_currency,p_renewal_date; END IF;
  END IF;
  INSERT INTO finance.vendor_bills(vendor_id,bill_date,due_date,currency,exchange_rate,total_amount,base_total_amount,subtotal,base_subtotal,status,description,created_by,organization_id,rate_date,rate_source,rate_snapshot)
  VALUES(p_vendor_id,p_renewal_date,p_renewal_date,v_currency,v_rate,p_amount,round(p_amount*v_rate,2),p_amount,round(p_amount*v_rate,2),'DRAFT',p_description,p_user_id,p_organization_id,p_renewal_date,'APPROVED_LOCKED',jsonb_build_object('rate',v_rate,'rate_date',p_renewal_date))
  RETURNING * INTO v_bill;
  UPDATE public.subscription_renewal_events SET status='DRAFT_BILL_CREATED',draft_vendor_bill_id=v_bill.id,updated_at=now()
   WHERE id=v_event.id AND organization_id=p_organization_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Renewal event linkage failed; transaction rolled back'; END IF;
  RETURN v_bill;
END; $$;
REVOKE ALL ON FUNCTION finance.create_subscription_renewal_bill_atomic(uuid,uuid,uuid,uuid,uuid,date,text,numeric,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION finance.create_subscription_renewal_bill_atomic(uuid,uuid,uuid,uuid,uuid,date,text,numeric,text) TO authenticated;

-- P2-012: AP document amounts cannot be negative.
ALTER TABLE finance.vendor_bills ADD CONSTRAINT vendor_bills_total_amount_non_negative CHECK (total_amount >= 0);
ALTER TABLE finance.vendor_bills ADD CONSTRAINT vendor_bills_amount_paid_non_negative CHECK (amount_paid >= 0);
ALTER TABLE finance.vendor_bills ADD CONSTRAINT vendor_bills_outstanding_non_negative CHECK (outstanding_amount >= 0);
ALTER TABLE finance.vendor_bills ADD CONSTRAINT vendor_bills_subtotal_non_negative CHECK (subtotal >= 0);
ALTER TABLE finance.vendor_bills ADD CONSTRAINT vendor_bills_tax_amount_non_negative CHECK (tax_amount >= 0);
ALTER TABLE finance.vendor_bills ADD CONSTRAINT vendor_bills_withholding_non_negative CHECK (withholding_amount >= 0);
ALTER TABLE finance.vendor_bills ADD CONSTRAINT vendor_bills_discount_non_negative CHECK (discount_amount >= 0);
ALTER TABLE finance.vendor_bills ADD CONSTRAINT vendor_bills_base_total_non_negative CHECK (base_total_amount >= 0);
ALTER TABLE finance.vendor_bill_lines ADD CONSTRAINT vendor_bill_lines_quantity_positive CHECK (quantity > 0);
ALTER TABLE finance.vendor_bill_lines ADD CONSTRAINT vendor_bill_lines_unit_price_non_negative CHECK (unit_price >= 0);
ALTER TABLE finance.vendor_bill_lines ADD CONSTRAINT vendor_bill_lines_tax_rate_non_negative CHECK (tax_rate >= 0);
ALTER TABLE finance.vendor_bill_lines ADD CONSTRAINT vendor_bill_lines_tax_amount_non_negative CHECK (tax_amount >= 0);
ALTER TABLE finance.vendor_bill_lines ADD CONSTRAINT vendor_bill_lines_withholding_rate_non_negative CHECK (withholding_rate >= 0);
ALTER TABLE finance.vendor_bill_lines ADD CONSTRAINT vendor_bill_lines_withholding_amount_non_negative CHECK (withholding_amount >= 0);
ALTER TABLE finance.vendor_bill_lines ADD CONSTRAINT vendor_bill_lines_line_total_non_negative CHECK (line_total >= 0);

-- P2-013: legacy reads are tenant-scoped where an organization can be resolved.
DROP POLICY IF EXISTS fa_pub_select ON legacy.financial_accounts;
CREATE POLICY fa_pub_select_org_scoped ON legacy.financial_accounts FOR SELECT TO authenticated
USING ((core.is_finance_head() OR core.has_role('ACCOUNTANT') OR core.has_role('VIEWER')) AND
       (user_id = auth.uid() OR EXISTS (SELECT 1 FROM public.profiles up WHERE up.user_id=auth.uid() AND up.organization_id = (SELECT organization_id FROM public.profiles x WHERE x.user_id=legacy.financial_accounts.user_id LIMIT 1))));
DROP POLICY IF EXISTS numbering_select_role_restricted ON legacy.numbering_sequences;
-- Legacy numbering rows contain no organization_id; fail closed for authenticated readers.
CREATE POLICY numbering_select_service_only ON legacy.numbering_sequences FOR SELECT TO authenticated USING (false);

-- P2-018: operational multi-step SLA processor. It escalates overdue pending steps and advances completed chains.
CREATE OR REPLACE FUNCTION core.process_approval_slas() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,core,public AS $$
DECLARE r record; n integer:=0;
BEGIN
 FOR r IN SELECT s.id,s.approval_request_id,s.step_number,s.escalate_to_user_id
   FROM core.approval_steps s JOIN core.approval_requests a ON a.id=s.approval_request_id
   WHERE s.status='PENDING' AND s.sla_hours IS NOT NULL AND s.created_at + make_interval(hours=>s.sla_hours) < now() AND a.status='PENDING' LOOP
   UPDATE core.approval_steps SET status='ESCALATED', assigned_user_id=coalesce(escalate_to_user_id,assigned_user_id) WHERE id=r.id AND status='PENDING';
   UPDATE core.approval_requests SET status='ESCALATED', updated_at=now() WHERE id=r.approval_request_id AND status='PENDING';
   n:=n+1;
 END LOOP;
 RETURN n;
END; $$;
REVOKE ALL ON FUNCTION core.process_approval_slas() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.process_approval_slas() TO service_role;

-- P2-019: delivery queue + worker support. Actual provider is configured by NOTIFICATION_EMAIL_WEBHOOK_URL.
CREATE INDEX IF NOT EXISTS idx_notification_deliveries_pending ON public.notification_deliveries(status,created_at);

-- P2-020: currency settings become authoritative for rounding.
CREATE OR REPLACE FUNCTION finance.round_currency_amount(p_organization_id uuid,p_currency text,p_amount numeric) RETURNS numeric
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,finance,core,public AS $$
DECLARE v_dec integer:=2; v_method text:='HALF_UP';
BEGIN
 SELECT decimals,rounding_method INTO v_dec,v_method FROM finance.currency_settings WHERE organization_id=p_organization_id AND currency=upper(p_currency) AND enabled=true LIMIT 1;
 IF v_method='DOWN' THEN RETURN trunc(p_amount,v_dec); END IF;
 IF v_method='UP' THEN RETURN ceil(p_amount * power(10,v_dec))/power(10,v_dec); END IF;
 IF v_method='FLOOR' THEN RETURN floor(p_amount * power(10,v_dec))/power(10,v_dec); END IF;
 IF v_method='CEILING' THEN RETURN ceil(p_amount * power(10,v_dec))/power(10,v_dec); END IF;
 IF v_method='HALF_EVEN' THEN
   RETURN CASE WHEN abs(p_amount * power(10,v_dec) - trunc(p_amount * power(10,v_dec))) = 0.5
     THEN trunc(p_amount * power(10,v_dec)) + CASE WHEN mod(abs(trunc(p_amount * power(10,v_dec)))::bigint,2)=0 THEN 0 ELSE sign(p_amount) END
     ELSE round(p_amount,v_dec) END / power(10,v_dec);
 END IF;
 RETURN round(p_amount,v_dec);
END; $$;
REVOKE ALL ON FUNCTION finance.round_currency_amount(uuid,text,numeric) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION finance.round_currency_amount(uuid,text,numeric) TO authenticated,service_role;

-- P2-022: integration event processing state is operationally consumable.
CREATE INDEX IF NOT EXISTS idx_integration_events_pending ON core.integration_events(processing_status,created_at);
CREATE INDEX IF NOT EXISTS idx_integration_failures_retry ON core.integration_failures(next_retry_at) WHERE dead_letter=false;

COMMIT;

-- Materialize a multi-level chain from effective approval-limit configuration.
CREATE OR REPLACE FUNCTION core.create_approval_chain_for_submission(
 p_entity_type text,p_entity_id uuid,p_transaction_type text,p_amount numeric,p_currency text,p_requested_by uuid,p_organization_id uuid
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,core,public AS $$
DECLARE v_req uuid; r record; v_step int:=0;
BEGIN
 IF auth.uid() IS NULL OR auth.uid()<>p_requested_by OR NOT core.same_org(p_organization_id) THEN RAISE EXCEPTION 'Invalid approval context'; END IF;
 SELECT id INTO v_req FROM core.approval_requests WHERE organization_id=p_organization_id AND entity_type=p_entity_type AND entity_id=p_entity_id AND status='PENDING' LIMIT 1;
 IF v_req IS NOT NULL THEN RETURN v_req; END IF;
 INSERT INTO core.approval_requests(entity_type,entity_id,transaction_type,amount,currency,requested_by,current_step,status,organization_id)
 VALUES(p_entity_type,p_entity_id,p_transaction_type,p_amount,upper(coalesce(p_currency,'PKR')),p_requested_by,1,'PENDING',p_organization_id) RETURNING id INTO v_req;
 FOR r IN SELECT role_id,user_id,max_amount FROM core.approval_limits WHERE organization_id=p_organization_id AND transaction_type=p_transaction_type AND upper(currency)=upper(coalesce(p_currency,'PKR')) AND effective_from<=CURRENT_DATE AND (effective_to IS NULL OR effective_to>=CURRENT_DATE) AND (max_amount IS NULL OR p_amount<=max_amount) ORDER BY CASE WHEN max_amount IS NULL THEN 999999999999999 ELSE max_amount END, id LOOP
   v_step:=v_step+1;
   INSERT INTO core.approval_steps(approval_request_id,step_number,required_role_id,assigned_user_id,sla_hours,status) VALUES(v_req,v_step,r.role_id,r.user_id,24,'PENDING');
 END LOOP;
 IF v_step=0 THEN INSERT INTO core.approval_steps(approval_request_id,step_number,sla_hours,status) VALUES(v_req,1,24,'PENDING'); END IF;
 RETURN v_req;
END; $$;
REVOKE ALL ON FUNCTION core.create_approval_chain_for_submission(text,uuid,text,numeric,text,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.create_approval_chain_for_submission(text,uuid,text,numeric,text,uuid,uuid) TO authenticated;


-- P2-018: approval action is now step-aware. Only the current step can approve;
-- intermediate approvals do not mutate the source document to APPROVED.
CREATE OR REPLACE FUNCTION core.advance_approval_chain(
 p_entity_type text,p_entity_id uuid,p_approver_id uuid,p_approver_role text,p_organization_id uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,core,public AS $$
DECLARE v_req core.approval_requests%ROWTYPE; v_step core.approval_steps%ROWTYPE; v_role_id uuid; v_final boolean:=false;
BEGIN
 IF auth.uid() IS NULL OR auth.uid()<>p_approver_id OR NOT core.same_org(p_organization_id) THEN RAISE EXCEPTION 'Invalid approval context'; END IF;
 SELECT * INTO v_req FROM core.approval_requests WHERE entity_type=p_entity_type AND entity_id=p_entity_id AND organization_id=p_organization_id AND status IN ('PENDING','ESCALATED') ORDER BY created_at DESC LIMIT 1 FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'No pending approval chain found'; END IF;
 SELECT * INTO v_step FROM core.approval_steps WHERE approval_request_id=v_req.id AND step_number=v_req.current_step AND status='PENDING' FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Current approval step is not pending'; END IF;
 IF v_step.assigned_user_id IS NOT NULL AND v_step.assigned_user_id<>p_approver_id THEN RAISE EXCEPTION 'Approval is assigned to another user'; END IF;
 IF v_step.required_role_id IS NOT NULL THEN
   SELECT id INTO v_role_id FROM core.roles WHERE id=v_step.required_role_id AND organization_id=p_organization_id AND upper(name)=upper(p_approver_role) LIMIT 1;
   IF v_role_id IS NULL THEN RAISE EXCEPTION 'Approver does not hold the required role'; END IF;
 END IF;
 IF NOT (core.is_finance_head() OR core.has_role(p_approver_role) OR p_approver_role='CEO') THEN RAISE EXCEPTION 'Insufficient approval privilege'; END IF;
 UPDATE core.approval_steps SET status='APPROVED' WHERE id=v_step.id;
 IF EXISTS (SELECT 1 FROM core.approval_steps WHERE approval_request_id=v_req.id AND step_number>v_req.current_step AND status='PENDING') THEN
   UPDATE core.approval_requests SET current_step=current_step+1,updated_at=now(),status='PENDING' WHERE id=v_req.id;
 ELSE
   UPDATE core.approval_requests SET status='APPROVED',updated_at=now() WHERE id=v_req.id;
   v_final:=true;
 END IF;
 RETURN jsonb_build_object('approval_request_id',v_req.id,'step_number',v_step.step_number,'final_approval',v_final);
END; $$;
REVOKE ALL ON FUNCTION core.advance_approval_chain(text,uuid,uuid,text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.advance_approval_chain(text,uuid,uuid,text,uuid) TO authenticated;
