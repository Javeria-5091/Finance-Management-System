-- ═══════════════════════════════════════════════════════════════════════════
-- 01_audit_schema_v1_3_spec.sql   (REVISED — gap-fix pass)
-- Complete audit-log backend, built directly from:
--   Section 8.1  — Required audit event fields (Actor / Event / Time+Source /
--                   Change / Workflow / Evidence / AI)
--   Section 8.2  — Mandatory audited actions
--   Section 8.3  — Tamper resistance, retention, and REQUIRED filters
--                   ("user, entity, action, date, project, amount, approval,
--                    and risk level")
--   Section 9.9  — AI data model / logs (ai_query_audit-equivalent fields)
--   Section 10.4 — Workflow/audit/notification table group
--   Appendix A   — Role and Permission Matrix (Audit logs row)
--
-- CHANGES vs the prior version (fixes applied in this pass):
--   1. Added project_id, amount, amount_currency columns + indexes, because
--      8.3 explicitly requires filtering/export "by ... project, amount ...".
--   2. Added the full 8.1 "AI" field group (question, normalized intent,
--      selected tool, generated SQL/template ID, row count, model, latency,
--      cost/tokens, refusal reason) directly onto audit.audit_log, plus a
--      dedicated audit.log_ai_event() writer function, so AI question/tool/
--      result-access events (8.2) are captured in the same append-only,
--      RLS-protected, hash-chained ledger as every other audited action.
--   3. Expanded the auto-trigger table list to also cover the tables Section
--      8.2 calls out by name: approval_limits, delegations,
--      user_permission_overrides (permission/limit changes), owners /
--      ownership_history / reserve_policies / distribution_policies /
--      distributions (ownership, reserve policy, owner distribution),
--      financial_accounts (bank account / vendor bank-detail change), and
--      compensation_terms / payroll_runs / payroll_lines (salary access).
--      All entries remain conditional on the table existing, so this is safe
--      to run in any phase and will "light up" automatically as later
--      phases create those tables.
--   4. audit.audit_log_report() now accepts p_project_id, p_min_amount,
--      p_max_amount and returns project_id/amount in the row payload, so the
--      8.3 filter set is fully implemented end-to-end (table -> RPC -> view).
--   5. public.v_audit_log extended with the new columns.
--
-- Run AFTER 00_drop_audit_schema.sql, on a database where the audit schema
-- does not yet exist. Assumes core.roles + core.user_roles are the live
-- RBAC tables (confirmed).
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

CREATE SCHEMA IF NOT EXISTS audit;

-- ═══════════════════════════════════════════════════════════════════════════
-- TABLE: audit.audit_log  (Section 8.1)
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE audit.audit_log (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- ── Actor (8.1) ─────────────────────────────────────────────────────
    user_id             UUID,                 -- User ID
    user_name           TEXT,                 -- name snapshot
    user_email          TEXT,                 -- kept for identification/search
    role_snapshot       TEXT,                 -- role snapshot at time of action
    session_id          TEXT,
    auth_method         TEXT,                 -- password / mfa / sso

    -- ── Event (8.1) ─────────────────────────────────────────────────────
    action              TEXT NOT NULL,
    entity_type         TEXT,
    entity_id           UUID,
    status              TEXT NOT NULL DEFAULT 'success'
                          CHECK (status IN ('success', 'denied', 'error')),
    severity            TEXT NOT NULL DEFAULT 'info'
                          CHECK (severity IN ('info', 'low', 'medium', 'high', 'critical')),

    -- ── Time and source (8.1) ───────────────────────────────────────────
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),   -- UTC timestamp (source of truth)
    org_timezone        TEXT,                 -- used by the UI to render "local display time";
                                                -- not stored as a second timestamp to avoid drift
    ip_address          INET,
    user_agent          TEXT,
    request_id          TEXT,

    -- ── Change (8.1) ────────────────────────────────────────────────────
    description         TEXT,
    old_values           JSONB,
    new_values           JSONB,
    changed_columns      TEXT[],
    reason               TEXT,
    approval_comments    TEXT,

    -- ── Workflow (8.1) ──────────────────────────────────────────────────
    previous_status      TEXT,
    new_status           TEXT,
    approval_level       TEXT,
    delegated_authority  TEXT,   -- set when the actor acted under a delegation (Section 7 delegations)
    limit_decision       TEXT,   -- e.g. within_limit / exceeded_limit / escalated

    -- ── Evidence (8.1) ──────────────────────────────────────────────────
    attachment_ids       UUID[],
    import_batch_id       UUID,
    external_ref          TEXT,
    related_journal_id    UUID,
    related_payment_id    UUID,

    -- ── 8.3 required filter dimensions: project + amount ───────────────
    -- Spec 8.3: "Provide filters and exports by user, entity, action, date,
    -- project, amount, approval, and risk level." project_id/amount are
    -- populated either explicitly (audit.log_action / manual callers) or
    -- automatically by the trigger when the audited row carries a
    -- project_id / amount-like column (see audit.trigger_audit_log()).
    project_id            UUID,
    amount                NUMERIC(18,2),
    amount_currency        TEXT,

    -- ── Source classification (trigger-based events) ──────────────────
    source_module         TEXT,     -- e.g. finance, hr, ai, admin
    source_schema          TEXT,    -- schema of the table that changed (trigger events)
    source_table            TEXT,   -- table that changed (trigger events)
    record_id                UUID,  -- alias of entity_id for trigger events (kept for compatibility)
    changed_by                UUID, -- alias of user_id for trigger events (kept for compatibility)

    -- ── Legacy / compatibility fields (kept so existing frontend keeps working) ──
    table_schema         TEXT,
    table_name            TEXT,
    error_message          TEXT,
    source_id                UUID,

    -- ── AI field group (8.1 "AI" row + 9.9 ai_query_audit equivalent) ──
    -- Populated by audit.log_ai_event() for every AI question / tool call /
    -- generated query, per 8.2 ("AI question, generated query/tool, result
    -- access, document extraction, recommendation acceptance/rejection, and
    -- detected policy violation").
    ai_question            TEXT,
    ai_normalized_intent    TEXT,
    ai_selected_tool         TEXT,
    ai_generated_sql          TEXT,
    ai_template_id             TEXT,
    ai_row_count                 INTEGER,
    ai_model                      TEXT,
    ai_latency_ms                    INTEGER,
    ai_cost_usd                         NUMERIC(12,6),
    ai_input_tokens                        INTEGER,
    ai_output_tokens                          INTEGER,
    ai_refusal_reason                            TEXT,

    -- ── Integrity chain (8.3) ───────────────────────────────────────────
    prev_hash              TEXT,
    entry_hash              TEXT
);

COMMENT ON TABLE audit.audit_log IS
  'Append-only audit trail per Spec v1.3 Section 8.1 (incl. AI field group) and 8.3 (incl. project/amount filters). Insert-only from the application; no UPDATE or DELETE path exists for authenticated roles.';

-- Indexes for the required filters: user, entity, action, date, project, amount, approval, severity (8.3)
CREATE INDEX idx_audit_log_created_at   ON audit.audit_log(created_at DESC);
CREATE INDEX idx_audit_log_user_id      ON audit.audit_log(user_id);
CREATE INDEX idx_audit_log_action       ON audit.audit_log(action);
CREATE INDEX idx_audit_log_entity       ON audit.audit_log(entity_type, entity_id);
CREATE INDEX idx_audit_log_status       ON audit.audit_log(status);
CREATE INDEX idx_audit_log_severity     ON audit.audit_log(severity);
CREATE INDEX idx_audit_log_source_module ON audit.audit_log(source_module);
CREATE INDEX idx_audit_log_source_table  ON audit.audit_log(source_schema, source_table);
CREATE INDEX idx_audit_log_request_id    ON audit.audit_log(request_id);
CREATE INDEX idx_audit_log_approval_level ON audit.audit_log(approval_level);
CREATE INDEX idx_audit_log_related_journal ON audit.audit_log(related_journal_id);
CREATE INDEX idx_audit_log_related_payment ON audit.audit_log(related_payment_id);
CREATE INDEX idx_audit_log_project        ON audit.audit_log(project_id);
CREATE INDEX idx_audit_log_amount         ON audit.audit_log(amount);
CREATE INDEX idx_audit_log_ai_tool        ON audit.audit_log(ai_selected_tool);

ALTER TABLE audit.audit_log ENABLE ROW LEVEL SECURITY;

-- ═══════════════════════════════════════════════════════════════════════════
-- RLS — Appendix A, "Audit logs" row:
--   CEO = Full · Finance Head = Full · Accountant = Config (scoped, not full)
--   HOD = Limited · Project Manager = Limited · Employee = Own actions
--   Auditor = Read · Tech Admin = None (security logs only, handled on
--   audit.security_events instead, not here)
--
-- NOTE: "Config" / "Limited" scoping below defaults to each role's own
-- actions until the Phase-1 permission engine (role_permissions, scopes,
-- approval_limits — Section 7.2) is wired in. Replace the ACCOUNTANT /
-- HOD / PROJECT_MANAGER clauses with a proper scope join once those
-- tables exist; this is a safe, spec-compliant interim default (nobody
-- sees more than the spec allows, some may see slightly less until the
-- scope engine is live).
-- ═══════════════════════════════════════════════════════════════════════════

-- CEO + FINANCE_HEAD: full read
CREATE POLICY "audit_log_select_full" ON audit.audit_log
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM core.user_roles ur
      JOIN core.roles r ON r.id = ur.role_id
      WHERE ur.user_id = auth.uid() AND ur.is_active = true
        AND r.name IN ('CEO', 'FINANCE_HEAD')
        AND (ur.effective_to IS NULL OR ur.effective_to >= CURRENT_DATE)
    )
  );

