-- ═══════════════════════════════════════════════════════════════════════
-- P2_034: Re-fix AP-01 in finance.post_vendor_payment_atomic
-- ═══════════════════════════════════════════════════════════════════════
-- Apply this migration to the database (e.g. via the Supabase CLI /
-- migration runner). Once applied, regenerate schema.sql from the live
-- database in the normal way (e.g. `supabase db dump`) rather than
-- hand-editing the dump — schema.sql in this repo has already been
-- updated to match the end state produced by this migration so local
-- development / fresh installs are not left broken in the meantime.
--
-- AP-01 (P0, financial / data-integrity) — REGRESSION
-- ---------------------------------------------------------------------
-- finance.vendor_payment_allocations has never had an organization_id
-- column (see CREATE TABLE, schema.sql ~14215-14230): id,
-- vendor_payment_id, vendor_bill_id, allocated_amount,
-- base_allocated_amount, allocated_by, allocated_at, discount_amount,
-- base_discount_amount. Org membership for this table has always been
-- established via its FK to finance.vendor_bills (which does carry
-- organization_id) — see the vpa_insert_org_scoped / vpa_select_org_scoped
-- RLS policies, which join to vendor_bills for exactly this reason.
--
-- P2_017_ap01_vendor_payment_posting_fix.sql already fixed this in
-- finance.post_vendor_payment() by dropping the two vpa.organization_id
-- references and relying on the existing JOIN to vendor_bills instead.
--
-- P2_017b_vendor_payment_atomic_posting.sql, added in the same rollout to
-- fix the unrelated AP-02 non-atomic-posting bug, introduced a NEW
-- function, finance.post_vendor_payment_atomic(), by copying the
-- *pre-AP-01-fix* body of post_vendor_payment() — so the same two
-- vpa.organization_id references came right back, in the one function the
-- application actually calls (src/app/api/finance/vendor-payments/[id]/
-- route.ts and, transitively via post_vendor_payment_batch_atomic, src/
-- app/api/finance/vendor-payments/batches/[id]/route.ts). Every posting
-- attempt has been failing with 42703 ("column vpa.organization_id does
-- not exist") ever since.
--
-- Fix: identical to P2_017 — drop both vpa.organization_id references in
-- post_vendor_payment_atomic and re-derive org scoping via the existing
-- JOIN to finance.vendor_bills, matching this table's own RLS policies.
-- No column is added to vendor_payment_allocations; no application code
-- changes are required (the route handlers already call
-- post_vendor_payment_atomic / post_vendor_payment_batch_atomic and only
-- need the function body fixed).
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

  -- AP-01 FIX: finance.vendor_payment_allocations has no organization_id
  -- column. Org membership of each allocation is established solely by
  -- joining to finance.vendor_bills (which does have organization_id),
  -- exactly like this table's own RLS policies (vpa_insert_org_scoped /
  -- vpa_select_org_scoped) already do, and matching the fix already
  -- applied to finance.post_vendor_payment() in P2_017.
  SELECT
    COALESCE(SUM(vpa.allocated_amount), 0),
    COALESCE(SUM((SELECT COALESCE(SUM(COALESCE(bl.base_withholding_amount, bl.withholding_amount, 0)), 0)
      FROM finance.vendor_bill_lines bl WHERE bl.vendor_bill_id = vpa.vendor_bill_id AND bl.organization_id = v_org)), 0),
    COALESCE(SUM(vpa.discount_amount), 0)
  INTO v_total_allocated, v_total_withholding, v_total_discount
  FROM finance.vendor_payment_allocations vpa
  JOIN finance.vendor_bills vb ON vb.id = vpa.vendor_bill_id AND vb.organization_id = v_org
  WHERE vpa.vendor_payment_id = p_payment_id;

  -- AP-01 FIX: same defensive cross-org check as before, rewritten to go
  -- through the vendor_bills join instead of the nonexistent
  -- vpa.organization_id column. Catches an allocation whose bill belongs
  -- to a different organization than the caller's.
  IF EXISTS (
    SELECT 1 FROM finance.vendor_payment_allocations vpa
    JOIN finance.vendor_bills vb ON vb.id = vpa.vendor_bill_id
    WHERE vpa.vendor_payment_id = p_payment_id
      AND vb.organization_id IS DISTINCT FROM v_org
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

  -- AP-02 FIX: this UPDATE runs in the SAME transaction as the journal
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

COMMENT ON FUNCTION "finance"."post_vendor_payment_atomic"("p_payment_id" "uuid", "p_period_id" "uuid", "p_transaction_date" "date") IS 'AP-01 FIX (P0, re-applied): removed two references to vpa.organization_id, a column that does not exist on finance.vendor_payment_allocations. These had been correctly removed from finance.post_vendor_payment() by P2_017 but were reintroduced here when P2_017b copied that function''s pre-fix body to create post_vendor_payment_atomic, breaking every vendor-payment GL posting (single and batch) with 42703. Org membership of each allocation is now established solely via the existing JOIN to finance.vendor_bills.organization_id, matching this table''s own RLS policies. AP-02 atomicity behavior (journal + status flip in one transaction) is unchanged.';

REVOKE ALL ON FUNCTION "finance"."post_vendor_payment_atomic"("p_payment_id" "uuid", "p_period_id" "uuid", "p_transaction_date" "date") FROM PUBLIC;
GRANT ALL ON FUNCTION "finance"."post_vendor_payment_atomic"("p_payment_id" "uuid", "p_period_id" "uuid", "p_transaction_date" "date") TO "authenticated";