-- ============================================================
-- OSYSTIC Finance Management System - P1 Payroll Module
-- Migration 100: Payroll, Contractors, Commissions & Advances
-- Schema: finance
-- Priority: P1
-- ============================================================

-- Enable UUID extension if not already enabled
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================
-- 1. WORKERS TABLE
-- Finance-owned employee/contractor reference for payroll
-- Links to shared_people (future HR) via person_id
-- ============================================================
CREATE TABLE IF NOT EXISTS finance.workers (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    organization_id UUID NOT NULL REFERENCES core.organizations(id),
    person_id       UUID REFERENCES core.shared_people(id),  -- future HR link
    employee_code    VARCHAR(50) NOT NULL,
    full_name       VARCHAR(200) NOT NULL,
    email           VARCHAR(255),
    phone           VARCHAR(50),
    department      VARCHAR(100),
    designation     VARCHAR(150),
    worker_type     VARCHAR(20) NOT NULL DEFAULT 'employee'
                    CHECK (worker_type IN ('employee', 'contractor', 'consultant', 'intern')),
    employment_status VARCHAR(20) NOT NULL DEFAULT 'active'
                    CHECK (employment_status IN ('active', 'inactive', 'terminated', 'on_leave')),
    join_date       DATE NOT NULL,
    exit_date       DATE,
    bank_name       VARCHAR(100),
    bank_account    VARCHAR(100),
    bank_title      VARCHAR(200),
    cnic            VARCHAR(20),
    project_id       UUID REFERENCES finance.projects(id),
    cost_center_id  UUID,
    created_by       UUID REFERENCES auth.users(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_by       UUID REFERENCES auth.users(id),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    
    CONSTRAINT uq_worker_code_org UNIQUE (employee_code, organization_id)
);

COMMENT ON TABLE finance.workers IS 'Finance-owned employee/contractor master for payroll processing';
COMMENT ON COLUMN finance.workers.worker_type IS 'employee, contractor, consultant, or intern';
COMMENT ON COLUMN finance.workers.person_id IS 'Future link to HR shared_people when Employee Management System is integrated';

-- ============================================================
-- 2. COMPENSATION TERMS
-- Salary/rate, commission rules, effective-dated
-- Sensitive: requires PAYROLL_SENSITIVE_READ permission
-- ============================================================
CREATE TABLE IF NOT EXISTS finance.compensation_terms (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    worker_id       UUID NOT NULL REFERENCES finance.workers(id) ON DELETE CASCADE,
    compensation_type VARCHAR(30) NOT NULL
                    CHECK (compensation_type IN ('monthly_salary', 'daily_rate', 'hourly_rate', 
                                                'project_fixed', 'milestone_based', 'retainer')),
    amount          NUMERIC(15,2) NOT NULL CHECK (amount >= 0),
    currency        VARCHAR(10) NOT NULL DEFAULT 'PKR',
    pay_frequency   VARCHAR(20) NOT NULL DEFAULT 'monthly'
                    CHECK (pay_frequency IN ('weekly', 'biweekly', 'monthly', 'quarterly', 'project_end')),
    project_id      UUID REFERENCES finance.projects(id),
    cost_center_id  UUID,
    effective_from  DATE NOT NULL,
    effective_to    DATE,
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    overtime_rate   NUMERIC(5,2),  -- multiplier e.g. 1.5x
    allowance_fixed NUMERIC(12,2) DEFAULT 0 CHECK (allowance_fixed >= 0),
    allowance_transport NUMERIC(12,2) DEFAULT 0 CHECK (allowance_transport >= 0),
    allowance_medical NUMERIC(12,2) DEFAULT 0 CHECK (allowance_medical >= 0),
    allowance_housing NUMERIC(12,2) DEFAULT 0 CHECK (allowance_housing >= 0),
    tax_deduction_pct NUMERIC(5,2),  -- withholding tax %
    created_by      UUID REFERENCES auth.users(id),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    approved_by    UUID REFERENCES auth.users(id),
    approved_at    TIMESTAMPTZ,
    
    CONSTRAINT chk_effective_dates CHECK (effective_to IS NULL OR effective_to >= effective_from)
);

COMMENT ON TABLE finance.compensation_terms IS 'Effective-dated compensation/salary terms - SENSITIVE DATA';
COMMENT ON COLUMN finance.compensation_terms.amount IS 'Base salary or rate amount';

-- ============================================================
-- 3. COMMISSIONS TABLE
-- Commission rules and earned commissions
-- ============================================================
CREATE TABLE IF NOT EXISTS finance.commissions (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    worker_id       UUID NOT NULL REFERENCES finance.workers(id) ON DELETE CASCADE,
    commission_type VARCHAR(30) NOT NULL
                    CHECK (commission_type IN ('project_percentage', 'revenue_percentage', 
                                                'fixed_per_milestone', 'referral_bonus', 'performance_bonus')),
    project_id      UUID REFERENCES finance.projects(id),
    description     TEXT,
    rate_or_amount  NUMERIC(12,2) NOT NULL CHECK (rate_or_amount >= 0),
    is_percentage   BOOLEAN NOT NULL DEFAULT FALSE,  -- TRUE if rate_or_amount is a percentage
    basis           VARCHAR(50) DEFAULT 'project_revenue'
                    CHECK (basis IN ('project_revenue', 'invoice_amount', 'collection_amount', 
                                      'milestone_value', 'custom')),
    min_threshold   NUMERIC(15,2) DEFAULT 0 CHECK (min_threshold >= 0),
    max_payout      NUMERIC(15,2),  -- NULL = no cap
    effective_from  DATE NOT NULL,
    effective_to    DATE,
    status          VARCHAR(20) NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active', 'earned', 'paid', 'cancelled', 'expired')),
    earned_amount   NUMERIC(15,2) DEFAULT 0 CHECK (earned_amount >= 0),
    earned_date     DATE,
    payroll_run_id  UUID,  -- linked when paid through payroll
    created_by      UUID REFERENCES auth.users(id),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    
    CONSTRAINT chk_comm_dates CHECK (effective_to IS NULL OR effective_to >= effective_from)
);

COMMENT ON TABLE finance.commissions IS 'Commission rules and earned commission records';

-- ============================================================
-- 4. ADVANCES TABLE
-- Salary advances, project advances, recoverable advances
-- ============================================================
CREATE TABLE IF NOT EXISTS finance.advances (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    worker_id       UUID NOT NULL REFERENCES finance.workers(id) ON DELETE CASCADE,
    advance_type    VARCHAR(30) NOT NULL
                    CHECK (advance_type IN ('salary_advance', 'project_advance', 'travel_advance', 
                                                'emergency_advance', 'equipment_advance')),
    amount          NUMERIC(15,2) NOT NULL CHECK (amount > 0),
    currency        VARCHAR(10) NOT NULL DEFAULT 'PKR',
    purpose         TEXT NOT NULL,
    project_id      UUID REFERENCES finance.projects(id),
    recovery_method VARCHAR(30) NOT NULL DEFAULT 'salary_deduction'
                    CHECK (recovery_method IN ('salary_deduction', 'project_deduction', 
                                                'lump_sum', 'monthly_installment')),
    recovery_months INT DEFAULT 1 CHECK (recovery_months >= 1),
    amount_recovered NUMERIC(15,2) DEFAULT 0 CHECK (amount_recovered >= 0),
    balance_outstanding NUMERIC(15,2) GENERATED ALWAYS AS (amount - amount_recovered) STORED,
    status          VARCHAR(20) NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'approved', 'partially_recovered', 
                                        'fully_recovered', 'written_off', 'cancelled')),
    requested_date DATE NOT NULL DEFAULT CURRENT_DATE,
    approved_by     UUID REFERENCES auth.users(id),
    approved_at     TIMESTAMPTZ,
    journal_entry_id UUID,  -- linked when posted
    created_by      UUID REFERENCES auth.users(id),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE finance.advances IS 'Employee/contractor advances with recovery tracking';

