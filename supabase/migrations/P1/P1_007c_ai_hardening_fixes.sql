-- =============================================================================
-- P1_008_ai_hardening_fixes.sql
--
-- Follow-up fixes after a spec-alignment review against Sections 8 and 9
-- (AI Finance Layer / Audit Trail):
--
--   1. Atomic per-user/org AI usage counter (Spec 9.11 cost control).
--      Gap: checkAiDailyLimit() / checkOrgAiDailyLimit() in api-auth.ts
--      only ever READ ai.ai_user_cost_tracking. Nothing in the codebase
--      ever wrote to it, so request_count/estimated_cost stayed at 0
--      forever and the daily limits could never actually trigger —
--      effectively unlimited AI usage was possible in production.
--
--   2. Grants for the new execute_ai_readonly_query(text, uuid, uuid,
--      boolean) signature, as a safety net in case P1_006_ai_function.sql
--      v2 is applied separately from this file.
--
--   3. RLS: CEO / FINANCE_HEAD / AUDITOR / Admin need read access to
--      ai_conversations and ai_messages, not just ai_tool_calls /
--      ai_query_audit (which P1_006_ai_schema.sql's "FIX 1" block already
--      granted). Appendix A lists AI Q&A as "Full scope" for CEO/Finance
--      Head and "Read scope" for Auditor — that has to include the actual
--      conversation content, not just the tool-call/query metadata.
--
--   4. text_to_sql prompt: the DB-seeded version (P1_006_ai_seed_prompts...
--      style migration) was missing the "Schema: ..." line that the
--      hardcoded code fallback had. Once that DB row became the active
--      prompt, the model silently lost all schema context. Reseeded with
--      the same {{SCHEMA}} placeholder the app code now fills in.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------
-- 1. Atomic usage increment (Spec 9.11 cost control)
-- -----------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ai.increment_usage(
  p_user_id uuid,
  p_organization_id uuid,
  p_tokens integer,
  p_cost numeric
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ai
AS $$
BEGIN
  INSERT INTO ai.ai_user_cost_tracking
    (user_id, organization_id, period_date, request_count, total_tokens, estimated_cost)
  VALUES
    (p_user_id, p_organization_id, CURRENT_DATE, 1, GREATEST(p_tokens, 0), GREATEST(p_cost, 0))
  ON CONFLICT (user_id, organization_id, period_date)
  DO UPDATE SET
    request_count  = ai.ai_user_cost_tracking.request_count + 1,
    total_tokens    = ai.ai_user_cost_tracking.total_tokens + GREATEST(p_tokens, 0),
    estimated_cost  = ai.ai_user_cost_tracking.estimated_cost + GREATEST(p_cost, 0),
    updated_at      = now();
END;
$$;

REVOKE ALL ON FUNCTION ai.increment_usage(uuid, uuid, integer, numeric) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ai.increment_usage(uuid, uuid, integer, numeric) TO authenticated;

-- -----------------------------------------------------------------------
-- 2. Grants for the new execute_ai_readonly_query signature (safety net —
--    P1_006_ai_function.sql v2 already issues this GRANT itself)
-- -----------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'execute_ai_readonly_query'
      AND pg_get_function_identity_arguments(p.oid) = 'query_string text, p_org_id uuid, p_user_id uuid, p_enforce_user_scope boolean'
  ) THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.execute_ai_readonly_query(text, uuid, uuid, boolean) TO authenticated';
  END IF;
END
$$;

-- -----------------------------------------------------------------------
-- 3. RLS: extend privileged-role read access to conversations + messages
-- -----------------------------------------------------------------------
DROP POLICY IF EXISTS users_own_conversations ON ai.ai_conversations;
DROP POLICY IF EXISTS read_ai_conversations ON ai.ai_conversations;
DROP POLICY IF EXISTS write_own_conversations ON ai.ai_conversations;
DROP POLICY IF EXISTS update_own_conversations ON ai.ai_conversations;
DROP POLICY IF EXISTS delete_own_conversations ON ai.ai_conversations;

