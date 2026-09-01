-- =====================================================================
-- Finance Management System — Critical Fixes
--   FND-AR-03 (P0): credit note creation always 23502s -- base_amount is
--                    NOT NULL with no default and is never supplied
--   FND-AR-04 (P0): payment reversal route fails on its first query --
--                    public.payment_receipts doesn't expose organization_id,
--                    and journal_entry_id has no FK for PostgREST to embed
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- FND-AR-03: finance.credit_notes.base_amount is NOT NULL with no
-- default, public.credit_notes is a plain (non-INSTEAD-OF) view over it,
-- and src/app/api/finance/credit-notes/route.ts never supplies base_amount
-- in its INSERT -- so every credit note create fails with 23502.
--
-- Fix: a BEFORE INSERT/UPDATE trigger derives base_amount from
-- amount * exchange_rate whenever it isn't explicitly supplied, exactly
-- mirroring how finance.payment_receipts / public.invoices already derive
-- their base_* columns. This is a safety net at the table level, so it
-- protects every caller (the API route, admin tooling, future code) --
-- not just the one INSERT statement the app happens to fix today.
-- ---------------------------------------------------------------------

CREATE OR REPLACE FUNCTION "finance"."derive_credit_note_base_amount"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  IF NEW."base_amount" IS NULL THEN
    NEW."base_amount" := NEW."amount" * COALESCE(NEW."exchange_rate", 1);
  END IF;
  RETURN NEW;
END;
$$;

ALTER FUNCTION "finance"."derive_credit_note_base_amount"() OWNER TO "postgres";

COMMENT ON FUNCTION "finance"."derive_credit_note_base_amount"() IS
  'FND-AR-03 fix: derives base_amount = amount * exchange_rate whenever an INSERT/UPDATE (including through the public.credit_notes view) omits it. base_amount is NOT NULL with no column default, and src/app/api/finance/credit-notes/route.ts never supplied it, so every create previously failed with 23502.';

DROP TRIGGER IF EXISTS "trg_derive_credit_note_base_amount" ON "finance"."credit_notes";

CREATE TRIGGER "trg_derive_credit_note_base_amount"
    BEFORE INSERT OR UPDATE ON "finance"."credit_notes"
    FOR EACH ROW
    EXECUTE FUNCTION "finance"."derive_credit_note_base_amount"();


-- ---------------------------------------------------------------------
-- FND-AR-04, part 1: public.payment_receipts never exposed organization_id
-- (same class of bug as the credit_notes view fix noted in the "BUG-021"
-- comment already in this schema), so
-- .eq('organization_id', auth.orgId) against the view 42703s.
-- ---------------------------------------------------------------------

CREATE OR REPLACE VIEW "public"."payment_receipts" WITH ("security_invoker"='true') AS
 SELECT "id",
    "receipt_number",
    "payment_date",
    "amount",
    "currency",
    "exchange_rate",
    "base_amount",
    "client_id",
    "project_id",
    "financial_account_id",
    "payment_method",
    "reference",
    "description",
    "status",
    "journal_entry_id",
    "period_id",
    "created_by",
    "approved_by",
    "approved_at",
    "posted_by",
    "posted_at",
    "created_at",
    "updated_at",
    "organization_id"
   FROM "finance"."payment_receipts";

ALTER VIEW "public"."payment_receipts" OWNER TO "postgres";

COMMENT ON VIEW "public"."payment_receipts" IS
  'FND-AR-04 fix: added organization_id, which was previously missing from this view. src/app/api/finance/payment-reversals/route.ts (and any other caller filtering by organization_id) failed with PGRST/42703 "column payment_receipts.organization_id does not exist" on every call.';


-- ---------------------------------------------------------------------
-- FND-AR-04, part 2: finance.payment_receipts.journal_entry_id had no
-- foreign key, so PostgREST could not resolve the
-- journal_entry:finance.journal_entries(...) embed the reversal route
-- attempted, producing PGRST200 ("could not find a relationship").
--
-- Added NOT VALID (matching the existing client_id FK on this same table)
-- so this migration cannot be blocked by any pre-existing orphaned value;
-- run the VALIDATE CONSTRAINT statement at the bottom once you've
-- confirmed there are none, to get full enforcement.
-- ---------------------------------------------------------------------

ALTER TABLE ONLY "finance"."payment_receipts"
  DROP CONSTRAINT IF EXISTS "payment_receipts_journal_entry_id_fkey";

ALTER TABLE ONLY "finance"."payment_receipts"
  ADD CONSTRAINT "payment_receipts_journal_entry_id_fkey"
  FOREIGN KEY ("journal_entry_id") REFERENCES "finance"."journal_entries"("id") ON DELETE SET NULL NOT VALID;

COMMIT;

-- ---------------------------------------------------------------------
-- Run once you've confirmed no orphaned journal_entry_id values exist:
--   select id, journal_entry_id from finance.payment_receipts pr
--   where journal_entry_id is not null
--     and not exists (select 1 from finance.journal_entries je where je.id = pr.journal_entry_id);
--   -- if that returns zero rows:
--   alter table finance.payment_receipts validate constraint payment_receipts_journal_entry_id_fkey;
-- ---------------------------------------------------------------------

-- ---------------------------------------------------------------------
-- Verification:
--   1) POST /api/finance/credit-notes with a valid invoice_id/total_amount
--      -- previously 23502, should now succeed and base_amount should
--      equal total_amount * exchange_rate.
--   2) select organization_id from public.payment_receipts limit 1;
--      -- previously 42703, should now return a value.
--   3) POST /api/finance/payment-reversals for a POSTED receipt
--      -- previously failed on the very first query; should now reach
--      finance.reverse_payment_receipt_atomic().
-- ---------------------------------------------------------------------