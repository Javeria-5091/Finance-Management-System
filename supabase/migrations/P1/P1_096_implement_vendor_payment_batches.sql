-- ============================================================================
-- P1_095_implement_vendor_payment_batches.sql
--
-- AP-05 FIX: "Payment batches" were never actually implemented.
-- finance.vendor_payment_batches / finance.vendor_payment_batch_lines
-- existed in the schema (with risk_flags, submitted_by/approved_by/
-- posted_by columns and their own DRAFT->SUBMITTED->APPROVED->POSTED
-- status machine) but nothing ever wrote to them:
--
--   - src/app/api/finance/vendor-payments/batches/route.ts was a verbatim
--     copy-paste of the single-payment route (see its own header comment,
--     which literally cites itself as the reference for the *other* file).
--     It hardcoded is_batch: false and inserted one finance.vendor_payments
--     row for one vendor — never touched vendor_payment_batches at all.
--   - src/app/api/finance/vendor-payments/batches/[id]/route.ts only knew
--     action IN ('approve','post','cancel') against a single vendor_payment
--     row (.eq('is_batch', false)), not 'submit' against a batch.
--   - dashboard/vendor-payments/batches/page.tsx (lines 52/60) called those
--     endpoints expecting batch shapes (batch_number, payment_count,
--     total_amount) back from a payload that could only ever produce a
--     single vendor_payments row for a single vendor.
--
-- This migration adds the two DB-side pieces the real feature needs so the
-- creation and posting steps are transactional, matching the *_atomic
-- pattern already used elsewhere in this schema (save_vendor_bill_atomic,
-- post_vendor_payment_atomic):
--
--   1. finance.create_vendor_payment_batch_atomic(...) — creates the batch
--      row plus one finance.vendor_payments row (is_batch = true,
--      batch_id = the new batch) and one finance.vendor_payment_batch_lines
--      row PER vendor in the batch, all in a single DB transaction, with
--      basic risk flags written into vendor_payment_batches.risk_flags.
--   2. finance.post_vendor_payment_batch_atomic(p_batch_id) — posts every
--      APPROVED child payment in the batch to the GL via the existing
--      finance.post_vendor_payment_atomic() and only then flips the batch
--      to POSTED, all inside one transaction: if any child payment fails
--      to post (e.g. a missing accounting period), the whole batch's
--      postings roll back together instead of leaving some vendors paid
--      and others not.
--
-- The application-layer routes and the dashboard page are fixed to match
-- in the same commit (see updated route.ts / page.tsx files).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 0. Numbering sequence for batch numbers (finance.get_next_number() raises
--    if a sequence_type row doesn't exist for the org, so seed it for every
--    org that doesn't already have one — same shape as the existing
--    VENDOR_PAYMENT / VENDOR_BILL / etc. rows in seed_data.sql).
-- ---------------------------------------------------------------------------
INSERT INTO finance.numbering_sequences (organization_id, sequence_type, prefix, padding, reset_per_period, format)
SELECT o.id, 'VENDOR_PAYMENT_BATCH', 'BATCH-', 4, false, '{PREFIX}{NUMBER}'
FROM core.organizations o
WHERE NOT EXISTS (
  SELECT 1 FROM finance.numbering_sequences ns
  WHERE ns.organization_id = o.id AND ns.sequence_type = 'VENDOR_PAYMENT_BATCH'
);

-- ---------------------------------------------------------------------------
-- 1. finance.create_vendor_payment_batch_atomic
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION "finance"."create_vendor_payment_batch_atomic"(
  "p_organization_id" "uuid",
  "p_user_id" "uuid",
  "p_payment_date" "date",
  "p_financial_account_id" "uuid",
  "p_payment_method" "text",
  "p_reference" "text",
  "p_description" "text",
  "p_payments" "jsonb"
) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'finance', 'core', 'public'
    AS $$
DECLARE
  v_batch_id uuid := gen_random_uuid();
  v_batch_number text;
  v_group jsonb;
  v_alloc jsonb;
  v_vendor_id uuid;
  v_bill RECORD;
  v_payment_id uuid;
  v_payment_number text;
  v_group_total numeric(18,2);
  v_batch_total numeric(18,2) := 0;
  v_payment_count int := 0;
  v_currency text;
  v_risk_flags jsonb := '[]'::jsonb;
  v_vendor_totals jsonb := '{}'::jsonb;
  v_max_vendor_total numeric(18,2) := 0;
