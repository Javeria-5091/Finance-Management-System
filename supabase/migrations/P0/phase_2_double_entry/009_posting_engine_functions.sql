-- ==========================================
-- PHASE 2 - STEP 2.3: Posting Engine (CORRECTED)
-- ==========================================

CREATE OR REPLACE FUNCTION finance.post_journal_entry(
  -- REQUIRED PARAMETERS (Bina default ke)
  p_description TEXT,
  p_transaction_date DATE,
  p_period_id UUID,
  p_lines JSONB, 
  
  -- OPTIONAL PARAMETERS (Defaults ke sath)
  p_currency TEXT DEFAULT 'PKR',
  p_exchange_rate NUMERIC(18,4) DEFAULT 1.0000,
  p_source_type TEXT DEFAULT 'MANUAL',
  p_source_id UUID DEFAULT NULL,
  p_project_id UUID DEFAULT NULL,
  p_department_id UUID DEFAULT NULL
) RETURNS UUID AS $$ 
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
 $$ LANGUAGE plpgsql SECURITY DEFINER;

-- ==========================================
-- REVERSAL FUNCTION (Isme koi error nahi tha, lekin reverify kar lo)
-- ==========================================
CREATE OR REPLACE FUNCTION finance.reverse_journal_entry(
  p_journal_id UUID,
  p_reversal_date DATE,
  p_reason TEXT
) RETURNS UUID AS $$ 
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
 $$ LANGUAGE plpgsql SECURITY DEFINER;