-- =============================================================================
-- Migration: 022_legacy_duplicate_table_write_freeze.sql
-- Purpose:   Mitigate compliance issue C-1 (Schema Compliance Audit,
--            CRITICAL finding). Spec ref: Section 5.8/5.1 "financial
--            accounts... user-configured master records" (single source of
--            truth), Section 10.5 "Financial accounts are organization-
--            scoped, user-configured master records", Section 2.2 success
--            criterion "Cash accuracy: System bank and wallet balances
--            reconcile to imported statements."
--
-- Problem:   Four entities each have two independently-writable tables that
--            the schema's own comments confirm are NOT kept in sync:
--              finance.financial_accounts   <-> public.financial_accounts
--              finance.numbering_sequences  <-> public.numbering_sequences
--              finance.budget_lines         <-> public.budget_lines
--              finance.tax_returns          <-> public.tax_returns
--            The finance.* table is the canonical, spec-aligned one in every
--            case (per the existing in-schema comments and per the fact that
--            reporting views such as reporting.v_cash_position read only
--            from finance.financial_accounts). The public.* tables predate
--            them and remain fully writable through their own RLS policies.
--
-- IMPORTANT - WHY THIS MIGRATION DOES NOT DROP OR CONVERT THE LEGACY TABLES:
--            The task brief for this migration set explicitly requires: do
--            not silently rename/remove objects the application may depend
--            on, and stop and explain before proposing destructive changes.
--            The legacy and canonical tables in each pair have MATERIALLY
--            DIFFERENT column sets and, in the financial_accounts and
--            tax_returns cases, different enum vocabularies (e.g. legacy
--            financial_accounts.account_type allows
--            BANK/CASH/MOBILE_WALLET/OTHER, while finance.financial_accounts
--            .account_type allows
--            CURRENT/SAVINGS/DIGITAL_WALLET/PLATFORM_BALANCE/PETTY_CASH/
--            CLEARING -- there is no lossless 1:1 mapping between them).
--            Converting the legacy table into a view over the canonical
--            table (the pattern already used successfully elsewhere in this
--            schema for e.g. public.journal_entries) would therefore require
--            either fabricating a value mapping (risking silent semantic
--            corruption of historical data) or dropping columns the
--            application may still read. Neither is safe to do without
--            knowing which table the application frontend/API actually
--            targets for each entity today.
--
--            THIS IS THEREFORE FLAGGED AS "REQUIRES MANUAL DECISION" IN THE
--            REMEDIATION MATRIX, NOT AUTO-RESOLVED. See the remediation plan
--            for the two safe consolidation paths once that decision is
--            made.
--
-- Fix (what THIS migration safely does today):
--            Freeze further drift without touching any existing data or
--            dropping any object: replace the permissive INSERT/UPDATE
--            policies on the four legacy tables with USING(false)/WITH
--            CHECK(false) for the authenticated role (the same idiom already
--            used elsewhere in this schema for audit_log_no_update/
--            audit_log_no_delete), while preserving full service_role access
--            so an authorized backend script can still perform the eventual
--            one-time data consolidation. SELECT and DELETE policies are
--            left untouched -- existing data remains fully readable, and no
--            data is deleted by this migration.
--
--            This stops the compliance risk described in the audit (silent
--            divergence between the two tables) immediately, while the
--            consolidation decision itself is made deliberately rather than
--            automatically.
--
-- Data safety: Non-destructive. No rows are altered or deleted. Only future
--            INSERT/UPDATE attempts through the authenticated role against
--            the four legacy tables are blocked. Existing legacy rows remain
--            visible and intact for the eventual consolidation/migration
--            step. If the application currently writes to any of these
--            legacy tables for a live user-facing feature, THAT FEATURE WILL
--            START FAILING WRITES after this migration is applied -- run the
--            verification queries at the bottom FIRST, in a staging
--            environment, to confirm no legacy table has received a write in
--            recent history before applying this to production. If any has,
--            resolve the consolidation decision before applying this
--            migration rather than applying it blind.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- finance.financial_accounts <-> public.financial_accounts
-- -----------------------------------------------------------------------------
DROP POLICY IF EXISTS "fa_pub_insert" ON "public"."financial_accounts";
DROP POLICY IF EXISTS "fa_pub_update" ON "public"."financial_accounts";

