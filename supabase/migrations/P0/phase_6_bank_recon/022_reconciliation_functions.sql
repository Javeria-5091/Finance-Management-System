-- ==========================================
-- PHASE 6: RECONCILIATION FUNCTIONS & VIEWS
-- ==========================================

-- 1. AUTO-MATCH (4 rounds)
-- 1. AUTO-MATCH (4 rounds) — FIXED VERSION
CREATE OR REPLACE FUNCTION finance.auto_match_statement_lines(p_statement_id UUID) RETURNS INTEGER AS $$ DECLARE
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
 $$ LANGUAGE plpgsql SECURITY DEFINER;

-- 2. MANUAL MATCH
CREATE OR REPLACE FUNCTION finance.manual_match_statement_line(
    p_line_id UUID, p_journal_line_id UUID, p_reason TEXT DEFAULT NULL
) RETURNS VOID AS $$ DECLARE v_sl RECORD; v_ledger UUID;
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
 $$ LANGUAGE plpgsql SECURITY DEFINER;

-- 3. UNMATCH
CREATE OR REPLACE FUNCTION finance.unmatch_statement_line(p_line_id UUID, p_reason TEXT DEFAULT NULL) RETURNS VOID AS $$ DECLARE v_sl RECORD;
BEGIN
    SELECT * INTO v_sl FROM finance.statement_lines WHERE id = p_line_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Line not found'; END IF;
    IF v_sl.reconciliation_status NOT IN ('MATCHED','MANUAL_MATCH') THEN RAISE EXCEPTION 'Can only unmatch matched lines'; END IF;
    UPDATE finance.statement_lines SET reconciliation_status = 'UNRECONCILED', matched_journal_line_id = NULL, matched_at = NULL, matched_by = NULL, match_method = NULL WHERE id = p_line_id;
END;
 $$ LANGUAGE plpgsql SECURITY DEFINER;

-- 4. EXCLUDE
CREATE OR REPLACE FUNCTION finance.exclude_statement_line(p_line_id UUID, p_reason TEXT) RETURNS VOID AS $$ BEGIN
    IF p_reason IS NULL OR p_reason = '' THEN RAISE EXCEPTION 'Reason required'; END IF;
    UPDATE finance.statement_lines SET reconciliation_status = 'EXCLUDED', exclusion_reason = p_reason
    WHERE id = p_line_id AND reconciliation_status = 'UNRECONCILED';
END;
 $$ LANGUAGE plpgsql SECURITY DEFINER;

-- 5. DETECT DUPLICATES
CREATE OR REPLACE FUNCTION finance.detect_duplicate_statement_lines(p_statement_id UUID) RETURNS INTEGER AS $$ DECLARE v_count INT;
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
 $$ LANGUAGE plpgsql SECURITY DEFINER;

-- 6. RECONCILIATION SUMMARY VIEW
-- 6. RECONCILIATION SUMMARY VIEW — FIXED
CREATE OR REPLACE VIEW reporting.reconciliation_summary AS
SELECT
    fa.id AS financial_account_id,
    fa.account_name,
    fa.institution_name,
    fa.currency,
    fa.masked_identifier,
    COALESCE(ledger.ledger_balance, 0) AS ledger_balance,
    COALESCE(latest.closing_balance, 0) AS statement_balance,
    COALESCE(ledger.ledger_balance, 0) - COALESCE(latest.closing_balance, 0) AS difference,
    COALESCE(cnts.total_lines, 0) AS total_lines,
    COALESCE(cnts.matched_lines, 0) AS matched_lines,
    COALESCE(cnts.unreconciled_lines, 0) AS unreconciled_lines,
    CASE WHEN COALESCE(cnts.total_lines, 0) = 0 THEN 100
         ELSE ROUND((COALESCE(cnts.matched_lines, 0)::NUMERIC / COALESCE(cnts.total_lines, 0)) * 100, 1)
    END AS reconciliation_pct,
    latest.statement_date AS latest_statement_date
FROM finance.financial_accounts fa
LEFT JOIN LATERAL (
    SELECT SUM(debit_amount - credit_amount) AS ledger_balance
    FROM finance.journal_lines jl
    JOIN finance.journal_entries je ON je.id = jl.journal_entry_id
    WHERE jl.account_id = fa.linked_ledger_account_id AND je.status = 'posted'
) ledger ON TRUE
LEFT JOIN LATERAL (
    SELECT closing_balance, statement_date
    FROM finance.bank_statements
    WHERE financial_account_id = fa.id
    ORDER BY statement_date DESC LIMIT 1
) latest ON TRUE
LEFT JOIN LATERAL (
    SELECT
        COUNT(*) AS total_lines,
        COUNT(*) FILTER (WHERE sl.reconciliation_status IN ('MATCHED','MANUAL_MATCH')) AS matched_lines,
        COUNT(*) FILTER (WHERE sl.reconciliation_status = 'UNRECONCILED') AS unreconciled_lines
    FROM finance.statement_lines sl
    JOIN finance.bank_statements bs ON bs.id = sl.bank_statement_id
    WHERE bs.financial_account_id = fa.id
) cnts ON TRUE
WHERE fa.is_active = TRUE;

-- 7. UNRECONCILED LINES VIEW
CREATE OR REPLACE VIEW reporting.unreconciled_lines AS
SELECT
    sl.id, sl.line_number, sl.transaction_date, sl.description, sl.reference,
    sl.counterparty, sl.amount, sl.balance_after,
    fa.account_name AS financial_account_name, fa.institution_name, fa.currency, fa.masked_identifier
FROM finance.statement_lines sl
JOIN finance.bank_statements bs ON bs.id = sl.bank_statement_id
JOIN finance.financial_accounts fa ON fa.id = bs.financial_account_id
WHERE sl.reconciliation_status = 'UNRECONCILED'
ORDER BY sl.transaction_date DESC, fa.account_name;