-- =============================================================================
-- Migration: P2_039_vendor_bill_amount_consistency.sql
-- Fixes:     DEF-06 (vendor bill amount differs between list and detail view)
--
-- FINDING: the app's own create/edit code (LineItemsEditor.tsx,
-- vendor-bills/page.tsx) always computes total_amount and every line's
-- line_total from the SAME formula (qty*price + tax - withholding), so a bill
-- created or edited through the app cannot end up inconsistent. The specific
-- UAT bill (BILL-OM-002) is not present anywhere in this repository's own
-- seed data, and this codebase has a documented precedent of loading records
-- directly into tables (see seed_data.sql: "UPDATE public.expenses SET
-- status='POSTED'..."), which bypasses this app logic entirely. The most
-- likely explanation is that this specific bill's header (total_amount) and
-- its lines were written independently by whatever loaded the UAT dataset,
-- not through this application.
--
-- This migration does not "fix" that historical row (correcting someone
-- else's financial data silently would be its own defect). Instead, per
-- spec 10.5 "Mandatory database constraints", it makes the same mismatch
-- impossible for every vendor bill going forward, and it will immediately
-- tell you (by name) which existing bills are already inconsistent so they
-- can be corrected with evidence rather than guessed at.
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Header self-consistency (mirrors "invoices_amounts_consistency_check",
--    which already exists on public.invoices but was never added to
--    finance.vendor_bills).
-- ---------------------------------------------------------------------------
ALTER TABLE "finance"."vendor_bills"
  ADD CONSTRAINT "vendor_bills_amounts_consistency_check"
  CHECK (
    round(subtotal + tax_amount - withholding_amount - discount_amount, 2) = round(total_amount, 2)
  ) NOT VALID;

-- ---------------------------------------------------------------------------
-- 2. Header-vs-lines consistency. Enforced at the SUBMIT transition (the
--    last point a DRAFT is still freely editable) rather than on every save,
--    so mid-edit intermediate states are not blocked.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION finance.check_vendor_bill_lines_match_total()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_lines_total numeric(18,2);
BEGIN
  SELECT COALESCE(SUM(line_total), 0) INTO v_lines_total
  FROM finance.vendor_bill_lines
  WHERE vendor_bill_id = NEW.id;

  IF round(v_lines_total, 2) <> round(NEW.total_amount, 2) THEN
    RAISE EXCEPTION
      'Vendor bill % cannot be submitted: line items total % but the bill total is %. Fix the line items or the bill total before submitting.',
      COALESCE(NEW.bill_number, NEW.id::text), v_lines_total, NEW.total_amount;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_vendor_bill_lines_match_total ON "finance"."vendor_bills";
CREATE TRIGGER trg_vendor_bill_lines_match_total
  BEFORE UPDATE ON "finance"."vendor_bills"
  FOR EACH ROW
  WHEN (OLD.status = 'DRAFT' AND NEW.status = 'SUBMITTED')
  EXECUTE FUNCTION finance.check_vendor_bill_lines_match_total();

COMMENT ON FUNCTION finance.check_vendor_bill_lines_match_total() IS
  'DEF-06 prevention: blocks submitting a vendor bill whose line items do not add up to its total_amount, so list view and detail view can never disagree again.';

COMMIT;

-- ---------------------------------------------------------------------------
-- Run this SEPARATELY (after COMMIT above) to see which already-loaded bills
-- are inconsistent, WITHOUT changing any data. The header check above was
-- added NOT VALID so it does not fail on existing rows; run this to find
-- them, then correct each one by hand with the accountant.
-- ---------------------------------------------------------------------------
-- SELECT id, bill_number, subtotal, tax_amount, withholding_amount, discount_amount, total_amount
-- FROM finance.vendor_bills
-- WHERE round(subtotal + tax_amount - withholding_amount - discount_amount, 2) <> round(total_amount, 2);
--
-- SELECT vb.id, vb.bill_number, vb.total_amount, SUM(vbl.line_total) AS lines_total
-- FROM finance.vendor_bills vb
-- JOIN finance.vendor_bill_lines vbl ON vbl.vendor_bill_id = vb.id
-- GROUP BY vb.id, vb.bill_number, vb.total_amount
-- HAVING round(SUM(vbl.line_total), 2) <> round(vb.total_amount, 2);