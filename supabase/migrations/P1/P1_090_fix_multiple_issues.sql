-- FND-AI-009: tenant-scope AI conversation mutations
DROP POLICY IF EXISTS "update_own_conversations" ON ai.ai_conversations;
CREATE POLICY "update_own_conversations" ON ai.ai_conversations
  FOR UPDATE TO authenticated
  USING (user_id = auth.uid() AND core.same_org(organization_id))
  WITH CHECK (user_id = auth.uid() AND core.same_org(organization_id));

DROP POLICY IF EXISTS "delete_own_conversations" ON ai.ai_conversations;
CREATE POLICY "delete_own_conversations" ON ai.ai_conversations
  FOR DELETE TO authenticated
  USING (user_id = auth.uid() AND core.same_org(organization_id));

-- FND-ACCT-013: defense-in-depth DB constraint for owner/org integrity.
ALTER TABLE finance.capital_transactions
  DROP CONSTRAINT IF EXISTS capital_transactions_owner_org_fk;
ALTER TABLE finance.capital_transactions
  ADD CONSTRAINT capital_transactions_owner_org_fk
  FOREIGN KEY (owner_id) REFERENCES finance.owners(id);

CREATE OR REPLACE FUNCTION finance.validate_capital_transaction_owner_org()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, finance, core, public
AS $$
DECLARE
  v_owner_org uuid;
BEGIN
  IF NEW.organization_id IS NULL THEN
    RAISE EXCEPTION 'Capital transaction organization_id is required';
  END IF;

  SELECT organization_id INTO v_owner_org
  FROM finance.owners
  WHERE id = NEW.owner_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Owner % not found', NEW.owner_id;
  END IF;

  IF v_owner_org IS NULL OR v_owner_org <> NEW.organization_id THEN
    RAISE EXCEPTION 'Owner does not belong to the capital transaction organization';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_validate_capital_transaction_owner_org ON finance.capital_transactions;
CREATE TRIGGER trg_validate_capital_transaction_owner_org
BEFORE INSERT OR UPDATE OF owner_id, organization_id ON finance.capital_transactions
FOR EACH ROW EXECUTE FUNCTION finance.validate_capital_transaction_owner_org();

-- FND-FIN-011: immutable FX provenance/snapshot columns.
-- Existing rows remain readable; new/updated monetary records receive a snapshot.
ALTER TABLE finance.journal_entries
  ADD COLUMN IF NOT EXISTS rate_date date,
  ADD COLUMN IF NOT EXISTS rate_source text,
  ADD COLUMN IF NOT EXISTS rate_snapshot jsonb;

ALTER TABLE finance.journal_lines
  ADD COLUMN IF NOT EXISTS rate_date date,
  ADD COLUMN IF NOT EXISTS rate_source text,
  ADD COLUMN IF NOT EXISTS rate_snapshot jsonb;

ALTER TABLE finance.payment_receipts
  ADD COLUMN IF NOT EXISTS rate_date date,
  ADD COLUMN IF NOT EXISTS rate_source text,
  ADD COLUMN IF NOT EXISTS rate_snapshot jsonb;

ALTER TABLE finance.credit_notes
  ADD COLUMN IF NOT EXISTS rate_date date,
  ADD COLUMN IF NOT EXISTS rate_source text,
  ADD COLUMN IF NOT EXISTS rate_snapshot jsonb;

ALTER TABLE finance.vendor_bills
  ADD COLUMN IF NOT EXISTS rate_date date,
  ADD COLUMN IF NOT EXISTS rate_source text,
  ADD COLUMN IF NOT EXISTS rate_snapshot jsonb;

ALTER TABLE public.expenses
  ADD COLUMN IF NOT EXISTS rate_date date,
  ADD COLUMN IF NOT EXISTS rate_source text,
  ADD COLUMN IF NOT EXISTS rate_snapshot jsonb;