-- ============================================================
-- 5. PAYROLL RUNS TABLE
-- Main payroll period header
-- ============================================================
CREATE TABLE IF NOT EXISTS finance.payroll_runs (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    organization_id UUID NOT NULL REFERENCES core.organizations(id),
    payroll_period_start DATE NOT NULL,
    payroll_period_end   DATE NOT NULL,
    period_id      UUID REFERENCES finance.accounting_periods(id),
    fiscal_year_id UUID REFERENCES finance.fiscal_years(id),
    payroll_type    VARCHAR(20) NOT NULL DEFAULT 'regular'
                    CHECK (payroll_type IN ('regular', 'bonus', 'overtime', 
                                            'final_settlement', 'correction', 'adhoc')),
    status          VARCHAR(20) NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft', 'calculating', 'review', 'approved', 
                                        'posted', 'paid', 'cancelled', 'rejected')),
    total_gross     NUMERIC(15,2) NOT NULL DEFAULT 0 CHECK (total_gross >= 0),
    total_deductions NUMERIC(15,2) NOT NULL DEFAULT 0 CHECK (total_deductions >= 0),
    total_net       NUMERIC(15,2) NOT NULL DEFAULT 0 CHECK (total_net >= 0),
    total_employer_cost NUMERIC(15,2) NOT NULL DEFAULT 0 CHECK (total_employer_cost >= 0),
    currency        VARCHAR(10) NOT NULL DEFAULT 'PKR',
    worker_count    INT NOT NULL DEFAULT 0 CHECK (worker_count >= 0),
    journal_entry_id UUID,  -- linked when posted to GL
    snapshot_id     UUID,  -- references payroll_input_snapshots
    calculated_by   UUID REFERENCES auth.users(id),
    calculated_at   TIMESTAMPTZ,
    reviewed_by     UUID REFERENCES auth.users(id),
    reviewed_at     TIMESTAMPTZ,
    approved_by     UUID REFERENCES auth.users(id),
    approved_at     TIMESTAMPTZ,
    posted_by       UUID REFERENCES auth.users(id),
    posted_at       TIMESTAMPTZ,
    rejection_reason TEXT,
    notes           TEXT,
    created_by      UUID REFERENCES auth.users(id),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    
    CONSTRAINT chk_payroll_dates CHECK (payroll_period_end >= payroll_period_start),
    CONSTRAINT uq_payroll_period UNIQUE (organization_id, payroll_period_start, payroll_period_end, payroll_type)
);

