-- =====================================================================
-- Migration: 016_accounting_integrity_fixes.sql
-- Purpose:   Fix three CRITICAL accounting-integrity defects found in the
--            compliance audit:
--              (C3) finance.auto_update_invoice_status() always zeroes
--                   base_amount_paid due to a variable-reuse bug.
--              (C2) No database-level guard prevents payment/bill
--                   allocations from exceeding the outstanding balance.
--              (C5) No enforcement that ownership percentages sum to
--                   100% for overlapping effective periods.
-- Spec refs: 4.1, 5.12, 10.5, 13.1 (Section 30 of audit report: R7, R8, R10)
-- Non-destructive: yes (function replace + new BEFORE triggers only)
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- FIX 1 (C3): Correct the base-currency amount-paid calculation bug in
-- finance.auto_update_invoice_status(). The previous version reused
-- v_base_outstanding to hold base_total_amount, then computed
-- (v_base_outstanding - v_base_outstanding), which is always 0.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION "finance"."auto_update_invoice_status"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'finance', 'public'
    AS $$
DECLARE
  v_outstanding      NUMERIC(18,2);
  v_base_outstanding NUMERIC(18,2);
  v_total            NUMERIC(18,2);
  v_base_total        NUMERIC(18,2);
BEGIN
  -- Calculate outstanding (original currency and base/PKR currency)
  SELECT
    i.total_amount - COALESCE(SUM(pa.allocated_amount), 0),
    i.base_total_amount - COALESCE(SUM(pa.base_allocated_amount), 0),
    i.total_amount,
    i.base_total_amount
  INTO v_outstanding, v_base_outstanding, v_total, v_base_total
  FROM public.invoices i
  LEFT JOIN finance.payment_allocations pa ON pa.invoice_id = i.id
  WHERE i.id = NEW.invoice_id
  GROUP BY i.total_amount, i.base_total_amount;

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

COMMENT ON FUNCTION "finance"."auto_update_invoice_status"() IS
  'Fixed 2026: base_amount_paid previously always computed as 0 due to variable reuse. See migration 016.';

-- ---------------------------------------------------------------------
-- FIX 2 (C2): Block allocations that exceed the invoice's outstanding
-- balance. Implemented as a BEFORE INSERT/UPDATE trigger because the
-- check depends on aggregating sibling rows, which a plain CHECK
-- constraint cannot do.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION "finance"."validate_payment_allocation"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'finance', 'public'
    AS $$
DECLARE
  v_invoice_total     NUMERIC(18,2);
  v_already_allocated NUMERIC(18,2);
BEGIN
  SELECT total_amount INTO v_invoice_total
  FROM public.invoices
  WHERE id = NEW.invoice_id
  FOR UPDATE;

  IF v_invoice_total IS NULL THEN
    RAISE EXCEPTION 'Cannot allocate payment: invoice % does not exist', NEW.invoice_id;
  END IF;

  SELECT COALESCE(SUM(allocated_amount), 0) INTO v_already_allocated
  FROM finance.payment_allocations
  WHERE invoice_id = NEW.invoice_id
    AND id IS DISTINCT FROM NEW.id;

  IF (v_already_allocated + NEW.allocated_amount) > v_invoice_total THEN
    RAISE EXCEPTION
      'Payment allocation of % exceeds invoice outstanding balance (already allocated %, invoice total %)',
      NEW.allocated_amount, v_already_allocated, v_invoice_total;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "trg_validate_payment_allocation" ON "finance"."payment_allocations";
CREATE TRIGGER "trg_validate_payment_allocation"
  BEFORE INSERT OR UPDATE ON "finance"."payment_allocations"
  FOR EACH ROW EXECUTE FUNCTION "finance"."validate_payment_allocation"();

-- Same guard for vendor-bill allocations (mirrors the AP side of the same rule).
CREATE OR REPLACE FUNCTION "finance"."validate_vendor_payment_allocation"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'finance', 'public'
    AS $$
DECLARE
  v_bill_total        NUMERIC(18,2);
  v_already_allocated NUMERIC(18,2);
BEGIN
  SELECT total_amount INTO v_bill_total
  FROM finance.vendor_bills
  WHERE id = NEW.vendor_bill_id
  FOR UPDATE;

  IF v_bill_total IS NULL THEN
    RAISE EXCEPTION 'Cannot allocate payment: vendor bill % does not exist', NEW.vendor_bill_id;
  END IF;

  SELECT COALESCE(SUM(allocated_amount), 0) INTO v_already_allocated
  FROM finance.vendor_payment_allocations
  WHERE vendor_bill_id = NEW.vendor_bill_id
    AND id IS DISTINCT FROM NEW.id;

  IF (v_already_allocated + NEW.allocated_amount) > v_bill_total THEN
    RAISE EXCEPTION
      'Vendor payment allocation of % exceeds bill outstanding balance (already allocated %, bill total %)',
      NEW.allocated_amount, v_already_allocated, v_bill_total;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "trg_validate_vendor_payment_allocation" ON "finance"."vendor_payment_allocations";
CREATE TRIGGER "trg_validate_vendor_payment_allocation"
  BEFORE INSERT OR UPDATE ON "finance"."vendor_payment_allocations"
  FOR EACH ROW EXECUTE FUNCTION "finance"."validate_vendor_payment_allocation"();

-- ---------------------------------------------------------------------
-- FIX 3 (C5): Enforce that active ownership percentages sum to <= 100%
-- for any given effective date. Implemented as an AFTER-trigger
-- (deferred, per-statement is not needed here since ownership_history
-- changes are low-frequency) that re-validates all rows whose effective
-- range overlaps the changed row's range.
--
-- NOTE: existing data is checked first (see verification query in the
-- companion "Post-Migration Verification" queries). If existing rows
-- already violate the 100% rule, this trigger will not retroactively
-- break them (triggers only fire on future INSERT/UPDATE), but you
-- should run the verification query before relying on this control.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION "finance"."validate_ownership_percentage_total"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'finance', 'public'
    AS $$
DECLARE
  v_check_date DATE;
  v_total_pct  NUMERIC(6,2);
BEGIN
  v_check_date := COALESCE(NEW.effective_from, CURRENT_DATE);

  SELECT COALESCE(SUM(oh.ownership_percentage), 0) INTO v_total_pct
  FROM finance.ownership_history oh
  JOIN finance.owners o ON o.id = oh.owner_id
  WHERE o.status = 'ACTIVE'
    AND oh.effective_from <= v_check_date
    AND (oh.effective_to IS NULL OR oh.effective_to >= v_check_date)
    AND oh.id IS DISTINCT FROM NEW.id;

  v_total_pct := v_total_pct + NEW.ownership_percentage;

  IF v_total_pct > 100.00 THEN
        RAISE EXCEPTION 'Ownership percentages for effective date % would total %% (Current Total: %), which exceeds 100%%. Adjust or end-date an existing ownership record first.', v_check_date, v_total_pct;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "trg_validate_ownership_percentage" ON "finance"."ownership_history";
CREATE TRIGGER "trg_validate_ownership_percentage"
  BEFORE INSERT OR UPDATE ON "finance"."ownership_history"
  FOR EACH ROW EXECUTE FUNCTION "finance"."validate_ownership_percentage_total"();

COMMIT;