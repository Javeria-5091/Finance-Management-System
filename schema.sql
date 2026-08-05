


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


CREATE SCHEMA IF NOT EXISTS "audit";


ALTER SCHEMA "audit" OWNER TO "postgres";


CREATE SCHEMA IF NOT EXISTS "core";


ALTER SCHEMA "core" OWNER TO "postgres";


CREATE SCHEMA IF NOT EXISTS "finance";


ALTER SCHEMA "finance" OWNER TO "postgres";


CREATE SCHEMA IF NOT EXISTS "public";


ALTER SCHEMA "public" OWNER TO "pg_database_owner";


COMMENT ON SCHEMA "public" IS 'standard public schema';



CREATE SCHEMA IF NOT EXISTS "reporting";


ALTER SCHEMA "reporting" OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "audit"."has_audit_permission"("p_user_id" "uuid") RETURNS boolean
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    AS $$ DECLARE
  v_role TEXT;
BEGIN
  -- Get user's active role from user_roles
  SELECT ur.role INTO v_role
  FROM public.user_roles ur
  WHERE ur.user_id = p_user_id
    AND ur.is_active = true
    AND ur.effective_from <= NOW()
    AND (ur.effective_to IS NULL OR ur.effective_to >= NOW())
  ORDER BY ur.effective_from DESC
  LIMIT 1;
  
  -- Fallback to profiles if not found
  IF v_role IS NULL THEN
    SELECT p.role INTO v_role
    FROM public.profiles p
    WHERE p.id = p_user_id;
  END IF;
  
  -- CEO, FINANCE_HEAD, and ACCOUNTANT can view audit logs
  RETURN v_role IN ('CEO', 'FINANCE_HEAD', 'ACCOUNTANT');
END;
 $$;