COMMENT ON TABLE finance.payroll_runs IS 'Payroll period header - immutable after posting';
COMMENT ON COLUMN finance.payroll_runs.snapshot_id IS 'References locked input snapshot - prevents recalculation from changing source data';

-- ============================================================
-- 6. PAYROLL INPUT SNAPSHOTS
-- Locked snapshot of all inputs used for a payroll run
-- Immutable - ensures HR edits don't change approved payroll
-- ============================================================
CREATE TABLE IF NOT EXISTS finance.payroll_input_snapshots (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    payroll_run_id  UUID NOT NULL REFERENCES finance.payroll_runs(id) ON DELETE CASCADE,
    worker_id       UUID NOT NULL REFERENCES finance.workers(id),
    compensation_id UUID NOT NULL REFERENCES finance.compensation_terms(id),
    basic_salary    NUMERIC(15,2) NOT NULL,
    allowances_total NUMERIC(15,2) NOT NULL DEFAULT 0,
    overtime_hours  NUMERIC(8,2) DEFAULT 0,
    overtime_amount NUMERIC(15,2) DEFAULT 0,
    attendance_days INT DEFAULT 0,
    leave_days      INT DEFAULT 0,
    absent_days     INT DEFAULT 0,
    advance_deduction NUMERIC(15,2) DEFAULT 0,
    commission_earned NUMERIC(15,2) DEFAULT 0,
    tax_deduction_pct NUMERIC(5,2),
    project_allocation JSONB DEFAULT '[]',  -- [{project_id, percentage, amount}]
    raw_input_data  JSONB DEFAULT '{}',     -- complete snapshot of all source data
    captured_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    
    CONSTRAINT uq_payroll_worker UNIQUE (payroll_run_id, worker_id)
);

COMMENT ON TABLE finance.payroll_input_snapshots IS 'IMMUTABLE snapshot of payroll inputs - locked at calculation time';

