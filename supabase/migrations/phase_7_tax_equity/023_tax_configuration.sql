-- ==========================================
-- PHASE 7.1–7.2: TAX CONFIGURATION & RECONCILIATION
-- ==========================================

-- 1. TAXPAYER PROFILE (single row for OSYSTIC)
CREATE TABLE IF NOT EXISTS finance.taxpayer_profile (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    legal_entity_type TEXT NOT NULL DEFAULT 'AOP' CHECK (legal_entity_type IN (
        'SOLE_PROPRIETOR', 'AOP', 'COMPANY', 'INDIVIDUAL'
    )),
    ntn_number TEXT,
    filing_jurisdiction TEXT NOT NULL DEFAULT 'PAKISTAN',
    tax_status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (tax_status IN ('ACTIVE', 'SUSPENDED', 'DEREGISTERED')),
    default_tax_year_basis TEXT NOT NULL DEFAULT 'JUL_JUN',
    cnic_number TEXT,
    registered_address TEXT,
    contact_phone TEXT,
    configured_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    approved_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    approved_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),

    CONSTRAINT uq_taxpayer_profile UNIQUE (ntn_number)
);

-- Insert default row
INSERT INTO finance.taxpayer_profile (legal_entity_type, ntn_number, default_tax_year_basis, configured_by)
VALUES ('AOP', NULL, 'JUL_JUN', NULL)
ON CONFLICT DO NOTHING;

-- 2. TAX RULE SETS
CREATE TABLE IF NOT EXISTS finance.tax_rule_sets (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    name TEXT NOT NULL,
    jurisdiction TEXT NOT NULL DEFAULT 'PAKISTAN',
    taxpayer_type TEXT NOT NULL,
    tax_year TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'APPROVED', 'LOCKED', 'SUPERSEDED')),
    approved_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    approved_at TIMESTAMPTZ,
    version INTEGER NOT NULL DEFAULT 1,
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,

    CONSTRAINT uq_tax_rule UNIQUE (tax_year, taxpayer_type, jurisdiction, version)
);

-- 3. TAX SLABS
CREATE TABLE IF NOT EXISTS finance.tax_slabs (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    tax_rule_set_id UUID NOT NULL REFERENCES finance.tax_rule_sets(id) ON DELETE CASCADE,
    slab_name TEXT,
    income_from NUMERIC(18,2) NOT NULL,
    income_to NUMERIC(18,2),
    tax_rate NUMERIC(5,2) NOT NULL,
    fixed_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
    slab_type TEXT NOT NULL DEFAULT 'PROGRESSIVE' CHECK (slab_type IN ('PROGRESSIVE', 'FLAT', 'FIXED')),
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_ts_rule ON finance.tax_slabs(tax_rule_set_id);
CREATE INDEX idx_ts_sort ON finance.tax_slabs(tax_rule_set_id, sort_order);

-- 4. TAX RECONCILIATIONS
CREATE TABLE IF NOT EXISTS finance.tax_reconciliations (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    tax_year TEXT NOT NULL,
    fiscal_year_id UUID NOT NULL,
    accounting_profit_before_tax NUMERIC(18,2) NOT NULL DEFAULT 0,
    taxable_income NUMERIC(18,2) NOT NULL DEFAULT 0,
    gross_tax_liability NUMERIC(18,2) NOT NULL DEFAULT 0,
    withholding_credits NUMERIC(18,2) NOT NULL DEFAULT 0,
    advance_tax_credits NUMERIC(18,2) NOT NULL DEFAULT 0,
    other_tax_credits NUMERIC(18,2) NOT NULL DEFAULT 0,
    net_tax_payable NUMERIC(18,2) NOT NULL DEFAULT 0,
    profit_after_tax NUMERIC(18,2) NOT NULL DEFAULT 0,
    effective_tax_rate NUMERIC(5,2) NOT NULL DEFAULT 0,
    tax_rule_set_id UUID NOT NULL REFERENCES finance.tax_rule_sets(id),
    status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN (
        'DRAFT', 'CALCULATED', 'UNDER_REVIEW', 'ACCOUNTANT_APPROVED',
        'FILED', 'PAYMENT_PENDING', 'PAID', 'REFUND_PENDING', 'AMENDED', 'CLOSED'
    )),
    filing_date DATE,
    filing_reference TEXT,
    filed_values JSONB,
    payment_reference TEXT,
    payment_date DATE,
    accountant_approved_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    approved_at TIMESTAMPTZ,
    rejection_reason TEXT,
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,

    CONSTRAINT uq_tax_recon_year UNIQUE (tax_year)
);

