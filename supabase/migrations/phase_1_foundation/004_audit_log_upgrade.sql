-- Drop and recreate the trigger function
DROP FUNCTION IF EXISTS audit.trigger_audit_log() CASCADE;

CREATE OR REPLACE FUNCTION audit.trigger_audit_log()
RETURNS TRIGGER AS $$ DECLARE
    v_old JSONB;
    v_new JSONB;
    v_columns TEXT[] := ARRAY[]::TEXT[];
    v_action TEXT;
    v_user_id UUID;
    v_key TEXT;
BEGIN
    v_action := TG_OP;

    -- ✅ FIX: Try multiple ways to get user ID
    -- 1. auth.uid() - direct call
    -- 2. JWT claim sub - from request context  
    -- 3. Session variable - set by RPC functions
    -- 4. NULL - last resort (audit log still records)
    v_user_id := COALESCE(
        auth.uid(),
        NULLIF(current_setting('request.jwt.claims.sub', true), '')::UUID,
        NULLIF(current_setting('app.current_user_id', true), '')::UUID,
        NULL  -- ✅ NULL hai to koi masla nahi, ab nullable hai
    );

    IF TG_OP = 'INSERT' THEN
        v_new := to_jsonb(NEW);
        v_old := NULL;
        v_columns := NULL;

    ELSIF TG_OP = 'UPDATE' THEN
        v_old := to_jsonb(OLD);
        v_new := to_jsonb(NEW);

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

        -- No actual change? Skip
        IF array_length(v_columns, 1) IS NULL THEN
            RETURN NEW;
        END IF;

        -- Detect status changes
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
        v_user_id,  -- ✅ Ab NULL ho sakta hai, FK fail nahi hoga
        inet_client_addr(),
        current_setting('request.header.user-agent', true),
        TG_TABLE_SCHEMA
    );

    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;
    RETURN NEW;
END;
 $$ LANGUAGE plpgsql SECURITY DEFINER;

-- Re-attach triggers (they were dropped with the function)
CREATE TRIGGER fy_audit
    AFTER INSERT OR UPDATE ON finance.fiscal_years
    FOR EACH ROW EXECUTE FUNCTION audit.trigger_audit_log();

CREATE TRIGGER ap_audit
    AFTER INSERT OR UPDATE ON finance.accounting_periods
    FOR EACH ROW EXECUTE FUNCTION audit.trigger_audit_log();

CREATE TRIGGER org_config_audit
    AFTER INSERT OR UPDATE OR DELETE ON core.organization_config
    FOR EACH ROW EXECUTE FUNCTION audit.trigger_audit_log();

CREATE TRIGGER coa_audit
    AFTER INSERT OR UPDATE OR DELETE ON finance.chart_of_accounts
    FOR EACH ROW EXECUTE FUNCTION audit.trigger_audit_log();

    DROP FUNCTION IF EXISTS audit.log_manual(text, text, uuid, text, jsonb, jsonb, text, text, uuid) CASCADE;

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
) RETURNS UUID AS $$ 
DECLARE
    v_log_id UUID;
    v_user_id UUID;
BEGIN
    -- ✅ Same multi-source user detection
    v_user_id := COALESCE(
        auth.uid(),
        NULLIF(current_setting('request.jwt.claims.sub', true), '')::UUID,
        NULLIF(current_setting('app.current_user_id', true), '')::UUID,
        NULL
    );

    INSERT INTO audit.audit_log (
        table_schema, table_name, record_id, action,
        old_values, new_values, changed_by,
        reason, source_module, source_id
    ) VALUES (
        p_table_schema, p_table_name, p_record_id, p_action,
        p_old_values, p_new_values, v_user_id,
        p_reason, p_source_module, p_source_id
    )
    RETURNING id INTO v_log_id;
    
    RETURN v_log_id;
END;
 $$ LANGUAGE plpgsql SECURITY DEFINER;

-- Re-grant security definer
ALTER FUNCTION audit.log_manual(text, text, uuid, text, jsonb, jsonb, text, text, uuid) SECURITY DEFINER;