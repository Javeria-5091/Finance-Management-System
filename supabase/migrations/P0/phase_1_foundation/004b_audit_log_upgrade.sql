-- REWRITE: Unified trigger function matching new audit.audit_log schema
-- Fixes Issue 1 (wrong columns) and Issue 7 (missing tables)

DROP FUNCTION IF EXISTS audit.trigger_audit_log() CASCADE;

CREATE OR REPLACE FUNCTION audit.trigger_audit_log()
RETURNS TRIGGER AS $$ DECLARE
    v_old JSONB;
    v_new JSONB;
    v_columns TEXT[] := ARRAY[]::TEXT[];
    v_action TEXT;
    v_user_id UUID;
    v_user_email TEXT;
    v_user_name TEXT;
    v_role TEXT;
    v_key TEXT;
BEGIN
    v_action := TG_OP;

    -- Multi-source user detection
    v_user_id := COALESCE(
        auth.uid(),
        NULLIF(current_setting('request.jwt.claims.sub', true), '')::UUID,
        NULLIF(current_setting('app.current_user_id', true), '')::UUID,
        NULL
    );

    -- Fetch user info for snapshot
    IF v_user_id IS NOT NULL THEN
        SELECT email, full_name INTO v_user_email, v_user_name
        FROM public.profiles WHERE id = v_user_id;

        SELECT ur.role INTO v_role
        FROM public.user_roles ur
        WHERE ur.user_id = v_user_id AND ur.is_active = true
          AND ur.effective_from <= NOW()
          AND (ur.effective_to IS NULL OR ur.effective_to >= NOW())
        ORDER BY ur.effective_from DESC LIMIT 1;
    END IF;

    IF TG_OP = 'INSERT' THEN
        v_new := to_jsonb(NEW);
        v_old := NULL;
        v_columns := NULL;

    ELSIF TG_OP = 'UPDATE' THEN
        v_old := to_jsonb(OLD);
        v_new := to_jsonb(NEW);

        FOR v_key IN (
            SELECT k FROM (
                SELECT jsonb_object_keys(v_new) AS k
                UNION
                SELECT jsonb_object_keys(v_old) AS k
            ) all_keys
        ) LOOP
            IF v_old ->> v_key IS DISTINCT FROM v_new ->> v_key THEN
                v_columns := array_append(v_columns, v_key);
            END IF;
        END LOOP;

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
        user_id, user_email, user_name, role_snapshot,
        action, entity_type, entity_id,
        status, severity,
        description,
        old_values, new_values, changed_columns,
        previous_status, new_status,
        ip_address, user_agent,
        source_module, source_table, source_schema,
        entry_hash
    ) VALUES (
        v_user_id, v_user_email, v_user_name, v_role,
        v_action,
        TG_TABLE_NAME,  -- entity_type = table name
        COALESCE(NEW.id, OLD.id),
        'success', 'info',
        TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME || ' ' || v_action,
        v_old, v_new, v_columns,
        CASE WHEN TG_OP = 'UPDATE' THEN v_old->>'status' END,
        CASE WHEN TG_OP = 'UPDATE' THEN v_new->>'status' END,
        inet_client_addr(),
        current_setting('request.header.user-agent', true),
        TG_TABLE_SCHEMA,
        TG_TABLE_NAME,
        TG_TABLE_SCHEMA,
        encode(sha256(
            COALESCE(v_user_id::TEXT, '') || TG_OP || TG_TABLE_NAME ||
            COALESCE(NEW.id::TEXT, OLD.id::TEXT, '') || NOW()::TEXT
        ), 'hex')
    );

    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
END;
 $$ LANGUAGE plpgsql SECURITY DEFINER;

-- ═══════════════════════════════════════════════════════════════
-- Re-attach triggers — FIX: Now covers ALL major tables (Issue 7)
-- ═══════════════════════════════════════════════════════════════

-- Foundation
DO $$ BEGIN
  -- finance schema
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='finance' AND table_name='fiscal_years') THEN
    CREATE TRIGGER fy_audit AFTER INSERT OR UPDATE OR DELETE ON finance.fiscal_years
      FOR EACH ROW EXECUTE FUNCTION audit.trigger_audit_log();
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='finance' AND table_name='accounting_periods') THEN
    CREATE TRIGGER ap_audit AFTER INSERT OR UPDATE OR DELETE ON finance.accounting_periods
      FOR EACH ROW EXECUTE FUNCTION audit.trigger_audit_log();
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='finance' AND table_name='chart_of_accounts') THEN
    CREATE TRIGGER coa_audit AFTER INSERT OR UPDATE OR DELETE ON finance.chart_of_accounts
      FOR EACH ROW EXECUTE FUNCTION audit.trigger_audit_log();
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='finance' AND table_name='journal_entries') THEN
    CREATE TRIGGER je_audit AFTER INSERT OR UPDATE OR DELETE ON finance.journal_entries
      FOR EACH ROW EXECUTE FUNCTION audit.trigger_audit_log();
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='finance' AND table_name='journal_lines') THEN
    CREATE TRIGGER jl_audit AFTER INSERT OR UPDATE OR DELETE ON finance.journal_lines
      FOR EACH ROW EXECUTE FUNCTION audit.trigger_audit_log();
  END IF;

  -- core schema
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='core' AND table_name='organization_config') THEN
    CREATE TRIGGER org_config_audit AFTER INSERT OR UPDATE OR DELETE ON core.organization_config
      FOR EACH ROW EXECUTE FUNCTION audit.trigger_audit_log();
  END IF;

  -- public schema tables
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='expenses') THEN
    CREATE TRIGGER expenses_audit AFTER INSERT OR UPDATE OR DELETE ON public.expenses
      FOR EACH ROW EXECUTE FUNCTION audit.trigger_audit_log();
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='incomes') THEN
    CREATE TRIGGER incomes_audit AFTER INSERT OR UPDATE OR DELETE ON public.incomes
      FOR EACH ROW EXECUTE FUNCTION audit.trigger_audit_log();
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='invoices') THEN
    CREATE TRIGGER invoices_audit AFTER INSERT OR UPDATE OR DELETE ON public.invoices
      FOR EACH ROW EXECUTE FUNCTION audit.trigger_audit_log();
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='projects') THEN
    CREATE TRIGGER projects_audit AFTER INSERT OR UPDATE OR DELETE ON public.projects
      FOR EACH ROW EXECUTE FUNCTION audit.trigger_audit_log();
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='clients') THEN
    CREATE TRIGGER clients_audit AFTER INSERT OR UPDATE OR DELETE ON public.clients
      FOR EACH ROW EXECUTE FUNCTION audit.trigger_audit_log();
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='vendors') THEN
    CREATE TRIGGER vendors_audit AFTER INSERT OR UPDATE OR DELETE ON public.vendors
      FOR EACH ROW EXECUTE FUNCTION audit.trigger_audit_log();
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='vendor_bills') THEN
    CREATE TRIGGER vendor_bills_audit AFTER INSERT OR UPDATE OR DELETE ON public.vendor_bills
      FOR EACH ROW EXECUTE FUNCTION audit.trigger_audit_log();
  END IF;

  RAISE NOTICE ' Audit triggers attached to all major tables';
END $$;