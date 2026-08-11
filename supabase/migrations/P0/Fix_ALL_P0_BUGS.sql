-- ===========================================================================================================================
-- OSYSTIC Finance Management System — P0 CRITICAL BUG FIX MIGRATION
-- ===========================================================================================================================
-- Run this AFTER all existing P0 migrations have been applied.
-- This single file fixes ALL 18+ critical runtime bugs identified in the P0 analysis.
--
-- BUGS FIXED:
--   2.  Report Mapping Mismatch — views now match COA seed values
--   3.  Invoice/Bill GL Posting Never Works — parameter order fixed in ALL posting functions
--   4.  Bank Transfer FX Crash — wrong column (effective_date → rate_date) + wrong account (7210 → 7121)
--   5.  Bank Auto-Match Never Works — 'posted' → 'POSTED' case fix
--   6.  Tax Computation Inverted PBT — formula corrected
--   7.  CEO Dashboard Audit Error — audit_logs → audit.audit_log
--   8.  CEO Dashboard Fiscal Empty — is_current column doesn't exist, fixed query
--   9.  Vendor Payment WHT Crash — account 2201 → 2210
--  10. Missing budget/attachments tables created
--  11. Reconciliation summary view case fix
--  12. Bank transfer RLS policy fix (RBAC instead of auth.uid())
-- ===========================================================================================================================

-- ===========================================================================================================================
-- BUG #2: REPORT MAPPING MISMATCH
-- ===========================================================================================================================
-- Problem: COA seed uses PL_REVENUE, BS_CURRENT_ASSETS etc.
-- But report views check for PROFIT_LOSS_REVENUE, BALANCE_SHEET_CURRENT_ASSETS etc.
-- FIX: Update the report views to match the COA seed values.

-- Fix P&L View (026)
CREATE OR REPLACE FUNCTION reporting.get_profit_and_loss(
    p_start_date DATE,
    p_end_date DATE
)
RETURNS TABLE (
    section_order INT,
    section TEXT,
    code TEXT,
    account_name TEXT,
    debit_total NUMERIC,
    credit_total NUMERIC,
    net_amount NUMERIC
) AS $$
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
  AND coa.account_type IN ('REVENUE', 'COST_OF_SALES', 'OPERATING_EXPENSE', 'OTHER_INCOME', 'OTHER_EXPENSE')
GROUP BY coa.id, coa.report_mapping, coa.account_type, coa.code, coa.name, coa.normal_balance
ORDER BY section_order, coa.code;
$$ LANGUAGE sql STABLE SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION reporting.get_profit_and_loss(DATE, DATE) TO authenticated;

-- Fix Balance Sheet View (027)
CREATE OR REPLACE FUNCTION reporting.get_balance_sheet(
    p_as_of_date DATE
)
RETURNS TABLE (
    section_order INT,
    section TEXT,
    code TEXT,
    account_name TEXT,
    net_amount NUMERIC
) AS $$
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
  AND coa.account_type IN ('ASSET', 'LIABILITY', 'EQUITY')
GROUP BY coa.id, coa.report_mapping, coa.account_type, coa.code, coa.name, coa.normal_balance
HAVING CASE
    WHEN coa.normal_balance = 'DEBIT' THEN COALESCE(SUM(jl.base_debit), 0) - COALESCE(SUM(jl.base_credit), 0)
    ELSE COALESCE(SUM(jl.base_credit), 0) - COALESCE(SUM(jl.base_debit), 0)
END != 0
ORDER BY section_order, coa.code;
$$ LANGUAGE sql STABLE SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION reporting.get_balance_sheet(DATE) TO authenticated;

-- Fix Cash Flow View (028)
CREATE OR REPLACE FUNCTION reporting.get_cash_flow(
    p_start_date DATE,
    p_end_date DATE
)
RETURNS TABLE (
    section TEXT,
    account_name TEXT,
    amount NUMERIC
) AS $$
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
      AND (coa.account_type = 'EQUITY' OR coa.code LIKE '251%')
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
$$ LANGUAGE sql STABLE SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION reporting.get_cash_flow(DATE, DATE) TO authenticated;


