-- ============================================================================
-- OSYSTIC FMS - Confirmed Issue Fix Migration 2026-08-25
-- IMPORTANT: Run against the CURRENT live database, NOT migration history.
-- Do NOT edit schema.sql manually. After success, create a fresh Supabase CLI dump.
-- ============================================================================
BEGIN;

-- --------------------------------------------------------------------------
-- 1) AI: close direct-RPC bypass and enforce organization/caller identity.
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.execute_ai_readonly_query(
  query_string text,
  p_org_id uuid,
  p_user_id uuid,
  p_enforce_user_scope boolean DEFAULT true
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'pg_catalog','public','reporting','core'
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

REVOKE ALL ON FUNCTION public.execute_ai_readonly_query(text,uuid,uuid,boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.execute_ai_readonly_query(text,uuid,uuid,boolean) FROM anon;
GRANT EXECUTE ON FUNCTION public.execute_ai_readonly_query(text,uuid,uuid,boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.execute_ai_readonly_query(text,uuid,uuid,boolean) TO service_role;

-- AI configuration contains prompts/model policy and is not tenant data.
-- Do not expose it to every authenticated user.
DROP POLICY IF EXISTS authenticated_read_model_registry ON ai.ai_model_registry;
DROP POLICY IF EXISTS authenticated_read_prompts ON ai.ai_prompt_versions;
CREATE POLICY authenticated_read_model_registry ON ai.ai_model_registry
  FOR SELECT TO authenticated
  USING (
    core.has_role('CEO') OR core.has_role('FINANCE_HEAD') OR
    core.has_role('Admin') OR core.has_role('TECHNICAL_ADMIN')
  );
CREATE POLICY authenticated_read_prompts ON ai.ai_prompt_versions
  FOR SELECT TO authenticated
  USING (
    core.has_role('CEO') OR core.has_role('FINANCE_HEAD') OR
    core.has_role('Admin') OR core.has_role('TECHNICAL_ADMIN')
  );

-- --------------------------------------------------------------------------
-- 2) Audit report SECURITY DEFINER functions: enforce tenant scope.
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION audit.ai_audit_report(
  p_start timestamptz DEFAULT NULL,p_end timestamptz DEFAULT NULL,p_user_id uuid DEFAULT NULL,
  p_tool text DEFAULT NULL,p_status text DEFAULT NULL,p_page integer DEFAULT 1,p_page_size integer DEFAULT 50
) RETURNS json LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO 'pg_catalog','audit','public','core'
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

CREATE OR REPLACE FUNCTION audit.audit_log_report(
  p_start timestamptz DEFAULT NULL,p_end timestamptz DEFAULT NULL,p_user_id uuid DEFAULT NULL,p_action text DEFAULT NULL,
  p_entity_type text DEFAULT NULL,p_severity text DEFAULT NULL,p_approval_level text DEFAULT NULL,p_source_module text DEFAULT NULL,
  p_project_id uuid DEFAULT NULL,p_min_amount numeric DEFAULT NULL,p_max_amount numeric DEFAULT NULL,p_page integer DEFAULT 1,p_page_size integer DEFAULT 50
) RETURNS json LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO 'pg_catalog','audit','public','core'
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

GRANT EXECUTE ON FUNCTION audit.ai_audit_report(timestamptz,timestamptz,uuid,text,text,integer,integer) TO authenticated;
GRANT EXECUTE ON FUNCTION audit.audit_log_report(timestamptz,timestamptz,uuid,text,text,text,text,text,uuid,numeric,numeric,integer,integer) TO authenticated;

-- --------------------------------------------------------------------------
-- 2) Legacy public.payments: backfill and enforce organization_id.
-- --------------------------------------------------------------------------
UPDATE public.payments p
SET organization_id = pr.organization_id
FROM public.profiles pr
WHERE p.organization_id IS NULL
  AND pr.user_id = p.user_id
  AND pr.organization_id IS NOT NULL;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.payments WHERE organization_id IS NULL) THEN
    RAISE EXCEPTION 'Cannot enforce public.payments.organization_id NOT NULL: unresolved legacy rows remain';
  END IF;
END $$;
ALTER TABLE public.payments ALTER COLUMN organization_id SET NOT NULL;

