-- =============================================================================
-- Migration: 025_bank_transfer_numbering_concurrency_fix.sql
-- Purpose:   Fix HIGH finding H3 from the second-opinion audit, VERIFIED
--            against this schema: finance.fn_gen_bt_number() was confirmed
--            to use `SELECT COALESCE(MAX(...),0)+1` against
--            finance.bank_transfers.transfer_number rather than the
--            schema's own concurrency-safe finance.get_next_number()/
--            finance.numbering_sequences mechanism (confirmed present and
--            used correctly for invoices/bills/journals via
--            "SELECT ... FOR UPDATE" row locking). Spec ref: Section 21
--            "concurrency safety."
--
-- Problem:   Two bank transfers created at nearly the same moment can both
--            compute the same MAX()+1 value before either commits. The
--            existing UNIQUE constraint on transfer_number (uq_transfer_number)
--            prevents silent duplication, but one of the two transactions
--            will fail with a unique-violation error instead of being
--            handed a safe, distinct number the way every other document
--            type in this schema already is.
--
-- Fix:       Replace the function body to call finance.get_next_number(
--            'BANK_TRANSFER') -- the same mechanism already used for
--            invoices/bills/journals, which locks the sequence row with
--            FOR UPDATE before incrementing. Seed a 'BANK_TRANSFER'
--            numbering_sequences row (prefix 'BT-', 5-digit padding to
--            match the existing format 'BT-00001') if one does not already
--            exist, seeded from the current MAX() so numbering continues
--            from where it left off rather than restarting at 1 (which
--            would immediately collide with the unique constraint on
--            existing data).
--
-- Data safety: Non-destructive. No existing bank_transfers row is renumbered
--            or touched. The seed value for the new numbering_sequences row
--            is derived deterministically from existing data (current
--            MAX(transfer_number) suffix), not invented, so the first
--            transfer created after this migration gets the next number in
--            the existing sequence.
-- =============================================================================

BEGIN;

-- Seed the numbering_sequences row only if one doesn't already exist for
-- BANK_TRANSFER, continuing from the current maximum existing number so no
-- gap or collision is introduced.
INSERT INTO "finance"."numbering_sequences"
  ("sequence_type", "prefix", "current_number", "padding", "format", "fiscal_year_id", "reset_per_period")
SELECT
  'BANK_TRANSFER',
  'BT-',
  COALESCE((
    SELECT MAX(CAST(SUBSTRING("transfer_number" FROM 4) AS INT))
    FROM "finance"."bank_transfers"
    WHERE "transfer_number" LIKE 'BT-%'
  ), 0),
  5,
  '{PREFIX}{NUMBER}',
  NULL,
  false
WHERE NOT EXISTS (
  SELECT 1 FROM "finance"."numbering_sequences" WHERE "sequence_type" = 'BANK_TRANSFER'
);

CREATE OR REPLACE FUNCTION "finance"."fn_gen_bt_number"()
RETURNS "trigger"
LANGUAGE "plpgsql" SECURITY DEFINER
SET "search_path" TO 'pg_catalog', 'finance', 'public'
AS $$
BEGIN
  IF NEW.transfer_number IS NULL OR NEW.transfer_number = '' THEN
    NEW.transfer_number := finance.get_next_number('BANK_TRANSFER');
  END IF;
  RETURN NEW;
END;
$$;

ALTER FUNCTION "finance"."fn_gen_bt_number"() OWNER TO "postgres";

COMMENT ON FUNCTION "finance"."fn_gen_bt_number"() IS
  'Generates bank transfer numbers via finance.get_next_number(), the same '
  'concurrency-safe (SELECT...FOR UPDATE) mechanism used for invoices/bills/'
  'journals. Previously used a race-prone MAX()+1 pattern. See Migration '
  '025 / compliance audit Section H3.';

COMMIT;

-- -----------------------------------------------------------------------------
-- Verification (read-only)
-- -----------------------------------------------------------------------------
-- Confirm the seeded sequence starts at or above the current max:
-- SELECT ns.current_number,
--        (SELECT MAX(CAST(SUBSTRING(bt.transfer_number FROM 4) AS INT))
--           FROM finance.bank_transfers bt WHERE bt.transfer_number LIKE 'BT-%') AS existing_max
--   FROM finance.numbering_sequences ns
--  WHERE ns.sequence_type = 'BANK_TRANSFER';
--
-- Confirm no duplicate transfer numbers exist today (should already be
-- guaranteed by the UNIQUE constraint, but confirms nothing to reconcile):
-- SELECT transfer_number, COUNT(*) FROM finance.bank_transfers
--  GROUP BY transfer_number HAVING COUNT(*) > 1;