ALTER FUNCTION "audit"."has_audit_permission"("p_user_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "audit"."log_action"("p_user_id" "uuid", "p_user_email" "text", "p_user_name" "text", "p_action" "text", "p_entity_type" "text", "p_entity_id" "uuid" DEFAULT NULL::"uuid", "p_description" "text" DEFAULT ''::"text", "p_old_values" "jsonb" DEFAULT NULL::"jsonb", "p_new_values" "jsonb" DEFAULT NULL::"jsonb", "p_ip_address" "inet" DEFAULT NULL::"inet", "p_user_agent" "text" DEFAULT NULL::"text", "p_status" "text" DEFAULT 'success'::"text", "p_error_message" "text" DEFAULT NULL::"text") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$ DECLARE
  v_id UUID;
BEGIN
  INSERT INTO audit.audit_log (
    user_id, user_email, user_name, action, entity_type, entity_id,
    description, old_values, new_values, ip_address, user_agent,
    status, error_message
  ) VALUES (
    p_user_id, p_user_email, p_user_name, p_action, p_entity_type, p_entity_id,
    p_description, p_old_values, p_new_values, p_ip_address, p_user_agent,
    p_status, p_error_message
  )
  RETURNING id INTO v_id;
  
  RETURN v_id;
END;
 $$;


ALTER FUNCTION "audit"."log_action"("p_user_id" "uuid", "p_user_email" "text", "p_user_name" "text", "p_action" "text", "p_entity_type" "text", "p_entity_id" "uuid", "p_description" "text", "p_old_values" "jsonb", "p_new_values" "jsonb", "p_ip_address" "inet", "p_user_agent" "text", "p_status" "text", "p_error_message" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "audit"."log_manual"("p_table_schema" "text", "p_table_name" "text", "p_record_id" "uuid", "p_action" "text", "p_old_values" "jsonb" DEFAULT NULL::"jsonb", "p_new_values" "jsonb" DEFAULT NULL::"jsonb", "p_reason" "text" DEFAULT NULL::"text", "p_source_module" "text" DEFAULT NULL::"text", "p_source_id" "uuid" DEFAULT NULL::"uuid") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$ 
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
 $$;


ALTER FUNCTION "audit"."log_manual"("p_table_schema" "text", "p_table_name" "text", "p_record_id" "uuid", "p_action" "text", "p_old_values" "jsonb", "p_new_values" "jsonb", "p_reason" "text", "p_source_module" "text", "p_source_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "audit"."trigger_audit_log"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$ DECLARE
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
 $$;


ALTER FUNCTION "audit"."trigger_audit_log"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "core"."current_user_id"() RETURNS "uuid"
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    AS $$ BEGIN
    RETURN auth.uid();
END;
 $$;


ALTER FUNCTION "core"."current_user_id"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "core"."get_data_scope"("p_user_id" "uuid", "p_permission_code" "text") RETURNS "text"
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
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
    AS $$ DECLARE
    user_role TEXT;
BEGIN
    SELECT role INTO user_role
    FROM public.profiles
    WHERE user_id = auth.uid();
    
    RETURN COALESCE(user_role, 'User') = p_role;
END;
 $$;


ALTER FUNCTION "core"."has_role"("p_role" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "core"."is_ceo_or_admin"() RETURNS boolean
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    AS $$ BEGIN
    RETURN core.has_role('CEO') OR core.has_role('Admin');
END;
 $$;


ALTER FUNCTION "core"."is_ceo_or_admin"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "core"."is_finance_head"() RETURNS boolean
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    AS $$ BEGIN
    RETURN core.has_role('CEO') 
        OR core.has_role('Admin') 
        OR core.has_role('HOD');
END;
 $$;


ALTER FUNCTION "core"."is_finance_head"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "core"."set_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$ BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
 $$;


ALTER FUNCTION "core"."set_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "finance"."auto_match_statement_lines"("p_statement_id" "uuid") RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$ DECLARE
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
      AND jl.account_id = v_ledger AND je.status = 'posted'
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
      AND jl.account_id = v_ledger AND je.status = 'posted'
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
      AND jl.account_id = v_ledger AND je.status = 'posted'
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
      AND jl.account_id = v_ledger AND je.status = 'posted'
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
    AS $$ DECLARE
  v_outstanding NUMERIC(18,2);
  v_total NUMERIC(18,2);
  v_base_outstanding NUMERIC(18,2);
BEGIN
  -- Calculate total allocated against this invoice
  SELECT 
    i.total_amount - COALESCE(SUM(pa.allocated_amount), 0),
    i.base_total_amount - COALESCE(SUM(pa.base_allocated_amount), 0)
  INTO v_outstanding, v_base_outstanding
  FROM public.invoices i
  LEFT JOIN finance.payment_allocations pa ON pa.invoice_id = i.id
  WHERE i.id = NEW.invoice_id
  GROUP BY i.total_amount, i.base_total_amount;
  
  -- Get totals
  SELECT total_amount, base_total_amount INTO v_total, v_base_outstanding 
  FROM public.invoices WHERE id = NEW.invoice_id;
  
  -- Update balances and status based on outstanding
  UPDATE public.invoices SET 
    amount_paid = v_total - v_outstanding,
    base_amount_paid = v_base_outstanding - v_base_outstanding,
    outstanding_amount = v_outstanding,
    base_outstanding_amount = v_base_outstanding,
    status = CASE 
      WHEN v_outstanding <= 0 THEN 'PAID'
      WHEN v_outstanding < v_total THEN 'PARTIALLY_PAID'
      ELSE status -- Keep existing if still fully unpaid
    END
  WHERE id = NEW.invoice_id;
  
  RETURN NEW;
END;
 $$;


ALTER FUNCTION "finance"."auto_update_invoice_status"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "finance"."check_journal_balance"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$ DECLARE
  v_total_dr NUMERIC(18,2);
  v_total_cr NUMERIC(18,2);
  v_diff NUMERIC(18,4);
BEGIN
  SELECT 
    COALESCE(SUM(debit_amount), 0),
    COALESCE(SUM(credit_amount), 0)
  INTO v_total_dr, v_total_cr
  FROM finance.journal_lines
  WHERE journal_entry_id = COALESCE(NEW.journal_entry_id, OLD.journal_entry_id);

  v_diff := ABS(v_total_dr - v_total_cr);

  -- Allow 0.01 tolerance for rounding
  IF v_diff > 0.01 THEN
    RAISE EXCEPTION 'Journal entry unbalanced: Debit=%, Credit=%, Diff=%', 
      v_total_dr, v_total_cr, v_diff;
  END IF;

  -- Update header totals
  UPDATE finance.journal_entries
  SET total_debit = v_total_dr,
      total_credit = v_total_cr
  WHERE id = COALESCE(NEW.journal_entry_id, OLD.journal_entry_id);

  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
 $$;


ALTER FUNCTION "finance"."check_journal_balance"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "finance"."compute_platform_fee"("p_platform_id" "uuid", "p_amount" numeric, "p_source_type" character varying DEFAULT 'EXPENSE'::character varying) RETURNS numeric
    LANGUAGE "plpgsql" SECURITY DEFINER
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
    AS $$ DECLARE
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
    -- 1. Get reconciliation record
    SELECT * INTO v_recon FROM finance.tax_reconciliations WHERE id = p_tax_recon_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Tax reconciliation not found'; END IF;

    -- 2. Validate rule set is locked
    SELECT status INTO v_rule_status FROM finance.tax_rule_sets WHERE id = v_recon.tax_rule_set_id;
    IF v_rule_status IS NULL THEN RAISE EXCEPTION 'Tax rule set not found'; END IF;
    IF v_rule_status NOT IN ('APPROVED', 'LOCKED') THEN
        RAISE EXCEPTION 'Tax rule set must be APPROVED or LOCKED, current: %', v_rule_status;
    END IF;

    -- 3. Calculate Accounting PBT from GL (Revenue - Expenses for the fiscal year)
    SELECT 
        COALESCE(SUM(CASE WHEN coa.account_type IN ('OTHER_EXPENSE','OPERATING_EXPENSE','COST_OF_SALES') 
                          THEN jl.credit_amount ELSE 0 END), 0) -
        COALESCE(SUM(CASE WHEN coa.account_type IN ('OTHER_EXPENSE','OPERATING_EXPENSE','COST_OF_SALES')
                          THEN jl.debit_amount ELSE 0 END), 0)
        -
        COALESCE(SUM(CASE WHEN coa.account_type IN ('REVENUE','OTHER_INCOME')
                          THEN jl.credit_amount ELSE 0 END), 0)
        +
        COALESCE(SUM(CASE WHEN coa.account_type IN ('REVENUE','OTHER_INCOME')
                          THEN jl.debit_amount ELSE 0 END), 0)
    INTO v_pbt
    FROM finance.journal_lines jl
    JOIN finance.journal_entries je ON je.id = jl.journal_entry_id
    JOIN finance.chart_of_accounts coa ON coa.id = jl.account_id
    JOIN finance.accounting_periods ap ON ap.id = je.period_id
    WHERE ap.fiscal_year_id = v_recon.fiscal_year_id
      AND je.status = 'POSTED'
      AND coa.account_type IN ('REVENUE','COST_OF_SALES','OPERATING_EXPENSE','OTHER_INCOME','OTHER_EXPENSE');

    -- 4. Sum adjustments (positive = add-back, negative = deduction)
    SELECT COALESCE(SUM(amount), 0) INTO v_total_adj
    FROM finance.tax_adjustments
    WHERE tax_reconciliation_id = p_tax_recon_id;

    -- 5. Taxable Income = PBT + Adjustments
    v_taxable_income := v_pbt + v_total_adj;

    -- 6. Apply Tax Slabs progressively
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

    -- 7. Update reconciliation
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


CREATE OR REPLACE FUNCTION "finance"."enforce_maker_checker"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
DECLARE
  v_creator_id UUID;
  v_approver_id UUID;
  v_table TEXT;
  v_schema TEXT;
BEGIN
  v_table := TG_TABLE_NAME;
  v_schema := TG_TABLE_SCHEMA;
  
  -- Get creator and approver IDs based on table
  -- public.expenses, public.incomes, public.invoices use `user_id` as creator
  -- finance.vendor_bills, finance.journal_entries use `created_by` as creator
  IF v_table IN ('expenses', 'incomes', 'invoices') THEN
    v_creator_id := COALESCE(OLD.user_id, NEW.user_id);
    v_approver_id := NEW.approved_by;
  ELSIF v_table IN ('vendor_bills', 'journal_entries') THEN
    v_creator_id := COALESCE(OLD.created_by, NEW.created_by);
    v_approver_id := NEW.approved_by;
  ELSE
    RETURN NEW;
  END IF;

  -- Enforce: creator cannot be the approver
  IF v_approver_id IS NOT NULL AND v_creator_id IS NOT NULL AND v_approver_id = v_creator_id THEN
    RAISE EXCEPTION 'MAKER_CHECKER_VIOLATION: Creator (user %) cannot approve their own record in %', 
      v_creator_id, v_table;
  END IF;

  RETURN NEW;
END;
$$;


ALTER FUNCTION "finance"."enforce_maker_checker"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "finance"."exclude_statement_line"("p_line_id" "uuid", "p_reason" "text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$ BEGIN
    IF p_reason IS NULL OR p_reason = '' THEN RAISE EXCEPTION 'Reason required'; END IF;
    UPDATE finance.statement_lines SET reconciliation_status = 'EXCLUDED', exclusion_reason = p_reason
    WHERE id = p_line_id AND reconciliation_status = 'UNRECONCILED';
END;
 $$;


ALTER FUNCTION "finance"."exclude_statement_line"("p_line_id" "uuid", "p_reason" "text") OWNER TO "postgres";


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
    LANGUAGE "plpgsql"
    AS $$ DECLARE v_n INT;
BEGIN
    IF NEW.transfer_number IS NULL OR NEW.transfer_number = '' THEN
        SELECT COALESCE(MAX(CAST(SUBSTRING(transfer_number FROM 4) AS INT)),0)+1
        INTO v_n FROM finance.bank_transfers WHERE transfer_number LIKE 'BT-%';
        NEW.transfer_number := 'BT-' || LPAD(v_n::TEXT, 5, '0');
    END IF;
    RETURN NEW;
END;
 $$;


ALTER FUNCTION "finance"."fn_gen_bt_number"() OWNER TO "postgres";


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


CREATE OR REPLACE FUNCTION "finance"."fn_tax_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$ BEGIN NEW.updated_at = NOW(); RETURN NEW; END; $$;


ALTER FUNCTION "finance"."fn_tax_updated_at"() OWNER TO "postgres";


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
    AS $$ 
DECLARE
  v_period_id UUID;
BEGIN
  SELECT id INTO v_period_id
  FROM finance.accounting_periods
  WHERE CURRENT_DATE BETWEEN start_date AND end_date
    AND status = 'OPEN'
  ORDER BY start_date DESC
  LIMIT 1;
  
  RETURN v_period_id; -- NULL agar koi open period nahi mila
END;
$$;


ALTER FUNCTION "finance"."get_current_open_period_id"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "finance"."get_current_period"() RETURNS TABLE("period_id" "uuid", "fiscal_year_id" "uuid", "fiscal_year_name" "text", "period_number" integer, "period_name" "text", "period_start" "date", "period_end" "date", "period_status" "text")
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    AS $$ BEGIN
    RETURN QUERY
    SELECT 
        ap.id,
        ap.fiscal_year_id,
        fy.name,
        ap.period_number,
        ap.name,
        ap.start_date,
        ap.end_date,
        ap.status
    FROM finance.accounting_periods ap
    JOIN finance.fiscal_years fy ON ap.fiscal_year_id = fy.id
    WHERE ap.status = 'OPEN'
      AND fy.status = 'OPEN'
      AND CURRENT_DATE BETWEEN ap.start_date AND ap.end_date
    LIMIT 1;
END;
 $$;


ALTER FUNCTION "finance"."get_current_period"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "finance"."get_next_number"("p_type" "text") RETURNS "text"
    LANGUAGE "plpgsql" SECURITY DEFINER
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
    LIMIT 1
    FOR UPDATE;
    
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Numbering sequence not found for type: %', p_type;
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


ALTER FUNCTION "finance"."get_next_number"("p_type" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "finance"."get_period_by_date"("p_date" "date") RETURNS TABLE("period_id" "uuid", "fiscal_year_id" "uuid", "fiscal_year_name" "text", "period_number" integer, "period_name" "text", "period_start" "date", "period_end" "date", "period_status" "text", "fy_status" "text")
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    AS $$ BEGIN
    RETURN QUERY
    SELECT 
        ap.id,
        ap.fiscal_year_id,
        fy.name,
        ap.period_number,
        ap.name,
        ap.start_date,
        ap.end_date,
        ap.status,
        fy.status
    FROM finance.accounting_periods ap
    JOIN finance.fiscal_years fy ON ap.fiscal_year_id = fy.id
    WHERE p_date BETWEEN ap.start_date AND ap.end_date
    LIMIT 1;
END;
 $$;


ALTER FUNCTION "finance"."get_period_by_date"("p_date" "date") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "finance"."is_date_in_open_period"("p_date" "date") RETURNS boolean
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    AS $$ DECLARE
    v_is_open BOOLEAN;
BEGIN
    SELECT EXISTS (
        SELECT 1 
        FROM finance.accounting_periods ap
        JOIN finance.fiscal_years fy ON ap.fiscal_year_id = fy.id
        WHERE ap.status = 'OPEN'
          AND fy.status = 'OPEN'
          AND p_date BETWEEN ap.start_date AND ap.end_date
    ) INTO v_is_open;
    
    RETURN v_is_open;
END;
 $$;


ALTER FUNCTION "finance"."is_date_in_open_period"("p_date" "date") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "finance"."manual_match_statement_line"("p_line_id" "uuid", "p_journal_line_id" "uuid", "p_reason" "text" DEFAULT NULL::"text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$ DECLARE v_sl RECORD; v_ledger UUID;
BEGIN
    SELECT * INTO v_sl FROM finance.statement_lines WHERE id = p_line_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Line not found'; END IF;
    IF v_sl.reconciliation_status != 'UNRECONCILED' THEN RAISE EXCEPTION 'Not unreconciled: %', v_sl.reconciliation_status; END IF;

    SELECT fa.linked_ledger_account_id INTO v_ledger
    FROM finance.bank_statements bs JOIN finance.financial_accounts fa ON fa.id = bs.financial_account_id
    WHERE bs.id = v_sl.bank_statement_id;

    IF EXISTS (SELECT 1 FROM finance.journal_lines WHERE id = p_journal_line_id AND account_id != v_ledger) THEN
        RAISE EXCEPTION 'Journal line does not belong to this financial account';
    END IF;
    IF EXISTS (SELECT 1 FROM finance.statement_lines WHERE matched_journal_line_id = p_journal_line_id AND id != p_line_id AND reconciliation_status IN ('MATCHED','MANUAL_MATCH')) THEN
        RAISE EXCEPTION 'Journal line already matched';
    END IF;

    UPDATE finance.statement_lines SET
        reconciliation_status = 'MANUAL_MATCH', matched_journal_line_id = p_journal_line_id,
        matched_at = NOW(), matched_by = auth.uid(), match_method = 'MANUAL', exclusion_reason = p_reason
    WHERE id = p_line_id;
END;
 $$;


ALTER FUNCTION "finance"."manual_match_statement_line"("p_line_id" "uuid", "p_journal_line_id" "uuid", "p_reason" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "finance"."mark_overdue_invoices"() RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$ 
DECLARE
  v_count INTEGER := 0;
BEGIN
  -- Sirf un invoices ko OVERDUE mark karo jo ISSUED ya PARTIALLY_PAID hain
  -- AUR unka due_date ho chuka ho aur outstanding_amount > 0 ho
  UPDATE public.invoices
  SET status = 'OVERDUE'
  WHERE id IN (
    SELECT id FROM public.invoices
    WHERE status IN ('ISSUED', 'PARTIALLY_PAID')
      AND due_date < CURRENT_DATE
      AND outstanding_amount > 0
  );
  
  GET DIAGNOSTICS v_count = ROW_COUNT; -- Fixed the syntax here as well
  
  RETURN v_count;
END;
$$;


ALTER FUNCTION "finance"."mark_overdue_invoices"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "finance"."mark_paid_invoices"() RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$ 
DECLARE
  v_count INTEGER := 0;
BEGIN
  -- Agar outstanding 0 se kam ya barabar hai toh PAID kar do
  UPDATE public.invoices
  SET status = 'PAID'
  WHERE id IN (
    SELECT id FROM public.invoices
    WHERE status IN ('ISSUED', 'PARTIALLY_PAID', 'OVERDUE')
      AND outstanding_amount <= 0
  );
  
  GET DIAGNOSTICS v_count = ROW_COUNT; -- Fixed the syntax here as well
  RETURN v_count;
END;
$$;


ALTER FUNCTION "finance"."mark_paid_invoices"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "finance"."open_period"("p_period_id" "uuid", "p_opened_by" "uuid" DEFAULT NULL::"uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
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
    AS $$ DECLARE
    v_t RECORD; v_fy_id UUID; v_from_ledger UUID; v_to_ledger UUID;
    v_fx_gain UUID; v_fx_loss UUID; v_lines JSONB := '[]'::JSONB;
    v_fx_diff NUMERIC(18,2); v_from_base NUMERIC(18,2); v_to_base NUMERIC(18,2);
    v_from_rate NUMERIC(18,6); v_to_rate NUMERIC(18,6);
BEGIN
    SELECT * INTO v_t FROM finance.bank_transfers WHERE id = p_transfer_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Transfer not found'; END IF;
    IF v_t.status NOT IN ('APPROVED','SUBMITTED') THEN RAISE EXCEPTION 'Must be approved, status: %', v_t.status; END IF;

    SELECT fiscal_year_id INTO v_fy_id FROM finance.accounting_periods WHERE id = p_period_id;
    IF v_fy_id IS NULL THEN RAISE EXCEPTION 'Invalid period'; END IF;

    SELECT linked_ledger_account_id INTO v_from_ledger FROM finance.financial_accounts WHERE id = v_t.from_account_id;
    SELECT linked_ledger_account_id INTO v_to_ledger FROM finance.financial_accounts WHERE id = v_t.to_account_id;
    SELECT id INTO v_fx_gain FROM finance.chart_of_accounts WHERE code = '4210' LIMIT 1;
    SELECT id INTO v_fx_loss FROM finance.chart_of_accounts WHERE code = '7210' LIMIT 1;

    -- From side to PKR base
    IF v_t.from_currency = 'PKR' THEN v_from_base := v_t.from_amount; v_from_rate := 1;
    ELSE
        SELECT rate INTO v_from_rate FROM finance.exchange_rates WHERE from_currency = v_t.from_currency AND to_currency = 'PKR' ORDER BY effective_date DESC LIMIT 1;
        IF v_from_rate IS NULL THEN v_from_rate := v_t.exchange_rate; END IF;
        v_from_base := ROUND(v_t.from_amount * v_from_rate, 2);
    END IF;

    -- To side to PKR base
    IF v_t.to_currency = 'PKR' THEN v_to_base := v_t.to_amount; v_to_rate := 1;
    ELSE
        SELECT rate INTO v_to_rate FROM finance.exchange_rates WHERE from_currency = v_t.to_currency AND to_currency = 'PKR' ORDER BY effective_date DESC LIMIT 1;
        IF v_to_rate IS NULL THEN v_to_rate := 1 / v_t.exchange_rate; END IF;
        v_to_base := ROUND(v_t.to_amount * v_to_rate, 2);
    END IF;

    -- Same currency
    IF v_t.from_currency = v_t.to_currency THEN
        v_lines := jsonb_build_object('account_id', v_to_ledger, 'debit_amount', v_t.to_amount, 'credit_amount', 0, 'description', 'Transfer TO: ' || v_t.transfer_number);
        v_lines := v_lines || jsonb_build_object('account_id', v_from_ledger, 'debit_amount', 0, 'credit_amount', v_t.from_amount, 'description', 'Transfer FROM: ' || v_t.transfer_number);
    ELSE
        v_fx_diff := v_to_base - v_from_base;
        v_lines := jsonb_build_object('account_id', v_to_ledger, 'debit_amount', v_to_base, 'credit_amount', 0, 'description', 'Transfer TO: ' || v_t.transfer_number || ' (' || v_t.to_amount || ' ' || v_t.to_currency || ')');
        v_lines := v_lines || jsonb_build_object('account_id', v_from_ledger, 'debit_amount', 0, 'credit_amount', v_from_base, 'description', 'Transfer FROM: ' || v_t.transfer_number || ' (' || v_t.from_amount || ' ' || v_t.from_currency || ')');
        IF v_fx_diff > 0 AND v_fx_gain IS NOT NULL THEN
            v_lines := v_lines || jsonb_build_object('account_id', v_fx_gain, 'debit_amount', 0, 'credit_amount', v_fx_diff, 'description', 'FX Gain: ' || v_t.transfer_number);
        ELSIF v_fx_diff < 0 AND v_fx_loss IS NOT NULL THEN
            v_lines := v_lines || jsonb_build_object('account_id', v_fx_loss, 'debit_amount', ABS(v_fx_diff), 'credit_amount', 0, 'description', 'FX Loss: ' || v_t.transfer_number);
        END IF;
    END IF;

    RETURN finance.post_journal_entry('Bank Transfer: ' || v_t.transfer_number, p_transaction_date, p_period_id, 'PKR', 1.0000, 'BANK_TRANSFER', p_transfer_id, NULL, NULL, v_lines);
END;
 $$;


ALTER FUNCTION "finance"."post_bank_transfer"("p_transfer_id" "uuid", "p_period_id" "uuid", "p_transaction_date" "date") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "finance"."post_credit_note"("p_cn_id" "uuid", "p_period_id" "uuid", "p_transaction_date" "date") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$ DECLARE
  v_cn RECORD;
  v_fy_id UUID;
  v_rev_account UUID := '41100000-0000-0000-0000-000000000000';
  v_ar_account UUID := '12100000-0000-0000-0000-000000000000';
  v_lines JSONB := '[]'::JSONB;
BEGIN
  SELECT * INTO v_cn FROM finance.credit_notes WHERE id = p_cn_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Credit Note not found'; END IF;
  
  SELECT fiscal_year_id INTO v_fy_id FROM finance.accounting_periods WHERE id = p_period_id;
  IF v_fy_id IS NULL THEN RAISE EXCEPTION 'Invalid period'; END IF;

  SELECT id INTO v_rev_account FROM finance.chart_of_accounts WHERE code = '4110' LIMIT 1;
  SELECT id INTO v_ar_account FROM finance.chart_of_accounts WHERE code = '1210' LIMIT 1;

  -- Debit Revenue (Reduce income)
  v_lines := jsonb_build_object(
    'account_id', v_rev_account,
    'debit_amount', v_cn.base_amount,
    'credit_amount', 0,
    'description', 'Credit Note: ' || COALESCE(v_cn.credit_note_number, v_cn.id::text) || ' - ' || v_cn.reason
  );

  -- Credit AR (Reduce receivable)
  v_lines := v_lines || jsonb_build_object(
    'account_id', v_ar_account,
    'debit_amount', 0,
    'credit_amount', v_cn.base_amount,
    'description', 'AR Adjustment: CN ' || COALESCE(v_cn.credit_note_number, v_cn.id::text)
  );

  RETURN finance.post_journal_entry(
    'Credit Note: ' || COALESCE(v_cn.credit_note_number, v_cn.id::text),
    p_transaction_date,
    p_period_id,
    'PKR', 1.0000,
    'CREDIT_NOTE', p_cn_id,
    NULL, NULL,
    v_lines
  );
END;
 $$;


ALTER FUNCTION "finance"."post_credit_note"("p_cn_id" "uuid", "p_period_id" "uuid", "p_transaction_date" "date") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "finance"."post_distribution_payment"("p_line_id" "uuid", "p_period_id" "uuid", "p_transaction_date" "date", "p_bank_account_id" "uuid") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$ DECLARE
    v_line RECORD; v_lines JSONB := '[]'::JSONB;
    v_payable UUID; v_bank_ledger UUID; v_owner_name TEXT;
BEGIN
    SELECT * INTO v_line FROM finance.distribution_lines WHERE id = p_line_id;
    IF v_line.payment_status != 'PENDING' THEN RAISE EXCEPTION 'Already paid'; END IF;

    SELECT name INTO v_owner_name FROM finance.owners WHERE id = v_line.owner_id;
    SELECT id INTO v_payable FROM finance.chart_of_accounts WHERE code = '2410' LIMIT 1;
    SELECT linked_ledger_account_id INTO v_bank_ledger FROM finance.financial_accounts WHERE id = p_bank_account_id;

    v_lines := jsonb_build_object('account_id', v_payable, 'debit_amount', v_line.final_amount, 'credit_amount', 0, 'description', 'Payout to ' || v_owner_name);
    v_lines := v_lines || jsonb_build_object('account_id', v_bank_ledger, 'debit_amount', 0, 'credit_amount', v_line.final_amount, 'description', 'Payout to ' || v_owner_name);

    RETURN finance.post_journal_entry('Owner Payout', p_transaction_date, p_period_id, 'PKR', 1.0, 'DISTRIBUTION_PAYMENT', p_line_id, NULL, NULL, v_lines);
END;
 $$;


ALTER FUNCTION "finance"."post_distribution_payment"("p_line_id" "uuid", "p_period_id" "uuid", "p_transaction_date" "date", "p_bank_account_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "finance"."post_invoice_ar"("p_invoice_id" "uuid", "p_period_id" "uuid", "p_transaction_date" "date") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$ DECLARE
  v_inv RECORD;
  v_fy_id UUID;
  v_lines JSONB := '[]'::JSONB;
  v_dr_account UUID := '12100000-0000-0000-0000-000000000000'; -- Fallback AR account
  v_rev_account UUID := '41100000-0000-0000-0000-000000000000'; -- Fallback Revenue
  v_tax_account UUID := '22100000-0000-0000-0000-000000000000'; -- Fallback Tax Payable
BEGIN
  -- Fetch invoice details
  SELECT * INTO v_inv FROM public.invoices WHERE id = p_invoice_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Invoice not found'; END IF;
  
  -- Get fiscal year
  SELECT fiscal_year_id INTO v_fy_id FROM finance.accounting_periods WHERE id = p_period_id;
  IF v_fy_id IS NULL THEN RAISE EXCEPTION 'Invalid period'; END IF;

  -- Try to get actual mapped accounts from COA (Best Practice)
  SELECT id INTO v_dr_account FROM finance.chart_of_accounts WHERE code = '1210' LIMIT 1;
  SELECT id INTO v_rev_account FROM finance.chart_of_accounts WHERE code = '4110' LIMIT 1;
  SELECT id INTO v_tax_account FROM finance.chart_of_accounts WHERE code = '2210' LIMIT 1;

  -- Build journal lines
  -- Line 1: Debit AR
  v_lines := v_lines || jsonb_build_object(
    'account_id', v_dr_account,
    'debit_amount', v_inv.base_total_amount,
    'credit_amount', 0,
    'description', 'AR: ' || COALESCE(v_inv.invoice_number, 'N/A') || ' - ' || v_inv.client_name
  );

  -- Line 2: Credit Revenue (Total - Tax)
  IF v_inv.base_total_amount - v_inv.base_tax_amount > 0 THEN
    v_lines := v_lines || jsonb_build_object(
      'account_id', v_rev_account,
      'debit_amount', 0,
      'credit_amount', v_inv.base_total_amount - v_inv.base_tax_amount,
      'description', 'Revenue: ' || COALESCE(v_inv.invoice_number, 'N/A')
    );
  END IF;

  -- Line 3: Credit Tax Payable (If tax exists)
  IF v_inv.base_tax_amount > 0 THEN
    v_lines := v_lines || jsonb_build_object(
      'account_id', v_tax_account,
      'debit_amount', 0,
      'credit_amount', v_inv.base_tax_amount,
      'description', 'Tax on Inv: ' || COALESCE(v_inv.invoice_number, 'N/A')
    );
  END IF;

  -- Call the master posting engine from Phase 2
  RETURN finance.post_journal_entry(
    'AR Invoice: ' || COALESCE(v_inv.invoice_number, v_inv.id::text),
    p_transaction_date,
    p_period_id,
    'PKR', 1.0000, -- Always posted in base currency for AR
    'INVOICE', p_invoice_id,
    v_inv.project_id,
    NULL,
    v_lines
  );
END;
 $$;


ALTER FUNCTION "finance"."post_invoice_ar"("p_invoice_id" "uuid", "p_period_id" "uuid", "p_transaction_date" "date") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "finance"."post_journal_entry"("p_description" "text", "p_transaction_date" "date", "p_period_id" "uuid", "p_lines" "jsonb", "p_currency" "text" DEFAULT 'PKR'::"text", "p_exchange_rate" numeric DEFAULT 1.0000, "p_source_type" "text" DEFAULT 'MANUAL'::"text", "p_source_id" "uuid" DEFAULT NULL::"uuid", "p_project_id" "uuid" DEFAULT NULL::"uuid", "p_department_id" "uuid" DEFAULT NULL::"uuid") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$ 
DECLARE
  v_journal_id UUID;
  v_ref TEXT;
  v_fiscal_year_id UUID;
  v_total_dr NUMERIC(18,2) := 0;
  v_total_cr NUMERIC(18,2) := 0;
  v_line_num INTEGER := 0;
  v_line JSONB;
BEGIN
  -- 1. Get Fiscal Year from Period
  SELECT fiscal_year_id INTO v_fiscal_year_id
  FROM finance.accounting_periods WHERE id = p_period_id;
  
  IF v_fiscal_year_id IS NULL THEN
    RAISE EXCEPTION 'Invalid period_id: %', p_period_id;
  END IF;

  -- 2. Validate & Calculate Totals
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

  -- 3. Get Reference
  v_ref := finance.get_next_number('JOURNAL_ENTRY');

  -- 4. Insert Header (Directly POSTED for system entries)
  INSERT INTO finance.journal_entries (
    reference, description, status, transaction_date, posting_date,
    period_id, fiscal_year_id, currency, exchange_rate, base_currency,
    total_debit, total_credit, source_type, source_id, project_id, department_id,
    created_by, submitted_by, submitted_at, verified_by, verified_at,
    approved_by, approved_at, posted_by, posted_at
  ) VALUES (
    v_ref, p_description, 'POSTED', p_transaction_date, CURRENT_DATE,
    p_period_id, v_fiscal_year_id, p_currency, p_exchange_rate, 'PKR',
    v_total_dr, v_total_cr, p_source_type, p_source_id, p_project_id, p_department_id,
    auth.uid(), auth.uid(), NOW(), auth.uid(), NOW(), 
    auth.uid(), NOW(), auth.uid(), NOW()
  ) RETURNING id INTO v_journal_id;

  -- 5. Insert Lines
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


CREATE OR REPLACE FUNCTION "finance"."post_payment_receipt"("p_receipt_id" "uuid", "p_period_id" "uuid", "p_transaction_date" "date") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$ DECLARE
  v_receipt RECORD;
  v_fy_id UUID;
  v_bank_account UUID := '11100000-0000-0000-0000-000000000000'; -- Fallback Bank
  v_ar_account UUID := '12100000-0000-0000-0000-000000000000'; -- Fallback AR
  v_lines JSONB := '[]'::JSONB;
BEGIN
  SELECT * INTO v_receipt FROM finance.payment_receipts WHERE id = p_receipt_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Receipt not found'; END IF;
  
  SELECT fiscal_year_id INTO v_fy_id FROM finance.accounting_periods WHERE id = p_period_id;
  IF v_fy_id IS NULL THEN RAISE EXCEPTION 'Invalid period'; END IF;

  -- Try to get actual Bank account (Hardcoded to PKR for now, Phase 6 will make it dynamic)
  SELECT id INTO v_bank_account FROM finance.chart_of_accounts WHERE code = '1110' LIMIT 1;
  SELECT id INTO v_ar_account FROM finance.chart_of_accounts WHERE code = '1210' LIMIT 1;

  -- Build journal lines
  v_lines := jsonb_build_object(
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

  -- Call Phase 2 posting engine
  RETURN finance.post_journal_entry(
    'Payment Receipt: ' || COALESCE(v_receipt.receipt_number, v_receipt.id::text),
    p_transaction_date,
    p_period_id,
    'PKR', 1.0000,
    'PAYMENT', p_receipt_id,
    v_receipt.project_id,
    NULL,
    v_lines
  );
END;
 $$;


ALTER FUNCTION "finance"."post_payment_receipt"("p_receipt_id" "uuid", "p_period_id" "uuid", "p_transaction_date" "date") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "finance"."post_profit_distribution"("p_distribution_id" "uuid", "p_period_id" "uuid", "p_transaction_date" "date") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
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

    v_lines := jsonb_build_object('account_id', v_pnl, 'debit_amount', v_dist.total_available_profit, 'credit_amount', 0, 'description', 'Close P&L & Transfer to Reserves/Distributions');
    
    IF v_dist.reserve_amount > 0 THEN
        v_lines := v_lines || jsonb_build_object('account_id', v_reserve, 'debit_amount', 0, 'credit_amount', v_dist.reserve_amount, 'description', 'Transfer to Reserves');
    END IF;
    
    IF v_dist.distributable_amount > 0 THEN
        v_lines := v_lines || jsonb_build_object('account_id', v_payable, 'debit_amount', 0, 'credit_amount', v_dist.distributable_amount, 'description', 'Profit Distribution Payable');
    END IF;

    RETURN finance.post_journal_entry('Profit Distribution', p_transaction_date, p_period_id, 'PKR', 1.0, 'PROFIT_DISTRIBUTION', p_distribution_id, NULL, NULL, v_lines);
END;
 $$;


ALTER FUNCTION "finance"."post_profit_distribution"("p_distribution_id" "uuid", "p_period_id" "uuid", "p_transaction_date" "date") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "finance"."post_vendor_bill"("p_bill_id" "uuid", "p_period_id" "uuid", "p_transaction_date" "date") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$ 
DECLARE
  v_bill RECORD;
  v_fy_id UUID;
  v_lines JSONB := '[]'::JSONB;
  v_ap_account UUID;
  v_wht_account UUID;
  v_line RECORD;
  v_total_debit NUMERIC(18,2) := 0;
  v_total_credit NUMERIC(18,2) := 0;
BEGIN
  SELECT * INTO v_bill FROM finance.vendor_bills WHERE id = p_bill_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Bill not found'; END IF;
  
  IF v_bill.status != 'APPROVED' THEN 
    RAISE EXCEPTION 'Bill must be APPROVED before posting, current status: %', v_bill.status; 
  END IF;
  
  SELECT fiscal_year_id INTO v_fy_id FROM finance.accounting_periods WHERE id = p_period_id;
  IF v_fy_id IS NULL THEN RAISE EXCEPTION 'Invalid period'; END IF;

  SELECT id INTO v_ap_account FROM finance.chart_of_accounts WHERE code = '2110' LIMIT 1;
  IF v_ap_account IS NULL THEN RAISE EXCEPTION 'AP account 2110 not found in COA'; END IF;

  SELECT id INTO v_wht_account FROM finance.chart_of_accounts WHERE code = '1401' LIMIT 1;
  IF v_wht_account IS NULL THEN RAISE EXCEPTION 'WHT account 1401 not found in COA'; END IF;

  -- ✅ FIXED: Correct column names
  FOR v_line IN (
    SELECT 
      id, 
      account_id, 
      line_total AS line_amount,
      description,
      COALESCE(withholding_amount, 0) AS wht_amount
    FROM finance.vendor_bill_lines 
    WHERE vendor_bill_id = p_bill_id
    ORDER BY line_number
  ) LOOP
    -- Debit Expense Account (net of withholding)
    v_lines := v_lines || jsonb_build_object(
      'account_id', v_line.account_id,
      'debit_amount', v_line.line_amount - v_line.wht_amount,
      'credit_amount', 0,
      'description', v_line.description
    );
    v_total_debit := v_total_debit + (v_line.line_amount - v_line.wht_amount);
    
    -- Debit WHT Receivable (If any withholding)
    IF v_line.wht_amount > 0 THEN
      v_lines := v_lines || jsonb_build_object(
        'account_id', v_wht_account,
        'debit_amount', v_line.wht_amount,
        'credit_amount', 0,
        'description', 'WHT on Bill ' || v_bill.bill_number
      );
      v_total_debit := v_total_debit + v_line.wht_amount;
    END IF;
  END LOOP;

  -- Credit Total AP Account
  v_lines := v_lines || jsonb_build_object(
    'account_id', v_ap_account,
    'debit_amount', 0,
    'credit_amount', v_bill.total_amount,
    'description', 'AP: ' || v_bill.bill_number || ' - ' || (SELECT name FROM finance.vendors WHERE id = v_bill.vendor_id)
  );
  v_total_credit := v_bill.total_amount;

  -- ✅ Balance check
  IF ABS(v_total_debit - v_total_credit) > 0.02 THEN
    RAISE EXCEPTION 'Journal unbalanced: Debit=%, Credit=%', v_total_debit, v_total_credit;
  END IF;

  RETURN finance.post_journal_entry(
    'AP Bill: ' || v_bill.bill_number,
    p_transaction_date, p_period_id, 'PKR', 1.0000,
    'VENDOR_BILL', p_bill_id, v_bill.project_id, NULL, v_lines
  );
END;
 $$;


ALTER FUNCTION "finance"."post_vendor_bill"("p_bill_id" "uuid", "p_period_id" "uuid", "p_transaction_date" "date") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "finance"."post_vendor_payment"("p_payment_id" "uuid", "p_period_id" "uuid", "p_transaction_date" "date") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$ 
DECLARE
  v_pay RECORD;
  v_fy_id UUID;
  v_ap_account UUID;
  v_bank_account UUID;
  v_wht_payable UUID;
  v_total_allocated NUMERIC(18,2);
  v_total_withholding NUMERIC(18,2);
  v_lines JSONB := '[]'::JSONB;
  v_full_bill_amount NUMERIC(18,2);
BEGIN
  SELECT * INTO v_pay FROM finance.vendor_payments WHERE id = p_payment_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Payment not found'; END IF;
  
  SELECT fiscal_year_id INTO v_fy_id FROM finance.accounting_periods WHERE id = p_period_id;
  IF v_fy_id IS NULL THEN RAISE EXCEPTION 'Invalid period'; END IF;

  -- Get actual Accounts from COA
  SELECT id INTO v_ap_account FROM finance.chart_of_accounts WHERE code = '2110' LIMIT 1;
  IF v_ap_account IS NULL THEN RAISE EXCEPTION 'AP account 2110 not found'; END IF;

  SELECT id INTO v_bank_account FROM finance.chart_of_accounts WHERE code = '1110' LIMIT 1;
  IF v_bank_account IS NULL THEN RAISE EXCEPTION 'Bank account 1110 not found'; END IF;

  SELECT id INTO v_wht_payable FROM finance.chart_of_accounts WHERE code = '2201' LIMIT 1;
  IF v_wht_payable IS NULL THEN RAISE EXCEPTION 'WHT Payable account 2201 not found'; END IF;

  -- FIX #8: Calculate totals CORRECTLY from allocations
  -- Old wrong JOIN: vbl.id = vpa.vendor_bill_id (joined line ID to bill ID — WRONG)
  -- New correct approach: aggregate from allocations + bills directly
  SELECT 
    COALESCE(SUM(vpa.allocated_amount), 0),
    COALESCE(SUM(
      (SELECT COALESCE(SUM(COALESCE(bl.base_withholding_amount, bl.withholding_amount, 0)), 0)
       FROM finance.vendor_bill_lines bl 
       WHERE bl.vendor_bill_id = vpa.vendor_bill_id)
    ), 0),
    COALESCE(SUM(vb.total_amount), 0)
  INTO v_total_allocated, v_total_withholding, v_full_bill_amount
  FROM finance.vendor_payment_allocations vpa
  JOIN finance.vendor_bills vb ON vb.id = vpa.vendor_bill_id
  WHERE vpa.vendor_payment_id = p_payment_id;

  -- Debit AP for full bill amounts being cleared
  IF v_full_bill_amount > 0 THEN
    v_lines := jsonb_build_object(
      'account_id', v_ap_account,
      'debit_amount', v_full_bill_amount,
      'credit_amount', 0,
      'description', 'AP Cleared: ' || v_pay.payment_number
    );
  END IF;

  -- Credit Bank for actual payment amount
  IF v_total_allocated > 0 THEN
    v_lines := v_lines || jsonb_build_object(
      'account_id', v_bank_account,
      'debit_amount', 0,
      'credit_amount', v_total_allocated,
      'description', 'Paid to Vendor: ' || v_pay.payment_number
    );
  END IF;

  -- Credit WHT Payable (If any tax was withheld)
  IF v_total_withholding > 0 THEN
    v_lines := v_lines || jsonb_build_object(
      'account_id', v_wht_payable,
      'debit_amount', 0,
      'credit_amount', v_total_withholding,
      'description', 'WHT Deposited: ' || v_pay.payment_number
    );
  END IF;

  RETURN finance.post_journal_entry(
    'Vendor Payment: ' || v_pay.payment_number,
    p_transaction_date, p_period_id, 'PKR', 1.0000,
    'VENDOR_PAYMENT', p_payment_id, NULL, NULL, v_lines
  );
END;
 $$;


ALTER FUNCTION "finance"."post_vendor_payment"("p_payment_id" "uuid", "p_period_id" "uuid", "p_transaction_date" "date") OWNER TO "postgres";


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


CREATE OR REPLACE FUNCTION "finance"."reset_sequence"("p_type" "text", "p_fy_id" "uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
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
    AS $$ 
DECLARE
  v_original RECORD;
  v_reversal_id UUID;
  v_ref TEXT;
BEGIN
  -- 1. Fetch original
  SELECT * INTO v_original 
  FROM finance.journal_entries WHERE id = p_journal_id;

  IF NOT FOUND THEN RAISE EXCEPTION 'Journal not found'; END IF;
  IF v_original.status != 'POSTED' THEN RAISE EXCEPTION 'Can only reverse POSTED entries'; END IF;
  IF v_original.reversal_of_id IS NOT NULL THEN RAISE EXCEPTION 'This is already a reversal'; END IF;
  IF p_reason IS NULL OR TRIM(p_reason) = '' THEN RAISE EXCEPTION 'Reversal reason is mandatory'; END IF;

  v_ref := finance.get_next_number('JOURNAL_ENTRY');

  -- 2. Mark original as REVERSED
  UPDATE finance.journal_entries 
  SET status = 'REVERSED', reversed_by = auth.uid(), reversed_at = NOW(), reversal_reason = p_reason
  WHERE id = p_journal_id;

  -- 3. Create Reversal Header (Swapped totals)
  INSERT INTO finance.journal_entries (
    reference, description, status, transaction_date, posting_date,
    period_id, fiscal_year_id, currency, exchange_rate, base_currency,
    total_debit, total_credit, source_type, source_id, project_id, department_id,
    reversal_of_id, reversal_reason,
    created_by, posted_by, posted_at
  ) VALUES (
    v_ref, 'REVERSAL: ' || v_original.description, 'POSTED', p_reversal_date, CURRENT_DATE,
    v_original.period_id, v_original.fiscal_year_id, v_original.currency, v_original.exchange_rate, v_original.base_currency,
    v_original.total_credit, v_original.total_debit, -- SWAPPED
    'REVERSAL', p_journal_id, v_original.project_id, v_original.department_id,
    p_journal_id, p_reason,
    auth.uid(), auth.uid(), NOW()
  ) RETURNING id INTO v_reversal_id;

  -- 4. Create Reversal Lines (Swapped Dr/Cr)
  INSERT INTO finance.journal_lines (
    journal_entry_id, line_number, account_id, description,
    debit_amount, credit_amount, currency, exchange_rate, base_debit, base_credit,
    project_id, department_id, created_by
  )
  SELECT 
    v_reversal_id, line_number, account_id, 'REVERSAL: ' || COALESCE(description, ''),
    credit_amount, debit_amount, -- SWAPPED
    currency, exchange_rate, base_credit, base_debit, -- SWAPPED
    project_id, department_id, auth.uid()
  FROM finance.journal_lines WHERE journal_entry_id = p_journal_id;

  RETURN v_reversal_id;
END;
 $$;


ALTER FUNCTION "finance"."reverse_journal_entry"("p_journal_id" "uuid", "p_reversal_date" "date", "p_reason" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "finance"."unmatch_statement_line"("p_line_id" "uuid", "p_reason" "text" DEFAULT NULL::"text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$ DECLARE v_sl RECORD;
BEGIN
    SELECT * INTO v_sl FROM finance.statement_lines WHERE id = p_line_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Line not found'; END IF;
    IF v_sl.reconciliation_status NOT IN ('MATCHED','MANUAL_MATCH') THEN RAISE EXCEPTION 'Can only unmatch matched lines'; END IF;
    UPDATE finance.statement_lines SET reconciliation_status = 'UNRECONCILED', matched_journal_line_id = NULL, matched_at = NULL, matched_by = NULL, match_method = NULL WHERE id = p_line_id;
END;
 $$;


ALTER FUNCTION "finance"."unmatch_statement_line"("p_line_id" "uuid", "p_reason" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."create_user_by_admin"("p_email" "text", "p_password" "text", "p_role" "text" DEFAULT 'User'::"text", "p_full_name" "text" DEFAULT ''::"text") RETURNS json
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$ DECLARE
  v_new_user_id UUID;
BEGIN
  -- 1. Check karo ke jo call kar raha hai wo Admin hai ya nahi
  IF NOT EXISTS (
    SELECT 1 FROM public.profiles 
    WHERE user_id = auth.uid() AND role = 'Admin'
  ) THEN
    RETURN json_build_object('error', 'Only admins can create users')::JSON;
  END IF;

  -- 2. auth.users mein naya account banao (Direct database insert)
  INSERT INTO auth.users (
    instance_id, id, email, encrypted_password, email_confirmed_at, 
    raw_user_meta_data, created_at, updated_at, aud, role, 
    confirmation_token, recovery_token, email_change_token_new, email_change, invited_at
  ) VALUES (
    '00000000-0000-0000-0000-000000000000', 
    gen_random_uuid(), 
    p_email, 
    crypt(p_password, gen_salt('bf')), -- Password securely hash ho raha hai
    NOW(), -- Email auto confirm
    jsonb_build_object('full_name', p_full_name), 
    NOW(), NOW(), 
    'authenticated', 'authenticated', 
    '', '', '', '', NULL
  )
  RETURNING id INTO v_new_user_id;

  -- 3. Public profiles table mein entry banao (Trigger skip ho jayega isliye manually)
  INSERT INTO public.profiles (user_id, email, full_name, role)
  VALUES (v_new_user_id, p_email, p_full_name, p_role);

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
    AS $$
DECLARE
  v_profile_id UUID;
  v_email TEXT;
BEGIN
  -- Check if profile already exists
  SELECT id INTO v_profile_id FROM public.profiles WHERE user_id = target_user_id;
  
  IF v_profile_id IS NOT NULL THEN
    RETURN v_profile_id;
  END IF;
  
  -- Get email from auth.users
  SELECT email INTO v_email FROM auth.users WHERE id = target_user_id;
  
  -- Create profile
  INSERT INTO public.profiles (user_id, email, full_name, role)
  VALUES (target_user_id, v_email, '', 'EMPLOYEE')
  RETURNING id INTO v_profile_id;
  
  RETURN v_profile_id;
END;
$$;


ALTER FUNCTION "public"."ensure_profile_exists"("target_user_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."execute_sql_query"("query_string" "text") RETURNS json
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$ 
DECLARE
  result JSON;
  lower_query TEXT;
BEGIN
  lower_query := LOWER(TRIM(query_string));
  
  -- Allow SELECT and WITH (CTE)
  IF NOT (
    LEFT(lower_query, 6) = 'select' 
    OR LEFT(lower_query, 4) = 'with'
  ) THEN
    RAISE EXCEPTION 'Only SELECT queries are allowed';
  END IF;

  -- Block dangerous operations (word boundaries)
  IF lower_query ~* '\b(DROP|DELETE|UPDATE|INSERT|ALTER|CREATE|TRUNCATE|GRANT|REVOKE)\b' THEN
    RAISE EXCEPTION 'Dangerous operation not allowed';
  END IF;

  -- Execute with error handling
  BEGIN
    EXECUTE format('SELECT json_agg(t) FROM (%s) t', query_string) INTO result;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'SQL Error: %', SQLERRM;
  END;
  
  RETURN COALESCE(result, '[]'::JSON);
END;
 $$;


ALTER FUNCTION "public"."execute_sql_query"("query_string" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."find_auth_user_by_email"("search_email" "text") RETURNS TABLE("user_id" "uuid", "email" "text")
    LANGUAGE "sql" STABLE SECURITY DEFINER
    AS $$
 SELECT id, email
  FROM auth.users
  WHERE email ILIKE '%' || search_email || '%'
  LIMIT 10;
$$;


ALTER FUNCTION "public"."find_auth_user_by_email"("search_email" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_all_system_users"() RETURNS TABLE("user_id" "uuid", "email" "text", "full_name" "text", "profile_role" "text", "has_profile" boolean)
    LANGUAGE "sql" STABLE SECURITY DEFINER
    AS $$
 SELECT 
    u.id AS user_id,
    u.email,
    COALESCE(p.full_name, '') AS full_name,
    p.role AS profile_role,
    (p.id IS NOT NULL) AS has_profile
  FROM auth.users u
  LEFT JOIN public.profiles p ON p.user_id = u.id
  ORDER BY COALESCE(p.full_name, u.email);
$$;


ALTER FUNCTION "public"."get_all_system_users"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_my_permissions"() RETURNS TABLE("permission_code" "text", "permission_name" "text", "module" "text", "data_scope" "text")
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
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
    AS $$ BEGIN
  RETURN QUERY SELECT * FROM core.get_user_permissions(p_user_id);
END;
 $$;


ALTER FUNCTION "public"."get_user_permissions"("p_user_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_user_roles_by_id"("p_target_user_id" "uuid") RETURNS TABLE("id" "uuid", "user_id" "uuid", "role_id" "uuid", "role" "text", "role_display_name" "text", "role_level" integer, "is_active" boolean, "effective_from" "date", "effective_to" "date", "delegated_from" "uuid", "created_at" timestamp with time zone, "updated_at" timestamp with time zone, "created_by" "uuid")
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    AS $$ BEGIN
  RETURN QUERY
  SELECT 
    ur.id,
    ur.user_id,
    ur.role_id,
    r.name,
    r.display_name,
    r.level,
    ur.is_active,
    ur.effective_from,
    ur.effective_to,
    ur.delegated_from,
    ur.created_at,
    ur.updated_at,
    ur.created_by
  FROM core.user_roles ur
  INNER JOIN core.roles r ON r.id = ur.role_id
  WHERE ur.user_id = p_target_user_id;
END;
 $$;


ALTER FUNCTION "public"."get_user_roles_by_id"("p_target_user_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."handle_new_user"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$ BEGIN
    INSERT INTO public.profiles (
        user_id, full_name, role, email,
        can_create_project, can_edit_project, can_delete_project,
        can_add_income, can_edit_income, can_delete_income,
        can_add_expense, can_edit_expense, can_delete_expense,
        can_create_invoice, can_edit_invoice, can_delete_invoice
    )
    VALUES (
        NEW.id, 
        COALESCE((NEW.raw_user_meta_data::jsonb)->>'full_name', ''), 
        'User',
        NEW.email,
        FALSE, FALSE, FALSE, -- Projects
        FALSE, FALSE, FALSE, -- Income
        FALSE, FALSE, FALSE, -- Expense
        FALSE, FALSE, FALSE  -- Invoices
    );
    RETURN NEW;
END;
 $$;


ALTER FUNCTION "public"."handle_new_user"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."is_admin"() RETURNS boolean
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    AS $$ 
DECLARE
    user_role TEXT;
BEGIN
    SELECT role INTO user_role 
    FROM public.profiles 
    WHERE user_id = auth.uid();
    
    RETURN COALESCE(user_role, 'User') = 'Admin';
END;
 $$;


ALTER FUNCTION "public"."is_admin"() OWNER TO "postgres";


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
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    AS $$ BEGIN
  RETURN COALESCE(json_agg(row_to_json(t)), '[]'::JSON) FROM (
    SELECT id, account_name, institution_type, currency, masked_identifier, opening_balance as balance
    FROM finance.financial_accounts WHERE is_active = true ORDER BY opening_balance DESC
  ) t;
END;
 $$;


ALTER FUNCTION "reporting"."cash_distribution"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "reporting"."ceo_chart_aging"() RETURNS json
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
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
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
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
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    AS $$ BEGIN
  RETURN COALESCE(json_agg(row_to_json(t) ORDER BY balance DESC), '[]'::JSON) FROM (
    SELECT id, account_name, institution_type, currency, masked_identifier, opening_balance as balance
    FROM finance.financial_accounts WHERE is_active = true
  ) t;
END;
 $$;


ALTER FUNCTION "reporting"."ceo_chart_cash"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "reporting"."ceo_chart_categories"() RETURNS json
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
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
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
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
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
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
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    AS $$ BEGIN
  RETURN COALESCE(json_agg(row_to_json(t)), '[]'::JSON) FROM (
    SELECT 
      al.id, al.action, al.module,
      COALESCE(al.details::text, '') as details,
      al.created_at,
      COALESCE((SELECT full_name FROM public.profiles p WHERE p.user_id = al.user_id), al.user_id::text) as user_name,
      al.table_name
    FROM audit.audit_logs al
    ORDER BY al.created_at DESC
    LIMIT 30
  ) t;
END;
 $$;


ALTER FUNCTION "reporting"."ceo_table_audit"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "reporting"."ceo_table_equity_tax"() RETURNS json
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
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
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    AS $$ BEGIN
  RETURN COALESCE(json_agg(row_to_json(t) ORDER BY ap.start_date), '[]'::JSON) FROM (
    SELECT ap.id, ap.name,
      ap.start_date, ap.end_date, ap.status,
      EXTRACT(MONTH FROM ap.start_date)::int as month_num,
      EXTRACT(MONTH FROM ap.end_date)::int - EXTRACT(MONTH FROM ap.start_date)::int + 1 as total_months
    FROM finance.accounting_periods ap
    WHERE ap.fiscal_year_id = (SELECT id FROM finance.fiscal_years WHERE is_current = true LIMIT 1)
    ORDER BY ap.start_date
  ) t;
END;
 $$;


ALTER FUNCTION "reporting"."ceo_table_fiscal"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "reporting"."get_balance_sheet"("p_as_of_date" "date") RETURNS TABLE("section_order" integer, "section" "text", "code" "text", "account_name" "text", "net_amount" numeric)
    LANGUAGE "sql" STABLE SECURITY DEFINER
    AS $$ SELECT 
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
  AND coa.account_type IN ('ASSET', 'LIABILITY', 'EQUITY')
GROUP BY coa.id, coa.report_mapping, coa.account_type, coa.code, coa.name, coa.normal_balance
HAVING CASE 
    WHEN coa.normal_balance = 'DEBIT' THEN COALESCE(SUM(jl.base_debit), 0) - COALESCE(SUM(jl.base_credit), 0)
    ELSE COALESCE(SUM(jl.base_credit), 0) - COALESCE(SUM(jl.base_debit), 0)
END != 0
ORDER BY section_order, coa.code;
 $$;


ALTER FUNCTION "reporting"."get_balance_sheet"("p_as_of_date" "date") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "reporting"."get_cash_flow"("p_start_date" "date", "p_end_date" "date") RETURNS TABLE("section" "text", "account_name" "text", "amount" numeric)
    LANGUAGE "sql" STABLE SECURITY DEFINER
    AS $$ WITH pnl_changes AS (
    -- Operating Activities: P&L items adjusted for non-cash
    SELECT 
        'OPERATING' AS section,
        coa.name AS account_name,
        SUM(CASE WHEN coa.normal_balance = 'CREDIT' THEN jl.base_credit ELSE -jl.base_debit END) AS amount
    FROM finance.journal_lines jl
    JOIN finance.journal_entries je ON je.id = jl.journal_entry_id AND je.status = 'POSTED'
    JOIN finance.accounting_periods ap ON ap.id = je.period_id
    JOIN finance.chart_of_accounts coa ON coa.id = jl.account_id
    WHERE ap.start_date >= p_start_date AND ap.end_date <= p_end_date
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
      AND coa.report_mapping IN ('BALANCE_SHEET_RECEIVABLES', 'BALANCE_SHEET_PAYABLES')
    GROUP BY coa.name
    HAVING (COALESCE(SUM(jl.base_debit), 0) - COALESCE(SUM(jl.base_credit), 0)) != 0
    
    UNION ALL
    
    -- Investing Activities (Fixed Assets)
    SELECT 
        'INVESTING' AS section,
        coa.name AS account_name,
        -1 * (COALESCE(SUM(jl.base_debit), 0) - COALESCE(SUM(jl.base_credit), 0)) AS amount
    FROM finance.journal_lines jl
    JOIN finance.journal_entries je ON je.id = jl.journal_entry_id AND je.status = 'POSTED'
    JOIN finance.accounting_periods ap ON ap.id = je.period_id
    JOIN finance.chart_of_accounts coa ON coa.id = jl.account_id
    WHERE ap.start_date >= p_start_date AND ap.end_date <= p_end_date
      AND coa.report_mapping = 'BALANCE_SHEET_FIXED_ASSETS'
    GROUP BY coa.name
    HAVING (COALESCE(SUM(jl.base_debit), 0) - COALESCE(SUM(jl.base_credit), 0)) != 0
    
    UNION ALL
    
    -- Financing Activities (Loans, Capital, Distributions)
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
      AND coa.account_type = 'EQUITY'
    GROUP BY coa.name, coa.normal_balance
    HAVING CASE WHEN coa.normal_balance = 'CREDIT' 
           THEN COALESCE(SUM(jl.base_credit), 0) - COALESCE(SUM(jl.base_debit), 0)
           ELSE -1 * (COALESCE(SUM(jl.base_debit), 0) - COALESCE(SUM(jl.base_credit), 0)) 
    END != 0
)
SELECT * FROM pnl_changes
ORDER BY 
    CASE section WHEN 'OPERATING' THEN 1 WHEN 'INVESTING' THEN 2 WHEN 'FINANCING' THEN 3 END,
    account_name;
 $$;


ALTER FUNCTION "reporting"."get_cash_flow"("p_start_date" "date", "p_end_date" "date") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "reporting"."get_ceo_metrics"() RETURNS TABLE("total_cash" numeric, "total_receivables" numeric, "total_payables" numeric, "current_month_pl" numeric)
    LANGUAGE "sql" STABLE SECURITY DEFINER
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


CREATE OR REPLACE FUNCTION "reporting"."get_profit_and_loss"("p_start_date" "date", "p_end_date" "date") RETURNS TABLE("section_order" integer, "section" "text", "code" "text", "account_name" "text", "debit_total" numeric, "credit_total" numeric, "net_amount" numeric)
    LANGUAGE "sql" STABLE SECURITY DEFINER
    AS $$ SELECT 
    CASE coa.report_mapping
        WHEN 'PROFIT_LOSS_REVENUE' THEN 1
        WHEN 'PROFIT_LOSS_COS' THEN 2
        WHEN 'PROFIT_LOSS_OP_EXPENSE' THEN 3
        WHEN 'PROFIT_LOSS_OTHER_INCOME' THEN 4
        WHEN 'PROFIT_LOSS_OTHER_EXPENSE' THEN 5
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
  AND coa.account_type IN ('REVENUE', 'COST_OF_SALES', 'OPERATING_EXPENSE', 'OTHER_INCOME', 'OTHER_EXPENSE')
GROUP BY coa.id, coa.report_mapping, coa.account_type, coa.code, coa.name, coa.normal_balance
ORDER BY section_order, coa.code;
 $$;


ALTER FUNCTION "reporting"."get_profit_and_loss"("p_start_date" "date", "p_end_date" "date") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "reporting"."get_project_profitability"("p_start_date" "date", "p_end_date" "date") RETURNS TABLE("project_id" "uuid", "project_name" "text", "total_revenue" numeric, "total_costs" numeric, "gross_profit" numeric, "margin_pct" numeric)
    LANGUAGE "sql" STABLE SECURITY DEFINER
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


CREATE OR REPLACE FUNCTION "reporting"."get_trial_balance"("p_period_ids" "uuid"[]) RETURNS TABLE("account_id" "uuid", "code" "text", "name" "text", "account_type" "text", "normal_balance" "text", "total_debit" numeric, "total_credit" numeric, "net_balance" numeric)
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
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
    AND coa.posting_allowed = true
  GROUP BY coa.id, coa.code, coa.name, coa.account_type, coa.normal_balance
  HAVING COALESCE(SUM(COALESCE(jl.base_debit, jl.debit_amount)), 0) > 0 
      OR COALESCE(SUM(COALESCE(jl.base_credit, jl.credit_amount)), 0) > 0
  ORDER BY coa.code;
END;
 $$;


ALTER FUNCTION "reporting"."get_trial_balance"("p_period_ids" "uuid"[]) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "reporting"."pending_approvals_list"() RETURNS json
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
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
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
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
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
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
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
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
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
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
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
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
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
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
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
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


CREATE TABLE IF NOT EXISTS "audit"."audit_log" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid",
    "user_email" "text",
    "user_name" "text",
    "action" "text" NOT NULL,
    "entity_type" "text" NOT NULL,
    "entity_id" "uuid",
    "description" "text",
    "old_values" "jsonb",
    "new_values" "jsonb",
    "ip_address" "inet",
    "user_agent" "text",
    "status" "text" DEFAULT 'success'::"text",
    "error_message" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "audit_log_status_check" CHECK (("status" = ANY (ARRAY['success'::"text", 'denied'::"text", 'error'::"text"])))
);


ALTER TABLE "audit"."audit_log" OWNER TO "postgres";


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
    CONSTRAINT "organization_config_decimal_precision_check" CHECK ((("decimal_precision" >= 0) AND ("decimal_precision" <= 6))),
    CONSTRAINT "organization_config_fiscal_year_end_month_check" CHECK ((("fiscal_year_end_month" >= 1) AND ("fiscal_year_end_month" <= 12))),
    CONSTRAINT "organization_config_fiscal_year_start_month_check" CHECK ((("fiscal_year_start_month" >= 1) AND ("fiscal_year_start_month" <= 12))),
    CONSTRAINT "organization_config_rounding_method_check" CHECK (("rounding_method" = ANY (ARRAY['HALF_UP'::"text", 'HALF_DOWN'::"text", 'CEILING'::"text", 'FLOOR'::"text", 'UP'::"text", 'DOWN'::"text"]))),
    CONSTRAINT "valid_fiscal_months" CHECK (("fiscal_year_start_month" <> "fiscal_year_end_month"))
);


ALTER TABLE "core"."organization_config" OWNER TO "postgres";


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
    "created_by" "uuid"
);


ALTER TABLE "core"."roles" OWNER TO "postgres";


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
    CONSTRAINT "chart_of_accounts_account_type_check" CHECK (("account_type" = ANY (ARRAY['ASSET'::"text", 'LIABILITY'::"text", 'EQUITY'::"text", 'REVENUE'::"text", 'COST_OF_SALES'::"text", 'OPERATING_EXPENSE'::"text", 'OTHER_INCOME'::"text", 'OTHER_EXPENSE'::"text"]))),
    CONSTRAINT "chart_of_accounts_level_check" CHECK ((("level" >= 0) AND ("level" <= 10))),
    CONSTRAINT "chart_of_accounts_normal_balance_check" CHECK (("normal_balance" = ANY (ARRAY['DEBIT'::"text", 'CREDIT'::"text"]))),
    CONSTRAINT "coa_level_0_no_parent" CHECK (((("level" = 0) AND ("parent_id" IS NULL)) OR ("level" > 0))),
    CONSTRAINT "coa_name_not_empty" CHECK ((TRIM(BOTH FROM "name") <> ''::"text"))
);


ALTER TABLE "finance"."chart_of_accounts" OWNER TO "postgres";


CREATE OR REPLACE VIEW "finance"."account_type_summary" AS
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
    CONSTRAINT "accounting_periods_period_number_check" CHECK ((("period_number" >= 1) AND ("period_number" <= 12))),
    CONSTRAINT "accounting_periods_status_check" CHECK (("status" = ANY (ARRAY['PENDING'::"text", 'OPEN'::"text", 'SOFT_CLOSED'::"text", 'HARD_CLOSED'::"text"]))),
    CONSTRAINT "ap_dates_valid" CHECK (("end_date" > "start_date")),
    CONSTRAINT "ap_name_not_empty" CHECK ((TRIM(BOTH FROM "name") <> ''::"text")),
    CONSTRAINT "ap_reopening_requires_reason" CHECK (((("status" <> ALL (ARRAY['PENDING'::"text", 'OPEN'::"text"])) AND ("reopening_reason" IS NOT NULL)) OR ("status" = ANY (ARRAY['PENDING'::"text", 'OPEN'::"text"]))))
);


ALTER TABLE "finance"."accounting_periods" OWNER TO "postgres";


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
    CONSTRAINT "bank_transfers_exchange_rate_check" CHECK (("exchange_rate" > (0)::numeric)),
    CONSTRAINT "bank_transfers_from_amount_check" CHECK (("from_amount" > (0)::numeric)),
    CONSTRAINT "bank_transfers_status_check" CHECK (("status" = ANY (ARRAY['DRAFT'::"text", 'SUBMITTED'::"text", 'APPROVED'::"text", 'POSTED'::"text", 'REVERSED'::"text", 'REJECTED'::"text", 'CANCELLED'::"text"]))),
    CONSTRAINT "bank_transfers_to_amount_check" CHECK (("to_amount" > (0)::numeric)),
    CONSTRAINT "chk_diff_accounts" CHECK (("from_account_id" <> "to_account_id"))
);


ALTER TABLE "finance"."bank_transfers" OWNER TO "postgres";


CREATE OR REPLACE VIEW "finance"."coa_tree" AS
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
    "invoice_id" "uuid" NOT NULL,
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
    CONSTRAINT "credit_notes_amount_check" CHECK (("amount" > (0)::numeric)),
    CONSTRAINT "credit_notes_status_check" CHECK (("status" = ANY (ARRAY['DRAFT'::"text", 'APPROVED'::"text", 'POSTED'::"text", 'REVERSED'::"text"])))
);


ALTER TABLE "finance"."credit_notes" OWNER TO "postgres";


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
    CONSTRAINT "exchange_rates_rate_type_check" CHECK (("rate_type" = ANY (ARRAY['PLATFORM'::"text", 'BANK'::"text", 'MANUAL'::"text", 'PAYMENT_CHANNEL'::"text"])))
);


ALTER TABLE "finance"."exchange_rates" OWNER TO "postgres";


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
    "details" "jsonb" DEFAULT '{}'::"jsonb"
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
    CONSTRAINT "fee_rules_applies_to_check" CHECK ((("applies_to")::"text" = ANY ((ARRAY['EXPENSE'::character varying, 'INVOICE'::character varying, 'VENDOR_BILL'::character varying, 'PAYMENT_RECEIPT'::character varying, 'ALL'::character varying])::"text"[]))),
    CONSTRAINT "fee_rules_fee_type_check" CHECK ((("fee_type")::"text" = ANY ((ARRAY['PERCENTAGE'::character varying, 'FIXED'::character varying, 'TIERED'::character varying, 'SLAB'::character varying])::"text"[])))
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
    CONSTRAINT "financial_accounts_account_type_check" CHECK (("account_type" = ANY (ARRAY['CURRENT'::"text", 'SAVINGS'::"text", 'DIGITAL_WALLET'::"text", 'PLATFORM_BALANCE'::"text", 'PETTY_CASH'::"text", 'CLEARING'::"text"]))),
    CONSTRAINT "financial_accounts_institution_type_check" CHECK (("institution_type" = ANY (ARRAY['BANK'::"text", 'CASH'::"text", 'WALLET'::"text", 'PLATFORM'::"text", 'PAYMENT_GATEWAY'::"text", 'CARD'::"text", 'CLEARING'::"text"]))),
    CONSTRAINT "financial_accounts_reconciliation_method_check" CHECK (("reconciliation_method" = ANY (ARRAY['MANUAL'::"text", 'AUTO'::"text", 'IMPORT'::"text"])))
);


ALTER TABLE "finance"."financial_accounts" OWNER TO "postgres";


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
    CONSTRAINT "fiscal_years_status_check" CHECK (("status" = ANY (ARRAY['OPEN'::"text", 'SOFT_CLOSED'::"text", 'HARD_CLOSED'::"text"]))),
    CONSTRAINT "fy_dates_valid" CHECK (("end_date" > "start_date")),
    CONSTRAINT "fy_name_not_empty" CHECK ((TRIM(BOTH FROM "name") <> ''::"text")),
    CONSTRAINT "fy_reopening_requires_reason" CHECK (((("status" <> 'OPEN'::"text") AND ("reopening_reason" IS NOT NULL)) OR ("status" = 'OPEN'::"text")))
);


ALTER TABLE "finance"."fiscal_years" OWNER TO "postgres";


CREATE OR REPLACE VIEW "finance"."fiscal_year_summary" AS
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
    CONSTRAINT "ns_current_non_negative" CHECK (("current_number" >= 0)),
    CONSTRAINT "ns_format_valid" CHECK ((("format" ~~ '%{PREFIX}%'::"text") AND ("format" ~~ '%{NUMBER}%'::"text"))),
    CONSTRAINT "numbering_sequences_padding_check" CHECK ((("padding" >= 1) AND ("padding" <= 10)))
);


ALTER TABLE "finance"."numbering_sequences" OWNER TO "postgres";


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
    CONSTRAINT "payment_allocations_allocated_amount_check" CHECK (("allocated_amount" > (0)::numeric))
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
    CONSTRAINT "payment_receipts_amount_check" CHECK (("amount" >= (0)::numeric)),
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
    CONSTRAINT "platforms_platform_type_check" CHECK ((("platform_type")::"text" = ANY ((ARRAY['PAYMENT_GATEWAY'::character varying, 'BANK_TRANSFER'::character varying, 'MARKETPLACE'::character varying, 'WALLET'::character varying, 'OTHER'::character varying])::"text"[])))
);


ALTER TABLE "finance"."platforms" OWNER TO "postgres";


CREATE OR REPLACE VIEW "finance"."postable_accounts" AS
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
    CONSTRAINT "reserve_policies_policy_type_check" CHECK (("policy_type" = ANY (ARRAY['DISABLED'::"text", 'FIXED_AMOUNT'::"text", 'PERCENT_OF_PROFIT'::"text", 'PERCENT_OF_PAYOUT'::"text", 'TARGET_BALANCE'::"text", 'HYBRID'::"text"])))
);


ALTER TABLE "finance"."reserve_policies" OWNER TO "postgres";


CREATE OR REPLACE VIEW "finance"."sequence_status" AS
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
    CONSTRAINT "tax_adjustments_adjustment_category_check" CHECK (("adjustment_category" = ANY (ARRAY['ADD_BACK'::"text", 'DEDUCTION'::"text", 'NON_DEDUCTIBLE'::"text", 'EXEMPTION'::"text", 'DEPRECIATION_DIFF'::"text", 'PROVISION_ADJUST'::"text", 'PRIVATE_EXPENSE'::"text", 'CAPITAL_VS_REVENUE'::"text", 'LOSS_CARRY_FORWARD'::"text", 'SEPARATE_BLOCK'::"text", 'TAX_DEPRECIATION'::"text", 'OTHER'::"text"])))
);


ALTER TABLE "finance"."tax_adjustments" OWNER TO "postgres";


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
    CONSTRAINT "tax_reconciliations_status_check" CHECK (("status" = ANY (ARRAY['DRAFT'::"text", 'CALCULATED'::"text", 'UNDER_REVIEW'::"text", 'ACCOUNTANT_APPROVED'::"text", 'FILED'::"text", 'PAYMENT_PENDING'::"text", 'PAID'::"text", 'REFUND_PENDING'::"text", 'AMENDED'::"text", 'CLOSED'::"text"])))
);


ALTER TABLE "finance"."tax_reconciliations" OWNER TO "postgres";


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
    CONSTRAINT "taxpayer_profile_legal_entity_type_check" CHECK (("legal_entity_type" = ANY (ARRAY['SOLE_PROPRIETOR'::"text", 'AOP'::"text", 'COMPANY'::"text", 'INDIVIDUAL'::"text"]))),
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
    CONSTRAINT "vendor_payment_allocations_allocated_amount_check" CHECK (("allocated_amount" > (0)::numeric))
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
    "created_by" "uuid"
);


ALTER TABLE "finance"."vendors" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."budget_lines" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "budget_id" "uuid" NOT NULL,
    "account_id" "uuid",
    "line_description" "text",
    "allocated_amount" numeric(18,2) DEFAULT 0 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "created_by" "uuid"
);


ALTER TABLE "public"."budget_lines" OWNER TO "postgres";


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
    CONSTRAINT "budgets_total_amount_check" CHECK (("total_amount" >= (0)::numeric))
);


ALTER TABLE "public"."budgets" OWNER TO "postgres";


COMMENT ON COLUMN "public"."budgets"."control_account_id" IS 'GL control account that tracks budget allocations. Debit = allocation, Credit = utilization.';



COMMENT ON COLUMN "public"."budgets"."variance_alert_threshold" IS 'Percentage (0-100) at which variance alerts trigger. Default 80%.';



CREATE OR REPLACE VIEW "public"."chart_of_accounts" AS
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
    CONSTRAINT "clients_status_check" CHECK (("status" = ANY (ARRAY['ACTIVE'::"text", 'INACTIVE'::"text"])))
);


ALTER TABLE "public"."clients" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."coa_tree" AS
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


CREATE OR REPLACE VIEW "public"."credit_notes" AS
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


CREATE OR REPLACE VIEW "public"."exchange_rates" AS
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
    CONSTRAINT "expenses_status_check" CHECK (("status" = ANY (ARRAY['DRAFT'::"text", 'SUBMITTED'::"text", 'VERIFIED'::"text", 'APPROVED'::"text", 'POSTED'::"text", 'REVERSED'::"text", 'REJECTED'::"text", 'CANCELLED'::"text"])))
);


