-- ═══════════════════════════════════════════════════════════════════════
-- P2_016: Atomic GL posting for vendor payments
-- ═══════════════════════════════════════════════════════════════════════
-- Apply this migration to the database (e.g. via the Supabase CLI /
-- migration runner) to fix AP-02.
--
-- NOTE: schema.sql (the consolidated dump) is intentionally left
-- untouched by this change, matching the convention already established
-- in P2_006_atomic_gl_posting_and_profit_distribution_lockdown.sql. Once
-- this migration has been applied to the actual database, regenerate
-- schema.sql from it in the normal way (e.g. `supabase db dump`) rather
-- than hand-editing the dump.
-- ═══════════════════════════════════════════════════════════════════════
--
-- AP-02 (P1, financial / data-integrity)
-- ---------------------------------------------------------------------
-- src/app/api/finance/vendor-payments/[id]/route.ts (lines 91-109) and
-- src/app/api/finance/vendor-payments/batches/[id]/route.ts (lines 95-110)
-- both posted a vendor payment to the GL as TWO separate, non-transactional
-- PostgREST calls:
--
--   1. rpc('post_vendor_payment', ...)   -- creates+commits the journal
--   2. .update() on finance.vendor_payments -- sets status='POSTED',
--      journal_entry_id, period_id, posted_by, posted_at
--
-- These two calls have no transactional link. If step 2 fails for any
-- reason (network drop, a concurrent update flipping status away from
-- APPROVED so the `.eq('status','APPROVED')` filter matches zero rows,
-- a timeout, a crash) the journal from step 1 is already permanently
-- committed, but the payment row is left status = APPROVED with
-- journal_entry_id = NULL.
--
-- That is a double-journal risk, not just an orphan row: the payment still
-- reads as APPROVED, so it is still eligible to be posted. If the user (or
-- an automatic retry) clicks "Post" again, the route's own status guard
-- (`payment.status !== 'APPROVED'`) passes, finance.post_vendor_payment()
-- has no idempotency check of its own, and it creates a SECOND journal
-- entry crediting Bank and debiting AP for the same payment -- double
-- counting the cash outflow and understating AP a second time.
--
-- Fix: exactly the same pattern already used for
-- finance.post_vendor_bill_atomic / post_income_atomic / etc. (see
-- P2_006): add finance.post_vendor_payment_atomic(), a single SECURITY
-- DEFINER PL/pgSQL function that, in one DB transaction:
--   (a) re-validates the payment row under FOR UPDATE lock,
--   (b) explicitly guards against a pre-existing journal for this payment
--       (defense in depth beyond the status check),
--   (c) resolves GL accounts and builds the journal lines (identical logic
--       to the existing finance.post_vendor_payment(), which is left in
--       place, unused by the app, for backward compatibility / audit
--       history -- nothing else calls it),
--   (d) calls finance.post_journal_entry() to create the journal, and
--   (e) updates the payment row to POSTED/linked in the SAME transaction.
-- If any step raises, Postgres rolls back the whole call, including the
-- journal insert -- a payment can no longer end up POSTED-in-the-GL but
-- APPROVED-on-the-row, or vice versa.
--
-- Both route.ts files are updated in this change set to call
-- post_vendor_payment_atomic once instead of post_vendor_payment followed
-- by a separate .update().
-- ═══════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION "finance"."post_vendor_payment_atomic"("p_payment_id" "uuid", "p_period_id" "uuid", "p_transaction_date" "date") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'finance', 'core', 'public'
    AS $$
DECLARE
  v_org uuid := core.current_user_org_id();
  v_pay RECORD;
  v_ap_account uuid;
  v_bank_account uuid;
  v_wht_payable uuid;
  v_discount_account uuid;
  v_total_allocated numeric(18,2);
  v_total_withholding numeric(18,2);
  v_total_discount numeric(18,2);
  v_lines jsonb := '[]'::jsonb;
  v_journal_id uuid;
  v_ref text;
