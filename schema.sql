


SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;


CREATE SCHEMA IF NOT EXISTS "ai";


ALTER SCHEMA "ai" OWNER TO "postgres";


CREATE SCHEMA IF NOT EXISTS "audit";


ALTER SCHEMA "audit" OWNER TO "postgres";


CREATE SCHEMA IF NOT EXISTS "core";


ALTER SCHEMA "core" OWNER TO "postgres";


CREATE SCHEMA IF NOT EXISTS "finance";


ALTER SCHEMA "finance" OWNER TO "postgres";


CREATE SCHEMA IF NOT EXISTS "legacy";


ALTER SCHEMA "legacy" OWNER TO "postgres";


COMMENT ON SCHEMA "legacy" IS 'Archived legacy/duplicate tables retained for historical reference only. Not exposed to PostgREST. See Migration 032 (compliance audit Finding 2.2 / Section 3.2 resolution; builds on the write-freeze from Migration 022).';



COMMENT ON SCHEMA "public" IS 'standard public schema';



CREATE SCHEMA IF NOT EXISTS "reporting";


ALTER SCHEMA "reporting" OWNER TO "postgres";


CREATE EXTENSION IF NOT EXISTS "btree_gist" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "pg_stat_statements" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "pgcrypto" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "supabase_vault" WITH SCHEMA "vault";






CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA "extensions";






CREATE OR REPLACE FUNCTION "ai"."increment_usage"("p_user_id" "uuid", "p_organization_id" "uuid", "p_tokens" integer, "p_cost" numeric) RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'ai', 'core', 'public'
    AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF p_user_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'Cannot record AI usage for another user';
  END IF;

  IF NOT core.same_org(p_organization_id) THEN
    RAISE EXCEPTION 'Cannot record AI usage for another organization';
  END IF;

  INSERT INTO ai.ai_user_cost_tracking
    (user_id, organization_id, period_date, request_count, total_tokens, estimated_cost)
  VALUES
    (p_user_id, p_organization_id, CURRENT_DATE, 1,
     GREATEST(COALESCE(p_tokens, 0), 0),
     GREATEST(COALESCE(p_cost, 0), 0))
  ON CONFLICT (user_id, organization_id, period_date)
  DO UPDATE SET
    request_count = ai.ai_user_cost_tracking.request_count + 1,
    total_tokens = ai.ai_user_cost_tracking.total_tokens + GREATEST(COALESCE(p_tokens, 0), 0),
    estimated_cost = ai.ai_user_cost_tracking.estimated_cost + GREATEST(COALESCE(p_cost, 0), 0),
    updated_at = now();
END;
$$;


ALTER FUNCTION "ai"."increment_usage"("p_user_id" "uuid", "p_organization_id" "uuid", "p_tokens" integer, "p_cost" numeric) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "audit"."ai_audit_report"("p_start" timestamp with time zone DEFAULT NULL::timestamp with time zone, "p_end" timestamp with time zone DEFAULT NULL::timestamp with time zone, "p_user_id" "uuid" DEFAULT NULL::"uuid", "p_tool" "text" DEFAULT NULL::"text", "p_status" "text" DEFAULT NULL::"text", "p_page" integer DEFAULT 1, "p_page_size" integer DEFAULT 50) RETURNS json
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'audit', 'public', 'core'
    AS $$
DECLARE v_org uuid:=core.current_user_org_id(); v_offset integer:=greatest(p_page-1,0)*p_page_size; v_rows jsonb:='[]'::jsonb; v_total integer:=0;
BEGIN
  IF v_org IS NULL OR NOT (core.has_role('CEO') OR core.has_role('FINANCE_HEAD') OR core.has_role('AUDITOR') OR core.has_role('Admin')) THEN RAISE EXCEPTION 'Access denied'; END IF;
  SELECT count(*) INTO v_total FROM audit.audit_log al WHERE al.organization_id=v_org AND al.source_module='ai'
    AND (p_start IS NULL OR al.created_at>=p_start) AND (p_end IS NULL OR al.created_at<=p_end)
    AND (p_user_id IS NULL OR al.user_id=p_user_id) AND (p_tool IS NULL OR al.ai_selected_tool=p_tool) AND (p_status IS NULL OR al.status=p_status);
  SELECT jsonb_agg(jsonb_build_object('id',al.id::text,'timestamp',al.created_at::text,'user_id',al.user_id::text,'user_email',coalesce(al.user_email,''),'action',al.action,'status',al.status,'question',coalesce(al.ai_question,''),'normalized_intent',coalesce(al.ai_normalized_intent,''),'selected_tool',coalesce(al.ai_selected_tool,''),'template_id',coalesce(al.ai_template_id,''),'row_count',al.ai_row_count,'model',coalesce(al.ai_model,''),'latency_ms',al.ai_latency_ms,'cost_usd',al.ai_cost_usd,'input_tokens',al.ai_input_tokens,'output_tokens',al.ai_output_tokens,'refusal_reason',coalesce(al.ai_refusal_reason,'')) ORDER BY al.created_at DESC)
  INTO v_rows FROM audit.audit_log al WHERE al.organization_id=v_org AND al.source_module='ai'
    AND (p_start IS NULL OR al.created_at>=p_start) AND (p_end IS NULL OR al.created_at<=p_end)
    AND (p_user_id IS NULL OR al.user_id=p_user_id) AND (p_tool IS NULL OR al.ai_selected_tool=p_tool) AND (p_status IS NULL OR al.status=p_status)
  LIMIT p_page_size OFFSET v_offset;
  RETURN jsonb_build_object('rows',coalesce(v_rows,'[]'::jsonb),'total_count',v_total);
END; $$;


ALTER FUNCTION "audit"."ai_audit_report"("p_start" timestamp with time zone, "p_end" timestamp with time zone, "p_user_id" "uuid", "p_tool" "text", "p_status" "text", "p_page" integer, "p_page_size" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "audit"."audit_log_report"("p_start" timestamp with time zone DEFAULT NULL::timestamp with time zone, "p_end" timestamp with time zone DEFAULT NULL::timestamp with time zone, "p_user_id" "uuid" DEFAULT NULL::"uuid", "p_action" "text" DEFAULT NULL::"text", "p_entity_type" "text" DEFAULT NULL::"text", "p_severity" "text" DEFAULT NULL::"text", "p_approval_level" "text" DEFAULT NULL::"text", "p_source_module" "text" DEFAULT NULL::"text", "p_project_id" "uuid" DEFAULT NULL::"uuid", "p_min_amount" numeric DEFAULT NULL::numeric, "p_max_amount" numeric DEFAULT NULL::numeric, "p_page" integer DEFAULT 1, "p_page_size" integer DEFAULT 50) RETURNS json
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'audit', 'public', 'core'
    AS $$
DECLARE v_org uuid:=core.current_user_org_id(); v_offset integer:=greatest(p_page-1,0)*p_page_size; v_rows jsonb:='[]'::jsonb; v_total integer:=0;
BEGIN
  IF v_org IS NULL OR NOT (core.has_role('CEO') OR core.has_role('FINANCE_HEAD') OR core.has_role('AUDITOR') OR core.has_role('Admin')) THEN RAISE EXCEPTION 'Access denied'; END IF;
  SELECT count(*) INTO v_total FROM audit.audit_log al WHERE al.organization_id=v_org
    AND (p_start IS NULL OR al.created_at>=p_start) AND (p_end IS NULL OR al.created_at<=p_end) AND (p_user_id IS NULL OR al.user_id=p_user_id)
    AND (p_action IS NULL OR al.action ILIKE '%'||p_action||'%') AND (p_entity_type IS NULL OR al.entity_type ILIKE '%'||p_entity_type||'%')
    AND (p_severity IS NULL OR al.severity=p_severity) AND (p_approval_level IS NULL OR al.approval_level=p_approval_level)
    AND (p_source_module IS NULL OR al.source_module=p_source_module) AND (p_project_id IS NULL OR al.project_id=p_project_id)
    AND (p_min_amount IS NULL OR al.amount>=p_min_amount) AND (p_max_amount IS NULL OR al.amount<=p_max_amount);
  SELECT jsonb_agg(jsonb_build_object('id',al.id::text,'timestamp',al.created_at::text,'user_id',al.user_id::text,'user_email',coalesce(al.user_email,''),'user_name',coalesce(al.user_name,''),'role_snapshot',coalesce(al.role_snapshot,''),'action',al.action,'entity_type',coalesce(al.entity_type,''),'entity_id',coalesce(al.entity_id::text,''),'description',coalesce(al.description,''),'status',al.status,'severity',al.severity,'reason',coalesce(al.reason,''),'approval_level',coalesce(al.approval_level,''),'source_module',coalesce(al.source_module,''),'project_id',coalesce(al.project_id::text,''),'amount',al.amount,'amount_currency',coalesce(al.amount_currency,''),'ip_address',coalesce(al.ip_address::text,'')) ORDER BY al.created_at DESC)
  INTO v_rows FROM audit.audit_log al WHERE al.organization_id=v_org
    AND (p_start IS NULL OR al.created_at>=p_start) AND (p_end IS NULL OR al.created_at<=p_end) AND (p_user_id IS NULL OR al.user_id=p_user_id)
    AND (p_action IS NULL OR al.action ILIKE '%'||p_action||'%') AND (p_entity_type IS NULL OR al.entity_type ILIKE '%'||p_entity_type||'%')
    AND (p_severity IS NULL OR al.severity=p_severity) AND (p_approval_level IS NULL OR al.approval_level=p_approval_level)
    AND (p_source_module IS NULL OR al.source_module=p_source_module) AND (p_project_id IS NULL OR al.project_id=p_project_id)
    AND (p_min_amount IS NULL OR al.amount>=p_min_amount) AND (p_max_amount IS NULL OR al.amount<=p_max_amount)
  LIMIT p_page_size OFFSET v_offset;
  RETURN jsonb_build_object('rows',coalesce(v_rows,'[]'::jsonb),'total_count',v_total);
END; $$;


ALTER FUNCTION "audit"."audit_log_report"("p_start" timestamp with time zone, "p_end" timestamp with time zone, "p_user_id" "uuid", "p_action" "text", "p_entity_type" "text", "p_severity" "text", "p_approval_level" "text", "p_source_module" "text", "p_project_id" "uuid", "p_min_amount" numeric, "p_max_amount" numeric, "p_page" integer, "p_page_size" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "audit"."log_action"("p_user_id" "uuid", "p_user_email" "text" DEFAULT NULL::"text", "p_user_name" "text" DEFAULT NULL::"text", "p_action" "text" DEFAULT NULL::"text", "p_entity_type" "text" DEFAULT NULL::"text", "p_entity_id" "uuid" DEFAULT NULL::"uuid", "p_description" "text" DEFAULT ''::"text", "p_old_values" "jsonb" DEFAULT NULL::"jsonb", "p_new_values" "jsonb" DEFAULT NULL::"jsonb", "p_ip_address" "inet" DEFAULT NULL::"inet", "p_user_agent" "text" DEFAULT NULL::"text", "p_status" "text" DEFAULT 'success'::"text", "p_error_message" "text" DEFAULT NULL::"text", "p_severity" "text" DEFAULT 'info'::"text", "p_reason" "text" DEFAULT NULL::"text", "p_source_module" "text" DEFAULT NULL::"text", "p_request_id" "text" DEFAULT NULL::"text", "p_previous_status" "text" DEFAULT NULL::"text", "p_new_status" "text" DEFAULT NULL::"text", "p_approval_level" "text" DEFAULT NULL::"text", "p_approval_comments" "text" DEFAULT NULL::"text", "p_delegated_authority" "text" DEFAULT NULL::"text", "p_limit_decision" "text" DEFAULT NULL::"text", "p_session_id" "text" DEFAULT NULL::"text", "p_auth_method" "text" DEFAULT NULL::"text", "p_attachment_ids" "uuid"[] DEFAULT NULL::"uuid"[], "p_import_batch_id" "uuid" DEFAULT NULL::"uuid", "p_external_ref" "text" DEFAULT NULL::"text", "p_related_journal_id" "uuid" DEFAULT NULL::"uuid", "p_related_payment_id" "uuid" DEFAULT NULL::"uuid", "p_project_id" "uuid" DEFAULT NULL::"uuid", "p_amount" numeric DEFAULT NULL::numeric, "p_amount_currency" "text" DEFAULT NULL::"text") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'audit', 'public'
    AS $$
DECLARE
  v_id UUID;
  v_role TEXT;
  v_org UUID;
  v_effective_user_id UUID;
  v_prev_hash TEXT;
  v_hash TEXT;
BEGIN
  -- Only service_role (no auth.uid(), acting on behalf of the system,
  -- e.g. edge functions) may log on behalf of an arbitrary user. Any
  -- authenticated caller may only log actions as themselves.
  IF auth.uid() IS NOT NULL AND p_user_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'audit.log_action: p_user_id must match the calling user';
  END IF;
  v_effective_user_id := COALESCE(p_user_id, auth.uid());

  SELECT r.name INTO v_role
  FROM core.user_roles ur JOIN core.roles r ON r.id = ur.role_id
  WHERE ur.user_id = v_effective_user_id AND ur.is_active = true
    AND (ur.effective_to IS NULL OR ur.effective_to >= CURRENT_DATE)
  ORDER BY ur.effective_from DESC LIMIT 1;

  SELECT organization_id INTO v_org
  FROM public.profiles WHERE user_id = v_effective_user_id;

  SELECT entry_hash INTO v_prev_hash
  FROM audit.audit_log ORDER BY created_at DESC, id DESC LIMIT 1;

  v_hash := encode(
    sha256(
      COALESCE(v_prev_hash, '') ||
      COALESCE(v_effective_user_id::TEXT, '') || COALESCE(p_action, '') ||
      COALESCE(p_entity_type, '') || COALESCE(p_entity_id::TEXT, '') ||
      COALESCE(p_description, '') || COALESCE(p_severity, 'info') || NOW()::TEXT
    ), 'hex'
  );

  INSERT INTO audit.audit_log (
    user_id, user_email, user_name, role_snapshot, organization_id, session_id, auth_method,
    action, entity_type, entity_id, status, severity,
    ip_address, user_agent, request_id,
    description, old_values, new_values, reason, approval_comments,
    previous_status, new_status, approval_level, delegated_authority, limit_decision,
    attachment_ids, import_batch_id, external_ref, related_journal_id, related_payment_id,
    project_id, amount, amount_currency,
    source_module, error_message, prev_hash, entry_hash
  ) VALUES (
    v_effective_user_id, p_user_email, p_user_name, v_role, v_org, p_session_id, p_auth_method,
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
$$;


ALTER FUNCTION "audit"."log_action"("p_user_id" "uuid", "p_user_email" "text", "p_user_name" "text", "p_action" "text", "p_entity_type" "text", "p_entity_id" "uuid", "p_description" "text", "p_old_values" "jsonb", "p_new_values" "jsonb", "p_ip_address" "inet", "p_user_agent" "text", "p_status" "text", "p_error_message" "text", "p_severity" "text", "p_reason" "text", "p_source_module" "text", "p_request_id" "text", "p_previous_status" "text", "p_new_status" "text", "p_approval_level" "text", "p_approval_comments" "text", "p_delegated_authority" "text", "p_limit_decision" "text", "p_session_id" "text", "p_auth_method" "text", "p_attachment_ids" "uuid"[], "p_import_batch_id" "uuid", "p_external_ref" "text", "p_related_journal_id" "uuid", "p_related_payment_id" "uuid", "p_project_id" "uuid", "p_amount" numeric, "p_amount_currency" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "audit"."log_ai_event"("p_user_id" "uuid", "p_user_email" "text" DEFAULT NULL::"text", "p_user_name" "text" DEFAULT NULL::"text", "p_action" "text" DEFAULT 'AI_QUERY'::"text", "p_status" "text" DEFAULT 'success'::"text", "p_severity" "text" DEFAULT 'info'::"text", "p_entity_type" "text" DEFAULT NULL::"text", "p_entity_id" "uuid" DEFAULT NULL::"uuid", "p_project_id" "uuid" DEFAULT NULL::"uuid", "p_ai_question" "text" DEFAULT NULL::"text", "p_ai_normalized_intent" "text" DEFAULT NULL::"text", "p_ai_selected_tool" "text" DEFAULT NULL::"text", "p_ai_generated_sql" "text" DEFAULT NULL::"text", "p_ai_template_id" "text" DEFAULT NULL::"text", "p_ai_row_count" integer DEFAULT NULL::integer, "p_ai_model" "text" DEFAULT NULL::"text", "p_ai_latency_ms" integer DEFAULT NULL::integer, "p_ai_cost_usd" numeric DEFAULT NULL::numeric, "p_ai_input_tokens" integer DEFAULT NULL::integer, "p_ai_output_tokens" integer DEFAULT NULL::integer, "p_ai_refusal_reason" "text" DEFAULT NULL::"text", "p_request_id" "text" DEFAULT NULL::"text", "p_ip_address" "inet" DEFAULT NULL::"inet", "p_user_agent" "text" DEFAULT NULL::"text") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'audit', 'public'
    AS $$
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
$$;


ALTER FUNCTION "audit"."log_ai_event"("p_user_id" "uuid", "p_user_email" "text", "p_user_name" "text", "p_action" "text", "p_status" "text", "p_severity" "text", "p_entity_type" "text", "p_entity_id" "uuid", "p_project_id" "uuid", "p_ai_question" "text", "p_ai_normalized_intent" "text", "p_ai_selected_tool" "text", "p_ai_generated_sql" "text", "p_ai_template_id" "text", "p_ai_row_count" integer, "p_ai_model" "text", "p_ai_latency_ms" integer, "p_ai_cost_usd" numeric, "p_ai_input_tokens" integer, "p_ai_output_tokens" integer, "p_ai_refusal_reason" "text", "p_request_id" "text", "p_ip_address" "inet", "p_user_agent" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "audit"."log_data_access_event"("p_user_id" "uuid" DEFAULT NULL::"uuid", "p_user_email" "text" DEFAULT NULL::"text", "p_accessed_entity_type" "text" DEFAULT NULL::"text", "p_accessed_entity_id" "uuid" DEFAULT NULL::"uuid", "p_access_type" "text" DEFAULT 'read'::"text", "p_access_granted" boolean DEFAULT true, "p_request_id" "text" DEFAULT NULL::"text") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'audit', 'public'
    AS $$
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
$$;


ALTER FUNCTION "audit"."log_data_access_event"("p_user_id" "uuid", "p_user_email" "text", "p_accessed_entity_type" "text", "p_accessed_entity_id" "uuid", "p_access_type" "text", "p_access_granted" boolean, "p_request_id" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "audit"."log_export_event"("p_user_id" "uuid" DEFAULT NULL::"uuid", "p_user_email" "text" DEFAULT NULL::"text", "p_user_name" "text" DEFAULT NULL::"text", "p_report_name" "text" DEFAULT NULL::"text", "p_report_type" "text" DEFAULT NULL::"text", "p_format" "text" DEFAULT 'csv'::"text", "p_filters" "jsonb" DEFAULT NULL::"jsonb", "p_row_count" integer DEFAULT NULL::integer, "p_file_size_bytes" integer DEFAULT NULL::integer) RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'audit', 'public'
    AS $$
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
$$;


ALTER FUNCTION "audit"."log_export_event"("p_user_id" "uuid", "p_user_email" "text", "p_user_name" "text", "p_report_name" "text", "p_report_type" "text", "p_format" "text", "p_filters" "jsonb", "p_row_count" integer, "p_file_size_bytes" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "audit"."log_security_event"("p_user_id" "uuid" DEFAULT NULL::"uuid", "p_user_email" "text" DEFAULT NULL::"text", "p_event_type" "text" DEFAULT NULL::"text", "p_success" boolean DEFAULT true, "p_details" "jsonb" DEFAULT NULL::"jsonb", "p_request_id" "text" DEFAULT NULL::"text") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'audit', 'public'
    AS $$
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
$$;


ALTER FUNCTION "audit"."log_security_event"("p_user_id" "uuid", "p_user_email" "text", "p_event_type" "text", "p_success" boolean, "p_details" "jsonb", "p_request_id" "text") OWNER TO "postgres";


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
    v_organization_id UUID;
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
        -- FIX (DB-022): was `WHERE id = v_user_id`; profiles.id is the
        -- profile row's own PK, not the auth user id. Must join on
        -- user_id, exactly as the organization_id lookup below already
        -- (correctly) does.
        SELECT email, full_name, organization_id INTO v_user_email, v_user_name, v_organization_id
        FROM public.profiles WHERE user_id = v_user_id;

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

    -- (unchanged from migration 039): prefer the audited row's own
    -- organization_id when the table being audited has one.
    BEGIN
        IF v_row ? 'organization_id' AND v_row->>'organization_id' IS NOT NULL THEN
            v_organization_id := (v_row->>'organization_id')::UUID;
        END IF;
    EXCEPTION WHEN OTHERS THEN NULL;
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
        user_id, user_email, user_name, role_snapshot, organization_id,
        action, entity_type, entity_id, status, severity,
        description, old_values, new_values, changed_columns,
        previous_status, new_status,
        project_id, amount, amount_currency,
        ip_address, user_agent,
        source_module, source_schema, source_table,
        table_schema, table_name, record_id, changed_by,
        prev_hash, entry_hash
    ) VALUES (
        v_user_id, v_user_email, v_user_name, v_role, v_organization_id,
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


ALTER FUNCTION "audit"."trigger_audit_log"() OWNER TO "postgres";


COMMENT ON FUNCTION "audit"."trigger_audit_log"() IS 'Migration 039: now populates audit_log.organization_id (prefers the audited row''s own organization_id, falls back to the acting user''s) so Finding 4.5''s org-scoped SELECT policies have data to filter on for all future events. No other behavior changed from the migration 030 version (same hash chaining, same columns).';



CREATE OR REPLACE FUNCTION "core"."block_legacy_table_write"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'pg_catalog', 'public'
    AS $$
BEGIN
  IF current_setting('app.allow_legacy_write', true) IS DISTINCT FROM 'true' THEN
    RAISE EXCEPTION
      'Table %.% is a legacy duplicate that is frozen (Compliance Audit Finding 2.2). Writes are blocked for every role, including service_role. If this is a deliberate, audited data-consolidation operation, run it inside a transaction that first executes: SET LOCAL app.allow_legacy_write = ''true'';',
      TG_TABLE_SCHEMA, TG_TABLE_NAME
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;


ALTER FUNCTION "core"."block_legacy_table_write"() OWNER TO "postgres";


COMMENT ON FUNCTION "core"."block_legacy_table_write"() IS 'Hard-freeze for known legacy duplicate tables (Compliance Audit Finding 2.2). Blocks INSERT/UPDATE/DELETE for every role, including service_role/BYPASSRLS roles, which RLS-only freezes cannot reach. Escape hatch: SET LOCAL app.allow_legacy_write = ''true'' for an explicit, audited consolidation script only.';



CREATE OR REPLACE FUNCTION "core"."can_approve_amount"("p_user_id" "uuid", "p_permission_code" "text", "p_transaction_type" "text", "p_amount" numeric, "p_currency" "text" DEFAULT 'PKR'::"text") RETURNS boolean
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'core', 'public'
    AS $$
DECLARE
  v_denied boolean;
  v_user_limit numeric;
  v_role_limit numeric;
  v_base_ok boolean;
BEGIN
  -- 1. Explicit per-user DENY override always wins.
  SELECT EXISTS (
    SELECT 1 FROM core.user_permission_overrides upo
    JOIN core.permissions p ON p.id = upo.permission_id
    WHERE upo.user_id = p_user_id
      AND p.code = p_permission_code
      AND upo.override_type = 'DENY'
      AND CURRENT_DATE >= upo.effective_from
      AND (upo.effective_to IS NULL OR upo.effective_to >= CURRENT_DATE)
  ) INTO v_denied;

  IF v_denied THEN
    RETURN false;
  END IF;

  -- 2. Base permission (role-based or explicit per-user ALLOW override).
  v_base_ok := core.has_permission(p_user_id, p_permission_code);
  IF NOT v_base_ok THEN
    SELECT EXISTS (
      SELECT 1 FROM core.user_permission_overrides upo
      JOIN core.permissions p ON p.id = upo.permission_id
      WHERE upo.user_id = p_user_id
        AND p.code = p_permission_code
        AND upo.override_type = 'ALLOW'
        AND CURRENT_DATE >= upo.effective_from
        AND (upo.effective_to IS NULL OR upo.effective_to >= CURRENT_DATE)
    ) INTO v_base_ok;
  END IF;

  IF NOT v_base_ok THEN
    RETURN false;
  END IF;

  -- 3. Most specific applicable limit wins: per-user transaction-type limit,
  --    then role-level transaction-type limit, then role_permissions.amount_limit.
  SELECT MIN(al.max_amount) INTO v_user_limit
  FROM core.approval_limits al
  WHERE al.user_id = p_user_id
    AND al.transaction_type = p_transaction_type
    AND al.currency = p_currency
    AND CURRENT_DATE >= al.effective_from
    AND (al.effective_to IS NULL OR al.effective_to >= CURRENT_DATE);

  IF v_user_limit IS NOT NULL AND p_amount > v_user_limit THEN
    RETURN false;
  END IF;

  IF v_user_limit IS NULL THEN
    SELECT MIN(al.max_amount) INTO v_role_limit
    FROM core.approval_limits al
    JOIN core.user_roles ur ON ur.role_id = al.role_id
    WHERE ur.user_id = p_user_id
      AND ur.is_active = true
      AND al.transaction_type = p_transaction_type
      AND al.currency = p_currency
      AND CURRENT_DATE >= al.effective_from
      AND (al.effective_to IS NULL OR al.effective_to >= CURRENT_DATE);

    IF v_role_limit IS NOT NULL AND p_amount > v_role_limit THEN
      RETURN false;
    END IF;
  END IF;

  -- 4. Fall back to the existing role_permissions.amount_limit check so this
  --    function is a strict superset, never a regression, of the existing
  --    has_permission_with_limit.
  RETURN core.has_permission_with_limit(p_user_id, p_permission_code, p_amount);
END;
$$;


ALTER FUNCTION "core"."can_approve_amount"("p_user_id" "uuid", "p_permission_code" "text", "p_transaction_type" "text", "p_amount" numeric, "p_currency" "text") OWNER TO "postgres";


COMMENT ON FUNCTION "core"."can_approve_amount"("p_user_id" "uuid", "p_permission_code" "text", "p_transaction_type" "text", "p_amount" numeric, "p_currency" "text") IS 'Composite approval check: DENY override > ALLOW override/role permission > per-user limit > per-role transaction-type limit > role_permissions.amount_limit (spec 7.2, 7.3).';



CREATE OR REPLACE FUNCTION "core"."current_user_id"() RETURNS "uuid"
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'core', 'public'
    AS $$ BEGIN
    RETURN auth.uid();
END;
 $$;


ALTER FUNCTION "core"."current_user_id"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "core"."current_user_org_config_id"() RETURNS "uuid"
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'core', 'public'
    AS $$
DECLARE
  v_config_id uuid;
BEGIN
  SELECT oc.id INTO v_config_id
  FROM core.organization_config oc
  WHERE oc.organization_id = core.current_user_org_id()
  LIMIT 1;

  RETURN v_config_id;
END;
$$;


ALTER FUNCTION "core"."current_user_org_config_id"() OWNER TO "postgres";


COMMENT ON FUNCTION "core"."current_user_org_config_id"() IS 'Returns the organization_config.id row belonging to the current user''s organization (via core.current_user_org_id() -> core.organization_config.organization_id). Added migration 031 (Compliance Audit R2) to replace the unscoped "SELECT id FROM organization_config LIMIT 1" pattern previously used in finance.tax_* RLS policies.';



CREATE OR REPLACE FUNCTION "core"."current_user_org_id"() RETURNS "uuid"
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'core', 'public'
    AS $$
DECLARE
  v_org_id uuid;
BEGIN
  SELECT organization_id INTO v_org_id
  FROM public.profiles
  WHERE user_id = auth.uid()
  LIMIT 1;

  RETURN v_org_id;
END;
$$;


ALTER FUNCTION "core"."current_user_org_id"() OWNER TO "postgres";


COMMENT ON FUNCTION "core"."current_user_org_id"() IS 'Returns the organization_id of the currently authenticated user, sourced from public.profiles.organization_id. Introduced in migration 027 to support organization-scoped RLS (Compliance Audit Finding 2.1). Returns NULL if the caller has no profile row or no organization assigned; policies built on this function must treat NULL as "no access", never as "all access" -- see core.same_org() below, which enforces that fail-closed behavior.';



CREATE OR REPLACE FUNCTION "core"."get_data_scope"("p_user_id" "uuid", "p_permission_code" "text") RETURNS "text"
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'core', 'public'
    AS $$ DECLARE
  v_scope TEXT := 'NONE';
BEGIN
  -- Return the broadest scope the user has for this permission
  SELECT rp.data_scope INTO v_scope
  FROM core.user_roles ur
  JOIN core.role_permissions rp ON rp.role_id = ur.role_id
  JOIN core.permissions p ON p.id = rp.permission_id
  WHERE ur.user_id = p_user_id
    AND p.code = p_permission_code
    AND ur.is_active = true
    AND (ur.effective_to IS NULL OR ur.effective_to >= CURRENT_DATE)
  ORDER BY 
    CASE rp.data_scope
      WHEN 'ALL' THEN 1
      WHEN 'DEPARTMENT' THEN 2
      WHEN 'PROJECT' THEN 3
      WHEN 'OWN' THEN 4
      ELSE 5
    END
  LIMIT 1;
  
  RETURN COALESCE(v_scope, 'NONE');
END;
 $$;


ALTER FUNCTION "core"."get_data_scope"("p_user_id" "uuid", "p_permission_code" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "core"."get_user_max_level"("p_user_id" "uuid") RETURNS integer
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'core', 'public'
    AS $$ DECLARE
  v_max_level INTEGER := 0;
BEGIN
  SELECT COALESCE(MAX(r.level), 0) INTO v_max_level
  FROM core.user_roles ur
  JOIN core.roles r ON r.id = ur.role_id
  WHERE ur.user_id = p_user_id
    AND ur.is_active = true
    AND (ur.effective_to IS NULL OR ur.effective_to >= CURRENT_DATE);
  
  RETURN v_max_level;
END;
 $$;


ALTER FUNCTION "core"."get_user_max_level"("p_user_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "core"."get_user_permissions"("p_user_id" "uuid") RETURNS TABLE("code" "text", "module" "text", "action" "text", "data_scope" "text", "amount_limit" numeric)
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'core', 'public'
    AS $$ BEGIN
  RETURN QUERY
  SELECT DISTINCT ON (p.code)
    p.code, p.module, p.action, rp.data_scope, rp.amount_limit
  FROM core.user_roles ur
  JOIN core.role_permissions rp ON rp.role_id = ur.role_id
  JOIN core.permissions p ON p.id = rp.permission_id
  WHERE ur.user_id = p_user_id
    AND ur.is_active = true
    AND (ur.effective_to IS NULL OR ur.effective_to >= CURRENT_DATE)
  ORDER BY p.code, 
    CASE rp.data_scope WHEN 'ALL' THEN 1 ELSE 2 END;
END;
 $$;


ALTER FUNCTION "core"."get_user_permissions"("p_user_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "core"."has_permission"("p_user_id" "uuid", "p_permission_code" "text") RETURNS boolean
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'core', 'public'
    AS $$ DECLARE
  v_result BOOLEAN;
BEGIN
  SELECT EXISTS (
    SELECT 1
    FROM core.user_roles ur
    JOIN core.role_permissions rp ON rp.role_id = ur.role_id
    JOIN core.permissions p ON p.id = rp.permission_id
    WHERE ur.user_id = p_user_id
      AND p.code = p_permission_code
      AND ur.is_active = true
      AND (ur.effective_to IS NULL OR ur.effective_to >= CURRENT_DATE)
      AND CURRENT_DATE >= rp.effective_from
      AND (rp.effective_to IS NULL OR rp.effective_to >= CURRENT_DATE)
  ) INTO v_result;
  
  RETURN v_result;
END;
 $$;


ALTER FUNCTION "core"."has_permission"("p_user_id" "uuid", "p_permission_code" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "core"."has_permission_with_limit"("p_user_id" "uuid", "p_permission_code" "text", "p_amount" numeric) RETURNS boolean
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'core', 'public'
    AS $$ DECLARE
  v_result BOOLEAN;
BEGIN
  SELECT EXISTS (
    SELECT 1
    FROM core.user_roles ur
    JOIN core.role_permissions rp ON rp.role_id = ur.role_id
    JOIN core.permissions p ON p.id = rp.permission_id
    WHERE ur.user_id = p_user_id
      AND p.code = p_permission_code
      AND ur.is_active = true
      AND (ur.effective_to IS NULL OR ur.effective_to >= CURRENT_DATE)
      AND CURRENT_DATE >= rp.effective_from
      AND (rp.effective_to IS NULL OR rp.effective_to >= CURRENT_DATE)
      -- CRITICAL: Check if amount is within limit (NULL means unlimited)
      AND (rp.amount_limit IS NULL OR rp.amount_limit >= p_amount)
  ) INTO v_result;
  
  RETURN v_result;
END;
 $$;


ALTER FUNCTION "core"."has_permission_with_limit"("p_user_id" "uuid", "p_permission_code" "text", "p_amount" numeric) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "core"."has_role"("p_role" "text") RETURNS boolean
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'core', 'public'
    AS $$
DECLARE
  v_has_configured_role BOOLEAN;
  v_legacy_role TEXT;
BEGIN
  SELECT EXISTS (
    SELECT 1
    FROM core.user_roles ur
    JOIN core.roles r ON r.id = ur.role_id
    WHERE ur.user_id = auth.uid()
      AND ur.is_active = true
      AND (ur.effective_to IS NULL OR ur.effective_to >= CURRENT_DATE)
      AND r.name = p_role
  ) INTO v_has_configured_role;

  IF v_has_configured_role THEN
    RETURN true;
  END IF;

  -- Fallback for users not yet represented in core.user_roles.
  IF NOT EXISTS (
    SELECT 1 FROM core.user_roles ur
    WHERE ur.user_id = auth.uid() AND ur.is_active = true
      AND (ur.effective_to IS NULL OR ur.effective_to >= CURRENT_DATE)
  ) THEN
    SELECT role INTO v_legacy_role FROM public.profiles WHERE user_id = auth.uid();
    RETURN COALESCE(v_legacy_role, 'VIEWER') = p_role;
  END IF;

  RETURN false;
END;
$$;


ALTER FUNCTION "core"."has_role"("p_role" "text") OWNER TO "postgres";


COMMENT ON FUNCTION "core"."has_role"("p_role" "text") IS 'Fixed 2026 (migration 018): now checks core.user_roles/core.roles first; falls back to public.profiles.role only for users not yet migrated. See audit issue C4/C7.';



CREATE OR REPLACE FUNCTION "core"."is_ceo_or_admin"() RETURNS boolean
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'core', 'public'
    AS $$ BEGIN
    RETURN core.has_role('CEO');
END;
$$;


ALTER FUNCTION "core"."is_ceo_or_admin"() OWNER TO "postgres";


COMMENT ON FUNCTION "core"."is_ceo_or_admin"() IS 'Fixed 2026 (migration 018): removed dead literal ''Admin'' which could never match profiles_role_check. See audit issue C7.';



CREATE OR REPLACE FUNCTION "core"."is_finance_head"() RETURNS boolean
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'core', 'public'
    AS $$ BEGIN
    RETURN core.has_role('CEO') OR core.has_role('FINANCE_HEAD');
END;
$$;


ALTER FUNCTION "core"."is_finance_head"() OWNER TO "postgres";


COMMENT ON FUNCTION "core"."is_finance_head"() IS 'Fixed 2026 (migration 018): removed dead literal ''HOD'' and added the correct ''FINANCE_HEAD'' check -- previously this function could NEVER return true for an actual Finance Head user. See audit issue C7.';



CREATE OR REPLACE FUNCTION "core"."same_org"("p_organization_id" "uuid") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'core', 'public'
    AS $$
  SELECT p_organization_id IS NOT NULL
     AND core.current_user_org_id() IS NOT NULL
     AND p_organization_id = core.current_user_org_id();
$$;


ALTER FUNCTION "core"."same_org"("p_organization_id" "uuid") OWNER TO "postgres";


COMMENT ON FUNCTION "core"."same_org"("p_organization_id" "uuid") IS 'True only when the supplied organization_id matches the caller''s own organization_id AND neither value is NULL. Deliberately fails closed (returns false, not true) when either side is NULL, to avoid accidentally granting access to unscoped rows during the transition period before every table has organization_id populated. Used by the RLS policies added in migration 030.';



CREATE OR REPLACE FUNCTION "core"."set_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$ BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
 $$;


ALTER FUNCTION "core"."set_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "core"."soft_delete"("p_schema" "text", "p_table" "text", "p_id" "uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'public'
    AS $_$
DECLARE
  v_org uuid := core.current_user_org_id();
  v_rows int;
BEGIN
  IF p_schema NOT IN ('finance', 'public') OR
     p_table NOT IN ('chart_of_accounts', 'vendors', 'clients', 'projects',
                      'platforms', 'financial_accounts') THEN
    RAISE EXCEPTION 'core.soft_delete: table %.% is not an approved soft-delete target', p_schema, p_table;
  END IF;

  IF v_org IS NULL THEN
    RAISE EXCEPTION 'core.soft_delete: caller has no resolvable organization';
  END IF;

  IF p_schema = 'public' AND p_table = 'financial_accounts' THEN
    UPDATE public.financial_accounts
    SET deleted_at = now(), deleted_by = auth.uid(), status = 'INACTIVE'
    WHERE id = p_id AND deleted_at IS NULL AND organization_id = v_org;
  ELSIF p_schema = 'public' AND p_table = 'projects' THEN
    UPDATE public.projects
    SET deleted_at = now(), deleted_by = auth.uid()
    WHERE id = p_id AND deleted_at IS NULL AND organization_id = v_org;
  ELSIF p_schema = 'public' AND p_table = 'clients' THEN
    UPDATE public.clients
    SET deleted_at = now(), deleted_by = auth.uid(), status = 'INACTIVE'
    WHERE id = p_id AND deleted_at IS NULL AND organization_id = v_org;
  ELSE
    EXECUTE format(
      'UPDATE %I.%I SET deleted_at = now(), deleted_by = auth.uid(), is_active = false WHERE id = $1 AND deleted_at IS NULL AND organization_id = $2',
      p_schema, p_table
    ) USING p_id, v_org;
  END IF;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows = 0 THEN
    RAISE EXCEPTION 'core.soft_delete: no matching row % in %.% for caller''s organization (already deleted, wrong org, or does not exist)', p_id, p_schema, p_table;
  END IF;
END;
$_$;


ALTER FUNCTION "core"."soft_delete"("p_schema" "text", "p_table" "text", "p_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "finance"."allocate_payment_atomic"("p_payment_receipt_id" "uuid", "p_allocations" "jsonb", "p_user_id" "uuid", "p_organization_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'finance', 'public'
    AS $$
DECLARE
  v_receipt finance.payment_receipts%ROWTYPE;
  v_total_existing numeric(18,2);
  v_total_new numeric(18,2);
  v_new_paid numeric(18,2);
  v_alloc jsonb;
  v_invoice public.invoices%ROWTYPE;
  v_existing uuid;
  v_created jsonb := '[]'::jsonb;
BEGIN
  IF p_user_id IS NULL OR p_organization_id IS NULL THEN
    RAISE EXCEPTION 'User and organization context are required';
  END IF;

  IF auth.uid() IS DISTINCT FROM p_user_id THEN
    RAISE EXCEPTION 'User context mismatch';
  END IF;

  IF NOT core.has_permission(p_user_id, 'APPROVE_INVOICE') THEN
    RAISE EXCEPTION 'Permission denied';
  END IF;

  SELECT * INTO v_receipt
  FROM finance.payment_receipts
  WHERE id = p_payment_receipt_id
    AND organization_id = p_organization_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Payment receipt not found';
  END IF;

  IF jsonb_typeof(p_allocations) <> 'array' OR jsonb_array_length(p_allocations) = 0 THEN
    RAISE EXCEPTION 'At least one allocation is required';
  END IF;

  SELECT COALESCE(SUM(pa.allocated_amount),0)
    INTO v_total_existing
  FROM finance.payment_allocations pa
  WHERE pa.payment_receipt_id = p_payment_receipt_id;

  v_total_new := 0;

  FOR v_alloc IN SELECT value FROM jsonb_array_elements(p_allocations)
  LOOP
    IF NULLIF(v_alloc->>'invoice_id','') IS NULL
       OR (v_alloc->>'amount') IS NULL THEN
      RAISE EXCEPTION 'Each allocation requires invoice_id and amount';
    END IF;

    IF (v_alloc->>'amount')::numeric <= 0 THEN
      RAISE EXCEPTION 'Allocation amount must be greater than zero';
    END IF;

    SELECT id INTO v_existing
    FROM finance.payment_allocations
    WHERE payment_receipt_id = p_payment_receipt_id
      AND invoice_id = (v_alloc->>'invoice_id')::uuid
    LIMIT 1;

    IF v_existing IS NOT NULL THEN
      RAISE EXCEPTION 'Invoice % is already allocated to this receipt', v_alloc->>'invoice_id';
    END IF;

    SELECT * INTO v_invoice
    FROM public.invoices
    WHERE id = (v_alloc->>'invoice_id')::uuid
      AND organization_id = p_organization_id
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Invoice % not found', v_alloc->>'invoice_id';
    END IF;

    IF v_invoice.client_id <> v_receipt.client_id THEN
      RAISE EXCEPTION 'Invoice % does not belong to the payment receipt client', v_invoice.invoice_number;
    END IF;

    IF (v_alloc->>'amount')::numeric >
       (COALESCE(v_invoice.total_amount,0) - COALESCE(v_invoice.amount_paid,0)) THEN
      RAISE EXCEPTION 'Allocation exceeds outstanding amount for invoice %', v_invoice.invoice_number;
    END IF;

    v_total_new := v_total_new + (v_alloc->>'amount')::numeric;
  END LOOP;

  IF v_total_existing + v_total_new > v_receipt.amount + 0.01 THEN
    RAISE EXCEPTION 'Total allocation exceeds payment receipt amount';
  END IF;

  FOR v_alloc IN SELECT value FROM jsonb_array_elements(p_allocations)
  LOOP
    INSERT INTO finance.payment_allocations (
      payment_receipt_id, invoice_id, allocated_amount,
      base_allocated_amount, allocated_by
    ) VALUES (
      p_payment_receipt_id,
      (v_alloc->>'invoice_id')::uuid,
      (v_alloc->>'amount')::numeric,
      (v_alloc->>'amount')::numeric * COALESCE(v_receipt.exchange_rate,1),
      p_user_id
    )
    RETURNING id INTO v_existing;

    v_created := v_created || jsonb_build_array(jsonb_build_object(
      'id', v_existing,
      'invoice_id', v_alloc->>'invoice_id',
      'amount', (v_alloc->>'amount')::numeric
    ));

    UPDATE public.invoices
    SET amount_paid = COALESCE(amount_paid,0) + (v_alloc->>'amount')::numeric,
        status = CASE
          WHEN COALESCE(amount_paid,0) + (v_alloc->>'amount')::numeric >= total_amount
            THEN 'PAID'
          ELSE 'PARTIALLY_PAID'
        END
    WHERE id = (v_alloc->>'invoice_id')::uuid
      AND organization_id = p_organization_id;
  END LOOP;

  v_new_paid := v_total_existing + v_total_new;

  UPDATE finance.payment_receipts
  SET updated_at = now()
  WHERE id = p_payment_receipt_id
    AND organization_id = p_organization_id;

  RETURN jsonb_build_object(
    'success', true,
    'total_allocated', v_total_new,
    'total_allocated_after', v_new_paid,
    'remaining_unallocated', GREATEST(v_receipt.amount - v_new_paid, 0),
    'receipt_status', CASE
      WHEN v_new_paid >= v_receipt.amount - 0.01 THEN 'FULLY_ALLOCATED'
      ELSE 'PARTIALLY_ALLOCATED'
    END,
    'allocations', v_created
  );
END;
$$;


ALTER FUNCTION "finance"."allocate_payment_atomic"("p_payment_receipt_id" "uuid", "p_allocations" "jsonb", "p_user_id" "uuid", "p_organization_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "finance"."approve_and_post_journal_entry"("p_journal_id" "uuid") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'finance', 'core', 'public'
    AS $$
DECLARE
  v_status TEXT;
  v_source_type TEXT;
  v_org_id UUID;
BEGIN
  IF NOT (core.is_finance_head() OR core.has_role('ACCOUNTANT')) THEN
    RAISE EXCEPTION 'Only Finance Head or Accountant may approve and post a journal entry';
  END IF;

  SELECT status, source_type, organization_id INTO v_status, v_source_type, v_org_id
  FROM finance.journal_entries WHERE id = p_journal_id FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Journal entry % not found', p_journal_id;
  END IF;

  -- P1_060 SECURITY FIX (ISS-02, Critical): verify the journal entry belongs
  -- to the caller's own organization before approving/posting it.
  IF NOT core.same_org(v_org_id) THEN
    RAISE EXCEPTION 'Access denied: journal entry % does not belong to your organization', p_journal_id;
  END IF;

  IF v_status <> 'DRAFT' THEN
    RAISE EXCEPTION 'Journal entry % is not in DRAFT status (current: %)', p_journal_id, v_status;
  END IF;

  IF COALESCE(v_source_type, 'MANUAL') <> 'MANUAL' THEN
    RAISE EXCEPTION 'System-sourced journal entries post automatically and cannot be approved through this function';
  END IF;

  -- The trg_maker_checker + trg_prevent_closed_period_posting triggers on
  -- finance.journal_entries, and trg_check_journal_balance on
  -- finance.journal_lines, all fire on this UPDATE and enforce their rules.
  UPDATE finance.journal_entries
  SET status = 'POSTED',
      submitted_by = COALESCE(submitted_by, auth.uid()),
      submitted_at = COALESCE(submitted_at, NOW()),
      verified_by = COALESCE(verified_by, auth.uid()),
      verified_at = COALESCE(verified_at, NOW()),
      approved_by = auth.uid(),
      approved_at = NOW(),
      posted_by = auth.uid(),
      posted_at = NOW(),
      posting_date = CURRENT_DATE
  WHERE id = p_journal_id;

  RETURN p_journal_id;
END;
$$;


ALTER FUNCTION "finance"."approve_and_post_journal_entry"("p_journal_id" "uuid") OWNER TO "postgres";


COMMENT ON FUNCTION "finance"."approve_and_post_journal_entry"("p_journal_id" "uuid") IS 'P1_060 SECURITY FIX (ISS-02, Critical): added organization-match check (this function already had the correct Finance Head/Accountant role check from migration 029; only the organization-scoping was missing). Completes the maker-checker approval + posting step for a MANUAL journal left in DRAFT by finance.post_journal_entry(). Enforces creator <> approver via trg_maker_checker.';



CREATE OR REPLACE FUNCTION "finance"."auto_match_statement_lines"("p_statement_id" "uuid") RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'finance', 'public'
    AS $$
DECLARE
    v_matched INTEGER := 0;
    v_ledger UUID;
    v_row_count INTEGER;
BEGIN
    SELECT fa.linked_ledger_account_id INTO v_ledger
    FROM finance.bank_statements bs JOIN finance.financial_accounts fa ON fa.id = bs.financial_account_id
    WHERE bs.id = p_statement_id;
    IF v_ledger IS NULL THEN RAISE EXCEPTION 'Statement not found'; END IF;

    -- Round 1: exact amount + same date
    UPDATE finance.statement_lines sl SET
        reconciliation_status = 'MATCHED', matched_journal_line_id = jl.id,
        matched_at = NOW(), matched_by = auth.uid(), match_method = 'AUTO_AMOUNT_DATE'
    FROM finance.journal_lines jl JOIN finance.journal_entries je ON je.id = jl.journal_entry_id
    WHERE sl.bank_statement_id = p_statement_id AND sl.reconciliation_status = 'UNRECONCILED'
      AND jl.account_id = v_ledger AND je.status = 'POSTED'  --  FIXED: uppercase
      AND jl.id NOT IN (SELECT matched_journal_line_id FROM finance.statement_lines WHERE matched_journal_line_id IS NOT NULL AND reconciliation_status IN ('MATCHED','MANUAL_MATCH'))
      AND sl.transaction_date = je.transaction_date
      AND ((sl.amount > 0 AND jl.debit_amount = sl.amount) OR (sl.amount < 0 AND jl.credit_amount = ABS(sl.amount)));
    GET DIAGNOSTICS v_row_count = ROW_COUNT;
    v_matched := v_matched + v_row_count;

    -- Round 2: exact amount + reference match (±3 days)
    UPDATE finance.statement_lines sl SET
        reconciliation_status = 'MATCHED', matched_journal_line_id = jl.id,
        matched_at = NOW(), matched_by = auth.uid(), match_method = 'AUTO_AMOUNT_REF'
    FROM finance.journal_lines jl JOIN finance.journal_entries je ON je.id = jl.journal_entry_id
    WHERE sl.bank_statement_id = p_statement_id AND sl.reconciliation_status = 'UNRECONCILED'
      AND sl.reference IS NOT NULL AND sl.reference != ''
      AND jl.account_id = v_ledger AND je.status = 'POSTED'  --  FIXED: uppercase
      AND jl.id NOT IN (SELECT matched_journal_line_id FROM finance.statement_lines WHERE matched_journal_line_id IS NOT NULL AND reconciliation_status IN ('MATCHED','MANUAL_MATCH'))
      AND sl.transaction_date BETWEEN je.transaction_date - 3 AND je.transaction_date + 3
      AND je.description ILIKE '%' || sl.reference || '%'
      AND ((sl.amount > 0 AND jl.debit_amount = sl.amount) OR (sl.amount < 0 AND jl.credit_amount = ABS(sl.amount)));
    GET DIAGNOSTICS v_row_count = ROW_COUNT;
    v_matched := v_matched + v_row_count;

    -- Round 3: exact amount only (±7 days)
    UPDATE finance.statement_lines sl SET
        reconciliation_status = 'MATCHED', matched_journal_line_id = jl.id,
        matched_at = NOW(), matched_by = auth.uid(), match_method = 'AUTO_AMOUNT_DESC'
    FROM finance.journal_lines jl JOIN finance.journal_entries je ON je.id = jl.journal_entry_id
    WHERE sl.bank_statement_id = p_statement_id AND sl.reconciliation_status = 'UNRECONCILED'
      AND jl.account_id = v_ledger AND je.status = 'POSTED'  --  FIXED: uppercase
      AND jl.id NOT IN (SELECT matched_journal_line_id FROM finance.statement_lines WHERE matched_journal_line_id IS NOT NULL AND reconciliation_status IN ('MATCHED','MANUAL_MATCH'))
      AND sl.transaction_date BETWEEN je.transaction_date - 7 AND je.transaction_date + 7
      AND ((sl.amount > 0 AND jl.debit_amount = sl.amount) OR (sl.amount < 0 AND jl.credit_amount = ABS(sl.amount)));
    GET DIAGNOSTICS v_row_count = ROW_COUNT;
    v_matched := v_matched + v_row_count;

    -- Round 4: by transaction_identifier
    UPDATE finance.statement_lines sl SET
        reconciliation_status = 'MATCHED', matched_journal_line_id = jl.id,
        matched_at = NOW(), matched_by = auth.uid(), match_method = 'AUTO_IDENTIFIER'
    FROM finance.journal_lines jl JOIN finance.journal_entries je ON je.id = jl.journal_entry_id
    WHERE sl.bank_statement_id = p_statement_id AND sl.reconciliation_status = 'UNRECONCILED'
      AND sl.transaction_identifier IS NOT NULL AND sl.transaction_identifier != ''
      AND jl.account_id = v_ledger AND je.status = 'POSTED'  --  FIXED: uppercase
      AND jl.id NOT IN (SELECT matched_journal_line_id FROM finance.statement_lines WHERE matched_journal_line_id IS NOT NULL AND reconciliation_status IN ('MATCHED','MANUAL_MATCH'))
      AND je.reference ILIKE '%' || sl.transaction_identifier || '%';
    GET DIAGNOSTICS v_row_count = ROW_COUNT;
    v_matched := v_matched + v_row_count;

    RETURN v_matched;
END;
$$;


ALTER FUNCTION "finance"."auto_match_statement_lines"("p_statement_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "finance"."auto_update_bill_status"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'finance', 'public'
    AS $$ 
DECLARE
  v_bill_id UUID;
  v_outstanding NUMERIC(18,2);
  v_total NUMERIC(18,2);
  v_current_status TEXT;
BEGIN
  v_bill_id := COALESCE(NEW.vendor_bill_id, OLD.vendor_bill_id);

  SELECT 
    vb.total_amount - COALESCE(SUM(vpa.allocated_amount), 0)
  INTO v_outstanding
  FROM finance.vendor_bills vb
  LEFT JOIN finance.vendor_payment_allocations vpa ON vpa.vendor_bill_id = vb.id
  WHERE vb.id = v_bill_id
  GROUP BY vb.total_amount;
  
  SELECT total_amount, status INTO v_total, v_current_status 
  FROM finance.vendor_bills WHERE id = v_bill_id;
  
  -- ✅ Sirf POSTED/PARTIALLY_PAID bills ka status update karo, DRAFT/CANCELLED ko mat chhedo
  UPDATE finance.vendor_bills SET 
    amount_paid = v_total - v_outstanding,
    outstanding_amount = v_outstanding,
    status = CASE 
      WHEN v_current_status NOT IN ('POSTED', 'PARTIALLY_PAID') THEN v_current_status
      WHEN v_outstanding <= 0 THEN 'PAID'
      WHEN v_outstanding < v_total THEN 'PARTIALLY_PAID'
      ELSE v_current_status
    END
  WHERE id = v_bill_id;
  
  RETURN COALESCE(NEW, OLD);
END;
 $$;


ALTER FUNCTION "finance"."auto_update_bill_status"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "finance"."auto_update_invoice_status"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'finance', 'public'
    AS $$
DECLARE
  v_outstanding      NUMERIC(18,2);
  v_base_outstanding NUMERIC(18,2);
  v_total            NUMERIC(18,2);
  v_base_total        NUMERIC(18,2);
BEGIN
  -- Calculate outstanding (original currency and base/PKR currency)
  SELECT
    i.total_amount - COALESCE(SUM(pa.allocated_amount), 0),
    i.base_total_amount - COALESCE(SUM(pa.base_allocated_amount), 0),
    i.total_amount,
    i.base_total_amount
  INTO v_outstanding, v_base_outstanding, v_total, v_base_total
  FROM public.invoices i
  LEFT JOIN finance.payment_allocations pa ON pa.invoice_id = i.id
  WHERE i.id = NEW.invoice_id
  GROUP BY i.total_amount, i.base_total_amount;

  UPDATE public.invoices SET
    amount_paid              = v_total - v_outstanding,
    base_amount_paid         = v_base_total - v_base_outstanding,   -- FIXED (was always 0)
    outstanding_amount       = v_outstanding,
    base_outstanding_amount  = v_base_outstanding,
    status = CASE
      WHEN v_outstanding <= 0 THEN 'PAID'
      WHEN v_outstanding < v_total THEN 'PARTIALLY_PAID'
      ELSE status
    END
  WHERE id = NEW.invoice_id;

  RETURN NEW;
END;
$$;


ALTER FUNCTION "finance"."auto_update_invoice_status"() OWNER TO "postgres";


COMMENT ON FUNCTION "finance"."auto_update_invoice_status"() IS 'Fixed 2026: base_amount_paid previously always computed as 0 due to variable reuse. See migration 016.';



CREATE OR REPLACE FUNCTION "finance"."check_journal_balance"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
DECLARE
  v_journal_id uuid;
  v_total_debit numeric(18,2);
  v_total_credit numeric(18,2);
  v_total_base_debit numeric(18,2);
  v_total_base_credit numeric(18,2);
  v_line_count integer;
  v_status text;
BEGIN
  v_journal_id := COALESCE(NEW.journal_entry_id, OLD.journal_entry_id);

  SELECT
    COALESCE(SUM(debit_amount), 0),
    COALESCE(SUM(credit_amount), 0),
    COALESCE(SUM(COALESCE(base_debit, debit_amount)), 0),
    COALESCE(SUM(COALESCE(base_credit, credit_amount)), 0),
    COUNT(*)
  INTO
    v_total_debit, v_total_credit, v_total_base_debit, v_total_base_credit, v_line_count
  FROM finance.journal_lines
  WHERE journal_entry_id = v_journal_id;

  IF v_total_debit <> v_total_credit THEN
    RAISE EXCEPTION
      'Journal entry % is unbalanced in transaction currency: debit % != credit %',
      v_journal_id, v_total_debit, v_total_credit
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_total_base_debit <> v_total_base_credit THEN
    RAISE EXCEPTION
      'Journal entry % is unbalanced in base (PKR) currency: base debit % != base credit %',
      v_journal_id, v_total_base_debit, v_total_base_credit
      USING ERRCODE = 'check_violation';
  END IF;

  -- Only require >= 2 lines once the entry is (or is being) POSTED --
  -- DRAFT entries are allowed to be built up line by line.
  SELECT status INTO v_status FROM finance.journal_entries WHERE id = v_journal_id;
  IF v_status = 'POSTED' AND v_line_count < 2 THEN
    RAISE EXCEPTION
      'Journal entry % cannot be POSTED with fewer than 2 lines (has %)',
      v_journal_id, v_line_count
      USING ERRCODE = 'check_violation';
  END IF;

  UPDATE finance.journal_entries
  SET total_debit = v_total_debit,
      total_credit = v_total_credit
  WHERE id = v_journal_id;

  RETURN NULL;
END;
$$;


ALTER FUNCTION "finance"."check_journal_balance"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "finance"."compute_platform_fee"("p_platform_id" "uuid", "p_amount" numeric, "p_source_type" character varying DEFAULT 'EXPENSE'::character varying) RETURNS numeric
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'finance', 'public'
    AS $$
DECLARE
  v_fee NUMERIC(18,4) := 0;
  v_rule RECORD;
  v_tiers RECORD;
  v_remaining NUMERIC(18,4);
  v_tier_min NUMERIC(18,4);
  v_tier_max NUMERIC(18,4);
BEGIN
  -- Get the highest-priority active rule for this platform
  SELECT * INTO v_rule
  FROM finance.fee_rules
  WHERE platform_id = p_platform_id
    AND is_active = true
    AND (applies_to = 'ALL' OR applies_to = p_source_type)
    AND (effective_from IS NULL OR effective_from <= CURRENT_DATE)
    AND (effective_to IS NULL OR effective_to >= CURRENT_DATE)
  ORDER BY priority DESC
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN 0;
  END IF;

  -- PERCENTAGE: fee = amount * fee_value / 100
  IF v_rule.fee_type = 'PERCENTAGE' THEN
    v_fee := p_amount * v_rule.fee_value / 100;
    IF v_rule.min_fee > 0 AND v_fee < v_rule.min_fee THEN v_fee := v_rule.min_fee; END IF;
    IF v_rule.max_fee > 0 AND v_fee > v_rule.max_fee THEN v_fee := v_rule.max_fee; END IF;

  -- FIXED: flat fee
  ELSIF v_rule.fee_type = 'FIXED' THEN
    v_fee := v_rule.fee_value;

  -- TIERED: graduated calculation
  ELSIF v_rule.fee_type = 'TIERED' THEN
    v_remaining := p_amount;
    FOR v_tiers IN (
      SELECT * FROM finance.fee_tiers 
      WHERE fee_rule_id = v_rule.id 
      ORDER BY tier_from ASC
    ) LOOP
      v_tier_min := v_tiers.tier_from;
      v_tier_max := CASE WHEN v_tiers.tier_to = 0 THEN p_amount ELSE LEAST(v_tiers.tier_to, p_amount) END;
      
      IF v_remaining <= 0 THEN EXIT; END IF;
      
      DECLARE
        v_tierable NUMERIC(18,4);
      BEGIN
        v_tierable := LEAST(GREATEST(v_remaining, 0), v_tier_max - v_tier_min);
        IF v_tierable > 0 THEN
          v_fee := v_fee + (v_tierable * v_tiers.fee_percent / 100) + v_tiers.fee_fixed;
          v_remaining := v_remaining - v_tierable;
        END IF;
      END;
    END LOOP;

  -- SLAB: find the matching slab
  ELSIF v_rule.fee_type = 'SLAB' THEN
    SELECT (p_amount * fee_percent / 100) + fee_fixed INTO v_fee
    FROM finance.fee_tiers
    WHERE fee_rule_id = v_rule.id
      AND p_amount >= tier_from
      AND (tier_to = 0 OR p_amount < tier_to)
    ORDER BY tier_from DESC
    LIMIT 1;
  END IF;

  -- Log the computation
  INSERT INTO finance.fee_computation_log (
    source_type, platform_id, fee_rule_id, base_amount, fee_amount
  ) VALUES (
    p_source_type, p_platform_id, v_rule.id, p_amount, COALESCE(v_fee, 0)
  );

  RETURN COALESCE(v_fee, 0);
END;
$$;


ALTER FUNCTION "finance"."compute_platform_fee"("p_platform_id" "uuid", "p_amount" numeric, "p_source_type" character varying) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "finance"."compute_tax_liability"("p_tax_recon_id" "uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'finance', 'public'
    AS $$
DECLARE
    v_recon RECORD;
    v_pbt NUMERIC(18,2) := 0;
    v_total_adj NUMERIC(18,2) := 0;
    v_taxable_income NUMERIC(18,2);
    v_gross_tax NUMERIC(18,2) := 0;
    v_remaining_income NUMERIC(18,2);
    v_slab_income NUMERIC(18,2);
    v_slab RECORD;
    v_rule_status TEXT;
BEGIN
    SELECT * INTO v_recon FROM finance.tax_reconciliations WHERE id = p_tax_recon_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Tax reconciliation not found'; END IF;

    SELECT status INTO v_rule_status FROM finance.tax_rule_sets WHERE id = v_recon.tax_rule_set_id;
    IF v_rule_status IS NULL THEN RAISE EXCEPTION 'Tax rule set not found'; END IF;
    IF v_rule_status NOT IN ('APPROVED', 'LOCKED') THEN
        RAISE EXCEPTION 'Tax rule set must be APPROVED or LOCKED, current: %', v_rule_status;
    END IF;

    --  FIXED: PBT = Revenue Net - Expense Net
    -- Revenue Net = credit - debit (revenue increases on credit side)
    -- Expense Net = debit - credit (expenses increase on debit side)
    SELECT
        COALESCE(SUM(CASE WHEN coa.account_type IN ('REVENUE','OTHER_INCOME')
                          THEN jl.credit_amount - jl.debit_amount ELSE 0 END), 0)
        -
        COALESCE(SUM(CASE WHEN coa.account_type IN ('OTHER_EXPENSE','OPERATING_EXPENSE','COST_OF_SALES')
                          THEN jl.debit_amount - jl.credit_amount ELSE 0 END), 0)
    INTO v_pbt
    FROM finance.journal_lines jl
    JOIN finance.journal_entries je ON je.id = jl.journal_entry_id
    JOIN finance.chart_of_accounts coa ON coa.id = jl.account_id
    JOIN finance.accounting_periods ap ON ap.id = je.period_id
    WHERE ap.fiscal_year_id = v_recon.fiscal_year_id
      AND je.status = 'POSTED'
      AND coa.account_type IN ('REVENUE','COST_OF_SALES','OPERATING_EXPENSE','OTHER_INCOME','OTHER_EXPENSE');

    -- Sum adjustments
    SELECT COALESCE(SUM(amount), 0) INTO v_total_adj
    FROM finance.tax_adjustments
    WHERE tax_reconciliation_id = p_tax_recon_id;

    v_taxable_income := v_pbt + v_total_adj;

    -- Apply Tax Slabs progressively
    v_remaining_income := v_taxable_income;

    FOR v_slab IN
        SELECT * FROM finance.tax_slabs
        WHERE tax_rule_set_id = v_recon.tax_rule_set_id
        ORDER BY sort_order ASC, income_from ASC
    LOOP
        IF v_remaining_income <= 0 THEN EXIT; END IF;

        v_slab_income := LEAST(
            v_remaining_income,
            COALESCE(v_slab.income_to, 999999999999) - v_slab.income_from + 1
        );
        v_slab_income := GREATEST(v_slab_income, 0);

        v_gross_tax := v_gross_tax + (v_slab_income * v_slab.tax_rate / 100.0) + v_slab.fixed_amount;
        v_remaining_income := v_remaining_income - v_slab_income;
    END LOOP;

    UPDATE finance.tax_reconciliations SET
         accounting_profit_before_tax = v_pbt,
        taxable_income = v_taxable_income,
        gross_tax_liability = v_gross_tax,
        net_tax_payable = GREATEST(v_gross_tax - v_recon.withholding_credits - v_recon.advance_tax_credits - v_recon.other_tax_credits, 0),
        profit_after_tax = v_pbt - GREATEST(v_gross_tax - v_recon.withholding_credits - v_recon.advance_tax_credits - v_recon.other_tax_credits, 0),
        effective_tax_rate = CASE 
            WHEN v_pbt > 0 
            THEN ROUND(GREATEST(v_gross_tax - v_recon.withholding_credits - v_recon.advance_tax_credits - v_recon.other_tax_credits, 0) / v_pbt * 100, 2) 
            ELSE 0 
        END,
        status = 'CALCULATED',
        updated_at = NOW()
    WHERE id = p_tax_recon_id;
END;
 $$;


ALTER FUNCTION "finance"."compute_tax_liability"("p_tax_recon_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "finance"."create_fiscal_year_with_periods"("p_name" "text", "p_start_date" "date", "p_end_date" "date", "p_description" "text" DEFAULT NULL::"text", "p_created_by" "uuid" DEFAULT NULL::"uuid") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'finance', 'public'
    AS $$ 
DECLARE
    v_fy_id UUID;
    v_month_count INTEGER;
    v_user_id UUID;  -- ✅ FIX: Declare variable
BEGIN
    -- ✅ FIX: Resolve user ID from multiple sources
    v_user_id := COALESCE(
        p_created_by,
        auth.uid(),
        NULL
    );

    -- ✅ FIX: Set session variable so audit triggers can read it
    IF v_user_id IS NOT NULL THEN
        PERFORM set_config('app.current_user_id', v_user_id::TEXT, true);
    END IF;

    -- Validate dates
    IF p_end_date <= p_start_date THEN
        RAISE EXCEPTION 'End date must be after start date';
    END IF;
    
    -- Calculate months
    v_month_count := (EXTRACT(YEAR FROM p_end_date) - EXTRACT(YEAR FROM p_start_date)) * 12 
                   + EXTRACT(MONTH FROM p_end_date) - EXTRACT(MONTH FROM p_start_date) + 1;
    
    IF v_month_count < 1 THEN
        RAISE EXCEPTION 'Must be at least 1 month long';
    END IF;
    
    IF v_month_count > 24 THEN
        RAISE EXCEPTION 'Cannot exceed 24 months';
    END IF;
    
    -- Check for overlapping fiscal years
    IF EXISTS (
        SELECT 1 FROM finance.fiscal_years 
        WHERE p_start_date < end_date AND p_end_date > start_date
    ) THEN
        RAISE EXCEPTION 'Overlaps with an existing fiscal year';
    END IF;
    
    -- Create fiscal year
    INSERT INTO finance.fiscal_years (name, start_date, end_date, description, created_by)
    VALUES (p_name, p_start_date, p_end_date, p_description, v_user_id)  -- ✅ FIX: Use v_user_id
    RETURNING id INTO v_fy_id;
    
    -- Create periods with PENDING status
    INSERT INTO finance.accounting_periods (fiscal_year_id, period_number, name, start_date, end_date, status, created_by)
    SELECT 
        v_fy_id,
        gs.period_num,
        TO_CHAR(gs.month_start, 'Month YYYY'),
        gs.month_start,
        LEAST(
            (gs.month_start + INTERVAL '1 month' - INTERVAL '1 day')::date,
            p_end_date
        ),
        'PENDING',
        v_user_id  -- ✅ FIX: Removed duplicate p_created_by
    FROM (
        SELECT 
            generate_series(1, v_month_count) AS period_num,
            (p_start_date + (generate_series(1, v_month_count) - 1) * INTERVAL '1 month')::date AS month_start
    ) gs;
    
    RETURN v_fy_id;
END;
 $$;


ALTER FUNCTION "finance"."create_fiscal_year_with_periods"("p_name" "text", "p_start_date" "date", "p_end_date" "date", "p_description" "text", "p_created_by" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "finance"."detect_duplicate_statement_lines"("p_statement_id" "uuid") RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'finance', 'public'
    AS $$ DECLARE v_count INT;
BEGIN
    UPDATE finance.statement_lines sl SET reconciliation_status = 'DUPLICATE', exclusion_reason = 'Auto-detected duplicate'
    WHERE sl.bank_statement_id = p_statement_id AND sl.reconciliation_status = 'UNRECONCILED'
      AND EXISTS (
          SELECT 1 FROM finance.statement_lines sl2
          JOIN finance.bank_statements bs2 ON bs2.id = sl2.bank_statement_id
          WHERE bs2.financial_account_id = (SELECT financial_account_id FROM finance.bank_statements WHERE id = p_statement_id)
            AND sl2.id != sl.id AND sl2.amount = sl.amount AND sl2.transaction_date = sl.transaction_date
            AND (sl2.description = sl.description OR SIMILARITY(sl2.description, sl.description) > 0.85)
            AND sl2.reconciliation_status NOT IN ('DUPLICATE','EXCLUDED')
      );
    GET DIAGNOSTICS v_count = ROW_COUNT;
    RETURN v_count;
END;
 $$;


ALTER FUNCTION "finance"."detect_duplicate_statement_lines"("p_statement_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "finance"."enforce_base_amounts_on_post"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM finance.journal_entries je
    WHERE je.id = NEW.journal_entry_id AND je.status = 'POSTED'
  ) AND (NEW.base_debit IS NULL OR NEW.base_credit IS NULL) THEN
    RAISE EXCEPTION 'journal_lines.base_debit/base_credit must be set before a journal entry can be POSTED (line %)', NEW.id;
  END IF;
  RETURN NEW;
END;
$$;


ALTER FUNCTION "finance"."enforce_base_amounts_on_post"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "finance"."enforce_expense_line_org"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'pg_catalog', 'finance', 'public'
    AS $$
DECLARE v_org uuid;
BEGIN
  SELECT organization_id INTO v_org FROM public.expenses WHERE id = NEW.expense_id;
  IF v_org IS NULL OR NEW.organization_id IS DISTINCT FROM v_org THEN
    RAISE EXCEPTION 'Expense line organization does not match parent expense';
  END IF;
  RETURN NEW;
END;
$$;


ALTER FUNCTION "finance"."enforce_expense_line_org"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "finance"."enforce_invoice_line_org"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'pg_catalog', 'finance', 'public'
    AS $$
DECLARE v_org uuid;
BEGIN
  SELECT organization_id INTO v_org FROM public.invoices WHERE id = NEW.invoice_id;
  IF v_org IS NULL OR NEW.organization_id IS DISTINCT FROM v_org THEN
    RAISE EXCEPTION 'Invoice line organization does not match parent invoice';
  END IF;
  RETURN NEW;
END;
$$;


ALTER FUNCTION "finance"."enforce_invoice_line_org"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "finance"."enforce_maker_checker"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'finance', 'public'
    AS $$
DECLARE
  v_creator_id UUID;
  v_approver_id UUID;
  v_second_approver_id UUID;
  v_table TEXT;
  v_schema TEXT;
BEGIN
  v_table := TG_TABLE_NAME;
  v_schema := TG_TABLE_SCHEMA;

  -- Get creator and approver IDs based on table
  -- public.expenses, public.incomes, public.invoices use `user_id` as creator
  -- finance.vendor_bills, finance.journal_entries use `created_by` as creator
  -- P1_060 (ISS-09, Medium): finance.bank_transfers and
  -- finance.profit_distributions added -- both are spec-flagged (5.8, 5.13)
  -- as requiring dual/maker-checker approval and were previously not wired
  -- to this trigger at all.
  IF v_table IN ('expenses', 'incomes', 'invoices') THEN
    v_creator_id := COALESCE(OLD.user_id, NEW.user_id);
    v_approver_id := NEW.approved_by;
  ELSIF v_table IN ('vendor_bills', 'journal_entries') THEN
    v_creator_id := COALESCE(OLD.created_by, NEW.created_by);
    v_approver_id := NEW.approved_by;
  ELSIF v_table = 'bank_transfers' THEN
    v_creator_id := COALESCE(OLD.created_by, NEW.created_by);
    v_approver_id := NEW.approved_by;
    v_second_approver_id := NEW.second_approved_by;
  ELSIF v_table = 'profit_distributions' THEN
    v_creator_id := COALESCE(OLD.declared_by, NEW.declared_by);
    v_approver_id := NEW.approved_by;
  ELSE
    RETURN NEW;
  END IF;

  -- Enforce: creator cannot be the approver
  IF v_approver_id IS NOT NULL AND v_creator_id IS NOT NULL AND v_approver_id = v_creator_id THEN
    RAISE EXCEPTION 'MAKER_CHECKER_VIOLATION: Creator (user %) cannot approve their own record in %',
      v_creator_id, v_table;
  END IF;

  -- P1_060 (ISS-09): bank_transfers additionally supports a documented
  -- second/dual approver (second_approved_by). Enforce that the second
  -- approver is distinct from both the creator and the first approver, so
  -- "dual approval" cannot be satisfied by the same person twice.
  IF v_table = 'bank_transfers' AND v_second_approver_id IS NOT NULL THEN
    IF v_creator_id IS NOT NULL AND v_second_approver_id = v_creator_id THEN
      RAISE EXCEPTION 'MAKER_CHECKER_VIOLATION: Creator (user %) cannot be the second approver on a bank transfer', v_creator_id;
    END IF;
    IF v_approver_id IS NOT NULL AND v_second_approver_id = v_approver_id THEN
      RAISE EXCEPTION 'MAKER_CHECKER_VIOLATION: The first and second approver on a bank transfer must be different users (user %)', v_approver_id;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;


ALTER FUNCTION "finance"."enforce_maker_checker"() OWNER TO "postgres";


COMMENT ON FUNCTION "finance"."enforce_maker_checker"() IS 'P1_060 SECURITY FIX (ISS-09, Medium): extended to cover finance.bank_transfers (including dual/second-approver distinctness) and finance.profit_distributions, both spec-flagged (5.8, 5.13) as requiring maker-checker/dual approval and previously not wired to this trigger at all. Original expenses/incomes/invoices/vendor_bills/journal_entries behavior is unchanged.';



CREATE OR REPLACE FUNCTION "finance"."enforce_payment_receipt_client_org"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'finance', 'public', 'core'
    AS $$
DECLARE
  v_client_org uuid;
BEGIN
  IF NEW.client_id IS NULL THEN
    RAISE EXCEPTION 'Payment receipt client_id is required';
  END IF;

  SELECT c.organization_id INTO v_client_org
  FROM public.clients c
  WHERE c.id = NEW.client_id;

  IF v_client_org IS NULL THEN
    RAISE EXCEPTION 'Client % does not exist or has no organization', NEW.client_id;
  END IF;

  IF NEW.organization_id IS NULL THEN
    RAISE EXCEPTION 'Payment receipt organization_id is required';
  END IF;

  IF v_client_org IS DISTINCT FROM NEW.organization_id THEN
    RAISE EXCEPTION 'Payment receipt client belongs to a different organization';
  END IF;

  RETURN NEW;
END;
$$;


ALTER FUNCTION "finance"."enforce_payment_receipt_client_org"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "finance"."enforce_postable_account"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'pg_catalog', 'finance', 'public'
    AS $$
DECLARE
  v_posting_allowed boolean;
  v_is_active boolean;
  v_code text;
BEGIN
  SELECT posting_allowed, is_active, code
    INTO v_posting_allowed, v_is_active, v_code
  FROM finance.chart_of_accounts
  WHERE id = NEW.account_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Journal line references unknown account_id %', NEW.account_id;
  END IF;

  IF v_posting_allowed IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Account % (posting_allowed = false, typically a summary/parent account) cannot receive postings', v_code;
  END IF;

  IF v_is_active IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Account % is inactive and cannot receive postings', v_code;
  END IF;

  RETURN NEW;
END;
$$;


ALTER FUNCTION "finance"."enforce_postable_account"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "finance"."enforce_settlement_line_org"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'pg_catalog', 'finance', 'public'
    AS $$
DECLARE v_org uuid;
BEGIN
  SELECT organization_id INTO v_org
  FROM finance.settlement_batches
  WHERE id = NEW.settlement_batch_id;
  IF v_org IS NULL OR NEW.organization_id IS DISTINCT FROM v_org THEN
    RAISE EXCEPTION 'Settlement line organization does not match parent settlement batch';
  END IF;
  RETURN NEW;
END;
$$;


ALTER FUNCTION "finance"."enforce_settlement_line_org"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "finance"."enforce_transition_year_period_13"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'finance', 'public'
    AS $$
DECLARE
  v_is_transition boolean;
  v_approved_by uuid;
  v_approved_at timestamptz;
BEGIN
  IF NEW.period_number <> 13 THEN
    RETURN NEW;
  END IF;

  SELECT is_transition_year, transition_approved_by, transition_approved_at
    INTO v_is_transition, v_approved_by, v_approved_at
    FROM finance.fiscal_years
   WHERE id = NEW.fiscal_year_id;

  IF v_is_transition IS NOT TRUE THEN
    RAISE EXCEPTION
      'Period 13 is only allowed for a fiscal year explicitly flagged is_transition_year = true (fiscal_year_id %). Regular fiscal years are limited to 12 periods per spec Section 4.3.',
      NEW.fiscal_year_id;
  END IF;

  IF v_approved_by IS NULL OR v_approved_at IS NULL THEN
    RAISE EXCEPTION
      'Period 13 requires the owning fiscal year to have recorded transition approval (transition_approved_by/transition_approved_at) per spec Section 4.3 ("explicitly approved one-time transition period"). fiscal_year_id %.',
      NEW.fiscal_year_id;
  END IF;

  RETURN NEW;
END;
$$;


ALTER FUNCTION "finance"."enforce_transition_year_period_13"() OWNER TO "postgres";


COMMENT ON FUNCTION "finance"."enforce_transition_year_period_13"() IS 'BUG-027 fix: restricts accounting_periods.period_number = 13 to fiscal years explicitly flagged and approved as a transition year (finance.fiscal_years.is_transition_year/transition_approved_by/transition_approved_at), per spec Section 4.3.';



CREATE OR REPLACE FUNCTION "finance"."exclude_statement_line"("p_line_id" "uuid", "p_reason" "text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'finance', 'public', 'core'
    AS $$
DECLARE v_org uuid := core.current_user_org_id();
BEGIN
  IF v_org IS NULL OR NOT (core.is_finance_head() OR core.has_role('ACCOUNTANT')) THEN
    RAISE EXCEPTION 'Access denied';
  END IF;
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN RAISE EXCEPTION 'Reason required'; END IF;
  UPDATE finance.statement_lines sl
  SET reconciliation_status='EXCLUDED', exclusion_reason=p_reason, updated_at=now()
  FROM finance.bank_statements bs
  WHERE sl.id=p_line_id
    AND bs.id=sl.bank_statement_id
    AND bs.organization_id=v_org
    AND sl.reconciliation_status='UNRECONCILED';
  IF NOT FOUND THEN RAISE EXCEPTION 'Statement line not found or access denied'; END IF;
END;
$$;


ALTER FUNCTION "finance"."exclude_statement_line"("p_line_id" "uuid", "p_reason" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "finance"."fn_add_accumulated_depreciation"("p_asset_id" "uuid", "p_amount" numeric) RETURNS "void"
    LANGUAGE "plpgsql"
    AS $$ BEGIN
    UPDATE finance.fixed_assets
    SET accumulated_depreciation = accumulated_depreciation + p_amount
    WHERE id = p_asset_id;
END;
 $$;


ALTER FUNCTION "finance"."fn_add_accumulated_depreciation"("p_asset_id" "uuid", "p_amount" numeric) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "finance"."fn_bs_sl_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$ BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
 $$;


ALTER FUNCTION "finance"."fn_bs_sl_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "finance"."fn_bt_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$ BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
 $$;


ALTER FUNCTION "finance"."fn_bt_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "finance"."fn_calculate_sl_depreciation"("p_asset_id" "uuid", "p_period_id" "uuid") RETURNS numeric
    LANGUAGE "plpgsql"
    AS $$ DECLARE
    v_asset        RECORD;
    v_period       RECORD;
    v_depreciation NUMERIC(18,2) := 0;
    v_residual     NUMERIC(18,2);
    v_life         INTEGER;
    v_existing_dep NUMERIC(18,2) := 0;
    v_days         INTEGER;
BEGIN
    SELECT * INTO v_asset FROM finance.fixed_assets WHERE id = p_asset_id;
    SELECT * INTO v_period FROM finance.accounting_periods WHERE id = p_period_id;

    IF NOT FOUND OR v_asset.status NOT IN ('active','fully_depreciated') THEN
        RETURN 0;
    END IF;

    v_life := COALESCE(v_asset.useful_life_months,
        (SELECT useful_life_months FROM finance.asset_categories WHERE id = v_asset.category_id));

    v_residual := COALESCE(v_asset.residual_value_amount,
        COALESCE(v_asset.residual_value_pct, 0) * v_asset.base_cost / 100);

    SELECT COALESCE(SUM(depreciation_amount), 0) INTO v_existing_dep
    FROM finance.depreciation_schedule
    WHERE asset_id = p_asset_id AND status IN ('calculated','posted');

    IF v_existing_dep >= (v_asset.base_cost - v_residual) THEN
        RETURN 0;
    END IF;

    v_depreciation := (v_asset.base_cost - v_residual) / v_life;

    v_days := EXTRACT(DAY FROM v_period.end_date::timestamp - v_period.start_date::timestamp)::INTEGER + 1;
    v_depreciation := v_depreciation * (v_days::NUMERIC / 30);

    IF (v_existing_dep + v_depreciation) > (v_asset.base_cost - v_residual) THEN
        v_depreciation := (v_asset.base_cost - v_residual) - v_existing_dep;
    END IF;

    RETURN ROUND(v_depreciation, 2);
END;
 $$;


ALTER FUNCTION "finance"."fn_calculate_sl_depreciation"("p_asset_id" "uuid", "p_period_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "finance"."fn_enforce_single_default_fa"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$ BEGIN
    IF NEW.is_default = TRUE THEN
        UPDATE finance.financial_accounts
        SET is_default = FALSE
        WHERE currency = NEW.currency AND id != NEW.id AND is_default = TRUE;
    END IF;
    RETURN NEW;
END;
 $$;


ALTER FUNCTION "finance"."fn_enforce_single_default_fa"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "finance"."fn_fa_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$ BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
 $$;


ALTER FUNCTION "finance"."fn_fa_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "finance"."fn_gen_bt_number"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'finance', 'public'
    AS $$
BEGIN
  IF NEW.transfer_number IS NULL OR NEW.transfer_number = '' THEN
    NEW.transfer_number := finance.get_next_number('BANK_TRANSFER');
  END IF;
  RETURN NEW;
END;
$$;


ALTER FUNCTION "finance"."fn_gen_bt_number"() OWNER TO "postgres";


COMMENT ON FUNCTION "finance"."fn_gen_bt_number"() IS 'Generates bank transfer numbers via finance.get_next_number(), the same concurrency-safe (SELECT...FOR UPDATE) mechanism used for invoices/bills/journals. Previously used a race-prone MAX()+1 pattern. See Migration 025 / compliance audit Section H3.';



CREATE OR REPLACE FUNCTION "finance"."fn_generate_depreciation_for_period"("p_period_id" "uuid", "p_created_by" "uuid") RETURNS TABLE("asset_id" "uuid", "asset_code" character varying, "asset_name" character varying, "depreciation_amount" numeric, "status" "text")
    LANGUAGE "plpgsql"
    AS $$ DECLARE
    v_period RECORD;
    v_fy_id  UUID;
BEGIN
    SELECT * INTO v_period FROM finance.accounting_periods WHERE id = p_period_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Period not found';
    END IF;

    SELECT fiscal_year_id INTO v_fy_id FROM finance.accounting_periods WHERE id = p_period_id;

    -- Step 1: INSERT depreciation records (no RETURNING)
    WITH active_assets AS (
        SELECT fa.*,
            ac.useful_life_months AS cat_life,
            ac.residual_value_pct AS cat_residual_pct,
            ac.depreciation_method AS cat_method
        FROM finance.fixed_assets fa
        JOIN finance.asset_categories ac ON ac.id = fa.category_id
        WHERE fa.status IN ('active','fully_depreciated')
        AND fa.purchase_date <= v_period.end_date
        AND NOT EXISTS (
            SELECT 1 FROM finance.depreciation_schedule ds
            WHERE ds.asset_id = fa.id AND ds.period_id = p_period_id
        )
    ),
    calc AS (
        SELECT
            aa.id AS asset_id,
            aa.code AS asset_code,
            aa.name AS asset_name,
            COALESCE(aa.accumulated_depreciation, 0) AS opening_dep,
            finance.fn_calculate_sl_depreciation(aa.id, p_period_id) AS dep_amount,
            GREATEST(aa.base_cost - COALESCE(aa.accumulated_depreciation, 0)
                - finance.fn_calculate_sl_depreciation(aa.id, p_period_id),
                COALESCE(aa.residual_value_amount,
                    COALESCE(aa.residual_value_pct, aa.cat_residual_pct, 0) * aa.base_cost / 100)) AS closing_nbv
        FROM active_assets aa
    )
    INSERT INTO finance.depreciation_schedule (
        asset_id, period_id, fiscal_year_id,
        opening_nbv, depreciation_amount, closing_nbv,
        method, rate, days_in_period,
        status, created_by
    )
    SELECT
        c.asset_id, p_period_id, v_fy_id,
        (SELECT base_cost FROM finance.fixed_assets WHERE id = c.asset_id) - c.opening_dep,
        c.dep_amount, c.closing_nbv,
        COALESCE(
            (SELECT fa.depreciation_method FROM finance.fixed_assets fa WHERE fa.id = c.asset_id),
            (SELECT ac.depreciation_method FROM finance.asset_categories ac
             JOIN finance.fixed_assets fa2 ON fa2.category_id = ac.id WHERE fa2.id = c.asset_id),
            'straight_line'
        ),
        CASE WHEN c.dep_amount > 0
            THEN ROUND(c.dep_amount / NULLIF(GREATEST(
                (SELECT base_cost FROM finance.fixed_assets WHERE id = c.asset_id) - c.opening_dep, 0.01), 0.01) * 100, 4)
            ELSE 0 END,
        EXTRACT(DAY FROM v_period.end_date::timestamp - v_period.start_date::timestamp)::INTEGER + 1,
        'calculated', p_created_by
    FROM calc c
    WHERE c.dep_amount > 0;

    -- Step 2: SELECT back the inserted rows to return them with correct types
    RETURN QUERY
    SELECT
        ds.asset_id,
        fa.code AS asset_code,
        fa.name AS asset_name,
        ds.depreciation_amount::NUMERIC(18,2),
        ds.status::TEXT
    FROM finance.depreciation_schedule ds
    JOIN finance.fixed_assets fa ON fa.id = ds.asset_id
    WHERE ds.period_id = p_period_id
    AND ds.created_by = p_created_by;

    RETURN;
END;
$$;


ALTER FUNCTION "finance"."fn_generate_depreciation_for_period"("p_period_id" "uuid", "p_created_by" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "finance"."fn_prevent_double_match"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$ BEGIN
    IF NEW.matched_journal_line_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM finance.statement_lines WHERE matched_journal_line_id = NEW.matched_journal_line_id AND id != NEW.id AND reconciliation_status IN ('MATCHED','MANUAL_MATCH')
    ) THEN RAISE EXCEPTION 'Journal line already matched'; END IF;
    RETURN NEW;
END;
 $$;


ALTER FUNCTION "finance"."fn_prevent_double_match"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "finance"."fn_set_dual_approval"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$ DECLARE v_min NUMERIC;
BEGIN
    SELECT MIN(COALESCE(min_dual_approval_amount, 999999999999))
    INTO v_min FROM finance.financial_accounts WHERE id IN (NEW.from_account_id, NEW.to_account_id);
    IF NEW.from_amount >= v_min THEN NEW.requires_dual_approval := TRUE; END IF;
    RETURN NEW;
END;
 $$;


ALTER FUNCTION "finance"."fn_set_dual_approval"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "finance"."fn_stmt_line_count"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$ BEGIN
    UPDATE finance.bank_statements SET
        line_count = (SELECT COUNT(*) FROM finance.statement_lines WHERE bank_statement_id = COALESCE(NEW.bank_statement_id, OLD.bank_statement_id)),
        updated_at = NOW()
    WHERE id = COALESCE(NEW.bank_statement_id, OLD.bank_statement_id);
    RETURN COALESCE(NEW, OLD);
END;
 $$;


ALTER FUNCTION "finance"."fn_stmt_line_count"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "finance"."fn_stmt_recon_status"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$ DECLARE v_total INT; v_matched INT; v_excluded INT; v_sid UUID;
BEGIN
    v_sid := COALESCE(NEW.bank_statement_id, OLD.bank_statement_id);
    SELECT COUNT(*), COUNT(*) FILTER (WHERE reconciliation_status IN ('MATCHED','MANUAL_MATCH')), COUNT(*) FILTER (WHERE reconciliation_status = 'EXCLUDED')
    INTO v_total, v_matched, v_excluded FROM finance.statement_lines WHERE bank_statement_id = v_sid;
    UPDATE finance.bank_statements SET reconciliation_status = CASE
        WHEN v_total = 0 THEN 'PENDING'
        WHEN v_matched + v_excluded = v_total THEN 'COMPLETED'
        WHEN v_matched > 0 OR v_excluded > 0 THEN 'PARTIAL'
        ELSE 'IN_PROGRESS'
    END, updated_at = NOW() WHERE id = v_sid;
    RETURN COALESCE(NEW, OLD);
END;
 $$;


ALTER FUNCTION "finance"."fn_stmt_recon_status"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "finance"."fn_subtract_accumulated_depreciation"("p_asset_id" "uuid", "p_amount" numeric) RETURNS "void"
    LANGUAGE "plpgsql"
    AS $$ BEGIN
    UPDATE finance.fixed_assets
    SET accumulated_depreciation = GREATEST(accumulated_depreciation - p_amount, 0)
    WHERE id = p_asset_id;
END;
$$;


ALTER FUNCTION "finance"."fn_subtract_accumulated_depreciation"("p_asset_id" "uuid", "p_amount" numeric) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "finance"."fn_tax_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$ BEGIN NEW.updated_at = NOW(); RETURN NEW; END; $$;


ALTER FUNCTION "finance"."fn_tax_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "finance"."fn_update_asset_nbv"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$ DECLARE
    rv NUMERIC(18,2);
BEGIN
    IF NEW.accumulated_depreciation IS NULL THEN
        NEW.accumulated_depreciation := 0;
    END IF;

    IF NEW.residual_value_amount IS NOT NULL THEN
        rv := NEW.residual_value_amount;
    ELSE
        rv := COALESCE(NEW.residual_value_pct,
            (SELECT residual_value_pct FROM finance.asset_categories WHERE id = NEW.category_id), 0)
            * NEW.base_cost / 100;
    END IF;
    NEW.net_book_value := GREATEST(NEW.base_cost - NEW.accumulated_depreciation, rv);

    IF NEW.base_cost > 0 AND NEW.net_book_value <= rv AND NEW.status = 'active' THEN
        NEW.status := 'fully_depreciated';
    END IF;

    RETURN NEW;
END;
 $$;


ALTER FUNCTION "finance"."fn_update_asset_nbv"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "finance"."fn_update_timestamp"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$ BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
 $$;


ALTER FUNCTION "finance"."fn_update_timestamp"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "finance"."fn_validate_fa_ledger"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$ DECLARE v_code TEXT;
BEGIN
    SELECT LEFT(code, 1) INTO v_code FROM finance.chart_of_accounts WHERE id = NEW.linked_ledger_account_id;
    IF v_code != '1' THEN
        RAISE EXCEPTION 'Linked account must be Asset (1xxx), got: %', v_code;
    END IF;
    RETURN NEW;
END;
 $$;


ALTER FUNCTION "finance"."fn_validate_fa_ledger"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "finance"."get_current_open_period_id"() RETURNS "uuid"
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'finance', 'public', 'core'
    AS $$
DECLARE v_org uuid := core.current_user_org_id(); v_period uuid;
BEGIN
  IF v_org IS NULL THEN RAISE EXCEPTION 'Organization context missing'; END IF;
  SELECT ap.id INTO v_period
  FROM finance.accounting_periods ap
  JOIN finance.fiscal_years fy ON fy.id=ap.fiscal_year_id
  WHERE ap.organization_id=v_org AND fy.organization_id=v_org
    AND ap.status='OPEN' AND fy.status='OPEN'
    AND CURRENT_DATE BETWEEN ap.start_date AND ap.end_date
  ORDER BY ap.start_date DESC LIMIT 1;
  RETURN v_period;
END;
$$;


ALTER FUNCTION "finance"."get_current_open_period_id"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "finance"."get_current_period"() RETURNS TABLE("period_id" "uuid", "fiscal_year_id" "uuid", "fiscal_year_name" "text", "period_number" integer, "period_name" "text", "period_start" "date", "period_end" "date", "period_status" "text")
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'finance', 'public', 'core'
    AS $$
DECLARE v_org uuid := core.current_user_org_id();
BEGIN
  IF v_org IS NULL THEN RAISE EXCEPTION 'Organization context missing'; END IF;
  RETURN QUERY
  SELECT ap.id,ap.fiscal_year_id,fy.name,ap.period_number,ap.name,ap.start_date,ap.end_date,ap.status
  FROM finance.accounting_periods ap JOIN finance.fiscal_years fy ON fy.id=ap.fiscal_year_id
  WHERE ap.organization_id=v_org AND fy.organization_id=v_org
    AND ap.status='OPEN' AND fy.status='OPEN'
    AND CURRENT_DATE BETWEEN ap.start_date AND ap.end_date
  ORDER BY ap.start_date DESC LIMIT 1;
END;
$$;


ALTER FUNCTION "finance"."get_current_period"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "finance"."get_next_number"("p_type" "text", "p_organization_id" "uuid" DEFAULT "core"."current_user_org_id"()) RETURNS "text"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'finance', 'core', 'public'
    AS $$
DECLARE
    v_seq RECORD;
    v_next_num INTEGER;
    v_result TEXT;
    v_fy_id UUID;
BEGIN
    SELECT id INTO v_fy_id
    FROM finance.fiscal_years
    WHERE status = 'OPEN'
      AND (p_organization_id IS NULL OR organization_id = p_organization_id)
    ORDER BY start_date DESC
    LIMIT 1;

    SELECT * INTO v_seq
    FROM finance.numbering_sequences
    WHERE sequence_type = p_type
      AND (fiscal_year_id = v_fy_id OR fiscal_year_id IS NULL)
      AND (p_organization_id IS NULL OR organization_id = p_organization_id)
    ORDER BY fiscal_year_id DESC NULLS LAST
    LIMIT 1
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Numbering sequence not found for type: % (organization: %)', p_type, p_organization_id;
    END IF;

    v_next_num := v_seq.current_number + 1;

    UPDATE finance.numbering_sequences
    SET current_number = v_next_num
    WHERE id = v_seq.id;

    v_result := REPLACE(v_seq.format, '{PREFIX}', v_seq.prefix);
    v_result := REPLACE(v_result, '{NUMBER}', LPAD(v_next_num::TEXT, v_seq.padding, '0'));

    RETURN v_result;
END;
$$;


ALTER FUNCTION "finance"."get_next_number"("p_type" "text", "p_organization_id" "uuid") OWNER TO "postgres";


COMMENT ON FUNCTION "finance"."get_next_number"("p_type" "text", "p_organization_id" "uuid") IS 'Fixed migration 035 (Compliance Audit R5): added optional p_organization_id (defaults to caller''s own org via core.current_user_org_id()) so numbering sequences and open-fiscal-year lookup cannot cross organization boundaries in a multi-org deployment. Existing single-argument call sites are unaffected.';



CREATE OR REPLACE FUNCTION "finance"."get_period_by_date"("p_date" "date") RETURNS TABLE("period_id" "uuid", "fiscal_year_id" "uuid", "fiscal_year_name" "text", "period_number" integer, "period_name" "text", "period_start" "date", "period_end" "date", "period_status" "text", "fy_status" "text")
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'finance', 'public', 'core'
    AS $$
DECLARE v_org uuid := core.current_user_org_id();
BEGIN
  IF v_org IS NULL THEN RAISE EXCEPTION 'Organization context missing'; END IF;
  RETURN QUERY
  SELECT ap.id,ap.fiscal_year_id,fy.name,ap.period_number,ap.name,ap.start_date,ap.end_date,ap.status,fy.status
  FROM finance.accounting_periods ap JOIN finance.fiscal_years fy ON fy.id=ap.fiscal_year_id
  WHERE ap.organization_id=v_org AND fy.organization_id=v_org
    AND p_date BETWEEN ap.start_date AND ap.end_date
  ORDER BY ap.start_date DESC LIMIT 1;
END;
$$;


ALTER FUNCTION "finance"."get_period_by_date"("p_date" "date") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "finance"."get_pnl_accounts"("p_fiscal_year_id" "uuid", "p_organization_id" "uuid", "p_account_type" "text") RETURNS TABLE("account_id" "uuid", "code" "text", "name" "text", "balance" numeric)
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'finance', 'public', 'core'
    AS $$
BEGIN
  IF p_organization_id IS DISTINCT FROM core.current_user_org_id() THEN RAISE EXCEPTION 'Access denied'; END IF;
  IF p_account_type NOT IN ('REVENUE','EXPENSE') THEN RAISE EXCEPTION 'Invalid P&L account type'; END IF;
  RETURN QUERY
  SELECT coa.id,coa.code,coa.name,
    CASE WHEN p_account_type='REVENUE' THEN
      coalesce(sum(coalesce(jl.base_credit,jl.credit_amount)-coalesce(jl.base_debit,jl.debit_amount)),0)
    ELSE
      coalesce(sum(coalesce(jl.base_debit,jl.debit_amount)-coalesce(jl.base_credit,jl.credit_amount)),0)
    END AS balance
  FROM finance.chart_of_accounts coa
  LEFT JOIN finance.journal_lines jl ON jl.account_id=coa.id
  LEFT JOIN finance.journal_entries je ON je.id=jl.journal_entry_id
    AND je.status='POSTED' AND je.fiscal_year_id=p_fiscal_year_id AND je.organization_id=p_organization_id
  WHERE coa.organization_id=p_organization_id AND coa.account_type=p_account_type
  GROUP BY coa.id,coa.code,coa.name
  ORDER BY coa.code;
END;
$$;


ALTER FUNCTION "finance"."get_pnl_accounts"("p_fiscal_year_id" "uuid", "p_organization_id" "uuid", "p_account_type" "text") OWNER TO "postgres";


COMMENT ON FUNCTION "finance"."get_pnl_accounts"("p_fiscal_year_id" "uuid", "p_organization_id" "uuid", "p_account_type" "text") IS 'Confirmed audit fix: organization-scoped P&L balances for fiscal close.';



CREATE OR REPLACE FUNCTION "finance"."is_date_in_open_period"("p_date" "date") RETURNS boolean
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'finance', 'public', 'core'
    AS $$
DECLARE v_org uuid := core.current_user_org_id(); v_open boolean;
BEGIN
  IF v_org IS NULL THEN RAISE EXCEPTION 'Organization context missing'; END IF;
  SELECT EXISTS(
    SELECT 1 FROM finance.accounting_periods ap JOIN finance.fiscal_years fy ON fy.id=ap.fiscal_year_id
    WHERE ap.organization_id=v_org AND fy.organization_id=v_org AND ap.status='OPEN' AND fy.status='OPEN'
      AND p_date BETWEEN ap.start_date AND ap.end_date
  ) INTO v_open;
  RETURN v_open;
END;
$$;


ALTER FUNCTION "finance"."is_date_in_open_period"("p_date" "date") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "finance"."manual_match_statement_line"("p_line_id" "uuid", "p_journal_line_id" "uuid", "p_reason" "text" DEFAULT NULL::"text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'finance', 'public', 'core'
    AS $$
DECLARE v_org uuid := core.current_user_org_id(); v_sl record; v_ledger uuid;
BEGIN
  IF v_org IS NULL OR NOT (core.is_finance_head() OR core.has_role('ACCOUNTANT')) THEN RAISE EXCEPTION 'Access denied'; END IF;
  SELECT sl.*, bs.organization_id, fa.linked_ledger_account_id AS ledger_id
  INTO v_sl
  FROM finance.statement_lines sl
  JOIN finance.bank_statements bs ON bs.id=sl.bank_statement_id
  JOIN finance.financial_accounts fa ON fa.id=bs.financial_account_id
  WHERE sl.id=p_line_id AND bs.organization_id=v_org;
  IF NOT FOUND THEN RAISE EXCEPTION 'Statement line not found or access denied'; END IF;
  IF v_sl.reconciliation_status <> 'UNRECONCILED' THEN RAISE EXCEPTION 'Statement line is not unreconciled'; END IF;
  v_ledger := v_sl.ledger_id;
  IF NOT EXISTS (
    SELECT 1 FROM finance.journal_lines jl
    JOIN finance.journal_entries je ON je.id=jl.journal_entry_id
    WHERE jl.id=p_journal_line_id AND jl.account_id=v_ledger AND je.organization_id=v_org
  ) THEN RAISE EXCEPTION 'Journal line does not belong to this organization/account'; END IF;
  IF EXISTS (SELECT 1 FROM finance.statement_lines sl2 WHERE sl2.matched_journal_line_id=p_journal_line_id AND sl2.reconciliation_status IN ('MATCHED','MANUAL_MATCH') AND sl2.id<>p_line_id) THEN
    RAISE EXCEPTION 'Journal line already matched';
  END IF;
  UPDATE finance.statement_lines
  SET reconciliation_status='MANUAL_MATCH', matched_journal_line_id=p_journal_line_id,
      matched_at=now(), matched_by=auth.uid(), match_method='MANUAL', exclusion_reason=p_reason, updated_at=now()
  WHERE id=p_line_id;
END;
$$;


ALTER FUNCTION "finance"."manual_match_statement_line"("p_line_id" "uuid", "p_journal_line_id" "uuid", "p_reason" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "finance"."mark_overdue_invoices"() RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'finance', 'public'
    AS $$
DECLARE
  v_count INTEGER := 0;
  v_org_id UUID;
BEGIN
  -- C-09 fix: scope to caller's own organization and require an authorized
  -- role, so this SECURITY DEFINER function can no longer touch every
  -- organization's invoices when called by any authenticated user.
  v_org_id := core.current_user_org_id();
  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'Access denied: no organization context for caller';
  END IF;
  IF NOT (core.is_finance_head() OR core.has_role('ACCOUNTANT')) THEN
    RAISE EXCEPTION 'Insufficient privileges to mark invoices overdue';
  END IF;

  -- Sirf un invoices ko OVERDUE mark karo jo ISSUED ya PARTIALLY_PAID hain
  -- AUR unka due_date ho chuka ho aur outstanding_amount > 0 ho
  UPDATE public.invoices
  SET status = 'OVERDUE'
  WHERE id IN (
    SELECT id FROM public.invoices
    WHERE status IN ('ISSUED', 'PARTIALLY_PAID')
      AND due_date < CURRENT_DATE
      AND outstanding_amount > 0
      AND organization_id = v_org_id
  );

  GET DIAGNOSTICS v_count = ROW_COUNT;

  RETURN v_count;
END;
$$;


ALTER FUNCTION "finance"."mark_overdue_invoices"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "finance"."mark_paid_invoices"() RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'finance', 'public'
    AS $$
DECLARE
  v_count INTEGER := 0;
  v_org_id UUID;
BEGIN
  -- C-10 fix: scope to caller's own organization and require an authorized
  -- role, matching the C-09 fix applied to mark_overdue_invoices().
  v_org_id := core.current_user_org_id();
  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'Access denied: no organization context for caller';
  END IF;
  IF NOT (core.is_finance_head() OR core.has_role('ACCOUNTANT')) THEN
    RAISE EXCEPTION 'Insufficient privileges to mark invoices paid';
  END IF;

  -- Agar outstanding 0 se kam ya barabar hai toh PAID kar do
  UPDATE public.invoices
  SET status = 'PAID'
  WHERE id IN (
    SELECT id FROM public.invoices
    WHERE status IN ('ISSUED', 'PARTIALLY_PAID', 'OVERDUE')
      AND outstanding_amount <= 0
      AND organization_id = v_org_id
  );

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;


ALTER FUNCTION "finance"."mark_paid_invoices"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "finance"."open_period"("p_period_id" "uuid", "p_opened_by" "uuid" DEFAULT NULL::"uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'finance', 'public'
    AS $$ 
DECLARE
    v_period RECORD;
    v_user_id UUID;
BEGIN
    -- ✅ FIX: Resolve user ID
    v_user_id := COALESCE(p_opened_by, auth.uid());
    
    -- ✅ FIX: Set for audit trigger
    PERFORM set_config('app.current_user_id', v_user_id::TEXT, true);

    SELECT ap.*, fy.status AS fy_status, fy.name AS fy_name
    INTO v_period
    FROM finance.accounting_periods ap
    JOIN finance.fiscal_years fy ON ap.fiscal_year_id = fy.id
    WHERE ap.id = p_period_id;
    
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Period not found';
    END IF;
    
    IF v_period.fy_status != 'OPEN' THEN
        RAISE EXCEPTION 'Cannot open period: fiscal year "%" is not open', v_period.fy_name;
    END IF;
    
    IF v_period.status != 'PENDING' THEN
        RAISE EXCEPTION 'Period is not in PENDING status (current: %)', v_period.status;
    END IF;
    
    UPDATE finance.accounting_periods
    SET status = 'OPEN',
        updated_at = NOW()
    WHERE id = p_period_id;
END;
 $$;


ALTER FUNCTION "finance"."open_period"("p_period_id" "uuid", "p_opened_by" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "finance"."peek_next_number"("p_type" "text") RETURNS "text"
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'finance', 'public'
    AS $$ DECLARE
    v_seq RECORD;
    v_next_num INTEGER;
    v_result TEXT;
    v_fy_id UUID;
BEGIN
    SELECT id INTO v_fy_id 
    FROM finance.fiscal_years 
    WHERE status = 'OPEN' 
    ORDER BY start_date DESC 
    LIMIT 1;
    
    SELECT * INTO v_seq 
    FROM finance.numbering_sequences 
    WHERE sequence_type = p_type 
      AND (fiscal_year_id = v_fy_id OR fiscal_year_id IS NULL)
    ORDER BY fiscal_year_id DESC NULLS LAST
    LIMIT 1;
    
    IF NOT FOUND THEN
        RETURN 'N/A';
    END IF;
    
    v_next_num := v_seq.current_number + 1;
    
    v_result := REPLACE(v_seq.format, '{PREFIX}', v_seq.prefix);
    v_result := REPLACE(v_result, '{NUMBER}', LPAD(v_next_num::TEXT, v_seq.padding, '0'));
    
    RETURN v_result;
END;
 $$;


ALTER FUNCTION "finance"."peek_next_number"("p_type" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "finance"."post_bank_transfer"("p_transfer_id" "uuid", "p_period_id" "uuid", "p_transaction_date" "date") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'finance', 'public'
    AS $$
DECLARE
    v_t RECORD;
    v_fy_id UUID;
    v_from_ledger UUID;
    v_to_ledger UUID;
    v_fx_gain UUID;
    v_fx_loss UUID;
    v_lines JSONB := '[]'::JSONB;
    v_fx_diff NUMERIC(18,2);
    v_from_base NUMERIC(18,2);
    v_to_base NUMERIC(18,2);
    v_from_rate NUMERIC(18,6);
    v_to_rate NUMERIC(18,6);
BEGIN
    SELECT * INTO v_t FROM finance.bank_transfers WHERE id = p_transfer_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Transfer not found'; END IF;
    IF v_t.status NOT IN ('APPROVED','SUBMITTED') THEN RAISE EXCEPTION 'Must be approved, status: %', v_t.status; END IF;

    SELECT fiscal_year_id INTO v_fy_id FROM finance.accounting_periods WHERE id = p_period_id;
    IF v_fy_id IS NULL THEN RAISE EXCEPTION 'Invalid period'; END IF;

    SELECT linked_ledger_account_id INTO v_from_ledger FROM finance.financial_accounts WHERE id = v_t.from_account_id;
    SELECT linked_ledger_account_id INTO v_to_ledger FROM finance.financial_accounts WHERE id = v_t.to_account_id;

    --  BUG FIX: 4210 = Exchange Gain (exists), 7121 = Realized FX Loss (exists, was 7210)
    SELECT id INTO v_fx_gain FROM finance.chart_of_accounts WHERE code = '4210' LIMIT 1;
    SELECT id INTO v_fx_loss FROM finance.chart_of_accounts WHERE code = '7121' LIMIT 1;

    -- From side to PKR base
    IF v_t.from_currency = 'PKR' THEN v_from_base := v_t.from_amount; v_from_rate := 1;
    ELSE
        --  BUG FIX: rate_date NOT effective_date
        SELECT rate INTO v_from_rate FROM finance.exchange_rates
        WHERE from_currency = v_t.from_currency AND to_currency = 'PKR'
        ORDER BY rate_date DESC LIMIT 1;
        IF v_from_rate IS NULL THEN v_from_rate := v_t.exchange_rate; END IF;
        v_from_base := ROUND(v_t.from_amount * v_from_rate, 2);
    END IF;

    -- To side to PKR base
    IF v_t.to_currency = 'PKR' THEN v_to_base := v_t.to_amount; v_to_rate := 1;
    ELSE
        --  BUG FIX: rate_date NOT effective_date
        SELECT rate INTO v_to_rate FROM finance.exchange_rates
        WHERE from_currency = v_t.to_currency AND to_currency = 'PKR'
        ORDER BY rate_date DESC LIMIT 1;
        IF v_to_rate IS NULL THEN v_to_rate := 1 / v_t.exchange_rate; END IF;
        v_to_base := ROUND(v_t.to_amount * v_to_rate, 2);
    END IF;

    -- Same currency
    IF v_t.from_currency = v_t.to_currency THEN
        v_lines := v_lines || jsonb_build_object('account_id', v_to_ledger, 'debit_amount', v_t.to_amount, 'credit_amount', 0, 'description', 'Transfer TO: ' || v_t.transfer_number);
        v_lines := v_lines || jsonb_build_object('account_id', v_from_ledger, 'debit_amount', 0, 'credit_amount', v_t.from_amount, 'description', 'Transfer FROM: ' || v_t.transfer_number);
    ELSE
        v_fx_diff := v_to_base - v_from_base;
        v_lines := v_lines || jsonb_build_object('account_id', v_to_ledger, 'debit_amount', v_to_base, 'credit_amount', 0, 'description', 'Transfer TO: ' || v_t.transfer_number || ' (' || v_t.to_amount || ' ' || v_t.to_currency || ')');
        v_lines := v_lines || jsonb_build_object('account_id', v_from_ledger, 'debit_amount', 0, 'credit_amount', v_from_base, 'description', 'Transfer FROM: ' || v_t.transfer_number || ' (' || v_t.from_amount || ' ' || v_t.from_currency || ')');
        IF v_fx_diff > 0 AND v_fx_gain IS NOT NULL THEN
            v_lines := v_lines || jsonb_build_object('account_id', v_fx_gain, 'debit_amount', 0, 'credit_amount', v_fx_diff, 'description', 'FX Gain: ' || v_t.transfer_number);
        ELSIF v_fx_diff < 0 AND v_fx_loss IS NOT NULL THEN
            v_lines := v_lines || jsonb_build_object('account_id', v_fx_loss, 'debit_amount', ABS(v_fx_diff), 'credit_amount', 0, 'description', 'FX Loss: ' || v_t.transfer_number);
        END IF;
    END IF;

    --  CORRECT PARAMETER ORDER
    RETURN finance.post_journal_entry('Bank Transfer: ' || v_t.transfer_number, p_transaction_date, p_period_id, v_lines, 'PKR', 1.0000, 'BANK_TRANSFER', p_transfer_id, NULL, NULL);
END;
$$;


ALTER FUNCTION "finance"."post_bank_transfer"("p_transfer_id" "uuid", "p_period_id" "uuid", "p_transaction_date" "date") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "finance"."post_credit_note"("p_cn_id" "uuid", "p_period_id" "uuid", "p_transaction_date" "date") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'finance', 'public'
    AS $$
DECLARE
    v_cn RECORD;
    v_fy_id UUID;
    v_rev_account UUID;
    v_ar_account UUID;
    v_lines JSONB := '[]'::JSONB;
BEGIN
    SELECT * INTO v_cn FROM finance.credit_notes WHERE id = p_cn_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Credit Note not found'; END IF;

    SELECT fiscal_year_id INTO v_fy_id FROM finance.accounting_periods WHERE id = p_period_id;
    IF v_fy_id IS NULL THEN RAISE EXCEPTION 'Invalid period'; END IF;

    SELECT id INTO v_rev_account FROM finance.chart_of_accounts WHERE code = '4110' LIMIT 1;
    SELECT id INTO v_ar_account FROM finance.chart_of_accounts WHERE code = '1210' LIMIT 1;

    v_lines := v_lines || jsonb_build_object(
        'account_id', v_rev_account,
        'debit_amount', v_cn.base_amount,
        'credit_amount', 0,
        'description', 'Credit Note: ' || COALESCE(v_cn.credit_note_number, v_cn.id::text) || ' - ' || v_cn.reason
    );

    v_lines := v_lines || jsonb_build_object(
        'account_id', v_ar_account,
        'debit_amount', 0,
        'credit_amount', v_cn.base_amount,
        'description', 'AR Adjustment: CN ' || COALESCE(v_cn.credit_note_number, v_cn.id::text)
    );

    --  CORRECT PARAMETER ORDER
    RETURN finance.post_journal_entry(
        'Credit Note: ' || COALESCE(v_cn.credit_note_number, v_cn.id::text),
        p_transaction_date,
        p_period_id,
        v_lines,
        'PKR', 1.0000,
        'CREDIT_NOTE', p_cn_id,
        NULL, NULL
    );
END;
$$;


ALTER FUNCTION "finance"."post_credit_note"("p_cn_id" "uuid", "p_period_id" "uuid", "p_transaction_date" "date") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "finance"."post_distribution_payment"("p_line_id" "uuid", "p_period_id" "uuid", "p_transaction_date" "date", "p_bank_account_id" "uuid") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'finance', 'public'
    AS $$ DECLARE
    v_line RECORD; v_lines JSONB := '[]'::JSONB;
    v_payable UUID; v_bank_ledger UUID; v_owner_name TEXT;
BEGIN
    SELECT * INTO v_line FROM finance.distribution_lines WHERE id = p_line_id;
    IF v_line.payment_status != 'PENDING' THEN RAISE EXCEPTION 'Already paid'; END IF;

    SELECT name INTO v_owner_name FROM finance.owners WHERE id = v_line.owner_id;
    SELECT id INTO v_payable FROM finance.chart_of_accounts WHERE code = '2410' LIMIT 1;
    SELECT linked_ledger_account_id INTO v_bank_ledger FROM finance.financial_accounts WHERE id = p_bank_account_id;

    v_lines := v_lines || jsonb_build_object('account_id', v_payable, 'debit_amount', v_line.final_amount, 'credit_amount', 0, 'description', 'Payout to ' || v_owner_name);
    v_lines := v_lines || jsonb_build_object('account_id', v_bank_ledger, 'debit_amount', 0, 'credit_amount', v_line.final_amount, 'description', 'Payout to ' || v_owner_name);

    RETURN finance.post_journal_entry('Owner Payout', p_transaction_date, p_period_id, v_lines, 'PKR', 1.0, 'DISTRIBUTION_PAYMENT', p_line_id, NULL, NULL);
END;
 $$;


ALTER FUNCTION "finance"."post_distribution_payment"("p_line_id" "uuid", "p_period_id" "uuid", "p_transaction_date" "date", "p_bank_account_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "finance"."post_existing_journal_entry"("p_journal_id" "uuid", "p_posted_by" "uuid") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'finance', 'public', 'core'
    AS $$
DECLARE v_org uuid := core.current_user_org_id(); v_j record; v_period text; v_debit numeric; v_credit numeric;
BEGIN
  IF v_org IS NULL OR p_posted_by IS DISTINCT FROM auth.uid() THEN RAISE EXCEPTION 'Access denied'; END IF;
  IF NOT (core.is_finance_head() OR core.has_role('ACCOUNTANT')) THEN RAISE EXCEPTION 'Insufficient privileges'; END IF;
  SELECT * INTO v_j FROM finance.journal_entries WHERE id=p_journal_id AND organization_id=v_org FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Journal not found or access denied'; END IF;
  IF v_j.status<>'APPROVED' THEN RAISE EXCEPTION 'Only APPROVED journals can be posted'; END IF;
  SELECT status INTO v_period FROM finance.accounting_periods WHERE id=v_j.period_id AND organization_id=v_org;
  IF v_period<>'OPEN' THEN RAISE EXCEPTION 'Journal period is not OPEN'; END IF;
  SELECT coalesce(sum(debit_amount),0),coalesce(sum(credit_amount),0) INTO v_debit,v_credit FROM finance.journal_lines WHERE journal_entry_id=p_journal_id;
  IF abs(v_debit-v_credit)>0.01 THEN RAISE EXCEPTION 'Journal is unbalanced: debit %, credit %',v_debit,v_credit; END IF;
  UPDATE finance.journal_entries SET status='POSTED',posted_by=p_posted_by,posted_at=now(),posting_date=current_date,total_debit=v_debit,total_credit=v_credit WHERE id=p_journal_id;
  RETURN p_journal_id;
END;
$$;


ALTER FUNCTION "finance"."post_existing_journal_entry"("p_journal_id" "uuid", "p_posted_by" "uuid") OWNER TO "postgres";


COMMENT ON FUNCTION "finance"."post_existing_journal_entry"("p_journal_id" "uuid", "p_posted_by" "uuid") IS 'Confirmed audit fix: atomically posts an already-approved journal in place, with organization, role, period and balance checks.';



CREATE OR REPLACE FUNCTION "finance"."post_invoice_ar"("p_invoice_id" "uuid", "p_period_id" "uuid", "p_transaction_date" "date") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'finance', 'core', 'public'
    AS $$
DECLARE
    v_inv RECORD;
    v_fy_id UUID;
    v_lines JSONB := '[]'::JSONB;
    v_dr_account UUID;
    v_rev_account UUID;
    v_tax_account UUID;
BEGIN
    -- ─── P1_060 SECURITY FIX (ISS-02, Critical) ───
    IF NOT (core.is_finance_head() OR core.has_role('ACCOUNTANT')) THEN
        RAISE EXCEPTION 'Insufficient privileges to post an invoice to the general ledger. Requires Finance Head, CEO, or Accountant.';
    END IF;

    SELECT * INTO v_inv FROM public.invoices WHERE id = p_invoice_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Invoice not found'; END IF;

    -- P1_060 SECURITY FIX: verify the invoice belongs to the caller's own
    -- organization before posting anything to the ledger on its behalf.
    IF NOT core.same_org(v_inv.organization_id) THEN
        RAISE EXCEPTION 'Access denied: invoice % does not belong to your organization', p_invoice_id;
    END IF;

    SELECT fiscal_year_id INTO v_fy_id FROM finance.accounting_periods WHERE id = p_period_id;
    IF v_fy_id IS NULL THEN RAISE EXCEPTION 'Invalid period'; END IF;

    SELECT id INTO v_dr_account FROM finance.chart_of_accounts WHERE code = '1210' LIMIT 1;
    SELECT id INTO v_rev_account FROM finance.chart_of_accounts WHERE code = '4110' LIMIT 1;
    SELECT id INTO v_tax_account FROM finance.chart_of_accounts WHERE code = '2210' LIMIT 1;

    IF v_dr_account IS NULL THEN RAISE EXCEPTION 'AR account 1210 not found'; END IF;
    IF v_rev_account IS NULL THEN RAISE EXCEPTION 'Revenue account 4110 not found'; END IF;

    -- Line 1: Debit AR (full invoice amount)
    v_lines := v_lines || jsonb_build_object(
        'account_id', v_dr_account,
        'debit_amount', v_inv.base_total_amount,
        'credit_amount', 0,
        'description', 'AR: ' || COALESCE(v_inv.invoice_number, 'N/A') || ' - ' || COALESCE(v_inv.client_name, '')
    );

    -- Line 2: Credit Revenue (Total - Tax)
    IF v_inv.base_total_amount - COALESCE(v_inv.base_tax_amount, 0) > 0 THEN
        v_lines := v_lines || jsonb_build_object(
            'account_id', v_rev_account,
            'debit_amount', 0,
            'credit_amount', v_inv.base_total_amount - COALESCE(v_inv.base_tax_amount, 0),
            'description', 'Revenue: ' || COALESCE(v_inv.invoice_number, 'N/A')
        );
    END IF;

    -- Line 3: Credit Tax Payable
    IF COALESCE(v_inv.base_tax_amount, 0) > 0 AND v_tax_account IS NOT NULL THEN
        v_lines := v_lines || jsonb_build_object(
            'account_id', v_tax_account,
            'debit_amount', 0,
            'credit_amount', v_inv.base_tax_amount,
            'description', 'Tax on Inv: ' || COALESCE(v_inv.invoice_number, 'N/A')
        );
    END IF;

    -- CORRECT PARAMETER ORDER: p_lines is 4th parameter
    RETURN finance.post_journal_entry(
        'AR Invoice: ' || COALESCE(v_inv.invoice_number, v_inv.id::text),
        p_transaction_date,
        p_period_id,
        v_lines,                    --  p_lines = 4th position
        'PKR', 1.0000,              -- p_currency, p_exchange_rate
        'INVOICE', p_invoice_id,     -- p_source_type, p_source_id
        v_inv.project_id,            -- p_project_id
        NULL                        -- p_department_id
    );
END;
$$;


ALTER FUNCTION "finance"."post_invoice_ar"("p_invoice_id" "uuid", "p_period_id" "uuid", "p_transaction_date" "date") OWNER TO "postgres";


COMMENT ON FUNCTION "finance"."post_invoice_ar"("p_invoice_id" "uuid", "p_period_id" "uuid", "p_transaction_date" "date") IS 'P1_060 SECURITY FIX (ISS-02, Critical): added in-function role check (Finance Head/CEO/Accountant) and organization-match check against the invoice being posted. Previously contained only existence checks (IF NOT FOUND), no authorization of any kind.';



CREATE OR REPLACE FUNCTION "finance"."post_journal_entry"("p_description" "text", "p_transaction_date" "date", "p_period_id" "uuid", "p_lines" "jsonb", "p_currency" "text" DEFAULT 'PKR'::"text", "p_exchange_rate" numeric DEFAULT 1.0000, "p_source_type" "text" DEFAULT 'MANUAL'::"text", "p_source_id" "uuid" DEFAULT NULL::"uuid", "p_project_id" "uuid" DEFAULT NULL::"uuid", "p_department_id" "uuid" DEFAULT NULL::"uuid") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'finance', 'core', 'public'
    AS $$
DECLARE
  v_journal_id UUID;
  v_ref TEXT;
  v_fiscal_year_id UUID;
  v_period_org_id UUID;
  v_total_dr NUMERIC(18,2) := 0;
  v_total_cr NUMERIC(18,2) := 0;
  v_line_num INTEGER := 0;
  v_line JSONB;
  v_is_manual BOOLEAN;
BEGIN
  -- ─── P1_060 SECURITY FIX (ISS-02, Critical): in-function authorization ───
  -- Defense-in-depth backstop matching approve_and_post_journal_entry's own
  -- existing check. See migration header for why this is a role check and
  -- not a single hard-coded permission code.
  IF NOT (core.is_finance_head() OR core.has_role('ACCOUNTANT')) THEN
    RAISE EXCEPTION 'Insufficient privileges to post journal entries. Requires Finance Head, CEO, or Accountant.';
  END IF;

  v_is_manual := (COALESCE(p_source_type, 'MANUAL') = 'MANUAL');

  -- 1. Get Fiscal Year + organization from Period, and verify the period
  --    belongs to the caller's own organization (P1_060 SECURITY FIX).
  SELECT fiscal_year_id, organization_id INTO v_fiscal_year_id, v_period_org_id
  FROM finance.accounting_periods WHERE id = p_period_id;

  IF v_fiscal_year_id IS NULL THEN
    RAISE EXCEPTION 'Invalid period_id: %', p_period_id;
  END IF;

  IF NOT core.same_org(v_period_org_id) THEN
    RAISE EXCEPTION 'Access denied: accounting period % does not belong to your organization', p_period_id;
  END IF;

  -- 2. Validate & Calculate Totals.
  --    This early check is kept for a fast, friendly error message before
  --    we build any rows. finance.check_journal_balance() (attached as a
  --    deferred constraint trigger in migration 028) remains the actual
  --    authoritative, unbypassable enforcement at COMMIT time.
  IF jsonb_array_length(p_lines) < 2 THEN
    RAISE EXCEPTION 'Journal must have at least 2 lines';
  END IF;

  FOR v_line IN SELECT * FROM jsonb_array_elements(p_lines) LOOP
    v_total_dr := v_total_dr + COALESCE((v_line->>'debit_amount')::NUMERIC(18,2), 0);
    v_total_cr := v_total_cr + COALESCE((v_line->>'credit_amount')::NUMERIC(18,2), 0);
  END LOOP;

  IF ABS(v_total_dr - v_total_cr) > 0.01 THEN
    RAISE EXCEPTION 'Journal unbalanced: DR=% CR=%', v_total_dr, v_total_cr;
  END IF;

  -- 3. Get Reference (P1_059 already dropped the unscoped 1-arg overload, so
  --    this now unambiguously resolves to the org-scoped version, defaulting
  --    p_organization_id to core.current_user_org_id()).
  v_ref := finance.get_next_number('JOURNAL_ENTRY');

  -- 4. Insert Header.
  --    System-sourced (non-MANUAL) postings: already approved via their own
  --    module workflow -> insert directly as POSTED, approved_by left NULL
  --    (no separate journal-level approver; see header comment).
  --    Manual postings: insert as DRAFT, only created_by set. Must be
  --    completed via finance.approve_and_post_journal_entry() below.
  IF v_is_manual THEN
    INSERT INTO finance.journal_entries (
      reference, description, status, transaction_date,
      period_id, fiscal_year_id, currency, exchange_rate, base_currency,
      total_debit, total_credit, source_type, source_id, project_id, department_id,
      created_by, organization_id
    ) VALUES (
      v_ref, p_description, 'DRAFT', p_transaction_date,
      p_period_id, v_fiscal_year_id, p_currency, p_exchange_rate, 'PKR',
      v_total_dr, v_total_cr, p_source_type, p_source_id, p_project_id, p_department_id,
      auth.uid(), v_period_org_id
    ) RETURNING id INTO v_journal_id;
  ELSE
    INSERT INTO finance.journal_entries (
      reference, description, status, transaction_date, posting_date,
      period_id, fiscal_year_id, currency, exchange_rate, base_currency,
      total_debit, total_credit, source_type, source_id, project_id, department_id,
      created_by, posted_by, posted_at, organization_id
    ) VALUES (
      v_ref, p_description, 'POSTED', p_transaction_date, CURRENT_DATE,
      p_period_id, v_fiscal_year_id, p_currency, p_exchange_rate, 'PKR',
      v_total_dr, v_total_cr, p_source_type, p_source_id, p_project_id, p_department_id,
      auth.uid(), auth.uid(), NOW(), v_period_org_id
    ) RETURNING id INTO v_journal_id;
  END IF;

  -- 5. Insert Lines (unchanged)
  FOR v_line IN SELECT * FROM jsonb_array_elements(p_lines) LOOP
    v_line_num := v_line_num + 1;

    INSERT INTO finance.journal_lines (
      journal_entry_id, line_number, account_id, description,
      debit_amount, credit_amount, currency, exchange_rate,
      base_debit, base_credit, project_id, department_id, created_by
    ) VALUES (
      v_journal_id, v_line_num,
      (v_line->>'account_id')::UUID,
      v_line->>'description',
      COALESCE((v_line->>'debit_amount')::NUMERIC(18,2), 0),
      COALESCE((v_line->>'credit_amount')::NUMERIC(18,2), 0),
      p_currency, p_exchange_rate,
      COALESCE((v_line->>'debit_amount')::NUMERIC(18,2), 0) * p_exchange_rate,
      COALESCE((v_line->>'credit_amount')::NUMERIC(18,2), 0) * p_exchange_rate,
      COALESCE((v_line->>'project_id')::UUID, p_project_id),
      p_department_id, auth.uid()
    );
  END LOOP;

  RETURN v_journal_id;
END;
$$;


ALTER FUNCTION "finance"."post_journal_entry"("p_description" "text", "p_transaction_date" "date", "p_period_id" "uuid", "p_lines" "jsonb", "p_currency" "text", "p_exchange_rate" numeric, "p_source_type" "text", "p_source_id" "uuid", "p_project_id" "uuid", "p_department_id" "uuid") OWNER TO "postgres";


COMMENT ON FUNCTION "finance"."post_journal_entry"("p_description" "text", "p_transaction_date" "date", "p_period_id" "uuid", "p_lines" "jsonb", "p_currency" "text", "p_exchange_rate" numeric, "p_source_type" "text", "p_source_id" "uuid", "p_project_id" "uuid", "p_department_id" "uuid") IS 'P1_060 SECURITY FIX (ISS-02, Critical): added in-function role check (Finance Head/CEO/Accountant) and organization-match check against p_period_id, so this SECURITY DEFINER function can no longer be used to post to another organization''s ledger or bypass authorization via a direct PostgREST RPC call. Also now populates journal_entries.organization_id (previously relied on the caller/trigger; explicit here for defense-in-depth). Previously fixed in migration 029 (MANUAL journals insert as DRAFT, not self-approved).';



CREATE OR REPLACE FUNCTION "finance"."post_payment_receipt"("p_receipt_id" "uuid", "p_period_id" "uuid", "p_transaction_date" "date") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'finance', 'public'
    AS $$
DECLARE
    v_receipt RECORD;
    v_fy_id UUID;
    v_bank_account UUID;
    v_ar_account UUID;
    v_lines JSONB := '[]'::JSONB;
BEGIN
    SELECT * INTO v_receipt FROM finance.payment_receipts WHERE id = p_receipt_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Receipt not found'; END IF;

    SELECT fiscal_year_id INTO v_fy_id FROM finance.accounting_periods WHERE id = p_period_id;
    IF v_fy_id IS NULL THEN RAISE EXCEPTION 'Invalid period'; END IF;

    SELECT id INTO v_bank_account FROM finance.chart_of_accounts WHERE code = '1110' LIMIT 1;
    SELECT id INTO v_ar_account FROM finance.chart_of_accounts WHERE code = '1210' LIMIT 1;

    IF v_bank_account IS NULL THEN RAISE EXCEPTION 'Bank account 1110 not found'; END IF;
    IF v_ar_account IS NULL THEN RAISE EXCEPTION 'AR account 1210 not found'; END IF;

    v_lines := v_lines || jsonb_build_object(
        'account_id', v_bank_account,
        'debit_amount', v_receipt.base_amount,
        'credit_amount', 0,
        'description', 'Payment Received: ' || COALESCE(v_receipt.receipt_number, v_receipt.id::text)
    );

    v_lines := v_lines || jsonb_build_object(
        'account_id', v_ar_account,
        'debit_amount', 0,
        'credit_amount', v_receipt.base_amount,
        'description', 'AR Cleared: ' || COALESCE(v_receipt.receipt_number, v_receipt.id::text)
    );

    --  CORRECT PARAMETER ORDER
    RETURN finance.post_journal_entry(
        'Payment Receipt: ' || COALESCE(v_receipt.receipt_number, v_receipt.id::text),
        p_transaction_date,
        p_period_id,
        v_lines,
        'PKR', 1.0000,
        'PAYMENT', p_receipt_id,
        v_receipt.project_id,
        NULL
    );
END;
$$;


ALTER FUNCTION "finance"."post_payment_receipt"("p_receipt_id" "uuid", "p_period_id" "uuid", "p_transaction_date" "date") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "finance"."post_payment_receipt_atomic"("p_client_id" "uuid", "p_amount" numeric, "p_currency" "text" DEFAULT 'PKR'::"text", "p_exchange_rate" numeric DEFAULT 1.0000, "p_payment_date" "date" DEFAULT CURRENT_DATE, "p_payment_method" "text" DEFAULT 'BANK_TRANSFER'::"text", "p_reference" "text" DEFAULT NULL::"text", "p_financial_account_id" "uuid" DEFAULT NULL::"uuid", "p_notes" "text" DEFAULT NULL::"text", "p_allocations" "jsonb" DEFAULT '[]'::"jsonb") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'finance', 'public', 'core'
    AS $$
DECLARE
  v_org_id UUID := core.current_user_org_id();
  v_receipt_id UUID;
  v_receipt_number TEXT;
  v_period_id UUID;
  v_journal_id UUID;
  v_alloc JSONB;
  v_invoice RECORD;
  v_alloc_amount NUMERIC(18,2);
  v_base_alloc_amount NUMERIC(18,2);
  v_total_allocated NUMERIC(18,2) := 0;
BEGIN
  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'Access denied: no organization context for caller';
  END IF;

  IF NOT (core.is_finance_head() OR core.has_role('ACCOUNTANT')) THEN
    RAISE EXCEPTION 'Insufficient privileges to record a payment receipt';
  END IF;

  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'Payment amount must be greater than zero';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.clients WHERE id = p_client_id AND organization_id = v_org_id) THEN
    RAISE EXCEPTION 'Client not found in your organization';
  END IF;

  IF p_financial_account_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM finance.financial_accounts WHERE id = p_financial_account_id AND organization_id = v_org_id
  ) THEN
    RAISE EXCEPTION 'Financial account not found in your organization';
  END IF;

  SELECT id INTO v_period_id
  FROM finance.accounting_periods
  WHERE status = 'OPEN' AND organization_id = v_org_id
  ORDER BY start_date DESC
  LIMIT 1;
  IF v_period_id IS NULL THEN
    RAISE EXCEPTION 'No OPEN accounting period found';
  END IF;

  v_receipt_number := finance.get_next_number('PMT-RC', v_org_id);
  IF v_receipt_number IS NULL THEN
    v_receipt_number := 'PMT-RC-' || to_char(now(), 'YYYYMMDDHH24MISS');
  END IF;

  INSERT INTO finance.payment_receipts (
    receipt_number, payment_date, amount, currency, exchange_rate,
    base_amount, client_id, financial_account_id, payment_method,
    reference, description, status, period_id, created_by, organization_id
  ) VALUES (
    v_receipt_number, p_payment_date, p_amount, COALESCE(p_currency, 'PKR'), COALESCE(p_exchange_rate, 1),
    ROUND(p_amount * COALESCE(p_exchange_rate, 1), 2), p_client_id, p_financial_account_id, COALESCE(p_payment_method, 'BANK_TRANSFER'),
    p_reference, p_notes, 'DRAFT', v_period_id, auth.uid(), v_org_id
  ) RETURNING id INTO v_receipt_id;

  IF p_allocations IS NOT NULL THEN
    FOR v_alloc IN SELECT * FROM jsonb_array_elements(p_allocations)
    LOOP
      SELECT * INTO v_invoice FROM public.invoices
      WHERE id = (v_alloc->>'invoice_id')::UUID AND organization_id = v_org_id
      FOR UPDATE;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'Invoice % not found in your organization', (v_alloc->>'invoice_id');
      END IF;

      v_alloc_amount := (v_alloc->>'amount')::NUMERIC(18,2);
      IF v_alloc_amount IS NULL OR v_alloc_amount <= 0 THEN
        RAISE EXCEPTION 'Invalid allocation amount for invoice %', v_invoice.invoice_number;
      END IF;
      IF v_alloc_amount > (v_invoice.total_amount - COALESCE(v_invoice.amount_paid, 0)) THEN
        RAISE EXCEPTION 'Allocation exceeds outstanding balance for invoice %', v_invoice.invoice_number;
      END IF;

      v_base_alloc_amount := ROUND(v_alloc_amount * COALESCE(p_exchange_rate, 1), 2);
      v_total_allocated := v_total_allocated + v_alloc_amount;

      INSERT INTO finance.payment_allocations (
        payment_receipt_id, invoice_id, allocated_amount, base_allocated_amount, allocated_by
      ) VALUES (
        v_receipt_id, v_invoice.id, v_alloc_amount, v_base_alloc_amount, auth.uid()
      );

      UPDATE public.invoices
      SET amount_paid = COALESCE(amount_paid, 0) + v_alloc_amount,
          base_amount_paid = COALESCE(base_amount_paid, 0) + v_base_alloc_amount,
          outstanding_amount = GREATEST(total_amount - (COALESCE(amount_paid, 0) + v_alloc_amount), 0),
          base_outstanding_amount = GREATEST(base_total_amount - (COALESCE(base_amount_paid, 0) + v_base_alloc_amount), 0),
          status = CASE
                     WHEN (COALESCE(amount_paid, 0) + v_alloc_amount) >= total_amount THEN 'PAID'
                     ELSE 'PARTIALLY_PAID'
                   END
      WHERE id = v_invoice.id;
    END LOOP;
  END IF;

  IF ABS(v_total_allocated - p_amount) > 0.01 THEN
    RAISE EXCEPTION 'Total allocations (%) must equal payment amount (%)', v_total_allocated, p_amount;
  END IF;

  v_journal_id := finance.post_payment_receipt(v_receipt_id, v_period_id, p_payment_date);

  UPDATE finance.payment_receipts
  SET status = 'POSTED', journal_entry_id = v_journal_id, posted_by = auth.uid(), posted_at = now()
  WHERE id = v_receipt_id;

  RETURN jsonb_build_object(
    'receipt_id', v_receipt_id,
    'journal_id', v_journal_id,
    'receipt_number', v_receipt_number
  );
END;
$$;


ALTER FUNCTION "finance"."post_payment_receipt_atomic"("p_client_id" "uuid", "p_amount" numeric, "p_currency" "text", "p_exchange_rate" numeric, "p_payment_date" "date", "p_payment_method" "text", "p_reference" "text", "p_financial_account_id" "uuid", "p_notes" "text", "p_allocations" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "finance"."post_profit_distribution"("p_distribution_id" "uuid", "p_period_id" "uuid", "p_transaction_date" "date") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'finance', 'public'
    AS $$ DECLARE
    v_dist RECORD; v_lines JSONB := '[]'::JSONB;
    v_pnl UUID; v_reserve UUID; v_payable UUID;
BEGIN
    SELECT * INTO v_dist FROM finance.profit_distributions WHERE id = p_distribution_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Distribution not found'; END IF;
    IF v_dist.status != 'APPROVED' THEN RAISE EXCEPTION 'Must be APPROVED'; END IF;

    SELECT id INTO v_pnl FROM finance.chart_of_accounts WHERE code = '3400' LIMIT 1;
    SELECT id INTO v_reserve FROM finance.chart_of_accounts WHERE code = '3310' LIMIT 1;
    SELECT id INTO v_payable FROM finance.chart_of_accounts WHERE code = '2410' LIMIT 1;

    v_lines := v_lines || jsonb_build_object('account_id', v_pnl, 'debit_amount', v_dist.total_available_profit, 'credit_amount', 0, 'description', 'Close P&L & Transfer to Reserves/Distributions');

    IF v_dist.reserve_amount > 0 THEN
        v_lines := v_lines || jsonb_build_object('account_id', v_reserve, 'debit_amount', 0, 'credit_amount', v_dist.reserve_amount, 'description', 'Transfer to Reserves');
    END IF;

    IF v_dist.distributable_amount > 0 THEN
        v_lines := v_lines || jsonb_build_object('account_id', v_payable, 'debit_amount', 0, 'credit_amount', v_dist.distributable_amount, 'description', 'Profit Distribution Payable');
    END IF;

    RETURN finance.post_journal_entry('Profit Distribution', p_transaction_date, p_period_id, v_lines, 'PKR', 1.0, 'PROFIT_DISTRIBUTION', p_distribution_id, NULL, NULL);
END;
 $$;


ALTER FUNCTION "finance"."post_profit_distribution"("p_distribution_id" "uuid", "p_period_id" "uuid", "p_transaction_date" "date") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "finance"."post_vendor_bill"("p_bill_id" "uuid", "p_period_id" "uuid", "p_transaction_date" "date") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'finance', 'core', 'public'
    AS $$
DECLARE
  v_bill record; v_ap uuid; v_wht uuid; v_lines jsonb:='[]'::jsonb; v_gross numeric:=0; v_wht_total numeric:=0;
  v_fy uuid; v_line record;
BEGIN
  IF NOT (core.is_finance_head() OR core.has_role('ACCOUNTANT')) THEN RAISE EXCEPTION 'Insufficient privileges'; END IF;
  SELECT * INTO v_bill FROM finance.vendor_bills WHERE id=p_bill_id AND organization_id=core.current_user_org_id();
  IF NOT FOUND THEN RAISE EXCEPTION 'Bill not found or access denied'; END IF;
  IF v_bill.status<>'APPROVED' THEN RAISE EXCEPTION 'Bill must be APPROVED before posting'; END IF;
  SELECT fiscal_year_id INTO v_fy FROM finance.accounting_periods WHERE id=p_period_id AND organization_id=v_bill.organization_id AND status='OPEN';
  IF v_fy IS NULL THEN RAISE EXCEPTION 'Invalid or closed accounting period'; END IF;
  SELECT id INTO v_ap FROM finance.chart_of_accounts WHERE code='2110' AND organization_id=v_bill.organization_id AND is_active=true AND posting_allowed=true;
  SELECT id INTO v_wht FROM finance.chart_of_accounts WHERE code='2210' AND organization_id=v_bill.organization_id AND is_active=true AND posting_allowed=true;
  IF v_ap IS NULL THEN RAISE EXCEPTION 'AP account 2110 not found'; END IF;

  FOR v_line IN SELECT account_id,line_total,description,coalesce(withholding_amount,0) AS withholding_amount FROM finance.vendor_bill_lines WHERE vendor_bill_id=p_bill_id ORDER BY line_number LOOP
    v_lines := v_lines || jsonb_build_object('account_id',v_line.account_id,'debit_amount',v_line.line_total,'credit_amount',0,'description',v_line.description);
    v_gross := v_gross + v_line.line_total;
    v_wht_total := v_wht_total + v_line.withholding_amount;
  END LOOP;

  IF v_wht_total > 0 AND v_wht IS NULL THEN RAISE EXCEPTION 'WHT Payable account 2210 not found'; END IF;
  IF v_gross <= 0 THEN RAISE EXCEPTION 'Vendor bill has no positive posting amount'; END IF;
  IF abs(v_gross - (v_bill.total_amount + v_wht_total)) > 0.02 THEN
    RAISE EXCEPTION 'Vendor bill totals do not reconcile: gross %, net AP %, WHT %',v_gross,v_bill.total_amount,v_wht_total;
  END IF;

  v_lines := v_lines || jsonb_build_object('account_id',v_ap,'debit_amount',0,'credit_amount',v_bill.total_amount,'description','AP: '||v_bill.bill_number);
  IF v_wht_total > 0 THEN
    v_lines := v_lines || jsonb_build_object('account_id',v_wht,'debit_amount',0,'credit_amount',v_wht_total,'description','WHT Payable: '||v_bill.bill_number);
  END IF;

  RETURN finance.post_journal_entry('AP Bill: '||v_bill.bill_number,p_transaction_date,p_period_id,v_lines,coalesce(v_bill.currency,'PKR'),coalesce(v_bill.exchange_rate,1),'VENDOR_BILL',p_bill_id,v_bill.project_id,NULL);
END;
$$;


ALTER FUNCTION "finance"."post_vendor_bill"("p_bill_id" "uuid", "p_period_id" "uuid", "p_transaction_date" "date") OWNER TO "postgres";


COMMENT ON FUNCTION "finance"."post_vendor_bill"("p_bill_id" "uuid", "p_period_id" "uuid", "p_transaction_date" "date") IS 'BUG-006 fix (database audit): posts using vendor_bills.currency / vendor_bills.exchange_rate instead of hard-coded PKR/1.0, so foreign-currency bills carry correct FX information into the journal. Retains the P1_060 role/org-ownership checks.';



CREATE OR REPLACE FUNCTION "finance"."post_vendor_payment"("p_payment_id" "uuid", "p_period_id" "uuid", "p_transaction_date" "date") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'finance', 'public'
    AS $$
DECLARE
    v_pay RECORD;
    v_fy_id UUID;
    v_ap_account UUID;
    v_bank_account UUID;
    v_wht_payable UUID;
    v_discount_account UUID;
    v_total_allocated NUMERIC(18,2);
    v_total_withholding NUMERIC(18,2);
    v_total_discount NUMERIC(18,2);
    v_total_bill_amount NUMERIC(18,2);
    v_lines JSONB := '[]'::JSONB;
BEGIN
    SELECT * INTO v_pay FROM finance.vendor_payments WHERE id = p_payment_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Payment not found'; END IF;

    SELECT fiscal_year_id INTO v_fy_id FROM finance.accounting_periods WHERE id = p_period_id;
    IF v_fy_id IS NULL THEN RAISE EXCEPTION 'Invalid period'; END IF;

    SELECT id INTO v_ap_account FROM finance.chart_of_accounts WHERE code = '2110' LIMIT 1;
    IF v_ap_account IS NULL THEN RAISE EXCEPTION 'AP account 2110 not found'; END IF;

    SELECT id INTO v_bank_account FROM finance.chart_of_accounts WHERE code = '1110' LIMIT 1;
    IF v_bank_account IS NULL THEN RAISE EXCEPTION 'Bank account 1110 not found'; END IF;

    SELECT id INTO v_wht_payable FROM finance.chart_of_accounts WHERE code = '2210' LIMIT 1;

    -- BUG-001 FIX: resolve the discount account (falls back to name match
    -- in case an org already had a differently-coded discount account
    -- before this migration ran).
    SELECT id INTO v_discount_account
    FROM finance.chart_of_accounts
    WHERE code = '4910' OR name ILIKE '%discount%'
    ORDER BY (code = '4910') DESC
    LIMIT 1;

    SELECT
        COALESCE(SUM(vpa.allocated_amount), 0),
        COALESCE(SUM(
            (SELECT COALESCE(SUM(COALESCE(bl.base_withholding_amount, bl.withholding_amount, 0)), 0)
             FROM finance.vendor_bill_lines bl
             WHERE bl.vendor_bill_id = vpa.vendor_bill_id)
        ), 0),
        COALESCE(SUM(vpa.discount_amount), 0),
        COALESCE(SUM(vb.total_amount), 0)
    INTO v_total_allocated, v_total_withholding, v_total_discount, v_total_bill_amount
    FROM finance.vendor_payment_allocations vpa
    JOIN finance.vendor_bills vb ON vb.id = vpa.vendor_bill_id
    WHERE vpa.vendor_payment_id = p_payment_id;

    IF v_total_discount > 0 AND v_discount_account IS NULL THEN
        RAISE EXCEPTION 'A discount was taken on this payment but no "Purchase Discounts Received" GL account exists. Run the BUG-001 fix migration or create one manually before posting.';
    END IF;

    -- Debit AP for the FULL bill amount being cleared (allocated + discount + withholding).
    -- C-05 fix: withholding must be included here too, since it is credited to WHT
    -- Payable below; omitting it left the journal unbalanced by v_total_withholding.
    IF (v_total_allocated + v_total_discount + v_total_withholding) > 0 THEN
        v_lines := v_lines || jsonb_build_object(
            'account_id', v_ap_account,
            'debit_amount', v_total_allocated + v_total_discount + v_total_withholding,
            'credit_amount', 0,
            'description', 'AP Cleared: ' || v_pay.payment_number
        );
    END IF;

    -- Credit Bank for the NET cash actually paid out
    IF v_total_allocated > 0 THEN
        v_lines := v_lines || jsonb_build_object(
            'account_id', v_bank_account,
            'debit_amount', 0,
            'credit_amount', v_total_allocated,
            'description', 'Paid to Vendor: ' || v_pay.payment_number
        );
    END IF;

    -- BUG-001 FIX: Credit Purchase Discounts Received so the journal
    -- balances (debit AP = credit Bank + credit Discount Received).
    IF v_total_discount > 0 THEN
        v_lines := v_lines || jsonb_build_object(
            'account_id', v_discount_account,
            'debit_amount', 0,
            'credit_amount', v_total_discount,
            'description', 'Early Payment Discount Taken: ' || v_pay.payment_number
        );
    END IF;

    -- Credit WHT Payable (deposit withholding tax)
    IF v_total_withholding > 0 AND v_wht_payable IS NOT NULL THEN
        v_lines := v_lines || jsonb_build_object(
            'account_id', v_wht_payable,
            'debit_amount', 0,
            'credit_amount', v_total_withholding,
            'description', 'WHT Deposited: ' || v_pay.payment_number
        );
    END IF;

    RETURN finance.post_journal_entry(
        'Vendor Payment: ' || v_pay.payment_number,
        p_transaction_date, p_period_id,
        v_lines,
        'PKR', 1.0000,
        'VENDOR_PAYMENT', p_payment_id,
        NULL, NULL
    );
END;
$$;


ALTER FUNCTION "finance"."post_vendor_payment"("p_payment_id" "uuid", "p_period_id" "uuid", "p_transaction_date" "date") OWNER TO "postgres";


COMMENT ON FUNCTION "finance"."post_vendor_payment"("p_payment_id" "uuid", "p_period_id" "uuid", "p_transaction_date" "date") IS 'BUG-001 fix (database audit): now posts vendor_payment_allocations.discount_amount to a Purchase Discounts Received GL line so debit AP always equals credit Bank + credit Discount, keeping the journal balanced.';



CREATE OR REPLACE FUNCTION "finance"."prevent_closed_period_posting"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$ DECLARE
  v_period_status TEXT;
BEGIN
  SELECT status INTO v_period_status
  FROM finance.accounting_periods WHERE id = NEW.period_id;

  IF v_period_status = 'HARD_CLOSED' THEN
    RAISE EXCEPTION 'Cannot post to a HARD CLOSED period.';
  END IF;

  IF v_period_status = 'SOFT_CLOSED' AND NEW.status = 'POSTED' THEN
    RAISE EXCEPTION 'Cannot post to a SOFT CLOSED period without special authorization.';
  END IF;

  RETURN NEW;
END;
 $$;


ALTER FUNCTION "finance"."prevent_closed_period_posting"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "finance"."prevent_locked_tax_rule_edit"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  IF TG_OP IN ('UPDATE','DELETE') AND OLD.status IN ('APPROVED','LOCKED','SUPERSEDED') THEN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'Cannot delete tax rule set "%" (status %): once approved it is retained for computations that reference it.', OLD.name, OLD.status
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF NEW.status = 'DRAFT' OR NEW.name IS DISTINCT FROM OLD.name
       OR NEW.jurisdiction IS DISTINCT FROM OLD.jurisdiction
       OR NEW.taxpayer_type IS DISTINCT FROM OLD.taxpayer_type
       OR NEW.tax_year IS DISTINCT FROM OLD.tax_year
    THEN
      RAISE EXCEPTION 'Cannot modify tax rule set "%": status is % (approved/locked). Create a new versioned rule set instead.', OLD.name, OLD.status
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;


ALTER FUNCTION "finance"."prevent_locked_tax_rule_edit"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "finance"."prevent_locked_tax_slab_edit"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
DECLARE
  v_status text;
BEGIN
  SELECT status INTO v_status FROM finance.tax_rule_sets WHERE id = COALESCE(NEW.tax_rule_set_id, OLD.tax_rule_set_id);
  IF v_status IN ('APPROVED','LOCKED','SUPERSEDED') THEN
    RAISE EXCEPTION 'Cannot modify tax slabs for a rule set with status %. Create a new versioned rule set instead.', v_status
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;


ALTER FUNCTION "finance"."prevent_locked_tax_slab_edit"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "finance"."prevent_posted_capital_transaction_edit"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'finance', 'public'
    AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'POSTED' THEN
      RAISE EXCEPTION 'Cannot delete a POSTED capital transaction (%). Reverse via the linked journal entry instead.', OLD.id;
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.status = 'POSTED' AND NEW.status = 'POSTED' THEN
    RAISE EXCEPTION 'Cannot edit a POSTED capital transaction (%). Correct via a reversing journal entry.', OLD.id;
  END IF;

  RETURN NEW;
END;
$$;


ALTER FUNCTION "finance"."prevent_posted_capital_transaction_edit"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "finance"."prevent_posted_edit"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$ BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    IF EXISTS (
      SELECT 1 FROM finance.journal_entries 
      WHERE id = OLD.journal_entry_id AND status = 'POSTED'
    ) THEN
      RAISE EXCEPTION 'Cannot modify journal lines of a POSTED entry. Create a Reversal.';
    END IF;
  END IF;

  IF TG_OP = 'UPDATE' AND OLD.account_id != NEW.account_id THEN
    IF EXISTS (
      SELECT 1 FROM finance.journal_entries 
      WHERE id = OLD.journal_entry_id AND status IN ('VERIFIED', 'APPROVED')
    ) THEN
      RAISE EXCEPTION 'Cannot change account on a verified/approved journal.';
    END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
 $$;


ALTER FUNCTION "finance"."prevent_posted_edit"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "finance"."prevent_posted_vendor_bill_edit"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') AND OLD.status = 'POSTED' THEN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'Cannot delete vendor bill "%": it is POSTED. Reverse it instead.', OLD.bill_number
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF NEW.total_amount IS DISTINCT FROM OLD.total_amount
       OR NEW.vendor_id IS DISTINCT FROM OLD.vendor_id
       OR NEW.currency IS DISTINCT FROM OLD.currency
       OR NEW.status NOT IN ('POSTED','PARTIALLY_PAID','PAID','REVERSED','CANCELLED')
    THEN
      RAISE EXCEPTION 'Cannot modify financial fields of vendor bill "%": it is POSTED. Reverse it instead.', OLD.bill_number
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;


ALTER FUNCTION "finance"."prevent_posted_vendor_bill_edit"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "finance"."prevent_used_financial_account_deletion"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
DECLARE
  v_statement_count INTEGER;
  v_transfer_count INTEGER;
  v_tax_payment_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO v_statement_count
  FROM finance.bank_statements
  WHERE financial_account_id = OLD.id;

  SELECT COUNT(*) INTO v_transfer_count
  FROM finance.bank_transfers
  WHERE from_account_id = OLD.id OR to_account_id = OLD.id;

  SELECT COUNT(*) INTO v_tax_payment_count
  FROM finance.tax_payments_and_refunds
  WHERE financial_account_id = OLD.id;

  IF v_statement_count > 0 OR v_transfer_count > 0 OR v_tax_payment_count > 0 THEN
    RAISE EXCEPTION
      'Cannot delete financial account "%": it has % bank statement(s), % transfer(s), and % tax payment/refund record(s) attached. Deactivate the account (is_active = false) instead of deleting it.',
      OLD.account_name, v_statement_count, v_transfer_count, v_tax_payment_count
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  RETURN OLD;
END;
$$;


ALTER FUNCTION "finance"."prevent_used_financial_account_deletion"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "finance"."prevent_used_fiscal_year_deletion"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
DECLARE
  v_period_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO v_period_count
  FROM finance.accounting_periods
  WHERE fiscal_year_id = OLD.id;

  IF v_period_count > 0 THEN
    RAISE EXCEPTION
      'Cannot delete fiscal year "%": it has % accounting period(s). Periods (and any journals posted to them) must never be silently cascade-deleted. Hard-close or archive the fiscal year instead of deleting it.',
      OLD.name, v_period_count
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  RETURN OLD;
END;
$$;


ALTER FUNCTION "finance"."prevent_used_fiscal_year_deletion"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "finance"."reset_sequence"("p_type" "text", "p_fy_id" "uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'finance', 'public'
    AS $$ BEGIN
    INSERT INTO finance.numbering_sequences (sequence_type, prefix, padding, fiscal_year_id, reset_per_period, format, created_by)
    SELECT 
        sequence_type, prefix, padding, p_fy_id, reset_per_period, format, auth.uid()
    FROM finance.numbering_sequences 
    WHERE sequence_type = p_type 
      AND fiscal_year_id IS NULL
    ON CONFLICT DO NOTHING;
END;
 $$;


ALTER FUNCTION "finance"."reset_sequence"("p_type" "text", "p_fy_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "finance"."reverse_journal_entry"("p_journal_id" "uuid", "p_reversal_date" "date", "p_reason" "text") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'finance', 'public', 'core'
    AS $$
DECLARE v_original record; v_reversal_id uuid; v_ref text; v_period_status text; v_org uuid := core.current_user_org_id();
BEGIN
  IF v_org IS NULL OR NOT (core.is_finance_head() OR core.has_role('ACCOUNTANT')) THEN RAISE EXCEPTION 'Access denied'; END IF;
  SELECT * INTO v_original FROM finance.journal_entries WHERE id=p_journal_id AND organization_id=v_org FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Journal not found or access denied'; END IF;
  IF v_original.status<>'POSTED' OR v_original.reversal_of_id IS NOT NULL THEN RAISE EXCEPTION 'Only original POSTED journal entries can be reversed'; END IF;
  IF p_reason IS NULL OR btrim(p_reason)='' THEN RAISE EXCEPTION 'Reversal reason is mandatory'; END IF;
  SELECT status INTO v_period_status FROM finance.accounting_periods WHERE id=v_original.period_id AND organization_id=v_org;
  IF v_period_status IS NULL OR v_period_status <> 'OPEN' THEN RAISE EXCEPTION 'Journal reversal requires an OPEN accounting period'; END IF;

  v_ref := finance.get_next_number('JOURNAL_ENTRY',v_org);
  UPDATE finance.journal_entries SET status='REVERSED',reversed_by=auth.uid(),reversed_at=now(),reversal_reason=p_reason WHERE id=p_journal_id;
  INSERT INTO finance.journal_entries(
    reference,description,status,transaction_date,posting_date,period_id,fiscal_year_id,currency,exchange_rate,base_currency,
    total_debit,total_credit,source_type,source_id,project_id,department_id,reversal_of_id,reversal_reason,created_by,posted_by,posted_at,organization_id
  ) VALUES(
    v_ref,'REVERSAL: '||v_original.description,'POSTED',p_reversal_date,current_date,v_original.period_id,v_original.fiscal_year_id,
    v_original.currency,v_original.exchange_rate,v_original.base_currency,v_original.total_credit,v_original.total_debit,
    'REVERSAL',p_journal_id,v_original.project_id,v_original.department_id,p_journal_id,p_reason,auth.uid(),auth.uid(),now(),v_org
  ) RETURNING id INTO v_reversal_id;

  INSERT INTO finance.journal_lines(
    journal_entry_id,line_number,account_id,description,debit_amount,credit_amount,currency,exchange_rate,base_debit,base_credit,project_id,department_id,created_by,organization_id
  )
  SELECT v_reversal_id,line_number,account_id,'REVERSAL: '||coalesce(description,''),credit_amount,debit_amount,currency,exchange_rate,base_credit,base_debit,project_id,department_id,auth.uid(),v_org
  FROM finance.journal_lines WHERE journal_entry_id=p_journal_id;
  RETURN v_reversal_id;
END;
$$;


ALTER FUNCTION "finance"."reverse_journal_entry"("p_journal_id" "uuid", "p_reversal_date" "date", "p_reason" "text") OWNER TO "postgres";


COMMENT ON FUNCTION "finance"."reverse_journal_entry"("p_journal_id" "uuid", "p_reversal_date" "date", "p_reason" "text") IS 'BUG-005 fix (database audit): added an explicit fiscal-period-lock check as defense-in-depth alongside the existing trg_prevent_closed_period_posting table trigger.';



CREATE OR REPLACE FUNCTION "finance"."reverse_payment_receipt_atomic"("p_receipt_id" "uuid", "p_period_id" "uuid", "p_reversal_date" "date", "p_reason" "text", "p_reversed_by" "uuid") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'finance', 'public', 'core'
    AS $$
DECLARE v_org uuid:=core.current_user_org_id(); v_r record; v_j record; v_new uuid; v_lines jsonb; v_ref text;
BEGIN
  IF v_org IS NULL OR p_reversed_by IS DISTINCT FROM auth.uid() THEN RAISE EXCEPTION 'Access denied'; END IF;
  IF NOT (core.is_finance_head() OR core.has_role('ACCOUNTANT')) THEN RAISE EXCEPTION 'Insufficient privileges'; END IF;
  IF p_reason IS NULL OR btrim(p_reason)='' THEN RAISE EXCEPTION 'Reason is required'; END IF;
  SELECT * INTO v_r FROM finance.payment_receipts WHERE id=p_receipt_id AND organization_id=v_org FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Payment receipt not found or access denied'; END IF;
  IF v_r.status='REVERSED' THEN RAISE EXCEPTION 'Payment receipt is already reversed'; END IF;
  SELECT * INTO v_j FROM finance.journal_entries WHERE id=v_r.journal_entry_id AND organization_id=v_org FOR UPDATE;
  IF NOT FOUND OR v_j.status<>'POSTED' THEN RAISE EXCEPTION 'Original payment journal is not POSTED'; END IF;
  IF NOT EXISTS (SELECT 1 FROM finance.accounting_periods WHERE id=p_period_id AND organization_id=v_org AND status='OPEN') THEN RAISE EXCEPTION 'Reversal period is not OPEN'; END IF;

  SELECT jsonb_agg(jsonb_build_object(
    'account_id',jl.account_id,
    'debit_amount',jl.credit_amount,
    'credit_amount',jl.debit_amount,
    'description','REVERSAL: '||coalesce(jl.description,'')
  ) ORDER BY jl.line_number) INTO v_lines
  FROM finance.journal_lines jl WHERE jl.journal_entry_id=v_j.id;

  v_new := finance.post_journal_entry(
    'REVERSAL: Payment Receipt '||coalesce(v_r.receipt_number,p_receipt_id::text)||' - '||p_reason,
    p_reversal_date,p_period_id,v_lines,v_r.currency,coalesce(v_r.exchange_rate,1),'PAYMENT_REVERSAL',p_receipt_id,v_r.project_id,NULL
  );

  SELECT reference INTO v_ref FROM finance.journal_entries WHERE id=v_new;
  UPDATE finance.payment_receipts SET status='REVERSED',updated_at=now(),posted_by=coalesce(posted_by,p_reversed_by) WHERE id=p_receipt_id;

  UPDATE finance.payment_allocations pa
  SET status='REVERSED',reversed_at=now(),reversed_by=p_reversed_by
  WHERE pa.payment_receipt_id=p_receipt_id AND pa.status='ACTIVE';

  UPDATE public.invoices i
  SET amount_paid=greatest(0,coalesce(i.amount_paid,0)-x.allocated_amount),
      base_amount_paid=greatest(0,coalesce(i.base_amount_paid,0)-x.base_allocated_amount),
      status=CASE WHEN greatest(0,coalesce(i.amount_paid,0)-x.allocated_amount)<=0.01 THEN 'ISSUED' ELSE 'PARTIALLY_PAID' END
  FROM (
    SELECT pa.invoice_id,sum(pa.allocated_amount) allocated_amount,sum(pa.base_allocated_amount) base_allocated_amount
    FROM finance.payment_allocations pa WHERE pa.payment_receipt_id=p_receipt_id AND pa.reversed_by=p_reversed_by AND pa.reversed_at IS NOT NULL
    GROUP BY pa.invoice_id
  ) x
  WHERE i.id=x.invoice_id AND i.organization_id=v_org;

  RETURN v_new;
END;
$$;


ALTER FUNCTION "finance"."reverse_payment_receipt_atomic"("p_receipt_id" "uuid", "p_period_id" "uuid", "p_reversal_date" "date", "p_reason" "text", "p_reversed_by" "uuid") OWNER TO "postgres";


COMMENT ON FUNCTION "finance"."reverse_payment_receipt_atomic"("p_receipt_id" "uuid", "p_period_id" "uuid", "p_reversal_date" "date", "p_reason" "text", "p_reversed_by" "uuid") IS 'Confirmed audit fix: atomic payment reversal across GL, receipt, allocations and invoice balances.';



CREATE OR REPLACE FUNCTION "finance"."snapshot_tax_rule_set"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  IF NEW.computation_json IS NULL AND NEW.tax_rule_set_id IS NOT NULL THEN
    SELECT jsonb_build_object(
      'rule_set', to_jsonb(trs.*),
      'slabs', (SELECT jsonb_agg(to_jsonb(ts.*) ORDER BY ts.sort_order) FROM finance.tax_slabs ts WHERE ts.tax_rule_set_id = trs.id),
      'snapshot_taken_at', now()
    )
    INTO NEW.computation_json
    FROM finance.tax_rule_sets trs
    WHERE trs.id = NEW.tax_rule_set_id;
  END IF;
  RETURN NEW;
END;
$$;


ALTER FUNCTION "finance"."snapshot_tax_rule_set"() OWNER TO "postgres";


COMMENT ON FUNCTION "finance"."snapshot_tax_rule_set"() IS 'Auto-populates tax_computations.computation_json with an immutable snapshot of the referenced tax_rule_set + tax_slabs at insert time (Spec 5.12.1). Applies to new rows only -- existing tax_computations rows created before this migration do not have a verified-accurate historical snapshot and require a manual decision (see Migration 033 notes) before they can be trusted for a filed return.';



CREATE OR REPLACE FUNCTION "finance"."sync_budget_line_committed_amount"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
DECLARE
  v_budget_line_id uuid;
  v_total numeric(18,2);
BEGIN
  v_budget_line_id := COALESCE(NEW.budget_line_id, OLD.budget_line_id);

  SELECT COALESCE(SUM(amount), 0) INTO v_total
  FROM finance.budget_commitments
  WHERE budget_line_id = v_budget_line_id
    AND status = 'OPEN';

  UPDATE finance.budget_lines
  SET committed_amount = v_total
  WHERE id = v_budget_line_id;

  RETURN COALESCE(NEW, OLD);
END;
$$;


ALTER FUNCTION "finance"."sync_budget_line_committed_amount"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "finance"."unmatch_statement_line"("p_line_id" "uuid", "p_reason" "text" DEFAULT NULL::"text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'finance', 'public'
    AS $$ DECLARE v_sl RECORD;
BEGIN
    SELECT * INTO v_sl FROM finance.statement_lines WHERE id = p_line_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Line not found'; END IF;
    IF v_sl.reconciliation_status NOT IN ('MATCHED','MANUAL_MATCH') THEN RAISE EXCEPTION 'Can only unmatch matched lines'; END IF;
    UPDATE finance.statement_lines SET reconciliation_status = 'UNRECONCILED', matched_journal_line_id = NULL, matched_at = NULL, matched_by = NULL, match_method = NULL WHERE id = p_line_id;
END;
 $$;


ALTER FUNCTION "finance"."unmatch_statement_line"("p_line_id" "uuid", "p_reason" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "finance"."validate_ownership_percentage_total"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'finance', 'public'
    AS $$
DECLARE
  v_check_date DATE;
  v_total_pct  NUMERIC(6,2);
  v_org        uuid;
BEGIN
  v_check_date := COALESCE(NEW.effective_from, CURRENT_DATE);

  SELECT o.organization_id INTO v_org
  FROM finance.owners o WHERE o.id = NEW.owner_id;

  SELECT COALESCE(SUM(oh.ownership_percentage), 0) INTO v_total_pct
  FROM finance.ownership_history oh
  JOIN finance.owners o ON o.id = oh.owner_id
  WHERE o.status = 'ACTIVE'
    AND o.organization_id = v_org
    AND oh.effective_from <= v_check_date
    AND (oh.effective_to IS NULL OR oh.effective_to >= v_check_date)
    AND oh.id IS DISTINCT FROM NEW.id;

  v_total_pct := v_total_pct + NEW.ownership_percentage;

  IF v_total_pct > 100.00 THEN
    RAISE EXCEPTION 'Ownership percentages for effective date % would total %% (Current Total: %), which exceeds 100%%. Adjust or end-date an existing ownership record first.', v_check_date, v_total_pct;
  END IF;

  RETURN NEW;
END;
$$;


ALTER FUNCTION "finance"."validate_ownership_percentage_total"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "finance"."validate_payment_allocation"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'finance', 'public'
    AS $$
DECLARE
  v_invoice_total       NUMERIC(18,2);
  v_invoice_allocated   NUMERIC(18,2);
  v_receipt_total       NUMERIC(18,2);
  v_receipt_allocated   NUMERIC(18,2);
BEGIN
  SELECT total_amount INTO v_invoice_total
  FROM public.invoices WHERE id = NEW.invoice_id FOR UPDATE;

  IF v_invoice_total IS NULL THEN
    RAISE EXCEPTION 'Cannot allocate payment: invoice % does not exist', NEW.invoice_id;
  END IF;

  SELECT COALESCE(SUM(allocated_amount), 0) INTO v_invoice_allocated
  FROM finance.payment_allocations
  WHERE invoice_id = NEW.invoice_id AND id IS DISTINCT FROM NEW.id;

  IF (v_invoice_allocated + NEW.allocated_amount) > v_invoice_total THEN
    RAISE EXCEPTION
      'Payment allocation of % exceeds invoice outstanding balance (already allocated %, invoice total %)',
      NEW.allocated_amount, v_invoice_allocated, v_invoice_total;
  END IF;

  -- NEW CHECK: don't let the sum of allocations against one payment
  -- receipt exceed what that receipt actually received.
  SELECT amount INTO v_receipt_total
  FROM finance.payment_receipts WHERE id = NEW.payment_receipt_id FOR UPDATE;

  IF v_receipt_total IS NULL THEN
    RAISE EXCEPTION 'Cannot allocate payment: payment receipt % does not exist', NEW.payment_receipt_id;
  END IF;

  SELECT COALESCE(SUM(allocated_amount), 0) INTO v_receipt_allocated
  FROM finance.payment_allocations
  WHERE payment_receipt_id = NEW.payment_receipt_id AND id IS DISTINCT FROM NEW.id;

  IF (v_receipt_allocated + NEW.allocated_amount) > v_receipt_total THEN
    RAISE EXCEPTION
      'Payment allocation of % exceeds the payment receipt''s own total (already allocated %, receipt total %)',
      NEW.allocated_amount, v_receipt_allocated, v_receipt_total;
  END IF;

  RETURN NEW;
END;
$$;


ALTER FUNCTION "finance"."validate_payment_allocation"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "finance"."validate_vendor_payment_allocation"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'finance', 'public'
    AS $$
DECLARE
  v_bill_total        NUMERIC(18,2);
  v_already_allocated NUMERIC(18,2);
BEGIN
  SELECT total_amount INTO v_bill_total
  FROM finance.vendor_bills
  WHERE id = NEW.vendor_bill_id
  FOR UPDATE;

  IF v_bill_total IS NULL THEN
    RAISE EXCEPTION 'Cannot allocate payment: vendor bill % does not exist', NEW.vendor_bill_id;
  END IF;

  SELECT COALESCE(SUM(allocated_amount), 0) INTO v_already_allocated
  FROM finance.vendor_payment_allocations
  WHERE vendor_bill_id = NEW.vendor_bill_id
    AND id IS DISTINCT FROM NEW.id;

  IF (v_already_allocated + NEW.allocated_amount) > v_bill_total THEN
    RAISE EXCEPTION
      'Vendor payment allocation of % exceeds bill outstanding balance (already allocated %, bill total %)',
      NEW.allocated_amount, v_already_allocated, v_bill_total;
  END IF;

  RETURN NEW;
END;
$$;


ALTER FUNCTION "finance"."validate_vendor_payment_allocation"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."balance_sheet"() RETURNS json
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'public', 'finance', 'core'
    AS $$
DECLARE
  v_org_id UUID := core.current_user_org_id();
  v_as_of DATE := CURRENT_DATE;
  v_result JSON;
BEGIN
  IF v_org_id IS NULL THEN
    RETURN json_build_object('assets', '[]'::json, 'liabilities', '[]'::json, 'equity', '[]'::json);
  END IF;

  WITH lines AS (
    SELECT
      coa.account_type,
      coa.code,
      coa.name AS account_name,
      CASE
        WHEN coa.normal_balance = 'DEBIT'
          THEN COALESCE(SUM(jl.base_debit), 0) - COALESCE(SUM(jl.base_credit), 0)
        ELSE COALESCE(SUM(jl.base_credit), 0) - COALESCE(SUM(jl.base_debit), 0)
      END AS total
    FROM finance.chart_of_accounts coa
    LEFT JOIN finance.journal_lines jl ON jl.account_id = coa.id
    LEFT JOIN finance.journal_entries je ON je.id = jl.journal_entry_id
      AND je.status = 'POSTED' AND je.organization_id = v_org_id
    LEFT JOIN finance.accounting_periods ap ON ap.id = je.period_id AND ap.end_date <= v_as_of
    WHERE coa.organization_id = v_org_id
      AND coa.is_active = true
      AND coa.account_type IN ('ASSET', 'LIABILITY', 'EQUITY')
    GROUP BY coa.id, coa.account_type, coa.code, coa.name, coa.normal_balance
    HAVING CASE
      WHEN coa.normal_balance = 'DEBIT'
        THEN COALESCE(SUM(jl.base_debit), 0) - COALESCE(SUM(jl.base_credit), 0)
      ELSE COALESCE(SUM(jl.base_credit), 0) - COALESCE(SUM(jl.base_debit), 0)
    END != 0
  )
  SELECT json_build_object(
    'assets', COALESCE((SELECT json_agg(json_build_object('code', code, 'account_name', account_name, 'account_type', account_type, 'total', total) ORDER BY code) FROM lines WHERE account_type = 'ASSET'), '[]'::json),
    'liabilities', COALESCE((SELECT json_agg(json_build_object('code', code, 'account_name', account_name, 'account_type', account_type, 'total', total) ORDER BY code) FROM lines WHERE account_type = 'LIABILITY'), '[]'::json),
    'equity', COALESCE((SELECT json_agg(json_build_object('code', code, 'account_name', account_name, 'account_type', account_type, 'total', total) ORDER BY code) FROM lines WHERE account_type = 'EQUITY'), '[]'::json)
  ) INTO v_result;

  RETURN v_result;
END;
$$;


ALTER FUNCTION "public"."balance_sheet"() OWNER TO "postgres";


COMMENT ON FUNCTION "public"."balance_sheet"() IS 'Org-scoped Balance Sheet as-of CURRENT_DATE for the calling user''s organization only. Fixes BUG-001 (see public.profit_and_loss comment for full context).';



CREATE OR REPLACE FUNCTION "public"."cash_flow"("p_start" "date" DEFAULT NULL::"date", "p_end" "date" DEFAULT NULL::"date") RETURNS json
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'public', 'finance', 'core'
    AS $$
DECLARE
  v_org_id UUID := core.current_user_org_id();
  v_start DATE := COALESCE(p_start, date_trunc('year', CURRENT_DATE)::date);
  v_end DATE := COALESCE(p_end, CURRENT_DATE);
  v_cash_balance NUMERIC;
  v_result JSON;
BEGIN
  IF v_org_id IS NULL THEN
    RETURN json_build_object('operating', '[]'::json, 'investing', '[]'::json, 'financing', '[]'::json, 'cash_balance', 0);
  END IF;

  -- Cash & bank sub-accounts are seeded as code 11xx under the "Cash and
  -- Bank" (1100) parent -- see phase_1_foundation/002_chart_of_accounts.sql.
  -- Receivables (12xx) are deliberately excluded by this LIKE pattern.
  SELECT COALESCE(SUM(
    CASE WHEN coa.normal_balance = 'DEBIT'
      THEN COALESCE(jl.base_debit, 0) - COALESCE(jl.base_credit, 0)
      ELSE COALESCE(jl.base_credit, 0) - COALESCE(jl.base_debit, 0)
    END
  ), 0)
  INTO v_cash_balance
  FROM finance.chart_of_accounts coa
  LEFT JOIN finance.journal_lines jl ON jl.account_id = coa.id
  LEFT JOIN finance.journal_entries je ON je.id = jl.journal_entry_id
    AND je.status = 'POSTED' AND je.organization_id = v_org_id
  LEFT JOIN finance.accounting_periods ap ON ap.id = je.period_id AND ap.end_date <= v_end
  WHERE coa.organization_id = v_org_id
    AND coa.account_type = 'ASSET'
    AND coa.code LIKE '11%';

  WITH operating AS (
    SELECT
      coa.name AS account_name,
      coa.account_type,
      -- C-12 fix: net both sides of every account instead of summing only one
      -- side. Previously a revenue account only summed credits (ignoring debit
      -- contra-entries like sales returns) and an expense account only summed
      -- debits (ignoring credit contra-entries like purchase returns), so those
      -- returns were silently dropped from the cash flow statement. For this
      -- operating-activities cash-flow sign convention, "credit_total -
      -- debit_total" is the correct net contribution for BOTH a credit-normal
      -- revenue account (net revenue) and a debit-normal expense account
      -- (negative of net expense) -- the sign flip is already built in.
      (COALESCE(SUM(jl.base_credit), 0) - COALESCE(SUM(jl.base_debit), 0)) AS total
    FROM finance.journal_lines jl
    JOIN finance.journal_entries je ON je.id = jl.journal_entry_id
      AND je.status = 'POSTED' AND je.organization_id = v_org_id
    JOIN finance.accounting_periods ap ON ap.id = je.period_id
    JOIN finance.chart_of_accounts coa ON coa.id = jl.account_id AND coa.organization_id = v_org_id
    WHERE ap.start_date >= v_start AND ap.end_date <= v_end
      AND coa.account_type IN ('REVENUE', 'COST_OF_SALES', 'OPERATING_EXPENSE')
    GROUP BY coa.name, coa.account_type
    HAVING (COALESCE(SUM(jl.base_credit), 0) - COALESCE(SUM(jl.base_debit), 0)) != 0

    UNION ALL

    SELECT
      'Change in ' || coa.name AS account_name,
      coa.account_type,
      -1 * (COALESCE(SUM(jl.base_debit), 0) - COALESCE(SUM(jl.base_credit), 0)) AS total
    FROM finance.journal_lines jl
    JOIN finance.journal_entries je ON je.id = jl.journal_entry_id
      AND je.status = 'POSTED' AND je.organization_id = v_org_id
    JOIN finance.accounting_periods ap ON ap.id = je.period_id
    JOIN finance.chart_of_accounts coa ON coa.id = jl.account_id AND coa.organization_id = v_org_id
    WHERE ap.start_date >= v_start AND ap.end_date <= v_end
      AND coa.account_type IN ('ASSET', 'LIABILITY')
      AND coa.code NOT LIKE '11%'   -- cash/bank movements are the plug, not a working-capital line
      AND coa.code NOT LIKE '15%'   -- fixed assets are investing, not operating
    GROUP BY coa.name, coa.account_type
    HAVING (COALESCE(SUM(jl.base_debit), 0) - COALESCE(SUM(jl.base_credit), 0)) != 0
  ),
  investing AS (
    SELECT
      coa.name AS account_name,
      coa.account_type,
      -1 * (COALESCE(SUM(jl.base_debit), 0) - COALESCE(SUM(jl.base_credit), 0)) AS total
    FROM finance.journal_lines jl
    JOIN finance.journal_entries je ON je.id = jl.journal_entry_id
      AND je.status = 'POSTED' AND je.organization_id = v_org_id
    JOIN finance.accounting_periods ap ON ap.id = je.period_id
    JOIN finance.chart_of_accounts coa ON coa.id = jl.account_id AND coa.organization_id = v_org_id
    WHERE ap.start_date >= v_start AND ap.end_date <= v_end
      AND coa.account_type = 'ASSET' AND coa.code LIKE '15%'
    GROUP BY coa.name, coa.account_type
    HAVING (COALESCE(SUM(jl.base_debit), 0) - COALESCE(SUM(jl.base_credit), 0)) != 0
  ),
  financing AS (
    SELECT
      coa.name AS account_name,
      coa.account_type,
      CASE WHEN coa.normal_balance = 'CREDIT'
        THEN COALESCE(SUM(jl.base_credit), 0) - COALESCE(SUM(jl.base_debit), 0)
        ELSE -1 * (COALESCE(SUM(jl.base_debit), 0) - COALESCE(SUM(jl.base_credit), 0))
      END AS total
    FROM finance.journal_lines jl
    JOIN finance.journal_entries je ON je.id = jl.journal_entry_id
      AND je.status = 'POSTED' AND je.organization_id = v_org_id
    JOIN finance.accounting_periods ap ON ap.id = je.period_id
    JOIN finance.chart_of_accounts coa ON coa.id = jl.account_id AND coa.organization_id = v_org_id
    WHERE ap.start_date >= v_start AND ap.end_date <= v_end
      AND coa.account_type = 'EQUITY'
    GROUP BY coa.name, coa.account_type, coa.normal_balance
    HAVING CASE WHEN coa.normal_balance = 'CREDIT'
      THEN COALESCE(SUM(jl.base_credit), 0) - COALESCE(SUM(jl.base_debit), 0)
      ELSE -1 * (COALESCE(SUM(jl.base_debit), 0) - COALESCE(SUM(jl.base_credit), 0))
    END != 0
  )
  SELECT json_build_object(
    'operating', COALESCE((SELECT json_agg(json_build_object('account_name', account_name, 'account_type', account_type, 'total', total) ORDER BY account_name) FROM operating), '[]'::json),
    'investing', COALESCE((SELECT json_agg(json_build_object('account_name', account_name, 'account_type', account_type, 'total', total) ORDER BY account_name) FROM investing), '[]'::json),
    'financing', COALESCE((SELECT json_agg(json_build_object('account_name', account_name, 'account_type', account_type, 'total', total) ORDER BY account_name) FROM financing), '[]'::json),
    'cash_balance', v_cash_balance
  ) INTO v_result;

  RETURN v_result;
END;
$$;


ALTER FUNCTION "public"."cash_flow"("p_start" "date", "p_end" "date") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."cash_flow"("p_start" "date", "p_end" "date") IS 'Org-scoped indirect-method Cash Flow for the calling user''s organization only. cash_balance is the as-of-p_end balance of code 11xx (cash/bank) accounts. Fixes BUG-001 (see public.profit_and_loss comment for full context).';



CREATE OR REPLACE FUNCTION "public"."create_user_by_admin"("p_email" "text", "p_password" "text", "p_role" "text" DEFAULT 'EMPLOYEE'::"text", "p_full_name" "text" DEFAULT ''::"text") RETURNS json
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'public'
    AS $$
DECLARE
  v_new_user_id UUID;
BEGIN
  IF NOT core.has_permission(auth.uid(), 'ADMIN_USERS') THEN
    RETURN json_build_object('error', 'Only users with ADMIN_USERS permission can create users')::JSON;
  END IF;

  INSERT INTO auth.users (
    instance_id, id, email, encrypted_password, email_confirmed_at,
    raw_user_meta_data, created_at, updated_at, aud, role,
    confirmation_token, recovery_token, email_change_token_new, email_change, invited_at
  ) VALUES (
    '00000000-0000-0000-0000-000000000000',
    gen_random_uuid(),
    p_email,
    crypt(p_password, gen_salt('bf')),
    NOW(),
    jsonb_build_object('full_name', p_full_name),
    NOW(), NOW(),
    'authenticated', 'authenticated',
    '', '', '', '', NULL
  )
  RETURNING id INTO v_new_user_id;

  INSERT INTO public.profiles (user_id, email, full_name, role, organization_id)
  VALUES (v_new_user_id, p_email, p_full_name, p_role, core.current_user_org_id());

  RETURN json_build_object('success', true, 'message', 'User created successfully')::JSON;

EXCEPTION
  WHEN unique_violation THEN
    RETURN json_build_object('error', 'User with this email already exists')::JSON;
  WHEN OTHERS THEN
    RETURN json_build_object('error', SQLERRM)::JSON;
END;
$$;


ALTER FUNCTION "public"."create_user_by_admin"("p_email" "text", "p_password" "text", "p_role" "text", "p_full_name" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."ensure_profile_exists"("target_user_id" "uuid") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'public'
    AS $$
DECLARE
  v_profile_id UUID;
  v_email TEXT;
BEGIN
  -- Self-service only: a user may only ensure their OWN profile exists.
  -- (Admin-initiated user creation is a separate, permission-gated path.)
  IF auth.uid() IS NULL OR auth.uid() <> target_user_id THEN
    RAISE EXCEPTION 'Access denied: ensure_profile_exists may only be called for the current user';
  END IF;

  SELECT id INTO v_profile_id FROM public.profiles WHERE user_id = target_user_id;
  IF v_profile_id IS NOT NULL THEN
    RETURN v_profile_id;
  END IF;

  SELECT email INTO v_email FROM auth.users WHERE id = target_user_id;

  INSERT INTO public.profiles (user_id, email, full_name, role)
  VALUES (target_user_id, v_email, '', 'EMPLOYEE')
  RETURNING id INTO v_profile_id;

  RETURN v_profile_id;
END;
$$;


ALTER FUNCTION "public"."ensure_profile_exists"("target_user_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."execute_ai_readonly_query"("query_string" "text", "p_org_id" "uuid", "p_user_id" "uuid", "p_enforce_user_scope" boolean DEFAULT true) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'public', 'reporting', 'core'
    AS $$
DECLARE
  result jsonb;
  wrapped_sql text;
  q text := btrim(query_string);
  v_org uuid := core.current_user_org_id();
  v_user uuid := auth.uid();
BEGIN
  IF v_org IS NULL OR v_org <> p_org_id OR v_user IS NULL OR v_user <> p_user_id THEN
    RAISE EXCEPTION 'Access denied: AI scope must match authenticated user and organization';
  END IF;

  IF q = '' OR q ~ E'[;]' OR q ~ E'(--|/\\*|\\*/)' THEN
    RAISE EXCEPTION 'AI query rejected: comments and multiple statements are not allowed';
  END IF;

  IF q !~* E'^SELECT[[:space:]]' AND q !~* E'^WITH[[:space:]]' THEN
    RAISE EXCEPTION 'AI query rejected: only SELECT/WITH queries are allowed';
  END IF;

  IF q ~* E'\\m(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|GRANT|REVOKE|COPY|CALL|DO|EXECUTE|SET|RESET)\\M' THEN
    RAISE EXCEPTION 'AI query rejected: unsafe SQL keyword detected';
  END IF;

  IF q ~* E'\\m(JOIN|UNION|INTERSECT|EXCEPT|LATERAL)\\M' THEN
    RAISE EXCEPTION 'AI query rejected: joins/set operations are not permitted';
  END IF;

  -- Only reporting views plus the organization-scoped policy_documents table
  -- are exposed to AI. No direct finance/core/audit/auth/system relation access.
  IF q ~* E'\\m(finance|core|audit|auth|pg_catalog|information_schema)\\.' THEN
    RAISE EXCEPTION 'AI query rejected: non-reporting objects are not allowed';
  END IF;

  IF q !~* E'\\mreporting\\.(general_ledger|trial_balance|balance_sheet|budget_vs_actual|budget_category_summary|budget_gl_actual|cash_flow|changes_in_equity|payable_aging|pnl|receivable_aging|reconciliation_summary|unreconciled_lines|v_asset_register|v_cash_position|v_depreciation_summary|v_project_profitability|v_tax_computation_summary|ai_fiscal_close_context)\\M'
     AND q !~* E'\\mpublic\\.policy_documents\\M' THEN
    RAISE EXCEPTION 'AI query rejected: source is not on the approved allowlist';
  END IF;

  SET LOCAL ROLE ai_readonly_role;
  SET LOCAL statement_timeout = '5s';

  -- Every approved source query must carry an organization predicate. We
  -- normalize the predicate to the authenticated organization so a direct RPC
  -- caller cannot substitute another UUID. Aggregate-style queries used by the
  -- existing AI routes are executed as-is after this normalization; raw SELECTs
  -- are additionally wrapped with a server-side tenant predicate and LIMIT.
  IF q !~* E'organization_id[[:space:]]*=[[:space:]]*''[0-9a-fA-F-]{36}''' THEN
    RAISE EXCEPTION 'AI query rejected: organization_id predicate is required';
  END IF;
  q := regexp_replace(q, '(organization_id[[:space:]]*=[[:space:]]*)''[0-9a-fA-F-]{36}''', E'\\1' || quote_literal(p_org_id), 'gi');

  IF p_enforce_user_scope THEN
    IF q !~* E'user_id[[:space:]]*=[[:space:]]*''[0-9a-fA-F-]{36}''' THEN
      RAISE EXCEPTION 'AI query rejected: user_id predicate is required for this tool';
    END IF;
    q := regexp_replace(q, '(user_id[[:space:]]*=[[:space:]]*)''[0-9a-fA-F-]{36}''', E'\\1' || quote_literal(p_user_id), 'gi');
  END IF;

  IF q ~* E'jsonb_agg[[:space:]]*\(' THEN
    wrapped_sql := q;
  ELSE
    wrapped_sql := format(
      'SELECT COALESCE(jsonb_agg(t), ''[]''::jsonb) FROM (SELECT * FROM (%s) llm_query LIMIT 200) t',
      q
    );
  END IF;

  EXECUTE wrapped_sql INTO result;
  RESET ROLE;
  RESET statement_timeout;
  RETURN COALESCE(result, '[]'::jsonb);
EXCEPTION
  WHEN query_canceled THEN
    RESET ROLE;
    RAISE EXCEPTION 'AI query timed out after 5 seconds';
  WHEN insufficient_privilege THEN
    RESET ROLE;
    RAISE EXCEPTION 'Access denied: AI can only query approved read-only sources';
  WHEN undefined_column THEN
    RESET ROLE;
    RAISE EXCEPTION 'Approved AI source does not expose the required organization/user scope';
  WHEN OTHERS THEN
    RESET ROLE;
    RAISE EXCEPTION 'AI query rejected or failed: %', SQLERRM;
END;
$$;


ALTER FUNCTION "public"."execute_ai_readonly_query"("query_string" "text", "p_org_id" "uuid", "p_user_id" "uuid", "p_enforce_user_scope" boolean) OWNER TO "postgres";


COMMENT ON FUNCTION "public"."execute_ai_readonly_query"("query_string" "text", "p_org_id" "uuid", "p_user_id" "uuid", "p_enforce_user_scope" boolean) IS 'Confirmed audit fix: database-side AI SQL allowlist, tenant scope and ai_readonly_role execution.';



CREATE OR REPLACE FUNCTION "public"."execute_sql_query"("query_string" "text") RETURNS json
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'public'
    AS $$
DECLARE
  result JSON;
  lower_query TEXT;
BEGIN
  IF COALESCE(current_setting('request.jwt.claim.role', true), '') <> 'service_role' THEN
    RAISE EXCEPTION 'Access denied: service_role required';
  END IF;

  lower_query := LOWER(TRIM(query_string));
  IF NOT (LEFT(lower_query, 6) = 'select' OR LEFT(lower_query, 4) = 'with') THEN
    RAISE EXCEPTION 'Only SELECT queries are allowed';
  END IF;
  IF lower_query ~* '\m(drop|delete|update|insert|alter|create|truncate|grant|revoke)\M' THEN
    RAISE EXCEPTION 'Dangerous operation not allowed';
  END IF;

  BEGIN
    EXECUTE format('SELECT json_agg(t) FROM (%s) t', query_string) INTO result;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'SQL Error: %', SQLERRM;
  END;
  RETURN COALESCE(result, '[]'::JSON);
END;
$$;


ALTER FUNCTION "public"."execute_sql_query"("query_string" "text") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."execute_sql_query"("query_string" "text") IS 'RESTRICTED to service_role only (migration 027). This function has no schema/table allowlist and runs as the function owner, bypassing RLS. It must never be reachable from the AI gateway or any authenticated end-user session; use public.execute_ai_readonly_query (scoped to the ai_readonly_role and public/reporting schemas) for AI-driven querying instead, per spec Section 9.5.';



CREATE OR REPLACE FUNCTION "public"."find_auth_user_by_email"("search_email" "text") RETURNS TABLE("user_id" "uuid", "email" "text")
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'public', 'core'
    AS $$
BEGIN
  IF NOT core.has_permission(auth.uid(), 'ADMIN_USERS') THEN
    RAISE EXCEPTION 'Access denied: ADMIN_USERS permission required';
  END IF;

  RETURN QUERY
  SELECT u.id, u.email
  FROM auth.users u
  WHERE u.email ILIKE '%' || search_email || '%'
  LIMIT 10;
END;
$$;


ALTER FUNCTION "public"."find_auth_user_by_email"("search_email" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_all_system_users"() RETURNS TABLE("user_id" "uuid", "email" "text", "full_name" "text", "profile_role" "text", "has_profile" boolean)
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'public', 'core'
    AS $$
BEGIN
  IF NOT core.has_permission(auth.uid(), 'ADMIN_USERS') THEN
    RAISE EXCEPTION 'Access denied: ADMIN_USERS permission required';
  END IF;

  RETURN QUERY
  SELECT
    u.id AS user_id,
    u.email,
    COALESCE(p.full_name, '') AS full_name,
    p.role AS profile_role,
    (p.id IS NOT NULL) AS has_profile
  FROM auth.users u
  JOIN public.profiles p ON p.user_id = u.id
  WHERE p.organization_id = core.current_user_org_id()
  ORDER BY COALESCE(p.full_name, u.email);
END;
$$;


ALTER FUNCTION "public"."get_all_system_users"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_my_permissions"() RETURNS TABLE("permission_code" "text", "permission_name" "text", "module" "text", "data_scope" "text")
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'public'
    AS $$ BEGIN
  RETURN QUERY
  SELECT DISTINCT
    p.code AS permission_code,
    p.name AS permission_name,
    p.module,
    rp.data_scope
  FROM public.user_roles ur
  JOIN public.role_permissions rp ON rp.role_id = ur.role_id
  JOIN public.permissions p ON p.id = rp.permission_id
  WHERE ur.user_id = auth.uid()
    AND ur.is_active = true
    AND (ur.effective_to IS NULL OR ur.effective_to >= CURRENT_DATE)
    AND rp.effective_from <= CURRENT_DATE
    AND (rp.effective_to IS NULL OR rp.effective_to >= CURRENT_DATE)
  ORDER BY p.module, p.code;
END;
$$;


ALTER FUNCTION "public"."get_my_permissions"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_my_user_roles"() RETURNS TABLE("role_id" "uuid", "role" "text", "display_name" "text", "is_active" boolean, "effective_from" "date", "effective_to" "date", "level" integer)
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'public'
    AS $$ BEGIN
  RETURN QUERY
  SELECT 
    r.id AS role_id,
    r.name AS role,
    r.display_name,
    ur.is_active,
    ur.effective_from,
    ur.effective_to,
    r.level
  FROM public.user_roles ur
  JOIN public.roles r ON r.id = ur.role_id
  WHERE ur.user_id = auth.uid()
    AND ur.is_active = true
    AND ur.effective_from <= CURRENT_DATE
    AND (ur.effective_to IS NULL OR ur.effective_to >= CURRENT_DATE)
  ORDER BY r.level DESC;
END;
$$;


ALTER FUNCTION "public"."get_my_user_roles"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_user_permissions"("p_user_id" "uuid") RETURNS TABLE("code" "text", "module" "text", "action" "text", "data_scope" "text", "amount_limit" numeric)
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'public'
    AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Access denied: authentication required';
  END IF;
  -- A caller may fetch their own permission set, or an ADMIN_USERS
  -- holder may look up someone else's -- both still resolved via
  -- core.get_user_permissions, which is itself org/user scoped.
  IF p_user_id <> auth.uid() AND NOT core.has_permission(auth.uid(), 'ADMIN_USERS') THEN
    RAISE EXCEPTION 'Access denied: cannot read another user''s permissions';
  END IF;
  RETURN QUERY SELECT * FROM core.get_user_permissions(p_user_id);
END;
$$;


ALTER FUNCTION "public"."get_user_permissions"("p_user_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_user_roles_by_id"("p_target_user_id" "uuid") RETURNS TABLE("id" "uuid", "user_id" "uuid", "role_id" "uuid", "role" "text", "role_display_name" "text", "role_level" integer, "is_active" boolean, "effective_from" "date", "effective_to" "date", "delegated_from" "uuid", "created_at" timestamp with time zone, "updated_at" timestamp with time zone, "created_by" "uuid")
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'public', 'core'
    AS $$
BEGIN
  IF auth.uid() IS DISTINCT FROM p_target_user_id
     AND NOT core.has_permission(auth.uid(), 'ADMIN_USERS') THEN
    RAISE EXCEPTION 'Access denied: cannot view another user''s role history';
  END IF;

  RETURN QUERY
  SELECT
    ur.id, ur.user_id, ur.role_id, r.name, r.display_name, r.level,
    ur.is_active, ur.effective_from, ur.effective_to, ur.delegated_from,
    ur.created_at, ur.updated_at, ur.created_by
  FROM core.user_roles ur
  INNER JOIN core.roles r ON r.id = ur.role_id
  WHERE ur.user_id = p_target_user_id;
END;
$$;


ALTER FUNCTION "public"."get_user_roles_by_id"("p_target_user_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."handle_new_user"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'public', 'core'
    AS $$
DECLARE
  v_org_id uuid;
  v_org_name text;
BEGIN
  v_org_name := NULLIF(btrim(COALESCE(NEW.raw_user_meta_data->>'organization_name', '')), '');

  IF v_org_name IS NOT NULL THEN
    INSERT INTO core.organizations (
      name, legal_name, created_by, is_active
    ) VALUES (
      v_org_name, v_org_name, NEW.id, true
    )
    RETURNING id INTO v_org_id;
  END IF;

  INSERT INTO public.profiles (
    user_id, full_name, role, email, organization_id,
    can_create_project, can_edit_project, can_delete_project,
    can_add_income, can_edit_income, can_delete_income,
    can_add_expense, can_edit_expense, can_delete_expense,
    can_create_invoice, can_edit_invoice, can_delete_invoice
  )
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data->>'full_name', ''),
    CASE WHEN v_org_id IS NOT NULL THEN 'CEO' ELSE 'EMPLOYEE' END,
    NEW.email,
    v_org_id,
    false, false, false,
    false, false, false,
    false, false, false,
    false, false, false
  );

  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."handle_new_user"() OWNER TO "postgres";


COMMENT ON FUNCTION "public"."handle_new_user"() IS 'Creates an organization-scoped profile for self-service signups when organization_name is supplied. Existing admin-created users without organization metadata remain unassigned until explicitly provisioned.';



CREATE OR REPLACE FUNCTION "public"."is_admin"() RETURNS boolean
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'core', 'public'
    AS $$
BEGIN
    RETURN core.is_finance_head();
END;
$$;


ALTER FUNCTION "public"."is_admin"() OWNER TO "postgres";


COMMENT ON FUNCTION "public"."is_admin"() IS 'Redefined by P1_059 (Remediation ISS-03, High). Previously read public.profiles.role = ''Admin'', a value profiles_role_check never permits, so this function was always false. Now delegates to core.is_finance_head() (CEO or FINANCE_HEAD), the correct organization-aware elevated role used throughout core/finance. Callers still need their own core.same_org(...) check for the row in question -- this function alone does not know which organization a given row belongs to. See P1_059 STEP 13 for the profiles/user_mfa/payments policies that were rewritten to add that check explicitly.';



CREATE OR REPLACE FUNCTION "public"."payroll_generate_employee_code"() RETURNS character varying
    LANGUAGE "plpgsql"
    AS $$
DECLARE
  next_num INTEGER;
  code VARCHAR(20);
  exists BOOLEAN;
BEGIN
  LOOP
    next_num := nextval('public.payroll_employee_code_seq');
    code := 'EMP-' || LPAD(next_num::TEXT, 4, '0');
    SELECT EXISTS(SELECT 1 FROM public.payroll_employees WHERE employee_code = code) INTO exists;
    IF NOT exists THEN RETURN code; END IF;
  END LOOP;
END;
$$;


ALTER FUNCTION "public"."payroll_generate_employee_code"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."payroll_update_timestamp"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."payroll_update_timestamp"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."prevent_posted_invoice_deletion"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
DECLARE
  v_credit_note_count INTEGER;
  v_allocation_count INTEGER;
BEGIN
  IF OLD.journal_entry_id IS NOT NULL THEN
    RAISE EXCEPTION
      'Cannot delete invoice "%": it has already been posted to the general ledger (journal_entry_id = %). Void or reverse it instead.',
      OLD.invoice_number, OLD.journal_entry_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  SELECT COUNT(*) INTO v_credit_note_count
  FROM finance.credit_notes
  WHERE invoice_id = OLD.id;

  IF v_credit_note_count > 0 THEN
    RAISE EXCEPTION
      'Cannot delete invoice "%": it has % linked credit note(s).',
      OLD.invoice_number, v_credit_note_count
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  SELECT COUNT(*) INTO v_allocation_count
  FROM finance.payment_allocations
  WHERE invoice_id = OLD.id;

  IF v_allocation_count > 0 THEN
    RAISE EXCEPTION
      'Cannot delete invoice "%": it has % payment allocation(s) applied.',
      OLD.invoice_number, v_allocation_count
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  RETURN OLD;
END;
$$;


ALTER FUNCTION "public"."prevent_posted_invoice_deletion"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."prevent_posted_invoice_edit"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  IF OLD.journal_entry_id IS NOT NULL THEN
    -- Allow status/payment-tracking fields to keep moving (paid amount,
    -- status, updated_at) since those reflect real subsequent events
    -- (payments, void) rather than rewriting the posted financial facts.
    IF NEW.total_amount IS DISTINCT FROM OLD.total_amount
       OR NEW.tax_amount IS DISTINCT FROM OLD.tax_amount
       OR NEW.currency IS DISTINCT FROM OLD.currency
       OR NEW.client_id IS DISTINCT FROM OLD.client_id
       OR NEW.issue_date IS DISTINCT FROM OLD.issue_date
       OR NEW.journal_entry_id IS DISTINCT FROM OLD.journal_entry_id
    THEN
      RAISE EXCEPTION
        'Cannot modify financial fields of invoice "%": it has already been posted to the general ledger (journal_entry_id = %). Issue a credit note or reversal instead.',
        OLD.invoice_number, OLD.journal_entry_id
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."prevent_posted_invoice_edit"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."prevent_posted_payroll_run_edit"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') AND OLD.status = 'POSTED' THEN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'Cannot delete payroll run "%": it is POSTED.', OLD.id
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF NEW.status NOT IN ('POSTED','CANCELLED') THEN
      RAISE EXCEPTION 'Cannot modify a POSTED payroll run (id %). Create an adjustment run instead.', OLD.id
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."prevent_posted_payroll_run_edit"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."profit_and_loss"("p_start" "date" DEFAULT NULL::"date", "p_end" "date" DEFAULT NULL::"date") RETURNS json
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'public', 'finance', 'core'
    AS $$
DECLARE
  v_org_id UUID := core.current_user_org_id();
  v_start DATE := COALESCE(p_start, date_trunc('year', CURRENT_DATE)::date);
  v_end DATE := COALESCE(p_end, CURRENT_DATE);
  v_result JSON;
BEGIN
  IF v_org_id IS NULL THEN
    RETURN json_build_object(
      'revenue', '[]'::json, 'cost_of_sales', '[]'::json,
      'operating_expenses', '[]'::json, 'other_income', '[]'::json,
      'other_expenses', '[]'::json
    );
  END IF;

  WITH lines AS (
    SELECT
      coa.account_type,
      coa.code,
      coa.name AS account_name,
      COALESCE(SUM(jl.base_debit), 0) AS debit_total,
      COALESCE(SUM(jl.base_credit), 0) AS credit_total,
      CASE
        WHEN coa.normal_balance = 'DEBIT'
          THEN COALESCE(SUM(jl.base_debit), 0) - COALESCE(SUM(jl.base_credit), 0)
        ELSE COALESCE(SUM(jl.base_credit), 0) - COALESCE(SUM(jl.base_debit), 0)
      END AS total
    FROM finance.chart_of_accounts coa
    JOIN finance.journal_lines jl ON jl.account_id = coa.id
    JOIN finance.journal_entries je ON je.id = jl.journal_entry_id
    JOIN finance.accounting_periods ap ON ap.id = je.period_id
    WHERE je.status = 'POSTED'
      AND je.organization_id = v_org_id
      AND coa.organization_id = v_org_id
      AND ap.start_date >= v_start
      AND ap.end_date <= v_end
      AND coa.is_active = true
      AND coa.account_type IN ('REVENUE', 'COST_OF_SALES', 'OPERATING_EXPENSE', 'OTHER_INCOME', 'OTHER_EXPENSE')
    GROUP BY coa.id, coa.account_type, coa.code, coa.name, coa.normal_balance
    HAVING CASE
      WHEN coa.normal_balance = 'DEBIT'
        THEN COALESCE(SUM(jl.base_debit), 0) - COALESCE(SUM(jl.base_credit), 0)
      ELSE COALESCE(SUM(jl.base_credit), 0) - COALESCE(SUM(jl.base_debit), 0)
    END != 0
  )
  SELECT json_build_object(
    'revenue', COALESCE((SELECT json_agg(json_build_object('code', code, 'account_name', account_name, 'total', total, 'debit_total', debit_total, 'credit_total', credit_total) ORDER BY code) FROM lines WHERE account_type = 'REVENUE'), '[]'::json),
    'cost_of_sales', COALESCE((SELECT json_agg(json_build_object('code', code, 'account_name', account_name, 'total', total, 'debit_total', debit_total, 'credit_total', credit_total) ORDER BY code) FROM lines WHERE account_type = 'COST_OF_SALES'), '[]'::json),
    'operating_expenses', COALESCE((SELECT json_agg(json_build_object('code', code, 'account_name', account_name, 'total', total, 'debit_total', debit_total, 'credit_total', credit_total) ORDER BY code) FROM lines WHERE account_type = 'OPERATING_EXPENSE'), '[]'::json),
    'other_income', COALESCE((SELECT json_agg(json_build_object('code', code, 'account_name', account_name, 'total', total, 'debit_total', debit_total, 'credit_total', credit_total) ORDER BY code) FROM lines WHERE account_type = 'OTHER_INCOME'), '[]'::json),
    'other_expenses', COALESCE((SELECT json_agg(json_build_object('code', code, 'account_name', account_name, 'total', total, 'debit_total', debit_total, 'credit_total', credit_total) ORDER BY code) FROM lines WHERE account_type = 'OTHER_EXPENSE'), '[]'::json)
  ) INTO v_result;

  RETURN v_result;
END;
$$;


ALTER FUNCTION "public"."profit_and_loss"("p_start" "date", "p_end" "date") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."profit_and_loss"("p_start" "date", "p_end" "date") IS 'Org-scoped P&L for the calling user''s organization only (resolved via core.current_user_org_id(), not caller-supplied). Fixes BUG-001: previously the frontend called a function (public.profit_and_loss) that did not exist -- reporting.get_profit_and_loss existed but lives in a schema PostgREST never exposes and returns a different shape.';



CREATE OR REPLACE FUNCTION "public"."rls_auto_enable"() RETURNS "event_trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'pg_catalog'
    AS $$
DECLARE
  cmd record;
BEGIN
  FOR cmd IN
    SELECT *
    FROM pg_event_trigger_ddl_commands()
    WHERE command_tag IN ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
      AND object_type IN ('table','partitioned table')
  LOOP
     IF cmd.schema_name IS NOT NULL AND cmd.schema_name IN ('public') AND cmd.schema_name NOT IN ('pg_catalog','information_schema') AND cmd.schema_name NOT LIKE 'pg_toast%' AND cmd.schema_name NOT LIKE 'pg_temp%' THEN
      BEGIN
        EXECUTE format('alter table if exists %s enable row level security', cmd.object_identity);
        RAISE LOG 'rls_auto_enable: enabled RLS on %', cmd.object_identity;
      EXCEPTION
        WHEN OTHERS THEN
          RAISE LOG 'rls_auto_enable: failed to enable RLS on %', cmd.object_identity;
      END;
     ELSE
        RAISE LOG 'rls_auto_enable: skip % (either system schema or not in enforced list: %.)', cmd.object_identity, cmd.schema_name;
     END IF;
  END LOOP;
END;
$$;


ALTER FUNCTION "public"."rls_auto_enable"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."sync_invoice_client_name"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'public'
    AS $$
DECLARE
  v_client_name TEXT;
BEGIN
  IF NEW.client_id IS NOT NULL THEN
    SELECT name INTO v_client_name FROM public.clients WHERE id = NEW.client_id;
    IF v_client_name IS NOT NULL THEN
      NEW.client_name := v_client_name;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."sync_invoice_client_name"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."update_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$ BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
 $$;


ALTER FUNCTION "public"."update_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."user_has_role"("p_role_name" "text") RETURNS boolean
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'public'
    AS $$ DECLARE
  v_current_user uuid;
  v_result boolean;
BEGIN
  v_current_user := (current_setting('request.jwt.claims', true)::json->>'sub')::uuid;
  
  SELECT EXISTS (
    SELECT 1 
    FROM core.user_roles ur
    INNER JOIN core.roles r ON r.id = ur.role_id
    WHERE ur.user_id = v_current_user
      AND r.name = p_role_name
      AND ur.is_active = true
      AND ur.effective_from <= CURRENT_DATE
      AND (ur.effective_to IS NULL OR ur.effective_to >= CURRENT_DATE)
  ) INTO v_result;
  
  RETURN v_result;
END;
 $$;


ALTER FUNCTION "public"."user_has_role"("p_role_name" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "reporting"."cash_distribution"() RETURNS json
    LANGUAGE "plpgsql" STABLE
    SET "search_path" TO 'pg_catalog', 'reporting', 'public'
    AS $$ BEGIN
  RETURN COALESCE(json_agg(row_to_json(t)), '[]'::JSON) FROM (
    SELECT id, account_name, institution_type, currency, masked_identifier, opening_balance as balance
    FROM finance.financial_accounts WHERE is_active = true ORDER BY opening_balance DESC
  ) t;
END;
 $$;


ALTER FUNCTION "reporting"."cash_distribution"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "reporting"."ceo_chart_aging"() RETURNS json
    LANGUAGE "plpgsql" STABLE
    SET "search_path" TO 'pg_catalog', 'reporting', 'public'
    AS $$ BEGIN
  RETURN json_build_object(
    'receivable', COALESCE(json_build_object(
      'current', COALESCE((SELECT SUM(COALESCE(outstanding_amount, 0)) FROM public.invoices WHERE status IN ('ISSUED','PARTIALLY_PAID','OVERDUE') AND due_date >= CURRENT_DATE), 0),
      'overdue_1_30', COALESCE((SELECT SUM(COALESCE(outstanding_amount, 0)) FROM public.invoices WHERE status IN ('ISSUED','PARTIALLY_PAID','OVERDUE') AND due_date < CURRENT_DATE AND due_date >= CURRENT_DATE - INTERVAL '30 days'), 0),
      'overdue_31_60', COALESCE((SELECT SUM(COALESCE(outstanding_amount, 0)) FROM public.invoices WHERE status IN ('ISSUED','PARTIALLY_PAID','OVERDUE') AND due_date < CURRENT_DATE - INTERVAL '30 days' AND due_date >= CURRENT_DATE - INTERVAL '60 days'), 0),
      'overdue_61_90', COALESCE((SELECT SUM(COALESCE(outstanding_amount, 0)) FROM public.invoices WHERE status IN ('ISSUED','PARTIALLY_PAID','OVERDUE') AND due_date < CURRENT_DATE - INTERVAL '60 days' AND due_date >= CURRENT_DATE - INTERVAL '90 days'), 0),
      'overdue_over_90', COALESCE((SELECT SUM(COALESCE(outstanding_amount, 0)) FROM public.invoices WHERE status IN ('ISSUED','PARTIALLY_PAID','OVERDUE') AND due_date < CURRENT_DATE - INTERVAL '90 days'), 0),
      'total', COALESCE((SELECT SUM(COALESCE(outstanding_amount, 0)) FROM public.invoices WHERE status IN ('ISSUED','PARTIALLY_PAID','OVERDUE')), 0)
    ), '{}'::JSON),
    'payable', COALESCE(json_build_object(
      'current', COALESCE((SELECT SUM(COALESCE(outstanding_amount, 0)) FROM finance.vendor_bills WHERE status IN ('POSTED','PARTIALLY_PAID') AND due_date >= CURRENT_DATE), 0),
      'overdue_1_30', COALESCE((SELECT SUM(COALESCE(outstanding_amount, 0)) FROM finance.vendor_bills WHERE status IN ('POSTED','PARTIALLY_PAID') AND due_date < CURRENT_DATE AND due_date >= CURRENT_DATE - INTERVAL '30 days'), 0),
      'overdue_31_60', COALESCE((SELECT SUM(COALESCE(outstanding_amount, 0)) FROM finance.vendor_bills WHERE status IN ('POSTED','PARTIALLY_PAID') AND due_date < CURRENT_DATE - INTERVAL '30 days' AND due_date >= CURRENT_DATE - INTERVAL '60 days'), 0),
      'overdue_61_90', COALESCE((SELECT SUM(COALESCE(outstanding_amount, 0)) FROM finance.vendor_bills WHERE status IN ('POSTED','PARTIALLY_PAID') AND due_date < CURRENT_DATE - INTERVAL '60 days' AND due_date >= CURRENT_DATE - INTERVAL '90 days'), 0),
      'overdue_over_90', COALESCE((SELECT SUM(COALESCE(outstanding_amount, 0)) FROM finance.vendor_bills WHERE status IN ('POSTED','PARTIALLY_PAID') AND due_date < CURRENT_DATE - INTERVAL '90 days'), 0),
      'total', COALESCE((SELECT SUM(COALESCE(outstanding_amount, 0)) FROM finance.vendor_bills WHERE status IN ('POSTED','PARTIALLY_PAID')), 0)
    ), '{}'::JSON)
  );
END;
 $$;


ALTER FUNCTION "reporting"."ceo_chart_aging"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "reporting"."ceo_chart_budget"() RETURNS json
    LANGUAGE "plpgsql" STABLE
    SET "search_path" TO 'pg_catalog', 'reporting', 'public'
    AS $$ BEGIN
  RETURN COALESCE(json_agg(row_to_json(t)), '[]'::JSON) FROM (
    SELECT 
      COALESCE(b.name, 'Uncategorized') as category,
      COALESCE(b.total_amount, 0) as budget,
      COALESCE(SUM(jl.debit_amount - jl.credit_amount), 0) as actual,
      COALESCE(b.total_amount, 0) - COALESCE(SUM(jl.debit_amount - jl.credit_amount), 0) as variance
    FROM public.budgets b
    LEFT JOIN finance.journal_lines jl ON jl.description ILIKE '%' || b.name || '%'
    LEFT JOIN finance.chart_of_accounts ca ON ca.id = jl.account_id
    LEFT JOIN finance.journal_entries je ON je.id = jl.journal_entry_id AND je.status = 'POSTED'
    WHERE b.status IN ('APPROVED','ACTIVE')
    GROUP BY b.id, b.name, b.total_amount
  ) t;
END;
 $$;


ALTER FUNCTION "reporting"."ceo_chart_budget"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "reporting"."ceo_chart_cash"() RETURNS json
    LANGUAGE "plpgsql" STABLE
    SET "search_path" TO 'pg_catalog', 'reporting', 'public'
    AS $$ BEGIN
  RETURN COALESCE(json_agg(row_to_json(t) ORDER BY balance DESC), '[]'::JSON) FROM (
    SELECT id, account_name, institution_type, currency, masked_identifier, opening_balance as balance
    FROM finance.financial_accounts WHERE is_active = true
  ) t;
END;
 $$;


ALTER FUNCTION "reporting"."ceo_chart_cash"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "reporting"."ceo_chart_categories"() RETURNS json
    LANGUAGE "plpgsql" STABLE
    SET "search_path" TO 'pg_catalog', 'reporting', 'public'
    AS $$ BEGIN
  RETURN json_build_object(
    'expenses', COALESCE((SELECT json_agg(row_to_json(t) ORDER BY total DESC) FROM (
      SELECT 
        CASE ca.account_type
          WHEN 'COST_OF_SALES' THEN 'Cost of Sales'
          WHEN 'OPERATING_EXPENSE' THEN 'Operating Expenses'
          WHEN 'OTHER_EXPENSE' THEN 'Other Expenses'
          ELSE ca.account_type
        END as category,
        SUM(jl.debit_amount - jl.credit_amount) as total
      FROM finance.journal_lines jl
      JOIN finance.chart_of_accounts ca ON ca.id = jl.account_id
      JOIN finance.journal_entries je ON je.id = jl.journal_entry_id
      WHERE je.status = 'POSTED' AND ca.account_type IN ('COST_OF_SALES','OPERATING_EXPENSE','OTHER_EXPENSE')
      GROUP BY ca.account_type
    ) t), '[]'::JSON),

    'assets', COALESCE((SELECT json_agg(row_to_json(t) ORDER BY total DESC) FROM (
      SELECT 
        CASE 
          WHEN ca.code LIKE '11%' THEN 'Cash & Bank'
          WHEN ca.code LIKE '12%' THEN 'Receivables'
          WHEN ca.code LIKE '13%' THEN 'Advances & Prepayments'
          WHEN ca.code LIKE '14%' THEN 'Tax Receivables'
          WHEN ca.code LIKE '151%' THEN 'Fixed Assets'
          WHEN ca.code LIKE '152%' THEN 'Intangible Assets'
          WHEN ca.code LIKE '153%' THEN 'Accum. Depreciation'
          ELSE ca.name
        END as category,
        SUM(CASE WHEN ca.code LIKE '153%' THEN jl.credit_amount - jl.debit_amount ELSE jl.debit_amount - jl.credit_amount END) as total
      FROM finance.journal_lines jl
      JOIN finance.chart_of_accounts ca ON ca.id = jl.account_id
      JOIN finance.journal_entries je ON je.id = jl.journal_entry_id
      WHERE je.status = 'POSTED' AND ca.account_type = 'ASSET'
      GROUP BY 
        CASE 
          WHEN ca.code LIKE '11%' THEN 'Cash & Bank'
          WHEN ca.code LIKE '12%' THEN 'Receivables'
          WHEN ca.code LIKE '13%' THEN 'Advances & Prepayments'
          WHEN ca.code LIKE '14%' THEN 'Tax Receivables'
          WHEN ca.code LIKE '151%' THEN 'Fixed Assets'
          WHEN ca.code LIKE '152%' THEN 'Intangible Assets'
          WHEN ca.code LIKE '153%' THEN 'Accum. Depreciation'
          ELSE ca.name
        END
    ) t), '[]'::JSON),

    'liabilities', COALESCE((SELECT json_agg(row_to_json(t) ORDER BY total DESC) FROM (
      SELECT 
        CASE
          WHEN ca.code LIKE '21%' THEN 'Accounts Payable'
          WHEN ca.code LIKE '22%' THEN 'Tax Payables'
          WHEN ca.code LIKE '23%' THEN 'Payroll Payables'
          WHEN ca.code LIKE '24%' THEN 'Owner Payables'
          WHEN ca.code LIKE '26%' THEN 'Accrued Expenses'
          WHEN ca.code LIKE '251%' THEN 'Long-term Loans'
          ELSE ca.name
        END as category,
        SUM(jl.credit_amount - jl.debit_amount) as total
      FROM finance.journal_lines jl
      JOIN finance.chart_of_accounts ca ON ca.id = jl.account_id
      JOIN finance.journal_entries je ON je.id = jl.journal_entry_id
      WHERE je.status = 'POSTED' AND ca.account_type = 'LIABILITY'
      GROUP BY 
        CASE
          WHEN ca.code LIKE '21%' THEN 'Accounts Payable'
          WHEN ca.code LIKE '22%' THEN 'Tax Payables'
          WHEN ca.code LIKE '23%' THEN 'Payroll Payables'
          WHEN ca.code LIKE '24%' THEN 'Owner Payables'
          WHEN ca.code LIKE '26%' THEN 'Accrued Expenses'
          WHEN ca.code LIKE '251%' THEN 'Long-term Loans'
          ELSE ca.name
        END
    ) t), '[]'::JSON)
  );
END;
 $$;


ALTER FUNCTION "reporting"."ceo_chart_categories"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "reporting"."ceo_chart_monthly"() RETURNS json
    LANGUAGE "plpgsql" STABLE
    SET "search_path" TO 'pg_catalog', 'reporting', 'public'
    AS $$ BEGIN
  RETURN COALESCE(json_agg(row_to_json(t) ORDER BY sort_order), '[]'::JSON) FROM (
    SELECT TO_CHAR(ap.start_date, 'Mon YYYY') as month, TO_CHAR(ap.start_date, 'YY-MM') as month_short,
      COALESCE(SUM(CASE WHEN ca.account_type = 'REVENUE' THEN jl.credit_amount - jl.debit_amount ELSE 0 END), 0) as revenue,
      COALESCE(SUM(CASE WHEN ca.account_type IN ('COST_OF_SALES','OPERATING_EXPENSE','OTHER_EXPENSE') THEN jl.debit_amount - jl.credit_amount ELSE 0 END), 0) as expenses,
      ap.start_date as sort_order
    FROM finance.accounting_periods ap
    LEFT JOIN finance.journal_entries je ON je.period_id = ap.id AND je.status = 'POSTED'
    LEFT JOIN finance.journal_lines jl ON jl.journal_entry_id = je.id
    LEFT JOIN finance.chart_of_accounts ca ON ca.id = jl.account_id
    WHERE ap.start_date >= CURRENT_DATE - INTERVAL '6 months'
    GROUP BY ap.id, ap.start_date
  ) t;
END;
 $$;


ALTER FUNCTION "reporting"."ceo_chart_monthly"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "reporting"."ceo_dashboard_kpis"() RETURNS json
    LANGUAGE "plpgsql" STABLE
    SET "search_path" TO 'pg_catalog', 'reporting', 'public'
    AS $$ DECLARE
  v_period_id UUID;
  v_prev_period_id UUID;
  v_total_cash NUMERIC := 0;
  v_monthly_expense NUMERIC := 0;
BEGIN
  SELECT id INTO v_period_id FROM finance.accounting_periods WHERE status = 'OPEN' ORDER BY start_date DESC LIMIT 1;
  SELECT id INTO v_prev_period_id FROM finance.accounting_periods WHERE status IN ('OPEN','SOFT_CLOSED','HARD_CLOSED') AND id != v_period_id ORDER BY start_date DESC LIMIT 1;
  
  SELECT COALESCE(SUM(opening_balance), 0) INTO v_total_cash FROM finance.financial_accounts WHERE is_active = true;
  
  SELECT COALESCE(SUM(jl.debit_amount - jl.credit_amount) / NULLIF(COUNT(DISTINCT je.period_id), 1), 0) INTO v_monthly_expense
  FROM finance.journal_lines jl
  JOIN finance.journal_entries je ON je.id = jl.journal_entry_id
  JOIN finance.chart_of_accounts ca ON ca.id = jl.account_id
  JOIN finance.accounting_periods ap ON ap.id = je.period_id
  WHERE je.status = 'POSTED'
    AND ca.account_type IN ('COST_OF_SALES','OPERATING_EXPENSE','OTHER_EXPENSE')
    AND ap.status IN ('SOFT_CLOSED','HARD_CLOSED')
    AND ap.end_date >= CURRENT_DATE - INTERVAL '4 months'
    AND ap.start_date < CURRENT_DATE;
    
  IF v_monthly_expense = 0 THEN
    SELECT COALESCE(SUM(jl.debit_amount - jl.credit_amount) / 3, 0) INTO v_monthly_expense
    FROM finance.journal_lines jl
    JOIN finance.journal_entries je ON je.id = jl.journal_entry_id
    JOIN finance.chart_of_accounts ca ON ca.id = jl.account_id
    WHERE je.status = 'POSTED' AND ca.account_type IN ('COST_OF_SALES','OPERATING_EXPENSE','OTHER_EXPENSE');
  END IF;

  RETURN json_build_object(
    'revenue_mtd', COALESCE((SELECT SUM(jl.credit_amount - jl.debit_amount) FROM finance.journal_lines jl JOIN finance.chart_of_accounts ca ON ca.id = jl.account_id JOIN finance.journal_entries je ON je.id = jl.journal_entry_id WHERE je.period_id = v_period_id AND je.status = 'POSTED' AND ca.account_type = 'REVENUE'), 0),
    'revenue_prev', COALESCE((SELECT SUM(jl.credit_amount - jl.debit_amount) FROM finance.journal_lines jl JOIN finance.chart_of_accounts ca ON ca.id = jl.account_id JOIN finance.journal_entries je ON je.id = jl.journal_entry_id WHERE je.period_id = v_prev_period_id AND je.status = 'POSTED' AND ca.account_type = 'REVENUE'), 0),
    'cogs_mtd', COALESCE((SELECT SUM(jl.debit_amount - jl.credit_amount) FROM finance.journal_lines jl JOIN finance.chart_of_accounts ca ON ca.id = jl.account_id JOIN finance.journal_entries je ON je.id = jl.journal_entry_id WHERE je.period_id = v_period_id AND je.status = 'POSTED' AND ca.account_type = 'COST_OF_SALES'), 0),
    'opex_mtd', COALESCE((SELECT SUM(jl.debit_amount - jl.credit_amount) FROM finance.journal_lines jl JOIN finance.chart_of_accounts ca ON ca.id = jl.account_id JOIN finance.journal_entries je ON je.id = jl.journal_entry_id WHERE je.period_id = v_period_id AND je.status = 'POSTED' AND ca.account_type = 'OPERATING_EXPENSE'), 0),
    'other_income_mtd', COALESCE((SELECT SUM(jl.credit_amount - jl.debit_amount) FROM finance.journal_lines jl JOIN finance.chart_of_accounts ca ON ca.id = jl.account_id JOIN finance.journal_entries je ON je.id = jl.journal_entry_id WHERE je.period_id = v_period_id AND je.status = 'POSTED' AND ca.account_type = 'OTHER_INCOME'), 0),
    'other_expense_mtd', COALESCE((SELECT SUM(jl.debit_amount - jl.credit_amount) FROM finance.journal_lines jl JOIN finance.chart_of_accounts ca ON ca.id = jl.account_id JOIN finance.journal_entries je ON je.id = jl.journal_entry_id WHERE je.period_id = v_period_id AND je.status = 'POSTED' AND ca.account_type = 'OTHER_EXPENSE'), 0),
    'net_profit_mtd', COALESCE((SELECT SUM(CASE WHEN ca.normal_balance = 'CREDIT' THEN jl.credit_amount - jl.debit_amount ELSE jl.debit_amount - jl.credit_amount END) FROM finance.journal_lines jl JOIN finance.chart_of_accounts ca ON ca.id = jl.account_id JOIN finance.journal_entries je ON je.id = jl.journal_entry_id WHERE je.period_id = v_period_id AND je.status = 'POSTED' AND ca.account_type IN ('REVENUE','COST_OF_SALES','OPERATING_EXPENSE','OTHER_INCOME','OTHER_EXPENSE')), 0),
    'net_profit_prev', COALESCE((SELECT SUM(CASE WHEN ca.normal_balance = 'CREDIT' THEN jl.credit_amount - jl.debit_amount ELSE jl.debit_amount - jl.credit_amount END) FROM finance.journal_lines jl JOIN finance.chart_of_accounts ca ON ca.id = jl.account_id JOIN finance.journal_entries je ON je.id = jl.journal_entry_id WHERE je.period_id = v_prev_period_id AND je.status = 'POSTED' AND ca.account_type IN ('REVENUE','COST_OF_SALES','OPERATING_EXPENSE','OTHER_INCOME','OTHER_EXPENSE')), 0),
    'total_assets', COALESCE((SELECT SUM(CASE WHEN ca.code LIKE '153%' THEN jl.credit_amount - jl.debit_amount ELSE jl.debit_amount - jl.credit_amount END) FROM finance.journal_lines jl JOIN finance.chart_of_accounts ca ON ca.id = jl.account_id JOIN finance.journal_entries je ON je.status = 'POSTED' WHERE ca.account_type = 'ASSET'), 0),
    'current_assets', COALESCE((SELECT SUM(jl.debit_amount - jl.credit_amount) FROM finance.journal_lines jl JOIN finance.chart_of_accounts ca ON ca.id = jl.account_id JOIN finance.journal_entries je ON je.status = 'POSTED' WHERE ca.account_type = 'ASSET' AND ca.code LIKE '1%'), 0),
    'fixed_assets_net', COALESCE((SELECT SUM(CASE WHEN ca.code LIKE '153%' THEN jl.credit_amount - jl.debit_amount ELSE jl.debit_amount - jl.credit_amount END) FROM finance.journal_lines jl JOIN finance.chart_of_accounts ca ON ca.id = jl.account_id JOIN finance.journal_entries je ON je.status = 'POSTED' WHERE ca.code LIKE '15%' OR ca.code LIKE '153%'), 0),
    'total_liabilities', COALESCE((SELECT SUM(jl.credit_amount - jl.debit_amount) FROM finance.journal_lines jl JOIN finance.chart_of_accounts ca ON ca.id = jl.account_id JOIN finance.journal_entries je ON je.status = 'POSTED' WHERE ca.account_type = 'LIABILITY'), 0),
    'current_liabilities', COALESCE((SELECT SUM(jl.credit_amount - jl.debit_amount) FROM finance.journal_lines jl JOIN finance.chart_of_accounts ca ON ca.id = jl.account_id JOIN finance.journal_entries je ON je.status = 'POSTED' WHERE ca.account_type = 'LIABILITY' AND ca.code LIKE '2%'), 0),
    'total_cash', v_total_cash,
    'cash_runway_months', CASE WHEN v_monthly_expense > 0 THEN FLOOR(v_total_cash / v_monthly_expense) ELSE 0 END,
    'accounts_receivable', COALESCE((SELECT SUM(COALESCE(outstanding_amount, 0)) FROM public.invoices WHERE status IN ('ISSUED','PARTIALLY_PAID','OVERDUE')), 0),
    'accounts_payable', COALESCE((SELECT SUM(COALESCE(outstanding_amount, 0)) FROM finance.vendor_bills WHERE status IN ('POSTED','PARTIALLY_PAID')), 0),
    'retained_earnings', COALESCE((SELECT SUM(jl.credit_amount - jl.debit_amount) FROM finance.journal_lines jl JOIN finance.chart_of_accounts ca ON ca.id = jl.account_id JOIN finance.journal_entries je ON je.status = 'POSTED' WHERE ca.code = '3200'), 0),
    'reserve_balance', COALESCE((SELECT SUM(jl.credit_amount - jl.debit_amount) FROM finance.journal_lines jl JOIN finance.chart_of_accounts ca ON ca.id = jl.account_id JOIN finance.journal_entries je ON je.status = 'POSTED' WHERE ca.code LIKE '33%'), 0),
    'owner_capital', COALESCE((SELECT SUM(jl.credit_amount - jl.debit_amount) FROM finance.journal_lines jl JOIN finance.chart_of_accounts ca ON ca.id = jl.account_id JOIN finance.journal_entries je ON je.status = 'POSTED' WHERE ca.code = '3110'), 0),
    'owner_drawings', COALESCE((SELECT SUM(jl.debit_amount - jl.credit_amount) FROM finance.journal_lines jl JOIN finance.chart_of_accounts ca ON ca.id = jl.account_id JOIN finance.journal_entries je ON je.status = 'POSTED' WHERE ca.code = '2420'), 0),
    'distributable_profit', GREATEST(
      COALESCE((SELECT SUM(CASE WHEN ca.normal_balance = 'CREDIT' THEN jl.credit_amount - jl.debit_amount ELSE jl.debit_amount - jl.credit_amount END) FROM finance.journal_lines jl JOIN finance.chart_of_accounts ca ON ca.id = jl.account_id JOIN finance.journal_entries je ON je.status = 'POSTED' WHERE ca.account_type IN ('REVENUE','COST_OF_SALES','OPERATING_EXPENSE','OTHER_INCOME','OTHER_EXPENSE')), 0)
      - COALESCE((SELECT SUM(jl.debit_amount - jl.credit_amount) FROM finance.journal_lines jl JOIN finance.chart_of_accounts ca ON ca.id = jl.account_id JOIN finance.journal_entries je ON je.status = 'POSTED' WHERE ca.code = '7111'), 0)
      - COALESCE((SELECT SUM(jl.credit_amount - jl.debit_amount) FROM finance.journal_lines jl JOIN finance.chart_of_accounts ca ON ca.id = jl.account_id JOIN finance.journal_entries je ON je.status = 'POSTED' WHERE ca.code LIKE '33%'), 0),
      0
    ),
    'pending_approvals', (
      COALESCE((SELECT COUNT(*) FROM public.invoices WHERE status = 'SUBMITTED'), 0) +
      COALESCE((SELECT COUNT(*) FROM finance.vendor_bills WHERE status IN ('SUBMITTED','VERIFIED')), 0) +
      COALESCE((SELECT COUNT(*) FROM public.expenses WHERE status = 'SUBMITTED'), 0)
    ),
    'unreconciled_lines', COALESCE((SELECT COUNT(*) FROM finance.statement_lines WHERE reconciliation_status = 'UNRECONCILED'), 0),
    'risk_overdue_receivables', COALESCE((SELECT COUNT(*) FROM public.invoices WHERE status = 'OVERDUE'), 0),
    'risk_overdue_payables', COALESCE((SELECT COUNT(*) FROM finance.vendor_bills WHERE status IN ('POSTED','PARTIALLY_PAID') AND due_date < CURRENT_DATE), 0),
    'risk_unreconciled', COALESCE((SELECT COUNT(DISTINCT bank_statement_id) FROM finance.statement_lines WHERE reconciliation_status = 'UNRECONCILED'), 0),
    'risk_pending_period_close', COALESCE((SELECT COUNT(*) FROM finance.accounting_periods WHERE status = 'OPEN' AND end_date < CURRENT_DATE + INTERVAL '7 days'), 0)
  );
END;
 $$;


ALTER FUNCTION "reporting"."ceo_dashboard_kpis"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "reporting"."ceo_table_audit"() RETURNS json
    LANGUAGE "plpgsql" STABLE
    SET "search_path" TO 'pg_catalog', 'reporting', 'public'
    AS $$
BEGIN
    RETURN COALESCE(json_agg(row_to_json(t)), '[]'::JSON) FROM (
        SELECT
            al.id,
            al.action,
            COALESCE(al.entity_type, al.table_name) AS module,
            COALESCE(al.description, al.changed_columns::TEXT, '') AS details,
            al.created_at,
            COALESCE(al.user_name,
                (SELECT full_name FROM public.profiles p WHERE p.user_id = COALESCE(al.user_id, al.changed_id)),
                COALESCE(al.user_id, al.changed_by)::TEXT
            ) AS user_name,
            COALESCE(al.entity_type, al.table_name) AS table_name
        FROM audit.audit_log al  --  FIXED: correct table name
        ORDER BY al.created_at DESC
        LIMIT 30
    ) t;
END;
$$;


ALTER FUNCTION "reporting"."ceo_table_audit"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "reporting"."ceo_table_equity_tax"() RETURNS json
    LANGUAGE "plpgsql" STABLE
    SET "search_path" TO 'pg_catalog', 'reporting', 'public'
    AS $$ DECLARE
  v_profit_before_tax NUMERIC := 0;
BEGIN
  SELECT SUM(CASE WHEN ca.normal_balance = 'CREDIT' THEN jl.credit_amount - jl.debit_amount ELSE jl.debit_amount - jl.credit_amount END)
    INTO v_profit_before_tax
  FROM finance.journal_lines jl
  JOIN finance.chart_of_accounts ca ON ca.id = jl.account_id
  JOIN finance.journal_entries je ON je.id = jl.journal_entry_id
  JOIN finance.accounting_periods ap ON ap.id = je.period_id
  WHERE je.status = 'POSTED' AND ap.status = 'OPEN'
    AND ca.account_type IN ('REVENUE','COST_OF_SALES','OPERATING_EXPENSE','OTHER_INCOME','OTHER_EXPENSE');

  RETURN json_build_object(
    'shareholders', COALESCE((SELECT json_agg(row_to_json(t)) FROM (
      SELECT 
        CASE ca.code
          WHEN '3110' THEN 'Owner Capital'
          WHEN '2420' THEN 'Owner Drawings'
          WHEN '3200' THEN 'Retained Earnings'
          WHEN '3300' THEN 'General Reserve'
          WHEN '3320' THEN 'Capital Reserve'
          ELSE ca.name
        END as label,
        SUM(CASE WHEN ca.code = '2420' THEN jl.debit_amount - jl.credit_amount ELSE jl.credit_amount - jl.debit_amount END) as balance,
        ca.code
      FROM finance.journal_lines jl
      JOIN finance.chart_of_accounts ca ON ca.id = jl.account_id
      JOIN finance.journal_entries je ON je.id = jl.journal_entry_id
      WHERE je.status = 'POSTED' AND ca.code IN ('3110','2420','3200','3300','3320')
      GROUP BY ca.code, ca.name
    ) t), '[]'::JSON),
    'tax', json_build_object(
      'profit_before_tax', v_profit_before_tax,
      'estimated_tax', COALESCE((SELECT SUM(jl.debit_amount - jl.credit_amount) FROM finance.journal_lines jl JOIN finance.chart_of_accounts ca ON ca.id = jl.account_id JOIN finance.journal_entries je ON je.id = jl.journal_entry_id WHERE je.status = 'POSTED' AND ca.code = '7111'), 0),
      'withholding_credits', COALESCE((SELECT SUM(jl.debit_amount - jl.credit_amount) FROM finance.journal_lines jl JOIN finance.chart_of_accounts ca ON ca.id = jl.account_id JOIN finance.journal_entries je ON je.id = jl.journal_entry_id WHERE je.status = 'POSTED' AND ca.code = '1410'), 0),
      'tax_payable', GREATEST(
        COALESCE((SELECT SUM(jl.debit_amount - jl.credit_amount) FROM finance.journal_lines jl JOIN finance.chart_of_accounts ca ON ca.id = jl.account_id JOIN finance.journal_entries je ON je.id = jl.journal_entry_id WHERE je.status = 'POSTED' AND ca.code = '7111'), 0)
        - COALESCE((SELECT SUM(jl.debit_amount - jl.credit_amount) FROM finance.journal_lines jl JOIN finance.chart_of_accounts ca ON ca.id = jl.account_id JOIN finance.journal_entries je ON je.id = jl.journal_entry_id WHERE je.status = 'POSTED' AND ca.code = '1410'), 0),
        0
      ),
      'profit_after_tax', GREATEST(v_profit_before_tax - 
        COALESCE((SELECT SUM(jl.debit_amount - jl.credit_amount) FROM finance.journal_lines jl JOIN finance.chart_of_accounts ca ON ca.id = jl.account_id JOIN finance.journal_entries je ON je.id = jl.journal_entry_id WHERE je.status = 'POSTED' AND ca.code = '7111'), 0)
        + COALESCE((SELECT SUM(jl.debit_amount - jl.credit_amount) FROM finance.journal_lines jl JOIN finance.chart_of_accounts ca ON ca.id = jl.account_id JOIN finance.journal_entries je ON je.id = jl.journal_entry_id WHERE je.status = 'POSTED' AND ca.code = '1410'), 0),
        0
      )
    )
  );
END;
 $$;


ALTER FUNCTION "reporting"."ceo_table_equity_tax"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "reporting"."ceo_table_fiscal"() RETURNS json
    LANGUAGE "plpgsql" STABLE
    SET "search_path" TO 'pg_catalog', 'reporting', 'public'
    AS $$
BEGIN
    RETURN COALESCE(json_agg(row_to_json(t) ORDER BY t.start_date), '[]'::JSON) FROM (
        SELECT
            ap.id, ap.name,
            ap.start_date, ap.end_date, ap.status,
            EXTRACT(MONTH FROM ap.start_date)::int AS month_num,
            EXTRACT(MONTH FROM ap.end_date)::int - EXTRACT(MONTH FROM ap.start_date)::int + 1 AS total_months
        FROM finance.accounting_periods ap
        --  FIXED: Use status='OPEN' instead of non-existent is_current column
        WHERE ap.fiscal_year_id = (
            SELECT id FROM finance.fiscal_years
            WHERE status = 'OPEN'
            ORDER BY start_date DESC
            LIMIT 1
        )
        ORDER BY ap.start_date
    ) t;
END;
$$;


ALTER FUNCTION "reporting"."ceo_table_fiscal"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "reporting"."get_balance_sheet"("p_as_of_date" "date", "p_organization_id" "uuid") RETURNS TABLE("section_order" integer, "section" "text", "code" "text", "account_name" "text", "net_amount" numeric)
    LANGUAGE "sql" STABLE
    SET "search_path" TO 'pg_catalog', 'reporting', 'public'
    AS $$
SELECT
    CASE coa.account_type
        WHEN 'ASSET' THEN 1
        WHEN 'LIABILITY' THEN 2
        WHEN 'EQUITY' THEN 3
    END AS section_order,
    COALESCE(coa.report_mapping, coa.account_type) AS section,
    coa.code,
    coa.name AS account_name,
    CASE
        WHEN coa.normal_balance = 'DEBIT' THEN COALESCE(SUM(jl.base_debit), 0) - COALESCE(SUM(jl.base_credit), 0)
        ELSE COALESCE(SUM(jl.base_credit), 0) - COALESCE(SUM(jl.base_debit), 0)
    END AS net_amount
FROM finance.chart_of_accounts coa
LEFT JOIN finance.journal_lines jl ON jl.account_id = coa.id
LEFT JOIN finance.journal_entries je ON je.id = jl.journal_entry_id AND je.status = 'POSTED'
LEFT JOIN finance.accounting_periods ap ON ap.id = je.period_id AND ap.end_date <= p_as_of_date
WHERE coa.is_active = true
  AND coa.organization_id = p_organization_id
  AND p_organization_id = core.current_user_org_id()
  AND coa.account_type IN ('ASSET', 'LIABILITY', 'EQUITY')
GROUP BY coa.id, coa.report_mapping, coa.account_type, coa.code, coa.name, coa.normal_balance
HAVING CASE
    WHEN coa.normal_balance = 'DEBIT' THEN COALESCE(SUM(jl.base_debit), 0) - COALESCE(SUM(jl.base_credit), 0)
    ELSE COALESCE(SUM(jl.base_credit), 0) - COALESCE(SUM(jl.base_debit), 0)
END != 0
ORDER BY section_order, coa.code;
$$;


ALTER FUNCTION "reporting"."get_balance_sheet"("p_as_of_date" "date", "p_organization_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "reporting"."get_cash_flow"("p_start_date" "date", "p_end_date" "date", "p_organization_id" "uuid") RETURNS TABLE("section" "text", "account_name" "text", "amount" numeric)
    LANGUAGE "sql" STABLE
    SET "search_path" TO 'pg_catalog', 'reporting', 'public'
    AS $$
WITH pnl_changes AS (
    -- Operating Activities: P&L items
    SELECT
        'OPERATING' AS section,
        coa.name AS account_name,
        SUM(CASE WHEN coa.normal_balance = 'CREDIT' THEN jl.base_credit ELSE -jl.base_debit END) AS amount
    FROM finance.journal_lines jl
    JOIN finance.journal_entries je ON je.id = jl.journal_entry_id AND je.status = 'POSTED'
    JOIN finance.accounting_periods ap ON ap.id = je.period_id
    JOIN finance.chart_of_accounts coa ON coa.id = jl.account_id
    WHERE ap.start_date >= p_start_date AND ap.end_date <= p_end_date
      AND coa.organization_id = p_organization_id
      AND coa.account_type IN ('REVENUE', 'COST_OF_SALES', 'OPERATING_EXPENSE')
    GROUP BY coa.name
    HAVING SUM(CASE WHEN coa.normal_balance = 'CREDIT' THEN jl.base_credit ELSE -jl.base_debit END) != 0

    UNION ALL

    -- Working Capital Changes (Receivables/Payables)
    SELECT
        'OPERATING' AS section,
        'Change in ' || coa.name AS account_name,
        -1 * (COALESCE(SUM(jl.base_debit), 0) - COALESCE(SUM(jl.base_credit), 0)) AS amount
    FROM finance.journal_lines jl
    JOIN finance.journal_entries je ON je.id = jl.journal_entry_id AND je.status = 'POSTED'
    JOIN finance.accounting_periods ap ON ap.id = je.period_id
    JOIN finance.chart_of_accounts coa ON coa.id = jl.account_id
    WHERE ap.start_date >= p_start_date AND ap.end_date <= p_end_date
      AND coa.organization_id = p_organization_id
      AND coa.code LIKE '12%'  -- Receivables
    GROUP BY coa.name
    HAVING (COALESCE(SUM(jl.base_debit), 0) - COALESCE(SUM(jl.base_credit), 0)) != 0

    UNION ALL

    -- Working Capital: Payables
    SELECT
        'OPERATING' AS section,
        'Change in ' || coa.name AS account_name,
        (COALESCE(SUM(jl.base_credit), 0) - COALESCE(SUM(jl.base_debit), 0)) AS amount
    FROM finance.journal_lines jl
    JOIN finance.journal_entries je ON je.id = jl.journal_entry_id AND je.status = 'POSTED'
    JOIN finance.accounting_periods ap ON ap.id = je.period_id
    JOIN finance.chart_of_accounts coa ON coa.id = jl.account_id
    WHERE ap.start_date >= p_start_date AND ap.end_date <= p_end_date
      AND coa.organization_id = p_organization_id
      AND coa.code LIKE '21%'  -- Payables
    GROUP BY coa.name
    HAVING (COALESCE(SUM(jl.base_credit), 0) - COALESCE(SUM(jl.base_debit), 0)) != 0

    UNION ALL

    -- Investing Activities (Fixed Assets - non-depreciation)
    SELECT
        'INVESTING' AS section,
        coa.name AS account_name,
        -1 * (COALESCE(SUM(jl.base_debit), 0) - COALESCE(SUM(jl.base_credit), 0)) AS amount
    FROM finance.journal_lines jl
    JOIN finance.journal_entries je ON je.id = jl.journal_entry_id AND je.status = 'POSTED'
    JOIN finance.accounting_periods ap ON ap.id = je.period_id
    JOIN finance.chart_of_accounts coa ON coa.id = jl.account_id
    WHERE ap.start_date >= p_start_date AND ap.end_date <= p_end_date
      AND coa.organization_id = p_organization_id
      AND coa.code LIKE '151%'
    GROUP BY coa.name
    HAVING (COALESCE(SUM(jl.base_debit), 0) - COALESCE(SUM(jl.base_credit), 0)) != 0

    UNION ALL

    -- Financing Activities (Equity + Long-term Liabilities)
    SELECT
        'FINANCING' AS section,
        coa.name AS account_name,
        CASE WHEN coa.normal_balance = 'CREDIT'
             THEN COALESCE(SUM(jl.base_credit), 0) - COALESCE(SUM(jl.base_debit), 0)
             ELSE -1 * (COALESCE(SUM(jl.base_debit), 0) - COALESCE(SUM(jl.base_credit), 0))
        END AS amount
    FROM finance.journal_lines jl
    JOIN finance.journal_entries je ON je.id = jl.journal_entry_id AND je.status = 'POSTED'
    JOIN finance.accounting_periods ap ON ap.id = je.period_id
    JOIN finance.chart_of_accounts coa ON coa.id = jl.account_id
    WHERE ap.start_date >= p_start_date AND ap.end_date <= p_end_date
      AND coa.organization_id = p_organization_id
      AND (coa.account_type = 'EQUITY' OR coa.code LIKE '251%')
    GROUP BY coa.name, coa.normal_balance
    HAVING CASE WHEN coa.normal_balance = 'CREDIT'
           THEN COALESCE(SUM(jl.base_credit), 0) - COALESCE(SUM(jl.base_debit), 0)
           ELSE -1 * (COALESCE(SUM(jl.base_debit), 0) - COALESCE(SUM(jl.base_credit), 0))
    END != 0
)
SELECT * FROM pnl_changes
WHERE p_organization_id = core.current_user_org_id()
ORDER BY
    CASE section WHEN 'OPERATING' THEN 1 WHEN 'INVESTING' THEN 2 WHEN 'FINANCING' THEN 3 END,
    account_name;
$$;


ALTER FUNCTION "reporting"."get_cash_flow"("p_start_date" "date", "p_end_date" "date", "p_organization_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "reporting"."get_ceo_metrics"() RETURNS TABLE("total_cash" numeric, "total_receivables" numeric, "total_payables" numeric, "current_month_pl" numeric)
    LANGUAGE "sql" STABLE
    SET "search_path" TO 'pg_catalog', 'reporting', 'public'
    AS $$ WITH gl_balances AS (
    SELECT 
        coa.report_mapping,
        coa.normal_balance,
        SUM(jl.base_debit) AS total_dr,
        SUM(jl.base_credit) AS total_cr
    FROM finance.chart_of_accounts coa
    JOIN finance.journal_lines jl ON jl.account_id = coa.id
    JOIN finance.journal_entries je ON je.id = jl.journal_entry_id AND je.status = 'POSTED'
    WHERE coa.report_mapping IN ('BALANCE_SHEET_CASH', 'BALANCE_SHEET_RECEIVABLES', 'BALANCE_SHEET_PAYABLES')
    GROUP BY coa.report_mapping, coa.normal_balance
),
current_month_pl AS (
    SELECT 
        SUM(CASE WHEN coa.normal_balance = 'CREDIT' THEN jl.base_credit ELSE -jl.base_debit END) AS pl
    FROM finance.journal_lines jl
    JOIN finance.journal_entries je ON je.id = jl.journal_entry_id AND je.status = 'POSTED'
    JOIN finance.accounting_periods ap ON ap.id = je.period_id
    JOIN finance.chart_of_accounts coa ON coa.id = jl.account_id
    WHERE coa.account_type IN ('REVENUE', 'COST_OF_SALES', 'OPERATING_EXPENSE')
      AND CURRENT_DATE BETWEEN ap.start_date AND ap.end_date
)
SELECT 
    COALESCE((SELECT CASE WHEN normal_balance='DEBIT' THEN total_dr - total_cr ELSE total_cr - total_dr END FROM gl_balances WHERE report_mapping = 'BALANCE_SHEET_CASH'), 0),
    COALESCE((SELECT CASE WHEN normal_balance='DEBIT' THEN total_dr - total_cr ELSE total_cr - total_dr END FROM gl_balances WHERE report_mapping = 'BALANCE_SHEET_RECEIVABLES'), 0),
    COALESCE((SELECT CASE WHEN normal_balance='DEBIT' THEN total_dr - total_cr ELSE total_cr - total_dr END FROM gl_balances WHERE report_mapping = 'BALANCE_SHEET_PAYABLES'), 0),
    COALESCE((SELECT pl FROM current_month_pl), 0);
 $$;


ALTER FUNCTION "reporting"."get_ceo_metrics"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "reporting"."get_profit_and_loss"("p_start_date" "date", "p_end_date" "date", "p_organization_id" "uuid") RETURNS TABLE("section_order" integer, "section" "text", "code" "text", "account_name" "text", "debit_total" numeric, "credit_total" numeric, "net_amount" numeric)
    LANGUAGE "sql" STABLE
    SET "search_path" TO 'pg_catalog', 'reporting', 'public'
    AS $$
SELECT
    CASE coa.report_mapping
        WHEN 'PL_REVENUE' THEN 1
        WHEN 'PL_COS' THEN 2
        WHEN 'PL_OP_EXPENSE' THEN 3
        WHEN 'PL_OTHER_INCOME' THEN 4
        WHEN 'PL_OTHER_EXPENSE' THEN 5
        ELSE 6
    END AS section_order,
    COALESCE(coa.report_mapping, coa.account_type) AS section,
    coa.code,
    coa.name AS account_name,
    COALESCE(SUM(jl.base_debit), 0) AS debit_total,
    COALESCE(SUM(jl.base_credit), 0) AS credit_total,
    CASE
        WHEN coa.normal_balance = 'DEBIT' THEN COALESCE(SUM(jl.base_debit), 0) - COALESCE(SUM(jl.base_credit), 0)
        ELSE COALESCE(SUM(jl.base_credit), 0) - COALESCE(SUM(jl.base_debit), 0)
    END AS net_amount
FROM finance.chart_of_accounts coa
JOIN finance.journal_lines jl ON jl.account_id = coa.id
JOIN finance.journal_entries je ON je.id = jl.journal_entry_id
JOIN finance.accounting_periods ap ON ap.id = je.period_id
WHERE je.status = 'POSTED'
  AND ap.start_date >= p_start_date
  AND ap.end_date <= p_end_date
  AND coa.is_active = true
  AND coa.organization_id = p_organization_id
  AND p_organization_id = core.current_user_org_id()
  AND coa.account_type IN ('REVENUE', 'COST_OF_SALES', 'OPERATING_EXPENSE', 'OTHER_INCOME', 'OTHER_EXPENSE')
GROUP BY coa.id, coa.report_mapping, coa.account_type, coa.code, coa.name, coa.normal_balance
ORDER BY section_order, coa.code;
$$;


ALTER FUNCTION "reporting"."get_profit_and_loss"("p_start_date" "date", "p_end_date" "date", "p_organization_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "reporting"."get_project_profitability"("p_start_date" "date", "p_end_date" "date") RETURNS TABLE("project_id" "uuid", "project_name" "text", "total_revenue" numeric, "total_costs" numeric, "gross_profit" numeric, "margin_pct" numeric)
    LANGUAGE "sql" STABLE
    SET "search_path" TO 'pg_catalog', 'reporting', 'public'
    AS $$ SELECT 
    je.project_id,
    COALESCE(p.name, 'Unassigned') AS project_name,
    COALESCE(SUM(CASE WHEN coa.account_type = 'REVENUE' THEN jl.base_credit ELSE 0 END), 0) AS total_revenue,
    COALESCE(SUM(CASE WHEN coa.account_type IN ('COST_OF_SALES', 'OPERATING_EXPENSE') THEN jl.base_debit ELSE 0 END), 0) AS total_costs,
    COALESCE(SUM(CASE WHEN coa.account_type = 'REVENUE' THEN jl.base_credit ELSE 0 END), 0) - 
    COALESCE(SUM(CASE WHEN coa.account_type IN ('COST_OF_SALES', 'OPERATING_EXPENSE') THEN jl.base_debit ELSE 0 END), 0) AS gross_profit,
    CASE 
        WHEN SUM(CASE WHEN coa.account_type = 'REVENUE' THEN jl.base_credit ELSE 0 END) = 0 THEN 0
        ELSE ROUND(
            ((SUM(CASE WHEN coa.account_type = 'REVENUE' THEN jl.base_credit ELSE 0 END) - 
              SUM(CASE WHEN coa.account_type IN ('COST_OF_SALES', 'OPERATING_EXPENSE') THEN jl.base_debit ELSE 0 END)) / 
             NULLIF(SUM(CASE WHEN coa.account_type = 'REVENUE' THEN jl.base_credit ELSE 0 END), 0)) * 100, 2
        )
    END AS margin_pct
FROM finance.journal_lines jl
JOIN finance.journal_entries je ON je.id = jl.journal_entry_id AND je.status = 'POSTED'
JOIN finance.accounting_periods ap ON ap.id = je.period_id
JOIN finance.chart_of_accounts coa ON coa.id = jl.account_id
LEFT JOIN public.projects p ON p.id = je.project_id 
WHERE ap.start_date >= p_start_date AND ap.end_date <= p_end_date
  AND coa.account_type IN ('REVENUE', 'COST_OF_SALES', 'OPERATING_EXPENSE')
GROUP BY je.project_id, p.name
ORDER BY gross_profit DESC;
 $$;


ALTER FUNCTION "reporting"."get_project_profitability"("p_start_date" "date", "p_end_date" "date") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "reporting"."get_statement_of_changes_in_equity"("p_period_start" "date", "p_period_end" "date", "p_organization_id" "uuid") RETURNS TABLE("account_id" "uuid", "code" "text", "account_name" "text", "opening_balance" numeric, "period_movement" numeric, "closing_balance" numeric)
    LANGUAGE "sql" STABLE
    SET "search_path" TO 'pg_catalog', 'reporting', 'finance', 'public'
    AS $$
WITH opening AS (
  SELECT
    coa.id AS account_id,
    COALESCE(SUM(jl.base_credit), 0) - COALESCE(SUM(jl.base_debit), 0) AS opening_balance
  FROM finance.chart_of_accounts coa
  LEFT JOIN finance.journal_lines jl ON jl.account_id = coa.id
  LEFT JOIN finance.journal_entries je
    ON je.id = jl.journal_entry_id
   AND je.status = 'POSTED'
   AND je.transaction_date < p_period_start
  WHERE coa.account_type = 'EQUITY'
  AND coa.organization_id = p_organization_id
  AND p_organization_id = core.current_user_org_id()
    AND coa.organization_id = p_organization_id
  GROUP BY coa.id
),
movement AS (
  SELECT
    coa.id AS account_id,
    COALESCE(SUM(jl.base_credit), 0) - COALESCE(SUM(jl.base_debit), 0) AS period_movement
  FROM finance.chart_of_accounts coa
  LEFT JOIN finance.journal_lines jl ON jl.account_id = coa.id
  LEFT JOIN finance.journal_entries je
    ON je.id = jl.journal_entry_id
   AND je.status = 'POSTED'
   AND je.transaction_date >= p_period_start
   AND je.transaction_date <= p_period_end
  WHERE coa.account_type = 'EQUITY'
  AND coa.organization_id = p_organization_id
    AND coa.organization_id = p_organization_id
  GROUP BY coa.id
)
SELECT
  coa.id AS account_id,
  coa.code,
  coa.name AS account_name,
  COALESCE(o.opening_balance, 0) AS opening_balance,
  COALESCE(m.period_movement, 0) AS period_movement,
  COALESCE(o.opening_balance, 0) + COALESCE(m.period_movement, 0) AS closing_balance
FROM finance.chart_of_accounts coa
LEFT JOIN opening o ON o.account_id = coa.id
LEFT JOIN movement m ON m.account_id = coa.id
WHERE coa.account_type = 'EQUITY'
  AND coa.organization_id = p_organization_id
  AND coa.is_active = true
ORDER BY coa.code;
$$;


ALTER FUNCTION "reporting"."get_statement_of_changes_in_equity"("p_period_start" "date", "p_period_end" "date", "p_organization_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "reporting"."get_trial_balance"("p_period_ids" "uuid"[], "p_organization_id" "uuid") RETURNS TABLE("account_id" "uuid", "code" "text", "name" "text", "account_type" "text", "normal_balance" "text", "total_debit" numeric, "total_credit" numeric, "net_balance" numeric)
    LANGUAGE "plpgsql" STABLE
    SET "search_path" TO 'pg_catalog', 'reporting', 'public'
    AS $$ BEGIN
  RETURN QUERY
  SELECT 
    coa.id,
    coa.code,
    coa.name,
    coa.account_type,
    coa.normal_balance,
    COALESCE(SUM(COALESCE(jl.base_debit, jl.debit_amount)), 0) AS total_debit,
    COALESCE(SUM(COALESCE(jl.base_credit, jl.credit_amount)), 0) AS total_credit,
    CASE 
      WHEN coa.normal_balance = 'DEBIT' 
        THEN COALESCE(SUM(COALESCE(jl.base_debit, jl.debit_amount)), 0) - COALESCE(SUM(COALESCE(jl.base_credit, jl.credit_amount)), 0)
      ELSE COALESCE(SUM(COALESCE(jl.base_credit, jl.credit_amount)), 0) - COALESCE(SUM(COALESCE(jl.base_debit, jl.debit_amount)), 0)
    END AS net_balance
  FROM finance.chart_of_accounts coa
  LEFT JOIN finance.journal_lines jl ON jl.account_id = coa.id
  LEFT JOIN finance.journal_entries je ON je.id = jl.journal_entry_id 
    AND je.status = 'POSTED'
    AND je.period_id = ANY(p_period_ids)
  WHERE coa.is_active = true
    AND coa.organization_id = p_organization_id
    AND p_organization_id = core.current_user_org_id()
    AND coa.posting_allowed = true
  GROUP BY coa.id, coa.code, coa.name, coa.account_type, coa.normal_balance
  HAVING COALESCE(SUM(COALESCE(jl.base_debit, jl.debit_amount)), 0) > 0 
      OR COALESCE(SUM(COALESCE(jl.base_credit, jl.credit_amount)), 0) > 0
  ORDER BY coa.code;
END;
 $$;


ALTER FUNCTION "reporting"."get_trial_balance"("p_period_ids" "uuid"[], "p_organization_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "reporting"."pending_approvals_list"() RETURNS json
    LANGUAGE "plpgsql" STABLE
    SET "search_path" TO 'pg_catalog', 'reporting', 'public'
    AS $$ BEGIN
  RETURN COALESCE(
    json_agg(row_to_json(t) ORDER BY t.created_at DESC)
  , '[]'::JSON) FROM (
    -- Invoices
    SELECT id, 'INVOICE' as module_type, invoice_number as reference,
      COALESCE(client_name, 'N/A') as description,
      COALESCE(total_amount, 0) as amount,
      created_by, created_at,
      CASE WHEN due_date < CURRENT_DATE THEN 'HIGH' ELSE 'NORMAL' END as urgency
    FROM public.invoices WHERE status = 'SUBMITTED'
    UNION ALL
    -- Vendor Bills
    SELECT id, 'VENDOR_BILL' as module_type, bill_number as reference,
      COALESCE(vendor_name, description, 'N/A') as description,
      COALESCE(total_amount, 0) as amount,
      created_by, created_at,
      CASE WHEN due_date < CURRENT_DATE THEN 'HIGH' ELSE 'NORMAL' END as urgency
    FROM finance.vendor_bills WHERE status IN ('SUBMITTED','VERIFIED')
    UNION ALL
    -- Expenses
    SELECT id, 'EXPENSE' as module_type, reference_number as reference,
      COALESCE(description, purpose, 'N/A') as description,
      COALESCE(total_amount, 0) as amount,
      created_by, created_at,
      'NORMAL' as urgency
    FROM public.expenses WHERE status = 'SUBMITTED'
  ) t;
END;
 $$;


ALTER FUNCTION "reporting"."pending_approvals_list"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "reporting"."project_profitability"() RETURNS json
    LANGUAGE "plpgsql" STABLE
    SET "search_path" TO 'pg_catalog', 'reporting', 'public'
    AS $$ BEGIN
  RETURN COALESCE(
    json_agg(row_to_json(t) ORDER BY t.gross_profit DESC)
  , '[]'::JSON) FROM (
    SELECT 
      p.id,
      p.name as project_name,
      COALESCE((SELECT c.name FROM public.clients c WHERE c.id = p.client_id), 'N/A') as client_name,
      COALESCE(SUM(CASE WHEN ca.account_type = 'REVENUE' THEN jl.credit_amount - jl.debit_amount ELSE 0 END), 0) as revenue,
      COALESCE(SUM(CASE WHEN ca.account_type IN ('COST_OF_SALES','OPERATING_EXPENSE') THEN jl.debit_amount - jl.credit_amount ELSE 0 END), 0) as costs,
      COALESCE(SUM(CASE WHEN ca.account_type = 'REVENUE' THEN jl.credit_amount - jl.debit_amount ELSE 0 END), 0)
        - COALESCE(SUM(CASE WHEN ca.account_type IN ('COST_OF_SALES','OPERATING_EXPENSE') THEN jl.debit_amount - jl.credit_amount ELSE 0 END), 0) as gross_profit,
      CASE 
        WHEN COALESCE(SUM(CASE WHEN ca.account_type = 'REVENUE' THEN jl.credit_amount - jl.debit_amount ELSE 0 END), 0) > 0 
        THEN ROUND(
          ((SUM(CASE WHEN ca.account_type = 'REVENUE' THEN jl.credit_amount - jl.debit_amount ELSE 0 END)
            - SUM(CASE WHEN ca.account_type IN ('COST_OF_SALES','OPERATING_EXPENSE') THEN jl.debit_amount - jl.credit_amount ELSE 0 END))
          / NULLIF(SUM(CASE WHEN ca.account_type = 'REVENUE' THEN jl.credit_amount - jl.debit_amount ELSE 0 END), 0)) * 100, 1)
        ELSE 0 
      END as margin,
      p.status
    FROM public.projects p
    LEFT JOIN finance.journal_lines jl ON jl.project_id = p.id
    LEFT JOIN finance.journal_entries je ON je.id = jl.journal_entry_id AND je.status = 'POSTED'
    LEFT JOIN finance.chart_of_accounts ca ON ca.id = jl.account_id
    WHERE ca.account_type IN ('REVENUE','COST_OF_SALES','OPERATING_EXPENSE')
    GROUP BY p.id, p.name, p.client_id, p.status
  ) t;
END;
 $$;


ALTER FUNCTION "reporting"."project_profitability"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "reporting"."receivable_aging_summary"() RETURNS json
    LANGUAGE "plpgsql" STABLE
    SET "search_path" TO 'pg_catalog', 'reporting', 'public'
    AS $$ DECLARE v_result JSON;
BEGIN
  SELECT json_build_object(
    'current', COALESCE((SELECT SUM(current_amount) FROM reporting.receivable_aging), 0),
    'overdue_1_30', COALESCE((SELECT SUM(overdue_1_30_days) FROM reporting.receivable_aging), 0),
    'overdue_31_60', COALESCE((SELECT SUM(overdue_31_60_days) FROM reporting.receivable_aging), 0),
    'overdue_61_90', COALESCE((SELECT SUM(overdue_61_90_days) FROM reporting.receivable_aging), 0),
    'overdue_over_90', COALESCE((SELECT SUM(overdue_over_90_days) FROM reporting.receivable_aging), 0),
    'total', COALESCE((SELECT SUM(outstanding_base_amount) FROM reporting.receivable_aging), 0)
  ) INTO v_result;
  RETURN v_result;
END;
 $$;


ALTER FUNCTION "reporting"."receivable_aging_summary"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "reporting"."revenue_expense_monthly"() RETURNS json
    LANGUAGE "plpgsql" STABLE
    SET "search_path" TO 'pg_catalog', 'reporting', 'public'
    AS $$ BEGIN
  RETURN COALESCE(json_agg(row_to_json(t)), '[]'::JSON) FROM (
    SELECT TO_CHAR(ap.start_date, 'Mon YYYY') as month, TO_CHAR(ap.start_date, 'YY-MM') as month_short,
      COALESCE(SUM(CASE WHEN ca.account_type = 'REVENUE' THEN jl.credit_amount - jl.debit_amount ELSE 0 END), 0) as revenue,
      COALESCE(SUM(CASE WHEN ca.account_type IN ('COST_OF_SALES','OPERATING_EXPENSE','OTHER_EXPENSE') THEN jl.debit_amount - jl.credit_amount ELSE 0 END), 0) as expenses
    FROM finance.accounting_periods ap
    LEFT JOIN finance.journal_entries je ON je.period_id = ap.id AND je.status = 'POSTED'
    LEFT JOIN finance.journal_lines jl ON jl.journal_entry_id = je.id
    LEFT JOIN finance.chart_of_accounts ca ON ca.id = jl.account_id
    WHERE ap.start_date >= CURRENT_DATE - INTERVAL '6 months'
    GROUP BY ap.id, ap.start_date ORDER BY ap.start_date LIMIT 6
  ) t;
END;
 $$;


ALTER FUNCTION "reporting"."revenue_expense_monthly"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "reporting"."transaction_detail"("p_id" "uuid") RETURNS json
    LANGUAGE "plpgsql" STABLE
    SET "search_path" TO 'pg_catalog', 'reporting', 'public'
    AS $$ DECLARE
  v_result JSON;
  v_settlement_lines JSON := '[]'::JSON;
BEGIN
  -- Build settlement waterfall from journal lines if applicable
  SELECT COALESCE(json_agg(row_to_json(s) ORDER BY s.sort_order), '[]'::JSON) INTO v_settlement_lines FROM (
    SELECT 
      CASE 
        WHEN ca.account_type = 'REVENUE' THEN 'Gross Project Amount'
        WHEN ca.code LIKE '51%' THEN 'Platform / Service Fee'
        WHEN ca.code LIKE '22%' OR ca.code = '1410' THEN 'Withholding Tax'
        WHEN ca.code LIKE '527%' THEN 'Withdrawal / Bank Fee'
        WHEN ca.code LIKE '52%' THEN 'Exchange Difference'
        WHEN ca.account_type = 'ASSET' AND ca.code LIKE '11%' THEN 'Net Cash Received'
        ELSE ca.name
      END as label,
      CASE 
        WHEN ca.account_type IN ('REVENUE','OTHER_INCOME') THEN jl.credit_amount - jl.debit_amount
        ELSE jl.debit_amount - jl.credit_amount
      END as amount,
      NULL::numeric as original_amount,
      NULL::text as original_currency,
      CASE 
        WHEN ca.account_type = 'REVENUE' THEN 'GROSS'
        WHEN ca.account_type IN ('COST_OF_SALES','OPERATING_EXPENSE','OTHER_EXPENSE') THEN 'DEDUCTION'
        WHEN ca.code LIKE '52%' THEN 'ADJUSTMENT'
        WHEN ca.account_type = 'ASSET' AND ca.code LIKE '11%' THEN 'NET'
        ELSE 'DEDUCTION'
      END as type,
      CASE 
        WHEN ca.account_type = 'REVENUE' THEN '#3b82f6'
        WHEN ca.code LIKE '51%' THEN '#f97316'
        WHEN ca.code LIKE '22%' OR ca.code = '1410' THEN '#8b5cf6'
        WHEN ca.code LIKE '527%' THEN '#ef4444'
        WHEN ca.code LIKE '52%' THEN '#f59e0b'
        WHEN ca.account_type = 'ASSET' AND ca.code LIKE '11%' THEN '#22c55e'
        ELSE '#6b7280'
      END as color,
      ROW_NUMBER() OVER (ORDER BY 
        CASE WHEN ca.account_type = 'REVENUE' THEN 1
             WHEN ca.code LIKE '51%' THEN 2
             WHEN ca.code LIKE '22%' OR ca.code = '1410' THEN 3
             WHEN ca.code LIKE '527%' THEN 4
             WHEN ca.code LIKE '52%' THEN 5
             WHEN ca.account_type = 'ASSET' THEN 6
             ELSE 7 END
      ) as sort_order
    FROM finance.journal_lines jl
    JOIN finance.chart_of_accounts ca ON ca.id = jl.account_id
    WHERE jl.journal_entry_id = p_id
      AND (jl.debit_amount > 0 OR jl.credit_amount > 0)
  ) s;

  -- Main detail
  SELECT json_build_object(
    'id', je.id,
    'reference', COALESCE(je.reference, ''),
    'description', COALESCE(je.description, ''),
    'status', je.status,
    'entry_date', COALESCE(je.entry_date, je.created_at::date)::text,
    'source_type', COALESCE(je.source_type, 'JOURNAL'),
    'source_reference', CASE je.source_type
      WHEN 'INVOICE' THEN (SELECT invoice_number FROM public.invoices WHERE id = je.source_id)
      WHEN 'VENDOR_BILL' THEN (SELECT bill_number FROM finance.vendor_bills WHERE id = je.source_id)
      WHEN 'EXPENSE' THEN (SELECT reference_number FROM public.expenses WHERE id = je.source_id)
      ELSE NULL
    END,
    'project_name', p.name,
    'period_name', ap.name,
    'total_debit', agg.total_debit,
    'total_credit', agg.total_credit,
    'created_by_name', COALESCE((SELECT full_name FROM public.profiles WHERE user_id = je.created_by), ''),
    'created_at', je.created_at::text,
    'settlement_lines', v_settlement_lines,
    'journal_lines', COALESCE((SELECT json_agg(row_to_json(jl_row) ORDER BY jl_row.account_code) FROM (
      SELECT ca.code as account_code, ca.name as account_name, ca.account_type,
        jl.debit_amount, jl.credit_amount
      FROM finance.journal_lines jl
      JOIN finance.chart_of_accounts ca ON ca.id = jl.account_id
      WHERE jl.journal_entry_id = p_id
    ) jl_row), '[]'::JSON),
    'status_timeline', '[]'::JSON,
    'attachments_count', 0
  ) INTO v_result
  FROM finance.journal_entries je
  LEFT JOIN public.projects p ON p.id = je.project_id
  LEFT JOIN finance.accounting_periods ap ON ap.id = je.period_id
  LEFT JOIN LATERAL (
    SELECT SUM(jl.debit_amount) as total_debit, SUM(jl.credit_amount) as total_credit
    FROM finance.journal_lines jl WHERE jl.journal_entry_id = je.id
  ) agg ON true
  WHERE je.id = p_id;

  RETURN COALESCE(v_result, '{}'::JSON);
END;
 $$;


ALTER FUNCTION "reporting"."transaction_detail"("p_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "reporting"."transaction_list"("p_search" "text" DEFAULT ''::"text", "p_type" "text" DEFAULT 'ALL'::"text", "p_status" "text" DEFAULT 'ALL'::"text", "p_project_id" "uuid" DEFAULT NULL::"uuid", "p_date_from" "date" DEFAULT NULL::"date", "p_date_to" "date" DEFAULT NULL::"date", "p_limit" integer DEFAULT 25, "p_offset" integer DEFAULT 0) RETURNS json
    LANGUAGE "plpgsql" STABLE
    SET "search_path" TO 'pg_catalog', 'reporting', 'public'
    AS $$ BEGIN
  RETURN COALESCE(json_agg(row_to_json(t) ORDER BY t.entry_date DESC, t.created_at DESC), '[]'::JSON) FROM (
    SELECT 
      je.id,
      COALESCE(je.reference, '') as reference,
      COALESCE(je.description, 'No description') as description,
      je.status,
      COALESCE(je.entry_date, je.created_at::date)::text as entry_date,
      COALESCE(je.source_type, 'JOURNAL') as source_type,
      CASE je.source_type
        WHEN 'INVOICE' THEN (SELECT invoice_number FROM public.invoices WHERE id = je.source_id)
        WHEN 'VENDOR_BILL' THEN (SELECT bill_number FROM finance.vendor_bills WHERE id = je.source_id)
        WHEN 'EXPENSE' THEN (SELECT reference_number FROM public.expenses WHERE id = je.source_id)
        ELSE NULL
      END as source_reference,
      p.name as project_name,
      agg.total_debit,
      agg.total_credit,
      agg.total_credit - agg.total_debit as net_amount,
      agg.account_names,
      COALESCE((SELECT full_name FROM public.profiles WHERE user_id = je.created_by), '') as created_by_name,
      je.created_at::text
    FROM finance.journal_entries je
    LEFT JOIN public.projects p ON p.id = je.project_id
    LEFT JOIN LATERAL (
      SELECT 
        SUM(jl.debit_amount) as total_debit,
        SUM(jl.credit_amount) as total_credit,
        ARRAY_AGG(DISTINCT ca.name ORDER BY ca.name) FILTER (WHERE ca.name IS NOT NULL) as account_names
      FROM finance.journal_lines jl
      JOIN finance.chart_of_accounts ca ON ca.id = jl.account_id
      WHERE jl.journal_entry_id = je.id
    ) agg ON true
    WHERE 1=1
      AND (p_search = '' OR je.description ILIKE '%' || p_search || '%' OR je.reference ILIKE '%' || p_search || '%')
      AND (p_status = 'ALL' OR je.status = p_status)
      AND (p_project_id IS NULL OR je.project_id = p_project_id)
      AND (p_date_from IS NULL OR COALESCE(je.entry_date, je.created_at::date) >= p_date_from)
      AND (p_date_to IS NULL OR COALESCE(je.entry_date, je.created_at::date) <= p_date_to)
      AND (p_type = 'ALL' OR
        (p_type = 'INFLOW' AND agg.total_credit > agg.total_debit) OR
        (p_type = 'OUTFLOW' AND agg.total_debit > agg.total_credit)
      )
    ORDER BY COALESCE(je.entry_date, je.created_at::date) DESC, je.created_at DESC
    LIMIT p_limit OFFSET p_offset
  ) t;
END;
 $$;


ALTER FUNCTION "reporting"."transaction_list"("p_search" "text", "p_type" "text", "p_status" "text", "p_project_id" "uuid", "p_date_from" "date", "p_date_to" "date", "p_limit" integer, "p_offset" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "reporting"."transaction_summary"() RETURNS json
    LANGUAGE "plpgsql" STABLE
    SET "search_path" TO 'pg_catalog', 'reporting', 'public'
    AS $$ DECLARE
  v_period_id UUID;
BEGIN
  SELECT id INTO v_period_id FROM finance.accounting_periods WHERE status = 'OPEN' ORDER BY start_date DESC LIMIT 1;

  RETURN json_build_object(
    'total_inflow', COALESCE((SELECT SUM(jl.credit_amount - jl.debit_amount) FROM finance.journal_lines jl JOIN finance.journal_entries je ON je.id = jl.journal_entry_id JOIN finance.chart_of_accounts ca ON ca.id = jl.account_id WHERE je.status = 'POSTED' AND ca.account_type IN ('REVENUE','OTHER_INCOME')), 0),
    'total_outflow', COALESCE((SELECT SUM(jl.debit_amount - jl.credit_amount) FROM finance.journal_lines jl JOIN finance.journal_entries je ON je.id = jl.journal_entry_id JOIN finance.chart_of_accounts ca ON ca.id = jl.account_id WHERE je.status = 'POSTED' AND ca.account_type IN ('COST_OF_SALES','OPERATING_EXPENSE','OTHER_EXPENSE')), 0),
    'this_month_count', COALESCE((SELECT COUNT(*) FROM finance.journal_entries WHERE period_id = v_period_id), 0),
    'posted_count', COALESCE((SELECT COUNT(*) FROM finance.journal_entries WHERE status = 'POSTED'), 0),
    'pending_count', COALESCE((SELECT COUNT(*) FROM finance.journal_entries WHERE status IN ('DRAFT','SUBMITTED','VERIFIED','APPROVED')), 0)
  );
END;
 $$;


ALTER FUNCTION "reporting"."transaction_summary"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "reporting"."unreconciled_summary"() RETURNS json
    LANGUAGE "plpgsql" STABLE
    SET "search_path" TO 'pg_catalog', 'reporting', 'public'
    AS $$ BEGIN
  RETURN COALESCE(
    json_agg(row_to_json(t) ORDER BY t.unreconciled_amount DESC)
  , '[]'::JSON) FROM (
    SELECT 
      fa.id as account_id,
      fa.account_name,
      fa.institution_type,
      COUNT(sl.id)::int as unreconciled_count,
      COALESCE(SUM(sl.amount), 0) as unreconciled_amount,
      MAX(sl.transaction_date) as last_statement_date
    FROM finance.statement_lines sl
    JOIN finance.bank_statements bs ON bs.id = sl.bank_statement_id
    JOIN finance.financial_accounts fa ON fa.id = bs.financial_account_id
    WHERE sl.reconciliation_status = 'UNRECONCILED'
    GROUP BY fa.id, fa.account_name, fa.institution_type
  ) t;
END;
 $$;


ALTER FUNCTION "reporting"."unreconciled_summary"() OWNER TO "postgres";

SET default_tablespace = '';

SET default_table_access_method = "heap";


CREATE TABLE IF NOT EXISTS "ai"."ai_conversations" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "title" "text",
    "status" "text" DEFAULT 'active'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "ai_conversations_status_check" CHECK (("status" = ANY (ARRAY['active'::"text", 'archived'::"text", 'deleted'::"text"])))
);


ALTER TABLE "ai"."ai_conversations" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "ai"."ai_document_extractions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "file_id" "uuid",
    "file_name" "text" NOT NULL,
    "document_type" "text" NOT NULL,
    "extracted_fields" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "confidence" numeric(5,4),
    "reviewer_id" "uuid",
    "status" "text" DEFAULT 'draft'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "reviewed_at" timestamp with time zone,
    CONSTRAINT "ai_document_extractions_document_type_check" CHECK (("document_type" = ANY (ARRAY['receipt'::"text", 'invoice'::"text", 'bank_statement'::"text", 'other'::"text"]))),
    CONSTRAINT "ai_document_extractions_status_check" CHECK (("status" = ANY (ARRAY['draft'::"text", 'accepted'::"text", 'corrected'::"text", 'rejected'::"text"])))
);


ALTER TABLE "ai"."ai_document_extractions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "ai"."ai_feedback" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "message_id" "uuid",
    "tool_call_id" "uuid",
    "feedback_type" "text" NOT NULL,
    "rating" integer,
    "correction" "text",
    "reason" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "ai_feedback_feedback_type_check" CHECK (("feedback_type" = ANY (ARRAY['message_rating'::"text", 'suggestion_rating'::"text", 'correction'::"text", 'general'::"text"]))),
    CONSTRAINT "ai_feedback_rating_check" CHECK ((("rating" >= 1) AND ("rating" <= 5)))
);


ALTER TABLE "ai"."ai_feedback" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "ai"."ai_messages" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "conversation_id" "uuid" NOT NULL,
    "role" "text" NOT NULL,
    "content" "text" NOT NULL,
    "content_type" "text" DEFAULT 'text'::"text" NOT NULL,
    "classification" "text",
    "metadata" "jsonb" DEFAULT '{}'::"jsonb",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "ai_messages_content_type_check" CHECK (("content_type" = ANY (ARRAY['text'::"text", 'json'::"text", 'error'::"text"]))),
    CONSTRAINT "ai_messages_role_check" CHECK (("role" = ANY (ARRAY['user'::"text", 'assistant'::"text", 'system'::"text"])))
);


ALTER TABLE "ai"."ai_messages" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "ai"."ai_model_registry" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "provider" "text" NOT NULL,
    "model_id" "text" NOT NULL,
    "display_name" "text" NOT NULL,
    "purpose" "text" NOT NULL,
    "version" "text",
    "data_policy" "text" DEFAULT 'no_storage'::"text" NOT NULL,
    "max_tokens" integer DEFAULT 4096,
    "temperature" numeric(3,2) DEFAULT 0.1,
    "enabled" boolean DEFAULT true NOT NULL,
    "cost_per_1k_tokens" numeric(10,6),
    "rate_limit_rpm" integer DEFAULT 30,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "ai"."ai_model_registry" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "ai"."ai_prompt_versions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "prompt_key" "text" NOT NULL,
    "version" integer DEFAULT 1 NOT NULL,
    "content" "text" NOT NULL,
    "checksum" "text" NOT NULL,
    "is_active" boolean DEFAULT true NOT NULL,
    "approved_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "ai"."ai_prompt_versions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "ai"."ai_query_audit" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tool_call_id" "uuid",
    "conversation_id" "uuid" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "question" "text" NOT NULL,
    "normalized_intent" "text",
    "tool_or_report" "text",
    "sql_or_params" "jsonb",
    "row_count" integer,
    "timed_out" boolean DEFAULT false NOT NULL,
    "result_hash" "text",
    "status" "text" DEFAULT 'success'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "timeout_ms" integer DEFAULT 5000,
    "estimated_cost" numeric(10,6) DEFAULT 0
);


ALTER TABLE "ai"."ai_query_audit" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "ai"."ai_suggestions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "entity_type" "text" NOT NULL,
    "entity_id" "uuid",
    "suggestion_type" "text" NOT NULL,
    "suggestion_data" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "confidence" numeric(5,4),
    "reasons" "text"[],
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "resolved_at" timestamp with time zone,
    "resolved_by" "uuid",
    CONSTRAINT "ai_suggestions_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'accepted'::"text", 'rejected'::"text", 'expired'::"text"])))
);


ALTER TABLE "ai"."ai_suggestions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "ai"."ai_tool_calls" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "message_id" "uuid" NOT NULL,
    "conversation_id" "uuid" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "tool_name" "text" NOT NULL,
    "input_params" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "input_hash" "text",
    "permission_check" "text" DEFAULT 'pending'::"text" NOT NULL,
    "user_role" "text" NOT NULL,
    "status" "text" DEFAULT 'success'::"text" NOT NULL,
    "result_rows" integer,
    "latency_ms" integer,
    "model" "text",
    "error_message" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "ai_tool_calls_permission_check_check" CHECK (("permission_check" = ANY (ARRAY['passed'::"text", 'denied'::"text", 'skipped'::"text"]))),
    CONSTRAINT "ai_tool_calls_status_check" CHECK (("status" = ANY (ARRAY['success'::"text", 'error'::"text", 'timeout'::"text", 'blocked'::"text"])))
);


ALTER TABLE "ai"."ai_tool_calls" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "ai"."ai_user_cost_tracking" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "period_date" "date" NOT NULL,
    "request_count" integer DEFAULT 0 NOT NULL,
    "total_tokens" integer DEFAULT 0 NOT NULL,
    "estimated_cost" numeric(12,4) DEFAULT 0 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "ai"."ai_user_cost_tracking" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "audit"."audit_log" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid",
    "user_name" "text",
    "user_email" "text",
    "role_snapshot" "text",
    "session_id" "text",
    "auth_method" "text",
    "action" "text" NOT NULL,
    "entity_type" "text",
    "entity_id" "uuid",
    "status" "text" DEFAULT 'success'::"text" NOT NULL,
    "severity" "text" DEFAULT 'info'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "org_timezone" "text",
    "ip_address" "inet",
    "user_agent" "text",
    "request_id" "text",
    "description" "text",
    "old_values" "jsonb",
    "new_values" "jsonb",
    "changed_columns" "text"[],
    "reason" "text",
    "approval_comments" "text",
    "previous_status" "text",
    "new_status" "text",
    "approval_level" "text",
    "delegated_authority" "text",
    "limit_decision" "text",
    "attachment_ids" "uuid"[],
    "import_batch_id" "uuid",
    "external_ref" "text",
    "related_journal_id" "uuid",
    "related_payment_id" "uuid",
    "project_id" "uuid",
    "amount" numeric(18,2),
    "amount_currency" "text",
    "source_module" "text",
    "source_schema" "text",
    "source_table" "text",
    "record_id" "uuid",
    "changed_by" "uuid",
    "table_schema" "text",
    "table_name" "text",
    "error_message" "text",
    "source_id" "uuid",
    "ai_question" "text",
    "ai_normalized_intent" "text",
    "ai_selected_tool" "text",
    "ai_generated_sql" "text",
    "ai_template_id" "text",
    "ai_row_count" integer,
    "ai_model" "text",
    "ai_latency_ms" integer,
    "ai_cost_usd" numeric(12,6),
    "ai_input_tokens" integer,
    "ai_output_tokens" integer,
    "ai_refusal_reason" "text",
    "prev_hash" "text",
    "entry_hash" "text",
    "organization_id" "uuid",
    CONSTRAINT "audit_log_severity_check" CHECK (("severity" = ANY (ARRAY['info'::"text", 'low'::"text", 'medium'::"text", 'high'::"text", 'critical'::"text"]))),
    CONSTRAINT "audit_log_status_check" CHECK (("status" = ANY (ARRAY['success'::"text", 'denied'::"text", 'error'::"text"])))
);


ALTER TABLE "audit"."audit_log" OWNER TO "postgres";


COMMENT ON TABLE "audit"."audit_log" IS 'Append-only audit trail per Spec v1.3 Section 8.1 (incl. AI field group) and 8.3 (incl. project/amount filters). Insert-only from the application; no UPDATE or DELETE path exists for authenticated roles.';



COMMENT ON COLUMN "audit"."audit_log"."organization_id" IS 'Added migration 036 (Compliance Audit Finding 4.5). Backfilled from public.profiles via user_id, so CEO/FINANCE_HEAD audit-log SELECT policies can be organization-scoped in migration 039.';



CREATE TABLE IF NOT EXISTS "audit"."data_access_events" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid",
    "user_email" "text",
    "accessed_entity_type" "text" NOT NULL,
    "accessed_entity_id" "uuid",
    "access_type" "text" DEFAULT 'read'::"text",
    "access_granted" boolean DEFAULT true,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "request_id" "text",
    "organization_id" "uuid",
    CONSTRAINT "data_access_events_access_type_check" CHECK (("access_type" = ANY (ARRAY['read'::"text", 'export'::"text", 'print'::"text", 'download'::"text"])))
);


ALTER TABLE "audit"."data_access_events" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "audit"."export_events" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid",
    "user_email" "text",
    "user_name" "text",
    "report_name" "text" NOT NULL,
    "report_type" "text",
    "format" "text" DEFAULT 'csv'::"text",
    "filters" "jsonb",
    "row_count" integer,
    "file_size_bytes" integer,
    "ip_address" "inet",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "request_id" "text",
    "organization_id" "uuid",
    CONSTRAINT "export_events_format_check" CHECK (("format" = ANY (ARRAY['csv'::"text", 'pdf'::"text", 'xlsx'::"text", 'json'::"text"])))
);


ALTER TABLE "audit"."export_events" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "audit"."security_events" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid",
    "user_email" "text",
    "event_type" "text" NOT NULL,
    "ip_address" "inet",
    "user_agent" "text",
    "details" "jsonb",
    "success" boolean DEFAULT true,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "request_id" "text",
    "organization_id" "uuid",
    CONSTRAINT "security_events_event_type_check" CHECK (("event_type" = ANY (ARRAY['LOGIN_SUCCESS'::"text", 'LOGIN_FAILURE'::"text", 'MFA_ENABLED'::"text", 'MFA_DISABLED'::"text", 'MFA_VERIFICATION_SUCCESS'::"text", 'MFA_VERIFICATION_FAILURE'::"text", 'PASSWORD_RESET_REQUEST'::"text", 'PASSWORD_RESET_SUCCESS'::"text", 'PASSWORD_RESET_FAILURE'::"text", 'SESSION_TERMINATED'::"text", 'SUSPICIOUS_ACCESS'::"text", 'LOCKOUT'::"text", 'PERMISSION_CHANGE'::"text", 'ROLE_CHANGE'::"text", 'DATA_SCOPE_CHANGE'::"text", 'NEW_DEVICE'::"text"])))
);


ALTER TABLE "audit"."security_events" OWNER TO "postgres";


CREATE OR REPLACE VIEW "audit"."v_unsafe_security_definer_functions" WITH ("security_invoker"='true') AS
 SELECT "n"."nspname" AS "schema_name",
    "p"."proname" AS "function_name",
    "pg_get_function_identity_arguments"("p"."oid") AS "arguments"
   FROM ("pg_proc" "p"
     JOIN "pg_namespace" "n" ON (("n"."oid" = "p"."pronamespace")))
  WHERE (("n"."nspname" = ANY (ARRAY['ai'::"name", 'audit'::"name", 'core'::"name", 'finance'::"name", 'public'::"name", 'reporting'::"name"])) AND ("p"."prosecdef" = true) AND (NOT (EXISTS ( SELECT 1
           FROM "unnest"(COALESCE("p"."proconfig", ARRAY[]::"text"[])) "cfg"("cfg")
          WHERE ("cfg"."cfg" ~~ 'search_path=%'::"text")))));


ALTER VIEW "audit"."v_unsafe_security_definer_functions" OWNER TO "postgres";


COMMENT ON VIEW "audit"."v_unsafe_security_definer_functions" IS 'Guardrail view (spec Section 20): any row here is a SECURITY DEFINER function shipped without a pinned search_path and must be fixed before release.';



CREATE TABLE IF NOT EXISTS "core"."approval_actions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "approval_step_id" "uuid" NOT NULL,
    "actor_user_id" "uuid" NOT NULL,
    "action" "text" NOT NULL,
    "comment" "text",
    "delegated_from" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "approval_actions_action_check" CHECK (("action" = ANY (ARRAY['APPROVE'::"text", 'REJECT'::"text", 'ESCALATE'::"text", 'DELEGATE'::"text", 'RETURN'::"text"])))
);


ALTER TABLE "core"."approval_actions" OWNER TO "postgres";


COMMENT ON TABLE "core"."approval_actions" IS 'Immutable log of individual approve/reject/escalate/delegate actions. Added migration 021 (audit issue H8).';



CREATE TABLE IF NOT EXISTS "core"."approval_limits" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "role_id" "uuid",
    "user_id" "uuid",
    "transaction_type" "text" NOT NULL,
    "currency" "text" DEFAULT 'PKR'::"text" NOT NULL,
    "max_amount" numeric(18,2),
    "scope" "text" DEFAULT 'ALL'::"text" NOT NULL,
    "effective_from" "date" DEFAULT CURRENT_DATE NOT NULL,
    "effective_to" "date",
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "created_by" "uuid",
    "organization_id" "uuid",
    CONSTRAINT "approval_limits_dates_chk" CHECK ((("effective_to" IS NULL) OR ("effective_to" >= "effective_from"))),
    CONSTRAINT "approval_limits_max_amount_chk" CHECK ((("max_amount" IS NULL) OR ("max_amount" >= (0)::numeric))),
    CONSTRAINT "approval_limits_org_required_going_forward" CHECK (("organization_id" IS NOT NULL)),
    CONSTRAINT "approval_limits_role_or_user_chk" CHECK (((("role_id" IS NOT NULL) AND ("user_id" IS NULL)) OR (("role_id" IS NULL) AND ("user_id" IS NOT NULL)))),
    CONSTRAINT "approval_limits_scope_chk" CHECK (("scope" = ANY (ARRAY['OWN'::"text", 'PROJECT'::"text", 'DEPARTMENT'::"text", 'ALL'::"text"]))),
    CONSTRAINT "approval_limits_transaction_type_chk" CHECK (("transaction_type" = ANY (ARRAY['EXPENSE'::"text", 'PURCHASE'::"text", 'VENDOR_PAYMENT'::"text", 'BUDGET_REVISION'::"text", 'JOURNAL_ENTRY'::"text", 'BANK_TRANSFER'::"text", 'SALARY_PAYROLL'::"text", 'OWNER_DISTRIBUTION'::"text", 'PERIOD_REOPEN'::"text", 'INVOICE_CREDIT_NOTE'::"text", 'VENDOR_BILL'::"text", 'RESERVE_ALLOCATION'::"text"])))
);


ALTER TABLE "core"."approval_limits" OWNER TO "postgres";


COMMENT ON TABLE "core"."approval_limits" IS 'Configurable monetary approval ceilings by role or individual user, per transaction type and currency (spec 7.3). max_amount NULL = unlimited (e.g. CEO).';



CREATE TABLE IF NOT EXISTS "core"."approval_requests" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "entity_type" "text" NOT NULL,
    "entity_id" "uuid" NOT NULL,
    "transaction_type" "text" NOT NULL,
    "amount" numeric(18,2),
    "currency" "text" DEFAULT 'PKR'::"text",
    "requested_by" "uuid" NOT NULL,
    "current_step" integer DEFAULT 1 NOT NULL,
    "status" "text" DEFAULT 'PENDING'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "organization_id" "uuid",
    CONSTRAINT "approval_requests_org_required_going_forward" CHECK (("organization_id" IS NOT NULL)),
    CONSTRAINT "approval_requests_status_check" CHECK (("status" = ANY (ARRAY['PENDING'::"text", 'APPROVED'::"text", 'REJECTED'::"text", 'ESCALATED'::"text", 'CANCELLED'::"text"])))
);


ALTER TABLE "core"."approval_requests" OWNER TO "postgres";


COMMENT ON TABLE "core"."approval_requests" IS 'Generic maker-checker approval chain header. Added migration 021 (audit issue H8).';



CREATE TABLE IF NOT EXISTS "core"."approval_steps" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "approval_request_id" "uuid" NOT NULL,
    "step_number" integer NOT NULL,
    "required_role_id" "uuid",
    "assigned_user_id" "uuid",
    "sla_hours" integer,
    "escalate_to_user_id" "uuid",
    "status" "text" DEFAULT 'PENDING'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "approval_steps_status_check" CHECK (("status" = ANY (ARRAY['PENDING'::"text", 'APPROVED'::"text", 'REJECTED'::"text", 'ESCALATED'::"text", 'SKIPPED'::"text"])))
);


ALTER TABLE "core"."approval_steps" OWNER TO "postgres";


COMMENT ON TABLE "core"."approval_steps" IS 'Per-level approval steps with SLA/escalation. Added migration 021 (audit issue H8).';



CREATE TABLE IF NOT EXISTS "core"."budget_policies" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "enforcement_mode" "text" DEFAULT 'HARD_BLOCK'::"text" NOT NULL,
    "caution_threshold" numeric(5,2) DEFAULT 75 NOT NULL,
    "warning_threshold" numeric(5,2) DEFAULT 90 NOT NULL,
    "block_threshold" numeric(5,2) DEFAULT 100 NOT NULL,
    "is_active" boolean DEFAULT true NOT NULL,
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "chk_block" CHECK ((("block_threshold" >= (0)::numeric) AND ("block_threshold" <= (100)::numeric))),
    CONSTRAINT "chk_caution" CHECK ((("caution_threshold" >= (0)::numeric) AND ("caution_threshold" <= (100)::numeric))),
    CONSTRAINT "chk_enforcement_mode" CHECK (("enforcement_mode" = ANY (ARRAY['WARN_ONLY'::"text", 'HARD_BLOCK'::"text"]))),
    CONSTRAINT "chk_warning" CHECK ((("warning_threshold" >= (0)::numeric) AND ("warning_threshold" <= (100)::numeric)))
);


ALTER TABLE "core"."budget_policies" OWNER TO "postgres";


COMMENT ON TABLE "core"."budget_policies" IS 'Per-organization budget enforcement policy configuration. Referenced by budget-check.service.ts.';



CREATE TABLE IF NOT EXISTS "core"."delegations" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "from_user_id" "uuid" NOT NULL,
    "to_user_id" "uuid" NOT NULL,
    "permission_ids" "uuid"[] NOT NULL,
    "reason" "text" NOT NULL,
    "effective_from" "date" DEFAULT CURRENT_DATE NOT NULL,
    "effective_to" "date" NOT NULL,
    "status" "text" DEFAULT 'ACTIVE'::"text" NOT NULL,
    "revoked_by" "uuid",
    "revoked_at" timestamp with time zone,
    "revoke_reason" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "created_by" "uuid",
    "organization_id" "uuid",
    CONSTRAINT "delegations_dates_chk" CHECK (("effective_to" >= "effective_from")),
    CONSTRAINT "delegations_not_self_chk" CHECK (("from_user_id" <> "to_user_id")),
    CONSTRAINT "delegations_org_required_going_forward" CHECK (("organization_id" IS NOT NULL)),
    CONSTRAINT "delegations_permission_ids_not_empty_chk" CHECK (("array_length"("permission_ids", 1) > 0)),
    CONSTRAINT "delegations_reason_not_blank_chk" CHECK (("btrim"("reason") <> ''::"text")),
    CONSTRAINT "delegations_status_chk" CHECK (("status" = ANY (ARRAY['ACTIVE'::"text", 'EXPIRED'::"text", 'REVOKED'::"text"])))
);


ALTER TABLE "core"."delegations" OWNER TO "postgres";


COMMENT ON TABLE "core"."delegations" IS 'Time-limited delegation of specific permissions from one user to another with mandatory reason (spec 10.1, 7.2).';



CREATE TABLE IF NOT EXISTS "core"."employee_links" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "shared_person_id" "uuid" NOT NULL,
    "source_module" "text" DEFAULT 'FINANCE'::"text" NOT NULL,
    "external_employee_id" "text",
    "schema_version" integer DEFAULT 1 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "core"."employee_links" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "core"."idempotency_keys" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "scope" "text" NOT NULL,
    "key" "text" NOT NULL,
    "request_hash" "text",
    "response_snapshot" "jsonb",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "organization_id" "uuid" NOT NULL
);


ALTER TABLE "core"."idempotency_keys" OWNER TO "postgres";


COMMENT ON TABLE "core"."idempotency_keys" IS 'General-purpose idempotency guard for payment/import/webhook/posting commands (spec 11.2). Added migration 021.';



CREATE TABLE IF NOT EXISTS "core"."integration_events" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "schema_version" integer DEFAULT 1 NOT NULL,
    "source_module" "text" NOT NULL,
    "event_type" "text" NOT NULL,
    "organization_id" "uuid",
    "idempotency_key" "text" NOT NULL,
    "occurred_at" timestamp with time zone NOT NULL,
    "effective_business_date" "date",
    "actor_user_id" "uuid",
    "correlation_id" "uuid",
    "payload" "jsonb" NOT NULL,
    "payload_hash" "text" NOT NULL,
    "processing_status" "text" DEFAULT 'PENDING'::"text" NOT NULL,
    "processed_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "integration_events_org_required_going_forward" CHECK (("organization_id" IS NOT NULL)),
    CONSTRAINT "integration_events_status_check" CHECK (("processing_status" = ANY (ARRAY['PENDING'::"text", 'PROCESSED'::"text", 'FAILED'::"text", 'DEAD_LETTER'::"text"])))
);


ALTER TABLE "core"."integration_events" OWNER TO "postgres";


COMMENT ON TABLE "core"."integration_events" IS 'Versioned, idempotent cross-module events (Appendix D). Added migration 021 (audit issue H6).';



CREATE TABLE IF NOT EXISTS "core"."integration_failures" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "integration_event_id" "uuid" NOT NULL,
    "retry_count" integer DEFAULT 0 NOT NULL,
    "last_error" "text",
    "next_retry_at" timestamp with time zone,
    "dead_letter" boolean DEFAULT false NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "core"."integration_failures" OWNER TO "postgres";


COMMENT ON TABLE "core"."integration_failures" IS 'Retry/dead-letter tracking for integration_events. Added migration 021 (audit issue H6).';



CREATE TABLE IF NOT EXISTS "core"."organization_config" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "created_by" "uuid",
    "org_name" "text" NOT NULL,
    "base_currency" "text" DEFAULT 'PKR'::"text" NOT NULL,
    "enabled_currencies" "text"[] DEFAULT '{PKR,USD}'::"text"[],
    "timezone" "text" DEFAULT 'Asia/Karachi'::"text",
    "date_format" "text" DEFAULT 'DD/MM/YYYY'::"text",
    "number_format" "text" DEFAULT 'en-PK'::"text",
    "fiscal_year_start_month" integer DEFAULT 7 NOT NULL,
    "fiscal_year_end_month" integer DEFAULT 6 NOT NULL,
    "decimal_precision" integer DEFAULT 2,
    "rounding_method" "text" DEFAULT 'HALF_UP'::"text",
    "logo_url" "text",
    "active" boolean DEFAULT true,
    "organization_id" "uuid",
    CONSTRAINT "organization_config_decimal_precision_check" CHECK ((("decimal_precision" >= 0) AND ("decimal_precision" <= 6))),
    CONSTRAINT "organization_config_fiscal_year_end_month_check" CHECK ((("fiscal_year_end_month" >= 1) AND ("fiscal_year_end_month" <= 12))),
    CONSTRAINT "organization_config_fiscal_year_start_month_check" CHECK ((("fiscal_year_start_month" >= 1) AND ("fiscal_year_start_month" <= 12))),
    CONSTRAINT "organization_config_rounding_method_check" CHECK (("rounding_method" = ANY (ARRAY['HALF_UP'::"text", 'HALF_DOWN'::"text", 'CEILING'::"text", 'FLOOR'::"text", 'UP'::"text", 'DOWN'::"text"]))),
    CONSTRAINT "valid_fiscal_months" CHECK (("fiscal_year_start_month" <> "fiscal_year_end_month"))
);


ALTER TABLE "core"."organization_config" OWNER TO "postgres";


COMMENT ON COLUMN "core"."organization_config"."organization_id" IS 'Links this settings row to its owning organization (spec Section 10.1 organizations table). Added FK + UNIQUE in migration 030 (Compliance Audit R3). Previously unconstrained, which allowed finance.tax_* RLS policies to reference this table without any real org-scoping guarantee.';



CREATE TABLE IF NOT EXISTS "core"."organization_modules" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "module_key" "text" NOT NULL,
    "enabled" boolean DEFAULT false NOT NULL,
    "config" "jsonb" DEFAULT '{}'::"jsonb",
    "config_version" integer DEFAULT 1 NOT NULL,
    "effective_from" "date" DEFAULT CURRENT_DATE NOT NULL,
    "effective_to" "date",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "created_by" "uuid",
    CONSTRAINT "organization_modules_module_key_chk" CHECK (("module_key" = ANY (ARRAY['FINANCE'::"text", 'HR'::"text", 'PAYROLL'::"text", 'ATTENDANCE'::"text", 'AI'::"text", 'REPORTING'::"text", 'INTEGRATION'::"text"])))
);


ALTER TABLE "core"."organization_modules" OWNER TO "postgres";


COMMENT ON TABLE "core"."organization_modules" IS 'Per-organization module enablement/config, e.g. gating the future HR/Payroll modules on the shared Supabase platform (spec 10.1, Appendix D).';



CREATE TABLE IF NOT EXISTS "core"."organizations" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "legal_name" "text",
    "type" "text" DEFAULT 'COMPANY'::"text",
    "tax_registration" "text",
    "ntn" "text",
    "base_currency" "text" DEFAULT 'PKR'::"text" NOT NULL,
    "timezone" "text" DEFAULT 'Asia/Karachi'::"text" NOT NULL,
    "date_format" "text" DEFAULT 'DD/MM/YYYY'::"text" NOT NULL,
    "number_format" "text" DEFAULT 'EN'::"text" NOT NULL,
    "fiscal_year_start_month" integer DEFAULT 7 NOT NULL,
    "is_active" boolean DEFAULT true NOT NULL,
    "address" "text",
    "city" "text",
    "country" "text" DEFAULT 'Pakistan'::"text" NOT NULL,
    "phone" "text",
    "email" "text",
    "website" "text",
    "logo_url" "text",
    "config" "jsonb" DEFAULT '{}'::"jsonb",
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "organizations_type_check" CHECK (("type" = ANY (ARRAY['COMPANY'::"text", 'SOLE_PROPRIETOR'::"text", 'PARTNERSHIP'::"text", 'AOP'::"text", 'OTHER'::"text"])))
);


ALTER TABLE "core"."organizations" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "core"."permissions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "code" "text" NOT NULL,
    "name" "text" NOT NULL,
    "module" "text" NOT NULL,
    "action" "text" NOT NULL,
    "description" "text",
    "is_system" boolean DEFAULT false,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "created_by" "uuid"
);


ALTER TABLE "core"."permissions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "core"."role_permissions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "role_id" "uuid" NOT NULL,
    "permission_id" "uuid" NOT NULL,
    "data_scope" "text" DEFAULT 'ALL'::"text" NOT NULL,
    "amount_limit" numeric(18,2),
    "effective_from" "date" DEFAULT CURRENT_DATE NOT NULL,
    "effective_to" "date",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "created_by" "uuid",
    CONSTRAINT "role_permissions_data_scope_check" CHECK (("data_scope" = ANY (ARRAY['OWN'::"text", 'DEPARTMENT'::"text", 'PROJECT'::"text", 'ALL'::"text"])))
);


ALTER TABLE "core"."role_permissions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "core"."roles" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "display_name" "text" NOT NULL,
    "description" "text",
    "is_system" boolean DEFAULT false,
    "level" integer DEFAULT 0,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "created_by" "uuid",
    "organization_id" "uuid"
);


ALTER TABLE "core"."roles" OWNER TO "postgres";


COMMENT ON COLUMN "core"."roles"."organization_id" IS 'Added migration 028 (Compliance Audit Finding 2.1). Nullable until migration 029 backfills and constrains it. NULL means "not yet scoped" during the transition window only.';



CREATE TABLE IF NOT EXISTS "core"."shared_people" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "auth_user_id" "uuid",
    "display_name" "text" NOT NULL,
    "person_type" "text" DEFAULT 'EMPLOYEE'::"text" NOT NULL,
    "status" "text" DEFAULT 'ACTIVE'::"text" NOT NULL,
    "external_reference" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "created_by" "uuid",
    CONSTRAINT "shared_people_person_type_chk" CHECK (("person_type" = ANY (ARRAY['EMPLOYEE'::"text", 'CONTRACTOR'::"text", 'OWNER'::"text", 'OTHER'::"text"]))),
    CONSTRAINT "shared_people_status_chk" CHECK (("status" = ANY (ARRAY['ACTIVE'::"text", 'INACTIVE'::"text", 'TERMINATED'::"text"])))
);


ALTER TABLE "core"."shared_people" OWNER TO "postgres";


COMMENT ON TABLE "core"."shared_people" IS 'Stable cross-module person identity (spec Appendix D.2). Finance, and later HR/attendance/payroll, reference this ID rather than maintaining independent, conflicting identity records.';



CREATE TABLE IF NOT EXISTS "core"."user_permission_overrides" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "permission_id" "uuid" NOT NULL,
    "override_type" "text" NOT NULL,
    "data_scope" "text" DEFAULT 'ALL'::"text",
    "amount_limit" numeric(18,2),
    "reason" "text" NOT NULL,
    "effective_from" "date" DEFAULT CURRENT_DATE NOT NULL,
    "effective_to" "date",
    "approved_by" "uuid",
    "approved_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "created_by" "uuid",
    CONSTRAINT "upo_data_scope_chk" CHECK (("data_scope" = ANY (ARRAY['OWN'::"text", 'DEPARTMENT'::"text", 'PROJECT'::"text", 'ALL'::"text"]))),
    CONSTRAINT "upo_dates_chk" CHECK ((("effective_to" IS NULL) OR ("effective_to" >= "effective_from"))),
    CONSTRAINT "upo_override_type_chk" CHECK (("override_type" = ANY (ARRAY['ALLOW'::"text", 'DENY'::"text"]))),
    CONSTRAINT "upo_reason_not_blank_chk" CHECK (("btrim"("reason") <> ''::"text"))
);


ALTER TABLE "core"."user_permission_overrides" OWNER TO "postgres";


COMMENT ON TABLE "core"."user_permission_overrides" IS 'Per-user ALLOW/DENY override of a specific permission, independent of role assignment (spec 7.2).';



CREATE TABLE IF NOT EXISTS "core"."user_roles" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "role_id" "uuid" NOT NULL,
    "effective_from" "date" DEFAULT CURRENT_DATE NOT NULL,
    "effective_to" "date",
    "delegated_from" "uuid",
    "is_active" boolean DEFAULT true,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "created_by" "uuid"
);


ALTER TABLE "core"."user_roles" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "finance"."chart_of_accounts" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "created_by" "uuid",
    "code" "text" NOT NULL,
    "name" "text" NOT NULL,
    "parent_id" "uuid",
    "account_type" "text" NOT NULL,
    "normal_balance" "text" NOT NULL,
    "currency" "text" DEFAULT 'PKR'::"text",
    "is_active" boolean DEFAULT true,
    "posting_allowed" boolean DEFAULT true,
    "is_control_account" boolean DEFAULT false,
    "report_mapping" "text",
    "description" "text",
    "display_order" integer DEFAULT 0,
    "level" integer DEFAULT 0,
    "deleted_at" timestamp with time zone,
    "deleted_by" "uuid",
    "organization_id" "uuid" NOT NULL,
    CONSTRAINT "chart_of_accounts_account_type_check" CHECK (("account_type" = ANY (ARRAY['ASSET'::"text", 'LIABILITY'::"text", 'EQUITY'::"text", 'REVENUE'::"text", 'COST_OF_SALES'::"text", 'OPERATING_EXPENSE'::"text", 'OTHER_INCOME'::"text", 'OTHER_EXPENSE'::"text"]))),
    CONSTRAINT "chart_of_accounts_level_check" CHECK ((("level" >= 0) AND ("level" <= 10))),
    CONSTRAINT "chart_of_accounts_normal_balance_check" CHECK (("normal_balance" = ANY (ARRAY['DEBIT'::"text", 'CREDIT'::"text"]))),
    CONSTRAINT "coa_level_0_no_parent" CHECK (((("level" = 0) AND ("parent_id" IS NULL)) OR ("level" > 0))),
    CONSTRAINT "coa_name_not_empty" CHECK ((TRIM(BOTH FROM "name") <> ''::"text"))
);


ALTER TABLE "finance"."chart_of_accounts" OWNER TO "postgres";


CREATE OR REPLACE VIEW "finance"."account_type_summary" WITH ("security_invoker"='true') AS
 SELECT "account_type",
    "count"(*) AS "total_accounts",
    "count"(*) FILTER (WHERE ("is_active" = true)) AS "active_accounts",
    "count"(*) FILTER (WHERE ("posting_allowed" = true)) AS "postable_accounts"
   FROM "finance"."chart_of_accounts"
  GROUP BY "account_type"
  ORDER BY "account_type";


ALTER VIEW "finance"."account_type_summary" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "finance"."accounting_periods" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "created_by" "uuid",
    "fiscal_year_id" "uuid" NOT NULL,
    "period_number" integer NOT NULL,
    "name" "text" NOT NULL,
    "start_date" "date" NOT NULL,
    "end_date" "date" NOT NULL,
    "status" "text" DEFAULT 'PENDING'::"text" NOT NULL,
    "closed_by" "uuid",
    "closed_at" timestamp with time zone,
    "reopening_reason" "text",
    "organization_id" "uuid",
    CONSTRAINT "accounting_periods_org_required_going_forward" CHECK (("organization_id" IS NOT NULL)),
    CONSTRAINT "accounting_periods_period_number_check" CHECK ((("period_number" >= 1) AND ("period_number" <= 13))),
    CONSTRAINT "accounting_periods_status_check" CHECK (("status" = ANY (ARRAY['PENDING'::"text", 'OPEN'::"text", 'SOFT_CLOSED'::"text", 'HARD_CLOSED'::"text"]))),
    CONSTRAINT "ap_dates_valid" CHECK (("end_date" > "start_date")),
    CONSTRAINT "ap_name_not_empty" CHECK ((TRIM(BOTH FROM "name") <> ''::"text")),
    CONSTRAINT "ap_reopening_requires_reason" CHECK (((("status" <> ALL (ARRAY['PENDING'::"text", 'OPEN'::"text"])) AND ("reopening_reason" IS NOT NULL)) OR ("status" = ANY (ARRAY['PENDING'::"text", 'OPEN'::"text"]))))
);


ALTER TABLE "finance"."accounting_periods" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "finance"."asset_categories" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "code" character varying(50) NOT NULL,
    "name" character varying(200) NOT NULL,
    "description" "text",
    "useful_life_months" integer DEFAULT 60 NOT NULL,
    "residual_value_pct" numeric(5,2) DEFAULT 0 NOT NULL,
    "depreciation_method" character varying(50) DEFAULT 'straight_line'::character varying NOT NULL,
    "capitalization_threshold" numeric(18,2) DEFAULT 0 NOT NULL,
    "linked_asset_account_id" "uuid",
    "linked_depreciation_account_id" "uuid",
    "linked_expense_account_id" "uuid",
    "active" boolean DEFAULT true NOT NULL,
    "created_by" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "organization_id" "uuid",
    CONSTRAINT "asset_categories_depreciation_method_check" CHECK ((("depreciation_method")::"text" = ANY ((ARRAY['straight_line'::character varying, 'declining_balance'::character varying, 'units_of_production'::character varying])::"text"[]))),
    CONSTRAINT "asset_categories_org_required_going_forward" CHECK (("organization_id" IS NOT NULL))
);


ALTER TABLE "finance"."asset_categories" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "finance"."asset_verification_lines" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "verification_id" "uuid" NOT NULL,
    "asset_id" "uuid" NOT NULL,
    "physical_location" character varying(200),
    "physical_condition" character varying(100),
    "is_verified" boolean DEFAULT false NOT NULL,
    "discrepancy_notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "finance"."asset_verification_lines" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "finance"."asset_verifications" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "verification_code" character varying(50) NOT NULL,
    "verification_date" "date" NOT NULL,
    "verified_by" "uuid" NOT NULL,
    "notes" "text",
    "status" character varying(30) DEFAULT 'in_progress'::character varying NOT NULL,
    "created_by" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "organization_id" "uuid",
    CONSTRAINT "asset_verifications_org_required_going_forward" CHECK (("organization_id" IS NOT NULL)),
    CONSTRAINT "asset_verifications_status_check" CHECK ((("status")::"text" = ANY ((ARRAY['in_progress'::character varying, 'completed'::character varying, 'discrepancy_found'::character varying])::"text"[])))
);


ALTER TABLE "finance"."asset_verifications" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "finance"."attachments" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "entity_type" "text" NOT NULL,
    "entity_id" "uuid" NOT NULL,
    "file_name" "text" NOT NULL,
    "file_type" "text" NOT NULL,
    "file_size" bigint DEFAULT 0 NOT NULL,
    "storage_path" "text" NOT NULL,
    "file_hash" "text",
    "mime_type" "text",
    "description" "text",
    "uploaded_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "organization_id" "uuid",
    CONSTRAINT "attachments_org_required_going_forward" CHECK (("organization_id" IS NOT NULL))
);


ALTER TABLE "finance"."attachments" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "finance"."attendance_period_snapshots" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "shared_person_id" "uuid" NOT NULL,
    "period_start" "date" NOT NULL,
    "period_end" "date" NOT NULL,
    "source_event_id" "uuid",
    "snapshot_payload" "jsonb" NOT NULL,
    "payload_hash" "text" NOT NULL,
    "locked" boolean DEFAULT true NOT NULL,
    "received_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "attendance_snapshot_period_valid" CHECK (("period_end" >= "period_start"))
);


ALTER TABLE "finance"."attendance_period_snapshots" OWNER TO "postgres";


COMMENT ON TABLE "finance"."attendance_period_snapshots" IS 'Immutable, versioned attendance/payroll-input snapshot consumed by payroll calculation. Once locked=true, snapshot_payload must never be edited -- payroll runs must reference this row, not live attendance data. Added migration 021 (audit issue H6 / Appendix D).';



CREATE TABLE IF NOT EXISTS "finance"."bank_statements" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "financial_account_id" "uuid" NOT NULL,
    "statement_date" "date" NOT NULL,
    "opening_balance" numeric(18,2) NOT NULL,
    "closing_balance" numeric(18,2) NOT NULL,
    "currency" "text" DEFAULT 'PKR'::"text" NOT NULL,
    "total_debits" numeric(18,2) DEFAULT 0,
    "total_credits" numeric(18,2) DEFAULT 0,
    "line_count" integer DEFAULT 0,
    "imported_at" timestamp with time zone DEFAULT "now"(),
    "imported_by" "uuid" NOT NULL,
    "file_name" "text",
    "reconciliation_status" "text" DEFAULT 'PENDING'::"text" NOT NULL,
    "reconciled_at" timestamp with time zone,
    "reconciled_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "organization_id" "uuid",
    CONSTRAINT "bank_statements_org_required_going_forward" CHECK (("organization_id" IS NOT NULL)),
    CONSTRAINT "bank_statements_reconciliation_status_check" CHECK (("reconciliation_status" = ANY (ARRAY['PENDING'::"text", 'IN_PROGRESS'::"text", 'COMPLETED'::"text", 'PARTIAL'::"text"])))
);


ALTER TABLE "finance"."bank_statements" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "finance"."bank_transfers" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "transfer_number" "text",
    "description" "text",
    "from_account_id" "uuid" NOT NULL,
    "from_currency" "text" DEFAULT 'PKR'::"text" NOT NULL,
    "from_amount" numeric(18,2) NOT NULL,
    "to_account_id" "uuid" NOT NULL,
    "to_currency" "text" DEFAULT 'PKR'::"text" NOT NULL,
    "to_amount" numeric(18,2) NOT NULL,
    "exchange_rate" numeric(18,6) DEFAULT 1.000000 NOT NULL,
    "fx_rate_date" "date",
    "transfer_date" "date" DEFAULT CURRENT_DATE NOT NULL,
    "status" "text" DEFAULT 'DRAFT'::"text" NOT NULL,
    "requires_dual_approval" boolean DEFAULT false,
    "approved_by" "uuid",
    "approved_at" timestamp with time zone,
    "second_approved_by" "uuid",
    "second_approved_at" timestamp with time zone,
    "rejected_by" "uuid",
    "rejected_at" timestamp with time zone,
    "rejection_reason" "text",
    "journal_entry_id" "uuid",
    "period_id" "uuid",
    "posted_by" "uuid",
    "posted_at" timestamp with time zone,
    "reversal_reason" "text",
    "reversed_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "created_by" "uuid",
    "organization_id" "uuid",
    CONSTRAINT "bank_transfers_exchange_rate_check" CHECK (("exchange_rate" > (0)::numeric)),
    CONSTRAINT "bank_transfers_from_amount_check" CHECK (("from_amount" > (0)::numeric)),
    CONSTRAINT "bank_transfers_org_required_going_forward" CHECK (("organization_id" IS NOT NULL)),
    CONSTRAINT "bank_transfers_status_check" CHECK (("status" = ANY (ARRAY['DRAFT'::"text", 'SUBMITTED'::"text", 'APPROVED'::"text", 'POSTED'::"text", 'REVERSED'::"text", 'REJECTED'::"text", 'CANCELLED'::"text"]))),
    CONSTRAINT "bank_transfers_to_amount_check" CHECK (("to_amount" > (0)::numeric)),
    CONSTRAINT "chk_diff_accounts" CHECK (("from_account_id" <> "to_account_id"))
);


ALTER TABLE "finance"."bank_transfers" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "finance"."budget_commitments" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "budget_line_id" "uuid" NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "source_type" "text" NOT NULL,
    "source_reference" "text",
    "amount" numeric(18,2) NOT NULL,
    "base_amount" numeric(18,2) NOT NULL,
    "status" "text" DEFAULT 'OPEN'::"text" NOT NULL,
    "description" "text",
    "created_by" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "released_by" "uuid",
    "released_at" timestamp with time zone,
    "release_reason" "text",
    "updated_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "budget_commitments_amount_check" CHECK (("amount" > (0)::numeric)),
    CONSTRAINT "budget_commitments_release_requires_reason" CHECK ((("status" = 'OPEN'::"text") OR ("release_reason" IS NOT NULL))),
    CONSTRAINT "budget_commitments_source_type_check" CHECK (("source_type" = ANY (ARRAY['PURCHASE_REQUEST'::"text", 'VENDOR_BILL'::"text", 'MANUAL'::"text"]))),
    CONSTRAINT "budget_commitments_status_check" CHECK (("status" = ANY (ARRAY['OPEN'::"text", 'RELEASED'::"text", 'CANCELLED'::"text"])))
);


ALTER TABLE "finance"."budget_commitments" OWNER TO "postgres";


COMMENT ON TABLE "finance"."budget_commitments" IS 'Encumbrance ledger giving the "Committed" figure required by spec §5.4/§2.1/§13.2 a real database source. budget_lines.committed_amount is a trigger-maintained sum of OPEN rows here, kept in sync automatically. Added in Migration 036.';



CREATE TABLE IF NOT EXISTS "finance"."budget_lines" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "budget_id" "uuid" NOT NULL,
    "account_id" "uuid" NOT NULL,
    "period_id" "uuid",
    "budgeted_amount" numeric(18,2) DEFAULT 0 NOT NULL,
    "description" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "organization_id" "uuid",
    "committed_amount" numeric(18,2) DEFAULT 0 NOT NULL,
    CONSTRAINT "budget_lines_org_required_going_forward" CHECK (("organization_id" IS NOT NULL))
);


ALTER TABLE "finance"."budget_lines" OWNER TO "postgres";


COMMENT ON TABLE "finance"."budget_lines" IS 'Budget line items. NOTE: public.budget_lines is a separate, independently-writable table referencing the same public.budgets parent. See Migration 023 / compliance audit Section 3.2 for the required consolidation decision.';



CREATE TABLE IF NOT EXISTS "finance"."budget_revisions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "budget_id" "uuid" NOT NULL,
    "revision_number" integer NOT NULL,
    "previous_amount" numeric(18,2) NOT NULL,
    "revised_amount" numeric(18,2) NOT NULL,
    "change_amount" numeric(18,2) GENERATED ALWAYS AS (("revised_amount" - "previous_amount")) STORED,
    "reason" "text" NOT NULL,
    "requested_by" "uuid" NOT NULL,
    "approved_by" "uuid",
    "approved_at" timestamp with time zone,
    "status" "text" DEFAULT 'PENDING'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "organization_id" "uuid",
    CONSTRAINT "budget_revisions_org_required_going_forward" CHECK (("organization_id" IS NOT NULL)),
    CONSTRAINT "budget_revisions_reason_not_blank" CHECK (("btrim"("reason") <> ''::"text")),
    CONSTRAINT "budget_revisions_status_check" CHECK (("status" = ANY (ARRAY['PENDING'::"text", 'APPROVED'::"text", 'REJECTED'::"text"])))
);


ALTER TABLE "finance"."budget_revisions" OWNER TO "postgres";


COMMENT ON TABLE "finance"."budget_revisions" IS 'Budget revision history with reasons and approvals. Added migration 021 (audit issue H5).';



CREATE TABLE IF NOT EXISTS "finance"."capital_transactions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "owner_id" "uuid" NOT NULL,
    "transaction_type" "text" NOT NULL,
    "amount" numeric(18,2) NOT NULL,
    "currency" "text" DEFAULT 'PKR'::"text" NOT NULL,
    "base_amount" numeric(18,2),
    "transaction_date" "date" NOT NULL,
    "description" "text",
    "financial_account_id" "uuid",
    "journal_entry_id" "uuid",
    "status" "text" DEFAULT 'DRAFT'::"text" NOT NULL,
    "declared_by" "uuid",
    "declared_at" timestamp with time zone,
    "approved_by" "uuid",
    "approved_at" timestamp with time zone,
    "posted_by" "uuid",
    "posted_at" timestamp with time zone,
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "created_by" "uuid",
    "organization_id" "uuid",
    CONSTRAINT "capital_transactions_amount_check" CHECK (("amount" > (0)::numeric)),
    CONSTRAINT "capital_transactions_org_required_going_forward" CHECK (("organization_id" IS NOT NULL)),
    CONSTRAINT "capital_transactions_status_check" CHECK (("status" = ANY (ARRAY['DRAFT'::"text", 'APPROVED'::"text", 'POSTED'::"text", 'CANCELLED'::"text"]))),
    CONSTRAINT "capital_transactions_type_check" CHECK (("transaction_type" = ANY (ARRAY['CAPITAL_CONTRIBUTION'::"text", 'OWNER_LOAN_ADVANCE'::"text", 'OWNER_LOAN_REPAYMENT'::"text", 'DRAWING'::"text"])))
);


ALTER TABLE "finance"."capital_transactions" OWNER TO "postgres";


COMMENT ON TABLE "finance"."capital_transactions" IS 'Owner capital contributions, loan advances/repayments, and drawings. Spec Section 5.13/2.1. journal_entry_id links to the authoritative GL posting once posted -- this table is the structured entry point, not a parallel balance. See Migration 024.';



CREATE OR REPLACE VIEW "finance"."coa_tree" WITH ("security_invoker"='true') AS
 WITH RECURSIVE "coa_hierarchy" AS (
         SELECT ("chart_of_accounts"."id")::"text" AS "id",
            "chart_of_accounts"."code",
            "chart_of_accounts"."name",
            ("chart_of_accounts"."parent_id")::"text" AS "parent_id",
            "chart_of_accounts"."account_type",
            "chart_of_accounts"."normal_balance",
            "chart_of_accounts"."is_active",
            "chart_of_accounts"."posting_allowed",
            "chart_of_accounts"."is_control_account",
            "chart_of_accounts"."report_mapping",
            "chart_of_accounts"."level",
            "chart_of_accounts"."display_order",
            ARRAY[("chart_of_accounts"."id")::"text"] AS "path_ids",
            ARRAY["chart_of_accounts"."code"] AS "path_codes",
            0 AS "depth"
           FROM "finance"."chart_of_accounts"
          WHERE ("chart_of_accounts"."parent_id" IS NULL)
        UNION ALL
         SELECT ("c"."id")::"text" AS "id",
            "c"."code",
            "c"."name",
            ("c"."parent_id")::"text" AS "parent_id",
            "c"."account_type",
            "c"."normal_balance",
            "c"."is_active",
            "c"."posting_allowed",
            "c"."is_control_account",
            "c"."report_mapping",
            "c"."level",
            "c"."display_order",
            ("ch"."path_ids" || ("c"."id")::"text"),
            ("ch"."path_codes" || "c"."code"),
            ("ch"."depth" + 1) AS "int4"
           FROM ("finance"."chart_of_accounts" "c"
             JOIN "coa_hierarchy" "ch" ON ((("c"."parent_id")::"text" = "ch"."id")))
        )
 SELECT "id",
    "code",
    "name",
    "parent_id",
    "account_type",
    "normal_balance",
    "is_active",
    "posting_allowed",
    "is_control_account",
    "report_mapping",
    "level",
    "display_order",
    "path_ids",
    "path_codes",
    "depth"
   FROM "coa_hierarchy"
  ORDER BY "path_codes";


ALTER VIEW "finance"."coa_tree" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "finance"."credit_notes" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "credit_note_number" "text",
    "invoice_id" "uuid",
    "reason" "text" NOT NULL,
    "amount" numeric(18,2) NOT NULL,
    "currency" "text" DEFAULT 'PKR'::"text" NOT NULL,
    "exchange_rate" numeric(18,4) DEFAULT 1,
    "base_amount" numeric(18,2) NOT NULL,
    "status" "text" DEFAULT 'DRAFT'::"text" NOT NULL,
    "journal_entry_id" "uuid",
    "period_id" "uuid",
    "created_by" "uuid" NOT NULL,
    "approved_by" "uuid",
    "approved_at" timestamp with time zone,
    "posted_by" "uuid",
    "posted_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "organization_id" "uuid",
    "vendor_bill_id" "uuid",
    "credit_note_type" "text" GENERATED ALWAYS AS (
CASE
    WHEN ("invoice_id" IS NOT NULL) THEN 'AR'::"text"
    ELSE 'AP'::"text"
END) STORED,
    CONSTRAINT "credit_notes_amount_check" CHECK (("amount" > (0)::numeric)),
    CONSTRAINT "credit_notes_exactly_one_source" CHECK (((("invoice_id" IS NOT NULL) AND ("vendor_bill_id" IS NULL)) OR (("invoice_id" IS NULL) AND ("vendor_bill_id" IS NOT NULL)))),
    CONSTRAINT "credit_notes_org_required_going_forward" CHECK (("organization_id" IS NOT NULL)),
    CONSTRAINT "credit_notes_status_check" CHECK (("status" = ANY (ARRAY['DRAFT'::"text", 'APPROVED'::"text", 'POSTED'::"text", 'REVERSED'::"text"])))
);


ALTER TABLE "finance"."credit_notes" OWNER TO "postgres";


COMMENT ON TABLE "finance"."credit_notes" IS 'Credit notes against either a client invoice (AR, invoice_id set) or a vendor bill (AP, vendor_bill_id set) -- see credit_notes_exactly_one_source. Extended for AP support in Migration 035 (spec §5.7 / §2.1 / §12.3).';



CREATE TABLE IF NOT EXISTS "finance"."currency_settings" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "currency" "text" NOT NULL,
    "enabled" boolean DEFAULT true NOT NULL,
    "decimals" smallint DEFAULT 2 NOT NULL,
    "rounding_method" "text" DEFAULT 'HALF_UP'::"text" NOT NULL,
    "rounding_account_id" "uuid",
    "tolerance" numeric(18,6) DEFAULT 0 NOT NULL,
    "display_format" "text",
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "currency_settings_currency_check" CHECK (("currency" ~ '^[A-Z]{3}$'::"text")),
    CONSTRAINT "currency_settings_decimals_check" CHECK ((("decimals" >= 0) AND ("decimals" <= 6))),
    CONSTRAINT "currency_settings_rounding_method_check" CHECK (("rounding_method" = ANY (ARRAY['HALF_UP'::"text", 'HALF_EVEN'::"text", 'DOWN'::"text", 'UP'::"text", 'FLOOR'::"text", 'CEILING'::"text"]))),
    CONSTRAINT "currency_settings_tolerance_check" CHECK (("tolerance" >= (0)::numeric))
);

ALTER TABLE ONLY "finance"."currency_settings" FORCE ROW LEVEL SECURITY;


ALTER TABLE "finance"."currency_settings" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "finance"."depreciation_schedule" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "asset_id" "uuid" NOT NULL,
    "period_id" "uuid" NOT NULL,
    "fiscal_year_id" "uuid" NOT NULL,
    "opening_nbv" numeric(18,2) NOT NULL,
    "depreciation_amount" numeric(18,2) DEFAULT 0 NOT NULL,
    "closing_nbv" numeric(18,2) NOT NULL,
    "method" character varying(50) DEFAULT 'straight_line'::character varying NOT NULL,
    "rate" numeric(8,4) DEFAULT 0 NOT NULL,
    "days_in_period" integer DEFAULT 30 NOT NULL,
    "journal_entry_id" "uuid",
    "status" character varying(30) DEFAULT 'calculated'::character varying NOT NULL,
    "calculated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "posted_at" timestamp with time zone,
    "created_by" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "depreciation_schedule_status_check" CHECK ((("status")::"text" = ANY ((ARRAY['calculated'::character varying, 'posted'::character varying, 'reversed'::character varying, 'skipped'::character varying])::"text"[])))
);


ALTER TABLE "finance"."depreciation_schedule" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "finance"."dimensions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "type" "text" NOT NULL,
    "code" "text" NOT NULL,
    "name" "text" NOT NULL,
    "parent_id" "uuid",
    "manager_user_id" "uuid",
    "is_active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "created_by" "uuid",
    CONSTRAINT "dimensions_type_check" CHECK (("type" = ANY (ARRAY['DEPARTMENT'::"text", 'COST_CENTER'::"text", 'BUSINESS_UNIT'::"text"])))
);


ALTER TABLE "finance"."dimensions" OWNER TO "postgres";


COMMENT ON TABLE "finance"."dimensions" IS 'Departments / cost centers / business units transactions can be tagged against. Added migration 021 (audit issue H4).';



CREATE TABLE IF NOT EXISTS "finance"."distribution_lines" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "profit_distribution_id" "uuid" NOT NULL,
    "owner_id" "uuid" NOT NULL,
    "ownership_percentage" numeric(5,2) DEFAULT 0 NOT NULL,
    "calculated_amount" numeric(18,2) DEFAULT 0 NOT NULL,
    "overridden_amount" numeric(18,2),
    "final_amount" numeric(18,2) DEFAULT 0 NOT NULL,
    "payment_status" "text" DEFAULT 'PENDING'::"text" NOT NULL,
    "paid_amount" numeric(18,2) DEFAULT 0 NOT NULL,
    "paid_date" "date",
    "payment_reference" "text",
    "payment_account_id" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "distribution_lines_payment_status_check" CHECK (("payment_status" = ANY (ARRAY['PENDING'::"text", 'PAID'::"text", 'CANCELLED'::"text"])))
);


ALTER TABLE "finance"."distribution_lines" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "finance"."exchange_rates" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "from_currency" "text" NOT NULL,
    "to_currency" "text" NOT NULL,
    "rate" numeric(18,6) NOT NULL,
    "rate_date" "date" NOT NULL,
    "rate_time" time without time zone,
    "rate_type" "text" NOT NULL,
    "source_platform" "text",
    "entered_by" "uuid" NOT NULL,
    "approved_by" "uuid",
    "approved_at" timestamp with time zone,
    "is_locked" boolean DEFAULT false,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "created_by" "uuid",
    "organization_id" "uuid" NOT NULL,
    CONSTRAINT "exchange_rates_rate_positive_check" CHECK (("rate" > (0)::numeric)),
    CONSTRAINT "exchange_rates_rate_type_check" CHECK (("rate_type" = ANY (ARRAY['PLATFORM'::"text", 'BANK'::"text", 'MANUAL'::"text", 'PAYMENT_CHANNEL'::"text"])))
);


ALTER TABLE "finance"."exchange_rates" OWNER TO "postgres";


COMMENT ON COLUMN "finance"."exchange_rates"."organization_id" IS 'Migration 040: now NOT NULL. Every manual exchange rate must belong to exactly one organization; a NULL value previously made the row invisible to the tenant boundary entirely (it satisfied neither side of core.same_org(), which fails closed, but also was never actually checked by the old fx_select/fx_insert policies).';



CREATE TABLE IF NOT EXISTS "finance"."expense_lines" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "expense_id" "uuid" NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "line_number" integer NOT NULL,
    "description" "text" NOT NULL,
    "quantity" numeric(18,4) DEFAULT 1 NOT NULL,
    "unit_price" numeric(18,2) DEFAULT 0 NOT NULL,
    "amount" numeric(18,2) DEFAULT 0 NOT NULL,
    "currency" "text" DEFAULT 'PKR'::"text" NOT NULL,
    "exchange_rate" numeric(18,6) DEFAULT 1 NOT NULL,
    "base_amount" numeric(18,2) DEFAULT 0 NOT NULL,
    "account_id" "uuid",
    "project_id" "uuid",
    "department_id" "uuid",
    "cost_center_id" "uuid",
    "tax_code_id" "uuid",
    "tax_rate" numeric(8,4) DEFAULT 0 NOT NULL,
    "tax_amount" numeric(18,2) DEFAULT 0 NOT NULL,
    "vendor_id" "uuid",
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "expense_lines_amounts_check" CHECK ((("unit_price" >= (0)::numeric) AND ("amount" >= (0)::numeric) AND ("exchange_rate" > (0)::numeric) AND ("base_amount" >= (0)::numeric) AND ("tax_rate" >= (0)::numeric) AND ("tax_amount" >= (0)::numeric))),
    CONSTRAINT "expense_lines_currency_check" CHECK (("currency" ~ '^[A-Z]{3}$'::"text")),
    CONSTRAINT "expense_lines_number_check" CHECK (("line_number" > 0)),
    CONSTRAINT "expense_lines_quantity_check" CHECK (("quantity" > (0)::numeric))
);

ALTER TABLE ONLY "finance"."expense_lines" FORCE ROW LEVEL SECURITY;


ALTER TABLE "finance"."expense_lines" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "finance"."fee_computation_log" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "source_type" character varying(50),
    "source_id" "uuid",
    "platform_id" "uuid",
    "fee_rule_id" "uuid",
    "base_amount" numeric(18,4) DEFAULT 0 NOT NULL,
    "fee_amount" numeric(18,4) DEFAULT 0 NOT NULL,
    "computed_by" "uuid",
    "computed_at" timestamp with time zone DEFAULT "now"(),
    "details" "jsonb" DEFAULT '{}'::"jsonb",
    "organization_id" "uuid",
    CONSTRAINT "fee_computation_log_org_required_going_forward" CHECK (("organization_id" IS NOT NULL))
);


ALTER TABLE "finance"."fee_computation_log" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "finance"."fee_rules" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "platform_id" "uuid" NOT NULL,
    "name" character varying(200) NOT NULL,
    "fee_type" character varying(30) DEFAULT 'PERCENTAGE'::character varying NOT NULL,
    "fee_value" numeric(18,4) DEFAULT 0 NOT NULL,
    "min_fee" numeric(18,4) DEFAULT 0,
    "max_fee" numeric(18,4) DEFAULT 0,
    "applies_to" character varying(50) DEFAULT 'EXPENSE'::character varying NOT NULL,
    "is_active" boolean DEFAULT true,
    "effective_from" "date" DEFAULT CURRENT_DATE,
    "effective_to" "date",
    "priority" integer DEFAULT 0,
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "organization_id" "uuid",
    CONSTRAINT "fee_rules_applies_to_check" CHECK ((("applies_to")::"text" = ANY ((ARRAY['EXPENSE'::character varying, 'INVOICE'::character varying, 'VENDOR_BILL'::character varying, 'PAYMENT_RECEIPT'::character varying, 'ALL'::character varying])::"text"[]))),
    CONSTRAINT "fee_rules_fee_type_check" CHECK ((("fee_type")::"text" = ANY ((ARRAY['PERCENTAGE'::character varying, 'FIXED'::character varying, 'TIERED'::character varying, 'SLAB'::character varying])::"text"[]))),
    CONSTRAINT "fee_rules_org_required_going_forward" CHECK (("organization_id" IS NOT NULL))
);


ALTER TABLE "finance"."fee_rules" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "finance"."fee_tiers" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "fee_rule_id" "uuid" NOT NULL,
    "tier_from" numeric(18,4) DEFAULT 0 NOT NULL,
    "tier_to" numeric(18,4) DEFAULT 0 NOT NULL,
    "fee_percent" numeric(8,4) DEFAULT 0 NOT NULL,
    "fee_fixed" numeric(18,4) DEFAULT 0 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "finance"."fee_tiers" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "finance"."financial_accounts" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "account_name" "text" NOT NULL,
    "institution_name" "text" NOT NULL,
    "institution_type" "text" NOT NULL,
    "account_type" "text" NOT NULL,
    "currency" "text" DEFAULT 'PKR'::"text" NOT NULL,
    "masked_identifier" "text",
    "opening_balance" numeric(18,2) DEFAULT 0 NOT NULL,
    "opening_date" "date",
    "linked_ledger_account_id" "uuid" NOT NULL,
    "reconciliation_method" "text" DEFAULT 'MANUAL'::"text" NOT NULL,
    "responsible_user_id" "uuid",
    "is_active" boolean DEFAULT true NOT NULL,
    "is_default" boolean DEFAULT false NOT NULL,
    "requires_dual_approval" boolean DEFAULT false,
    "min_dual_approval_amount" numeric(18,2),
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "created_by" "uuid",
    "deleted_at" timestamp with time zone,
    "deleted_by" "uuid",
    "organization_id" "uuid" NOT NULL,
    CONSTRAINT "financial_accounts_account_type_check" CHECK (("account_type" = ANY (ARRAY['CURRENT'::"text", 'SAVINGS'::"text", 'DIGITAL_WALLET'::"text", 'PLATFORM_BALANCE'::"text", 'PETTY_CASH'::"text", 'CLEARING'::"text"]))),
    CONSTRAINT "financial_accounts_institution_type_check" CHECK (("institution_type" = ANY (ARRAY['BANK'::"text", 'CASH'::"text", 'WALLET'::"text", 'PLATFORM'::"text", 'PAYMENT_GATEWAY'::"text", 'CARD'::"text", 'CLEARING'::"text"]))),
    CONSTRAINT "financial_accounts_reconciliation_method_check" CHECK (("reconciliation_method" = ANY (ARRAY['MANUAL'::"text", 'AUTO'::"text", 'IMPORT'::"text"])))
);


ALTER TABLE "finance"."financial_accounts" OWNER TO "postgres";


COMMENT ON TABLE "finance"."financial_accounts" IS 'Canonical (spec-aligned) financial accounts table -- has ledger mapping, reconciliation method, dual-approval fields. NOTE: public.financial_accounts is a separate, independently-writable legacy table covering the same entity. See Migration 023 / compliance audit Section 3.2 for the required consolidation decision before further schema changes.';



CREATE TABLE IF NOT EXISTS "finance"."fiscal_years" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "created_by" "uuid",
    "name" "text" NOT NULL,
    "start_date" "date" NOT NULL,
    "end_date" "date" NOT NULL,
    "status" "text" DEFAULT 'OPEN'::"text" NOT NULL,
    "description" "text",
    "closed_by" "uuid",
    "closed_at" timestamp with time zone,
    "reopening_reason" "text",
    "is_transition_year" boolean DEFAULT false NOT NULL,
    "transition_approved_by" "uuid",
    "transition_approved_at" timestamp with time zone,
    "organization_id" "uuid",
    CONSTRAINT "fiscal_years_org_required_going_forward" CHECK (("organization_id" IS NOT NULL)),
    CONSTRAINT "fiscal_years_status_check" CHECK (("status" = ANY (ARRAY['OPEN'::"text", 'SOFT_CLOSED'::"text", 'HARD_CLOSED'::"text"]))),
    CONSTRAINT "fy_dates_valid" CHECK (("end_date" > "start_date")),
    CONSTRAINT "fy_name_not_empty" CHECK ((TRIM(BOTH FROM "name") <> ''::"text")),
    CONSTRAINT "fy_reopening_requires_reason" CHECK (((("status" <> 'OPEN'::"text") AND ("reopening_reason" IS NOT NULL)) OR ("status" = 'OPEN'::"text"))),
    CONSTRAINT "fy_transition_requires_approval" CHECK ((("is_transition_year" = false) OR (("transition_approved_by" IS NOT NULL) AND ("transition_approved_at" IS NOT NULL))))
);


ALTER TABLE "finance"."fiscal_years" OWNER TO "postgres";


COMMENT ON COLUMN "finance"."fiscal_years"."is_transition_year" IS 'True for an explicitly approved one-time non-12-month fiscal year (e.g. the 1 Jun - 30 Jun thirteen-month transition described in spec Section 4.3). Auto-backfilled for existing non-12-month rows; requires transition_approved_by/at going forward. See Migration 020 / compliance audit Section M-3.';



CREATE OR REPLACE VIEW "finance"."fiscal_year_summary" WITH ("security_invoker"='true') AS
 SELECT "fy"."id",
    "fy"."name",
    "fy"."start_date",
    "fy"."end_date",
    "fy"."status",
    "fy"."description",
    "fy"."closed_at",
    "fy"."created_at",
    "fy"."updated_at",
    "fy"."created_by",
    "fy"."closed_by",
    "fy"."reopening_reason",
    "count"("ap"."id") AS "total_periods",
    "count"("ap"."id") FILTER (WHERE ("ap"."status" = 'PENDING'::"text")) AS "pending_periods",
    "count"("ap"."id") FILTER (WHERE ("ap"."status" = 'OPEN'::"text")) AS "open_periods",
    "count"("ap"."id") FILTER (WHERE ("ap"."status" = 'SOFT_CLOSED'::"text")) AS "soft_closed_periods",
    "count"("ap"."id") FILTER (WHERE ("ap"."status" = 'HARD_CLOSED'::"text")) AS "hard_closed_periods"
   FROM ("finance"."fiscal_years" "fy"
     LEFT JOIN "finance"."accounting_periods" "ap" ON (("ap"."fiscal_year_id" = "fy"."id")))
  GROUP BY "fy"."id", "fy"."name", "fy"."start_date", "fy"."end_date", "fy"."status", "fy"."description", "fy"."closed_at", "fy"."created_at", "fy"."updated_at", "fy"."created_by", "fy"."closed_by", "fy"."reopening_reason"
  ORDER BY "fy"."start_date" DESC;


ALTER VIEW "finance"."fiscal_year_summary" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "finance"."fixed_assets" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "code" character varying(50) NOT NULL,
    "name" character varying(300) NOT NULL,
    "category_id" "uuid" NOT NULL,
    "description" "text",
    "vendor_id" "uuid",
    "purchase_date" "date" NOT NULL,
    "purchase_cost" numeric(18,2) NOT NULL,
    "currency" "text" DEFAULT 'PKR'::"text" NOT NULL,
    "base_cost" numeric(18,2) NOT NULL,
    "exchange_rate_id" "uuid",
    "serial_number" character varying(200),
    "warranty_start" "date",
    "warranty_end" "date",
    "location" character varying(200),
    "assigned_user_id" "uuid",
    "useful_life_months" integer,
    "residual_value_pct" numeric(5,2),
    "depreciation_method" character varying(50),
    "residual_value_amount" numeric(18,2),
    "accumulated_depreciation" numeric(18,2) DEFAULT 0 NOT NULL,
    "net_book_value" numeric(18,2) DEFAULT 0 NOT NULL,
    "linked_asset_account_id" "uuid",
    "linked_depreciation_account_id" "uuid",
    "linked_expense_account_id" "uuid",
    "project_id" "uuid",
    "department_id" "uuid",
    "cost_center_id" "uuid",
    "status" character varying(50) DEFAULT 'pending_capitalization'::character varying NOT NULL,
    "disposal_date" "date",
    "disposal_value" numeric(18,2),
    "disposal_currency" "text",
    "disposal_method" character varying(100),
    "gain_loss_amount" numeric(18,2),
    "disposal_journal_id" "uuid",
    "approved_by" "uuid",
    "approved_at" timestamp with time zone,
    "created_by" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "organization_id" "uuid",
    CONSTRAINT "fixed_assets_base_cost_check" CHECK (("base_cost" >= (0)::numeric)),
    CONSTRAINT "fixed_assets_depreciation_method_check" CHECK ((("depreciation_method" IS NULL) OR (("depreciation_method")::"text" = ANY ((ARRAY['straight_line'::character varying, 'declining_balance'::character varying, 'units_of_production'::character varying])::"text"[])))),
    CONSTRAINT "fixed_assets_org_required_going_forward" CHECK (("organization_id" IS NOT NULL)),
    CONSTRAINT "fixed_assets_purchase_cost_check" CHECK (("purchase_cost" >= (0)::numeric)),
    CONSTRAINT "fixed_assets_status_check" CHECK ((("status")::"text" = ANY ((ARRAY['pending_capitalization'::character varying, 'active'::character varying, 'fully_depreciated'::character varying, 'under_repair'::character varying, 'disposed'::character varying, 'sold'::character varying])::"text"[])))
);


ALTER TABLE "finance"."fixed_assets" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "finance"."invoice_lines" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "invoice_id" "uuid" NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "line_number" integer NOT NULL,
    "description" "text" NOT NULL,
    "quantity" numeric(18,4) DEFAULT 1 NOT NULL,
    "unit_price" numeric(18,2) DEFAULT 0 NOT NULL,
    "line_subtotal" numeric(18,2) DEFAULT 0 NOT NULL,
    "discount_amount" numeric(18,2) DEFAULT 0 NOT NULL,
    "tax_code_id" "uuid",
    "tax_rate" numeric(8,4) DEFAULT 0 NOT NULL,
    "tax_amount" numeric(18,2) DEFAULT 0 NOT NULL,
    "line_total" numeric(18,2) DEFAULT 0 NOT NULL,
    "base_line_subtotal" numeric(18,2) DEFAULT 0 NOT NULL,
    "base_tax_amount" numeric(18,2) DEFAULT 0 NOT NULL,
    "base_line_total" numeric(18,2) DEFAULT 0 NOT NULL,
    "account_id" "uuid",
    "project_id" "uuid",
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "invoice_lines_amounts_check" CHECK ((("unit_price" >= (0)::numeric) AND ("line_subtotal" >= (0)::numeric) AND ("discount_amount" >= (0)::numeric) AND ("tax_rate" >= (0)::numeric) AND ("tax_amount" >= (0)::numeric) AND ("line_total" >= (0)::numeric) AND ("base_line_subtotal" >= (0)::numeric) AND ("base_tax_amount" >= (0)::numeric) AND ("base_line_total" >= (0)::numeric))),
    CONSTRAINT "invoice_lines_number_check" CHECK (("line_number" > 0)),
    CONSTRAINT "invoice_lines_quantity_check" CHECK (("quantity" > (0)::numeric))
);

ALTER TABLE ONLY "finance"."invoice_lines" FORCE ROW LEVEL SECURITY;


ALTER TABLE "finance"."invoice_lines" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "finance"."journal_entries" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "created_by" "uuid" NOT NULL,
    "reference" "text" NOT NULL,
    "description" "text" NOT NULL,
    "status" "text" DEFAULT 'DRAFT'::"text" NOT NULL,
    "transaction_date" "date" NOT NULL,
    "posting_date" "date",
    "period_id" "uuid" NOT NULL,
    "fiscal_year_id" "uuid" NOT NULL,
    "currency" "text" DEFAULT 'PKR'::"text" NOT NULL,
    "exchange_rate" numeric(18,4) DEFAULT 1.0000,
    "base_currency" "text" DEFAULT 'PKR'::"text" NOT NULL,
    "total_debit" numeric(18,2) DEFAULT 0 NOT NULL,
    "total_credit" numeric(18,2) DEFAULT 0 NOT NULL,
    "source_type" "text",
    "source_id" "uuid",
    "project_id" "uuid",
    "department_id" "uuid",
    "cost_center_id" "uuid",
    "attachment_ids" "uuid"[],
    "notes" "text",
    "rejection_reason" "text",
    "reversal_of_id" "uuid",
    "reversal_reason" "text",
    "submitted_by" "uuid",
    "submitted_at" timestamp with time zone,
    "verified_by" "uuid",
    "verified_at" timestamp with time zone,
    "approved_by" "uuid",
    "approved_at" timestamp with time zone,
    "posted_by" "uuid",
    "posted_at" timestamp with time zone,
    "reversed_by" "uuid",
    "reversed_at" timestamp with time zone,
    "entry_date" "date",
    "organization_id" "uuid" NOT NULL,
    CONSTRAINT "je_date_not_null" CHECK (("transaction_date" IS NOT NULL)),
    CONSTRAINT "journal_entries_status_check" CHECK (("status" = ANY (ARRAY['DRAFT'::"text", 'SUBMITTED'::"text", 'VERIFIED'::"text", 'APPROVED'::"text", 'POSTED'::"text", 'REVERSED'::"text", 'REJECTED'::"text", 'CANCELLED'::"text"]))),
    CONSTRAINT "journal_entries_total_credit_check" CHECK (("total_credit" >= (0)::numeric)),
    CONSTRAINT "journal_entries_total_debit_check" CHECK (("total_debit" >= (0)::numeric))
);


ALTER TABLE "finance"."journal_entries" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "finance"."journal_lines" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "created_by" "uuid",
    "journal_entry_id" "uuid" NOT NULL,
    "line_number" integer NOT NULL,
    "account_id" "uuid" NOT NULL,
    "description" "text",
    "debit_amount" numeric(18,2) DEFAULT 0 NOT NULL,
    "credit_amount" numeric(18,2) DEFAULT 0 NOT NULL,
    "currency" "text" DEFAULT 'PKR'::"text" NOT NULL,
    "exchange_rate" numeric(18,4),
    "base_debit" numeric(18,2),
    "base_credit" numeric(18,2),
    "project_id" "uuid",
    "department_id" "uuid",
    "cost_center_id" "uuid",
    "tax_code_id" "uuid",
    "matching_ref" "text",
    CONSTRAINT "jl_one_side_only" CHECK ((("debit_amount" = (0)::numeric) OR ("credit_amount" = (0)::numeric))),
    CONSTRAINT "journal_lines_credit_amount_check" CHECK (("credit_amount" >= (0)::numeric)),
    CONSTRAINT "journal_lines_debit_amount_check" CHECK (("debit_amount" >= (0)::numeric)),
    CONSTRAINT "journal_lines_line_number_check" CHECK (("line_number" > 0))
);


ALTER TABLE "finance"."journal_lines" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "finance"."numbering_sequences" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "created_by" "uuid",
    "sequence_type" "text" NOT NULL,
    "prefix" "text" NOT NULL,
    "current_number" integer DEFAULT 0 NOT NULL,
    "padding" integer DEFAULT 4 NOT NULL,
    "fiscal_year_id" "uuid",
    "reset_per_period" boolean DEFAULT false,
    "format" "text" DEFAULT '{PREFIX}{NUMBER}'::"text" NOT NULL,
    "organization_id" "uuid",
    CONSTRAINT "ns_current_non_negative" CHECK (("current_number" >= 0)),
    CONSTRAINT "ns_format_valid" CHECK ((("format" ~~ '%{PREFIX}%'::"text") AND ("format" ~~ '%{NUMBER}%'::"text"))),
    CONSTRAINT "numbering_sequences_org_required_going_forward" CHECK (("organization_id" IS NOT NULL)),
    CONSTRAINT "numbering_sequences_padding_check" CHECK ((("padding" >= 1) AND ("padding" <= 10)))
);


ALTER TABLE "finance"."numbering_sequences" OWNER TO "postgres";


COMMENT ON TABLE "finance"."numbering_sequences" IS 'Canonical document-numbering table -- used by finance.get_next_number(), which every post_* function calls. public.numbering_sequences is a separate, disconnected numbering authority; do not write to it expecting it to affect finance.* document numbers. See Migration 023.';



CREATE TABLE IF NOT EXISTS "finance"."opening_balance_imports" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "import_batch_id" "text" NOT NULL,
    "account_id" "uuid" NOT NULL,
    "account_code" "text" NOT NULL,
    "account_name" "text" NOT NULL,
    "debit_amount" numeric(18,2) DEFAULT 0,
    "credit_amount" numeric(18,2) DEFAULT 0,
    "currency" "text" DEFAULT 'PKR'::"text" NOT NULL,
    "exchange_rate" numeric(18,6) DEFAULT 1,
    "base_amount" numeric(18,2) DEFAULT 0,
    "fiscal_year_id" "uuid",
    "status" "text" DEFAULT 'PENDING'::"text" NOT NULL,
    "journal_entry_id" "uuid",
    "error_message" "text",
    "imported_by" "uuid" NOT NULL,
    "imported_at" timestamp with time zone DEFAULT "now"(),
    "created_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "opening_balance_imports_status_check" CHECK (("status" = ANY (ARRAY['PENDING'::"text", 'IMPORTED'::"text", 'FAILED'::"text", 'REVERSED'::"text"])))
);


ALTER TABLE "finance"."opening_balance_imports" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "finance"."owners" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "partner_class" "text",
    "status" "text" DEFAULT 'ACTIVE'::"text" NOT NULL,
    "cnic_number" "text",
    "contact_info" "text",
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "created_by" "uuid",
    "organization_id" "uuid",
    CONSTRAINT "owners_org_required_going_forward" CHECK (("organization_id" IS NOT NULL)),
    CONSTRAINT "owners_status_check" CHECK (("status" = ANY (ARRAY['ACTIVE'::"text", 'INACTIVE'::"text", 'EXITED'::"text"])))
);


ALTER TABLE "finance"."owners" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "finance"."ownership_history" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "owner_id" "uuid" NOT NULL,
    "ownership_percentage" numeric(5,2) NOT NULL,
    "effective_from" "date" NOT NULL,
    "effective_to" "date",
    "changed_by" "uuid" NOT NULL,
    "change_reason" "text",
    "approved_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "organization_id" "uuid",
    CONSTRAINT "ownership_history_org_required_going_forward" CHECK (("organization_id" IS NOT NULL)),
    CONSTRAINT "ownership_history_ownership_percentage_check" CHECK ((("ownership_percentage" >= (0)::numeric) AND ("ownership_percentage" <= (100)::numeric)))
);


ALTER TABLE "finance"."ownership_history" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "finance"."payment_allocations" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "payment_receipt_id" "uuid" NOT NULL,
    "invoice_id" "uuid" NOT NULL,
    "allocated_amount" numeric(18,2) NOT NULL,
    "base_allocated_amount" numeric(18,2) NOT NULL,
    "allocated_by" "uuid" NOT NULL,
    "allocated_at" timestamp with time zone DEFAULT "now"(),
    "status" "text" DEFAULT 'ACTIVE'::"text" NOT NULL,
    "reversed_at" timestamp with time zone,
    "reversed_by" "uuid",
    CONSTRAINT "payment_allocations_allocated_amount_check" CHECK (("allocated_amount" > (0)::numeric)),
    CONSTRAINT "payment_allocations_status_check" CHECK (("status" = ANY (ARRAY['ACTIVE'::"text", 'REVERSED'::"text"])))
);


ALTER TABLE "finance"."payment_allocations" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "finance"."payment_receipts" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "receipt_number" "text",
    "payment_date" "date" DEFAULT CURRENT_DATE NOT NULL,
    "amount" numeric(18,2) NOT NULL,
    "currency" "text" DEFAULT 'PKR'::"text" NOT NULL,
    "exchange_rate" numeric(18,4) DEFAULT 1,
    "base_amount" numeric(18,2) NOT NULL,
    "client_id" "uuid" NOT NULL,
    "project_id" "uuid",
    "financial_account_id" "uuid",
    "payment_method" "text" NOT NULL,
    "reference" "text",
    "description" "text",
    "status" "text" DEFAULT 'DRAFT'::"text" NOT NULL,
    "journal_entry_id" "uuid",
    "period_id" "uuid",
    "created_by" "uuid" NOT NULL,
    "approved_by" "uuid",
    "approved_at" timestamp with time zone,
    "posted_by" "uuid",
    "posted_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "organization_id" "uuid",
    CONSTRAINT "payment_receipts_amount_check" CHECK (("amount" >= (0)::numeric)),
    CONSTRAINT "payment_receipts_org_required_going_forward" CHECK (("organization_id" IS NOT NULL)),
    CONSTRAINT "payment_receipts_payment_method_check" CHECK (("payment_method" = ANY (ARRAY['BANK_TRANSFER'::"text", 'PLATFORM'::"text", 'CASH'::"text", 'CHEQUE'::"text", 'OTHER'::"text"]))),
    CONSTRAINT "payment_receipts_status_check" CHECK (("status" = ANY (ARRAY['DRAFT'::"text", 'APPROVED'::"text", 'POSTED'::"text", 'REVERSED'::"text"])))
);


ALTER TABLE "finance"."payment_receipts" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "finance"."platforms" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" character varying(200) NOT NULL,
    "code" character varying(50) NOT NULL,
    "platform_type" character varying(50) DEFAULT 'PAYMENT_GATEWAY'::character varying NOT NULL,
    "description" "text",
    "is_active" boolean DEFAULT true,
    "integration_config" "jsonb" DEFAULT '{}'::"jsonb",
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "deleted_at" timestamp with time zone,
    "deleted_by" "uuid",
    "organization_id" "uuid",
    CONSTRAINT "platforms_org_required_going_forward" CHECK (("organization_id" IS NOT NULL)),
    CONSTRAINT "platforms_platform_type_check" CHECK ((("platform_type")::"text" = ANY ((ARRAY['PAYMENT_GATEWAY'::character varying, 'BANK_TRANSFER'::character varying, 'MARKETPLACE'::character varying, 'WALLET'::character varying, 'OTHER'::character varying])::"text"[])))
);


ALTER TABLE "finance"."platforms" OWNER TO "postgres";


CREATE OR REPLACE VIEW "finance"."postable_accounts" WITH ("security_invoker"='true') AS
 SELECT "id",
    "code",
    "name",
    "account_type",
    "normal_balance",
    "currency",
    "is_control_account",
    "report_mapping"
   FROM "finance"."chart_of_accounts"
  WHERE (("is_active" = true) AND ("posting_allowed" = true) AND ("level" >= 2))
  ORDER BY "code";


ALTER VIEW "finance"."postable_accounts" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "finance"."profit_distributions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "fiscal_year_id" "uuid" NOT NULL,
    "period_id" "uuid",
    "total_available_profit" numeric(18,2) DEFAULT 0 NOT NULL,
    "reserve_amount" numeric(18,2) DEFAULT 0 NOT NULL,
    "distributable_amount" numeric(18,2) DEFAULT 0 NOT NULL,
    "status" "text" DEFAULT 'DRAFT'::"text" NOT NULL,
    "declared_by" "uuid",
    "declared_at" timestamp with time zone,
    "approved_by" "uuid",
    "approved_at" timestamp with time zone,
    "posted_by" "uuid",
    "posted_at" timestamp with time zone,
    "journal_entry_id" "uuid",
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "created_by" "uuid",
    "organization_id" "uuid",
    CONSTRAINT "profit_distributions_org_required_going_forward" CHECK (("organization_id" IS NOT NULL)),
    CONSTRAINT "profit_distributions_status_check" CHECK (("status" = ANY (ARRAY['DRAFT'::"text", 'DECLARED'::"text", 'APPROVED'::"text", 'POSTED'::"text", 'PAID'::"text", 'CANCELLED'::"text"])))
);


ALTER TABLE "finance"."profit_distributions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "finance"."reserve_policies" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "policy_type" "text" NOT NULL,
    "fixed_amount" numeric(18,2) DEFAULT 0 NOT NULL,
    "percentage" numeric(5,2) DEFAULT 0 NOT NULL,
    "target_balance" numeric(18,2) DEFAULT 0 NOT NULL,
    "effective_from" "date" DEFAULT CURRENT_DATE NOT NULL,
    "effective_to" "date",
    "approved_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "created_by" "uuid",
    "organization_id" "uuid",
    CONSTRAINT "reserve_policies_org_required_going_forward" CHECK (("organization_id" IS NOT NULL)),
    CONSTRAINT "reserve_policies_policy_type_check" CHECK (("policy_type" = ANY (ARRAY['DISABLED'::"text", 'FIXED_AMOUNT'::"text", 'PERCENT_OF_PROFIT'::"text", 'PERCENT_OF_PAYOUT'::"text", 'TARGET_BALANCE'::"text", 'HYBRID'::"text"])))
);


ALTER TABLE "finance"."reserve_policies" OWNER TO "postgres";


CREATE OR REPLACE VIEW "finance"."sequence_status" WITH ("security_invoker"='true') AS
 SELECT "id",
    "sequence_type",
    "prefix",
    "current_number",
    "padding",
    "format",
    "finance"."peek_next_number"("sequence_type") AS "next_number_preview"
   FROM "finance"."numbering_sequences" "ns"
  ORDER BY "sequence_type";


ALTER VIEW "finance"."sequence_status" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "finance"."settlement_batches" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "platform_id" "uuid",
    "financial_account_id" "uuid",
    "settlement_reference" "text" NOT NULL,
    "settlement_date" "date" NOT NULL,
    "currency" "text" DEFAULT 'PKR'::"text" NOT NULL,
    "gross_amount" numeric(18,2) DEFAULT 0 NOT NULL,
    "expected_fee_amount" numeric(18,2) DEFAULT 0 NOT NULL,
    "actual_fee_amount" numeric(18,2) DEFAULT 0 NOT NULL,
    "withholding_amount" numeric(18,2) DEFAULT 0 NOT NULL,
    "withdrawal_fee_amount" numeric(18,2) DEFAULT 0 NOT NULL,
    "net_amount" numeric(18,2) DEFAULT 0 NOT NULL,
    "exchange_rate" numeric(18,6),
    "base_net_amount" numeric(18,2),
    "status" "text" DEFAULT 'DRAFT'::"text" NOT NULL,
    "evidence_attachment_id" "uuid",
    "notes" "text",
    "created_by" "uuid",
    "approved_by" "uuid",
    "approved_at" timestamp with time zone,
    "posted_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "settlement_batches_amounts_check" CHECK ((("gross_amount" >= (0)::numeric) AND ("expected_fee_amount" >= (0)::numeric) AND ("actual_fee_amount" >= (0)::numeric) AND ("withholding_amount" >= (0)::numeric) AND ("withdrawal_fee_amount" >= (0)::numeric) AND ("net_amount" >= (0)::numeric))),
    CONSTRAINT "settlement_batches_currency_check" CHECK (("currency" ~ '^[A-Z]{3}$'::"text")),
    CONSTRAINT "settlement_batches_status_check" CHECK (("status" = ANY (ARRAY['DRAFT'::"text", 'SUBMITTED'::"text", 'VERIFIED'::"text", 'APPROVED'::"text", 'POSTED'::"text", 'RECONCILED'::"text", 'REJECTED'::"text", 'REVERSED'::"text"])))
);

ALTER TABLE ONLY "finance"."settlement_batches" FORCE ROW LEVEL SECURITY;


ALTER TABLE "finance"."settlement_batches" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "finance"."settlement_lines" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "settlement_batch_id" "uuid" NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "line_number" integer NOT NULL,
    "line_type" "text" NOT NULL,
    "source_type" "text",
    "source_id" "uuid",
    "project_id" "uuid",
    "client_id" "uuid",
    "currency" "text" DEFAULT 'PKR'::"text" NOT NULL,
    "amount" numeric(18,2) DEFAULT 0 NOT NULL,
    "rate" numeric(18,6),
    "base_amount" numeric(18,2),
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "settlement_lines_amount_check" CHECK (("amount" >= (0)::numeric)),
    CONSTRAINT "settlement_lines_currency_check" CHECK (("currency" ~ '^[A-Z]{3}$'::"text")),
    CONSTRAINT "settlement_lines_number_check" CHECK (("line_number" > 0))
);

ALTER TABLE ONLY "finance"."settlement_lines" FORCE ROW LEVEL SECURITY;


ALTER TABLE "finance"."settlement_lines" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "finance"."statement_lines" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "bank_statement_id" "uuid" NOT NULL,
    "line_number" integer,
    "transaction_date" "date" NOT NULL,
    "description" "text",
    "reference" "text",
    "counterparty" "text",
    "transaction_identifier" "text",
    "amount" numeric(18,2) NOT NULL,
    "balance_after" numeric(18,2),
    "reconciliation_status" "text" DEFAULT 'UNRECONCILED'::"text" NOT NULL,
    "matched_journal_line_id" "uuid",
    "matched_at" timestamp with time zone,
    "matched_by" "uuid",
    "match_method" "text",
    "exclusion_reason" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "statement_lines_match_method_check" CHECK ((("match_method" IS NULL) OR ("match_method" = ANY (ARRAY['AUTO_AMOUNT_DATE'::"text", 'AUTO_AMOUNT_REF'::"text", 'AUTO_AMOUNT_DESC'::"text", 'AUTO_IDENTIFIER'::"text", 'MANUAL'::"text"])))),
    CONSTRAINT "statement_lines_reconciliation_status_check" CHECK (("reconciliation_status" = ANY (ARRAY['UNRECONCILED'::"text", 'MATCHED'::"text", 'EXCLUDED'::"text", 'DUPLICATE'::"text", 'MANUAL_MATCH'::"text"])))
);


ALTER TABLE "finance"."statement_lines" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "finance"."tax_adjustments" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tax_reconciliation_id" "uuid" NOT NULL,
    "adjustment_category" "text" NOT NULL,
    "description" "text" NOT NULL,
    "amount" numeric(18,2) NOT NULL,
    "source_account_id" "uuid",
    "evidence_notes" "text",
    "created_by" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "organization_id" "uuid",
    CONSTRAINT "tax_adjustments_adjustment_category_check" CHECK (("adjustment_category" = ANY (ARRAY['ADD_BACK'::"text", 'DEDUCTION'::"text", 'NON_DEDUCTIBLE'::"text", 'EXEMPTION'::"text", 'DEPRECIATION_DIFF'::"text", 'PROVISION_ADJUST'::"text", 'PRIVATE_EXPENSE'::"text", 'CAPITAL_VS_REVENUE'::"text", 'LOSS_CARRY_FORWARD'::"text", 'SEPARATE_BLOCK'::"text", 'TAX_DEPRECIATION'::"text", 'OTHER'::"text"]))),
    CONSTRAINT "tax_adjustments_org_required_going_forward" CHECK (("organization_id" IS NOT NULL))
);


ALTER TABLE "finance"."tax_adjustments" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "finance"."tax_codes" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "code" "text" NOT NULL,
    "name" "text" NOT NULL,
    "tax_type" "text" DEFAULT 'TAX'::"text" NOT NULL,
    "rate" numeric(8,4) DEFAULT 0 NOT NULL,
    "recoverable_account_id" "uuid",
    "payable_account_id" "uuid",
    "effective_from" "date" DEFAULT CURRENT_DATE NOT NULL,
    "effective_to" "date",
    "is_active" boolean DEFAULT true NOT NULL,
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "tax_codes_code_not_empty" CHECK (("btrim"("code") <> ''::"text")),
    CONSTRAINT "tax_codes_dates_check" CHECK ((("effective_to" IS NULL) OR ("effective_to" >= "effective_from"))),
    CONSTRAINT "tax_codes_name_not_empty" CHECK (("btrim"("name") <> ''::"text")),
    CONSTRAINT "tax_codes_rate_check" CHECK (("rate" >= (0)::numeric))
);

ALTER TABLE ONLY "finance"."tax_codes" FORCE ROW LEVEL SECURITY;


ALTER TABLE "finance"."tax_codes" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "finance"."tax_computations" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "tax_rule_set_id" "uuid",
    "fiscal_year_id" "uuid",
    "period_id" "uuid",
    "tax_type" "text" DEFAULT 'corporate'::"text" NOT NULL,
    "period_start" "date" NOT NULL,
    "period_end" "date" NOT NULL,
    "gross_income" numeric(18,2) DEFAULT 0,
    "total_deductions" numeric(18,2) DEFAULT 0,
    "taxable_income" numeric(18,2) DEFAULT 0,
    "tax_rate" numeric(8,4) DEFAULT 0,
    "computed_tax" numeric(18,2) DEFAULT 0 NOT NULL,
    "surcharge" numeric(18,2) DEFAULT 0,
    "extra_tax" numeric(18,2) DEFAULT 0,
    "total_tax" numeric(18,2) GENERATED ALWAYS AS ((("computed_tax" + COALESCE("surcharge", (0)::numeric)) + COALESCE("extra_tax", (0)::numeric))) STORED,
    "status" "text" DEFAULT 'DRAFT'::"text" NOT NULL,
    "reviewed_by" "uuid",
    "reviewed_at" timestamp with time zone,
    "approved_by" "uuid",
    "approved_at" timestamp with time zone,
    "tax_return_id" "uuid",
    "notes" "text",
    "computation_json" "jsonb",
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "tax_computations_status_check" CHECK (("status" = ANY (ARRAY['DRAFT'::"text", 'CALCULATED'::"text", 'REVIEWED'::"text", 'UNDER_REVIEW'::"text", 'APPROVED'::"text", 'FILED'::"text", 'PAYMENT_PENDING'::"text", 'PAID'::"text", 'REFUND_PENDING'::"text", 'ADJUSTED'::"text", 'CLOSED'::"text"]))),
    CONSTRAINT "tax_computations_tax_type_check" CHECK (("tax_type" = ANY (ARRAY['corporate'::"text", 'sales'::"text", 'withholding'::"text", 'presumptive'::"text"])))
);


ALTER TABLE "finance"."tax_computations" OWNER TO "postgres";


COMMENT ON COLUMN "finance"."tax_computations"."status" IS 'Spec Section 5.12.1 state set (Draft/Calculated/Under Review/Approved/Filed/Payment Pending/Paid/Refund Pending/Amended[=Adjusted]/Closed). REVIEWED is retained alongside UNDER_REVIEW for backward compatibility with existing rows/application code -- confirm with the implementation team whether one should be deprecated. See Migration 019 / compliance audit Section C-5.';



CREATE TABLE IF NOT EXISTS "finance"."tax_credits_and_withholding" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "tax_computation_id" "uuid",
    "fiscal_year_id" "uuid",
    "period_id" "uuid",
    "credit_type" "text" NOT NULL,
    "counterparty_name" "text",
    "counterparty_cnic" "text",
    "counterparty_ntn" "text",
    "source_type" "text",
    "source_id" "uuid",
    "gross_amount" numeric(18,2) DEFAULT 0 NOT NULL,
    "wht_rate" numeric(8,4) DEFAULT 0,
    "credit_amount" numeric(18,2) DEFAULT 0 NOT NULL,
    "currency" "text" DEFAULT 'PKR'::"text",
    "status" "text" DEFAULT 'PENDING'::"text" NOT NULL,
    "tax_return_id" "uuid",
    "notes" "text",
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "tax_credits_and_withholding_credit_type_check" CHECK (("credit_type" = ANY (ARRAY['WHT_DEDUCTED'::"text", 'WHT_COLLECTED'::"text", 'TAX_CREDIT'::"text", 'CARRY_FORWARD'::"text", 'ADJUSTMENT'::"text", 'PREVIOUS_YEAR_CREDIT'::"text"]))),
    CONSTRAINT "tax_credits_and_withholding_status_check" CHECK (("status" = ANY (ARRAY['PENDING'::"text", 'CLAIMED'::"text", 'REJECTED'::"text", 'ADJUSTED'::"text"])))
);


ALTER TABLE "finance"."tax_credits_and_withholding" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "finance"."tax_payments_and_refunds" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "tax_computation_id" "uuid",
    "tax_return_id" "uuid",
    "fiscal_year_id" "uuid",
    "period_id" "uuid",
    "payment_type" "text" NOT NULL,
    "tax_authority" "text" DEFAULT 'FBR'::"text",
    "cpr_number" "text",
    "prs_number" "text",
    "amount" numeric(18,2) DEFAULT 0 NOT NULL,
    "currency" "text" DEFAULT 'PKR'::"text",
    "penalty_amount" numeric(18,2) DEFAULT 0,
    "surcharge_amount" numeric(18,2) DEFAULT 0,
    "total_paid" numeric(18,2) GENERATED ALWAYS AS ((("amount" + COALESCE("penalty_amount", (0)::numeric)) + COALESCE("surcharge_amount", (0)::numeric))) STORED,
    "payment_reference" "text",
    "payment_method" "text" DEFAULT 'bank_transfer'::"text",
    "payment_date" "date" DEFAULT CURRENT_DATE NOT NULL,
    "financial_account_id" "uuid",
    "journal_entry_id" "uuid",
    "status" "text" DEFAULT 'PENDING'::"text" NOT NULL,
    "notes" "text",
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "tax_payments_and_refunds_payment_method_check" CHECK (("payment_method" = ANY (ARRAY['bank_transfer'::"text", 'cheque'::"text", 'online'::"text", 'adjustment'::"text"]))),
    CONSTRAINT "tax_payments_and_refunds_payment_type_check" CHECK (("payment_type" = ANY (ARRAY['PAYMENT'::"text", 'REFUND'::"text", 'ADVANCE_PAYMENT'::"text", 'ADJUSTMENT'::"text"]))),
    CONSTRAINT "tax_payments_and_refunds_status_check" CHECK (("status" = ANY (ARRAY['PENDING'::"text", 'COMPLETED'::"text", 'FAILED'::"text", 'REVERSED'::"text"])))
);


ALTER TABLE "finance"."tax_payments_and_refunds" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "finance"."tax_reconciliations" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tax_year" "text" NOT NULL,
    "fiscal_year_id" "uuid" NOT NULL,
    "accounting_profit_before_tax" numeric(18,2) DEFAULT 0 NOT NULL,
    "taxable_income" numeric(18,2) DEFAULT 0 NOT NULL,
    "gross_tax_liability" numeric(18,2) DEFAULT 0 NOT NULL,
    "withholding_credits" numeric(18,2) DEFAULT 0 NOT NULL,
    "advance_tax_credits" numeric(18,2) DEFAULT 0 NOT NULL,
    "other_tax_credits" numeric(18,2) DEFAULT 0 NOT NULL,
    "net_tax_payable" numeric(18,2) DEFAULT 0 NOT NULL,
    "profit_after_tax" numeric(18,2) DEFAULT 0 NOT NULL,
    "effective_tax_rate" numeric(5,2) DEFAULT 0 NOT NULL,
    "tax_rule_set_id" "uuid" NOT NULL,
    "status" "text" DEFAULT 'DRAFT'::"text" NOT NULL,
    "filing_date" "date",
    "filing_reference" "text",
    "filed_values" "jsonb",
    "payment_reference" "text",
    "payment_date" "date",
    "accountant_approved_by" "uuid",
    "approved_at" timestamp with time zone,
    "rejection_reason" "text",
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "created_by" "uuid",
    "organization_id" "uuid",
    CONSTRAINT "tax_reconciliations_org_required_going_forward" CHECK (("organization_id" IS NOT NULL)),
    CONSTRAINT "tax_reconciliations_status_check" CHECK (("status" = ANY (ARRAY['DRAFT'::"text", 'CALCULATED'::"text", 'UNDER_REVIEW'::"text", 'ACCOUNTANT_APPROVED'::"text", 'FILED'::"text", 'PAYMENT_PENDING'::"text", 'PAID'::"text", 'REFUND_PENDING'::"text", 'AMENDED'::"text", 'CLOSED'::"text"])))
);


ALTER TABLE "finance"."tax_reconciliations" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "finance"."tax_returns" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "tax_rule_set_id" "uuid",
    "fiscal_year_id" "uuid",
    "period_id" "uuid",
    "tax_reconciliation_id" "uuid",
    "tax_type" "text" DEFAULT 'corporate'::"text" NOT NULL,
    "tax_year" "text" NOT NULL,
    "period_start" "date" NOT NULL,
    "period_end" "date" NOT NULL,
    "status" "text" DEFAULT 'DRAFT'::"text" NOT NULL,
    "filing_reference" "text",
    "filing_date" "date",
    "due_date" "date",
    "acknowledged_date" "date",
    "assessed_date" "date",
    "declared_income" numeric(18,2) DEFAULT 0,
    "declared_taxable" numeric(18,2) DEFAULT 0,
    "declared_tax" numeric(18,2) DEFAULT 0,
    "declared_wht_credits" numeric(18,2) DEFAULT 0,
    "declared_net_payable" numeric(18,2) DEFAULT 0,
    "assessed_income" numeric(18,2),
    "assessed_tax" numeric(18,2),
    "assessed_penalty" numeric(18,2) DEFAULT 0,
    "assessed_surcharge" numeric(18,2) DEFAULT 0,
    "assessed_total_due" numeric(18,2),
    "prepared_by" "uuid",
    "prepared_at" timestamp with time zone,
    "reviewed_by" "uuid",
    "reviewed_at" timestamp with time zone,
    "approved_by" "uuid",
    "approved_at" timestamp with time zone,
    "attachment_ids" "uuid"[],
    "filing_json" "jsonb",
    "notes" "text",
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "tax_returns_status_check" CHECK (("status" = ANY (ARRAY['DRAFT'::"text", 'PREPARED'::"text", 'UNDER_REVIEW'::"text", 'APPROVED'::"text", 'FILED'::"text", 'ACKNOWLEDGED'::"text", 'ASSESSED'::"text", 'ADJUSTED'::"text", 'CANCELLED'::"text"]))),
    CONSTRAINT "tax_returns_tax_type_check" CHECK (("tax_type" = ANY (ARRAY['corporate'::"text", 'sales'::"text", 'withholding'::"text", 'presumptive'::"text"])))
);


ALTER TABLE "finance"."tax_returns" OWNER TO "postgres";


COMMENT ON TABLE "finance"."tax_returns" IS 'Canonical tax returns table -- referenced by finance.tax_computations, finance.tax_credits_and_withholding, finance.tax_payments_and_refunds. public.tax_returns is a structurally orphaned duplicate (no inbound FK found); confirm it is unused by the application, then deprecate it. See Migration 023.';



CREATE TABLE IF NOT EXISTS "finance"."tax_rule_sets" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "jurisdiction" "text" DEFAULT 'PAKISTAN'::"text" NOT NULL,
    "taxpayer_type" "text" NOT NULL,
    "tax_year" "text" NOT NULL,
    "status" "text" DEFAULT 'DRAFT'::"text" NOT NULL,
    "approved_by" "uuid",
    "approved_at" timestamp with time zone,
    "version" integer DEFAULT 1 NOT NULL,
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "created_by" "uuid",
    "organization_id" "uuid",
    CONSTRAINT "tax_rule_sets_org_required_going_forward" CHECK (("organization_id" IS NOT NULL)),
    CONSTRAINT "tax_rule_sets_status_check" CHECK (("status" = ANY (ARRAY['DRAFT'::"text", 'APPROVED'::"text", 'LOCKED'::"text", 'SUPERSEDED'::"text"])))
);


ALTER TABLE "finance"."tax_rule_sets" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "finance"."tax_slabs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tax_rule_set_id" "uuid" NOT NULL,
    "slab_name" "text",
    "income_from" numeric(18,2) NOT NULL,
    "income_to" numeric(18,2),
    "tax_rate" numeric(5,2) NOT NULL,
    "fixed_amount" numeric(18,2) DEFAULT 0 NOT NULL,
    "slab_type" "text" DEFAULT 'PROGRESSIVE'::"text" NOT NULL,
    "sort_order" integer DEFAULT 0 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "organization_id" "uuid",
    CONSTRAINT "tax_slabs_org_required_going_forward" CHECK (("organization_id" IS NOT NULL)),
    CONSTRAINT "tax_slabs_slab_type_check" CHECK (("slab_type" = ANY (ARRAY['PROGRESSIVE'::"text", 'FLAT'::"text", 'FIXED'::"text"])))
);


ALTER TABLE "finance"."tax_slabs" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "finance"."taxpayer_profile" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "legal_entity_type" "text" DEFAULT 'AOP'::"text" NOT NULL,
    "ntn_number" "text",
    "filing_jurisdiction" "text" DEFAULT 'PAKISTAN'::"text" NOT NULL,
    "tax_status" "text" DEFAULT 'ACTIVE'::"text" NOT NULL,
    "default_tax_year_basis" "text" DEFAULT 'JUL_JUN'::"text" NOT NULL,
    "cnic_number" "text",
    "registered_address" "text",
    "contact_phone" "text",
    "configured_by" "uuid",
    "approved_by" "uuid",
    "approved_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "organization_id" "uuid",
    CONSTRAINT "taxpayer_profile_legal_entity_type_check" CHECK (("legal_entity_type" = ANY (ARRAY['SOLE_PROPRIETOR'::"text", 'AOP'::"text", 'COMPANY'::"text", 'INDIVIDUAL'::"text"]))),
    CONSTRAINT "taxpayer_profile_org_required_going_forward" CHECK (("organization_id" IS NOT NULL)),
    CONSTRAINT "taxpayer_profile_tax_status_check" CHECK (("tax_status" = ANY (ARRAY['ACTIVE'::"text", 'SUSPENDED'::"text", 'DEREGISTERED'::"text"])))
);


ALTER TABLE "finance"."taxpayer_profile" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "finance"."vendor_bill_lines" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "vendor_bill_id" "uuid" NOT NULL,
    "line_number" integer NOT NULL,
    "account_id" "uuid" NOT NULL,
    "description" "text" NOT NULL,
    "quantity" numeric(18,4) DEFAULT 1,
    "unit_price" numeric(18,2) NOT NULL,
    "tax_code_id" "uuid",
    "tax_rate" numeric(8,2) DEFAULT 0,
    "tax_amount" numeric(18,2) DEFAULT 0,
    "withholding_rate" numeric(8,2) DEFAULT 0,
    "withholding_amount" numeric(18,2) DEFAULT 0,
    "line_total" numeric(18,2) NOT NULL,
    "project_id" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "finance"."vendor_bill_lines" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "finance"."vendor_bills" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "bill_number" "text",
    "vendor_id" "uuid" NOT NULL,
    "bill_date" "date" DEFAULT CURRENT_DATE NOT NULL,
    "due_date" "date",
    "currency" "text" DEFAULT 'PKR'::"text",
    "exchange_rate" numeric(18,4) DEFAULT 1,
    "subtotal" numeric(18,2) DEFAULT 0,
    "tax_amount" numeric(18,2) DEFAULT 0,
    "withholding_amount" numeric(18,2) DEFAULT 0,
    "discount_amount" numeric(18,2) DEFAULT 0,
    "total_amount" numeric(18,2) NOT NULL,
    "base_subtotal" numeric(18,2) DEFAULT 0,
    "base_tax_amount" numeric(18,2) DEFAULT 0,
    "base_withholding_amount" numeric(18,2) DEFAULT 0,
    "base_discount_amount" numeric(18,2) DEFAULT 0,
    "base_total_amount" numeric(18,2) NOT NULL,
    "amount_paid" numeric(18,2) DEFAULT 0,
    "outstanding_amount" numeric(18,2) DEFAULT 0,
    "status" "text" DEFAULT 'DRAFT'::"text" NOT NULL,
    "project_id" "uuid",
    "description" "text",
    "submitted_by" "uuid",
    "submitted_at" timestamp with time zone,
    "verified_by" "uuid",
    "verified_at" timestamp with time zone,
    "approved_by" "uuid",
    "approved_at" timestamp with time zone,
    "posted_by" "uuid",
    "posted_at" timestamp with time zone,
    "rejection_reason" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "created_by" "uuid",
    "organization_id" "uuid" NOT NULL,
    CONSTRAINT "vendor_bills_status_check" CHECK (("status" = ANY (ARRAY['DRAFT'::"text", 'SUBMITTED'::"text", 'VERIFIED'::"text", 'APPROVED'::"text", 'POSTED'::"text", 'PARTIALLY_PAID'::"text", 'PAID'::"text", 'REVERSED'::"text", 'CANCELLED'::"text"])))
);


ALTER TABLE "finance"."vendor_bills" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "finance"."vendor_payment_allocations" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "vendor_payment_id" "uuid" NOT NULL,
    "vendor_bill_id" "uuid" NOT NULL,
    "allocated_amount" numeric(18,2) NOT NULL,
    "base_allocated_amount" numeric(18,2) NOT NULL,
    "allocated_by" "uuid" NOT NULL,
    "allocated_at" timestamp with time zone DEFAULT "now"(),
    "discount_amount" numeric(18,2) DEFAULT 0 NOT NULL,
    "base_discount_amount" numeric(18,2) DEFAULT 0 NOT NULL,
    CONSTRAINT "vendor_payment_allocations_allocated_amount_check" CHECK (("allocated_amount" > (0)::numeric)),
    CONSTRAINT "vendor_payment_allocations_discount_amount_check" CHECK (("discount_amount" >= (0)::numeric))
);


ALTER TABLE "finance"."vendor_payment_allocations" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "finance"."vendor_payments" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "payment_number" "text",
    "payment_date" "date" DEFAULT CURRENT_DATE NOT NULL,
    "amount" numeric(18,2) NOT NULL,
    "currency" "text" DEFAULT 'PKR'::"text",
    "exchange_rate" numeric(18,4) DEFAULT 1,
    "base_amount" numeric(18,2) NOT NULL,
    "vendor_id" "uuid" NOT NULL,
    "financial_account_id" "uuid",
    "payment_method" "text" NOT NULL,
    "reference" "text",
    "description" "text",
    "status" "text" DEFAULT 'DRAFT'::"text" NOT NULL,
    "is_batch" boolean DEFAULT false,
    "batch_id" "uuid",
    "journal_entry_id" "uuid",
    "period_id" "uuid",
    "approved_by" "uuid",
    "approved_at" timestamp with time zone,
    "posted_by" "uuid",
    "posted_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "created_by" "uuid",
    "organization_id" "uuid",
    CONSTRAINT "vendor_payments_org_required_going_forward" CHECK (("organization_id" IS NOT NULL)),
    CONSTRAINT "vendor_payments_payment_method_check" CHECK (("payment_method" = ANY (ARRAY['BANK_TRANSFER'::"text", 'CHEQUE'::"text", 'CASH'::"text", 'PLATFORM'::"text", 'OTHER'::"text"]))),
    CONSTRAINT "vendor_payments_status_check" CHECK (("status" = ANY (ARRAY['DRAFT'::"text", 'APPROVED'::"text", 'POSTED'::"text", 'REVERSED'::"text"])))
);


ALTER TABLE "finance"."vendor_payments" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "finance"."vendors" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "vendor_code" "text",
    "name" "text" NOT NULL,
    "contact_person" "text",
    "email" "text",
    "phone" "text",
    "address" "text",
    "city" "text",
    "country" "text" DEFAULT 'Pakistan'::"text",
    "tax_registration" "text",
    "tax_type" "text" DEFAULT 'GST_REGISTERED'::"text",
    "payment_terms" "text" DEFAULT 'NET_30'::"text",
    "default_currency" "text" DEFAULT 'PKR'::"text",
    "bank_name" "text",
    "bank_account" "text",
    "is_active" boolean DEFAULT true,
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "created_by" "uuid",
    "deleted_at" timestamp with time zone,
    "deleted_by" "uuid",
    "organization_id" "uuid",
    CONSTRAINT "vendors_org_required_going_forward" CHECK (("organization_id" IS NOT NULL))
);


ALTER TABLE "finance"."vendors" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "legacy"."budget_lines" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "budget_id" "uuid" NOT NULL,
    "account_id" "uuid",
    "line_description" "text",
    "allocated_amount" numeric(18,2) DEFAULT 0 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "created_by" "uuid"
);


ALTER TABLE "legacy"."budget_lines" OWNER TO "postgres";


COMMENT ON TABLE "legacy"."budget_lines" IS 'ARCHIVED (Migration 032): formerly public.budget_lines, a legacy duplicate of finance.budget_lines (the canonical table; reporting.budget_gl_actual re-pointed to it in Migration 031). Write-frozen since Migration 022; retained read-only for historical reference.';



CREATE TABLE IF NOT EXISTS "legacy"."financial_accounts" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "account_name" "text" NOT NULL,
    "account_number" "text",
    "account_type" "text" DEFAULT 'BANK'::"text",
    "bank_name" "text",
    "branch_name" "text",
    "currency" "text" DEFAULT 'PKR'::"text",
    "opening_balance" numeric(18,2) DEFAULT 0,
    "current_balance" numeric(18,2) DEFAULT 0,
    "is_default" boolean DEFAULT false,
    "status" "text" DEFAULT 'ACTIVE'::"text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "user_id" "uuid",
    "deleted_at" timestamp with time zone,
    "deleted_by" "uuid",
    CONSTRAINT "financial_accounts_account_type_check" CHECK (("account_type" = ANY (ARRAY['BANK'::"text", 'CASH'::"text", 'MOBILE_WALLET'::"text", 'OTHER'::"text"]))),
    CONSTRAINT "financial_accounts_status_check" CHECK (("status" = ANY (ARRAY['ACTIVE'::"text", 'INACTIVE'::"text"])))
);


ALTER TABLE "legacy"."financial_accounts" OWNER TO "postgres";


COMMENT ON TABLE "legacy"."financial_accounts" IS 'ARCHIVED (Migration 032): formerly public.financial_accounts, a legacy duplicate of finance.financial_accounts (the canonical table). Write-frozen since Migration 022; retained read-only for historical reference. Resolves Compliance Audit Finding 2.2 / Section 3.2. NOTE: core.soft_delete() has an unreached branch referencing public.financial_accounts by name -- confirmed NOT a blocking dependency (PL/pgSQL body text is not tracked by pg_depend); tracked as a separate application-level follow-up, not fixed by this migration.';



CREATE TABLE IF NOT EXISTS "legacy"."numbering_sequences" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "document_type" "text" NOT NULL,
    "prefix" "text" DEFAULT ''::"text",
    "next_number" integer DEFAULT 1,
    "pad_length" integer DEFAULT 5,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "legacy"."numbering_sequences" OWNER TO "postgres";


COMMENT ON TABLE "legacy"."numbering_sequences" IS 'ARCHIVED (Migration 032): formerly public.numbering_sequences, a legacy numbering authority disconnected from finance.get_next_number(). Write-frozen since Migration 022; retained read-only for historical reference.';



CREATE TABLE IF NOT EXISTS "legacy"."tax_returns" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tax_type" "text" NOT NULL,
    "filing_period_start" "date" NOT NULL,
    "filing_period_end" "date",
    "due_date" "date" NOT NULL,
    "filed_date" "date",
    "status" "text" DEFAULT 'DRAFT'::"text",
    "total_tax_liability" numeric(18,2) DEFAULT 0,
    "tax_paid" numeric(18,2) DEFAULT 0,
    "balance_due" numeric(18,2) GENERATED ALWAYS AS (("total_tax_liability" - "tax_paid")) STORED,
    "filing_reference" "text",
    "notes" "text",
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "user_id" "uuid",
    CONSTRAINT "tax_returns_status_check" CHECK (("status" = ANY (ARRAY['DRAFT'::"text", 'PENDING_REVIEW'::"text", 'FILED'::"text", 'PAID'::"text", 'OVERDUE'::"text", 'ADJUSTED'::"text"])))
);


ALTER TABLE "legacy"."tax_returns" OWNER TO "postgres";


COMMENT ON TABLE "legacy"."tax_returns" IS 'ARCHIVED (Migration 032): formerly public.tax_returns, a structurally orphaned duplicate of finance.tax_returns (the canonical table referenced by finance.tax_computations / tax_credits_and_withholding / tax_payments_and_refunds). Write-frozen since Migration 022; retained read-only for historical reference.';



CREATE TABLE IF NOT EXISTS "public"."budgets" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "category" "text" NOT NULL,
    "total_amount" numeric(12,2) NOT NULL,
    "start_date" "date" NOT NULL,
    "end_date" "date" NOT NULL,
    "description" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "control_account_id" "uuid",
    "variance_alert_threshold" numeric(5,2) DEFAULT 80.00,
    "status" "text" DEFAULT 'DRAFT'::"text" NOT NULL,
    "submitted_by" "uuid",
    "submitted_at" timestamp with time zone,
    "approved_by" "uuid",
    "approved_at" timestamp with time zone,
    "rejection_reason" "text",
    "fiscal_year_id" "uuid",
    "project_id" "uuid",
    "department" "text",
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "organization_id" "uuid" NOT NULL,
    CONSTRAINT "budgets_status_check" CHECK (("status" = ANY (ARRAY['DRAFT'::"text", 'SUBMITTED'::"text", 'APPROVED'::"text", 'REJECTED'::"text"]))),
    CONSTRAINT "budgets_total_amount_check" CHECK (("total_amount" >= (0)::numeric))
);


ALTER TABLE "public"."budgets" OWNER TO "postgres";


COMMENT ON COLUMN "public"."budgets"."control_account_id" IS 'GL control account that tracks budget allocations. Debit = allocation, Credit = utilization.';



COMMENT ON COLUMN "public"."budgets"."variance_alert_threshold" IS 'Percentage (0-100) at which variance alerts trigger. Default 80%.';



COMMENT ON COLUMN "public"."budgets"."organization_id" IS 'Added migration 036 (Compliance Audit Finding 4.1). Backfilled from public.profiles via user_id.';



CREATE OR REPLACE VIEW "public"."chart_of_accounts" WITH ("security_invoker"='true') AS
 SELECT "id",
    "created_at",
    "updated_at",
    "created_by",
    "code",
    "name",
    "parent_id",
    "account_type",
    "normal_balance",
    "currency",
    "is_active",
    "posting_allowed",
    "is_control_account",
    "report_mapping",
    "description",
    "display_order",
    "level"
   FROM "finance"."chart_of_accounts";


ALTER VIEW "public"."chart_of_accounts" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."clients" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "contact_person" "text",
    "email" "text",
    "phone" "text",
    "address" "text",
    "city" "text",
    "country" "text" DEFAULT 'Pakistan'::"text",
    "tax_id" "text",
    "status" "text" DEFAULT 'ACTIVE'::"text",
    "user_id" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "deleted_at" timestamp with time zone,
    "deleted_by" "uuid",
    "organization_id" "uuid" NOT NULL,
    CONSTRAINT "clients_status_check" CHECK (("status" = ANY (ARRAY['ACTIVE'::"text", 'INACTIVE'::"text"])))
);


ALTER TABLE "public"."clients" OWNER TO "postgres";


COMMENT ON COLUMN "public"."clients"."organization_id" IS 'Added migration 036 (Compliance Audit Finding 4.1). Backfilled from public.profiles via user_id where user_id is present; rows with NULL user_id require manual assignment -- see migration 036 NOTICE output.';



CREATE OR REPLACE VIEW "public"."coa_tree" WITH ("security_invoker"='true') AS
 SELECT "id",
    "code",
    "name",
    "parent_id",
    "account_type",
    "normal_balance",
    "is_active",
    "posting_allowed",
    "is_control_account",
    "report_mapping",
    "level",
    "display_order",
    "path_ids",
    "path_codes",
    "depth"
   FROM "finance"."coa_tree";


ALTER VIEW "public"."coa_tree" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."commissions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "contractor_id" "uuid",
    "person_name" character varying(200) NOT NULL,
    "person_type" character varying(20) DEFAULT 'CONTRACTOR'::character varying NOT NULL,
    "commission_type" character varying(30) DEFAULT 'PERCENTAGE'::character varying NOT NULL,
    "calculation_basis" character varying(50) DEFAULT 'PROJECT_REVENUE'::character varying NOT NULL,
    "rate_or_amount" numeric(14,4) DEFAULT 0 NOT NULL,
    "project_id" "uuid",
    "client_id" "uuid",
    "invoice_ref" character varying(100),
    "milestone_ref" character varying(100),
    "period_start" "date",
    "period_end" "date",
    "base_amount" numeric(14,2) DEFAULT 0 NOT NULL,
    "commission_amount" numeric(14,2) DEFAULT 0 NOT NULL,
    "currency" character varying(3) DEFAULT 'PKR'::character varying NOT NULL,
    "tax_withheld" numeric(14,2) DEFAULT 0,
    "net_amount" numeric(14,2) GENERATED ALWAYS AS (
CASE
    WHEN ("commission_amount" >= "tax_withheld") THEN ("commission_amount" - "tax_withheld")
    ELSE (0)::numeric
END) STORED,
    "status" character varying(20) DEFAULT 'PENDING'::character varying NOT NULL,
    "payment_date" "date",
    "payment_ref" character varying(100),
    "approved_by" "uuid",
    "approved_at" timestamp with time zone,
    "notes" "text",
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "organization_id" "uuid",
    CONSTRAINT "commissions_base_amount_check" CHECK (("base_amount" >= (0)::numeric)),
    CONSTRAINT "commissions_calculation_basis_check" CHECK ((("calculation_basis")::"text" = ANY ((ARRAY['PROJECT_REVENUE'::character varying, 'INVOICE_AMOUNT'::character varying, 'MILESTONE_VALUE'::character varying, 'CLIENT_PAYMENT'::character varying, 'SALES_TARGET'::character varying, 'FIXED_AMOUNT'::character varying])::"text"[]))),
    CONSTRAINT "commissions_commission_amount_check" CHECK (("commission_amount" >= (0)::numeric)),
    CONSTRAINT "commissions_commission_type_check" CHECK ((("commission_type")::"text" = ANY ((ARRAY['PERCENTAGE'::character varying, 'FIXED_AMOUNT'::character varying, 'TIERED'::character varying, 'FLAT_BONUS'::character varying, 'REFERRAL'::character varying])::"text"[]))),
    CONSTRAINT "commissions_org_required_going_forward" CHECK (("organization_id" IS NOT NULL)),
    CONSTRAINT "commissions_person_type_check" CHECK ((("person_type")::"text" = ANY ((ARRAY['CONTRACTOR'::character varying, 'EMPLOYEE'::character varying])::"text"[]))),
    CONSTRAINT "commissions_rate_or_amount_check" CHECK (("rate_or_amount" >= (0)::numeric)),
    CONSTRAINT "commissions_status_check" CHECK ((("status")::"text" = ANY ((ARRAY['PENDING'::character varying, 'APPROVED'::character varying, 'PAID'::character varying, 'CANCELLED'::character varying, 'HELD'::character varying])::"text"[]))),
    CONSTRAINT "commissions_tax_withheld_check" CHECK (("tax_withheld" >= (0)::numeric))
);


ALTER TABLE "public"."commissions" OWNER TO "postgres";


COMMENT ON TABLE "public"."commissions" IS 'Commission earnings for contractors and employees, linked to projects, invoices, or milestones with full payment tracking.';



CREATE TABLE IF NOT EXISTS "public"."contractors" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" character varying(200) NOT NULL,
    "email" character varying(255),
    "phone" character varying(50),
    "company" character varying(200),
    "role" character varying(50) DEFAULT 'DEVELOPER'::character varying NOT NULL,
    "specialization" character varying(200),
    "rate_type" character varying(20) DEFAULT 'MONTHLY'::character varying NOT NULL,
    "rate" numeric(14,2) NOT NULL,
    "currency" character varying(3) DEFAULT 'PKR'::character varying NOT NULL,
    "contract_start" "date",
    "contract_end" "date",
    "project_id" "uuid",
    "status" character varying(20) DEFAULT 'ACTIVE'::character varying NOT NULL,
    "tax_withholding_pct" numeric(5,2) DEFAULT 0,
    "payment_terms" character varying(50) DEFAULT 'NET_30'::character varying,
    "bank_name" character varying(200),
    "bank_account" character varying(100),
    "notes" "text",
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "organization_id" "uuid",
    CONSTRAINT "contractors_org_required_going_forward" CHECK (("organization_id" IS NOT NULL)),
    CONSTRAINT "contractors_payment_terms_check" CHECK ((("payment_terms")::"text" = ANY ((ARRAY['NET_15'::character varying, 'NET_30'::character varying, 'NET_45'::character varying, 'NET_60'::character varying, 'UPFRONT'::character varying, 'MILESTONE'::character varying])::"text"[]))),
    CONSTRAINT "contractors_rate_check" CHECK (("rate" >= (0)::numeric)),
    CONSTRAINT "contractors_rate_type_check" CHECK ((("rate_type")::"text" = ANY ((ARRAY['HOURLY'::character varying, 'DAILY'::character varying, 'WEEKLY'::character varying, 'MONTHLY'::character varying, 'FIXED_PROJECT'::character varying])::"text"[]))),
    CONSTRAINT "contractors_role_check" CHECK ((("role")::"text" = ANY ((ARRAY['DEVELOPER'::character varying, 'DESIGNER'::character varying, 'CONSULTANT'::character varying, 'PM'::character varying, 'QA_TESTER'::character varying, 'DEVOPS'::character varying, 'DATA_ANALYST'::character varying, 'CONTENT_WRITER'::character varying, 'OTHER'::character varying])::"text"[]))),
    CONSTRAINT "contractors_status_check" CHECK ((("status")::"text" = ANY ((ARRAY['ACTIVE'::character varying, 'ON_HOLD'::character varying, 'TERMINATED'::character varying, 'COMPLETED'::character varying])::"text"[]))),
    CONSTRAINT "contractors_tax_withholding_pct_check" CHECK ((("tax_withholding_pct" >= (0)::numeric) AND ("tax_withholding_pct" <= (100)::numeric)))
);


ALTER TABLE "public"."contractors" OWNER TO "postgres";


COMMENT ON TABLE "public"."contractors" IS 'External contractor engagements with rates, contract periods, project allocation, and cost tracking.';



CREATE OR REPLACE VIEW "public"."credit_notes" WITH ("security_invoker"='true') AS
 SELECT "id",
    "credit_note_number",
    "invoice_id",
    "reason",
    "amount",
    "currency",
    "exchange_rate",
    "base_amount",
    "status",
    "journal_entry_id",
    "period_id",
    "created_by",
    "approved_by",
    "approved_at",
    "posted_by",
    "posted_at",
    "created_at",
    "updated_at"
   FROM "finance"."credit_notes";


ALTER VIEW "public"."credit_notes" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."exchange_rates" WITH ("security_invoker"='true') AS
 SELECT "id",
    "from_currency",
    "to_currency",
    "rate",
    "rate_date",
    "rate_time",
    "rate_type",
    "source_platform",
    "entered_by",
    "approved_by",
    "approved_at",
    "is_locked",
    "created_at",
    "updated_at"
   FROM "finance"."exchange_rates";


ALTER VIEW "public"."exchange_rates" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."expenses" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "project_id" "uuid",
    "title" character varying(255) NOT NULL,
    "amount" numeric(12,2) NOT NULL,
    "category" character varying(100) NOT NULL,
    "expense_date" "date" DEFAULT CURRENT_DATE NOT NULL,
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "status" "text" DEFAULT 'DRAFT'::"text",
    "journal_entry_id" "uuid",
    "period_id" "uuid",
    "currency" "text" DEFAULT 'PKR'::"text",
    "exchange_rate" numeric(18,4) DEFAULT 1,
    "base_amount" numeric(18,2),
    "submitted_by" "uuid",
    "submitted_at" timestamp with time zone,
    "approved_by" "uuid",
    "approved_at" timestamp with time zone,
    "posted_at" timestamp with time zone,
    "rejection_reason" "text",
    "account_id" "uuid",
    "vendor_id" "uuid",
    "has_receipt" boolean DEFAULT false,
    "receipt_attachment_id" "uuid",
    "organization_id" "uuid" NOT NULL,
    CONSTRAINT "expenses_status_check" CHECK (("status" = ANY (ARRAY['DRAFT'::"text", 'SUBMITTED'::"text", 'VERIFIED'::"text", 'APPROVED'::"text", 'POSTED'::"text", 'REVERSED'::"text", 'REJECTED'::"text", 'CANCELLED'::"text"])))
);


ALTER TABLE "public"."expenses" OWNER TO "postgres";


COMMENT ON COLUMN "public"."expenses"."organization_id" IS 'Added migration 036 (Compliance Audit Finding 4.1). Backfilled from public.profiles via user_id.';



CREATE OR REPLACE VIEW "reporting"."general_ledger" WITH ("security_invoker"='true') AS
 SELECT "je"."id" AS "journal_entry_id",
    "je"."reference" AS "journal_reference",
    "je"."description" AS "journal_description",
    "je"."transaction_date",
    "je"."posting_date",
    "je"."period_id",
    "je"."fiscal_year_id",
    "je"."project_id",
    "je"."source_type",
    "je"."source_id",
    "jl"."id" AS "line_id",
    "jl"."line_number",
    "jl"."account_id",
    "coa"."code" AS "account_code",
    "coa"."name" AS "account_name",
    "coa"."account_type",
    "coa"."normal_balance",
    "jl"."description" AS "line_description",
    "jl"."debit_amount",
    "jl"."credit_amount",
    COALESCE("jl"."base_debit", "jl"."debit_amount") AS "base_debit",
    COALESCE("jl"."base_credit", "jl"."credit_amount") AS "base_credit",
    "jl"."currency",
    "jl"."exchange_rate",
    "sum"(
        CASE
            WHEN ("coa"."normal_balance" = 'DEBIT'::"text") THEN (COALESCE("jl"."base_debit", "jl"."debit_amount") - COALESCE("jl"."base_credit", "jl"."credit_amount"))
            ELSE (COALESCE("jl"."base_credit", "jl"."credit_amount") - COALESCE("jl"."base_debit", "jl"."debit_amount"))
        END) OVER (PARTITION BY "jl"."account_id" ORDER BY "je"."transaction_date", "je"."reference", "jl"."line_number" ROWS UNBOUNDED PRECEDING) AS "running_balance"
   FROM (("finance"."journal_lines" "jl"
     JOIN "finance"."journal_entries" "je" ON (("je"."id" = "jl"."journal_entry_id")))
     JOIN "finance"."chart_of_accounts" "coa" ON (("coa"."id" = "jl"."account_id")))
  WHERE ("je"."status" = 'POSTED'::"text");


ALTER VIEW "reporting"."general_ledger" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."general_ledger" WITH ("security_invoker"='true') AS
 SELECT "journal_entry_id",
    "journal_reference",
    "journal_description",
    "transaction_date",
    "posting_date",
    "period_id",
    "fiscal_year_id",
    "project_id",
    "source_type",
    "source_id",
    "line_id",
    "line_number",
    "account_id",
    "account_code",
    "account_name",
    "account_type",
    "normal_balance",
    "line_description",
    "debit_amount",
    "credit_amount",
    "base_debit",
    "base_credit",
    "currency",
    "exchange_rate",
    "running_balance"
   FROM "reporting"."general_ledger";


ALTER VIEW "public"."general_ledger" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."incomes" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "title" character varying(255) NOT NULL,
    "amount" numeric(12,2) NOT NULL,
    "category" character varying(100) NOT NULL,
    "description" "text",
    "income_date" "date" DEFAULT CURRENT_DATE NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "project_id" "uuid",
    "status" "text" DEFAULT 'DRAFT'::"text",
    "journal_entry_id" "uuid",
    "period_id" "uuid",
    "currency" "text" DEFAULT 'PKR'::"text",
    "exchange_rate" numeric(18,4) DEFAULT 1,
    "base_amount" numeric(18,2),
    "submitted_by" "uuid",
    "submitted_at" timestamp with time zone,
    "approved_by" "uuid",
    "approved_at" timestamp with time zone,
    "posted_at" timestamp with time zone,
    "rejection_reason" "text",
    "account_id" "uuid",
    "organization_id" "uuid",
    CONSTRAINT "incomes_org_required_going_forward" CHECK (("organization_id" IS NOT NULL)),
    CONSTRAINT "incomes_status_check" CHECK (("status" = ANY (ARRAY['DRAFT'::"text", 'SUBMITTED'::"text", 'VERIFIED'::"text", 'APPROVED'::"text", 'POSTED'::"text", 'REVERSED'::"text", 'REJECTED'::"text", 'CANCELLED'::"text"])))
);


ALTER TABLE "public"."incomes" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."invoices" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "project_id" "uuid",
    "invoice_number" character varying(50) NOT NULL,
    "client_name" character varying(255) NOT NULL,
    "amount" numeric(18,2) NOT NULL,
    "status" character varying(50) DEFAULT 'DRAFT'::character varying,
    "issue_date" "date" DEFAULT CURRENT_DATE NOT NULL,
    "due_date" "date" NOT NULL,
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "client_id" "uuid",
    "currency" "text" DEFAULT 'PKR'::"text",
    "exchange_rate" numeric(18,4) DEFAULT 1,
    "subtotal" numeric(18,2) DEFAULT 0,
    "tax_amount" numeric(18,2) DEFAULT 0,
    "discount_amount" numeric(18,2) DEFAULT 0,
    "total_amount" numeric(18,2) DEFAULT 0,
    "base_subtotal" numeric(18,2) DEFAULT 0,
    "base_tax_amount" numeric(18,2) DEFAULT 0,
    "base_discount_amount" numeric(18,2) DEFAULT 0,
    "base_total_amount" numeric(18,2) DEFAULT 0,
    "amount_paid" numeric(18,2) DEFAULT 0,
    "base_amount_paid" numeric(18,2) DEFAULT 0,
    "outstanding_amount" numeric(18,2) DEFAULT 0,
    "base_outstanding_amount" numeric(18,2) DEFAULT 0,
    "journal_entry_id" "uuid",
    "period_id" "uuid",
    "approved_by" "uuid",
    "approved_at" timestamp with time zone,
    "issued_by" "uuid",
    "issued_at" timestamp with time zone,
    "void_reason" "text",
    "voided_by" "uuid",
    "voided_at" timestamp with time zone,
    "organization_id" "uuid" NOT NULL,
    CONSTRAINT "invoices_amounts_non_negative_check" CHECK ((("amount" >= (0)::numeric) AND ("subtotal" >= (0)::numeric) AND ("tax_amount" >= (0)::numeric) AND ("discount_amount" >= (0)::numeric) AND ("total_amount" >= (0)::numeric) AND ("base_subtotal" >= (0)::numeric) AND ("base_tax_amount" >= (0)::numeric) AND ("base_discount_amount" >= (0)::numeric) AND ("base_total_amount" >= (0)::numeric) AND ("amount_paid" >= (0)::numeric) AND ("base_amount_paid" >= (0)::numeric) AND ("outstanding_amount" >= (0)::numeric) AND ("base_outstanding_amount" >= (0)::numeric))),
    CONSTRAINT "invoices_status_check" CHECK ((("status")::"text" = ANY ((ARRAY['DRAFT'::character varying, 'SUBMITTED'::character varying, 'PENDING_APPROVAL'::character varying, 'VERIFIED'::character varying, 'APPROVED'::character varying, 'ISSUED'::character varying, 'PARTIALLY_PAID'::character varying, 'PAID'::character varying, 'OVERDUE'::character varying, 'VOID'::character varying, 'CREDITED'::character varying, 'REFUNDED'::character varying])::"text"[])))
);


ALTER TABLE "public"."invoices" OWNER TO "postgres";


COMMENT ON COLUMN "public"."invoices"."organization_id" IS 'Added migration 036 (Compliance Audit Finding 4.1). Backfilled from public.profiles via user_id; must be NOT NULL + FK after migration 037 verifies clean data.';



CREATE OR REPLACE VIEW "public"."journal_entries" WITH ("security_invoker"='true') AS
 SELECT "id",
    "created_at",
    "updated_at",
    "created_by",
    "reference",
    "description",
    "status",
    "transaction_date",
    "posting_date",
    "period_id",
    "fiscal_year_id",
    "currency",
    "exchange_rate",
    "base_currency",
    "total_debit",
    "total_credit",
    "source_type",
    "source_id",
    "project_id",
    "department_id",
    "cost_center_id",
    "attachment_ids",
    "notes",
    "rejection_reason",
    "reversal_of_id",
    "reversal_reason",
    "submitted_by",
    "submitted_at",
    "verified_by",
    "verified_at",
    "approved_by",
    "approved_at",
    "posted_by",
    "posted_at",
    "reversed_by",
    "reversed_at"
   FROM "finance"."journal_entries";


ALTER VIEW "public"."journal_entries" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."journal_lines" WITH ("security_invoker"='true') AS
 SELECT "id",
    "created_at",
    "updated_at",
    "created_by",
    "journal_entry_id",
    "line_number",
    "account_id",
    "description",
    "debit_amount",
    "credit_amount",
    "currency",
    "exchange_rate",
    "base_debit",
    "base_credit",
    "project_id",
    "department_id",
    "cost_center_id",
    "tax_code_id",
    "matching_ref"
   FROM "finance"."journal_lines";


ALTER VIEW "public"."journal_lines" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."notification_deliveries" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "notification_id" "uuid" NOT NULL,
    "channel" "text" NOT NULL,
    "status" "text" DEFAULT 'PENDING'::"text" NOT NULL,
    "attempted_at" timestamp with time zone DEFAULT "now"(),
    "delivered_at" timestamp with time zone,
    "error_message" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "notification_deliveries_channel_check" CHECK (("channel" = ANY (ARRAY['IN_APP'::"text", 'EMAIL'::"text", 'SMS'::"text"]))),
    CONSTRAINT "notification_deliveries_status_check" CHECK (("status" = ANY (ARRAY['PENDING'::"text", 'SENT'::"text", 'DELIVERED'::"text", 'FAILED'::"text"])))
);


ALTER TABLE "public"."notification_deliveries" OWNER TO "postgres";


COMMENT ON TABLE "public"."notification_deliveries" IS 'Per-channel delivery attempt/result for a notification. Spec Section 10.4. See Migration 021.';



CREATE TABLE IF NOT EXISTS "public"."notification_preferences" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "category" "text" NOT NULL,
    "channel" "text" NOT NULL,
    "enabled" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "notification_preferences_channel_check" CHECK (("channel" = ANY (ARRAY['IN_APP'::"text", 'EMAIL'::"text", 'SMS'::"text"])))
);


ALTER TABLE "public"."notification_preferences" OWNER TO "postgres";


COMMENT ON TABLE "public"."notification_preferences" IS 'Per-user, per-category, per-channel notification opt-in/out. Spec Section 10.4. See Migration 021.';



CREATE TABLE IF NOT EXISTS "public"."notifications" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "title" character varying(255) NOT NULL,
    "message" "text" NOT NULL,
    "is_read" boolean DEFAULT false,
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."notifications" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."organization_config" WITH ("security_invoker"='true') AS
 SELECT "id",
    "created_at",
    "updated_at",
    "created_by",
    "org_name",
    "base_currency",
    "enabled_currencies",
    "timezone",
    "date_format",
    "number_format",
    "fiscal_year_start_month",
    "fiscal_year_end_month",
    "decimal_precision",
    "rounding_method",
    "logo_url",
    "active"
   FROM "core"."organization_config";


ALTER VIEW "public"."organization_config" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."payment_allocations" WITH ("security_invoker"='true') AS
 SELECT "id",
    "payment_receipt_id",
    "invoice_id",
    "allocated_amount",
    "base_allocated_amount",
    "allocated_by",
    "allocated_at"
   FROM "finance"."payment_allocations";


ALTER VIEW "public"."payment_allocations" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."payment_receipts" WITH ("security_invoker"='true') AS
 SELECT "id",
    "receipt_number",
    "payment_date",
    "amount",
    "currency",
    "exchange_rate",
    "base_amount",
    "client_id",
    "project_id",
    "financial_account_id",
    "payment_method",
    "reference",
    "description",
    "status",
    "journal_entry_id",
    "period_id",
    "created_by",
    "approved_by",
    "approved_at",
    "posted_by",
    "posted_at",
    "created_at",
    "updated_at"
   FROM "finance"."payment_receipts";


ALTER VIEW "public"."payment_receipts" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."payments" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "invoice_id" "uuid",
    "project_id" "uuid",
    "amount" numeric(12,2) NOT NULL,
    "payment_date" "date" DEFAULT CURRENT_DATE NOT NULL,
    "payment_method" "text" NOT NULL,
    "status" "text" DEFAULT 'Pending'::"text" NOT NULL,
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "organization_id" "uuid" NOT NULL,
    "journal_entry_id" "uuid",
    CONSTRAINT "payments_amount_check" CHECK (("amount" >= (0)::numeric)),
    CONSTRAINT "payments_status_check" CHECK (("status" = ANY (ARRAY['Pending'::"text", 'Paid'::"text", 'Partial Payment'::"text", 'Overdue'::"text"])))
);


ALTER TABLE "public"."payments" OWNER TO "postgres";


COMMENT ON TABLE "public"."payments" IS 'LEGACY payment table -- amount precision (numeric(12,2)) and status enum do not match the finance.* schema convention, and it predates the properly-modeled finance.payment_receipts (AR) / finance.vendor_payments (AP) tables with allocations and reconciliation. journal_entry_id / organization_id added by Migration 026 as nullable linkage infrastructure only -- confirm with the implementation team whether the frontend still writes to this table before deciding to wire it into the posting engine or retire it in favor of finance.payment_receipts / finance.vendor_payments. See compliance audit Section H1.';



CREATE TABLE IF NOT EXISTS "public"."payroll_advances" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "employee_id" "uuid" NOT NULL,
    "amount" numeric(14,2) NOT NULL,
    "purpose" "text",
    "request_date" "date" DEFAULT CURRENT_DATE NOT NULL,
    "approval_status" character varying(20) DEFAULT 'PENDING'::character varying NOT NULL,
    "approved_by" "uuid",
    "approved_at" timestamp with time zone,
    "total_deducted" numeric(14,2) DEFAULT 0 NOT NULL,
    "remaining_balance" numeric(14,2) DEFAULT 0 NOT NULL,
    "monthly_deduction" numeric(14,2),
    "start_deduction_month" character varying(7),
    "notes" "text",
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "organization_id" "uuid",
    CONSTRAINT "payroll_advances_amount_check" CHECK (("amount" > (0)::numeric)),
    CONSTRAINT "payroll_advances_approval_status_check" CHECK ((("approval_status")::"text" = ANY ((ARRAY['PENDING'::character varying, 'APPROVED'::character varying, 'REJECTED'::character varying, 'PARTIALLY_RECOVERED'::character varying, 'FULLY_RECOVERED'::character varying])::"text"[]))),
    CONSTRAINT "payroll_advances_org_required_going_forward" CHECK (("organization_id" IS NOT NULL))
);


ALTER TABLE "public"."payroll_advances" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."payroll_commissions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "employee_id" "uuid" NOT NULL,
    "project_id" "uuid",
    "commission_type" character varying(30) DEFAULT 'PERFORMANCE_BASED'::character varying NOT NULL,
    "description" "text",
    "base_amount" numeric(14,2) DEFAULT 0 NOT NULL,
    "commission_rate" numeric(7,4) DEFAULT 0 NOT NULL,
    "commission_amount" numeric(14,2) DEFAULT 0 NOT NULL,
    "period_month" character varying(7),
    "status" character varying(20) DEFAULT 'PENDING'::character varying NOT NULL,
    "approved_by" "uuid",
    "approved_at" timestamp with time zone,
    "paid_date" "date",
    "payment_ref" character varying(100),
    "notes" "text",
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "organization_id" "uuid",
    CONSTRAINT "payroll_commissions_commission_type_check" CHECK ((("commission_type")::"text" = ANY ((ARRAY['PERFORMANCE_BASED'::character varying, 'PROJECT_BASED'::character varying, 'SALES_BASED'::character varying, 'REFERRAL'::character varying, 'OTHER'::character varying])::"text"[]))),
    CONSTRAINT "payroll_commissions_org_required_going_forward" CHECK (("organization_id" IS NOT NULL)),
    CONSTRAINT "payroll_commissions_status_check" CHECK ((("status")::"text" = ANY ((ARRAY['PENDING'::character varying, 'APPROVED'::character varying, 'PAID'::character varying, 'REJECTED'::character varying, 'CANCELLED'::character varying])::"text"[])))
);


ALTER TABLE "public"."payroll_commissions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."payroll_compensation" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "employee_id" "uuid" NOT NULL,
    "compensation_type" character varying(30) DEFAULT 'MONTHLY_SALARY'::character varying NOT NULL,
    "amount" numeric(14,2) NOT NULL,
    "currency" character varying(3) DEFAULT 'PKR'::character varying NOT NULL,
    "effective_from" "date" DEFAULT CURRENT_DATE NOT NULL,
    "effective_to" "date",
    "is_active" boolean DEFAULT true NOT NULL,
    "project_id" "uuid",
    "notes" "text",
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "organization_id" "uuid",
    CONSTRAINT "payroll_compensation_amount_check" CHECK (("amount" >= (0)::numeric)),
    CONSTRAINT "payroll_compensation_compensation_type_check" CHECK ((("compensation_type")::"text" = ANY ((ARRAY['MONTHLY_SALARY'::character varying, 'HOURLY_RATE'::character varying, 'DAILY_RATE'::character varying, 'PROJECT_BASED'::character varying, 'COMMISSION_ONLY'::character varying, 'FIXED_CONTRACT'::character varying])::"text"[]))),
    CONSTRAINT "payroll_compensation_org_required_going_forward" CHECK (("organization_id" IS NOT NULL))
);


ALTER TABLE "public"."payroll_compensation" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."payroll_deductions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "employee_id" "uuid" NOT NULL,
    "deduction_type" character varying(50) DEFAULT 'OTHER'::character varying NOT NULL,
    "amount" numeric(14,2),
    "percentage" numeric(5,2),
    "effective_from" "date" DEFAULT CURRENT_DATE NOT NULL,
    "effective_to" "date",
    "is_active" boolean DEFAULT true NOT NULL,
    "notes" "text",
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "organization_id" "uuid",
    CONSTRAINT "payroll_deductions_deduction_type_check" CHECK ((("deduction_type")::"text" = ANY ((ARRAY['TAX'::character varying, 'PROVIDENT_FUND'::character varying, 'EOBI'::character varying, 'SOCIAL_SECURITY'::character varying, 'LOAN_INSTALLMENT'::character varying, 'ADVANCE_DEDUCTION'::character varying, 'ABSENCE_PENALTY'::character varying, 'OTHER'::character varying])::"text"[]))),
    CONSTRAINT "payroll_deductions_org_required_going_forward" CHECK (("organization_id" IS NOT NULL))
);


ALTER TABLE "public"."payroll_deductions" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."payroll_employee_code_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."payroll_employee_code_seq" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."payroll_employees" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "employee_code" character varying(20) NOT NULL,
    "user_id" "uuid",
    "name" character varying(200) NOT NULL,
    "email" character varying(255),
    "phone" character varying(30),
    "designation" character varying(150),
    "department" character varying(150),
    "employment_type" character varying(30) DEFAULT 'FULL_TIME'::character varying NOT NULL,
    "status" character varying(20) DEFAULT 'ACTIVE'::character varying NOT NULL,
    "join_date" "date",
    "bank_name" character varying(200),
    "bank_account" character varying(50),
    "cnic" character varying(20),
    "notes" "text",
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "organization_id" "uuid",
    CONSTRAINT "payroll_employees_employment_type_check" CHECK ((("employment_type")::"text" = ANY ((ARRAY['FULL_TIME'::character varying, 'PART_TIME'::character varying, 'CONTRACTOR'::character varying, 'INTERN'::character varying, 'CONSULTANT'::character varying])::"text"[]))),
    CONSTRAINT "payroll_employees_org_required_going_forward" CHECK (("organization_id" IS NOT NULL)),
    CONSTRAINT "payroll_employees_status_check" CHECK ((("status")::"text" = ANY ((ARRAY['ACTIVE'::character varying, 'ON_LEAVE'::character varying, 'TERMINATED'::character varying, 'SUSPENDED'::character varying])::"text"[])))
);


ALTER TABLE "public"."payroll_employees" OWNER TO "postgres";


COMMENT ON TABLE "public"."payroll_employees" IS 'Finance-side employee registry for payroll. Full HR master data lives in future hr.employees.';



COMMENT ON COLUMN "public"."payroll_employees"."organization_id" IS 'Added by P1_059 (Remediation ISS-01, Critical). Nullable by design -- see migration header. Backfilled from created_by -> profiles.organization_id in STEP 2.';



CREATE TABLE IF NOT EXISTS "public"."payroll_lines" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "payroll_run_id" "uuid" NOT NULL,
    "employee_id" "uuid" NOT NULL,
    "basic_salary" numeric(14,2) DEFAULT 0 NOT NULL,
    "housing_allow" numeric(14,2) DEFAULT 0 NOT NULL,
    "medical_allow" numeric(14,2) DEFAULT 0 NOT NULL,
    "conveyance_allow" numeric(14,2) DEFAULT 0 NOT NULL,
    "other_allowances" numeric(14,2) DEFAULT 0 NOT NULL,
    "overtime_pay" numeric(14,2) DEFAULT 0 NOT NULL,
    "commission_pay" numeric(14,2) DEFAULT 0 NOT NULL,
    "bonus_pay" numeric(14,2) DEFAULT 0 NOT NULL,
    "gross_pay" numeric(14,2) DEFAULT 0 NOT NULL,
    "tax_deduction" numeric(14,2) DEFAULT 0 NOT NULL,
    "provident_fund" numeric(14,2) DEFAULT 0 NOT NULL,
    "eobi" numeric(14,2) DEFAULT 0 NOT NULL,
    "advance_deduction" numeric(14,2) DEFAULT 0 NOT NULL,
    "other_deductions" numeric(14,2) DEFAULT 0 NOT NULL,
    "total_deductions" numeric(14,2) DEFAULT 0 NOT NULL,
    "net_pay" numeric(14,2) DEFAULT 0 NOT NULL,
    "employer_cost" numeric(14,2) DEFAULT 0 NOT NULL,
    "payment_status" character varying(20) DEFAULT 'PENDING'::character varying NOT NULL,
    "payment_date" "date",
    "payment_ref" character varying(100),
    "bank_name" character varying(200),
    "bank_account" character varying(50),
    "project_id" "uuid",
    "employee_name" character varying(200),
    "employee_code" character varying(20),
    "designation" character varying(150),
    "department" character varying(150),
    "compensation_snapshot" "jsonb",
    "deduction_snapshot" "jsonb",
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "organization_id" "uuid",
    CONSTRAINT "payroll_lines_org_required_going_forward" CHECK (("organization_id" IS NOT NULL)),
    CONSTRAINT "payroll_lines_payment_status_check" CHECK ((("payment_status")::"text" = ANY ((ARRAY['PENDING'::character varying, 'PAID'::character varying, 'PARTIALLY_PAID'::character varying, 'FAILED'::character varying])::"text"[])))
);


ALTER TABLE "public"."payroll_lines" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."payroll_reimbursements" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "employee_id" "uuid" NOT NULL,
    "project_id" "uuid",
    "amount" numeric(14,2) NOT NULL,
    "currency" character varying(3) DEFAULT 'PKR'::character varying NOT NULL,
    "category" character varying(50) DEFAULT 'OTHER'::character varying NOT NULL,
    "description" "text",
    "receipt_ref" character varying(100),
    "expense_date" "date" DEFAULT CURRENT_DATE NOT NULL,
    "status" character varying(20) DEFAULT 'PENDING'::character varying NOT NULL,
    "approved_by" "uuid",
    "approved_at" timestamp with time zone,
    "paid_date" "date",
    "payment_ref" character varying(100),
    "payroll_run_id" "uuid",
    "notes" "text",
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "organization_id" "uuid",
    CONSTRAINT "payroll_reimbursements_amount_check" CHECK (("amount" > (0)::numeric)),
    CONSTRAINT "payroll_reimbursements_category_check" CHECK ((("category")::"text" = ANY ((ARRAY['TRAVEL'::character varying, 'MEAL'::character varying, 'MEDICAL'::character varying, 'EQUIPMENT'::character varying, 'INTERNET'::character varying, 'OTHER'::character varying])::"text"[]))),
    CONSTRAINT "payroll_reimbursements_org_required_going_forward" CHECK (("organization_id" IS NOT NULL)),
    CONSTRAINT "payroll_reimbursements_status_check" CHECK ((("status")::"text" = ANY ((ARRAY['PENDING'::character varying, 'APPROVED'::character varying, 'REJECTED'::character varying, 'PAID'::character varying, 'CANCELLED'::character varying])::"text"[])))
);


ALTER TABLE "public"."payroll_reimbursements" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."payroll_runs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "payroll_period" character varying(20) NOT NULL,
    "period_start" "date" NOT NULL,
    "period_end" "date" NOT NULL,
    "status" character varying(20) DEFAULT 'DRAFT'::character varying NOT NULL,
    "total_gross_pay" numeric(16,2) DEFAULT 0 NOT NULL,
    "total_deductions" numeric(16,2) DEFAULT 0 NOT NULL,
    "total_net_pay" numeric(16,2) DEFAULT 0 NOT NULL,
    "total_employer_cost" numeric(16,2) DEFAULT 0 NOT NULL,
    "total_employees" integer DEFAULT 0 NOT NULL,
    "calculated_by" "uuid",
    "calculated_at" timestamp with time zone,
    "approved_by" "uuid",
    "approved_at" timestamp with time zone,
    "posted_by" "uuid",
    "posted_at" timestamp with time zone,
    "notes" "text",
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "organization_id" "uuid",
    CONSTRAINT "payroll_runs_org_required_going_forward" CHECK (("organization_id" IS NOT NULL)),
    CONSTRAINT "payroll_runs_status_check" CHECK ((("status")::"text" = ANY ((ARRAY['DRAFT'::character varying, 'CALCULATED'::character varying, 'UNDER_REVIEW'::character varying, 'APPROVED'::character varying, 'POSTED'::character varying, 'REJECTED'::character varying, 'CANCELLED'::character varying])::"text"[])))
);


ALTER TABLE "public"."payroll_runs" OWNER TO "postgres";


COMMENT ON TABLE "public"."payroll_runs" IS 'A payroll run is a batch calculation for a specific period. Once APPROVED the inputs are snapshotted.';



CREATE OR REPLACE VIEW "public"."permissions" WITH ("security_invoker"='true') AS
 SELECT "id",
    "code",
    "name",
    "module",
    "action",
    "description",
    "is_system",
    "created_at",
    "updated_at",
    "created_by"
   FROM "core"."permissions";


ALTER VIEW "public"."permissions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."policy_documents" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "title" "text" NOT NULL,
    "document_type" "text" DEFAULT 'POLICY'::"text" NOT NULL,
    "content" "text" NOT NULL,
    "is_active" boolean DEFAULT true NOT NULL,
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "policy_documents_document_type_check" CHECK (("document_type" = ANY (ARRAY['POLICY'::"text", 'PROCEDURE'::"text", 'CONTRACT'::"text", 'GUIDELINE'::"text", 'OTHER'::"text"])))
);


ALTER TABLE "public"."policy_documents" OWNER TO "postgres";


COMMENT ON TABLE "public"."policy_documents" IS 'Added P1_061 to support the spec 9.1/Appendix B "Policy/document Q&A" AI capability and the existing policy-qa route, which already queried this table by name before it existed. Minimal schema (title/content/document_type) -- document ingestion (upload, chunking, embeddings for real RAG) is explicitly out of scope for this migration; see remediation matrix.';



CREATE OR REPLACE VIEW "public"."postable_accounts" WITH ("security_invoker"='true') AS
 SELECT "id",
    "code",
    "name",
    "account_type",
    "normal_balance",
    "currency",
    "is_control_account",
    "report_mapping"
   FROM "finance"."postable_accounts";


ALTER VIEW "public"."postable_accounts" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."profiles" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "full_name" "text" DEFAULT ''::"text",
    "role" "text" DEFAULT 'VIEWER'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "email" "text" DEFAULT ''::"text",
    "can_create_project" boolean DEFAULT false,
    "can_delete_project" boolean DEFAULT false,
    "can_add_income" boolean DEFAULT false,
    "can_add_expense" boolean DEFAULT false,
    "can_create_invoice" boolean DEFAULT false,
    "can_delete_invoice" boolean DEFAULT false,
    "can_edit_project" boolean DEFAULT false,
    "can_edit_income" boolean DEFAULT false,
    "can_edit_expense" boolean DEFAULT false,
    "can_edit_invoice" boolean DEFAULT false,
    "can_delete_income" boolean DEFAULT false,
    "can_delete_expense" boolean DEFAULT false,
    "can_manage_budgets" boolean DEFAULT false,
    "mfa_required" boolean DEFAULT false NOT NULL,
    "organization_id" "uuid",
    "department_id" "uuid",
    "manager_id" "uuid",
    CONSTRAINT "profiles_role_check" CHECK (("role" = ANY (ARRAY['CEO'::"text", 'FINANCE_HEAD'::"text", 'ACCOUNTANT'::"text", 'PROJECT_MANAGER'::"text", 'EMPLOYEE'::"text", 'VIEWER'::"text", 'Admin'::"text", 'AUDITOR'::"text", 'HOD'::"text", 'TECHNICAL_ADMIN'::"text"])))
);


ALTER TABLE "public"."profiles" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."projects" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "name" character varying(255) NOT NULL,
    "client_name" character varying(255) NOT NULL,
    "description" "text",
    "status" character varying(50) DEFAULT 'Active'::character varying,
    "start_date" "date" NOT NULL,
    "end_date" "date",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "budget_id" "uuid",
    "deleted_at" timestamp with time zone,
    "deleted_by" "uuid",
    "organization_id" "uuid" NOT NULL,
    CONSTRAINT "projects_status_check" CHECK ((("status")::"text" = ANY ((ARRAY['Active'::character varying, 'Completed'::character varying, 'On Hold'::character varying])::"text"[])))
);


ALTER TABLE "public"."projects" OWNER TO "postgres";


COMMENT ON COLUMN "public"."projects"."organization_id" IS 'Added migration 036 (Compliance Audit Finding 4.1). Backfilled from public.profiles via user_id.';



CREATE OR REPLACE VIEW "public"."role_permissions" WITH ("security_invoker"='true') AS
 SELECT "id",
    "role_id",
    "permission_id",
    "data_scope",
    "amount_limit",
    "effective_from",
    "effective_to",
    "created_at",
    "updated_at",
    "created_by"
   FROM "core"."role_permissions";


ALTER VIEW "public"."role_permissions" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."roles" WITH ("security_invoker"='true') AS
 SELECT "id",
    "name",
    "display_name",
    "description",
    "is_system",
    "level",
    "created_at",
    "updated_at",
    "created_by"
   FROM "core"."roles";


ALTER VIEW "public"."roles" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."subscriptions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" character varying(200) NOT NULL,
    "vendor" character varying(200),
    "category" character varying(50) DEFAULT 'SOFTWARE'::character varying NOT NULL,
    "amount" numeric(14,2) NOT NULL,
    "currency" character varying(3) DEFAULT 'PKR'::character varying NOT NULL,
    "billing_frequency" character varying(20) DEFAULT 'MONTHLY'::character varying NOT NULL,
    "start_date" "date" DEFAULT CURRENT_DATE NOT NULL,
    "renewal_date" "date",
    "cancellation_notice_days" integer DEFAULT 30 NOT NULL,
    "auto_renew" boolean DEFAULT true NOT NULL,
    "project_id" "uuid",
    "owner" character varying(200),
    "status" character varying(20) DEFAULT 'ACTIVE'::character varying NOT NULL,
    "notes" "text",
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "organization_id" "uuid",
    CONSTRAINT "subscriptions_amount_check" CHECK (("amount" >= (0)::numeric)),
    CONSTRAINT "subscriptions_billing_frequency_check" CHECK ((("billing_frequency")::"text" = ANY ((ARRAY['WEEKLY'::character varying, 'MONTHLY'::character varying, 'QUARTERLY'::character varying, 'SEMI_ANNUALLY'::character varying, 'ANNUALLY'::character varying, 'BIENNIAL'::character varying, 'ONE_TIME'::character varying])::"text"[]))),
    CONSTRAINT "subscriptions_category_check" CHECK ((("category")::"text" = ANY ((ARRAY['HOSTING'::character varying, 'DOMAIN'::character varying, 'AI_API'::character varying, 'DATABASE'::character varying, 'EMAIL'::character varying, 'INTERNET'::character varying, 'RENT'::character varying, 'UTILITIES'::character varying, 'SOFTWARE'::character varying, 'HARDWARE'::character varying, 'INSURANCE'::character varying, 'MEMBERSHIP'::character varying, 'CLOUD_STORAGE'::character varying, 'CRM'::character varying, 'PROJECT_MANAGEMENT'::character varying, 'COMMUNICATION'::character varying, 'SECURITY'::character varying, 'OTHER'::character varying])::"text"[]))),
    CONSTRAINT "subscriptions_org_required_going_forward" CHECK (("organization_id" IS NOT NULL)),
    CONSTRAINT "subscriptions_status_check" CHECK ((("status")::"text" = ANY ((ARRAY['ACTIVE'::character varying, 'PAUSED'::character varying, 'CANCELLED'::character varying, 'EXPIRED'::character varying, 'PENDING_SETUP'::character varying])::"text"[])))
);


ALTER TABLE "public"."subscriptions" OWNER TO "postgres";


COMMENT ON TABLE "public"."subscriptions" IS 'Recurring costs and subscriptions with renewal tracking and annualized spend reporting.';



CREATE TABLE IF NOT EXISTS "public"."user_mfa" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "factor_id" "text" NOT NULL,
    "factor_type" "text" DEFAULT 'totp'::"text" NOT NULL,
    "is_verified" boolean DEFAULT false NOT NULL,
    "verified_at" timestamp with time zone,
    "enrolled_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "last_used_at" timestamp with time zone
);


ALTER TABLE "public"."user_mfa" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."user_roles" WITH ("security_invoker"='true') AS
 SELECT "id",
    "user_id",
    "role_id",
    "effective_from",
    "effective_to",
    "delegated_from",
    "is_active",
    "created_at",
    "updated_at",
    "created_by"
   FROM "core"."user_roles";


ALTER VIEW "public"."user_roles" OWNER TO "postgres";


COMMENT ON VIEW "public"."user_roles" IS 'Fixed migration 032 (Compliance Audit Critical R1): added security_invoker so the underlying core.user_roles RLS policy is actually enforced for the querying user, and revoked anon access.';



CREATE OR REPLACE VIEW "public"."v_audit_log" WITH ("security_invoker"='true') AS
 SELECT "id",
    "user_id",
    "user_email",
    "user_name",
    "role_snapshot",
    "session_id",
    "auth_method",
    "action",
    "entity_type",
    "entity_id",
    "status",
    "severity",
    "created_at",
    "org_timezone",
    ("ip_address")::"text" AS "ip_address",
    "user_agent",
    "request_id",
    "description",
    "old_values",
    "new_values",
    "changed_columns",
    "reason",
    "approval_comments",
    "previous_status",
    "new_status",
    "approval_level",
    "delegated_authority",
    "limit_decision",
    "attachment_ids",
    "import_batch_id",
    "external_ref",
    "related_journal_id",
    "related_payment_id",
    "project_id",
    "amount",
    "amount_currency",
    "source_module",
    "source_schema",
    "source_table",
    "ai_question",
    "ai_normalized_intent",
    "ai_selected_tool",
    "ai_generated_sql",
    "ai_template_id",
    "ai_row_count",
    "ai_model",
    "ai_latency_ms",
    "ai_cost_usd",
    "ai_input_tokens",
    "ai_output_tokens",
    "ai_refusal_reason",
    "error_message",
    "entry_hash"
   FROM "audit"."audit_log";


ALTER VIEW "public"."v_audit_log" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."v_commission_by_person" WITH ("security_invoker"='true') AS
 SELECT "person_name",
    "person_type",
    "contractor_id",
    "count"(*) AS "commission_count",
    "sum"("base_amount") AS "total_base_amount",
    "sum"("commission_amount") AS "total_commission",
    "sum"("tax_withheld") AS "total_tax_withheld",
    "sum"("net_amount") AS "total_net_amount",
    "currency"
   FROM "public"."commissions" "c"
  WHERE (("status")::"text" <> 'CANCELLED'::"text")
  GROUP BY "person_name", "person_type", "contractor_id", "currency"
  ORDER BY ("sum"("commission_amount")) DESC;


ALTER VIEW "public"."v_commission_by_person" OWNER TO "postgres";


COMMENT ON VIEW "public"."v_commission_by_person" IS 'Aggregated commission totals per person (contractor/employee), excluding cancelled.';



CREATE OR REPLACE VIEW "public"."v_commission_by_project" WITH ("security_invoker"='true') AS
 SELECT COALESCE("p"."name", 'Unassigned'::character varying) AS "project_name",
    COALESCE(("p"."id")::"text", 'none'::"text") AS "project_id",
    "count"(*) AS "commission_count",
    "sum"("c"."base_amount") AS "total_base_amount",
    "sum"("c"."commission_amount") AS "total_commission",
    "sum"("c"."tax_withheld") AS "total_tax_withheld",
    "sum"("c"."net_amount") AS "total_net_amount",
    "c"."currency"
   FROM ("public"."commissions" "c"
     LEFT JOIN "public"."projects" "p" ON (("p"."id" = "c"."project_id")))
  WHERE (("c"."status")::"text" <> 'CANCELLED'::"text")
  GROUP BY "p"."name", "p"."id", "c"."currency"
  ORDER BY ("sum"("c"."commission_amount")) DESC;


ALTER VIEW "public"."v_commission_by_project" OWNER TO "postgres";


COMMENT ON VIEW "public"."v_commission_by_project" IS 'Aggregated commission totals per project, excluding cancelled.';



CREATE OR REPLACE VIEW "public"."v_commission_by_type" WITH ("security_invoker"='true') AS
 SELECT "commission_type",
    "calculation_basis",
    "count"(*) AS "commission_count",
    "sum"("commission_amount") AS "total_commission",
    "sum"("tax_withheld") AS "total_tax_withheld",
    "sum"("net_amount") AS "total_net_amount"
   FROM "public"."commissions" "c"
  WHERE (("status")::"text" <> 'CANCELLED'::"text")
  GROUP BY "commission_type", "calculation_basis"
  ORDER BY ("sum"("commission_amount")) DESC;


ALTER VIEW "public"."v_commission_by_type" OWNER TO "postgres";


COMMENT ON VIEW "public"."v_commission_by_type" IS 'Commission breakdown by type and calculation basis, excluding cancelled.';



CREATE OR REPLACE VIEW "public"."v_commission_status_summary" WITH ("security_invoker"='true') AS
 SELECT "status",
    "count"(*) AS "commission_count",
    "sum"("commission_amount") AS "total_commission",
    "sum"("tax_withheld") AS "total_tax_withheld",
    "sum"("net_amount") AS "total_net_amount"
   FROM "public"."commissions"
  GROUP BY "status"
  ORDER BY "status";


ALTER VIEW "public"."v_commission_status_summary" OWNER TO "postgres";


COMMENT ON VIEW "public"."v_commission_status_summary" IS 'Commission totals grouped by payment status.';



CREATE OR REPLACE VIEW "public"."v_contractor_costs" WITH ("security_invoker"='true') AS
 SELECT "role",
    "count"(*) AS "contractor_count",
    "sum"("rate") AS "raw_total_rate",
    "sum"(
        CASE
            WHEN (("rate_type")::"text" = 'HOURLY'::"text") THEN ("rate" * (2080)::numeric)
            WHEN (("rate_type")::"text" = 'DAILY'::"text") THEN ("rate" * (260)::numeric)
            WHEN (("rate_type")::"text" = 'WEEKLY'::"text") THEN ("rate" * (52)::numeric)
            WHEN (("rate_type")::"text" = 'MONTHLY'::"text") THEN ("rate" * (12)::numeric)
            WHEN (("rate_type")::"text" = 'FIXED_PROJECT'::"text") THEN "rate"
            ELSE (0)::numeric
        END) AS "annualized_cost",
    "sum"(
        CASE
            WHEN (("rate_type")::"text" = 'HOURLY'::"text") THEN (("rate" * (2080)::numeric) / (12)::numeric)
            WHEN (("rate_type")::"text" = 'DAILY'::"text") THEN (("rate" * (260)::numeric) / (12)::numeric)
            WHEN (("rate_type")::"text" = 'WEEKLY'::"text") THEN (("rate" * (52)::numeric) / (12)::numeric)
            WHEN (("rate_type")::"text" = 'MONTHLY'::"text") THEN "rate"
            WHEN (("rate_type")::"text" = 'FIXED_PROJECT'::"text") THEN ("rate" / (12)::numeric)
            ELSE (0)::numeric
        END) AS "normalized_monthly"
   FROM "public"."contractors" "c"
  WHERE (("status")::"text" = 'ACTIVE'::"text")
  GROUP BY "role"
  ORDER BY ("sum"(
        CASE
            WHEN (("rate_type")::"text" = 'HOURLY'::"text") THEN ("rate" * (2080)::numeric)
            WHEN (("rate_type")::"text" = 'DAILY'::"text") THEN ("rate" * (260)::numeric)
            WHEN (("rate_type")::"text" = 'WEEKLY'::"text") THEN ("rate" * (52)::numeric)
            WHEN (("rate_type")::"text" = 'MONTHLY'::"text") THEN ("rate" * (12)::numeric)
            WHEN (("rate_type")::"text" = 'FIXED_PROJECT'::"text") THEN "rate"
            ELSE (0)::numeric
        END)) DESC;


ALTER VIEW "public"."v_contractor_costs" OWNER TO "postgres";


COMMENT ON VIEW "public"."v_contractor_costs" IS 'Role-wise annualized and normalized monthly contractor cost for active engagements.';



CREATE OR REPLACE VIEW "public"."v_contractor_expirations" WITH ("security_invoker"='true') AS
 SELECT "id",
    "name",
    "email",
    "phone",
    "company",
    "role",
    "specialization",
    "rate_type",
    "rate",
    "currency",
    "contract_start",
    "contract_end",
    "project_id",
    "status",
    "tax_withholding_pct",
    "payment_terms",
    "bank_name",
    "bank_account",
    "notes",
    "created_by",
    "created_at",
    "updated_at",
        CASE
            WHEN ("contract_end" IS NULL) THEN NULL::"text"
            WHEN ("contract_end" < CURRENT_DATE) THEN 'EXPIRED'::"text"
            WHEN ("contract_end" <= (CURRENT_DATE + 7)) THEN '7_DAYS'::"text"
            WHEN ("contract_end" <= (CURRENT_DATE + 30)) THEN '30_DAYS'::"text"
            WHEN ("contract_end" <= (CURRENT_DATE + 60)) THEN '60_DAYS'::"text"
            WHEN ("contract_end" <= (CURRENT_DATE + 90)) THEN '90_DAYS'::"text"
            ELSE 'LATER'::"text"
        END AS "expiry_bucket",
    ("contract_end" - CURRENT_DATE) AS "days_until_expiry"
   FROM "public"."contractors" "c"
  WHERE ((("status")::"text" = 'ACTIVE'::"text") AND ("contract_end" IS NOT NULL))
  ORDER BY "contract_end";


ALTER VIEW "public"."v_contractor_expirations" OWNER TO "postgres";


COMMENT ON VIEW "public"."v_contractor_expirations" IS 'Active contractors with contract end date bucketed into urgency groups.';



CREATE OR REPLACE VIEW "public"."v_contractor_project_costs" WITH ("security_invoker"='true') AS
 SELECT COALESCE("p"."name", 'Unassigned'::character varying) AS "project_name",
    COALESCE(("p"."id")::"text", 'none'::"text") AS "project_id",
    "count"(*) AS "contractor_count",
    "sum"(
        CASE
            WHEN (("c"."rate_type")::"text" = 'HOURLY'::"text") THEN ("c"."rate" * (2080)::numeric)
            WHEN (("c"."rate_type")::"text" = 'DAILY'::"text") THEN ("c"."rate" * (260)::numeric)
            WHEN (("c"."rate_type")::"text" = 'WEEKLY'::"text") THEN ("c"."rate" * (52)::numeric)
            WHEN (("c"."rate_type")::"text" = 'MONTHLY'::"text") THEN ("c"."rate" * (12)::numeric)
            WHEN (("c"."rate_type")::"text" = 'FIXED_PROJECT'::"text") THEN "c"."rate"
            ELSE (0)::numeric
        END) AS "annualized_cost",
    "sum"(
        CASE
            WHEN (("c"."rate_type")::"text" = 'HOURLY'::"text") THEN (("c"."rate" * (2080)::numeric) / (12)::numeric)
            WHEN (("c"."rate_type")::"text" = 'DAILY'::"text") THEN (("c"."rate" * (260)::numeric) / (12)::numeric)
            WHEN (("c"."rate_type")::"text" = 'WEEKLY'::"text") THEN (("c"."rate" * (52)::numeric) / (12)::numeric)
            WHEN (("c"."rate_type")::"text" = 'MONTHLY'::"text") THEN "c"."rate"
            WHEN (("c"."rate_type")::"text" = 'FIXED_PROJECT'::"text") THEN ("c"."rate" / (12)::numeric)
            ELSE (0)::numeric
        END) AS "normalized_monthly"
   FROM ("public"."contractors" "c"
     LEFT JOIN "public"."projects" "p" ON (("p"."id" = "c"."project_id")))
  WHERE (("c"."status")::"text" = 'ACTIVE'::"text")
  GROUP BY "p"."name", "p"."id"
  ORDER BY ("sum"(
        CASE
            WHEN (("c"."rate_type")::"text" = 'HOURLY'::"text") THEN ("c"."rate" * (2080)::numeric)
            WHEN (("c"."rate_type")::"text" = 'DAILY'::"text") THEN ("c"."rate" * (260)::numeric)
            WHEN (("c"."rate_type")::"text" = 'WEEKLY'::"text") THEN ("c"."rate" * (52)::numeric)
            WHEN (("c"."rate_type")::"text" = 'MONTHLY'::"text") THEN ("c"."rate" * (12)::numeric)
            WHEN (("c"."rate_type")::"text" = 'FIXED_PROJECT'::"text") THEN "c"."rate"
            ELSE (0)::numeric
        END)) DESC;


ALTER VIEW "public"."v_contractor_project_costs" OWNER TO "postgres";


COMMENT ON VIEW "public"."v_contractor_project_costs" IS 'Project-wise annualized and normalized monthly contractor cost.';



CREATE OR REPLACE VIEW "public"."v_payroll_summary" AS
SELECT
    NULL::"uuid" AS "run_id",
    NULL::character varying(20) AS "payroll_period",
    NULL::character varying(20) AS "run_status",
    NULL::numeric(16,2) AS "total_gross_pay",
    NULL::numeric(16,2) AS "total_deductions",
    NULL::numeric(16,2) AS "total_net_pay",
    NULL::numeric(16,2) AS "total_employer_cost",
    NULL::integer AS "total_employees",
    NULL::timestamp with time zone AS "created_at",
    NULL::bigint AS "line_count",
    NULL::bigint AS "paid_count",
    NULL::numeric AS "unpaid_amount";


ALTER VIEW "public"."v_payroll_summary" OWNER TO "postgres";


COMMENT ON VIEW "public"."v_payroll_summary" IS 'Aggregated payroll run summary with payment tracking.';



CREATE OR REPLACE VIEW "public"."v_permissions" WITH ("security_invoker"='true') AS
 SELECT "id",
    "code",
    "name",
    "module",
    "action",
    "description",
    "is_system",
    "created_at",
    "updated_at",
    "created_by"
   FROM "core"."permissions";


ALTER VIEW "public"."v_permissions" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."v_role_permissions" WITH ("security_invoker"='true') AS
 SELECT "rp"."id",
    "rp"."role_id",
    "rp"."permission_id",
    "p"."code" AS "permission_code",
    "p"."name" AS "permission_name",
    "p"."module" AS "permission_module",
    "rp"."data_scope",
    "rp"."amount_limit",
    "rp"."effective_from",
    "rp"."effective_to",
    "rp"."created_at",
    "rp"."updated_at",
    "rp"."created_by"
   FROM ("core"."role_permissions" "rp"
     JOIN "core"."permissions" "p" ON (("p"."id" = "rp"."permission_id")));


ALTER VIEW "public"."v_role_permissions" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."v_roles" WITH ("security_invoker"='true') AS
 SELECT "id",
    "name",
    "display_name",
    "description",
    "is_system",
    "level",
    "created_at",
    "updated_at",
    "created_by"
   FROM "core"."roles";


ALTER VIEW "public"."v_roles" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."v_subscription_renewals" WITH ("security_invoker"='true') AS
 SELECT "id",
    "name",
    "vendor",
    "category",
    "amount",
    "currency",
    "billing_frequency",
    "start_date",
    "renewal_date",
    "cancellation_notice_days",
    "auto_renew",
    "project_id",
    "owner",
    "status",
    "notes",
    "created_by",
    "created_at",
    "updated_at",
        CASE
            WHEN ("renewal_date" IS NULL) THEN NULL::"text"
            WHEN ("renewal_date" < CURRENT_DATE) THEN 'OVERDUE'::"text"
            WHEN ("renewal_date" <= (CURRENT_DATE + 7)) THEN '7_DAYS'::"text"
            WHEN ("renewal_date" <= (CURRENT_DATE + 30)) THEN '30_DAYS'::"text"
            WHEN ("renewal_date" <= (CURRENT_DATE + 60)) THEN '60_DAYS'::"text"
            WHEN ("renewal_date" <= (CURRENT_DATE + 90)) THEN '90_DAYS'::"text"
            ELSE 'LATER'::"text"
        END AS "renewal_bucket",
    ("renewal_date" - CURRENT_DATE) AS "days_until_renewal",
    (("renewal_date" - (("cancellation_notice_days" || ' days'::"text"))::interval))::"date" AS "notice_date"
   FROM "public"."subscriptions" "s"
  WHERE ((("status")::"text" = 'ACTIVE'::"text") AND ("renewal_date" IS NOT NULL))
  ORDER BY "renewal_date";


ALTER VIEW "public"."v_subscription_renewals" OWNER TO "postgres";


COMMENT ON VIEW "public"."v_subscription_renewals" IS 'Active subscriptions with renewal date bucketed into urgency groups.';



CREATE OR REPLACE VIEW "public"."v_subscription_spend" WITH ("security_invoker"='true') AS
 SELECT "category",
    "count"(*) AS "subscription_count",
    "sum"("amount") AS "raw_total",
    "sum"(
        CASE
            WHEN (("billing_frequency")::"text" = 'WEEKLY'::"text") THEN ("amount" * (52)::numeric)
            WHEN (("billing_frequency")::"text" = 'MONTHLY'::"text") THEN ("amount" * (12)::numeric)
            WHEN (("billing_frequency")::"text" = 'QUARTERLY'::"text") THEN ("amount" * (4)::numeric)
            WHEN (("billing_frequency")::"text" = 'SEMI_ANNUALLY'::"text") THEN ("amount" * (2)::numeric)
            WHEN (("billing_frequency")::"text" = 'ANNUALLY'::"text") THEN "amount"
            WHEN (("billing_frequency")::"text" = 'BIENNIAL'::"text") THEN ("amount" / (2)::numeric)
            ELSE (0)::numeric
        END) AS "annualized_amount",
    "sum"(
        CASE
            WHEN (("billing_frequency")::"text" = 'WEEKLY'::"text") THEN (("amount" * (52)::numeric) / (12)::numeric)
            WHEN (("billing_frequency")::"text" = 'MONTHLY'::"text") THEN "amount"
            WHEN (("billing_frequency")::"text" = 'QUARTERLY'::"text") THEN (("amount" * (4)::numeric) / (12)::numeric)
            WHEN (("billing_frequency")::"text" = 'SEMI_ANNUALLY'::"text") THEN (("amount" * (2)::numeric) / (12)::numeric)
            WHEN (("billing_frequency")::"text" = 'ANNUALLY'::"text") THEN ("amount" / (12)::numeric)
            WHEN (("billing_frequency")::"text" = 'BIENNIAL'::"text") THEN ("amount" / (24)::numeric)
            ELSE (0)::numeric
        END) AS "normalized_monthly"
   FROM "public"."subscriptions" "s"
  WHERE (("status")::"text" = 'ACTIVE'::"text")
  GROUP BY "category"
  ORDER BY ("sum"(
        CASE
            WHEN (("billing_frequency")::"text" = 'WEEKLY'::"text") THEN ("amount" * (52)::numeric)
            WHEN (("billing_frequency")::"text" = 'MONTHLY'::"text") THEN ("amount" * (12)::numeric)
            WHEN (("billing_frequency")::"text" = 'QUARTERLY'::"text") THEN ("amount" * (4)::numeric)
            WHEN (("billing_frequency")::"text" = 'SEMI_ANNUALLY'::"text") THEN ("amount" * (2)::numeric)
            WHEN (("billing_frequency")::"text" = 'ANNUALLY'::"text") THEN "amount"
            WHEN (("billing_frequency")::"text" = 'BIENNIAL'::"text") THEN ("amount" / (2)::numeric)
            ELSE (0)::numeric
        END)) DESC;


ALTER VIEW "public"."v_subscription_spend" OWNER TO "postgres";


COMMENT ON VIEW "public"."v_subscription_spend" IS 'Category-wise annualized and normalized monthly spend for active subscriptions.';



CREATE OR REPLACE VIEW "public"."v_user_roles" WITH ("security_invoker"='true') AS
 SELECT "ur"."id",
    "ur"."user_id",
    "ur"."role_id",
    "r"."name" AS "role",
    "r"."display_name" AS "role_display_name",
    "r"."level" AS "role_level",
    "ur"."is_active",
    "ur"."effective_from",
    "ur"."effective_to",
    "ur"."delegated_from",
    "ur"."created_at",
    "ur"."updated_at",
    "ur"."created_by"
   FROM ("core"."user_roles" "ur"
     JOIN "core"."roles" "r" ON (("r"."id" = "ur"."role_id")));


ALTER VIEW "public"."v_user_roles" OWNER TO "postgres";


CREATE OR REPLACE VIEW "reporting"."trial_balance" WITH ("security_invoker"='true') AS
 SELECT "je"."organization_id",
    "je"."fiscal_year_id",
    "je"."period_id",
    "jl"."account_id",
    "coa"."code" AS "account_code",
    "coa"."name" AS "account_name",
    "coa"."account_type",
    "coa"."normal_balance",
    "sum"("jl"."debit_amount") AS "debit",
    "sum"("jl"."credit_amount") AS "credit",
    "sum"(COALESCE("jl"."base_debit", "jl"."debit_amount")) AS "base_debit",
    "sum"(COALESCE("jl"."base_credit", "jl"."credit_amount")) AS "base_credit",
    "sum"((COALESCE("jl"."base_debit", "jl"."debit_amount") - COALESCE("jl"."base_credit", "jl"."credit_amount"))) AS "signed_base_balance"
   FROM (("finance"."journal_entries" "je"
     JOIN "finance"."journal_lines" "jl" ON (("jl"."journal_entry_id" = "je"."id")))
     JOIN "finance"."chart_of_accounts" "coa" ON (("coa"."id" = "jl"."account_id")))
  WHERE ("je"."status" = 'POSTED'::"text")
  GROUP BY "je"."organization_id", "je"."fiscal_year_id", "je"."period_id", "jl"."account_id", "coa"."code", "coa"."name", "coa"."account_type", "coa"."normal_balance";


ALTER VIEW "reporting"."trial_balance" OWNER TO "postgres";


CREATE OR REPLACE VIEW "reporting"."balance_sheet" WITH ("security_invoker"='true') AS
 SELECT "organization_id",
    "fiscal_year_id",
    "period_id",
    "account_id",
    "account_code",
    "account_name",
    "account_type",
    "debit",
    "credit",
    "base_debit",
    "base_credit",
        CASE
            WHEN ("account_type" = ANY (ARRAY['ASSET'::"text", 'OTHER_EXPENSE'::"text"])) THEN ("base_debit" - "base_credit")
            ELSE ("base_credit" - "base_debit")
        END AS "amount"
   FROM "reporting"."trial_balance"
  WHERE ("account_type" = ANY (ARRAY['ASSET'::"text", 'LIABILITY'::"text", 'EQUITY'::"text"]));


ALTER VIEW "reporting"."balance_sheet" OWNER TO "postgres";


CREATE OR REPLACE VIEW "reporting"."budget_vs_actual" WITH ("security_invoker"='true') AS
 SELECT "b"."id" AS "budget_id",
    "b"."name" AS "budget_name",
    "b"."category" AS "budget_category",
    "b"."total_amount" AS "budgeted_amount",
    "b"."start_date",
    "b"."end_date",
    COALESCE("sum"(
        CASE
            WHEN ("coa"."normal_balance" = 'DEBIT'::"text") THEN (COALESCE("jl"."base_debit", "jl"."debit_amount") - COALESCE("jl"."base_credit", "jl"."credit_amount"))
            ELSE (COALESCE("jl"."base_credit", "jl"."credit_amount") - COALESCE("jl"."base_debit", "jl"."debit_amount"))
        END), (0)::numeric) AS "actual_amount",
    (("b"."total_amount" - COALESCE("sum"(
        CASE
            WHEN ("coa"."normal_balance" = 'DEBIT'::"text") THEN (COALESCE("jl"."base_debit", "jl"."debit_amount") - COALESCE("jl"."base_credit", "jl"."credit_amount"))
            ELSE (COALESCE("jl"."base_credit", "jl"."credit_amount") - COALESCE("jl"."base_debit", "jl"."debit_amount"))
        END), (0)::numeric)) - COALESCE(( SELECT "sum"(("vb"."total_amount" - "vb"."amount_paid")) AS "sum"
           FROM "finance"."vendor_bills" "vb"
          WHERE (("vb"."project_id" = "p"."id") AND ("vb"."status" = 'APPROVED'::"text"))), (0)::numeric)) AS "remaining_amount",
        CASE
            WHEN ("b"."total_amount" = (0)::numeric) THEN (0)::numeric
            ELSE "round"((((COALESCE("sum"(
            CASE
                WHEN ("coa"."normal_balance" = 'DEBIT'::"text") THEN (COALESCE("jl"."base_debit", "jl"."debit_amount") - COALESCE("jl"."base_credit", "jl"."credit_amount"))
                ELSE (COALESCE("jl"."base_credit", "jl"."credit_amount") - COALESCE("jl"."base_debit", "jl"."debit_amount"))
            END), (0)::numeric) + COALESCE(( SELECT "sum"(("vb"."total_amount" - "vb"."amount_paid")) AS "sum"
               FROM "finance"."vendor_bills" "vb"
              WHERE (("vb"."project_id" = "p"."id") AND ("vb"."status" = 'APPROVED'::"text"))), (0)::numeric)) / "b"."total_amount") * (100)::numeric), 2)
        END AS "utilization_pct",
    "p"."id" AS "project_id",
    "p"."name" AS "project_name",
    COALESCE(( SELECT "sum"(("vb"."total_amount" - "vb"."amount_paid")) AS "sum"
           FROM "finance"."vendor_bills" "vb"
          WHERE (("vb"."project_id" = "p"."id") AND ("vb"."status" = 'APPROVED'::"text"))), (0)::numeric) AS "committed_amount"
   FROM (((("public"."budgets" "b"
     LEFT JOIN "public"."projects" "p" ON (("p"."budget_id" = "b"."id")))
     LEFT JOIN "finance"."journal_entries" "je" ON ((("je"."project_id" = "p"."id") AND ("je"."status" = 'POSTED'::"text") AND ("je"."source_type" = 'EXPENSE'::"text"))))
     LEFT JOIN "finance"."journal_lines" "jl" ON (("jl"."journal_entry_id" = "je"."id")))
     LEFT JOIN "finance"."chart_of_accounts" "coa" ON ((("coa"."id" = "jl"."account_id") AND ("coa"."account_type" = ANY (ARRAY['EXPENSE'::"text", 'COST_OF_SALES'::"text"])))))
  GROUP BY "b"."id", "b"."name", "b"."category", "b"."total_amount", "b"."start_date", "b"."end_date", "p"."id", "p"."name";


ALTER VIEW "reporting"."budget_vs_actual" OWNER TO "postgres";


COMMENT ON VIEW "reporting"."budget_vs_actual" IS 'BUG-019 fix (database audit): added committed_amount (approved-but-unpaid vendor bills on the same project) so remaining_amount/utilization_pct reflect true available budget, per spec.';



CREATE OR REPLACE VIEW "reporting"."budget_category_summary" WITH ("security_invoker"='true') AS
 SELECT "b"."category",
    "count"(DISTINCT "b"."id") AS "budget_count",
    "sum"("b"."total_amount") AS "total_budgeted",
    COALESCE("sum"("bva"."actual_amount"), (0)::numeric) AS "total_actual",
    COALESCE("sum"("bva"."remaining_amount"), (0)::numeric) AS "total_remaining",
        CASE
            WHEN ("sum"("b"."total_amount") = (0)::numeric) THEN (0)::numeric
            ELSE "round"(((COALESCE("sum"("bva"."actual_amount"), (0)::numeric) / "sum"("b"."total_amount")) * (100)::numeric), 2)
        END AS "overall_utilization_pct"
   FROM ("public"."budgets" "b"
     LEFT JOIN "reporting"."budget_vs_actual" "bva" ON (("bva"."budget_id" = "b"."id")))
  GROUP BY "b"."category";


ALTER VIEW "reporting"."budget_category_summary" OWNER TO "postgres";


CREATE OR REPLACE VIEW "reporting"."budget_gl_actual" WITH ("security_invoker"='true') AS
 SELECT "bl"."id" AS "budget_line_id",
    "bl"."budget_id",
    "b"."name" AS "budget_name",
    "bl"."account_id",
    "coa"."code" AS "account_code",
    "coa"."name" AS "account_name",
    "bl"."budgeted_amount" AS "allocated_amount",
    COALESCE("sum"(
        CASE
            WHEN ("coa"."normal_balance" = 'DEBIT'::"text") THEN (COALESCE("jl"."base_debit", "jl"."debit_amount") - COALESCE("jl"."base_credit", "jl"."credit_amount"))
            ELSE (COALESCE("jl"."base_credit", "jl"."credit_amount") - COALESCE("jl"."base_debit", "jl"."debit_amount"))
        END), (0)::numeric) AS "actual_spent",
    ("bl"."budgeted_amount" - COALESCE("sum"(
        CASE
            WHEN ("coa"."normal_balance" = 'DEBIT'::"text") THEN (COALESCE("jl"."base_debit", "jl"."debit_amount") - COALESCE("jl"."base_credit", "jl"."credit_amount"))
            ELSE (COALESCE("jl"."base_credit", "jl"."credit_amount") - COALESCE("jl"."base_debit", "jl"."debit_amount"))
        END), (0)::numeric)) AS "remaining"
   FROM (((("finance"."budget_lines" "bl"
     JOIN "public"."budgets" "b" ON (("b"."id" = "bl"."budget_id")))
     LEFT JOIN "finance"."chart_of_accounts" "coa" ON (("coa"."id" = "bl"."account_id")))
     LEFT JOIN "finance"."journal_lines" "jl" ON (("jl"."account_id" = "bl"."account_id")))
     LEFT JOIN "finance"."journal_entries" "je" ON ((("je"."id" = "jl"."journal_entry_id") AND ("je"."status" = 'POSTED'::"text") AND ("je"."transaction_date" >= "b"."start_date") AND (("je"."transaction_date" <= "b"."end_date") OR ("b"."end_date" IS NULL)))))
  GROUP BY "bl"."id", "bl"."budget_id", "b"."name", "bl"."account_id", "coa"."code", "coa"."name", "bl"."budgeted_amount";


ALTER VIEW "reporting"."budget_gl_actual" OWNER TO "postgres";


COMMENT ON VIEW "reporting"."budget_gl_actual" IS 'Budget-vs-GL actuals, spec Section 13.2. Re-pointed from legacy public.budget_lines to canonical finance.budget_lines (Migration 031, corrected paren-count from the initial attempt). security_invoker preserved.';



CREATE OR REPLACE VIEW "reporting"."cash_flow" WITH ("security_invoker"='true') AS
 SELECT "organization_id",
    "fiscal_year_id",
    "period_id",
    "account_id",
    "account_code",
    "account_name",
    "account_type",
    "report_mapping",
    "base_debit",
    "base_credit",
    ("base_debit" - "base_credit") AS "net_cash_movement"
   FROM ( SELECT "tb"."organization_id",
            "tb"."fiscal_year_id",
            "tb"."period_id",
            "tb"."account_id",
            "tb"."account_code",
            "tb"."account_name",
            "tb"."account_type",
            "tb"."normal_balance",
            "tb"."debit",
            "tb"."credit",
            "tb"."base_debit",
            "tb"."base_credit",
            "tb"."signed_base_balance",
            "coa"."report_mapping"
           FROM ("reporting"."trial_balance" "tb"
             JOIN "finance"."chart_of_accounts" "coa" ON (("coa"."id" = "tb"."account_id")))
          WHERE ("tb"."account_type" = 'ASSET'::"text")) "q"
  WHERE (("report_mapping" IS NOT NULL) AND (("upper"("report_mapping") ~~ '%CASH%'::"text") OR ("upper"("report_mapping") ~~ '%BANK%'::"text") OR ("upper"("report_mapping") ~~ '%WALLET%'::"text")));


ALTER VIEW "reporting"."cash_flow" OWNER TO "postgres";


CREATE OR REPLACE VIEW "reporting"."changes_in_equity" WITH ("security_invoker"='true') AS
 SELECT "organization_id",
    "fiscal_year_id",
    "period_id",
    "account_id",
    "account_code",
    "account_name",
    "debit",
    "credit",
    "base_debit",
    "base_credit",
    ("base_credit" - "base_debit") AS "equity_change"
   FROM "reporting"."trial_balance"
  WHERE ("account_type" = 'EQUITY'::"text");


ALTER VIEW "reporting"."changes_in_equity" OWNER TO "postgres";


CREATE OR REPLACE VIEW "reporting"."payable_aging" WITH ("security_invoker"='true') AS
 SELECT "vb"."id" AS "bill_id",
    "vb"."bill_number",
    "vb"."vendor_id",
    "v"."name" AS "vendor_name",
    "vb"."project_id",
    "vb"."total_amount",
    "vb"."amount_paid",
    "vb"."outstanding_amount",
    "vb"."due_date",
    "vb"."bill_date",
    "vb"."status",
        CASE
            WHEN ("vb"."outstanding_amount" <= (0)::numeric) THEN (0)::numeric
            WHEN ("vb"."due_date" >= CURRENT_DATE) THEN "vb"."outstanding_amount"
            ELSE (0)::numeric
        END AS "current_amount",
        CASE
            WHEN (("vb"."due_date" < CURRENT_DATE) AND ("vb"."due_date" >= (CURRENT_DATE - '30 days'::interval))) THEN "vb"."outstanding_amount"
            ELSE (0)::numeric
        END AS "overdue_1_30_days",
        CASE
            WHEN (("vb"."due_date" < (CURRENT_DATE - '30 days'::interval)) AND ("vb"."due_date" >= (CURRENT_DATE - '60 days'::interval))) THEN "vb"."outstanding_amount"
            ELSE (0)::numeric
        END AS "overdue_31_60_days",
        CASE
            WHEN (("vb"."due_date" < (CURRENT_DATE - '60 days'::interval)) AND ("vb"."due_date" >= (CURRENT_DATE - '90 days'::interval))) THEN "vb"."outstanding_amount"
            ELSE (0)::numeric
        END AS "overdue_61_90_days",
        CASE
            WHEN ("vb"."due_date" < (CURRENT_DATE - '90 days'::interval)) THEN "vb"."outstanding_amount"
            ELSE (0)::numeric
        END AS "overdue_over_90_days"
   FROM ("finance"."vendor_bills" "vb"
     JOIN "finance"."vendors" "v" ON (("v"."id" = "vb"."vendor_id")))
  WHERE ("vb"."status" = ANY (ARRAY['POSTED'::"text", 'PARTIALLY_PAID'::"text", 'PAID'::"text"]));


ALTER VIEW "reporting"."payable_aging" OWNER TO "postgres";


CREATE OR REPLACE VIEW "reporting"."pnl" WITH ("security_invoker"='true') AS
 SELECT "organization_id",
    "fiscal_year_id",
    "period_id",
    "account_id",
    "account_code",
    "account_name",
    "account_type",
    "debit",
    "credit",
    "base_debit",
    "base_credit",
        CASE
            WHEN ("account_type" = ANY (ARRAY['REVENUE'::"text", 'OTHER_INCOME'::"text"])) THEN ("base_credit" - "base_debit")
            ELSE ("base_debit" - "base_credit")
        END AS "amount"
   FROM "reporting"."trial_balance"
  WHERE ("account_type" = ANY (ARRAY['REVENUE'::"text", 'COST_OF_SALES'::"text", 'OPERATING_EXPENSE'::"text", 'OTHER_INCOME'::"text", 'OTHER_EXPENSE'::"text"]));


ALTER VIEW "reporting"."pnl" OWNER TO "postgres";


CREATE OR REPLACE VIEW "reporting"."receivable_aging" WITH ("security_invoker"='true') AS
 SELECT "id" AS "invoice_id",
    "invoice_number",
    "client_name",
    "project_id",
    "currency",
    "total_amount",
    "base_total_amount" AS "total_base_amount",
    "amount_paid",
    "base_amount_paid" AS "paid_base_amount",
    "outstanding_amount",
    "base_outstanding_amount" AS "outstanding_base_amount",
    "due_date",
    "issue_date",
    "status",
        CASE
            WHEN ("outstanding_amount" <= (0)::numeric) THEN (0)::numeric
            WHEN ("due_date" >= CURRENT_DATE) THEN "base_outstanding_amount"
            ELSE (0)::numeric
        END AS "current_amount",
        CASE
            WHEN (("due_date" < CURRENT_DATE) AND ("due_date" >= (CURRENT_DATE - '30 days'::interval))) THEN "base_outstanding_amount"
            ELSE (0)::numeric
        END AS "overdue_1_30_days",
        CASE
            WHEN (("due_date" < (CURRENT_DATE - '30 days'::interval)) AND ("due_date" >= (CURRENT_DATE - '60 days'::interval))) THEN "base_outstanding_amount"
            ELSE (0)::numeric
        END AS "overdue_31_60_days",
        CASE
            WHEN (("due_date" < (CURRENT_DATE - '60 days'::interval)) AND ("due_date" >= (CURRENT_DATE - '90 days'::interval))) THEN "base_outstanding_amount"
            ELSE (0)::numeric
        END AS "overdue_61_90_days",
        CASE
            WHEN ("due_date" < (CURRENT_DATE - '90 days'::interval)) THEN "base_outstanding_amount"
            ELSE (0)::numeric
        END AS "overdue_over_90_days"
   FROM "public"."invoices" "i"
  WHERE (("status")::"text" = ANY ((ARRAY['ISSUED'::character varying, 'PARTIALLY_PAID'::character varying, 'PAID'::character varying, 'OVERDUE'::character varying])::"text"[]));


ALTER VIEW "reporting"."receivable_aging" OWNER TO "postgres";


CREATE OR REPLACE VIEW "reporting"."reconciliation_summary" WITH ("security_invoker"='true') AS
 SELECT "fa"."id" AS "financial_account_id",
    "fa"."account_name",
    "fa"."institution_name",
    "fa"."currency",
    "fa"."masked_identifier",
    COALESCE("ledger"."ledger_balance", (0)::numeric) AS "ledger_balance",
    COALESCE("latest"."closing_balance", (0)::numeric) AS "statement_balance",
    (COALESCE("ledger"."ledger_balance", (0)::numeric) - COALESCE("latest"."closing_balance", (0)::numeric)) AS "difference",
    COALESCE("cnts"."total_lines", (0)::bigint) AS "total_lines",
    COALESCE("cnts"."matched_lines", (0)::bigint) AS "matched_lines",
    COALESCE("cnts"."unreconciled_lines", (0)::bigint) AS "unreconciled_lines",
        CASE
            WHEN (COALESCE("cnts"."total_lines", (0)::bigint) = 0) THEN (100)::numeric
            ELSE "round"((((COALESCE("cnts"."matched_lines", (0)::bigint))::numeric / (COALESCE("cnts"."total_lines", (0)::bigint))::numeric) * (100)::numeric), 1)
        END AS "reconciliation_pct",
    "latest"."statement_date" AS "latest_statement_date"
   FROM ((("finance"."financial_accounts" "fa"
     LEFT JOIN LATERAL ( SELECT "sum"(("jl"."debit_amount" - "jl"."credit_amount")) AS "ledger_balance"
           FROM ("finance"."journal_lines" "jl"
             JOIN "finance"."journal_entries" "je" ON (("je"."id" = "jl"."journal_entry_id")))
          WHERE (("jl"."account_id" = "fa"."linked_ledger_account_id") AND ("je"."status" = 'posted'::"text"))) "ledger" ON (true))
     LEFT JOIN LATERAL ( SELECT "bank_statements"."closing_balance",
            "bank_statements"."statement_date"
           FROM "finance"."bank_statements"
          WHERE ("bank_statements"."financial_account_id" = "fa"."id")
          ORDER BY "bank_statements"."statement_date" DESC
         LIMIT 1) "latest" ON (true))
     LEFT JOIN LATERAL ( SELECT "count"(*) AS "total_lines",
            "count"(*) FILTER (WHERE ("sl"."reconciliation_status" = ANY (ARRAY['MATCHED'::"text", 'MANUAL_MATCH'::"text"]))) AS "matched_lines",
            "count"(*) FILTER (WHERE ("sl"."reconciliation_status" = 'UNRECONCILED'::"text")) AS "unreconciled_lines"
           FROM ("finance"."statement_lines" "sl"
             JOIN "finance"."bank_statements" "bs" ON (("bs"."id" = "sl"."bank_statement_id")))
          WHERE ("bs"."financial_account_id" = "fa"."id")) "cnts" ON (true))
  WHERE ("fa"."is_active" = true);


ALTER VIEW "reporting"."reconciliation_summary" OWNER TO "postgres";


CREATE OR REPLACE VIEW "reporting"."unreconciled_lines" WITH ("security_invoker"='true') AS
 SELECT "sl"."id",
    "sl"."line_number",
    "sl"."transaction_date",
    "sl"."description",
    "sl"."reference",
    "sl"."counterparty",
    "sl"."amount",
    "sl"."balance_after",
    "fa"."account_name" AS "financial_account_name",
    "fa"."institution_name",
    "fa"."currency",
    "fa"."masked_identifier",
    "fa"."id" AS "financial_account_id"
   FROM (("finance"."statement_lines" "sl"
     JOIN "finance"."bank_statements" "bs" ON (("bs"."id" = "sl"."bank_statement_id")))
     JOIN "finance"."financial_accounts" "fa" ON (("fa"."id" = "bs"."financial_account_id")))
  WHERE ("sl"."reconciliation_status" = 'UNRECONCILED'::"text")
  ORDER BY "sl"."transaction_date" DESC, "fa"."account_name";


ALTER VIEW "reporting"."unreconciled_lines" OWNER TO "postgres";


COMMENT ON VIEW "reporting"."unreconciled_lines" IS 'P1_061 (corrected): added financial_account_id, appended as the last column so CREATE OR REPLACE VIEW does not attempt to rename/renumber any existing column. No existing column removed, renamed, or reordered.';



CREATE OR REPLACE VIEW "reporting"."v_asset_register" WITH ("security_invoker"='true') AS
 SELECT "fa"."id",
    "fa"."code",
    "fa"."name",
    "ac"."name" AS "category_name",
    "fa"."purchase_date",
    "fa"."purchase_cost",
    "fa"."currency" AS "currency_code",
    "fa"."base_cost",
    "fa"."accumulated_depreciation",
    "fa"."net_book_value",
    "fa"."serial_number",
    "fa"."location",
    "fa"."status",
    COALESCE("fa"."useful_life_months", "ac"."useful_life_months") AS "useful_life_months",
    COALESCE("fa"."residual_value_pct", "ac"."residual_value_pct") AS "residual_value_pct",
    "p"."name" AS "project_name",
    "fa"."disposal_date",
    "fa"."disposal_value",
    "fa"."gain_loss_amount"
   FROM (("finance"."fixed_assets" "fa"
     JOIN "finance"."asset_categories" "ac" ON (("ac"."id" = "fa"."category_id")))
     LEFT JOIN "public"."projects" "p" ON (("p"."id" = "fa"."project_id")))
  WHERE (("fa"."status")::"text" <> 'pending_capitalization'::"text");


ALTER VIEW "reporting"."v_asset_register" OWNER TO "postgres";


CREATE OR REPLACE VIEW "reporting"."v_cash_position" WITH ("security_invoker"='true') AS
 SELECT "fa"."id" AS "account_id",
    "fa"."account_name",
    "fa"."institution_name",
    "fa"."account_type",
    "fa"."currency",
    "fa"."opening_balance",
    (("fa"."opening_balance" + COALESCE("sum"("jl"."debit_amount") FILTER (WHERE ("je"."status" = 'POSTED'::"text")), (0)::numeric)) - COALESCE("sum"("jl"."credit_amount") FILTER (WHERE ("je"."status" = 'POSTED'::"text")), (0)::numeric)) AS "current_balance",
    (("fa"."opening_balance" + COALESCE("sum"("jl"."base_debit") FILTER (WHERE ("je"."status" = 'POSTED'::"text")), (0)::numeric)) - COALESCE("sum"("jl"."base_credit") FILTER (WHERE ("je"."status" = 'POSTED'::"text")), (0)::numeric)) AS "current_balance_base",
    "org"."base_currency",
    "fa"."is_active",
    "fa"."is_default",
    "org"."id" AS "organization_id",
    "now"() AS "data_as_of"
   FROM ((("finance"."financial_accounts" "fa"
     LEFT JOIN "finance"."journal_lines" "jl" ON (("jl"."account_id" = "fa"."linked_ledger_account_id")))
     LEFT JOIN "finance"."journal_entries" "je" ON (("je"."id" = "jl"."journal_entry_id")))
     CROSS JOIN "core"."organizations" "org")
  WHERE ("fa"."is_active" = true)
  GROUP BY "fa"."id", "fa"."account_name", "fa"."institution_name", "fa"."account_type", "fa"."currency", "fa"."opening_balance", "fa"."is_active", "fa"."is_default", "org"."id", "org"."base_currency";


ALTER VIEW "reporting"."v_cash_position" OWNER TO "postgres";


CREATE OR REPLACE VIEW "reporting"."v_depreciation_summary" WITH ("security_invoker"='true') AS
 SELECT "ds"."fiscal_year_id",
    "fy"."name" AS "fiscal_year_name",
    "ds"."period_id",
    "ap"."name" AS "period_name",
    "ap"."start_date",
    "ap"."end_date",
    "count"(DISTINCT "ds"."asset_id") AS "assets_depreciated",
    "sum"("ds"."depreciation_amount") AS "total_depreciation",
    "sum"("ds"."opening_nbv") AS "total_opening_nbv",
    "sum"("ds"."closing_nbv") AS "total_closing_nbv",
    "count"(*) FILTER (WHERE (("ds"."status")::"text" = 'posted'::"text")) AS "posted_count",
    "count"(*) FILTER (WHERE (("ds"."status")::"text" = 'calculated'::"text")) AS "pending_count"
   FROM (("finance"."depreciation_schedule" "ds"
     JOIN "finance"."fiscal_years" "fy" ON (("fy"."id" = "ds"."fiscal_year_id")))
     JOIN "finance"."accounting_periods" "ap" ON (("ap"."id" = "ds"."period_id")))
  GROUP BY "ds"."fiscal_year_id", "fy"."name", "ds"."period_id", "ap"."name", "ap"."start_date", "ap"."end_date"
  ORDER BY "fy"."name", "ap"."start_date";


ALTER VIEW "reporting"."v_depreciation_summary" OWNER TO "postgres";


CREATE OR REPLACE VIEW "reporting"."v_legacy_archive_status" WITH ("security_invoker"='true') AS
 SELECT 'financial_accounts'::"text" AS "entity",
    ( SELECT "count"(*) AS "count"
           FROM "finance"."financial_accounts") AS "canonical_rows",
    ( SELECT "count"(*) AS "count"
           FROM "legacy"."financial_accounts") AS "archived_legacy_rows"
UNION ALL
 SELECT 'budget_lines'::"text" AS "entity",
    ( SELECT "count"(*) AS "count"
           FROM "finance"."budget_lines") AS "canonical_rows",
    ( SELECT "count"(*) AS "count"
           FROM "legacy"."budget_lines") AS "archived_legacy_rows"
UNION ALL
 SELECT 'tax_returns'::"text" AS "entity",
    ( SELECT "count"(*) AS "count"
           FROM "finance"."tax_returns") AS "canonical_rows",
    ( SELECT "count"(*) AS "count"
           FROM "legacy"."tax_returns") AS "archived_legacy_rows"
UNION ALL
 SELECT 'numbering_sequences'::"text" AS "entity",
    ( SELECT "count"(*) AS "count"
           FROM "finance"."numbering_sequences") AS "canonical_rows",
    ( SELECT "count"(*) AS "count"
           FROM "legacy"."numbering_sequences") AS "archived_legacy_rows";


ALTER VIEW "reporting"."v_legacy_archive_status" OWNER TO "postgres";


COMMENT ON VIEW "reporting"."v_legacy_archive_status" IS 'Replaces reporting.v_duplicate_table_drift (Migration 032). Reference-only row counts for finance.* canonical tables vs. their archived legacy.* counterparts.';



CREATE OR REPLACE VIEW "reporting"."v_project_profitability" WITH ("security_invoker"='true') AS
 WITH "proj_gl" AS (
         SELECT "p"."id" AS "project_id",
            "p"."name" AS "project_name",
            "p"."client_name",
            "p"."status" AS "project_status",
            "p"."user_id",
            COALESCE("sum"(("jl"."base_credit" - "jl"."base_debit")) FILTER (WHERE (("je"."status" = 'POSTED'::"text") AND ("coa"."account_type" = 'REVENUE'::"text"))), (0)::numeric) AS "revenue",
            COALESCE("sum"(("jl"."base_debit" - "jl"."base_credit")) FILTER (WHERE (("je"."status" = 'POSTED'::"text") AND ("coa"."account_type" = ANY (ARRAY['COST_OF_SALES'::"text", 'OPERATING_EXPENSE'::"text"])))), (0)::numeric) AS "direct_cost"
           FROM ((("public"."projects" "p"
             LEFT JOIN "finance"."journal_entries" "je" ON (("je"."project_id" = "p"."id")))
             LEFT JOIN "finance"."journal_lines" "jl" ON (("jl"."journal_entry_id" = "je"."id")))
             LEFT JOIN "finance"."chart_of_accounts" "coa" ON (("coa"."id" = "jl"."account_id")))
          GROUP BY "p"."id", "p"."name", "p"."client_name", "p"."status", "p"."user_id"
        )
 SELECT "pg"."project_id",
    "pg"."project_name",
    "pg"."client_name",
    "pg"."project_status",
    "pg"."user_id",
    "pg"."revenue",
    "pg"."direct_cost",
    ("pg"."revenue" - "pg"."direct_cost") AS "gross_profit",
        CASE
            WHEN ("pg"."revenue" <> (0)::numeric) THEN "round"(((("pg"."revenue" - "pg"."direct_cost") / "pg"."revenue") * (100)::numeric), 2)
            ELSE NULL::numeric
        END AS "margin_percent",
    "org"."id" AS "organization_id",
    "org"."base_currency",
    "now"() AS "data_as_of"
   FROM ("proj_gl" "pg"
     CROSS JOIN "core"."organizations" "org");


ALTER VIEW "reporting"."v_project_profitability" OWNER TO "postgres";


CREATE OR REPLACE VIEW "reporting"."v_tax_computation_summary" WITH ("security_invoker"='true') AS
 SELECT "tr"."id" AS "tax_reconciliation_id",
    "tr"."tax_year",
    "tr"."fiscal_year_id",
    "tr"."accounting_profit_before_tax",
    "tr"."taxable_income",
    ("tr"."taxable_income" - "tr"."accounting_profit_before_tax") AS "net_tax_adjustments",
    "tr"."gross_tax_liability",
    "tr"."withholding_credits",
    "tr"."advance_tax_credits",
    "tr"."other_tax_credits",
    "tr"."net_tax_payable",
    "tr"."profit_after_tax",
    "tr"."effective_tax_rate",
    "tr"."status",
    "tr"."filing_date",
    "tr"."filing_reference",
    "tr"."payment_date",
    "tr"."tax_rule_set_id",
    "trs"."name" AS "tax_rule_set_name",
    "trs"."version" AS "tax_rule_set_version",
    "org"."id" AS "organization_id",
    "org"."base_currency",
    "now"() AS "data_as_of"
   FROM (("finance"."tax_reconciliations" "tr"
     LEFT JOIN "finance"."tax_rule_sets" "trs" ON (("trs"."id" = "tr"."tax_rule_set_id")))
     CROSS JOIN "core"."organizations" "org");


ALTER VIEW "reporting"."v_tax_computation_summary" OWNER TO "postgres";


ALTER TABLE ONLY "ai"."ai_conversations"
    ADD CONSTRAINT "ai_conversations_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "ai"."ai_document_extractions"
    ADD CONSTRAINT "ai_document_extractions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "ai"."ai_feedback"
    ADD CONSTRAINT "ai_feedback_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "ai"."ai_messages"
    ADD CONSTRAINT "ai_messages_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "ai"."ai_model_registry"
    ADD CONSTRAINT "ai_model_registry_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "ai"."ai_model_registry"
    ADD CONSTRAINT "ai_model_registry_provider_model_id_purpose_key" UNIQUE ("provider", "model_id", "purpose");



ALTER TABLE ONLY "ai"."ai_prompt_versions"
    ADD CONSTRAINT "ai_prompt_versions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "ai"."ai_prompt_versions"
    ADD CONSTRAINT "ai_prompt_versions_prompt_key_version_key" UNIQUE ("prompt_key", "version");



ALTER TABLE ONLY "ai"."ai_query_audit"
    ADD CONSTRAINT "ai_query_audit_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "ai"."ai_suggestions"
    ADD CONSTRAINT "ai_suggestions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "ai"."ai_tool_calls"
    ADD CONSTRAINT "ai_tool_calls_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "ai"."ai_user_cost_tracking"
    ADD CONSTRAINT "ai_user_cost_tracking_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "ai"."ai_user_cost_tracking"
    ADD CONSTRAINT "ai_user_cost_tracking_user_id_organization_id_period_date_key" UNIQUE ("user_id", "organization_id", "period_date");



ALTER TABLE ONLY "audit"."audit_log"
    ADD CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "audit"."data_access_events"
    ADD CONSTRAINT "data_access_events_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "audit"."export_events"
    ADD CONSTRAINT "export_events_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "audit"."security_events"
    ADD CONSTRAINT "security_events_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "core"."approval_actions"
    ADD CONSTRAINT "approval_actions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "core"."approval_limits"
    ADD CONSTRAINT "approval_limits_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "core"."approval_requests"
    ADD CONSTRAINT "approval_requests_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "core"."approval_steps"
    ADD CONSTRAINT "approval_steps_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "core"."approval_steps"
    ADD CONSTRAINT "approval_steps_unique_step" UNIQUE ("approval_request_id", "step_number");



ALTER TABLE ONLY "core"."budget_policies"
    ADD CONSTRAINT "budget_policies_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "core"."delegations"
    ADD CONSTRAINT "delegations_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "core"."employee_links"
    ADD CONSTRAINT "employee_links_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "core"."idempotency_keys"
    ADD CONSTRAINT "idempotency_keys_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "core"."idempotency_keys"
    ADD CONSTRAINT "idempotency_keys_unique" UNIQUE ("scope", "key", "organization_id");



ALTER TABLE ONLY "core"."integration_events"
    ADD CONSTRAINT "integration_events_idempotency_unique" UNIQUE ("organization_id", "source_module", "event_type", "idempotency_key");



ALTER TABLE ONLY "core"."integration_events"
    ADD CONSTRAINT "integration_events_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "core"."integration_failures"
    ADD CONSTRAINT "integration_failures_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "core"."organization_config"
    ADD CONSTRAINT "organization_config_organization_id_unique" UNIQUE ("organization_id");



ALTER TABLE ONLY "core"."organization_config"
    ADD CONSTRAINT "organization_config_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "core"."organization_modules"
    ADD CONSTRAINT "organization_modules_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "core"."organizations"
    ADD CONSTRAINT "organizations_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "core"."permissions"
    ADD CONSTRAINT "permissions_code_key" UNIQUE ("code");



ALTER TABLE ONLY "core"."permissions"
    ADD CONSTRAINT "permissions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "core"."role_permissions"
    ADD CONSTRAINT "role_permissions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "core"."roles"
    ADD CONSTRAINT "roles_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "core"."role_permissions"
    ADD CONSTRAINT "rp_unique" UNIQUE ("role_id", "permission_id", "effective_from");



ALTER TABLE ONLY "core"."shared_people"
    ADD CONSTRAINT "shared_people_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "core"."user_roles"
    ADD CONSTRAINT "ur_user_role_unique" UNIQUE ("user_id", "role_id", "effective_from");



ALTER TABLE ONLY "core"."user_permission_overrides"
    ADD CONSTRAINT "user_permission_overrides_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "core"."user_roles"
    ADD CONSTRAINT "user_roles_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "finance"."accounting_periods"
    ADD CONSTRAINT "accounting_periods_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "finance"."accounting_periods"
    ADD CONSTRAINT "ap_fy_period_unique" UNIQUE ("fiscal_year_id", "period_number");



ALTER TABLE ONLY "finance"."accounting_periods"
    ADD CONSTRAINT "ap_no_overlapping_ranges_per_fy" EXCLUDE USING "gist" ("fiscal_year_id" WITH =, "daterange"("start_date", "end_date", '[]'::"text") WITH &&);



ALTER TABLE ONLY "finance"."accounting_periods"
    ADD CONSTRAINT "ap_unique_period_number_per_fy" UNIQUE ("fiscal_year_id", "period_number");



ALTER TABLE ONLY "finance"."asset_categories"
    ADD CONSTRAINT "asset_categories_code_key" UNIQUE ("code");



ALTER TABLE ONLY "finance"."asset_categories"
    ADD CONSTRAINT "asset_categories_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "finance"."asset_verification_lines"
    ADD CONSTRAINT "asset_verification_lines_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "finance"."asset_verification_lines"
    ADD CONSTRAINT "asset_verification_lines_verification_id_asset_id_key" UNIQUE ("verification_id", "asset_id");



ALTER TABLE ONLY "finance"."asset_verifications"
    ADD CONSTRAINT "asset_verifications_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "finance"."asset_verifications"
    ADD CONSTRAINT "asset_verifications_verification_code_key" UNIQUE ("verification_code");



ALTER TABLE ONLY "finance"."attachments"
    ADD CONSTRAINT "attachments_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "finance"."attendance_period_snapshots"
    ADD CONSTRAINT "attendance_period_snapshots_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "finance"."attendance_period_snapshots"
    ADD CONSTRAINT "attendance_snapshot_unique" UNIQUE ("shared_person_id", "period_start", "period_end");



ALTER TABLE ONLY "finance"."bank_statements"
    ADD CONSTRAINT "bank_statements_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "finance"."bank_transfers"
    ADD CONSTRAINT "bank_transfers_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "finance"."budget_commitments"
    ADD CONSTRAINT "budget_commitments_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "finance"."budget_lines"
    ADD CONSTRAINT "budget_lines_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "finance"."budget_revisions"
    ADD CONSTRAINT "budget_revisions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "finance"."budget_revisions"
    ADD CONSTRAINT "budget_revisions_unique_number" UNIQUE ("budget_id", "revision_number");



ALTER TABLE ONLY "finance"."capital_transactions"
    ADD CONSTRAINT "capital_transactions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "finance"."chart_of_accounts"
    ADD CONSTRAINT "chart_of_accounts_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "finance"."chart_of_accounts"
    ADD CONSTRAINT "coa_code_unique" UNIQUE ("code");



ALTER TABLE ONLY "finance"."credit_notes"
    ADD CONSTRAINT "credit_notes_credit_note_number_key" UNIQUE ("credit_note_number");



ALTER TABLE ONLY "finance"."credit_notes"
    ADD CONSTRAINT "credit_notes_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "finance"."currency_settings"
    ADD CONSTRAINT "currency_settings_org_currency_key" UNIQUE ("organization_id", "currency");



ALTER TABLE ONLY "finance"."currency_settings"
    ADD CONSTRAINT "currency_settings_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "finance"."depreciation_schedule"
    ADD CONSTRAINT "depreciation_schedule_asset_id_period_id_key" UNIQUE ("asset_id", "period_id");



ALTER TABLE ONLY "finance"."depreciation_schedule"
    ADD CONSTRAINT "depreciation_schedule_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "finance"."dimensions"
    ADD CONSTRAINT "dimensions_org_code_unique" UNIQUE ("organization_id", "type", "code");



ALTER TABLE ONLY "finance"."dimensions"
    ADD CONSTRAINT "dimensions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "finance"."distribution_lines"
    ADD CONSTRAINT "distribution_lines_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "finance"."exchange_rates"
    ADD CONSTRAINT "exchange_rates_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "finance"."expense_lines"
    ADD CONSTRAINT "expense_lines_expense_line_key" UNIQUE ("expense_id", "line_number");



ALTER TABLE ONLY "finance"."expense_lines"
    ADD CONSTRAINT "expense_lines_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "finance"."fee_computation_log"
    ADD CONSTRAINT "fee_computation_log_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "finance"."fee_rules"
    ADD CONSTRAINT "fee_rules_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "finance"."fee_rules"
    ADD CONSTRAINT "fee_rules_platform_name_unique" UNIQUE ("platform_id", "name");



ALTER TABLE ONLY "finance"."fee_tiers"
    ADD CONSTRAINT "fee_tiers_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "finance"."financial_accounts"
    ADD CONSTRAINT "financial_accounts_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "finance"."fiscal_years"
    ADD CONSTRAINT "fiscal_years_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "finance"."fixed_assets"
    ADD CONSTRAINT "fixed_assets_code_key" UNIQUE ("code");



ALTER TABLE ONLY "finance"."fixed_assets"
    ADD CONSTRAINT "fixed_assets_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "finance"."fiscal_years"
    ADD CONSTRAINT "fy_no_overlapping_ranges" EXCLUDE USING "gist" ("organization_id" WITH =, "daterange"("start_date", "end_date", '[]'::"text") WITH &&);



ALTER TABLE ONLY "finance"."invoice_lines"
    ADD CONSTRAINT "invoice_lines_invoice_line_key" UNIQUE ("invoice_id", "line_number");



ALTER TABLE ONLY "finance"."invoice_lines"
    ADD CONSTRAINT "invoice_lines_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "finance"."journal_entries"
    ADD CONSTRAINT "je_reference_unique" UNIQUE ("reference");



ALTER TABLE ONLY "finance"."journal_lines"
    ADD CONSTRAINT "jl_entry_line_unique" UNIQUE ("journal_entry_id", "line_number");



ALTER TABLE ONLY "finance"."journal_entries"
    ADD CONSTRAINT "journal_entries_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "finance"."journal_lines"
    ADD CONSTRAINT "journal_lines_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "finance"."numbering_sequences"
    ADD CONSTRAINT "numbering_sequences_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "finance"."opening_balance_imports"
    ADD CONSTRAINT "opening_balance_imports_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "finance"."owners"
    ADD CONSTRAINT "owners_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "finance"."ownership_history"
    ADD CONSTRAINT "ownership_history_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "finance"."payment_allocations"
    ADD CONSTRAINT "payment_allocations_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "finance"."payment_receipts"
    ADD CONSTRAINT "payment_receipts_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "finance"."payment_receipts"
    ADD CONSTRAINT "payment_receipts_receipt_number_key" UNIQUE ("receipt_number");



ALTER TABLE ONLY "finance"."platforms"
    ADD CONSTRAINT "platforms_code_key" UNIQUE ("code");



ALTER TABLE ONLY "finance"."platforms"
    ADD CONSTRAINT "platforms_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "finance"."profit_distributions"
    ADD CONSTRAINT "profit_distributions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "finance"."reserve_policies"
    ADD CONSTRAINT "reserve_policies_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "finance"."settlement_batches"
    ADD CONSTRAINT "settlement_batches_org_reference_key" UNIQUE ("organization_id", "settlement_reference");



ALTER TABLE ONLY "finance"."settlement_batches"
    ADD CONSTRAINT "settlement_batches_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "finance"."settlement_lines"
    ADD CONSTRAINT "settlement_lines_batch_line_key" UNIQUE ("settlement_batch_id", "line_number");



ALTER TABLE ONLY "finance"."settlement_lines"
    ADD CONSTRAINT "settlement_lines_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "finance"."statement_lines"
    ADD CONSTRAINT "statement_lines_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "finance"."tax_adjustments"
    ADD CONSTRAINT "tax_adjustments_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "finance"."tax_codes"
    ADD CONSTRAINT "tax_codes_org_code_key" UNIQUE ("organization_id", "code");



ALTER TABLE ONLY "finance"."tax_codes"
    ADD CONSTRAINT "tax_codes_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "finance"."tax_computations"
    ADD CONSTRAINT "tax_computations_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "finance"."tax_credits_and_withholding"
    ADD CONSTRAINT "tax_credits_and_withholding_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "finance"."tax_payments_and_refunds"
    ADD CONSTRAINT "tax_payments_and_refunds_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "finance"."tax_reconciliations"
    ADD CONSTRAINT "tax_reconciliations_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "finance"."tax_returns"
    ADD CONSTRAINT "tax_returns_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "finance"."tax_rule_sets"
    ADD CONSTRAINT "tax_rule_sets_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "finance"."tax_slabs"
    ADD CONSTRAINT "tax_slabs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "finance"."taxpayer_profile"
    ADD CONSTRAINT "taxpayer_profile_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "finance"."financial_accounts"
    ADD CONSTRAINT "uq_fin_account_name" UNIQUE ("account_name");



ALTER TABLE ONLY "finance"."statement_lines"
    ADD CONSTRAINT "uq_stmt_line" UNIQUE ("bank_statement_id", "line_number");



ALTER TABLE ONLY "finance"."statement_lines"
    ADD CONSTRAINT "uq_stmt_txn_id" UNIQUE ("bank_statement_id", "transaction_identifier") DEFERRABLE INITIALLY DEFERRED;



ALTER TABLE ONLY "finance"."tax_reconciliations"
    ADD CONSTRAINT "uq_tax_recon_year" UNIQUE ("tax_year");



ALTER TABLE ONLY "finance"."tax_rule_sets"
    ADD CONSTRAINT "uq_tax_rule" UNIQUE ("tax_year", "taxpayer_type", "jurisdiction", "version");



ALTER TABLE ONLY "finance"."taxpayer_profile"
    ADD CONSTRAINT "uq_taxpayer_profile" UNIQUE ("ntn_number");



ALTER TABLE ONLY "finance"."bank_transfers"
    ADD CONSTRAINT "uq_transfer_number" UNIQUE ("transfer_number");



ALTER TABLE ONLY "finance"."vendor_bill_lines"
    ADD CONSTRAINT "vendor_bill_lines_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "finance"."vendor_bills"
    ADD CONSTRAINT "vendor_bills_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "finance"."vendor_payment_allocations"
    ADD CONSTRAINT "vendor_payment_allocations_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "finance"."vendor_payments"
    ADD CONSTRAINT "vendor_payments_payment_number_key" UNIQUE ("payment_number");



ALTER TABLE ONLY "finance"."vendor_payments"
    ADD CONSTRAINT "vendor_payments_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "finance"."vendors"
    ADD CONSTRAINT "vendors_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "finance"."vendors"
    ADD CONSTRAINT "vendors_vendor_code_key" UNIQUE ("vendor_code");



ALTER TABLE ONLY "legacy"."budget_lines"
    ADD CONSTRAINT "budget_lines_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "legacy"."financial_accounts"
    ADD CONSTRAINT "financial_accounts_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "legacy"."numbering_sequences"
    ADD CONSTRAINT "numbering_sequences_document_type_key" UNIQUE ("document_type");



ALTER TABLE ONLY "legacy"."numbering_sequences"
    ADD CONSTRAINT "numbering_sequences_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "legacy"."tax_returns"
    ADD CONSTRAINT "tax_returns_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."budgets"
    ADD CONSTRAINT "budgets_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."clients"
    ADD CONSTRAINT "clients_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."commissions"
    ADD CONSTRAINT "commissions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."contractors"
    ADD CONSTRAINT "contractors_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."expenses"
    ADD CONSTRAINT "expenses_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."incomes"
    ADD CONSTRAINT "incomes_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."invoices"
    ADD CONSTRAINT "invoices_invoice_number_key" UNIQUE ("invoice_number");



ALTER TABLE ONLY "public"."invoices"
    ADD CONSTRAINT "invoices_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."notification_deliveries"
    ADD CONSTRAINT "notification_deliveries_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."notification_preferences"
    ADD CONSTRAINT "notification_preferences_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."notification_preferences"
    ADD CONSTRAINT "notification_preferences_user_category_channel_key" UNIQUE ("user_id", "category", "channel");



ALTER TABLE ONLY "public"."notifications"
    ADD CONSTRAINT "notifications_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."payments"
    ADD CONSTRAINT "payments_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."payroll_advances"
    ADD CONSTRAINT "payroll_advances_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."payroll_commissions"
    ADD CONSTRAINT "payroll_commissions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."payroll_compensation"
    ADD CONSTRAINT "payroll_compensation_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."payroll_deductions"
    ADD CONSTRAINT "payroll_deductions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."payroll_employees"
    ADD CONSTRAINT "payroll_employees_employee_code_key" UNIQUE ("employee_code");



ALTER TABLE ONLY "public"."payroll_employees"
    ADD CONSTRAINT "payroll_employees_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."payroll_lines"
    ADD CONSTRAINT "payroll_lines_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."payroll_reimbursements"
    ADD CONSTRAINT "payroll_reimbursements_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."payroll_runs"
    ADD CONSTRAINT "payroll_runs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."policy_documents"
    ADD CONSTRAINT "policy_documents_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_user_id_key" UNIQUE ("user_id");



ALTER TABLE ONLY "public"."projects"
    ADD CONSTRAINT "projects_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."subscriptions"
    ADD CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."user_mfa"
    ADD CONSTRAINT "user_mfa_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."user_mfa"
    ADD CONSTRAINT "user_mfa_user_id_factor_id_key" UNIQUE ("user_id", "factor_id");



CREATE INDEX "idx_ai_conversations_org" ON "ai"."ai_conversations" USING "btree" ("organization_id", "created_at" DESC);



CREATE INDEX "idx_ai_conversations_user" ON "ai"."ai_conversations" USING "btree" ("user_id", "created_at" DESC);



CREATE INDEX "idx_ai_cost_user_date" ON "ai"."ai_user_cost_tracking" USING "btree" ("user_id", "period_date");



CREATE INDEX "idx_ai_feedback_user" ON "ai"."ai_feedback" USING "btree" ("user_id", "created_at" DESC);



CREATE INDEX "idx_ai_messages_conversation" ON "ai"."ai_messages" USING "btree" ("conversation_id", "created_at");



CREATE INDEX "idx_ai_query_audit_user" ON "ai"."ai_query_audit" USING "btree" ("user_id", "created_at" DESC);



CREATE INDEX "idx_ai_suggestions_entity" ON "ai"."ai_suggestions" USING "btree" ("entity_type", "entity_id", "status");



CREATE INDEX "idx_ai_suggestions_user" ON "ai"."ai_suggestions" USING "btree" ("user_id", "status");



CREATE INDEX "idx_ai_tool_calls_conv" ON "ai"."ai_tool_calls" USING "btree" ("conversation_id");



CREATE INDEX "idx_ai_tool_calls_user" ON "ai"."ai_tool_calls" USING "btree" ("user_id", "created_at" DESC);



CREATE INDEX "idx_audit_log_action" ON "audit"."audit_log" USING "btree" ("action");



CREATE INDEX "idx_audit_log_ai_tool" ON "audit"."audit_log" USING "btree" ("ai_selected_tool");



CREATE INDEX "idx_audit_log_amount" ON "audit"."audit_log" USING "btree" ("amount");



CREATE INDEX "idx_audit_log_approval_level" ON "audit"."audit_log" USING "btree" ("approval_level");



CREATE INDEX "idx_audit_log_created_at" ON "audit"."audit_log" USING "btree" ("created_at" DESC);



CREATE INDEX "idx_audit_log_entity" ON "audit"."audit_log" USING "btree" ("entity_type", "entity_id");



CREATE INDEX "idx_audit_log_organization_id" ON "audit"."audit_log" USING "btree" ("organization_id");



CREATE INDEX "idx_audit_log_project" ON "audit"."audit_log" USING "btree" ("project_id");



CREATE INDEX "idx_audit_log_related_journal" ON "audit"."audit_log" USING "btree" ("related_journal_id");



CREATE INDEX "idx_audit_log_related_payment" ON "audit"."audit_log" USING "btree" ("related_payment_id");



CREATE INDEX "idx_audit_log_request_id" ON "audit"."audit_log" USING "btree" ("request_id");



CREATE INDEX "idx_audit_log_severity" ON "audit"."audit_log" USING "btree" ("severity");



CREATE INDEX "idx_audit_log_source_module" ON "audit"."audit_log" USING "btree" ("source_module");



CREATE INDEX "idx_audit_log_source_table" ON "audit"."audit_log" USING "btree" ("source_schema", "source_table");



CREATE INDEX "idx_audit_log_status" ON "audit"."audit_log" USING "btree" ("status");



CREATE INDEX "idx_audit_log_user_id" ON "audit"."audit_log" USING "btree" ("user_id");



CREATE INDEX "idx_data_access_entity" ON "audit"."data_access_events" USING "btree" ("accessed_entity_type", "accessed_entity_id");



CREATE INDEX "idx_data_access_events_org" ON "audit"."data_access_events" USING "btree" ("organization_id");



CREATE INDEX "idx_data_access_user" ON "audit"."data_access_events" USING "btree" ("user_id", "created_at" DESC);



CREATE INDEX "idx_export_events_org" ON "audit"."export_events" USING "btree" ("organization_id");



CREATE INDEX "idx_export_events_user" ON "audit"."export_events" USING "btree" ("user_id", "created_at" DESC);



CREATE INDEX "idx_security_events_org" ON "audit"."security_events" USING "btree" ("organization_id");



CREATE INDEX "idx_security_events_type" ON "audit"."security_events" USING "btree" ("event_type", "created_at" DESC);



CREATE INDEX "idx_security_events_user" ON "audit"."security_events" USING "btree" ("user_id", "created_at" DESC);



CREATE INDEX "idx_approval_actions_step" ON "core"."approval_actions" USING "btree" ("approval_step_id");



CREATE INDEX "idx_approval_limits_effective" ON "core"."approval_limits" USING "btree" ("effective_from", "effective_to");



CREATE INDEX "idx_approval_limits_role" ON "core"."approval_limits" USING "btree" ("role_id", "transaction_type") WHERE ("role_id" IS NOT NULL);



CREATE INDEX "idx_approval_limits_user" ON "core"."approval_limits" USING "btree" ("user_id", "transaction_type") WHERE ("user_id" IS NOT NULL);



CREATE INDEX "idx_approval_requests_entity" ON "core"."approval_requests" USING "btree" ("entity_type", "entity_id");



CREATE INDEX "idx_approval_requests_status" ON "core"."approval_requests" USING "btree" ("status");



CREATE INDEX "idx_approval_steps_request" ON "core"."approval_steps" USING "btree" ("approval_request_id");



CREATE INDEX "idx_budget_policies_org_active" ON "core"."budget_policies" USING "btree" ("organization_id", "is_active");



CREATE INDEX "idx_delegations_effective" ON "core"."delegations" USING "btree" ("effective_from", "effective_to");



CREATE INDEX "idx_delegations_from" ON "core"."delegations" USING "btree" ("from_user_id", "status");



CREATE INDEX "idx_delegations_to" ON "core"."delegations" USING "btree" ("to_user_id", "status");



CREATE INDEX "idx_employee_links_person" ON "core"."employee_links" USING "btree" ("shared_person_id");



CREATE INDEX "idx_integration_events_org" ON "core"."integration_events" USING "btree" ("organization_id");



CREATE INDEX "idx_integration_events_status" ON "core"."integration_events" USING "btree" ("processing_status");



CREATE INDEX "idx_integration_failures_event" ON "core"."integration_failures" USING "btree" ("integration_event_id");



CREATE INDEX "idx_org_config_active" ON "core"."organization_config" USING "btree" ("active");



CREATE INDEX "idx_perm_code" ON "core"."permissions" USING "btree" ("code");



CREATE INDEX "idx_rp_role" ON "core"."role_permissions" USING "btree" ("role_id");



CREATE INDEX "idx_shared_people_org" ON "core"."shared_people" USING "btree" ("organization_id");



CREATE INDEX "idx_upo_user" ON "core"."user_permission_overrides" USING "btree" ("user_id");



CREATE INDEX "idx_ur_role" ON "core"."user_roles" USING "btree" ("role_id");



CREATE INDEX "idx_ur_user" ON "core"."user_roles" USING "btree" ("user_id");



CREATE UNIQUE INDEX "roles_name_org_unique" ON "core"."roles" USING "btree" ("organization_id", "name") WHERE ("organization_id" IS NOT NULL);



CREATE UNIQUE INDEX "roles_name_system_unique" ON "core"."roles" USING "btree" ("name") WHERE ("organization_id" IS NULL);



CREATE UNIQUE INDEX "uq_org_active_policy" ON "core"."budget_policies" USING "btree" ("organization_id") WHERE ("is_active" = true);



CREATE UNIQUE INDEX "uq_org_module_active" ON "core"."organization_modules" USING "btree" ("organization_id", "module_key") WHERE ("effective_to" IS NULL);



CREATE UNIQUE INDEX "uq_shared_people_auth_user" ON "core"."shared_people" USING "btree" ("auth_user_id") WHERE ("auth_user_id" IS NOT NULL);



CREATE UNIQUE INDEX "uq_upo_active_user_permission" ON "core"."user_permission_overrides" USING "btree" ("user_id", "permission_id") WHERE ("effective_to" IS NULL);



CREATE INDEX "expense_lines_expense_id_idx" ON "finance"."expense_lines" USING "btree" ("expense_id");



CREATE INDEX "expense_lines_org_id_idx" ON "finance"."expense_lines" USING "btree" ("organization_id");



CREATE INDEX "idx_alloc_invoice" ON "finance"."payment_allocations" USING "btree" ("invoice_id");



CREATE INDEX "idx_alloc_payment" ON "finance"."payment_allocations" USING "btree" ("payment_receipt_id");



CREATE INDEX "idx_ap_dates" ON "finance"."accounting_periods" USING "btree" ("start_date", "end_date");



CREATE INDEX "idx_ap_fy_id" ON "finance"."accounting_periods" USING "btree" ("fiscal_year_id");



CREATE INDEX "idx_ap_period_number" ON "finance"."accounting_periods" USING "btree" ("fiscal_year_id", "period_number");



CREATE INDEX "idx_ap_status" ON "finance"."accounting_periods" USING "btree" ("status");



CREATE INDEX "idx_asset_categories_active" ON "finance"."asset_categories" USING "btree" ("active");



CREATE INDEX "idx_attachments_entity" ON "finance"."attachments" USING "btree" ("entity_type", "entity_id");



CREATE INDEX "idx_attachments_hash" ON "finance"."attachments" USING "btree" ("file_hash");



CREATE INDEX "idx_attendance_snapshots_person" ON "finance"."attendance_period_snapshots" USING "btree" ("shared_person_id");



CREATE INDEX "idx_bl_account" ON "finance"."budget_lines" USING "btree" ("account_id");



CREATE INDEX "idx_bl_budget" ON "finance"."budget_lines" USING "btree" ("budget_id");



CREATE INDEX "idx_bs_account" ON "finance"."bank_statements" USING "btree" ("financial_account_id");



CREATE INDEX "idx_bs_date" ON "finance"."bank_statements" USING "btree" ("statement_date");



CREATE INDEX "idx_bt_date" ON "finance"."bank_transfers" USING "btree" ("transfer_date");



CREATE INDEX "idx_bt_from" ON "finance"."bank_transfers" USING "btree" ("from_account_id");



CREATE INDEX "idx_bt_status" ON "finance"."bank_transfers" USING "btree" ("status");



CREATE INDEX "idx_bt_to" ON "finance"."bank_transfers" USING "btree" ("to_account_id");



CREATE INDEX "idx_budget_commitments_budget_line" ON "finance"."budget_commitments" USING "btree" ("budget_line_id");



CREATE INDEX "idx_budget_commitments_status" ON "finance"."budget_commitments" USING "btree" ("status");



CREATE INDEX "idx_budget_revisions_budget" ON "finance"."budget_revisions" USING "btree" ("budget_id");



CREATE INDEX "idx_capital_txn_date" ON "finance"."capital_transactions" USING "btree" ("transaction_date");



CREATE INDEX "idx_capital_txn_owner" ON "finance"."capital_transactions" USING "btree" ("owner_id");



CREATE INDEX "idx_capital_txn_status" ON "finance"."capital_transactions" USING "btree" ("status") WHERE ("status" = ANY (ARRAY['DRAFT'::"text", 'APPROVED'::"text"]));



CREATE INDEX "idx_coa_account_type" ON "finance"."chart_of_accounts" USING "btree" ("account_type");



CREATE INDEX "idx_coa_active" ON "finance"."chart_of_accounts" USING "btree" ("id") WHERE ("deleted_at" IS NULL);



CREATE INDEX "idx_coa_code" ON "finance"."chart_of_accounts" USING "btree" ("code");



CREATE INDEX "idx_coa_is_active" ON "finance"."chart_of_accounts" USING "btree" ("is_active");



CREATE INDEX "idx_coa_level" ON "finance"."chart_of_accounts" USING "btree" ("level");



CREATE INDEX "idx_coa_organization_id" ON "finance"."chart_of_accounts" USING "btree" ("organization_id");



CREATE INDEX "idx_coa_parent_id" ON "finance"."chart_of_accounts" USING "btree" ("parent_id");



CREATE INDEX "idx_credit_notes_vendor_bill_id" ON "finance"."credit_notes" USING "btree" ("vendor_bill_id");



CREATE INDEX "idx_depreciation_schedule_asset" ON "finance"."depreciation_schedule" USING "btree" ("asset_id");



CREATE INDEX "idx_depreciation_schedule_period" ON "finance"."depreciation_schedule" USING "btree" ("period_id");



CREATE INDEX "idx_depreciation_schedule_status" ON "finance"."depreciation_schedule" USING "btree" ("status");



CREATE INDEX "idx_dimensions_org" ON "finance"."dimensions" USING "btree" ("organization_id");



CREATE INDEX "idx_dimensions_parent" ON "finance"."dimensions" USING "btree" ("parent_id");



CREATE INDEX "idx_dl_dist" ON "finance"."distribution_lines" USING "btree" ("profit_distribution_id");



CREATE INDEX "idx_fa_active" ON "finance"."financial_accounts" USING "btree" ("is_active");



CREATE INDEX "idx_fa_currency" ON "finance"."financial_accounts" USING "btree" ("currency");



CREATE INDEX "idx_fa_ledger" ON "finance"."financial_accounts" USING "btree" ("linked_ledger_account_id");



CREATE INDEX "idx_fa_organization_id" ON "finance"."financial_accounts" USING "btree" ("organization_id");



CREATE INDEX "idx_fa_type" ON "finance"."financial_accounts" USING "btree" ("institution_type");



CREATE INDEX "idx_fee_computation_log_org" ON "finance"."fee_computation_log" USING "btree" ("organization_id");



CREATE INDEX "idx_financial_accounts_fin_active" ON "finance"."financial_accounts" USING "btree" ("id") WHERE ("deleted_at" IS NULL);



CREATE INDEX "idx_fixed_assets_category" ON "finance"."fixed_assets" USING "btree" ("category_id");



CREATE INDEX "idx_fixed_assets_project" ON "finance"."fixed_assets" USING "btree" ("project_id");



CREATE INDEX "idx_fixed_assets_status" ON "finance"."fixed_assets" USING "btree" ("status");



CREATE INDEX "idx_fixed_assets_vendor" ON "finance"."fixed_assets" USING "btree" ("vendor_id");



CREATE INDEX "idx_fx_rate_date" ON "finance"."exchange_rates" USING "btree" ("rate_date" DESC);



CREATE INDEX "idx_fy_dates" ON "finance"."fiscal_years" USING "btree" ("start_date", "end_date");



CREATE INDEX "idx_fy_status" ON "finance"."fiscal_years" USING "btree" ("status");



CREATE INDEX "idx_je_created_by" ON "finance"."journal_entries" USING "btree" ("created_by");



CREATE INDEX "idx_je_date" ON "finance"."journal_entries" USING "btree" ("transaction_date" DESC);



CREATE INDEX "idx_je_organization_id" ON "finance"."journal_entries" USING "btree" ("organization_id");



CREATE INDEX "idx_je_period" ON "finance"."journal_entries" USING "btree" ("period_id");



CREATE INDEX "idx_je_project" ON "finance"."journal_entries" USING "btree" ("project_id");



CREATE INDEX "idx_je_source" ON "finance"."journal_entries" USING "btree" ("source_type", "source_id");



CREATE INDEX "idx_je_status" ON "finance"."journal_entries" USING "btree" ("status");



CREATE INDEX "idx_jl_account_id" ON "finance"."journal_lines" USING "btree" ("account_id");



CREATE INDEX "idx_jl_entry_id" ON "finance"."journal_lines" USING "btree" ("journal_entry_id");



CREATE INDEX "idx_ns_type" ON "finance"."numbering_sequences" USING "btree" ("sequence_type");



CREATE UNIQUE INDEX "idx_ns_type_fy_org_unique" ON "finance"."numbering_sequences" USING "btree" ("organization_id", "sequence_type", COALESCE(("fiscal_year_id")::"text", 'GLOBAL'::"text"));



CREATE INDEX "idx_oh_owner" ON "finance"."ownership_history" USING "btree" ("owner_id");



CREATE INDEX "idx_payment_receipts_client_id" ON "finance"."payment_receipts" USING "btree" ("client_id");



CREATE INDEX "idx_pd_fy" ON "finance"."profit_distributions" USING "btree" ("fiscal_year_id");



CREATE INDEX "idx_platforms_active" ON "finance"."platforms" USING "btree" ("id") WHERE ("deleted_at" IS NULL);



CREATE INDEX "idx_sl_amount" ON "finance"."statement_lines" USING "btree" ("amount");



CREATE INDEX "idx_sl_date" ON "finance"."statement_lines" USING "btree" ("transaction_date");



CREATE INDEX "idx_sl_journal" ON "finance"."statement_lines" USING "btree" ("matched_journal_line_id") WHERE ("matched_journal_line_id" IS NOT NULL);



CREATE INDEX "idx_sl_recon" ON "finance"."statement_lines" USING "btree" ("reconciliation_status");



CREATE INDEX "idx_sl_statement" ON "finance"."statement_lines" USING "btree" ("bank_statement_id");



CREATE INDEX "idx_sl_unreconciled" ON "finance"."statement_lines" USING "btree" ("bank_statement_id", "reconciliation_status") WHERE ("reconciliation_status" = 'UNRECONCILED'::"text");



CREATE INDEX "idx_ta_category" ON "finance"."tax_adjustments" USING "btree" ("adjustment_category");



CREATE INDEX "idx_ta_recon" ON "finance"."tax_adjustments" USING "btree" ("tax_reconciliation_id");



CREATE INDEX "idx_tax_comp_fy" ON "finance"."tax_computations" USING "btree" ("fiscal_year_id");



CREATE INDEX "idx_tax_comp_org" ON "finance"."tax_computations" USING "btree" ("organization_id");



CREATE INDEX "idx_tax_comp_period" ON "finance"."tax_computations" USING "btree" ("period_id");



CREATE INDEX "idx_tax_comp_status" ON "finance"."tax_computations" USING "btree" ("status");



CREATE INDEX "idx_tax_cw_comp" ON "finance"."tax_credits_and_withholding" USING "btree" ("tax_computation_id");



CREATE INDEX "idx_tax_cw_org" ON "finance"."tax_credits_and_withholding" USING "btree" ("organization_id");



CREATE INDEX "idx_tax_cw_period" ON "finance"."tax_credits_and_withholding" USING "btree" ("period_id");



CREATE INDEX "idx_tax_cw_status" ON "finance"."tax_credits_and_withholding" USING "btree" ("status");



CREATE INDEX "idx_tax_cw_type" ON "finance"."tax_credits_and_withholding" USING "btree" ("credit_type");



CREATE INDEX "idx_tax_pay_comp" ON "finance"."tax_payments_and_refunds" USING "btree" ("tax_computation_id");



CREATE INDEX "idx_tax_pay_date" ON "finance"."tax_payments_and_refunds" USING "btree" ("payment_date");



CREATE INDEX "idx_tax_pay_org" ON "finance"."tax_payments_and_refunds" USING "btree" ("organization_id");



CREATE INDEX "idx_tax_pay_period" ON "finance"."tax_payments_and_refunds" USING "btree" ("period_id");



CREATE INDEX "idx_tax_pay_return" ON "finance"."tax_payments_and_refunds" USING "btree" ("tax_return_id");



CREATE INDEX "idx_tax_pay_status" ON "finance"."tax_payments_and_refunds" USING "btree" ("status");



CREATE INDEX "idx_tax_ret_fy" ON "finance"."tax_returns" USING "btree" ("fiscal_year_id");



CREATE INDEX "idx_tax_ret_org" ON "finance"."tax_returns" USING "btree" ("organization_id");



CREATE INDEX "idx_tax_ret_period" ON "finance"."tax_returns" USING "btree" ("period_id");



CREATE INDEX "idx_tax_ret_recon" ON "finance"."tax_returns" USING "btree" ("tax_reconciliation_id");



CREATE INDEX "idx_tax_ret_status" ON "finance"."tax_returns" USING "btree" ("status");



CREATE INDEX "idx_tax_ret_type" ON "finance"."tax_returns" USING "btree" ("tax_type");



CREATE INDEX "idx_tr_fy" ON "finance"."tax_reconciliations" USING "btree" ("fiscal_year_id");



CREATE INDEX "idx_tr_rule" ON "finance"."tax_reconciliations" USING "btree" ("tax_rule_set_id");



CREATE INDEX "idx_tr_status" ON "finance"."tax_reconciliations" USING "btree" ("status");



CREATE INDEX "idx_ts_rule" ON "finance"."tax_slabs" USING "btree" ("tax_rule_set_id");



CREATE INDEX "idx_ts_sort" ON "finance"."tax_slabs" USING "btree" ("tax_rule_set_id", "sort_order");



CREATE INDEX "idx_vb_organization_id" ON "finance"."vendor_bills" USING "btree" ("organization_id");



CREATE INDEX "idx_vb_vendor" ON "finance"."vendor_bills" USING "btree" ("vendor_id");



CREATE INDEX "idx_vbl_bill" ON "finance"."vendor_bill_lines" USING "btree" ("vendor_bill_id");



CREATE INDEX "idx_vendors_active" ON "finance"."vendors" USING "btree" ("id") WHERE ("deleted_at" IS NULL);



CREATE INDEX "idx_vendors_code" ON "finance"."vendors" USING "btree" ("vendor_code");



CREATE INDEX "idx_vp_vendor" ON "finance"."vendor_payments" USING "btree" ("vendor_id");



CREATE INDEX "idx_vpa_payment" ON "finance"."vendor_payment_allocations" USING "btree" ("vendor_payment_id");



CREATE INDEX "invoice_lines_invoice_id_idx" ON "finance"."invoice_lines" USING "btree" ("invoice_id");



CREATE INDEX "invoice_lines_org_id_idx" ON "finance"."invoice_lines" USING "btree" ("organization_id");



CREATE INDEX "settlement_batches_org_id_idx" ON "finance"."settlement_batches" USING "btree" ("organization_id");



CREATE INDEX "settlement_lines_batch_id_idx" ON "finance"."settlement_lines" USING "btree" ("settlement_batch_id");



CREATE INDEX "settlement_lines_org_id_idx" ON "finance"."settlement_lines" USING "btree" ("organization_id");



CREATE UNIQUE INDEX "unique_exchange_rate" ON "finance"."exchange_rates" USING "btree" ("from_currency", "to_currency", "rate_date", "rate_type", "source_platform");



CREATE UNIQUE INDEX "uq_vendor_bill_number" ON "finance"."vendor_bills" USING "btree" ("vendor_id", "bill_number") WHERE ("status" <> ALL (ARRAY['DRAFT'::"text", 'CANCELLED'::"text", 'REJECTED'::"text"]));



CREATE INDEX "idx_financial_accounts_pub_active" ON "legacy"."financial_accounts" USING "btree" ("id") WHERE ("deleted_at" IS NULL);



CREATE INDEX "idx_advances_employee" ON "public"."payroll_advances" USING "btree" ("employee_id");



CREATE INDEX "idx_advances_status" ON "public"."payroll_advances" USING "btree" ("approval_status");



CREATE INDEX "idx_budgets_fy" ON "public"."budgets" USING "btree" ("fiscal_year_id");



CREATE INDEX "idx_budgets_organization_id" ON "public"."budgets" USING "btree" ("organization_id");



CREATE INDEX "idx_budgets_status" ON "public"."budgets" USING "btree" ("status");



CREATE INDEX "idx_clients_active" ON "public"."clients" USING "btree" ("id") WHERE ("deleted_at" IS NULL);



CREATE INDEX "idx_clients_organization_id" ON "public"."clients" USING "btree" ("organization_id");



CREATE INDEX "idx_commissions_contractor" ON "public"."commissions" USING "btree" ("contractor_id");



CREATE INDEX "idx_commissions_employee" ON "public"."payroll_commissions" USING "btree" ("employee_id");



CREATE INDEX "idx_commissions_org" ON "public"."commissions" USING "btree" ("organization_id");



CREATE INDEX "idx_commissions_period" ON "public"."commissions" USING "btree" ("period_start", "period_end");



CREATE INDEX "idx_commissions_person" ON "public"."commissions" USING "btree" ("person_name");



CREATE INDEX "idx_commissions_project" ON "public"."commissions" USING "btree" ("project_id");



CREATE INDEX "idx_commissions_status" ON "public"."payroll_commissions" USING "btree" ("status");



CREATE INDEX "idx_commissions_type" ON "public"."commissions" USING "btree" ("commission_type");



CREATE INDEX "idx_compensation_active" ON "public"."payroll_compensation" USING "btree" ("employee_id", "is_active");



CREATE INDEX "idx_compensation_employee" ON "public"."payroll_compensation" USING "btree" ("employee_id");



CREATE INDEX "idx_contractors_contract_end" ON "public"."contractors" USING "btree" ("contract_end") WHERE (("status")::"text" = 'ACTIVE'::"text");



CREATE INDEX "idx_contractors_org" ON "public"."contractors" USING "btree" ("organization_id");



CREATE INDEX "idx_contractors_project" ON "public"."contractors" USING "btree" ("project_id");



CREATE INDEX "idx_contractors_role" ON "public"."contractors" USING "btree" ("role");



CREATE INDEX "idx_contractors_status" ON "public"."contractors" USING "btree" ("status");



CREATE INDEX "idx_deductions_employee" ON "public"."payroll_deductions" USING "btree" ("employee_id");



CREATE INDEX "idx_expenses_date" ON "public"."expenses" USING "btree" ("expense_date" DESC);



CREATE INDEX "idx_expenses_organization_id" ON "public"."expenses" USING "btree" ("organization_id");



CREATE INDEX "idx_expenses_project_id" ON "public"."expenses" USING "btree" ("project_id");



CREATE INDEX "idx_expenses_user_id" ON "public"."expenses" USING "btree" ("user_id");



CREATE INDEX "idx_incomes_date" ON "public"."incomes" USING "btree" ("income_date" DESC);



CREATE INDEX "idx_incomes_org" ON "public"."incomes" USING "btree" ("organization_id");



CREATE INDEX "idx_incomes_project_id" ON "public"."incomes" USING "btree" ("project_id");



CREATE INDEX "idx_incomes_user_id" ON "public"."incomes" USING "btree" ("user_id");



CREATE INDEX "idx_invoices_due_date" ON "public"."invoices" USING "btree" ("due_date");



CREATE INDEX "idx_invoices_organization_id" ON "public"."invoices" USING "btree" ("organization_id");



CREATE INDEX "idx_invoices_project_id" ON "public"."invoices" USING "btree" ("project_id");



CREATE INDEX "idx_invoices_status" ON "public"."invoices" USING "btree" ("status");



CREATE INDEX "idx_invoices_user_id" ON "public"."invoices" USING "btree" ("user_id");



CREATE INDEX "idx_notification_deliveries_notification" ON "public"."notification_deliveries" USING "btree" ("notification_id");



CREATE INDEX "idx_notification_deliveries_status" ON "public"."notification_deliveries" USING "btree" ("status") WHERE ("status" = ANY (ARRAY['PENDING'::"text", 'FAILED'::"text"]));



CREATE INDEX "idx_notification_prefs_user" ON "public"."notification_preferences" USING "btree" ("user_id");



CREATE INDEX "idx_payments_journal_entry" ON "public"."payments" USING "btree" ("journal_entry_id");



CREATE INDEX "idx_payroll_advances_org" ON "public"."payroll_advances" USING "btree" ("organization_id");



CREATE INDEX "idx_payroll_commissions_org" ON "public"."payroll_commissions" USING "btree" ("organization_id");



CREATE INDEX "idx_payroll_compensation_org" ON "public"."payroll_compensation" USING "btree" ("organization_id");



CREATE INDEX "idx_payroll_deductions_org" ON "public"."payroll_deductions" USING "btree" ("organization_id");



CREATE INDEX "idx_payroll_employees_code" ON "public"."payroll_employees" USING "btree" ("employee_code");



CREATE INDEX "idx_payroll_employees_dept" ON "public"."payroll_employees" USING "btree" ("department");



CREATE INDEX "idx_payroll_employees_org" ON "public"."payroll_employees" USING "btree" ("organization_id");



CREATE INDEX "idx_payroll_employees_status" ON "public"."payroll_employees" USING "btree" ("status");



CREATE INDEX "idx_payroll_lines_employee" ON "public"."payroll_lines" USING "btree" ("employee_id");



CREATE INDEX "idx_payroll_lines_org" ON "public"."payroll_lines" USING "btree" ("organization_id");



CREATE INDEX "idx_payroll_lines_payment" ON "public"."payroll_lines" USING "btree" ("payment_status");



CREATE INDEX "idx_payroll_lines_run" ON "public"."payroll_lines" USING "btree" ("payroll_run_id");



CREATE INDEX "idx_payroll_reimbursements_org" ON "public"."payroll_reimbursements" USING "btree" ("organization_id");



CREATE INDEX "idx_payroll_runs_org" ON "public"."payroll_runs" USING "btree" ("organization_id");



CREATE INDEX "idx_payroll_runs_period" ON "public"."payroll_runs" USING "btree" ("payroll_period");



CREATE INDEX "idx_payroll_runs_status" ON "public"."payroll_runs" USING "btree" ("status");



CREATE INDEX "idx_policy_documents_active" ON "public"."policy_documents" USING "btree" ("organization_id", "is_active") WHERE ("is_active" = true);



CREATE INDEX "idx_policy_documents_org" ON "public"."policy_documents" USING "btree" ("organization_id");



CREATE INDEX "idx_profiles_department" ON "public"."profiles" USING "btree" ("department_id");



CREATE INDEX "idx_profiles_organization_id" ON "public"."profiles" USING "btree" ("organization_id");



CREATE INDEX "idx_profiles_role" ON "public"."profiles" USING "btree" ("role");



CREATE INDEX "idx_profiles_user_id" ON "public"."profiles" USING "btree" ("user_id");



CREATE INDEX "idx_projects_active" ON "public"."projects" USING "btree" ("id") WHERE ("deleted_at" IS NULL);



CREATE INDEX "idx_projects_organization_id" ON "public"."projects" USING "btree" ("organization_id");



CREATE INDEX "idx_projects_status" ON "public"."projects" USING "btree" ("status");



CREATE INDEX "idx_projects_user_id" ON "public"."projects" USING "btree" ("user_id");



CREATE INDEX "idx_reimb_employee" ON "public"."payroll_reimbursements" USING "btree" ("employee_id");



CREATE INDEX "idx_subscriptions_category" ON "public"."subscriptions" USING "btree" ("category");



CREATE INDEX "idx_subscriptions_org" ON "public"."subscriptions" USING "btree" ("organization_id");



CREATE INDEX "idx_subscriptions_project" ON "public"."subscriptions" USING "btree" ("project_id");



CREATE INDEX "idx_subscriptions_renewal" ON "public"."subscriptions" USING "btree" ("renewal_date") WHERE (("status")::"text" = 'ACTIVE'::"text");



CREATE INDEX "idx_subscriptions_status" ON "public"."subscriptions" USING "btree" ("status");



CREATE OR REPLACE VIEW "public"."v_payroll_summary" WITH ("security_invoker"='true') AS
 SELECT "pr"."id" AS "run_id",
    "pr"."payroll_period",
    "pr"."status" AS "run_status",
    "pr"."total_gross_pay",
    "pr"."total_deductions",
    "pr"."total_net_pay",
    "pr"."total_employer_cost",
    "pr"."total_employees",
    "pr"."created_at",
    "count"(DISTINCT "pl"."id") AS "line_count",
    "count"(DISTINCT
        CASE
            WHEN (("pl"."payment_status")::"text" = 'PAID'::"text") THEN "pl"."id"
            ELSE NULL::"uuid"
        END) AS "paid_count",
    "sum"(
        CASE
            WHEN (("pl"."payment_status")::"text" <> 'PAID'::"text") THEN "pl"."net_pay"
            ELSE (0)::numeric
        END) AS "unpaid_amount"
   FROM ("public"."payroll_runs" "pr"
     LEFT JOIN "public"."payroll_lines" "pl" ON (("pl"."payroll_run_id" = "pr"."id")))
  GROUP BY "pr"."id";



CREATE OR REPLACE TRIGGER "ai_conversations_audit" AFTER INSERT OR DELETE OR UPDATE ON "ai"."ai_conversations" FOR EACH ROW EXECUTE FUNCTION "audit"."trigger_audit_log"();



CREATE OR REPLACE TRIGGER "ai_document_extracti_audit" AFTER INSERT OR DELETE OR UPDATE ON "ai"."ai_document_extractions" FOR EACH ROW EXECUTE FUNCTION "audit"."trigger_audit_log"();



CREATE OR REPLACE TRIGGER "ai_feedback_audit" AFTER INSERT OR DELETE OR UPDATE ON "ai"."ai_feedback" FOR EACH ROW EXECUTE FUNCTION "audit"."trigger_audit_log"();



CREATE OR REPLACE TRIGGER "ai_messages_audit" AFTER INSERT OR DELETE OR UPDATE ON "ai"."ai_messages" FOR EACH ROW EXECUTE FUNCTION "audit"."trigger_audit_log"();



CREATE OR REPLACE TRIGGER "ai_suggestions_audit" AFTER INSERT OR DELETE OR UPDATE ON "ai"."ai_suggestions" FOR EACH ROW EXECUTE FUNCTION "audit"."trigger_audit_log"();



CREATE OR REPLACE TRIGGER "approval_limits_audit" AFTER INSERT OR DELETE OR UPDATE ON "core"."approval_limits" FOR EACH ROW EXECUTE FUNCTION "audit"."trigger_audit_log"();



CREATE OR REPLACE TRIGGER "approval_limits_updated_at" BEFORE UPDATE ON "core"."approval_limits" FOR EACH ROW EXECUTE FUNCTION "core"."set_updated_at"();



CREATE OR REPLACE TRIGGER "delegations_audit" AFTER INSERT OR DELETE OR UPDATE ON "core"."delegations" FOR EACH ROW EXECUTE FUNCTION "audit"."trigger_audit_log"();



CREATE OR REPLACE TRIGGER "delegations_updated_at" BEFORE UPDATE ON "core"."delegations" FOR EACH ROW EXECUTE FUNCTION "core"."set_updated_at"();



CREATE OR REPLACE TRIGGER "org_config_updated_at" BEFORE UPDATE ON "core"."organization_config" FOR EACH ROW EXECUTE FUNCTION "core"."set_updated_at"();



CREATE OR REPLACE TRIGGER "organization_config_audit" AFTER INSERT OR DELETE OR UPDATE ON "core"."organization_config" FOR EACH ROW EXECUTE FUNCTION "audit"."trigger_audit_log"();



CREATE OR REPLACE TRIGGER "organization_modules_updated_at" BEFORE UPDATE ON "core"."organization_modules" FOR EACH ROW EXECUTE FUNCTION "core"."set_updated_at"();



CREATE OR REPLACE TRIGGER "perm_updated_at" BEFORE UPDATE ON "core"."permissions" FOR EACH ROW EXECUTE FUNCTION "core"."set_updated_at"();



CREATE OR REPLACE TRIGGER "permissions_audit" AFTER INSERT OR DELETE OR UPDATE ON "core"."permissions" FOR EACH ROW EXECUTE FUNCTION "audit"."trigger_audit_log"();



CREATE OR REPLACE TRIGGER "role_permissions_audit" AFTER INSERT OR DELETE OR UPDATE ON "core"."role_permissions" FOR EACH ROW EXECUTE FUNCTION "audit"."trigger_audit_log"();



CREATE OR REPLACE TRIGGER "role_updated_at" BEFORE UPDATE ON "core"."roles" FOR EACH ROW EXECUTE FUNCTION "core"."set_updated_at"();



CREATE OR REPLACE TRIGGER "roles_audit" AFTER INSERT OR DELETE OR UPDATE ON "core"."roles" FOR EACH ROW EXECUTE FUNCTION "audit"."trigger_audit_log"();



CREATE OR REPLACE TRIGGER "rp_updated_at" BEFORE UPDATE ON "core"."role_permissions" FOR EACH ROW EXECUTE FUNCTION "core"."set_updated_at"();



CREATE OR REPLACE TRIGGER "shared_people_audit" AFTER INSERT OR DELETE OR UPDATE ON "core"."shared_people" FOR EACH ROW EXECUTE FUNCTION "audit"."trigger_audit_log"();



CREATE OR REPLACE TRIGGER "shared_people_updated_at" BEFORE UPDATE ON "core"."shared_people" FOR EACH ROW EXECUTE FUNCTION "core"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_updated_at" BEFORE UPDATE ON "core"."approval_requests" FOR EACH ROW EXECUTE FUNCTION "core"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_updated_at" BEFORE UPDATE ON "core"."budget_policies" FOR EACH ROW EXECUTE FUNCTION "core"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_updated_at" BEFORE UPDATE ON "core"."employee_links" FOR EACH ROW EXECUTE FUNCTION "core"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_updated_at" BEFORE UPDATE ON "core"."integration_failures" FOR EACH ROW EXECUTE FUNCTION "core"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_updated_at" BEFORE UPDATE ON "core"."organizations" FOR EACH ROW EXECUTE FUNCTION "core"."set_updated_at"();



CREATE OR REPLACE TRIGGER "upo_audit" AFTER INSERT OR DELETE OR UPDATE ON "core"."user_permission_overrides" FOR EACH ROW EXECUTE FUNCTION "audit"."trigger_audit_log"();



CREATE OR REPLACE TRIGGER "upo_updated_at" BEFORE UPDATE ON "core"."user_permission_overrides" FOR EACH ROW EXECUTE FUNCTION "core"."set_updated_at"();



CREATE OR REPLACE TRIGGER "ur_updated_at" BEFORE UPDATE ON "core"."user_roles" FOR EACH ROW EXECUTE FUNCTION "core"."set_updated_at"();



CREATE OR REPLACE TRIGGER "user_roles_audit" AFTER INSERT OR DELETE OR UPDATE ON "core"."user_roles" FOR EACH ROW EXECUTE FUNCTION "audit"."trigger_audit_log"();



CREATE OR REPLACE TRIGGER "accounting_periods_audit" AFTER INSERT OR DELETE OR UPDATE ON "finance"."accounting_periods" FOR EACH ROW EXECUTE FUNCTION "audit"."trigger_audit_log"();



CREATE OR REPLACE TRIGGER "ap_updated_at" BEFORE UPDATE ON "finance"."accounting_periods" FOR EACH ROW EXECUTE FUNCTION "core"."set_updated_at"();



CREATE OR REPLACE TRIGGER "asset_categories_audit" AFTER INSERT OR DELETE OR UPDATE ON "finance"."asset_categories" FOR EACH ROW EXECUTE FUNCTION "audit"."trigger_audit_log"();



CREATE OR REPLACE TRIGGER "asset_verifications_audit" AFTER INSERT OR DELETE OR UPDATE ON "finance"."asset_verifications" FOR EACH ROW EXECUTE FUNCTION "audit"."trigger_audit_log"();



CREATE OR REPLACE TRIGGER "bank_statements_audit" AFTER INSERT OR DELETE OR UPDATE ON "finance"."bank_statements" FOR EACH ROW EXECUTE FUNCTION "audit"."trigger_audit_log"();



CREATE OR REPLACE TRIGGER "bank_transfers_audit" AFTER INSERT OR DELETE OR UPDATE ON "finance"."bank_transfers" FOR EACH ROW EXECUTE FUNCTION "audit"."trigger_audit_log"();



CREATE OR REPLACE TRIGGER "budget_commitments_audit" AFTER INSERT OR DELETE OR UPDATE ON "finance"."budget_commitments" FOR EACH ROW EXECUTE FUNCTION "audit"."trigger_audit_log"();



CREATE OR REPLACE TRIGGER "chart_of_accounts_audit" AFTER INSERT OR DELETE OR UPDATE ON "finance"."chart_of_accounts" FOR EACH ROW EXECUTE FUNCTION "audit"."trigger_audit_log"();



CREATE OR REPLACE TRIGGER "coa_updated_at" BEFORE UPDATE ON "finance"."chart_of_accounts" FOR EACH ROW EXECUTE FUNCTION "core"."set_updated_at"();



CREATE OR REPLACE TRIGGER "credit_notes_audit" AFTER INSERT OR DELETE OR UPDATE ON "finance"."credit_notes" FOR EACH ROW EXECUTE FUNCTION "audit"."trigger_audit_log"();



CREATE OR REPLACE TRIGGER "currency_settings_audit" AFTER INSERT OR DELETE OR UPDATE ON "finance"."currency_settings" FOR EACH ROW EXECUTE FUNCTION "audit"."trigger_audit_log"();



CREATE OR REPLACE TRIGGER "currency_settings_updated_at" BEFORE UPDATE ON "finance"."currency_settings" FOR EACH ROW EXECUTE FUNCTION "core"."set_updated_at"();



CREATE OR REPLACE TRIGGER "depreciation_schedul_audit" AFTER INSERT OR DELETE OR UPDATE ON "finance"."depreciation_schedule" FOR EACH ROW EXECUTE FUNCTION "audit"."trigger_audit_log"();



CREATE OR REPLACE TRIGGER "distribution_lines_audit" AFTER INSERT OR DELETE OR UPDATE ON "finance"."distribution_lines" FOR EACH ROW EXECUTE FUNCTION "audit"."trigger_audit_log"();



CREATE OR REPLACE TRIGGER "exchange_rates_audit" AFTER INSERT OR DELETE OR UPDATE ON "finance"."exchange_rates" FOR EACH ROW EXECUTE FUNCTION "audit"."trigger_audit_log"();



CREATE OR REPLACE TRIGGER "expense_lines_audit" AFTER INSERT OR DELETE OR UPDATE ON "finance"."expense_lines" FOR EACH ROW EXECUTE FUNCTION "audit"."trigger_audit_log"();



CREATE OR REPLACE TRIGGER "expense_lines_org_guard" BEFORE INSERT OR UPDATE ON "finance"."expense_lines" FOR EACH ROW EXECUTE FUNCTION "finance"."enforce_expense_line_org"();



CREATE OR REPLACE TRIGGER "expense_lines_updated_at" BEFORE UPDATE ON "finance"."expense_lines" FOR EACH ROW EXECUTE FUNCTION "core"."set_updated_at"();



CREATE OR REPLACE TRIGGER "fee_computation_log_audit" AFTER INSERT OR DELETE OR UPDATE ON "finance"."fee_computation_log" FOR EACH ROW EXECUTE FUNCTION "audit"."trigger_audit_log"();



CREATE OR REPLACE TRIGGER "fee_rules_audit" AFTER INSERT OR DELETE OR UPDATE ON "finance"."fee_rules" FOR EACH ROW EXECUTE FUNCTION "audit"."trigger_audit_log"();



CREATE OR REPLACE TRIGGER "fee_tiers_audit" AFTER INSERT OR DELETE OR UPDATE ON "finance"."fee_tiers" FOR EACH ROW EXECUTE FUNCTION "audit"."trigger_audit_log"();



CREATE OR REPLACE TRIGGER "financial_accounts_audit" AFTER INSERT OR DELETE OR UPDATE ON "finance"."financial_accounts" FOR EACH ROW EXECUTE FUNCTION "audit"."trigger_audit_log"();



CREATE OR REPLACE TRIGGER "fiscal_years_audit" AFTER INSERT OR DELETE OR UPDATE ON "finance"."fiscal_years" FOR EACH ROW EXECUTE FUNCTION "audit"."trigger_audit_log"();



CREATE OR REPLACE TRIGGER "fixed_assets_audit" AFTER INSERT OR DELETE OR UPDATE ON "finance"."fixed_assets" FOR EACH ROW EXECUTE FUNCTION "audit"."trigger_audit_log"();



CREATE OR REPLACE TRIGGER "fy_updated_at" BEFORE UPDATE ON "finance"."fiscal_years" FOR EACH ROW EXECUTE FUNCTION "core"."set_updated_at"();



CREATE OR REPLACE TRIGGER "invoice_lines_audit" AFTER INSERT OR DELETE OR UPDATE ON "finance"."invoice_lines" FOR EACH ROW EXECUTE FUNCTION "audit"."trigger_audit_log"();



CREATE OR REPLACE TRIGGER "invoice_lines_org_guard" BEFORE INSERT OR UPDATE ON "finance"."invoice_lines" FOR EACH ROW EXECUTE FUNCTION "finance"."enforce_invoice_line_org"();



CREATE OR REPLACE TRIGGER "invoice_lines_updated_at" BEFORE UPDATE ON "finance"."invoice_lines" FOR EACH ROW EXECUTE FUNCTION "core"."set_updated_at"();



CREATE OR REPLACE TRIGGER "je_updated_at" BEFORE UPDATE ON "finance"."journal_entries" FOR EACH ROW EXECUTE FUNCTION "core"."set_updated_at"();



CREATE OR REPLACE TRIGGER "jl_updated_at" BEFORE UPDATE ON "finance"."journal_lines" FOR EACH ROW EXECUTE FUNCTION "core"."set_updated_at"();



CREATE OR REPLACE TRIGGER "journal_entries_audit" AFTER INSERT OR DELETE OR UPDATE ON "finance"."journal_entries" FOR EACH ROW EXECUTE FUNCTION "audit"."trigger_audit_log"();



CREATE OR REPLACE TRIGGER "journal_lines_audit" AFTER INSERT OR DELETE OR UPDATE ON "finance"."journal_lines" FOR EACH ROW EXECUTE FUNCTION "audit"."trigger_audit_log"();



CREATE OR REPLACE TRIGGER "ns_updated_at" BEFORE UPDATE ON "finance"."numbering_sequences" FOR EACH ROW EXECUTE FUNCTION "core"."set_updated_at"();



CREATE OR REPLACE TRIGGER "numbering_sequences_audit" AFTER INSERT OR DELETE OR UPDATE ON "finance"."numbering_sequences" FOR EACH ROW EXECUTE FUNCTION "audit"."trigger_audit_log"();



CREATE OR REPLACE TRIGGER "owners_audit" AFTER INSERT OR DELETE OR UPDATE ON "finance"."owners" FOR EACH ROW EXECUTE FUNCTION "audit"."trigger_audit_log"();



CREATE OR REPLACE TRIGGER "ownership_history_audit" AFTER INSERT OR DELETE OR UPDATE ON "finance"."ownership_history" FOR EACH ROW EXECUTE FUNCTION "audit"."trigger_audit_log"();



CREATE OR REPLACE TRIGGER "payment_allocations_audit" AFTER INSERT OR DELETE OR UPDATE ON "finance"."payment_allocations" FOR EACH ROW EXECUTE FUNCTION "audit"."trigger_audit_log"();



CREATE OR REPLACE TRIGGER "payment_receipts_audit" AFTER INSERT OR DELETE OR UPDATE ON "finance"."payment_receipts" FOR EACH ROW EXECUTE FUNCTION "audit"."trigger_audit_log"();



CREATE OR REPLACE TRIGGER "platforms_audit" AFTER INSERT OR DELETE OR UPDATE ON "finance"."platforms" FOR EACH ROW EXECUTE FUNCTION "audit"."trigger_audit_log"();



CREATE OR REPLACE TRIGGER "profit_distributions_audit" AFTER INSERT OR DELETE OR UPDATE ON "finance"."profit_distributions" FOR EACH ROW EXECUTE FUNCTION "audit"."trigger_audit_log"();



CREATE OR REPLACE TRIGGER "reserve_policies_audit" AFTER INSERT OR DELETE OR UPDATE ON "finance"."reserve_policies" FOR EACH ROW EXECUTE FUNCTION "audit"."trigger_audit_log"();



CREATE OR REPLACE TRIGGER "settlement_batches_audit" AFTER INSERT OR DELETE OR UPDATE ON "finance"."settlement_batches" FOR EACH ROW EXECUTE FUNCTION "audit"."trigger_audit_log"();



CREATE OR REPLACE TRIGGER "settlement_batches_updated_at" BEFORE UPDATE ON "finance"."settlement_batches" FOR EACH ROW EXECUTE FUNCTION "core"."set_updated_at"();



CREATE OR REPLACE TRIGGER "settlement_lines_audit" AFTER INSERT OR DELETE OR UPDATE ON "finance"."settlement_lines" FOR EACH ROW EXECUTE FUNCTION "audit"."trigger_audit_log"();



CREATE OR REPLACE TRIGGER "settlement_lines_org_guard" BEFORE INSERT OR UPDATE ON "finance"."settlement_lines" FOR EACH ROW EXECUTE FUNCTION "finance"."enforce_settlement_line_org"();



CREATE OR REPLACE TRIGGER "settlement_lines_updated_at" BEFORE UPDATE ON "finance"."settlement_lines" FOR EACH ROW EXECUTE FUNCTION "core"."set_updated_at"();



CREATE OR REPLACE TRIGGER "statement_lines_audit" AFTER INSERT OR DELETE OR UPDATE ON "finance"."statement_lines" FOR EACH ROW EXECUTE FUNCTION "audit"."trigger_audit_log"();



CREATE OR REPLACE TRIGGER "tax_adjustments_audit" AFTER INSERT OR DELETE OR UPDATE ON "finance"."tax_adjustments" FOR EACH ROW EXECUTE FUNCTION "audit"."trigger_audit_log"();



CREATE OR REPLACE TRIGGER "tax_codes_audit" AFTER INSERT OR DELETE OR UPDATE ON "finance"."tax_codes" FOR EACH ROW EXECUTE FUNCTION "audit"."trigger_audit_log"();



CREATE OR REPLACE TRIGGER "tax_codes_updated_at" BEFORE UPDATE ON "finance"."tax_codes" FOR EACH ROW EXECUTE FUNCTION "core"."set_updated_at"();



CREATE OR REPLACE TRIGGER "tax_computations_audit" AFTER INSERT OR DELETE OR UPDATE ON "finance"."tax_computations" FOR EACH ROW EXECUTE FUNCTION "audit"."trigger_audit_log"();



CREATE OR REPLACE TRIGGER "tax_credits_and_wh_audit" AFTER INSERT OR DELETE OR UPDATE ON "finance"."tax_credits_and_withholding" FOR EACH ROW EXECUTE FUNCTION "audit"."trigger_audit_log"();



CREATE OR REPLACE TRIGGER "tax_payments_ref_audit" AFTER INSERT OR DELETE OR UPDATE ON "finance"."tax_payments_and_refunds" FOR EACH ROW EXECUTE FUNCTION "audit"."trigger_audit_log"();



CREATE OR REPLACE TRIGGER "tax_reconciliations_audit" AFTER INSERT OR DELETE OR UPDATE ON "finance"."tax_reconciliations" FOR EACH ROW EXECUTE FUNCTION "audit"."trigger_audit_log"();



CREATE OR REPLACE TRIGGER "tax_returns_audit" AFTER INSERT OR DELETE OR UPDATE ON "finance"."tax_returns" FOR EACH ROW EXECUTE FUNCTION "audit"."trigger_audit_log"();



CREATE OR REPLACE TRIGGER "tax_rule_sets_audit" AFTER INSERT OR DELETE OR UPDATE ON "finance"."tax_rule_sets" FOR EACH ROW EXECUTE FUNCTION "audit"."trigger_audit_log"();



CREATE OR REPLACE TRIGGER "tax_slabs_audit" AFTER INSERT OR DELETE OR UPDATE ON "finance"."tax_slabs" FOR EACH ROW EXECUTE FUNCTION "audit"."trigger_audit_log"();



CREATE OR REPLACE TRIGGER "taxpayer_profile_audit" AFTER INSERT OR DELETE OR UPDATE ON "finance"."taxpayer_profile" FOR EACH ROW EXECUTE FUNCTION "audit"."trigger_audit_log"();



CREATE OR REPLACE TRIGGER "trg_asset_categories_ts" BEFORE UPDATE ON "finance"."asset_categories" FOR EACH ROW EXECUTE FUNCTION "finance"."fn_update_timestamp"();



CREATE OR REPLACE TRIGGER "trg_asset_verification_lines_ts" BEFORE UPDATE ON "finance"."asset_verification_lines" FOR EACH ROW EXECUTE FUNCTION "finance"."fn_update_timestamp"();



CREATE OR REPLACE TRIGGER "trg_asset_verifications_ts" BEFORE UPDATE ON "finance"."asset_verifications" FOR EACH ROW EXECUTE FUNCTION "finance"."fn_update_timestamp"();



CREATE OR REPLACE TRIGGER "trg_auto_update_bill_status" AFTER INSERT OR DELETE OR UPDATE ON "finance"."vendor_payment_allocations" FOR EACH ROW EXECUTE FUNCTION "finance"."auto_update_bill_status"();



CREATE OR REPLACE TRIGGER "trg_auto_update_invoice_status" AFTER INSERT OR DELETE OR UPDATE ON "finance"."payment_allocations" FOR EACH ROW EXECUTE FUNCTION "finance"."auto_update_invoice_status"();



CREATE OR REPLACE TRIGGER "trg_bs_updated_at" BEFORE UPDATE ON "finance"."bank_statements" FOR EACH ROW EXECUTE FUNCTION "finance"."fn_bs_sl_updated_at"();



CREATE OR REPLACE TRIGGER "trg_bt_updated_at" BEFORE UPDATE ON "finance"."bank_transfers" FOR EACH ROW EXECUTE FUNCTION "finance"."fn_bt_updated_at"();



CREATE CONSTRAINT TRIGGER "trg_check_journal_balance" AFTER INSERT OR DELETE OR UPDATE ON "finance"."journal_lines" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "finance"."check_journal_balance"();



CREATE OR REPLACE TRIGGER "trg_depreciation_schedule_ts" BEFORE UPDATE ON "finance"."depreciation_schedule" FOR EACH ROW EXECUTE FUNCTION "finance"."fn_update_timestamp"();



CREATE CONSTRAINT TRIGGER "trg_enforce_base_amounts_on_post" AFTER INSERT OR UPDATE ON "finance"."journal_lines" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "finance"."enforce_base_amounts_on_post"();



CREATE OR REPLACE TRIGGER "trg_enforce_postable_account" BEFORE INSERT OR UPDATE OF "account_id" ON "finance"."journal_lines" FOR EACH ROW EXECUTE FUNCTION "finance"."enforce_postable_account"();



CREATE OR REPLACE TRIGGER "trg_enforce_transition_year_period_13" BEFORE INSERT OR UPDATE OF "period_number", "fiscal_year_id" ON "finance"."accounting_periods" FOR EACH ROW EXECUTE FUNCTION "finance"."enforce_transition_year_period_13"();



CREATE OR REPLACE TRIGGER "trg_fa_single_default" BEFORE INSERT OR UPDATE OF "is_default" ON "finance"."financial_accounts" FOR EACH ROW WHEN (("new"."is_default" IS TRUE)) EXECUTE FUNCTION "finance"."fn_enforce_single_default_fa"();



CREATE OR REPLACE TRIGGER "trg_fa_updated_at" BEFORE UPDATE ON "finance"."financial_accounts" FOR EACH ROW EXECUTE FUNCTION "finance"."fn_fa_updated_at"();



CREATE OR REPLACE TRIGGER "trg_fixed_assets_nbv" BEFORE INSERT OR UPDATE ON "finance"."fixed_assets" FOR EACH ROW EXECUTE FUNCTION "finance"."fn_update_asset_nbv"();



CREATE OR REPLACE TRIGGER "trg_gen_bt_number" BEFORE INSERT ON "finance"."bank_transfers" FOR EACH ROW EXECUTE FUNCTION "finance"."fn_gen_bt_number"();



CREATE OR REPLACE TRIGGER "trg_maker_checker" BEFORE INSERT OR UPDATE ON "finance"."bank_transfers" FOR EACH ROW EXECUTE FUNCTION "finance"."enforce_maker_checker"();



CREATE OR REPLACE TRIGGER "trg_maker_checker" BEFORE INSERT OR UPDATE ON "finance"."journal_entries" FOR EACH ROW EXECUTE FUNCTION "finance"."enforce_maker_checker"();



CREATE OR REPLACE TRIGGER "trg_maker_checker" BEFORE INSERT OR UPDATE ON "finance"."profit_distributions" FOR EACH ROW EXECUTE FUNCTION "finance"."enforce_maker_checker"();



CREATE OR REPLACE TRIGGER "trg_maker_checker" BEFORE INSERT OR UPDATE ON "finance"."vendor_bills" FOR EACH ROW EXECUTE FUNCTION "finance"."enforce_maker_checker"();



CREATE OR REPLACE TRIGGER "trg_payment_receipt_client_org" BEFORE INSERT OR UPDATE OF "client_id", "organization_id" ON "finance"."payment_receipts" FOR EACH ROW EXECUTE FUNCTION "finance"."enforce_payment_receipt_client_org"();



CREATE OR REPLACE TRIGGER "trg_prevent_closed_period" BEFORE UPDATE ON "finance"."journal_entries" FOR EACH ROW WHEN ((("new"."status" = 'POSTED'::"text") AND ("old"."status" <> 'POSTED'::"text"))) EXECUTE FUNCTION "finance"."prevent_closed_period_posting"();



CREATE OR REPLACE TRIGGER "trg_prevent_closed_period_posting" BEFORE INSERT OR UPDATE ON "finance"."credit_notes" FOR EACH ROW EXECUTE FUNCTION "finance"."prevent_closed_period_posting"();



CREATE OR REPLACE TRIGGER "trg_prevent_closed_period_posting" BEFORE INSERT OR UPDATE ON "finance"."journal_entries" FOR EACH ROW EXECUTE FUNCTION "finance"."prevent_closed_period_posting"();



CREATE OR REPLACE TRIGGER "trg_prevent_closed_period_posting" BEFORE INSERT OR UPDATE ON "finance"."payment_receipts" FOR EACH ROW EXECUTE FUNCTION "finance"."prevent_closed_period_posting"();



CREATE OR REPLACE TRIGGER "trg_prevent_closed_period_posting" BEFORE INSERT OR UPDATE ON "finance"."vendor_payments" FOR EACH ROW EXECUTE FUNCTION "finance"."prevent_closed_period_posting"();



CREATE OR REPLACE TRIGGER "trg_prevent_double_match" BEFORE INSERT OR UPDATE OF "matched_journal_line_id" ON "finance"."statement_lines" FOR EACH ROW EXECUTE FUNCTION "finance"."fn_prevent_double_match"();



CREATE OR REPLACE TRIGGER "trg_prevent_locked_tax_rule_edit" BEFORE DELETE OR UPDATE ON "finance"."tax_rule_sets" FOR EACH ROW EXECUTE FUNCTION "finance"."prevent_locked_tax_rule_edit"();



CREATE OR REPLACE TRIGGER "trg_prevent_locked_tax_slab_edit" BEFORE INSERT OR DELETE OR UPDATE ON "finance"."tax_slabs" FOR EACH ROW EXECUTE FUNCTION "finance"."prevent_locked_tax_slab_edit"();



CREATE OR REPLACE TRIGGER "trg_prevent_posted_capital_transaction_edit" BEFORE DELETE OR UPDATE ON "finance"."capital_transactions" FOR EACH ROW EXECUTE FUNCTION "finance"."prevent_posted_capital_transaction_edit"();



CREATE OR REPLACE TRIGGER "trg_prevent_posted_edit" BEFORE DELETE OR UPDATE ON "finance"."journal_lines" FOR EACH ROW EXECUTE FUNCTION "finance"."prevent_posted_edit"();



CREATE OR REPLACE TRIGGER "trg_prevent_posted_vendor_bill_edit" BEFORE DELETE OR UPDATE ON "finance"."vendor_bills" FOR EACH ROW EXECUTE FUNCTION "finance"."prevent_posted_vendor_bill_edit"();



CREATE OR REPLACE TRIGGER "trg_prevent_used_financial_account_deletion" BEFORE DELETE ON "finance"."financial_accounts" FOR EACH ROW EXECUTE FUNCTION "finance"."prevent_used_financial_account_deletion"();



CREATE OR REPLACE TRIGGER "trg_prevent_used_fiscal_year_deletion" BEFORE DELETE ON "finance"."fiscal_years" FOR EACH ROW EXECUTE FUNCTION "finance"."prevent_used_fiscal_year_deletion"();



CREATE OR REPLACE TRIGGER "trg_set_dual_approval" BEFORE INSERT OR UPDATE OF "from_amount" ON "finance"."bank_transfers" FOR EACH ROW EXECUTE FUNCTION "finance"."fn_set_dual_approval"();



CREATE OR REPLACE TRIGGER "trg_single_default_fa" BEFORE INSERT OR UPDATE OF "is_default" ON "finance"."financial_accounts" FOR EACH ROW EXECUTE FUNCTION "finance"."fn_enforce_single_default_fa"();



CREATE OR REPLACE TRIGGER "trg_sl_updated_at" BEFORE UPDATE ON "finance"."statement_lines" FOR EACH ROW EXECUTE FUNCTION "finance"."fn_bs_sl_updated_at"();



CREATE OR REPLACE TRIGGER "trg_snapshot_tax_rule_set" BEFORE INSERT ON "finance"."tax_computations" FOR EACH ROW EXECUTE FUNCTION "finance"."snapshot_tax_rule_set"();



CREATE OR REPLACE TRIGGER "trg_stmt_line_count" AFTER INSERT OR DELETE OR UPDATE ON "finance"."statement_lines" FOR EACH ROW EXECUTE FUNCTION "finance"."fn_stmt_line_count"();



CREATE OR REPLACE TRIGGER "trg_stmt_recon_status" AFTER INSERT OR DELETE OR UPDATE ON "finance"."statement_lines" FOR EACH ROW EXECUTE FUNCTION "finance"."fn_stmt_recon_status"();



CREATE OR REPLACE TRIGGER "trg_sync_budget_line_committed_amount" AFTER INSERT OR DELETE OR UPDATE ON "finance"."budget_commitments" FOR EACH ROW EXECUTE FUNCTION "finance"."sync_budget_line_committed_amount"();



CREATE OR REPLACE TRIGGER "trg_tax_updated_at" BEFORE UPDATE ON "finance"."tax_adjustments" FOR EACH ROW EXECUTE FUNCTION "finance"."fn_tax_updated_at"();



CREATE OR REPLACE TRIGGER "trg_tax_updated_at" BEFORE UPDATE ON "finance"."tax_computations" FOR EACH ROW EXECUTE FUNCTION "finance"."fn_tax_updated_at"();



CREATE OR REPLACE TRIGGER "trg_tax_updated_at" BEFORE UPDATE ON "finance"."tax_credits_and_withholding" FOR EACH ROW EXECUTE FUNCTION "finance"."fn_tax_updated_at"();



CREATE OR REPLACE TRIGGER "trg_tax_updated_at" BEFORE UPDATE ON "finance"."tax_payments_and_refunds" FOR EACH ROW EXECUTE FUNCTION "finance"."fn_tax_updated_at"();



CREATE OR REPLACE TRIGGER "trg_tax_updated_at" BEFORE UPDATE ON "finance"."tax_reconciliations" FOR EACH ROW EXECUTE FUNCTION "finance"."fn_tax_updated_at"();



CREATE OR REPLACE TRIGGER "trg_tax_updated_at" BEFORE UPDATE ON "finance"."tax_returns" FOR EACH ROW EXECUTE FUNCTION "finance"."fn_tax_updated_at"();



CREATE OR REPLACE TRIGGER "trg_tax_updated_at" BEFORE UPDATE ON "finance"."tax_rule_sets" FOR EACH ROW EXECUTE FUNCTION "finance"."fn_tax_updated_at"();



CREATE OR REPLACE TRIGGER "trg_tax_updated_at" BEFORE UPDATE ON "finance"."tax_slabs" FOR EACH ROW EXECUTE FUNCTION "finance"."fn_tax_updated_at"();



CREATE OR REPLACE TRIGGER "trg_tax_updated_at" BEFORE UPDATE ON "finance"."taxpayer_profile" FOR EACH ROW EXECUTE FUNCTION "finance"."fn_tax_updated_at"();



CREATE OR REPLACE TRIGGER "trg_updated_at" BEFORE UPDATE ON "finance"."asset_categories" FOR EACH ROW EXECUTE FUNCTION "core"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_updated_at" BEFORE UPDATE ON "finance"."asset_verification_lines" FOR EACH ROW EXECUTE FUNCTION "core"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_updated_at" BEFORE UPDATE ON "finance"."asset_verifications" FOR EACH ROW EXECUTE FUNCTION "core"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_updated_at" BEFORE UPDATE ON "finance"."budget_commitments" FOR EACH ROW EXECUTE FUNCTION "core"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_updated_at" BEFORE UPDATE ON "finance"."credit_notes" FOR EACH ROW EXECUTE FUNCTION "core"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_updated_at" BEFORE UPDATE ON "finance"."depreciation_schedule" FOR EACH ROW EXECUTE FUNCTION "core"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_updated_at" BEFORE UPDATE ON "finance"."dimensions" FOR EACH ROW EXECUTE FUNCTION "core"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_updated_at" BEFORE UPDATE ON "finance"."distribution_lines" FOR EACH ROW EXECUTE FUNCTION "core"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_updated_at" BEFORE UPDATE ON "finance"."exchange_rates" FOR EACH ROW EXECUTE FUNCTION "core"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_updated_at" BEFORE UPDATE ON "finance"."fee_rules" FOR EACH ROW EXECUTE FUNCTION "core"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_updated_at" BEFORE UPDATE ON "finance"."fixed_assets" FOR EACH ROW EXECUTE FUNCTION "core"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_updated_at" BEFORE UPDATE ON "finance"."owners" FOR EACH ROW EXECUTE FUNCTION "core"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_updated_at" BEFORE UPDATE ON "finance"."ownership_history" FOR EACH ROW EXECUTE FUNCTION "core"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_updated_at" BEFORE UPDATE ON "finance"."payment_receipts" FOR EACH ROW EXECUTE FUNCTION "core"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_updated_at" BEFORE UPDATE ON "finance"."platforms" FOR EACH ROW EXECUTE FUNCTION "core"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_updated_at" BEFORE UPDATE ON "finance"."profit_distributions" FOR EACH ROW EXECUTE FUNCTION "core"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_updated_at" BEFORE UPDATE ON "finance"."reserve_policies" FOR EACH ROW EXECUTE FUNCTION "core"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_updated_at" BEFORE UPDATE ON "finance"."vendor_bill_lines" FOR EACH ROW EXECUTE FUNCTION "core"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_updated_at" BEFORE UPDATE ON "finance"."vendor_bills" FOR EACH ROW EXECUTE FUNCTION "core"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_updated_at" BEFORE UPDATE ON "finance"."vendor_payments" FOR EACH ROW EXECUTE FUNCTION "core"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_updated_at" BEFORE UPDATE ON "finance"."vendors" FOR EACH ROW EXECUTE FUNCTION "core"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_validate_fa_ledger" BEFORE INSERT OR UPDATE OF "linked_ledger_account_id" ON "finance"."financial_accounts" FOR EACH ROW EXECUTE FUNCTION "finance"."fn_validate_fa_ledger"();



CREATE OR REPLACE TRIGGER "trg_validate_ownership_percentage" BEFORE INSERT OR UPDATE ON "finance"."ownership_history" FOR EACH ROW EXECUTE FUNCTION "finance"."validate_ownership_percentage_total"();



CREATE OR REPLACE TRIGGER "trg_validate_payment_allocation" BEFORE INSERT OR UPDATE ON "finance"."payment_allocations" FOR EACH ROW EXECUTE FUNCTION "finance"."validate_payment_allocation"();



CREATE OR REPLACE TRIGGER "trg_validate_vendor_payment_allocation" BEFORE INSERT OR UPDATE ON "finance"."vendor_payment_allocations" FOR EACH ROW EXECUTE FUNCTION "finance"."validate_vendor_payment_allocation"();



CREATE OR REPLACE TRIGGER "vendor_bill_lines_audit" AFTER INSERT OR DELETE OR UPDATE ON "finance"."vendor_bill_lines" FOR EACH ROW EXECUTE FUNCTION "audit"."trigger_audit_log"();



CREATE OR REPLACE TRIGGER "vendor_bills_audit" AFTER INSERT OR DELETE OR UPDATE ON "finance"."vendor_bills" FOR EACH ROW EXECUTE FUNCTION "audit"."trigger_audit_log"();



CREATE OR REPLACE TRIGGER "vendor_payment_alloc_audit" AFTER INSERT OR DELETE OR UPDATE ON "finance"."vendor_payment_allocations" FOR EACH ROW EXECUTE FUNCTION "audit"."trigger_audit_log"();



CREATE OR REPLACE TRIGGER "vendor_payments_audit" AFTER INSERT OR DELETE OR UPDATE ON "finance"."vendor_payments" FOR EACH ROW EXECUTE FUNCTION "audit"."trigger_audit_log"();



CREATE OR REPLACE TRIGGER "vendors_audit" AFTER INSERT OR DELETE OR UPDATE ON "finance"."vendors" FOR EACH ROW EXECUTE FUNCTION "audit"."trigger_audit_log"();



CREATE OR REPLACE TRIGGER "trg_block_legacy_write" BEFORE INSERT OR DELETE OR UPDATE ON "legacy"."budget_lines" FOR EACH ROW EXECUTE FUNCTION "core"."block_legacy_table_write"();



CREATE OR REPLACE TRIGGER "trg_block_legacy_write" BEFORE INSERT OR DELETE OR UPDATE ON "legacy"."financial_accounts" FOR EACH ROW EXECUTE FUNCTION "core"."block_legacy_table_write"();



CREATE OR REPLACE TRIGGER "trg_block_legacy_write" BEFORE INSERT OR DELETE OR UPDATE ON "legacy"."numbering_sequences" FOR EACH ROW EXECUTE FUNCTION "core"."block_legacy_table_write"();



CREATE OR REPLACE TRIGGER "trg_block_legacy_write" BEFORE INSERT OR DELETE OR UPDATE ON "legacy"."tax_returns" FOR EACH ROW EXECUTE FUNCTION "core"."block_legacy_table_write"();



CREATE OR REPLACE TRIGGER "trg_updated_at" BEFORE UPDATE ON "legacy"."numbering_sequences" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at"();



CREATE OR REPLACE TRIGGER "budgets_audit" AFTER INSERT OR DELETE OR UPDATE ON "public"."budgets" FOR EACH ROW EXECUTE FUNCTION "audit"."trigger_audit_log"();



CREATE OR REPLACE TRIGGER "clients_audit" AFTER INSERT OR DELETE OR UPDATE ON "public"."clients" FOR EACH ROW EXECUTE FUNCTION "audit"."trigger_audit_log"();



CREATE OR REPLACE TRIGGER "contractors_audit" AFTER INSERT OR DELETE OR UPDATE ON "public"."contractors" FOR EACH ROW EXECUTE FUNCTION "audit"."trigger_audit_log"();



CREATE OR REPLACE TRIGGER "expenses_audit" AFTER INSERT OR DELETE OR UPDATE ON "public"."expenses" FOR EACH ROW EXECUTE FUNCTION "audit"."trigger_audit_log"();



CREATE OR REPLACE TRIGGER "incomes_audit" AFTER INSERT OR DELETE OR UPDATE ON "public"."incomes" FOR EACH ROW EXECUTE FUNCTION "audit"."trigger_audit_log"();



CREATE OR REPLACE TRIGGER "incomes_updated_at" BEFORE UPDATE ON "public"."incomes" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at"();



CREATE OR REPLACE TRIGGER "invoices_audit" AFTER INSERT OR DELETE OR UPDATE ON "public"."invoices" FOR EACH ROW EXECUTE FUNCTION "audit"."trigger_audit_log"();



CREATE OR REPLACE TRIGGER "notifications_audit" AFTER INSERT OR DELETE OR UPDATE ON "public"."notifications" FOR EACH ROW EXECUTE FUNCTION "audit"."trigger_audit_log"();



CREATE OR REPLACE TRIGGER "policy_documents_set_updated_at" BEFORE UPDATE ON "public"."policy_documents" FOR EACH ROW EXECUTE FUNCTION "core"."set_updated_at"();



CREATE OR REPLACE TRIGGER "profiles_audit" AFTER INSERT OR DELETE OR UPDATE ON "public"."profiles" FOR EACH ROW EXECUTE FUNCTION "audit"."trigger_audit_log"();



CREATE OR REPLACE TRIGGER "projects_audit" AFTER INSERT OR DELETE OR UPDATE ON "public"."projects" FOR EACH ROW EXECUTE FUNCTION "audit"."trigger_audit_log"();



CREATE OR REPLACE TRIGGER "trg_commissions_updated" BEFORE UPDATE ON "public"."commissions" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at"();



CREATE OR REPLACE TRIGGER "trg_contractors_updated" BEFORE UPDATE ON "public"."contractors" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at"();



CREATE OR REPLACE TRIGGER "trg_maker_checker" BEFORE INSERT OR UPDATE ON "public"."expenses" FOR EACH ROW EXECUTE FUNCTION "finance"."enforce_maker_checker"();



CREATE OR REPLACE TRIGGER "trg_maker_checker" BEFORE INSERT OR UPDATE ON "public"."incomes" FOR EACH ROW EXECUTE FUNCTION "finance"."enforce_maker_checker"();



CREATE OR REPLACE TRIGGER "trg_maker_checker" BEFORE INSERT OR UPDATE ON "public"."invoices" FOR EACH ROW EXECUTE FUNCTION "finance"."enforce_maker_checker"();



CREATE OR REPLACE TRIGGER "trg_payroll_advances_updated" BEFORE UPDATE ON "public"."payroll_advances" FOR EACH ROW EXECUTE FUNCTION "public"."payroll_update_timestamp"();



CREATE OR REPLACE TRIGGER "trg_payroll_commissions_updated" BEFORE UPDATE ON "public"."payroll_commissions" FOR EACH ROW EXECUTE FUNCTION "public"."payroll_update_timestamp"();



CREATE OR REPLACE TRIGGER "trg_payroll_compensation_updated" BEFORE UPDATE ON "public"."payroll_compensation" FOR EACH ROW EXECUTE FUNCTION "public"."payroll_update_timestamp"();



CREATE OR REPLACE TRIGGER "trg_payroll_deductions_updated" BEFORE UPDATE ON "public"."payroll_deductions" FOR EACH ROW EXECUTE FUNCTION "public"."payroll_update_timestamp"();



CREATE OR REPLACE TRIGGER "trg_payroll_employees_updated" BEFORE UPDATE ON "public"."payroll_employees" FOR EACH ROW EXECUTE FUNCTION "public"."payroll_update_timestamp"();



CREATE OR REPLACE TRIGGER "trg_payroll_lines_updated" BEFORE UPDATE ON "public"."payroll_lines" FOR EACH ROW EXECUTE FUNCTION "public"."payroll_update_timestamp"();



CREATE OR REPLACE TRIGGER "trg_payroll_reimbursements_updated" BEFORE UPDATE ON "public"."payroll_reimbursements" FOR EACH ROW EXECUTE FUNCTION "public"."payroll_update_timestamp"();



CREATE OR REPLACE TRIGGER "trg_payroll_runs_updated" BEFORE UPDATE ON "public"."payroll_runs" FOR EACH ROW EXECUTE FUNCTION "public"."payroll_update_timestamp"();



CREATE OR REPLACE TRIGGER "trg_prevent_closed_period_posting" BEFORE INSERT OR UPDATE ON "public"."expenses" FOR EACH ROW EXECUTE FUNCTION "finance"."prevent_closed_period_posting"();



CREATE OR REPLACE TRIGGER "trg_prevent_closed_period_posting" BEFORE INSERT OR UPDATE ON "public"."incomes" FOR EACH ROW EXECUTE FUNCTION "finance"."prevent_closed_period_posting"();



CREATE OR REPLACE TRIGGER "trg_prevent_closed_period_posting" BEFORE INSERT OR UPDATE ON "public"."invoices" FOR EACH ROW EXECUTE FUNCTION "finance"."prevent_closed_period_posting"();



CREATE OR REPLACE TRIGGER "trg_prevent_posted_invoice_deletion" BEFORE DELETE ON "public"."invoices" FOR EACH ROW EXECUTE FUNCTION "public"."prevent_posted_invoice_deletion"();



CREATE OR REPLACE TRIGGER "trg_prevent_posted_invoice_edit" BEFORE UPDATE ON "public"."invoices" FOR EACH ROW EXECUTE FUNCTION "public"."prevent_posted_invoice_edit"();



CREATE OR REPLACE TRIGGER "trg_prevent_posted_payroll_run_edit" BEFORE DELETE OR UPDATE ON "public"."payroll_runs" FOR EACH ROW EXECUTE FUNCTION "public"."prevent_posted_payroll_run_edit"();



CREATE OR REPLACE TRIGGER "trg_subscriptions_updated" BEFORE UPDATE ON "public"."subscriptions" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at"();



CREATE OR REPLACE TRIGGER "trg_sync_invoice_client_name" BEFORE INSERT OR UPDATE OF "client_id" ON "public"."invoices" FOR EACH ROW EXECUTE FUNCTION "public"."sync_invoice_client_name"();



CREATE OR REPLACE TRIGGER "trg_updated_at" BEFORE UPDATE ON "public"."budgets" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at"();



CREATE OR REPLACE TRIGGER "trg_updated_at" BEFORE UPDATE ON "public"."clients" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at"();



ALTER TABLE ONLY "ai"."ai_conversations"
    ADD CONSTRAINT "ai_conversations_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "ai"."ai_document_extractions"
    ADD CONSTRAINT "ai_document_extractions_reviewer_id_fkey" FOREIGN KEY ("reviewer_id") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "ai"."ai_document_extractions"
    ADD CONSTRAINT "ai_document_extractions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "ai"."ai_feedback"
    ADD CONSTRAINT "ai_feedback_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "ai"."ai_messages"("id");



ALTER TABLE ONLY "ai"."ai_feedback"
    ADD CONSTRAINT "ai_feedback_tool_call_id_fkey" FOREIGN KEY ("tool_call_id") REFERENCES "ai"."ai_tool_calls"("id");



ALTER TABLE ONLY "ai"."ai_feedback"
    ADD CONSTRAINT "ai_feedback_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "ai"."ai_messages"
    ADD CONSTRAINT "ai_messages_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "ai"."ai_conversations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "ai"."ai_prompt_versions"
    ADD CONSTRAINT "ai_prompt_versions_approved_by_fkey" FOREIGN KEY ("approved_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "ai"."ai_query_audit"
    ADD CONSTRAINT "ai_query_audit_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "ai"."ai_conversations"("id");



ALTER TABLE ONLY "ai"."ai_query_audit"
    ADD CONSTRAINT "ai_query_audit_tool_call_id_fkey" FOREIGN KEY ("tool_call_id") REFERENCES "ai"."ai_tool_calls"("id");



ALTER TABLE ONLY "ai"."ai_suggestions"
    ADD CONSTRAINT "ai_suggestions_resolved_by_fkey" FOREIGN KEY ("resolved_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "ai"."ai_suggestions"
    ADD CONSTRAINT "ai_suggestions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "ai"."ai_tool_calls"
    ADD CONSTRAINT "ai_tool_calls_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "ai"."ai_conversations"("id");



ALTER TABLE ONLY "ai"."ai_tool_calls"
    ADD CONSTRAINT "ai_tool_calls_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "ai"."ai_messages"("id");



ALTER TABLE ONLY "ai"."ai_user_cost_tracking"
    ADD CONSTRAINT "ai_user_cost_tracking_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "audit"."audit_log"
    ADD CONSTRAINT "audit_log_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "core"."organizations"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "audit"."data_access_events"
    ADD CONSTRAINT "data_access_events_org_fkey" FOREIGN KEY ("organization_id") REFERENCES "core"."organizations"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "audit"."export_events"
    ADD CONSTRAINT "export_events_org_fkey" FOREIGN KEY ("organization_id") REFERENCES "core"."organizations"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "audit"."security_events"
    ADD CONSTRAINT "security_events_org_fkey" FOREIGN KEY ("organization_id") REFERENCES "core"."organizations"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "core"."approval_actions"
    ADD CONSTRAINT "approval_actions_approval_step_id_fkey" FOREIGN KEY ("approval_step_id") REFERENCES "core"."approval_steps"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "core"."approval_limits"
    ADD CONSTRAINT "approval_limits_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "core"."roles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "core"."approval_limits"
    ADD CONSTRAINT "approval_limits_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "core"."approval_steps"
    ADD CONSTRAINT "approval_steps_approval_request_id_fkey" FOREIGN KEY ("approval_request_id") REFERENCES "core"."approval_requests"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "core"."approval_steps"
    ADD CONSTRAINT "approval_steps_required_role_id_fkey" FOREIGN KEY ("required_role_id") REFERENCES "core"."roles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "core"."budget_policies"
    ADD CONSTRAINT "budget_policies_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "core"."budget_policies"
    ADD CONSTRAINT "budget_policies_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "core"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "core"."delegations"
    ADD CONSTRAINT "delegations_from_user_id_fkey" FOREIGN KEY ("from_user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "core"."delegations"
    ADD CONSTRAINT "delegations_to_user_id_fkey" FOREIGN KEY ("to_user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "core"."employee_links"
    ADD CONSTRAINT "employee_links_shared_person_id_fkey" FOREIGN KEY ("shared_person_id") REFERENCES "core"."shared_people"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "core"."idempotency_keys"
    ADD CONSTRAINT "idempotency_keys_org_fkey" FOREIGN KEY ("organization_id") REFERENCES "core"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "core"."integration_events"
    ADD CONSTRAINT "integration_events_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "core"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "core"."integration_failures"
    ADD CONSTRAINT "integration_failures_integration_event_id_fkey" FOREIGN KEY ("integration_event_id") REFERENCES "core"."integration_events"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "core"."organization_config"
    ADD CONSTRAINT "organization_config_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "core"."organization_config"
    ADD CONSTRAINT "organization_config_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "core"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "core"."organization_modules"
    ADD CONSTRAINT "organization_modules_org_fkey" FOREIGN KEY ("organization_id") REFERENCES "core"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "core"."permissions"
    ADD CONSTRAINT "permissions_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "core"."role_permissions"
    ADD CONSTRAINT "role_permissions_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "core"."role_permissions"
    ADD CONSTRAINT "role_permissions_permission_id_fkey" FOREIGN KEY ("permission_id") REFERENCES "core"."permissions"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "core"."role_permissions"
    ADD CONSTRAINT "role_permissions_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "core"."roles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "core"."roles"
    ADD CONSTRAINT "roles_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "core"."shared_people"
    ADD CONSTRAINT "shared_people_auth_user_fkey" FOREIGN KEY ("auth_user_id") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "core"."shared_people"
    ADD CONSTRAINT "shared_people_org_fkey" FOREIGN KEY ("organization_id") REFERENCES "core"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "core"."user_permission_overrides"
    ADD CONSTRAINT "user_permission_overrides_permission_id_fkey" FOREIGN KEY ("permission_id") REFERENCES "core"."permissions"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "core"."user_permission_overrides"
    ADD CONSTRAINT "user_permission_overrides_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "core"."user_roles"
    ADD CONSTRAINT "user_roles_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "core"."user_roles"
    ADD CONSTRAINT "user_roles_delegated_from_fkey" FOREIGN KEY ("delegated_from") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "core"."user_roles"
    ADD CONSTRAINT "user_roles_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "core"."roles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "core"."user_roles"
    ADD CONSTRAINT "user_roles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "finance"."accounting_periods"
    ADD CONSTRAINT "accounting_periods_closed_by_fkey" FOREIGN KEY ("closed_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "finance"."accounting_periods"
    ADD CONSTRAINT "accounting_periods_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "finance"."accounting_periods"
    ADD CONSTRAINT "accounting_periods_fiscal_year_id_fkey" FOREIGN KEY ("fiscal_year_id") REFERENCES "finance"."fiscal_years"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "finance"."asset_categories"
    ADD CONSTRAINT "asset_categories_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "finance"."asset_categories"
    ADD CONSTRAINT "asset_categories_linked_asset_account_id_fkey" FOREIGN KEY ("linked_asset_account_id") REFERENCES "finance"."chart_of_accounts"("id");



ALTER TABLE ONLY "finance"."asset_categories"
    ADD CONSTRAINT "asset_categories_linked_depreciation_account_id_fkey" FOREIGN KEY ("linked_depreciation_account_id") REFERENCES "finance"."chart_of_accounts"("id");



ALTER TABLE ONLY "finance"."asset_categories"
    ADD CONSTRAINT "asset_categories_linked_expense_account_id_fkey" FOREIGN KEY ("linked_expense_account_id") REFERENCES "finance"."chart_of_accounts"("id");



ALTER TABLE ONLY "finance"."asset_verification_lines"
    ADD CONSTRAINT "asset_verification_lines_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "finance"."fixed_assets"("id");



ALTER TABLE ONLY "finance"."asset_verification_lines"
    ADD CONSTRAINT "asset_verification_lines_verification_id_fkey" FOREIGN KEY ("verification_id") REFERENCES "finance"."asset_verifications"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "finance"."asset_verifications"
    ADD CONSTRAINT "asset_verifications_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "finance"."asset_verifications"
    ADD CONSTRAINT "asset_verifications_verified_by_fkey" FOREIGN KEY ("verified_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "finance"."attachments"
    ADD CONSTRAINT "attachments_uploaded_by_fkey" FOREIGN KEY ("uploaded_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "finance"."attendance_period_snapshots"
    ADD CONSTRAINT "attendance_period_snapshots_shared_person_id_fkey" FOREIGN KEY ("shared_person_id") REFERENCES "core"."shared_people"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "finance"."bank_statements"
    ADD CONSTRAINT "bank_statements_financial_account_id_fkey" FOREIGN KEY ("financial_account_id") REFERENCES "finance"."financial_accounts"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "finance"."bank_statements"
    ADD CONSTRAINT "bank_statements_imported_by_fkey" FOREIGN KEY ("imported_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "finance"."bank_statements"
    ADD CONSTRAINT "bank_statements_reconciled_by_fkey" FOREIGN KEY ("reconciled_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "finance"."bank_transfers"
    ADD CONSTRAINT "bank_transfers_approved_by_fkey" FOREIGN KEY ("approved_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "finance"."bank_transfers"
    ADD CONSTRAINT "bank_transfers_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "finance"."bank_transfers"
    ADD CONSTRAINT "bank_transfers_from_account_id_fkey" FOREIGN KEY ("from_account_id") REFERENCES "finance"."financial_accounts"("id");



ALTER TABLE ONLY "finance"."bank_transfers"
    ADD CONSTRAINT "bank_transfers_posted_by_fkey" FOREIGN KEY ("posted_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "finance"."bank_transfers"
    ADD CONSTRAINT "bank_transfers_rejected_by_fkey" FOREIGN KEY ("rejected_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "finance"."bank_transfers"
    ADD CONSTRAINT "bank_transfers_second_approved_by_fkey" FOREIGN KEY ("second_approved_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "finance"."bank_transfers"
    ADD CONSTRAINT "bank_transfers_to_account_id_fkey" FOREIGN KEY ("to_account_id") REFERENCES "finance"."financial_accounts"("id");



ALTER TABLE ONLY "finance"."budget_commitments"
    ADD CONSTRAINT "budget_commitments_budget_line_id_fkey" FOREIGN KEY ("budget_line_id") REFERENCES "finance"."budget_lines"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "finance"."budget_commitments"
    ADD CONSTRAINT "budget_commitments_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "core"."organizations"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "finance"."budget_lines"
    ADD CONSTRAINT "budget_lines_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "finance"."chart_of_accounts"("id");



ALTER TABLE ONLY "finance"."budget_lines"
    ADD CONSTRAINT "budget_lines_budget_id_fkey" FOREIGN KEY ("budget_id") REFERENCES "public"."budgets"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "finance"."budget_lines"
    ADD CONSTRAINT "budget_lines_period_id_fkey" FOREIGN KEY ("period_id") REFERENCES "finance"."accounting_periods"("id");



ALTER TABLE ONLY "finance"."budget_revisions"
    ADD CONSTRAINT "budget_revisions_budget_id_fkey" FOREIGN KEY ("budget_id") REFERENCES "public"."budgets"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "finance"."capital_transactions"
    ADD CONSTRAINT "capital_transactions_financial_account_id_fkey" FOREIGN KEY ("financial_account_id") REFERENCES "finance"."financial_accounts"("id");



ALTER TABLE ONLY "finance"."capital_transactions"
    ADD CONSTRAINT "capital_transactions_journal_entry_id_fkey" FOREIGN KEY ("journal_entry_id") REFERENCES "finance"."journal_entries"("id");



ALTER TABLE ONLY "finance"."capital_transactions"
    ADD CONSTRAINT "capital_transactions_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "finance"."owners"("id");



ALTER TABLE ONLY "finance"."chart_of_accounts"
    ADD CONSTRAINT "chart_of_accounts_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "finance"."chart_of_accounts"
    ADD CONSTRAINT "chart_of_accounts_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "core"."organizations"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "finance"."chart_of_accounts"
    ADD CONSTRAINT "chart_of_accounts_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "finance"."chart_of_accounts"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "finance"."credit_notes"
    ADD CONSTRAINT "credit_notes_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "finance"."credit_notes"
    ADD CONSTRAINT "credit_notes_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "finance"."credit_notes"
    ADD CONSTRAINT "credit_notes_vendor_bill_id_fkey" FOREIGN KEY ("vendor_bill_id") REFERENCES "finance"."vendor_bills"("id");



ALTER TABLE ONLY "finance"."currency_settings"
    ADD CONSTRAINT "currency_settings_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "core"."organizations"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "finance"."currency_settings"
    ADD CONSTRAINT "currency_settings_rounding_account_id_fkey" FOREIGN KEY ("rounding_account_id") REFERENCES "finance"."chart_of_accounts"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "finance"."depreciation_schedule"
    ADD CONSTRAINT "depreciation_schedule_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "finance"."fixed_assets"("id");



ALTER TABLE ONLY "finance"."depreciation_schedule"
    ADD CONSTRAINT "depreciation_schedule_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "finance"."depreciation_schedule"
    ADD CONSTRAINT "depreciation_schedule_fiscal_year_id_fkey" FOREIGN KEY ("fiscal_year_id") REFERENCES "finance"."fiscal_years"("id");



ALTER TABLE ONLY "finance"."depreciation_schedule"
    ADD CONSTRAINT "depreciation_schedule_journal_entry_id_fkey" FOREIGN KEY ("journal_entry_id") REFERENCES "finance"."journal_entries"("id");



ALTER TABLE ONLY "finance"."depreciation_schedule"
    ADD CONSTRAINT "depreciation_schedule_period_id_fkey" FOREIGN KEY ("period_id") REFERENCES "finance"."accounting_periods"("id");



ALTER TABLE ONLY "finance"."dimensions"
    ADD CONSTRAINT "dimensions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "core"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "finance"."dimensions"
    ADD CONSTRAINT "dimensions_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "finance"."dimensions"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "finance"."distribution_lines"
    ADD CONSTRAINT "distribution_lines_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "finance"."owners"("id");



ALTER TABLE ONLY "finance"."distribution_lines"
    ADD CONSTRAINT "distribution_lines_profit_distribution_id_fkey" FOREIGN KEY ("profit_distribution_id") REFERENCES "finance"."profit_distributions"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "finance"."exchange_rates"
    ADD CONSTRAINT "exchange_rates_entered_by_fkey" FOREIGN KEY ("entered_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "finance"."expense_lines"
    ADD CONSTRAINT "expense_lines_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "finance"."chart_of_accounts"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "finance"."expense_lines"
    ADD CONSTRAINT "expense_lines_cost_center_id_fkey" FOREIGN KEY ("cost_center_id") REFERENCES "finance"."dimensions"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "finance"."expense_lines"
    ADD CONSTRAINT "expense_lines_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "finance"."dimensions"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "finance"."expense_lines"
    ADD CONSTRAINT "expense_lines_expense_id_fkey" FOREIGN KEY ("expense_id") REFERENCES "public"."expenses"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "finance"."expense_lines"
    ADD CONSTRAINT "expense_lines_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "core"."organizations"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "finance"."expense_lines"
    ADD CONSTRAINT "expense_lines_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "finance"."expense_lines"
    ADD CONSTRAINT "expense_lines_tax_code_id_fkey" FOREIGN KEY ("tax_code_id") REFERENCES "finance"."tax_codes"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "finance"."expense_lines"
    ADD CONSTRAINT "expense_lines_vendor_id_fkey" FOREIGN KEY ("vendor_id") REFERENCES "finance"."vendors"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "finance"."fee_computation_log"
    ADD CONSTRAINT "fee_computation_log_computed_by_fkey" FOREIGN KEY ("computed_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "finance"."fee_computation_log"
    ADD CONSTRAINT "fee_computation_log_fee_rule_id_fkey" FOREIGN KEY ("fee_rule_id") REFERENCES "finance"."fee_rules"("id");



ALTER TABLE ONLY "finance"."fee_computation_log"
    ADD CONSTRAINT "fee_computation_log_platform_id_fkey" FOREIGN KEY ("platform_id") REFERENCES "finance"."platforms"("id");



ALTER TABLE ONLY "finance"."fee_rules"
    ADD CONSTRAINT "fee_rules_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "finance"."fee_rules"
    ADD CONSTRAINT "fee_rules_platform_id_fkey" FOREIGN KEY ("platform_id") REFERENCES "finance"."platforms"("id");



ALTER TABLE ONLY "finance"."fee_tiers"
    ADD CONSTRAINT "fee_tiers_fee_rule_id_fkey" FOREIGN KEY ("fee_rule_id") REFERENCES "finance"."fee_rules"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "finance"."financial_accounts"
    ADD CONSTRAINT "financial_accounts_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "finance"."financial_accounts"
    ADD CONSTRAINT "financial_accounts_linked_ledger_account_id_fkey" FOREIGN KEY ("linked_ledger_account_id") REFERENCES "finance"."chart_of_accounts"("id");



ALTER TABLE ONLY "finance"."financial_accounts"
    ADD CONSTRAINT "financial_accounts_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "core"."organizations"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "finance"."financial_accounts"
    ADD CONSTRAINT "financial_accounts_responsible_user_id_fkey" FOREIGN KEY ("responsible_user_id") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "finance"."fiscal_years"
    ADD CONSTRAINT "fiscal_years_closed_by_fkey" FOREIGN KEY ("closed_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "finance"."fiscal_years"
    ADD CONSTRAINT "fiscal_years_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "finance"."fixed_assets"
    ADD CONSTRAINT "fixed_assets_approved_by_fkey" FOREIGN KEY ("approved_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "finance"."fixed_assets"
    ADD CONSTRAINT "fixed_assets_assigned_user_id_fkey" FOREIGN KEY ("assigned_user_id") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "finance"."fixed_assets"
    ADD CONSTRAINT "fixed_assets_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "finance"."asset_categories"("id");



ALTER TABLE ONLY "finance"."fixed_assets"
    ADD CONSTRAINT "fixed_assets_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "finance"."fixed_assets"
    ADD CONSTRAINT "fixed_assets_disposal_journal_id_fkey" FOREIGN KEY ("disposal_journal_id") REFERENCES "finance"."journal_entries"("id");



ALTER TABLE ONLY "finance"."fixed_assets"
    ADD CONSTRAINT "fixed_assets_exchange_rate_id_fkey" FOREIGN KEY ("exchange_rate_id") REFERENCES "finance"."exchange_rates"("id");



ALTER TABLE ONLY "finance"."fixed_assets"
    ADD CONSTRAINT "fixed_assets_linked_asset_account_id_fkey" FOREIGN KEY ("linked_asset_account_id") REFERENCES "finance"."chart_of_accounts"("id");



ALTER TABLE ONLY "finance"."fixed_assets"
    ADD CONSTRAINT "fixed_assets_linked_depreciation_account_id_fkey" FOREIGN KEY ("linked_depreciation_account_id") REFERENCES "finance"."chart_of_accounts"("id");



ALTER TABLE ONLY "finance"."fixed_assets"
    ADD CONSTRAINT "fixed_assets_linked_expense_account_id_fkey" FOREIGN KEY ("linked_expense_account_id") REFERENCES "finance"."chart_of_accounts"("id");



ALTER TABLE ONLY "finance"."fixed_assets"
    ADD CONSTRAINT "fixed_assets_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id");



ALTER TABLE ONLY "finance"."fixed_assets"
    ADD CONSTRAINT "fixed_assets_vendor_id_fkey" FOREIGN KEY ("vendor_id") REFERENCES "finance"."vendors"("id");



ALTER TABLE ONLY "finance"."invoice_lines"
    ADD CONSTRAINT "invoice_lines_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "finance"."chart_of_accounts"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "finance"."invoice_lines"
    ADD CONSTRAINT "invoice_lines_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "finance"."invoice_lines"
    ADD CONSTRAINT "invoice_lines_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "core"."organizations"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "finance"."invoice_lines"
    ADD CONSTRAINT "invoice_lines_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "finance"."invoice_lines"
    ADD CONSTRAINT "invoice_lines_tax_code_id_fkey" FOREIGN KEY ("tax_code_id") REFERENCES "finance"."tax_codes"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "finance"."journal_entries"
    ADD CONSTRAINT "journal_entries_approved_by_fkey" FOREIGN KEY ("approved_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "finance"."journal_entries"
    ADD CONSTRAINT "journal_entries_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "finance"."journal_entries"
    ADD CONSTRAINT "journal_entries_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "core"."organizations"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "finance"."journal_entries"
    ADD CONSTRAINT "journal_entries_posted_by_fkey" FOREIGN KEY ("posted_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "finance"."journal_entries"
    ADD CONSTRAINT "journal_entries_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "finance"."journal_entries"
    ADD CONSTRAINT "journal_entries_reversal_of_id_fkey" FOREIGN KEY ("reversal_of_id") REFERENCES "finance"."journal_entries"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "finance"."journal_entries"
    ADD CONSTRAINT "journal_entries_reversed_by_fkey" FOREIGN KEY ("reversed_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "finance"."journal_entries"
    ADD CONSTRAINT "journal_entries_submitted_by_fkey" FOREIGN KEY ("submitted_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "finance"."journal_entries"
    ADD CONSTRAINT "journal_entries_verified_by_fkey" FOREIGN KEY ("verified_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "finance"."journal_lines"
    ADD CONSTRAINT "journal_lines_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "finance"."chart_of_accounts"("id");



ALTER TABLE ONLY "finance"."journal_lines"
    ADD CONSTRAINT "journal_lines_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "finance"."journal_lines"
    ADD CONSTRAINT "journal_lines_journal_entry_id_fkey" FOREIGN KEY ("journal_entry_id") REFERENCES "finance"."journal_entries"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "finance"."journal_lines"
    ADD CONSTRAINT "journal_lines_tax_code_id_fkey" FOREIGN KEY ("tax_code_id") REFERENCES "finance"."tax_codes"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "finance"."numbering_sequences"
    ADD CONSTRAINT "numbering_sequences_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "finance"."opening_balance_imports"
    ADD CONSTRAINT "opening_balance_imports_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "finance"."chart_of_accounts"("id");



ALTER TABLE ONLY "finance"."opening_balance_imports"
    ADD CONSTRAINT "opening_balance_imports_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "core"."organizations"("id");



ALTER TABLE ONLY "finance"."owners"
    ADD CONSTRAINT "owners_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "finance"."ownership_history"
    ADD CONSTRAINT "ownership_history_approved_by_fkey" FOREIGN KEY ("approved_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "finance"."ownership_history"
    ADD CONSTRAINT "ownership_history_changed_by_fkey" FOREIGN KEY ("changed_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "finance"."ownership_history"
    ADD CONSTRAINT "ownership_history_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "finance"."owners"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "finance"."payment_allocations"
    ADD CONSTRAINT "payment_allocations_allocated_by_fkey" FOREIGN KEY ("allocated_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "finance"."payment_allocations"
    ADD CONSTRAINT "payment_allocations_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "finance"."payment_allocations"
    ADD CONSTRAINT "payment_allocations_payment_receipt_id_fkey" FOREIGN KEY ("payment_receipt_id") REFERENCES "finance"."payment_receipts"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "finance"."payment_receipts"
    ADD CONSTRAINT "payment_receipts_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE RESTRICT NOT VALID;



ALTER TABLE ONLY "finance"."payment_receipts"
    ADD CONSTRAINT "payment_receipts_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "finance"."payment_receipts"
    ADD CONSTRAINT "payment_receipts_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "finance"."platforms"
    ADD CONSTRAINT "platforms_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "finance"."profit_distributions"
    ADD CONSTRAINT "profit_distributions_approved_by_fkey" FOREIGN KEY ("approved_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "finance"."profit_distributions"
    ADD CONSTRAINT "profit_distributions_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "finance"."profit_distributions"
    ADD CONSTRAINT "profit_distributions_declared_by_fkey" FOREIGN KEY ("declared_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "finance"."profit_distributions"
    ADD CONSTRAINT "profit_distributions_posted_by_fkey" FOREIGN KEY ("posted_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "finance"."reserve_policies"
    ADD CONSTRAINT "reserve_policies_approved_by_fkey" FOREIGN KEY ("approved_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "finance"."reserve_policies"
    ADD CONSTRAINT "reserve_policies_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "finance"."settlement_batches"
    ADD CONSTRAINT "settlement_batches_evidence_attachment_id_fkey" FOREIGN KEY ("evidence_attachment_id") REFERENCES "finance"."attachments"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "finance"."settlement_batches"
    ADD CONSTRAINT "settlement_batches_financial_account_id_fkey" FOREIGN KEY ("financial_account_id") REFERENCES "finance"."financial_accounts"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "finance"."settlement_batches"
    ADD CONSTRAINT "settlement_batches_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "core"."organizations"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "finance"."settlement_batches"
    ADD CONSTRAINT "settlement_batches_platform_id_fkey" FOREIGN KEY ("platform_id") REFERENCES "finance"."platforms"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "finance"."settlement_lines"
    ADD CONSTRAINT "settlement_lines_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "finance"."settlement_lines"
    ADD CONSTRAINT "settlement_lines_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "core"."organizations"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "finance"."settlement_lines"
    ADD CONSTRAINT "settlement_lines_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "finance"."settlement_lines"
    ADD CONSTRAINT "settlement_lines_settlement_batch_id_fkey" FOREIGN KEY ("settlement_batch_id") REFERENCES "finance"."settlement_batches"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "finance"."statement_lines"
    ADD CONSTRAINT "statement_lines_bank_statement_id_fkey" FOREIGN KEY ("bank_statement_id") REFERENCES "finance"."bank_statements"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "finance"."statement_lines"
    ADD CONSTRAINT "statement_lines_matched_by_fkey" FOREIGN KEY ("matched_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "finance"."statement_lines"
    ADD CONSTRAINT "statement_lines_matched_journal_line_id_fkey" FOREIGN KEY ("matched_journal_line_id") REFERENCES "finance"."journal_lines"("id");



ALTER TABLE ONLY "finance"."tax_adjustments"
    ADD CONSTRAINT "tax_adjustments_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "finance"."tax_adjustments"
    ADD CONSTRAINT "tax_adjustments_source_account_id_fkey" FOREIGN KEY ("source_account_id") REFERENCES "finance"."chart_of_accounts"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "finance"."tax_adjustments"
    ADD CONSTRAINT "tax_adjustments_tax_reconciliation_id_fkey" FOREIGN KEY ("tax_reconciliation_id") REFERENCES "finance"."tax_reconciliations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "finance"."tax_codes"
    ADD CONSTRAINT "tax_codes_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "core"."organizations"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "finance"."tax_codes"
    ADD CONSTRAINT "tax_codes_payable_account_id_fkey" FOREIGN KEY ("payable_account_id") REFERENCES "finance"."chart_of_accounts"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "finance"."tax_codes"
    ADD CONSTRAINT "tax_codes_recoverable_account_id_fkey" FOREIGN KEY ("recoverable_account_id") REFERENCES "finance"."chart_of_accounts"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "finance"."tax_computations"
    ADD CONSTRAINT "tax_computations_fiscal_year_id_fkey" FOREIGN KEY ("fiscal_year_id") REFERENCES "finance"."fiscal_years"("id");



ALTER TABLE ONLY "finance"."tax_computations"
    ADD CONSTRAINT "tax_computations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "core"."organization_config"("id");



ALTER TABLE ONLY "finance"."tax_computations"
    ADD CONSTRAINT "tax_computations_period_id_fkey" FOREIGN KEY ("period_id") REFERENCES "finance"."accounting_periods"("id");



ALTER TABLE ONLY "finance"."tax_computations"
    ADD CONSTRAINT "tax_computations_tax_return_id_fkey" FOREIGN KEY ("tax_return_id") REFERENCES "finance"."tax_returns"("id");



ALTER TABLE ONLY "finance"."tax_computations"
    ADD CONSTRAINT "tax_computations_tax_rule_set_id_fkey" FOREIGN KEY ("tax_rule_set_id") REFERENCES "finance"."tax_rule_sets"("id");



ALTER TABLE ONLY "finance"."tax_credits_and_withholding"
    ADD CONSTRAINT "tax_credits_and_withholding_fiscal_year_id_fkey" FOREIGN KEY ("fiscal_year_id") REFERENCES "finance"."fiscal_years"("id");



ALTER TABLE ONLY "finance"."tax_credits_and_withholding"
    ADD CONSTRAINT "tax_credits_and_withholding_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "core"."organization_config"("id");



ALTER TABLE ONLY "finance"."tax_credits_and_withholding"
    ADD CONSTRAINT "tax_credits_and_withholding_period_id_fkey" FOREIGN KEY ("period_id") REFERENCES "finance"."accounting_periods"("id");



ALTER TABLE ONLY "finance"."tax_credits_and_withholding"
    ADD CONSTRAINT "tax_credits_and_withholding_tax_computation_id_fkey" FOREIGN KEY ("tax_computation_id") REFERENCES "finance"."tax_computations"("id");



ALTER TABLE ONLY "finance"."tax_credits_and_withholding"
    ADD CONSTRAINT "tax_credits_and_withholding_tax_return_id_fkey" FOREIGN KEY ("tax_return_id") REFERENCES "finance"."tax_returns"("id");



ALTER TABLE ONLY "finance"."tax_payments_and_refunds"
    ADD CONSTRAINT "tax_payments_and_refunds_financial_account_id_fkey" FOREIGN KEY ("financial_account_id") REFERENCES "finance"."financial_accounts"("id");



ALTER TABLE ONLY "finance"."tax_payments_and_refunds"
    ADD CONSTRAINT "tax_payments_and_refunds_fiscal_year_id_fkey" FOREIGN KEY ("fiscal_year_id") REFERENCES "finance"."fiscal_years"("id");



ALTER TABLE ONLY "finance"."tax_payments_and_refunds"
    ADD CONSTRAINT "tax_payments_and_refunds_journal_entry_id_fkey" FOREIGN KEY ("journal_entry_id") REFERENCES "finance"."journal_entries"("id");



ALTER TABLE ONLY "finance"."tax_payments_and_refunds"
    ADD CONSTRAINT "tax_payments_and_refunds_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "core"."organization_config"("id");



ALTER TABLE ONLY "finance"."tax_payments_and_refunds"
    ADD CONSTRAINT "tax_payments_and_refunds_period_id_fkey" FOREIGN KEY ("period_id") REFERENCES "finance"."accounting_periods"("id");



ALTER TABLE ONLY "finance"."tax_payments_and_refunds"
    ADD CONSTRAINT "tax_payments_and_refunds_tax_computation_id_fkey" FOREIGN KEY ("tax_computation_id") REFERENCES "finance"."tax_computations"("id");



ALTER TABLE ONLY "finance"."tax_payments_and_refunds"
    ADD CONSTRAINT "tax_payments_and_refunds_tax_return_id_fkey" FOREIGN KEY ("tax_return_id") REFERENCES "finance"."tax_returns"("id");



ALTER TABLE ONLY "finance"."tax_reconciliations"
    ADD CONSTRAINT "tax_reconciliations_accountant_approved_by_fkey" FOREIGN KEY ("accountant_approved_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "finance"."tax_reconciliations"
    ADD CONSTRAINT "tax_reconciliations_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "finance"."tax_reconciliations"
    ADD CONSTRAINT "tax_reconciliations_tax_rule_set_id_fkey" FOREIGN KEY ("tax_rule_set_id") REFERENCES "finance"."tax_rule_sets"("id");



ALTER TABLE ONLY "finance"."tax_returns"
    ADD CONSTRAINT "tax_returns_fiscal_year_id_fkey" FOREIGN KEY ("fiscal_year_id") REFERENCES "finance"."fiscal_years"("id");



ALTER TABLE ONLY "finance"."tax_returns"
    ADD CONSTRAINT "tax_returns_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "core"."organization_config"("id");



ALTER TABLE ONLY "finance"."tax_returns"
    ADD CONSTRAINT "tax_returns_period_id_fkey" FOREIGN KEY ("period_id") REFERENCES "finance"."accounting_periods"("id");



ALTER TABLE ONLY "finance"."tax_returns"
    ADD CONSTRAINT "tax_returns_tax_reconciliation_id_fkey" FOREIGN KEY ("tax_reconciliation_id") REFERENCES "finance"."tax_reconciliations"("id");



ALTER TABLE ONLY "finance"."tax_returns"
    ADD CONSTRAINT "tax_returns_tax_rule_set_id_fkey" FOREIGN KEY ("tax_rule_set_id") REFERENCES "finance"."tax_rule_sets"("id");



ALTER TABLE ONLY "finance"."tax_rule_sets"
    ADD CONSTRAINT "tax_rule_sets_approved_by_fkey" FOREIGN KEY ("approved_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "finance"."tax_rule_sets"
    ADD CONSTRAINT "tax_rule_sets_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "finance"."tax_slabs"
    ADD CONSTRAINT "tax_slabs_tax_rule_set_id_fkey" FOREIGN KEY ("tax_rule_set_id") REFERENCES "finance"."tax_rule_sets"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "finance"."taxpayer_profile"
    ADD CONSTRAINT "taxpayer_profile_approved_by_fkey" FOREIGN KEY ("approved_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "finance"."taxpayer_profile"
    ADD CONSTRAINT "taxpayer_profile_configured_by_fkey" FOREIGN KEY ("configured_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "finance"."vendor_bill_lines"
    ADD CONSTRAINT "vendor_bill_lines_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "finance"."chart_of_accounts"("id");



ALTER TABLE ONLY "finance"."vendor_bill_lines"
    ADD CONSTRAINT "vendor_bill_lines_tax_code_id_fkey" FOREIGN KEY ("tax_code_id") REFERENCES "finance"."tax_codes"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "finance"."vendor_bill_lines"
    ADD CONSTRAINT "vendor_bill_lines_vendor_bill_id_fkey" FOREIGN KEY ("vendor_bill_id") REFERENCES "finance"."vendor_bills"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "finance"."vendor_bills"
    ADD CONSTRAINT "vendor_bills_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "finance"."vendor_bills"
    ADD CONSTRAINT "vendor_bills_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "core"."organizations"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "finance"."vendor_bills"
    ADD CONSTRAINT "vendor_bills_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "finance"."vendor_bills"
    ADD CONSTRAINT "vendor_bills_vendor_id_fkey" FOREIGN KEY ("vendor_id") REFERENCES "finance"."vendors"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "finance"."vendor_payment_allocations"
    ADD CONSTRAINT "vendor_payment_allocations_allocated_by_fkey" FOREIGN KEY ("allocated_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "finance"."vendor_payment_allocations"
    ADD CONSTRAINT "vendor_payment_allocations_vendor_bill_id_fkey" FOREIGN KEY ("vendor_bill_id") REFERENCES "finance"."vendor_bills"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "finance"."vendor_payment_allocations"
    ADD CONSTRAINT "vendor_payment_allocations_vendor_payment_id_fkey" FOREIGN KEY ("vendor_payment_id") REFERENCES "finance"."vendor_payments"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "finance"."vendor_payments"
    ADD CONSTRAINT "vendor_payments_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "finance"."vendor_payments"
    ADD CONSTRAINT "vendor_payments_vendor_id_fkey" FOREIGN KEY ("vendor_id") REFERENCES "finance"."vendors"("id");



ALTER TABLE ONLY "finance"."vendors"
    ADD CONSTRAINT "vendors_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "legacy"."budget_lines"
    ADD CONSTRAINT "budget_lines_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "finance"."chart_of_accounts"("id");



ALTER TABLE ONLY "legacy"."budget_lines"
    ADD CONSTRAINT "budget_lines_budget_id_fkey" FOREIGN KEY ("budget_id") REFERENCES "public"."budgets"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "legacy"."financial_accounts"
    ADD CONSTRAINT "financial_accounts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "legacy"."tax_returns"
    ADD CONSTRAINT "tax_returns_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."budgets"
    ADD CONSTRAINT "budgets_control_account_id_fkey" FOREIGN KEY ("control_account_id") REFERENCES "finance"."chart_of_accounts"("id");



ALTER TABLE ONLY "public"."budgets"
    ADD CONSTRAINT "budgets_fiscal_year_id_fkey" FOREIGN KEY ("fiscal_year_id") REFERENCES "finance"."fiscal_years"("id");



ALTER TABLE ONLY "public"."budgets"
    ADD CONSTRAINT "budgets_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "core"."organizations"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."budgets"
    ADD CONSTRAINT "budgets_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."budgets"
    ADD CONSTRAINT "budgets_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."clients"
    ADD CONSTRAINT "clients_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "core"."organizations"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."clients"
    ADD CONSTRAINT "clients_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."commissions"
    ADD CONSTRAINT "commissions_approved_by_fkey" FOREIGN KEY ("approved_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."commissions"
    ADD CONSTRAINT "commissions_contractor_id_fkey" FOREIGN KEY ("contractor_id") REFERENCES "public"."contractors"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."commissions"
    ADD CONSTRAINT "commissions_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."commissions"
    ADD CONSTRAINT "commissions_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."contractors"
    ADD CONSTRAINT "contractors_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."contractors"
    ADD CONSTRAINT "contractors_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."expenses"
    ADD CONSTRAINT "expenses_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "finance"."chart_of_accounts"("id");



ALTER TABLE ONLY "public"."expenses"
    ADD CONSTRAINT "expenses_journal_entry_id_fkey" FOREIGN KEY ("journal_entry_id") REFERENCES "finance"."journal_entries"("id");



ALTER TABLE ONLY "public"."expenses"
    ADD CONSTRAINT "expenses_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "core"."organizations"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."expenses"
    ADD CONSTRAINT "expenses_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."expenses"
    ADD CONSTRAINT "expenses_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "fk_profiles_organization_id" FOREIGN KEY ("organization_id") REFERENCES "core"."organizations"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."incomes"
    ADD CONSTRAINT "incomes_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "finance"."chart_of_accounts"("id");



ALTER TABLE ONLY "public"."incomes"
    ADD CONSTRAINT "incomes_journal_entry_id_fkey" FOREIGN KEY ("journal_entry_id") REFERENCES "finance"."journal_entries"("id");



ALTER TABLE ONLY "public"."incomes"
    ADD CONSTRAINT "incomes_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."incomes"
    ADD CONSTRAINT "incomes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."invoices"
    ADD CONSTRAINT "invoices_journal_entry_id_fkey" FOREIGN KEY ("journal_entry_id") REFERENCES "finance"."journal_entries"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."invoices"
    ADD CONSTRAINT "invoices_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "core"."organizations"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."invoices"
    ADD CONSTRAINT "invoices_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."invoices"
    ADD CONSTRAINT "invoices_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."notification_deliveries"
    ADD CONSTRAINT "notification_deliveries_notification_id_fkey" FOREIGN KEY ("notification_id") REFERENCES "public"."notifications"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."notifications"
    ADD CONSTRAINT "notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."payments"
    ADD CONSTRAINT "payments_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."payments"
    ADD CONSTRAINT "payments_journal_entry_id_fkey" FOREIGN KEY ("journal_entry_id") REFERENCES "finance"."journal_entries"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."payments"
    ADD CONSTRAINT "payments_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "core"."organizations"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."payments"
    ADD CONSTRAINT "payments_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."payments"
    ADD CONSTRAINT "payments_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."payroll_advances"
    ADD CONSTRAINT "payroll_advances_approved_by_fkey" FOREIGN KEY ("approved_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."payroll_advances"
    ADD CONSTRAINT "payroll_advances_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."payroll_advances"
    ADD CONSTRAINT "payroll_advances_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "public"."payroll_employees"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."payroll_commissions"
    ADD CONSTRAINT "payroll_commissions_approved_by_fkey" FOREIGN KEY ("approved_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."payroll_commissions"
    ADD CONSTRAINT "payroll_commissions_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."payroll_commissions"
    ADD CONSTRAINT "payroll_commissions_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "public"."payroll_employees"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."payroll_commissions"
    ADD CONSTRAINT "payroll_commissions_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."payroll_compensation"
    ADD CONSTRAINT "payroll_compensation_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."payroll_compensation"
    ADD CONSTRAINT "payroll_compensation_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "public"."payroll_employees"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."payroll_compensation"
    ADD CONSTRAINT "payroll_compensation_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."payroll_deductions"
    ADD CONSTRAINT "payroll_deductions_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."payroll_deductions"
    ADD CONSTRAINT "payroll_deductions_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "public"."payroll_employees"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."payroll_employees"
    ADD CONSTRAINT "payroll_employees_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."payroll_employees"
    ADD CONSTRAINT "payroll_employees_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."payroll_lines"
    ADD CONSTRAINT "payroll_lines_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "public"."payroll_employees"("id");



ALTER TABLE ONLY "public"."payroll_lines"
    ADD CONSTRAINT "payroll_lines_payroll_run_id_fkey" FOREIGN KEY ("payroll_run_id") REFERENCES "public"."payroll_runs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."payroll_lines"
    ADD CONSTRAINT "payroll_lines_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."payroll_reimbursements"
    ADD CONSTRAINT "payroll_reimbursements_approved_by_fkey" FOREIGN KEY ("approved_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."payroll_reimbursements"
    ADD CONSTRAINT "payroll_reimbursements_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."payroll_reimbursements"
    ADD CONSTRAINT "payroll_reimbursements_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "public"."payroll_employees"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."payroll_reimbursements"
    ADD CONSTRAINT "payroll_reimbursements_payroll_run_id_fkey" FOREIGN KEY ("payroll_run_id") REFERENCES "public"."payroll_runs"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."payroll_reimbursements"
    ADD CONSTRAINT "payroll_reimbursements_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."payroll_runs"
    ADD CONSTRAINT "payroll_runs_approved_by_fkey" FOREIGN KEY ("approved_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."payroll_runs"
    ADD CONSTRAINT "payroll_runs_calculated_by_fkey" FOREIGN KEY ("calculated_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."payroll_runs"
    ADD CONSTRAINT "payroll_runs_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."payroll_runs"
    ADD CONSTRAINT "payroll_runs_posted_by_fkey" FOREIGN KEY ("posted_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "finance"."dimensions"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_manager_id_fkey" FOREIGN KEY ("manager_id") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."projects"
    ADD CONSTRAINT "projects_budget_id_fkey" FOREIGN KEY ("budget_id") REFERENCES "public"."budgets"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."projects"
    ADD CONSTRAINT "projects_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "core"."organizations"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."projects"
    ADD CONSTRAINT "projects_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."subscriptions"
    ADD CONSTRAINT "subscriptions_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."subscriptions"
    ADD CONSTRAINT "subscriptions_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."user_mfa"
    ADD CONSTRAINT "user_mfa_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



CREATE POLICY "admin_write_model_registry" ON "ai"."ai_model_registry" USING ((EXISTS ( SELECT 1
   FROM ("core"."user_roles" "ur"
     JOIN "core"."roles" "r" ON (("r"."id" = "ur"."role_id")))
  WHERE (("ur"."user_id" = "auth"."uid"()) AND ("r"."name" = ANY (ARRAY['CEO'::"text", 'Admin'::"text", 'TECHNICAL_ADMIN'::"text"])) AND ("ur"."effective_from" <= "now"()) AND (("ur"."effective_to" IS NULL) OR ("ur"."effective_to" >= "now"()))))));



CREATE POLICY "admin_write_prompts" ON "ai"."ai_prompt_versions" USING ((EXISTS ( SELECT 1
   FROM ("core"."user_roles" "ur"
     JOIN "core"."roles" "r" ON (("r"."id" = "ur"."role_id")))
  WHERE (("ur"."user_id" = "auth"."uid"()) AND ("r"."name" = ANY (ARRAY['CEO'::"text", 'Admin'::"text", 'TECHNICAL_ADMIN'::"text"])) AND ("ur"."effective_from" <= "now"()) AND (("ur"."effective_to" IS NULL) OR ("ur"."effective_to" >= "now"()))))));



ALTER TABLE "ai"."ai_conversations" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "ai"."ai_document_extractions" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "ai"."ai_feedback" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "ai"."ai_messages" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "ai"."ai_model_registry" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "ai"."ai_prompt_versions" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "ai"."ai_query_audit" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "ai"."ai_suggestions" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "ai"."ai_tool_calls" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "ai"."ai_user_cost_tracking" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "authenticated_read_model_registry" ON "ai"."ai_model_registry" FOR SELECT TO "authenticated" USING (("core"."has_role"('CEO'::"text") OR "core"."has_role"('FINANCE_HEAD'::"text") OR "core"."has_role"('Admin'::"text") OR "core"."has_role"('TECHNICAL_ADMIN'::"text")));



CREATE POLICY "authenticated_read_prompts" ON "ai"."ai_prompt_versions" FOR SELECT TO "authenticated" USING (("core"."has_role"('CEO'::"text") OR "core"."has_role"('FINANCE_HEAD'::"text") OR "core"."has_role"('Admin'::"text") OR "core"."has_role"('TECHNICAL_ADMIN'::"text")));



CREATE POLICY "delete_own_conversations" ON "ai"."ai_conversations" FOR DELETE USING (("user_id" = "auth"."uid"()));



CREATE POLICY "read_ai_conversations" ON "ai"."ai_conversations" FOR SELECT USING (((("user_id" = "auth"."uid"()) AND "core"."same_org"("organization_id")) OR ((EXISTS ( SELECT 1
   FROM ("core"."user_roles" "ur"
     JOIN "core"."roles" "r" ON (("r"."id" = "ur"."role_id")))
  WHERE (("ur"."user_id" = "auth"."uid"()) AND ("r"."name" = ANY (ARRAY['CEO'::"text", 'FINANCE_HEAD'::"text", 'AUDITOR'::"text", 'Admin'::"text"])) AND ("ur"."effective_from" <= "now"()) AND (("ur"."effective_to" IS NULL) OR ("ur"."effective_to" >= "now"()))))) AND "core"."same_org"("organization_id"))));



CREATE POLICY "read_ai_messages" ON "ai"."ai_messages" FOR SELECT USING ((("conversation_id" IN ( SELECT "c"."id"
   FROM "ai"."ai_conversations" "c"
  WHERE (("c"."user_id" = "auth"."uid"()) AND "core"."same_org"("c"."organization_id")))) OR ((EXISTS ( SELECT 1
   FROM ("core"."user_roles" "ur"
     JOIN "core"."roles" "r" ON (("r"."id" = "ur"."role_id")))
  WHERE (("ur"."user_id" = "auth"."uid"()) AND ("r"."name" = ANY (ARRAY['CEO'::"text", 'FINANCE_HEAD'::"text", 'AUDITOR'::"text", 'Admin'::"text"])) AND ("ur"."effective_from" <= "now"()) AND (("ur"."effective_to" IS NULL) OR ("ur"."effective_to" >= "now"()))))) AND ("conversation_id" IN ( SELECT "c"."id"
   FROM "ai"."ai_conversations" "c"
  WHERE "core"."same_org"("c"."organization_id"))))));



CREATE POLICY "read_ai_query_audit" ON "ai"."ai_query_audit" FOR SELECT USING (((("user_id" = "auth"."uid"()) AND "core"."same_org"("organization_id")) OR ((EXISTS ( SELECT 1
   FROM ("core"."user_roles" "ur"
     JOIN "core"."roles" "r" ON (("r"."id" = "ur"."role_id")))
  WHERE (("ur"."user_id" = "auth"."uid"()) AND ("r"."name" = ANY (ARRAY['CEO'::"text", 'FINANCE_HEAD'::"text", 'AUDITOR'::"text", 'Admin'::"text"])) AND ("ur"."effective_from" <= "now"()) AND (("ur"."effective_to" IS NULL) OR ("ur"."effective_to" >= "now"()))))) AND "core"."same_org"("organization_id"))));



CREATE POLICY "read_ai_tool_calls" ON "ai"."ai_tool_calls" FOR SELECT USING (((("user_id" = "auth"."uid"()) AND "core"."same_org"("organization_id")) OR ((EXISTS ( SELECT 1
   FROM ("core"."user_roles" "ur"
     JOIN "core"."roles" "r" ON (("r"."id" = "ur"."role_id")))
  WHERE (("ur"."user_id" = "auth"."uid"()) AND ("r"."name" = ANY (ARRAY['CEO'::"text", 'FINANCE_HEAD'::"text", 'AUDITOR'::"text", 'Admin'::"text"])) AND ("ur"."effective_from" <= "now"()) AND (("ur"."effective_to" IS NULL) OR ("ur"."effective_to" >= "now"()))))) AND "core"."same_org"("organization_id"))));



CREATE POLICY "update_own_conversations" ON "ai"."ai_conversations" FOR UPDATE USING (("user_id" = "auth"."uid"()));



CREATE POLICY "users_own_cost" ON "ai"."ai_user_cost_tracking" USING (("user_id" = "auth"."uid"()));



CREATE POLICY "users_own_extractions" ON "ai"."ai_document_extractions" USING (("user_id" = "auth"."uid"()));



CREATE POLICY "users_own_feedback" ON "ai"."ai_feedback" USING (("user_id" = "auth"."uid"()));



CREATE POLICY "users_own_suggestions" ON "ai"."ai_suggestions" USING (("user_id" = "auth"."uid"()));



CREATE POLICY "write_own_conversations" ON "ai"."ai_conversations" FOR INSERT WITH CHECK (("user_id" = "auth"."uid"()));



CREATE POLICY "write_own_messages" ON "ai"."ai_messages" FOR INSERT WITH CHECK (("conversation_id" IN ( SELECT "ai_conversations"."id"
   FROM "ai"."ai_conversations"
  WHERE ("ai_conversations"."user_id" = "auth"."uid"()))));



ALTER TABLE "audit"."audit_log" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "audit_log_no_delete" ON "audit"."audit_log" FOR DELETE TO "authenticated" USING (false);



CREATE POLICY "audit_log_no_update" ON "audit"."audit_log" FOR UPDATE TO "authenticated" USING (false);



CREATE POLICY "audit_log_select_accountant" ON "audit"."audit_log" FOR SELECT TO "authenticated" USING ((("user_id" = "auth"."uid"()) AND (EXISTS ( SELECT 1
   FROM ("core"."user_roles" "ur"
     JOIN "core"."roles" "r" ON (("r"."id" = "ur"."role_id")))
  WHERE (("ur"."user_id" = "auth"."uid"()) AND ("ur"."is_active" = true) AND ("r"."name" = 'ACCOUNTANT'::"text") AND (("ur"."effective_to" IS NULL) OR ("ur"."effective_to" >= CURRENT_DATE)))))));



CREATE POLICY "audit_log_select_auditor" ON "audit"."audit_log" FOR SELECT TO "authenticated" USING (("core"."same_org"("organization_id") AND (EXISTS ( SELECT 1
   FROM ("core"."user_roles" "ur"
     JOIN "core"."roles" "r" ON (("r"."id" = "ur"."role_id")))
  WHERE (("ur"."user_id" = "auth"."uid"()) AND ("ur"."is_active" = true) AND ("r"."name" = 'AUDITOR'::"text") AND (("ur"."effective_to" IS NULL) OR ("ur"."effective_to" >= CURRENT_DATE)))))));



CREATE POLICY "audit_log_select_full" ON "audit"."audit_log" FOR SELECT TO "authenticated" USING (("core"."same_org"("organization_id") AND (EXISTS ( SELECT 1
   FROM ("core"."user_roles" "ur"
     JOIN "core"."roles" "r" ON (("r"."id" = "ur"."role_id")))
  WHERE (("ur"."user_id" = "auth"."uid"()) AND ("ur"."is_active" = true) AND ("r"."name" = ANY (ARRAY['CEO'::"text", 'FINANCE_HEAD'::"text"])) AND (("ur"."effective_to" IS NULL) OR ("ur"."effective_to" >= CURRENT_DATE)))))));



CREATE POLICY "audit_log_select_limited" ON "audit"."audit_log" FOR SELECT TO "authenticated" USING ((("user_id" = "auth"."uid"()) AND (EXISTS ( SELECT 1
   FROM ("core"."user_roles" "ur"
     JOIN "core"."roles" "r" ON (("r"."id" = "ur"."role_id")))
  WHERE (("ur"."user_id" = "auth"."uid"()) AND ("ur"."is_active" = true) AND ("r"."name" = ANY (ARRAY['HOD'::"text", 'PROJECT_MANAGER'::"text"])) AND (("ur"."effective_to" IS NULL) OR ("ur"."effective_to" >= CURRENT_DATE)))))));



CREATE POLICY "audit_log_select_own" ON "audit"."audit_log" FOR SELECT TO "authenticated" USING ((("user_id" = "auth"."uid"()) AND (EXISTS ( SELECT 1
   FROM ("core"."user_roles" "ur"
     JOIN "core"."roles" "r" ON (("r"."id" = "ur"."role_id")))
  WHERE (("ur"."user_id" = "auth"."uid"()) AND ("ur"."is_active" = true) AND ("r"."name" = 'EMPLOYEE'::"text") AND (("ur"."effective_to" IS NULL) OR ("ur"."effective_to" >= CURRENT_DATE)))))));



CREATE POLICY "audit_log_service_all" ON "audit"."audit_log" TO "service_role" USING (true) WITH CHECK (true);



ALTER TABLE "audit"."data_access_events" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "data_access_insert" ON "audit"."data_access_events" FOR INSERT TO "authenticated" WITH CHECK (((("user_id" IS NULL) OR ("user_id" = "auth"."uid"())) AND (("organization_id" IS NULL) OR "core"."same_org"("organization_id"))));



CREATE POLICY "data_access_no_delete" ON "audit"."data_access_events" FOR DELETE TO "authenticated" USING (false);



CREATE POLICY "data_access_no_update" ON "audit"."data_access_events" FOR UPDATE TO "authenticated" USING (false);



CREATE POLICY "data_access_select" ON "audit"."data_access_events" FOR SELECT TO "authenticated" USING (((EXISTS ( SELECT 1
   FROM ("core"."user_roles" "ur"
     JOIN "core"."roles" "r" ON (("r"."id" = "ur"."role_id")))
  WHERE (("ur"."user_id" = "auth"."uid"()) AND ("ur"."is_active" = true) AND ("r"."name" = ANY (ARRAY['CEO'::"text", 'FINANCE_HEAD'::"text", 'AUDITOR'::"text"])) AND (("ur"."effective_to" IS NULL) OR ("ur"."effective_to" >= CURRENT_DATE))))) AND (("organization_id" IS NULL) OR "core"."same_org"("organization_id"))));



CREATE POLICY "data_access_service_all" ON "audit"."data_access_events" TO "service_role" USING (true) WITH CHECK (true);



ALTER TABLE "audit"."export_events" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "export_events_insert" ON "audit"."export_events" FOR INSERT TO "authenticated" WITH CHECK (((("user_id" IS NULL) OR ("user_id" = "auth"."uid"())) AND (("organization_id" IS NULL) OR "core"."same_org"("organization_id"))));



CREATE POLICY "export_events_no_delete" ON "audit"."export_events" FOR DELETE TO "authenticated" USING (false);



CREATE POLICY "export_events_no_update" ON "audit"."export_events" FOR UPDATE TO "authenticated" USING (false);



CREATE POLICY "export_events_select" ON "audit"."export_events" FOR SELECT TO "authenticated" USING ((((EXISTS ( SELECT 1
   FROM ("core"."user_roles" "ur"
     JOIN "core"."roles" "r" ON (("r"."id" = "ur"."role_id")))
  WHERE (("ur"."user_id" = "auth"."uid"()) AND ("ur"."is_active" = true) AND ("r"."name" = ANY (ARRAY['CEO'::"text", 'FINANCE_HEAD'::"text", 'AUDITOR'::"text"])) AND (("ur"."effective_to" IS NULL) OR ("ur"."effective_to" >= CURRENT_DATE))))) AND (("organization_id" IS NULL) OR "core"."same_org"("organization_id"))) OR ("user_id" = "auth"."uid"())));



CREATE POLICY "export_events_service_all" ON "audit"."export_events" TO "service_role" USING (true) WITH CHECK (true);



CREATE POLICY "sec_events_insert" ON "audit"."security_events" FOR INSERT TO "authenticated" WITH CHECK ((("user_id" IS NULL) OR ("auth"."uid"() = "user_id")));



CREATE POLICY "sec_events_no_delete" ON "audit"."security_events" FOR DELETE TO "authenticated" USING (false);



CREATE POLICY "sec_events_no_update" ON "audit"."security_events" FOR UPDATE TO "authenticated" USING (false);



CREATE POLICY "sec_events_select" ON "audit"."security_events" FOR SELECT TO "authenticated" USING (((EXISTS ( SELECT 1
   FROM ("core"."user_roles" "ur"
     JOIN "core"."roles" "r" ON (("r"."id" = "ur"."role_id")))
  WHERE (("ur"."user_id" = "auth"."uid"()) AND ("ur"."is_active" = true) AND ("r"."name" = ANY (ARRAY['CEO'::"text", 'FINANCE_HEAD'::"text", 'AUDITOR'::"text", 'TECHNICAL_ADMIN'::"text"])) AND (("ur"."effective_to" IS NULL) OR ("ur"."effective_to" >= CURRENT_DATE))))) AND (("organization_id" IS NULL) OR "core"."same_org"("organization_id"))));



CREATE POLICY "sec_events_service_all" ON "audit"."security_events" TO "service_role" USING (true) WITH CHECK (true);



ALTER TABLE "audit"."security_events" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "Admins manage organizations" ON "core"."organizations" FOR UPDATE USING (((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."user_id" = "auth"."uid"()) AND ("p"."role" = ANY (ARRAY['CEO'::"text", 'Admin'::"text"]))))) AND "core"."same_org"("id"))) WITH CHECK (((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."user_id" = "auth"."uid"()) AND ("p"."role" = ANY (ARRAY['CEO'::"text", 'Admin'::"text"]))))) AND "core"."same_org"("id")));



CREATE POLICY "Users can read their org" ON "core"."organizations" FOR SELECT USING (("id" = ( SELECT "profiles"."organization_id"
   FROM "public"."profiles"
  WHERE ("profiles"."user_id" = "auth"."uid"()))));



ALTER TABLE "core"."approval_actions" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "approval_actions_insert" ON "core"."approval_actions" FOR INSERT WITH CHECK ((("actor_user_id" = "auth"."uid"()) AND (EXISTS ( SELECT 1
   FROM ("core"."approval_steps" "s"
     JOIN "core"."approval_requests" "r" ON (("r"."id" = "s"."approval_request_id")))
  WHERE (("s"."id" = "approval_actions"."approval_step_id") AND "core"."same_org"("r"."organization_id"))))));



CREATE POLICY "approval_actions_select" ON "core"."approval_actions" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM ("core"."approval_steps" "s"
     JOIN "core"."approval_requests" "r" ON (("r"."id" = "s"."approval_request_id")))
  WHERE (("s"."id" = "approval_actions"."approval_step_id") AND "core"."same_org"("r"."organization_id") AND (("approval_actions"."actor_user_id" = "auth"."uid"()) OR ("r"."requested_by" = "auth"."uid"()) OR "core"."is_ceo_or_admin"() OR "core"."is_finance_head"())))));



ALTER TABLE "core"."approval_limits" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "approval_limits_manage" ON "core"."approval_limits" USING (("core"."has_permission"("auth"."uid"(), 'ADMIN_USERS'::"text") AND "core"."same_org"("organization_id"))) WITH CHECK (("core"."has_permission"("auth"."uid"(), 'ADMIN_USERS'::"text") AND "core"."same_org"("organization_id")));



CREATE POLICY "approval_limits_select_own" ON "core"."approval_limits" FOR SELECT USING (((("user_id" = "auth"."uid"()) OR "core"."has_permission"("auth"."uid"(), 'ADMIN_USERS'::"text")) AND "core"."same_org"("organization_id")));



ALTER TABLE "core"."approval_requests" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "approval_requests_insert" ON "core"."approval_requests" FOR INSERT WITH CHECK (("core"."same_org"("organization_id") AND ("requested_by" = "auth"."uid"())));



CREATE POLICY "approval_requests_select" ON "core"."approval_requests" FOR SELECT USING (("core"."same_org"("organization_id") AND (("requested_by" = "auth"."uid"()) OR "core"."is_ceo_or_admin"() OR "core"."is_finance_head"() OR (EXISTS ( SELECT 1
   FROM "core"."approval_steps" "s"
  WHERE (("s"."approval_request_id" = "approval_requests"."id") AND ("s"."assigned_user_id" = "auth"."uid"())))))));



CREATE POLICY "approval_requests_update" ON "core"."approval_requests" FOR UPDATE USING (("core"."same_org"("organization_id") AND ("core"."is_ceo_or_admin"() OR "core"."is_finance_head"() OR (EXISTS ( SELECT 1
   FROM "core"."approval_steps" "s"
  WHERE (("s"."approval_request_id" = "approval_requests"."id") AND ("s"."assigned_user_id" = "auth"."uid"())))))));



ALTER TABLE "core"."approval_steps" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "approval_steps_insert" ON "core"."approval_steps" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM "core"."approval_requests" "r"
  WHERE (("r"."id" = "approval_steps"."approval_request_id") AND "core"."same_org"("r"."organization_id")))));



CREATE POLICY "approval_steps_select" ON "core"."approval_steps" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "core"."approval_requests" "r"
  WHERE (("r"."id" = "approval_steps"."approval_request_id") AND "core"."same_org"("r"."organization_id") AND (("r"."requested_by" = "auth"."uid"()) OR ("approval_steps"."assigned_user_id" = "auth"."uid"()) OR "core"."is_ceo_or_admin"() OR "core"."is_finance_head"())))));



CREATE POLICY "approval_steps_update" ON "core"."approval_steps" FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM "core"."approval_requests" "r"
  WHERE (("r"."id" = "approval_steps"."approval_request_id") AND "core"."same_org"("r"."organization_id") AND (("approval_steps"."assigned_user_id" = "auth"."uid"()) OR "core"."is_ceo_or_admin"() OR "core"."is_finance_head"())))));



ALTER TABLE "core"."budget_policies" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "budget_policies_org_isolation_fixed" ON "core"."budget_policies" USING ("core"."same_org"("organization_id")) WITH CHECK ("core"."same_org"("organization_id"));



ALTER TABLE "core"."delegations" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "delegations_create_own_org_scoped" ON "core"."delegations" FOR INSERT WITH CHECK (((("from_user_id" = "auth"."uid"()) OR "core"."has_permission"("auth"."uid"(), 'ADMIN_USERS'::"text")) AND "core"."same_org"("organization_id")));



CREATE POLICY "delegations_manage_org_scoped" ON "core"."delegations" USING (("core"."has_permission"("auth"."uid"(), 'ADMIN_USERS'::"text") AND "core"."same_org"("organization_id"))) WITH CHECK (("core"."has_permission"("auth"."uid"(), 'ADMIN_USERS'::"text") AND "core"."same_org"("organization_id")));



CREATE POLICY "delegations_select_own" ON "core"."delegations" FOR SELECT USING ((("from_user_id" = "auth"."uid"()) OR ("to_user_id" = "auth"."uid"()) OR ("core"."has_permission"("auth"."uid"(), 'ADMIN_USERS'::"text") AND "core"."same_org"("organization_id"))));



ALTER TABLE "core"."employee_links" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "employee_links_insert_org_scoped" ON "core"."employee_links" FOR INSERT WITH CHECK ((("core"."is_ceo_or_admin"() OR "core"."is_finance_head"()) AND (EXISTS ( SELECT 1
   FROM "core"."shared_people" "sp"
  WHERE (("sp"."id" = "employee_links"."shared_person_id") AND "core"."same_org"("sp"."organization_id"))))));



CREATE POLICY "employee_links_select_org_scoped" ON "core"."employee_links" FOR SELECT USING ((("core"."is_ceo_or_admin"() OR "core"."is_finance_head"()) AND (EXISTS ( SELECT 1
   FROM "core"."shared_people" "sp"
  WHERE (("sp"."id" = "employee_links"."shared_person_id") AND "core"."same_org"("sp"."organization_id"))))));



CREATE POLICY "employee_links_update_org_scoped" ON "core"."employee_links" FOR UPDATE USING ((("core"."is_ceo_or_admin"() OR "core"."is_finance_head"()) AND (EXISTS ( SELECT 1
   FROM "core"."shared_people" "sp"
  WHERE (("sp"."id" = "employee_links"."shared_person_id") AND "core"."same_org"("sp"."organization_id"))))));



ALTER TABLE "core"."idempotency_keys" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "idempotency_keys_read_finance" ON "core"."idempotency_keys" FOR SELECT TO "authenticated" USING ("core"."is_finance_head"());



CREATE POLICY "idempotency_keys_service_all" ON "core"."idempotency_keys" TO "service_role" USING (true) WITH CHECK (true);



ALTER TABLE "core"."integration_events" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "integration_events_select" ON "core"."integration_events" FOR SELECT USING ((("core"."is_ceo_or_admin"() OR "core"."is_finance_head"()) AND (("organization_id" IS NULL) OR "core"."same_org"("organization_id"))));



ALTER TABLE "core"."integration_failures" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "integration_failures_read_finance" ON "core"."integration_failures" FOR SELECT TO "authenticated" USING (("core"."is_finance_head"() AND (EXISTS ( SELECT 1
   FROM "core"."integration_events" "e"
  WHERE (("e"."id" = "integration_failures"."integration_event_id") AND (("e"."organization_id" IS NULL) OR "core"."same_org"("e"."organization_id")))))));



CREATE POLICY "integration_failures_service_all" ON "core"."integration_failures" TO "service_role" USING (true) WITH CHECK (true);



CREATE POLICY "org_config_insert" ON "core"."organization_config" FOR INSERT WITH CHECK (("core"."is_ceo_or_admin"() AND (("organization_id" IS NULL) OR "core"."same_org"("organization_id"))));



CREATE POLICY "org_config_select_org_scoped" ON "core"."organization_config" FOR SELECT USING ((("auth"."uid"() IS NOT NULL) AND "core"."same_org"("organization_id")));



CREATE POLICY "org_config_update" ON "core"."organization_config" FOR UPDATE USING (("core"."is_ceo_or_admin"() AND "core"."same_org"("organization_id"))) WITH CHECK (("core"."is_ceo_or_admin"() AND "core"."same_org"("organization_id")));



CREATE POLICY "org_modules_manage" ON "core"."organization_modules" USING (("core"."has_permission"("auth"."uid"(), 'ADMIN_CONFIG'::"text") AND "core"."same_org"("organization_id"))) WITH CHECK (("core"."has_permission"("auth"."uid"(), 'ADMIN_CONFIG'::"text") AND "core"."same_org"("organization_id")));



CREATE POLICY "org_modules_select_org_scoped" ON "core"."organization_modules" FOR SELECT USING ((("auth"."uid"() IS NOT NULL) AND "core"."same_org"("organization_id")));



ALTER TABLE "core"."organization_config" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "core"."organization_modules" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "core"."organizations" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "perm_manage" ON "core"."permissions" USING ("core"."has_permission"("auth"."uid"(), 'ADMIN_CONFIG'::"text"));



CREATE POLICY "perm_select" ON "core"."permissions" FOR SELECT USING (("auth"."uid"() IS NOT NULL));



ALTER TABLE "core"."permissions" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "role_manage" ON "core"."roles" USING (("core"."has_permission"("auth"."uid"(), 'ADMIN_USERS'::"text") AND (("organization_id" IS NULL) OR "core"."same_org"("organization_id")))) WITH CHECK (("core"."has_permission"("auth"."uid"(), 'ADMIN_USERS'::"text") AND (("organization_id" IS NULL) OR "core"."same_org"("organization_id"))));



ALTER TABLE "core"."role_permissions" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "role_select" ON "core"."roles" FOR SELECT USING ((("auth"."uid"() IS NOT NULL) AND (("organization_id" IS NULL) OR "core"."same_org"("organization_id"))));



ALTER TABLE "core"."roles" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "rp_manage_org_scoped" ON "core"."role_permissions" USING (("core"."has_permission"("auth"."uid"(), 'ADMIN_USERS'::"text") AND (EXISTS ( SELECT 1
   FROM "core"."roles" "r"
  WHERE (("r"."id" = "role_permissions"."role_id") AND (("r"."organization_id" IS NULL) OR "core"."same_org"("r"."organization_id"))))))) WITH CHECK (("core"."has_permission"("auth"."uid"(), 'ADMIN_USERS'::"text") AND (EXISTS ( SELECT 1
   FROM "core"."roles" "r"
  WHERE (("r"."id" = "role_permissions"."role_id") AND (("r"."organization_id" IS NULL) OR "core"."same_org"("r"."organization_id")))))));



CREATE POLICY "rp_select_org_scoped" ON "core"."role_permissions" FOR SELECT USING (("core"."has_permission"("auth"."uid"(), 'ADMIN_USERS'::"text") AND (EXISTS ( SELECT 1
   FROM "core"."roles" "r"
  WHERE (("r"."id" = "role_permissions"."role_id") AND (("r"."organization_id" IS NULL) OR "core"."same_org"("r"."organization_id")))))));



ALTER TABLE "core"."shared_people" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "shared_people_manage_org_scoped" ON "core"."shared_people" USING (("core"."has_permission"("auth"."uid"(), 'ADMIN_USERS'::"text") AND "core"."same_org"("organization_id"))) WITH CHECK (("core"."has_permission"("auth"."uid"(), 'ADMIN_USERS'::"text") AND "core"."same_org"("organization_id")));



CREATE POLICY "shared_people_select_self_org_scoped" ON "core"."shared_people" FOR SELECT USING ((("auth_user_id" = "auth"."uid"()) OR ("core"."has_permission"("auth"."uid"(), 'ADMIN_USERS'::"text") AND "core"."same_org"("organization_id"))));



CREATE POLICY "upo_manage_org_scoped" ON "core"."user_permission_overrides" USING (("core"."has_permission"("auth"."uid"(), 'ADMIN_USERS'::"text") AND (EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."user_id" = "user_permission_overrides"."user_id") AND "core"."same_org"("p"."organization_id")))))) WITH CHECK (("core"."has_permission"("auth"."uid"(), 'ADMIN_USERS'::"text") AND (EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."user_id" = "user_permission_overrides"."user_id") AND "core"."same_org"("p"."organization_id"))))));



CREATE POLICY "upo_select_own_org_scoped" ON "core"."user_permission_overrides" FOR SELECT USING ((("user_id" = "auth"."uid"()) OR ("core"."has_permission"("auth"."uid"(), 'ADMIN_USERS'::"text") AND (EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."user_id" = "user_permission_overrides"."user_id") AND "core"."same_org"("p"."organization_id")))))));



CREATE POLICY "ur_manage_org_scoped" ON "core"."user_roles" USING (("core"."has_permission"("auth"."uid"(), 'ADMIN_USERS'::"text") AND (EXISTS ( SELECT 1
   FROM "core"."roles" "r"
  WHERE (("r"."id" = "user_roles"."role_id") AND "core"."same_org"("r"."organization_id")))) AND (EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."user_id" = "user_roles"."user_id") AND "core"."same_org"("p"."organization_id")))))) WITH CHECK (("core"."has_permission"("auth"."uid"(), 'ADMIN_USERS'::"text") AND (EXISTS ( SELECT 1
   FROM "core"."roles" "r"
  WHERE (("r"."id" = "user_roles"."role_id") AND "core"."same_org"("r"."organization_id")))) AND (EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."user_id" = "user_roles"."user_id") AND "core"."same_org"("p"."organization_id"))))));



CREATE POLICY "ur_select" ON "core"."user_roles" FOR SELECT USING ((("user_id" = "auth"."uid"()) OR ("core"."has_permission"("auth"."uid"(), 'ADMIN_USERS'::"text") AND (EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."user_id" = "user_roles"."user_id") AND "core"."same_org"("p"."organization_id")))))));



COMMENT ON POLICY "ur_select" ON "core"."user_roles" IS 'Fixed migration 032 (Compliance Audit Critical R1): previously USING (auth.uid() IS NOT NULL) with no org check, exposing all organizations'' role assignments to any authenticated user.';



ALTER TABLE "core"."user_permission_overrides" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "core"."user_roles" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "Org scope opening balance imports" ON "finance"."opening_balance_imports" USING (("organization_id" = ( SELECT "profiles"."organization_id"
   FROM "public"."profiles"
  WHERE ("profiles"."user_id" = "auth"."uid"()))));



ALTER TABLE "finance"."accounting_periods" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "admin_write_fee_rules" ON "finance"."fee_rules" USING (("core"."has_permission"("auth"."uid"(), 'ADMIN_CONFIG'::"text") AND "core"."same_org"("organization_id"))) WITH CHECK (("core"."has_permission"("auth"."uid"(), 'ADMIN_CONFIG'::"text") AND "core"."same_org"("organization_id")));



CREATE POLICY "admin_write_platforms" ON "finance"."platforms" USING (("core"."has_permission"("auth"."uid"(), 'ADMIN_CONFIG'::"text") AND "core"."same_org"("organization_id"))) WITH CHECK (("core"."has_permission"("auth"."uid"(), 'ADMIN_CONFIG'::"text") AND "core"."same_org"("organization_id")));



CREATE POLICY "admin_write_tiers" ON "finance"."fee_tiers" TO "authenticated" USING (("core"."has_permission"("auth"."uid"(), 'ADMIN_CONFIG'::"text") AND (EXISTS ( SELECT 1
   FROM "finance"."fee_rules" "fr"
  WHERE (("fr"."id" = "fee_tiers"."fee_rule_id") AND "core"."same_org"("fr"."organization_id")))))) WITH CHECK (("core"."has_permission"("auth"."uid"(), 'ADMIN_CONFIG'::"text") AND (EXISTS ( SELECT 1
   FROM "finance"."fee_rules" "fr"
  WHERE (("fr"."id" = "fee_tiers"."fee_rule_id") AND "core"."same_org"("fr"."organization_id"))))));



CREATE POLICY "ap_insert" ON "finance"."accounting_periods" FOR INSERT WITH CHECK (("core"."is_finance_head"() AND "core"."same_org"("organization_id")));



CREATE POLICY "ap_select_org_scoped" ON "finance"."accounting_periods" FOR SELECT USING ((("auth"."uid"() IS NOT NULL) AND "core"."same_org"("organization_id")));



CREATE POLICY "ap_update" ON "finance"."accounting_periods" FOR UPDATE USING (("core"."is_finance_head"() AND "core"."same_org"("organization_id"))) WITH CHECK (("core"."is_finance_head"() AND "core"."same_org"("organization_id")));



ALTER TABLE "finance"."asset_categories" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "asset_categories_insert_org_scoped" ON "finance"."asset_categories" FOR INSERT WITH CHECK ((("auth"."uid"() IS NOT NULL) AND "core"."same_org"("organization_id")));



CREATE POLICY "asset_categories_select_org_scoped" ON "finance"."asset_categories" FOR SELECT USING ((("auth"."uid"() IS NOT NULL) AND "core"."same_org"("organization_id")));



CREATE POLICY "asset_categories_update_org_scoped" ON "finance"."asset_categories" FOR UPDATE USING ((("auth"."uid"() IS NOT NULL) AND "core"."same_org"("organization_id"))) WITH CHECK ((("auth"."uid"() IS NOT NULL) AND "core"."same_org"("organization_id")));



ALTER TABLE "finance"."asset_verification_lines" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "asset_verification_lines_insert" ON "finance"."asset_verification_lines" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM "finance"."asset_verifications" "v"
  WHERE (("v"."id" = "asset_verification_lines"."verification_id") AND (("v"."status")::"text" = 'in_progress'::"text")))));



CREATE POLICY "asset_verification_lines_select" ON "finance"."asset_verification_lines" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "finance"."asset_verifications" "v"
  WHERE ("v"."id" = "asset_verification_lines"."verification_id"))));



CREATE POLICY "asset_verification_lines_update" ON "finance"."asset_verification_lines" FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM "finance"."asset_verifications" "v"
  WHERE (("v"."id" = "asset_verification_lines"."verification_id") AND (("v"."status")::"text" = 'in_progress'::"text")))));



ALTER TABLE "finance"."asset_verifications" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "asset_verifications_insert_org_scoped" ON "finance"."asset_verifications" FOR INSERT WITH CHECK ((("auth"."uid"() IS NOT NULL) AND "core"."same_org"("organization_id")));



CREATE POLICY "asset_verifications_select_org_scoped" ON "finance"."asset_verifications" FOR SELECT USING ((("auth"."uid"() IS NOT NULL) AND "core"."same_org"("organization_id")));



CREATE POLICY "asset_verifications_update_org_scoped" ON "finance"."asset_verifications" FOR UPDATE USING ((("auth"."uid"() IS NOT NULL) AND "core"."same_org"("organization_id"))) WITH CHECK ((("auth"."uid"() IS NOT NULL) AND "core"."same_org"("organization_id")));



CREATE POLICY "att_insert_org_scoped" ON "finance"."attachments" FOR INSERT WITH CHECK ((("auth"."uid"() IS NOT NULL) AND "core"."same_org"("organization_id")));



CREATE POLICY "att_select_org_scoped" ON "finance"."attachments" FOR SELECT USING ((("auth"."uid"() IS NOT NULL) AND "core"."same_org"("organization_id")));



ALTER TABLE "finance"."attachments" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "finance"."attendance_period_snapshots" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "attendance_period_snapshots_insert" ON "finance"."attendance_period_snapshots" FOR INSERT WITH CHECK (("core"."is_ceo_or_admin"() OR "core"."is_finance_head"()));



CREATE POLICY "attendance_period_snapshots_select" ON "finance"."attendance_period_snapshots" FOR SELECT USING (("core"."is_ceo_or_admin"() OR "core"."is_finance_head"() OR "core"."has_role"('ACCOUNTANT'::"text")));



ALTER TABLE "finance"."bank_statements" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "finance"."bank_transfers" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "bc_insert" ON "finance"."budget_commitments" FOR INSERT WITH CHECK ((("auth"."uid"() IS NOT NULL) AND "core"."same_org"("organization_id")));



CREATE POLICY "bc_select" ON "finance"."budget_commitments" FOR SELECT USING ((("auth"."uid"() IS NOT NULL) AND "core"."same_org"("organization_id")));



CREATE POLICY "bc_update" ON "finance"."budget_commitments" FOR UPDATE USING ((("core"."is_finance_head"() OR "core"."has_role"('ACCOUNTANT'::"text")) AND "core"."same_org"("organization_id"))) WITH CHECK ((("core"."is_finance_head"() OR "core"."has_role"('ACCOUNTANT'::"text")) AND "core"."same_org"("organization_id")));



CREATE POLICY "bl_insert_org_scoped" ON "finance"."budget_lines" FOR INSERT WITH CHECK ((("auth"."uid"() IS NOT NULL) AND "core"."same_org"("organization_id")));



CREATE POLICY "bl_select_org_scoped" ON "finance"."budget_lines" FOR SELECT USING ((("auth"."uid"() IS NOT NULL) AND "core"."same_org"("organization_id")));



CREATE POLICY "bs_insert_org_scoped" ON "finance"."bank_statements" FOR INSERT WITH CHECK ((("auth"."uid"() IS NOT NULL) AND "core"."same_org"("organization_id")));



CREATE POLICY "bs_select_org_scoped" ON "finance"."bank_statements" FOR SELECT USING ((("auth"."uid"() IS NOT NULL) AND "core"."same_org"("organization_id")));



CREATE POLICY "bs_update_org_scoped" ON "finance"."bank_statements" FOR UPDATE USING ((("auth"."uid"() IS NOT NULL) AND "core"."same_org"("organization_id"))) WITH CHECK ((("auth"."uid"() IS NOT NULL) AND "core"."same_org"("organization_id")));



CREATE POLICY "bt_delete_restricted" ON "finance"."bank_transfers" FOR DELETE USING ((("core"."is_ceo_or_admin"() OR "core"."is_finance_head"()) AND "core"."same_org"("organization_id")));



CREATE POLICY "bt_insert_org_scoped" ON "finance"."bank_transfers" FOR INSERT WITH CHECK ((("auth"."uid"() IS NOT NULL) AND "core"."same_org"("organization_id")));



CREATE POLICY "bt_select_org_scoped" ON "finance"."bank_transfers" FOR SELECT USING ((("auth"."uid"() IS NOT NULL) AND "core"."same_org"("organization_id")));



CREATE POLICY "bt_update_restricted" ON "finance"."bank_transfers" FOR UPDATE USING ((("core"."is_ceo_or_admin"() OR "core"."is_finance_head"()) AND "core"."same_org"("organization_id"))) WITH CHECK ((("core"."is_ceo_or_admin"() OR "core"."is_finance_head"()) AND "core"."same_org"("organization_id")));



ALTER TABLE "finance"."budget_commitments" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "finance"."budget_lines" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "finance"."budget_revisions" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "budget_revisions_insert_org_scoped" ON "finance"."budget_revisions" FOR INSERT WITH CHECK (("core"."same_org"("organization_id") AND (("requested_by" = "auth"."uid"()) OR "core"."is_finance_head"() OR "core"."is_ceo_or_admin"())));



CREATE POLICY "budget_revisions_select_org_scoped" ON "finance"."budget_revisions" FOR SELECT USING (("core"."same_org"("organization_id") AND ("core"."is_ceo_or_admin"() OR "core"."is_finance_head"() OR "core"."has_role"('ACCOUNTANT'::"text") OR "core"."has_role"('VIEWER'::"text") OR ("requested_by" = "auth"."uid"()) OR (EXISTS ( SELECT 1
   FROM "public"."budgets" "b"
  WHERE (("b"."id" = "budget_revisions"."budget_id") AND (("b"."user_id" = "auth"."uid"()) OR (EXISTS ( SELECT 1
           FROM "public"."projects" "p"
          WHERE (("p"."id" = "b"."project_id") AND ("p"."user_id" = "auth"."uid"())))))))))));



CREATE POLICY "budget_revisions_update_org_scoped" ON "finance"."budget_revisions" FOR UPDATE USING (("core"."same_org"("organization_id") AND ("core"."is_ceo_or_admin"() OR "core"."is_finance_head"()))) WITH CHECK (("core"."same_org"("organization_id") AND ("core"."is_ceo_or_admin"() OR "core"."is_finance_head"())));



ALTER TABLE "finance"."capital_transactions" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "capital_txn_delete_org_scoped" ON "finance"."capital_transactions" FOR DELETE USING (("core"."same_org"("organization_id") AND "core"."is_finance_head"()));



CREATE POLICY "capital_txn_insert_org_scoped" ON "finance"."capital_transactions" FOR INSERT WITH CHECK (("core"."same_org"("organization_id") AND ("core"."is_finance_head"() OR "core"."has_role"('ACCOUNTANT'::"text"))));



CREATE POLICY "capital_txn_select_org_scoped" ON "finance"."capital_transactions" FOR SELECT USING (("core"."same_org"("organization_id") AND ("core"."is_finance_head"() OR "core"."has_role"('ACCOUNTANT'::"text") OR "core"."has_role"('CEO'::"text") OR "core"."has_role"('VIEWER'::"text"))));



CREATE POLICY "capital_txn_service_all" ON "finance"."capital_transactions" TO "service_role" USING (true) WITH CHECK (true);



CREATE POLICY "capital_txn_update_org_scoped" ON "finance"."capital_transactions" FOR UPDATE USING (("core"."same_org"("organization_id") AND ("core"."is_finance_head"() OR "core"."has_role"('ACCOUNTANT'::"text")))) WITH CHECK (("core"."same_org"("organization_id") AND ("core"."is_finance_head"() OR "core"."has_role"('ACCOUNTANT'::"text"))));



ALTER TABLE "finance"."chart_of_accounts" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "cn_insert_org_scoped" ON "finance"."credit_notes" FOR INSERT WITH CHECK ((("auth"."uid"() IS NOT NULL) AND "core"."same_org"("organization_id")));



CREATE POLICY "cn_select_org_scoped" ON "finance"."credit_notes" FOR SELECT USING ((("auth"."uid"() IS NOT NULL) AND "core"."same_org"("organization_id")));



CREATE POLICY "coa_insert" ON "finance"."chart_of_accounts" FOR INSERT WITH CHECK ((("core"."is_ceo_or_admin"() OR "core"."is_finance_head"()) AND "core"."same_org"("organization_id")));



CREATE POLICY "coa_select_active" ON "finance"."chart_of_accounts" FOR SELECT USING ((("auth"."uid"() IS NOT NULL) AND (("is_active" = true) OR "core"."is_ceo_or_admin"() OR "core"."is_finance_head"()) AND "core"."same_org"("organization_id")));



CREATE POLICY "coa_update" ON "finance"."chart_of_accounts" FOR UPDATE USING ((("core"."is_ceo_or_admin"() OR "core"."is_finance_head"()) AND "core"."same_org"("organization_id")));



ALTER TABLE "finance"."credit_notes" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "finance"."currency_settings" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "currency_settings_delete_org" ON "finance"."currency_settings" FOR DELETE TO "authenticated" USING (("core"."same_org"("organization_id") AND "core"."is_finance_head"()));



CREATE POLICY "currency_settings_insert_org" ON "finance"."currency_settings" FOR INSERT TO "authenticated" WITH CHECK (("core"."same_org"("organization_id") AND ("core"."is_finance_head"() OR "core"."has_role"('ACCOUNTANT'::"text"))));



CREATE POLICY "currency_settings_select_org" ON "finance"."currency_settings" FOR SELECT TO "authenticated" USING ("core"."same_org"("organization_id"));



CREATE POLICY "currency_settings_update_org" ON "finance"."currency_settings" FOR UPDATE TO "authenticated" USING (("core"."same_org"("organization_id") AND ("core"."is_finance_head"() OR "core"."has_role"('ACCOUNTANT'::"text")))) WITH CHECK (("core"."same_org"("organization_id") AND ("core"."is_finance_head"() OR "core"."has_role"('ACCOUNTANT'::"text"))));



ALTER TABLE "finance"."depreciation_schedule" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "depreciation_schedule_delete_org_scoped" ON "finance"."depreciation_schedule" FOR DELETE USING ((("auth"."uid"() = "created_by") AND (("status")::"text" = 'calculated'::"text") AND (EXISTS ( SELECT 1
   FROM "finance"."fixed_assets" "fa"
  WHERE (("fa"."id" = "depreciation_schedule"."asset_id") AND "core"."same_org"("fa"."organization_id"))))));



CREATE POLICY "depreciation_schedule_insert_org_scoped" ON "finance"."depreciation_schedule" FOR INSERT WITH CHECK ((("auth"."uid"() IS NOT NULL) AND (EXISTS ( SELECT 1
   FROM "finance"."fixed_assets" "fa"
  WHERE (("fa"."id" = "depreciation_schedule"."asset_id") AND "core"."same_org"("fa"."organization_id"))))));



CREATE POLICY "depreciation_schedule_select_org_scoped" ON "finance"."depreciation_schedule" FOR SELECT USING ((("auth"."uid"() IS NOT NULL) AND (EXISTS ( SELECT 1
   FROM "finance"."fixed_assets" "fa"
  WHERE (("fa"."id" = "depreciation_schedule"."asset_id") AND "core"."same_org"("fa"."organization_id"))))));



CREATE POLICY "depreciation_schedule_update_org_scoped" ON "finance"."depreciation_schedule" FOR UPDATE USING ((("auth"."uid"() IS NOT NULL) AND (EXISTS ( SELECT 1
   FROM "finance"."fixed_assets" "fa"
  WHERE (("fa"."id" = "depreciation_schedule"."asset_id") AND "core"."same_org"("fa"."organization_id"))))));



ALTER TABLE "finance"."dimensions" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "dimensions_delete" ON "finance"."dimensions" FOR DELETE USING ((("core"."is_ceo_or_admin"() OR "core"."is_finance_head"()) AND "core"."same_org"("organization_id")));



CREATE POLICY "dimensions_insert" ON "finance"."dimensions" FOR INSERT WITH CHECK ((("core"."is_ceo_or_admin"() OR "core"."is_finance_head"()) AND "core"."same_org"("organization_id")));



CREATE POLICY "dimensions_select_org_scoped" ON "finance"."dimensions" FOR SELECT USING ((("auth"."uid"() IS NOT NULL) AND "core"."same_org"("organization_id")));



CREATE POLICY "dimensions_update" ON "finance"."dimensions" FOR UPDATE USING ((("core"."is_ceo_or_admin"() OR "core"."is_finance_head"()) AND "core"."same_org"("organization_id"))) WITH CHECK ((("core"."is_ceo_or_admin"() OR "core"."is_finance_head"()) AND "core"."same_org"("organization_id")));



ALTER TABLE "finance"."distribution_lines" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "distribution_lines_delete_org_scoped" ON "finance"."distribution_lines" FOR DELETE USING (("core"."is_ceo_or_admin"() AND (EXISTS ( SELECT 1
   FROM "finance"."profit_distributions" "pd"
  WHERE (("pd"."id" = "distribution_lines"."profit_distribution_id") AND "core"."same_org"("pd"."organization_id"))))));



CREATE POLICY "distribution_lines_insert_org_scoped" ON "finance"."distribution_lines" FOR INSERT WITH CHECK ((("core"."is_ceo_or_admin"() OR "core"."is_finance_head"()) AND (EXISTS ( SELECT 1
   FROM "finance"."profit_distributions" "pd"
  WHERE (("pd"."id" = "distribution_lines"."profit_distribution_id") AND "core"."same_org"("pd"."organization_id"))))));



CREATE POLICY "distribution_lines_select_org_scoped" ON "finance"."distribution_lines" FOR SELECT USING ((("core"."is_ceo_or_admin"() OR "core"."is_finance_head"() OR "core"."has_role"('ACCOUNTANT'::"text")) AND (EXISTS ( SELECT 1
   FROM "finance"."profit_distributions" "pd"
  WHERE (("pd"."id" = "distribution_lines"."profit_distribution_id") AND "core"."same_org"("pd"."organization_id"))))));



CREATE POLICY "distribution_lines_update_org_scoped" ON "finance"."distribution_lines" FOR UPDATE USING ((("core"."is_ceo_or_admin"() OR "core"."is_finance_head"()) AND (EXISTS ( SELECT 1
   FROM "finance"."profit_distributions" "pd"
  WHERE (("pd"."id" = "distribution_lines"."profit_distribution_id") AND "core"."same_org"("pd"."organization_id"))))));



ALTER TABLE "finance"."exchange_rates" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "finance"."expense_lines" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "expense_lines_delete_org" ON "finance"."expense_lines" FOR DELETE TO "authenticated" USING ("core"."same_org"("organization_id"));



CREATE POLICY "expense_lines_insert_org" ON "finance"."expense_lines" FOR INSERT TO "authenticated" WITH CHECK ("core"."same_org"("organization_id"));



CREATE POLICY "expense_lines_select_org" ON "finance"."expense_lines" FOR SELECT TO "authenticated" USING ("core"."same_org"("organization_id"));



CREATE POLICY "expense_lines_update_org" ON "finance"."expense_lines" FOR UPDATE TO "authenticated" USING ("core"."same_org"("organization_id")) WITH CHECK ("core"."same_org"("organization_id"));



CREATE POLICY "fa_delete" ON "finance"."financial_accounts" FOR DELETE USING (("core"."is_finance_head"() AND "core"."same_org"("organization_id")));



CREATE POLICY "fa_insert" ON "finance"."financial_accounts" FOR INSERT WITH CHECK ((("core"."is_finance_head"() OR "core"."has_role"('ACCOUNTANT'::"text")) AND "core"."same_org"("organization_id")));



CREATE POLICY "fa_select" ON "finance"."financial_accounts" FOR SELECT USING ((("core"."is_finance_head"() OR "core"."has_role"('ACCOUNTANT'::"text") OR "core"."has_role"('VIEWER'::"text")) AND "core"."same_org"("organization_id")));



CREATE POLICY "fa_update" ON "finance"."financial_accounts" FOR UPDATE USING ((("core"."is_finance_head"() OR "core"."has_role"('ACCOUNTANT'::"text")) AND "core"."same_org"("organization_id")));



ALTER TABLE "finance"."fee_computation_log" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "finance"."fee_rules" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "fee_rules_select_org_scoped" ON "finance"."fee_rules" FOR SELECT USING ((("auth"."uid"() IS NOT NULL) AND "core"."same_org"("organization_id")));



ALTER TABLE "finance"."fee_tiers" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "fee_tiers_select_org_scoped" ON "finance"."fee_tiers" FOR SELECT TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "finance"."fee_rules" "fr"
  WHERE (("fr"."id" = "fee_tiers"."fee_rule_id") AND "core"."same_org"("fr"."organization_id")))));



ALTER TABLE "finance"."financial_accounts" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "finance"."fiscal_years" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "finance"."fixed_assets" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "fixed_assets_delete_org_scoped" ON "finance"."fixed_assets" FOR DELETE USING (("core"."same_org"("organization_id") AND ("auth"."uid"() = "created_by") AND (("status")::"text" = 'pending_capitalization'::"text") AND ("core"."is_finance_head"() OR "core"."has_role"('ACCOUNTANT'::"text"))));



CREATE POLICY "fixed_assets_insert_org_scoped" ON "finance"."fixed_assets" FOR INSERT WITH CHECK (("core"."same_org"("organization_id") AND ("core"."is_finance_head"() OR "core"."has_role"('ACCOUNTANT'::"text"))));



CREATE POLICY "fixed_assets_select_org_scoped" ON "finance"."fixed_assets" FOR SELECT USING (("core"."same_org"("organization_id") AND ("core"."is_finance_head"() OR "core"."has_role"('ACCOUNTANT'::"text") OR "core"."has_role"('VIEWER'::"text"))));



CREATE POLICY "fixed_assets_update_org_scoped" ON "finance"."fixed_assets" FOR UPDATE USING (("core"."same_org"("organization_id") AND ("core"."is_finance_head"() OR "core"."has_role"('ACCOUNTANT'::"text")))) WITH CHECK (("core"."same_org"("organization_id") AND ("core"."is_finance_head"() OR "core"."has_role"('ACCOUNTANT'::"text"))));



CREATE POLICY "fx_insert" ON "finance"."exchange_rates" FOR INSERT WITH CHECK ((("core"."is_finance_head"() OR "core"."has_role"('ACCOUNTANT'::"text")) AND "core"."same_org"("organization_id")));



COMMENT ON POLICY "fx_insert" ON "finance"."exchange_rates" IS 'Migration 040: added core.same_org(organization_id) tenant check. Previously this policy had no organization boundary at all, letting any Finance Head/Accountant in ANY organization insert exchange rates against another organization''s organization_id (Compliance Audit Rev 2, CRITICAL-1).';



CREATE POLICY "fx_select" ON "finance"."exchange_rates" FOR SELECT USING ((("core"."is_finance_head"() OR "core"."has_role"('ACCOUNTANT'::"text") OR "core"."has_role"('VIEWER'::"text")) AND "core"."same_org"("organization_id")));



COMMENT ON POLICY "fx_select" ON "finance"."exchange_rates" IS 'Migration 040: added core.same_org(organization_id) tenant check. Previously this policy had no organization boundary at all, letting any Finance Head/Accountant/Viewer in ANY organization read every other organization''s manual FX rates (Compliance Audit Rev 2, CRITICAL-1).';



CREATE POLICY "fy_insert" ON "finance"."fiscal_years" FOR INSERT WITH CHECK (("core"."is_finance_head"() AND "core"."same_org"("organization_id")));



CREATE POLICY "fy_select" ON "finance"."fiscal_years" FOR SELECT USING ((("auth"."uid"() IS NOT NULL) AND "core"."same_org"("organization_id")));



CREATE POLICY "fy_update" ON "finance"."fiscal_years" FOR UPDATE USING (("core"."is_finance_head"() AND "core"."same_org"("organization_id")));



ALTER TABLE "finance"."invoice_lines" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "invoice_lines_delete_org" ON "finance"."invoice_lines" FOR DELETE TO "authenticated" USING ("core"."same_org"("organization_id"));



CREATE POLICY "invoice_lines_insert_org" ON "finance"."invoice_lines" FOR INSERT TO "authenticated" WITH CHECK ("core"."same_org"("organization_id"));



CREATE POLICY "invoice_lines_select_org" ON "finance"."invoice_lines" FOR SELECT TO "authenticated" USING ("core"."same_org"("organization_id"));



CREATE POLICY "invoice_lines_update_org" ON "finance"."invoice_lines" FOR UPDATE TO "authenticated" USING ("core"."same_org"("organization_id")) WITH CHECK ("core"."same_org"("organization_id"));



CREATE POLICY "je_delete" ON "finance"."journal_entries" FOR DELETE USING (("core"."is_finance_head"() AND ("status" = 'DRAFT'::"text") AND "core"."same_org"("organization_id")));



CREATE POLICY "je_insert" ON "finance"."journal_entries" FOR INSERT WITH CHECK ((("core"."is_finance_head"() OR "core"."has_role"('ACCOUNTANT'::"text")) AND "core"."same_org"("organization_id")));



CREATE POLICY "je_select" ON "finance"."journal_entries" FOR SELECT USING ((("core"."is_finance_head"() OR "core"."has_role"('ACCOUNTANT'::"text") OR "core"."has_role"('VIEWER'::"text")) AND "core"."same_org"("organization_id")));



CREATE POLICY "je_update" ON "finance"."journal_entries" FOR UPDATE USING ((("core"."is_finance_head"() OR "core"."has_role"('ACCOUNTANT'::"text")) AND ("status" = 'DRAFT'::"text") AND "core"."same_org"("organization_id")));



CREATE POLICY "jl_delete" ON "finance"."journal_lines" FOR DELETE USING ((EXISTS ( SELECT 1
   FROM "finance"."journal_entries"
  WHERE (("journal_entries"."id" = "journal_lines"."journal_entry_id") AND ("journal_entries"."status" = 'DRAFT'::"text")))));



CREATE POLICY "jl_insert" ON "finance"."journal_lines" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM "finance"."journal_entries"
  WHERE (("journal_entries"."id" = "journal_lines"."journal_entry_id") AND ("journal_entries"."status" = 'DRAFT'::"text")))));



CREATE POLICY "jl_select" ON "finance"."journal_lines" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "finance"."journal_entries"
  WHERE ("journal_entries"."id" = "journal_lines"."journal_entry_id"))));



CREATE POLICY "jl_update" ON "finance"."journal_lines" FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM "finance"."journal_entries"
  WHERE (("journal_entries"."id" = "journal_lines"."journal_entry_id") AND ("journal_entries"."status" = 'DRAFT'::"text")))));



ALTER TABLE "finance"."journal_entries" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "finance"."journal_lines" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "ns_select_org_scoped" ON "finance"."numbering_sequences" FOR SELECT USING ((("auth"."uid"() IS NOT NULL) AND "core"."same_org"("organization_id")));



ALTER TABLE "finance"."numbering_sequences" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "finance"."opening_balance_imports" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "org_read_fee_log" ON "finance"."fee_computation_log" FOR SELECT TO "authenticated" USING ("core"."same_org"("organization_id"));



ALTER TABLE "finance"."owners" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "owners_delete_org_scoped" ON "finance"."owners" FOR DELETE USING (("core"."same_org"("organization_id") AND "core"."is_ceo_or_admin"()));



CREATE POLICY "owners_insert_org_scoped" ON "finance"."owners" FOR INSERT WITH CHECK (("core"."same_org"("organization_id") AND "core"."is_ceo_or_admin"()));



CREATE POLICY "owners_select_org_scoped" ON "finance"."owners" FOR SELECT USING (("core"."same_org"("organization_id") AND ("core"."is_ceo_or_admin"() OR "core"."is_finance_head"() OR "core"."has_role"('ACCOUNTANT'::"text"))));



CREATE POLICY "owners_update_org_scoped" ON "finance"."owners" FOR UPDATE USING (("core"."same_org"("organization_id") AND "core"."is_ceo_or_admin"())) WITH CHECK (("core"."same_org"("organization_id") AND "core"."is_ceo_or_admin"()));



ALTER TABLE "finance"."ownership_history" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "ownership_history_delete_org_scoped" ON "finance"."ownership_history" FOR DELETE USING (("core"."same_org"("organization_id") AND "core"."is_ceo_or_admin"()));



CREATE POLICY "ownership_history_insert_org_scoped" ON "finance"."ownership_history" FOR INSERT WITH CHECK (("core"."same_org"("organization_id") AND "core"."is_ceo_or_admin"()));



CREATE POLICY "ownership_history_select_org_scoped" ON "finance"."ownership_history" FOR SELECT USING (("core"."same_org"("organization_id") AND ("core"."is_ceo_or_admin"() OR "core"."is_finance_head"() OR "core"."has_role"('ACCOUNTANT'::"text"))));



CREATE POLICY "ownership_history_update_org_scoped" ON "finance"."ownership_history" FOR UPDATE USING (("core"."same_org"("organization_id") AND "core"."is_ceo_or_admin"())) WITH CHECK (("core"."same_org"("organization_id") AND "core"."is_ceo_or_admin"()));



CREATE POLICY "pa_delete" ON "finance"."payment_allocations" FOR DELETE USING (("core"."is_finance_head"() AND (EXISTS ( SELECT 1
   FROM "public"."invoices" "i"
  WHERE (("i"."id" = "payment_allocations"."invoice_id") AND "core"."same_org"("i"."organization_id"))))));



CREATE POLICY "pa_insert" ON "finance"."payment_allocations" FOR INSERT WITH CHECK ((("core"."is_finance_head"() OR "core"."has_role"('ACCOUNTANT'::"text")) AND (EXISTS ( SELECT 1
   FROM "public"."invoices" "i"
  WHERE (("i"."id" = "payment_allocations"."invoice_id") AND "core"."same_org"("i"."organization_id")))) AND (EXISTS ( SELECT 1
   FROM "finance"."payment_receipts" "pr"
  WHERE (("pr"."id" = "payment_allocations"."payment_receipt_id") AND "core"."same_org"("pr"."organization_id"))))));



CREATE POLICY "pa_select" ON "finance"."payment_allocations" FOR SELECT USING ((("core"."is_finance_head"() OR "core"."has_role"('ACCOUNTANT'::"text") OR "core"."has_role"('VIEWER'::"text")) AND (EXISTS ( SELECT 1
   FROM "public"."invoices" "i"
  WHERE (("i"."id" = "payment_allocations"."invoice_id") AND "core"."same_org"("i"."organization_id"))))));



CREATE POLICY "pa_update" ON "finance"."payment_allocations" FOR UPDATE USING (("core"."is_finance_head"() AND (EXISTS ( SELECT 1
   FROM "public"."invoices" "i"
  WHERE (("i"."id" = "payment_allocations"."invoice_id") AND "core"."same_org"("i"."organization_id")))))) WITH CHECK (("core"."is_finance_head"() AND (EXISTS ( SELECT 1
   FROM "public"."invoices" "i"
  WHERE (("i"."id" = "payment_allocations"."invoice_id") AND "core"."same_org"("i"."organization_id"))))));



ALTER TABLE "finance"."payment_allocations" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "finance"."payment_receipts" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "finance"."platforms" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "platforms_select_org_scoped" ON "finance"."platforms" FOR SELECT USING ((("auth"."uid"() IS NOT NULL) AND "core"."same_org"("organization_id")));



CREATE POLICY "pr_insert_org_scoped" ON "finance"."payment_receipts" FOR INSERT WITH CHECK ((("auth"."uid"() IS NOT NULL) AND "core"."same_org"("organization_id")));



CREATE POLICY "pr_select_org_scoped" ON "finance"."payment_receipts" FOR SELECT USING ((("auth"."uid"() IS NOT NULL) AND "core"."same_org"("organization_id")));



CREATE POLICY "pr_update_org_scoped" ON "finance"."payment_receipts" FOR UPDATE USING ((("auth"."uid"() IS NOT NULL) AND "core"."same_org"("organization_id"))) WITH CHECK ((("auth"."uid"() IS NOT NULL) AND "core"."same_org"("organization_id")));



ALTER TABLE "finance"."profit_distributions" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "profit_distributions_delete_org_scoped" ON "finance"."profit_distributions" FOR DELETE USING (("core"."same_org"("organization_id") AND "core"."is_ceo_or_admin"()));



CREATE POLICY "profit_distributions_insert_org_scoped" ON "finance"."profit_distributions" FOR INSERT WITH CHECK (("core"."same_org"("organization_id") AND ("core"."is_ceo_or_admin"() OR "core"."is_finance_head"())));



CREATE POLICY "profit_distributions_select_org_scoped" ON "finance"."profit_distributions" FOR SELECT USING (("core"."same_org"("organization_id") AND ("core"."is_ceo_or_admin"() OR "core"."is_finance_head"() OR "core"."has_role"('ACCOUNTANT'::"text"))));



CREATE POLICY "profit_distributions_update_org_scoped" ON "finance"."profit_distributions" FOR UPDATE USING (("core"."same_org"("organization_id") AND ("core"."is_ceo_or_admin"() OR "core"."is_finance_head"()))) WITH CHECK (("core"."same_org"("organization_id") AND ("core"."is_ceo_or_admin"() OR "core"."is_finance_head"())));



ALTER TABLE "finance"."reserve_policies" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "reserve_policies_delete_org_scoped" ON "finance"."reserve_policies" FOR DELETE USING (("core"."same_org"("organization_id") AND "core"."is_ceo_or_admin"()));



CREATE POLICY "reserve_policies_insert_org_scoped" ON "finance"."reserve_policies" FOR INSERT WITH CHECK (("core"."same_org"("organization_id") AND ("core"."is_ceo_or_admin"() OR "core"."is_finance_head"())));



CREATE POLICY "reserve_policies_select_org_scoped" ON "finance"."reserve_policies" FOR SELECT USING (("core"."same_org"("organization_id") AND ("core"."is_ceo_or_admin"() OR "core"."is_finance_head"() OR "core"."has_role"('ACCOUNTANT'::"text") OR "core"."has_role"('VIEWER'::"text"))));



CREATE POLICY "reserve_policies_update_org_scoped" ON "finance"."reserve_policies" FOR UPDATE USING (("core"."same_org"("organization_id") AND ("core"."is_ceo_or_admin"() OR "core"."is_finance_head"()))) WITH CHECK (("core"."same_org"("organization_id") AND ("core"."is_ceo_or_admin"() OR "core"."is_finance_head"())));



ALTER TABLE "finance"."settlement_batches" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "settlement_batches_delete_org" ON "finance"."settlement_batches" FOR DELETE TO "authenticated" USING ("core"."same_org"("organization_id"));



CREATE POLICY "settlement_batches_insert_org" ON "finance"."settlement_batches" FOR INSERT TO "authenticated" WITH CHECK ("core"."same_org"("organization_id"));



CREATE POLICY "settlement_batches_select_org" ON "finance"."settlement_batches" FOR SELECT TO "authenticated" USING ("core"."same_org"("organization_id"));



CREATE POLICY "settlement_batches_update_org" ON "finance"."settlement_batches" FOR UPDATE TO "authenticated" USING ("core"."same_org"("organization_id")) WITH CHECK ("core"."same_org"("organization_id"));



ALTER TABLE "finance"."settlement_lines" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "settlement_lines_delete_org" ON "finance"."settlement_lines" FOR DELETE TO "authenticated" USING ("core"."same_org"("organization_id"));



CREATE POLICY "settlement_lines_insert_org" ON "finance"."settlement_lines" FOR INSERT TO "authenticated" WITH CHECK ("core"."same_org"("organization_id"));



CREATE POLICY "settlement_lines_select_org" ON "finance"."settlement_lines" FOR SELECT TO "authenticated" USING ("core"."same_org"("organization_id"));



CREATE POLICY "settlement_lines_update_org" ON "finance"."settlement_lines" FOR UPDATE TO "authenticated" USING ("core"."same_org"("organization_id")) WITH CHECK ("core"."same_org"("organization_id"));



CREATE POLICY "sl_delete_org_scoped" ON "finance"."statement_lines" FOR DELETE USING ((("auth"."uid"() IS NOT NULL) AND (EXISTS ( SELECT 1
   FROM "finance"."bank_statements" "bs"
  WHERE (("bs"."id" = "statement_lines"."bank_statement_id") AND "core"."same_org"("bs"."organization_id"))))));



CREATE POLICY "sl_insert_org_scoped" ON "finance"."statement_lines" FOR INSERT WITH CHECK ((("auth"."uid"() IS NOT NULL) AND (EXISTS ( SELECT 1
   FROM "finance"."bank_statements" "bs"
  WHERE (("bs"."id" = "statement_lines"."bank_statement_id") AND "core"."same_org"("bs"."organization_id"))))));



CREATE POLICY "sl_select_org_scoped" ON "finance"."statement_lines" FOR SELECT USING ((("auth"."uid"() IS NOT NULL) AND (EXISTS ( SELECT 1
   FROM "finance"."bank_statements" "bs"
  WHERE (("bs"."id" = "statement_lines"."bank_statement_id") AND "core"."same_org"("bs"."organization_id"))))));



CREATE POLICY "sl_update_org_scoped" ON "finance"."statement_lines" FOR UPDATE USING ((("auth"."uid"() IS NOT NULL) AND (EXISTS ( SELECT 1
   FROM "finance"."bank_statements" "bs"
  WHERE (("bs"."id" = "statement_lines"."bank_statement_id") AND "core"."same_org"("bs"."organization_id"))))));



ALTER TABLE "finance"."statement_lines" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "ta_delete_restricted" ON "finance"."tax_adjustments" FOR DELETE USING ((("core"."is_ceo_or_admin"() OR "core"."is_finance_head"()) AND "core"."same_org"("organization_id")));



CREATE POLICY "ta_insert_org_scoped" ON "finance"."tax_adjustments" FOR INSERT WITH CHECK ((("auth"."uid"() IS NOT NULL) AND "core"."same_org"("organization_id")));



CREATE POLICY "ta_select_org_scoped" ON "finance"."tax_adjustments" FOR SELECT USING ((("auth"."uid"() IS NOT NULL) AND "core"."same_org"("organization_id")));



CREATE POLICY "ta_update_restricted" ON "finance"."tax_adjustments" FOR UPDATE USING ((("core"."is_ceo_or_admin"() OR "core"."is_finance_head"() OR "core"."has_role"('ACCOUNTANT'::"text")) AND "core"."same_org"("organization_id"))) WITH CHECK ((("core"."is_ceo_or_admin"() OR "core"."is_finance_head"() OR "core"."has_role"('ACCOUNTANT'::"text")) AND "core"."same_org"("organization_id")));



ALTER TABLE "finance"."tax_adjustments" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "finance"."tax_codes" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "tax_codes_delete_org" ON "finance"."tax_codes" FOR DELETE TO "authenticated" USING (("core"."same_org"("organization_id") AND "core"."is_finance_head"()));



CREATE POLICY "tax_codes_insert_org" ON "finance"."tax_codes" FOR INSERT TO "authenticated" WITH CHECK (("core"."same_org"("organization_id") AND ("core"."is_finance_head"() OR "core"."has_role"('ACCOUNTANT'::"text"))));



CREATE POLICY "tax_codes_select_org" ON "finance"."tax_codes" FOR SELECT TO "authenticated" USING ("core"."same_org"("organization_id"));



CREATE POLICY "tax_codes_update_org" ON "finance"."tax_codes" FOR UPDATE TO "authenticated" USING (("core"."same_org"("organization_id") AND ("core"."is_finance_head"() OR "core"."has_role"('ACCOUNTANT'::"text")))) WITH CHECK (("core"."same_org"("organization_id") AND ("core"."is_finance_head"() OR "core"."has_role"('ACCOUNTANT'::"text"))));



CREATE POLICY "tax_comp_delete" ON "finance"."tax_computations" FOR DELETE TO "authenticated" USING ((("organization_id" = "core"."current_user_org_config_id"()) AND ("core"."is_ceo_or_admin"() OR "core"."is_finance_head"())));



CREATE POLICY "tax_comp_insert" ON "finance"."tax_computations" FOR INSERT TO "authenticated" WITH CHECK ((("organization_id" = "core"."current_user_org_config_id"()) AND ("core"."is_ceo_or_admin"() OR "core"."is_finance_head"() OR "core"."has_role"('ACCOUNTANT'::"text"))));



CREATE POLICY "tax_comp_select" ON "finance"."tax_computations" FOR SELECT TO "authenticated" USING ((("organization_id" = "core"."current_user_org_config_id"()) AND ("core"."is_ceo_or_admin"() OR "core"."is_finance_head"() OR "core"."has_role"('ACCOUNTANT'::"text") OR "core"."has_role"('AUDITOR'::"text"))));



CREATE POLICY "tax_comp_service" ON "finance"."tax_computations" TO "service_role" USING (true) WITH CHECK (true);



CREATE POLICY "tax_comp_update" ON "finance"."tax_computations" FOR UPDATE TO "authenticated" USING ((("organization_id" = "core"."current_user_org_config_id"()) AND ("core"."is_ceo_or_admin"() OR "core"."is_finance_head"() OR "core"."has_role"('ACCOUNTANT'::"text"))));



ALTER TABLE "finance"."tax_computations" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "finance"."tax_credits_and_withholding" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "tax_cw_delete" ON "finance"."tax_credits_and_withholding" FOR DELETE TO "authenticated" USING ((("organization_id" = "core"."current_user_org_config_id"()) AND ("core"."is_ceo_or_admin"() OR "core"."is_finance_head"())));



CREATE POLICY "tax_cw_insert" ON "finance"."tax_credits_and_withholding" FOR INSERT TO "authenticated" WITH CHECK ((("organization_id" = "core"."current_user_org_config_id"()) AND ("core"."is_ceo_or_admin"() OR "core"."is_finance_head"() OR "core"."has_role"('ACCOUNTANT'::"text"))));



CREATE POLICY "tax_cw_select" ON "finance"."tax_credits_and_withholding" FOR SELECT TO "authenticated" USING ((("organization_id" = "core"."current_user_org_config_id"()) AND ("core"."is_ceo_or_admin"() OR "core"."is_finance_head"() OR "core"."has_role"('ACCOUNTANT'::"text") OR "core"."has_role"('AUDITOR'::"text"))));



CREATE POLICY "tax_cw_service" ON "finance"."tax_credits_and_withholding" TO "service_role" USING (true) WITH CHECK (true);



CREATE POLICY "tax_cw_update" ON "finance"."tax_credits_and_withholding" FOR UPDATE TO "authenticated" USING ((("organization_id" = "core"."current_user_org_config_id"()) AND ("core"."is_ceo_or_admin"() OR "core"."is_finance_head"() OR "core"."has_role"('ACCOUNTANT'::"text"))));



CREATE POLICY "tax_pay_delete" ON "finance"."tax_payments_and_refunds" FOR DELETE TO "authenticated" USING ((("organization_id" = "core"."current_user_org_config_id"()) AND ("core"."is_ceo_or_admin"() OR "core"."is_finance_head"())));



CREATE POLICY "tax_pay_insert" ON "finance"."tax_payments_and_refunds" FOR INSERT TO "authenticated" WITH CHECK ((("organization_id" = "core"."current_user_org_config_id"()) AND ("core"."is_ceo_or_admin"() OR "core"."is_finance_head"() OR "core"."has_role"('ACCOUNTANT'::"text"))));



CREATE POLICY "tax_pay_select" ON "finance"."tax_payments_and_refunds" FOR SELECT TO "authenticated" USING ((("organization_id" = "core"."current_user_org_config_id"()) AND ("core"."is_ceo_or_admin"() OR "core"."is_finance_head"() OR "core"."has_role"('ACCOUNTANT'::"text") OR "core"."has_role"('AUDITOR'::"text"))));



CREATE POLICY "tax_pay_service" ON "finance"."tax_payments_and_refunds" TO "service_role" USING (true) WITH CHECK (true);



CREATE POLICY "tax_pay_update" ON "finance"."tax_payments_and_refunds" FOR UPDATE TO "authenticated" USING ((("organization_id" = "core"."current_user_org_config_id"()) AND ("core"."is_ceo_or_admin"() OR "core"."is_finance_head"() OR "core"."has_role"('ACCOUNTANT'::"text"))));



ALTER TABLE "finance"."tax_payments_and_refunds" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "finance"."tax_reconciliations" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "tax_ret_delete" ON "finance"."tax_returns" FOR DELETE TO "authenticated" USING ((("organization_id" = "core"."current_user_org_config_id"()) AND ("core"."is_ceo_or_admin"() OR "core"."is_finance_head"())));



CREATE POLICY "tax_ret_insert" ON "finance"."tax_returns" FOR INSERT TO "authenticated" WITH CHECK ((("organization_id" = "core"."current_user_org_config_id"()) AND ("core"."is_ceo_or_admin"() OR "core"."is_finance_head"() OR "core"."has_role"('ACCOUNTANT'::"text"))));



CREATE POLICY "tax_ret_select" ON "finance"."tax_returns" FOR SELECT TO "authenticated" USING ((("organization_id" = "core"."current_user_org_config_id"()) AND ("core"."is_ceo_or_admin"() OR "core"."is_finance_head"() OR "core"."has_role"('ACCOUNTANT'::"text") OR "core"."has_role"('AUDITOR'::"text"))));



CREATE POLICY "tax_ret_service" ON "finance"."tax_returns" TO "service_role" USING (true) WITH CHECK (true);



CREATE POLICY "tax_ret_update" ON "finance"."tax_returns" FOR UPDATE TO "authenticated" USING ((("organization_id" = "core"."current_user_org_config_id"()) AND ("core"."is_ceo_or_admin"() OR "core"."is_finance_head"() OR "core"."has_role"('ACCOUNTANT'::"text"))));



ALTER TABLE "finance"."tax_returns" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "finance"."tax_rule_sets" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "finance"."tax_slabs" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "finance"."taxpayer_profile" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "tp_select" ON "finance"."taxpayer_profile" FOR SELECT USING ((("core"."is_finance_head"() OR "core"."has_role"('ACCOUNTANT'::"text")) AND "core"."same_org"("organization_id")));



CREATE POLICY "tp_update" ON "finance"."taxpayer_profile" FOR UPDATE USING (("core"."is_finance_head"() AND "core"."same_org"("organization_id")));



CREATE POLICY "tr_insert_org_scoped" ON "finance"."tax_reconciliations" FOR INSERT WITH CHECK ((("auth"."uid"() IS NOT NULL) AND "core"."same_org"("organization_id")));



CREATE POLICY "tr_select_org_scoped" ON "finance"."tax_reconciliations" FOR SELECT USING ((("auth"."uid"() IS NOT NULL) AND "core"."same_org"("organization_id")));



CREATE POLICY "tr_update_restricted" ON "finance"."tax_reconciliations" FOR UPDATE USING ((("core"."is_ceo_or_admin"() OR "core"."is_finance_head"() OR "core"."has_role"('ACCOUNTANT'::"text")) AND "core"."same_org"("organization_id"))) WITH CHECK ((("core"."is_ceo_or_admin"() OR "core"."is_finance_head"() OR "core"."has_role"('ACCOUNTANT'::"text")) AND "core"."same_org"("organization_id")));



CREATE POLICY "trs_insert_org_scoped" ON "finance"."tax_rule_sets" FOR INSERT WITH CHECK (("core"."same_org"("organization_id") AND ("core"."is_finance_head"() OR "core"."has_role"('ACCOUNTANT'::"text"))));



CREATE POLICY "trs_select_org_scoped" ON "finance"."tax_rule_sets" FOR SELECT USING (("core"."same_org"("organization_id") AND ("core"."is_finance_head"() OR "core"."has_role"('ACCOUNTANT'::"text"))));



CREATE POLICY "trs_update_org_scoped" ON "finance"."tax_rule_sets" FOR UPDATE USING (("core"."same_org"("organization_id") AND ("core"."is_finance_head"() OR "core"."has_role"('ACCOUNTANT'::"text")))) WITH CHECK (("core"."same_org"("organization_id") AND ("core"."is_finance_head"() OR "core"."has_role"('ACCOUNTANT'::"text"))));



CREATE POLICY "tsl_delete_restricted" ON "finance"."tax_slabs" FOR DELETE USING ((("core"."is_ceo_or_admin"() OR "core"."is_finance_head"()) AND "core"."same_org"("organization_id")));



CREATE POLICY "tsl_insert_org_scoped" ON "finance"."tax_slabs" FOR INSERT WITH CHECK ((("auth"."uid"() IS NOT NULL) AND "core"."same_org"("organization_id")));



CREATE POLICY "tsl_select_org_scoped" ON "finance"."tax_slabs" FOR SELECT USING ((("auth"."uid"() IS NOT NULL) AND "core"."same_org"("organization_id")));



CREATE POLICY "tsl_update_restricted" ON "finance"."tax_slabs" FOR UPDATE USING ((("core"."is_ceo_or_admin"() OR "core"."is_finance_head"()) AND "core"."same_org"("organization_id"))) WITH CHECK ((("core"."is_ceo_or_admin"() OR "core"."is_finance_head"()) AND "core"."same_org"("organization_id")));



CREATE POLICY "v_insert" ON "finance"."vendors" FOR INSERT WITH CHECK ((("core"."is_finance_head"() OR "core"."has_role"('ACCOUNTANT'::"text")) AND "core"."same_org"("organization_id")));



CREATE POLICY "v_select" ON "finance"."vendors" FOR SELECT USING ((("core"."is_finance_head"() OR "core"."has_role"('ACCOUNTANT'::"text") OR "core"."has_role"('PROJECT_MANAGER'::"text") OR "core"."has_role"('VIEWER'::"text")) AND "core"."same_org"("organization_id")));



CREATE POLICY "v_update" ON "finance"."vendors" FOR UPDATE USING ((("core"."is_finance_head"() OR "core"."has_role"('ACCOUNTANT'::"text")) AND "core"."same_org"("organization_id")));



CREATE POLICY "vb_insert" ON "finance"."vendor_bills" FOR INSERT WITH CHECK ((("core"."is_finance_head"() OR "core"."has_role"('ACCOUNTANT'::"text")) AND "core"."same_org"("organization_id")));



CREATE POLICY "vb_select" ON "finance"."vendor_bills" FOR SELECT USING ((("core"."is_finance_head"() OR "core"."has_role"('ACCOUNTANT'::"text") OR "core"."has_role"('PROJECT_MANAGER'::"text") OR "core"."has_role"('VIEWER'::"text")) AND "core"."same_org"("organization_id")));



CREATE POLICY "vb_update" ON "finance"."vendor_bills" FOR UPDATE USING ((("core"."is_finance_head"() OR "core"."has_role"('ACCOUNTANT'::"text")) AND "core"."same_org"("organization_id")));



CREATE POLICY "vbl_insert_org_scoped" ON "finance"."vendor_bill_lines" FOR INSERT WITH CHECK ((("auth"."uid"() IS NOT NULL) AND (EXISTS ( SELECT 1
   FROM "finance"."vendor_bills" "vb"
  WHERE (("vb"."id" = "vendor_bill_lines"."vendor_bill_id") AND "core"."same_org"("vb"."organization_id"))))));



CREATE POLICY "vbl_select_org_scoped" ON "finance"."vendor_bill_lines" FOR SELECT USING ((("auth"."uid"() IS NOT NULL) AND (EXISTS ( SELECT 1
   FROM "finance"."vendor_bills" "vb"
  WHERE (("vb"."id" = "vendor_bill_lines"."vendor_bill_id") AND "core"."same_org"("vb"."organization_id"))))));



CREATE POLICY "vbl_update_org_scoped" ON "finance"."vendor_bill_lines" FOR UPDATE USING ((("auth"."uid"() IS NOT NULL) AND (EXISTS ( SELECT 1
   FROM "finance"."vendor_bills" "vb"
  WHERE (("vb"."id" = "vendor_bill_lines"."vendor_bill_id") AND "core"."same_org"("vb"."organization_id"))))));



ALTER TABLE "finance"."vendor_bill_lines" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "finance"."vendor_bills" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "finance"."vendor_payment_allocations" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "finance"."vendor_payments" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "finance"."vendors" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "vp_insert_org_scoped" ON "finance"."vendor_payments" FOR INSERT WITH CHECK ((("auth"."uid"() IS NOT NULL) AND "core"."same_org"("organization_id")));



CREATE POLICY "vp_select_org_scoped" ON "finance"."vendor_payments" FOR SELECT USING ((("auth"."uid"() IS NOT NULL) AND "core"."same_org"("organization_id")));



CREATE POLICY "vp_update_org_scoped" ON "finance"."vendor_payments" FOR UPDATE USING ((("auth"."uid"() IS NOT NULL) AND "core"."same_org"("organization_id"))) WITH CHECK ((("auth"."uid"() IS NOT NULL) AND "core"."same_org"("organization_id")));



CREATE POLICY "vpa_insert_org_scoped" ON "finance"."vendor_payment_allocations" FOR INSERT WITH CHECK ((("core"."is_finance_head"() OR "core"."has_role"('ACCOUNTANT'::"text")) AND (EXISTS ( SELECT 1
   FROM "finance"."vendor_bills" "vb"
  WHERE (("vb"."id" = "vendor_payment_allocations"."vendor_bill_id") AND "core"."same_org"("vb"."organization_id")))) AND (EXISTS ( SELECT 1
   FROM "finance"."vendor_payments" "vp"
  WHERE (("vp"."id" = "vendor_payment_allocations"."vendor_payment_id") AND "core"."same_org"("vp"."organization_id")))) AND (EXISTS ( SELECT 1
   FROM ("finance"."vendor_bills" "vb2"
     JOIN "finance"."vendor_payments" "vp2" ON (("vp2"."organization_id" = "vb2"."organization_id")))
  WHERE (("vb2"."id" = "vendor_payment_allocations"."vendor_bill_id") AND ("vp2"."id" = "vendor_payment_allocations"."vendor_payment_id"))))));



CREATE POLICY "vpa_select_org_scoped" ON "finance"."vendor_payment_allocations" FOR SELECT USING ((("core"."is_finance_head"() OR "core"."has_role"('ACCOUNTANT'::"text") OR "core"."has_role"('VIEWER'::"text")) AND (EXISTS ( SELECT 1
   FROM "finance"."vendor_bills" "vb"
  WHERE (("vb"."id" = "vendor_payment_allocations"."vendor_bill_id") AND "core"."same_org"("vb"."organization_id")))) AND (EXISTS ( SELECT 1
   FROM "finance"."vendor_payments" "vp"
  WHERE (("vp"."id" = "vendor_payment_allocations"."vendor_payment_id") AND "core"."same_org"("vp"."organization_id"))))));



ALTER TABLE "legacy"."budget_lines" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "budget_lines_pub_delete_frozen" ON "legacy"."budget_lines" FOR DELETE TO "authenticated" USING (false);



CREATE POLICY "budget_lines_pub_insert_frozen" ON "legacy"."budget_lines" FOR INSERT TO "authenticated" WITH CHECK (false);



CREATE POLICY "budget_lines_pub_select_org_scoped" ON "legacy"."budget_lines" FOR SELECT TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."budgets" "b"
  WHERE (("b"."id" = "budget_lines"."budget_id") AND "core"."same_org"("b"."organization_id")))));



CREATE POLICY "budget_lines_pub_service_all" ON "legacy"."budget_lines" TO "service_role" USING (true) WITH CHECK (true);



CREATE POLICY "budget_lines_pub_update_frozen" ON "legacy"."budget_lines" FOR UPDATE TO "authenticated" USING (false);



CREATE POLICY "fa_pub_delete_frozen" ON "legacy"."financial_accounts" FOR DELETE TO "authenticated" USING (false);



CREATE POLICY "fa_pub_insert_frozen" ON "legacy"."financial_accounts" FOR INSERT TO "authenticated" WITH CHECK (false);



CREATE POLICY "fa_pub_select" ON "legacy"."financial_accounts" FOR SELECT USING (("core"."is_finance_head"() OR "core"."has_role"('ACCOUNTANT'::"text") OR "core"."has_role"('VIEWER'::"text")));



CREATE POLICY "fa_pub_service_all" ON "legacy"."financial_accounts" TO "service_role" USING (true) WITH CHECK (true);



CREATE POLICY "fa_pub_update_frozen" ON "legacy"."financial_accounts" FOR UPDATE TO "authenticated" USING (false);



ALTER TABLE "legacy"."financial_accounts" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "numbering_insert_frozen" ON "legacy"."numbering_sequences" FOR INSERT TO "authenticated" WITH CHECK (false);



CREATE POLICY "numbering_select_role_restricted" ON "legacy"."numbering_sequences" FOR SELECT USING (("core"."is_finance_head"() OR "core"."has_role"('ACCOUNTANT'::"text") OR "core"."has_role"('VIEWER'::"text")));



ALTER TABLE "legacy"."numbering_sequences" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "numbering_service_all" ON "legacy"."numbering_sequences" TO "service_role" USING (true) WITH CHECK (true);



CREATE POLICY "numbering_update_frozen" ON "legacy"."numbering_sequences" FOR UPDATE TO "authenticated" USING (false);



ALTER TABLE "legacy"."tax_returns" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "tax_returns_pub_delete_frozen" ON "legacy"."tax_returns" FOR DELETE TO "authenticated" USING (false);



CREATE POLICY "tax_returns_pub_insert_frozen" ON "legacy"."tax_returns" FOR INSERT TO "authenticated" WITH CHECK (false);



CREATE POLICY "tax_returns_pub_select_org_scoped" ON "legacy"."tax_returns" FOR SELECT TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."user_id" = "tax_returns"."user_id") AND "core"."same_org"("p"."organization_id")))));



CREATE POLICY "tax_returns_pub_service_all" ON "legacy"."tax_returns" TO "service_role" USING (true) WITH CHECK (true);



CREATE POLICY "tax_returns_pub_update_frozen" ON "legacy"."tax_returns" FOR UPDATE TO "authenticated" USING (false);



CREATE POLICY "Service role full access on commissions" ON "public"."commissions" TO "service_role" USING (true) WITH CHECK (true);



CREATE POLICY "Service role full access on contractors" ON "public"."contractors" TO "service_role" USING (true) WITH CHECK (true);



CREATE POLICY "Service role full access on payroll_advances" ON "public"."payroll_advances" TO "service_role" USING (true) WITH CHECK (true);



CREATE POLICY "Service role full access on payroll_commissions" ON "public"."payroll_commissions" TO "service_role" USING (true) WITH CHECK (true);



CREATE POLICY "Service role full access on payroll_compensation" ON "public"."payroll_compensation" TO "service_role" USING (true) WITH CHECK (true);



CREATE POLICY "Service role full access on payroll_deductions" ON "public"."payroll_deductions" TO "service_role" USING (true) WITH CHECK (true);



CREATE POLICY "Service role full access on payroll_employees" ON "public"."payroll_employees" TO "service_role" USING (true) WITH CHECK (true);



CREATE POLICY "Service role full access on payroll_lines" ON "public"."payroll_lines" TO "service_role" USING (true) WITH CHECK (true);



CREATE POLICY "Service role full access on payroll_reimbursements" ON "public"."payroll_reimbursements" TO "service_role" USING (true) WITH CHECK (true);



CREATE POLICY "Service role full access on payroll_runs" ON "public"."payroll_runs" TO "service_role" USING (true) WITH CHECK (true);



CREATE POLICY "Service role full access on subscriptions" ON "public"."subscriptions" TO "service_role" USING (true) WITH CHECK (true);



CREATE POLICY "Users manage own notifications" ON "public"."notifications" USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Users see own MFA" ON "public"."user_mfa" USING (("auth"."uid"() = "user_id"));



CREATE POLICY "admin_can_read_mfa_status_org_scoped" ON "public"."user_mfa" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."user_id" = "auth"."uid"()) AND ("p"."role" = 'CEO'::"text") AND ("p"."organization_id" IS NOT NULL) AND ("p"."organization_id" = ( SELECT "target"."organization_id"
           FROM "public"."profiles" "target"
          WHERE ("target"."user_id" = "user_mfa"."user_id")))))));



ALTER TABLE "public"."budgets" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "budgets_insert_org_scoped" ON "public"."budgets" FOR INSERT TO "authenticated" WITH CHECK (("core"."same_org"("organization_id") AND ("core"."is_finance_head"() OR "core"."has_role"('ACCOUNTANT'::"text") OR ("user_id" = "auth"."uid"()))));



CREATE POLICY "budgets_select_org_scoped" ON "public"."budgets" FOR SELECT TO "authenticated" USING (("core"."same_org"("organization_id") AND ("core"."is_finance_head"() OR "core"."has_role"('ACCOUNTANT'::"text") OR "core"."has_role"('VIEWER'::"text") OR ("user_id" = "auth"."uid"()) OR (("project_id" IS NOT NULL) AND (EXISTS ( SELECT 1
   FROM "public"."projects" "p"
  WHERE (("p"."id" = "budgets"."project_id") AND ("p"."user_id" = "auth"."uid"()))))))));



CREATE POLICY "budgets_update_org_scoped" ON "public"."budgets" FOR UPDATE TO "authenticated" USING (("core"."same_org"("organization_id") AND ("core"."is_finance_head"() OR "core"."has_role"('ACCOUNTANT'::"text") OR (("user_id" = "auth"."uid"()) AND ("status" = 'DRAFT'::"text"))))) WITH CHECK (("core"."same_org"("organization_id") AND ("core"."is_finance_head"() OR "core"."has_role"('ACCOUNTANT'::"text") OR (("user_id" = "auth"."uid"()) AND ("status" = 'DRAFT'::"text")))));



ALTER TABLE "public"."clients" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "clients_delete_org_scoped" ON "public"."clients" FOR DELETE TO "authenticated" USING (("core"."same_org"("organization_id") AND "core"."is_finance_head"()));



CREATE POLICY "clients_insert_org_scoped" ON "public"."clients" FOR INSERT TO "authenticated" WITH CHECK (("core"."same_org"("organization_id") AND ("core"."is_finance_head"() OR "core"."has_role"('ACCOUNTANT'::"text"))));



CREATE POLICY "clients_select_org_scoped" ON "public"."clients" FOR SELECT TO "authenticated" USING (("core"."same_org"("organization_id") AND ("core"."is_finance_head"() OR "core"."has_role"('ACCOUNTANT'::"text") OR "core"."has_role"('VIEWER'::"text") OR "core"."has_role"('PROJECT_MANAGER'::"text") OR ("user_id" = "auth"."uid"()))));



CREATE POLICY "clients_update_org_scoped" ON "public"."clients" FOR UPDATE TO "authenticated" USING (("core"."same_org"("organization_id") AND ("core"."is_finance_head"() OR "core"."has_role"('ACCOUNTANT'::"text")))) WITH CHECK (("core"."same_org"("organization_id") AND ("core"."is_finance_head"() OR "core"."has_role"('ACCOUNTANT'::"text"))));



ALTER TABLE "public"."commissions" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "commissions_delete_org_scoped" ON "public"."commissions" FOR DELETE TO "authenticated" USING (("core"."same_org"("organization_id") AND "core"."is_finance_head"()));



CREATE POLICY "commissions_insert_org_scoped" ON "public"."commissions" FOR INSERT TO "authenticated" WITH CHECK (("core"."same_org"("organization_id") AND ("core"."is_finance_head"() OR "core"."has_role"('ACCOUNTANT'::"text"))));



CREATE POLICY "commissions_select_org_scoped" ON "public"."commissions" FOR SELECT TO "authenticated" USING (("core"."same_org"("organization_id") AND ("core"."is_finance_head"() OR "core"."has_role"('ACCOUNTANT'::"text"))));



CREATE POLICY "commissions_update_org_scoped" ON "public"."commissions" FOR UPDATE TO "authenticated" USING (("core"."same_org"("organization_id") AND ("core"."is_finance_head"() OR "core"."has_role"('ACCOUNTANT'::"text")))) WITH CHECK (("core"."same_org"("organization_id") AND ("core"."is_finance_head"() OR "core"."has_role"('ACCOUNTANT'::"text"))));



ALTER TABLE "public"."contractors" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "contractors_delete_org_scoped" ON "public"."contractors" FOR DELETE TO "authenticated" USING (("core"."same_org"("organization_id") AND "core"."is_finance_head"()));



CREATE POLICY "contractors_insert_org_scoped" ON "public"."contractors" FOR INSERT TO "authenticated" WITH CHECK (("core"."same_org"("organization_id") AND ("core"."is_finance_head"() OR "core"."has_role"('ACCOUNTANT'::"text"))));



CREATE POLICY "contractors_select_org_scoped" ON "public"."contractors" FOR SELECT TO "authenticated" USING (("core"."same_org"("organization_id") AND ("core"."is_finance_head"() OR "core"."has_role"('ACCOUNTANT'::"text") OR "core"."has_role"('PROJECT_MANAGER'::"text"))));



CREATE POLICY "contractors_update_org_scoped" ON "public"."contractors" FOR UPDATE TO "authenticated" USING (("core"."same_org"("organization_id") AND ("core"."is_finance_head"() OR "core"."has_role"('ACCOUNTANT'::"text")))) WITH CHECK (("core"."same_org"("organization_id") AND ("core"."is_finance_head"() OR "core"."has_role"('ACCOUNTANT'::"text"))));



ALTER TABLE "public"."expenses" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "expenses_delete_org_scoped" ON "public"."expenses" FOR DELETE TO "authenticated" USING (("core"."same_org"("organization_id") AND (("auth"."uid"() = "user_id") OR "public"."is_admin"())));



CREATE POLICY "expenses_insert_org_scoped" ON "public"."expenses" FOR INSERT TO "authenticated" WITH CHECK (("core"."same_org"("organization_id") AND (("auth"."uid"() = "user_id") OR "public"."is_admin"())));



CREATE POLICY "expenses_select_org_scoped" ON "public"."expenses" FOR SELECT TO "authenticated" USING (("core"."same_org"("organization_id") AND ("core"."is_finance_head"() OR "core"."has_role"('ACCOUNTANT'::"text") OR "core"."has_role"('VIEWER'::"text") OR ("user_id" = "auth"."uid"()) OR (("project_id" IS NOT NULL) AND (EXISTS ( SELECT 1
   FROM "public"."projects" "p"
  WHERE (("p"."id" = "expenses"."project_id") AND ("p"."user_id" = "auth"."uid"()))))))));



CREATE POLICY "expenses_update_org_scoped" ON "public"."expenses" FOR UPDATE TO "authenticated" USING (("core"."same_org"("organization_id") AND (("auth"."uid"() = "user_id") OR "public"."is_admin"()))) WITH CHECK (("core"."same_org"("organization_id") AND (("auth"."uid"() = "user_id") OR "public"."is_admin"())));



ALTER TABLE "public"."incomes" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "incomes_delete_org_scoped" ON "public"."incomes" FOR DELETE TO "authenticated" USING (("core"."same_org"("organization_id") AND (("auth"."uid"() = "user_id") OR "core"."is_finance_head"())));



CREATE POLICY "incomes_insert_org_scoped" ON "public"."incomes" FOR INSERT TO "authenticated" WITH CHECK (("core"."same_org"("organization_id") AND (("auth"."uid"() = "user_id") OR "core"."is_finance_head"())));



CREATE POLICY "incomes_select_org_scoped" ON "public"."incomes" FOR SELECT TO "authenticated" USING (("core"."same_org"("organization_id") AND ("core"."is_finance_head"() OR "core"."has_role"('ACCOUNTANT'::"text") OR "core"."has_role"('VIEWER'::"text") OR ("user_id" = "auth"."uid"()) OR (("project_id" IS NOT NULL) AND (EXISTS ( SELECT 1
   FROM "public"."projects" "pr"
  WHERE (("pr"."id" = "incomes"."project_id") AND ("pr"."user_id" = "auth"."uid"()))))))));



CREATE POLICY "incomes_update_org_scoped" ON "public"."incomes" FOR UPDATE TO "authenticated" USING (("core"."same_org"("organization_id") AND (("auth"."uid"() = "user_id") OR "core"."is_finance_head"()))) WITH CHECK (("core"."same_org"("organization_id") AND (("auth"."uid"() = "user_id") OR "core"."is_finance_head"())));



ALTER TABLE "public"."invoices" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "invoices_delete_org_scoped" ON "public"."invoices" FOR DELETE TO "authenticated" USING (("core"."same_org"("organization_id") AND (("core"."is_finance_head"() OR "core"."has_role"('ACCOUNTANT'::"text")) AND ("journal_entry_id" IS NULL))));



CREATE POLICY "invoices_insert_org_scoped" ON "public"."invoices" FOR INSERT TO "authenticated" WITH CHECK (("core"."same_org"("organization_id") AND ("core"."is_finance_head"() OR "core"."has_role"('ACCOUNTANT'::"text") OR ("user_id" = "auth"."uid"()))));



CREATE POLICY "invoices_select_org_scoped" ON "public"."invoices" FOR SELECT TO "authenticated" USING (("core"."same_org"("organization_id") AND ("core"."is_finance_head"() OR "core"."has_role"('ACCOUNTANT'::"text") OR "core"."has_role"('VIEWER'::"text") OR ("user_id" = "auth"."uid"()) OR (EXISTS ( SELECT 1
   FROM "public"."projects" "p"
  WHERE (("p"."id" = "invoices"."project_id") AND ("p"."user_id" = "auth"."uid"())))))));



CREATE POLICY "invoices_update_org_scoped" ON "public"."invoices" FOR UPDATE TO "authenticated" USING (("core"."same_org"("organization_id") AND (("core"."is_finance_head"() OR "core"."has_role"('ACCOUNTANT'::"text")) AND ("journal_entry_id" IS NULL)))) WITH CHECK (("core"."same_org"("organization_id") AND (("core"."is_finance_head"() OR "core"."has_role"('ACCOUNTANT'::"text")) AND ("journal_entry_id" IS NULL))));



ALTER TABLE "public"."notification_deliveries" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "notification_deliveries_insert_own" ON "public"."notification_deliveries" FOR INSERT TO "authenticated" WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."notifications" "n"
  WHERE (("n"."id" = "notification_deliveries"."notification_id") AND ("n"."user_id" = "auth"."uid"())))));



CREATE POLICY "notification_deliveries_select_own" ON "public"."notification_deliveries" FOR SELECT TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."notifications" "n"
  WHERE (("n"."id" = "notification_deliveries"."notification_id") AND ("n"."user_id" = "auth"."uid"())))));



CREATE POLICY "notification_deliveries_service_all" ON "public"."notification_deliveries" TO "service_role" USING (true) WITH CHECK (true);



ALTER TABLE "public"."notification_preferences" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "notification_prefs_delete_own" ON "public"."notification_preferences" FOR DELETE TO "authenticated" USING (("user_id" = "auth"."uid"()));



CREATE POLICY "notification_prefs_insert_own" ON "public"."notification_preferences" FOR INSERT TO "authenticated" WITH CHECK (("user_id" = "auth"."uid"()));



CREATE POLICY "notification_prefs_select_own" ON "public"."notification_preferences" FOR SELECT TO "authenticated" USING (("user_id" = "auth"."uid"()));



CREATE POLICY "notification_prefs_service_all" ON "public"."notification_preferences" TO "service_role" USING (true) WITH CHECK (true);



CREATE POLICY "notification_prefs_update_own" ON "public"."notification_preferences" FOR UPDATE TO "authenticated" USING (("user_id" = "auth"."uid"())) WITH CHECK (("user_id" = "auth"."uid"()));



ALTER TABLE "public"."notifications" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."payments" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "payments_modify_org_scoped" ON "public"."payments" TO "authenticated" USING ((("user_id" = "auth"."uid"()) OR ("core"."is_finance_head"() AND ("organization_id" IS NOT NULL) AND ("organization_id" = "core"."current_user_org_id"())))) WITH CHECK ((("user_id" = "auth"."uid"()) OR ("core"."is_finance_head"() AND ("organization_id" IS NOT NULL) AND ("organization_id" = "core"."current_user_org_id"()))));



CREATE POLICY "payments_select_org_scoped" ON "public"."payments" FOR SELECT TO "authenticated" USING ((("user_id" = "auth"."uid"()) OR (("core"."is_finance_head"() OR "core"."has_role"('ACCOUNTANT'::"text")) AND ("organization_id" IS NOT NULL) AND ("organization_id" = "core"."current_user_org_id"()))));



ALTER TABLE "public"."payroll_advances" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "payroll_advances_delete_org_scoped" ON "public"."payroll_advances" FOR DELETE TO "authenticated" USING (("core"."same_org"("organization_id") AND "core"."is_finance_head"()));



CREATE POLICY "payroll_advances_insert_org_scoped" ON "public"."payroll_advances" FOR INSERT TO "authenticated" WITH CHECK (("core"."same_org"("organization_id") AND ("core"."is_finance_head"() OR "core"."has_role"('ACCOUNTANT'::"text"))));



CREATE POLICY "payroll_advances_select_org_scoped" ON "public"."payroll_advances" FOR SELECT TO "authenticated" USING (("core"."same_org"("organization_id") AND ("core"."is_finance_head"() OR "core"."has_role"('ACCOUNTANT'::"text"))));



CREATE POLICY "payroll_advances_update_org_scoped" ON "public"."payroll_advances" FOR UPDATE TO "authenticated" USING (("core"."same_org"("organization_id") AND ("core"."is_finance_head"() OR "core"."has_role"('ACCOUNTANT'::"text")))) WITH CHECK (("core"."same_org"("organization_id") AND ("core"."is_finance_head"() OR "core"."has_role"('ACCOUNTANT'::"text"))));



ALTER TABLE "public"."payroll_commissions" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "payroll_commissions_delete_org_scoped" ON "public"."payroll_commissions" FOR DELETE TO "authenticated" USING (("core"."same_org"("organization_id") AND "core"."is_finance_head"()));



CREATE POLICY "payroll_commissions_insert_org_scoped" ON "public"."payroll_commissions" FOR INSERT TO "authenticated" WITH CHECK (("core"."same_org"("organization_id") AND ("core"."is_finance_head"() OR "core"."has_role"('ACCOUNTANT'::"text"))));



CREATE POLICY "payroll_commissions_select_org_scoped" ON "public"."payroll_commissions" FOR SELECT TO "authenticated" USING (("core"."same_org"("organization_id") AND ("core"."is_finance_head"() OR "core"."has_role"('ACCOUNTANT'::"text"))));



CREATE POLICY "payroll_commissions_update_org_scoped" ON "public"."payroll_commissions" FOR UPDATE TO "authenticated" USING (("core"."same_org"("organization_id") AND ("core"."is_finance_head"() OR "core"."has_role"('ACCOUNTANT'::"text")))) WITH CHECK (("core"."same_org"("organization_id") AND ("core"."is_finance_head"() OR "core"."has_role"('ACCOUNTANT'::"text"))));



ALTER TABLE "public"."payroll_compensation" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "payroll_compensation_delete_org_scoped" ON "public"."payroll_compensation" FOR DELETE TO "authenticated" USING (("core"."same_org"("organization_id") AND "core"."is_finance_head"()));



CREATE POLICY "payroll_compensation_insert_org_scoped" ON "public"."payroll_compensation" FOR INSERT TO "authenticated" WITH CHECK (("core"."same_org"("organization_id") AND ("core"."is_finance_head"() OR "core"."has_role"('ACCOUNTANT'::"text"))));



CREATE POLICY "payroll_compensation_select_org_scoped" ON "public"."payroll_compensation" FOR SELECT TO "authenticated" USING (("core"."same_org"("organization_id") AND ("core"."is_finance_head"() OR "core"."has_role"('ACCOUNTANT'::"text"))));



CREATE POLICY "payroll_compensation_update_org_scoped" ON "public"."payroll_compensation" FOR UPDATE TO "authenticated" USING (("core"."same_org"("organization_id") AND ("core"."is_finance_head"() OR "core"."has_role"('ACCOUNTANT'::"text")))) WITH CHECK (("core"."same_org"("organization_id") AND ("core"."is_finance_head"() OR "core"."has_role"('ACCOUNTANT'::"text"))));



ALTER TABLE "public"."payroll_deductions" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "payroll_deductions_delete_org_scoped" ON "public"."payroll_deductions" FOR DELETE TO "authenticated" USING (("core"."same_org"("organization_id") AND "core"."is_finance_head"()));



CREATE POLICY "payroll_deductions_insert_org_scoped" ON "public"."payroll_deductions" FOR INSERT TO "authenticated" WITH CHECK (("core"."same_org"("organization_id") AND ("core"."is_finance_head"() OR "core"."has_role"('ACCOUNTANT'::"text"))));



CREATE POLICY "payroll_deductions_select_org_scoped" ON "public"."payroll_deductions" FOR SELECT TO "authenticated" USING (("core"."same_org"("organization_id") AND ("core"."is_finance_head"() OR "core"."has_role"('ACCOUNTANT'::"text"))));



CREATE POLICY "payroll_deductions_update_org_scoped" ON "public"."payroll_deductions" FOR UPDATE TO "authenticated" USING (("core"."same_org"("organization_id") AND ("core"."is_finance_head"() OR "core"."has_role"('ACCOUNTANT'::"text")))) WITH CHECK (("core"."same_org"("organization_id") AND ("core"."is_finance_head"() OR "core"."has_role"('ACCOUNTANT'::"text"))));



ALTER TABLE "public"."payroll_employees" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "payroll_employees_delete_org_scoped" ON "public"."payroll_employees" FOR DELETE TO "authenticated" USING (("core"."same_org"("organization_id") AND "core"."is_finance_head"()));



CREATE POLICY "payroll_employees_insert_org_scoped" ON "public"."payroll_employees" FOR INSERT TO "authenticated" WITH CHECK (("core"."same_org"("organization_id") AND ("core"."is_finance_head"() OR "core"."has_role"('ACCOUNTANT'::"text"))));



CREATE POLICY "payroll_employees_select_org_scoped" ON "public"."payroll_employees" FOR SELECT TO "authenticated" USING (("core"."same_org"("organization_id") AND ("core"."is_finance_head"() OR "core"."has_role"('ACCOUNTANT'::"text") OR ("user_id" = "auth"."uid"()))));



CREATE POLICY "payroll_employees_update_org_scoped" ON "public"."payroll_employees" FOR UPDATE TO "authenticated" USING (("core"."same_org"("organization_id") AND ("core"."is_finance_head"() OR "core"."has_role"('ACCOUNTANT'::"text")))) WITH CHECK (("core"."same_org"("organization_id") AND ("core"."is_finance_head"() OR "core"."has_role"('ACCOUNTANT'::"text"))));



ALTER TABLE "public"."payroll_lines" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "payroll_lines_delete_org_scoped" ON "public"."payroll_lines" FOR DELETE TO "authenticated" USING (("core"."same_org"("organization_id") AND "core"."is_finance_head"()));



CREATE POLICY "payroll_lines_insert_org_scoped" ON "public"."payroll_lines" FOR INSERT TO "authenticated" WITH CHECK (("core"."same_org"("organization_id") AND ("core"."is_finance_head"() OR "core"."has_role"('ACCOUNTANT'::"text"))));



CREATE POLICY "payroll_lines_select_org_scoped" ON "public"."payroll_lines" FOR SELECT TO "authenticated" USING (("core"."same_org"("organization_id") AND ("core"."is_finance_head"() OR "core"."has_role"('ACCOUNTANT'::"text"))));



CREATE POLICY "payroll_lines_update_org_scoped" ON "public"."payroll_lines" FOR UPDATE TO "authenticated" USING (("core"."same_org"("organization_id") AND ("core"."is_finance_head"() OR "core"."has_role"('ACCOUNTANT'::"text")))) WITH CHECK (("core"."same_org"("organization_id") AND ("core"."is_finance_head"() OR "core"."has_role"('ACCOUNTANT'::"text"))));



ALTER TABLE "public"."payroll_reimbursements" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "payroll_reimbursements_delete_org_scoped" ON "public"."payroll_reimbursements" FOR DELETE TO "authenticated" USING (("core"."same_org"("organization_id") AND "core"."is_finance_head"()));



CREATE POLICY "payroll_reimbursements_insert_org_scoped" ON "public"."payroll_reimbursements" FOR INSERT TO "authenticated" WITH CHECK (("core"."same_org"("organization_id") AND ("core"."is_finance_head"() OR "core"."has_role"('ACCOUNTANT'::"text"))));



CREATE POLICY "payroll_reimbursements_select_org_scoped" ON "public"."payroll_reimbursements" FOR SELECT TO "authenticated" USING (("core"."same_org"("organization_id") AND ("core"."is_finance_head"() OR "core"."has_role"('ACCOUNTANT'::"text"))));



CREATE POLICY "payroll_reimbursements_update_org_scoped" ON "public"."payroll_reimbursements" FOR UPDATE TO "authenticated" USING (("core"."same_org"("organization_id") AND ("core"."is_finance_head"() OR "core"."has_role"('ACCOUNTANT'::"text")))) WITH CHECK (("core"."same_org"("organization_id") AND ("core"."is_finance_head"() OR "core"."has_role"('ACCOUNTANT'::"text"))));



ALTER TABLE "public"."payroll_runs" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "payroll_runs_delete_org_scoped" ON "public"."payroll_runs" FOR DELETE TO "authenticated" USING (("core"."same_org"("organization_id") AND "core"."is_finance_head"()));



CREATE POLICY "payroll_runs_insert_org_scoped" ON "public"."payroll_runs" FOR INSERT TO "authenticated" WITH CHECK (("core"."same_org"("organization_id") AND ("core"."is_finance_head"() OR "core"."has_role"('ACCOUNTANT'::"text"))));



CREATE POLICY "payroll_runs_select_org_scoped" ON "public"."payroll_runs" FOR SELECT TO "authenticated" USING (("core"."same_org"("organization_id") AND ("core"."is_finance_head"() OR "core"."has_role"('ACCOUNTANT'::"text"))));



CREATE POLICY "payroll_runs_update_org_scoped" ON "public"."payroll_runs" FOR UPDATE TO "authenticated" USING (("core"."same_org"("organization_id") AND ("core"."is_finance_head"() OR "core"."has_role"('ACCOUNTANT'::"text")))) WITH CHECK (("core"."same_org"("organization_id") AND ("core"."is_finance_head"() OR "core"."has_role"('ACCOUNTANT'::"text"))));



ALTER TABLE "public"."policy_documents" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "policy_documents_delete_org_scoped" ON "public"."policy_documents" FOR DELETE TO "authenticated" USING (("core"."same_org"("organization_id") AND "core"."is_finance_head"()));



CREATE POLICY "policy_documents_insert_org_scoped" ON "public"."policy_documents" FOR INSERT TO "authenticated" WITH CHECK (("core"."same_org"("organization_id") AND "core"."is_finance_head"()));



CREATE POLICY "policy_documents_select_org_scoped" ON "public"."policy_documents" FOR SELECT TO "authenticated" USING ("core"."same_org"("organization_id"));



CREATE POLICY "policy_documents_service_role" ON "public"."policy_documents" TO "service_role" USING (true) WITH CHECK (true);



CREATE POLICY "policy_documents_update_org_scoped" ON "public"."policy_documents" FOR UPDATE TO "authenticated" USING (("core"."same_org"("organization_id") AND "core"."is_finance_head"())) WITH CHECK (("core"."same_org"("organization_id") AND "core"."is_finance_head"()));



ALTER TABLE "public"."profiles" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "profiles_modify_org_scoped" ON "public"."profiles" TO "authenticated" USING ((("auth"."uid"() = "user_id") OR ("public"."is_admin"() AND ("organization_id" IS NOT NULL) AND ("organization_id" = "core"."current_user_org_id"())))) WITH CHECK ((("auth"."uid"() = "user_id") OR ("public"."is_admin"() AND ("organization_id" IS NOT NULL) AND ("organization_id" = "core"."current_user_org_id"()))));



CREATE POLICY "profiles_select_org_scoped" ON "public"."profiles" FOR SELECT TO "authenticated" USING ((("auth"."uid"() = "user_id") OR ("public"."is_admin"() AND ("organization_id" IS NOT NULL) AND ("organization_id" = "core"."current_user_org_id"()))));



ALTER TABLE "public"."projects" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "projects_delete_org_scoped" ON "public"."projects" FOR DELETE TO "authenticated" USING (("core"."same_org"("organization_id") AND ("core"."is_finance_head"() OR ("user_id" = "auth"."uid"()) OR "public"."is_admin"())));



CREATE POLICY "projects_insert_org_scoped" ON "public"."projects" FOR INSERT TO "authenticated" WITH CHECK (("core"."same_org"("organization_id") AND ("core"."is_finance_head"() OR "core"."has_role"('ACCOUNTANT'::"text") OR "core"."has_role"('PROJECT_MANAGER'::"text") OR ("user_id" = "auth"."uid"()))));



CREATE POLICY "projects_select_org_scoped" ON "public"."projects" FOR SELECT TO "authenticated" USING (("core"."same_org"("organization_id") AND ("core"."is_finance_head"() OR "core"."has_role"('ACCOUNTANT'::"text") OR "core"."has_role"('VIEWER'::"text") OR "core"."has_role"('PROJECT_MANAGER'::"text") OR ("user_id" = "auth"."uid"()))));



CREATE POLICY "projects_update_org_scoped" ON "public"."projects" FOR UPDATE TO "authenticated" USING (("core"."same_org"("organization_id") AND ("core"."is_finance_head"() OR ("user_id" = "auth"."uid"()) OR "public"."is_admin"()))) WITH CHECK (("core"."same_org"("organization_id") AND ("core"."is_finance_head"() OR ("user_id" = "auth"."uid"()) OR "public"."is_admin"())));



ALTER TABLE "public"."subscriptions" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "subscriptions_delete_org_scoped" ON "public"."subscriptions" FOR DELETE TO "authenticated" USING (("core"."same_org"("organization_id") AND "core"."is_finance_head"()));



CREATE POLICY "subscriptions_insert_org_scoped" ON "public"."subscriptions" FOR INSERT TO "authenticated" WITH CHECK (("core"."same_org"("organization_id") AND ("core"."is_finance_head"() OR "core"."has_role"('ACCOUNTANT'::"text"))));



CREATE POLICY "subscriptions_select_org_scoped" ON "public"."subscriptions" FOR SELECT TO "authenticated" USING (("core"."same_org"("organization_id") AND ("core"."is_finance_head"() OR "core"."has_role"('ACCOUNTANT'::"text") OR "core"."has_role"('VIEWER'::"text") OR "core"."has_role"('PROJECT_MANAGER'::"text"))));



CREATE POLICY "subscriptions_update_org_scoped" ON "public"."subscriptions" FOR UPDATE TO "authenticated" USING (("core"."same_org"("organization_id") AND ("core"."is_finance_head"() OR "core"."has_role"('ACCOUNTANT'::"text")))) WITH CHECK (("core"."same_org"("organization_id") AND ("core"."is_finance_head"() OR "core"."has_role"('ACCOUNTANT'::"text"))));



ALTER TABLE "public"."user_mfa" ENABLE ROW LEVEL SECURITY;




ALTER PUBLICATION "supabase_realtime" OWNER TO "postgres";






GRANT USAGE ON SCHEMA "audit" TO "authenticated";
GRANT USAGE ON SCHEMA "audit" TO "service_role";



GRANT USAGE ON SCHEMA "core" TO "authenticated";
GRANT ALL ON SCHEMA "core" TO "service_role";
GRANT USAGE ON SCHEMA "core" TO "anon";



GRANT USAGE ON SCHEMA "finance" TO "authenticated";
GRANT ALL ON SCHEMA "finance" TO "service_role";
GRANT USAGE ON SCHEMA "finance" TO "anon";



GRANT USAGE ON SCHEMA "legacy" TO "service_role";



GRANT USAGE ON SCHEMA "public" TO "postgres";
GRANT USAGE ON SCHEMA "public" TO "anon";
GRANT USAGE ON SCHEMA "public" TO "authenticated";
GRANT USAGE ON SCHEMA "public" TO "service_role";
GRANT USAGE ON SCHEMA "public" TO "ai_readonly_role";



GRANT ALL ON SCHEMA "reporting" TO "authenticated";
GRANT ALL ON SCHEMA "reporting" TO "service_role";
GRANT USAGE ON SCHEMA "reporting" TO "anon";
GRANT USAGE ON SCHEMA "reporting" TO "ai_readonly_role";




REVOKE ALL ON FUNCTION "ai"."increment_usage"("p_user_id" "uuid", "p_organization_id" "uuid", "p_tokens" integer, "p_cost" numeric) FROM PUBLIC;
GRANT ALL ON FUNCTION "ai"."increment_usage"("p_user_id" "uuid", "p_organization_id" "uuid", "p_tokens" integer, "p_cost" numeric) TO "authenticated";



GRANT ALL ON FUNCTION "audit"."ai_audit_report"("p_start" timestamp with time zone, "p_end" timestamp with time zone, "p_user_id" "uuid", "p_tool" "text", "p_status" "text", "p_page" integer, "p_page_size" integer) TO "authenticated";



GRANT ALL ON FUNCTION "audit"."audit_log_report"("p_start" timestamp with time zone, "p_end" timestamp with time zone, "p_user_id" "uuid", "p_action" "text", "p_entity_type" "text", "p_severity" "text", "p_approval_level" "text", "p_source_module" "text", "p_project_id" "uuid", "p_min_amount" numeric, "p_max_amount" numeric, "p_page" integer, "p_page_size" integer) TO "authenticated";



GRANT ALL ON FUNCTION "audit"."log_action"("p_user_id" "uuid", "p_user_email" "text", "p_user_name" "text", "p_action" "text", "p_entity_type" "text", "p_entity_id" "uuid", "p_description" "text", "p_old_values" "jsonb", "p_new_values" "jsonb", "p_ip_address" "inet", "p_user_agent" "text", "p_status" "text", "p_error_message" "text", "p_severity" "text", "p_reason" "text", "p_source_module" "text", "p_request_id" "text", "p_previous_status" "text", "p_new_status" "text", "p_approval_level" "text", "p_approval_comments" "text", "p_delegated_authority" "text", "p_limit_decision" "text", "p_session_id" "text", "p_auth_method" "text", "p_attachment_ids" "uuid"[], "p_import_batch_id" "uuid", "p_external_ref" "text", "p_related_journal_id" "uuid", "p_related_payment_id" "uuid", "p_project_id" "uuid", "p_amount" numeric, "p_amount_currency" "text") TO "authenticated";



GRANT ALL ON FUNCTION "audit"."log_ai_event"("p_user_id" "uuid", "p_user_email" "text", "p_user_name" "text", "p_action" "text", "p_status" "text", "p_severity" "text", "p_entity_type" "text", "p_entity_id" "uuid", "p_project_id" "uuid", "p_ai_question" "text", "p_ai_normalized_intent" "text", "p_ai_selected_tool" "text", "p_ai_generated_sql" "text", "p_ai_template_id" "text", "p_ai_row_count" integer, "p_ai_model" "text", "p_ai_latency_ms" integer, "p_ai_cost_usd" numeric, "p_ai_input_tokens" integer, "p_ai_output_tokens" integer, "p_ai_refusal_reason" "text", "p_request_id" "text", "p_ip_address" "inet", "p_user_agent" "text") TO "authenticated";



GRANT ALL ON FUNCTION "audit"."log_data_access_event"("p_user_id" "uuid", "p_user_email" "text", "p_accessed_entity_type" "text", "p_accessed_entity_id" "uuid", "p_access_type" "text", "p_access_granted" boolean, "p_request_id" "text") TO "authenticated";



GRANT ALL ON FUNCTION "audit"."log_export_event"("p_user_id" "uuid", "p_user_email" "text", "p_user_name" "text", "p_report_name" "text", "p_report_type" "text", "p_format" "text", "p_filters" "jsonb", "p_row_count" integer, "p_file_size_bytes" integer) TO "authenticated";



GRANT ALL ON FUNCTION "audit"."log_security_event"("p_user_id" "uuid", "p_user_email" "text", "p_event_type" "text", "p_success" boolean, "p_details" "jsonb", "p_request_id" "text") TO "authenticated";



REVOKE ALL ON FUNCTION "core"."current_user_org_config_id"() FROM PUBLIC;
GRANT ALL ON FUNCTION "core"."current_user_org_config_id"() TO "authenticated";
GRANT ALL ON FUNCTION "core"."current_user_org_config_id"() TO "service_role";



REVOKE ALL ON FUNCTION "core"."current_user_org_id"() FROM PUBLIC;
GRANT ALL ON FUNCTION "core"."current_user_org_id"() TO "authenticated";
GRANT ALL ON FUNCTION "core"."current_user_org_id"() TO "service_role";



REVOKE ALL ON FUNCTION "core"."same_org"("p_organization_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "core"."same_org"("p_organization_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "core"."same_org"("p_organization_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "core"."soft_delete"("p_schema" "text", "p_table" "text", "p_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "core"."soft_delete"("p_schema" "text", "p_table" "text", "p_id" "uuid") TO "authenticated";



REVOKE ALL ON FUNCTION "finance"."allocate_payment_atomic"("p_payment_receipt_id" "uuid", "p_allocations" "jsonb", "p_user_id" "uuid", "p_organization_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "finance"."allocate_payment_atomic"("p_payment_receipt_id" "uuid", "p_allocations" "jsonb", "p_user_id" "uuid", "p_organization_id" "uuid") TO "authenticated";



GRANT ALL ON FUNCTION "finance"."approve_and_post_journal_entry"("p_journal_id" "uuid") TO "authenticated";



GRANT ALL ON FUNCTION "finance"."exclude_statement_line"("p_line_id" "uuid", "p_reason" "text") TO "authenticated";



GRANT ALL ON FUNCTION "finance"."get_current_open_period_id"() TO "authenticated";



GRANT ALL ON FUNCTION "finance"."get_current_period"() TO "authenticated";



GRANT ALL ON FUNCTION "finance"."get_period_by_date"("p_date" "date") TO "authenticated";



GRANT ALL ON FUNCTION "finance"."get_pnl_accounts"("p_fiscal_year_id" "uuid", "p_organization_id" "uuid", "p_account_type" "text") TO "authenticated";



GRANT ALL ON FUNCTION "finance"."is_date_in_open_period"("p_date" "date") TO "authenticated";



GRANT ALL ON FUNCTION "finance"."manual_match_statement_line"("p_line_id" "uuid", "p_journal_line_id" "uuid", "p_reason" "text") TO "authenticated";



REVOKE ALL ON FUNCTION "finance"."mark_overdue_invoices"() FROM PUBLIC;
GRANT ALL ON FUNCTION "finance"."mark_overdue_invoices"() TO "authenticated";



REVOKE ALL ON FUNCTION "finance"."mark_paid_invoices"() FROM PUBLIC;
GRANT ALL ON FUNCTION "finance"."mark_paid_invoices"() TO "authenticated";



GRANT ALL ON FUNCTION "finance"."post_existing_journal_entry"("p_journal_id" "uuid", "p_posted_by" "uuid") TO "authenticated";



REVOKE ALL ON FUNCTION "finance"."post_payment_receipt_atomic"("p_client_id" "uuid", "p_amount" numeric, "p_currency" "text", "p_exchange_rate" numeric, "p_payment_date" "date", "p_payment_method" "text", "p_reference" "text", "p_financial_account_id" "uuid", "p_notes" "text", "p_allocations" "jsonb") FROM PUBLIC;
GRANT ALL ON FUNCTION "finance"."post_payment_receipt_atomic"("p_client_id" "uuid", "p_amount" numeric, "p_currency" "text", "p_exchange_rate" numeric, "p_payment_date" "date", "p_payment_method" "text", "p_reference" "text", "p_financial_account_id" "uuid", "p_notes" "text", "p_allocations" "jsonb") TO "authenticated";



REVOKE ALL ON FUNCTION "finance"."prevent_posted_capital_transaction_edit"() FROM PUBLIC;



GRANT ALL ON FUNCTION "finance"."reverse_journal_entry"("p_journal_id" "uuid", "p_reversal_date" "date", "p_reason" "text") TO "authenticated";



GRANT ALL ON FUNCTION "finance"."reverse_payment_receipt_atomic"("p_receipt_id" "uuid", "p_period_id" "uuid", "p_reversal_date" "date", "p_reason" "text", "p_reversed_by" "uuid") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."balance_sheet"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."balance_sheet"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."balance_sheet"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."cash_flow"("p_start" "date", "p_end" "date") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."cash_flow"("p_start" "date", "p_end" "date") TO "authenticated";
GRANT ALL ON FUNCTION "public"."cash_flow"("p_start" "date", "p_end" "date") TO "service_role";



GRANT ALL ON FUNCTION "public"."create_user_by_admin"("p_email" "text", "p_password" "text", "p_role" "text", "p_full_name" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."create_user_by_admin"("p_email" "text", "p_password" "text", "p_role" "text", "p_full_name" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."ensure_profile_exists"("target_user_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."ensure_profile_exists"("target_user_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."execute_ai_readonly_query"("query_string" "text", "p_org_id" "uuid", "p_user_id" "uuid", "p_enforce_user_scope" boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."execute_ai_readonly_query"("query_string" "text", "p_org_id" "uuid", "p_user_id" "uuid", "p_enforce_user_scope" boolean) TO "authenticated";
GRANT ALL ON FUNCTION "public"."execute_ai_readonly_query"("query_string" "text", "p_org_id" "uuid", "p_user_id" "uuid", "p_enforce_user_scope" boolean) TO "service_role";



REVOKE ALL ON FUNCTION "public"."execute_sql_query"("query_string" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."execute_sql_query"("query_string" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."find_auth_user_by_email"("search_email" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."find_auth_user_by_email"("search_email" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."get_all_system_users"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_all_system_users"() TO "service_role";



GRANT ALL ON FUNCTION "public"."get_my_permissions"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_my_permissions"() TO "service_role";



GRANT ALL ON FUNCTION "public"."get_my_user_roles"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_my_user_roles"() TO "service_role";



GRANT ALL ON FUNCTION "public"."get_user_permissions"("p_user_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_user_permissions"("p_user_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."get_user_roles_by_id"("p_target_user_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_user_roles_by_id"("p_target_user_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."handle_new_user"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."handle_new_user"() TO "service_role";



GRANT ALL ON FUNCTION "public"."is_admin"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."is_admin"() TO "service_role";



GRANT ALL ON FUNCTION "public"."payroll_generate_employee_code"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."payroll_generate_employee_code"() TO "service_role";



GRANT ALL ON FUNCTION "public"."payroll_update_timestamp"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."payroll_update_timestamp"() TO "service_role";



GRANT ALL ON FUNCTION "public"."prevent_posted_invoice_deletion"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."prevent_posted_invoice_deletion"() TO "service_role";



GRANT ALL ON FUNCTION "public"."prevent_posted_invoice_edit"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."prevent_posted_invoice_edit"() TO "service_role";



GRANT ALL ON FUNCTION "public"."prevent_posted_payroll_run_edit"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."prevent_posted_payroll_run_edit"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."profit_and_loss"("p_start" "date", "p_end" "date") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."profit_and_loss"("p_start" "date", "p_end" "date") TO "authenticated";
GRANT ALL ON FUNCTION "public"."profit_and_loss"("p_start" "date", "p_end" "date") TO "service_role";



GRANT ALL ON FUNCTION "public"."rls_auto_enable"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."rls_auto_enable"() TO "service_role";



GRANT ALL ON FUNCTION "public"."sync_invoice_client_name"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."sync_invoice_client_name"() TO "service_role";



GRANT ALL ON FUNCTION "public"."update_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."update_updated_at"() TO "service_role";



GRANT ALL ON FUNCTION "public"."user_has_role"("p_role_name" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."user_has_role"("p_role_name" "text") TO "service_role";



REVOKE ALL ON FUNCTION "reporting"."cash_distribution"() FROM PUBLIC;
GRANT ALL ON FUNCTION "reporting"."cash_distribution"() TO "authenticated";



REVOKE ALL ON FUNCTION "reporting"."ceo_chart_aging"() FROM PUBLIC;
GRANT ALL ON FUNCTION "reporting"."ceo_chart_aging"() TO "authenticated";



REVOKE ALL ON FUNCTION "reporting"."ceo_chart_budget"() FROM PUBLIC;
GRANT ALL ON FUNCTION "reporting"."ceo_chart_budget"() TO "authenticated";



REVOKE ALL ON FUNCTION "reporting"."ceo_chart_cash"() FROM PUBLIC;
GRANT ALL ON FUNCTION "reporting"."ceo_chart_cash"() TO "authenticated";



REVOKE ALL ON FUNCTION "reporting"."ceo_chart_categories"() FROM PUBLIC;
GRANT ALL ON FUNCTION "reporting"."ceo_chart_categories"() TO "authenticated";



REVOKE ALL ON FUNCTION "reporting"."ceo_chart_monthly"() FROM PUBLIC;
GRANT ALL ON FUNCTION "reporting"."ceo_chart_monthly"() TO "authenticated";



REVOKE ALL ON FUNCTION "reporting"."ceo_dashboard_kpis"() FROM PUBLIC;
GRANT ALL ON FUNCTION "reporting"."ceo_dashboard_kpis"() TO "authenticated";



REVOKE ALL ON FUNCTION "reporting"."ceo_table_audit"() FROM PUBLIC;
GRANT ALL ON FUNCTION "reporting"."ceo_table_audit"() TO "authenticated";



REVOKE ALL ON FUNCTION "reporting"."ceo_table_equity_tax"() FROM PUBLIC;
GRANT ALL ON FUNCTION "reporting"."ceo_table_equity_tax"() TO "authenticated";



REVOKE ALL ON FUNCTION "reporting"."ceo_table_fiscal"() FROM PUBLIC;
GRANT ALL ON FUNCTION "reporting"."ceo_table_fiscal"() TO "authenticated";



REVOKE ALL ON FUNCTION "reporting"."get_ceo_metrics"() FROM PUBLIC;
GRANT ALL ON FUNCTION "reporting"."get_ceo_metrics"() TO "authenticated";



REVOKE ALL ON FUNCTION "reporting"."get_project_profitability"("p_start_date" "date", "p_end_date" "date") FROM PUBLIC;
GRANT ALL ON FUNCTION "reporting"."get_project_profitability"("p_start_date" "date", "p_end_date" "date") TO "authenticated";



REVOKE ALL ON FUNCTION "reporting"."pending_approvals_list"() FROM PUBLIC;
GRANT ALL ON FUNCTION "reporting"."pending_approvals_list"() TO "authenticated";



REVOKE ALL ON FUNCTION "reporting"."project_profitability"() FROM PUBLIC;
GRANT ALL ON FUNCTION "reporting"."project_profitability"() TO "authenticated";



REVOKE ALL ON FUNCTION "reporting"."receivable_aging_summary"() FROM PUBLIC;
GRANT ALL ON FUNCTION "reporting"."receivable_aging_summary"() TO "authenticated";



REVOKE ALL ON FUNCTION "reporting"."revenue_expense_monthly"() FROM PUBLIC;
GRANT ALL ON FUNCTION "reporting"."revenue_expense_monthly"() TO "authenticated";



REVOKE ALL ON FUNCTION "reporting"."transaction_detail"("p_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "reporting"."transaction_detail"("p_id" "uuid") TO "authenticated";



REVOKE ALL ON FUNCTION "reporting"."transaction_list"("p_search" "text", "p_type" "text", "p_status" "text", "p_project_id" "uuid", "p_date_from" "date", "p_date_to" "date", "p_limit" integer, "p_offset" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "reporting"."transaction_list"("p_search" "text", "p_type" "text", "p_status" "text", "p_project_id" "uuid", "p_date_from" "date", "p_date_to" "date", "p_limit" integer, "p_offset" integer) TO "authenticated";



REVOKE ALL ON FUNCTION "reporting"."transaction_summary"() FROM PUBLIC;
GRANT ALL ON FUNCTION "reporting"."transaction_summary"() TO "authenticated";



REVOKE ALL ON FUNCTION "reporting"."unreconciled_summary"() FROM PUBLIC;
GRANT ALL ON FUNCTION "reporting"."unreconciled_summary"() TO "authenticated";












GRANT SELECT,INSERT ON TABLE "audit"."audit_log" TO "authenticated";
GRANT ALL ON TABLE "audit"."audit_log" TO "service_role";



GRANT SELECT,INSERT ON TABLE "audit"."data_access_events" TO "authenticated";
GRANT ALL ON TABLE "audit"."data_access_events" TO "service_role";



GRANT SELECT,INSERT ON TABLE "audit"."export_events" TO "authenticated";
GRANT ALL ON TABLE "audit"."export_events" TO "service_role";



GRANT SELECT,INSERT ON TABLE "audit"."security_events" TO "authenticated";
GRANT ALL ON TABLE "audit"."security_events" TO "service_role";



GRANT SELECT ON TABLE "audit"."v_unsafe_security_definer_functions" TO "service_role";



GRANT ALL ON TABLE "core"."approval_actions" TO "authenticated";
GRANT ALL ON TABLE "core"."approval_actions" TO "service_role";



GRANT ALL ON TABLE "core"."approval_limits" TO "authenticated";
GRANT ALL ON TABLE "core"."approval_limits" TO "service_role";



GRANT ALL ON TABLE "core"."approval_requests" TO "authenticated";
GRANT ALL ON TABLE "core"."approval_requests" TO "service_role";



GRANT ALL ON TABLE "core"."approval_steps" TO "authenticated";
GRANT ALL ON TABLE "core"."approval_steps" TO "service_role";



GRANT ALL ON TABLE "core"."budget_policies" TO "authenticated";
GRANT ALL ON TABLE "core"."budget_policies" TO "service_role";



GRANT ALL ON TABLE "core"."delegations" TO "authenticated";
GRANT ALL ON TABLE "core"."delegations" TO "service_role";



GRANT ALL ON TABLE "core"."employee_links" TO "authenticated";
GRANT ALL ON TABLE "core"."employee_links" TO "service_role";



GRANT ALL ON TABLE "core"."idempotency_keys" TO "authenticated";
GRANT ALL ON TABLE "core"."idempotency_keys" TO "service_role";



GRANT ALL ON TABLE "core"."integration_events" TO "authenticated";
GRANT ALL ON TABLE "core"."integration_events" TO "service_role";



GRANT ALL ON TABLE "core"."integration_failures" TO "authenticated";
GRANT ALL ON TABLE "core"."integration_failures" TO "service_role";



GRANT ALL ON TABLE "core"."organization_config" TO "authenticated";
GRANT ALL ON TABLE "core"."organization_config" TO "service_role";



GRANT ALL ON TABLE "core"."organization_modules" TO "authenticated";
GRANT ALL ON TABLE "core"."organization_modules" TO "service_role";



GRANT ALL ON TABLE "core"."organizations" TO "authenticated";
GRANT ALL ON TABLE "core"."organizations" TO "service_role";



GRANT ALL ON TABLE "core"."permissions" TO "authenticated";
GRANT ALL ON TABLE "core"."permissions" TO "service_role";



GRANT ALL ON TABLE "core"."role_permissions" TO "authenticated";
GRANT ALL ON TABLE "core"."role_permissions" TO "service_role";



GRANT ALL ON TABLE "core"."roles" TO "authenticated";
GRANT ALL ON TABLE "core"."roles" TO "service_role";



GRANT ALL ON TABLE "core"."shared_people" TO "authenticated";
GRANT ALL ON TABLE "core"."shared_people" TO "service_role";



GRANT ALL ON TABLE "core"."user_permission_overrides" TO "authenticated";
GRANT ALL ON TABLE "core"."user_permission_overrides" TO "service_role";



GRANT ALL ON TABLE "core"."user_roles" TO "authenticated";
GRANT ALL ON TABLE "core"."user_roles" TO "service_role";









GRANT ALL ON TABLE "finance"."chart_of_accounts" TO "authenticated";
GRANT ALL ON TABLE "finance"."chart_of_accounts" TO "service_role";



GRANT ALL ON TABLE "finance"."account_type_summary" TO "authenticated";
GRANT ALL ON TABLE "finance"."account_type_summary" TO "service_role";



GRANT ALL ON TABLE "finance"."accounting_periods" TO "authenticated";
GRANT ALL ON TABLE "finance"."accounting_periods" TO "service_role";



GRANT ALL ON TABLE "finance"."asset_categories" TO "authenticated";
GRANT ALL ON TABLE "finance"."asset_categories" TO "service_role";



GRANT ALL ON TABLE "finance"."asset_verification_lines" TO "authenticated";
GRANT ALL ON TABLE "finance"."asset_verification_lines" TO "service_role";



GRANT ALL ON TABLE "finance"."asset_verifications" TO "authenticated";
GRANT ALL ON TABLE "finance"."asset_verifications" TO "service_role";



GRANT ALL ON TABLE "finance"."attachments" TO "authenticated";
GRANT ALL ON TABLE "finance"."attachments" TO "service_role";



GRANT ALL ON TABLE "finance"."attendance_period_snapshots" TO "authenticated";
GRANT ALL ON TABLE "finance"."attendance_period_snapshots" TO "service_role";



GRANT ALL ON TABLE "finance"."bank_statements" TO "authenticated";
GRANT ALL ON TABLE "finance"."bank_statements" TO "service_role";



GRANT ALL ON TABLE "finance"."bank_transfers" TO "authenticated";
GRANT ALL ON TABLE "finance"."bank_transfers" TO "service_role";



GRANT ALL ON TABLE "finance"."budget_commitments" TO "authenticated";
GRANT ALL ON TABLE "finance"."budget_commitments" TO "service_role";



GRANT ALL ON TABLE "finance"."budget_lines" TO "authenticated";
GRANT ALL ON TABLE "finance"."budget_lines" TO "service_role";



GRANT ALL ON TABLE "finance"."budget_revisions" TO "authenticated";
GRANT ALL ON TABLE "finance"."budget_revisions" TO "service_role";



GRANT ALL ON TABLE "finance"."capital_transactions" TO "authenticated";
GRANT ALL ON TABLE "finance"."capital_transactions" TO "service_role";



GRANT ALL ON TABLE "finance"."coa_tree" TO "authenticated";
GRANT ALL ON TABLE "finance"."coa_tree" TO "service_role";



GRANT ALL ON TABLE "finance"."credit_notes" TO "authenticated";
GRANT ALL ON TABLE "finance"."credit_notes" TO "service_role";



GRANT ALL ON TABLE "finance"."currency_settings" TO "authenticated";
GRANT ALL ON TABLE "finance"."currency_settings" TO "service_role";



GRANT ALL ON TABLE "finance"."depreciation_schedule" TO "authenticated";
GRANT ALL ON TABLE "finance"."depreciation_schedule" TO "service_role";



GRANT ALL ON TABLE "finance"."dimensions" TO "authenticated";
GRANT ALL ON TABLE "finance"."dimensions" TO "service_role";



GRANT ALL ON TABLE "finance"."distribution_lines" TO "authenticated";
GRANT ALL ON TABLE "finance"."distribution_lines" TO "service_role";



GRANT ALL ON TABLE "finance"."exchange_rates" TO "authenticated";
GRANT ALL ON TABLE "finance"."exchange_rates" TO "service_role";



GRANT ALL ON TABLE "finance"."expense_lines" TO "authenticated";
GRANT ALL ON TABLE "finance"."expense_lines" TO "service_role";



GRANT ALL ON TABLE "finance"."fee_computation_log" TO "authenticated";
GRANT ALL ON TABLE "finance"."fee_computation_log" TO "service_role";



GRANT ALL ON TABLE "finance"."fee_rules" TO "authenticated";
GRANT ALL ON TABLE "finance"."fee_rules" TO "service_role";



GRANT ALL ON TABLE "finance"."fee_tiers" TO "authenticated";
GRANT ALL ON TABLE "finance"."fee_tiers" TO "service_role";



GRANT ALL ON TABLE "finance"."financial_accounts" TO "authenticated";
GRANT ALL ON TABLE "finance"."financial_accounts" TO "service_role";



GRANT ALL ON TABLE "finance"."fiscal_years" TO "authenticated";
GRANT ALL ON TABLE "finance"."fiscal_years" TO "service_role";



GRANT ALL ON TABLE "finance"."fiscal_year_summary" TO "authenticated";
GRANT ALL ON TABLE "finance"."fiscal_year_summary" TO "service_role";



GRANT ALL ON TABLE "finance"."fixed_assets" TO "authenticated";
GRANT ALL ON TABLE "finance"."fixed_assets" TO "service_role";



GRANT ALL ON TABLE "finance"."invoice_lines" TO "authenticated";
GRANT ALL ON TABLE "finance"."invoice_lines" TO "service_role";



GRANT ALL ON TABLE "finance"."journal_entries" TO "authenticated";
GRANT ALL ON TABLE "finance"."journal_entries" TO "service_role";



GRANT ALL ON TABLE "finance"."journal_lines" TO "authenticated";
GRANT ALL ON TABLE "finance"."journal_lines" TO "service_role";



GRANT ALL ON TABLE "finance"."numbering_sequences" TO "authenticated";
GRANT ALL ON TABLE "finance"."numbering_sequences" TO "service_role";



GRANT ALL ON TABLE "finance"."opening_balance_imports" TO "authenticated";
GRANT ALL ON TABLE "finance"."opening_balance_imports" TO "service_role";



GRANT ALL ON TABLE "finance"."owners" TO "authenticated";
GRANT ALL ON TABLE "finance"."owners" TO "service_role";



GRANT ALL ON TABLE "finance"."ownership_history" TO "authenticated";
GRANT ALL ON TABLE "finance"."ownership_history" TO "service_role";



GRANT ALL ON TABLE "finance"."payment_allocations" TO "authenticated";
GRANT ALL ON TABLE "finance"."payment_allocations" TO "service_role";



GRANT ALL ON TABLE "finance"."payment_receipts" TO "authenticated";
GRANT ALL ON TABLE "finance"."payment_receipts" TO "service_role";



GRANT ALL ON TABLE "finance"."platforms" TO "authenticated";
GRANT ALL ON TABLE "finance"."platforms" TO "service_role";



GRANT ALL ON TABLE "finance"."postable_accounts" TO "authenticated";
GRANT ALL ON TABLE "finance"."postable_accounts" TO "service_role";



GRANT ALL ON TABLE "finance"."profit_distributions" TO "authenticated";
GRANT ALL ON TABLE "finance"."profit_distributions" TO "service_role";



GRANT ALL ON TABLE "finance"."reserve_policies" TO "authenticated";
GRANT ALL ON TABLE "finance"."reserve_policies" TO "service_role";



GRANT ALL ON TABLE "finance"."sequence_status" TO "authenticated";
GRANT ALL ON TABLE "finance"."sequence_status" TO "service_role";



GRANT ALL ON TABLE "finance"."settlement_batches" TO "authenticated";
GRANT ALL ON TABLE "finance"."settlement_batches" TO "service_role";



GRANT ALL ON TABLE "finance"."settlement_lines" TO "authenticated";
GRANT ALL ON TABLE "finance"."settlement_lines" TO "service_role";



GRANT ALL ON TABLE "finance"."statement_lines" TO "authenticated";
GRANT ALL ON TABLE "finance"."statement_lines" TO "service_role";



GRANT ALL ON TABLE "finance"."tax_adjustments" TO "authenticated";
GRANT ALL ON TABLE "finance"."tax_adjustments" TO "service_role";



GRANT ALL ON TABLE "finance"."tax_codes" TO "authenticated";
GRANT ALL ON TABLE "finance"."tax_codes" TO "service_role";



GRANT ALL ON TABLE "finance"."tax_computations" TO "authenticated";
GRANT ALL ON TABLE "finance"."tax_computations" TO "service_role";



GRANT ALL ON TABLE "finance"."tax_credits_and_withholding" TO "authenticated";
GRANT ALL ON TABLE "finance"."tax_credits_and_withholding" TO "service_role";



GRANT ALL ON TABLE "finance"."tax_payments_and_refunds" TO "authenticated";
GRANT ALL ON TABLE "finance"."tax_payments_and_refunds" TO "service_role";



GRANT ALL ON TABLE "finance"."tax_reconciliations" TO "authenticated";
GRANT ALL ON TABLE "finance"."tax_reconciliations" TO "service_role";



GRANT ALL ON TABLE "finance"."tax_returns" TO "authenticated";
GRANT ALL ON TABLE "finance"."tax_returns" TO "service_role";



GRANT ALL ON TABLE "finance"."tax_rule_sets" TO "authenticated";
GRANT ALL ON TABLE "finance"."tax_rule_sets" TO "service_role";



GRANT ALL ON TABLE "finance"."tax_slabs" TO "authenticated";
GRANT ALL ON TABLE "finance"."tax_slabs" TO "service_role";



GRANT ALL ON TABLE "finance"."taxpayer_profile" TO "authenticated";
GRANT ALL ON TABLE "finance"."taxpayer_profile" TO "service_role";



GRANT ALL ON TABLE "finance"."vendor_bill_lines" TO "authenticated";
GRANT ALL ON TABLE "finance"."vendor_bill_lines" TO "service_role";



GRANT ALL ON TABLE "finance"."vendor_bills" TO "authenticated";
GRANT ALL ON TABLE "finance"."vendor_bills" TO "service_role";



GRANT ALL ON TABLE "finance"."vendor_payment_allocations" TO "authenticated";
GRANT ALL ON TABLE "finance"."vendor_payment_allocations" TO "service_role";



GRANT ALL ON TABLE "finance"."vendor_payments" TO "authenticated";
GRANT ALL ON TABLE "finance"."vendor_payments" TO "service_role";



GRANT ALL ON TABLE "finance"."vendors" TO "authenticated";
GRANT ALL ON TABLE "finance"."vendors" TO "service_role";



GRANT ALL ON TABLE "legacy"."budget_lines" TO "service_role";



GRANT ALL ON TABLE "legacy"."financial_accounts" TO "service_role";



GRANT ALL ON TABLE "legacy"."numbering_sequences" TO "service_role";



GRANT ALL ON TABLE "legacy"."tax_returns" TO "service_role";



GRANT ALL ON TABLE "public"."budgets" TO "authenticated";
GRANT ALL ON TABLE "public"."budgets" TO "service_role";



GRANT ALL ON TABLE "public"."chart_of_accounts" TO "authenticated";
GRANT ALL ON TABLE "public"."chart_of_accounts" TO "service_role";



GRANT ALL ON TABLE "public"."clients" TO "authenticated";
GRANT ALL ON TABLE "public"."clients" TO "service_role";



GRANT ALL ON TABLE "public"."coa_tree" TO "authenticated";
GRANT ALL ON TABLE "public"."coa_tree" TO "service_role";



GRANT ALL ON TABLE "public"."commissions" TO "authenticated";
GRANT ALL ON TABLE "public"."commissions" TO "service_role";



GRANT ALL ON TABLE "public"."contractors" TO "authenticated";
GRANT ALL ON TABLE "public"."contractors" TO "service_role";



GRANT ALL ON TABLE "public"."credit_notes" TO "authenticated";
GRANT ALL ON TABLE "public"."credit_notes" TO "service_role";



GRANT ALL ON TABLE "public"."exchange_rates" TO "authenticated";
GRANT ALL ON TABLE "public"."exchange_rates" TO "service_role";



GRANT ALL ON TABLE "public"."expenses" TO "authenticated";
GRANT ALL ON TABLE "public"."expenses" TO "service_role";



GRANT ALL ON TABLE "reporting"."general_ledger" TO "service_role";
GRANT SELECT ON TABLE "reporting"."general_ledger" TO "ai_readonly_role";
GRANT SELECT ON TABLE "reporting"."general_ledger" TO "authenticated";



GRANT ALL ON TABLE "public"."general_ledger" TO "authenticated";
GRANT ALL ON TABLE "public"."general_ledger" TO "service_role";



GRANT ALL ON TABLE "public"."incomes" TO "authenticated";
GRANT ALL ON TABLE "public"."incomes" TO "service_role";



GRANT ALL ON TABLE "public"."invoices" TO "authenticated";
GRANT ALL ON TABLE "public"."invoices" TO "service_role";



GRANT ALL ON TABLE "public"."journal_entries" TO "authenticated";
GRANT ALL ON TABLE "public"."journal_entries" TO "service_role";



GRANT ALL ON TABLE "public"."journal_lines" TO "authenticated";
GRANT ALL ON TABLE "public"."journal_lines" TO "service_role";



GRANT ALL ON TABLE "public"."notification_deliveries" TO "authenticated";
GRANT ALL ON TABLE "public"."notification_deliveries" TO "service_role";



GRANT ALL ON TABLE "public"."notification_preferences" TO "authenticated";
GRANT ALL ON TABLE "public"."notification_preferences" TO "service_role";



GRANT ALL ON TABLE "public"."notifications" TO "authenticated";
GRANT ALL ON TABLE "public"."notifications" TO "service_role";



GRANT ALL ON TABLE "public"."organization_config" TO "authenticated";
GRANT ALL ON TABLE "public"."organization_config" TO "service_role";



GRANT ALL ON TABLE "public"."payment_allocations" TO "authenticated";
GRANT ALL ON TABLE "public"."payment_allocations" TO "service_role";



GRANT ALL ON TABLE "public"."payment_receipts" TO "authenticated";
GRANT ALL ON TABLE "public"."payment_receipts" TO "service_role";



GRANT ALL ON TABLE "public"."payments" TO "authenticated";
GRANT ALL ON TABLE "public"."payments" TO "service_role";



GRANT ALL ON TABLE "public"."payroll_advances" TO "authenticated";
GRANT ALL ON TABLE "public"."payroll_advances" TO "service_role";



GRANT ALL ON TABLE "public"."payroll_commissions" TO "authenticated";
GRANT ALL ON TABLE "public"."payroll_commissions" TO "service_role";



GRANT ALL ON TABLE "public"."payroll_compensation" TO "authenticated";
GRANT ALL ON TABLE "public"."payroll_compensation" TO "service_role";



GRANT ALL ON TABLE "public"."payroll_deductions" TO "authenticated";
GRANT ALL ON TABLE "public"."payroll_deductions" TO "service_role";



GRANT ALL ON SEQUENCE "public"."payroll_employee_code_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."payroll_employee_code_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."payroll_employee_code_seq" TO "service_role";



GRANT ALL ON TABLE "public"."payroll_employees" TO "authenticated";
GRANT ALL ON TABLE "public"."payroll_employees" TO "service_role";



GRANT ALL ON TABLE "public"."payroll_lines" TO "authenticated";
GRANT ALL ON TABLE "public"."payroll_lines" TO "service_role";



GRANT ALL ON TABLE "public"."payroll_reimbursements" TO "authenticated";
GRANT ALL ON TABLE "public"."payroll_reimbursements" TO "service_role";



GRANT ALL ON TABLE "public"."payroll_runs" TO "authenticated";
GRANT ALL ON TABLE "public"."payroll_runs" TO "service_role";



GRANT ALL ON TABLE "public"."permissions" TO "authenticated";
GRANT ALL ON TABLE "public"."permissions" TO "service_role";



GRANT ALL ON TABLE "public"."policy_documents" TO "authenticated";
GRANT ALL ON TABLE "public"."policy_documents" TO "service_role";
GRANT SELECT ON TABLE "public"."policy_documents" TO "ai_readonly_role";



GRANT ALL ON TABLE "public"."postable_accounts" TO "authenticated";
GRANT ALL ON TABLE "public"."postable_accounts" TO "service_role";



GRANT ALL ON TABLE "public"."profiles" TO "authenticated";
GRANT ALL ON TABLE "public"."profiles" TO "service_role";



GRANT ALL ON TABLE "public"."projects" TO "authenticated";
GRANT ALL ON TABLE "public"."projects" TO "service_role";



GRANT ALL ON TABLE "public"."role_permissions" TO "authenticated";
GRANT ALL ON TABLE "public"."role_permissions" TO "service_role";



GRANT ALL ON TABLE "public"."roles" TO "authenticated";
GRANT ALL ON TABLE "public"."roles" TO "service_role";



GRANT ALL ON TABLE "public"."subscriptions" TO "authenticated";
GRANT ALL ON TABLE "public"."subscriptions" TO "service_role";



GRANT ALL ON TABLE "public"."user_mfa" TO "authenticated";
GRANT ALL ON TABLE "public"."user_mfa" TO "service_role";



GRANT ALL ON TABLE "public"."user_roles" TO "authenticated";
GRANT ALL ON TABLE "public"."user_roles" TO "service_role";



GRANT ALL ON TABLE "public"."v_audit_log" TO "authenticated";
GRANT ALL ON TABLE "public"."v_audit_log" TO "service_role";



GRANT ALL ON TABLE "public"."v_commission_by_person" TO "authenticated";
GRANT ALL ON TABLE "public"."v_commission_by_person" TO "service_role";



GRANT ALL ON TABLE "public"."v_commission_by_project" TO "authenticated";
GRANT ALL ON TABLE "public"."v_commission_by_project" TO "service_role";



GRANT ALL ON TABLE "public"."v_commission_by_type" TO "authenticated";
GRANT ALL ON TABLE "public"."v_commission_by_type" TO "service_role";



GRANT ALL ON TABLE "public"."v_commission_status_summary" TO "authenticated";
GRANT ALL ON TABLE "public"."v_commission_status_summary" TO "service_role";



GRANT ALL ON TABLE "public"."v_contractor_costs" TO "authenticated";
GRANT ALL ON TABLE "public"."v_contractor_costs" TO "service_role";



GRANT ALL ON TABLE "public"."v_contractor_expirations" TO "authenticated";
GRANT ALL ON TABLE "public"."v_contractor_expirations" TO "service_role";



GRANT ALL ON TABLE "public"."v_contractor_project_costs" TO "authenticated";
GRANT ALL ON TABLE "public"."v_contractor_project_costs" TO "service_role";



GRANT ALL ON TABLE "public"."v_payroll_summary" TO "authenticated";
GRANT ALL ON TABLE "public"."v_payroll_summary" TO "service_role";



GRANT ALL ON TABLE "public"."v_permissions" TO "authenticated";
GRANT ALL ON TABLE "public"."v_permissions" TO "service_role";



GRANT ALL ON TABLE "public"."v_role_permissions" TO "authenticated";
GRANT ALL ON TABLE "public"."v_role_permissions" TO "service_role";



GRANT ALL ON TABLE "public"."v_roles" TO "authenticated";
GRANT ALL ON TABLE "public"."v_roles" TO "service_role";



GRANT ALL ON TABLE "public"."v_subscription_renewals" TO "authenticated";
GRANT ALL ON TABLE "public"."v_subscription_renewals" TO "service_role";



GRANT ALL ON TABLE "public"."v_subscription_spend" TO "authenticated";
GRANT ALL ON TABLE "public"."v_subscription_spend" TO "service_role";



GRANT ALL ON TABLE "public"."v_user_roles" TO "authenticated";
GRANT ALL ON TABLE "public"."v_user_roles" TO "service_role";



GRANT ALL ON TABLE "reporting"."trial_balance" TO "authenticated";
GRANT ALL ON TABLE "reporting"."trial_balance" TO "service_role";



GRANT ALL ON TABLE "reporting"."balance_sheet" TO "authenticated";
GRANT ALL ON TABLE "reporting"."balance_sheet" TO "service_role";



GRANT ALL ON TABLE "reporting"."budget_vs_actual" TO "service_role";
GRANT SELECT ON TABLE "reporting"."budget_vs_actual" TO "ai_readonly_role";
GRANT SELECT ON TABLE "reporting"."budget_vs_actual" TO "authenticated";



GRANT ALL ON TABLE "reporting"."budget_category_summary" TO "service_role";
GRANT SELECT ON TABLE "reporting"."budget_category_summary" TO "authenticated";



GRANT ALL ON TABLE "reporting"."budget_gl_actual" TO "service_role";
GRANT SELECT ON TABLE "reporting"."budget_gl_actual" TO "authenticated";



GRANT ALL ON TABLE "reporting"."cash_flow" TO "authenticated";
GRANT ALL ON TABLE "reporting"."cash_flow" TO "service_role";



GRANT ALL ON TABLE "reporting"."changes_in_equity" TO "authenticated";
GRANT ALL ON TABLE "reporting"."changes_in_equity" TO "service_role";



GRANT ALL ON TABLE "reporting"."payable_aging" TO "service_role";
GRANT SELECT ON TABLE "reporting"."payable_aging" TO "ai_readonly_role";
GRANT SELECT ON TABLE "reporting"."payable_aging" TO "authenticated";



GRANT ALL ON TABLE "reporting"."pnl" TO "authenticated";
GRANT ALL ON TABLE "reporting"."pnl" TO "service_role";



GRANT ALL ON TABLE "reporting"."receivable_aging" TO "service_role";
GRANT SELECT ON TABLE "reporting"."receivable_aging" TO "ai_readonly_role";
GRANT SELECT ON TABLE "reporting"."receivable_aging" TO "authenticated";



GRANT ALL ON TABLE "reporting"."reconciliation_summary" TO "service_role";
GRANT SELECT ON TABLE "reporting"."reconciliation_summary" TO "ai_readonly_role";
GRANT SELECT ON TABLE "reporting"."reconciliation_summary" TO "authenticated";



GRANT ALL ON TABLE "reporting"."unreconciled_lines" TO "service_role";
GRANT SELECT ON TABLE "reporting"."unreconciled_lines" TO "ai_readonly_role";
GRANT SELECT ON TABLE "reporting"."unreconciled_lines" TO "authenticated";



GRANT ALL ON TABLE "reporting"."v_asset_register" TO "service_role";
GRANT SELECT ON TABLE "reporting"."v_asset_register" TO "authenticated";



GRANT ALL ON TABLE "reporting"."v_cash_position" TO "service_role";
GRANT SELECT ON TABLE "reporting"."v_cash_position" TO "ai_readonly_role";
GRANT SELECT ON TABLE "reporting"."v_cash_position" TO "authenticated";



GRANT ALL ON TABLE "reporting"."v_depreciation_summary" TO "service_role";
GRANT SELECT ON TABLE "reporting"."v_depreciation_summary" TO "authenticated";



GRANT ALL ON TABLE "reporting"."v_legacy_archive_status" TO "service_role";
GRANT SELECT ON TABLE "reporting"."v_legacy_archive_status" TO "authenticated";



GRANT ALL ON TABLE "reporting"."v_project_profitability" TO "service_role";
GRANT SELECT ON TABLE "reporting"."v_project_profitability" TO "ai_readonly_role";
GRANT SELECT ON TABLE "reporting"."v_project_profitability" TO "authenticated";



GRANT ALL ON TABLE "reporting"."v_tax_computation_summary" TO "service_role";
GRANT SELECT ON TABLE "reporting"."v_tax_computation_summary" TO "ai_readonly_role";
GRANT SELECT ON TABLE "reporting"."v_tax_computation_summary" TO "authenticated";



ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "core" GRANT ALL ON TABLES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "core" GRANT ALL ON TABLES TO "service_role";



ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "finance" GRANT ALL ON TABLES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "finance" GRANT ALL ON TABLES TO "service_role";



ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "legacy" GRANT SELECT ON TABLES TO "service_role";



ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "reporting" GRANT ALL ON TABLES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "reporting" GRANT ALL ON TABLES TO "service_role";