ALTER TABLE "public"."expenses" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."financial_accounts" (
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
    CONSTRAINT "financial_accounts_account_type_check" CHECK (("account_type" = ANY (ARRAY['BANK'::"text", 'CASH'::"text", 'MOBILE_WALLET'::"text", 'OTHER'::"text"]))),
    CONSTRAINT "financial_accounts_status_check" CHECK (("status" = ANY (ARRAY['ACTIVE'::"text", 'INACTIVE'::"text"])))
);


ALTER TABLE "public"."financial_accounts" OWNER TO "postgres";


CREATE OR REPLACE VIEW "reporting"."general_ledger" AS
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


CREATE OR REPLACE VIEW "public"."general_ledger" AS
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
    CONSTRAINT "incomes_status_check" CHECK (("status" = ANY (ARRAY['DRAFT'::"text", 'SUBMITTED'::"text", 'VERIFIED'::"text", 'APPROVED'::"text", 'POSTED'::"text", 'REVERSED'::"text", 'REJECTED'::"text", 'CANCELLED'::"text"])))
);


ALTER TABLE "public"."incomes" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."invoices" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "project_id" "uuid",
    "invoice_number" character varying(50) NOT NULL,
    "client_name" character varying(255) NOT NULL,
    "amount" numeric(12,2) NOT NULL,
    "status" character varying(50) DEFAULT 'Draft'::character varying,
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
    CONSTRAINT "invoices_status_check" CHECK ((("status")::"text" = ANY ((ARRAY['DRAFT'::character varying, 'SUBMITTED'::character varying, 'APPROVED'::character varying, 'ISSUED'::character varying, 'PARTIALLY_PAID'::character varying, 'PAID'::character varying, 'OVERDUE'::character varying, 'VOID'::character varying, 'REVERSED'::character varying, 'Draft'::character varying, 'Pending'::character varying, 'Paid'::character varying])::"text"[])))
);


