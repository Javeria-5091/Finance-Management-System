-- =====================================================================
-- Finance Management System — Critical Fix
--   FND-RLS-03 (P1): finance.finalize_platform_settlement is SECURITY
--   DEFINER, never checks auth.uid(), and trusts p_user_id/
--   p_organization_id as ordinary client parameters. The app route
--   (src/app/api/finance/platform-settlements/[id]/route.ts) does check
--   SETTLEMENT_RECONCILE and passes auth.userId/auth.orgId correctly --
--   but the RPC is directly callable via PostgREST by any authenticated
--   principal (GRANT ALL ... TO authenticated, no REVOKE FROM PUBLIC),
--   so a caller can bypass that route, supply a fabricated p_user_id to
--   defeat the maker-checker check at "the batch creator cannot
--   finalize/reconcile their own settlement", and supply a victim
--   organization_id to post a balanced journal into another tenant's
--   books.
--
-- Fix: same pattern as FND-RLS-02 (calculate_payroll_run) -- validate
-- identity, org, and permission inside the function itself, so it's safe
-- regardless of how it's called.
-- =====================================================================

BEGIN;

CREATE OR REPLACE FUNCTION "finance"."finalize_platform_settlement"("p_batch_id" "uuid", "p_user_id" "uuid", "p_organization_id" "uuid") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'finance', 'public', 'core'
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
  -- FND-RLS-03 FIX: authenticate and authorize inside the function itself
  -- instead of trusting p_user_id/p_organization_id as free client
  -- parameters, or relying on the app route (which an authenticated
  -- caller can bypass by calling this RPC directly via PostgREST).

  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'finalize_platform_settlement: must be called by an authenticated user'
      USING ERRCODE = '28000';
  END IF;

  -- p_organization_id must be the caller's own organization -- never
  -- trust it as a free client parameter, or an authenticated user in one
  -- tenant could post a balanced journal into a victim tenant's books by
  -- supplying that tenant's organization_id.
  IF p_organization_id IS DISTINCT FROM core.current_user_org_id() THEN
    RAISE EXCEPTION 'finalize_platform_settlement: p_organization_id does not match the caller''s organization'
      USING ERRCODE = '42501';
  END IF;

  -- p_user_id must be the caller themselves. This is not just cosmetic:
  -- it's also load-bearing for the maker-checker check further down
  -- (v_batch.created_by = p_user_id) -- if a caller could pass an
  -- arbitrary p_user_id, they could defeat that check by claiming to be
  -- someone other than themselves.
  IF p_user_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'finalize_platform_settlement: p_user_id must match the authenticated caller'
      USING ERRCODE = '42501';
  END IF;

  -- Same permission the app route already enforces
  -- (SETTLEMENT_RECONCILE) -- now also enforced here, so it can't be
  -- bypassed by calling the RPC directly.
  IF NOT core.has_permission(auth.uid(), 'SETTLEMENT_RECONCILE') THEN
    RAISE EXCEPTION 'finalize_platform_settlement: SETTLEMENT_RECONCILE permission required'
      USING ERRCODE = '42501';
  END IF;

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

ALTER FUNCTION "finance"."finalize_platform_settlement"("p_batch_id" "uuid", "p_user_id" "uuid", "p_organization_id" "uuid") OWNER TO "postgres";

COMMENT ON FUNCTION "finance"."finalize_platform_settlement"("p_batch_id" "uuid", "p_user_id" "uuid", "p_organization_id" "uuid") IS
  'FND-RLS-03 fix: now requires auth.uid() IS NOT NULL, p_organization_id = core.current_user_org_id(), p_user_id = auth.uid(), and core.has_permission(auth.uid(),''SETTLEMENT_RECONCILE'') before touching any data. Previously trusted p_user_id/p_organization_id as ordinary client parameters, which let a caller both defeat the maker-checker check (by lying about p_user_id) and post into another tenant''s books (by lying about p_organization_id).';

-- Defense-in-depth: explicit REVOKE FROM PUBLIC. The function's own
-- auth.uid() check now makes it safe regardless of grants, but there is
-- no legitimate reason for this to be reachable by anything other than
-- `authenticated`.
REVOKE ALL ON FUNCTION "finance"."finalize_platform_settlement"("p_batch_id" "uuid", "p_user_id" "uuid", "p_organization_id" "uuid") FROM PUBLIC;
REVOKE ALL ON FUNCTION "finance"."finalize_platform_settlement"("p_batch_id" "uuid", "p_user_id" "uuid", "p_organization_id" "uuid") FROM "anon";

GRANT ALL ON FUNCTION "finance"."finalize_platform_settlement"("p_batch_id" "uuid", "p_user_id" "uuid", "p_organization_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "finance"."finalize_platform_settlement"("p_batch_id" "uuid", "p_user_id" "uuid", "p_organization_id" "uuid") TO "service_role";

COMMIT;

-- ---------------------------------------------------------------------
-- Verification:
--   1) As anon: rpc call fails at auth.uid() IS NULL (and is no longer
--      GRANTed at all).
--   2) As the batch's own creator, WITH SETTLEMENT_RECONCILE, trying to
--      finalize their own DRAFT batch by passing their own uid as
--      p_user_id: still correctly blocked by MAKER_CHECKER_VIOLATION
--      (unchanged -- this fix closes the way to *forge* p_user_id to get
--      around that check, it doesn't touch the check itself).
--   3) As an authenticated user WITHOUT SETTLEMENT_RECONCILE:
--        select finance.finalize_platform_settlement('<batch-id>', auth.uid(), '<own-org-id>');
--        -- expect: ERROR  SETTLEMENT_RECONCILE permission required
--   4) As an authenticated user WITH SETTLEMENT_RECONCILE, passing a
--      foreign org's id as p_organization_id:
--        -- expect: ERROR  p_organization_id does not match the caller's organization
--   5) As an authenticated user WITH SETTLEMENT_RECONCILE, passing
--      someone else's uuid as p_user_id (the original attack -- forging
--      identity to dodge the maker-checker check):
--        -- expect: ERROR  p_user_id must match the authenticated caller
--   6) Normal path (own org, own uid, has SETTLEMENT_RECONCILE, not the
--      batch creator, batch is DRAFT) still succeeds and posts the same
--      balanced journal as before.
-- ---------------------------------------------------------------------