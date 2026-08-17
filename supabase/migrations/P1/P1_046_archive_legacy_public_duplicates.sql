-- 046_archive_legacy_public_duplicates.sql  (corrected ordering + idempotency)
--
-- Archives the four legacy duplicate tables out of the public schema.
-- Depends on 031_repoint_budget_gl_actual_to_finance.sql having
-- committed successfully first (no changes needed to 031 — see note below).
--
-- Does NOT recreate, modify, or depend on running
-- 022_legacy_duplicate_table_write_freeze.sql again. core.block_legacy_
-- table_write(), its triggers, and the *_frozen RLS policies from that
-- migration are left completely alone; they travel automatically with
-- their tables when ALTER TABLE ... SET SCHEMA runs below.
--
-- Ordering fix vs. the previous attempt: the known, expected dependency
-- (reporting.v_duplicate_table_drift, which itself selects FROM all four
-- public.* legacy tables) is now dropped BEFORE the dependency guard
-- runs, not after. The guard therefore only reports genuinely unexpected
-- dependencies. Verified: DDL effects are visible to later statements in
-- the same transaction via Postgres's command-counter semantics, so
-- dropping the view earlier in this transaction is safe and sufficient.
--
-- Idempotent: safe to re-run if a prior attempt partially applied.

BEGIN;

-- ---------------------------------------------------------------------
-- Step 1: create the archive schema (idempotent)
-- ---------------------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS "legacy";
ALTER SCHEMA "legacy" OWNER TO "postgres";
COMMENT ON SCHEMA "legacy" IS
  'Archived legacy/duplicate tables retained for historical reference only. Not exposed to PostgREST. See Migration 032 (compliance audit Finding 2.2 / Section 3.2 resolution; builds on the write-freeze from Migration 022).';

-- ---------------------------------------------------------------------
-- Step 2: retire the KNOWN obsolete dependency first (idempotent).
-- This view's only purpose was to compare finance.* vs public.* row
-- counts; once there is only one live copy per entity, it has nothing
-- left to compare and is being replaced by v_legacy_archive_status
-- in Step 6.
-- ---------------------------------------------------------------------
DROP VIEW IF EXISTS "reporting"."v_duplicate_table_drift";

-- ---------------------------------------------------------------------
-- Step 3: dependency guard -- now only fires for genuinely unexpected
-- dependencies, since the one known dependency was just removed above.
-- ---------------------------------------------------------------------
DO $$
DECLARE
  v_offenders text;
BEGIN
  SELECT string_agg(DISTINCT format('%I.%I (references %I.%I)', vn.nspname, vc.relname, tn.nspname, tc.relname), ', ')
  INTO v_offenders
  FROM pg_depend d
  JOIN pg_rewrite r ON r.oid = d.objid
  JOIN pg_class vc ON vc.oid = r.ev_class
  JOIN pg_namespace vn ON vn.oid = vc.relnamespace
  JOIN pg_class tc ON tc.oid = d.refobjid
  JOIN pg_namespace tn ON tn.oid = tc.relnamespace
  WHERE tn.nspname = 'public'
    AND tc.relname IN ('financial_accounts','budget_lines','tax_returns','numbering_sequences')
    AND vn.nspname <> 'public';

  IF v_offenders IS NOT NULL THEN
    RAISE EXCEPTION
      'Aborting: the following UNEXPECTED object(s) outside public still depend on the legacy public duplicate tables: %. The known dependency (reporting.v_duplicate_table_drift) was already retired by this migration, so anything reported here is new and needs investigation before archiving.',
      v_offenders;
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- Step 4: move the four tables (idempotent -- skips any table that has
-- already been moved, e.g. on a re-run after partial success). Data,
-- PK/FK/UNIQUE/CHECK constraints, indexes, RLS policies, and the
-- Migration-022 triggers all move with the table automatically.
-- ---------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'financial_accounts') THEN
    ALTER TABLE "public"."financial_accounts" SET SCHEMA "legacy";
  END IF;
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'budget_lines') THEN
    ALTER TABLE "public"."budget_lines" SET SCHEMA "legacy";
  END IF;
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'tax_returns') THEN
    ALTER TABLE "public"."tax_returns" SET SCHEMA "legacy";
  END IF;
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'numbering_sequences') THEN
    ALTER TABLE "public"."numbering_sequences" SET SCHEMA "legacy";
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- Step 5: refresh documentation comments (safe to re-apply)
-- ---------------------------------------------------------------------
COMMENT ON TABLE "legacy"."financial_accounts" IS
  'ARCHIVED (Migration 032): formerly public.financial_accounts, a legacy duplicate of finance.financial_accounts (the canonical table). Write-frozen since Migration 022; retained read-only for historical reference. Resolves Compliance Audit Finding 2.2 / Section 3.2. NOTE: core.soft_delete() has an unreached branch referencing public.financial_accounts by name -- confirmed NOT a blocking dependency (PL/pgSQL body text is not tracked by pg_depend); tracked as a separate application-level follow-up, not fixed by this migration.';