-- ============================================================
-- 7. PAYROLL LINES TABLE
-- Individual worker payroll breakdown per run
-- ============================================================
CREATE TABLE IF NOT EXISTS finance.payroll_lines (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    payroll_run_id  UUID NOT NULL REFERENCES finance.payroll_runs(id) ON DELETE CASCADE,
    worker_id       UUID NOT NULL REFERENCES finance.workers(id),
    snapshot_id     UUID NOT NULL REFERENCES finance.payroll_input_snapshots(id),
    
    -- Earnings
    basic_salary    NUMERIC(15,2) NOT NULL DEFAULT 0 CHECK (basic_salary >= 0),
    house_allowance NUMERIC(12,2) DEFAULT 0 CHECK (house_allowance >= 0),
    medical_allowance NUMERIC(12,2) DEFAULT 0 CHECK (medical_allowance >= 0),
    transport_allowance NUMERIC(12,2) DEFAULT 0 CHECK (transport_allowance >= 0),
    fixed_allowance NUMERIC(12,2) DEFAULT 0 CHECK (fixed_allowance >= 0),
    overtime_pay    NUMERIC(12,2) DEFAULT 0 CHECK (overtime_pay >= 0),
    bonus_amount    NUMERIC(12,2) DEFAULT 0 CHECK (bonus_amount >= 0),
    commission_pay   NUMERIC(12,2) DEFAULT 0 CHECK (commission_pay >= 0),
    
    -- Totals
    gross_pay       NUMERIC(15,2) NOT NULL DEFAULT 0 CHECK (gross_pay >= 0),
    
    -- Deductions
    income_tax      NUMERIC(12,2) DEFAULT 0 CHECK (income_tax >= 0),
    advance_recovery NUMERIC(12,2) DEFAULT 0 CHECK (advance_recovery >= 0),
    absence_deduction NUMERIC(12,2) DEFAULT 0 CHECK (absence_deduction >= 0),
    other_deductions NUMERIC(12,2) DEFAULT 0 CHECK (other_deductions >= 0),
    total_deductions NUMERIC(15,2) NOT NULL DEFAULT 0 CHECK (total_deductions >= 0),
    
    -- Net
    net_pay         NUMERIC(15,2) NOT NULL DEFAULT 0 CHECK (net_pay >= 0),
    
    -- Employer cost
    employer_tax     NUMERIC(12,2) DEFAULT 0 CHECK (employer_tax >= 0),
    employer_provident_fund NUMERIC(12,2) DEFAULT 0 CHECK (employer_provident_fund >= 0),
    employer_eobi    NUMERIC(12,2) DEFAULT 0 CHECK (employer_eobi >= 0),
    total_employer_cost NUMERIC(15,2) NOT NULL DEFAULT 0 CHECK (total_employer_cost >= 0),
    
    -- Project allocation
    project_allocations JSONB DEFAULT '[]',
    
    -- Payment tracking
    payment_status  VARCHAR(20) NOT NULL DEFAULT 'unpaid'
                    CHECK (payment_status IN ('unpaid', 'processing', 'paid', 'failed')),
    payment_date    DATE,
    payment_ref     VARCHAR(100),
    bank_account_id UUID REFERENCES finance.financial_accounts(id),
    
    -- Journal link
    journal_line_id UUID,
    
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    
    CONSTRAINT uq_payroll_line UNIQUE (payroll_run_id, worker_id)
);

COMMENT ON TABLE finance.payroll_lines IS 'Individual worker payroll breakdown - auto-calculated from snapshot';

-- ============================================================
-- 8. PAYROLL INTEGRATION EVENTS
-- For future HR/Attendance system integration
-- ============================================================
CREATE TABLE IF NOT EXISTS finance.payroll_integration_events (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    event_type      VARCHAR(50) NOT NULL
                    CHECK (event_type IN ('attendance_snapshot', 'leave_update', 'salary_change', 
                                            'attendance_correction', 'hr_data_sync')),
    source_module   VARCHAR(50) NOT NULL DEFAULT 'finance',
    source_event_id VARCHAR(200) NOT NULL,  -- idempotency key from source
    worker_id       UUID REFERENCES finance.workers(id),
    payload         JSONB NOT NULL DEFAULT '{}',
    status          VARCHAR(20) NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'processed', 'failed', 'skipped')),
    error_message   TEXT,
    processed_at    TIMESTAMPTZ,
    retry_count     INT NOT NULL DEFAULT 0,
    max_retries     INT NOT NULL DEFAULT 3,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    
    CONSTRAINT uq_integration_event UNIQUE (source_module, source_event_id)
);

COMMENT ON TABLE finance.payroll_integration_events IS 'Integration events for future HR/Attendance sync - idempotent';

