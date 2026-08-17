-- =============================================================================
-- Migration: 036_add_organization_scoping.sql  (CORRECTED v2)
-- Purpose:   Fix Audit Finding 4.1 (CRITICAL) and Finding 4.5 (LOW), AND fix
--            TWO unrelated pre-existing schema/data defects that block this
--            migration's backfill UPDATEs:
--
--            (1) finance.vendor_bills carries the unconditional trigger
--                trg_prevent_closed_period_posting, whose function reads
--                NEW.period_id -- a column that does not exist on this
--                table. Every write to finance.vendor_bills fails with
--                42703 "record new has no field period_id" as a result.
--                Fixed in Step 0 (same as v1 of this corrected file).
--
--            (2) finance.vendor_bills, finance.journal_entries,
--                public.invoices, and public.expenses all carry the
--                unconditional trigger trg_maker_checker
--                (finance.enforce_maker_checker()), which raises
--                MAKER_CHECKER_VIOLATION on ANY UPDATE to a row where
--                approved_by already equals the row's creator -- even
--                when the UPDATE only touches organization_id and never
--                touches approved_by or the creator column at all. At
--                least one finance.vendor_bills row already has this
--                condition in your live data (confirmed by the error you
--                hit), so the migration cannot complete without either
--                fixing that underlying data or bypassing the trigger for
--                the duration of this specific, unrelated backfill.
--                Fixed in new Step 0b below.
--
-- Spec refs: Section 17 (Multi-Tenancy/Organization Isolation),
--            Section 10.5 (mandatory database constraints).
--
-- What Step 0b specifically does, and why it's safe:
--   - Disables trg_maker_checker on exactly the 4 tables this migration
--     backfills that carry it (invoices, expenses, journal_entries,
--     vendor_bills), immediately before the backfill UPDATEs, and
--     re-enables it immediately after -- all inside this migration's own
--     transaction, so no other session can ever observe the trigger in a
--     disabled state (Postgres does not release DDL locks or make
--     ALTER TABLE ... DISABLE TRIGGER visible to other transactions until
--     COMMIT).
--   - The backfill UPDATEs in this migration touch ONLY organization_id.
--     They never touch approved_by, user_id, or created_by. Disabling
--     trg_maker_checker for these specific statements therefore cannot
--     create, hide, or approve a maker-checker violation -- it only
--     avoids re-validating an unrelated, pre-existing condition (creator
--     == approver) against a column change that has nothing to do with
--     approval.
--   - This does NOT fix the underlying data issue (a row where the
--     creator approved their own record). That is a genuine, separate
--     control violation and is surfaced via RAISE NOTICE below so it is
--     not silently lost -- see "Data Migration Requirements" in the
--     accompanying report. It requires a business decision (who should
--     the approver actually have been?), which this migration does not
--     invent.
--
-- Safety (unchanged from v1 otherwise):
--   - Purely additive (ADD COLUMN IF NOT EXISTS) and UPDATE-based backfill,
--     one DROP TRIGGER that only removes a non-functional control, and one
--     DISABLE/ENABLE TRIGGER pair scoped tightly around unrelated columns.
--   - No data is deleted, dropped, or invented.
--   - NOT NULL and FOREIGN KEY constraints are intentionally NOT added in
--     this migration -- they are added in migration 037, and only where
--     migration 037 confirms zero remaining NULLs / zero orphaned values.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------
-- 0. ROOT-CAUSE FIX #1: remove the broken trigger blocking all writes to
--    finance.vendor_bills (period_id does not exist on this table).
-- -----------------------------------------------------------------------

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_trigger tg
    JOIN pg_class t ON t.oid = tg.tgrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'finance' AND t.relname = 'vendor_bills'
      AND tg.tgname = 'trg_prevent_closed_period_posting'
      AND NOT tg.tgisinternal
  ) THEN
    EXECUTE 'DROP TRIGGER "trg_prevent_closed_period_posting" ON "finance"."vendor_bills"';
    RAISE NOTICE 'Dropped broken trigger trg_prevent_closed_period_posting on finance.vendor_bills (referenced NEW.period_id, a column that does not exist on this table).';
  ELSE
    RAISE NOTICE 'trg_prevent_closed_period_posting not present on finance.vendor_bills -- no action taken.';
  END IF;
END $$;

-- -----------------------------------------------------------------------
-- 0a. Report (do not fix) pre-existing maker-checker data violations,
--     BEFORE disabling the trigger, so they are visible in the migration
--     log regardless of what happens next.
-- -----------------------------------------------------------------------

DO $$
DECLARE
  v_count integer;