CREATE INDEX idx_tr_fy ON finance.tax_reconciliations(fiscal_year_id);
CREATE INDEX idx_tr_rule ON finance.tax_reconciliations(tax_rule_set_id);
CREATE INDEX idx_tr_status ON finance.tax_reconciliations(status);

-- 5. TAX ADJUSTMENTS
CREATE TABLE IF NOT EXISTS finance.tax_adjustments (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    tax_reconciliation_id UUID NOT NULL REFERENCES finance.tax_reconciliations(id) ON DELETE CASCADE,
    adjustment_category TEXT NOT NULL CHECK (adjustment_category IN (
        'ADD_BACK', 'DEDUCTION', 'NON_DEDUCTIBLE', 'EXEMPTION',
        'DEPRECIATION_DIFF', 'PROVISION_ADJUST', 'PRIVATE_EXPENSE',
        'CAPITAL_VS_REVENUE', 'LOSS_CARRY_FORWARD', 'SEPARATE_BLOCK',
        'TAX_DEPRECIATION', 'OTHER'
    )),
    description TEXT NOT NULL,
    amount NUMERIC(18,2) NOT NULL,
    source_account_id UUID REFERENCES finance.chart_of_accounts(id) ON DELETE SET NULL,
    evidence_notes TEXT,
    created_by UUID NOT NULL REFERENCES auth.users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_ta_recon ON finance.tax_adjustments(tax_reconciliation_id);
CREATE INDEX idx_ta_category ON finance.tax_adjustments(adjustment_category);

-- ==========================================
-- TAX COMPUTATION FUNCTION (DETERMINISTIC)
-- ==========================================
CREATE OR REPLACE FUNCTION finance.compute_tax_liability(p_tax_recon_id UUID)
RETURNS VOID AS $$ DECLARE
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
    -- 1. Get reconciliation record
    SELECT * INTO v_recon FROM finance.tax_reconciliations WHERE id = p_tax_recon_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Tax reconciliation not found'; END IF;

    -- 2. Validate rule set is locked
    SELECT status INTO v_rule_status FROM finance.tax_rule_sets WHERE id = v_recon.tax_rule_set_id;
    IF v_rule_status IS NULL THEN RAISE EXCEPTION 'Tax rule set not found'; END IF;
    IF v_rule_status NOT IN ('APPROVED', 'LOCKED') THEN
        RAISE EXCEPTION 'Tax rule set must be APPROVED or LOCKED, current: %', v_rule_status;
    END IF;

    -- 3. Calculate Accounting PBT from GL (Revenue - Expenses for the fiscal year)
    SELECT 
        COALESCE(SUM(CASE WHEN coa.account_type IN ('OTHER_EXPENSE','OPERATING_EXPENSE','COST_OF_SALES') 
                          THEN jl.credit_amount ELSE 0 END), 0) -
        COALESCE(SUM(CASE WHEN coa.account_type IN ('OTHER_EXPENSE','OPERATING_EXPENSE','COST_OF_SALES')
                          THEN jl.debit_amount ELSE 0 END), 0)
        -
        COALESCE(SUM(CASE WHEN coa.account_type IN ('REVENUE','OTHER_INCOME')
                          THEN jl.credit_amount ELSE 0 END), 0)
        +
        COALESCE(SUM(CASE WHEN coa.account_type IN ('REVENUE','OTHER_INCOME')
                          THEN jl.debit_amount ELSE 0 END), 0)
    INTO v_pbt
    FROM finance.journal_lines jl
    JOIN finance.journal_entries je ON je.id = jl.journal_entry_id
    JOIN finance.chart_of_accounts coa ON coa.id = jl.account_id
    JOIN finance.accounting_periods ap ON ap.id = je.period_id
    WHERE ap.fiscal_year_id = v_recon.fiscal_year_id
      AND je.status = 'POSTED'
      AND coa.account_type IN ('REVENUE','COST_OF_SALES','OPERATING_EXPENSE','OTHER_INCOME','OTHER_EXPENSE');

    -- 4. Sum adjustments (positive = add-back, negative = deduction)
    SELECT COALESCE(SUM(amount), 0) INTO v_total_adj
    FROM finance.tax_adjustments
    WHERE tax_reconciliation_id = p_tax_recon_id;

    -- 5. Taxable Income = PBT + Adjustments
    v_taxable_income := v_pbt + v_total_adj;

    -- 6. Apply Tax Slabs progressively
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

    -- 7. Update reconciliation
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

-- ==========================================
-- RLS
-- ==========================================
ALTER TABLE finance.taxpayer_profile ENABLE ROW LEVEL SECURITY;
ALTER TABLE finance.tax_rule_sets ENABLE ROW LEVEL SECURITY;
ALTER TABLE finance.tax_slabs ENABLE ROW LEVEL SECURITY;
ALTER TABLE finance.tax_reconciliations ENABLE ROW LEVEL SECURITY;
ALTER TABLE finance.tax_adjustments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "tp_select" ON finance.taxpayer_profile FOR SELECT USING (auth.uid() IS NOT NULL);
CREATE POLICY "tp_update" ON finance.taxpayer_profile FOR UPDATE USING (auth.uid() IS NOT NULL);

CREATE POLICY "trs_select" ON finance.tax_rule_sets FOR SELECT USING (auth.uid() IS NOT NULL);
CREATE POLICY "trs_insert" ON finance.tax_rule_sets FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);
CREATE POLICY "trs_update" ON finance.tax_rule_sets FOR UPDATE USING (auth.uid() IS NOT NULL);