-- --------------------------------------------------------------------------
-- 3) Statement-line reconciliation SECURITY DEFINER functions.
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION finance.exclude_statement_line(p_line_id uuid, p_reason text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'pg_catalog','finance','public','core'
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

CREATE OR REPLACE FUNCTION finance.manual_match_statement_line(p_line_id uuid, p_journal_line_id uuid, p_reason text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'pg_catalog','finance','public','core'
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

-- --------------------------------------------------------------------------
-- 4) Period helper functions must never select another organization's period.
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION finance.get_current_open_period_id()
RETURNS uuid LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO 'pg_catalog','finance','public','core'
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

CREATE OR REPLACE FUNCTION finance.get_current_period()
RETURNS TABLE(period_id uuid,fiscal_year_id uuid,fiscal_year_name text,period_number integer,period_name text,period_start date,period_end date,period_status text)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO 'pg_catalog','finance','public','core'
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

CREATE OR REPLACE FUNCTION finance.get_period_by_date(p_date date)
RETURNS TABLE(period_id uuid,fiscal_year_id uuid,fiscal_year_name text,period_number integer,period_name text,period_start date,period_end date,period_status text,fy_status text)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO 'pg_catalog','finance','public','core'
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

CREATE OR REPLACE FUNCTION finance.is_date_in_open_period(p_date date)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO 'pg_catalog','finance','public','core'
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

-- --------------------------------------------------------------------------
-- 5) Posted journals: DB-level immutability + organization-safe reversal.
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION finance.reverse_journal_entry(p_journal_id uuid,p_reversal_date date,p_reason text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'pg_catalog','finance','public','core'
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

-- --------------------------------------------------------------------------
-- 6) Missing RPC used by the manual journal posting route.
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION finance.post_existing_journal_entry(p_journal_id uuid,p_posted_by uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'pg_catalog','finance','public','core'
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

-- --------------------------------------------------------------------------
-- 7) Missing P&L account balance RPC used by year-end close.
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION finance.get_pnl_accounts(p_fiscal_year_id uuid,p_organization_id uuid,p_account_type text)
RETURNS TABLE(account_id uuid,code text,name text,balance numeric)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO 'pg_catalog','finance','public','core'
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

-- --------------------------------------------------------------------------
-- 8) Vendor-bill WHT posting: use WHT Payable and keep the journal balanced.
-- Gross expense/tax is debited; net AP is credited; withholding is credited
-- to WHT Payable. This removes the old WHT Receivable/debit imbalance.
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION finance.post_vendor_bill(p_bill_id uuid,p_period_id uuid,p_transaction_date date)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'pg_catalog','finance','core','public'
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

-- --------------------------------------------------------------------------
-- 9) Payment allocations schema mismatch: add reversal state columns.

-- --------------------------------------------------------------------------
ALTER TABLE finance.payment_allocations
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'ACTIVE',
  ADD COLUMN IF NOT EXISTS reversed_at timestamptz,
  ADD COLUMN IF NOT EXISTS reversed_by uuid;
ALTER TABLE finance.payment_allocations
  DROP CONSTRAINT IF EXISTS payment_allocations_status_check;
ALTER TABLE finance.payment_allocations
  ADD CONSTRAINT payment_allocations_status_check CHECK (status IN ('ACTIVE','REVERSED'));

-- Atomic payment reversal. This is the only function the API should call for
-- GL + receipt + allocations + invoice balance/status changes.
CREATE OR REPLACE FUNCTION finance.reverse_payment_receipt_atomic(
  p_receipt_id uuid,p_period_id uuid,p_reversal_date date,p_reason text,p_reversed_by uuid
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'pg_catalog','finance','public','core'
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

-- --------------------------------------------------------------------------
-- 9) Invoice status workflow constraint must allow the application's actual
-- maker-checker lifecycle.
-- --------------------------------------------------------------------------
-- Pre-fix (2026-08-25): legacy mixed-case status values found via manual
-- data audit on this database. The original constraint was itself installed
-- NOT VALID and never validated, so these rows predate any enforcement.
--   'Paid'    (2 rows) -> unambiguous case-normalization -> 'PAID'
--   'Pending' (2 rows, INV-2026-6047 / INV-2026-6727) -> both have
--     total_amount = 0.00 and issued_at IS NULL (never issued, no line
--     items) -> confirmed abandoned/test invoices -> 'VOID'
-- Targeted by id for the VOID case so this statement can never touch any
-- other row, including a future legitimate 'Pending' invoice.
UPDATE public.invoices
SET status = 'PAID'
WHERE status = 'Paid';