ALTER TABLE "public"."invoices" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."journal_entries" AS
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


CREATE OR REPLACE VIEW "public"."journal_lines" AS
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


CREATE TABLE IF NOT EXISTS "public"."notifications" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "title" character varying(255) NOT NULL,
    "message" "text" NOT NULL,
    "is_read" boolean DEFAULT false,
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."notifications" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."numbering_sequences" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "document_type" "text" NOT NULL,
    "prefix" "text" DEFAULT ''::"text",
    "next_number" integer DEFAULT 1,
    "pad_length" integer DEFAULT 5,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."numbering_sequences" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."organization_config" AS
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


CREATE OR REPLACE VIEW "public"."payment_allocations" AS
 SELECT "id",
    "payment_receipt_id",
    "invoice_id",
    "allocated_amount",
    "base_allocated_amount",
    "allocated_by",
    "allocated_at"
   FROM "finance"."payment_allocations";


ALTER VIEW "public"."payment_allocations" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."payment_receipts" AS
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
    CONSTRAINT "payments_amount_check" CHECK (("amount" >= (0)::numeric)),
    CONSTRAINT "payments_status_check" CHECK (("status" = ANY (ARRAY['Pending'::"text", 'Paid'::"text", 'Partial Payment'::"text", 'Overdue'::"text"])))
);


