-- =====================================================================
-- Finance Management System — Critical Fix
--   AR-03 (P1): No invoice-status guard: DRAFT or VOID invoices can be
--               marked PARTIALLY_PAID/PAID.
--
--   None of the three places that touch invoice payment status ever
--   checked the invoice's own status first:
--     - finance.allocate_payment_atomic   (schema.sql ~1373+)
--     - finance.post_payment_receipt_atomic (schema.sql ~5384+)
--     - finance.auto_update_invoice_status trigger (schema.sql ~1856+),
--       fired AFTER INSERT/UPDATE/DELETE on finance.payment_allocations
--     - src/app/api/finance/payment-receipts/route.ts:227-252 selects
--       invoice.status but only ever validates amount vs. outstanding
--
--   Net effect: an invoice sitting in DRAFT (never issued to the
--   client), or VOID (cancelled), could still be picked as an
--   allocation target. Its `total_amount - amount_paid` outstanding
--   check passes fine (a DRAFT/VOID invoice still carries a positive
--   total_amount), so the allocation goes through and the invoice gets
--   silently flipped to PARTIALLY_PAID/PAID -- corrupting AR reporting
--   and effectively "un-voiding" a cancelled invoice.
--
--   Fix: only invoices in ISSUED, PARTIALLY_PAID, or OVERDUE status may
--   receive a payment allocation. This is the same "payable" status set
--   already used everywhere else in this codebase for AR (aging view,
--   CEO dashboard accounts_receivable figure, overdue-marking job -- see
--   the `status IN ('ISSUED','PARTIALLY_PAID','OVERDUE')` pattern
--   repeated throughout schema.sql), so this brings payment allocation
--   in line with how the rest of the system already defines "an invoice
--   that can still take money against it".
--
--   Guard added at three layers so no caller (current or future, API or
--   direct SQL) can bypass it:
--     1) allocate_payment_atomic -- fails fast per-invoice, inside the
--        same transaction as the rest of its validation.
--     2) post_payment_receipt_atomic -- same, for the receipt+allocate
--        combined flow.
--     3) auto_update_invoice_status trigger -- the actual, final write
--        path for invoices.status whenever a payment_allocations row is
--        inserted/updated, from *any* source. This is the backstop: even
--        if a future code path inserts into payment_allocations without
--        going through either RPC above, this trigger still refuses to
--        move a non-payable invoice into PARTIALLY_PAID/PAID and rolls
--        back the whole insert.
--   The API route (payment-receipts POST) also gets an early, friendly
--   400 instead of surfacing a raw Postgres exception -- see the
--   accompanying route.ts change in this fix set.
--
-- Safe to run more than once (CREATE OR REPLACE).
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- 1) finance.allocate_payment_atomic
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION "finance"."allocate_payment_atomic"("p_payment_receipt_id" "uuid", "p_allocations" "jsonb", "p_user_id" "uuid", "p_organization_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'finance', 'public', 'core'
    AS $$
DECLARE
  v_receipt finance.payment_receipts%ROWTYPE;
  v_total_existing numeric(18,2);
  v_total_new numeric(18,2);
  v_new_paid numeric(18,2);
  v_alloc jsonb;
  v_invoice public.invoices%ROWTYPE;
  v_existing uuid;
  v_created jsonb := '[]'::jsonb;
BEGIN
  IF p_user_id IS NULL OR p_organization_id IS NULL THEN
    RAISE EXCEPTION 'User and organization context are required';
  END IF;

  IF auth.uid() IS DISTINCT FROM p_user_id THEN
    RAISE EXCEPTION 'User context mismatch';
  END IF;

  IF NOT core.has_permission(p_user_id, 'PAYMENT_RECEIPT_UPDATE') THEN
    RAISE EXCEPTION 'Permission denied';
  END IF;

  SELECT * INTO v_receipt
  FROM finance.payment_receipts
  WHERE id = p_payment_receipt_id
    AND organization_id = p_organization_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Payment receipt not found';
  END IF;

  IF jsonb_typeof(p_allocations) <> 'array' OR jsonb_array_length(p_allocations) = 0 THEN
    RAISE EXCEPTION 'At least one allocation is required';
  END IF;

  SELECT COALESCE(SUM(pa.allocated_amount),0)
    INTO v_total_existing
  FROM finance.payment_allocations pa
  WHERE pa.payment_receipt_id = p_payment_receipt_id;

  v_total_new := 0;

  FOR v_alloc IN SELECT value FROM jsonb_array_elements(p_allocations)
  LOOP
    IF NULLIF(v_alloc->>'invoice_id','') IS NULL
       OR (v_alloc->>'amount') IS NULL THEN
      RAISE EXCEPTION 'Each allocation requires invoice_id and amount';
    END IF;

    IF (v_alloc->>'amount')::numeric <= 0 THEN
      RAISE EXCEPTION 'Allocation amount must be greater than zero';
    END IF;

    SELECT id INTO v_existing
    FROM finance.payment_allocations
    WHERE payment_receipt_id = p_payment_receipt_id
      AND invoice_id = (v_alloc->>'invoice_id')::uuid
    LIMIT 1;

    IF v_existing IS NOT NULL THEN
      RAISE EXCEPTION 'Invoice % is already allocated to this receipt', v_alloc->>'invoice_id';
    END IF;

    SELECT * INTO v_invoice
    FROM public.invoices
    WHERE id = (v_alloc->>'invoice_id')::uuid
      AND organization_id = p_organization_id
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Invoice % not found', v_alloc->>'invoice_id';
    END IF;

    -- AR-03 FIX: only an invoice that has actually been issued (and not
    -- yet fully paid or cancelled) can take a payment allocation.
    IF v_invoice.status NOT IN ('ISSUED', 'PARTIALLY_PAID', 'OVERDUE') THEN
      RAISE EXCEPTION 'Cannot allocate payment to invoice % -- it is % status. Only ISSUED, PARTIALLY_PAID, or OVERDUE invoices can receive payments.', v_invoice.invoice_number, v_invoice.status;
    END IF;

    IF v_invoice.client_id <> v_receipt.client_id THEN
      RAISE EXCEPTION 'Invoice % does not belong to the payment receipt client', v_invoice.invoice_number;
    END IF;

    IF upper(COALESCE(v_invoice.currency, 'PKR'))
       <> upper(COALESCE(v_receipt.currency, 'PKR')) THEN
      RAISE EXCEPTION
        'Currency mismatch: payment receipt is % but invoice % is %',
        COALESCE(v_receipt.currency, 'PKR'),
        v_invoice.invoice_number,
        COALESCE(v_invoice.currency, 'PKR');
    END IF;

    IF (v_alloc->>'amount')::numeric >
       (COALESCE(v_invoice.total_amount,0) - COALESCE(v_invoice.amount_paid,0)) THEN
      RAISE EXCEPTION 'Allocation exceeds outstanding amount for invoice %', v_invoice.invoice_number;
    END IF;

    v_total_new := v_total_new + (v_alloc->>'amount')::numeric;
  END LOOP;

  IF v_total_existing + v_total_new > v_receipt.amount + 0.01 THEN
    RAISE EXCEPTION 'Total allocation exceeds payment receipt amount';
  END IF;

  FOR v_alloc IN SELECT value FROM jsonb_array_elements(p_allocations)
  LOOP
    INSERT INTO finance.payment_allocations (
      payment_receipt_id, invoice_id, allocated_amount,
      base_allocated_amount, allocated_by
    ) VALUES (
      p_payment_receipt_id,
      (v_alloc->>'invoice_id')::uuid,
      (v_alloc->>'amount')::numeric,
      (v_alloc->>'amount')::numeric * COALESCE(v_receipt.exchange_rate,1),
      p_user_id
    )
    RETURNING id INTO v_existing;

    v_created := v_created || jsonb_build_array(jsonb_build_object(
      'id', v_existing,
      'invoice_id', v_alloc->>'invoice_id',
      'amount', (v_alloc->>'amount')::numeric
    ));

    UPDATE public.invoices
    SET amount_paid = COALESCE(amount_paid,0) + (v_alloc->>'amount')::numeric,
        status = CASE
          WHEN COALESCE(amount_paid,0) + (v_alloc->>'amount')::numeric >= total_amount
            THEN 'PAID'
          ELSE 'PARTIALLY_PAID'
        END
    WHERE id = (v_alloc->>'invoice_id')::uuid
      AND organization_id = p_organization_id;
  END LOOP;

  v_new_paid := v_total_existing + v_total_new;

  UPDATE finance.payment_receipts
  SET updated_at = now()
  WHERE id = p_payment_receipt_id
    AND organization_id = p_organization_id;

  RETURN jsonb_build_object(
    'success', true,
    'total_allocated', v_total_new,
    'total_allocated_after', v_new_paid,
    'remaining_unallocated', GREATEST(v_receipt.amount - v_new_paid, 0),
    'receipt_status', CASE
      WHEN v_new_paid >= v_receipt.amount - 0.01 THEN 'FULLY_ALLOCATED'
      ELSE 'PARTIALLY_ALLOCATED'
    END,
    'allocations', v_created
  );
END;
$$;

ALTER FUNCTION "finance"."allocate_payment_atomic"("p_payment_receipt_id" "uuid", "p_allocations" "jsonb", "p_user_id" "uuid", "p_organization_id" "uuid") OWNER TO "postgres";

COMMENT ON FUNCTION "finance"."allocate_payment_atomic"("p_payment_receipt_id" "uuid", "p_allocations" "jsonb", "p_user_id" "uuid", "p_organization_id" "uuid") IS
  'AR-03 fix: added an invoice-status guard (ISSUED/PARTIALLY_PAID/OVERDUE only) so DRAFT or VOID invoices can no longer be pushed to PARTIALLY_PAID/PAID via allocation.';

-- ---------------------------------------------------------------------
-- 2) finance.post_payment_receipt_atomic
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION "finance"."post_payment_receipt_atomic"("p_client_id" "uuid", "p_amount" numeric, "p_currency" "text" DEFAULT 'PKR'::"text", "p_exchange_rate" numeric DEFAULT 1.0000, "p_payment_date" "date" DEFAULT CURRENT_DATE, "p_payment_method" "text" DEFAULT 'BANK_TRANSFER'::"text", "p_reference" "text" DEFAULT NULL::"text", "p_financial_account_id" "uuid" DEFAULT NULL::"uuid", "p_notes" "text" DEFAULT NULL::"text", "p_allocations" "jsonb" DEFAULT '[]'::"jsonb") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'finance', 'public', 'core'
    AS $$
