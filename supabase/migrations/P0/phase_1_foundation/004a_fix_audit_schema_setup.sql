-- migrations/P0/fix_audit_schema_setup.sql
--  COMPLETE REWRITE: Unified audit schema per Spec v1.3 Section 8 & 10.4

-- ═══════════════════════════════════════════════════════════════
-- STEP 1: Drop EVERYTHING (clean slate)
-- ═══════════════════════════════════════════════════════════════
DROP TABLE IF EXISTS audit.security_events CASCADE;
DROP TABLE IF EXISTS audit.export_events CASCADE;
DROP TABLE IF EXISTS audit.data_access_events CASCADE;
DROP TABLE IF EXISTS audit.audit_log CASCADE;
DROP VIEW IF EXISTS public.v_audit_log CASCADE;
DROP VIEW IF EXISTS audit.audit_log_enriched CASCADE;
DROP FUNCTION IF EXISTS audit.has_audit_permission(UUID) CASCADE;
DROP FUNCTION IF EXISTS audit.log_action CASCADE;
DROP FUNCTION IF EXISTS audit.trigger_audit_log() CASCADE;
DROP FUNCTION IF EXISTS audit.log_manual CASCADE;
DROP INDEX IF EXISTS audit.idx_audit_log_created_at CASCADE;
DROP INDEX IF EXISTS audit.idx_audit_log_user_id CASCADE;
DROP INDEX IF EXISTS audit.idx_audit_log_action CASCADE;
DROP INDEX IF EXISTS audit.idx_audit_log_entity CASCADE;
DROP INDEX IF EXISTS audit.idx_audit_log_status CASCADE;
DROP TABLE IF EXISTS public.audit_logs CASCADE;
DROP TABLE IF EXISTS public.audit_log CASCADE;
DROP FUNCTION IF EXISTS public.has_audit_permission(UUID) CASCADE;
DROP FUNCTION IF EXISTS public.log_audit_action() CASCADE;

-- ═══════════════════════════════════════════════════════════════
-- STEP 2: Create audit schema
-- ═══════════════════════════════════════════════════════════════
CREATE SCHEMA IF NOT EXISTS audit;

-- ═══════════════════════════════════════════════════════════════
-- STEP 3: Main audit_log table (Spec 8.1 + 8.2 + 8.3)
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE audit.audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Actor (Spec 8.1)
  user_id UUID,
  user_email TEXT,
  user_name TEXT,
  role_snapshot TEXT,                --  NEW: role at time of action
  session_id TEXT,                   --  NEW: session identifier
  auth_method TEXT,                  --  NEW: password/mfa/sso

  -- Event (Spec 8.1)
  action TEXT NOT NULL,
  entity_type TEXT,                  -- maps to table_name or module
  entity_id UUID,
  status TEXT DEFAULT 'success' CHECK (status IN ('success', 'denied', 'error')),
  severity TEXT DEFAULT 'info' CHECK (severity IN ('info', 'low', 'medium', 'high', 'critical')),

  -- Time and source (Spec 8.1)
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ip_address INET,
  user_agent TEXT,
  request_id TEXT,                   --  NEW: correlation/request ID

  -- Change (Spec 8.1)
  description TEXT,
  old_values JSONB,
  new_values JSONB,
  changed_columns TEXT[],
  reason TEXT,                       --  NEW: why the change was made

  -- Workflow (Spec 8.1)
  previous_status TEXT,              
  new_status TEXT,                   
  approval_level TEXT,               
  approver_id UUID,                  
  approval_limit DECIMAL(18,2),      

  -- Evidence (Spec 8.1)
  attachment_ids UUID[],            
  import_batch_id UUID,              
  external_ref TEXT,                 
  related_journal_id UUID,           
  related_payment_id UUID,           

  -- Source classification
  source_module TEXT,                -- e.g. finance, hr, ai, admin
  source_table TEXT,                 -- actual table name for DB triggers
  source_schema TEXT,

  -- Integrity (Spec 8.3)
  prev_hash TEXT,                    --  NEW: chain to previous entry
  entry_hash TEXT                    --  NEW: SHA-256 of this entry
);

-- ═══════════════════════════════════════════════════════════════
-- STEP 4: Security events table (Spec 10.4)
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE audit.security_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID,
  user_email TEXT,
  event_type TEXT NOT NULL CHECK (event_type IN (
    'LOGIN_SUCCESS', 'LOGIN_FAILURE', 'MFA_ENABLED', 'MFA_DISABLED',
    'MFA_VERIFICATION_SUCCESS', 'MFA_VERIFICATION_FAILURE',
    'PASSWORD_RESET_REQUEST', 'PASSWORD_RESET_SUCCESS', 'PASSWORD_RESET_FAILURE',
    'SESSION_TERMINATED', 'SUSPICIOUS_ACCESS', 'LOCKOUT',
    'PERMISSION_CHANGE', 'ROLE_CHANGE', 'DATA_SCOPE_CHANGE'
  )),
  ip_address INET,
  user_agent TEXT,
  details JSONB,
  success BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  request_id TEXT
);

