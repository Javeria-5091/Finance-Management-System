-- ==========================================
-- PHASE 6: BANK TRANSFERS
-- ==========================================

CREATE TABLE IF NOT EXISTS finance.bank_transfers (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    transfer_number TEXT UNIQUE,
    description TEXT,
    from_account_id UUID NOT NULL REFERENCES finance.financial_accounts(id),
    from_currency TEXT NOT NULL DEFAULT 'PKR',
    from_amount NUMERIC(18,2) NOT NULL CHECK (from_amount > 0),
    to_account_id UUID NOT NULL REFERENCES finance.financial_accounts(id),
    to_currency TEXT NOT NULL DEFAULT 'PKR',
    to_amount NUMERIC(18,2) NOT NULL CHECK (to_amount > 0),
    exchange_rate NUMERIC(18,6) NOT NULL DEFAULT 1.000000 CHECK (exchange_rate > 0),
    fx_rate_date DATE,
    transfer_date DATE NOT NULL DEFAULT CURRENT_DATE,
    status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'SUBMITTED', 'APPROVED', 'POSTED', 'REVERSED', 'REJECTED', 'CANCELLED')),
    requires_dual_approval BOOLEAN DEFAULT false,
    approved_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    approved_at TIMESTAMPTZ,
    second_approved_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    second_approved_at TIMESTAMPTZ,
    rejected_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    rejected_at TIMESTAMPTZ,
    rejection_reason TEXT,
    journal_entry_id UUID,
    period_id UUID REFERENCES finance.accounting_periods(id),
    posted_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    posted_at TIMESTAMPTZ,
    reversal_reason TEXT,
    reversed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,

    CONSTRAINT uq_transfer_number UNIQUE (transfer_number),
    CONSTRAINT chk_diff_accounts CHECK (from_account_id != to_account_id)
);

-- Trigger: Auto generate BT-0001
CREATE OR REPLACE FUNCTION finance.fn_gen_bt_number()
RETURNS TRIGGER AS $$ DECLARE v_n INT;
BEGIN
    IF NEW.transfer_number IS NULL OR NEW.transfer_number = '' THEN
        SELECT COALESCE(MAX(CAST(SUBSTRING(transfer_number FROM 4) AS INT)),0)+1
        INTO v_n FROM finance.bank_transfers WHERE transfer_number LIKE 'BT-%';
        NEW.transfer_number := 'BT-' || LPAD(v_n::TEXT, 5, '0');
    END IF;
    RETURN NEW;
END;
 $$ LANGUAGE plpgsql;
CREATE TRIGGER trg_gen_bt_number BEFORE INSERT ON finance.bank_transfers FOR EACH ROW EXECUTE FUNCTION finance.fn_gen_bt_number();

-- Trigger: Auto dual approval
CREATE OR REPLACE FUNCTION finance.fn_set_dual_approval()
RETURNS TRIGGER AS $$ DECLARE v_min NUMERIC;
BEGIN
    SELECT MIN(COALESCE(min_dual_approval_amount, 999999999999))
    INTO v_min FROM finance.financial_accounts WHERE id IN (NEW.from_account_id, NEW.to_account_id);
    IF NEW.from_amount >= v_min THEN NEW.requires_dual_approval := TRUE; END IF;
    RETURN NEW;
END;
 $$ LANGUAGE plpgsql;
CREATE TRIGGER trg_set_dual_approval BEFORE INSERT OR UPDATE OF from_amount ON finance.bank_transfers FOR EACH ROW EXECUTE FUNCTION finance.fn_set_dual_approval();

-- Trigger: updated_at
CREATE OR REPLACE FUNCTION finance.fn_bt_updated_at() RETURNS TRIGGER AS $$ BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
 $$ LANGUAGE plpgsql;
CREATE TRIGGER trg_bt_updated_at BEFORE UPDATE ON finance.bank_transfers FOR EACH ROW EXECUTE FUNCTION finance.fn_bt_updated_at();