BEGIN
  IF p_user_id IS NULL OR p_user_id <> auth.uid() OR NOT core.same_org(p_organization_id) THEN
    RAISE EXCEPTION 'Invalid authenticated organization context';
  END IF;
  IF NOT (core.is_finance_head() OR core.has_role('ACCOUNTANT')) THEN
    RAISE EXCEPTION 'Insufficient privileges to create vendor payment batches';
  END IF;
  IF p_payments IS NULL OR jsonb_typeof(p_payments) <> 'array' OR jsonb_array_length(p_payments) = 0 THEN
    RAISE EXCEPTION 'A batch requires at least one vendor payment';
  END IF;

  PERFORM 1 FROM finance.financial_accounts
   WHERE id = p_financial_account_id AND organization_id = p_organization_id AND is_active = true;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Financial account not found or inactive';
  END IF;

  FOR v_group IN SELECT * FROM jsonb_array_elements(p_payments)
  LOOP
    v_vendor_id := (v_group->>'vendor_id')::uuid;
    IF v_vendor_id IS NULL THEN
      RAISE EXCEPTION 'Each payment in the batch requires a vendor_id';
    END IF;

    PERFORM 1 FROM finance.vendors
     WHERE id = v_vendor_id AND organization_id = p_organization_id AND is_active = true;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Vendor % not found or inactive in your organization', v_vendor_id;
    END IF;

    IF jsonb_typeof(v_group->'allocations') <> 'array' OR jsonb_array_length(v_group->'allocations') = 0 THEN
      RAISE EXCEPTION 'Vendor % has no bill allocations', v_vendor_id;
    END IF;

    v_group_total := 0;
    v_currency := NULL;

    FOR v_alloc IN SELECT * FROM jsonb_array_elements(v_group->'allocations')
    LOOP
      SELECT id, outstanding_amount, currency INTO v_bill
      FROM finance.vendor_bills
      WHERE id = (v_alloc->>'vendor_bill_id')::uuid
        AND organization_id = p_organization_id
        AND vendor_id = v_vendor_id
        AND status IN ('POSTED', 'PARTIALLY_PAID')
        AND outstanding_amount > 0
      FOR UPDATE;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'Bill % is unavailable, already paid, belongs to a different vendor, or outside your organization', (v_alloc->>'vendor_bill_id');
      END IF;

      IF v_currency IS NULL THEN
        v_currency := COALESCE(v_bill.currency, 'PKR');
      ELSIF v_currency <> COALESCE(v_bill.currency, 'PKR') THEN
        RAISE EXCEPTION 'All bills allocated to vendor % must share the same currency', v_vendor_id;
      END IF;

      IF (v_alloc->>'allocated_amount')::numeric > v_bill.outstanding_amount + 0.01 THEN
        RAISE EXCEPTION 'Allocation of % exceeds outstanding balance (%) for bill %',
          (v_alloc->>'allocated_amount'), v_bill.outstanding_amount, v_bill.id;
      END IF;

      v_group_total := v_group_total + (v_alloc->>'allocated_amount')::numeric;
    END LOOP;

    v_group_total := ROUND(v_group_total, 2);
    IF v_group_total <= 0 THEN
      RAISE EXCEPTION 'Payment amount for vendor % must be greater than zero', v_vendor_id;
    END IF;

    v_payment_number := finance.get_next_number('VENDOR_PAYMENT', p_organization_id);

    INSERT INTO finance.vendor_payments (
      payment_number, payment_date, amount, currency, exchange_rate, base_amount,
      vendor_id, financial_account_id, payment_method, reference, description,
      status, is_batch, batch_id, created_by, organization_id
    ) VALUES (
      v_payment_number, p_payment_date, v_group_total, v_currency, 1, v_group_total,
      v_vendor_id, p_financial_account_id, p_payment_method, p_reference, p_description,
      'DRAFT', true, v_batch_id, p_user_id, p_organization_id
    ) RETURNING id INTO v_payment_id;

    INSERT INTO finance.vendor_payment_allocations
      (vendor_payment_id, vendor_bill_id, allocated_amount, base_allocated_amount, allocated_by)
    SELECT v_payment_id, (a->>'vendor_bill_id')::uuid, (a->>'allocated_amount')::numeric,
           (a->>'allocated_amount')::numeric, p_user_id
    FROM jsonb_array_elements(v_group->'allocations') a;

    INSERT INTO finance.vendor_payment_batch_lines (batch_id, vendor_payment_id, organization_id, amount)
    VALUES (v_batch_id, v_payment_id, p_organization_id, v_group_total);

    v_batch_total := v_batch_total + v_group_total;
    v_payment_count := v_payment_count + 1;
    v_vendor_totals := jsonb_set(
      v_vendor_totals, ARRAY[v_vendor_id::text],
      to_jsonb(COALESCE((v_vendor_totals->>v_vendor_id::text)::numeric, 0) + v_group_total)
    );
  END LOOP;

  v_batch_total := ROUND(v_batch_total, 2);

  SELECT MAX((kv.value)::numeric) INTO v_max_vendor_total FROM jsonb_each(v_vendor_totals) kv;

  IF v_batch_total > 1000000 THEN
    v_risk_flags := v_risk_flags || jsonb_build_object(
      'type', 'HIGH_VALUE_BATCH', 'message', 'Batch total exceeds PKR 1,000,000'
    );
  END IF;
  IF v_payment_count > 20 THEN
    v_risk_flags := v_risk_flags || jsonb_build_object(
      'type', 'LARGE_BATCH', 'message', format('Batch contains %s payments', v_payment_count)
    );
  END IF;
  IF v_payment_count > 1 AND v_max_vendor_total > (v_batch_total * 0.7) THEN
    v_risk_flags := v_risk_flags || jsonb_build_object(
      'type', 'VENDOR_CONCENTRATION', 'message', 'A single vendor accounts for over 70% of this batch''s value'
    );
  END IF;

  BEGIN
    v_batch_number := finance.get_next_number('VENDOR_PAYMENT_BATCH', p_organization_id);
  EXCEPTION WHEN OTHERS THEN
    v_batch_number := 'BATCH-' || to_char(now(), 'YYYYMMDDHH24MISS');
  END;

  INSERT INTO finance.vendor_payment_batches (
    id, organization_id, batch_number, payment_date, financial_account_id,
    status, total_amount, payment_count, risk_flags, created_by
  ) VALUES (
    v_batch_id, p_organization_id, v_batch_number, p_payment_date, p_financial_account_id,
    'DRAFT', v_batch_total, v_payment_count, v_risk_flags, p_user_id
  );

  RETURN jsonb_build_object(
    'batch_id', v_batch_id, 'batch_number', v_batch_number,
    'total_amount', v_batch_total, 'payment_count', v_payment_count,
    'risk_flags', v_risk_flags
  );