DECLARE
  v_org_id UUID := core.current_user_org_id();
  v_receipt_id UUID;
  v_receipt_number TEXT;
  v_period_id UUID;
  v_journal_id UUID;
  v_alloc JSONB;
  v_invoice RECORD;
  v_alloc_amount NUMERIC(18,2);
  v_base_alloc_amount NUMERIC(18,2);
  v_total_allocated NUMERIC(18,2) := 0;
BEGIN
  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'Access denied: no organization context for caller';
  END IF;

  IF NOT (core.is_finance_head() OR core.has_role('ACCOUNTANT')) THEN
    RAISE EXCEPTION 'Insufficient privileges to record a payment receipt';
  END IF;

  IF to_regprocedure('finance.post_payment_receipt(uuid,uuid,date)') IS NULL THEN
    RAISE EXCEPTION 'Required posting function finance.post_payment_receipt(uuid,uuid,date) is not available';
  END IF;

  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'Payment amount must be greater than zero';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.clients WHERE id = p_client_id AND organization_id = v_org_id) THEN
    RAISE EXCEPTION 'Client not found in your organization';
  END IF;

  IF p_financial_account_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM finance.financial_accounts WHERE id = p_financial_account_id AND organization_id = v_org_id
  ) THEN
    RAISE EXCEPTION 'Financial account not found in your organization';
  END IF;

  SELECT id INTO v_period_id
  FROM finance.accounting_periods
  WHERE status = 'OPEN' AND organization_id = v_org_id
  ORDER BY start_date DESC
  LIMIT 1;
  IF v_period_id IS NULL THEN
    RAISE EXCEPTION 'No OPEN accounting period found';
  END IF;

  v_receipt_number := finance.get_next_number('PMT-RC', v_org_id);
  IF v_receipt_number IS NULL THEN
    v_receipt_number := 'PMT-RC-' || to_char(now(), 'YYYYMMDDHH24MISS');
  END IF;

  INSERT INTO finance.payment_receipts (
    receipt_number, payment_date, amount, currency, exchange_rate,
    base_amount, client_id, financial_account_id, payment_method,
    reference, description, status, period_id, created_by, organization_id
  ) VALUES (
    v_receipt_number, p_payment_date, p_amount, COALESCE(p_currency, 'PKR'), COALESCE(p_exchange_rate, 1),
    ROUND(p_amount * COALESCE(p_exchange_rate, 1), 2), p_client_id, p_financial_account_id, COALESCE(p_payment_method, 'BANK_TRANSFER'),
    p_reference, p_notes, 'DRAFT', v_period_id, auth.uid(), v_org_id
  ) RETURNING id INTO v_receipt_id;

  IF p_allocations IS NOT NULL THEN
    FOR v_alloc IN SELECT * FROM jsonb_array_elements(p_allocations)
    LOOP
      SELECT * INTO v_invoice FROM public.invoices
      WHERE id = (v_alloc->>'invoice_id')::UUID AND organization_id = v_org_id
      FOR UPDATE;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'Invoice % not found in your organization', (v_alloc->>'invoice_id');
      END IF;

      -- AR-03 FIX: only an invoice that has actually been issued (and not
      -- yet fully paid or cancelled) can take a payment allocation.
      IF v_invoice.status NOT IN ('ISSUED', 'PARTIALLY_PAID', 'OVERDUE') THEN
        RAISE EXCEPTION 'Cannot allocate payment to invoice % -- it is % status. Only ISSUED, PARTIALLY_PAID, or OVERDUE invoices can receive payments.', v_invoice.invoice_number, v_invoice.status;
      END IF;

      IF upper(COALESCE(v_invoice.currency, 'PKR'))
         <> upper(COALESCE(p_currency, 'PKR')) THEN
        RAISE EXCEPTION
          'Currency mismatch: payment receipt is % but invoice % is %',
          COALESCE(p_currency, 'PKR'),
          v_invoice.invoice_number,
          COALESCE(v_invoice.currency, 'PKR');
      END IF;

      v_alloc_amount := (v_alloc->>'amount')::NUMERIC(18,2);
      IF v_alloc_amount IS NULL OR v_alloc_amount <= 0 THEN
        RAISE EXCEPTION 'Invalid allocation amount for invoice %', v_invoice.invoice_number;
      END IF;
      IF v_alloc_amount > (v_invoice.total_amount - COALESCE(v_invoice.amount_paid, 0)) THEN
        RAISE EXCEPTION 'Allocation exceeds outstanding balance for invoice %', v_invoice.invoice_number;
      END IF;

      v_base_alloc_amount := ROUND(v_alloc_amount * COALESCE(p_exchange_rate, 1), 2);
      v_total_allocated := v_total_allocated + v_alloc_amount;

      INSERT INTO finance.payment_allocations (
        payment_receipt_id, invoice_id, allocated_amount, base_allocated_amount, allocated_by
      ) VALUES (
        v_receipt_id, v_invoice.id, v_alloc_amount, v_base_alloc_amount, auth.uid()
      );

      UPDATE public.invoices
      SET amount_paid = COALESCE(amount_paid, 0) + v_alloc_amount,
          base_amount_paid = COALESCE(base_amount_paid, 0) + v_base_alloc_amount,
          outstanding_amount = GREATEST(total_amount - (COALESCE(amount_paid, 0) + v_alloc_amount), 0),
          base_outstanding_amount = GREATEST(base_total_amount - (COALESCE(base_amount_paid, 0) + v_base_alloc_amount), 0),
          status = CASE
                     WHEN (COALESCE(amount_paid, 0) + v_alloc_amount) >= total_amount THEN 'PAID'
                     ELSE 'PARTIALLY_PAID'
                   END
      WHERE id = v_invoice.id;
    END LOOP;
  END IF;

  IF v_total_allocated > p_amount + 0.01 THEN
    RAISE EXCEPTION 'Total allocations (%) cannot exceed payment amount (%)', v_total_allocated, p_amount;
  END IF;

  v_journal_id := finance.post_payment_receipt(v_receipt_id, v_period_id, p_payment_date);

  UPDATE finance.payment_receipts
  SET status = 'POSTED', journal_entry_id = v_journal_id, posted_by = auth.uid(), posted_at = now()
  WHERE id = v_receipt_id;

  RETURN jsonb_build_object(
    'receipt_id', v_receipt_id,
    'journal_id', v_journal_id,
    'receipt_number', v_receipt_number
  );