BEGIN
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'Access denied: no organization context for caller';
  END IF;

  IF NOT (core.is_finance_head() OR core.has_role('ACCOUNTANT')) THEN
    RAISE EXCEPTION 'Insufficient privileges to post vendor payment';
  END IF;

  SELECT * INTO v_pay
  FROM finance.vendor_payments
  WHERE id = p_payment_id AND organization_id = v_org
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Payment not found in your organization';
  END IF;

  IF v_pay.status <> 'APPROVED' THEN
    RAISE EXCEPTION 'Only APPROVED vendor payments can be posted. Current: %', v_pay.status;
  END IF;

  -- AP-02 FIX: explicit idempotency guard, defense in depth beyond the
  -- status check above -- if a prior attempt committed the journal but the
  -- (now-removed) separate status UPDATE never ran, this stops a retry
  -- from creating a second journal for the same payment.
  IF EXISTS (
    SELECT 1 FROM finance.journal_entries
    WHERE source_type = 'VENDOR_PAYMENT' AND source_id = p_payment_id
  ) THEN
    RAISE EXCEPTION 'Already posted to GL';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM finance.accounting_periods
    WHERE id = p_period_id AND organization_id = v_org AND status = 'OPEN'
  ) THEN
    RAISE EXCEPTION 'Invalid or inaccessible accounting period';
  END IF;

  SELECT id INTO v_ap_account FROM finance.chart_of_accounts
   WHERE organization_id = v_org AND code = '2110' AND is_active = true AND posting_allowed = true LIMIT 1;
  IF v_ap_account IS NULL THEN
    RAISE EXCEPTION 'AP account 2110 not found for organization';
  END IF;

  SELECT id INTO v_bank_account FROM finance.chart_of_accounts
   WHERE organization_id = v_org AND code = '1110' AND is_active = true AND posting_allowed = true LIMIT 1;
  IF v_bank_account IS NULL THEN
    RAISE EXCEPTION 'Bank/cash ledger account is not configured for organization';
  END IF;

  SELECT id INTO v_wht_payable FROM finance.chart_of_accounts
   WHERE organization_id = v_org AND code = '2210' AND is_active = true AND posting_allowed = true LIMIT 1;
  SELECT id INTO v_discount_account FROM finance.chart_of_accounts
   WHERE organization_id = v_org AND (code = '4910' OR name ILIKE '%discount%') AND is_active = true AND posting_allowed = true
   ORDER BY (code = '4910') DESC LIMIT 1;

  SELECT
    COALESCE(SUM(vpa.allocated_amount), 0),
    COALESCE(SUM((SELECT COALESCE(SUM(COALESCE(bl.base_withholding_amount, bl.withholding_amount, 0)), 0)
      FROM finance.vendor_bill_lines bl WHERE bl.vendor_bill_id = vpa.vendor_bill_id AND bl.organization_id = v_org)), 0),
    COALESCE(SUM(vpa.discount_amount), 0)
  INTO v_total_allocated, v_total_withholding, v_total_discount
  FROM finance.vendor_payment_allocations vpa
  JOIN finance.vendor_bills vb ON vb.id = vpa.vendor_bill_id AND vb.organization_id = v_org
  WHERE vpa.vendor_payment_id = p_payment_id AND vpa.organization_id = v_org;

  IF EXISTS (
    SELECT 1 FROM finance.vendor_payment_allocations vpa
    WHERE vpa.vendor_payment_id = p_payment_id AND vpa.organization_id IS DISTINCT FROM v_org
  ) THEN
    RAISE EXCEPTION 'Vendor payment allocation organization mismatch';
  END IF;

  IF v_total_discount > 0 AND v_discount_account IS NULL THEN
    RAISE EXCEPTION 'Discount GL account is not configured for organization';
  END IF;
  IF v_total_withholding > 0 AND v_wht_payable IS NULL THEN
    RAISE EXCEPTION 'Withholding Tax Payable account is not configured for organization';
  END IF;

  IF v_total_allocated + v_total_discount + v_total_withholding > 0 THEN
    v_lines := v_lines || jsonb_build_object('account_id', v_ap_account, 'debit_amount', v_total_allocated + v_total_discount + v_total_withholding, 'credit_amount', 0, 'description', 'AP Cleared: ' || v_pay.payment_number);
  END IF;
  IF v_total_allocated > 0 THEN
    v_lines := v_lines || jsonb_build_object('account_id', v_bank_account, 'debit_amount', 0, 'credit_amount', v_total_allocated, 'description', 'Paid to Vendor: ' || v_pay.payment_number);
  END IF;
  IF v_total_discount > 0 THEN
    v_lines := v_lines || jsonb_build_object('account_id', v_discount_account, 'debit_amount', 0, 'credit_amount', v_total_discount, 'description', 'Early Payment Discount Taken: ' || v_pay.payment_number);
  END IF;
  IF v_total_withholding > 0 THEN
    v_lines := v_lines || jsonb_build_object('account_id', v_wht_payable, 'debit_amount', 0, 'credit_amount', v_total_withholding, 'description', 'WHT Deposited: ' || v_pay.payment_number);
  END IF;

  v_journal_id := finance.post_journal_entry(
    'Vendor Payment: ' || v_pay.payment_number, p_transaction_date, p_period_id, v_lines,
    'PKR', 1, 'VENDOR_PAYMENT', p_payment_id, NULL, NULL
  );

  -- AP-02 FIX: this UPDATE now runs in the SAME transaction as the journal
  -- insert above (inside finance.post_journal_entry), instead of as a
  -- second, independent PostgREST call from the route. Either both commit
  -- or neither does.
  UPDATE finance.vendor_payments
  SET status = 'POSTED',
      journal_entry_id = v_journal_id,
      period_id = p_period_id,
      posted_by = auth.uid(),
      posted_at = now(),
      updated_at = now()
  WHERE id = p_payment_id
    AND organization_id = v_org
    AND status = 'APPROVED';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Vendor payment status update failed while posting to GL';
  END IF;

  SELECT reference INTO v_ref FROM finance.journal_entries WHERE id = v_journal_id;

  RETURN jsonb_build_object('journal_id', v_journal_id, 'reference', v_ref);
END;
$$;

ALTER FUNCTION "finance"."post_vendor_payment_atomic"("p_payment_id" "uuid", "p_period_id" "uuid", "p_transaction_date" "date") OWNER TO "postgres";

COMMENT ON FUNCTION "finance"."post_vendor_payment_atomic"("p_payment_id" "uuid", "p_period_id" "uuid", "p_transaction_date" "date") IS 'AP-02 fix: atomic replacement for the previous post_vendor_payment-then-separate-UPDATE two-step in src/app/api/finance/vendor-payments/[id]/route.ts and src/app/api/finance/vendor-payments/batches/[id]/route.ts. Creates the journal via finance.post_journal_entry() and marks the vendor payment POSTED (with journal_entry_id/period_id linkage) in the same DB transaction. finance.post_vendor_payment() is left in place, unchanged, for backward compatibility; the app no longer calls it.';

REVOKE ALL ON FUNCTION "finance"."post_vendor_payment_atomic"("p_payment_id" "uuid", "p_period_id" "uuid", "p_transaction_date" "date") FROM PUBLIC;
GRANT ALL ON FUNCTION "finance"."post_vendor_payment_atomic"("p_payment_id" "uuid", "p_period_id" "uuid", "p_transaction_date" "date") TO "authenticated";