CREATE POLICY "fa_pub_insert_frozen" ON "public"."financial_accounts"
  FOR INSERT TO "authenticated" WITH CHECK (false);

CREATE POLICY "fa_pub_update_frozen" ON "public"."financial_accounts"
  FOR UPDATE TO "authenticated" USING (false);

CREATE POLICY "fa_pub_service_all" ON "public"."financial_accounts"
  TO "service_role" USING (true) WITH CHECK (true);

-- -----------------------------------------------------------------------------
-- finance.numbering_sequences <-> public.numbering_sequences
-- -----------------------------------------------------------------------------
DROP POLICY IF EXISTS "numbering_insert" ON "public"."numbering_sequences";
DROP POLICY IF EXISTS "numbering_update" ON "public"."numbering_sequences";

CREATE POLICY "numbering_insert_frozen" ON "public"."numbering_sequences"
  FOR INSERT TO "authenticated" WITH CHECK (false);

CREATE POLICY "numbering_update_frozen" ON "public"."numbering_sequences"
  FOR UPDATE TO "authenticated" USING (false);

CREATE POLICY "numbering_service_all" ON "public"."numbering_sequences"
  TO "service_role" USING (true) WITH CHECK (true);

-- -----------------------------------------------------------------------------
-- finance.budget_lines <-> public.budget_lines
-- -----------------------------------------------------------------------------
DROP POLICY IF EXISTS "Admins can insert budget lines" ON "public"."budget_lines";
DROP POLICY IF EXISTS "Admins can update budget lines" ON "public"."budget_lines";

CREATE POLICY "budget_lines_pub_insert_frozen" ON "public"."budget_lines"
  FOR INSERT TO "authenticated" WITH CHECK (false);

CREATE POLICY "budget_lines_pub_update_frozen" ON "public"."budget_lines"
  FOR UPDATE TO "authenticated" USING (false);

CREATE POLICY "budget_lines_pub_service_all" ON "public"."budget_lines"
  TO "service_role" USING (true) WITH CHECK (true);

-- -----------------------------------------------------------------------------
-- finance.tax_returns <-> public.tax_returns
-- The existing "Admins can manage tax returns" policy has no FOR clause
-- (defaults to ALL) and no USING clause (defaults to true), i.e. it
-- currently grants full SELECT/INSERT/UPDATE/DELETE to any authenticated
-- user. Replace it with the same read-preserved / write-frozen pattern.
-- The pre-existing "Anyone can view tax returns" SELECT policy is untouched.
-- -----------------------------------------------------------------------------
DROP POLICY IF EXISTS "Admins can manage tax returns" ON "public"."tax_returns";

CREATE POLICY "tax_returns_pub_insert_frozen" ON "public"."tax_returns"
  FOR INSERT TO "authenticated" WITH CHECK (false);

CREATE POLICY "tax_returns_pub_update_frozen" ON "public"."tax_returns"
  FOR UPDATE TO "authenticated" USING (false);

CREATE POLICY "tax_returns_pub_delete_frozen" ON "public"."tax_returns"
  FOR DELETE TO "authenticated" USING (false);

CREATE POLICY "tax_returns_pub_service_all" ON "public"."tax_returns"
  TO "service_role" USING (true) WITH CHECK (true);

-- Record the freeze in-schema so the next engineer sees it immediately.
COMMENT ON TABLE "public"."financial_accounts" IS
  'LEGACY financial accounts table (predates finance.financial_accounts). '
  'WRITE-FROZEN as of Migration 022 pending a manual consolidation decision '
  '-- INSERT/UPDATE now blocked for authenticated users. finance.'
  'financial_accounts is canonical. See Migration 022 / compliance audit '
  'Section C-1.';