END;
$$;

ALTER FUNCTION "finance"."post_payment_receipt_atomic"("p_client_id" "uuid", "p_amount" numeric, "p_currency" "text", "p_exchange_rate" numeric, "p_payment_date" "date", "p_payment_method" "text", "p_reference" "text", "p_financial_account_id" "uuid", "p_notes" "text", "p_allocations" "jsonb") OWNER TO "postgres";

COMMENT ON FUNCTION "finance"."post_payment_receipt_atomic"("p_client_id" "uuid", "p_amount" numeric, "p_currency" "text", "p_exchange_rate" numeric, "p_payment_date" "date", "p_payment_method" "text", "p_reference" "text", "p_financial_account_id" "uuid", "p_notes" "text", "p_allocations" "jsonb") IS
  'AR-03 fix: added an invoice-status guard (ISSUED/PARTIALLY_PAID/OVERDUE only) inside the allocation loop so DRAFT or VOID invoices can no longer be pushed to PARTIALLY_PAID/PAID via a new payment receipt.';

-- ---------------------------------------------------------------------
-- 3) finance.auto_update_invoice_status trigger function
--    (final write path -- backstop for any caller, current or future)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION "finance"."auto_update_invoice_status"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'finance', 'public'
    AS $$
DECLARE
  v_outstanding      NUMERIC(18,2);
  v_base_outstanding NUMERIC(18,2);
  v_total            NUMERIC(18,2);
  v_base_total       NUMERIC(18,2);
  v_current_status   TEXT;