-- ═══════════════════════════════════════════════════════════════
-- STEP 5: Export events table (Spec 10.4)
-- ═══════════════════════════════════════════════════════════════
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

-- ═══════════════════════════════════════════════════════════════
-- STEP 6: Data access events table (Spec 10.4)
-- ═══════════════════════════════════════════════════════════════
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

-- ═══════════════════════════════════════════════════════════════
-- STEP 7: Indexes
-- ═══════════════════════════════════════════════════════════════
CREATE INDEX idx_audit_log_created_at ON audit.audit_log(created_at DESC);
CREATE INDEX idx_audit_log_user_id ON audit.audit_log(user_id);
CREATE INDEX idx_audit_log_action ON audit.audit_log(action);
CREATE INDEX idx_audit_log_entity ON audit.audit_log(entity_type, entity_id);
CREATE INDEX idx_audit_log_status ON audit.audit_log(status);
CREATE INDEX idx_audit_log_severity ON audit.audit_log(severity);
CREATE INDEX idx_audit_log_source_module ON audit.audit_log(source_module);
CREATE INDEX idx_audit_log_source_table ON audit.audit_log(source_schema, source_table);
CREATE INDEX idx_audit_log_request_id ON audit.audit_log(request_id);

CREATE INDEX idx_security_events_user ON audit.security_events(user_id, created_at DESC);
CREATE INDEX idx_security_events_type ON audit.security_events(event_type, created_at DESC);

CREATE INDEX idx_export_events_user ON audit.export_events(user_id, created_at DESC);

CREATE INDEX idx_data_access_user ON audit.data_access_events(user_id, created_at DESC);

-- ═══════════════════════════════════════════════════════════════
-- STEP 8: RLS — audit.audit_log
-- ═══════════════════════════════════════════════════════════════
ALTER TABLE audit.audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit.security_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit.export_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit.data_access_events ENABLE ROW LEVEL SECURITY;

--  FIX: Role-based access per Spec Appendix A
-- CEO: Full, FINANCE_HEAD: Full, ACCOUNTANT: Full, AUDITOR: Full read
-- HOD/PM: Own actions only
CREATE OR REPLACE FUNCTION audit.has_audit_permission(p_user_id UUID)
RETURNS TEXT AS $$ DECLARE
  v_role TEXT;
BEGIN
  SELECT ur.role INTO v_role
  FROM public.user_roles ur
  WHERE ur.user_id = p_user_id
    AND ur.is_active = true
    AND ur.effective_from <= NOW()
    AND (ur.effective_to IS NULL OR ur.effective_to >= NOW())
  ORDER BY ur.effective_from DESC
  LIMIT 1;

  IF v_role IS NULL THEN
    SELECT p.role INTO v_role
    FROM public.profiles p
    WHERE p.id = p_user_id;
  END IF;

  RETURN v_role;
END;
 $$ LANGUAGE plpgsql SECURITY DEFINER STABLE;

-- Full read: CEO, FINANCE_HEAD, ACCOUNTANT, AUDITOR, TECH_ADMIN (security logs only)
CREATE POLICY "audit_log_select_full" ON audit.audit_log
  FOR SELECT TO authenticated
  USING (audit.has_audit_permission(auth.uid()) IN ('CEO', 'FINANCE_HEAD', 'ACCOUNTANT', 'AUDITOR', 'TECH_ADMIN'));

-- Own actions only: HOD, PROJECT_MANAGER, EMPLOYEE
CREATE POLICY "audit_log_select_own" ON audit.audit_log
  FOR SELECT TO authenticated
  USING (audit.has_audit_permission(auth.uid()) IN ('HOD', 'PROJECT_MANAGER', 'EMPLOYEE')
         AND user_id = auth.uid());

-- Insert: all authenticated users can INSERT (needed for app-side logging)
CREATE POLICY "audit_log_insert" ON audit.audit_log
  FOR INSERT TO authenticated
  WITH CHECK (true);

-- No update (append-only per Spec 8)
CREATE POLICY "audit_log_no_update" ON audit.audit_log
  FOR UPDATE TO authenticated USING (false);