ALTER TABLE "public"."payments" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."permissions" AS
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


CREATE OR REPLACE VIEW "public"."postable_accounts" AS
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
    "role" "text" DEFAULT 'User'::"text" NOT NULL,
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
    CONSTRAINT "profiles_role_check" CHECK (("role" = ANY (ARRAY['CEO'::"text", 'FINANCE_HEAD'::"text", 'ACCOUNTANT'::"text", 'PROJECT_MANAGER'::"text", 'EMPLOYEE'::"text", 'VIEWER'::"text"])))
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
    CONSTRAINT "projects_status_check" CHECK ((("status")::"text" = ANY ((ARRAY['Active'::character varying, 'Completed'::character varying, 'On Hold'::character varying])::"text"[])))
);


ALTER TABLE "public"."projects" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."role_permissions" AS
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


CREATE OR REPLACE VIEW "public"."roles" AS
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


CREATE TABLE IF NOT EXISTS "public"."tax_returns" (
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


ALTER TABLE "public"."tax_returns" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."user_roles" AS
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


CREATE OR REPLACE VIEW "public"."v_audit_log" AS
 SELECT "id",
    "user_id",
    "user_email",
    "user_name",
    "action",
    "entity_type",
    "entity_id",
    "description",
    "old_values",
    "new_values",
    ("ip_address")::"text" AS "ip_address",
    "user_agent",
    "status",
    "error_message",
    "created_at"
   FROM "audit"."audit_log";


ALTER VIEW "public"."v_audit_log" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."v_permissions" AS
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


CREATE OR REPLACE VIEW "public"."v_role_permissions" AS
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


CREATE OR REPLACE VIEW "public"."v_roles" AS
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


CREATE OR REPLACE VIEW "public"."v_user_roles" AS
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


CREATE OR REPLACE VIEW "reporting"."budget_vs_actual" AS
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
    ("b"."total_amount" - COALESCE("sum"(
        CASE
            WHEN ("coa"."normal_balance" = 'DEBIT'::"text") THEN (COALESCE("jl"."base_debit", "jl"."debit_amount") - COALESCE("jl"."base_credit", "jl"."credit_amount"))
            ELSE (COALESCE("jl"."base_credit", "jl"."credit_amount") - COALESCE("jl"."base_debit", "jl"."debit_amount"))
        END), (0)::numeric)) AS "remaining_amount",
        CASE
            WHEN ("b"."total_amount" = (0)::numeric) THEN (0)::numeric
            ELSE "round"(((COALESCE("sum"(
            CASE
                WHEN ("coa"."normal_balance" = 'DEBIT'::"text") THEN (COALESCE("jl"."base_debit", "jl"."debit_amount") - COALESCE("jl"."base_credit", "jl"."credit_amount"))
                ELSE (COALESCE("jl"."base_credit", "jl"."credit_amount") - COALESCE("jl"."base_debit", "jl"."debit_amount"))
            END), (0)::numeric) / "b"."total_amount") * (100)::numeric), 2)
        END AS "utilization_pct",
    "p"."id" AS "project_id",
    "p"."name" AS "project_name"
   FROM (((("public"."budgets" "b"
     LEFT JOIN "public"."projects" "p" ON (("p"."budget_id" = "b"."id")))
     LEFT JOIN "finance"."journal_entries" "je" ON ((("je"."project_id" = "p"."id") AND ("je"."status" = 'POSTED'::"text") AND ("je"."source_type" = 'EXPENSE'::"text"))))
     LEFT JOIN "finance"."journal_lines" "jl" ON (("jl"."journal_entry_id" = "je"."id")))
     LEFT JOIN "finance"."chart_of_accounts" "coa" ON ((("coa"."id" = "jl"."account_id") AND ("coa"."account_type" = ANY (ARRAY['EXPENSE'::"text", 'COST_OF_SALES'::"text"])))))
  GROUP BY "b"."id", "b"."name", "b"."category", "b"."total_amount", "b"."start_date", "b"."end_date", "p"."id", "p"."name";


ALTER VIEW "reporting"."budget_vs_actual" OWNER TO "postgres";


CREATE OR REPLACE VIEW "reporting"."budget_category_summary" AS
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


CREATE OR REPLACE VIEW "reporting"."budget_gl_actual" AS
 SELECT "bl"."id" AS "budget_line_id",
    "bl"."budget_id",
    "b"."name" AS "budget_name",
    "bl"."account_id",
    "coa"."code" AS "account_code",
    "coa"."name" AS "account_name",
    "bl"."allocated_amount",
    COALESCE("sum"(
        CASE
            WHEN ("coa"."normal_balance" = 'DEBIT'::"text") THEN (COALESCE("jl"."base_debit", "jl"."debit_amount") - COALESCE("jl"."base_credit", "jl"."credit_amount"))
            ELSE (COALESCE("jl"."base_credit", "jl"."credit_amount") - COALESCE("jl"."base_debit", "jl"."debit_amount"))
        END), (0)::numeric) AS "actual_spent",
    ("bl"."allocated_amount" - COALESCE("sum"(
        CASE
            WHEN ("coa"."normal_balance" = 'DEBIT'::"text") THEN (COALESCE("jl"."base_debit", "jl"."debit_amount") - COALESCE("jl"."base_credit", "jl"."credit_amount"))
            ELSE (COALESCE("jl"."base_credit", "jl"."credit_amount") - COALESCE("jl"."base_debit", "jl"."debit_amount"))
        END), (0)::numeric)) AS "remaining"
   FROM (((("public"."budget_lines" "bl"
     JOIN "public"."budgets" "b" ON (("b"."id" = "bl"."budget_id")))
     LEFT JOIN "finance"."chart_of_accounts" "coa" ON (("coa"."id" = "bl"."account_id")))
     LEFT JOIN "finance"."journal_lines" "jl" ON (("jl"."account_id" = "bl"."account_id")))
     LEFT JOIN "finance"."journal_entries" "je" ON ((("je"."id" = "jl"."journal_entry_id") AND ("je"."status" = 'POSTED'::"text") AND ("je"."transaction_date" >= "b"."start_date") AND (("je"."transaction_date" <= "b"."end_date") OR ("b"."end_date" IS NULL)))))
  GROUP BY "bl"."id", "bl"."budget_id", "b"."name", "bl"."account_id", "coa"."code", "coa"."name", "bl"."allocated_amount";


ALTER VIEW "reporting"."budget_gl_actual" OWNER TO "postgres";


CREATE OR REPLACE VIEW "reporting"."payable_aging" AS
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


CREATE OR REPLACE VIEW "reporting"."receivable_aging" AS
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


CREATE OR REPLACE VIEW "reporting"."reconciliation_summary" AS
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


CREATE OR REPLACE VIEW "reporting"."unreconciled_lines" AS
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
    "fa"."masked_identifier"
   FROM (("finance"."statement_lines" "sl"
     JOIN "finance"."bank_statements" "bs" ON (("bs"."id" = "sl"."bank_statement_id")))
     JOIN "finance"."financial_accounts" "fa" ON (("fa"."id" = "bs"."financial_account_id")))
  WHERE ("sl"."reconciliation_status" = 'UNRECONCILED'::"text")
  ORDER BY "sl"."transaction_date" DESC, "fa"."account_name";


ALTER VIEW "reporting"."unreconciled_lines" OWNER TO "postgres";


ALTER TABLE ONLY "audit"."audit_log"
    ADD CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "core"."organization_config"
    ADD CONSTRAINT "organization_config_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "core"."permissions"
    ADD CONSTRAINT "permissions_code_key" UNIQUE ("code");



ALTER TABLE ONLY "core"."permissions"
    ADD CONSTRAINT "permissions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "core"."role_permissions"
    ADD CONSTRAINT "role_permissions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "core"."roles"
    ADD CONSTRAINT "roles_name_key" UNIQUE ("name");



ALTER TABLE ONLY "core"."roles"
    ADD CONSTRAINT "roles_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "core"."role_permissions"
    ADD CONSTRAINT "rp_unique" UNIQUE ("role_id", "permission_id", "effective_from");



ALTER TABLE ONLY "core"."user_roles"
    ADD CONSTRAINT "ur_user_role_unique" UNIQUE ("user_id", "role_id", "effective_from");



ALTER TABLE ONLY "core"."user_roles"
    ADD CONSTRAINT "user_roles_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "finance"."accounting_periods"
    ADD CONSTRAINT "accounting_periods_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "finance"."accounting_periods"
    ADD CONSTRAINT "ap_fy_period_unique" UNIQUE ("fiscal_year_id", "period_number");



ALTER TABLE ONLY "finance"."bank_statements"
    ADD CONSTRAINT "bank_statements_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "finance"."bank_transfers"
    ADD CONSTRAINT "bank_transfers_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "finance"."chart_of_accounts"
    ADD CONSTRAINT "chart_of_accounts_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "finance"."chart_of_accounts"
    ADD CONSTRAINT "coa_code_unique" UNIQUE ("code");



ALTER TABLE ONLY "finance"."credit_notes"
    ADD CONSTRAINT "credit_notes_credit_note_number_key" UNIQUE ("credit_note_number");



ALTER TABLE ONLY "finance"."credit_notes"
    ADD CONSTRAINT "credit_notes_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "finance"."distribution_lines"
    ADD CONSTRAINT "distribution_lines_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "finance"."exchange_rates"
    ADD CONSTRAINT "exchange_rates_pkey" PRIMARY KEY ("id");



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



ALTER TABLE ONLY "finance"."statement_lines"
    ADD CONSTRAINT "statement_lines_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "finance"."tax_adjustments"
    ADD CONSTRAINT "tax_adjustments_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "finance"."tax_reconciliations"
    ADD CONSTRAINT "tax_reconciliations_pkey" PRIMARY KEY ("id");



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
    ADD CONSTRAINT "vendor_bills_bill_number_key" UNIQUE ("bill_number");



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



ALTER TABLE ONLY "public"."budget_lines"
    ADD CONSTRAINT "budget_lines_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."budgets"
    ADD CONSTRAINT "budgets_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."clients"
    ADD CONSTRAINT "clients_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."expenses"
    ADD CONSTRAINT "expenses_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."financial_accounts"
    ADD CONSTRAINT "financial_accounts_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."incomes"
    ADD CONSTRAINT "incomes_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."invoices"
    ADD CONSTRAINT "invoices_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."notifications"
    ADD CONSTRAINT "notifications_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."numbering_sequences"
    ADD CONSTRAINT "numbering_sequences_document_type_key" UNIQUE ("document_type");



ALTER TABLE ONLY "public"."numbering_sequences"
    ADD CONSTRAINT "numbering_sequences_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."payments"
    ADD CONSTRAINT "payments_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_user_id_key" UNIQUE ("user_id");



ALTER TABLE ONLY "public"."projects"
    ADD CONSTRAINT "projects_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."tax_returns"
    ADD CONSTRAINT "tax_returns_pkey" PRIMARY KEY ("id");



CREATE INDEX "idx_audit_log_action" ON "audit"."audit_log" USING "btree" ("action");



CREATE INDEX "idx_audit_log_created_at" ON "audit"."audit_log" USING "btree" ("created_at" DESC);



CREATE INDEX "idx_audit_log_entity" ON "audit"."audit_log" USING "btree" ("entity_type", "entity_id");



CREATE INDEX "idx_audit_log_status" ON "audit"."audit_log" USING "btree" ("status");



CREATE INDEX "idx_audit_log_user_id" ON "audit"."audit_log" USING "btree" ("user_id");



CREATE INDEX "idx_org_config_active" ON "core"."organization_config" USING "btree" ("active");



CREATE INDEX "idx_perm_code" ON "core"."permissions" USING "btree" ("code");



CREATE INDEX "idx_rp_role" ON "core"."role_permissions" USING "btree" ("role_id");



CREATE INDEX "idx_ur_role" ON "core"."user_roles" USING "btree" ("role_id");



CREATE INDEX "idx_ur_user" ON "core"."user_roles" USING "btree" ("user_id");



CREATE INDEX "idx_alloc_invoice" ON "finance"."payment_allocations" USING "btree" ("invoice_id");



CREATE INDEX "idx_alloc_payment" ON "finance"."payment_allocations" USING "btree" ("payment_receipt_id");



CREATE INDEX "idx_ap_dates" ON "finance"."accounting_periods" USING "btree" ("start_date", "end_date");



CREATE INDEX "idx_ap_fy_id" ON "finance"."accounting_periods" USING "btree" ("fiscal_year_id");



CREATE INDEX "idx_ap_period_number" ON "finance"."accounting_periods" USING "btree" ("fiscal_year_id", "period_number");



CREATE INDEX "idx_ap_status" ON "finance"."accounting_periods" USING "btree" ("status");



CREATE INDEX "idx_bs_account" ON "finance"."bank_statements" USING "btree" ("financial_account_id");



CREATE INDEX "idx_bs_date" ON "finance"."bank_statements" USING "btree" ("statement_date");



CREATE INDEX "idx_bt_date" ON "finance"."bank_transfers" USING "btree" ("transfer_date");



CREATE INDEX "idx_bt_from" ON "finance"."bank_transfers" USING "btree" ("from_account_id");



CREATE INDEX "idx_bt_status" ON "finance"."bank_transfers" USING "btree" ("status");



CREATE INDEX "idx_bt_to" ON "finance"."bank_transfers" USING "btree" ("to_account_id");



CREATE INDEX "idx_coa_account_type" ON "finance"."chart_of_accounts" USING "btree" ("account_type");



CREATE INDEX "idx_coa_code" ON "finance"."chart_of_accounts" USING "btree" ("code");



CREATE INDEX "idx_coa_is_active" ON "finance"."chart_of_accounts" USING "btree" ("is_active");



CREATE INDEX "idx_coa_level" ON "finance"."chart_of_accounts" USING "btree" ("level");



CREATE INDEX "idx_coa_parent_id" ON "finance"."chart_of_accounts" USING "btree" ("parent_id");



CREATE INDEX "idx_dl_dist" ON "finance"."distribution_lines" USING "btree" ("profit_distribution_id");



CREATE INDEX "idx_fa_active" ON "finance"."financial_accounts" USING "btree" ("is_active");



CREATE INDEX "idx_fa_currency" ON "finance"."financial_accounts" USING "btree" ("currency");



CREATE INDEX "idx_fa_ledger" ON "finance"."financial_accounts" USING "btree" ("linked_ledger_account_id");



CREATE INDEX "idx_fa_type" ON "finance"."financial_accounts" USING "btree" ("institution_type");



CREATE INDEX "idx_fx_rate_date" ON "finance"."exchange_rates" USING "btree" ("rate_date" DESC);



CREATE INDEX "idx_fy_dates" ON "finance"."fiscal_years" USING "btree" ("start_date", "end_date");



CREATE INDEX "idx_fy_status" ON "finance"."fiscal_years" USING "btree" ("status");



CREATE INDEX "idx_je_created_by" ON "finance"."journal_entries" USING "btree" ("created_by");



CREATE INDEX "idx_je_date" ON "finance"."journal_entries" USING "btree" ("transaction_date" DESC);



CREATE INDEX "idx_je_period" ON "finance"."journal_entries" USING "btree" ("period_id");



CREATE INDEX "idx_je_project" ON "finance"."journal_entries" USING "btree" ("project_id");



CREATE INDEX "idx_je_source" ON "finance"."journal_entries" USING "btree" ("source_type", "source_id");



CREATE INDEX "idx_je_status" ON "finance"."journal_entries" USING "btree" ("status");



CREATE INDEX "idx_jl_account_id" ON "finance"."journal_lines" USING "btree" ("account_id");



CREATE INDEX "idx_jl_entry_id" ON "finance"."journal_lines" USING "btree" ("journal_entry_id");



CREATE INDEX "idx_ns_type" ON "finance"."numbering_sequences" USING "btree" ("sequence_type");



CREATE UNIQUE INDEX "idx_ns_type_fy_unique" ON "finance"."numbering_sequences" USING "btree" ("sequence_type", COALESCE(("fiscal_year_id")::"text", 'GLOBAL'::"text"));



CREATE INDEX "idx_oh_owner" ON "finance"."ownership_history" USING "btree" ("owner_id");



CREATE INDEX "idx_pd_fy" ON "finance"."profit_distributions" USING "btree" ("fiscal_year_id");



CREATE INDEX "idx_sl_amount" ON "finance"."statement_lines" USING "btree" ("amount");



CREATE INDEX "idx_sl_date" ON "finance"."statement_lines" USING "btree" ("transaction_date");



CREATE INDEX "idx_sl_journal" ON "finance"."statement_lines" USING "btree" ("matched_journal_line_id") WHERE ("matched_journal_line_id" IS NOT NULL);



CREATE INDEX "idx_sl_recon" ON "finance"."statement_lines" USING "btree" ("reconciliation_status");



CREATE INDEX "idx_sl_statement" ON "finance"."statement_lines" USING "btree" ("bank_statement_id");



CREATE INDEX "idx_sl_unreconciled" ON "finance"."statement_lines" USING "btree" ("bank_statement_id", "reconciliation_status") WHERE ("reconciliation_status" = 'UNRECONCILED'::"text");



CREATE INDEX "idx_ta_category" ON "finance"."tax_adjustments" USING "btree" ("adjustment_category");



CREATE INDEX "idx_ta_recon" ON "finance"."tax_adjustments" USING "btree" ("tax_reconciliation_id");



CREATE INDEX "idx_tr_fy" ON "finance"."tax_reconciliations" USING "btree" ("fiscal_year_id");



CREATE INDEX "idx_tr_rule" ON "finance"."tax_reconciliations" USING "btree" ("tax_rule_set_id");



CREATE INDEX "idx_tr_status" ON "finance"."tax_reconciliations" USING "btree" ("status");



CREATE INDEX "idx_ts_rule" ON "finance"."tax_slabs" USING "btree" ("tax_rule_set_id");



CREATE INDEX "idx_ts_sort" ON "finance"."tax_slabs" USING "btree" ("tax_rule_set_id", "sort_order");



CREATE INDEX "idx_vb_vendor" ON "finance"."vendor_bills" USING "btree" ("vendor_id");



CREATE INDEX "idx_vbl_bill" ON "finance"."vendor_bill_lines" USING "btree" ("vendor_bill_id");



CREATE INDEX "idx_vendors_code" ON "finance"."vendors" USING "btree" ("vendor_code");



CREATE INDEX "idx_vp_vendor" ON "finance"."vendor_payments" USING "btree" ("vendor_id");



CREATE INDEX "idx_vpa_payment" ON "finance"."vendor_payment_allocations" USING "btree" ("vendor_payment_id");



CREATE UNIQUE INDEX "unique_exchange_rate" ON "finance"."exchange_rates" USING "btree" ("from_currency", "to_currency", "rate_date", "rate_type", "source_platform");



CREATE INDEX "idx_expenses_date" ON "public"."expenses" USING "btree" ("expense_date" DESC);



CREATE INDEX "idx_expenses_project_id" ON "public"."expenses" USING "btree" ("project_id");



CREATE INDEX "idx_expenses_user_id" ON "public"."expenses" USING "btree" ("user_id");



CREATE INDEX "idx_incomes_date" ON "public"."incomes" USING "btree" ("income_date" DESC);



CREATE INDEX "idx_incomes_project_id" ON "public"."incomes" USING "btree" ("project_id");



CREATE INDEX "idx_incomes_user_id" ON "public"."incomes" USING "btree" ("user_id");



CREATE INDEX "idx_invoices_due_date" ON "public"."invoices" USING "btree" ("due_date");



CREATE INDEX "idx_invoices_project_id" ON "public"."invoices" USING "btree" ("project_id");



CREATE INDEX "idx_invoices_status" ON "public"."invoices" USING "btree" ("status");



CREATE INDEX "idx_invoices_user_id" ON "public"."invoices" USING "btree" ("user_id");



CREATE INDEX "idx_profiles_role" ON "public"."profiles" USING "btree" ("role");



CREATE INDEX "idx_profiles_user_id" ON "public"."profiles" USING "btree" ("user_id");



CREATE INDEX "idx_projects_status" ON "public"."projects" USING "btree" ("status");



CREATE INDEX "idx_projects_user_id" ON "public"."projects" USING "btree" ("user_id");



CREATE OR REPLACE TRIGGER "org_config_audit" AFTER INSERT OR DELETE OR UPDATE ON "core"."organization_config" FOR EACH ROW EXECUTE FUNCTION "audit"."trigger_audit_log"();



CREATE OR REPLACE TRIGGER "org_config_updated_at" BEFORE UPDATE ON "core"."organization_config" FOR EACH ROW EXECUTE FUNCTION "core"."set_updated_at"();



CREATE OR REPLACE TRIGGER "perm_updated_at" BEFORE UPDATE ON "core"."permissions" FOR EACH ROW EXECUTE FUNCTION "core"."set_updated_at"();



CREATE OR REPLACE TRIGGER "role_updated_at" BEFORE UPDATE ON "core"."roles" FOR EACH ROW EXECUTE FUNCTION "core"."set_updated_at"();



CREATE OR REPLACE TRIGGER "rp_updated_at" BEFORE UPDATE ON "core"."role_permissions" FOR EACH ROW EXECUTE FUNCTION "core"."set_updated_at"();



CREATE OR REPLACE TRIGGER "ur_updated_at" BEFORE UPDATE ON "core"."user_roles" FOR EACH ROW EXECUTE FUNCTION "core"."set_updated_at"();



CREATE OR REPLACE TRIGGER "ap_updated_at" BEFORE UPDATE ON "finance"."accounting_periods" FOR EACH ROW EXECUTE FUNCTION "core"."set_updated_at"();



CREATE OR REPLACE TRIGGER "chk_maker_checker" BEFORE UPDATE ON "finance"."journal_entries" FOR EACH ROW EXECUTE FUNCTION "finance"."enforce_maker_checker"();



CREATE OR REPLACE TRIGGER "chk_maker_checker" BEFORE UPDATE ON "finance"."vendor_bills" FOR EACH ROW EXECUTE FUNCTION "finance"."enforce_maker_checker"();



CREATE OR REPLACE TRIGGER "coa_audit" AFTER INSERT OR DELETE OR UPDATE ON "finance"."chart_of_accounts" FOR EACH ROW EXECUTE FUNCTION "audit"."trigger_audit_log"();



CREATE OR REPLACE TRIGGER "coa_updated_at" BEFORE UPDATE ON "finance"."chart_of_accounts" FOR EACH ROW EXECUTE FUNCTION "core"."set_updated_at"();



CREATE OR REPLACE TRIGGER "dl_uat" BEFORE UPDATE ON "finance"."distribution_lines" FOR EACH ROW EXECUTE FUNCTION "finance"."fn_tax_updated_at"();



CREATE OR REPLACE TRIGGER "fy_updated_at" BEFORE UPDATE ON "finance"."fiscal_years" FOR EACH ROW EXECUTE FUNCTION "core"."set_updated_at"();



CREATE OR REPLACE TRIGGER "je_updated_at" BEFORE UPDATE ON "finance"."journal_entries" FOR EACH ROW EXECUTE FUNCTION "core"."set_updated_at"();



CREATE OR REPLACE TRIGGER "jl_updated_at" BEFORE UPDATE ON "finance"."journal_lines" FOR EACH ROW EXECUTE FUNCTION "core"."set_updated_at"();



CREATE OR REPLACE TRIGGER "ns_updated_at" BEFORE UPDATE ON "finance"."numbering_sequences" FOR EACH ROW EXECUTE FUNCTION "core"."set_updated_at"();



CREATE OR REPLACE TRIGGER "o_uat" BEFORE UPDATE ON "finance"."owners" FOR EACH ROW EXECUTE FUNCTION "finance"."fn_tax_updated_at"();



CREATE OR REPLACE TRIGGER "oh_uat" BEFORE UPDATE ON "finance"."ownership_history" FOR EACH ROW EXECUTE FUNCTION "finance"."fn_tax_updated_at"();



CREATE OR REPLACE TRIGGER "pd_uat" BEFORE UPDATE ON "finance"."profit_distributions" FOR EACH ROW EXECUTE FUNCTION "finance"."fn_tax_updated_at"();



CREATE OR REPLACE TRIGGER "rp_uat" BEFORE UPDATE ON "finance"."reserve_policies" FOR EACH ROW EXECUTE FUNCTION "finance"."fn_tax_updated_at"();



CREATE OR REPLACE TRIGGER "ta_uat" BEFORE UPDATE ON "finance"."tax_adjustments" FOR EACH ROW EXECUTE FUNCTION "finance"."fn_tax_updated_at"();



CREATE OR REPLACE TRIGGER "tp_uat" BEFORE UPDATE ON "finance"."taxpayer_profile" FOR EACH ROW EXECUTE FUNCTION "finance"."fn_tax_updated_at"();



CREATE OR REPLACE TRIGGER "tr_uat" BEFORE UPDATE ON "finance"."tax_reconciliations" FOR EACH ROW EXECUTE FUNCTION "finance"."fn_tax_updated_at"();



CREATE OR REPLACE TRIGGER "trg_alloc_bill_status" AFTER INSERT OR DELETE OR UPDATE ON "finance"."vendor_payment_allocations" FOR EACH ROW EXECUTE FUNCTION "finance"."auto_update_bill_status"();



CREATE OR REPLACE TRIGGER "trg_alloc_status_update" AFTER INSERT OR DELETE OR UPDATE ON "finance"."payment_allocations" FOR EACH ROW EXECUTE FUNCTION "finance"."auto_update_invoice_status"();



CREATE OR REPLACE TRIGGER "trg_bs_updated_at" BEFORE UPDATE ON "finance"."bank_statements" FOR EACH ROW EXECUTE FUNCTION "finance"."fn_bs_sl_updated_at"();



CREATE OR REPLACE TRIGGER "trg_bt_updated_at" BEFORE UPDATE ON "finance"."bank_transfers" FOR EACH ROW EXECUTE FUNCTION "finance"."fn_bt_updated_at"();



CREATE OR REPLACE TRIGGER "trg_fa_updated_at" BEFORE UPDATE ON "finance"."financial_accounts" FOR EACH ROW EXECUTE FUNCTION "finance"."fn_fa_updated_at"();



CREATE OR REPLACE TRIGGER "trg_gen_bt_number" BEFORE INSERT ON "finance"."bank_transfers" FOR EACH ROW EXECUTE FUNCTION "finance"."fn_gen_bt_number"();



CREATE OR REPLACE TRIGGER "trg_journal_balance" AFTER INSERT OR DELETE OR UPDATE ON "finance"."journal_lines" FOR EACH ROW EXECUTE FUNCTION "finance"."check_journal_balance"();



CREATE OR REPLACE TRIGGER "trg_prevent_closed_period" BEFORE UPDATE ON "finance"."journal_entries" FOR EACH ROW WHEN ((("new"."status" = 'POSTED'::"text") AND ("old"."status" <> 'POSTED'::"text"))) EXECUTE FUNCTION "finance"."prevent_closed_period_posting"();



CREATE OR REPLACE TRIGGER "trg_prevent_double_match" BEFORE INSERT OR UPDATE OF "matched_journal_line_id" ON "finance"."statement_lines" FOR EACH ROW EXECUTE FUNCTION "finance"."fn_prevent_double_match"();



CREATE OR REPLACE TRIGGER "trg_prevent_posted_line_edit" BEFORE DELETE OR UPDATE ON "finance"."journal_lines" FOR EACH ROW EXECUTE FUNCTION "finance"."prevent_posted_edit"();



CREATE OR REPLACE TRIGGER "trg_set_dual_approval" BEFORE INSERT OR UPDATE OF "from_amount" ON "finance"."bank_transfers" FOR EACH ROW EXECUTE FUNCTION "finance"."fn_set_dual_approval"();



CREATE OR REPLACE TRIGGER "trg_single_default_fa" BEFORE INSERT OR UPDATE OF "is_default" ON "finance"."financial_accounts" FOR EACH ROW EXECUTE FUNCTION "finance"."fn_enforce_single_default_fa"();



CREATE OR REPLACE TRIGGER "trg_sl_updated_at" BEFORE UPDATE ON "finance"."statement_lines" FOR EACH ROW EXECUTE FUNCTION "finance"."fn_bs_sl_updated_at"();



CREATE OR REPLACE TRIGGER "trg_stmt_line_count" AFTER INSERT OR DELETE OR UPDATE ON "finance"."statement_lines" FOR EACH ROW EXECUTE FUNCTION "finance"."fn_stmt_line_count"();



CREATE OR REPLACE TRIGGER "trg_stmt_recon_status" AFTER INSERT OR DELETE OR UPDATE ON "finance"."statement_lines" FOR EACH ROW EXECUTE FUNCTION "finance"."fn_stmt_recon_status"();



CREATE OR REPLACE TRIGGER "trg_validate_fa_ledger" BEFORE INSERT OR UPDATE OF "linked_ledger_account_id" ON "finance"."financial_accounts" FOR EACH ROW EXECUTE FUNCTION "finance"."fn_validate_fa_ledger"();



CREATE OR REPLACE TRIGGER "trs_uat" BEFORE UPDATE ON "finance"."tax_rule_sets" FOR EACH ROW EXECUTE FUNCTION "finance"."fn_tax_updated_at"();



CREATE OR REPLACE TRIGGER "tsl_uat" BEFORE UPDATE ON "finance"."tax_slabs" FOR EACH ROW EXECUTE FUNCTION "finance"."fn_tax_updated_at"();



CREATE OR REPLACE TRIGGER "chk_maker_checker" BEFORE UPDATE ON "public"."expenses" FOR EACH ROW EXECUTE FUNCTION "finance"."enforce_maker_checker"();



CREATE OR REPLACE TRIGGER "chk_maker_checker" BEFORE UPDATE ON "public"."incomes" FOR EACH ROW EXECUTE FUNCTION "finance"."enforce_maker_checker"();



CREATE OR REPLACE TRIGGER "chk_maker_checker" BEFORE UPDATE ON "public"."invoices" FOR EACH ROW EXECUTE FUNCTION "finance"."enforce_maker_checker"();



CREATE OR REPLACE TRIGGER "incomes_updated_at" BEFORE UPDATE ON "public"."incomes" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at"();



ALTER TABLE ONLY "core"."organization_config"
    ADD CONSTRAINT "organization_config_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



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
    ADD CONSTRAINT "accounting_periods_fiscal_year_id_fkey" FOREIGN KEY ("fiscal_year_id") REFERENCES "finance"."fiscal_years"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "finance"."bank_statements"
    ADD CONSTRAINT "bank_statements_financial_account_id_fkey" FOREIGN KEY ("financial_account_id") REFERENCES "finance"."financial_accounts"("id") ON DELETE CASCADE;



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



ALTER TABLE ONLY "finance"."chart_of_accounts"
    ADD CONSTRAINT "chart_of_accounts_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "finance"."chart_of_accounts"
    ADD CONSTRAINT "chart_of_accounts_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "finance"."chart_of_accounts"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "finance"."credit_notes"
    ADD CONSTRAINT "credit_notes_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "finance"."credit_notes"
    ADD CONSTRAINT "credit_notes_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "finance"."distribution_lines"
    ADD CONSTRAINT "distribution_lines_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "finance"."owners"("id");



ALTER TABLE ONLY "finance"."distribution_lines"
    ADD CONSTRAINT "distribution_lines_profit_distribution_id_fkey" FOREIGN KEY ("profit_distribution_id") REFERENCES "finance"."profit_distributions"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "finance"."exchange_rates"
    ADD CONSTRAINT "exchange_rates_entered_by_fkey" FOREIGN KEY ("entered_by") REFERENCES "auth"."users"("id");



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
    ADD CONSTRAINT "financial_accounts_responsible_user_id_fkey" FOREIGN KEY ("responsible_user_id") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "finance"."fiscal_years"
    ADD CONSTRAINT "fiscal_years_closed_by_fkey" FOREIGN KEY ("closed_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "finance"."fiscal_years"
    ADD CONSTRAINT "fiscal_years_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "finance"."journal_entries"
    ADD CONSTRAINT "journal_entries_approved_by_fkey" FOREIGN KEY ("approved_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "finance"."journal_entries"
    ADD CONSTRAINT "journal_entries_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



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



ALTER TABLE ONLY "finance"."numbering_sequences"
    ADD CONSTRAINT "numbering_sequences_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



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



ALTER TABLE ONLY "finance"."tax_reconciliations"
    ADD CONSTRAINT "tax_reconciliations_accountant_approved_by_fkey" FOREIGN KEY ("accountant_approved_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "finance"."tax_reconciliations"
    ADD CONSTRAINT "tax_reconciliations_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "finance"."tax_reconciliations"
    ADD CONSTRAINT "tax_reconciliations_tax_rule_set_id_fkey" FOREIGN KEY ("tax_rule_set_id") REFERENCES "finance"."tax_rule_sets"("id");



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
    ADD CONSTRAINT "vendor_bill_lines_vendor_bill_id_fkey" FOREIGN KEY ("vendor_bill_id") REFERENCES "finance"."vendor_bills"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "finance"."vendor_bills"
    ADD CONSTRAINT "vendor_bills_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



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



ALTER TABLE ONLY "public"."budget_lines"
    ADD CONSTRAINT "budget_lines_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "finance"."chart_of_accounts"("id");



ALTER TABLE ONLY "public"."budget_lines"
    ADD CONSTRAINT "budget_lines_budget_id_fkey" FOREIGN KEY ("budget_id") REFERENCES "public"."budgets"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."budgets"
    ADD CONSTRAINT "budgets_control_account_id_fkey" FOREIGN KEY ("control_account_id") REFERENCES "finance"."chart_of_accounts"("id");



ALTER TABLE ONLY "public"."budgets"
    ADD CONSTRAINT "budgets_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."clients"
    ADD CONSTRAINT "clients_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."expenses"
    ADD CONSTRAINT "expenses_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "finance"."chart_of_accounts"("id");



ALTER TABLE ONLY "public"."expenses"
    ADD CONSTRAINT "expenses_journal_entry_id_fkey" FOREIGN KEY ("journal_entry_id") REFERENCES "finance"."journal_entries"("id");



ALTER TABLE ONLY "public"."expenses"
    ADD CONSTRAINT "expenses_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."expenses"
    ADD CONSTRAINT "expenses_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."financial_accounts"
    ADD CONSTRAINT "financial_accounts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."incomes"
    ADD CONSTRAINT "incomes_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "finance"."chart_of_accounts"("id");



ALTER TABLE ONLY "public"."incomes"
    ADD CONSTRAINT "incomes_journal_entry_id_fkey" FOREIGN KEY ("journal_entry_id") REFERENCES "finance"."journal_entries"("id");



ALTER TABLE ONLY "public"."incomes"
    ADD CONSTRAINT "incomes_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."incomes"
    ADD CONSTRAINT "incomes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."invoices"
    ADD CONSTRAINT "invoices_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."invoices"
    ADD CONSTRAINT "invoices_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."notifications"
    ADD CONSTRAINT "notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."payments"
    ADD CONSTRAINT "payments_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."payments"
    ADD CONSTRAINT "payments_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."payments"
    ADD CONSTRAINT "payments_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."projects"
    ADD CONSTRAINT "projects_budget_id_fkey" FOREIGN KEY ("budget_id") REFERENCES "public"."budgets"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."projects"
    ADD CONSTRAINT "projects_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."tax_returns"
    ADD CONSTRAINT "tax_returns_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE "audit"."audit_log" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "audit_log_insert" ON "audit"."audit_log" FOR INSERT TO "authenticated" WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "audit_log_no_delete" ON "audit"."audit_log" FOR DELETE TO "authenticated" USING (false);



CREATE POLICY "audit_log_no_update" ON "audit"."audit_log" FOR UPDATE TO "authenticated" USING (false);



CREATE POLICY "audit_log_select_permitted" ON "audit"."audit_log" FOR SELECT TO "authenticated" USING ("audit"."has_audit_permission"("auth"."uid"()));



CREATE POLICY "audit_log_service_all" ON "audit"."audit_log" TO "service_role" USING (true) WITH CHECK (true);



CREATE POLICY "org_config_insert" ON "core"."organization_config" FOR INSERT WITH CHECK ("core"."is_ceo_or_admin"());



CREATE POLICY "org_config_select" ON "core"."organization_config" FOR SELECT USING (("auth"."uid"() IS NOT NULL));



CREATE POLICY "org_config_update" ON "core"."organization_config" FOR UPDATE USING ("core"."is_ceo_or_admin"());



ALTER TABLE "core"."organization_config" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "perm_manage" ON "core"."permissions" USING ("core"."has_permission"("auth"."uid"(), 'ADMIN_CONFIG'::"text"));



CREATE POLICY "perm_select" ON "core"."permissions" FOR SELECT USING (("auth"."uid"() IS NOT NULL));



ALTER TABLE "core"."permissions" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "role_manage" ON "core"."roles" USING ("core"."has_permission"("auth"."uid"(), 'ADMIN_USERS'::"text"));



ALTER TABLE "core"."role_permissions" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "role_select" ON "core"."roles" FOR SELECT USING (("auth"."uid"() IS NOT NULL));



ALTER TABLE "core"."roles" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "rp_manage" ON "core"."role_permissions" USING ("core"."has_permission"("auth"."uid"(), 'ADMIN_USERS'::"text"));



CREATE POLICY "rp_select" ON "core"."role_permissions" FOR SELECT USING ("core"."has_permission"("auth"."uid"(), 'ADMIN_USERS'::"text"));



CREATE POLICY "ur_manage" ON "core"."user_roles" USING ("core"."has_permission"("auth"."uid"(), 'ADMIN_USERS'::"text"));



CREATE POLICY "ur_select" ON "core"."user_roles" FOR SELECT USING (("auth"."uid"() IS NOT NULL));



ALTER TABLE "core"."user_roles" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "finance"."accounting_periods" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "admin_write_fee_rules" ON "finance"."fee_rules" USING ("core"."has_permission"("auth"."uid"(), 'ADMIN_CONFIG'::"text"));



CREATE POLICY "admin_write_platforms" ON "finance"."platforms" USING ("core"."has_permission"("auth"."uid"(), 'ADMIN_CONFIG'::"text"));



CREATE POLICY "admin_write_tiers" ON "finance"."fee_tiers" USING ("core"."has_permission"("auth"."uid"(), 'ADMIN_CONFIG'::"text"));



CREATE POLICY "ap_insert" ON "finance"."accounting_periods" FOR INSERT WITH CHECK ("core"."is_finance_head"());



CREATE POLICY "ap_select" ON "finance"."accounting_periods" FOR SELECT USING (("auth"."uid"() IS NOT NULL));



CREATE POLICY "ap_update" ON "finance"."accounting_periods" FOR UPDATE USING ("core"."is_finance_head"());



CREATE POLICY "authenticated_read_tiers" ON "finance"."fee_tiers" FOR SELECT TO "authenticated" USING (true);



ALTER TABLE "finance"."bank_statements" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "finance"."bank_transfers" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "bs_insert" ON "finance"."bank_statements" FOR INSERT WITH CHECK (("auth"."uid"() IS NOT NULL));



CREATE POLICY "bs_select" ON "finance"."bank_statements" FOR SELECT USING (("auth"."uid"() IS NOT NULL));



CREATE POLICY "bs_update" ON "finance"."bank_statements" FOR UPDATE USING (("auth"."uid"() IS NOT NULL));



CREATE POLICY "bt_delete" ON "finance"."bank_transfers" FOR DELETE USING (("auth"."uid"() IS NOT NULL));



CREATE POLICY "bt_insert" ON "finance"."bank_transfers" FOR INSERT WITH CHECK (("auth"."uid"() IS NOT NULL));



CREATE POLICY "bt_select" ON "finance"."bank_transfers" FOR SELECT USING (("auth"."uid"() IS NOT NULL));



CREATE POLICY "bt_update" ON "finance"."bank_transfers" FOR UPDATE USING (("auth"."uid"() IS NOT NULL));



ALTER TABLE "finance"."chart_of_accounts" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "cn_insert" ON "finance"."credit_notes" FOR INSERT WITH CHECK (("auth"."uid"() IS NOT NULL));



CREATE POLICY "cn_select" ON "finance"."credit_notes" FOR SELECT USING (("auth"."uid"() IS NOT NULL));



CREATE POLICY "coa_insert" ON "finance"."chart_of_accounts" FOR INSERT WITH CHECK (("core"."is_ceo_or_admin"() OR "core"."is_finance_head"()));



CREATE POLICY "coa_select_active" ON "finance"."chart_of_accounts" FOR SELECT USING ((("auth"."uid"() IS NOT NULL) AND (("is_active" = true) OR "core"."is_ceo_or_admin"() OR "core"."is_finance_head"())));



CREATE POLICY "coa_update" ON "finance"."chart_of_accounts" FOR UPDATE USING (("core"."is_ceo_or_admin"() OR "core"."is_finance_head"()));



ALTER TABLE "finance"."credit_notes" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "finance"."distribution_lines" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "dl_all" ON "finance"."distribution_lines" USING (("auth"."uid"() IS NOT NULL));



ALTER TABLE "finance"."exchange_rates" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "fa_delete" ON "finance"."financial_accounts" FOR DELETE USING (("auth"."uid"() IS NOT NULL));



CREATE POLICY "fa_insert" ON "finance"."financial_accounts" FOR INSERT WITH CHECK (("auth"."uid"() IS NOT NULL));



CREATE POLICY "fa_select" ON "finance"."financial_accounts" FOR SELECT USING (("auth"."uid"() IS NOT NULL));



CREATE POLICY "fa_update" ON "finance"."financial_accounts" FOR UPDATE USING (("auth"."uid"() IS NOT NULL));



ALTER TABLE "finance"."fee_computation_log" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "finance"."fee_rules" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "finance"."fee_tiers" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "finance"."financial_accounts" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "finance"."fiscal_years" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "fx_insert" ON "finance"."exchange_rates" FOR INSERT WITH CHECK (("auth"."uid"() IS NOT NULL));



CREATE POLICY "fx_select" ON "finance"."exchange_rates" FOR SELECT USING (("auth"."uid"() IS NOT NULL));



CREATE POLICY "fy_insert" ON "finance"."fiscal_years" FOR INSERT WITH CHECK ("core"."is_finance_head"());



CREATE POLICY "fy_select" ON "finance"."fiscal_years" FOR SELECT USING (("auth"."uid"() IS NOT NULL));



CREATE POLICY "fy_update" ON "finance"."fiscal_years" FOR UPDATE USING ("core"."is_finance_head"());



CREATE POLICY "je_delete" ON "finance"."journal_entries" FOR DELETE USING ((("auth"."uid"() = "created_by") AND ("status" = 'DRAFT'::"text")));



CREATE POLICY "je_insert" ON "finance"."journal_entries" FOR INSERT WITH CHECK (("auth"."uid"() IS NOT NULL));



CREATE POLICY "je_select_own" ON "finance"."journal_entries" FOR SELECT USING (("auth"."uid"() IS NOT NULL));



CREATE POLICY "je_update" ON "finance"."journal_entries" FOR UPDATE USING (("auth"."uid"() IS NOT NULL));



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


CREATE POLICY "ns_select" ON "finance"."numbering_sequences" FOR SELECT USING (("auth"."uid"() IS NOT NULL));



ALTER TABLE "finance"."numbering_sequences" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "o_all" ON "finance"."owners" USING (("auth"."uid"() IS NOT NULL));



CREATE POLICY "oh_all" ON "finance"."ownership_history" USING (("auth"."uid"() IS NOT NULL));



CREATE POLICY "org_read_fee_log" ON "finance"."fee_computation_log" FOR SELECT USING (true);



CREATE POLICY "org_read_fee_rules" ON "finance"."fee_rules" FOR SELECT USING (("auth"."uid"() IS NOT NULL));



CREATE POLICY "org_read_platforms" ON "finance"."platforms" FOR SELECT USING (("auth"."uid"() IS NOT NULL));



ALTER TABLE "finance"."owners" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "finance"."ownership_history" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "pa_insert" ON "finance"."payment_allocations" FOR INSERT WITH CHECK (("auth"."uid"() IS NOT NULL));



CREATE POLICY "pa_select" ON "finance"."payment_allocations" FOR SELECT USING (("auth"."uid"() IS NOT NULL));



ALTER TABLE "finance"."payment_allocations" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "finance"."payment_receipts" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "pd_all" ON "finance"."profit_distributions" USING (("auth"."uid"() IS NOT NULL));



ALTER TABLE "finance"."platforms" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "pr_insert" ON "finance"."payment_receipts" FOR INSERT WITH CHECK (("auth"."uid"() IS NOT NULL));



CREATE POLICY "pr_select" ON "finance"."payment_receipts" FOR SELECT USING (("auth"."uid"() IS NOT NULL));



CREATE POLICY "pr_update" ON "finance"."payment_receipts" FOR UPDATE USING (("auth"."uid"() IS NOT NULL));



ALTER TABLE "finance"."profit_distributions" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "finance"."reserve_policies" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "rp_all" ON "finance"."reserve_policies" USING (("auth"."uid"() IS NOT NULL));



CREATE POLICY "sl_delete" ON "finance"."statement_lines" FOR DELETE USING (("auth"."uid"() IS NOT NULL));



CREATE POLICY "sl_insert" ON "finance"."statement_lines" FOR INSERT WITH CHECK (("auth"."uid"() IS NOT NULL));



CREATE POLICY "sl_select" ON "finance"."statement_lines" FOR SELECT USING (("auth"."uid"() IS NOT NULL));



CREATE POLICY "sl_update" ON "finance"."statement_lines" FOR UPDATE USING (("auth"."uid"() IS NOT NULL));



ALTER TABLE "finance"."statement_lines" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "ta_delete" ON "finance"."tax_adjustments" FOR DELETE USING (("auth"."uid"() IS NOT NULL));



CREATE POLICY "ta_insert" ON "finance"."tax_adjustments" FOR INSERT WITH CHECK (("auth"."uid"() IS NOT NULL));



CREATE POLICY "ta_select" ON "finance"."tax_adjustments" FOR SELECT USING (("auth"."uid"() IS NOT NULL));



CREATE POLICY "ta_update" ON "finance"."tax_adjustments" FOR UPDATE USING (("auth"."uid"() IS NOT NULL)) WITH CHECK (("auth"."uid"() IS NOT NULL));



ALTER TABLE "finance"."tax_adjustments" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "finance"."tax_reconciliations" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "finance"."tax_rule_sets" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "finance"."tax_slabs" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "finance"."taxpayer_profile" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "tp_select" ON "finance"."taxpayer_profile" FOR SELECT USING (("auth"."uid"() IS NOT NULL));



CREATE POLICY "tp_update" ON "finance"."taxpayer_profile" FOR UPDATE USING (("auth"."uid"() IS NOT NULL)) WITH CHECK (("auth"."uid"() IS NOT NULL));



CREATE POLICY "tr_insert" ON "finance"."tax_reconciliations" FOR INSERT WITH CHECK (("auth"."uid"() IS NOT NULL));



CREATE POLICY "tr_select" ON "finance"."tax_reconciliations" FOR SELECT USING (("auth"."uid"() IS NOT NULL));



CREATE POLICY "tr_update" ON "finance"."tax_reconciliations" FOR UPDATE USING (("auth"."uid"() IS NOT NULL)) WITH CHECK (("auth"."uid"() IS NOT NULL));



CREATE POLICY "trs_insert" ON "finance"."tax_rule_sets" FOR INSERT WITH CHECK (("auth"."uid"() IS NOT NULL));



CREATE POLICY "trs_select" ON "finance"."tax_rule_sets" FOR SELECT USING (("auth"."uid"() IS NOT NULL));



CREATE POLICY "trs_update" ON "finance"."tax_rule_sets" FOR UPDATE USING (("auth"."uid"() IS NOT NULL)) WITH CHECK (("auth"."uid"() IS NOT NULL));



CREATE POLICY "tsl_delete" ON "finance"."tax_slabs" FOR DELETE USING (("auth"."uid"() IS NOT NULL));



CREATE POLICY "tsl_insert" ON "finance"."tax_slabs" FOR INSERT WITH CHECK (("auth"."uid"() IS NOT NULL));



CREATE POLICY "tsl_select" ON "finance"."tax_slabs" FOR SELECT USING (("auth"."uid"() IS NOT NULL));



CREATE POLICY "tsl_update" ON "finance"."tax_slabs" FOR UPDATE USING (("auth"."uid"() IS NOT NULL)) WITH CHECK (("auth"."uid"() IS NOT NULL));



CREATE POLICY "v_insert" ON "finance"."vendors" FOR INSERT WITH CHECK (("auth"."uid"() IS NOT NULL));



CREATE POLICY "v_select" ON "finance"."vendors" FOR SELECT USING (("auth"."uid"() IS NOT NULL));



CREATE POLICY "v_update" ON "finance"."vendors" FOR UPDATE USING (("auth"."uid"() IS NOT NULL));



CREATE POLICY "vb_insert" ON "finance"."vendor_bills" FOR INSERT WITH CHECK (("auth"."uid"() IS NOT NULL));



CREATE POLICY "vb_select" ON "finance"."vendor_bills" FOR SELECT USING (("auth"."uid"() IS NOT NULL));



CREATE POLICY "vb_update" ON "finance"."vendor_bills" FOR UPDATE USING (("auth"."uid"() IS NOT NULL));



CREATE POLICY "vbl_insert" ON "finance"."vendor_bill_lines" FOR INSERT WITH CHECK (("auth"."uid"() IS NOT NULL));



CREATE POLICY "vbl_select" ON "finance"."vendor_bill_lines" FOR SELECT USING (("auth"."uid"() IS NOT NULL));



CREATE POLICY "vbl_update" ON "finance"."vendor_bill_lines" FOR UPDATE USING (("auth"."uid"() IS NOT NULL));



ALTER TABLE "finance"."vendor_bill_lines" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "finance"."vendor_bills" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "finance"."vendor_payment_allocations" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "finance"."vendor_payments" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "finance"."vendors" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "vp_insert" ON "finance"."vendor_payments" FOR INSERT WITH CHECK (("auth"."uid"() IS NOT NULL));



CREATE POLICY "vp_select" ON "finance"."vendor_payments" FOR SELECT USING (("auth"."uid"() IS NOT NULL));



CREATE POLICY "vp_update" ON "finance"."vendor_payments" FOR UPDATE USING (("auth"."uid"() IS NOT NULL));



CREATE POLICY "vpa_insert" ON "finance"."vendor_payment_allocations" FOR INSERT WITH CHECK (("auth"."uid"() IS NOT NULL));



CREATE POLICY "vpa_select" ON "finance"."vendor_payment_allocations" FOR SELECT USING (("auth"."uid"() IS NOT NULL));



CREATE POLICY "Admin can delete any expense" ON "public"."expenses" FOR DELETE USING ("public"."is_admin"());



CREATE POLICY "Admin can delete any income" ON "public"."incomes" FOR DELETE USING ("public"."is_admin"());



CREATE POLICY "Admin can delete income" ON "public"."incomes" FOR DELETE USING ("public"."is_admin"());



CREATE POLICY "Admin can insert any expense" ON "public"."expenses" FOR INSERT WITH CHECK ("public"."is_admin"());



CREATE POLICY "Admin can insert any income" ON "public"."incomes" FOR INSERT WITH CHECK ("public"."is_admin"());



CREATE POLICY "Admin can insert income" ON "public"."incomes" FOR INSERT WITH CHECK ("public"."is_admin"());



CREATE POLICY "Admin can manage budgets" ON "public"."budgets" USING ("public"."is_admin"());



CREATE POLICY "Admin can manage payments" ON "public"."payments" USING ("public"."is_admin"());



CREATE POLICY "Admin can update any expense" ON "public"."expenses" FOR UPDATE USING ("public"."is_admin"());



CREATE POLICY "Admin can update any income" ON "public"."incomes" FOR UPDATE USING ("public"."is_admin"());



CREATE POLICY "Admin can update income" ON "public"."incomes" FOR UPDATE USING ("public"."is_admin"());



CREATE POLICY "Admin full access on profiles" ON "public"."profiles" USING ("public"."is_admin"());



CREATE POLICY "Admins can delete budget lines" ON "public"."budget_lines" FOR DELETE TO "authenticated" USING (true);



CREATE POLICY "Admins can insert budget lines" ON "public"."budget_lines" FOR INSERT TO "authenticated" WITH CHECK (true);



CREATE POLICY "Admins can manage financial accounts" ON "public"."financial_accounts" TO "authenticated" WITH CHECK (true);



CREATE POLICY "Admins can manage tax returns" ON "public"."tax_returns" TO "authenticated" WITH CHECK (true);



CREATE POLICY "Admins can update budget lines" ON "public"."budget_lines" FOR UPDATE TO "authenticated" USING (true);



CREATE POLICY "All authenticated users can view expenses" ON "public"."expenses" FOR SELECT USING (("auth"."uid"() IS NOT NULL));



CREATE POLICY "All authenticated users can view incomes" ON "public"."incomes" FOR SELECT USING (("auth"."uid"() IS NOT NULL));



CREATE POLICY "All users can view invoices" ON "public"."invoices" FOR SELECT USING (("auth"."uid"() IS NOT NULL));



CREATE POLICY "All users can view projects" ON "public"."projects" FOR SELECT USING (("auth"."uid"() IS NOT NULL));



CREATE POLICY "Anyone authenticated can view budgets" ON "public"."budgets" FOR SELECT USING (("auth"."uid"() IS NOT NULL));



CREATE POLICY "Anyone authenticated can view payments" ON "public"."payments" FOR SELECT USING (("auth"."uid"() IS NOT NULL));



CREATE POLICY "Anyone can view financial accounts" ON "public"."financial_accounts" FOR SELECT TO "authenticated" USING (true);



CREATE POLICY "Anyone can view tax returns" ON "public"."tax_returns" FOR SELECT TO "authenticated" USING (true);



CREATE POLICY "User can delete own income" ON "public"."incomes" FOR DELETE USING (("auth"."uid"() = "user_id"));



CREATE POLICY "User can insert own income" ON "public"."incomes" FOR INSERT WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "User can update own income" ON "public"."incomes" FOR UPDATE USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can delete own expense" ON "public"."expenses" FOR DELETE USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can delete own income" ON "public"."incomes" FOR DELETE USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can insert own expense" ON "public"."expenses" FOR INSERT WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can insert own income" ON "public"."incomes" FOR INSERT WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can manage own invoices" ON "public"."invoices" USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can manage own projects" ON "public"."projects" USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can update own expense" ON "public"."expenses" FOR UPDATE USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can update own income" ON "public"."incomes" FOR UPDATE USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can view budget lines" ON "public"."budget_lines" FOR SELECT TO "authenticated" USING (true);



CREATE POLICY "Users manage own notifications" ON "public"."notifications" USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Users with permission can manage budgets" ON "public"."budgets" USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Users with permission can manage payments" ON "public"."payments" USING (("auth"."uid"() = "user_id"));



ALTER TABLE "public"."budget_lines" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."budgets" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."clients" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "clients_delete" ON "public"."clients" FOR DELETE USING (true);



CREATE POLICY "clients_insert" ON "public"."clients" FOR INSERT WITH CHECK (true);



CREATE POLICY "clients_select" ON "public"."clients" FOR SELECT USING (true);



CREATE POLICY "clients_update" ON "public"."clients" FOR UPDATE USING (true);



ALTER TABLE "public"."expenses" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "expenses_delete" ON "public"."expenses" FOR DELETE USING ((("auth"."uid"() = "user_id") OR "public"."is_admin"()));



CREATE POLICY "expenses_insert" ON "public"."expenses" FOR INSERT WITH CHECK ((("auth"."uid"() = "user_id") OR "public"."is_admin"()));



CREATE POLICY "expenses_select" ON "public"."expenses" FOR SELECT USING (("auth"."uid"() IS NOT NULL));



CREATE POLICY "expenses_update" ON "public"."expenses" FOR UPDATE USING ((("auth"."uid"() = "user_id") OR "public"."is_admin"()));



ALTER TABLE "public"."financial_accounts" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."incomes" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "incomes_delete" ON "public"."incomes" FOR DELETE USING ((("auth"."uid"() = "user_id") OR "public"."is_admin"()));



CREATE POLICY "incomes_insert" ON "public"."incomes" FOR INSERT WITH CHECK ((("auth"."uid"() = "user_id") OR "public"."is_admin"()));



CREATE POLICY "incomes_select" ON "public"."incomes" FOR SELECT USING (("auth"."uid"() IS NOT NULL));



CREATE POLICY "incomes_update" ON "public"."incomes" FOR UPDATE USING ((("auth"."uid"() = "user_id") OR "public"."is_admin"()));



ALTER TABLE "public"."invoices" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "invoices_modify" ON "public"."invoices" USING ((("auth"."uid"() = "user_id") OR "public"."is_admin"()));



CREATE POLICY "invoices_select" ON "public"."invoices" FOR SELECT USING (("auth"."uid"() IS NOT NULL));



ALTER TABLE "public"."notifications" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "numbering_insert" ON "public"."numbering_sequences" FOR INSERT WITH CHECK (true);



CREATE POLICY "numbering_select" ON "public"."numbering_sequences" FOR SELECT USING (true);



ALTER TABLE "public"."numbering_sequences" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "numbering_update" ON "public"."numbering_sequences" FOR UPDATE USING (true);



ALTER TABLE "public"."payments" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."profiles" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "profiles_modify" ON "public"."profiles" USING ((("auth"."uid"() = "user_id") OR "public"."is_admin"()));



CREATE POLICY "profiles_select" ON "public"."profiles" FOR SELECT USING ((("auth"."uid"() = "user_id") OR "public"."is_admin"()));



ALTER TABLE "public"."projects" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "projects_modify" ON "public"."projects" USING ((("auth"."uid"() = "user_id") OR "public"."is_admin"()));



CREATE POLICY "projects_select" ON "public"."projects" FOR SELECT USING (("auth"."uid"() IS NOT NULL));



ALTER TABLE "public"."tax_returns" ENABLE ROW LEVEL SECURITY;


GRANT ALL ON SCHEMA "audit" TO "authenticated";
GRANT ALL ON SCHEMA "audit" TO "service_role";
GRANT USAGE ON SCHEMA "audit" TO "anon";



GRANT ALL ON SCHEMA "core" TO "authenticated";
GRANT ALL ON SCHEMA "core" TO "service_role";
GRANT USAGE ON SCHEMA "core" TO "anon";



GRANT ALL ON SCHEMA "finance" TO "authenticated";
GRANT ALL ON SCHEMA "finance" TO "service_role";
GRANT USAGE ON SCHEMA "finance" TO "anon";



GRANT USAGE ON SCHEMA "public" TO "postgres";
GRANT USAGE ON SCHEMA "public" TO "anon";
GRANT USAGE ON SCHEMA "public" TO "authenticated";
GRANT USAGE ON SCHEMA "public" TO "service_role";



GRANT ALL ON SCHEMA "reporting" TO "authenticated";
GRANT ALL ON SCHEMA "reporting" TO "service_role";



GRANT ALL ON FUNCTION "audit"."log_action"("p_user_id" "uuid", "p_user_email" "text", "p_user_name" "text", "p_action" "text", "p_entity_type" "text", "p_entity_id" "uuid", "p_description" "text", "p_old_values" "jsonb", "p_new_values" "jsonb", "p_ip_address" "inet", "p_user_agent" "text", "p_status" "text", "p_error_message" "text") TO "authenticated";



GRANT ALL ON FUNCTION "public"."create_user_by_admin"("p_email" "text", "p_password" "text", "p_role" "text", "p_full_name" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."create_user_by_admin"("p_email" "text", "p_password" "text", "p_role" "text", "p_full_name" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."create_user_by_admin"("p_email" "text", "p_password" "text", "p_role" "text", "p_full_name" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."ensure_profile_exists"("target_user_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."ensure_profile_exists"("target_user_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."ensure_profile_exists"("target_user_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."execute_sql_query"("query_string" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."execute_sql_query"("query_string" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."execute_sql_query"("query_string" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."find_auth_user_by_email"("search_email" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."find_auth_user_by_email"("search_email" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."find_auth_user_by_email"("search_email" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."get_all_system_users"() TO "anon";
GRANT ALL ON FUNCTION "public"."get_all_system_users"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_all_system_users"() TO "service_role";



GRANT ALL ON FUNCTION "public"."get_my_permissions"() TO "anon";
GRANT ALL ON FUNCTION "public"."get_my_permissions"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_my_permissions"() TO "service_role";



GRANT ALL ON FUNCTION "public"."get_my_user_roles"() TO "anon";
GRANT ALL ON FUNCTION "public"."get_my_user_roles"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_my_user_roles"() TO "service_role";



GRANT ALL ON FUNCTION "public"."get_user_permissions"("p_user_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."get_user_permissions"("p_user_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_user_permissions"("p_user_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."get_user_roles_by_id"("p_target_user_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."get_user_roles_by_id"("p_target_user_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_user_roles_by_id"("p_target_user_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."handle_new_user"() TO "anon";
GRANT ALL ON FUNCTION "public"."handle_new_user"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."handle_new_user"() TO "service_role";



GRANT ALL ON FUNCTION "public"."is_admin"() TO "anon";
GRANT ALL ON FUNCTION "public"."is_admin"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."is_admin"() TO "service_role";



GRANT ALL ON FUNCTION "public"."rls_auto_enable"() TO "anon";
GRANT ALL ON FUNCTION "public"."rls_auto_enable"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."rls_auto_enable"() TO "service_role";



GRANT ALL ON FUNCTION "public"."update_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."update_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."update_updated_at"() TO "service_role";



GRANT ALL ON FUNCTION "public"."user_has_role"("p_role_name" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."user_has_role"("p_role_name" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."user_has_role"("p_role_name" "text") TO "service_role";



GRANT ALL ON FUNCTION "reporting"."get_balance_sheet"("p_as_of_date" "date") TO "authenticated";



GRANT ALL ON FUNCTION "reporting"."get_cash_flow"("p_start_date" "date", "p_end_date" "date") TO "authenticated";



GRANT ALL ON FUNCTION "reporting"."get_ceo_metrics"() TO "authenticated";



GRANT ALL ON FUNCTION "reporting"."get_profit_and_loss"("p_start_date" "date", "p_end_date" "date") TO "authenticated";



GRANT ALL ON FUNCTION "reporting"."get_project_profitability"("p_start_date" "date", "p_end_date" "date") TO "authenticated";



GRANT SELECT,INSERT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "audit"."audit_log" TO "authenticated";
GRANT ALL ON TABLE "audit"."audit_log" TO "service_role";



GRANT ALL ON TABLE "core"."organization_config" TO "authenticated";
GRANT ALL ON TABLE "core"."organization_config" TO "service_role";



GRANT ALL ON TABLE "core"."permissions" TO "authenticated";
GRANT ALL ON TABLE "core"."permissions" TO "service_role";



GRANT ALL ON TABLE "core"."role_permissions" TO "authenticated";
GRANT ALL ON TABLE "core"."role_permissions" TO "service_role";



GRANT ALL ON TABLE "core"."roles" TO "authenticated";
GRANT ALL ON TABLE "core"."roles" TO "service_role";



GRANT ALL ON TABLE "core"."user_roles" TO "authenticated";
GRANT ALL ON TABLE "core"."user_roles" TO "service_role";



GRANT ALL ON TABLE "finance"."chart_of_accounts" TO "authenticated";
GRANT ALL ON TABLE "finance"."chart_of_accounts" TO "service_role";



GRANT ALL ON TABLE "finance"."account_type_summary" TO "authenticated";
GRANT ALL ON TABLE "finance"."account_type_summary" TO "service_role";
GRANT SELECT ON TABLE "finance"."account_type_summary" TO "anon";



GRANT ALL ON TABLE "finance"."accounting_periods" TO "authenticated";
GRANT ALL ON TABLE "finance"."accounting_periods" TO "service_role";



GRANT ALL ON TABLE "finance"."bank_statements" TO "authenticated";
GRANT ALL ON TABLE "finance"."bank_statements" TO "service_role";



GRANT ALL ON TABLE "finance"."bank_transfers" TO "authenticated";
GRANT ALL ON TABLE "finance"."bank_transfers" TO "service_role";



GRANT ALL ON TABLE "finance"."coa_tree" TO "authenticated";
GRANT ALL ON TABLE "finance"."coa_tree" TO "service_role";
GRANT SELECT ON TABLE "finance"."coa_tree" TO "anon";



GRANT ALL ON TABLE "finance"."credit_notes" TO "authenticated";
GRANT ALL ON TABLE "finance"."credit_notes" TO "service_role";



GRANT ALL ON TABLE "finance"."distribution_lines" TO "authenticated";
GRANT ALL ON TABLE "finance"."distribution_lines" TO "service_role";



GRANT ALL ON TABLE "finance"."exchange_rates" TO "authenticated";
GRANT ALL ON TABLE "finance"."exchange_rates" TO "service_role";



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



GRANT ALL ON TABLE "finance"."journal_entries" TO "authenticated";
GRANT ALL ON TABLE "finance"."journal_entries" TO "service_role";



GRANT ALL ON TABLE "finance"."journal_lines" TO "authenticated";
GRANT ALL ON TABLE "finance"."journal_lines" TO "service_role";



GRANT ALL ON TABLE "finance"."numbering_sequences" TO "authenticated";
GRANT ALL ON TABLE "finance"."numbering_sequences" TO "service_role";



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
GRANT SELECT ON TABLE "finance"."postable_accounts" TO "anon";



GRANT ALL ON TABLE "finance"."profit_distributions" TO "authenticated";
GRANT ALL ON TABLE "finance"."profit_distributions" TO "service_role";



GRANT ALL ON TABLE "finance"."reserve_policies" TO "authenticated";
GRANT ALL ON TABLE "finance"."reserve_policies" TO "service_role";



GRANT ALL ON TABLE "finance"."sequence_status" TO "authenticated";
GRANT ALL ON TABLE "finance"."sequence_status" TO "service_role";



GRANT ALL ON TABLE "finance"."statement_lines" TO "authenticated";
GRANT ALL ON TABLE "finance"."statement_lines" TO "service_role";



GRANT ALL ON TABLE "finance"."tax_adjustments" TO "authenticated";
GRANT ALL ON TABLE "finance"."tax_adjustments" TO "service_role";



GRANT ALL ON TABLE "finance"."tax_reconciliations" TO "authenticated";
GRANT ALL ON TABLE "finance"."tax_reconciliations" TO "service_role";



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



GRANT ALL ON TABLE "public"."budget_lines" TO "anon";
GRANT ALL ON TABLE "public"."budget_lines" TO "authenticated";
GRANT ALL ON TABLE "public"."budget_lines" TO "service_role";



GRANT ALL ON TABLE "public"."budgets" TO "anon";
GRANT ALL ON TABLE "public"."budgets" TO "authenticated";
GRANT ALL ON TABLE "public"."budgets" TO "service_role";



GRANT ALL ON TABLE "public"."chart_of_accounts" TO "anon";
GRANT ALL ON TABLE "public"."chart_of_accounts" TO "authenticated";
GRANT ALL ON TABLE "public"."chart_of_accounts" TO "service_role";



GRANT ALL ON TABLE "public"."clients" TO "anon";
GRANT ALL ON TABLE "public"."clients" TO "authenticated";
GRANT ALL ON TABLE "public"."clients" TO "service_role";



GRANT ALL ON TABLE "public"."coa_tree" TO "anon";
GRANT ALL ON TABLE "public"."coa_tree" TO "authenticated";
GRANT ALL ON TABLE "public"."coa_tree" TO "service_role";



GRANT ALL ON TABLE "public"."credit_notes" TO "anon";
GRANT ALL ON TABLE "public"."credit_notes" TO "authenticated";
GRANT ALL ON TABLE "public"."credit_notes" TO "service_role";



GRANT ALL ON TABLE "public"."exchange_rates" TO "anon";
GRANT ALL ON TABLE "public"."exchange_rates" TO "authenticated";
GRANT ALL ON TABLE "public"."exchange_rates" TO "service_role";



GRANT ALL ON TABLE "public"."expenses" TO "anon";
GRANT ALL ON TABLE "public"."expenses" TO "authenticated";
GRANT ALL ON TABLE "public"."expenses" TO "service_role";



GRANT ALL ON TABLE "public"."financial_accounts" TO "anon";
GRANT ALL ON TABLE "public"."financial_accounts" TO "authenticated";
GRANT ALL ON TABLE "public"."financial_accounts" TO "service_role";



GRANT ALL ON TABLE "reporting"."general_ledger" TO "authenticated";
GRANT ALL ON TABLE "reporting"."general_ledger" TO "service_role";



GRANT ALL ON TABLE "public"."general_ledger" TO "anon";
GRANT ALL ON TABLE "public"."general_ledger" TO "authenticated";
GRANT ALL ON TABLE "public"."general_ledger" TO "service_role";



GRANT ALL ON TABLE "public"."incomes" TO "anon";
GRANT ALL ON TABLE "public"."incomes" TO "authenticated";
GRANT ALL ON TABLE "public"."incomes" TO "service_role";



GRANT ALL ON TABLE "public"."invoices" TO "anon";
GRANT ALL ON TABLE "public"."invoices" TO "authenticated";
GRANT ALL ON TABLE "public"."invoices" TO "service_role";



GRANT ALL ON TABLE "public"."journal_entries" TO "anon";
GRANT ALL ON TABLE "public"."journal_entries" TO "authenticated";
GRANT ALL ON TABLE "public"."journal_entries" TO "service_role";



GRANT ALL ON TABLE "public"."journal_lines" TO "anon";
GRANT ALL ON TABLE "public"."journal_lines" TO "authenticated";
GRANT ALL ON TABLE "public"."journal_lines" TO "service_role";



GRANT ALL ON TABLE "public"."notifications" TO "anon";
GRANT ALL ON TABLE "public"."notifications" TO "authenticated";
GRANT ALL ON TABLE "public"."notifications" TO "service_role";



GRANT ALL ON TABLE "public"."numbering_sequences" TO "anon";
GRANT ALL ON TABLE "public"."numbering_sequences" TO "authenticated";
GRANT ALL ON TABLE "public"."numbering_sequences" TO "service_role";



GRANT ALL ON TABLE "public"."organization_config" TO "anon";
GRANT ALL ON TABLE "public"."organization_config" TO "authenticated";
GRANT ALL ON TABLE "public"."organization_config" TO "service_role";



GRANT ALL ON TABLE "public"."payment_allocations" TO "anon";
GRANT ALL ON TABLE "public"."payment_allocations" TO "authenticated";
GRANT ALL ON TABLE "public"."payment_allocations" TO "service_role";



GRANT ALL ON TABLE "public"."payment_receipts" TO "anon";
GRANT ALL ON TABLE "public"."payment_receipts" TO "authenticated";
GRANT ALL ON TABLE "public"."payment_receipts" TO "service_role";



GRANT ALL ON TABLE "public"."payments" TO "anon";
GRANT ALL ON TABLE "public"."payments" TO "authenticated";
GRANT ALL ON TABLE "public"."payments" TO "service_role";



GRANT ALL ON TABLE "public"."permissions" TO "anon";
GRANT ALL ON TABLE "public"."permissions" TO "authenticated";
GRANT ALL ON TABLE "public"."permissions" TO "service_role";



GRANT ALL ON TABLE "public"."postable_accounts" TO "anon";
GRANT ALL ON TABLE "public"."postable_accounts" TO "authenticated";
GRANT ALL ON TABLE "public"."postable_accounts" TO "service_role";



GRANT ALL ON TABLE "public"."profiles" TO "anon";
GRANT ALL ON TABLE "public"."profiles" TO "authenticated";
GRANT ALL ON TABLE "public"."profiles" TO "service_role";



GRANT ALL ON TABLE "public"."projects" TO "anon";
GRANT ALL ON TABLE "public"."projects" TO "authenticated";
GRANT ALL ON TABLE "public"."projects" TO "service_role";



GRANT ALL ON TABLE "public"."role_permissions" TO "anon";
GRANT ALL ON TABLE "public"."role_permissions" TO "authenticated";
GRANT ALL ON TABLE "public"."role_permissions" TO "service_role";



GRANT ALL ON TABLE "public"."roles" TO "anon";
GRANT ALL ON TABLE "public"."roles" TO "authenticated";
GRANT ALL ON TABLE "public"."roles" TO "service_role";



GRANT ALL ON TABLE "public"."tax_returns" TO "anon";
GRANT ALL ON TABLE "public"."tax_returns" TO "authenticated";
GRANT ALL ON TABLE "public"."tax_returns" TO "service_role";



GRANT ALL ON TABLE "public"."user_roles" TO "anon";
GRANT ALL ON TABLE "public"."user_roles" TO "authenticated";
GRANT ALL ON TABLE "public"."user_roles" TO "service_role";



GRANT ALL ON TABLE "public"."v_audit_log" TO "anon";
GRANT ALL ON TABLE "public"."v_audit_log" TO "authenticated";
GRANT ALL ON TABLE "public"."v_audit_log" TO "service_role";



GRANT ALL ON TABLE "public"."v_permissions" TO "anon";
GRANT ALL ON TABLE "public"."v_permissions" TO "authenticated";
GRANT ALL ON TABLE "public"."v_permissions" TO "service_role";



GRANT ALL ON TABLE "public"."v_role_permissions" TO "anon";
GRANT ALL ON TABLE "public"."v_role_permissions" TO "authenticated";
GRANT ALL ON TABLE "public"."v_role_permissions" TO "service_role";



GRANT ALL ON TABLE "public"."v_roles" TO "anon";
GRANT ALL ON TABLE "public"."v_roles" TO "authenticated";
GRANT ALL ON TABLE "public"."v_roles" TO "service_role";



GRANT ALL ON TABLE "public"."v_user_roles" TO "anon";
GRANT ALL ON TABLE "public"."v_user_roles" TO "authenticated";
GRANT ALL ON TABLE "public"."v_user_roles" TO "service_role";



GRANT ALL ON TABLE "reporting"."budget_vs_actual" TO "authenticated";
GRANT ALL ON TABLE "reporting"."budget_vs_actual" TO "service_role";



GRANT ALL ON TABLE "reporting"."budget_category_summary" TO "authenticated";
GRANT ALL ON TABLE "reporting"."budget_category_summary" TO "service_role";



GRANT ALL ON TABLE "reporting"."budget_gl_actual" TO "authenticated";
GRANT ALL ON TABLE "reporting"."budget_gl_actual" TO "service_role";



GRANT ALL ON TABLE "reporting"."payable_aging" TO "authenticated";
GRANT ALL ON TABLE "reporting"."payable_aging" TO "service_role";



GRANT ALL ON TABLE "reporting"."receivable_aging" TO "authenticated";
GRANT ALL ON TABLE "reporting"."receivable_aging" TO "service_role";



GRANT ALL ON TABLE "reporting"."reconciliation_summary" TO "authenticated";
GRANT ALL ON TABLE "reporting"."reconciliation_summary" TO "service_role";



GRANT ALL ON TABLE "reporting"."unreconciled_lines" TO "authenticated";
GRANT ALL ON TABLE "reporting"."unreconciled_lines" TO "service_role";



ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "audit" GRANT ALL ON TABLES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "audit" GRANT ALL ON TABLES TO "service_role";



ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "core" GRANT ALL ON TABLES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "core" GRANT ALL ON TABLES TO "service_role";



ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "finance" GRANT ALL ON TABLES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "finance" GRANT ALL ON TABLES TO "service_role";



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
