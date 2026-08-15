-- =============================================================================
-- Migration: 026_security_definer_search_path.sql
-- Purpose  : CRITICAL-4 remediation. Pin `search_path` on every SECURITY DEFINER
--            function in the ai / audit / core / finance / public / reporting
--            schemas so that a caller cannot hijack function name resolution by
--            creating shadow objects earlier in their own search_path
--            (classic Postgres/Supabase SECURITY DEFINER privilege-escalation
--            vector; see spec Section 20 and Appendix C "PostgreSQL Row
--            Security Policies" / Supabase RLS guidance).
--
-- Approach : Rather than hand-writing ~86 ALTER FUNCTION statements (fragile
--            against future signature drift), this migration walks pg_proc for
--            every SECURITY DEFINER function owned by this project's schemas
--            and applies `SET search_path = pg_catalog, <owning schema>, public`
--            to each one. Functions that already declare a `search_path`
--            config parameter (e.g. public.execute_ai_readonly_query, which
--            intentionally scopes itself to 'public','reporting') are left
--            untouched so we do not weaken an already-correct, narrower
--            configuration.
--
--            `pg_catalog` is always included first so built-in types/operators
--            resolve safely regardless of caller state. The function's own
--            declared schema is included so unqualified references inside the
--            function body keep working. `public` is appended because several
--            functions call across schemas into public (e.g. public.profiles).
--
-- Safety   : Idempotent (checks proconfig before altering). No data changes.
--            No signature changes. Purely a hardening ALTER on existing
--            functions; safe to re-run.
-- =============================================================================

DO $migration$
DECLARE
  r RECORD;
  v_search_path text;
  v_already_set boolean;
BEGIN
  FOR r IN
    SELECT
      p.oid,
      n.nspname AS schema_name,
      p.proname AS func_name,
      pg_get_function_identity_arguments(p.oid) AS args,
      p.proconfig
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname IN ('ai','audit','core','finance','public','reporting')
      AND p.prosecdef = true
  LOOP
    v_already_set := false;
    IF r.proconfig IS NOT NULL THEN
      SELECT bool_or(cfg LIKE 'search_path=%')
      INTO v_already_set
      FROM unnest(r.proconfig) AS cfg;
    END IF;

    IF COALESCE(v_already_set, false) THEN
      -- Function already pins its own search_path (e.g. the AI gateway
      -- function intentionally restricts itself to public, reporting).
      -- Do not override an intentionally narrower configuration.
      CONTINUE;
    END IF;

    v_search_path := format('pg_catalog, %I, public', r.schema_name);

    EXECUTE format(
      'ALTER FUNCTION %I.%I(%s) SET search_path = %s',
      r.schema_name, r.func_name, r.args, v_search_path
    );
  END LOOP;
END;
$migration$;

-- Verification helper view: lists any remaining SECURITY DEFINER function
-- without a pinned search_path, so future functions can be caught in CI/QA
-- before they ship without this control. Kept as a permanent, low-cost
-- guardrail (read-only, service_role/definition-only, no sensitive data).
CREATE OR REPLACE VIEW "audit"."v_unsafe_security_definer_functions" AS
SELECT
  n.nspname AS schema_name,
  p.proname AS function_name,
  pg_get_function_identity_arguments(p.oid) AS arguments
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname IN ('ai','audit','core','finance','public','reporting')
  AND p.prosecdef = true
  AND NOT EXISTS (
    SELECT 1 FROM unnest(COALESCE(p.proconfig, ARRAY[]::text[])) AS cfg
    WHERE cfg LIKE 'search_path=%'
  );

COMMENT ON VIEW "audit"."v_unsafe_security_definer_functions" IS
  'Guardrail view (spec Section 20): any row here is a SECURITY DEFINER function shipped without a pinned search_path and must be fixed before release.';

REVOKE ALL ON "audit"."v_unsafe_security_definer_functions" FROM PUBLIC, anon, authenticated;
GRANT SELECT ON "audit"."v_unsafe_security_definer_functions" TO service_role;