-- 030_fix_trigger_audit_log_sha256.sql
-- Root cause: audit.trigger_audit_log() calls sha256(text), which does not
-- exist in core PostgreSQL. SHA-256 is only available via pgcrypto's
-- digest(bytea, text). Additionally, the function's pinned search_path
-- ('pg_catalog','audit','public') does not include the 'extensions'
-- schema where pgcrypto is installed in this database, so even a bare
-- digest() call would fail to resolve. Fix: install pgcrypto if missing,
-- and call extensions.digest(input::bytea, 'sha256') fully schema-qualified.
--
-- This does NOT change audit behavior: same columns, same hash-chaining
-- (prev_hash -> entry_hash), same append-only semantics, same trigger
-- attachments on every audited table.

BEGIN;

-- Idempotent: safe even though pgcrypto is already installed on this
-- database per the original schema.sql. Included so this migration is
-- self-contained and safe to run against any environment independently.
CREATE EXTENSION IF NOT EXISTS "pgcrypto" WITH SCHEMA "extensions";

CREATE OR REPLACE FUNCTION "audit"."trigger_audit_log"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'audit', 'public'
    AS $$
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

    -- FIXED (migration 030): sha256(text) -> extensions.digest(bytea,'sha256').
    -- Fully schema-qualified because this function's search_path does not
    -- include 'extensions'. Explicit ::bytea cast because digest() takes
    -- bytea, not text.
    v_hash := encode(
        extensions.digest(
            (
                COALESCE(v_prev_hash, '') ||
                COALESCE(v_user_id::TEXT, '') || TG_OP || TG_TABLE_NAME ||
                COALESCE(NEW.id::TEXT, OLD.id::TEXT, '') || NOW()::TEXT
            )::bytea,
            'sha256'
        ),
        'hex'
    );

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
$$;

COMMENT ON FUNCTION "audit"."trigger_audit_log"() IS
  'Fixed migration 030 (sha256(text) does not exist in PostgreSQL / pgcrypto is installed in the extensions schema, outside this function''s pinned search_path). Replaced with extensions.digest(input::bytea, ''sha256''). No other behavior changed: same columns, same prev_hash/entry_hash chaining, same append-only design.';

COMMIT;