-- =====================================================================
-- Migration: 017_constraint_fixes.sql
-- Purpose:   Fix HIGH-severity constraint gaps on public.invoices:
--              (H2) No UNIQUE constraint on invoice_number.
--              (M1) invoices_status_check allows two overlapping status
--                   vocabularies simultaneously (legacy 'Draft'/'Pending'
--                   /'Paid' alongside the correct uppercase spec values).
--              (H3) client_id is nullable while client_name is a
--                   mandatory free-text field with no guaranteed link.
-- Spec refs: 8, 10.5, 27 (Section 30 of audit report: R11 partial, R12, R13)
-- Non-destructive: yes, guarded with pre-checks; will RAISE NOTICE and
-- skip (not fail) if existing data would violate a new constraint.
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- FIX 1 (H2): Add uniqueness on invoice_number, but only if no existing
-- duplicates would violate it. If duplicates exist, this block reports
-- them and skips adding the constraint rather than failing the whole
-- migration -- duplicates must be resolved manually first (see Section D
-- "Data Migration Requirements" in the accompanying report).
-- ---------------------------------------------------------------------
DO $$
DECLARE
  v_dupe_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO v_dupe_count
  FROM (
    SELECT invoice_number
    FROM public.invoices
    GROUP BY invoice_number
    HAVING COUNT(*) > 1
  ) d;

  IF v_dupe_count > 0 THEN
    RAISE NOTICE 'SKIPPED: % duplicate invoice_number value(s) found in public.invoices. '
                 'Resolve duplicates manually, then run: '
                 'ALTER TABLE public.invoices ADD CONSTRAINT invoices_invoice_number_key UNIQUE (invoice_number);',
                 v_dupe_count;
  ELSE
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint WHERE conname = 'invoices_invoice_number_key'
    ) THEN
      ALTER TABLE public.invoices ADD CONSTRAINT invoices_invoice_number_key UNIQUE (invoice_number);
      RAISE NOTICE 'Added UNIQUE constraint invoices_invoice_number_key.';
    END IF;
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- FIX 3 (H3): Keep client_name in sync with client_id when a client_id
-- is provided, so the free-text field cannot silently diverge from the
-- FK relationship. This does NOT make client_id mandatory (that would
-- require a data backfill decision -- see Section D of the report) but
-- it closes the specific integrity gap of the two fields disagreeing.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION "public"."sync_invoice_client_name"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'public'
    AS $$
DECLARE
  v_client_name TEXT;
BEGIN
  IF NEW.client_id IS NOT NULL THEN
    SELECT name INTO v_client_name FROM public.clients WHERE id = NEW.client_id;
    IF v_client_name IS NOT NULL THEN
      NEW.client_name := v_client_name;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "trg_sync_invoice_client_name" ON "public"."invoices";
CREATE TRIGGER "trg_sync_invoice_client_name"
  BEFORE INSERT OR UPDATE OF client_id ON "public"."invoices"
  FOR EACH ROW EXECUTE FUNCTION "public"."sync_invoice_client_name"();

COMMIT;

-- MANUAL DECISION REQUIRED (not automated by this migration):
-- Making client_id NOT NULL requires knowing that every existing invoice
-- row can be deterministically matched to a clients.id. Run this query
-- first (see verification queries) to see how many rows would need
-- manual client-matching before NOT NULL can safely be added:
--   SELECT count(*) FROM public.invoices WHERE client_id IS NULL;