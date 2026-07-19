-- ==========================================
-- PHASE 1 - STEP 1.5: Audit Log (Append-Only)
-- FIXED: Added parameter types in ALTER FUNCTION
-- ==========================================

-- Drop existing (if re-running)
DROP TABLE IF EXISTS audit.audit_log CASCADE;
DROP VIEW IF EXISTS audit.audit_log_enriched CASCADE;
DROP FUNCTION IF EXISTS audit.trigger_audit_log() CASCADE;
DROP FUNCTION IF EXISTS audit.log_manual(text, text, uuid, text, jsonb, jsonb, text, text, uuid) CASCADE;

-- ==========================================
-- TABLE CREATION
-- ==========================================
CREATE TABLE audit.audit_log (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    
    table_schema TEXT NOT NULL,
    table_name TEXT NOT NULL,
    record_id UUID NOT NULL,
    
    action TEXT NOT NULL CHECK (action IN (
        'INSERT', 'UPDATE', 'DELETE', 
        'STATUS_CHANGE', 'APPROVE', 'REJECT', 'REVERSE',
        'LOGIN', 'LOGOUT', 'PERMISSION_CHANGE',
        'EXPORT', 'PERIOD_CLOSE', 'PERIOD_REOPEN',
        'AI_QUERY', 'RATE_CHANGE', 'CONFIG_CHANGE',
        'POST', 'UNPOST'
    )),
    
    old_values JSONB,
    new_values JSONB,
    changed_columns TEXT[],
    
    changed_by UUID NOT NULL REFERENCES auth.users(id) ON DELETE SET NULL,
    changed_at TIMESTAMPTZ DEFAULT NOW(),
    
    ip_address INET,
    user_agent TEXT,
    reason TEXT,
    approval_ref_id UUID,
    source_module TEXT,
    source_id UUID,
    session_id UUID
);

-- ==========================================
-- INDEXES
-- ==========================================
CREATE INDEX idx_audit_schema_table_record ON audit.audit_log(table_schema, table_name, record_id);
CREATE INDEX idx_audit_changed_by ON audit.audit_log(changed_by);
CREATE INDEX idx_audit_changed_at ON audit.audit_log(changed_at DESC);
CREATE INDEX idx_audit_action ON audit.audit_log(action);
CREATE INDEX idx_audit_source_module ON audit.audit_log(source_module);
CREATE INDEX idx_audit_table_schema ON audit.audit_log(table_schema, table_name);

-- ==========================================
-- APPEND-ONLY ENFORCEMENT
-- ==========================================
REVOKE UPDATE, DELETE ON audit.audit_log FROM authenticated;
REVOKE UPDATE, DELETE ON audit.audit_log FROM service_role;
REVOKE UPDATE, DELETE ON audit.audit_log FROM postgres;

-- ==========================================
-- AUDIT TRIGGER FUNCTION
-- ==========================================
CREATE OR REPLACE FUNCTION audit.trigger_audit_log()
RETURNS TRIGGER AS $$ DECLARE
    v_old JSONB;
    v_new JSONB;
    v_columns TEXT[];
    v_action TEXT;
    v_user_id UUID;
BEGIN
    v_action := TG_OP;
    
    v_user_id := COALESCE(
        NEW.created_by,
        OLD.created_by,
        auth.uid(),
        '00000000-0000-0000-0000-000000000000'::UUID
    );
    
    IF TG_OP = 'INSERT' THEN
        v_new := to_jsonb(NEW);
        v_old := NULL;
        v_columns := NULL;
        
    ELSIF TG_OP = 'UPDATE' THEN
        v_old := to_jsonb(OLD);
        v_new := to_jsonb(NEW);
        
        SELECT array_agg(key) INTO v_columns
        FROM jsonb_object_keys(v_new - v_old) AS key;
        
        IF v_columns IS NULL OR array_length(v_columns, 1) IS NULL THEN
            RETURN NEW;
        END IF;
        
        IF v_old ? 'status' AND v_new ? 'status' AND v_old->>'status' != v_new->>'status' THEN
            v_action := 'STATUS_CHANGE';
        END IF;
        
    ELSIF TG_OP = 'DELETE' THEN
        v_old := to_jsonb(OLD);
        v_new := NULL;
        v_columns := NULL;
    END IF;
    
    INSERT INTO audit.audit_log (
        table_schema, table_name, record_id, action,
        old_values, new_values, changed_columns,
        changed_by, ip_address, user_agent, source_module
    ) VALUES (
        TG_TABLE_SCHEMA, TG_TABLE_NAME,
        COALESCE(NEW.id, OLD.id),
        v_action, v_old, v_new, v_columns,
        v_user_id, inet_client_addr(),
        current_setting('request.header.user-agent', true),
        TG_TABLE_SCHEMA
    );
    
    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;
    RETURN NEW;