-- AUDITOR: read-only, full scope (per 7.1 "Read-only authorized scope")
CREATE POLICY "audit_log_select_auditor" ON audit.audit_log
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM core.user_roles ur
      JOIN core.roles r ON r.id = ur.role_id
      WHERE ur.user_id = auth.uid() AND ur.is_active = true
        AND r.name = 'AUDITOR'
        AND (ur.effective_to IS NULL OR ur.effective_to >= CURRENT_DATE)
    )
  );

-- ACCOUNTANT: Config (interim = own actions; widen with a scope join later)
CREATE POLICY "audit_log_select_accountant" ON audit.audit_log
  FOR SELECT TO authenticated
  USING (
    user_id = auth.uid()
    AND EXISTS (
      SELECT 1 FROM core.user_roles ur
      JOIN core.roles r ON r.id = ur.role_id
      WHERE ur.user_id = auth.uid() AND ur.is_active = true
        AND r.name = 'ACCOUNTANT'
        AND (ur.effective_to IS NULL OR ur.effective_to >= CURRENT_DATE)
    )
  );

-- HOD + PROJECT_MANAGER: Limited (interim = own actions; widen with
-- department/project scope join later)
CREATE POLICY "audit_log_select_limited" ON audit.audit_log
  FOR SELECT TO authenticated
  USING (
    user_id = auth.uid()
    AND EXISTS (
      SELECT 1 FROM core.user_roles ur
      JOIN core.roles r ON r.id = ur.role_id
      WHERE ur.user_id = auth.uid() AND ur.is_active = true
        AND r.name IN ('HOD', 'PROJECT_MANAGER')
        AND (ur.effective_to IS NULL OR ur.effective_to >= CURRENT_DATE)
    )
  );

-- EMPLOYEE: Own actions only
CREATE POLICY "audit_log_select_own" ON audit.audit_log
  FOR SELECT TO authenticated
  USING (
    user_id = auth.uid()
    AND EXISTS (
      SELECT 1 FROM core.user_roles ur
      JOIN core.roles r ON r.id = ur.role_id
      WHERE ur.user_id = auth.uid() AND ur.is_active = true
        AND r.name = 'EMPLOYEE'
        AND (ur.effective_to IS NULL OR ur.effective_to >= CURRENT_DATE)
    )
  );

-- TECH_ADMIN: no default access to audit.audit_log (Appendix A: audit logs
-- = "Security logs only" for Tech Admin — that means audit.security_events,
-- not this table; deliberately no policy is created for Tech Admin here).

-- INSERT: restricted, insert-only per 8.3 ("restricted insert-only service
-- access"). Self-insert only — the normal path is via SECURITY DEFINER
-- functions below; this is the fallback safety net for direct inserts.
CREATE POLICY "audit_log_insert" ON audit.audit_log
  FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id OR auth.uid() = changed_by);

-- No UPDATE, no DELETE for any authenticated role — append-only (8.3)
CREATE POLICY "audit_log_no_update" ON audit.audit_log
  FOR UPDATE TO authenticated USING (false);
CREATE POLICY "audit_log_no_delete" ON audit.audit_log
  FOR DELETE TO authenticated USING (false);

