-- ==========================================
-- PHASE 5: PAYABLE AGING VIEW & POSTING ENGINE
-- FIXED VERSION — All 9 errors resolved
-- ==========================================

-- ============================================================
-- 1. PAYABLE AGING VIEW
-- FIX #1,#2,#3: base_* columns → actual column names
-- FIX #4: uppercase statuses → lowercase enum values
-- ============================================================
CREATE OR REPLACE VIEW reporting.payable_aging AS
SELECT 
  vb.id AS bill_id,
  vb.bill_number,
  vb.vendor_id,
  v.name AS vendor_name,
  vb.project_id,
  vb.total_amount,              -- FIX #2: was base_total_amount
  vb.amount_paid,               -- FIX #1: was base_amount_paid
  vb.outstanding_amount,        -- FIX #3: was base_outstanding_amount
  vb.due_date,
  vb.bill_date,
  vb.status,
  CASE 
    WHEN vb.outstanding_amount <= 0 THEN 0
    WHEN vb.due_date >= CURRENT_DATE THEN vb.outstanding_amount
    ELSE 0
  END AS current_amount,
  CASE 
    WHEN vb.due_date < CURRENT_DATE 
      AND vb.due_date >= CURRENT_DATE - INTERVAL '30 days' THEN vb.outstanding_amount
    ELSE 0
  END AS overdue_1_30_days,
  CASE 
    WHEN vb.due_date < CURRENT_DATE - INTERVAL '30 days' 
      AND vb.due_date >= CURRENT_DATE - INTERVAL '60 days' THEN vb.outstanding_amount
    ELSE 0
  END AS overdue_31_60_days,
  CASE 
    WHEN vb.due_date < CURRENT_DATE - INTERVAL '60 days' 
      AND vb.due_date >= CURRENT_DATE - INTERVAL '90 days' THEN vb.outstanding_amount
    ELSE 0
  END AS overdue_61_90_days,
  CASE 
    WHEN vb.due_date < CURRENT_DATE - INTERVAL '90 days' THEN vb.outstanding_amount
    ELSE 0
  END AS overdue_over_90_days
FROM finance.vendor_bills vb
JOIN finance.vendors v ON v.id = vb.vendor_id
-- FIX #4: lowercase enum values matching your DB enum definition
WHERE vb.status IN ('posted', 'partially_paid', 'paid', 'overdue');


-- ============================================================
-- 2. AUTO-UPDATE VENDOR BILL STATUS ON PAYMENT
-- FIX #5: uppercase statuses → lowercase
-- FIX #6: DELETE operation → use OLD instead of NEW
-- ============================================================
CREATE OR REPLACE FUNCTION finance.auto_update_bill_status()
RETURNS TRIGGER AS $$ 
DECLARE
  v_bill_id UUID;
  v_outstanding NUMERIC(18,2);
  v_total NUMERIC(18,2);
BEGIN
  -- FIX #6: For DELETE, use OLD; for INSERT/UPDATE, use NEW
  v_bill_id := COALESCE(NEW.vendor_bill_id, OLD.vendor_bill_id);

  SELECT 
    vb.total_amount - COALESCE(SUM(vpa.allocated_amount), 0)
  INTO v_outstanding
  FROM finance.vendor_bills vb
  LEFT JOIN finance.vendor_payment_allocations vpa ON vpa.vendor_bill_id = vb.id
  WHERE vb.id = v_bill_id
  GROUP BY vb.total_amount;
  
  SELECT total_amount INTO v_total FROM finance.vendor_bills WHERE id = v_bill_id;
  
  UPDATE finance.vendor_bills SET 
    amount_paid = v_total - v_outstanding,
    outstanding_amount = v_outstanding,
    status = CASE 
      -- FIX #5: lowercase enum values
      WHEN v_outstanding <= 0 THEN 'paid'
      WHEN v_outstanding < v_total THEN 'partially_paid'
      ELSE status
    END
  WHERE id = v_bill_id;
  
  RETURN COALESCE(NEW, OLD);
END;
 $$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_alloc_bill_status ON finance.vendor_payment_allocations;
CREATE TRIGGER trg_alloc_bill_status
AFTER INSERT OR UPDATE OR DELETE ON finance.vendor_payment_allocations
FOR EACH ROW EXECUTE FUNCTION finance.auto_update_bill_status();


-- ============================================================
-- 3. VENDOR BILL POSTING LOGIC
-- FIX: v_line RECORD; declaration added
-- ============================================================
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
  v_line RECORD;              -- ✅ FIX: yeh line add ki