UPDATE public.invoices
SET status = 'VOID',
    void_reason = COALESCE(void_reason, 'Migration 2026-08-25: abandoned draft, total_amount 0.00, never issued, legacy status "Pending" predates invoices_status_check enforcement'),
    voided_at = COALESCE(voided_at, now())
WHERE id IN ('ffc57dd2-74d1-43bb-87fd-d13abcce7885', '4a2a7e69-7287-4bfc-8288-8eb5d7766935')
  AND status = 'Pending';

-- Belt-and-suspenders: abort clearly instead of hitting the opaque 23514
-- constraint error if any *other* unexpected status value still remains.
DO $$
DECLARE v_bad text;
BEGIN
  SELECT string_agg(DISTINCT status, ', ') INTO v_bad
  FROM public.invoices
  WHERE status IS NULL
     OR status NOT IN ('DRAFT','SUBMITTED','PENDING_APPROVAL','VERIFIED','APPROVED','ISSUED','PARTIALLY_PAID','PAID','OVERDUE','VOID','CREDITED','REFUNDED');
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'invoices_status_check pre-check failed: unexpected status value(s) remain: %. Resolve these before re-running.', v_bad;
  END IF;
END $$;

ALTER TABLE public.invoices DROP CONSTRAINT IF EXISTS invoices_status_check;
ALTER TABLE public.invoices
  ADD CONSTRAINT invoices_status_check CHECK (status IN ('DRAFT','SUBMITTED','PENDING_APPROVAL','VERIFIED','APPROVED','ISSUED','PARTIALLY_PAID','PAID','OVERDUE','VOID','CREDITED','REFUNDED')) NOT VALID;
-- Validate only after the constraint is installed; if legacy data contains an
-- unsupported status the transaction aborts instead of silently accepting it.
ALTER TABLE public.invoices VALIDATE CONSTRAINT invoices_status_check;

-- --------------------------------------------------------------------------
-- 10) Audit/verification metadata.
-- --------------------------------------------------------------------------
COMMENT ON FUNCTION finance.post_existing_journal_entry(uuid,uuid) IS 'Confirmed audit fix: atomically posts an already-approved journal in place, with organization, role, period and balance checks.';
COMMENT ON FUNCTION finance.get_pnl_accounts(uuid,uuid,text) IS 'Confirmed audit fix: organization-scoped P&L balances for fiscal close.';
COMMENT ON FUNCTION finance.reverse_payment_receipt_atomic(uuid,uuid,date,text,uuid) IS 'Confirmed audit fix: atomic payment reversal across GL, receipt, allocations and invoice balances.';
GRANT EXECUTE ON FUNCTION finance.post_existing_journal_entry(uuid,uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION finance.get_pnl_accounts(uuid,uuid,text) TO authenticated;
GRANT EXECUTE ON FUNCTION finance.reverse_payment_receipt_atomic(uuid,uuid,date,text,uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION finance.reverse_journal_entry(uuid,date,text) TO authenticated;
GRANT EXECUTE ON FUNCTION finance.exclude_statement_line(uuid,text) TO authenticated;
GRANT EXECUTE ON FUNCTION finance.manual_match_statement_line(uuid,uuid,text) TO authenticated;
GRANT EXECUTE ON FUNCTION finance.get_current_open_period_id() TO authenticated;
GRANT EXECUTE ON FUNCTION finance.get_current_period() TO authenticated;
GRANT EXECUTE ON FUNCTION finance.get_period_by_date(date) TO authenticated;
GRANT EXECUTE ON FUNCTION finance.is_date_in_open_period(date) TO authenticated;
COMMENT ON FUNCTION public.execute_ai_readonly_query(text,uuid,uuid,boolean) IS 'Confirmed audit fix: database-side AI SQL allowlist, tenant scope and ai_readonly_role execution.';

COMMIT;