COMMENT ON TABLE "public"."numbering_sequences" IS
  'LEGACY numbering table. WRITE-FROZEN as of Migration 022 pending a manual '
  'consolidation decision. finance.numbering_sequences (used by finance.'
  'get_next_number()) is canonical. See Migration 022 / compliance audit '
  'Section C-1.';

COMMENT ON TABLE "public"."budget_lines" IS
  'LEGACY budget line items table. WRITE-FROZEN as of Migration 022 pending '
  'a manual consolidation decision. finance.budget_lines is canonical. See '
  'Migration 022 / compliance audit Section C-1.';

COMMENT ON TABLE "public"."tax_returns" IS
  'LEGACY tax returns table, structurally orphaned (no inbound FKs). '
  'WRITE-FROZEN as of Migration 022 pending a manual consolidation decision. '
  'finance.tax_returns is canonical and is what finance.tax_computations / '
  'tax_credits_and_withholding / tax_payments_and_refunds actually '
  'reference. See Migration 022 / compliance audit Section C-1.';

COMMIT;

-- -----------------------------------------------------------------------------
-- Verification (READ-ONLY -- run BEFORE applying this migration, ideally
-- against a recent production snapshot, to check whether the legacy tables
-- are still receiving live writes that would break if frozen):
-- -----------------------------------------------------------------------------
-- SELECT 'public.financial_accounts' AS tbl, count(*) AS rows,
--        max(created_at) AS most_recent_row
--   FROM public.financial_accounts
-- UNION ALL
-- SELECT 'finance.financial_accounts', count(*), max(created_at)
--   FROM finance.financial_accounts
-- UNION ALL
-- SELECT 'public.numbering_sequences', count(*), max(updated_at)
--   FROM public.numbering_sequences
-- UNION ALL
-- SELECT 'finance.numbering_sequences', count(*), max(updated_at)
--   FROM finance.numbering_sequences
-- UNION ALL
-- SELECT 'public.budget_lines', count(*), max(created_at)
--   FROM public.budget_lines
-- UNION ALL
-- SELECT 'finance.budget_lines', count(*), max(created_at)
--   FROM finance.budget_lines
-- UNION ALL
-- SELECT 'public.tax_returns', count(*), max(created_at)
--   FROM public.tax_returns
-- UNION ALL
-- SELECT 'finance.tax_returns', count(*), max(created_at)
--   FROM finance.tax_returns;
--
-- If any "public.*" row in this result has a most_recent_row timestamp
-- newer than, or close to, its "finance.*" counterpart, the application is
-- likely still actively writing to the legacy table -- STOP and resolve the
-- consolidation decision (which table the app should target, and a one-time
-- data migration of any legacy-only rows into the canonical table) before
-- applying this freeze, or the freeze will break a live feature.


-- =============================================================================
-- Migration 031: Hard-freeze legacy duplicate tables
-- =============================================================================
-- PURPOSE
--   Fixes Compliance Audit Finding 2.2 (Medium): public.budget_lines,
--   public.financial_accounts, public.numbering_sequences, and
--   public.tax_returns are legacy duplicates of their canonical finance.*
--   counterparts. A prior migration (022, per the existing schema comments)
--   already froze INSERT/UPDATE for the `authenticated` role via
--   `WITH CHECK (false)` / `USING (false)` RLS policies. This migration
--   closes the two gaps that freeze left open:
--
--   1. DELETE was NOT frozen on two of the four tables:
--      - public.budget_lines: "Admins can delete budget lines" USING (true)
--        is still active and permissive.
--      - public.financial_accounts: "fa_pub_delete" still allows
--        core.is_finance_head() to delete rows.
--      (public.tax_returns already had a DELETE freeze; public.numbering_sequences
--       had no DELETE policy at all, which is effectively deny-by-default
--       under RLS, so it is left as-is.)
--
--   2. RLS-based freezes do not apply to `service_role` (each of the four
--      tables has a "*_service_all" policy with USING(true)/WITH CHECK(true)
--      for service_role, and RLS does not apply at all to a role with the
--      BYPASSRLS attribute). Any server-side code running with the service
--      key is therefore NOT actually blocked from writing to these legacy
--      tables today. This migration adds a BEFORE INSERT OR UPDATE OR DELETE
--      trigger on all four tables that raises an exception regardless of
--      role -- including service_role -- unless the session has explicitly
--      opted in via `SET LOCAL app.allow_legacy_write = 'true'`, which is
--      reserved for a deliberate, audited, one-time consolidation script.
--
-- ISSUES FIXED
--   - Spec Section 3.2 ("must not maintain conflicting copies")
--   - Spec Section 27 (Internal Consistency -- duplicate entities)
--
-- SAFETY
--   Non-destructive: no table, row, or column is dropped. The legacy tables
--   and their data remain fully readable. This only removes the ability to
--   write to them outside an explicit, intentional escape hatch.
-- =============================================================================

