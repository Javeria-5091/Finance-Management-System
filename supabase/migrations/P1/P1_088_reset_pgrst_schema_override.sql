-- =============================================================================
-- Migration: P1_088_reset_pgrst_schema_override.sql
-- Purpose:   Fixes "Invalid schema: audit" / "Invalid schema: finance"
--            console errors seen right after login (logSecurityEvent,
--            useFiscalPeriod).
--
-- Root cause: P1_075_fix_journal_reversal_engine_&_ceo_kpi.sql ran
--               ALTER ROLE authenticator SET pgrst.db_schemas =
--                 'public, graphql_public, reporting';
--             This sets exposed schemas at the DATABASE ROLE level, which
--             takes priority over -- and freezes -- the Supabase Dashboard's
--             Project Settings -> Data API -> "Exposed schemas" field. Since
--             that hardcoded list only ever included `reporting` (added for
--             BUG-004), `audit` and `finance` (and `core`, `ai`, `ops`) were
--             never actually exposed at the PostgREST level, no matter what
--             the Dashboard showed or how many times it was saved.
--
-- Fix:       RESET the role-level override so PostgREST goes back to
--            reading the Dashboard-managed schema list (Project Settings ->
--            Data API -> Exposed schemas), which has already been
--            correctly configured to include public, graphql_public,
--            audit, finance, core, ai, ops, reporting.
--
-- IMPORTANT: This statement affects live PostgREST config, not app data --
--            it must be run directly against the project (SQL Editor or
--            `supabase db push`), same as P1_075 was. It cannot be
--            reproduced by editing supabase/config.toml, since this project
--            is a hosted/managed Supabase project (config.toml only
--            controls local `supabase start`).
-- =============================================================================

ALTER ROLE authenticator RESET pgrst.db_schemas;
NOTIFY pgrst, 'reload config';
NOTIFY pgrst, 'reload schema';