-- ==========================================
-- PHASE 7.3: OWNERSHIP, RESERVES & DISTRIBUTIONS
-- ==========================================

-- 1. OWNERS
CREATE TABLE IF NOT EXISTS finance.owners (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    name TEXT NOT NULL,
    partner_class TEXT,
    status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'INACTIVE', 'EXITED')),
    cnic_number TEXT,
    contact_info TEXT,
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL
);

-- 2. OWNERSHIP HISTORY
CREATE TABLE IF NOT EXISTS finance.ownership_history (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    owner_id UUID NOT NULL REFERENCES finance.owners(id) ON DELETE CASCADE,
    ownership_percentage NUMERIC(5,2) NOT NULL CHECK (ownership_percentage >= 0 AND ownership_percentage <= 100),
    effective_from DATE NOT NULL,
    effective_to DATE,
    changed_by UUID NOT NULL REFERENCES auth.users(id) ON DELETE SET NULL,
    change_reason TEXT,
    approved_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 3. RESERVE POLICIES
CREATE TABLE IF NOT EXISTS finance.reserve_policies (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    policy_type TEXT NOT NULL CHECK (policy_type IN ('DISABLED', 'FIXED_AMOUNT', 'PERCENT_OF_PROFIT', 'PERCENT_OF_PAYOUT', 'TARGET_BALANCE', 'HYBRID')),
    fixed_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
    percentage NUMERIC(5,2) NOT NULL DEFAULT 0,
    target_balance NUMERIC(18,2) NOT NULL DEFAULT 0,
    effective_from DATE NOT NULL DEFAULT CURRENT_DATE,
    effective_to DATE,
    approved_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL
);

-- 4. PROFIT DISTRIBUTIONS
CREATE TABLE IF NOT EXISTS finance.profit_distributions (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    fiscal_year_id UUID NOT NULL REFERENCES finance.fiscal_years(id),
    period_id UUID REFERENCES finance.accounting_periods(id),
    total_available_profit NUMERIC(18,2) NOT NULL DEFAULT 0,
    reserve_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
    distributable_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'DECLARED', 'APPROVED', 'POSTED', 'PAID', 'CANCELLED')),
    declared_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    declared_at TIMESTAMPTZ,
    approved_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    approved_at TIMESTAMPTZ,
    posted_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    posted_at TIMESTAMPTZ,
    journal_entry_id UUID,
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL
);

