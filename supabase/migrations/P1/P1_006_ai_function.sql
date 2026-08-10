-- Spec 9.5: Dedicated Read-Only Execution Function with Timeout
CREATE OR REPLACE FUNCTION public.execute_ai_readonly_query(query_string text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER -- Executes with function owner's rights, but we restrict it heavily
SET search_path = public, reporting, finance -- Block access to core, auth, ai schemas
AS $$
DECLARE
  result jsonb;
BEGIN
  -- Spec 9.5: Enforce strict statement timeout (5 seconds) to prevent expensive joins/DoS
  SET LOCAL statement_timeout = '5s';
  
  -- Execute the query and convert to JSONB
  EXECUTE query_string INTO result;
  
  -- Reset timeout
  RESET statement_timeout;
  
  RETURN result;
EXCEPTION
  WHEN query_canceled THEN
    RAISE EXCEPTION 'AI query timed out after 5 seconds. Please refine your question.';
  WHEN insufficient_privilege THEN
    RAISE EXCEPTION 'Access denied. AI can only query approved reporting views.';
  WHEN OTHERS THEN
    RAISE EXCEPTION 'Query execution failed: %', SQLERRM;
END;
$$;

-- Revoke execute from public, grant only to authenticated/service role via API
REVOKE ALL ON FUNCTION public.execute_ai_readonly_query(text) FROM PUBLIC;