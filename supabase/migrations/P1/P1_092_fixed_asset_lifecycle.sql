-- P1_092: Fixed asset lifecycle completion and canonical API support
-- Source of truth: OSYSTIC Finance Management System specification §5.10.
-- Adds impairment/adjustment and transfer accounting events, hardens disposal FX,
-- makes asset-code generation concurrency-safe, and preserves organization scope.

CREATE TABLE IF NOT EXISTS finance.asset_impairments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  asset_id uuid NOT NULL REFERENCES finance.fixed_assets(id),
  adjustment_date date NOT NULL,
  amount numeric(18,2) NOT NULL CHECK (amount > 0),
  reason text NOT NULL CHECK (btrim(reason) <> ''),
  previous_accumulated_depreciation numeric(18,2) NOT NULL,
  previous_net_book_value numeric(18,2) NOT NULL,
  new_accumulated_depreciation numeric(18,2) NOT NULL,
  new_net_book_value numeric(18,2) NOT NULL,
  journal_entry_id uuid,
  created_by uuid NOT NULL REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS finance.asset_transfers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  asset_id uuid NOT NULL REFERENCES finance.fixed_assets(id),
  transfer_date date NOT NULL,
  from_location varchar(200),
  to_location varchar(200),
  from_assigned_user_id uuid,
  to_assigned_user_id uuid,
  from_project_id uuid,
  to_project_id uuid,
  from_department_id uuid,
  to_department_id uuid,
  from_cost_center_id uuid,
  to_cost_center_id uuid,
  reason text NOT NULL CHECK (btrim(reason) <> ''),
  journal_entry_id uuid,
  created_by uuid NOT NULL REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE finance.asset_impairments ENABLE ROW LEVEL SECURITY;
ALTER TABLE finance.asset_transfers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS asset_impairments_select_org ON finance.asset_impairments;
DROP POLICY IF EXISTS asset_impairments_insert_org ON finance.asset_impairments;
DROP POLICY IF EXISTS asset_transfers_select_org ON finance.asset_transfers;
DROP POLICY IF EXISTS asset_transfers_insert_org ON finance.asset_transfers;

CREATE POLICY asset_impairments_select_org ON finance.asset_impairments
  FOR SELECT USING (auth.uid() IS NOT NULL AND core.same_org(organization_id));
CREATE POLICY asset_impairments_insert_org ON finance.asset_impairments
  FOR INSERT WITH CHECK (auth.uid() IS NOT NULL AND core.same_org(organization_id));
CREATE POLICY asset_transfers_select_org ON finance.asset_transfers
  FOR SELECT USING (auth.uid() IS NOT NULL AND core.same_org(organization_id));
CREATE POLICY asset_transfers_insert_org ON finance.asset_transfers
  FOR INSERT WITH CHECK (auth.uid() IS NOT NULL AND core.same_org(organization_id));

CREATE INDEX IF NOT EXISTS asset_impairments_asset_idx ON finance.asset_impairments(asset_id, adjustment_date);
CREATE INDEX IF NOT EXISTS asset_transfers_asset_idx ON finance.asset_transfers(asset_id, transfer_date);

-- Concurrency-safe, organization-scoped asset code generation.
CREATE OR REPLACE FUNCTION finance.generate_next_asset_code()
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, finance, core, public
AS $$
DECLARE
  v_org uuid := core.current_user_org_id();
  v_next integer;
BEGIN
  IF auth.uid() IS NULL OR v_org IS NULL THEN
    RAISE EXCEPTION 'Authentication and organization context are required';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(v_org::text || ':fixed_asset_code', 0));

  SELECT COALESCE(MAX((substring(code FROM '^AST-([0-9]+)$'))::integer), 0) + 1
    INTO v_next
  FROM finance.fixed_assets
  WHERE organization_id = v_org;

  RETURN 'AST-' || lpad(v_next::text, 4, '0');
END;
$$;

