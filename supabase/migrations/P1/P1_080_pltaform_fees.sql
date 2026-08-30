-- ═════════════════════════════════════════════════════════════════════
--  BUG-019 FIX: Platform fee engine orphaned and self-broken; settlements
--  never compute expected fees.
--
--  (1) finance.compute_platform_fee() inserted into
--      finance.fee_computation_log WITHOUT organization_id, but that
--      column has a NOT NULL CHECK constraint
--      (fee_computation_log_org_required_going_forward) — so the
--      function crashed on its own logging statement every single time
--      it found a matching rule to compute. The fee_rules lookup was
--      also missing an organization_id filter (a platform_id could only
--      belong to one org in practice here, but the lookup wasn't
--      provably deterministic/tenant-safe without it — spec 5.12 asks
--      for "deterministic fee rule priority").
--
--  (2) finance.finalize_platform_settlement() — called by
--      src/app/api/finance/platform-settlements/[id]/route.ts — did not
--      exist anywhere, so every settlement batch dead-ended at DRAFT.
--
--  (3) finance.fee_rules.applies_to had no 'SETTLEMENT' option, so a fee
--      rule could not be scoped specifically to platform settlements
--      (the primary real-world use of this engine) without abusing
--      'ALL'.
-- ═════════════════════════════════════════════════════════════════════

-- ---------------------------------------------------------------------
-- 1. compute_platform_fee: fix the self-crashing INSERT + make the rule
--    lookup organization-scoped and deterministic.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION "finance"."compute_platform_fee"(
  "p_platform_id" "uuid",
  "p_amount" numeric,
  "p_source_type" character varying DEFAULT 'EXPENSE'::character varying
) RETURNS numeric
LANGUAGE plpgsql SECURITY DEFINER
SET "search_path" TO 'pg_catalog', 'finance', 'public'
AS $$
DECLARE
  v_org_id UUID;
  v_fee NUMERIC(18,4) := 0;
  v_rule RECORD;
  v_tiers RECORD;
  v_remaining NUMERIC(18,4);
  v_tier_min NUMERIC(18,4);
  v_tier_max NUMERIC(18,4);
BEGIN
  -- BUG-019 FIX: derive the owning org from the platform itself, both to
  -- scope the rule lookup deterministically and to satisfy
  -- fee_computation_log's NOT NULL organization_id.
  SELECT organization_id INTO v_org_id FROM finance.platforms WHERE id = p_platform_id;
  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'Platform % not found or has no organization', p_platform_id;
  END IF;

  -- Get the highest-priority active rule for this platform (org-scoped).
  SELECT * INTO v_rule
  FROM finance.fee_rules
  WHERE platform_id = p_platform_id
    AND organization_id = v_org_id
    AND is_active = true
    AND (applies_to = 'ALL' OR applies_to = p_source_type)
    AND (effective_from IS NULL OR effective_from <= CURRENT_DATE)
    AND (effective_to IS NULL OR effective_to >= CURRENT_DATE)
  ORDER BY priority DESC, effective_from DESC
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN 0;
  END IF;

  -- PERCENTAGE: fee = amount * fee_value / 100
  IF v_rule.fee_type = 'PERCENTAGE' THEN
    v_fee := p_amount * v_rule.fee_value / 100;
    IF v_rule.min_fee > 0 AND v_fee < v_rule.min_fee THEN v_fee := v_rule.min_fee; END IF;
    IF v_rule.max_fee > 0 AND v_fee > v_rule.max_fee THEN v_fee := v_rule.max_fee; END IF;

  -- FIXED: flat fee
  ELSIF v_rule.fee_type = 'FIXED' THEN
    v_fee := v_rule.fee_value;

  -- TIERED: graduated calculation
  ELSIF v_rule.fee_type = 'TIERED' THEN
    v_remaining := p_amount;
    FOR v_tiers IN (
      SELECT * FROM finance.fee_tiers
      WHERE fee_rule_id = v_rule.id
      ORDER BY tier_from ASC
    ) LOOP
      v_tier_min := v_tiers.tier_from;
      v_tier_max := CASE WHEN v_tiers.tier_to = 0 THEN p_amount ELSE LEAST(v_tiers.tier_to, p_amount) END;

      IF v_remaining <= 0 THEN EXIT; END IF;

      DECLARE
        v_tierable NUMERIC(18,4);
      BEGIN
        v_tierable := LEAST(GREATEST(v_remaining, 0), v_tier_max - v_tier_min);
        IF v_tierable > 0 THEN
          v_fee := v_fee + (v_tierable * v_tiers.fee_percent / 100) + v_tiers.fee_fixed;
          v_remaining := v_remaining - v_tierable;
        END IF;
      END;
    END LOOP;

  -- SLAB: find the matching slab
  ELSIF v_rule.fee_type = 'SLAB' THEN
    SELECT (p_amount * fee_percent / 100) + fee_fixed INTO v_fee
    FROM finance.fee_tiers
    WHERE fee_rule_id = v_rule.id
      AND p_amount >= tier_from
      AND (tier_to = 0 OR p_amount < tier_to)
    ORDER BY tier_from DESC
    LIMIT 1;
  END IF;

  -- BUG-019 FIX: organization_id is required by
  -- fee_computation_log_org_required_going_forward — omitting it made
  -- this INSERT (and therefore the whole function) fail every time a
  -- rule matched.
  INSERT INTO finance.fee_computation_log (
    source_type, platform_id, fee_rule_id, base_amount, fee_amount, organization_id
  ) VALUES (
    p_source_type, p_platform_id, v_rule.id, p_amount, COALESCE(v_fee, 0), v_org_id
  );

  RETURN COALESCE(v_fee, 0);
