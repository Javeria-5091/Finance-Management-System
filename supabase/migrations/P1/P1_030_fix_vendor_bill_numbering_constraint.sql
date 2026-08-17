-- =============================================================================
-- Migration 020: Fix conflicting vendor bill numbering constraints
-- =============================================================================
-- PURPOSE
--   The compliance audit found finance.vendor_bills carrying two
--   simultaneous, conflicting uniqueness rules on bill_number:
--     * vendor_bills_bill_number_key  -- a GLOBAL UNIQUE(bill_number)
--       constraint across ALL vendors
--     * uq_vendor_bill_number         -- a partial UNIQUE INDEX on
--       (vendor_id, bill_number), correctly scoped PER VENDOR, excluding
--       DRAFT/CANCELLED/REJECTED rows
--
--   Spec 5.7 requires: "Prevent duplicate vendor bill numbers per vendor
--   unless authorized with reason" -- i.e. uniqueness must be scoped per
--   vendor, since each vendor controls its own invoice numbering. The
--   global constraint is strictly more restrictive than the spec requires
--   and makes it impossible for two different vendors to ever submit a
--   bill numbered e.g. "INV-1001", which happens constantly in the real
--   world and is not a business rule OSYSTIC asked for.
--
-- ISSUES FIXED
--   - Spec 5.7: vendor bill number uniqueness scoped per vendor, not
--     globally
--
-- SAFETY
--   Before dropping the global constraint, this migration checks whether
--   any EXISTING data would violate the per-vendor partial unique index if
--   it isn't already enforcing correctly (it already exists, so existing
--   data necessarily already satisfies it -- this migration only removes
--   the extra, overly-strict global rule; it does not loosen anything the
--   per-vendor index already guarantees). No data is changed.
-- =============================================================================

BEGIN;

-- Sanity check: confirm the per-vendor partial unique index this migration
-- relies on actually exists before dropping the global constraint. If it is
-- missing for any reason, abort rather than leave bill_number completely
-- unconstrained.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'finance'
      AND tablename = 'vendor_bills'
      AND indexname = 'uq_vendor_bill_number'
  ) THEN
    RAISE EXCEPTION
      'Migration 020 aborted: expected partial unique index "uq_vendor_bill_number" on finance.vendor_bills was not found. Refusing to drop the global uniqueness constraint without a replacement in place.';
  END IF;
END $$;

ALTER TABLE "finance"."vendor_bills"
  DROP CONSTRAINT IF EXISTS "vendor_bills_bill_number_key";

COMMIT;

-- After this migration: finance.vendor_bills.bill_number uniqueness is
-- enforced ONLY by the pre-existing partial index uq_vendor_bill_number,
-- i.e. unique per (vendor_id, bill_number) among bills that are not
-- DRAFT/CANCELLED/REJECTED -- matching spec 5.7 exactly.