-- Read: owner OR a privileged org role (same role list as the existing
-- FIX 1 policy on ai_tool_calls/ai_query_audit, for consistency).
CREATE POLICY read_ai_conversations ON ai.ai_conversations
  FOR SELECT USING (
    user_id = auth.uid()
    OR EXISTS (
      SELECT 1 FROM core.user_roles ur
      JOIN core.roles r ON r.id = ur.role_id
      WHERE ur.user_id = auth.uid()
        AND r.name IN ('CEO', 'FINANCE_HEAD', 'AUDITOR', 'Admin')
        AND ur.effective_from <= now() AND (ur.effective_to IS NULL OR ur.effective_to >= now())
    )
  );

-- Write access stays owner-only — CEO/Auditor can read another user's AI
-- history for oversight, but should never be able to insert/modify it.
CREATE POLICY write_own_conversations ON ai.ai_conversations
  FOR INSERT WITH CHECK (user_id = auth.uid());

CREATE POLICY update_own_conversations ON ai.ai_conversations
  FOR UPDATE USING (user_id = auth.uid());

CREATE POLICY delete_own_conversations ON ai.ai_conversations
  FOR DELETE USING (user_id = auth.uid());

DROP POLICY IF EXISTS users_own_messages ON ai.ai_messages;
DROP POLICY IF EXISTS read_ai_messages ON ai.ai_messages;
DROP POLICY IF EXISTS write_own_messages ON ai.ai_messages;

CREATE POLICY read_ai_messages ON ai.ai_messages
  FOR SELECT USING (
    conversation_id IN (SELECT id FROM ai.ai_conversations WHERE user_id = auth.uid())
    OR EXISTS (
      SELECT 1 FROM core.user_roles ur
      JOIN core.roles r ON r.id = ur.role_id
      WHERE ur.user_id = auth.uid()
        AND r.name IN ('CEO', 'FINANCE_HEAD', 'AUDITOR', 'Admin')
        AND ur.effective_from <= now() AND (ur.effective_to IS NULL OR ur.effective_to >= now())
    )
  );

CREATE POLICY write_own_messages ON ai.ai_messages
  FOR INSERT WITH CHECK (
    conversation_id IN (SELECT id FROM ai.ai_conversations WHERE user_id = auth.uid())
  );

-- -----------------------------------------------------------------------
-- 4. Reseed text_to_sql prompt with {{SCHEMA}} placeholder restored
-- -----------------------------------------------------------------------
UPDATE ai.ai_prompt_versions
SET is_active = false
WHERE prompt_key = 'text_to_sql' AND is_active = true;

INSERT INTO ai.ai_prompt_versions (prompt_key, version, content, checksum, is_active)
SELECT
  'text_to_sql',
  COALESCE((SELECT MAX(version) FROM ai.ai_prompt_versions WHERE prompt_key = 'text_to_sql'), 0) + 1,
  'You are OSYSTIC Finance AI. Generate a SINGLE read-only SELECT query.
Schema: {{SCHEMA}}
CRITICAL RULES:
1. ONLY query tables/views starting with ''reporting.''. NEVER query ''core.'', ''auth.'', ''audit.'', or ''finance.''.
2. NEVER use = for text. Use ILIKE ''%value%''.
3. No semicolons, no comments, no explanations. Return ONLY the SQL string.
4. Always include organization_id = ''{{ORG_ID}}'' in your WHERE clause if the table has it.',
  encode(sha256('text_to_sql_v2_with_schema'::bytea), 'hex'),
  true;

COMMIT;

-- =============================================================================
-- VERIFY AFTER RUNNING:
--
--   SELECT prompt_key, version, is_active, left(content, 60)
--   FROM ai.ai_prompt_versions WHERE prompt_key = 'text_to_sql' ORDER BY version;
--   -- newest version should be is_active = true and contain "Schema: {{SCHEMA}}"
--
--   SELECT polname, tablename FROM pg_policies WHERE schemaname = 'ai'
--   AND tablename IN ('ai_conversations','ai_messages') ORDER BY tablename, polname;
-- =============================================================================