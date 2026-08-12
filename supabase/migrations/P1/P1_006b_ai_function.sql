-- =============================================================================
-- P1_006_ai_function.sql (REVISED — see P1_007_ai_security_hardening.sql for context)
--
-- ✅ FIX: earlier we tried "ALTER FUNCTION ... OWNER TO ai_readonly_role" to
-- make this SECURITY DEFINER function run with restricted privileges. That
-- requires ai_readonly_role to have CREATE privilege on schema "public"
-- (Postgres requires the new owner of an object to be allowed to create
-- objects in that object's schema), which Supabase does not grant to new
-- roles by default — hence "permission denied for schema public".
--
-- Cleaner fix: keep the function owned by whichever role created it
-- (normally 'postgres'), but have the function itself switch into the
-- restricted role with SET ROLE before running the dynamic query, and
-- switch back immediately after (including on every error path). This
-- achieves the same privilege restriction without any ownership/schema
-- permission requirements. It only requires that the function's owner is a
-- member of ai_readonly_role — which P1_007's step 1a already grants.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.execute_ai_readonly_query(query_string text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, reporting
AS $$
DECLARE
  result jsonb;
BEGIN
  -- Switch into the restricted, minimal-privilege role for the duration of
  -- this statement only. SET LOCAL automatically reverts at the end of the
  -- current transaction even if we forget to RESET, but we also RESET
  -- explicitly on every path below for clarity and defense-in-depth.
  SET LOCAL ROLE ai_readonly_role;
  SET LOCAL statement_timeout = '5s';

  EXECUTE query_string INTO result;

  RESET ROLE;
  RESET statement_timeout;

  RETURN result;
EXCEPTION
  WHEN query_canceled THEN
    RESET ROLE;
    RAISE EXCEPTION 'AI query timed out after 5 seconds. Please refine your question.';
  WHEN insufficient_privilege THEN
    RESET ROLE;
    RAISE EXCEPTION 'Access denied. AI can only query approved reporting views.';
  WHEN OTHERS THEN
    RESET ROLE;
    RAISE EXCEPTION 'Query execution failed: %', SQLERRM;
END;
$$;

-- Only the app's authenticated role may ever call this function.
REVOKE ALL ON FUNCTION public.execute_ai_readonly_query(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.execute_ai_readonly_query(text) TO authenticated;