-- Disposal now converts original-currency proceeds to PKR using an approved,
-- locked organization FX rate. No hardcoded 1 for non-PKR currencies.
CREATE OR REPLACE FUNCTION finance.post_asset_disposal(
  p_asset_id uuid,
  p_disposal_date date,
  p_disposal_value numeric,
  p_disposal_currency text,
  p_disposal_method text
) RETURNS finance.fixed_assets
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, finance, core, public
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

CREATE OR REPLACE FUNCTION finance.post_asset_impairment(
  p_asset_id uuid, p_adjustment_date date, p_amount numeric, p_reason text, p_posted_by uuid
) RETURNS finance.fixed_assets
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, finance, core, public
AS $$
DECLARE
  a finance.fixed_assets%ROWTYPE; org_id uuid; period_id uuid; journal_id uuid;
  new_acc numeric(18,2); new_nbv numeric(18,2); lines jsonb;
BEGIN
  IF NOT (core.is_finance_head() OR core.has_role('ACCOUNTANT')) THEN RAISE EXCEPTION 'Insufficient privileges for asset impairment/adjustment'; END IF;
  IF p_amount IS NULL OR p_amount <= 0 OR p_reason IS NULL OR btrim(p_reason) = '' THEN RAISE EXCEPTION 'Positive amount and reason are required'; END IF;
  SELECT * INTO a FROM finance.fixed_assets WHERE id = p_asset_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Fixed asset not found'; END IF;
  org_id := a.organization_id;
  IF NOT core.same_org(org_id) THEN RAISE EXCEPTION 'Access denied: asset belongs to another organization'; END IF;
  IF a.status NOT IN ('active','fully_depreciated','under_repair') THEN RAISE EXCEPTION 'Only active/fully_depreciated/under_repair assets may be impaired'; END IF;
  IF p_amount > a.net_book_value THEN RAISE EXCEPTION 'Impairment cannot exceed current net book value'; END IF;
  IF a.linked_expense_account_id IS NULL OR a.linked_depreciation_account_id IS NULL THEN RAISE EXCEPTION 'Asset impairment requires linked expense and depreciation accounts'; END IF;
  SELECT id INTO period_id FROM finance.accounting_periods WHERE organization_id=org_id AND status='OPEN' AND p_adjustment_date BETWEEN start_date AND end_date ORDER BY start_date DESC LIMIT 1;
  IF period_id IS NULL THEN RAISE EXCEPTION 'No OPEN accounting period found for adjustment date %', p_adjustment_date; END IF;
  new_acc := a.accumulated_depreciation + p_amount; new_nbv := a.net_book_value - p_amount;
  lines := jsonb_build_array(
    jsonb_build_object('account_id', a.linked_expense_account_id, 'debit_amount', p_amount, 'credit_amount', 0, 'description', 'Asset impairment: '||a.code||' - '||p_reason, 'project_id', a.project_id),
    jsonb_build_object('account_id', a.linked_depreciation_account_id, 'debit_amount', 0, 'credit_amount', p_amount, 'description', 'Asset impairment allowance: '||a.code, 'project_id', a.project_id)
  );
  journal_id := finance.post_journal_entry('Asset impairment: '||a.code||' - '||a.name, p_adjustment_date, period_id, lines, 'PKR', 1, 'ASSET_IMPAIRMENT', a.id, a.project_id, a.department_id);
  INSERT INTO finance.asset_impairments(organization_id,asset_id,adjustment_date,amount,reason,previous_accumulated_depreciation,previous_net_book_value,new_accumulated_depreciation,new_net_book_value,journal_entry_id,created_by)
  VALUES(org_id,a.id,p_adjustment_date,p_amount,p_reason,a.accumulated_depreciation,a.net_book_value,new_acc,new_nbv,journal_id,p_posted_by);
  UPDATE finance.fixed_assets SET accumulated_depreciation=new_acc, net_book_value=new_nbv, status=CASE WHEN new_nbv=0 THEN 'fully_depreciated' ELSE status END, updated_at=now() WHERE id=a.id RETURNING * INTO a;
  RETURN a;
END;
$$;