END;
$$;

ALTER FUNCTION "finance"."create_vendor_payment_batch_atomic"("p_organization_id" "uuid", "p_user_id" "uuid", "p_payment_date" "date", "p_financial_account_id" "uuid", "p_payment_method" "text", "p_reference" "text", "p_description" "text", "p_payments" "jsonb") OWNER TO "postgres";

COMMENT ON FUNCTION "finance"."create_vendor_payment_batch_atomic"("p_organization_id" "uuid", "p_user_id" "uuid", "p_payment_date" "date", "p_financial_account_id" "uuid", "p_payment_method" "text", "p_reference" "text", "p_description" "text", "p_payments" "jsonb") IS 'AP-05 fix: creates a finance.vendor_payment_batches row plus one finance.vendor_payments row per vendor (is_batch=true, batch_id set) and one finance.vendor_payment_batch_lines row per vendor, all in a single transaction, with basic risk_flags populated. Replaces the previous batches/route.ts, which never touched any of these tables and instead hardcoded is_batch:false onto a single-vendor payment.';

REVOKE ALL ON FUNCTION "finance"."create_vendor_payment_batch_atomic"("p_organization_id" "uuid", "p_user_id" "uuid", "p_payment_date" "date", "p_financial_account_id" "uuid", "p_payment_method" "text", "p_reference" "text", "p_description" "text", "p_payments" "jsonb") FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "finance"."create_vendor_payment_batch_atomic"("p_organization_id" "uuid", "p_user_id" "uuid", "p_payment_date" "date", "p_financial_account_id" "uuid", "p_payment_method" "text", "p_reference" "text", "p_description" "text", "p_payments" "jsonb") TO "authenticated";


