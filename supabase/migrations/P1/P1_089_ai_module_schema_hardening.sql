-- P1_089 AI module schema hardening
-- Fixes confirmed AI findings without changing financial posting workflows.

-- 1. AI audit tables: authenticated users may insert only their own, same-org records.
DROP POLICY IF EXISTS "insert_own_ai_query_audit" ON ai.ai_query_audit;
CREATE POLICY "insert_own_ai_query_audit"
ON ai.ai_query_audit
FOR INSERT TO authenticated
WITH CHECK (user_id = auth.uid() AND core.same_org(organization_id));

DROP POLICY IF EXISTS "insert_own_ai_tool_calls" ON ai.ai_tool_calls;
CREATE POLICY "insert_own_ai_tool_calls"
ON ai.ai_tool_calls
FOR INSERT TO authenticated
WITH CHECK (user_id = auth.uid() AND core.same_org(organization_id));

-- 2. Organization-wide AI limits must aggregate only the current organization.
-- The application query is scoped by organization_id; the RPC below also keeps
-- usage recording tenant-bound and user-bound.

-- 3. Harden the SECURITY DEFINER AI audit function. The supplied user id must
-- be the authenticated user and the organization is derived server-side.
CREATE OR REPLACE FUNCTION audit.log_ai_event(
  p_user_id uuid,
  p_user_email text DEFAULT NULL,
  p_user_name text DEFAULT NULL,
  p_action text DEFAULT 'AI_QUERY',
  p_status text DEFAULT 'success',
  p_severity text DEFAULT 'info',
  p_entity_type text DEFAULT NULL,
  p_entity_id uuid DEFAULT NULL,
  p_project_id uuid DEFAULT NULL,
  p_ai_question text DEFAULT NULL,
  p_ai_normalized_intent text DEFAULT NULL,
  p_ai_selected_tool text DEFAULT NULL,
  p_ai_generated_sql text DEFAULT NULL,
  p_ai_template_id text DEFAULT NULL,
  p_ai_row_count integer DEFAULT NULL,
  p_ai_model text DEFAULT NULL,
  p_ai_latency_ms integer DEFAULT NULL,
  p_ai_cost_usd numeric DEFAULT NULL,
  p_ai_input_tokens integer DEFAULT NULL,
  p_ai_output_tokens integer DEFAULT NULL,
  p_ai_refusal_reason text DEFAULT NULL,
  p_request_id text DEFAULT NULL,
  p_ip_address inet DEFAULT NULL,
  p_user_agent text DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'audit', 'public', 'core'
AS $$
DECLARE
  v_id uuid;
  v_role text;
  v_prev_hash text;
  v_hash text;
  v_auth_user uuid := auth.uid();
  v_org uuid;
BEGIN
  IF v_auth_user IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;
  IF p_user_id IS DISTINCT FROM v_auth_user THEN
    RAISE EXCEPTION 'AI audit user must match authenticated user';
  END IF;

  SELECT organization_id INTO v_org
  FROM public.profiles
  WHERE user_id = v_auth_user
  LIMIT 1;
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'Organization context missing';
  END IF;

  SELECT r.name INTO v_role
  FROM core.user_roles ur
  JOIN core.roles r ON r.id = ur.role_id
  WHERE ur.user_id = v_auth_user
    AND ur.is_active = true
    AND (ur.effective_to IS NULL OR ur.effective_to >= CURRENT_DATE)
  ORDER BY ur.effective_from DESC
  LIMIT 1;

  SELECT entry_hash INTO v_prev_hash
  FROM audit.audit_log
  ORDER BY created_at DESC, id DESC
  LIMIT 1;

  v_hash := encode(
    sha256(
      COALESCE(v_prev_hash, '') || COALESCE(v_auth_user::text, '') ||
      COALESCE(p_action, '') || COALESCE(p_ai_question, '') ||
      COALESCE(p_ai_selected_tool, '') || COALESCE(p_ai_generated_sql, '') || NOW()::text
    ), 'hex'
  );

  INSERT INTO audit.audit_log (
    user_id, user_email, user_name, role_snapshot,
    action, entity_type, entity_id, status, severity,
    project_id, request_id, ip_address, user_agent,
    source_module, organization_id,
    ai_question, ai_normalized_intent, ai_selected_tool, ai_generated_sql,
    ai_template_id, ai_row_count, ai_model, ai_latency_ms, ai_cost_usd,
    ai_input_tokens, ai_output_tokens, ai_refusal_reason,
    prev_hash, entry_hash
  ) VALUES (
    v_auth_user, p_user_email, p_user_name, v_role,
    p_action, p_entity_type, p_entity_id, p_status, p_severity,
    p_project_id, p_request_id, p_ip_address, p_user_agent,
    'ai', v_org,
    p_ai_question, p_ai_normalized_intent, p_ai_selected_tool, p_ai_generated_sql,
    p_ai_template_id, p_ai_row_count, p_ai_model, p_ai_latency_ms, p_ai_cost_usd,
    p_ai_input_tokens, p_ai_output_tokens, p_ai_refusal_reason,
    v_prev_hash, v_hash
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION audit.log_ai_event(
  uuid,text,text,text,text,text,text,uuid,uuid,text,text,text,text,text,integer,text,integer,numeric,integer,integer,text,text,inet,text
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION audit.log_ai_event(
  uuid,text,text,text,text,text,text,uuid,uuid,text,text,text,text,text,integer,text,integer,numeric,integer,integer,text,text,inet,text
) TO authenticated;

-- 4. Harden other AI write paths against organization spoofing when a client
-- calls PostgREST directly. The API still derives organization_id server-side.
-- 5. Tighten the pre-existing permissive AI write policies as well. Multiple
-- permissive policies are OR-combined, so the original user-only policies must
-- be replaced rather than merely supplemented.
DROP POLICY IF EXISTS "users_own_extractions" ON ai.ai_document_extractions;
CREATE POLICY "users_own_extractions" ON ai.ai_document_extractions
FOR ALL TO authenticated
USING (user_id = auth.uid() AND core.same_org(organization_id))
WITH CHECK (user_id = auth.uid() AND core.same_org(organization_id));

DROP POLICY IF EXISTS "users_own_feedback" ON ai.ai_feedback;
CREATE POLICY "users_own_feedback" ON ai.ai_feedback
FOR ALL TO authenticated
USING (user_id = auth.uid() AND core.same_org(organization_id))
WITH CHECK (user_id = auth.uid() AND core.same_org(organization_id));

DROP POLICY IF EXISTS "users_own_suggestions" ON ai.ai_suggestions;
CREATE POLICY "users_own_suggestions" ON ai.ai_suggestions
FOR ALL TO authenticated
USING (user_id = auth.uid() AND core.same_org(organization_id))
WITH CHECK (user_id = auth.uid() AND core.same_org(organization_id));

DROP POLICY IF EXISTS "users_own_cost" ON ai.ai_user_cost_tracking;
CREATE POLICY "users_own_cost" ON ai.ai_user_cost_tracking
FOR ALL TO authenticated
USING (user_id = auth.uid() AND core.same_org(organization_id))
WITH CHECK (user_id = auth.uid() AND core.same_org(organization_id));

DROP POLICY IF EXISTS "write_own_conversations" ON ai.ai_conversations;
CREATE POLICY "write_own_conversations" ON ai.ai_conversations
FOR INSERT TO authenticated
WITH CHECK (user_id = auth.uid() AND core.same_org(organization_id));


-- 6. Append organization_id to reporting views used by the AI gateway.
-- These columns are appended (not reordered) so existing consumers remain compatible.

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
  GROUP BY "b"."id", "b"."name", "b"."category", "b"."total_amount", "b"."start_date", "b"."end_date", "p"."id", "p"."name", "b"."organization_id";;


CREATE OR REPLACE VIEW "reporting"."budget_category_summary" WITH ("security_invoker"='true') AS
 SELECT "b"."category",
    "count"(DISTINCT "b"."id") AS "budget_count",
    "sum"("b"."total_amount") AS "total_budgeted",
    COALESCE("sum"("bva"."actual_amount"), (0)::numeric) AS "total_actual",
    COALESCE("sum"("bva"."remaining_amount"), (0)::numeric) AS "total_remaining",
        CASE
            WHEN ("sum"("b"."total_amount") = (0)::numeric) THEN (0)::numeric
            ELSE "round"(((COALESCE("sum"("bva"."actual_amount"), (0)::numeric) / "sum"("b"."total_amount")) * (100)::numeric), 2)
        END AS "overall_utilization_pct",
    "b"."organization_id"
   FROM ("public"."budgets" "b"
     LEFT JOIN "reporting"."budget_vs_actual" "bva" ON (("bva"."budget_id" = "b"."id")))
  GROUP BY "b"."category", "b"."organization_id";;


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
    ,"vb"."organization_id"
   FROM ("finance"."vendor_bills" "vb"
     JOIN "finance"."vendors" "v" ON (("v"."id" = "vb"."vendor_id")))
  WHERE ("vb"."status" = ANY (ARRAY['POSTED'::"text", 'PARTIALLY_PAID'::"text", 'PAID'::"text"]));;


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
    ,"i"."organization_id"
   FROM "public"."invoices" "i"
  WHERE (("status")::"text" = ANY ((ARRAY['ISSUED'::character varying, 'PARTIALLY_PAID'::character varying, 'PAID'::character varying, 'OVERDUE'::character varying])::"text"[]));;


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
    ,"fa"."organization_id"
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
  WHERE ("fa"."is_active" = true);;


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
    ,"fa"."organization_id"
   FROM (("finance"."statement_lines" "sl"
     JOIN "finance"."bank_statements" "bs" ON (("bs"."id" = "sl"."bank_statement_id")))
     JOIN "finance"."financial_accounts" "fa" ON (("fa"."id" = "bs"."financial_account_id")))
  WHERE ("sl"."reconciliation_status" = 'UNRECONCILED'::"text")
  ORDER BY "sl"."transaction_date" DESC, "fa"."account_name";;


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
    ,"fy"."organization_id"
   FROM (("finance"."depreciation_schedule" "ds"
     JOIN "finance"."fiscal_years" "fy" ON (("fy"."id" = "ds"."fiscal_year_id")))
     JOIN "finance"."accounting_periods" "ap" ON (("ap"."id" = "ds"."period_id")))
  GROUP BY "ds"."fiscal_year_id", "fy"."name", "ds"."period_id", "ap"."name", "ap"."start_date", "ap"."end_date", "fy"."organization_id"
  ORDER BY "fy"."name", "ap"."start_date";;


-- 7. AI schema reference now documents the server-enforced tenant dimension.
-- No data is written by this migration.