CREATE OR REPLACE FUNCTION finance.post_asset_transfer(
  p_asset_id uuid, p_transfer_date date, p_location varchar, p_assigned_user_id uuid,
  p_project_id uuid, p_department_id uuid, p_cost_center_id uuid, p_reason text, p_posted_by uuid
) RETURNS finance.fixed_assets
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, finance, core, public
AS $$
DECLARE
  a finance.fixed_assets%ROWTYPE; org_id uuid; period_id uuid; journal_id uuid; lines jsonb;
BEGIN
  IF NOT (core.is_finance_head() OR core.has_role('ACCOUNTANT')) THEN RAISE EXCEPTION 'Insufficient privileges for asset transfer'; END IF;
  IF p_reason IS NULL OR btrim(p_reason)='' THEN RAISE EXCEPTION 'Transfer reason is required'; END IF;
  SELECT * INTO a FROM finance.fixed_assets WHERE id=p_asset_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Fixed asset not found'; END IF;
  org_id:=a.organization_id;
  IF NOT core.same_org(org_id) THEN RAISE EXCEPTION 'Access denied: asset belongs to another organization'; END IF;
  IF a.status IN ('disposed','sold','pending_capitalization') THEN RAISE EXCEPTION 'Asset status % cannot be transferred', a.status; END IF;
  IF p_project_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.projects p WHERE p.id=p_project_id AND p.organization_id=org_id AND p.is_active=true) THEN RAISE EXCEPTION 'Target project is invalid or outside the organization'; END IF;
  IF p_department_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM finance.dimensions d WHERE d.id=p_department_id AND d.organization_id=org_id AND d.type='DEPARTMENT' AND d.is_active=true) THEN RAISE EXCEPTION 'Target department is invalid or outside the organization'; END IF;
  IF p_cost_center_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM finance.dimensions d WHERE d.id=p_cost_center_id AND d.organization_id=org_id AND d.type='COST_CENTER' AND d.is_active=true) THEN RAISE EXCEPTION 'Target cost center is invalid or outside the organization'; END IF;
  SELECT id INTO period_id FROM finance.accounting_periods WHERE organization_id=org_id AND status='OPEN' AND p_transfer_date BETWEEN start_date AND end_date ORDER BY start_date DESC LIMIT 1;
  IF period_id IS NULL THEN RAISE EXCEPTION 'No OPEN accounting period found for transfer date %', p_transfer_date; END IF;

  -- The transfer is represented by a balanced reclassification in the asset account;
  -- project is carried per line, while the header carries the target department.
  IF a.linked_asset_account_id IS NULL THEN RAISE EXCEPTION 'Asset has no linked asset GL account'; END IF;
  lines := jsonb_build_array(
    jsonb_build_object('account_id',a.linked_asset_account_id,'debit_amount',a.base_cost,'credit_amount',0,'description','Asset transfer to new assignment: '||a.code,'project_id',p_project_id),
    jsonb_build_object('account_id',a.linked_asset_account_id,'debit_amount',0,'credit_amount',a.base_cost,'description','Asset transfer from previous assignment: '||a.code,'project_id',a.project_id)
  );
  journal_id := finance.post_journal_entry('Asset transfer: '||a.code||' - '||a.name,p_transfer_date,period_id,lines,'PKR',1,'ASSET_TRANSFER',a.id,p_project_id,p_department_id);
  INSERT INTO finance.asset_transfers(organization_id,asset_id,transfer_date,from_location,to_location,from_assigned_user_id,to_assigned_user_id,from_project_id,to_project_id,from_department_id,to_department_id,from_cost_center_id,to_cost_center_id,reason,journal_entry_id,created_by)
  VALUES(org_id,a.id,p_transfer_date,a.location,p_location,a.assigned_user_id,p_assigned_user_id,a.project_id,p_project_id,a.department_id,p_department_id,a.cost_center_id,p_cost_center_id,p_reason,journal_id,p_posted_by);
  UPDATE finance.fixed_assets SET location=p_location,assigned_user_id=p_assigned_user_id,project_id=p_project_id,department_id=p_department_id,cost_center_id=p_cost_center_id,updated_at=now() WHERE id=a.id RETURNING * INTO a;
  RETURN a;
END;
$$;

-- Verification creation must always carry tenant context; existing RLS already requires it.
-- Keep this server-side service path consistent with the API path.