CREATE POLICY "tsl_select" ON finance.tax_slabs FOR SELECT USING (auth.uid() IS NOT NULL);
CREATE POLICY "tsl_insert" ON finance.tax_slabs FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);
CREATE POLICY "tsl_update" ON finance.tax_slabs FOR UPDATE USING (auth.uid() IS NOT NULL);
CREATE POLICY "tsl_delete" ON finance.tax_slabs FOR DELETE USING (auth.uid() IS NOT NULL);

CREATE POLICY "tr_select" ON finance.tax_reconciliations FOR SELECT USING (auth.uid() IS NOT NULL);
CREATE POLICY "tr_insert" ON finance.tax_reconciliations FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);
CREATE POLICY "tr_update" ON finance.tax_reconciliations FOR UPDATE USING (auth.uid() IS NOT NULL);

CREATE POLICY "ta_select" ON finance.tax_adjustments FOR SELECT USING (auth.uid() IS NOT NULL);
CREATE POLICY "ta_insert" ON finance.tax_adjustments FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);
CREATE POLICY "ta_update" ON finance.tax_adjustments FOR UPDATE USING (auth.uid() IS NOT NULL);
CREATE POLICY "ta_delete" ON finance.tax_adjustments FOR DELETE USING (auth.uid() IS NOT NULL);

-- ==========================================
-- AUDIT TRIGGERS
-- ==========================================
CREATE TRIGGER trs_audit AFTER INSERT OR UPDATE OR DELETE ON finance.tax_rule_sets
FOR EACH ROW EXECUTE FUNCTION audit.trigger_audit_log();
CREATE TRIGGER tsl_audit AFTER INSERT OR UPDATE OR DELETE ON finance.tax_slabs
FOR EACH ROW EXECUTE FUNCTION audit.trigger_audit_log();
CREATE TRIGGER tr_audit AFTER INSERT OR UPDATE ON finance.tax_reconciliations
FOR EACH ROW EXECUTE FUNCTION audit.trigger_audit_log();
CREATE TRIGGER ta_audit AFTER INSERT OR UPDATE OR DELETE ON finance.tax_adjustments
FOR EACH ROW EXECUTE FUNCTION audit.trigger_audit_log();
CREATE TRIGGER tp_audit AFTER INSERT OR UPDATE ON finance.taxpayer_profile
FOR EACH ROW EXECUTE FUNCTION audit.trigger_audit_log();

-- ==========================================
-- AUTO UPDATED_AT TRIGGERS
-- ==========================================
CREATE OR REPLACE FUNCTION finance.fn_tax_updated_at() RETURNS TRIGGER AS $$ BEGIN NEW.updated_at = NOW(); RETURN NEW; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER trs_uat BEFORE UPDATE ON finance.tax_rule_sets FOR EACH ROW EXECUTE FUNCTION finance.fn_tax_updated_at();
CREATE TRIGGER tsl_uat BEFORE UPDATE ON finance.tax_slabs FOR EACH ROW EXECUTE FUNCTION finance.fn_tax_updated_at();
CREATE TRIGGER tr_uat BEFORE UPDATE ON finance.tax_reconciliations FOR EACH ROW EXECUTE FUNCTION finance.fn_tax_updated_at();
CREATE TRIGGER ta_uat BEFORE UPDATE ON finance.tax_adjustments FOR EACH ROW EXECUTE FUNCTION finance.fn_tax_updated_at();
CREATE TRIGGER tp_uat BEFORE UPDATE ON finance.taxpayer_profile FOR EACH ROW EXECUTE FUNCTION finance.fn_tax_updated_at();