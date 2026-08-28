-- SAFE CRITICAL DB FIXES v3
-- Safety-focused revision of v2. Generated from the exact current schema.sql function bodies.
-- Changes are intentionally narrow and preserve existing function signatures.
--
-- Fixes: 
-- 1) Payment allocation permission aligns with the existing PAYMENT_RECEIPT_UPDATE permission.
-- 2) Allocation rejects cross-currency invoice/receipt pairs.
-- 3) Payment receipt posting accepts legitimate partial allocations (<= receipt amount).
-- 4) Payment receipt posting validates its required posting dependency before any write.
-- 5) get_pnl_accounts is VOLATILE because its authorization depends on session/auth context.
-- 6) allocate_payment_atomic search_path explicitly includes core for future unqualified core calls.
--
-- No tables/columns/triggers/policies/grants/data are changed.
-- Run on staging/backup first.

BEGIN;

CREATE OR REPLACE FUNCTION "finance"."get_pnl_accounts"("p_fiscal_year_id" "uuid", "p_organization_id" "uuid", "p_account_type" "text") RETURNS TABLE("account_id" "uuid", "code" "text", "name" "text", "balance" numeric)
    LANGUAGE "plpgsql" VOLATILE SECURITY DEFINER
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
  WHERE coa.organization_id=p_organization_id AND ((p_account_type='REVENUE' AND coa.account_type IN ('REVENUE','OTHER_INCOME')) OR (p_account_type='EXPENSE' AND coa.account_type IN ('COST_OF_SALES','OPERATING_EXPENSE','OTHER_EXPENSE')))
  GROUP BY coa.id,coa.code,coa.name
  ORDER BY coa.code;
END;
$$;


CREATE OR REPLACE FUNCTION "finance"."allocate_payment_atomic"("p_payment_receipt_id" "uuid", "p_allocations" "jsonb", "p_user_id" "uuid", "p_organization_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'finance', 'public', 'core'
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

  IF NOT core.has_permission(p_user_id, 'PAYMENT_RECEIPT_UPDATE') THEN
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

    IF upper(COALESCE(v_invoice.currency, 'PKR'))
       <> upper(COALESCE(v_receipt.currency, 'PKR')) THEN
      RAISE EXCEPTION
        'Currency mismatch: payment receipt is % but invoice % is %',
        COALESCE(v_receipt.currency, 'PKR'),
        v_invoice.invoice_number,
        COALESCE(v_invoice.currency, 'PKR');
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

  IF to_regprocedure('finance.post_payment_receipt(uuid,uuid,date)') IS NULL THEN
    RAISE EXCEPTION 'Required posting function finance.post_payment_receipt(uuid,uuid,date) is not available';
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

      IF upper(COALESCE(v_invoice.currency, 'PKR'))
         <> upper(COALESCE(p_currency, 'PKR')) THEN
        RAISE EXCEPTION
          'Currency mismatch: payment receipt is % but invoice % is %',
          COALESCE(p_currency, 'PKR'),
          v_invoice.invoice_number,
          COALESCE(v_invoice.currency, 'PKR');
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

  IF v_total_allocated > p_amount + 0.01 THEN
    RAISE EXCEPTION 'Total allocations (%) cannot exceed payment amount (%)', v_total_allocated, p_amount;
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


COMMIT;
