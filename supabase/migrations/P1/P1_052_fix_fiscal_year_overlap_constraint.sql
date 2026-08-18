-- =====================================================================
-- Migration 033: Fix fiscal-year overlap constraint (organization scope)
-- =====================================================================
-- ROOT CAUSE:
--   finance.fiscal_years has:
--     CONSTRAINT fy_no_overlapping_ranges
--       EXCLUDE USING gist (daterange(start_date, end_date, '[]') WITH &&)
--   with NO organization_id term in the exclusion key, unlike the
--   correct sibling constraint on accounting_periods
--   (ap_no_overlapping_ranges_per_fy, which includes
--   "fiscal_year_id WITH ="). Because OSYSTIC's own fiscal year is a
--   full 12-month span (1 Jul - 30 Jun), this constraint makes it
--   structurally impossible for a second organization to ever have any
--   fiscal year at all, directly contradicting spec §5.1 ("organizationconfigurable fiscal-year calendar") and the shared-Supabase-platform
--   premise (spec §3, Appendix D).
--
-- FIX:
--   Drop and recreate the exclusion constraint with organization_id as
--   an equality term, so overlap is only rejected within the same
--   organization. This requires the btree_gist extension for the
--   uuid "=" operator class inside a GiST exclusion constraint.
--
-- DEPENDS ON: Migration 032 (organization_id must be backfilled/NOT NULL
--   on finance.fiscal_years before this constraint is meaningful; the
--   constraint below still works if some rows remain NULL organization_id,
--   because NULL is never equal to NULL in the "=" gist term and such
--   rows will simply not be checked against each other for overlap -- 
--   which is why Migration 032 must be run and reconciled first).
-- =====================================================================

BEGIN;

CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE finance.fiscal_years
  DROP CONSTRAINT IF EXISTS fy_no_overlapping_ranges;

ALTER TABLE finance.fiscal_years
  ADD CONSTRAINT fy_no_overlapping_ranges
  EXCLUDE USING gist (
    organization_id WITH =,
    daterange(start_date, end_date, '[]'::text) WITH &&
  );

COMMIT;

-- Validation:
--   -- Should succeed: two different organizations, same calendar dates
--   -- (run in a transaction and roll back; illustrative only)
--   -- INSERT INTO finance.fiscal_years (name, start_date, end_date, organization_id)
--   --   VALUES ('FY26 Org A', '2026-07-01', '2027-06-30', '<org-a-uuid>');
--   -- INSERT INTO finance.fiscal_years (name, start_date, end_date, organization_id)
--   --   VALUES ('FY26 Org B', '2026-07-01', '2027-06-30', '<org-b-uuid>');
--   -- Should still fail: same organization, overlapping dates.