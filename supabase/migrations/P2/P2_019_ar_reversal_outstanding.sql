-- =====================================================================
-- Finance Management System — Critical Fix
--   AR-04 (P1): Payment reversal leaves outstanding_amount stale; AR
--               aging understates receivables.
--
--   Two compounding bugs:
--
--   1) finance.auto_update_invoice_status trigger (schema.sql ~1874):
--        LEFT JOIN finance.payment_allocations pa ON pa.invoice_id = i.id
--      has no `AND pa.status = 'ACTIVE'` filter, so SUM(pa.allocated_amount)
--      counts REVERSED allocation rows exactly the same as ACTIVE ones
--      (reversing an allocation only flips its status column -- the
--      allocated_amount value itself is untouched, by design, as the
--      audit trail of what was reversed).
--
--   2) finance.reverse_payment_receipt_atomic (schema.sql ~6530+):
--      after flipping the allocation rows to status='REVERSED', it does
--      its own explicit UPDATE public.invoices to reduce amount_paid and
--      reset status -- but that UPDATE never touches outstanding_amount
--      or base_outstanding_amount at all. Those two columns are exactly
--      what reporting.receivable_aging (the AR aging view) reads
--      directly, so they were left holding whatever stale value bug (1)
--      had already written.
--
--   Net effect walking through a reversal:
--     a) `UPDATE finance.payment_allocations SET status='REVERSED' ...`
--        fires trg_auto_update_invoice_status per row. Because of bug
--        (1), that trigger recomputes outstanding_amount by summing the
--        allocation it is in the middle of reversing right along with
--        the still-active ones -- i.e. it (re)writes the SAME stale
--        outstanding_amount/status as before the reversal.
--     b) The function's own explicit UPDATE public.invoices then fixes
--        amount_paid and status by subtracting the reversed amount from
--        the current (still-correct-looking) amount_paid -- but per bug
--        (2) it never re-derives outstanding_amount/base_outstanding_amount,
--        so those two columns are left at the bug-(1) stale value:
--        understated receivables that never grow back after a reversal.
--
--   Fix:
--     1) Trigger: filter the JOIN to `pa.status = 'ACTIVE'` so a
--        reversed allocation is excluded from the sum the moment its
--        status flips -- this alone makes the trigger correctly restore
--        outstanding_amount/amount_paid/status on the very UPDATE that
--        reverses it.
--     2) reverse_payment_receipt_atomic: replace the incremental
--        "subtract the reversed amount from current amount_paid"
--        approach (which would double-subtract now that the trigger
--        also fixes it) with a full, authoritative recompute of
--        amount_paid / base_amount_paid / outstanding_amount /
--        base_outstanding_amount / status from the ACTIVE allocations
--        that remain, for every invoice touched by this receipt. This
--        is idempotent regardless of trigger execution order or timing,
--        so it stays correct even if bug (1) is ever reintroduced.
--
-- Safe to run more than once (CREATE OR REPLACE).
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- 1) finance.auto_update_invoice_status trigger function
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
  -- AR-04 FIX: joined ONLY on ACTIVE allocations -- a REVERSED
  -- allocation's allocated_amount is intentionally kept as an audit
  -- trail, so without this filter a reversed row was still being summed
  -- into "money paid", leaving outstanding_amount permanently stale
  -- after any reversal.
  SELECT
    i.total_amount - COALESCE(SUM(pa.allocated_amount), 0),
    i.base_total_amount - COALESCE(SUM(pa.base_allocated_amount), 0),
    i.total_amount,
    i.base_total_amount,
    i.status
  INTO v_outstanding, v_base_outstanding, v_total, v_base_total, v_current_status
  FROM public.invoices i
  LEFT JOIN finance.payment_allocations pa
    ON pa.invoice_id = i.id AND pa.status = 'ACTIVE'
  WHERE i.id = NEW.invoice_id
  GROUP BY i.total_amount, i.base_total_amount, i.status;

  -- AR-03 backstop guard (unchanged): only a payable invoice may have its
  -- balance moved by an allocation insert/update.
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
  'Fixed 2026: base_amount_paid previously always computed as 0 due to variable reuse. See migration 016. AR-03 fix: backstop invoice-status guard on INSERT/UPDATE. AR-04 fix: JOIN now filters to pa.status = ''ACTIVE'' so reversed allocations no longer count toward amount_paid/outstanding_amount, which had left outstanding_amount permanently stale after a payment reversal.';