-- ============================================================
-- INDEXES
-- ============================================================
CREATE INDEX idx_workers_org ON finance.workers(organization_id);
CREATE INDEX idx_workers_type ON finance.workers(worker_type);
CREATE INDEX idx_workers_status ON finance.workers(employment_status);
CREATE INDEX idx_compensation_worker ON finance.compensation_terms(worker_id);
CREATE INDEX idx_compensation_active ON finance.compensation_terms(is_active, effective_from, effective_to);
CREATE INDEX idx_commissions_worker ON finance.commissions(worker_id);
CREATE INDEX idx_commissions_project ON finance.commissions(project_id);
CREATE INDEX idx_commissions_status ON finance.commissions(status);
CREATE INDEX idx_advances_worker ON finance.advances(worker_id);
CREATE INDEX idx_advances_status ON finance.advances(status);
CREATE INDEX idx_payroll_runs_org ON finance.payroll_runs(organization_id);
CREATE INDEX idx_payroll_runs_period ON finance.payroll_runs(period_id);
CREATE INDEX idx_payroll_runs_status ON finance.payroll_runs(status);
CREATE INDEX idx_payroll_lines_run ON finance.payroll_lines(payroll_run_id);
CREATE INDEX idx_payroll_lines_worker ON finance.payroll_lines(worker_id);
CREATE INDEX idx_payroll_lines_payment ON finance.payroll_lines(payment_status);
CREATE INDEX idx_payroll_snapshots_run ON finance.payroll_input_snapshots(payroll_run_id);
CREATE INDEX idx_integration_events_status ON finance.payroll_integration_events(status);
CREATE INDEX idx_integration_events_type ON finance.payroll_integration_events(event_type);

-- ============================================================
-- RLS POLICIES (Row Level Security)
-- ============================================================
ALTER TABLE finance.workers ENABLE ROW LEVEL SECURITY;
ALTER TABLE finance.compensation_terms ENABLE ROW LEVEL SECURITY;
ALTER TABLE finance.commissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE finance.advances ENABLE ROW LEVEL SECURITY;
ALTER TABLE finance.payroll_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE finance.payroll_input_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE finance.payroll_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE finance.payroll_integration_events ENABLE ROW LEVEL SECURITY;

-- Workers: Finance team can read; HR link in future
CREATE POLICY workers_read ON finance.workers FOR SELECT
    TO authenticated USING (
        organization_id = (SELECT org_id FROM core.user_orgs WHERE user_id = auth.uid())
    );
CREATE POLICY workers_insert ON finance.workers FOR INSERT
    TO authenticated WITH CHECK (
        organization_id = (SELECT org_id FROM core.user_orgs WHERE user_id = auth.uid())
    );
CREATE POLICY workers_update ON finance.workers FOR UPDATE
    TO authenticated USING (
        organization_id = (SELECT org_id FROM core.user_orgs WHERE user_id = auth.uid())
    );

-- Compensation: Sensitive - requires special permission (enforced at app level)
CREATE POLICY comp_read ON finance.compensation_terms FOR SELECT
    TO authenticated USING (
        worker_id IN (SELECT id FROM finance.workers 
                      WHERE organization_id = (SELECT org_id FROM core.user_orgs WHERE user_id = auth.uid()))
    );
CREATE POLICY comp_insert ON finance.compensation_terms FOR INSERT
    TO authenticated WITH CHECK (
        worker_id IN (SELECT id FROM finance.workers 
                      WHERE organization_id = (SELECT org_id FROM core.user_orgs WHERE user_id = auth.uid()))
    );
CREATE POLICY comp_update ON finance.compensation_terms FOR UPDATE
    TO authenticated USING (
        worker_id IN (SELECT id FROM finance.workers 
                      WHERE organization_id = (SELECT org_id FROM core.user_orgs WHERE user_id = auth.uid()))
    );

-- Commissions
CREATE POLICY comm_read ON finance.commissions FOR SELECT
    TO authenticated USING (
        worker_id IN (SELECT id FROM finance.workers 
                      WHERE organization_id = (SELECT org_id FROM core.user_orgs WHERE user_id = auth.uid()))
    );
CREATE POLICY comm_insert ON finance.commissions FOR INSERT
    TO authenticated WITH CHECK (
        worker_id IN (SELECT id FROM finance.workers 
                      WHERE organization_id = (SELECT org_id FROM core.user_orgs WHERE user_id = auth.uid()))
    );
CREATE POLICY comm_update ON finance.commissions FOR UPDATE
    TO authenticated USING (
        worker_id IN (SELECT id FROM finance.workers 
                      WHERE organization_id = (SELECT org_id FROM core.user_orgs WHERE user_id = auth.uid()))
    );