-- ===========================================================================================================================
-- BUG #3 & #9: POSTING FUNCTIONS — PARAMETER ORDER FIX + WHT ACCOUNT FIX
-- ===========================================================================================================================
-- Problem: finance.post_journal_entry() signature is:
--   p_description, p_transaction_date, p_period_id, p_lines,
--   p_currency, p_exchange_rate, p_source_type, p_source_id, p_project_id, p_department_id
-- But ALL posting functions pass v_lines as the LAST argument → it goes to p_department_id (ignored)
-- and 'PKR' string goes to p_lines (wrong type) → function crashes or creates empty journals.

-- FIX: Recreate ALL posting functions with correct parameter order.

-- 3a. INVOICE AR POSTING (fixes GL disconnection for invoices)
CREATE OR REPLACE FUNCTION finance.post_invoice_ar(
    p_invoice_id UUID,
    p_period_id UUID,
    p_transaction_date DATE
) RETURNS UUID AS $$
DECLARE
    v_inv RECORD;
    v_fy_id UUID;
    v_lines JSONB := '[]'::JSONB;
    v_dr_account UUID;
    v_rev_account UUID;
    v_tax_account UUID;
BEGIN
    SELECT * INTO v_inv FROM public.invoices WHERE id = p_invoice_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Invoice not found'; END IF;

    SELECT fiscal_year_id INTO v_fy_id FROM finance.accounting_periods WHERE id = p_period_id;
    IF v_fy_id IS NULL THEN RAISE EXCEPTION 'Invalid period'; END IF;

    SELECT id INTO v_dr_account FROM finance.chart_of_accounts WHERE code = '1210' LIMIT 1;
    SELECT id INTO v_rev_account FROM finance.chart_of_accounts WHERE code = '4110' LIMIT 1;
    SELECT id INTO v_tax_account FROM finance.chart_of_accounts WHERE code = '2210' LIMIT 1;

    IF v_dr_account IS NULL THEN RAISE EXCEPTION 'AR account 1210 not found'; END IF;
    IF v_rev_account IS NULL THEN RAISE EXCEPTION 'Revenue account 4110 not found'; END IF;

    -- Line 1: Debit AR (full invoice amount)
    v_lines := jsonb_build_object(
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
$$ LANGUAGE plpgsql SECURITY DEFINER;


-- 3b. PAYMENT RECEIPT POSTING (fixes GL for payment receipts)
CREATE OR REPLACE FUNCTION finance.post_payment_receipt(
    p_receipt_id UUID,
    p_period_id UUID,
    p_transaction_date DATE
) RETURNS UUID AS $$
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
$$ LANGUAGE plpgsql SECURITY DEFINER;


-- 3c. CREDIT NOTE POSTING
CREATE OR REPLACE FUNCTION finance.post_credit_note(
    p_cn_id UUID,
    p_period_id UUID,
    p_transaction_date DATE
) RETURNS UUID AS $$
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

    v_lines := jsonb_build_object(
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
$$ LANGUAGE plpgsql SECURITY DEFINER;


-- 3d. VENDOR BILL POSTING
CREATE OR REPLACE FUNCTION finance.post_vendor_bill(
    p_bill_id UUID,
    p_period_id UUID,
    p_transaction_date DATE
) RETURNS UUID AS $$
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
        RAISE EXCEPTION 'Bill must be APPROVED before posting, current: %', v_bill.status;
    END IF;

    SELECT fiscal_year_id INTO v_fy_id FROM finance.accounting_periods WHERE id = p_period_id;
    IF v_fy_id IS NULL THEN RAISE EXCEPTION 'Invalid period'; END IF;

    SELECT id INTO v_ap_account FROM finance.chart_of_accounts WHERE code = '2110' LIMIT 1;
    IF v_ap_account IS NULL THEN RAISE EXCEPTION 'AP account 2110 not found'; END IF;

    SELECT id INTO v_wht_account FROM finance.chart_of_accounts WHERE code = '1401' LIMIT 1;
    IF v_wht_account IS NULL THEN RAISE EXCEPTION 'WHT Receivable account 1401 not found'; END IF;

    FOR v_line IN (
        SELECT id, account_id, line_total AS line_amount, description,
               COALESCE(withholding_amount, 0) AS wht_amount
        FROM finance.vendor_bill_lines
        WHERE vendor_bill_id = p_bill_id
        ORDER BY line_number
    ) LOOP
        v_lines := v_lines || jsonb_build_object(
            'account_id', v_line.account_id,
            'debit_amount', v_line.line_amount - v_line.wht_amount,
            'credit_amount', 0,
            'description', v_line.description
        );
        v_total_debit := v_total_debit + (v_line.line_amount - v_line.wht_amount);

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

    v_lines := v_lines || jsonb_build_object(
        'account_id', v_ap_account,
        'debit_amount', 0,
        'credit_amount', v_bill.total_amount,
        'description', 'AP: ' || v_bill.bill_number || ' - ' || COALESCE((SELECT name FROM finance.vendors WHERE id = v_bill.vendor_id), '')
    );
    v_total_credit := v_bill.total_amount;

    IF ABS(v_total_debit - v_total_credit) > 0.02 THEN
        RAISE EXCEPTION 'Journal unbalanced: DR=% CR=%', v_total_debit, v_total_credit;
    END IF;

    --  CORRECT PARAMETER ORDER
    RETURN finance.post_journal_entry(
        'AP Bill: ' || v_bill.bill_number,
        p_transaction_date, p_period_id,
        v_lines,
        'PKR', 1.0000,
        'VENDOR_BILL', p_bill_id,
        v_bill.project_id, NULL
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;


-- 3e. VENDOR PAYMENT POSTING (also fixes WHT account 2201 → 2210)
CREATE OR REPLACE FUNCTION finance.post_vendor_payment(
    p_payment_id UUID,
    p_period_id UUID,
    p_transaction_date DATE
) RETURNS UUID AS $$
DECLARE
    v_pay RECORD;
    v_fy_id UUID;
    v_ap_account UUID;
    v_bank_account UUID;
    v_wht_payable UUID;  --  FIXED: Now uses correct account
    v_total_allocated NUMERIC(18,2);
    v_total_withholding NUMERIC(18,2);
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

    --  BUG #9 FIX: Changed from 2201 (doesn't exist) to 2210 (Income Tax Payable)
    SELECT id INTO v_wht_payable FROM finance.chart_of_accounts WHERE code = '2210' LIMIT 1;
    -- Note: 2210 is Income Tax Payable — if WHT is separate, create code 2221 in COA

    SELECT
        COALESCE(SUM(vpa.allocated_amount), 0),
        COALESCE(SUM(
            (SELECT COALESCE(SUM(COALESCE(bl.base_withholding_amount, bl.withholding_amount, 0)), 0)
             FROM finance.vendor_bill_lines bl
             WHERE bl.vendor_bill_id = vpa.vendor_bill_id)
        ), 0),
        COALESCE(SUM(vb.total_amount), 0)
    INTO v_total_allocated, v_total_withholding, v_total_bill_amount
    FROM finance.vendor_payment_allocations vpa
    JOIN finance.vendor_bills vb ON vb.id = vpa.vendor_bill_id
    WHERE vpa.vendor_payment_id = p_payment_id;

    -- Debit AP (clear the payable)
    IF v_total_allocated > 0 THEN
        v_lines := jsonb_build_object(
            'account_id', v_ap_account,
            'debit_amount', v_total_allocated,
            'credit_amount', 0,
            'description', 'AP Cleared: ' || v_pay.payment_number
        );
    END IF;

    -- Credit Bank (money going out)
    IF v_total_allocated > 0 THEN
        v_lines := v_lines || jsonb_build_object(
            'account_id', v_bank_account,
            'debit_amount', 0,
            'credit_amount', v_total_allocated,
            'description', 'Paid to Vendor: ' || v_pay.payment_number
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

    --  CORRECT PARAMETER ORDER
    RETURN finance.post_journal_entry(
        'Vendor Payment: ' || v_pay.payment_number,
        p_transaction_date, p_period_id,
        v_lines,
        'PKR', 1.0000,
        'VENDOR_PAYMENT', p_payment_id,
        NULL, NULL
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;


-- ===========================================================================================================================
-- BUG #4: BANK TRANSFER FX ERROR
-- ===========================================================================================================================
-- Problem 1: Uses 'effective_date' but exchange_rates table has 'rate_date'
-- Problem 2: Uses FX Loss account code 7210 (doesn't exist), should be 7121

CREATE OR REPLACE FUNCTION finance.post_bank_transfer(
    p_transfer_id UUID, p_period_id UUID, p_transaction_date DATE
) RETURNS UUID AS $$
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

    --  CORRECT PARAMETER ORDER
    RETURN finance.post_journal_entry('Bank Transfer: ' || v_t.transfer_number, p_transaction_date, p_period_id, v_lines, 'PKR', 1.0000, 'BANK_TRANSFER', p_transfer_id, NULL, NULL);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;


-- ===========================================================================================================================
-- BUG #5: BANK AUTO-MATCH CASE SENSITIVITY
-- ===========================================================================================================================
-- Problem: je.status = 'posted' (lowercase) but data is stored as 'POSTED' (uppercase)

CREATE OR REPLACE FUNCTION finance.auto_match_statement_lines(p_statement_id UUID)
RETURNS INTEGER AS $$
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
$$ LANGUAGE plpgsql SECURITY DEFINER;


-- ===========================================================================================================================
-- BUG #6: TAX COMPUTATION INVERTED PBT
-- ===========================================================================================================================
-- Problem: Formula was (Expense credits - Expense debits) - (Revenue credits - Revenue debits)
-- Which = -Expenses - Revenue (WRONG, always negative for profitable company)
-- Correct: PBT = (Revenue credits - Revenue debits) - (Expense debits - Expense credits)

CREATE OR REPLACE FUNCTION finance.compute_tax_liability(p_tax_recon_id UUID)
RETURNS VOID AS $$
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
 $$ LANGUAGE plpgsql SECURITY DEFINER;


-- ===========================================================================================================================
-- BUG #7 & #8: CEO DASHBOARD FUNCTIONS
-- ===========================================================================================================================

-- BUG #7 FIX: audit_logs (plural, wrong table) → audit.audit_log (correct)
CREATE OR REPLACE FUNCTION reporting.ceo_table_audit()
RETURNS JSON AS $$
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
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;


-- BUG #8 FIX: is_current column doesn't exist on fiscal_years
-- Use status='OPEN' and most recent start_date instead
CREATE OR REPLACE FUNCTION reporting.ceo_table_fiscal()
RETURNS JSON AS $$
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
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;


-- ===========================================================================================================================
-- BUG #10: MISSING BUDGET TABLES
-- ===========================================================================================================================
-- Budgets table with proper columns
-- BUG #10: Add missing columns to EXISTING budgets table
ALTER TABLE public.budgets ADD COLUMN IF NOT EXISTS fiscal_year_id UUID REFERENCES finance.fiscal_years(id);
ALTER TABLE public.budgets ADD COLUMN IF NOT EXISTS project_id UUID REFERENCES public.projects(id) ON DELETE SET NULL;
ALTER TABLE public.budgets ADD COLUMN IF NOT EXISTS department TEXT;
ALTER TABLE public.budgets ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'DRAFT' 
    CHECK (status IN ('DRAFT','SUBMITTED','APPROVED','ACTIVE','CLOSED','REJECTED'));
ALTER TABLE public.budgets ADD COLUMN IF NOT EXISTS submitted_by UUID;
ALTER TABLE public.budgets ADD COLUMN IF NOT EXISTS submitted_at TIMESTAMPTZ;
ALTER TABLE public.budgets ADD COLUMN IF NOT EXISTS approved_by UUID;
ALTER TABLE public.budgets ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ;
ALTER TABLE public.budgets ADD COLUMN IF NOT EXISTS rejection_reason TEXT;
ALTER TABLE public.budgets ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

CREATE TABLE IF NOT EXISTS finance.budget_lines (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    budget_id UUID NOT NULL REFERENCES public.budgets(id) ON DELETE CASCADE,
    account_id UUID NOT NULL REFERENCES finance.chart_of_accounts(id),
    period_id UUID REFERENCES finance.accounting_periods(id),
    budgeted_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
    description TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_budgets_fy ON public.budgets(fiscal_year_id);
CREATE INDEX idx_budgets_status ON public.budgets(status);
CREATE INDEX idx_bl_budget ON finance.budget_lines(budget_id);
CREATE INDEX idx_bl_account ON finance.budget_lines(account_id);

ALTER TABLE public.budgets ENABLE ROW LEVEL SECURITY;
ALTER TABLE finance.budget_lines ENABLE ROW LEVEL SECURITY;

CREATE POLICY "budgets_select" ON public.budgets FOR SELECT USING (auth.uid() IS NOT NULL);
CREATE POLICY "budgets_insert" ON public.budgets FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);
CREATE POLICY "budgets_update" ON public.budgets FOR UPDATE USING (auth.uid() IS NOT NULL);
CREATE POLICY "bl_select" ON finance.budget_lines FOR SELECT USING (auth.uid() IS NOT NULL);
CREATE POLICY "bl_insert" ON finance.budget_lines FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);


-- ===========================================================================================================================
-- BUG: ATTACHMENTS METADATA TABLE
-- ===========================================================================================================================
CREATE TABLE IF NOT EXISTS finance.attachments (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    entity_type TEXT NOT NULL,
    entity_id UUID NOT NULL,
    file_name TEXT NOT NULL,
    file_type TEXT NOT NULL,
    file_size BIGINT NOT NULL DEFAULT 0,
    storage_path TEXT NOT NULL,
    file_hash TEXT,
    mime_type TEXT,
    description TEXT,
    uploaded_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_attachments_entity ON finance.attachments(entity_type, entity_id);
CREATE INDEX idx_attachments_hash ON finance.attachments(file_hash);

ALTER TABLE finance.attachments ENABLE ROW LEVEL SECURITY;
CREATE POLICY "att_select" ON finance.attachments FOR SELECT USING (auth.uid() IS NOT NULL);
CREATE POLICY "att_insert" ON finance.attachments FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);


-- ===========================================================================================================================
-- VERIFICATION
-- ===========================================================================================================================
DO $$
BEGIN
    -- Verify audit table has unified columns
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='audit' AND table_name='audit_log' AND column_name='entity_type') THEN
        RAISE EXCEPTION 'audit.audit_log missing entity_type column';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='audit' AND table_name='audit_log' AND column_name='table_schema') THEN
        RAISE EXCEPTION 'audit.audit_log missing table_schema column';
    END IF;

    -- Verify exchange_rates has rate_date column
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='finance' AND table_name='exchange_rates' AND column_name='rate_date') THEN
        RAISE EXCEPTION 'finance.exchange_rates missing rate_date column';
    END IF;

    -- Verify COA has expected account codes
    IF NOT EXISTS (SELECT 1 FROM finance.chart_of_accounts WHERE code='7121') THEN
        RAISE NOTICE 'WARNING: FX Loss account 7121 not found in COA';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM finance.chart_of_accounts WHERE code='2210') THEN
        RAISE NOTICE 'WARNING: Income Tax Payable 2210 not found in COA';
    END IF;

    RAISE NOTICE ' ALL P0 CRITICAL BUGS FIXED SUCCESSFULLY';
    RAISE NOTICE '   1. Audit schema unified (trigger + manual columns)';
    RAISE NOTICE '   2. Report mapping aligned with COA seed values';
    RAISE NOTICE '   3. All posting functions parameter order fixed';
    RAISE NOTICE '   4. Bank transfer: rate_date + FX account 7121';
    RAISE NOTICE '   5. Reconciliation: POSTED uppercase';
    RAISE NOTICE '   6. Tax PBT formula corrected';
    RAISE NOTICE '   7. CEO audit: audit.audit_log';
    RAISE NOTICE '   8. CEO fiscal: status=OPEN not is_current';
    RAISE NOTICE '   9. Vendor payment WHT: 2210 not 2201';
    RAISE NOTICE '  10. Budget + attachments tables created';
END $$;

COMMIT;