ALTER TABLE public.incomes
  ADD COLUMN IF NOT EXISTS rate_date date,
  ADD COLUMN IF NOT EXISTS rate_source text,
  ADD COLUMN IF NOT EXISTS rate_snapshot jsonb;

ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS rate_date date,
  ADD COLUMN IF NOT EXISTS rate_source text,
  ADD COLUMN IF NOT EXISTS rate_snapshot jsonb;

CREATE OR REPLACE FUNCTION finance.set_fx_snapshot()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, finance, core, public
AS $$
DECLARE
  v_currency text;
  v_rate numeric;
  v_rate_date date;
  v_source text;
  v_org uuid;
  v_date date;
BEGIN
  -- Never overwrite an existing snapshot: this is an immutable audit fact.
  IF NEW.rate_snapshot IS NOT NULL THEN
    RETURN NEW;
  END IF;

  IF TG_TABLE_SCHEMA = 'finance' AND TG_TABLE_NAME = 'journal_entries' THEN
    v_currency := NEW.currency; v_rate := COALESCE(NEW.exchange_rate, 1); v_org := NEW.organization_id; v_date := NEW.transaction_date;
  ELSIF TG_TABLE_SCHEMA = 'finance' AND TG_TABLE_NAME = 'journal_lines' THEN
    v_currency := NEW.currency; v_rate := COALESCE(NEW.exchange_rate, 1); v_date := CURRENT_DATE;
    SELECT organization_id INTO v_org FROM finance.journal_entries WHERE id = NEW.journal_entry_id;
  ELSIF TG_TABLE_SCHEMA = 'finance' AND TG_TABLE_NAME = 'payment_receipts' THEN
    v_currency := NEW.currency; v_rate := COALESCE(NEW.exchange_rate, 1); v_org := NEW.organization_id; v_date := NEW.payment_date;
  ELSIF TG_TABLE_SCHEMA = 'finance' AND TG_TABLE_NAME = 'credit_notes' THEN
    v_currency := NEW.currency; v_rate := COALESCE(NEW.exchange_rate, 1); v_org := NEW.organization_id; v_date := COALESCE(NEW.created_at::date, CURRENT_DATE);
  ELSIF TG_TABLE_SCHEMA = 'finance' AND TG_TABLE_NAME = 'vendor_bills' THEN
    v_currency := NEW.currency; v_rate := COALESCE(NEW.exchange_rate, 1); v_org := NEW.organization_id; v_date := NEW.bill_date;
  ELSIF TG_TABLE_SCHEMA = 'public' AND TG_TABLE_NAME = 'expenses' THEN
    v_currency := NEW.currency; v_rate := COALESCE(NEW.exchange_rate, 1); v_org := NEW.organization_id; v_date := NEW.expense_date;
  ELSIF TG_TABLE_SCHEMA = 'public' AND TG_TABLE_NAME = 'incomes' THEN
    v_currency := NEW.currency; v_rate := COALESCE(NEW.exchange_rate, 1); v_org := NEW.organization_id; v_date := NEW.income_date;
  ELSIF TG_TABLE_SCHEMA = 'public' AND TG_TABLE_NAME = 'invoices' THEN
    v_currency := NEW.currency; v_rate := COALESCE(NEW.exchange_rate, 1); v_org := NEW.organization_id; v_date := NEW.issue_date;
  END IF;

  IF v_currency IS NULL THEN
    RETURN NEW;
  END IF;

  v_rate_date := COALESCE(v_date, CURRENT_DATE);

  SELECT er.rate_date, COALESCE(er.source_platform, er.rate_type)
    INTO v_rate_date, v_source
  FROM finance.exchange_rates er
  WHERE er.organization_id = v_org
    AND er.from_currency = v_currency
    AND er.to_currency = 'PKR'
    AND er.rate = v_rate
    AND er.rate_date <= v_rate_date
    AND er.approved_by IS NOT NULL
    AND er.is_locked = true
  ORDER BY er.rate_date DESC, er.rate_time DESC NULLS LAST
  LIMIT 1;

  NEW.rate_date := COALESCE(v_rate_date, v_date, CURRENT_DATE);
  NEW.rate_source := COALESCE(v_source, CASE WHEN upper(v_currency) = 'PKR' AND v_rate = 1 THEN 'BASE_CURRENCY' ELSE 'RECORDED_RATE' END);
  NEW.rate_snapshot := jsonb_build_object(
    'currency', v_currency,
    'base_currency', 'PKR',
    'exchange_rate', v_rate,
    'rate_date', NEW.rate_date,
    'rate_source', NEW.rate_source,
    'captured_at', clock_timestamp()
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_journal_entries_fx_snapshot ON finance.journal_entries;
CREATE TRIGGER trg_journal_entries_fx_snapshot BEFORE INSERT ON finance.journal_entries
FOR EACH ROW EXECUTE FUNCTION finance.set_fx_snapshot();
DROP TRIGGER IF EXISTS trg_journal_lines_fx_snapshot ON finance.journal_lines;
CREATE TRIGGER trg_journal_lines_fx_snapshot BEFORE INSERT ON finance.journal_lines
FOR EACH ROW EXECUTE FUNCTION finance.set_fx_snapshot();
DROP TRIGGER IF EXISTS trg_payment_receipts_fx_snapshot ON finance.payment_receipts;
CREATE TRIGGER trg_payment_receipts_fx_snapshot BEFORE INSERT ON finance.payment_receipts
FOR EACH ROW EXECUTE FUNCTION finance.set_fx_snapshot();
DROP TRIGGER IF EXISTS trg_credit_notes_fx_snapshot ON finance.credit_notes;
CREATE TRIGGER trg_credit_notes_fx_snapshot BEFORE INSERT ON finance.credit_notes
FOR EACH ROW EXECUTE FUNCTION finance.set_fx_snapshot();
DROP TRIGGER IF EXISTS trg_vendor_bills_fx_snapshot ON finance.vendor_bills;
CREATE TRIGGER trg_vendor_bills_fx_snapshot BEFORE INSERT ON finance.vendor_bills
FOR EACH ROW EXECUTE FUNCTION finance.set_fx_snapshot();
DROP TRIGGER IF EXISTS trg_expenses_fx_snapshot ON public.expenses;
CREATE TRIGGER trg_expenses_fx_snapshot BEFORE INSERT ON public.expenses
FOR EACH ROW EXECUTE FUNCTION finance.set_fx_snapshot();
DROP TRIGGER IF EXISTS trg_incomes_fx_snapshot ON public.incomes;
CREATE TRIGGER trg_incomes_fx_snapshot BEFORE INSERT ON public.incomes
FOR EACH ROW EXECUTE FUNCTION finance.set_fx_snapshot();
DROP TRIGGER IF EXISTS trg_invoices_fx_snapshot ON public.invoices;
CREATE TRIGGER trg_invoices_fx_snapshot BEFORE INSERT ON public.invoices
FOR EACH ROW EXECUTE FUNCTION finance.set_fx_snapshot();

-- FND-FIN-012: opening balance import is one DB transaction.
CREATE OR REPLACE FUNCTION finance.import_opening_balance_atomic(
  p_batch_id text,
  p_fiscal_year_id uuid,
  p_rows jsonb,
  p_user_id uuid,
  p_organization_id uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, finance, core, public
AS $$
DECLARE
  v_period_id uuid;
  v_journal_id uuid;
  v_row jsonb;
  v_account_id uuid;
  v_debit numeric(18,2);
  v_credit numeric(18,2);
  v_rate numeric(18,6);
  v_total_dr numeric(18,2) := 0;
  v_total_cr numeric(18,2) := 0;
  v_lines jsonb := '[]'::jsonb;
  v_source_id uuid := gen_random_uuid();
BEGIN
  IF p_user_id IS NULL OR p_user_id <> auth.uid() OR NOT core.same_org(p_organization_id) THEN
    RAISE EXCEPTION 'Invalid authenticated organization context';
  END IF;
  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' OR jsonb_array_length(p_rows) = 0 THEN
    RAISE EXCEPTION 'rows array is required';
  END IF;

  SELECT id INTO v_period_id
  FROM finance.accounting_periods
  WHERE organization_id = p_organization_id
    AND status = 'OPEN'
    AND (p_fiscal_year_id IS NULL OR fiscal_year_id = p_fiscal_year_id)
  ORDER BY start_date ASC
  LIMIT 1;
  IF v_period_id IS NULL THEN
    RAISE EXCEPTION 'No OPEN accounting period found for the selected fiscal year';
  END IF;

  FOR v_row IN SELECT * FROM jsonb_array_elements(p_rows) LOOP
    SELECT id INTO v_account_id
    FROM finance.chart_of_accounts
    WHERE organization_id = p_organization_id
      AND (id = NULLIF(v_row->>'account_id','')::uuid OR code = v_row->>'account_code')
      AND is_active = true AND posting_allowed = true
    LIMIT 1;
    IF v_account_id IS NULL THEN
      RAISE EXCEPTION 'Account % not found in your organization', v_row->>'account_code';
    END IF;

    v_debit := round(abs(COALESCE((v_row->>'debit_amount')::numeric, 0)), 2);
    v_credit := round(abs(COALESCE((v_row->>'credit_amount')::numeric, 0)), 2);
    IF (v_debit = 0 AND v_credit = 0) OR (v_debit > 0 AND v_credit > 0) THEN
      RAISE EXCEPTION 'Each opening balance row must contain exactly one non-zero side';
    END IF;
    v_total_dr := v_total_dr + v_debit;
    v_total_cr := v_total_cr + v_credit;
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'account_id', v_account_id,
      'debit_amount', v_debit,
      'credit_amount', v_credit,
      'description', 'Opening Balance - ' || COALESCE(v_row->>'account_name', v_row->>'account_code')
    ));
  END LOOP;

  IF abs(v_total_dr - v_total_cr) > 0.01 THEN
    RAISE EXCEPTION 'Opening balances must balance. Total Debit: %, Total Credit: %', v_total_dr, v_total_cr;
  END IF;

  v_journal_id := finance.post_journal_entry(
    p_description => 'Opening Balance Import ' || p_batch_id,
    p_transaction_date => CURRENT_DATE,
    p_period_id => v_period_id,
    p_lines => v_lines,
    p_currency => 'PKR',
    p_exchange_rate => 1,
    p_source_type => 'OPENING_BALANCE',
    p_source_id => v_source_id
  );

  FOR v_row IN SELECT * FROM jsonb_array_elements(p_rows) LOOP
    SELECT id INTO v_account_id
    FROM finance.chart_of_accounts
    WHERE organization_id = p_organization_id
      AND (id = NULLIF(v_row->>'account_id','')::uuid OR code = v_row->>'account_code')
      AND is_active = true AND posting_allowed = true
    LIMIT 1;
    v_rate := COALESCE((v_row->>'exchange_rate')::numeric, 1);
    INSERT INTO finance.opening_balance_imports (
      organization_id, import_batch_id, account_id, account_code, account_name,
      debit_amount, credit_amount, currency, exchange_rate, base_amount,
      fiscal_year_id, status, journal_entry_id, imported_by
    ) VALUES (
      p_organization_id, p_batch_id, v_account_id, v_row->>'account_code', COALESCE(v_row->>'account_name',''),
      round(abs(COALESCE((v_row->>'debit_amount')::numeric,0)),2),
      round(abs(COALESCE((v_row->>'credit_amount')::numeric,0)),2),
      COALESCE(v_row->>'currency','PKR'), v_rate,
      round((abs(COALESCE((v_row->>'debit_amount')::numeric,0)) + abs(COALESCE((v_row->>'credit_amount')::numeric,0))) * v_rate,2),
      p_fiscal_year_id, 'IMPORTED', v_journal_id, p_user_id
    );
  END LOOP;

  RETURN jsonb_build_object('batch_id',p_batch_id,'journal_id',v_journal_id,'period_id',v_period_id,'rows',jsonb_array_length(p_rows));