-- Advances
CREATE POLICY adv_read ON finance.advances FOR SELECT
    TO authenticated USING (
        worker_id IN (SELECT id FROM finance.workers 
                      WHERE organization_id = (SELECT org_id FROM core.user_orgs WHERE user_id = auth.uid()))
    );
CREATE POLICY adv_insert ON finance.advances FOR INSERT
    TO authenticated WITH CHECK (
        worker_id IN (SELECT id FROM finance.workers 
                      WHERE organization_id = (SELECT org_id FROM core.user_orgs WHERE user_id = auth.uid()))
    );
CREATE POLICY adv_update ON finance.advances FOR UPDATE
    TO authenticated USING (
        worker_id IN (SELECT id FROM finance.workers 
                      WHERE organization_id = (SELECT org_id FROM core.user_orgs WHERE user_id = auth.uid()))
    );

-- Payroll Runs
CREATE POLICY pr_read ON finance.payroll_runs FOR SELECT
    TO authenticated USING (
        organization_id = (SELECT org_id FROM core.user_orgs WHERE user_id = auth.uid())
    );
CREATE POLICY pr_insert ON finance.payroll_runs FOR INSERT
    TO authenticated WITH CHECK (
        organization_id = (SELECT org_id FROM core.user_orgs WHERE user_id = auth.uid())
    );
CREATE POLICY pr_update ON finance.payroll_runs FOR UPDATE
    TO authenticated USING (
        organization_id = (SELECT org_id FROM core.user_orgs WHERE user_id = auth.uid())
    );

-- Payroll Lines
CREATE POLICY pl_read ON finance.payroll_lines FOR SELECT
    TO authenticated USING (
        payroll_run_id IN (SELECT id FROM finance.payroll_runs 
                           WHERE organization_id = (SELECT org_id FROM core.user_orgs WHERE user_id = auth.uid()))
    );
CREATE POLICY pl_insert ON finance.payroll_lines FOR INSERT
    TO authenticated WITH CHECK (
        payroll_run_id IN (SELECT id FROM finance.payroll_runs 
                           WHERE organization_id = (SELECT org_id FROM core.user_orgs WHERE user_id = auth.uid()))
    );
CREATE POLICY pl_update ON finance.payroll_lines FOR UPDATE
    TO authenticated USING (
        payroll_run_id IN (SELECT id FROM finance.payroll_runs 
                           WHERE organization_id = (SELECT org_id FROM core.user_orgs WHERE user_id = auth.uid()))
    );

-- Payroll Snapshots
CREATE POLICY snap_read ON finance.payroll_input_snapshots FOR SELECT
    TO authenticated USING (
        payroll_run_id IN (SELECT id FROM finance.payroll_runs 
                           WHERE organization_id = (SELECT org_id FROM core.user_orgs WHERE user_id = auth.uid()))
    );
CREATE POLICY snap_insert ON finance.payroll_input_snapshots FOR INSERT
    TO authenticated WITH CHECK (
        payroll_run_id IN (SELECT id FROM finance.payroll_runs 
                           WHERE organization_id = (SELECT org_id FROM core.user_orgs WHERE user_id = auth.uid()))
    );

-- Integration Events
CREATE POLICY ie_read ON finance.payroll_integration_events FOR SELECT
    TO authenticated USING (true);
CREATE POLICY ie_insert ON finance.payroll_integration_events FOR INSERT
    TO authenticated WITH CHECK (true);
CREATE POLICY ie_update ON finance.payroll_integration_events FOR UPDATE
    TO authenticated USING (true);

-- ============================================================
-- HELPER FUNCTIONS
-- ============================================================

-- Function: Get active compensation for a worker on a given date
CREATE OR REPLACE FUNCTION finance.get_active_compensation(p_worker_id UUID, p_date DATE)
RETURNS TABLE(id UUID, amount NUMERIC, type VARCHAR, frequency VARCHAR) AS $$ BEGIN
    RETURN QUERY
    SELECT ct.id, ct.amount, ct.compensation_type, ct.pay_frequency
    FROM finance.compensation_terms ct
    WHERE ct.worker_id = p_worker_id
      AND ct.is_active = TRUE
      AND ct.effective_from <= p_date
      AND (ct.effective_to IS NULL OR ct.effective_to >= p_date)
    ORDER BY ct.effective_from DESC
    LIMIT 1;
END;
 $$ LANGUAGE plpgsql SECURITY DEFINER;

COMMENT ON FUNCTION finance.get_active_compensation IS 'Get the active compensation term for a worker on a specific date';