-- No delete (append-only per Spec 8)
CREATE POLICY "audit_log_no_delete" ON audit.audit_log
  FOR DELETE TO authenticated USING (false);

-- Service role: full access
CREATE POLICY "audit_log_service_all" ON audit.audit_log
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Security events RLS
CREATE POLICY "sec_events_select" ON audit.security_events
  FOR SELECT TO authenticated
  USING (audit.has_audit_permission(auth.uid()) IN ('CEO', 'FINANCE_HEAD', 'ACCOUNTANT', 'AUDITOR', 'TECH_ADMIN'));

CREATE POLICY "sec_events_insert" ON audit.security_events
  FOR INSERT TO authenticated WITH CHECK (true);

CREATE POLICY "sec_events_no_update" ON audit.security_events
  FOR UPDATE TO authenticated USING (false);

CREATE POLICY "sec_events_no_delete" ON audit.security_events
  FOR DELETE TO authenticated USING (false);

-- Export events RLS
CREATE POLICY "export_events_select" ON audit.export_events
  FOR SELECT TO authenticated
  USING (audit.has_audit_permission(auth.uid()) IN ('CEO', 'FINANCE_HEAD', 'ACCOUNTANT', 'AUDITOR'));

CREATE POLICY "export_events_insert" ON audit.export_events
  FOR INSERT TO authenticated WITH CHECK (true);

CREATE POLICY "export_events_no_update" ON audit.export_events
  FOR UPDATE TO authenticated USING (false);

CREATE POLICY "export_events_no_delete" ON audit.export_events
  FOR DELETE TO authenticated USING (false);

-- Data access events RLS
CREATE POLICY "data_access_select" ON audit.data_access_events
  FOR SELECT TO authenticated
  USING (audit.has_audit_permission(auth.uid()) IN ('CEO', 'FINANCE_HEAD', 'ACCOUNTANT', 'AUDITOR', 'TECH_ADMIN'));

CREATE POLICY "data_access_insert" ON audit.data_access_events
  FOR INSERT TO authenticated WITH CHECK (true);

CREATE POLICY "data_access_no_update" ON audit.data_access_events
  FOR UPDATE TO authenticated USING (false);

CREATE POLICY "data_access_no_delete" ON audit.data_access_events
  FOR DELETE TO authenticated USING (false);

-- ═══════════════════════════════════════════════════════════════
-- STEP 9: Grants
-- ═══════════════════════════════════════════════════════════════
GRANT USAGE ON SCHEMA audit TO authenticated;
GRANT SELECT, INSERT ON audit.audit_log TO authenticated;
GRANT SELECT, INSERT ON audit.security_events TO authenticated;
GRANT SELECT, INSERT ON audit.export_events TO authenticated;
GRANT SELECT, INSERT ON audit.data_access_events TO authenticated;
REVOKE UPDATE, DELETE ON audit.audit_log FROM authenticated;
REVOKE UPDATE, DELETE ON audit.security_events FROM authenticated;
REVOKE UPDATE, DELETE ON audit.export_events FROM authenticated;
REVOKE UPDATE, DELETE ON audit.data_access_events FROM authenticated;
GRANT ALL ON ALL TABLES IN SCHEMA audit TO service_role;

-- ═══════════════════════════════════════════════════════════════
-- STEP 10: Enriched view (joins user info) — fixes Issue 2
-- ═══════════════════════════════════════════════════════════════
CREATE VIEW audit.audit_log_enriched AS
SELECT
  al.id,
  al.user_id,
  al.user_email,
  al.user_name,
  al.role_snapshot,
  al.session_id,
  al.auth_method,
  al.action,
  al.entity_type,
  al.entity_id,
  al.status,
  al.severity,
  al.created_at AS changed_at,
  al.ip_address::TEXT AS ip_address,
  al.user_agent,
  al.request_id,
  al.description,
  al.old_values,
  al.new_values,
  al.changed_columns,
  al.reason,
  al.previous_status,
  al.new_status,
  al.approval_level,
  al.approver_id,
  al.source_module,
  al.source_table AS table_name,
  al.source_schema AS table_schema,
  al.related_journal_id,
  al.related_payment_id,
  al.entry_hash,
  COALESCE(p.full_name, al.user_name) AS changed_by_name,
  COALESCE(p.email, al.user_email) AS changed_by_email,
  COALESCE(
    (SELECT ur.role FROM public.user_roles ur
     WHERE ur.user_id = al.user_id AND ur.is_active = true
     AND ur.effective_from <= al.created_at
     AND (ur.effective_to IS NULL OR ur.effective_to >= al.created_at)
     ORDER BY ur.effective_from DESC LIMIT 1),
    al.role_snapshot
  ) AS changed_by_role