BEGIN
  -- Calculate outstanding (original currency and base/PKR currency)
  SELECT
    i.total_amount - COALESCE(SUM(pa.allocated_amount), 0),
    i.base_total_amount - COALESCE(SUM(pa.base_allocated_amount), 0),
    i.total_amount,
    i.base_total_amount,
    i.status
  INTO v_outstanding, v_base_outstanding, v_total, v_base_total, v_current_status
  FROM public.invoices i
  LEFT JOIN finance.payment_allocations pa ON pa.invoice_id = i.id
  WHERE i.id = NEW.invoice_id
  GROUP BY i.total_amount, i.base_total_amount, i.status;

  -- AR-03 FIX: this trigger is the actual, final write path for
  -- invoices.status whenever a payment_allocations row is inserted or
  -- updated, regardless of which caller created that row. Both RPCs that
  -- normally create these rows (allocate_payment_atomic and
  -- post_payment_receipt_atomic) now reject DRAFT/VOID/etc. invoices
  -- before inserting -- this is the backstop that still blocks it here
  -- even if some future/other code path inserts directly into
  -- finance.payment_allocations without going through either RPC.
  IF TG_OP IN ('INSERT', 'UPDATE') AND v_current_status NOT IN ('ISSUED', 'PARTIALLY_PAID', 'OVERDUE') THEN
    RAISE EXCEPTION 'Cannot allocate payment to invoice % -- it is % status. Only ISSUED, PARTIALLY_PAID, or OVERDUE invoices can receive payments.', NEW.invoice_id, v_current_status;
  END IF;

  UPDATE public.invoices SET
    amount_paid              = v_total - v_outstanding,
    base_amount_paid         = v_base_total - v_base_outstanding,   -- FIXED (was always 0)
    outstanding_amount       = v_outstanding,
    base_outstanding_amount  = v_base_outstanding,
    status = CASE
      WHEN v_outstanding <= 0 THEN 'PAID'
      WHEN v_outstanding < v_total THEN 'PARTIALLY_PAID'
      ELSE status
    END
  WHERE id = NEW.invoice_id;

  RETURN NEW;