-- service_role: full access (backend jobs, migrations, exports)
CREATE POLICY "audit_log_service_all" ON audit.audit_log
  FOR ALL TO service_role USING (true) WITH CHECK (true);

GRANT USAGE ON SCHEMA audit TO authenticated;
GRANT SELECT, INSERT ON audit.audit_log TO authenticated;
REVOKE UPDATE, DELETE ON audit.audit_log FROM authenticated;
GRANT ALL ON audit.audit_log TO service_role;

-- ═══════════════════════════════════════════════════════════════════════════
-- TABLE: audit.security_events  (10.4 + 8.2 login/MFA/session events)
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE audit.security_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID,
  user_email TEXT,
  event_type TEXT NOT NULL CHECK (event_type IN (
    'LOGIN_SUCCESS', 'LOGIN_FAILURE', 'MFA_ENABLED', 'MFA_DISABLED',
    'MFA_VERIFICATION_SUCCESS', 'MFA_VERIFICATION_FAILURE',
    'PASSWORD_RESET_REQUEST', 'PASSWORD_RESET_SUCCESS', 'PASSWORD_RESET_FAILURE',
    'SESSION_TERMINATED', 'SUSPICIOUS_ACCESS', 'LOCKOUT',
    'PERMISSION_CHANGE', 'ROLE_CHANGE', 'DATA_SCOPE_CHANGE', 'NEW_DEVICE'
  )),
  ip_address INET,
  user_agent TEXT,
  details JSONB,
  success BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  request_id TEXT
);

CREATE INDEX idx_security_events_user ON audit.security_events(user_id, created_at DESC);
CREATE INDEX idx_security_events_type ON audit.security_events(event_type, created_at DESC);

ALTER TABLE audit.security_events ENABLE ROW LEVEL SECURITY;

-- Appendix A: Tech Admin gets "Security logs only" — this is that table.
CREATE POLICY "sec_events_select" ON audit.security_events
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM core.user_roles ur
      JOIN core.roles r ON r.id = ur.role_id
      WHERE ur.user_id = auth.uid() AND ur.is_active = true
        AND r.name IN ('CEO', 'FINANCE_HEAD', 'AUDITOR', 'TECH_ADMIN')
        AND (ur.effective_to IS NULL OR ur.effective_to >= CURRENT_DATE)
    )
  );

CREATE POLICY "sec_events_insert" ON audit.security_events
  FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "sec_events_no_update" ON audit.security_events FOR UPDATE TO authenticated USING (false);
CREATE POLICY "sec_events_no_delete" ON audit.security_events FOR DELETE TO authenticated USING (false);
CREATE POLICY "sec_events_service_all" ON audit.security_events FOR ALL TO service_role USING (true) WITH CHECK (true);

GRANT SELECT, INSERT ON audit.security_events TO authenticated;
REVOKE UPDATE, DELETE ON audit.security_events FROM authenticated;
GRANT ALL ON audit.security_events TO service_role;

-- ═══════════════════════════════════════════════════════════════════════════
-- TABLE: audit.export_events  (10.4 + 8.2 export/print/download + 13.3
-- "Exports require explicit permission and are logged with filters, row
-- count, file type, and recipient/download user")
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE audit.export_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID,
  user_email TEXT,
  user_name TEXT,
  report_name TEXT NOT NULL,
  report_type TEXT,
  format TEXT DEFAULT 'csv' CHECK (format IN ('csv', 'pdf', 'xlsx', 'json')),
  filters JSONB,
  row_count INTEGER,
  file_size_bytes INTEGER,
  ip_address INET,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  request_id TEXT
);

CREATE INDEX idx_export_events_user ON audit.export_events(user_id, created_at DESC);

ALTER TABLE audit.export_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "export_events_select" ON audit.export_events
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM core.user_roles ur
      JOIN core.roles r ON r.id = ur.role_id
      WHERE ur.user_id = auth.uid() AND ur.is_active = true
        AND r.name IN ('CEO', 'FINANCE_HEAD', 'AUDITOR')
        AND (ur.effective_to IS NULL OR ur.effective_to >= CURRENT_DATE)
    )
    OR user_id = auth.uid()
  );

CREATE POLICY "export_events_insert" ON audit.export_events
  FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "export_events_no_update" ON audit.export_events FOR UPDATE TO authenticated USING (false);
CREATE POLICY "export_events_no_delete" ON audit.export_events FOR DELETE TO authenticated USING (false);
CREATE POLICY "export_events_service_all" ON audit.export_events FOR ALL TO service_role USING (true) WITH CHECK (true);

GRANT SELECT, INSERT ON audit.export_events TO authenticated;
REVOKE UPDATE, DELETE ON audit.export_events FROM authenticated;
GRANT ALL ON audit.export_events TO service_role;

-- ═══════════════════════════════════════════════════════════════════════════
-- TABLE: audit.data_access_events  (10.4 + 8.2 "print, download" +
-- 5.14 attachment access accountability)
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE audit.data_access_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID,
  user_email TEXT,
  accessed_entity_type TEXT NOT NULL,
  accessed_entity_id UUID,
  access_type TEXT DEFAULT 'read' CHECK (access_type IN ('read', 'export', 'print', 'download')),
  access_granted BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  request_id TEXT
);

CREATE INDEX idx_data_access_user ON audit.data_access_events(user_id, created_at DESC);
CREATE INDEX idx_data_access_entity ON audit.data_access_events(accessed_entity_type, accessed_entity_id);

ALTER TABLE audit.data_access_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "data_access_select" ON audit.data_access_events
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM core.user_roles ur
      JOIN core.roles r ON r.id = ur.role_id
      WHERE ur.user_id = auth.uid() AND ur.is_active = true
        AND r.name IN ('CEO', 'FINANCE_HEAD', 'AUDITOR')
        AND (ur.effective_to IS NULL OR ur.effective_to >= CURRENT_DATE)
    )
  );

CREATE POLICY "data_access_insert" ON audit.data_access_events
  FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "data_access_no_update" ON audit.data_access_events FOR UPDATE TO authenticated USING (false);
CREATE POLICY "data_access_no_delete" ON audit.data_access_events FOR DELETE TO authenticated USING (false);
CREATE POLICY "data_access_service_all" ON audit.data_access_events FOR ALL TO service_role USING (true) WITH CHECK (true);

GRANT SELECT, INSERT ON audit.data_access_events TO authenticated;
REVOKE UPDATE, DELETE ON audit.data_access_events FROM authenticated;
GRANT ALL ON audit.data_access_events TO service_role;

