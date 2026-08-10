-- =============================================================================
-- P1_006_ai_schema.sql
-- OSYSTIC Finance Management System — AI Schema
-- Spec Reference: Section 9.9 AI data model and logs
-- =============================================================================

BEGIN;

-- Create ai schema if not exists
CREATE SCHEMA IF NOT EXISTS ai;

-- 1. ai_conversations — Conversation metadata
-- Spec 9.9: user, organization, title, status, created_at
CREATE TABLE IF NOT EXISTS ai.ai_conversations (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES auth.users(id),
  organization_id UUID NOT NULL,
  title         TEXT,
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived','deleted')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 2. ai_messages — User/assistant messages
-- Spec 9.9: conversation, role, content classification, timestamp
CREATE TABLE IF NOT EXISTS ai.ai_messages (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES ai.ai_conversations(id) ON DELETE CASCADE,
  role            TEXT NOT NULL CHECK (role IN ('user','assistant','system')),
  content         TEXT NOT NULL,
  content_type    TEXT NOT NULL DEFAULT 'text' CHECK (content_type IN ('text','json','error')),
  classification  TEXT,  -- e.g. 'finance_qa', 'report_narrative', 'extraction', 'suggestion', 'refused'
  metadata        JSONB DEFAULT '{}',  -- for tool name, confidence, period, currency, filters, warnings, etc.
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 3. ai_tool_calls — Every tool invocation
-- Spec 9.9: tool, inputs hash, permission result, status, latency, model
CREATE TABLE IF NOT EXISTS ai.ai_tool_calls (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id        UUID NOT NULL REFERENCES ai.ai_messages(id),
  conversation_id   UUID NOT NULL REFERENCES ai.ai_conversations(id),
  user_id           UUID NOT NULL,
  organization_id   UUID NOT NULL,
  tool_name         TEXT NOT NULL,
  input_params      JSONB NOT NULL DEFAULT '{}',
  input_hash        TEXT,  -- Spec 9.9: hash of inputs for dedup and integrity
  permission_check  TEXT NOT NULL DEFAULT 'passed' CHECK (permission_check IN ('passed','denied','skipped')),
  user_role         TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'success' CHECK (status IN ('success','error','timeout','blocked')),
  result_rows       INTEGER,
  latency_ms        INTEGER,
  model             TEXT,
  error_message     TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 4. ai_query_audit — SQL/report execution record
-- Spec 9.9: question, SQL/report ID, parameters, row count, timeout, result hash
CREATE TABLE IF NOT EXISTS ai.ai_query_audit (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tool_call_id      UUID REFERENCES ai.ai_tool_calls(id),
  conversation_id   UUID NOT NULL REFERENCES ai.ai_conversations(id),
  user_id           UUID NOT NULL,
  organization_id   UUID NOT NULL,
  question          TEXT NOT NULL,
  normalized_intent TEXT,
  tool_or_report    TEXT,       -- tool name or saved report ID
  sql_or_params     JSONB,      -- generated SQL or report parameters
  row_count         INTEGER,
  timed_out         BOOLEAN NOT NULL DEFAULT FALSE,
  result_hash       TEXT,       -- Spec 9.9: hash of result for integrity
  status            TEXT NOT NULL DEFAULT 'success',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 5. ai_document_extractions — Draft extracted fields
-- Spec 9.9: file, document type, fields JSON, confidence, reviewer
CREATE TABLE IF NOT EXISTS ai.ai_document_extractions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES auth.users(id),
  organization_id UUID NOT NULL,
  file_id         UUID,          -- reference to storage file
  file_name       TEXT NOT NULL,
  document_type   TEXT NOT NULL CHECK (document_type IN ('receipt','invoice','bank_statement','other')),
  extracted_fields JSONB NOT NULL DEFAULT '{}',
  confidence      NUMERIC(5,4),  -- 0.0000 to 1.0000
  reviewer_id     UUID REFERENCES auth.users(id),
  status          TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','accepted','corrected','rejected')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_at     TIMESTAMPTZ
);

-- 6. ai_suggestions — Classification/reconciliation/anomaly suggestions
-- Spec 9.9: entity, suggestion type, confidence, accepted/rejected
CREATE TABLE IF NOT EXISTS ai.ai_suggestions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES auth.users(id),
  organization_id UUID NOT NULL,
  entity_type     TEXT NOT NULL,      -- 'expense', 'invoice', 'bank_line', 'journal', etc.
  entity_id       UUID,               -- reference to the entity
  suggestion_type TEXT NOT NULL,      -- 'account_coding', 'duplicate', 'reconciliation', 'anomaly', 'category'
  suggestion_data JSONB NOT NULL DEFAULT '{}',
  confidence      NUMERIC(5,4),
  reasons         TEXT[],
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','rejected','expired')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at     TIMESTAMPTZ,
  resolved_by     UUID REFERENCES auth.users(id)
);

-- 7. ai_feedback — Human feedback for evaluation
-- Spec 9.9: suggestion/message, rating, correction, reason
-- FIX: Added conversation_id FK reference
CREATE TABLE IF NOT EXISTS ai.ai_feedback (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES auth.users(id),
  organization_id UUID NOT NULL,
  message_id      UUID REFERENCES ai.ai_messages(id),
  conversation_id UUID REFERENCES ai.ai_conversations(id),  -- FIX: FK reference added
  tool_call_id    UUID REFERENCES ai.ai_tool_calls(id),
  feedback_type   TEXT NOT NULL CHECK (feedback_type IN ('message_rating','suggestion_rating','correction','general')),
  rating          INTEGER CHECK (rating BETWEEN 1 AND 5),
  correction      TEXT,
  reason          TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 8. ai_model_registry — Approved provider/model configuration
-- Spec 9.9: model, purpose, version, data policy, enabled
-- Spec 9.11: data_policy must be restricted to approved values
CREATE TABLE IF NOT EXISTS ai.ai_model_registry (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider        TEXT NOT NULL,       -- 'groq', 'openai', 'anthropic', etc.
  model_id        TEXT NOT NULL,       -- 'llama-3.3-70b-versatile', etc.
  display_name    TEXT NOT NULL,
  purpose         TEXT NOT NULL,       -- 'finance_qa', 'extraction', 'classification', 'forecasting'
  version         TEXT,
  data_policy     TEXT NOT NULL DEFAULT 'no_storage' CHECK (data_policy IN ('no_storage','retention_30d','retention_90d')),
  max_tokens      INTEGER DEFAULT 4096,
  temperature     NUMERIC(3,2) DEFAULT 0.1,
  enabled         BOOLEAN NOT NULL DEFAULT TRUE,
  cost_per_1k_tokens NUMERIC(10,6),
  rate_limit_rpm  INTEGER DEFAULT 30,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider, model_id, purpose)
);

-- 9. ai_prompt_versions — Versioned system/tool prompts
-- Spec 9.9: prompt key, version, checksum, approved_by
CREATE TABLE IF NOT EXISTS ai.ai_prompt_versions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  prompt_key      TEXT NOT NULL,       -- 'system_finance_qa', 'tool_selection', 'report_narrative', etc.
  version         INTEGER NOT NULL DEFAULT 1,
  content         TEXT NOT NULL,
  checksum        TEXT NOT NULL,       -- SHA-256 of content
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  approved_by     UUID REFERENCES auth.users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (prompt_key, version)
);

-- 10. ai_user_cost_tracking — Per-user cost tracking (Spec 9.11 cost control)
CREATE TABLE IF NOT EXISTS ai.ai_user_cost_tracking (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES auth.users(id),
  organization_id UUID NOT NULL,
  period_date     DATE NOT NULL,
  request_count   INTEGER NOT NULL DEFAULT 0,
  total_tokens    INTEGER NOT NULL DEFAULT 0,
  estimated_cost  NUMERIC(12,4) NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, organization_id, period_date)
);

