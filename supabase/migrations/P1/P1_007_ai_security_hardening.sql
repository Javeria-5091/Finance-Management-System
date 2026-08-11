-- =============================================================================
-- P1_007_ai_security_hardening.sql (REVISED)
--
-- Creates a dedicated, minimally-privileged role (ai_readonly_role) that the
-- execute_ai_readonly_query() function switches into (via SET ROLE, see
-- P1_006_ai_function.sql) before running any AI-generated query. This role
-- gets SELECT on ONLY the specific approved reporting views — nothing else,
-- ever (Spec 9.5: "dedicated read-only database role with no write, DDL,
-- function creation, file access, or privileged schema access").
--
-- auth.uid() / JWT claims are session-level (set by PostgREST/Supabase per
-- request) and are unaffected by SET ROLE, so RLS policies keyed off
-- auth.uid() still scope rows to the real calling user.
--
-- ✅ This revision no longer transfers function ownership (that required
-- CREATE privilege on schema "public", which Supabase doesn't grant new
-- roles by default and caused "permission denied for schema public"). Run
-- P1_006_ai_function.sql (revised version) together with this file — that
-- file makes the function SET ROLE internally instead.
-- =============================================================================

-- 1. Dedicated read-only role
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ai_readonly_role') THEN
    CREATE ROLE ai_readonly_role
      NOLOGIN
      NOSUPERUSER
      NOCREATEDB
      NOCREATEROLE
      NOBYPASSRLS;
  END IF;
END
$$;

-- 1a. Grant membership of ai_readonly_role to whichever role owns
--     execute_ai_readonly_query() (normally 'postgres' in Supabase), so that
--     the function's SET ROLE ai_readonly_role statement is permitted.
DO $$
BEGIN
  EXECUTE format('GRANT ai_readonly_role TO %I', current_user);
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'Could not auto-grant ai_readonly_role to %. Ask a Supabase project admin to run: GRANT ai_readonly_role TO %;', current_user, current_user;
END
$$;

GRANT ai_readonly_role TO postgres;

-- 2. Deny everything by default on every sensitive schema
REVOKE ALL ON SCHEMA core    FROM ai_readonly_role;
REVOKE ALL ON SCHEMA auth    FROM ai_readonly_role;
REVOKE ALL ON SCHEMA storage FROM ai_readonly_role;
REVOKE ALL ON SCHEMA audit   FROM ai_readonly_role;
REVOKE ALL ON SCHEMA ai      FROM ai_readonly_role;

-- 3. Allow only USAGE on "public" (needed for search_path resolution — no
--    CREATE, no table grants there; every query must still be
--    schema-qualified to "reporting." per isSqlSafe()) and SELECT on only
--    the specific approved reporting views. Add a new GRANT line here every
--    time a new AI tool/view is added to AI_TOOLS in route.ts — never GRANT
--    on the whole schema.
GRANT USAGE ON SCHEMA public    TO ai_readonly_role;
GRANT USAGE ON SCHEMA reporting TO ai_readonly_role;
GRANT SELECT ON reporting.v_cash_position           TO ai_readonly_role;
GRANT SELECT ON reporting.v_project_profitability    TO ai_readonly_role;
GRANT SELECT ON reporting.v_tax_computation_summary  TO ai_readonly_role;

-- 4. Belt-and-braces: even if this role is ever granted a table directly in
--    future, force RLS to still apply to it.
ALTER ROLE ai_readonly_role SET row_security = on;

-- =============================================================================
-- VERIFY AFTER RUNNING (run these manually, not part of the migration):
--
--   SELECT rolname FROM pg_roles WHERE rolname = 'ai_readonly_role';
--
--   SELECT grantee, table_schema, table_name, privilege_type
--   FROM information_schema.role_table_grants
--   WHERE grantee = 'ai_readonly_role';
--   -- must show ONLY reporting.v_cash_position, v_project_profitability,
--   -- v_tax_computation_summary with SELECT — nothing else, ever.
--
--   -- confirm the function still switches role correctly:
--   SELECT public.execute_ai_readonly_query(
--     $q$ SELECT COALESCE(jsonb_agg(t), '[]'::jsonb) FROM (SELECT * FROM reporting.v_cash_position LIMIT 1) t $q$
--   );
-- =============================================================================