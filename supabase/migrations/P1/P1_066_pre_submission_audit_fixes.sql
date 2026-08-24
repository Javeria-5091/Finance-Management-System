-- OSYSTIC Finance Management System
-- Pre-submission audit fixes: organization-scoped reporting RPCs + atomic payment allocation.
-- Generated from the supplied schema and audit findings dated 24 Aug 2026.

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

DROP FUNCTION IF EXISTS reporting.get_profit_and_loss(date,date);

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

DROP FUNCTION IF EXISTS reporting.get_balance_sheet(date);

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

DROP FUNCTION IF EXISTS reporting.get_cash_flow(date,date);

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

DROP FUNCTION IF EXISTS reporting.get_statement_of_changes_in_equity(date,date);

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

DROP FUNCTION IF EXISTS reporting.get_trial_balance(uuid[]);


CREATE OR REPLACE FUNCTION finance.allocate_payment_atomic(
  p_payment_receipt_id uuid,
  p_allocations jsonb,
  p_user_id uuid,
  p_organization_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, finance, public
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

REVOKE ALL ON FUNCTION finance.allocate_payment_atomic(uuid,jsonb,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION finance.allocate_payment_atomic(uuid,jsonb,uuid,uuid) TO authenticated;