-- Function: Get outstanding advance balance for a worker
CREATE OR REPLACE FUNCTION finance.get_worker_advance_balance(p_worker_id UUID)
RETURNS NUMERIC AS $$ DECLARE
    v_balance NUMERIC;
BEGIN
    SELECT COALESCE(SUM(a.amount - a.amount_recovered), 0)
    INTO v_balance
    FROM finance.advances a
    WHERE a.worker_id = p_worker_id
      AND a.status IN ('approved', 'partially_recovered');
    RETURN v_balance;
END;
 $$ LANGUAGE plpgsql SECURITY DEFINER;

COMMENT ON FUNCTION finance.get_worker_advance_balance IS 'Calculate total outstanding advance balance for a worker';

-- Function: Calculate payroll line from snapshot
CREATE OR REPLACE FUNCTION finance.calculate_payroll_line(
    p_snapshot_id UUID,
    p_tax_pct NUMERIC DEFAULT 0,
    p_advance_deduction NUMERIC DEFAULT 0,
    p_absent_days INT DEFAULT 0
)
RETURNS JSONB AS $$ DECLARE
    v_snapshot finance.payroll_input_snapshots%ROWTYPE;
    v_result JSONB;
    v_daily_rate NUMERIC;
    v_gross NUMERIC;
    v_absent_deduction NUMERIC;
    v_net NUMERIC;
BEGIN
    SELECT * INTO v_snapshot FROM finance.payroll_input_snapshots WHERE id = p_snapshot_id;
    
    IF NOT FOUND THEN
        RETURN jsonb_build_object('error', 'Snapshot not found');
    END IF;
    
    -- Calculate daily rate from monthly salary
    v_daily_rate := ROUND(v_snapshot.basic_salary / 30, 2);
    v_absent_deduction := v_daily_rate * p_absent_days;
    
    v_gross := v_snapshot.basic_salary 
             + v_snapshot.allowances_total 
             + v_snapshot.overtime_amount 
             + v_snapshot.commission_earned
             - v_absent_deduction;
    
    v_gross := GREATEST(v_gross, 0);
    
    v_net := v_gross 
            - ROUND(v_gross * (p_tax_pct / 100), 2) 
            - p_advance_deduction;
    
    v_net := GREATEST(v_net, 0);
    
    v_result := jsonb_build_object(
        'basic_salary', v_snapshot.basic_salary,
        'allowances_total', v_snapshot.allowances_total,
        'overtime_amount', v_snapshot.overtime_amount,
        'commission_earned', v_snapshot.commission_earned,
        'absent_deduction', v_absent_deduction,
        'gross_pay', v_gross,
        'tax_deduction', ROUND(v_gross * (p_tax_pct / 100), 2),
        'advance_deduction', p_advance_deduction,
        'net_pay', v_net
    );
    
    RETURN v_result;
END;
 $$ LANGUAGE plpgsql SECURITY DEFINER;

COMMENT ON FUNCTION finance.calculate_payroll_line IS 'Calculate payroll line from locked snapshot - deterministic';

-- ============================================================
-- PERMISSIONS SEED
-- ============================================================
INSERT INTO core.permissions (resource, action, description, sensitive)
VALUES 
    ('payroll', 'read', 'View payroll runs and summaries', FALSE),
    ('payroll', 'create', 'Create payroll runs', FALSE),
    ('payroll', 'approve', 'Approve and post payroll', FALSE),
    ('payroll', 'pay', 'Mark payroll as paid', FALSE),
    ('payroll_sensitive', 'read', 'View salary/compensation details', TRUE),
    ('payroll_sensitive', 'create', 'Create/edit compensation terms', TRUE),
    ('worker', 'read', 'View worker/employee list', FALSE),
    ('worker', 'create', 'Add new workers', FALSE),
    ('worker', 'edit', 'Edit worker details', FALSE),
    ('advance', 'read', 'View advances', FALSE),
    ('advance', 'create', 'Request advances', FALSE),
    ('advance', 'approve', 'Approve/reject advances', FALSE),
    ('commission', 'read', 'View commissions', FALSE),
    ('commission', 'create', 'Create commission rules', FALSE),
    ('commission', 'edit', 'Edit commission records', FALSE)
ON CONFLICT (resource, action) DO NOTHING;

-- ============================================================
-- END OF MIGRATION 100
-- ============================================================