END;
$$;

GRANT EXECUTE ON FUNCTION finance.import_opening_balance_atomic(text,uuid,jsonb,uuid,uuid) TO authenticated;

-- FND-PBV-008: atomic vendor-bill create/update with its lines.
CREATE OR REPLACE FUNCTION finance.save_vendor_bill_atomic(
  p_bill_id uuid,
  p_payload jsonb,
  p_lines jsonb,
  p_user_id uuid,
  p_organization_id uuid
) RETURNS finance.vendor_bills
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, finance, core, public
AS $$
DECLARE
  v_bill finance.vendor_bills;
  v_vendor_org uuid;
  v_line jsonb;
  v_bill_number text;
  v_status text;
BEGIN
  IF p_user_id IS NULL OR p_user_id <> auth.uid() OR NOT core.same_org(p_organization_id) THEN
    RAISE EXCEPTION 'Invalid authenticated organization context';
  END IF;
  IF NOT (core.is_finance_head() OR core.has_role('ACCOUNTANT')) THEN
    RAISE EXCEPTION 'Insufficient privileges to save vendor bills';
  END IF;
  IF p_payload IS NULL OR p_lines IS NULL OR jsonb_typeof(p_lines) <> 'array' OR jsonb_array_length(p_lines) = 0 THEN
    RAISE EXCEPTION 'Vendor bill requires at least one line';
  END IF;

  SELECT organization_id INTO v_vendor_org FROM finance.vendors WHERE id = (p_payload->>'vendor_id')::uuid;
  IF v_vendor_org IS NULL OR v_vendor_org <> p_organization_id THEN
    RAISE EXCEPTION 'Vendor not found in your organization';
  END IF;

  v_status := COALESCE(p_payload->>'status','DRAFT');
  IF v_status <> 'DRAFT' THEN
    RAISE EXCEPTION 'New/edited vendor bills must be saved as DRAFT';
  END IF;

  IF p_bill_id IS NULL THEN
    v_bill_number := COALESCE(NULLIF(p_payload->>'bill_number',''), finance.get_next_number('VENDOR_BILL', p_organization_id));
    INSERT INTO finance.vendor_bills (
      bill_number,vendor_id,project_id,bill_date,due_date,currency,exchange_rate,
      subtotal,tax_amount,withholding_amount,discount_amount,total_amount,
      base_subtotal,base_tax_amount,base_withholding_amount,base_discount_amount,base_total_amount,
      amount_paid,outstanding_amount,status,description,created_by,organization_id
    ) VALUES (
      v_bill_number,(p_payload->>'vendor_id')::uuid,NULLIF(p_payload->>'project_id','')::uuid,
      (p_payload->>'bill_date')::date,NULLIF(p_payload->>'due_date','')::date,
      COALESCE(p_payload->>'currency','PKR'),COALESCE((p_payload->>'exchange_rate')::numeric,1),
      COALESCE((p_payload->>'subtotal')::numeric,0),COALESCE((p_payload->>'tax_amount')::numeric,0),
      COALESCE((p_payload->>'withholding_amount')::numeric,0),COALESCE((p_payload->>'discount_amount')::numeric,0),
      (p_payload->>'total_amount')::numeric,COALESCE((p_payload->>'base_subtotal')::numeric,0),
      COALESCE((p_payload->>'base_tax_amount')::numeric,0),COALESCE((p_payload->>'base_withholding_amount')::numeric,0),
      COALESCE((p_payload->>'base_discount_amount')::numeric,0),(p_payload->>'base_total_amount')::numeric,
      COALESCE((p_payload->>'amount_paid')::numeric,0),(p_payload->>'outstanding_amount')::numeric,
      'DRAFT',NULLIF(p_payload->>'description',''),p_user_id,p_organization_id
    ) RETURNING * INTO v_bill;
  ELSE
    SELECT * INTO v_bill FROM finance.vendor_bills
    WHERE id=p_bill_id AND organization_id=p_organization_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Vendor bill not found'; END IF;
    IF v_bill.status NOT IN ('DRAFT','SUBMITTED','VERIFIED','APPROVED') THEN
      RAISE EXCEPTION 'Only editable vendor bills can be changed';
    END IF;

    UPDATE finance.vendor_bills SET
      vendor_id=(p_payload->>'vendor_id')::uuid,
      project_id=NULLIF(p_payload->>'project_id','')::uuid,
      bill_date=(p_payload->>'bill_date')::date,
      due_date=NULLIF(p_payload->>'due_date','')::date,
      currency=COALESCE(p_payload->>'currency','PKR'),
      exchange_rate=COALESCE((p_payload->>'exchange_rate')::numeric,1),
      subtotal=COALESCE((p_payload->>'subtotal')::numeric,0),
      tax_amount=COALESCE((p_payload->>'tax_amount')::numeric,0),
      withholding_amount=COALESCE((p_payload->>'withholding_amount')::numeric,0),
      discount_amount=COALESCE((p_payload->>'discount_amount')::numeric,0),
      total_amount=(p_payload->>'total_amount')::numeric,
      base_subtotal=COALESCE((p_payload->>'base_subtotal')::numeric,0),
      base_tax_amount=COALESCE((p_payload->>'base_tax_amount')::numeric,0),
      base_withholding_amount=COALESCE((p_payload->>'base_withholding_amount')::numeric,0),
      base_discount_amount=COALESCE((p_payload->>'base_discount_amount')::numeric,0),
      base_total_amount=(p_payload->>'base_total_amount')::numeric,
      amount_paid=COALESCE((p_payload->>'amount_paid')::numeric,0),
      outstanding_amount=(p_payload->>'outstanding_amount')::numeric,
      status='DRAFT',description=NULLIF(p_payload->>'description',''),updated_at=now()
    WHERE id=p_bill_id AND organization_id=p_organization_id
    RETURNING * INTO v_bill;

    DELETE FROM finance.vendor_bill_lines WHERE vendor_bill_id=p_bill_id;
  END IF;

  FOR v_line IN SELECT * FROM jsonb_array_elements(p_lines) LOOP
    INSERT INTO finance.vendor_bill_lines (
      vendor_bill_id,line_number,account_id,description,quantity,unit_price,tax_code_id,
      tax_rate,tax_amount,withholding_rate,withholding_amount,line_total,project_id
    ) VALUES (
      v_bill.id,(v_line->>'line_number')::int,(v_line->>'account_id')::uuid,
      COALESCE(v_line->>'description',''),COALESCE((v_line->>'quantity')::numeric,1),
      COALESCE((v_line->>'unit_price')::numeric,0),NULLIF(v_line->>'tax_code_id','')::uuid,
      COALESCE((v_line->>'tax_rate')::numeric,0),COALESCE((v_line->>'tax_amount')::numeric,0),
      COALESCE((v_line->>'withholding_rate')::numeric,0),COALESCE((v_line->>'withholding_amount')::numeric,0),
      (v_line->>'line_total')::numeric,NULLIF(v_line->>'project_id','')::uuid
    );
  END LOOP;

  SELECT * INTO v_bill FROM finance.vendor_bills WHERE id=v_bill.id;
  RETURN v_bill;
END;
$$;

GRANT EXECUTE ON FUNCTION finance.save_vendor_bill_atomic(uuid,jsonb,jsonb,uuid,uuid) TO authenticated;