-- ═══════════════════════════════════════════════════════════════════════════
-- FUNCTION: audit.log_action() — manual/API logging path (all 8.1 fields,
-- including project_id / amount / amount_currency for 8.3 filtering)
-- ═══════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION audit.log_action(
    p_user_id UUID,
    p_user_email TEXT DEFAULT NULL,
    p_user_name TEXT DEFAULT NULL,
    p_action TEXT DEFAULT NULL,
    p_entity_type TEXT DEFAULT NULL,
    p_entity_id UUID DEFAULT NULL,
    p_description TEXT DEFAULT '',
    p_old_values JSONB DEFAULT NULL,
    p_new_values JSONB DEFAULT NULL,
    p_ip_address INET DEFAULT NULL,
    p_user_agent TEXT DEFAULT NULL,
    p_status TEXT DEFAULT 'success',
    p_error_message TEXT DEFAULT NULL,
    p_severity TEXT DEFAULT 'info',
    p_reason TEXT DEFAULT NULL,
    p_source_module TEXT DEFAULT NULL,
    p_request_id TEXT DEFAULT NULL,
    p_previous_status TEXT DEFAULT NULL,
    p_new_status TEXT DEFAULT NULL,
    p_approval_level TEXT DEFAULT NULL,
    p_approval_comments TEXT DEFAULT NULL,
    p_delegated_authority TEXT DEFAULT NULL,
    p_limit_decision TEXT DEFAULT NULL,
    p_session_id TEXT DEFAULT NULL,
    p_auth_method TEXT DEFAULT NULL,
    p_attachment_ids UUID[] DEFAULT NULL,
    p_import_batch_id UUID DEFAULT NULL,
    p_external_ref TEXT DEFAULT NULL,
    p_related_journal_id UUID DEFAULT NULL,
    p_related_payment_id UUID DEFAULT NULL,
    p_project_id UUID DEFAULT NULL,
    p_amount NUMERIC DEFAULT NULL,
    p_amount_currency TEXT DEFAULT NULL
)
RETURNS UUID AS $$
DECLARE
  v_id UUID;
  v_role TEXT;
  v_prev_hash TEXT;
  v_hash TEXT;
