-- =============================================================================
-- P1_006_ai_function.sql (REVISED v2)
--
-- ✅ FIX (Gap 2 — parameterized org/user scoping):
-- The previous version accepted only `query_string`, and the CALLER
-- (app/api/ai/chat/route.ts) was responsible for wrapping it with
-- `WHERE organization_id = '${orgId}' AND user_id = '${userId}' ...` via
-- plain TypeScript string interpolation before calling this function.
-- That is exactly the raw-interpolation pattern api-auth.ts's old
-- injectScope() comment claimed was already fixed — but the route never
-- called injectScope(); it had its own local buildScopedSql() that still
-- did the unsafe thing.
--
-- This version moves the wrapping INSIDE the function and takes org_id /
-- user_id as typed `uuid` PostgreSQL parameters (not raw text), so the
-- database itself enforces the type at the boundary — a malformed or
-- attacker-controlled value can't even reach format() as anything other
-- than a valid UUID. format(...,%L) is then used to safely quote them as
-- SQL literals when building the dynamic wrapper. Application code now
-- only ever passes the validated *inner* SELECT (already checked by
-- isSqlSafe()'s AST parser) — it can never influence the
-- organization/user scope or the LIMIT, because that part isn't built in
-- application code anymore at all.
-- =============================================================================

-- Drop the old single-argument overload so we don't end up with two
-- versions of this function (old text-only signature + new signature)
-- both callable side by side.
DROP FUNCTION IF EXISTS public.execute_ai_readonly_query(text);

CREATE OR REPLACE FUNCTION public.execute_ai_readonly_query(
  query_string text,
  p_org_id uuid,
  p_user_id uuid,
  p_enforce_user_scope boolean DEFAULT true
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, reporting
AS $$
DECLARE
  result jsonb;
  wrapped_sql text;
  user_filter text := '';
BEGIN
  -- Switch into the restricted, minimal-privilege role for the duration of
  -- this statement only. SET LOCAL automatically reverts at the end of the
  -- current transaction even if we forget to RESET, but we also RESET
  -- explicitly on every path below for clarity and defense-in-depth.
  SET LOCAL ROLE ai_readonly_role;
  SET LOCAL statement_timeout = '5s';

  IF p_enforce_user_scope THEN
    user_filter := format('AND user_id = %L', p_user_id);
  END IF;

  -- org_id/user_id are typed uuid parameters here — they never come from
  -- LLM output or raw app-level string concatenation, so %L is
  -- defense-in-depth on top of that, not the sole safety mechanism.
  wrapped_sql := format(
    'SELECT COALESCE(jsonb_agg(t), ''[]''::jsonb) FROM (
       WITH llm_query AS ( %s )
       SELECT * FROM llm_query
       WHERE organization_id = %L
       %s
       LIMIT 200
     ) t',
    query_string,
    p_org_id,
    user_filter
  );

  EXECUTE wrapped_sql INTO result;

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
  WHEN undefined_column THEN
    RESET ROLE;
    RAISE EXCEPTION 'That view does not expose an organization_id/user_id column needed for scoping.';
  WHEN OTHERS THEN
    RESET ROLE;
    RAISE EXCEPTION 'Query execution failed: %', SQLERRM;
END;
$$;

-- Only the app's authenticated role may ever call this function.
REVOKE ALL ON FUNCTION public.execute_ai_readonly_query(text, uuid, uuid, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.execute_ai_readonly_query(text, uuid, uuid, boolean) TO authenticated;

-- =============================================================================
-- VERIFY AFTER RUNNING (run these manually, not part of the migration):
--
--   SELECT proname, pg_get_function_identity_arguments(oid)
--   FROM pg_proc WHERE proname = 'execute_ai_readonly_query';
--   -- should show exactly ONE row: (text, uuid, uuid, boolean)
--
--   SELECT public.execute_ai_readonly_query(
--     'SELECT * FROM reporting.v_cash_position',
--     '<some-real-org-uuid>'::uuid,
--     '<some-real-user-uuid>'::uuid,
--     false
--   );
-- =============================================================================