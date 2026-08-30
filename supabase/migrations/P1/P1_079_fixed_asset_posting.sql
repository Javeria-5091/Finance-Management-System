-- ================================================================
-- BUG-024 FIX: Fixed Assets lifecycle unimplementable — capitalization,
-- disposal, and depreciation-posting RPCs missing.
--
-- Root causes (application code in src/services/fixed-assets.service.ts
-- already calls these three RPCs by name; none of them existed):
--   - finance.post_asset_capitalization(p_asset_id, p_posted_by)
--   - finance.post_asset_disposal(p_asset_id, p_disposal_date,
--       p_disposal_value, p_disposal_currency, p_disposal_method)
--   - finance.post_depreciation_for_period(p_period_id, p_created_by)
-- finance.fn_add_accumulated_depreciation() already existed (added by an
-- earlier migration) but had no caller, so accumulated_depreciation and
-- net_book_value never moved even when finance.fn_generate_depreciation_for_period()
-- calculated a schedule — the schedule sat at status='calculated' forever.
--
-- Fix: implement all three RPCs. None of them invent a new posting
-- engine — they build ordinary 2+ line journals and post through the
-- existing finance.post_journal_entry(), the same function every other
-- module in this codebase uses (post-vendor-bill, year-end-close,
-- capital-transactions, profit-distribution).
--
-- Schema additions needed to make this possible:
--   - finance.fixed_assets.financial_account_id: which bank/cash account
--     funded the purchase (capitalization credit leg when not on
--     vendor credit) and/or receives disposal proceeds. Mirrors the
--     same pattern added for finance.capital_transactions (BUG-018).
--   - finance.fixed_assets.capitalization_journal_id: traceability back
--     to the acquisition journal, matching the existing
--     disposal_journal_id column (spec 5.10: register reconciles to
--     the ledger).
-- ================================================================

-- ── 1. Schema additions ──────────────────────────────────────────────
ALTER TABLE finance.fixed_assets
  ADD COLUMN IF NOT EXISTS financial_account_id UUID REFERENCES finance.financial_accounts(id),
  ADD COLUMN IF NOT EXISTS capitalization_journal_id UUID REFERENCES finance.journal_entries(id);

COMMENT ON COLUMN finance.fixed_assets.financial_account_id IS
  'BUG-024 FIX: the bank/cash account that funded this asset''s purchase (used as the capitalization credit leg when the asset was not bought on vendor credit) and/or that receives disposal proceeds.';
COMMENT ON COLUMN finance.fixed_assets.capitalization_journal_id IS
  'BUG-024 FIX: the journal entry that recorded this asset''s initial capitalization, for register-to-ledger reconciliation (spec 5.10). Mirrors disposal_journal_id.';

-- ── 2. Capitalization ────────────────────────────────────────────────
-- DR linked_asset_account_id (base_cost)
-- CR financial_accounts.linked_ledger_account_id (if financial_account_id
--   is set -- paid immediately) OR the Vendor Payables control account
--   (code 2110, if bought on credit -- same account post-vendor-bill uses).
CREATE OR REPLACE FUNCTION finance.post_asset_capitalization(
  p_asset_id UUID,
  p_posted_by UUID
) RETURNS finance.fixed_assets
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'finance', 'core', 'public'
    AS $$
DECLARE
  v_asset finance.fixed_assets%ROWTYPE;
  v_org UUID;
  v_period_id UUID;
  v_credit_account_id UUID;
  v_journal_id UUID;
  v_lines JSONB;