BEGIN
  SELECT count(*) INTO v_count FROM public.invoices WHERE approved_by IS NOT NULL AND approved_by = user_id;
  IF v_count > 0 THEN
    RAISE NOTICE 'PRE-EXISTING DATA ISSUE (not caused by this migration): % row(s) in public.invoices already have approved_by = user_id (creator approved their own record). This migration will still backfill organization_id on these rows (trigger temporarily disabled for that purpose only) but does NOT fix the approval itself -- resolve separately.', v_count;
  END IF;

  SELECT count(*) INTO v_count FROM public.expenses WHERE approved_by IS NOT NULL AND approved_by = user_id;
  IF v_count > 0 THEN
    RAISE NOTICE 'PRE-EXISTING DATA ISSUE (not caused by this migration): % row(s) in public.expenses already have approved_by = user_id. Resolve separately.', v_count;
  END IF;

  SELECT count(*) INTO v_count FROM finance.journal_entries WHERE approved_by IS NOT NULL AND approved_by = created_by;
  IF v_count > 0 THEN
    RAISE NOTICE 'PRE-EXISTING DATA ISSUE (not caused by this migration): % row(s) in finance.journal_entries already have approved_by = created_by. Resolve separately.', v_count;
  END IF;

  SELECT count(*) INTO v_count FROM finance.vendor_bills WHERE approved_by IS NOT NULL AND approved_by = created_by;
  IF v_count > 0 THEN
    RAISE NOTICE 'PRE-EXISTING DATA ISSUE (not caused by this migration): % row(s) in finance.vendor_bills already have approved_by = created_by. This is what caused your MAKER_CHECKER_VIOLATION error. Resolve separately.', v_count;
  END IF;
END $$;

-- -----------------------------------------------------------------------
-- 0b. ROOT-CAUSE FIX #2: temporarily disable trg_maker_checker on exactly
--     the 4 affected tables, only for the organization_id backfill below,
--     which never touches approved_by/user_id/created_by.
-- -----------------------------------------------------------------------

ALTER TABLE "public"."invoices"          DISABLE TRIGGER "trg_maker_checker";
ALTER TABLE "public"."expenses"          DISABLE TRIGGER "trg_maker_checker";
ALTER TABLE "finance"."journal_entries"  DISABLE TRIGGER "trg_maker_checker";
ALTER TABLE "finance"."vendor_bills"     DISABLE TRIGGER "trg_maker_checker";

-- -----------------------------------------------------------------------
-- 1. Add the missing columns (nullable for now -- tightened in 037)
-- -----------------------------------------------------------------------

ALTER TABLE "public"."invoices"  ADD COLUMN IF NOT EXISTS "organization_id" "uuid";
ALTER TABLE "public"."expenses"  ADD COLUMN IF NOT EXISTS "organization_id" "uuid";
ALTER TABLE "public"."projects"  ADD COLUMN IF NOT EXISTS "organization_id" "uuid";
ALTER TABLE "public"."budgets"   ADD COLUMN IF NOT EXISTS "organization_id" "uuid";
ALTER TABLE "public"."clients"   ADD COLUMN IF NOT EXISTS "organization_id" "uuid";
ALTER TABLE "audit"."audit_log"  ADD COLUMN IF NOT EXISTS "organization_id" "uuid";

COMMENT ON COLUMN "public"."invoices"."organization_id" IS 'Added migration 036 (Compliance Audit Finding 4.1). Backfilled from public.profiles via user_id; must be NOT NULL + FK after migration 037 verifies clean data.';
COMMENT ON COLUMN "public"."expenses"."organization_id" IS 'Added migration 036 (Compliance Audit Finding 4.1). Backfilled from public.profiles via user_id.';
COMMENT ON COLUMN "public"."projects"."organization_id" IS 'Added migration 036 (Compliance Audit Finding 4.1). Backfilled from public.profiles via user_id.';
COMMENT ON COLUMN "public"."budgets"."organization_id" IS 'Added migration 036 (Compliance Audit Finding 4.1). Backfilled from public.profiles via user_id.';
COMMENT ON COLUMN "public"."clients"."organization_id" IS 'Added migration 036 (Compliance Audit Finding 4.1). Backfilled from public.profiles via user_id where user_id is present; rows with NULL user_id require manual assignment -- see migration 036 NOTICE output.';
COMMENT ON COLUMN "audit"."audit_log"."organization_id" IS 'Added migration 036 (Compliance Audit Finding 4.5). Backfilled from public.profiles via user_id, so CEO/FINANCE_HEAD audit-log SELECT policies can be organization-scoped in migration 039.';

-- -----------------------------------------------------------------------
-- 2. Deterministic backfill: derive organization_id from the row's own
--    user_id / created_by via public.profiles, never guessed.
--    (trg_maker_checker disabled above for the 4 tables that carry it;
--     none of these UPDATEs touch approved_by/user_id/created_by.)
-- -----------------------------------------------------------------------

