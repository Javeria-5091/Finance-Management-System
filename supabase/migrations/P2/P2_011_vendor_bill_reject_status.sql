-- =====================================================================
-- FND-AP-04 (P1): finance.vendor_bills_status_check does not allow
-- 'REJECTED', but the application already treats REJECTED as a real
-- status:
--   - src/app/api/finance/workflow/route.ts sets status='REJECTED' on
--     the vendor_bill 'reject' transition (Reject button on
--     src/app/dashboard/vendor-bills/page.tsx).
--   - The partial unique index "uq_vendor_bill_number" already EXCLUDES
--     'REJECTED' from the bill-number uniqueness check (alongside DRAFT
--     and CANCELLED), i.e. the schema was designed assuming a rejected
--     bill can be re-numbered/resubmitted — the CHECK constraint was
--     just never updated to match.
--
-- Effect of the bug: every UPDATE ... SET status = 'REJECTED' on
-- finance.vendor_bills raises a CHECK-violation, which the generic
-- workflow route surfaces as a 500. The Reject button on the Vendor
-- Bills page has therefore never worked.
--
-- Fix: widen the CHECK constraint to add 'REJECTED', consistent with
-- every other module's status vocabulary (expenses, invoices, incomes
-- all include REJECTED) and with the uq_vendor_bill_number index that
-- already assumed it. Purely additive — no existing row's status
-- changes, and no other constraint or code path is touched.
--
-- Idempotent: safe to run more than once.
-- =====================================================================

BEGIN;

ALTER TABLE "finance"."vendor_bills" DROP CONSTRAINT IF EXISTS "vendor_bills_status_check";
ALTER TABLE "finance"."vendor_bills"
  ADD CONSTRAINT "vendor_bills_status_check"
  CHECK (("status" = ANY (ARRAY[
    'DRAFT'::"text", 'SUBMITTED'::"text", 'VERIFIED'::"text", 'APPROVED'::"text",
    'REJECTED'::"text",
    'POSTED'::"text", 'PARTIALLY_PAID'::"text", 'PAID'::"text",
    'REVERSED'::"text", 'CANCELLED'::"text"
  ])));

COMMENT ON CONSTRAINT "vendor_bills_status_check" ON "finance"."vendor_bills" IS
  'FND-AP-04: widened to include REJECTED, which the application workflow route and the uq_vendor_bill_number partial index already assumed existed.';

COMMIT;