BEGIN
  IF NOT (core.is_finance_head() OR core.has_role('ACCOUNTANT')) THEN
    RAISE EXCEPTION 'Insufficient privileges to capitalize a fixed asset. Requires Finance Head, CEO, or Accountant.';
  END IF;

  SELECT * INTO v_asset FROM finance.fixed_assets WHERE id = p_asset_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Fixed asset not found: %', p_asset_id;
  END IF;

  v_org := v_asset.organization_id;
  IF v_org IS DISTINCT FROM core.current_user_org_id() THEN
    RAISE EXCEPTION 'Access denied: asset belongs to another organization';
  END IF;

  IF v_asset.status <> 'pending_capitalization' THEN
    RAISE EXCEPTION 'Only pending_capitalization assets can be capitalized. Current status: %', v_asset.status;
  END IF;

  IF v_asset.linked_asset_account_id IS NULL THEN
    RAISE EXCEPTION 'Asset % has no linked_asset_account_id configured (set on the asset or its category)', v_asset.code;
  END IF;

  -- Resolve the credit leg.
  IF v_asset.financial_account_id IS NOT NULL THEN
    SELECT linked_ledger_account_id INTO v_credit_account_id
    FROM finance.financial_accounts
    WHERE id = v_asset.financial_account_id AND organization_id = v_org AND is_active = true;
    IF v_credit_account_id IS NULL THEN
      RAISE EXCEPTION 'Asset %''s financial account is missing, inactive, or has no linked GL ledger account', v_asset.code;
    END IF;
  ELSE
    SELECT id INTO v_credit_account_id
    FROM finance.chart_of_accounts
    WHERE organization_id = v_org AND code = '2110' AND is_active = true AND posting_allowed IS NOT FALSE;
    IF v_credit_account_id IS NULL THEN
      RAISE EXCEPTION 'No financial_account_id set on asset % and the Vendor Payables control account (code 2110) is missing or not postable', v_asset.code;
    END IF;
  END IF;

  -- Resolve the OPEN accounting period covering the purchase date.
  SELECT id INTO v_period_id
  FROM finance.accounting_periods
  WHERE organization_id = v_org AND status = 'OPEN'
    AND v_asset.purchase_date BETWEEN start_date AND end_date
  ORDER BY start_date DESC LIMIT 1;
  IF v_period_id IS NULL THEN
    SELECT id INTO v_period_id
    FROM finance.accounting_periods
    WHERE organization_id = v_org AND status = 'OPEN'
    ORDER BY start_date DESC LIMIT 1;
  END IF;
  IF v_period_id IS NULL THEN
    RAISE EXCEPTION 'No OPEN accounting period found to post asset capitalization for %', v_asset.code;
  END IF;

  v_lines := jsonb_build_array(
    jsonb_build_object('account_id', v_asset.linked_asset_account_id, 'debit_amount', v_asset.base_cost, 'credit_amount', 0, 'description', 'Capitalize asset ' || v_asset.code || ' - ' || v_asset.name, 'project_id', v_asset.project_id),
    jsonb_build_object('account_id', v_credit_account_id, 'debit_amount', 0, 'credit_amount', v_asset.base_cost, 'description', 'Capitalize asset ' || v_asset.code || ' - ' || v_asset.name)
  );

  v_journal_id := finance.post_journal_entry(
    p_description := 'Asset capitalization: ' || v_asset.code || ' - ' || v_asset.name,
    p_transaction_date := v_asset.purchase_date,
    p_period_id := v_period_id,
    p_lines := v_lines,
    p_currency := v_asset.currency,
    p_exchange_rate := 1,
    p_source_type := 'ASSET_CAPITALIZATION',
    p_source_id := v_asset.id,
    p_project_id := v_asset.project_id,
    p_department_id := v_asset.department_id
  );

  UPDATE finance.fixed_assets
  SET status = 'active',
      approved_by = p_posted_by,
      approved_at = now(),
      capitalization_journal_id = v_journal_id,
      updated_at = now()
  WHERE id = p_asset_id
  RETURNING * INTO v_asset;

  RETURN v_asset;
END;
$$;

COMMENT ON FUNCTION finance.post_asset_capitalization(UUID, UUID) IS 'BUG-024 FIX: previously missing entirely, so no asset could ever leave pending_capitalization. Posts DR asset account / CR funding account (financial_account_id if paid immediately, else Vendor Payables 2110) through finance.post_journal_entry(), then flips the asset to active.';

-- ── 3. Disposal ──────────────────────────────────────────────────────
-- CR linked_asset_account_id (base_cost) -- removes the asset at cost
-- DR linked_depreciation_account_id (accumulated_depreciation) -- removes accumulated depreciation
-- DR financial_accounts.linked_ledger_account_id (disposal_value), if > 0 -- proceeds received
-- Gain (disposal_value > NBV): CR 'Fixed Asset Disposal Gain' (7031)
-- Loss (disposal_value < NBV): DR 'Fixed Asset Disposal Loss' (7131)
CREATE OR REPLACE FUNCTION finance.post_asset_disposal(
  p_asset_id UUID,
  p_disposal_date DATE,
  p_disposal_value NUMERIC,
  p_disposal_currency TEXT,
  p_disposal_method TEXT
) RETURNS finance.fixed_assets
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'finance', 'core', 'public'
    AS $$