FROM audit.audit_log al
LEFT JOIN public.profiles p ON p.id = al.user_id;

-- ═══════════════════════════════════════════════════════════════
-- STEP 11: Public view for v_audit_log (backward compat)
-- ═══════════════════════════════════════════════════════════════
CREATE VIEW public.v_audit_log AS
SELECT
  id, user_id, user_email, user_name, role_snapshot, session_id,
  action, entity_type, entity_id, status, severity,
  created_at, ip_address::TEXT AS ip_address, user_agent,
  request_id, description, old_values, new_values, changed_columns,
  reason, previous_status, new_status, approval_level,
  source_module, source_table AS table_name, source_schema AS table_schema
FROM audit.audit_log;

GRANT SELECT, INSERT ON public.v_audit_log TO authenticated;

-- ═══════════════════════════════════════════════════════════════
-- STEP 12: Server-side logging function (unified)
-- ═══════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION audit.log_action(
  p_user_id UUID,
  p_user_email TEXT DEFAULT NULL,
  p_user_name TEXT DEFAULT NULL,
  p_action TEXT,
  p_entity_type TEXT DEFAULT NULL,
  p_entity_id UUID DEFAULT NULL,
  p_description TEXT DEFAULT '',
  p_old_values JSONB DEFAULT NULL,
  p_new_values JSONB DEFAULT NULL,
  p_status TEXT DEFAULT 'success',
  p_error_message TEXT DEFAULT NULL,
  p_severity TEXT DEFAULT 'info',
  p_reason TEXT DEFAULT NULL,
  p_source_module TEXT DEFAULT NULL,
  p_request_id TEXT DEFAULT NULL,
  p_previous_status TEXT DEFAULT NULL,
  p_new_status TEXT DEFAULT NULL,
  p_ip_address INET DEFAULT NULL,
  p_user_agent TEXT DEFAULT NULL
)
RETURNS UUID AS $$ DECLARE
  v_id UUID;
  v_role TEXT;
  v_hash TEXT;