BEGIN
  SELECT * INTO v_bill FROM finance.vendor_bills WHERE id = p_bill_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Bill not found'; END IF;
  
  SELECT fiscal_year_id INTO v_fy_id FROM finance.accounting_periods WHERE id = p_period_id;
  IF v_fy_id IS NULL THEN RAISE EXCEPTION 'Invalid period'; END IF;

  -- Get actual Accounts from COA
  SELECT id INTO v_ap_account FROM finance.chart_of_accounts WHERE code = '2110' LIMIT 1;
  IF v_ap_account IS NULL THEN RAISE EXCEPTION 'AP account 2110 not found in COA'; END IF;

  SELECT id INTO v_wht_account FROM finance.chart_of_accounts WHERE code = '1401' LIMIT 1;
  IF v_wht_account IS NULL THEN RAISE EXCEPTION 'WHT account 1401 not found in COA'; END IF;

  -- Line Items Loop
  FOR v_line IN (
    SELECT 
      id, 
      account_id, 
      COALESCE(base_total, line_total) AS line_amount,
      description,
      COALESCE(base_withholding_amount, withholding_amount, 0) AS wht_amount
    FROM finance.vendor_bill_lines 
    WHERE vendor_bill_id = p_bill_id
  ) LOOP
    -- Debit Expense Account (net of withholding)
    v_lines := v_lines || jsonb_build_object(
      'account_id', v_line.account_id,
      'debit_amount', v_line.line_amount - v_line.wht_amount,
      'credit_amount', 0,
      'description', v_line.description
    );
    
    -- Debit WHT Receivable (If any withholding)
    IF v_line.wht_amount > 0 THEN
      v_lines := v_lines || jsonb_build_object(
        'account_id', v_wht_account,
        'debit_amount', v_line.wht_amount,
        'credit_amount', 0,
        'description', 'WHT on Bill ' || v_bill.bill_number
      );
    END IF;
  END LOOP;

  -- Credit Total AP Account
  v_lines := v_lines || jsonb_build_object(
    'account_id', v_ap_account,
    'debit_amount', 0,
    'credit_amount', v_bill.total_amount,
    'description', 'AP: ' || v_bill.bill_number || ' - ' || (SELECT name FROM finance.vendors WHERE id = v_bill.vendor_id)
  );

  RETURN finance.post_journal_entry(
    'AP Bill: ' || v_bill.bill_number,
    p_transaction_date, p_period_id, 'PKR', 1.0000,
    'VENDOR_BILL', p_bill_id, v_bill.project_id, NULL, v_lines
  );
END;
 $$ LANGUAGE plpgsql SECURITY DEFINER;


-- ============================================================
-- 4. VENDOR PAYMENT POSTING LOGIC
-- FIX #8: Wrong JOIN corrected (was joining lines on bill_id)
-- FIX #8b: Added NULL checks for safety
-- ============================================================
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
 $$ LANGUAGE plpgsql SECURITY DEFINER;


-- ============================================================
-- 5. AUDIT TRIGGERS
-- FIX #9: TRIGGER_audit_log() → audit.trigger_audit_log()
-- ============================================================

-- Vendor bills audit
DROP TRIGGER IF EXISTS vb_audit ON finance.vendor_bills;
CREATE TRIGGER vb_audit 
AFTER INSERT OR UPDATE ON finance.vendor_bills 
FOR EACH ROW EXECUTE FUNCTION audit.trigger_audit_log();

-- Vendor bill lines audit
DROP TRIGGER IF EXISTS vbl_audit ON finance.vendor_bill_lines;
CREATE TRIGGER vbl_audit 
AFTER INSERT OR UPDATE OR DELETE ON finance.vendor_bill_lines 
FOR EACH ROW EXECUTE FUNCTION audit.trigger_audit_log();

-- Vendor payments audit — FIX #9: was TRIGGER_audit_log()
DROP TRIGGER IF EXISTS vp_audit ON finance.vendor_payments;
CREATE TRIGGER vp_audit 
AFTER INSERT OR UPDATE ON finance.vendor_payments 
FOR EACH ROW EXECUTE FUNCTION audit.trigger_audit_log();

-- Vendor payment allocations audit
DROP TRIGGER IF EXISTS vpa_audit ON finance.vendor_payment_allocations;
CREATE TRIGGER vpa_audit 
AFTER INSERT OR UPDATE OR DELETE ON finance.vendor_payment_allocations 
FOR EACH ROW EXECUTE FUNCTION audit.trigger_audit_log();