END;
 $$ LANGUAGE plpgsql SECURITY DEFINER;

-- ==========================================
-- MANUAL AUDIT FUNCTION (WITH PARAMETERS IN ALTER)
-- ==========================================
CREATE OR REPLACE FUNCTION audit.log_manual(
    p_table_schema TEXT,
    p_table_name TEXT,
    p_record_id UUID,
    p_action TEXT,
    p_old_values JSONB DEFAULT NULL,
    p_new_values JSONB DEFAULT NULL,
    p_reason TEXT DEFAULT NULL,
    p_source_module TEXT DEFAULT NULL,
    p_source_id UUID DEFAULT NULL
) RETURNS UUID AS $$ DECLARE
    v_log_id UUID;
BEGIN
    INSERT INTO audit.audit_log (
        table_schema, table_name, record_id, action,
        old_values, new_values, changed_by,
        reason, source_module, source_id
    ) VALUES (
        p_table_schema, p_table_name, p_record_id, p_action,
        p_old_values, p_new_values, auth.uid(),
        p_reason, p_source_module, p_source_id
    )
    RETURNING id INTO v_log_id;
    
    RETURN v_log_id;
END;
 $$ LANGUAGE plpgsql SECURITY DEFINER;

-- ==========================================
-- APPLY AUDIT TRIGGERS
-- ==========================================
CREATE TRIGGER org_config_audit
    AFTER INSERT OR UPDATE OR DELETE ON core.organization_config
    FOR EACH ROW EXECUTE FUNCTION audit.trigger_audit_log();

CREATE TRIGGER coa_audit
    AFTER INSERT OR UPDATE OR DELETE ON finance.chart_of_accounts
    FOR EACH ROW EXECUTE FUNCTION audit.trigger_audit_log();

CREATE TRIGGER fy_audit
    AFTER INSERT OR UPDATE ON finance.fiscal_years
    FOR EACH ROW EXECUTE FUNCTION audit.trigger_audit_log();

CREATE TRIGGER ap_audit
    AFTER INSERT OR UPDATE ON finance.accounting_periods
    FOR EACH ROW EXECUTE FUNCTION audit.trigger_audit_log();

-- ==========================================
-- ENRICHED VIEW
-- ==========================================
CREATE OR REPLACE VIEW audit.audit_log_enriched AS
SELECT 
    al.id,
    al.table_schema,
    al.table_name,
    al.record_id,
    al.action,
    al.old_values,
    al.new_values,
    al.changed_columns,
    al.changed_by,
    al.changed_at,
    al.ip_address,
    al.user_agent,
    al.reason,
    al.source_module,
    al.source_id,
    p.full_name AS changed_by_name,
    p.email AS changed_by_email,
    p.role AS changed_by_role
FROM audit.audit_log al
LEFT JOIN public.profiles p ON al.changed_by = p.user_id
ORDER BY al.changed_at DESC;

-- ==========================================
-- ROW LEVEL SECURITY
-- ==========================================
ALTER TABLE audit.audit_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "audit_select_own" ON audit.audit_log
    FOR SELECT USING (
        changed_by = auth.uid() 
        OR core.is_ceo_or_admin() 
        OR core.is_finance_head()
    );

-- ==========================================
-- FIX: SECURITY DEFINER WITH FULL SIGNATURES
-- ==========================================
-- trigger_audit_log takes NO arguments
ALTER FUNCTION audit.trigger_audit_log() SECURITY DEFINER;

-- log_manual takes 9 arguments (types must match exactly)
ALTER FUNCTION audit.log_manual(text, text, uuid, text, jsonb, jsonb, text, text, uuid) SECURITY DEFINER;

GRANT SELECT ON audit.audit_log_enriched TO authenticated;