END;
$$;

ALTER FUNCTION "finance"."auto_update_invoice_status"() OWNER TO "postgres";

COMMENT ON FUNCTION "finance"."auto_update_invoice_status"() IS
  'Fixed 2026: base_amount_paid previously always computed as 0 due to variable reuse. See migration 016. AR-03 fix: added a backstop invoice-status guard on INSERT/UPDATE so no caller -- current or future -- can push a DRAFT/VOID/etc. invoice to PARTIALLY_PAID/PAID via finance.payment_allocations.';

COMMIT;

-- ---------------------------------------------------------------------
-- Verification (run manually):
--
-- 1) Create/find an invoice in DRAFT status and attempt to allocate a
--    payment to it via either RPC -- both should now raise:
--      select finance.allocate_payment_atomic('<receipt_id>',
--        '[{"invoice_id":"<draft_invoice_id>","amount":100}]'::jsonb,
--        '<user_id>', '<org_id>');
--    Expect: exception "Cannot allocate payment to invoice ... DRAFT status".
--
-- 2) Same for a VOID invoice.
--
-- 3) Confirm a normal payment against an ISSUED or PARTIALLY_PAID
--    invoice still succeeds and moves it to PARTIALLY_PAID/PAID as
--    before.
--
-- 4) Try inserting directly into finance.payment_allocations for a
--    DRAFT/VOID invoice (bypassing both RPCs) and confirm the trigger
--    itself rejects it:
--      insert into finance.payment_allocations
--        (payment_receipt_id, invoice_id, allocated_amount, allocated_by)
--      values ('<receipt_id>', '<draft_invoice_id>', 100, '<user_id>');
--    Expect: exception from the trigger, insert rolled back.
-- ---------------------------------------------------------------------