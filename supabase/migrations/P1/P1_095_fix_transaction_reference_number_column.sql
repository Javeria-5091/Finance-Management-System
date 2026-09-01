-- ============================================================================
-- P1_094_fix_transaction_reference_number_column.sql
--
-- FE-02 FIX: reporting.transaction_list() and reporting.transaction_detail()
-- both had an EXPENSE branch that selected "reference_number" from
-- public.expenses. That column does not exist on public.expenses (it has
-- "title", "notes", "amount", "user_id" - see FE-01 fix for the full column
-- list). Every journal entry sourced from an expense (source_type =
-- 'EXPENSE') therefore raised a Postgres "column does not exist" error,
-- which PostgREST turned into a failed RPC call - taking down the entire
-- Transactions Ledger page (schema.sql: transaction_list, transaction_detail).
--
-- The frontend made this worse: src/app/dashboard/transactions/page.tsx did
-- not destructure `error` from useTransactionList(), so a hard RPC failure
-- silently rendered as "No transactions found" instead of surfacing the
-- real problem (page.tsx:470-476). That UI gap is fixed separately in the
-- same commit (see page.tsx changes) by surfacing query errors.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. reporting.transaction_detail(p_id uuid)
-- ---------------------------------------------------------------------------
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
      WHEN 'EXPENSE' THEN (SELECT 'EXP-' || substr(id::text, 1, 8) FROM public.expenses WHERE id = je.source_id)
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

COMMENT ON FUNCTION "reporting"."transaction_detail"("p_id" "uuid") IS 'FE-02 fix: the EXPENSE branch of source_reference selected public.expenses.reference_number, which does not exist on that table, so every call raised a column-does-not-exist error and the Transactions page detail view was permanently dead. Now synthesizes a reference from the expense id instead.';

REVOKE ALL ON FUNCTION "reporting"."transaction_detail"("p_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "reporting"."transaction_detail"("p_id" "uuid") TO "authenticated";


-- ---------------------------------------------------------------------------
-- 2. reporting.transaction_list(...)
-- ---------------------------------------------------------------------------
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
        WHEN 'EXPENSE' THEN (SELECT 'EXP-' || substr(id::text, 1, 8) FROM public.expenses WHERE id = je.source_id)
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

COMMENT ON FUNCTION "reporting"."transaction_list"("p_search" "text", "p_type" "text", "p_status" "text", "p_project_id" "uuid", "p_date_from" "date", "p_date_to" "date", "p_limit" integer, "p_offset" integer) IS 'FE-02 fix: the EXPENSE branch of source_reference selected public.expenses.reference_number, which does not exist on that table, so every call raised a column-does-not-exist error and the whole Transactions Ledger page was permanently dead. Now synthesizes a reference from the expense id instead.';

REVOKE ALL ON FUNCTION "reporting"."transaction_list"("p_search" "text", "p_type" "text", "p_status" "text", "p_project_id" "uuid", "p_date_from" "date", "p_date_to" "date", "p_limit" integer, "p_offset" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "reporting"."transaction_list"("p_search" "text", "p_type" "text", "p_status" "text", "p_project_id" "uuid", "p_date_from" "date", "p_date_to" "date", "p_limit" integer, "p_offset" integer) TO "authenticated";