COMMENT ON TABLE "legacy"."budget_lines" IS
  'ARCHIVED (Migration 032): formerly public.budget_lines, a legacy duplicate of finance.budget_lines (the canonical table; reporting.budget_gl_actual re-pointed to it in Migration 031). Write-frozen since Migration 022; retained read-only for historical reference.';
COMMENT ON TABLE "legacy"."tax_returns" IS
  'ARCHIVED (Migration 032): formerly public.tax_returns, a structurally orphaned duplicate of finance.tax_returns (the canonical table referenced by finance.tax_computations / tax_credits_and_withholding / tax_payments_and_refunds). Write-frozen since Migration 022; retained read-only for historical reference.';
COMMENT ON TABLE "legacy"."numbering_sequences" IS
  'ARCHIVED (Migration 032): formerly public.numbering_sequences, a legacy numbering authority disconnected from finance.get_next_number(). Write-frozen since Migration 022; retained read-only for historical reference.';

-- ---------------------------------------------------------------------
-- Step 6: lock down the archive schema (idempotent)
-- ---------------------------------------------------------------------
REVOKE ALL ON ALL TABLES IN SCHEMA "legacy" FROM "anon";
REVOKE ALL ON ALL TABLES IN SCHEMA "legacy" FROM "authenticated";
REVOKE ALL ON SCHEMA "legacy" FROM "anon";
REVOKE ALL ON SCHEMA "legacy" FROM "authenticated";

GRANT USAGE ON SCHEMA "legacy" TO "service_role";
GRANT SELECT ON ALL TABLES IN SCHEMA "legacy" TO "service_role";

ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "legacy"
  GRANT SELECT ON TABLES TO "service_role";

-- ---------------------------------------------------------------------
-- Step 7: create the replacement archive-status view (idempotent via
-- CREATE OR REPLACE; works whether the tables have already been moved
-- by this same run or by a prior partial run)
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW "reporting"."v_legacy_archive_status" WITH ("security_invoker"='true') AS
 SELECT 'financial_accounts'::"text" AS "entity",
    (SELECT "count"(*) FROM "finance"."financial_accounts") AS "canonical_rows",
    (SELECT "count"(*) FROM "legacy"."financial_accounts")  AS "archived_legacy_rows"
UNION ALL
 SELECT 'budget_lines'::"text",
    (SELECT "count"(*) FROM "finance"."budget_lines"),
    (SELECT "count"(*) FROM "legacy"."budget_lines")
UNION ALL
 SELECT 'tax_returns'::"text",
    (SELECT "count"(*) FROM "finance"."tax_returns"),
    (SELECT "count"(*) FROM "legacy"."tax_returns")
UNION ALL
 SELECT 'numbering_sequences'::"text",
    (SELECT "count"(*) FROM "finance"."numbering_sequences"),
    (SELECT "count"(*) FROM "legacy"."numbering_sequences");

ALTER VIEW "reporting"."v_legacy_archive_status" OWNER TO "postgres";
COMMENT ON VIEW "reporting"."v_legacy_archive_status" IS
  'Replaces reporting.v_duplicate_table_drift (Migration 032). Reference-only row counts for finance.* canonical tables vs. their archived legacy.* counterparts.';

GRANT SELECT ON "reporting"."v_legacy_archive_status" TO "authenticated";
GRANT SELECT ON "reporting"."v_legacy_archive_status" TO "service_role";

COMMIT;