-- ================================================================
-- OSYSTIC Finance Management System — Payroll Module (P1)
-- ================================================================
-- Priority: P1/P2
-- Purpose: Finance-side payroll accounting with stable integration
--          boundary for future Employee Management System.
-- Schema: public (finance-side tables; HR-owned tables in hr schema later)
-- ================================================================

-- ─── 1. PAYROLL EMPLOYEES (Finance-side employee registry) ───
CREATE TABLE IF NOT EXISTS public.payroll_employees (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_code VARCHAR(20) NOT NULL UNIQUE,
  user_id       UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  name          VARCHAR(200) NOT NULL,
  email         VARCHAR(255),
  phone         VARCHAR(30),
  designation   VARCHAR(150),
  department    VARCHAR(150),
  employment_type VARCHAR(30) NOT NULL DEFAULT 'FULL_TIME'
                CHECK (employment_type IN (
                  'FULL_TIME','PART_TIME','CONTRACTOR','INTERN','CONSULTANT'
                )),
  status        VARCHAR(20) NOT NULL DEFAULT 'ACTIVE'
                CHECK (status IN ('ACTIVE','ON_LEAVE','TERMINATED','SUSPENDED')),
  join_date     DATE,
  bank_name     VARCHAR(200),
  bank_account  VARCHAR(50),
  cnic          VARCHAR(20),
  notes         TEXT,
  created_by    UUID REFERENCES auth.users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_payroll_employees_code ON public.payroll_employees(employee_code);
CREATE INDEX idx_payroll_employees_status ON public.payroll_employees(status);
CREATE INDEX idx_payroll_employees_dept ON public.payroll_employees(department);

COMMENT ON TABLE public.payroll_employees IS
  'Finance-side employee registry for payroll. Full HR master data lives in future hr.employees.';

-- ─── 2. COMPENSATION (Salary / Rate records — effective-dated) ───
CREATE TABLE IF NOT EXISTS public.payroll_compensation (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id       UUID NOT NULL REFERENCES public.payroll_employees(id) ON DELETE CASCADE,
  compensation_type VARCHAR(30) NOT NULL DEFAULT 'MONTHLY_SALARY'
                    CHECK (compensation_type IN (
                      'MONTHLY_SALARY','HOURLY_RATE','DAILY_RATE',
                      'PROJECT_BASED','COMMISSION_ONLY','FIXED_CONTRACT'
                    )),
  amount            NUMERIC(14,2) NOT NULL CHECK (amount >= 0),
  currency          VARCHAR(3) NOT NULL DEFAULT 'PKR',
  effective_from    DATE NOT NULL DEFAULT CURRENT_DATE,
  effective_to      DATE,
  is_active         BOOLEAN NOT NULL DEFAULT true,
  project_id        UUID REFERENCES public.projects(id) ON DELETE SET NULL,
  notes             TEXT,
  created_by        UUID REFERENCES auth.users(id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_compensation_employee ON public.payroll_compensation(employee_id);
CREATE INDEX idx_compensation_active ON public.payroll_compensation(employee_id, is_active);

-- ─── 3. PAYROLL DEDUCTIONS (Recurring deduction rules) ───
CREATE TABLE IF NOT EXISTS public.payroll_deductions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id     UUID NOT NULL REFERENCES public.payroll_employees(id) ON DELETE CASCADE,
  deduction_type  VARCHAR(50) NOT NULL DEFAULT 'OTHER'
                  CHECK (deduction_type IN (
                    'TAX','PROVIDENT_FUND','EOBI','SOCIAL_SECURITY',
                    'LOAN_INSTALLMENT','ADVANCE_DEDUCTION','ABSENCE_PENALTY',
                    'OTHER'
                  )),
  amount          NUMERIC(14,2),
  percentage      NUMERIC(5,2),
  effective_from  DATE NOT NULL DEFAULT CURRENT_DATE,
  effective_to    DATE,
  is_active       BOOLEAN NOT NULL DEFAULT true,
  notes           TEXT,
  created_by      UUID REFERENCES auth.users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_deductions_employee ON public.payroll_deductions(employee_id);

-- ─── 4. PAYROLL RUNS (Monthly/periodic payroll batch) ───
CREATE TABLE IF NOT EXISTS public.payroll_runs (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payroll_period   VARCHAR(20) NOT NULL,          -- e.g. '2025-01'
  period_start     DATE NOT NULL,
  period_end       DATE NOT NULL,
  status           VARCHAR(20) NOT NULL DEFAULT 'DRAFT'
                   CHECK (status IN (
                     'DRAFT','CALCULATED','UNDER_REVIEW','APPROVED',
                     'POSTED','REJECTED','CANCELLED'
                   )),
  total_gross_pay  NUMERIC(16,2) NOT NULL DEFAULT 0,
  total_deductions NUMERIC(16,2) NOT NULL DEFAULT 0,
  total_net_pay    NUMERIC(16,2) NOT NULL DEFAULT 0,
  total_employer_cost NUMERIC(16,2) NOT NULL DEFAULT 0,
  total_employees  INTEGER NOT NULL DEFAULT 0,
  calculated_by    UUID REFERENCES auth.users(id),
  calculated_at    TIMESTAMPTZ,
  approved_by      UUID REFERENCES auth.users(id),
  approved_at      TIMESTAMPTZ,
  posted_by        UUID REFERENCES auth.users(id),
  posted_at        TIMESTAMPTZ,
  notes            TEXT,
  created_by       UUID REFERENCES auth.users(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_payroll_runs_period ON public.payroll_runs(payroll_period);
CREATE INDEX idx_payroll_runs_status ON public.payroll_runs(status);

COMMENT ON TABLE public.payroll_runs IS
  'A payroll run is a batch calculation for a specific period. Once APPROVED the inputs are snapshotted.';

-- ─── 5. PAYROLL LINES (Per-employee result within a run) ───
CREATE TABLE IF NOT EXISTS public.payroll_lines (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payroll_run_id   UUID NOT NULL REFERENCES public.payroll_runs(id) ON DELETE CASCADE,
  employee_id      UUID NOT NULL REFERENCES public.payroll_employees(id),

  -- Snapshot of inputs at calculation time
  basic_salary     NUMERIC(14,2) NOT NULL DEFAULT 0,
  housing_allow    NUMERIC(14,2) NOT NULL DEFAULT 0,
  medical_allow    NUMERIC(14,2) NOT NULL DEFAULT 0,
  conveyance_allow NUMERIC(14,2) NOT NULL DEFAULT 0,
  other_allowances NUMERIC(14,2) NOT NULL DEFAULT 0,
  overtime_pay     NUMERIC(14,2) NOT NULL DEFAULT 0,
  commission_pay   NUMERIC(14,2) NOT NULL DEFAULT 0,
  bonus_pay        NUMERIC(14,2) NOT NULL DEFAULT 0,

  -- Totals
  gross_pay        NUMERIC(14,2) NOT NULL DEFAULT 0,
  tax_deduction    NUMERIC(14,2) NOT NULL DEFAULT 0,
  provident_fund   NUMERIC(14,2) NOT NULL DEFAULT 0,
  eobi             NUMERIC(14,2) NOT NULL DEFAULT 0,
  advance_deduction NUMERIC(14,2) NOT NULL DEFAULT 0,
  other_deductions NUMERIC(14,2) NOT NULL DEFAULT 0,
  total_deductions NUMERIC(14,2) NOT NULL DEFAULT 0,
  net_pay          NUMERIC(14,2) NOT NULL DEFAULT 0,
  employer_cost    NUMERIC(14,2) NOT NULL DEFAULT 0,

  -- Payment tracking
  payment_status   VARCHAR(20) NOT NULL DEFAULT 'PENDING'
                   CHECK (payment_status IN ('PENDING','PAID','PARTIALLY_PAID','FAILED')),
  payment_date     DATE,
  payment_ref      VARCHAR(100),
  bank_name        VARCHAR(200),
  bank_account     VARCHAR(50),
  project_id       UUID REFERENCES public.projects(id) ON DELETE SET NULL,

  -- Snapshot data (immutable after calculation)
 employee_name     VARCHAR(200),
  employee_code    VARCHAR(20),
  designation      VARCHAR(150),
  department       VARCHAR(150),
  compensation_snapshot JSONB,   -- Full compensation record at calc time
  deduction_snapshot   JSONB,   -- Full deduction records at calc time

  notes            TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_payroll_lines_run ON public.payroll_lines(payroll_run_id);
CREATE INDEX idx_payroll_lines_employee ON public.payroll_lines(employee_id);
CREATE INDEX idx_payroll_lines_payment ON public.payroll_lines(payment_status);

-- ─── 6. PAYROLL ADVANCES ───
CREATE TABLE IF NOT EXISTS public.payroll_advances (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id         UUID NOT NULL REFERENCES public.payroll_employees(id) ON DELETE CASCADE,
  amount              NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  purpose             TEXT,
  request_date        DATE NOT NULL DEFAULT CURRENT_DATE,
  approval_status     VARCHAR(20) NOT NULL DEFAULT 'PENDING'
                      CHECK (approval_status IN (
                        'PENDING','APPROVED','REJECTED','PARTIALLY_RECOVERED','FULLY_RECOVERED'
                      )),
  approved_by         UUID REFERENCES auth.users(id),
  approved_at         TIMESTAMPTZ,
  total_deducted      NUMERIC(14,2) NOT NULL DEFAULT 0,
  remaining_balance   NUMERIC(14,2) NOT NULL DEFAULT 0,
  monthly_deduction   NUMERIC(14,2),
  start_deduction_month VARCHAR(7),  -- e.g. '2025-02'
  notes               TEXT,
  created_by          UUID REFERENCES auth.users(id),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_advances_employee ON public.payroll_advances(employee_id);
CREATE INDEX idx_advances_status ON public.payroll_advances(approval_status);

-- ─── 7. PAYROLL COMMISSIONS ───
CREATE TABLE IF NOT EXISTS public.payroll_commissions (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id      UUID NOT NULL REFERENCES public.payroll_employees(id) ON DELETE CASCADE,
  project_id       UUID REFERENCES public.projects(id) ON DELETE SET NULL,
  commission_type  VARCHAR(30) NOT NULL DEFAULT 'PERFORMANCE_BASED'
                   CHECK (commission_type IN (
                     'PERFORMANCE_BASED','PROJECT_BASED','SALES_BASED','REFERRAL','OTHER'
                   )),
  description      TEXT,
  base_amount      NUMERIC(14,2) NOT NULL DEFAULT 0,
  commission_rate  NUMERIC(7,4) NOT NULL DEFAULT 0,   -- e.g. 0.10 = 10%
  commission_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
  period_month     VARCHAR(7),   -- e.g. '2025-01'
  status           VARCHAR(20) NOT NULL DEFAULT 'PENDING'
                   CHECK (status IN (
                     'PENDING','APPROVED','PAID','REJECTED','CANCELLED'
                   )),
  approved_by      UUID REFERENCES auth.users(id),
  approved_at      TIMESTAMPTZ,
  paid_date        DATE,
  payment_ref      VARCHAR(100),
  notes            TEXT,
  created_by       UUID REFERENCES auth.users(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_commissions_employee ON public.payroll_commissions(employee_id);
CREATE INDEX idx_commissions_status ON public.payroll_commissions(status);

-- ─── 7a. PAYROLL REIMBURSEMENTS ───
CREATE TABLE IF NOT EXISTS public.payroll_reimbursements (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id   UUID NOT NULL REFERENCES public.payroll_employees(id) ON DELETE CASCADE,
  project_id    UUID REFERENCES public.projects(id) ON DELETE SET NULL,
  amount        NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  currency      VARCHAR(3) NOT NULL DEFAULT 'PKR',
  category      VARCHAR(50) NOT NULL DEFAULT 'OTHER'
                CHECK (category IN (
                  'TRAVEL','MEAL','MEDICAL','EQUIPMENT','INTERNET','OTHER'
                )),
  description   TEXT,
  receipt_ref   VARCHAR(100),
  expense_date  DATE NOT NULL DEFAULT CURRENT_DATE,
  status        VARCHAR(20) NOT NULL DEFAULT 'PENDING'
                CHECK (status IN (
                  'PENDING','APPROVED','REJECTED','PAID','CANCELLED'
                )),
  approved_by   UUID REFERENCES auth.users(id),
  approved_at   TIMESTAMPTZ,
  paid_date     DATE,
  payment_ref   VARCHAR(100),
  payroll_run_id UUID REFERENCES public.payroll_runs(id) ON DELETE SET NULL,
  notes         TEXT,
  created_by    UUID REFERENCES auth.users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_reimb_employee ON public.payroll_reimbursements(employee_id);

-- ================================================================
-- ROW LEVEL SECURITY (RLS)
-- ================================================================

ALTER TABLE public.payroll_employees ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payroll_compensation ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payroll_deductions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payroll_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payroll_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payroll_advances ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payroll_commissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payroll_reimbursements ENABLE ROW LEVEL SECURITY;

-- Service role bypasses RLS (for API routes)
CREATE POLICY "Service role full access on payroll_employees"
  ON public.payroll_employees FOR ALL
  TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "Service role full access on payroll_compensation"
  ON public.payroll_compensation FOR ALL
  TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "Service role full access on payroll_deductions"
  ON public.payroll_deductions FOR ALL
  TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "Service role full access on payroll_runs"
  ON public.payroll_runs FOR ALL
  TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "Service role full access on payroll_lines"
  ON public.payroll_lines FOR ALL
  TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "Service role full access on payroll_advances"
  ON public.payroll_advances FOR ALL
  TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "Service role full access on payroll_commissions"
  ON public.payroll_commissions FOR ALL
  TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "Service role full access on payroll_reimbursements"
  ON public.payroll_reimbursements FOR ALL
  TO service_role USING (true) WITH CHECK (true);

-- Authenticated users: read access based on role (sensitive data check in app layer)
CREATE POLICY "Authenticated read on payroll_employees"
  ON public.payroll_employees FOR SELECT
  TO authenticated USING (true);

CREATE POLICY "Authenticated read on payroll_runs"
  ON public.payroll_runs FOR SELECT
  TO authenticated USING (true);

CREATE POLICY "Authenticated read on payroll_lines"
  ON public.payroll_lines FOR SELECT
  TO authenticated USING (true);

CREATE POLICY "Authenticated read on payroll_advances"
  ON public.payroll_advances FOR SELECT
  TO authenticated USING (true);

CREATE POLICY "Authenticated read on payroll_commissions"
  ON public.payroll_commissions FOR SELECT
  TO authenticated USING (true);

CREATE POLICY "Authenticated read on payroll_reimbursements"
  ON public.payroll_reimbursements FOR SELECT
  TO authenticated USING (true);

-- =============================================================================
-- FIX: Add missing INSERT/UPDATE/DELETE RLS policies for authenticated users
-- Run this in Supabase SQL Editor
-- =============================================================================

-- ─── payroll_employees ───
CREATE POLICY "Authenticated insert on payroll_employees"
  ON public.payroll_employees FOR INSERT
  TO authenticated WITH CHECK (true);

CREATE POLICY "Authenticated update on payroll_employees"
  ON public.payroll_employees FOR UPDATE
  TO authenticated USING (true) WITH CHECK (true);

CREATE POLICY "Authenticated delete on payroll_employees"
  ON public.payroll_employees FOR DELETE
  TO authenticated USING (true);

-- ─── payroll_compensation ───
CREATE POLICY "Authenticated insert on payroll_compensation"
  ON public.payroll_compensation FOR INSERT
  TO authenticated WITH CHECK (true);

CREATE POLICY "Authenticated update on payroll_compensation"
  ON public.payroll_compensation FOR UPDATE
  TO authenticated USING (true) WITH CHECK (true);

-- ─── payroll_deductions ───
CREATE POLICY "Authenticated insert on payroll_deductions"
  ON public.payroll_deductions FOR INSERT
  TO authenticated WITH CHECK (true);

CREATE POLICY "Authenticated update on payroll_deductions"
  ON public.payroll_deductions FOR UPDATE
  TO authenticated USING (true) WITH CHECK (true);

-- ─── payroll_runs ───
CREATE POLICY "Authenticated insert on payroll_runs"
  ON public.payroll_runs FOR INSERT
  TO authenticated WITH CHECK (true);

CREATE POLICY "Authenticated update on payroll_runs"
  ON public.payroll_runs FOR UPDATE
  TO authenticated USING (true) WITH CHECK (true);

-- ─── payroll_lines ───
CREATE POLICY "Authenticated insert on payroll_lines"
  ON public.payroll_lines FOR INSERT
  TO authenticated WITH CHECK (true);

CREATE POLICY "Authenticated update on payroll_lines"
  ON public.payroll_lines FOR UPDATE
  TO authenticated USING (true) WITH CHECK (true);

-- ─── payroll_advances ───
CREATE POLICY "Authenticated insert on payroll_advances"
  ON public.payroll_advances FOR INSERT
  TO authenticated WITH CHECK (true);

CREATE POLICY "Authenticated update on payroll_advances"
  ON public.payroll_advances FOR UPDATE
  TO authenticated USING (true) WITH CHECK (true);

-- ─── payroll_commissions ───
CREATE POLICY "Authenticated insert on payroll_commissions"
  ON public.payroll_commissions FOR INSERT
  TO authenticated WITH CHECK (true);

CREATE POLICY "Authenticated update on payroll_commissions"
  ON public.payroll_commissions FOR UPDATE
  TO authenticated USING (true) WITH CHECK (true);

-- ─── payroll_reimbursements ───
CREATE POLICY "Authenticated insert on payroll_reimbursements"
  ON public.payroll_reimbursements FOR INSERT
  TO authenticated WITH CHECK (true);

CREATE POLICY "Authenticated update on payroll_reimbursements"
  ON public.payroll_reimbursements FOR UPDATE
  TO authenticated USING (true) WITH CHECK (true);
-- ================================================================
-- AUTO-UPDATE TRIGGER FOR updated_at
-- ================================================================

CREATE OR REPLACE FUNCTION public.payroll_update_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_payroll_employees_updated
  BEFORE UPDATE ON public.payroll_employees
  FOR EACH ROW EXECUTE FUNCTION public.payroll_update_timestamp();

CREATE TRIGGER trg_payroll_compensation_updated
  BEFORE UPDATE ON public.payroll_compensation
  FOR EACH ROW EXECUTE FUNCTION public.payroll_update_timestamp();

CREATE TRIGGER trg_payroll_deductions_updated
  BEFORE UPDATE ON public.payroll_deductions
  FOR EACH ROW EXECUTE FUNCTION public.payroll_update_timestamp();

CREATE TRIGGER trg_payroll_runs_updated
  BEFORE UPDATE ON public.payroll_runs
  FOR EACH ROW EXECUTE FUNCTION public.payroll_update_timestamp();

CREATE TRIGGER trg_payroll_lines_updated
  BEFORE UPDATE ON public.payroll_lines
  FOR EACH ROW EXECUTE FUNCTION public.payroll_update_timestamp();

CREATE TRIGGER trg_payroll_advances_updated
  BEFORE UPDATE ON public.payroll_advances
  FOR EACH ROW EXECUTE FUNCTION public.payroll_update_timestamp();

CREATE TRIGGER trg_payroll_commissions_updated
  BEFORE UPDATE ON public.payroll_commissions
  FOR EACH ROW EXECUTE FUNCTION public.payroll_update_timestamp();

CREATE TRIGGER trg_payroll_reimbursements_updated
  BEFORE UPDATE ON public.payroll_reimbursements
  FOR EACH ROW EXECUTE FUNCTION public.payroll_update_timestamp();

-- ================================================================
-- HELPER: Auto-generate employee_code sequence
-- ================================================================
CREATE SEQUENCE IF NOT EXISTS public.payroll_employee_code_seq START 1;

CREATE OR REPLACE FUNCTION public.payroll_generate_employee_code()
RETURNS VARCHAR(20) AS $$
DECLARE
  next_num INTEGER;
  code VARCHAR(20);
  exists BOOLEAN;
BEGIN
  LOOP
    next_num := nextval('public.payroll_employee_code_seq');
    code := 'EMP-' || LPAD(next_num::TEXT, 4, '0');
    SELECT EXISTS(SELECT 1 FROM public.payroll_employees WHERE employee_code = code) INTO exists;
    IF NOT exists THEN RETURN code; END IF;
  END LOOP;
END;
$$ LANGUAGE plpgsql;

-- ================================================================
-- VIEW: Payroll summary for dashboard
-- ================================================================
CREATE OR REPLACE VIEW public.v_payroll_summary AS
SELECT
  pr.id AS run_id,
  pr.payroll_period,
  pr.status AS run_status,
  pr.total_gross_pay,
  pr.total_deductions,
  pr.total_net_pay,
  pr.total_employer_cost,
  pr.total_employees,
  pr.created_at,
  COUNT(DISTINCT pl.id) AS line_count,
  COUNT(DISTINCT CASE WHEN pl.payment_status = 'PAID' THEN pl.id END) AS paid_count,
  SUM(CASE WHEN pl.payment_status != 'PAID' THEN pl.net_pay ELSE 0 END) AS unpaid_amount
FROM public.payroll_runs pr
LEFT JOIN public.payroll_lines pl ON pl.payroll_run_id = pr.id
GROUP BY pr.id;

COMMENT ON VIEW public.v_payroll_summary IS
  'Aggregated payroll run summary with payment tracking.';