-- ---------------------------------------------------------------------
-- 2) finance.reverse_payment_receipt_atomic
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION "finance"."reverse_payment_receipt_atomic"("p_receipt_id" "uuid", "p_period_id" "uuid", "p_reversal_date" "date", "p_reason" "text", "p_reversed_by" "uuid") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'finance', 'public', 'core'
    AS $$
DECLARE v_org uuid:=core.current_user_org_id(); v_r record; v_j record; v_new uuid; v_lines jsonb; v_ref text;
BEGIN
  IF v_org IS NULL OR p_reversed_by IS DISTINCT FROM auth.uid() THEN RAISE EXCEPTION 'Access denied'; END IF;
  IF NOT (core.is_finance_head() OR core.has_role('ACCOUNTANT')) THEN RAISE EXCEPTION 'Insufficient privileges'; END IF;
  IF p_reason IS NULL OR btrim(p_reason)='' THEN RAISE EXCEPTION 'Reason is required'; END IF;
  SELECT * INTO v_r FROM finance.payment_receipts WHERE id=p_receipt_id AND organization_id=v_org FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Payment receipt not found or access denied'; END IF;
  IF v_r.status='REVERSED' THEN RAISE EXCEPTION 'Payment receipt is already reversed'; END IF;
  SELECT * INTO v_j FROM finance.journal_entries WHERE id=v_r.journal_entry_id AND organization_id=v_org FOR UPDATE;
  IF NOT FOUND OR v_j.status<>'POSTED' THEN RAISE EXCEPTION 'Original payment journal is not POSTED'; END IF;
  IF NOT EXISTS (SELECT 1 FROM finance.accounting_periods WHERE id=p_period_id AND organization_id=v_org AND status='OPEN') THEN RAISE EXCEPTION 'Reversal period is not OPEN'; END IF;

  SELECT jsonb_agg(jsonb_build_object(
    'account_id',jl.account_id,
    'debit_amount',jl.credit_amount,
    'credit_amount',jl.debit_amount,
    'description','REVERSAL: '||coalesce(jl.description,'')
  ) ORDER BY jl.line_number) INTO v_lines
  FROM finance.journal_lines jl WHERE jl.journal_entry_id=v_j.id;

  v_new := finance.post_journal_entry(
    'REVERSAL: Payment Receipt '||coalesce(v_r.receipt_number,p_receipt_id::text)||' - '||p_reason,
    p_reversal_date,p_period_id,v_lines,v_r.currency,coalesce(v_r.exchange_rate,1),'PAYMENT_REVERSAL',p_receipt_id,v_r.project_id,NULL
  );

  SELECT reference INTO v_ref FROM finance.journal_entries WHERE id=v_new;
  UPDATE finance.payment_receipts SET status='REVERSED',updated_at=now(),posted_by=coalesce(posted_by,p_reversed_by) WHERE id=p_receipt_id;

  UPDATE finance.payment_allocations pa
  SET status='REVERSED',reversed_at=now(),reversed_by=p_reversed_by
  WHERE pa.payment_receipt_id=p_receipt_id AND pa.status='ACTIVE';

  -- AR-04 FIX: previously this only decremented amount_paid/base_amount_paid
  -- by the just-reversed total and reset status -- outstanding_amount and
  -- base_outstanding_amount were never touched, so they stayed at whatever
  -- (stale) value the buggy trigger had last written, understating AR aging
  -- for every invoice this receipt had paid down.
  --
  -- Fixed as a full, authoritative recompute (not an incremental subtract)
  -- from the ACTIVE allocations that remain after this reversal, for every
  -- invoice this receipt touched. This is idempotent regardless of whether
  -- the auto_update_invoice_status trigger above already applied the same
  -- correction via the payment_allocations UPDATE just above -- both now
  -- converge on the same, correct numbers instead of double-subtracting.
  UPDATE public.invoices i
  SET
    amount_paid              = COALESCE(agg.paid, 0),
    base_amount_paid         = COALESCE(agg.base_paid, 0),
    outstanding_amount       = GREATEST(i.total_amount - COALESCE(agg.paid, 0), 0),
    base_outstanding_amount  = GREATEST(i.base_total_amount - COALESCE(agg.base_paid, 0), 0),
    status = CASE
      WHEN GREATEST(i.total_amount - COALESCE(agg.paid, 0), 0) <= 0.01 THEN 'PAID'
      WHEN COALESCE(agg.paid, 0) > 0 THEN 'PARTIALLY_PAID'
      ELSE 'ISSUED'
    END
  FROM (
    SELECT DISTINCT invoice_id
    FROM finance.payment_allocations
    WHERE payment_receipt_id = p_receipt_id
  ) touched
  LEFT JOIN (
    SELECT invoice_id,
           sum(allocated_amount) AS paid,
           sum(base_allocated_amount) AS base_paid
    FROM finance.payment_allocations
    WHERE status = 'ACTIVE'
    GROUP BY invoice_id
  ) agg ON agg.invoice_id = touched.invoice_id
  WHERE i.id = touched.invoice_id AND i.organization_id = v_org;

  RETURN v_new;