-- =============================================================================
-- INDEXES
-- =============================================================================
CREATE INDEX IF NOT EXISTS idx_ai_conversations_user ON ai.ai_conversations(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_conversations_org ON ai.ai_conversations(organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_messages_conversation ON ai.ai_messages(conversation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_ai_tool_calls_user ON ai.ai_tool_calls(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_tool_calls_conv ON ai.ai_tool_calls(conversation_id);
CREATE INDEX IF NOT EXISTS idx_ai_query_audit_user ON ai.ai_query_audit(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_suggestions_entity ON ai.ai_suggestions(entity_type, entity_id, status);
CREATE INDEX IF NOT EXISTS idx_ai_suggestions_user ON ai.ai_suggestions(user_id, status);
CREATE INDEX IF NOT EXISTS idx_ai_feedback_user ON ai.ai_feedback(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_feedback_conv ON ai.ai_feedback(conversation_id);
CREATE INDEX IF NOT EXISTS idx_ai_cost_user_date ON ai.ai_user_cost_tracking(user_id, period_date);

-- =============================================================================
-- RLS POLICIES — Users can only see their own data; auditors see org data
-- =============================================================================
ALTER TABLE ai.ai_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai.ai_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai.ai_tool_calls ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai.ai_query_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai.ai_document_extractions ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai.ai_suggestions ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai.ai_feedback ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai.ai_model_registry ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai.ai_prompt_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai.ai_user_cost_tracking ENABLE ROW LEVEL SECURITY;

-- Users see their own conversations
CREATE POLICY users_own_conversations ON ai.ai_conversations
  FOR ALL USING (user_id = auth.uid());

-- Users see messages in their own conversations
CREATE POLICY users_own_messages ON ai.ai_messages
  FOR ALL USING (
    conversation_id IN (SELECT id FROM ai.ai_conversations WHERE user_id = auth.uid())
  );

-- Users see their own tool calls
CREATE POLICY users_own_tool_calls ON ai.ai_tool_calls
  FOR ALL USING (user_id = auth.uid());

-- Users see their own query audit
CREATE POLICY users_own_query_audit ON ai.ai_query_audit
  FOR ALL USING (user_id = auth.uid());

-- Users see their own document extractions
CREATE POLICY users_own_extractions ON ai.ai_document_extractions
  FOR ALL USING (user_id = auth.uid());

-- Users see their own suggestions
CREATE POLICY users_own_suggestions ON ai.ai_suggestions
  FOR ALL USING (user_id = auth.uid());

-- Users see their own feedback
CREATE POLICY users_own_feedback ON ai.ai_feedback
  FOR ALL USING (user_id = auth.uid());

-- Model registry and prompts: readable by authenticated users, writable by admin
CREATE POLICY authenticated_read_model_registry ON ai.ai_model_registry
  FOR SELECT USING (true);
CREATE POLICY admin_write_model_registry ON ai.ai_model_registry
  FOR ALL USING (
    EXISTS (SELECT 1 FROM core.user_roles ur
            JOIN core.roles r ON r.id = ur.role_id
            WHERE ur.user_id = auth.uid() AND r.name IN ('CEO','Admin','TECHNICAL_ADMIN')
            AND ur.valid_from <= now() AND (ur.valid_to IS NULL OR ur.valid_to >= now()))
  );

CREATE POLICY authenticated_read_prompts ON ai.ai_prompt_versions
  FOR SELECT USING (true);
CREATE POLICY admin_write_prompts ON ai.ai_prompt_versions
  FOR ALL USING (
    EXISTS (SELECT 1 FROM core.user_roles ur
            JOIN core.roles r ON r.id = ur.role_id
            WHERE ur.user_id = auth.uid() AND r.name IN ('CEO','Admin','TECHNICAL_ADMIN')
            AND ur.valid_from <= now() AND (ur.valid_to IS NULL OR ur.valid_to >= now()))
  );

-- Users see their own cost tracking
CREATE POLICY users_own_cost ON ai.ai_user_cost_tracking
  FOR ALL USING (user_id = auth.uid());

-- =============================================================================
-- UPDATED_AT auto-trigger for ai_conversations
-- =============================================================================
CREATE OR REPLACE FUNCTION ai.update_conversation_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_ai_conversations_updated_at ON ai.ai_conversations;
CREATE TRIGGER trg_ai_conversations_updated_at
  BEFORE UPDATE ON ai.ai_conversations
  FOR EACH ROW EXECUTE FUNCTION ai.update_conversation_timestamp();

-- =============================================================================
-- SEED: Default model registry entry (Groq Llama 3.3)
-- =============================================================================
INSERT INTO ai.ai_model_registry (provider, model_id, display_name, purpose, version, max_tokens, temperature, rate_limit_rpm, data_policy)
VALUES
  ('groq', 'llama-3.3-70b-versatile', 'Llama 3.3 70B', 'finance_qa', '1', 4096, 0.1, 30, 'no_storage'),
  ('groq', 'llama-3.3-70b-versatile', 'Llama 3.3 70B', 'report_narrative', '1', 4096, 0.2, 30, 'no_storage'),
  ('groq', 'llama-3.3-70b-versatile', 'Llama 3.3 70B', 'tool_selection', '1', 1024, 0.0, 30, 'no_storage'),
  ('groq', 'llama-3.3-70b-versatile', 'Llama 3.3 70B', 'document_extraction', '1', 4096, 0.1, 10, 'no_storage')
ON CONFLICT (provider, model_id, purpose) DO NOTHING;

COMMIT;