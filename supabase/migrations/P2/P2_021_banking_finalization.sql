BEGIN;

-- Fee-rule schema required by the contextual selector. These are nullable
-- because rules can still be platform-wide. All values are evaluated only
-- after the rule's organization_id has been matched to the caller.
ALTER TABLE finance.fee_rules
  ADD COLUMN IF NOT EXISTS fixed_amount numeric(18,4) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS financial_account_id uuid,
  ADD COLUMN IF NOT EXISTS client_id uuid,
  ADD COLUMN IF NOT EXISTS project_id uuid,
  ADD COLUMN IF NOT EXISTS currency text,
  ADD COLUMN IF NOT EXISTS payment_method text,
  ADD COLUMN IF NOT EXISTS transaction_type text;
ALTER TABLE finance.fee_rules DROP CONSTRAINT IF EXISTS fee_rules_fee_type_check;
ALTER TABLE finance.fee_rules ADD CONSTRAINT fee_rules_fee_type_check
  CHECK (fee_type IN ('PERCENTAGE','FIXED','PERCENTAGE_PLUS_FIXED','TIERED','SLAB'));

-- -------------------------------------------------------------------------
-- BK-05/BK-16: controlled financial-account changes
-- -------------------------------------------------------------------------
ALTER TABLE finance.financial_accounts
  ADD COLUMN IF NOT EXISTS supporting_evidence_reference text;

CREATE TABLE IF NOT EXISTS finance.financial_account_change_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES core.organizations(id) ON DELETE RESTRICT,
  financial_account_id uuid NOT NULL REFERENCES finance.financial_accounts(id) ON DELETE RESTRICT,
  requested_changes jsonb NOT NULL,
  reason text NOT NULL,
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPROVED','REJECTED')),
  requested_by uuid NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  approved_by uuid,
  approved_at timestamptz,
  approval_reason text,
  CONSTRAINT fa_change_reason_not_blank CHECK (length(btrim(reason)) > 0)
);
ALTER TABLE finance.financial_account_change_requests ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS fa_change_select_org ON finance.financial_account_change_requests;
CREATE POLICY fa_change_select_org ON finance.financial_account_change_requests
  FOR SELECT TO authenticated USING (core.same_org(organization_id));
DROP POLICY IF EXISTS fa_change_insert_org ON finance.financial_account_change_requests;
CREATE POLICY fa_change_insert_org ON finance.financial_account_change_requests
  FOR INSERT TO authenticated WITH CHECK (core.same_org(organization_id) AND requested_by = auth.uid());
DROP POLICY IF EXISTS fa_change_update_org ON finance.financial_account_change_requests;
CREATE POLICY fa_change_update_org ON finance.financial_account_change_requests
  FOR UPDATE TO authenticated USING (false) WITH CHECK (false);

-- Direct browser updates are disabled. All changes must go through the
-- SECURITY DEFINER request/approval functions below.
DROP POLICY IF EXISTS fa_update ON finance.financial_accounts;
CREATE POLICY fa_update ON finance.financial_accounts
  FOR UPDATE TO authenticated USING (false) WITH CHECK (false);