-- Indexes
CREATE INDEX idx_bt_from ON finance.bank_transfers(from_account_id);
CREATE INDEX idx_bt_to ON finance.bank_transfers(to_account_id);
CREATE INDEX idx_bt_date ON finance.bank_transfers(transfer_date);
CREATE INDEX idx_bt_status ON finance.bank_transfers(status);

-- RLS
ALTER TABLE finance.bank_transfers ENABLE ROW LEVEL SECURITY;
CREATE POLICY "bt_select" ON finance.bank_transfers FOR SELECT USING (auth.uid() IS NOT NULL);
CREATE POLICY "bt_insert" ON finance.bank_transfers FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);
CREATE POLICY "bt_update" ON finance.bank_transfers FOR UPDATE USING (auth.uid() IS NOT NULL);
CREATE POLICY "bt_delete" ON finance.bank_transfers FOR DELETE USING (auth.uid() IS NOT NULL);

-- Audit
CREATE TRIGGER bt_audit AFTER INSERT OR UPDATE OR DELETE ON finance.bank_transfers FOR EACH ROW EXECUTE FUNCTION audit.trigger_audit_log();

-- POSTING FUNCTION
CREATE OR REPLACE FUNCTION finance.post_bank_transfer(
    p_transfer_id UUID, p_period_id UUID, p_transaction_date DATE
) RETURNS UUID AS $$ DECLARE
    v_t RECORD; v_fy_id UUID; v_from_ledger UUID; v_to_ledger UUID;
    v_fx_gain UUID; v_fx_loss UUID; v_lines JSONB := '[]'::JSONB;
    v_fx_diff NUMERIC(18,2); v_from_base NUMERIC(18,2); v_to_base NUMERIC(18,2);
    v_from_rate NUMERIC(18,6); v_to_rate NUMERIC(18,6);
BEGIN
    SELECT * INTO v_t FROM finance.bank_transfers WHERE id = p_transfer_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Transfer not found'; END IF;
    IF v_t.status NOT IN ('APPROVED','SUBMITTED') THEN RAISE EXCEPTION 'Must be approved, status: %', v_t.status; END IF;

    SELECT fiscal_year_id INTO v_fy_id FROM finance.accounting_periods WHERE id = p_period_id;
    IF v_fy_id IS NULL THEN RAISE EXCEPTION 'Invalid period'; END IF;

    SELECT linked_ledger_account_id INTO v_from_ledger FROM finance.financial_accounts WHERE id = v_t.from_account_id;
    SELECT linked_ledger_account_id INTO v_to_ledger FROM finance.financial_accounts WHERE id = v_t.to_account_id;
    SELECT id INTO v_fx_gain FROM finance.chart_of_accounts WHERE code = '4210' LIMIT 1;
    SELECT id INTO v_fx_loss FROM finance.chart_of_accounts WHERE code = '7210' LIMIT 1;

    -- From side to PKR base
    IF v_t.from_currency = 'PKR' THEN v_from_base := v_t.from_amount; v_from_rate := 1;
    ELSE
        SELECT rate INTO v_from_rate FROM finance.exchange_rates WHERE from_currency = v_t.from_currency AND to_currency = 'PKR' ORDER BY effective_date DESC LIMIT 1;
        IF v_from_rate IS NULL THEN v_from_rate := v_t.exchange_rate; END IF;
        v_from_base := ROUND(v_t.from_amount * v_from_rate, 2);
    END IF;

    -- To side to PKR base
    IF v_t.to_currency = 'PKR' THEN v_to_base := v_t.to_amount; v_to_rate := 1;
    ELSE
        SELECT rate INTO v_to_rate FROM finance.exchange_rates WHERE from_currency = v_t.to_currency AND to_currency = 'PKR' ORDER BY effective_date DESC LIMIT 1;
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

    RETURN finance.post_journal_entry('Bank Transfer: ' || v_t.transfer_number, p_transaction_date, p_period_id, 'PKR', 1.0000, 'BANK_TRANSFER', p_transfer_id, NULL, NULL, v_lines);
END;
 $$ LANGUAGE plpgsql SECURITY DEFINER;