DECLARE
  v_asset finance.fixed_assets%ROWTYPE;
  v_org UUID;
  v_period_id UUID;
  v_nbv NUMERIC(18,2);
  v_gain_loss NUMERIC(18,2);
  v_cash_ledger_account_id UUID;
  v_gain_account_id UUID;
  v_loss_account_id UUID;
  v_journal_id UUID;
  v_lines JSONB := '[]'::jsonb;
BEGIN
  IF NOT (core.is_finance_head() OR core.has_role('ACCOUNTANT')) THEN
    RAISE EXCEPTION 'Insufficient privileges to dispose a fixed asset. Requires Finance Head, CEO, or Accountant.';
  END IF;

  IF p_disposal_value IS NULL OR p_disposal_value < 0 THEN
    RAISE EXCEPTION 'Disposal value must be zero or a positive number';
  END IF;

  SELECT * INTO v_asset FROM finance.fixed_assets WHERE id = p_asset_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Fixed asset not found: %', p_asset_id;
  END IF;

  v_org := v_asset.organization_id;
  IF v_org IS DISTINCT FROM core.current_user_org_id() THEN
    RAISE EXCEPTION 'Access denied: asset belongs to another organization';
  END IF;

  IF v_asset.status NOT IN ('active', 'fully_depreciated', 'under_repair') THEN
    RAISE EXCEPTION 'Only active, fully_depreciated, or under_repair assets can be disposed. Current status: %', v_asset.status;
  END IF;

  IF v_asset.linked_asset_account_id IS NULL THEN
    RAISE EXCEPTION 'Asset % has no linked_asset_account_id configured', v_asset.code;
  END IF;
  IF v_asset.accumulated_depreciation > 0 AND v_asset.linked_depreciation_account_id IS NULL THEN
    RAISE EXCEPTION 'Asset % has accumulated depreciation but no linked_depreciation_account_id configured', v_asset.code;
  END IF;

  v_nbv := v_asset.base_cost - v_asset.accumulated_depreciation;
  v_gain_loss := p_disposal_value - v_nbv;

  IF p_disposal_value > 0 THEN
    IF v_asset.financial_account_id IS NULL THEN
      RAISE EXCEPTION 'Asset % has a disposal value but no financial_account_id set to receive the proceeds', v_asset.code;
    END IF;
    SELECT linked_ledger_account_id INTO v_cash_ledger_account_id
    FROM finance.financial_accounts
    WHERE id = v_asset.financial_account_id AND organization_id = v_org AND is_active = true;
    IF v_cash_ledger_account_id IS NULL THEN
      RAISE EXCEPTION 'Asset %''s financial account is missing, inactive, or has no linked GL ledger account', v_asset.code;
    END IF;
  END IF;

  IF v_gain_loss > 0 THEN
    SELECT id INTO v_gain_account_id FROM finance.chart_of_accounts
    WHERE organization_id = v_org AND code = '7031' AND is_active = true AND posting_allowed IS NOT FALSE;
    IF v_gain_account_id IS NULL THEN
      RAISE EXCEPTION 'Fixed Asset Disposal Gain account (code 7031) is missing or not postable';
    END IF;
  ELSIF v_gain_loss < 0 THEN
    SELECT id INTO v_loss_account_id FROM finance.chart_of_accounts
    WHERE organization_id = v_org AND code = '7131' AND is_active = true AND posting_allowed IS NOT FALSE;
    IF v_loss_account_id IS NULL THEN
      RAISE EXCEPTION 'Fixed Asset Disposal Loss account (code 7131) is missing or not postable';
    END IF;
  END IF;

  SELECT id INTO v_period_id
  FROM finance.accounting_periods
  WHERE organization_id = v_org AND status = 'OPEN'
    AND p_disposal_date BETWEEN start_date AND end_date
  ORDER BY start_date DESC LIMIT 1;
  IF v_period_id IS NULL THEN
    SELECT id INTO v_period_id
    FROM finance.accounting_periods
    WHERE organization_id = v_org AND status = 'OPEN'
    ORDER BY start_date DESC LIMIT 1;
  END IF;
  IF v_period_id IS NULL THEN
    RAISE EXCEPTION 'No OPEN accounting period found to post disposal of asset %', v_asset.code;
  END IF;

  v_lines := v_lines || jsonb_build_array(
    jsonb_build_object('account_id', v_asset.linked_asset_account_id, 'debit_amount', 0, 'credit_amount', v_asset.base_cost, 'description', 'Disposal of asset ' || v_asset.code || ' - remove cost')
  );
  IF v_asset.accumulated_depreciation > 0 THEN
    v_lines := v_lines || jsonb_build_array(
      jsonb_build_object('account_id', v_asset.linked_depreciation_account_id, 'debit_amount', v_asset.accumulated_depreciation, 'credit_amount', 0, 'description', 'Disposal of asset ' || v_asset.code || ' - remove accumulated depreciation')
    );
  END IF;
  IF p_disposal_value > 0 THEN
    v_lines := v_lines || jsonb_build_array(
      jsonb_build_object('account_id', v_cash_ledger_account_id, 'debit_amount', p_disposal_value, 'credit_amount', 0, 'description', 'Disposal proceeds: asset ' || v_asset.code)
    );
  END IF;
  IF v_gain_loss > 0 THEN
    v_lines := v_lines || jsonb_build_array(
      jsonb_build_object('account_id', v_gain_account_id, 'debit_amount', 0, 'credit_amount', v_gain_loss, 'description', 'Gain on disposal: asset ' || v_asset.code)
    );
  ELSIF v_gain_loss < 0 THEN
    v_lines := v_lines || jsonb_build_array(
      jsonb_build_object('account_id', v_loss_account_id, 'debit_amount', abs(v_gain_loss), 'credit_amount', 0, 'description', 'Loss on disposal: asset ' || v_asset.code)
    );
  END IF;

  v_journal_id := finance.post_journal_entry(
    p_description := 'Asset disposal: ' || v_asset.code || ' - ' || v_asset.name,
    p_transaction_date := p_disposal_date,
    p_period_id := v_period_id,
    p_lines := v_lines,
    p_currency := COALESCE(p_disposal_currency, v_asset.currency),
    p_exchange_rate := 1,
    p_source_type := 'ASSET_DISPOSAL',
    p_source_id := v_asset.id,
    p_project_id := v_asset.project_id,
    p_department_id := v_asset.department_id
  );

  UPDATE finance.fixed_assets
  SET status = CASE WHEN p_disposal_value > 0 THEN 'sold' ELSE 'disposed' END,
      disposal_date = p_disposal_date,
      disposal_value = p_disposal_value,
      disposal_currency = p_disposal_currency,
      disposal_method = p_disposal_method,
      gain_loss_amount = v_gain_loss,
      disposal_journal_id = v_journal_id,
      updated_at = now()
  WHERE id = p_asset_id
  RETURNING * INTO v_asset;

  RETURN v_asset;