BEGIN
  SELECT r.name INTO v_role
  FROM core.user_roles ur
  JOIN core.roles r ON r.id = ur.role_id
  WHERE ur.user_id = p_user_id AND ur.is_active = true
    AND (ur.effective_to IS NULL OR ur.effective_to >= CURRENT_DATE)
  ORDER BY ur.effective_from DESC LIMIT 1;

  -- Integrity chain (8.3): link to the hash of the most recent entry
  SELECT entry_hash INTO v_prev_hash
  FROM audit.audit_log ORDER BY created_at DESC, id DESC LIMIT 1;

  v_hash := encode(
    sha256(
      COALESCE(v_prev_hash, '') ||
      COALESCE(p_user_id::TEXT, '') || COALESCE(p_action, '') ||
      COALESCE(p_entity_type, '') || COALESCE(p_entity_id::TEXT, '') ||
      COALESCE(p_description, '') || COALESCE(p_severity, 'info') || NOW()::TEXT
    ), 'hex'
  );

  INSERT INTO audit.audit_log (
    user_id, user_email, user_name, role_snapshot, session_id, auth_method,
    action, entity_type, entity_id, status, severity,
    ip_address, user_agent, request_id,
    description, old_values, new_values, reason, approval_comments,
    previous_status, new_status, approval_level, delegated_authority, limit_decision,
    attachment_ids, import_batch_id, external_ref, related_journal_id, related_payment_id,
    project_id, amount, amount_currency,
    source_module, error_message, prev_hash, entry_hash
  ) VALUES (
    p_user_id, p_user_email, p_user_name, v_role, p_session_id, p_auth_method,
    p_action, p_entity_type, p_entity_id, p_status, p_severity,
    p_ip_address, p_user_agent, p_request_id,
    p_description, p_old_values, p_new_values, p_reason, p_approval_comments,
    p_previous_status, p_new_status, p_approval_level, p_delegated_authority, p_limit_decision,
    p_attachment_ids, p_import_batch_id, p_external_ref, p_related_journal_id, p_related_payment_id,
    p_project_id, p_amount, p_amount_currency,
    p_source_module, p_error_message, v_prev_hash, v_hash
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION audit.log_action TO authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- FUNCTION: audit.log_security_event()
-- ═══════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION audit.log_security_event(
  p_user_id UUID DEFAULT NULL,
  p_user_email TEXT DEFAULT NULL,
  p_event_type TEXT DEFAULT NULL,
  p_success BOOLEAN DEFAULT true,
  p_details JSONB DEFAULT NULL,
  p_request_id TEXT DEFAULT NULL
)
RETURNS UUID AS $$
DECLARE
  v_id UUID;
BEGIN
  INSERT INTO audit.security_events (
    user_id, user_email, event_type, ip_address, user_agent, details, success, request_id
  ) VALUES (
    p_user_id, p_user_email, p_event_type,
    inet_client_addr(), current_setting('request.header.user-agent', true),
    p_details, p_success, p_request_id
  ) RETURNING id INTO v_id;
  RETURN v_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION audit.log_security_event TO authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- FUNCTION: audit.log_export_event()
-- ═══════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION audit.log_export_event(
  p_user_id UUID DEFAULT NULL,
  p_user_email TEXT DEFAULT NULL,
  p_user_name TEXT DEFAULT NULL,
  p_report_name TEXT DEFAULT NULL,
  p_report_type TEXT DEFAULT NULL,
  p_format TEXT DEFAULT 'csv',
  p_filters JSONB DEFAULT NULL,
  p_row_count INTEGER DEFAULT NULL,
  p_file_size_bytes INTEGER DEFAULT NULL
)
RETURNS UUID AS $$
DECLARE
  v_id UUID;
BEGIN
  INSERT INTO audit.export_events (
    user_id, user_email, user_name, report_name, report_type,
    format, filters, row_count, file_size_bytes, ip_address
  ) VALUES (
    p_user_id, p_user_email, p_user_name, p_report_name, p_report_type,
    p_format, p_filters, p_row_count, p_file_size_bytes, inet_client_addr()
  ) RETURNING id INTO v_id;
  RETURN v_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION audit.log_export_event TO authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- FUNCTION: audit.log_data_access_event() — covers 8.2 "print, download"
-- and attachment/report view accountability (5.14, 13.3)
-- ═══════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION audit.log_data_access_event(
  p_user_id UUID DEFAULT NULL,
  p_user_email TEXT DEFAULT NULL,
  p_accessed_entity_type TEXT DEFAULT NULL,
  p_accessed_entity_id UUID DEFAULT NULL,
  p_access_type TEXT DEFAULT 'read',
  p_access_granted BOOLEAN DEFAULT true,
  p_request_id TEXT DEFAULT NULL
)
RETURNS UUID AS $$
DECLARE
  v_id UUID;
BEGIN
  INSERT INTO audit.data_access_events (
    user_id, user_email, accessed_entity_type, accessed_entity_id,
    access_type, access_granted, request_id
  ) VALUES (
    p_user_id, p_user_email, p_accessed_entity_type, p_accessed_entity_id,
    p_access_type, p_access_granted, p_request_id
  ) RETURNING id INTO v_id;
  RETURN v_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION audit.log_data_access_event TO authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- FUNCTION: audit.log_ai_event()  [NEW — fills Section 8.1 "AI" field group
-- and Section 8.2 "AI question, generated query/tool, result access,
-- document extraction, recommendation acceptance/rejection, and detected
-- policy violation"]
--
-- Called by the AI gateway (Section 9.3/9.5) after every AI question, tool
-- call, or Text-to-SQL execution — success, refusal, or error alike — so
-- the same append-only, hash-chained, RLS-protected ledger used for every
-- other financial action also captures AI activity, per 8.1/8.2/9.5
-- ("Log the original question, normalized intent, generated SQL or
-- saved-report ID, parameters, result metadata, and final answer").
-- ═══════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION audit.log_ai_event(
  p_user_id UUID,
  p_user_email TEXT DEFAULT NULL,
  p_user_name TEXT DEFAULT NULL,
  p_action TEXT DEFAULT 'AI_QUERY',              -- e.g. AI_QUERY, AI_TOOL_CALL, AI_EXTRACTION,
                                                   -- AI_SUGGESTION_ACCEPTED, AI_SUGGESTION_REJECTED,
                                                   -- AI_POLICY_VIOLATION_DETECTED
  p_status TEXT DEFAULT 'success',                -- success / denied / error (refusals => 'denied')
  p_severity TEXT DEFAULT 'info',
  p_entity_type TEXT DEFAULT NULL,
  p_entity_id UUID DEFAULT NULL,
  p_project_id UUID DEFAULT NULL,
  p_ai_question TEXT DEFAULT NULL,
  p_ai_normalized_intent TEXT DEFAULT NULL,
  p_ai_selected_tool TEXT DEFAULT NULL,
  p_ai_generated_sql TEXT DEFAULT NULL,
  p_ai_template_id TEXT DEFAULT NULL,
  p_ai_row_count INTEGER DEFAULT NULL,
  p_ai_model TEXT DEFAULT NULL,
  p_ai_latency_ms INTEGER DEFAULT NULL,
  p_ai_cost_usd NUMERIC DEFAULT NULL,
  p_ai_input_tokens INTEGER DEFAULT NULL,
  p_ai_output_tokens INTEGER DEFAULT NULL,
  p_ai_refusal_reason TEXT DEFAULT NULL,
  p_request_id TEXT DEFAULT NULL,
  p_ip_address INET DEFAULT NULL,
  p_user_agent TEXT DEFAULT NULL
)
RETURNS UUID AS $$
DECLARE
  v_id UUID;
  v_role TEXT;
  v_prev_hash TEXT;
  v_hash TEXT;
BEGIN
  SELECT r.name INTO v_role
  FROM core.user_roles ur
  JOIN core.roles r ON r.id = ur.role_id
  WHERE ur.user_id = p_user_id AND ur.is_active = true
    AND (ur.effective_to IS NULL OR ur.effective_to >= CURRENT_DATE)
  ORDER BY ur.effective_from DESC LIMIT 1;

  SELECT entry_hash INTO v_prev_hash
  FROM audit.audit_log ORDER BY created_at DESC, id DESC LIMIT 1;

  v_hash := encode(
    sha256(
      COALESCE(v_prev_hash, '') ||
      COALESCE(p_user_id::TEXT, '') || COALESCE(p_action, '') ||
      COALESCE(p_ai_question, '') || COALESCE(p_ai_selected_tool, '') ||
      COALESCE(p_ai_generated_sql, '') || NOW()::TEXT
    ), 'hex'
  );

  INSERT INTO audit.audit_log (
    user_id, user_email, user_name, role_snapshot,
    action, entity_type, entity_id, status, severity,
    project_id, request_id, ip_address, user_agent,
    source_module,
    ai_question, ai_normalized_intent, ai_selected_tool, ai_generated_sql,
    ai_template_id, ai_row_count, ai_model, ai_latency_ms, ai_cost_usd,
    ai_input_tokens, ai_output_tokens, ai_refusal_reason,
    prev_hash, entry_hash
  ) VALUES (
    p_user_id, p_user_email, p_user_name, v_role,
    p_action, p_entity_type, p_entity_id, p_status, p_severity,
    p_project_id, p_request_id, p_ip_address, p_user_agent,
    'ai',
    p_ai_question, p_ai_normalized_intent, p_ai_selected_tool, p_ai_generated_sql,
    p_ai_template_id, p_ai_row_count, p_ai_model, p_ai_latency_ms, p_ai_cost_usd,
    p_ai_input_tokens, p_ai_output_tokens, p_ai_refusal_reason,
    v_prev_hash, v_hash
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION audit.log_ai_event TO authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- TRIGGER FUNCTION: audit.trigger_audit_log() — automatic DB-level logging
-- for every table it's attached to (INSERT/UPDATE/DELETE).
-- Also opportunistically extracts project_id and an amount-like column
-- (amount / total_amount / gross_amount) from the changed row, so that
-- trigger-generated events participate in the 8.3 project/amount filters
-- without every audited table needing a bespoke trigger.
-- ═══════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION audit.trigger_audit_log()
RETURNS TRIGGER AS $$
DECLARE
    v_old JSONB;
    v_new JSONB;
    v_columns TEXT[] := ARRAY[]::TEXT[];
    v_action TEXT;
    v_user_id UUID;
    v_user_email TEXT;
    v_user_name TEXT;
    v_role TEXT;
    v_key TEXT;
    v_prev_hash TEXT;
    v_hash TEXT;
    v_row JSONB;
    v_project_id UUID;
    v_amount NUMERIC;
    v_amount_currency TEXT;
BEGIN
    v_action := TG_OP;

    v_user_id := COALESCE(
        auth.uid(),
        NULLIF(current_setting('request.jwt.claims.sub', true), '')::UUID,
        NULLIF(current_setting('app.current_user_id', true), '')::UUID,
        NULL
    );

    IF v_user_id IS NOT NULL THEN
        SELECT email, full_name INTO v_user_email, v_user_name
        FROM public.profiles WHERE id = v_user_id;

        SELECT r.name INTO v_role
        FROM core.user_roles ur
        JOIN core.roles r ON r.id = ur.role_id
        WHERE ur.user_id = v_user_id AND ur.is_active = true
          AND (ur.effective_to IS NULL OR ur.effective_to >= CURRENT_DATE)
        ORDER BY ur.effective_from DESC LIMIT 1;
    END IF;

    IF TG_OP = 'INSERT' THEN
        v_new := to_jsonb(NEW);
        v_old := NULL;
        v_columns := NULL;
        v_row := v_new;
    ELSIF TG_OP = 'UPDATE' THEN
        v_old := to_jsonb(OLD);
        v_new := to_jsonb(NEW);
        v_row := v_new;

        FOR v_key IN
            SELECT k FROM (
                SELECT jsonb_object_keys(v_new) AS k
                UNION
                SELECT jsonb_object_keys(v_old) AS k
            ) all_keys
        LOOP
            IF v_old ->> v_key IS DISTINCT FROM v_new ->> v_key THEN
                v_columns := array_append(v_columns, v_key);
            END IF;
        END LOOP;

        IF array_length(v_columns, 1) IS NULL THEN
            RETURN NEW;
        END IF;

        IF v_old ? 'status' AND v_new ? 'status' AND v_old->>'status' != v_new->>'status' THEN
            v_action := 'STATUS_CHANGE';
        END IF;
    ELSIF TG_OP = 'DELETE' THEN
        v_old := to_jsonb(OLD);
        v_new := NULL;
        v_columns := NULL;
        v_row := v_old;
    END IF;

    -- Opportunistic 8.3 filter-field extraction: project_id + first
    -- available amount-like column. Silently skipped if the table has
    -- neither (e.g. roles, permissions) — those events still audit fine
    -- without project/amount values.
    BEGIN
        IF v_row ? 'project_id' THEN
            v_project_id := NULLIF(v_row->>'project_id','')::UUID;
        END IF;
    EXCEPTION WHEN OTHERS THEN v_project_id := NULL;
    END;

    BEGIN
        IF v_row ? 'amount' THEN
            v_amount := NULLIF(v_row->>'amount','')::NUMERIC;
        ELSIF v_row ? 'total_amount' THEN
            v_amount := NULLIF(v_row->>'total_amount','')::NUMERIC;
        ELSIF v_row ? 'gross_amount' THEN
            v_amount := NULLIF(v_row->>'gross_amount','')::NUMERIC;
        ELSIF v_row ? 'base_amount' THEN
            v_amount := NULLIF(v_row->>'base_amount','')::NUMERIC;
        END IF;
    EXCEPTION WHEN OTHERS THEN v_amount := NULL;
    END;

    IF v_row ? 'currency' THEN
        v_amount_currency := v_row->>'currency';
    END IF;

    SELECT entry_hash INTO v_prev_hash
    FROM audit.audit_log ORDER BY created_at DESC, id DESC LIMIT 1;

    v_hash := encode(sha256(
        COALESCE(v_prev_hash, '') ||
        COALESCE(v_user_id::TEXT, '') || TG_OP || TG_TABLE_NAME ||
        COALESCE(NEW.id::TEXT, OLD.id::TEXT, '') || NOW()::TEXT
    ), 'hex');

    INSERT INTO audit.audit_log (
        user_id, user_email, user_name, role_snapshot,
        action, entity_type, entity_id, status, severity,
        description, old_values, new_values, changed_columns,
        previous_status, new_status,
        project_id, amount, amount_currency,
        ip_address, user_agent,
        source_module, source_schema, source_table,
        table_schema, table_name, record_id, changed_by,
        prev_hash, entry_hash
    ) VALUES (
        v_user_id, v_user_email, v_user_name, v_role,
        v_action, TG_TABLE_NAME, COALESCE(NEW.id, OLD.id), 'success', 'info',
        TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME || ' ' || v_action,
        v_old, v_new, v_columns,
        CASE WHEN TG_OP = 'UPDATE' THEN v_old->>'status' END,
        CASE WHEN TG_OP = 'UPDATE' THEN v_new->>'status' END,
        v_project_id, v_amount, v_amount_currency,
        inet_client_addr(),
        current_setting('request.header.user-agent', true),
        TG_TABLE_SCHEMA, TG_TABLE_SCHEMA, TG_TABLE_NAME,
        TG_TABLE_SCHEMA, TG_TABLE_NAME, COALESCE(NEW.id, OLD.id), v_user_id,
        v_prev_hash, v_hash
    );

    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ═══════════════════════════════════════════════════════════════════════════
-- Attach triggers to every table Section 8.2/10.5/10.6 implies must be
-- audited (all conditional on the table actually existing in this
-- database, so this is safe to (re)run at any phase). Expanded in this
-- pass to explicitly include the tables Section 8.2 names by category:
--   - "Role, permission, amount limit, data scope, ownership, reserve
--      policy, exchange-rate source, and accounting configuration changes"
--   - "bank account change, vendor bank-detail change, salary access, and
--      owner distribution"
-- ═══════════════════════════════════════════════════════════════════════════
DO $$
DECLARE
  v_tables TEXT[][] := ARRAY[
    -- Accounting core (8.2: accounting configuration changes)
    ['finance','fiscal_years'], ['finance','accounting_periods'], ['finance','chart_of_accounts'],
    ['finance','journal_entries'], ['finance','journal_lines'],
    ['core','organization_config'], ['core','permissions'], ['core','roles'],
    ['core','role_permissions'], ['core','user_roles'],

    -- Receivables / payables / FX
    ['finance','payment_receipts'], ['finance','payment_allocations'], ['finance','credit_notes'],
    ['finance','exchange_rates'],
    ['finance','vendor_bills'], ['finance','vendor_bill_lines'], ['finance','vendor_payments'],
    ['finance','vendor_payment_allocations'],
    ['finance','bank_transfers'],

    -- Tax
    ['finance','tax_rule_sets'], ['finance','tax_slabs'], ['finance','tax_reconciliations'],
    ['finance','tax_adjustments'], ['finance','taxpayer_profile'],

    -- Operational
    ['public','expenses'], ['public','incomes'], ['public','invoices'], ['public','projects'],
    ['public','clients'], ['public','vendors'], ['public','budgets'],

    -- [NEW] Permission / amount-limit / scope / delegation changes (8.2)
    ['core','approval_limits'], ['core','delegations'], ['core','user_permission_overrides'],

    -- [NEW] Financial accounts — "bank account change, vendor bank-detail
    -- change" (8.2)
    ['finance','financial_accounts'],

    -- [NEW] Ownership, reserve policy, owner distribution (8.2 / 5.13)
    ['finance','owners'], ['finance','ownership_history'], ['finance','reserve_policies'],
    ['finance','distribution_policies'], ['finance','distributions'], ['finance','distribution_lines'],
    ['finance','capital_events'],

    -- [NEW] Payroll / salary access (8.2 "salary access")
    ['finance','compensation_terms'], ['finance','payroll_runs'], ['finance','payroll_lines'],
    ['finance','commissions'], ['finance','advances']
  ];
  v_pair TEXT[];
  v_trigger_name TEXT;
  v_attached_count INTEGER := 0;
  v_skipped_count INTEGER := 0;
BEGIN
  FOREACH v_pair SLICE 1 IN ARRAY v_tables LOOP
    IF EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = v_pair[1] AND table_name = v_pair[2]
    ) THEN
      v_trigger_name := left(v_pair[2], 20) || '_audit';
      EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I.%I', v_trigger_name, v_pair[1], v_pair[2]);
      EXECUTE format(
        'CREATE TRIGGER %I AFTER INSERT OR UPDATE OR DELETE ON %I.%I FOR EACH ROW EXECUTE FUNCTION audit.trigger_audit_log()',
        v_trigger_name, v_pair[1], v_pair[2]
      );
      v_attached_count := v_attached_count + 1;
    ELSE
      v_skipped_count := v_skipped_count + 1;
    END IF;
  END LOOP;

  RAISE NOTICE 'Audit triggers attached to % existing table(s); % table(s) in the list do not exist yet and were skipped (they will pick up auditing automatically once created and this script is re-run)', v_attached_count, v_skipped_count;
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- RPC: audit.audit_log_report — filters per 8.3 ("filters and exports by
-- user, entity, action, date, project, amount, approval, and risk level").
-- Now includes p_project_id, p_min_amount, p_max_amount (closing the
-- previously-missing project/amount filter gap) and returns those fields.
-- "risk level" is served by p_severity (info/low/medium/high/critical).
-- ═══════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION audit.audit_log_report(
  p_start TIMESTAMPTZ DEFAULT NULL,
  p_end TIMESTAMPTZ DEFAULT NULL,
  p_user_id UUID DEFAULT NULL,
  p_action TEXT DEFAULT NULL,
  p_entity_type TEXT DEFAULT NULL,
  p_severity TEXT DEFAULT NULL,
  p_approval_level TEXT DEFAULT NULL,
  p_source_module TEXT DEFAULT NULL,
  p_project_id UUID DEFAULT NULL,
  p_min_amount NUMERIC DEFAULT NULL,
  p_max_amount NUMERIC DEFAULT NULL,
  p_page INTEGER DEFAULT 1,
  p_page_size INTEGER DEFAULT 50
)
RETURNS JSON AS $$
DECLARE
  v_offset INTEGER := GREATEST(p_page - 1, 0) * p_page_size;
  v_rows JSONB := '[]'::JSONB;
  v_total INTEGER := 0;
BEGIN
  SELECT COUNT(*) INTO v_total
  FROM audit.audit_log al
  WHERE (p_start IS NULL OR al.created_at >= p_start)
    AND (p_end IS NULL OR al.created_at <= p_end)
    AND (p_user_id IS NULL OR al.user_id = p_user_id)
    AND (p_action IS NULL OR al.action ILIKE '%' || p_action || '%')
    AND (p_entity_type IS NULL OR al.entity_type ILIKE '%' || p_entity_type || '%')
    AND (p_severity IS NULL OR al.severity = p_severity)
    AND (p_approval_level IS NULL OR al.approval_level = p_approval_level)
    AND (p_source_module IS NULL OR al.source_module = p_source_module)
    AND (p_project_id IS NULL OR al.project_id = p_project_id)
    AND (p_min_amount IS NULL OR al.amount >= p_min_amount)
    AND (p_max_amount IS NULL OR al.amount <= p_max_amount);

  SELECT jsonb_agg(
    jsonb_build_object(
      'id', al.id::TEXT,
      'timestamp', al.created_at::TEXT,
      'user_id', al.user_id::TEXT,
      'user_email', COALESCE(al.user_email, ''),
      'user_name', COALESCE(al.user_name, ''),
      'role_snapshot', COALESCE(al.role_snapshot, ''),
      'action', al.action,
      'entity_type', COALESCE(al.entity_type, ''),
      'entity_id', COALESCE(al.entity_id::TEXT, ''),
      'description', COALESCE(al.description, ''),
      'status', al.status,
      'severity', al.severity,
      'reason', COALESCE(al.reason, ''),
      'approval_level', COALESCE(al.approval_level, ''),
      'source_module', COALESCE(al.source_module, ''),
      'project_id', COALESCE(al.project_id::TEXT, ''),
      'amount', al.amount,
      'amount_currency', COALESCE(al.amount_currency, ''),
      'ip_address', COALESCE(al.ip_address::TEXT, '')
    )
    ORDER BY al.created_at DESC
  ) INTO v_rows
  FROM audit.audit_log al
  WHERE (p_start IS NULL OR al.created_at >= p_start)
    AND (p_end IS NULL OR al.created_at <= p_end)
    AND (p_user_id IS NULL OR al.user_id = p_user_id)
    AND (p_action IS NULL OR al.action ILIKE '%' || p_action || '%')
    AND (p_entity_type IS NULL OR al.entity_type ILIKE '%' || p_entity_type || '%')
    AND (p_severity IS NULL OR al.severity = p_severity)
    AND (p_approval_level IS NULL OR al.approval_level = p_approval_level)
    AND (p_source_module IS NULL OR al.source_module = p_source_module)
    AND (p_project_id IS NULL OR al.project_id = p_project_id)
    AND (p_min_amount IS NULL OR al.amount >= p_min_amount)
    AND (p_max_amount IS NULL OR al.amount <= p_max_amount)
  ORDER BY al.created_at DESC
  LIMIT p_page_size OFFSET v_offset;

  RETURN jsonb_build_object('rows', COALESCE(v_rows, '[]'::JSONB), 'total_count', v_total);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE;

GRANT EXECUTE ON FUNCTION audit.audit_log_report TO authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- RPC: audit.ai_audit_report — dedicated AI-activity report so the AI
-- gateway / AI-activity dashboard (Section 13.2 "Controls" report:
-- "audit trail, access review, AI activity and cost") can query the AI
-- field group without pulling unrelated non-AI rows.
-- ═══════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION audit.ai_audit_report(
  p_start TIMESTAMPTZ DEFAULT NULL,
  p_end TIMESTAMPTZ DEFAULT NULL,
  p_user_id UUID DEFAULT NULL,
  p_tool TEXT DEFAULT NULL,
  p_status TEXT DEFAULT NULL,
  p_page INTEGER DEFAULT 1,
  p_page_size INTEGER DEFAULT 50
)
RETURNS JSON AS $$
DECLARE
  v_offset INTEGER := GREATEST(p_page - 1, 0) * p_page_size;
  v_rows JSONB := '[]'::JSONB;
  v_total INTEGER := 0;
BEGIN
  SELECT COUNT(*) INTO v_total
  FROM audit.audit_log al
  WHERE al.source_module = 'ai'
    AND (p_start IS NULL OR al.created_at >= p_start)
    AND (p_end IS NULL OR al.created_at <= p_end)
    AND (p_user_id IS NULL OR al.user_id = p_user_id)
    AND (p_tool IS NULL OR al.ai_selected_tool = p_tool)
    AND (p_status IS NULL OR al.status = p_status);

  SELECT jsonb_agg(
    jsonb_build_object(
      'id', al.id::TEXT,
      'timestamp', al.created_at::TEXT,
      'user_id', al.user_id::TEXT,
      'user_email', COALESCE(al.user_email, ''),
      'action', al.action,
      'status', al.status,
      'question', COALESCE(al.ai_question, ''),
      'normalized_intent', COALESCE(al.ai_normalized_intent, ''),
      'selected_tool', COALESCE(al.ai_selected_tool, ''),
      'template_id', COALESCE(al.ai_template_id, ''),
      'row_count', al.ai_row_count,
      'model', COALESCE(al.ai_model, ''),
      'latency_ms', al.ai_latency_ms,
      'cost_usd', al.ai_cost_usd,
      'input_tokens', al.ai_input_tokens,
      'output_tokens', al.ai_output_tokens,
      'refusal_reason', COALESCE(al.ai_refusal_reason, '')
    )
    ORDER BY al.created_at DESC
  ) INTO v_rows
  FROM audit.audit_log al
  WHERE al.source_module = 'ai'
    AND (p_start IS NULL OR al.created_at >= p_start)
    AND (p_end IS NULL OR al.created_at <= p_end)
    AND (p_user_id IS NULL OR al.user_id = p_user_id)
    AND (p_tool IS NULL OR al.ai_selected_tool = p_tool)
    AND (p_status IS NULL OR al.status = p_status)
  ORDER BY al.created_at DESC
  LIMIT p_page_size OFFSET v_offset;

  RETURN jsonb_build_object('rows', COALESCE(v_rows, '[]'::JSONB), 'total_count', v_total);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE;

GRANT EXECUTE ON FUNCTION audit.ai_audit_report TO authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- VIEW: public.v_audit_log — read path for the frontend.
-- security_invoker = true per Section 7.5 ("Use security-invoker reporting
-- views where supported so underlying permissions and RLS apply to the
-- invoking user"). Extended with project_id/amount/amount_currency and the
-- AI field group.
-- ═══════════════════════════════════════════════════════════════════════════
CREATE VIEW public.v_audit_log
WITH (security_invoker = true) AS
SELECT
    id, user_id, user_email, user_name, role_snapshot, session_id, auth_method,
    action, entity_type, entity_id, status, severity,
    created_at, org_timezone, ip_address::TEXT AS ip_address, user_agent, request_id,
    description, old_values, new_values, changed_columns, reason, approval_comments,
    previous_status, new_status, approval_level, delegated_authority, limit_decision,
    attachment_ids, import_batch_id, external_ref, related_journal_id, related_payment_id,
    project_id, amount, amount_currency,
    source_module, source_schema, source_table,
    ai_question, ai_normalized_intent, ai_selected_tool, ai_generated_sql, ai_template_id,
    ai_row_count, ai_model, ai_latency_ms, ai_cost_usd, ai_input_tokens, ai_output_tokens,
    ai_refusal_reason,
    error_message, entry_hash
FROM audit.audit_log;

GRANT SELECT, INSERT ON public.v_audit_log TO authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- VERIFY
-- ═══════════════════════════════════════════════════════════════════════════
DO $$
BEGIN
  RAISE NOTICE 'Audit backend rebuilt per Spec v1.3 Section 8 / 9.9 / 10.4 / Appendix A (gap-fix pass):';
  RAISE NOTICE '  - audit.audit_log with full 8.1 field set (Actor/Event/Time/Change/Workflow/Evidence/AI) + integrity chain (8.3)';
  RAISE NOTICE '  - project_id + amount + amount_currency columns and RPC filters added (8.3 required filter set now complete)';
  RAISE NOTICE '  - AI field group (question, intent, tool, SQL, template, row count, model, latency, cost, tokens, refusal) added, with audit.log_ai_event() writer and audit.ai_audit_report() reader';
  RAISE NOTICE '  - audit.security_events / export_events / data_access_events (10.4)';
  RAISE NOTICE '  - RLS matches Appendix A audit-logs row (CEO/FinHead full, Auditor read, Accountant/HOD/PM scoped, Employee own, TechAdmin=security only)';
  RAISE NOTICE '  - log_action / log_security_event / log_export_event / log_data_access_event / log_ai_event functions';
  RAISE NOTICE '  - triggers reattached to every existing table in the expanded audited list (incl. approval_limits, delegations, user_permission_overrides, financial_accounts, ownership/reserve/distribution tables, payroll/compensation tables)';
  RAISE NOTICE '  - audit.audit_log_report() supports user/action/entity/date/severity/approval/module/project/amount filters (8.3 complete)';
  RAISE NOTICE '  - public.v_audit_log is security_invoker (Section 7.5) and exposes project/amount/AI fields';
END $$;

COMMIT;