END;
$$;

-- ---------------------------------------------------------------------
-- 2. Allow fee rules to be scoped specifically to settlements.
-- ---------------------------------------------------------------------
ALTER TABLE finance.fee_rules DROP CONSTRAINT IF EXISTS fee_rules_applies_to_check;
ALTER TABLE finance.fee_rules ADD CONSTRAINT fee_rules_applies_to_check
  CHECK (applies_to::text = ANY (ARRAY['EXPENSE','INVOICE','VENDOR_BILL','PAYMENT_RECEIPT','SETTLEMENT','ALL']::text[]));

-- ---------------------------------------------------------------------
-- 3. Seed a "Platform Settlement Receivable" ASSET account (code 1420)
--    per organization that already has a chart of accounts — the credit
--    leg finalize_platform_settlement() posts to below, representing
--    the platform-held balance being cleared into cash + fees.
-- ---------------------------------------------------------------------
DO $$
DECLARE
  v_org RECORD;
  v_parent_id UUID;
  v_acct_id UUID;
BEGIN
  FOR v_org IN
    SELECT DISTINCT organization_id FROM finance.chart_of_accounts WHERE organization_id IS NOT NULL
  LOOP
    SELECT id INTO v_acct_id FROM finance.chart_of_accounts
    WHERE organization_id = v_org.organization_id AND code = '1420';

    IF v_acct_id IS NULL THEN
      SELECT id INTO v_parent_id FROM finance.chart_of_accounts
      WHERE organization_id = v_org.organization_id AND code = '1400';

      -- NOTE: finance.chart_of_accounts has a GLOBAL UNIQUE(code)
      -- constraint (coa_code_unique), not UNIQUE(organization_id, code)
      -- — a pre-existing, separate multi-tenancy limitation in this
      -- schema, out of scope to redesign here. ON CONFLICT DO NOTHING
      -- keeps this seed loop safe if a second organization's chart of
      -- accounts happens to already use code 1420 for something else,
      -- rather than aborting the whole migration.
      INSERT INTO finance.chart_of_accounts (
        code, name, account_type, normal_balance, level, parent_id,
        is_control_account, report_mapping, display_order, organization_id, is_active, posting_allowed
      ) VALUES (
        '1420', 'Platform Settlement Receivable', 'ASSET', 'DEBIT', 2, v_parent_id,
        true, 'BALANCE_SHEET_CURRENT_ASSETS', 3, v_org.organization_id, true, true
      )
      ON CONFLICT (code) DO NOTHING;
    END IF;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------
-- 4. finalize_platform_settlement — the missing RPC. DRAFT -> POSTED:
--    posts a GL entry for the settlement and marks the batch posted.
--    Idempotent (re-running on an already-posted batch reuses the
--    existing journal rather than duplicating it). Enforces a basic
--    maker-checker rule (the batch creator cannot finalize it).
--
--    Accounting model (documented so finance can override account
--    resolution later if their books work differently):
--      DR  Bank/financial account ........ net_amount
--      DR  Platform Fees (5200) .......... actual_fee_amount
--      DR  Withholding Tax Receivable (1410) . withholding_amount (if any)
--      DR  Withdrawal Fees (6320) ........ withdrawal_fee_amount (if any)
--      CR  Platform Settlement Receivable (1420) . gross_amount
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION finance.finalize_platform_settlement(
  p_batch_id UUID,
  p_user_id UUID,
  p_organization_id UUID
) RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'pg_catalog', 'finance', 'public'
AS $$
DECLARE
  v_batch RECORD;
  v_bank_account UUID;
  v_fee_expense_account UUID;
  v_wht_account UUID;
  v_withdrawal_account UUID;
  v_receivable_account UUID;
  v_period_id UUID;
  v_journal_id UUID;
  v_lines JSONB;