-- 5. DISTRIBUTION LINES
CREATE TABLE IF NOT EXISTS finance.distribution_lines (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    profit_distribution_id UUID NOT NULL REFERENCES finance.profit_distributions(id) ON DELETE CASCADE,
    owner_id UUID NOT NULL REFERENCES finance.owners(id),
    ownership_percentage NUMERIC(5,2) NOT NULL DEFAULT 0,
    calculated_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
    overridden_amount NUMERIC(18,2),
    final_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
    payment_status TEXT NOT NULL DEFAULT 'PENDING' CHECK (payment_status IN ('PENDING', 'PAID', 'CANCELLED')),
    paid_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
    paid_date DATE,
    payment_reference TEXT,
    payment_account_id UUID, 
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- INDEXES
CREATE INDEX idx_oh_owner ON finance.ownership_history(owner_id);
CREATE INDEX idx_pd_fy ON finance.profit_distributions(fiscal_year_id);
CREATE INDEX idx_dl_dist ON finance.distribution_lines(profit_distribution_id);

-- RLS
ALTER TABLE finance.owners ENABLE ROW LEVEL SECURITY;
ALTER TABLE finance.ownership_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE finance.reserve_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE finance.profit_distributions ENABLE ROW LEVEL SECURITY;
ALTER TABLE finance.distribution_lines ENABLE ROW LEVEL SECURITY;

CREATE POLICY "o_all" ON finance.owners FOR ALL USING (auth.uid() IS NOT NULL);
CREATE POLICY "oh_all" ON finance.ownership_history FOR ALL USING (auth.uid() IS NOT NULL);
CREATE POLICY "rp_all" ON finance.reserve_policies FOR ALL USING (auth.uid() IS NOT NULL);
CREATE POLICY "pd_all" ON finance.profit_distributions FOR ALL USING (auth.uid() IS NOT NULL);
CREATE POLICY "dl_all" ON finance.distribution_lines FOR ALL USING (auth.uid() IS NOT NULL);

-- AUDIT & UPDATED_AT TRIGGERS
CREATE TRIGGER o_audit AFTER INSERT OR UPDATE OR DELETE ON finance.owners FOR EACH ROW EXECUTE FUNCTION audit.trigger_audit_log();
CREATE TRIGGER oh_audit AFTER INSERT OR UPDATE OR DELETE ON finance.ownership_history FOR EACH ROW EXECUTE FUNCTION audit.trigger_audit_log();
CREATE TRIGGER rp_audit AFTER INSERT OR UPDATE OR DELETE ON finance.reserve_policies FOR EACH ROW EXECUTE FUNCTION audit.trigger_audit_log();
CREATE TRIGGER pd_audit AFTER INSERT OR UPDATE OR DELETE ON finance.profit_distributions FOR EACH ROW EXECUTE FUNCTION audit.trigger_audit_log();
CREATE TRIGGER dl_audit AFTER INSERT OR UPDATE OR DELETE ON finance.distribution_lines FOR EACH ROW EXECUTE FUNCTION audit.trigger_audit_log();

CREATE TRIGGER o_uat BEFORE UPDATE ON finance.owners FOR EACH ROW EXECUTE FUNCTION finance.fn_tax_updated_at();
CREATE TRIGGER oh_uat BEFORE UPDATE ON finance.ownership_history FOR EACH ROW EXECUTE FUNCTION finance.fn_tax_updated_at();
CREATE TRIGGER rp_uat BEFORE UPDATE ON finance.reserve_policies FOR EACH ROW EXECUTE FUNCTION finance.fn_tax_updated_at();
CREATE TRIGGER pd_uat BEFORE UPDATE ON finance.profit_distributions FOR EACH ROW EXECUTE FUNCTION finance.fn_tax_updated_at();
CREATE TRIGGER dl_uat BEFORE UPDATE ON finance.distribution_lines FOR EACH ROW EXECUTE FUNCTION finance.fn_tax_updated_at();

-- ==========================================
-- POSTING FUNCTIONS
-- ==========================================

-- Post Profit Distribution (Dr. P&L, Cr. Reserves, Cr. Payable)
CREATE OR REPLACE FUNCTION finance.post_profit_distribution(
    p_distribution_id UUID, p_period_id UUID, p_transaction_date DATE
) RETURNS UUID AS $$ DECLARE
    v_dist RECORD; v_lines JSONB := '[]'::JSONB;
    v_pnl UUID; v_reserve UUID; v_payable UUID;
BEGIN
    SELECT * INTO v_dist FROM finance.profit_distributions WHERE id = p_distribution_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Distribution not found'; END IF;
    IF v_dist.status != 'APPROVED' THEN RAISE EXCEPTION 'Must be APPROVED'; END IF;

    SELECT id INTO v_pnl FROM finance.chart_of_accounts WHERE code = '3400' LIMIT 1;
    SELECT id INTO v_reserve FROM finance.chart_of_accounts WHERE code = '3310' LIMIT 1;
    SELECT id INTO v_payable FROM finance.chart_of_accounts WHERE code = '2410' LIMIT 1;

    v_lines := jsonb_build_object('account_id', v_pnl, 'debit_amount', v_dist.total_available_profit, 'credit_amount', 0, 'description', 'Close P&L & Transfer to Reserves/Distributions');
    
    IF v_dist.reserve_amount > 0 THEN
        v_lines := v_lines || jsonb_build_object('account_id', v_reserve, 'debit_amount', 0, 'credit_amount', v_dist.reserve_amount, 'description', 'Transfer to Reserves');
    END IF;
    
    IF v_dist.distributable_amount > 0 THEN
        v_lines := v_lines || jsonb_build_object('account_id', v_payable, 'debit_amount', 0, 'credit_amount', v_dist.distributable_amount, 'description', 'Profit Distribution Payable');
    END IF;

    RETURN finance.post_journal_entry('Profit Distribution', p_transaction_date, p_period_id, 'PKR', 1.0, 'PROFIT_DISTRIBUTION', p_distribution_id, NULL, NULL, v_lines);
END;
 $$ LANGUAGE plpgsql SECURITY DEFINER;

-- Post Owner Payment (Dr. Payable, Cr. Bank)
CREATE OR REPLACE FUNCTION finance.post_distribution_payment(
    p_line_id UUID, p_period_id UUID, p_transaction_date DATE, p_bank_account_id UUID
) RETURNS UUID AS $$ DECLARE
    v_line RECORD; v_lines JSONB := '[]'::JSONB;
    v_payable UUID; v_bank_ledger UUID; v_owner_name TEXT;
BEGIN
    SELECT * INTO v_line FROM finance.distribution_lines WHERE id = p_line_id;
    IF v_line.payment_status != 'PENDING' THEN RAISE EXCEPTION 'Already paid'; END IF;

    SELECT name INTO v_owner_name FROM finance.owners WHERE id = v_line.owner_id;
    SELECT id INTO v_payable FROM finance.chart_of_accounts WHERE code = '2410' LIMIT 1;
    SELECT linked_ledger_account_id INTO v_bank_ledger FROM finance.financial_accounts WHERE id = p_bank_account_id;

    v_lines := jsonb_build_object('account_id', v_payable, 'debit_amount', v_line.final_amount, 'credit_amount', 0, 'description', 'Payout to ' || v_owner_name);
    v_lines := v_lines || jsonb_build_object('account_id', v_bank_ledger, 'debit_amount', 0, 'credit_amount', v_line.final_amount, 'description', 'Payout to ' || v_owner_name);

    RETURN finance.post_journal_entry('Owner Payout', p_transaction_date, p_period_id, 'PKR', 1.0, 'DISTRIBUTION_PAYMENT', p_line_id, NULL, NULL, v_lines);
END;
 $$ LANGUAGE plpgsql SECURITY DEFINER;