CREATE OR REPLACE FUNCTION "core"."block_legacy_table_write"()
RETURNS "trigger"
LANGUAGE "plpgsql"
SET "search_path" TO 'pg_catalog', 'public'
AS $$
BEGIN
  IF current_setting('app.allow_legacy_write', true) IS DISTINCT FROM 'true' THEN
    RAISE EXCEPTION
      'Table %.% is a legacy duplicate that is frozen (Compliance Audit Finding 2.2). Writes are blocked for every role, including service_role. If this is a deliberate, audited data-consolidation operation, run it inside a transaction that first executes: SET LOCAL app.allow_legacy_write = ''true'';',
      TG_TABLE_SCHEMA, TG_TABLE_NAME
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

ALTER FUNCTION "core"."block_legacy_table_write"() OWNER TO "postgres";

COMMENT ON FUNCTION "core"."block_legacy_table_write"() IS
  'Hard-freeze for known legacy duplicate tables (Compliance Audit Finding 2.2). Blocks INSERT/UPDATE/DELETE for every role, including service_role/BYPASSRLS roles, which RLS-only freezes cannot reach. Escape hatch: SET LOCAL app.allow_legacy_write = ''true'' for an explicit, audited consolidation script only.';

DO $$
DECLARE
  t record;
  legacy_tables text[][] := ARRAY[
    ARRAY['public','budget_lines'],
    ARRAY['public','financial_accounts'],
    ARRAY['public','numbering_sequences'],
    ARRAY['public','tax_returns']
  ];
  i int;
BEGIN
  FOR i IN 1..array_length(legacy_tables, 1) LOOP
    IF EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = legacy_tables[i][1] AND table_name = legacy_tables[i][2]
    ) THEN
      EXECUTE format(
        'DROP TRIGGER IF EXISTS trg_block_legacy_write ON %I.%I',
        legacy_tables[i][1], legacy_tables[i][2]
      );
      EXECUTE format(
        'CREATE TRIGGER trg_block_legacy_write BEFORE INSERT OR UPDATE OR DELETE ON %I.%I FOR EACH ROW EXECUTE FUNCTION core.block_legacy_table_write()',
        legacy_tables[i][1], legacy_tables[i][2]
      );
    END IF;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- Close the two RLS gaps identified above (defense in depth alongside the
-- trigger; also makes the DELETE policies consistent with the existing
-- INSERT/UPDATE freeze convention already used on these same four tables).
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS "Admins can delete budget lines" ON "public"."budget_lines";
CREATE POLICY "budget_lines_pub_delete_frozen" ON "public"."budget_lines" FOR DELETE
  TO "authenticated" USING (false);

DROP POLICY IF EXISTS "fa_pub_delete" ON "public"."financial_accounts";
CREATE POLICY "fa_pub_delete_frozen" ON "public"."financial_accounts" FOR DELETE
  TO "authenticated" USING (false);