BEGIN
  SELECT * INTO v_batch
  FROM finance.settlement_batches
  WHERE id = p_batch_id AND organization_id = p_organization_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Settlement batch not found';
  END IF;

  IF v_batch.status = 'POSTED' THEN
    -- Idempotent: return the journal that's already there instead of
    -- erroring, so a client retry after a network blip is harmless.
    SELECT id INTO v_journal_id FROM finance.journal_entries
    WHERE source_type = 'PLATFORM_SETTLEMENT' AND source_id = p_batch_id AND organization_id = p_organization_id
    LIMIT 1;
    IF v_journal_id IS NOT NULL THEN
      RETURN v_journal_id;
    END IF;
    RAISE EXCEPTION 'Settlement batch is already POSTED but no journal entry was found — contact an administrator';
  END IF;

  IF v_batch.status <> 'DRAFT' THEN
    RAISE EXCEPTION 'Only DRAFT settlement batches can be finalized (current status: %)', v_batch.status;
  END IF;

  IF v_batch.created_by IS NOT NULL AND v_batch.created_by = p_user_id THEN
    RAISE EXCEPTION 'MAKER_CHECKER_VIOLATION: the batch creator cannot finalize/reconcile their own settlement';
  END IF;

  IF v_batch.financial_account_id IS NULL THEN
    RAISE EXCEPTION 'Settlement batch has no destination financial account configured';
  END IF;

  SELECT linked_ledger_account_id INTO v_bank_account
  FROM finance.financial_accounts
  WHERE id = v_batch.financial_account_id AND organization_id = p_organization_id;
  IF v_bank_account IS NULL THEN
    RAISE EXCEPTION 'Destination financial account not found or has no linked ledger account';
  END IF;

  SELECT id INTO v_fee_expense_account FROM finance.chart_of_accounts WHERE organization_id = p_organization_id AND code = '5200' AND is_active = true;
  SELECT id INTO v_wht_account FROM finance.chart_of_accounts WHERE organization_id = p_organization_id AND code = '1410' AND is_active = true;
  SELECT id INTO v_withdrawal_account FROM finance.chart_of_accounts WHERE organization_id = p_organization_id AND code = '6320' AND is_active = true;
  SELECT id INTO v_receivable_account FROM finance.chart_of_accounts WHERE organization_id = p_organization_id AND code = '1420' AND is_active = true;

  IF v_fee_expense_account IS NULL THEN RAISE EXCEPTION 'Platform Fees expense account (code 5200) not configured for this organization'; END IF;
  IF v_receivable_account IS NULL THEN RAISE EXCEPTION 'Platform Settlement Receivable account (code 1420) not configured for this organization'; END IF;

  SELECT id INTO v_period_id
  FROM finance.accounting_periods
  WHERE organization_id = p_organization_id
    AND status = 'OPEN'
    AND start_date <= v_batch.settlement_date
    AND end_date >= v_batch.settlement_date
  LIMIT 1;
  IF v_period_id IS NULL THEN
    RAISE EXCEPTION 'No OPEN accounting period covers this settlement date (%)', v_batch.settlement_date;
  END IF;

  v_lines := jsonb_build_array(
    jsonb_build_object('account_id', v_bank_account, 'debit_amount', v_batch.net_amount, 'credit_amount', 0, 'description', 'Net platform settlement received'),
    jsonb_build_object('account_id', v_fee_expense_account, 'debit_amount', v_batch.actual_fee_amount, 'credit_amount', 0, 'description', 'Platform fee (actual)')
  );

  IF v_batch.withholding_amount > 0 THEN
    IF v_wht_account IS NULL THEN RAISE EXCEPTION 'Withholding Tax Receivable account (code 1410) not configured for this organization'; END IF;
    v_lines := v_lines || jsonb_build_array(jsonb_build_object('account_id', v_wht_account, 'debit_amount', v_batch.withholding_amount, 'credit_amount', 0, 'description', 'Withholding tax deducted by platform'));
  END IF;

  IF v_batch.withdrawal_fee_amount > 0 THEN
    IF v_withdrawal_account IS NULL THEN RAISE EXCEPTION 'Withdrawal Fees account (code 6320) not configured for this organization'; END IF;
    v_lines := v_lines || jsonb_build_array(jsonb_build_object('account_id', v_withdrawal_account, 'debit_amount', v_batch.withdrawal_fee_amount, 'credit_amount', 0, 'description', 'Withdrawal/transfer fee'));
  END IF;

  v_lines := v_lines || jsonb_build_array(
    jsonb_build_object('account_id', v_receivable_account, 'debit_amount', 0, 'credit_amount', v_batch.gross_amount, 'description', 'Platform settlement receivable cleared')
  );

  v_journal_id := finance.post_journal_entry(
    p_description => 'Platform settlement ' || v_batch.settlement_reference,
    p_transaction_date => v_batch.settlement_date,
    p_period_id => v_period_id,
    p_lines => v_lines,
    p_currency => v_batch.currency,
    p_exchange_rate => COALESCE(v_batch.exchange_rate, 1),
    p_source_type => 'PLATFORM_SETTLEMENT',
    p_source_id => p_batch_id
  );

  UPDATE finance.settlement_batches
  SET status = 'POSTED',
      approved_by = p_user_id,
      approved_at = now(),
      posted_at = now(),
      updated_at = now()
  WHERE id = p_batch_id AND organization_id = p_organization_id;

  RETURN v_journal_id;
END;
$$;

GRANT EXECUTE ON FUNCTION finance.finalize_platform_settlement(UUID, UUID, UUID) TO authenticated;