END;
$$;

ALTER FUNCTION "finance"."reverse_payment_receipt_atomic"("p_receipt_id" "uuid", "p_period_id" "uuid", "p_reversal_date" "date", "p_reason" "text", "p_reversed_by" "uuid") OWNER TO "postgres";

COMMENT ON FUNCTION "finance"."reverse_payment_receipt_atomic"("p_receipt_id" "uuid", "p_period_id" "uuid", "p_reversal_date" "date", "p_reason" "text", "p_reversed_by" "uuid") IS
  'Confirmed audit fix: atomic payment reversal across GL, receipt, allocations and invoice balances. AR-04 fix: invoice balance update rewritten as a full recompute from remaining ACTIVE allocations (amount_paid, base_amount_paid, outstanding_amount, base_outstanding_amount, status) instead of an incremental subtract that never touched outstanding_amount/base_outstanding_amount -- those were left stale, understating AR aging after every reversal.';

COMMIT;

-- ---------------------------------------------------------------------
-- Verification (run manually):
--
-- 1) Take an ISSUED invoice with total_amount=1000, record and post a
--    full payment receipt against it (amount_paid -> 1000,
--    outstanding_amount -> 0, status -> PAID).
--
-- 2) Reverse that payment receipt via
--      select finance.reverse_payment_receipt_atomic('<receipt_id>',
--        '<open_period_id>', current_date, 'test reversal', '<user_id>');
--
-- 3) Confirm on public.invoices for that invoice:
--      amount_paid = 0, base_amount_paid = 0,
--      outstanding_amount = 1000, base_outstanding_amount = 1000 (or
--      the base-currency equivalent), status = 'ISSUED'.
--    Before this fix, outstanding_amount/base_outstanding_amount would
--    have stayed at 0 despite amount_paid correctly dropping to 0.
--
-- 4) Confirm reporting.receivable_aging now includes this invoice's
--    full outstanding balance again:
--      select outstanding_base_amount FROM reporting.receivable_aging
--      WHERE invoice_id = '<invoice_id>';
--
-- 5) Repeat with a partial payment + reversal (e.g. 400 of 1000) and
--    confirm outstanding_amount correctly returns to 1000 and status to
--    ISSUED, not left at 600/PARTIALLY_PAID.
-- ---------------------------------------------------------------------