CREATE OR REPLACE FUNCTION finance.request_financial_account_change(
  p_account_id uuid,
  p_changes jsonb,
  p_reason text
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO pg_catalog, finance, public, core
AS $$
DECLARE
  v_org uuid := core.current_user_org_id();
  v_id uuid;
  v_account finance.financial_accounts;
BEGIN
  IF auth.uid() IS NULL OR v_org IS NULL THEN RAISE EXCEPTION 'Authentication and organization are required'; END IF;
  IF NOT (core.is_finance_head() OR core.has_role('ACCOUNTANT')) THEN RAISE EXCEPTION 'Access denied'; END IF;
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN RAISE EXCEPTION 'Reason is mandatory'; END IF;
  IF p_changes IS NULL OR jsonb_typeof(p_changes) <> 'object' OR p_changes = '{}'::jsonb THEN RAISE EXCEPTION 'At least one account change is required'; END IF;

  SELECT * INTO v_account FROM finance.financial_accounts
  WHERE id = p_account_id AND organization_id = v_org FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Financial account not found or access denied'; END IF;

  INSERT INTO finance.financial_account_change_requests(
    organization_id, financial_account_id, requested_changes, reason, requested_by
  ) VALUES (v_org, p_account_id, p_changes, btrim(p_reason), auth.uid())
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION finance.approve_financial_account_change(
  p_request_id uuid,
  p_reason text DEFAULT NULL
) RETURNS finance.financial_accounts
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO pg_catalog, finance, public, core
AS $$
DECLARE
  v_org uuid := core.current_user_org_id();
  v_req finance.financial_account_change_requests;
  v_result finance.financial_accounts;
  v_changes jsonb;
BEGIN
  IF auth.uid() IS NULL OR v_org IS NULL THEN RAISE EXCEPTION 'Authentication and organization are required'; END IF;
  IF NOT core.is_finance_head() THEN RAISE EXCEPTION 'Only CEO/Finance Head may approve financial-account changes'; END IF;

  SELECT * INTO v_req FROM finance.financial_account_change_requests
  WHERE id = p_request_id AND organization_id = v_org FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Change request not found or access denied'; END IF;
  IF v_req.status <> 'PENDING' THEN RAISE EXCEPTION 'Change request is already %', v_req.status; END IF;
  IF v_req.requested_by = auth.uid() THEN RAISE EXCEPTION 'Maker-checker: requester cannot approve their own account change'; END IF;
  IF p_reason IS NOT NULL AND btrim(p_reason) = '' THEN RAISE EXCEPTION 'Approval reason cannot be blank'; END IF;

  v_changes := v_req.requested_changes;
  UPDATE finance.financial_accounts
  SET account_name = COALESCE(v_changes->>'account_name', account_name),
      institution_name = COALESCE(v_changes->>'institution_name', institution_name),
      institution_type = COALESCE(v_changes->>'institution_type', institution_type),
      account_type = COALESCE(v_changes->>'account_type', account_type),
      currency = COALESCE(v_changes->>'currency', currency),
      masked_identifier = CASE WHEN v_changes ? 'masked_identifier' THEN v_changes->>'masked_identifier' ELSE masked_identifier END,
      opening_balance = CASE WHEN v_changes ? 'opening_balance' THEN (v_changes->>'opening_balance')::numeric ELSE opening_balance END,
      opening_date = CASE WHEN v_changes ? 'opening_date' AND nullif(v_changes->>'opening_date','') IS NOT NULL THEN (v_changes->>'opening_date')::date WHEN v_changes ? 'opening_date' THEN NULL ELSE opening_date END,
      linked_ledger_account_id = CASE WHEN v_changes ? 'linked_ledger_account_id' THEN (v_changes->>'linked_ledger_account_id')::uuid ELSE linked_ledger_account_id END,
      reconciliation_method = COALESCE(v_changes->>'reconciliation_method', reconciliation_method),
      responsible_user_id = CASE WHEN v_changes ? 'responsible_user_id' AND nullif(v_changes->>'responsible_user_id','') IS NOT NULL THEN (v_changes->>'responsible_user_id')::uuid WHEN v_changes ? 'responsible_user_id' THEN NULL ELSE responsible_user_id END,
      supporting_evidence_reference = CASE WHEN v_changes ? 'supporting_evidence_reference' THEN v_changes->>'supporting_evidence_reference' ELSE supporting_evidence_reference END,
      notes = CASE WHEN v_changes ? 'notes' THEN v_changes->>'notes' ELSE notes END,
      is_active = CASE WHEN v_changes ? 'is_active' THEN (v_changes->>'is_active')::boolean ELSE is_active END,
      requires_dual_approval = CASE WHEN v_changes ? 'requires_dual_approval' THEN (v_changes->>'requires_dual_approval')::boolean ELSE requires_dual_approval END,
      min_dual_approval_amount = CASE WHEN v_changes ? 'min_dual_approval_amount' AND nullif(v_changes->>'min_dual_approval_amount','') IS NOT NULL THEN (v_changes->>'min_dual_approval_amount')::numeric WHEN v_changes ? 'min_dual_approval_amount' THEN NULL ELSE min_dual_approval_amount END,
      is_default = CASE WHEN v_changes ? 'is_default' THEN (v_changes->>'is_default')::boolean ELSE is_default END,
      updated_at = now()
  WHERE id = v_req.financial_account_id AND organization_id = v_org
  RETURNING * INTO v_result;

  UPDATE finance.financial_account_change_requests
  SET status='APPROVED', approved_by=auth.uid(), approved_at=now(), approval_reason=NULLIF(btrim(p_reason),'')
  WHERE id=v_req.id;

  RETURN v_result;
END;
$$;

-- -------------------------------------------------------------------------
-- BK-03/BK-06/BK-15/BK-02: safe, date-correct, rate-snapshot transfer post
-- -------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION finance.post_bank_transfer(
  p_transfer_id uuid,
  p_period_id uuid,
  p_transaction_date date
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO pg_catalog, finance, public, core
AS $$
DECLARE
  v_org uuid := core.current_user_org_id();
  v_t record;
  v_period record;
  v_from_ledger uuid;
  v_to_ledger uuid;
  v_fx_gain uuid;
  v_fx_loss uuid;
  v_from_rate numeric(18,6) := 1;
  v_to_rate numeric(18,6) := 1;
  v_from_base numeric(18,2);
  v_to_base numeric(18,2);
  v_fx_diff numeric(18,2);
  v_lines jsonb := '[]'::jsonb;
  v_journal_id uuid;
  v_from_rate_row jsonb;
  v_to_rate_row jsonb;
  v_snapshot_date date;
BEGIN
  IF v_org IS NULL OR auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  IF NOT (core.is_finance_head() OR core.has_role('ACCOUNTANT')) THEN RAISE EXCEPTION 'Access denied'; END IF;

  SELECT * INTO v_t FROM finance.bank_transfers
  WHERE id=p_transfer_id AND organization_id=v_org FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Transfer not found or access denied'; END IF;
  IF v_t.status <> 'APPROVED' THEN RAISE EXCEPTION 'Transfer must be APPROVED, current: %',v_t.status; END IF;
  IF v_t.requires_dual_approval AND v_t.second_approved_by IS NULL THEN RAISE EXCEPTION 'Second approval is required before posting'; END IF;

  SELECT * INTO v_period FROM finance.accounting_periods
  WHERE id=p_period_id AND organization_id=v_org AND status='OPEN' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Posting period is not OPEN or does not belong to your organization'; END IF;
  -- Never trust the browser date. The transfer record is the source of truth.
  IF v_t.transfer_date < v_period.start_date OR v_t.transfer_date > v_period.end_date THEN
    RAISE EXCEPTION 'Transfer date % is outside selected accounting period % - %',v_t.transfer_date,v_period.start_date,v_period.end_date;
  END IF;

  IF EXISTS (SELECT 1 FROM finance.journal_entries WHERE source_type='BANK_TRANSFER' AND source_id=p_transfer_id AND organization_id=v_org) THEN
    RAISE EXCEPTION 'This transfer has already been posted to the general ledger';
  END IF;

  SELECT linked_ledger_account_id INTO v_from_ledger FROM finance.financial_accounts WHERE id=v_t.from_account_id AND organization_id=v_org AND is_active;
  SELECT linked_ledger_account_id INTO v_to_ledger FROM finance.financial_accounts WHERE id=v_t.to_account_id AND organization_id=v_org AND is_active;
  IF v_from_ledger IS NULL OR v_to_ledger IS NULL THEN RAISE EXCEPTION 'Both financial accounts must be active and ledger-mapped'; END IF;

  IF v_t.from_currency <> 'PKR' THEN
    SELECT er.rate, to_jsonb(er) INTO v_from_rate, v_from_rate_row
    FROM finance.exchange_rates er
    WHERE er.organization_id=v_org AND er.from_currency=v_t.from_currency AND er.to_currency='PKR'
      AND er.rate_date <= v_t.transfer_date AND er.approved_by IS NOT NULL AND er.is_locked=true
    ORDER BY er.rate_date DESC, er.created_at DESC LIMIT 1;
    IF v_from_rate IS NULL THEN RAISE EXCEPTION 'No approved/locked %/PKR exchange rate exists on or before transfer date %',v_t.from_currency,v_t.transfer_date; END IF;
  END IF;

  IF v_t.to_currency <> 'PKR' THEN
    SELECT er.rate, to_jsonb(er) INTO v_to_rate, v_to_rate_row
    FROM finance.exchange_rates er
    WHERE er.organization_id=v_org AND er.from_currency=v_t.to_currency AND er.to_currency='PKR'
      AND er.rate_date <= v_t.transfer_date AND er.approved_by IS NOT NULL AND er.is_locked=true
    ORDER BY er.rate_date DESC, er.created_at DESC LIMIT 1;
    IF v_to_rate IS NULL THEN RAISE EXCEPTION 'No approved/locked %/PKR exchange rate exists on or before transfer date %',v_t.to_currency,v_t.transfer_date; END IF;
  END IF;

  v_from_base := round(v_t.from_amount * v_from_rate,2);
  v_to_base := round(v_t.to_amount * v_to_rate,2);
  v_snapshot_date := COALESCE(v_t.fx_rate_date, (v_from_rate_row->>'rate_date')::date, (v_to_rate_row->>'rate_date')::date, v_t.transfer_date);

  IF v_t.from_currency = v_t.to_currency THEN
    -- Same-currency transfers must still use the currency's approved PKR rate.
    v_lines := v_lines || jsonb_build_object('account_id',v_to_ledger,'debit_amount',v_t.to_amount,'credit_amount',0,'description','Transfer TO: '||v_t.transfer_number);
    v_lines := v_lines || jsonb_build_object('account_id',v_from_ledger,'debit_amount',0,'credit_amount',v_t.from_amount,'description','Transfer FROM: '||v_t.transfer_number);
  ELSE
    v_fx_diff := v_to_base-v_from_base;
    v_lines := v_lines || jsonb_build_object('account_id',v_to_ledger,'debit_amount',v_to_base,'credit_amount',0,'description','Transfer TO: '||v_t.transfer_number||' ('||v_t.to_amount||' '||v_t.to_currency||')');
    v_lines := v_lines || jsonb_build_object('account_id',v_from_ledger,'debit_amount',0,'credit_amount',v_from_base,'description','Transfer FROM: '||v_t.transfer_number||' ('||v_t.from_amount||' '||v_t.from_currency||')');
    IF v_fx_diff > 0 THEN
      SELECT id INTO v_fx_gain FROM finance.chart_of_accounts WHERE organization_id=v_org AND code='4210' AND posting_allowed=true AND is_active=true LIMIT 1;
      IF v_fx_gain IS NULL THEN RAISE EXCEPTION 'Realized FX gain account 4210 is not configured for this organization'; END IF;
      v_lines := v_lines || jsonb_build_object('account_id',v_fx_gain,'debit_amount',0,'credit_amount',v_fx_diff,'description','FX Gain: '||v_t.transfer_number);
    ELSIF v_fx_diff < 0 THEN
      SELECT id INTO v_fx_loss FROM finance.chart_of_accounts WHERE organization_id=v_org AND code='7121' AND posting_allowed=true AND is_active=true LIMIT 1;
      IF v_fx_loss IS NULL THEN RAISE EXCEPTION 'Realized FX loss account 7121 is not configured for this organization'; END IF;
      v_lines := v_lines || jsonb_build_object('account_id',v_fx_loss,'debit_amount',abs(v_fx_diff),'credit_amount',0,'description','FX Loss: '||v_t.transfer_number);
    END IF;
  END IF;

  v_journal_id := finance.post_journal_entry('Bank Transfer: '||v_t.transfer_number,v_t.transfer_date,p_period_id,v_lines,'PKR',1,'BANK_TRANSFER',p_transfer_id,NULL,NULL);

  UPDATE finance.journal_entries
  SET rate_date = v_snapshot_date,
      rate_source = CASE WHEN v_t.from_currency='PKR' AND v_t.to_currency='PKR' THEN 'BANK_TRANSFER_SAME_CURRENCY' ELSE 'APPROVED_EXCHANGE_RATE' END,
      rate_snapshot = jsonb_build_object(
        'transfer_id',v_t.id,
        'transfer_date',v_t.transfer_date,
        'from_currency',v_t.from_currency,'from_amount',v_t.from_amount,'from_base_amount',v_from_base,
        'to_currency',v_t.to_currency,'to_amount',v_t.to_amount,'to_base_amount',v_to_base,
        'quoted_transfer_rate',v_t.exchange_rate,
        'from_base_rate',v_from_rate,'to_base_rate',v_to_rate,
        'from_rate_row',v_from_rate_row,'to_rate_row',v_to_rate_row,
        'snapshot_taken_at',now()
      )
  WHERE id=v_journal_id;

  UPDATE finance.journal_lines
  SET base_debit = CASE WHEN debit_amount > 0 THEN CASE WHEN v_t.to_currency=v_t.from_currency THEN v_to_base ELSE debit_amount END ELSE 0 END,
      base_credit = CASE WHEN credit_amount > 0 THEN CASE WHEN v_t.to_currency=v_t.from_currency THEN v_from_base ELSE credit_amount END ELSE 0 END,
      rate_date=v_snapshot_date,
      rate_source=CASE WHEN v_t.from_currency=v_t.to_currency AND v_t.from_currency<>'PKR' THEN 'APPROVED_EXCHANGE_RATE' ELSE 'BANK_TRANSFER' END,
      rate_snapshot=jsonb_build_object('transfer_id',v_t.id,'from_currency',v_t.from_currency,'to_currency',v_t.to_currency,'quoted_rate',v_t.exchange_rate,'from_base_rate',v_from_rate,'to_base_rate',v_to_rate,'from_base_amount',v_from_base,'to_base_amount',v_to_base)
  WHERE journal_entry_id=v_journal_id;

  UPDATE finance.bank_transfers SET status='POSTED',journal_entry_id=v_journal_id,period_id=p_period_id,posted_by=auth.uid(),posted_at=now(),updated_at=now()
  WHERE id=p_transfer_id AND organization_id=v_org AND status='APPROVED';
  IF NOT FOUND THEN RAISE EXCEPTION 'Transfer finalization failed'; END IF;
  RETURN v_journal_id;
END;
$$;

CREATE OR REPLACE FUNCTION finance.reverse_bank_transfer(
  p_transfer_id uuid,
  p_reversal_date date,
  p_reason text
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO pg_catalog, finance, public, core
AS $$
DECLARE
  v_org uuid := core.current_user_org_id();
  v_t record;
  v_journal uuid;
  v_reversal uuid;
BEGIN
  IF v_org IS NULL OR auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  IF NOT core.is_finance_head() THEN RAISE EXCEPTION 'Only CEO/Finance Head may reverse a bank transfer'; END IF;
  IF p_reason IS NULL OR btrim(p_reason)='' THEN RAISE EXCEPTION 'Reversal reason is mandatory'; END IF;
  SELECT * INTO v_t FROM finance.bank_transfers WHERE id=p_transfer_id AND organization_id=v_org FOR UPDATE;
  IF NOT FOUND OR v_t.status<>'POSTED' OR v_t.journal_entry_id IS NULL THEN RAISE EXCEPTION 'Only a posted bank transfer with a journal can be reversed'; END IF;
  IF NOT EXISTS (SELECT 1 FROM finance.accounting_periods WHERE id=v_t.period_id AND organization_id=v_org AND status='OPEN') THEN RAISE EXCEPTION 'Original posting period is not open; use an authorized open reversal period'; END IF;
  v_journal := v_t.journal_entry_id;
  v_reversal := finance.reverse_journal_entry(v_journal,p_reversal_date,p_reason);
  UPDATE finance.bank_transfers SET status='REVERSED',reversal_reason=p_reason,reversed_at=now(),updated_at=now() WHERE id=p_transfer_id AND organization_id=v_org AND status='POSTED';
  IF NOT FOUND THEN RAISE EXCEPTION 'Bank transfer reversal finalization failed'; END IF;
  RETURN v_reversal;
END;
$$;

-- -------------------------------------------------------------------------
-- BK-07: suggestion-only auto matching + existing manual confirmation
-- -------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION finance.suggest_bank_statement_matches(p_statement_id uuid)
RETURNS TABLE(line_id uuid, journal_line_id uuid, match_method text, confidence numeric, journal_date date, journal_description text, journal_amount numeric)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO pg_catalog, finance, public, core
AS $$
DECLARE v_org uuid := core.current_user_org_id(); v_ledger uuid;
BEGIN
  IF v_org IS NULL OR NOT (core.is_finance_head() OR core.has_role('ACCOUNTANT')) THEN RAISE EXCEPTION 'Access denied'; END IF;
  SELECT fa.linked_ledger_account_id INTO v_ledger
  FROM finance.bank_statements bs JOIN finance.financial_accounts fa ON fa.id=bs.financial_account_id
  WHERE bs.id=p_statement_id AND bs.organization_id=v_org;
  IF v_ledger IS NULL THEN RAISE EXCEPTION 'Statement not found or access denied'; END IF;

  RETURN QUERY
  WITH candidates AS (
    SELECT sl.id line_id, jl.id journal_line_id,
      CASE
        WHEN sl.transaction_date=je.transaction_date AND ((sl.amount>0 AND jl.debit_amount=sl.amount) OR (sl.amount<0 AND jl.credit_amount=abs(sl.amount))) THEN 'AUTO_AMOUNT_DATE'
        WHEN sl.reference IS NOT NULL AND sl.reference<>'' AND sl.transaction_date BETWEEN je.transaction_date-3 AND je.transaction_date+3 AND je.description ILIKE '%'||sl.reference||'%' THEN 'AUTO_AMOUNT_REF'
        WHEN sl.transaction_date BETWEEN je.transaction_date-7 AND je.transaction_date+7 AND ((sl.amount>0 AND jl.debit_amount=sl.amount) OR (sl.amount<0 AND jl.credit_amount=abs(sl.amount))) THEN 'AUTO_AMOUNT_DATE_WINDOW'
        WHEN sl.transaction_identifier IS NOT NULL AND sl.transaction_identifier<>'' AND je.reference ILIKE '%'||sl.transaction_identifier||'%' THEN 'AUTO_IDENTIFIER'
      END match_method,
      CASE
        WHEN sl.transaction_date=je.transaction_date AND ((sl.amount>0 AND jl.debit_amount=sl.amount) OR (sl.amount<0 AND jl.credit_amount=abs(sl.amount))) THEN 1.0
        WHEN sl.reference IS NOT NULL AND sl.reference<>'' AND sl.transaction_date BETWEEN je.transaction_date-3 AND je.transaction_date+3 AND je.description ILIKE '%'||sl.reference||'%' THEN 0.95
        WHEN sl.transaction_date BETWEEN je.transaction_date-7 AND je.transaction_date+7 AND ((sl.amount>0 AND jl.debit_amount=sl.amount) OR (sl.amount<0 AND jl.credit_amount=abs(sl.amount))) THEN 0.85
        ELSE 0.80
      END confidence,
      je.transaction_date journal_date, je.description journal_description,
      CASE WHEN sl.amount>0 THEN jl.debit_amount ELSE jl.credit_amount END journal_amount,
      row_number() over(partition by sl.id order by
        CASE WHEN sl.transaction_date=je.transaction_date AND ((sl.amount>0 AND jl.debit_amount=sl.amount) OR (sl.amount<0 AND jl.credit_amount=abs(sl.amount))) THEN 1 WHEN sl.reference IS NOT NULL AND sl.reference<>'' AND je.description ILIKE '%'||sl.reference||'%' THEN 2 WHEN sl.transaction_date BETWEEN je.transaction_date-7 AND je.transaction_date+7 THEN 3 ELSE 4 END,
        abs(extract(epoch from (sl.transaction_date-je.transaction_date)))) rn
    FROM finance.statement_lines sl
    JOIN finance.journal_lines jl ON jl.account_id=v_ledger
    JOIN finance.journal_entries je ON je.id=jl.journal_entry_id
    WHERE sl.bank_statement_id=p_statement_id AND sl.reconciliation_status='UNRECONCILED'
      AND je.organization_id=v_org AND je.status='POSTED'
      AND NOT EXISTS (SELECT 1 FROM finance.statement_lines x WHERE x.matched_journal_line_id=jl.id AND x.reconciliation_status IN ('MATCHED','MANUAL_MATCH'))
  )
  SELECT line_id,journal_line_id,match_method,confidence,journal_date,journal_description,journal_amount
  FROM candidates WHERE rn=1 AND match_method IS NOT NULL;
END;
$$;

-- The old mutating auto-match RPC is deliberately disabled. Automatic matches are
-- suggestions only; a human must confirm through manual_match_statement_line.
CREATE OR REPLACE FUNCTION finance.auto_match_statement_lines(p_statement_id uuid) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO pg_catalog, finance, public, core
AS $$
BEGIN
  RAISE EXCEPTION 'Automatic matching is suggestion-only. Generate suggestions and explicitly confirm each match.';
END;
$$;
REVOKE ALL ON FUNCTION finance.auto_match_statement_lines(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION finance.auto_match_statement_lines(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION finance.manual_match_statement_line(p_line_id uuid,p_journal_line_id uuid,p_reason text DEFAULT NULL) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO pg_catalog, finance, public, core
AS $$
DECLARE v_org uuid:=core.current_user_org_id(); v_sl record; v_ledger uuid;
BEGIN
  IF v_org IS NULL OR NOT (core.is_finance_head() OR core.has_role('ACCOUNTANT')) THEN RAISE EXCEPTION 'Access denied'; END IF;
  IF p_reason IS NULL OR btrim(p_reason)='' THEN RAISE EXCEPTION 'Match confirmation reason is mandatory'; END IF;
  SELECT sl.*,bs.organization_id,fa.linked_ledger_account_id AS ledger_id INTO v_sl
  FROM finance.statement_lines sl JOIN finance.bank_statements bs ON bs.id=sl.bank_statement_id JOIN finance.financial_accounts fa ON fa.id=bs.financial_account_id
  WHERE sl.id=p_line_id AND bs.organization_id=v_org;
  IF NOT FOUND THEN RAISE EXCEPTION 'Statement line not found or access denied'; END IF;
  IF v_sl.reconciliation_status<>'UNRECONCILED' THEN RAISE EXCEPTION 'Statement line is not unreconciled'; END IF;
  v_ledger:=v_sl.ledger_id;
  IF NOT EXISTS(SELECT 1 FROM finance.journal_lines jl JOIN finance.journal_entries je ON je.id=jl.journal_entry_id WHERE jl.id=p_journal_line_id AND jl.account_id=v_ledger AND je.organization_id=v_org AND je.status='POSTED') THEN RAISE EXCEPTION 'Journal line does not belong to this organization/account or is not posted'; END IF;
  IF EXISTS(SELECT 1 FROM finance.statement_lines x WHERE x.matched_journal_line_id=p_journal_line_id AND x.reconciliation_status IN ('MATCHED','MANUAL_MATCH') AND x.id<>p_line_id) THEN RAISE EXCEPTION 'Journal line already matched'; END IF;
  UPDATE finance.statement_lines SET reconciliation_status='MANUAL_MATCH',matched_journal_line_id=p_journal_line_id,matched_at=now(),matched_by=auth.uid(),match_method='MANUAL',exclusion_reason=btrim(p_reason),updated_at=now() WHERE id=p_line_id;
END;
$$;
REVOKE ALL ON FUNCTION finance.manual_match_statement_line(uuid,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION finance.manual_match_statement_line(uuid,uuid,text) TO authenticated;

-- -------------------------------------------------------------------------
-- BK-10..BK-13: fee-rule scoping/composite support
-- -------------------------------------------------------------------------
ALTER TABLE finance.fee_rules
  ADD COLUMN IF NOT EXISTS financial_account_id uuid,
  ADD COLUMN IF NOT EXISTS client_id uuid,
  ADD COLUMN IF NOT EXISTS project_id uuid,
  ADD COLUMN IF NOT EXISTS currency text,
  ADD COLUMN IF NOT EXISTS payment_method text,
  ADD COLUMN IF NOT EXISTS transaction_type text,
  ADD COLUMN IF NOT EXISTS fixed_amount numeric(18,4) DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_fee_rules_context ON finance.fee_rules(organization_id,platform_id,financial_account_id,client_id,project_id,currency,payment_method,transaction_type,priority);

ALTER TABLE finance.fee_rules DROP CONSTRAINT IF EXISTS fee_rules_fee_type_check;
ALTER TABLE finance.fee_rules ADD CONSTRAINT fee_rules_fee_type_check CHECK (fee_type IN ('PERCENTAGE','FIXED','PERCENTAGE_PLUS_FIXED','TIERED','SLAB'));

CREATE OR REPLACE FUNCTION finance.compute_platform_fee_contextual(
  p_platform_id uuid,
  p_amount numeric,
  p_source_type varchar DEFAULT 'EXPENSE',
  p_financial_account_id uuid DEFAULT NULL,
  p_client_id uuid DEFAULT NULL,
  p_project_id uuid DEFAULT NULL,
  p_currency text DEFAULT NULL,
  p_payment_method text DEFAULT NULL,
  p_transaction_type text DEFAULT NULL,
  p_as_of_date date DEFAULT CURRENT_DATE
) RETURNS numeric
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO pg_catalog, finance, public, core
AS $$
DECLARE v_org uuid; v_fee numeric(18,4):=0; v_rule record; v_t record; v_amount numeric(18,4):=greatest(coalesce(p_amount,0),0); v_remaining numeric(18,4); v_piece numeric(18,4);
BEGIN
  SELECT organization_id INTO v_org FROM finance.platforms WHERE id=p_platform_id;
  IF v_org IS NULL OR v_org <> core.current_user_org_id() THEN RAISE EXCEPTION 'Platform not found or access denied'; END IF;
  SELECT * INTO v_rule FROM finance.fee_rules
  WHERE platform_id=p_platform_id AND organization_id=v_org AND is_active
    AND (applies_to='ALL' OR applies_to=p_source_type)
    AND (effective_from IS NULL OR effective_from<=p_as_of_date)
    AND (effective_to IS NULL OR effective_to>=p_as_of_date)
    AND (financial_account_id IS NULL OR financial_account_id=p_financial_account_id)
    AND (client_id IS NULL OR client_id=p_client_id)
    AND (project_id IS NULL OR project_id=p_project_id)
    AND (currency IS NULL OR currency=p_currency)
    AND (payment_method IS NULL OR payment_method=p_payment_method)
    AND (transaction_type IS NULL OR transaction_type=p_transaction_type OR transaction_type=p_source_type)
  ORDER BY
    (financial_account_id IS NOT NULL)::int + (client_id IS NOT NULL)::int + (project_id IS NOT NULL)::int + (currency IS NOT NULL)::int + (payment_method IS NOT NULL)::int + (transaction_type IS NOT NULL)::int DESC,
    priority DESC, effective_from DESC NULLS LAST
  LIMIT 1;
  IF NOT FOUND THEN RETURN 0; END IF;

  IF v_rule.fee_type='PERCENTAGE' THEN v_fee:=v_amount*v_rule.fee_value/100;
  ELSIF v_rule.fee_type='FIXED' THEN v_fee:=v_rule.fee_value;
  ELSIF v_rule.fee_type='PERCENTAGE_PLUS_FIXED' THEN v_fee:=v_amount*v_rule.fee_value/100+coalesce(v_rule.fixed_amount,0);
  ELSIF v_rule.fee_type='SLAB' THEN
    SELECT (v_amount*ft.fee_percent/100)+ft.fee_fixed INTO v_fee FROM finance.fee_tiers ft WHERE ft.fee_rule_id=v_rule.id AND v_amount>=ft.tier_from AND (ft.tier_to=0 OR v_amount<ft.tier_to) ORDER BY ft.tier_from DESC LIMIT 1;
  ELSIF v_rule.fee_type='TIERED' THEN
    v_remaining:=v_amount;
    FOR v_t IN SELECT * FROM finance.fee_tiers WHERE fee_rule_id=v_rule.id ORDER BY tier_from LOOP
      EXIT WHEN v_remaining<=0;
      v_piece:=least(v_remaining,CASE WHEN coalesce(v_t.tier_to,0)=0 THEN v_remaining ELSE greatest(v_t.tier_to,v_t.tier_from)-v_t.tier_from END);
      IF v_piece>0 THEN v_fee:=v_fee+(v_piece*v_t.fee_percent/100)+v_t.fee_fixed; v_remaining:=v_remaining-v_piece; END IF;
    END LOOP;
  END IF;
  IF coalesce(v_rule.min_fee,0)>0 THEN v_fee:=greatest(v_fee,v_rule.min_fee); END IF;
  IF coalesce(v_rule.max_fee,0)>0 THEN v_fee:=least(v_fee,v_rule.max_fee); END IF;
  RETURN round(coalesce(v_fee,0),2);
END;
$$;

-- Keep the old 3-argument API intact explicitly.
CREATE OR REPLACE FUNCTION finance.compute_platform_fee(p_platform_id uuid,p_amount numeric,p_source_type varchar DEFAULT 'EXPENSE') RETURNS numeric
LANGUAGE sql SECURITY DEFINER SET search_path TO pg_catalog, finance, public, core
AS $$ SELECT finance.compute_platform_fee_contextual($1,$2,$3,NULL,NULL,NULL,NULL,NULL,NULL,CURRENT_DATE); $$;


-- -------------------------------------------------------------------------
-- BK-08/BK-09/BK-12: atomic settlement creation + fee override evidence
-- -------------------------------------------------------------------------
ALTER TABLE finance.settlement_batches
  ADD COLUMN IF NOT EXISTS fee_variance numeric(18,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS fee_override_reason text,
  ADD COLUMN IF NOT EXISTS fee_override_evidence_reference text;

CREATE OR REPLACE FUNCTION finance.create_platform_settlement_atomic(
  p_platform_id uuid,
  p_financial_account_id uuid,
  p_settlement_reference text,
  p_settlement_date date,
  p_currency text,
  p_gross_amount numeric,
  p_expected_fee_amount numeric,
  p_actual_fee_amount numeric,
  p_withholding_amount numeric,
  p_withdrawal_fee_amount numeric,
  p_exchange_rate numeric,
  p_notes text,
  p_fee_variance numeric,
  p_fee_override_reason text,
  p_fee_override_evidence_reference text,
  p_lines jsonb
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO pg_catalog, finance, public, core
AS $$
DECLARE v_org uuid:=core.current_user_org_id(); v_batch uuid; v_net numeric(18,2); v_line jsonb; v_no int:=0;
BEGIN
  IF v_org IS NULL OR auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  IF NOT core.has_permission(auth.uid(),'SETTLEMENT_CREATE') THEN RAISE EXCEPTION 'SETTLEMENT_CREATE permission required'; END IF;
  IF p_platform_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM finance.platforms WHERE id=p_platform_id AND organization_id=v_org AND is_active) THEN RAISE EXCEPTION 'Platform not found or inactive'; END IF;
  IF p_financial_account_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM finance.financial_accounts WHERE id=p_financial_account_id AND organization_id=v_org AND is_active) THEN RAISE EXCEPTION 'Financial account not found or inactive'; END IF;
  IF p_gross_amount <= 0 OR p_actual_fee_amount < 0 OR p_withholding_amount < 0 OR p_withdrawal_fee_amount < 0 THEN RAISE EXCEPTION 'Invalid settlement amounts'; END IF;
  v_net:=p_gross_amount-p_actual_fee_amount-p_withholding_amount-p_withdrawal_fee_amount;
  IF v_net<0 THEN RAISE EXCEPTION 'Settlement deductions cannot exceed gross amount'; END IF;
  IF abs(coalesce(p_fee_variance,0))>0.01 AND (p_fee_override_reason IS NULL OR btrim(p_fee_override_reason)='') THEN RAISE EXCEPTION 'Fee variance requires an override reason'; END IF;
  IF abs(coalesce(p_fee_variance,0))>0.01 AND (p_fee_override_evidence_reference IS NULL OR btrim(p_fee_override_evidence_reference)='') THEN RAISE EXCEPTION 'Fee variance requires supporting evidence'; END IF;
  IF abs(coalesce(p_fee_variance,0))>0.01 AND NOT core.has_permission(auth.uid(),'SETTLEMENT_RECONCILE') THEN RAISE EXCEPTION 'Settlement fee override requires reconciliation permission'; END IF;

  INSERT INTO finance.settlement_batches(
    organization_id,platform_id,financial_account_id,settlement_reference,settlement_date,currency,gross_amount,expected_fee_amount,actual_fee_amount,withholding_amount,withdrawal_fee_amount,net_amount,exchange_rate,base_net_amount,status,notes,created_by,fee_variance,fee_override_reason,fee_override_evidence_reference
  ) VALUES (
    v_org,p_platform_id,p_financial_account_id,btrim(p_settlement_reference),p_settlement_date,upper(p_currency),p_gross_amount,coalesce(p_expected_fee_amount,0),p_actual_fee_amount,p_withholding_amount,p_withdrawal_fee_amount,v_net,p_exchange_rate,CASE WHEN p_currency='PKR' THEN round(v_net,2) ELSE round(v_net*coalesce(p_exchange_rate,0),2) END,'DRAFT',p_notes,auth.uid(),coalesce(p_fee_variance,0),nullif(btrim(p_fee_override_reason),''),nullif(btrim(p_fee_override_evidence_reference),'')
  ) RETURNING id INTO v_batch;

  IF upper(p_currency) <> 'PKR' AND (p_exchange_rate IS NULL OR p_exchange_rate <= 0) THEN RAISE EXCEPTION 'Exchange rate is required for non-PKR settlements'; END IF;
  IF p_lines IS NULL OR jsonb_typeof(p_lines)<>'array' OR jsonb_array_length(p_lines)=0 THEN
    p_lines:=jsonb_build_array(
      jsonb_build_object('line_type','GROSS','amount',p_gross_amount,'currency',p_currency),
      jsonb_build_object('line_type','FEE','amount',p_actual_fee_amount,'currency',p_currency),
      jsonb_build_object('line_type','WITHHOLDING','amount',p_withholding_amount,'currency',p_currency),
      jsonb_build_object('line_type','WITHDRAWAL_FEE','amount',p_withdrawal_fee_amount,'currency',p_currency),
      jsonb_build_object('line_type','NET','amount',v_net,'currency',p_currency)
    );
  END IF;
  FOR v_line IN SELECT * FROM jsonb_array_elements(p_lines) LOOP
    v_no:=v_no+1;
    INSERT INTO finance.settlement_lines(settlement_batch_id,organization_id,line_number,line_type,source_type,source_id,project_id,client_id,currency,amount,rate,base_amount,notes)
    VALUES(v_batch,v_org,v_no,coalesce(v_line->>'line_type','OTHER'),v_line->>'source_type',nullif(v_line->>'source_id','')::uuid,nullif(v_line->>'project_id','')::uuid,nullif(v_line->>'client_id','')::uuid,upper(coalesce(v_line->>'currency',p_currency)),coalesce((v_line->>'amount')::numeric,0),p_exchange_rate,coalesce((v_line->>'base_amount')::numeric,round(coalesce((v_line->>'amount')::numeric,0)*coalesce(p_exchange_rate,1),2)),v_line->>'notes');
  END LOOP;
  RETURN v_batch;
END;
$$;

-- Explicit RPC privileges: SECURITY DEFINER functions must never remain executable by PUBLIC.
REVOKE ALL ON FUNCTION finance.request_financial_account_change(uuid,jsonb,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION finance.request_financial_account_change(uuid,jsonb,text) TO authenticated;
REVOKE ALL ON FUNCTION finance.approve_financial_account_change(uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION finance.approve_financial_account_change(uuid,text) TO authenticated;
REVOKE ALL ON FUNCTION finance.reverse_bank_transfer(uuid,date,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION finance.reverse_bank_transfer(uuid,date,text) TO authenticated;
REVOKE ALL ON FUNCTION finance.suggest_bank_statement_matches(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION finance.suggest_bank_statement_matches(uuid) TO authenticated;
REVOKE ALL ON FUNCTION finance.create_platform_settlement_atomic(uuid,uuid,text,date,text,numeric,numeric,numeric,numeric,numeric,numeric,text,numeric,text,text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION finance.create_platform_settlement_atomic(uuid,uuid,text,date,text,numeric,numeric,numeric,numeric,numeric,numeric,text,numeric,text,text,jsonb) TO authenticated;
REVOKE ALL ON FUNCTION finance.compute_platform_fee_contextual(uuid,numeric,varchar,uuid,uuid,uuid,text,text,text,date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION finance.compute_platform_fee_contextual(uuid,numeric,varchar,uuid,uuid,uuid,text,text,text,date) TO authenticated;
GRANT SELECT,INSERT ON finance.financial_account_change_requests TO authenticated;

COMMIT;