-- ==========================================
-- PHASE 6: FINANCIAL ACCOUNTS
-- ==========================================

CREATE TABLE IF NOT EXISTS finance.financial_accounts (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    account_name TEXT NOT NULL,
    institution_name TEXT NOT NULL,
    institution_type TEXT NOT NULL CHECK (institution_type IN (
        'BANK', 'CASH', 'WALLET', 'PLATFORM', 'PAYMENT_GATEWAY', 'CARD', 'CLEARING'
    )),
    account_type TEXT NOT NULL CHECK (account_type IN (
        'CURRENT', 'SAVINGS', 'DIGITAL_WALLET', 'PLATFORM_BALANCE', 'PETTY_CASH', 'CLEARING'
    )),
    currency TEXT NOT NULL DEFAULT 'PKR',
    masked_identifier TEXT,
    opening_balance NUMERIC(18,2) NOT NULL DEFAULT 0,
    opening_date DATE,
    linked_ledger_account_id UUID NOT NULL REFERENCES finance.chart_of_accounts(id),
    reconciliation_method TEXT NOT NULL DEFAULT 'MANUAL' CHECK (reconciliation_method IN ('MANUAL', 'AUTO', 'IMPORT')),
    responsible_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    is_active BOOLEAN NOT NULL DEFAULT true,
    is_default BOOLEAN NOT NULL DEFAULT false,
    requires_dual_approval BOOLEAN DEFAULT false,
    min_dual_approval_amount NUMERIC(18,2),
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,

    CONSTRAINT uq_fin_account_name UNIQUE (account_name)
);

-- Trigger: Only one default per currency
CREATE OR REPLACE FUNCTION finance.fn_enforce_single_default_fa()
RETURNS TRIGGER AS $$ BEGIN
    IF NEW.is_default = TRUE THEN
        UPDATE finance.financial_accounts
        SET is_default = FALSE
        WHERE currency = NEW.currency AND id != NEW.id AND is_default = TRUE;
    END IF;
    RETURN NEW;
END;
 $$ LANGUAGE plpgsql;

CREATE TRIGGER trg_single_default_fa
BEFORE INSERT OR UPDATE OF is_default ON finance.financial_accounts
FOR EACH ROW EXECUTE FUNCTION finance.fn_enforce_single_default_fa();

-- Trigger: Linked account must be Asset (code starts with 1)
CREATE OR REPLACE FUNCTION finance.fn_validate_fa_ledger()
RETURNS TRIGGER AS $$ DECLARE v_code TEXT;
BEGIN
    SELECT LEFT(code, 1) INTO v_code FROM finance.chart_of_accounts WHERE id = NEW.linked_ledger_account_id;
    IF v_code != '1' THEN
        RAISE EXCEPTION 'Linked account must be Asset (1xxx), got: %', v_code;
    END IF;
    RETURN NEW;
END;
 $$ LANGUAGE plpgsql;

CREATE TRIGGER trg_validate_fa_ledger
BEFORE INSERT OR UPDATE OF linked_ledger_account_id ON finance.financial_accounts
FOR EACH ROW EXECUTE FUNCTION finance.fn_validate_fa_ledger();

-- Trigger: updated_at
CREATE OR REPLACE FUNCTION finance.fn_fa_updated_at()
RETURNS TRIGGER AS $$ BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
 $$ LANGUAGE plpgsql;

CREATE TRIGGER trg_fa_updated_at
BEFORE UPDATE ON finance.financial_accounts
FOR EACH ROW EXECUTE FUNCTION finance.fn_fa_updated_at();

-- Indexes
CREATE INDEX idx_fa_currency ON finance.financial_accounts(currency);
CREATE INDEX idx_fa_active ON finance.financial_accounts(is_active);
CREATE INDEX idx_fa_ledger ON finance.financial_accounts(linked_ledger_account_id);
CREATE INDEX idx_fa_type ON finance.financial_accounts(institution_type);

-- RLS
ALTER TABLE finance.financial_accounts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "fa_select" ON finance.financial_accounts FOR SELECT USING (auth.uid() IS NOT NULL);
CREATE POLICY "fa_insert" ON finance.financial_accounts FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);
CREATE POLICY "fa_update" ON finance.financial_accounts FOR UPDATE USING (auth.uid() IS NOT NULL);
CREATE POLICY "fa_delete" ON finance.financial_accounts FOR DELETE USING (auth.uid() IS NOT NULL);

-- Audit
CREATE TRIGGER fa_audit AFTER INSERT OR UPDATE OR DELETE ON finance.financial_accounts
FOR EACH ROW EXECUTE FUNCTION audit.trigger_audit_log();
