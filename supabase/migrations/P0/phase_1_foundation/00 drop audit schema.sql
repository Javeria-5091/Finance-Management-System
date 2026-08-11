-- ═══════════════════════════════════════════════════════════════════════════
-- 00_drop_audit_schema.sql
-- Removes EVERY audit-related object, cleanly, before the spec rebuild.
-- Only touches: the `audit` schema itself, public.v_audit_log /
-- public.v_audit_log_enriched, and any trigger anywhere in the database
-- that calls audit.trigger_audit_log(). Nothing outside audit logging is
-- touched — business tables (finance.*, public.expenses, etc.) keep all
-- their data and their own (non-audit) triggers/constraints.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- STEP 1: Drop every trigger anywhere that fires audit.trigger_audit_log(),
-- wherever it was attached (finance.*, core.*, public.*, whatever is live).
DO $$
DECLARE
    v_schema TEXT;
    v_table TEXT;
    v_trigger TEXT;
BEGIN
    FOR v_schema, v_table, v_trigger IN
        SELECT n.nspname, c.relname, t.tgname
        FROM pg_trigger t
        JOIN pg_class c ON t.tgrelid = c.oid
        JOIN pg_namespace n ON c.relnamespace = n.oid
        JOIN pg_proc p ON t.tgfoid = p.oid
        JOIN pg_namespace pn ON p.pronamespace = pn.oid
        WHERE pn.nspname = 'audit'
          AND p.proname = 'trigger_audit_log'
          AND NOT t.tgisinternal
    LOOP
        EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I.%I', v_trigger, v_schema, v_table);
        RAISE NOTICE 'Dropped trigger % on %.%', v_trigger, v_schema, v_table;
    END LOOP;
END $$;

-- STEP 2: Drop dependent views (public schema) before the table
DROP VIEW IF EXISTS public.v_audit_log CASCADE;
DROP VIEW IF EXISTS public.v_audit_log_enriched CASCADE;
DROP VIEW IF EXISTS audit.audit_log_enriched CASCADE;

-- STEP 3: Drop everything under the audit schema (tables, functions, all)
DROP SCHEMA IF EXISTS audit CASCADE;

-- STEP 4: Belt-and-braces — in case any stray objects exist outside the
-- audit schema from very old attempts
DROP TABLE IF EXISTS public.audit_logs CASCADE;
DROP TABLE IF EXISTS public.audit_log CASCADE;
DROP FUNCTION IF EXISTS public.has_audit_permission(UUID) CASCADE;
DROP FUNCTION IF EXISTS public.log_audit_action() CASCADE;

DO $$
BEGIN
  RAISE NOTICE 'Audit schema fully removed. Nothing else in the database was touched.';
END $$;

COMMIT;