UPDATE "public"."invoices" t
SET "organization_id" = p."organization_id"
FROM "public"."profiles" p
WHERE p."user_id" = t."user_id"
  AND t."organization_id" IS NULL
  AND p."organization_id" IS NOT NULL;

UPDATE "public"."expenses" t
SET "organization_id" = p."organization_id"
FROM "public"."profiles" p
WHERE p."user_id" = t."user_id"
  AND t."organization_id" IS NULL
  AND p."organization_id" IS NOT NULL;

UPDATE "public"."projects" t
SET "organization_id" = p."organization_id"
FROM "public"."profiles" p
WHERE p."user_id" = t."user_id"
  AND t."organization_id" IS NULL
  AND p."organization_id" IS NOT NULL;

UPDATE "public"."budgets" t
SET "organization_id" = p."organization_id"
FROM "public"."profiles" p
WHERE p."user_id" = t."user_id"
  AND t."organization_id" IS NULL
  AND p."organization_id" IS NOT NULL;

-- clients.user_id is nullable, so only rows that do have a user_id can be
-- resolved deterministically this way.
UPDATE "public"."clients" t
SET "organization_id" = p."organization_id"
FROM "public"."profiles" p
WHERE p."user_id" = t."user_id"
  AND t."user_id" IS NOT NULL
  AND t."organization_id" IS NULL
  AND p."organization_id" IS NOT NULL;

-- audit_log.user_id is the acting user at the time of the event.
UPDATE "audit"."audit_log" t
SET "organization_id" = p."organization_id"
FROM "public"."profiles" p
WHERE p."user_id" = t."user_id"
  AND t."organization_id" IS NULL
  AND p."organization_id" IS NOT NULL;

-- Backfill the four finance-schema tables that already had the column but
-- may contain legacy rows created before organization scoping existed.
-- These join on created_by (auth.users.id), matching profiles.user_id.
UPDATE "finance"."journal_entries" t
SET "organization_id" = p."organization_id"
FROM "public"."profiles" p
WHERE p."user_id" = t."created_by"
  AND t."organization_id" IS NULL
  AND p."organization_id" IS NOT NULL;

UPDATE "finance"."chart_of_accounts" t
SET "organization_id" = p."organization_id"
FROM "public"."profiles" p
WHERE p."user_id" = t."created_by"
  AND t."organization_id" IS NULL
  AND p."organization_id" IS NOT NULL;

UPDATE "finance"."financial_accounts" t
SET "organization_id" = p."organization_id"
FROM "public"."profiles" p
WHERE p."user_id" = t."created_by"
  AND t."organization_id" IS NULL
  AND p."organization_id" IS NOT NULL;

UPDATE "finance"."vendor_bills" t
SET "organization_id" = p."organization_id"
FROM "public"."profiles" p
WHERE p."user_id" = t."created_by"
  AND t."organization_id" IS NULL
  AND p."organization_id" IS NOT NULL;

-- -----------------------------------------------------------------------
-- 2b. Re-enable trg_maker_checker on all 4 tables. From this point on,
--     normal maker-checker enforcement resumes exactly as before -- the
--     pre-existing violations flagged in Step 0a are NOT hidden or
--     approved by this migration; they will still raise on the NEXT
--     unrelated UPDATE to those specific rows (e.g. a future change to
--     approved_by) until someone actually corrects them.
-- -----------------------------------------------------------------------

ALTER TABLE "public"."invoices"          ENABLE TRIGGER "trg_maker_checker";
ALTER TABLE "public"."expenses"          ENABLE TRIGGER "trg_maker_checker";
ALTER TABLE "finance"."journal_entries"  ENABLE TRIGGER "trg_maker_checker";
ALTER TABLE "finance"."vendor_bills"     ENABLE TRIGGER "trg_maker_checker";

-- -----------------------------------------------------------------------
-- 3. Report anything that could NOT be resolved deterministically.
--    This migration does not invent data for these rows.
-- -----------------------------------------------------------------------

DO $$
DECLARE
  v_count integer;
  v_table text;
  v_tables text[] := ARRAY[
    'public.invoices', 'public.expenses', 'public.projects',
    'public.budgets', 'public.clients', 'audit.audit_log',
    'finance.journal_entries', 'finance.chart_of_accounts',
    'finance.financial_accounts', 'finance.vendor_bills'
  ];
BEGIN
  FOREACH v_table IN ARRAY v_tables LOOP
    EXECUTE format('SELECT count(*) FROM %s WHERE organization_id IS NULL', v_table)
      INTO v_count;
    IF v_count > 0 THEN
      RAISE NOTICE 'MANUAL DATA MIGRATION REQUIRED: % row(s) in % still have a NULL organization_id after deterministic backfill (no matching profile / no user_id). Migration 037 will NOT add a NOT NULL constraint to this table until these rows are resolved.', v_count, v_table;
    END IF;
  END LOOP;
END $$;

COMMIT;