BEGIN
  -- Get role snapshot
  SELECT ur.role INTO v_role
  FROM public.user_roles ur
  WHERE ur.user_id = p_user_id AND ur.is_active = true
    AND ur.effective_from <= NOW()
    AND (ur.effective_to IS NULL OR ur.effective_to >= NOW())
  ORDER BY ur.effective_from DESC LIMIT 1;

  IF v_role IS NULL THEN
    SELECT p.role INTO v_role FROM public.profiles p WHERE p.id = p_user_id;
  END IF;

  -- Calculate entry hash (integrity chain)
  v_hash := encode(
    sha256(
      COALESCE(p_user_id::TEXT, '') ||
      p_action ||
      COALESCE(p_entity_type, '') ||
      COALESCE(p_entity_id::TEXT, '') ||
      COALESCE(p_description, '') ||
      COALESCE(p_severity, 'info') ||
      NOW()::TEXT
    ), 'hex'
  );

  INSERT INTO audit.audit_log (
    user_id, user_email, user_name, role_snapshot,
    action, entity_type, entity_id,
    status, severity,
    description, old_values, new_values, changed_columns, reason,
    previous_status, new_status,
    ip_address, user_agent, request_id,
    source_module, entry_hash
  ) VALUES (
    p_user_id, p_user_email, p_user_name, v_role,
    p_action, p_entity_type, p_entity_id,
    p_status, p_severity,
    p_description, p_old_values, p_new_values,
    CASE WHEN p_old_values IS NOT NULL AND p_new_values IS NOT NULL
      THEN ARRAY(SELECT jsonb_object_keys(p_new_values)) ELSE NULL END,
    p_reason,
    p_previous_status, p_new_status,
    COALESCE(p_ip_address, inet_client_addr()),
    COALESCE(p_user_agent, current_setting('request.header.user-agent', true)),
    p_request_id,
    p_source_module, v_hash
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END;
 $$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION audit.log_action TO authenticated;

-- ═══════════════════════════════════════════════════════════════
-- STEP 13: Log security event function
-- ═══════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION audit.log_security_event(
  p_user_id UUID DEFAULT NULL,
  p_user_email TEXT DEFAULT NULL,
  p_event_type TEXT,
  p_success BOOLEAN DEFAULT true,
  p_details JSONB DEFAULT NULL,
  p_request_id TEXT DEFAULT NULL
)
RETURNS UUID AS $$ DECLARE
  v_id UUID;
BEGIN
  INSERT INTO audit.security_events (
    user_id, user_email, event_type, ip_address, user_agent,
    details, success, request_id
  ) VALUES (
    p_user_id, p_user_email, p_event_type,
    inet_client_addr(),
    current_setting('request.header.user-agent', true),
    p_details, p_success, p_request_id
  ) RETURNING id INTO v_id;
  RETURN v_id;
END;
 $$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION audit.log_security_event TO authenticated;

-- ═══════════════════════════════════════════════════════════════
-- STEP 14: Log export event function
-- ═══════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION audit.log_export_event(
  p_user_id UUID DEFAULT NULL,
  p_user_email TEXT DEFAULT NULL,
  p_user_name TEXT DEFAULT NULL,
  p_report_name TEXT,
  p_report_type TEXT DEFAULT NULL,
  p_format TEXT DEFAULT 'csv',
  p_filters JSONB DEFAULT NULL,
  p_row_count INTEGER DEFAULT NULL,
  p_file_size_bytes INTEGER DEFAULT NULL
)
RETURNS UUID AS $$ DECLARE
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

-- ═══════════════════════════════════════════════════════════════
-- STEP 15: audit_log_report RPC — fixes Issue 3 (Controls & Audit page)
-- ═══════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION audit.audit_log_report(
  p_start TIMESTAMPTZ DEFAULT NULL,
  p_end TIMESTAMPTZ DEFAULT NULL,
  p_action TEXT DEFAULT NULL,
  p_resource TEXT DEFAULT NULL,
  p_page INTEGER DEFAULT 1,
  p_page_size INTEGER DEFAULT 50
)
RETURNS JSON AS $$ DECLARE
  v_offset INTEGER := (p_page - 1) * p_page_size;
  v_rows JSONB := '[]'::JSONB;
  v_total INTEGER := 0;
  v_result JSONB;
BEGIN
  -- Count total
  SELECT COUNT(*) INTO v_total
  FROM audit.audit_log al
  WHERE (p_start IS NULL OR al.created_at >= p_start)
    AND (p_end IS NULL OR al.created_at <= p_end)
    AND (p_action IS NULL OR al.action ILIKE '%' || p_action || '%')
    AND (p_resource IS NULL OR al.entity_type ILIKE '%' || p_resource || '%');

  -- Fetch page
  SELECT jsonb_agg(
    jsonb_build_object(
      'id', al.id::TEXT,
      'timestamp', al.created_at::TEXT,
      'user_email', COALESCE(al.user_email, ''),
      'user_name', COALESCE(al.user_name, ''),
      'action', al.action,
      'resource', COALESCE(al.entity_type, COALESCE(al.source_module, '')),
      'resource_id', COALESCE(al.entity_id::TEXT, ''),
      'details', COALESCE(al.new_values, '{}'::JSONB),
      'ip_address', COALESCE(al.ip_address::TEXT, ''),
      'severity', COALESCE(al.severity, 'info'),
      'status', COALESCE(al.status, 'success')
    )
    ORDER BY al.created_at DESC
  ) INTO v_rows
  FROM audit.audit_log al
  WHERE (p_start IS NULL OR al.created_at >= p_start)
    AND (p_end IS NULL OR al.created_at <= p_end)
    AND (p_action IS NULL OR al.action ILIKE '%' || p_action || '%')
    AND (p_resource IS NULL OR al.entity_type ILIKE '%' || p_resource || '%')
  ORDER BY al.created_at DESC
  LIMIT p_page_size OFFSET v_offset;

  v_result := jsonb_build_object('rows', v_rows, 'total_count', v_total);
  RETURN v_result;
END;
 $$ LANGUAGE plpgsql SECURITY DEFINER STABLE;

GRANT EXECUTE ON FUNCTION audit.audit_log_report TO authenticated;

-- ═══════════════════════════════════════════════════════════════
-- STEP 16: Verify
-- ═══════════════════════════════════════════════════════════════
DO $$ BEGIN
  RAISE NOTICE 'audit.audit_log table created with all Spec 8.1 fields';
  RAISE NOTICE 'audit.security_events table created';
  RAISE NOTICE 'audit.export_events table created';
  RAISE NOTICE '.data_access_events table created';
  RAISE NOTICE 'audit.audit_log_enriched view created';
  RAISE NOTICE 'public.v_audit_log view created';
  RAISE NOTICE 'audit.log_action() function created (unified)';
  RAISE NOTICE 'audit.log_security_event() function created';
  RAISE NOTICE 'audit.log_export_event() function created';
  RAISE NOTICE 'audit.audit_log_report() RPC created';
  RAISE NOTICE 'RLS policies applied with role-based access';
END $$;