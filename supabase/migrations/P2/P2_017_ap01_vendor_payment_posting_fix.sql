-- =====================================================================
-- Finance Management System — Critical Fix
--   AP-01 (P0): finance.post_vendor_payment references a column that
--   does not exist on finance.vendor_payment_allocations
--   (vpa.organization_id), so EVERY vendor payment GL posting fails.
--
-- Evidence:
--   finance.vendor_payment_allocations (schema.sql) has columns
--   (id, vendor_payment_id, vendor_bill_id, allocated_amount,
--    base_allocated_amount, allocated_by, allocated_at, discount_amount,
--    base_discount_amount) — there is no organization_id column, and
--   never has been (its own RLS policies, "vpa_insert_org_scoped" /
--   "vpa_select_org_scoped", already resolve organization via EXISTS
--   joins to finance.vendor_bills / finance.vendor_payments, which is
--   the tell that the column was never there to begin with).
--
--   finance.post_vendor_payment nonetheless references vpa.organization_id
--   twice: once in the allocation-aggregation query's JOIN/WHERE, and
--   again in a defensive cross-org-mismatch EXISTS check. Both raise
--   "column vpa.organization_id does not exist" (42703) the instant the
--   function runs, so /api/finance/vendor-payments/[id] and
--   /api/finance/vendor-payments/batches/[id] both 500 on the "post"
--   action for every single vendor payment, in every organization.
--
-- Fix (two parts, per the ticket's required fix):
--   1. Drop both vpa.organization_id references; rely on the existing
--      join to finance.vendor_bills (which DOES have organization_id)
--      for org verification, exactly like the table's own RLS policies
--      already do.
--   2. Fold the GL-posting call and the vendor_payments status update
--      into one atomic, idempotent SECURITY DEFINER RPC —
--      finance.post_vendor_payment_atomic — instead of leaving the
--      caller (src/app/api/finance/vendor-payments/[id]/route.ts and
--      .../batches/[id]/route.ts) to call post_vendor_payment for the
--      journal and then run a second, separate UPDATE on
--      finance.vendor_payments for the status flip. That two-step
--      pattern is exactly what finance.post_vendor_bill_atomic /
--      post_expense_atomic / post_income_atomic / post_invoice_atomic
--      already replaced for their respective modules (FND-FIN-001) —
--      this brings vendor payments in line with the same guarantee: a
--      failure partway through cannot leave a POSTED-looking payment
--      with no journal, or a journal with no status flip.
--
--   finance.post_vendor_payment itself is also fixed in place (same two
--   reference corrections) and left in the schema for any other direct
--   caller, but the application no longer calls it — both vendor-payment
--   routes are switched to finance.post_vendor_payment_atomic below.
--
-- Idempotency: post_vendor_payment_atomic raises if a journal entry
-- already exists with source_type = 'VENDOR_PAYMENT' and
-- source_id = p_payment_id (same idempotency guard style already used by
-- finance.post_vendor_bill_atomic's EXISTS check on source_type/source_id),
-- so a retried "post" click (double-submit, network retry) cannot create
-- a second GL journal for the same payment.
--
-- Note on file scope: the ticket also names
-- supabase/migrations/P0/phase_5_ap_vendors/018_payable_aging_posting.sql:214
-- as carrying the same defect. In this checkout that specific file's
-- finance.post_vendor_payment definition does NOT reference
-- organization_id at all (it predates the org-scoping work) — the
-- vpa.organization_id bug was introduced later, in
-- supabase/migrations/P1/P1_088_payroll_vendor_bank_commission_fixes.sql
-- (whose CREATE OR REPLACE is the one still live in schema.sql today).
-- That file is fixed directly for documentation/history consistency
-- alongside this corrective migration, since Postgres functions are
-- replace-in-place and the *last* CREATE OR REPLACE to run is what's
-- actually deployed — this migration is what fixes production.
-- =====================================================================

BEGIN;

-- ── 1. Fix finance.post_vendor_payment in place (drop the two
--       nonexistent-column references; org-check via the vendor_bills
--       join instead) ──────────────────────────────────────────────
CREATE OR REPLACE FUNCTION "finance"."post_vendor_payment"("p_payment_id" "uuid", "p_period_id" "uuid", "p_transaction_date" "date") RETURNS "uuid"
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
BEGIN
  IF v_org IS NULL THEN RAISE EXCEPTION 'Organization context is required'; END IF;
  IF NOT (core.is_finance_head() OR core.has_role('ACCOUNTANT')) THEN RAISE EXCEPTION 'Insufficient privileges to post vendor payment'; END IF;

  SELECT * INTO v_pay FROM finance.vendor_payments
   WHERE id=p_payment_id AND organization_id=v_org FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Payment not found in your organization'; END IF;
  IF v_pay.status <> 'APPROVED' THEN RAISE EXCEPTION 'Only APPROVED vendor payments can be posted'; END IF;

  IF NOT EXISTS (SELECT 1 FROM finance.accounting_periods WHERE id=p_period_id AND organization_id=v_org AND status='OPEN') THEN
    RAISE EXCEPTION 'Invalid or inaccessible accounting period';
  END IF;

  SELECT id INTO v_ap_account FROM finance.chart_of_accounts WHERE organization_id=v_org AND code='2110' AND is_active=true AND posting_allowed=true LIMIT 1;
  IF v_ap_account IS NULL THEN RAISE EXCEPTION 'AP account 2110 not found for organization'; END IF;

  SELECT id INTO v_bank_account FROM finance.chart_of_accounts
   WHERE organization_id=v_org AND code='1110' AND is_active=true AND posting_allowed=true LIMIT 1;
  IF v_bank_account IS NULL THEN RAISE EXCEPTION 'Bank/cash ledger account is not configured for organization'; END IF;

  SELECT id INTO v_wht_payable FROM finance.chart_of_accounts WHERE organization_id=v_org AND code='2210' AND is_active=true AND posting_allowed=true LIMIT 1;
  SELECT id INTO v_discount_account FROM finance.chart_of_accounts
   WHERE organization_id=v_org AND (code='4910' OR name ILIKE '%discount%') AND is_active=true AND posting_allowed=true
   ORDER BY (code='4910') DESC LIMIT 1;

  -- AP-01 FIX: finance.vendor_payment_allocations has no organization_id
  -- column. Org membership of each allocation is established solely by
  -- joining to finance.vendor_bills (which does have organization_id),
  -- exactly like this table's own RLS policies (vpa_insert_org_scoped /
  -- vpa_select_org_scoped) already do.
  SELECT
    COALESCE(SUM(vpa.allocated_amount),0),
    COALESCE(SUM((SELECT COALESCE(SUM(COALESCE(bl.base_withholding_amount,bl.withholding_amount,0)),0)
      FROM finance.vendor_bill_lines bl WHERE bl.vendor_bill_id=vpa.vendor_bill_id AND bl.organization_id=v_org)),0),
    COALESCE(SUM(vpa.discount_amount),0)
  INTO v_total_allocated,v_total_withholding,v_total_discount
  FROM finance.vendor_payment_allocations vpa
  JOIN finance.vendor_bills vb ON vb.id=vpa.vendor_bill_id AND vb.organization_id=v_org
  WHERE vpa.vendor_payment_id=p_payment_id;

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

  IF v_total_discount > 0 AND v_discount_account IS NULL THEN RAISE EXCEPTION 'Discount GL account is not configured for organization'; END IF;
  IF v_total_withholding > 0 AND v_wht_payable IS NULL THEN RAISE EXCEPTION 'Withholding Tax Payable account is not configured for organization'; END IF;

  IF v_total_allocated+v_total_discount+v_total_withholding > 0 THEN
    v_lines := v_lines || jsonb_build_object('account_id',v_ap_account,'debit_amount',v_total_allocated+v_total_discount+v_total_withholding,'credit_amount',0,'description','AP Cleared: '||v_pay.payment_number);
  END IF;
  IF v_total_allocated > 0 THEN
    v_lines := v_lines || jsonb_build_object('account_id',v_bank_account,'debit_amount',0,'credit_amount',v_total_allocated,'description','Paid to Vendor: '||v_pay.payment_number);
  END IF;
  IF v_total_discount > 0 THEN
    v_lines := v_lines || jsonb_build_object('account_id',v_discount_account,'debit_amount',0,'credit_amount',v_total_discount,'description','Early Payment Discount Taken: '||v_pay.payment_number);
  END IF;
  IF v_total_withholding > 0 THEN
    v_lines := v_lines || jsonb_build_object('account_id',v_wht_payable,'debit_amount',0,'credit_amount',v_total_withholding,'description','WHT Deposited: '||v_pay.payment_number);
  END IF;

  RETURN finance.post_journal_entry('Vendor Payment: '||v_pay.payment_number,p_transaction_date,p_period_id,v_lines,'PKR',1,'VENDOR_PAYMENT',p_payment_id,NULL,NULL);
END;
$$;

ALTER FUNCTION "finance"."post_vendor_payment"("p_payment_id" "uuid", "p_period_id" "uuid", "p_transaction_date" "date") OWNER TO "postgres";

COMMENT ON FUNCTION "finance"."post_vendor_payment"("p_payment_id" "uuid", "p_period_id" "uuid", "p_transaction_date" "date") IS
  'AP-01 FIX (P0): removed two references to vpa.organization_id, a '
  'column that does not exist on finance.vendor_payment_allocations '
  '(it was never added by any migration in this dump) — every call '
  'raised 42703 and every vendor payment GL posting failed end-to-end. '
  'Org membership of each allocation is now established solely via the '
  'existing JOIN to finance.vendor_bills.organization_id, matching this '
  'table''s own RLS policies. The application no longer calls this '
  'function directly (see finance.post_vendor_payment_atomic below); '
  'kept and fixed in place for any other direct caller. Previously: '
  'BUG-001 fix (discount_amount GL line for balance).';


-- ── 2. New atomic, idempotent RPC: posts the journal AND flips
--       vendor_payments.status to POSTED in the same DB transaction ──
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
  IF v_org IS NULL THEN RAISE EXCEPTION 'Organization context is required'; END IF;
  IF NOT (core.is_finance_head() OR core.has_role('ACCOUNTANT')) THEN RAISE EXCEPTION 'Insufficient privileges to post vendor payment'; END IF;

  SELECT * INTO v_pay FROM finance.vendor_payments
   WHERE id=p_payment_id AND organization_id=v_org FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Payment not found in your organization'; END IF;
  IF v_pay.status <> 'APPROVED' THEN RAISE EXCEPTION 'Only APPROVED vendor payments can be posted. Current: %', v_pay.status; END IF;

  -- Idempotency guard, same style as finance.post_vendor_bill_atomic:
  -- a retried "post" click cannot create a second GL journal.
  IF EXISTS (
    SELECT 1 FROM finance.journal_entries
    WHERE source_type = 'VENDOR_PAYMENT' AND source_id = p_payment_id
  ) THEN
    RAISE EXCEPTION 'Already posted to GL';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM finance.accounting_periods WHERE id=p_period_id AND organization_id=v_org AND status='OPEN') THEN
    RAISE EXCEPTION 'Invalid or inaccessible accounting period';
  END IF;

  SELECT id INTO v_ap_account FROM finance.chart_of_accounts WHERE organization_id=v_org AND code='2110' AND is_active=true AND posting_allowed=true LIMIT 1;
  IF v_ap_account IS NULL THEN RAISE EXCEPTION 'AP account 2110 not found for organization'; END IF;

  SELECT id INTO v_bank_account FROM finance.chart_of_accounts
   WHERE organization_id=v_org AND code='1110' AND is_active=true AND posting_allowed=true LIMIT 1;
  IF v_bank_account IS NULL THEN RAISE EXCEPTION 'Bank/cash ledger account is not configured for organization'; END IF;

  SELECT id INTO v_wht_payable FROM finance.chart_of_accounts WHERE organization_id=v_org AND code='2210' AND is_active=true AND posting_allowed=true LIMIT 1;
  SELECT id INTO v_discount_account FROM finance.chart_of_accounts
   WHERE organization_id=v_org AND (code='4910' OR name ILIKE '%discount%') AND is_active=true AND posting_allowed=true
   ORDER BY (code='4910') DESC LIMIT 1;

  -- AP-01 FIX: no organization_id column on vendor_payment_allocations —
  -- org membership comes from the vendor_bills join, as above.
  SELECT
    COALESCE(SUM(vpa.allocated_amount),0),
    COALESCE(SUM((SELECT COALESCE(SUM(COALESCE(bl.base_withholding_amount,bl.withholding_amount,0)),0)
      FROM finance.vendor_bill_lines bl WHERE bl.vendor_bill_id=vpa.vendor_bill_id AND bl.organization_id=v_org)),0),
    COALESCE(SUM(vpa.discount_amount),0)
  INTO v_total_allocated,v_total_withholding,v_total_discount
  FROM finance.vendor_payment_allocations vpa
  JOIN finance.vendor_bills vb ON vb.id=vpa.vendor_bill_id AND vb.organization_id=v_org
  WHERE vpa.vendor_payment_id=p_payment_id;

  IF EXISTS (
    SELECT 1 FROM finance.vendor_payment_allocations vpa
    JOIN finance.vendor_bills vb ON vb.id = vpa.vendor_bill_id
    WHERE vpa.vendor_payment_id = p_payment_id
      AND vb.organization_id IS DISTINCT FROM v_org
  ) THEN
    RAISE EXCEPTION 'Vendor payment allocation organization mismatch';
  END IF;

  IF v_total_discount > 0 AND v_discount_account IS NULL THEN RAISE EXCEPTION 'Discount GL account is not configured for organization'; END IF;
  IF v_total_withholding > 0 AND v_wht_payable IS NULL THEN RAISE EXCEPTION 'Withholding Tax Payable account is not configured for organization'; END IF;

  IF v_total_allocated+v_total_discount+v_total_withholding > 0 THEN
    v_lines := v_lines || jsonb_build_object('account_id',v_ap_account,'debit_amount',v_total_allocated+v_total_discount+v_total_withholding,'credit_amount',0,'description','AP Cleared: '||v_pay.payment_number);
  END IF;
  IF v_total_allocated > 0 THEN
    v_lines := v_lines || jsonb_build_object('account_id',v_bank_account,'debit_amount',0,'credit_amount',v_total_allocated,'description','Paid to Vendor: '||v_pay.payment_number);
  END IF;
  IF v_total_discount > 0 THEN
    v_lines := v_lines || jsonb_build_object('account_id',v_discount_account,'debit_amount',0,'credit_amount',v_total_discount,'description','Early Payment Discount Taken: '||v_pay.payment_number);
  END IF;
  IF v_total_withholding > 0 THEN
    v_lines := v_lines || jsonb_build_object('account_id',v_wht_payable,'debit_amount',0,'credit_amount',v_total_withholding,'description','WHT Deposited: '||v_pay.payment_number);
  END IF;

  v_journal_id := finance.post_journal_entry(
    'Vendor Payment: '||v_pay.payment_number, p_transaction_date, p_period_id, v_lines,
    'PKR', 1, 'VENDOR_PAYMENT', p_payment_id, NULL, NULL
  );

  -- Fold the status flip into the same transaction as the journal —
  -- either both commit or neither does.
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

COMMENT ON FUNCTION "finance"."post_vendor_payment_atomic"("p_payment_id" "uuid", "p_period_id" "uuid", "p_transaction_date" "date") IS
  'AP-01 FIX (P0, folds in AP-02): atomic replacement for the previous '
  'post_vendor_payment-then-separate-UPDATE two-step in '
  'src/app/api/finance/vendor-payments/[id]/route.ts and '
  '.../batches/[id]/route.ts. Creates the journal via '
  'finance.post_journal_entry() and marks the vendor payment POSTED in '
  'the same DB transaction, with an idempotency guard (source_type = '
  '''VENDOR_PAYMENT''/source_id) so a retried request cannot double-post. '
  'Also fixes the vpa.organization_id references (see '
  'finance.post_vendor_payment''s comment) that made every posting '
  'attempt fail with 42703.';

GRANT ALL ON FUNCTION "finance"."post_vendor_payment_atomic"("p_payment_id" "uuid", "p_period_id" "uuid", "p_transaction_date" "date") TO "authenticated";

COMMIT;