-- ==========================================
-- PHASE 6: BANK STATEMENTS & LINES
-- ==========================================

CREATE TABLE IF NOT EXISTS finance.bank_statements (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    financial_account_id UUID NOT NULL REFERENCES finance.financial_accounts(id) ON DELETE CASCADE,
    statement_date DATE NOT NULL,
    opening_balance NUMERIC(18,2) NOT NULL,
    closing_balance NUMERIC(18,2) NOT NULL,
    currency TEXT NOT NULL DEFAULT 'PKR',
    total_debits NUMERIC(18,2) DEFAULT 0,
    total_credits NUMERIC(18,2) DEFAULT 0,
    line_count INTEGER DEFAULT 0,
    imported_at TIMESTAMPTZ DEFAULT NOW(),
    imported_by UUID NOT NULL REFERENCES auth.users(id) ON DELETE SET NULL,
    file_name TEXT,
    reconciliation_status TEXT NOT NULL DEFAULT 'PENDING' CHECK (reconciliation_status IN ('PENDING', 'IN_PROGRESS', 'COMPLETED', 'PARTIAL')),
    reconciled_at TIMESTAMPTZ,
    reconciled_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS finance.statement_lines (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    bank_statement_id UUID NOT NULL REFERENCES finance.bank_statements(id) ON DELETE CASCADE,
    line_number INTEGER,
    transaction_date DATE NOT NULL,
    description TEXT,
    reference TEXT,
    counterparty TEXT,
    transaction_identifier TEXT,
    amount NUMERIC(18,2) NOT NULL,
    balance_after NUMERIC(18,2),
    reconciliation_status TEXT NOT NULL DEFAULT 'UNRECONCILED' CHECK (reconciliation_status IN (
        'UNRECONCILED', 'MATCHED', 'EXCLUDED', 'DUPLICATE', 'MANUAL_MATCH'
    )),
    matched_journal_line_id UUID REFERENCES finance.journal_lines(id),
    matched_at TIMESTAMPTZ,
    matched_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    match_method TEXT CHECK (match_method IS NULL OR match_method IN (
        'AUTO_AMOUNT_DATE', 'AUTO_AMOUNT_REF', 'AUTO_AMOUNT_DESC', 'AUTO_IDENTIFIER', 'MANUAL'
    )),
    exclusion_reason TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),

    CONSTRAINT uq_stmt_line UNIQUE (bank_statement_id, line_number),
    CONSTRAINT uq_stmt_txn_id UNIQUE (bank_statement_id, transaction_identifier) DEFERRABLE INITIALLY DEFERRED
);

-- Trigger: Auto line count
CREATE OR REPLACE FUNCTION finance.fn_stmt_line_count()
RETURNS TRIGGER AS $$ BEGIN
    UPDATE finance.bank_statements SET
        line_count = (SELECT COUNT(*) FROM finance.statement_lines WHERE bank_statement_id = COALESCE(NEW.bank_statement_id, OLD.bank_statement_id)),
        updated_at = NOW()
    WHERE id = COALESCE(NEW.bank_statement_id, OLD.bank_statement_id);
    RETURN COALESCE(NEW, OLD);
END;
 $$ LANGUAGE plpgsql;

CREATE TRIGGER trg_stmt_line_count
AFTER INSERT OR UPDATE OR DELETE ON finance.statement_lines
FOR EACH ROW EXECUTE FUNCTION finance.fn_stmt_line_count();

-- Trigger: Auto recon status
CREATE OR REPLACE FUNCTION finance.fn_stmt_recon_status()
RETURNS TRIGGER AS $$ DECLARE v_total INT; v_matched INT; v_excluded INT; v_sid UUID;
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
 $$ LANGUAGE plpgsql;

CREATE TRIGGER trg_stmt_recon_status
AFTER INSERT OR UPDATE OR DELETE ON finance.statement_lines
FOR EACH ROW EXECUTE FUNCTION finance.fn_stmt_recon_status();

-- Trigger: Prevent double match
CREATE OR REPLACE FUNCTION finance.fn_prevent_double_match()
RETURNS TRIGGER AS $$ BEGIN
    IF NEW.matched_journal_line_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM finance.statement_lines WHERE matched_journal_line_id = NEW.matched_journal_line_id AND id != NEW.id AND reconciliation_status IN ('MATCHED','MANUAL_MATCH')
    ) THEN RAISE EXCEPTION 'Journal line already matched'; END IF;
    RETURN NEW;
END;
 $$ LANGUAGE plpgsql;

CREATE TRIGGER trg_prevent_double_match
BEFORE INSERT OR UPDATE OF matched_journal_line_id ON finance.statement_lines
FOR EACH ROW EXECUTE FUNCTION finance.fn_prevent_double_match();

-- Trigger: updated_at
CREATE OR REPLACE FUNCTION finance.fn_bs_sl_updated_at()
RETURNS TRIGGER AS $$ BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
 $$ LANGUAGE plpgsql;
CREATE TRIGGER trg_bs_updated_at BEFORE UPDATE ON finance.bank_statements FOR EACH ROW EXECUTE FUNCTION finance.fn_bs_sl_updated_at();
CREATE TRIGGER trg_sl_updated_at BEFORE UPDATE ON finance.statement_lines FOR EACH ROW EXECUTE FUNCTION finance.fn_bs_sl_updated_at();

-- Indexes
CREATE INDEX idx_bs_account ON finance.bank_statements(financial_account_id);
CREATE INDEX idx_bs_date ON finance.bank_statements(statement_date);
CREATE INDEX idx_sl_statement ON finance.statement_lines(bank_statement_id);
CREATE INDEX idx_sl_date ON finance.statement_lines(transaction_date);
CREATE INDEX idx_sl_amount ON finance.statement_lines(amount);
CREATE INDEX idx_sl_recon ON finance.statement_lines(reconciliation_status);
CREATE INDEX idx_sl_journal ON finance.statement_lines(matched_journal_line_id) WHERE matched_journal_line_id IS NOT NULL;
CREATE INDEX idx_sl_unreconciled ON finance.statement_lines(bank_statement_id, reconciliation_status) WHERE reconciliation_status = 'UNRECONCILED';

-- RLS
ALTER TABLE finance.bank_statements ENABLE ROW LEVEL SECURITY;
ALTER TABLE finance.statement_lines ENABLE ROW LEVEL SECURITY;
CREATE POLICY "bs_select" ON finance.bank_statements FOR SELECT USING (auth.uid() IS NOT NULL);
CREATE POLICY "bs_insert" ON finance.bank_statements FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);
CREATE POLICY "bs_update" ON finance.bank_statements FOR UPDATE USING (auth.uid() IS NOT NULL);
CREATE POLICY "sl_select" ON finance.statement_lines FOR SELECT USING (auth.uid() IS NOT NULL);
CREATE POLICY "sl_insert" ON finance.statement_lines FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);
CREATE POLICY "sl_update" ON finance.statement_lines FOR UPDATE USING (auth.uid() IS NOT NULL);
CREATE POLICY "sl_delete" ON finance.statement_lines FOR DELETE USING (auth.uid() IS NOT NULL);

-- Audit
CREATE TRIGGER bs_audit AFTER INSERT OR UPDATE OR DELETE ON finance.bank_statements FOR EACH ROW EXECUTE FUNCTION audit.trigger_audit_log();
CREATE TRIGGER sl_audit AFTER INSERT OR UPDATE OR DELETE ON finance.statement_lines FOR EACH ROW EXECUTE FUNCTION audit.trigger_audit_log();