-- ---------------------------------------------------------------------------
-- 2. finance.post_vendor_payment_batch_atomic
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION "finance"."post_vendor_payment_batch_atomic"("p_batch_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'finance', 'core', 'public'
    AS $$
DECLARE
  v_org uuid := core.current_user_org_id();
  v_batch RECORD;
  v_payment RECORD;
  v_period_id uuid;
  v_result jsonb;
  v_journal_ids jsonb := '[]'::jsonb;
  v_posted_count int := 0;
BEGIN
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'Access denied: no organization context for caller';
  END IF;
  IF NOT (core.is_finance_head() OR core.has_role('ACCOUNTANT')) THEN
    RAISE EXCEPTION 'Insufficient privileges to post vendor payment batches';
  END IF;

  SELECT * INTO v_batch
  FROM finance.vendor_payment_batches
  WHERE id = p_batch_id AND organization_id = v_org
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Batch not found in your organization';
  END IF;
  IF v_batch.status <> 'APPROVED' THEN
    RAISE EXCEPTION 'Only APPROVED batches can be posted. Current: %', v_batch.status;
  END IF;

  FOR v_payment IN
    SELECT * FROM finance.vendor_payments
    WHERE batch_id = p_batch_id AND organization_id = v_org AND status = 'APPROVED'
    ORDER BY created_at
  LOOP
    SELECT id INTO v_period_id
    FROM finance.accounting_periods
    WHERE status = 'OPEN' AND organization_id = v_org
      AND start_date <= v_payment.payment_date AND end_date >= v_payment.payment_date
    LIMIT 1;

    IF v_period_id IS NULL THEN
      RAISE EXCEPTION 'No OPEN accounting period found for payment % (date %) — the whole batch has been rolled back',
        v_payment.payment_number, v_payment.payment_date;
    END IF;

    v_result := finance.post_vendor_payment_atomic(v_payment.id, v_period_id, v_payment.payment_date);
    v_journal_ids := v_journal_ids || jsonb_build_object('payment_id', v_payment.id, 'journal_id', v_result->>'journal_id');
    v_posted_count := v_posted_count + 1;
  END LOOP;

  IF v_posted_count = 0 THEN
    RAISE EXCEPTION 'Batch has no APPROVED payments left to post';
  END IF;
  IF v_posted_count <> v_batch.payment_count THEN
    RAISE EXCEPTION 'Expected to post % payments but found % — the whole batch has been rolled back',
      v_batch.payment_count, v_posted_count;
  END IF;

  UPDATE finance.vendor_payment_batches
  SET status = 'POSTED', posted_by = auth.uid(), posted_at = now(), updated_at = now()
  WHERE id = p_batch_id AND organization_id = v_org AND status = 'APPROVED';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Batch status update failed while posting to GL';
  END IF;

  RETURN jsonb_build_object('batch_id', p_batch_id, 'posted_count', v_posted_count, 'journals', v_journal_ids);
END;
$$;

ALTER FUNCTION "finance"."post_vendor_payment_batch_atomic"("p_batch_id" "uuid") OWNER TO "postgres";

COMMENT ON FUNCTION "finance"."post_vendor_payment_batch_atomic"("p_batch_id" "uuid") IS 'AP-05 fix: posts every APPROVED child finance.vendor_payments row in a batch to the GL (via the existing finance.post_vendor_payment_atomic) and only then flips finance.vendor_payment_batches to POSTED, all inside one DB transaction. If any child payment cannot be posted (e.g. missing OPEN accounting period), the whole batch rolls back together instead of leaving some vendors paid and others not.';

REVOKE ALL ON FUNCTION "finance"."post_vendor_payment_batch_atomic"("p_batch_id" "uuid") FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "finance"."post_vendor_payment_batch_atomic"("p_batch_id" "uuid") TO "authenticated";