GRANT SELECT, INSERT ON finance.asset_impairments TO authenticated;
GRANT SELECT, INSERT ON finance.asset_transfers TO authenticated;
GRANT EXECUTE ON FUNCTION finance.generate_next_asset_code() TO authenticated;
GRANT EXECUTE ON FUNCTION finance.post_asset_impairment(uuid,date,numeric,text,uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION finance.post_asset_transfer(uuid,date,varchar,uuid,uuid,uuid,uuid,text,uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION finance.post_asset_disposal(uuid,date,numeric,text,text) TO authenticated;

CREATE OR REPLACE FUNCTION finance.create_fixed_asset(p_input jsonb, p_created_by uuid)
RETURNS finance.fixed_assets
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, finance, core, public
AS $$
DECLARE
  v_org uuid := core.current_user_org_id(); v_code text; v_cat finance.asset_categories%ROWTYPE; v_asset finance.fixed_assets%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL OR v_org IS NULL THEN RAISE EXCEPTION 'Authentication and organization context are required'; END IF;
  IF NOT (core.is_finance_head() OR core.has_role('ACCOUNTANT')) THEN RAISE EXCEPTION 'Insufficient privileges to create fixed assets'; END IF;
  IF p_input->>'name' IS NULL OR btrim(p_input->>'name')='' THEN RAISE EXCEPTION 'Asset name is required'; END IF;
  SELECT * INTO v_cat FROM finance.asset_categories WHERE id=(p_input->>'category_id')::uuid AND organization_id=v_org AND active=true;
  IF NOT FOUND THEN RAISE EXCEPTION 'Asset category not found or inactive'; END IF;
  v_code := finance.generate_next_asset_code();
  INSERT INTO finance.fixed_assets(
    code,name,category_id,description,vendor_id,purchase_date,purchase_cost,currency,base_cost,
    serial_number,warranty_start,warranty_end,location,assigned_user_id,useful_life_months,residual_value_pct,
    depreciation_method,residual_value_amount,linked_asset_account_id,linked_depreciation_account_id,linked_expense_account_id,
    project_id,department_id,cost_center_id,status,created_by,organization_id,financial_account_id
  ) VALUES (
    v_code,p_input->>'name',(p_input->>'category_id')::uuid,p_input->>'description',NULLIF(p_input->>'vendor_id','')::uuid,
    (p_input->>'purchase_date')::date,(p_input->>'purchase_cost')::numeric,upper(coalesce(p_input->>'currency','PKR')),
    (p_input->>'base_cost')::numeric,NULLIF(p_input->>'serial_number',''),NULLIF(p_input->>'warranty_start','')::date,NULLIF(p_input->>'warranty_end','')::date,
    NULLIF(p_input->>'location',''),NULLIF(p_input->>'assigned_user_id','')::uuid,
    coalesce((p_input->>'useful_life_months')::integer,v_cat.useful_life_months),coalesce((p_input->>'residual_value_pct')::numeric,v_cat.residual_value_pct),
    coalesce(NULLIF(p_input->>'depreciation_method',''),v_cat.depreciation_method),coalesce((p_input->>'residual_value_amount')::numeric,0),
    coalesce(NULLIF(p_input->>'linked_asset_account_id','')::uuid,v_cat.linked_asset_account_id),
    coalesce(NULLIF(p_input->>'linked_depreciation_account_id','')::uuid,v_cat.linked_depreciation_account_id),
    coalesce(NULLIF(p_input->>'linked_expense_account_id','')::uuid,v_cat.linked_expense_account_id),
    NULLIF(p_input->>'project_id','')::uuid,NULLIF(p_input->>'department_id','')::uuid,NULLIF(p_input->>'cost_center_id','')::uuid,
    'pending_capitalization',p_created_by,v_org,NULLIF(p_input->>'financial_account_id','')::uuid
  ) RETURNING * INTO v_asset;
  RETURN v_asset;
END;
$$;
GRANT EXECUTE ON FUNCTION finance.create_fixed_asset(jsonb,uuid) TO authenticated;