END;
$$;

COMMENT ON FUNCTION finance.post_asset_disposal(UUID, DATE, NUMERIC, TEXT, TEXT) IS 'BUG-024 FIX: previously missing entirely, so no asset could ever be disposed. Removes the asset at cost and its accumulated depreciation, records any sale proceeds and the resulting gain/loss, through finance.post_journal_entry().';

-- ── 4. Depreciation posting ─────────────────────────────────────────
-- For every 'calculated' depreciation_schedule row in the period:
--   DR linked_expense_account_id (depreciation_amount)
--   CR linked_depreciation_account_id (depreciation_amount)
-- Then finance.fn_add_accumulated_depreciation() (existed, had no
-- caller) is invoked per asset so accumulated_depreciation/net_book_value
-- actually move, and each schedule row is marked 'posted'.
CREATE OR REPLACE FUNCTION finance.post_depreciation_for_period(
  p_period_id UUID,
  p_created_by UUID
) RETURNS INTEGER
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'finance', 'core', 'public'
    AS $$
DECLARE
  v_org UUID := core.current_user_org_id();
  v_period_org UUID;
  v_row RECORD;
  v_lines JSONB := '[]'::jsonb;
  v_journal_id UUID;
  v_posted_count INTEGER := 0;
BEGIN
  IF NOT (core.is_finance_head() OR core.has_role('ACCOUNTANT')) THEN
    RAISE EXCEPTION 'Insufficient privileges to post depreciation. Requires Finance Head, CEO, or Accountant.';
  END IF;

  SELECT organization_id INTO v_period_org FROM finance.accounting_periods WHERE id = p_period_id;
  IF v_period_org IS NULL THEN
    RAISE EXCEPTION 'Invalid period_id: %', p_period_id;
  END IF;
  IF v_period_org IS DISTINCT FROM v_org THEN
    RAISE EXCEPTION 'Access denied: accounting period % does not belong to your organization', p_period_id;
  END IF;

  FOR v_row IN
    SELECT ds.id AS schedule_id, ds.asset_id, ds.depreciation_amount,
           fa.code AS asset_code, fa.name AS asset_name,
           fa.linked_depreciation_account_id, fa.linked_expense_account_id,
           fa.project_id, fa.department_id, fa.currency
    FROM finance.depreciation_schedule ds
    JOIN finance.fixed_assets fa ON fa.id = ds.asset_id
    WHERE ds.period_id = p_period_id
      AND ds.status = 'calculated'
      AND fa.organization_id = v_org
    ORDER BY fa.code
  LOOP
    IF v_row.linked_depreciation_account_id IS NULL OR v_row.linked_expense_account_id IS NULL THEN
      RAISE EXCEPTION 'Asset % has no linked_depreciation_account_id/linked_expense_account_id configured', v_row.asset_code;
    END IF;

    v_lines := v_lines || jsonb_build_array(
      jsonb_build_object('account_id', v_row.linked_expense_account_id, 'debit_amount', v_row.depreciation_amount, 'credit_amount', 0, 'description', 'Depreciation: ' || v_row.asset_code || ' - ' || v_row.asset_name, 'project_id', v_row.project_id),
      jsonb_build_object('account_id', v_row.linked_depreciation_account_id, 'debit_amount', 0, 'credit_amount', v_row.depreciation_amount, 'description', 'Depreciation: ' || v_row.asset_code || ' - ' || v_row.asset_name)
    );
    v_posted_count := v_posted_count + 1;
  END LOOP;

  IF v_posted_count = 0 THEN
    RETURN 0;
  END IF;

  v_journal_id := finance.post_journal_entry(
    p_description := 'Depreciation run for period ' || p_period_id::text,
    p_transaction_date := CURRENT_DATE,
    p_period_id := p_period_id,
    p_lines := v_lines,
    p_currency := 'PKR',
    p_exchange_rate := 1,
    p_source_type := 'DEPRECIATION_RUN',
    p_source_id := p_period_id
  );

  -- Wire up finance.fn_add_accumulated_depreciation() (previously had no
  -- caller anywhere), and mark each schedule row posted.
  FOR v_row IN
    SELECT ds.id AS schedule_id, ds.asset_id, ds.depreciation_amount
    FROM finance.depreciation_schedule ds
    JOIN finance.fixed_assets fa ON fa.id = ds.asset_id
    WHERE ds.period_id = p_period_id
      AND ds.status = 'calculated'
      AND fa.organization_id = v_org
  LOOP
    PERFORM finance.fn_add_accumulated_depreciation(v_row.asset_id, v_row.depreciation_amount);

    UPDATE finance.depreciation_schedule
    SET status = 'posted', posted_at = now(), journal_entry_id = v_journal_id
    WHERE id = v_row.schedule_id;
  END LOOP;

  RETURN v_posted_count;
END;
$$;

COMMENT ON FUNCTION finance.post_depreciation_for_period(UUID, UUID) IS 'BUG-024 FIX: previously missing entirely, so finance.fn_generate_depreciation_for_period()''s output sat at status=calculated forever and finance.fn_add_accumulated_depreciation() (which existed) was never called. Posts one journal covering every calculated schedule row in the period, then updates each asset''s accumulated_depreciation/net_book_value and marks the schedule rows posted.';
