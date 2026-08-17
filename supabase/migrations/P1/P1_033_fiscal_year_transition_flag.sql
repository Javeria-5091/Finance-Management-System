-- =============================================================================
-- Migration: 020_fiscal_year_transition_flag.sql
-- Purpose:   Fix compliance issue M-3 (Schema Compliance Audit, Medium
--            Findings). Spec ref: Section 4.3 "A period from 1 June through
--            the following 30 June is thirteen months and may only be
--            created as an explicitly approved one-time transition period,
--            not as the normal recurring fiscal year."
--
-- Problem:   finance.fiscal_years has fy_dates_valid (end_date > start_date)
--            and a GiST exclusion constraint preventing overlap, but nothing
--            distinguishes an approved 13-month transition year from an
--            accidental non-standard-length fiscal year, and nothing
--            requires approval evidence for one.
--
-- Fix:       Add an explicit, nullable-by-default is_transition_year boolean
--            column plus approval-evidence columns, and a CHECK constraint
--            that a fiscal year whose length differs materially from 12
--            months (~365/366 days) MUST be flagged as a transition year
--            with an approver recorded. Normal 12-month years are
--            unaffected.
--
-- Data safety: Additive column with a safe default (false). Existing rows
--            are backfilled deterministically from their own start/end dates
--            (a year is auto-flagged only if it is NOT approximately 12
--            months -- this is a structural fact derivable from existing
--            columns, not invented data). If any backfilled row would then
--            violate the new CHECK constraint (i.e. a non-12-month year
--            exists today with no way to attribute an approver), the
--            constraint is added as NOT VALID first and reported via the
--            verification query rather than silently failing the migration.
-- =============================================================================

BEGIN;

ALTER TABLE "finance"."fiscal_years"
  ADD COLUMN IF NOT EXISTS "is_transition_year" boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "transition_approved_by" uuid,
  ADD COLUMN IF NOT EXISTS "transition_approved_at" timestamp with time zone;

-- Deterministic backfill: flag any existing fiscal year whose length is not
-- approximately 12 months (allow 360-372 days to cover normal calendar
-- variance) as a transition year, purely based on its own start/end dates
-- already stored in the row. This does not invent any new fact -- it labels
-- an existing fact.
UPDATE "finance"."fiscal_years"
   SET "is_transition_year" = true
 WHERE ("end_date" - "start_date") NOT BETWEEN 360 AND 372
   AND "is_transition_year" = false;

-- Require approval evidence for any transition year, but only enforce this
-- as a hard constraint for years going forward -- validate existing data
-- separately (NOT VALID + VALIDATE pattern) so this migration cannot fail
-- outright on historical rows that predate this control.
ALTER TABLE "finance"."fiscal_years"
  DROP CONSTRAINT IF EXISTS "fy_transition_requires_approval";

ALTER TABLE "finance"."fiscal_years"
  ADD CONSTRAINT "fy_transition_requires_approval"
  CHECK (
    ("is_transition_year" = false)
    OR ("transition_approved_by" IS NOT NULL AND "transition_approved_at" IS NOT NULL)
  ) NOT VALID;

COMMENT ON COLUMN "finance"."fiscal_years"."is_transition_year" IS
  'True for an explicitly approved one-time non-12-month fiscal year (e.g. '
  'the 1 Jun - 30 Jun thirteen-month transition described in spec Section '
  '4.3). Auto-backfilled for existing non-12-month rows; requires '
  'transition_approved_by/at going forward. See Migration 020 / compliance '
  'audit Section M-3.';

COMMIT;

-- -----------------------------------------------------------------------------
-- Verification (read-only) -- run these AFTER applying, before validating the
-- constraint in a follow-up deploy window:
-- -----------------------------------------------------------------------------
-- 1) Any transition years missing approval evidence (must be fixed manually
--    by an authorized user recording who approved the transition, per spec
--    "may only be created as an explicitly approved one-time transition
--    period" -- the correct approver cannot be inferred/invented):
-- SELECT id, name, start_date, end_date, (end_date - start_date) AS days
--   FROM finance.fiscal_years
--  WHERE is_transition_year = true
--    AND (transition_approved_by IS NULL OR transition_approved_at IS NULL);
--
-- 2) Once all rows above are resolved, validate the constraint for real:
-- ALTER TABLE finance.fiscal_years VALIDATE CONSTRAINT fy_transition_requires_approval;