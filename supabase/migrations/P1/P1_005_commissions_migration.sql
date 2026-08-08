-- =============================================================================
-- OSYSTIC Finance Management System — Commissions Module (P1)
-- =============================================================================
-- Spec Reference: Section 5.9 — Payroll, Contractors, Commissions, Team Payables
-- Priority: P1 | Linked to: contractors table
-- Purpose: Track commission earnings for contractors and future employees,
--          including commission rules, calculation basis, payment status,
--          project linkage, and cost analysis.
-- Schema: public
-- =============================================================================

-- ─── 1. COMMISSIONS TABLE ───
CREATE TABLE IF NOT EXISTS public.commissions (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contractor_id         UUID REFERENCES public.contractors(id) ON DELETE CASCADE,
  -- employee_id UUID REFERENCES future employees(id) ON DELETE SET NULL,  -- future HR integration
  person_name           VARCHAR(200) NOT NULL,
  person_type           VARCHAR(20) NOT NULL DEFAULT 'CONTRACTOR'
                        CHECK (person_type IN ('CONTRACTOR', 'EMPLOYEE')),

  -- Commission structure
  commission_type       VARCHAR(30) NOT NULL DEFAULT 'PERCENTAGE'
                        CHECK (commission_type IN (
                          'PERCENTAGE', 'FIXED_AMOUNT', 'TIERED', 'FLAT_BONUS', 'REFERRAL'
                        )),
  calculation_basis     VARCHAR(50) NOT NULL DEFAULT 'PROJECT_REVENUE'
                        CHECK (calculation_basis IN (
                          'PROJECT_REVENUE', 'INVOICE_AMOUNT', 'MILESTONE_VALUE',
                          'CLIENT_PAYMENT', 'SALES_TARGET', 'FIXED_AMOUNT'
                        )),
  rate_or_amount        NUMERIC(14,4) NOT NULL DEFAULT 0 CHECK (rate_or_amount >= 0),
  -- For PERCENTAGE type: this is the % (e.g., 10.50 means 10.5%)
  -- For FIXED_AMOUNT / FLAT_BONUS: this is the flat amount

  -- Source context
  project_id            UUID REFERENCES public.projects(id) ON DELETE SET NULL,
  client_id             UUID,   -- optional: linked client
  invoice_ref           VARCHAR(100),
  milestone_ref         VARCHAR(100),
  period_start          DATE,
  period_end            DATE,

  -- Financials
  base_amount           NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (base_amount >= 0),
  -- The amount on which commission is calculated (e.g., project revenue, invoice amount)
  commission_amount     NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (commission_amount >= 0),
  -- The calculated commission: base_amount * rate_or_amount/100 (for %) or rate_or_amount (for fixed)
  currency              VARCHAR(3) NOT NULL DEFAULT 'PKR',
  tax_withheld          NUMERIC(14,2) DEFAULT 0 CHECK (tax_withheld >= 0),
  net_amount            NUMERIC(14,2) GENERATED ALWAYS AS (
    CASE
      WHEN commission_amount >= tax_withheld THEN commission_amount - tax_withheld
      ELSE 0
    END
  ) STORED,

  -- Status
  status                VARCHAR(20) NOT NULL DEFAULT 'PENDING'
                        CHECK (status IN (
                          'PENDING', 'APPROVED', 'PAID', 'CANCELLED', 'HELD'
                        )),
  payment_date          DATE,
  payment_ref           VARCHAR(100),
  approved_by           UUID REFERENCES auth.users(id),
  approved_at           TIMESTAMPTZ,

  -- Meta
  notes                 TEXT,
  created_by            UUID REFERENCES auth.users(id),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_commissions_contractor ON public.commissions(contractor_id);
CREATE INDEX IF NOT EXISTS idx_commissions_project ON public.commissions(project_id);
CREATE INDEX IF NOT EXISTS idx_commissions_status ON public.commissions(status);
CREATE INDEX IF NOT EXISTS idx_commissions_period ON public.commissions(period_start, period_end);
CREATE INDEX IF NOT EXISTS idx_commissions_type ON public.commissions(commission_type);
CREATE INDEX IF NOT EXISTS idx_commissions_person ON public.commissions(person_name);

COMMENT ON TABLE public.commissions IS
  'Commission earnings for contractors and employees, linked to projects, invoices, or milestones with full payment tracking.';

-- ─── 2. ROW LEVEL SECURITY ───

ALTER TABLE public.commissions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access on commissions"
  ON public.commissions FOR ALL
  TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "Authenticated insert on commissions"
  ON public.commissions FOR INSERT
  TO authenticated WITH CHECK (true);

CREATE POLICY "Authenticated select on commissions"
  ON public.commissions FOR SELECT
  TO authenticated USING (true);

CREATE POLICY "Authenticated update on commissions"
  ON public.commissions FOR UPDATE
  TO authenticated USING (true) WITH CHECK (true);

CREATE POLICY "Authenticated delete on commissions"
  ON public.commissions FOR DELETE
  TO authenticated USING (true);

-- ─── 3. AUTO-UPDATE TRIGGER ───

CREATE TRIGGER trg_commissions_updated
  BEFORE UPDATE ON public.commissions
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- ─── 4. VIEW: Commission Summary by Person ───

CREATE OR REPLACE VIEW public.v_commission_by_person AS
SELECT
  c.person_name,
  c.person_type,
  c.contractor_id,
  COUNT(*) AS commission_count,
  SUM(c.base_amount) AS total_base_amount,
  SUM(c.commission_amount) AS total_commission,
  SUM(c.tax_withheld) AS total_tax_withheld,
  SUM(c.net_amount) AS total_net_amount,
 c.currency
FROM public.commissions c
WHERE c.status != 'CANCELLED'
GROUP BY c.person_name, c.person_type, c.contractor_id, c.currency
ORDER BY total_commission DESC;

COMMENT ON VIEW public.v_commission_by_person IS
  'Aggregated commission totals per person (contractor/employee), excluding cancelled.';

-- ─── 5. VIEW: Commission Summary by Project ───

CREATE OR REPLACE VIEW public.v_commission_by_project AS
SELECT
  COALESCE(p.name, 'Unassigned') AS project_name,
  COALESCE(p.id::text, 'none') AS project_id,
  COUNT(*) AS commission_count,
  SUM(c.base_amount) AS total_base_amount,
  SUM(c.commission_amount) AS total_commission,
  SUM(c.tax_withheld) AS total_tax_withheld,
  SUM(c.net_amount) AS total_net_amount,
  c.currency
FROM public.commissions c
LEFT JOIN public.projects p ON p.id = c.project_id
WHERE c.status != 'CANCELLED'
GROUP BY p.name, p.id, c.currency
ORDER BY total_commission DESC;

COMMENT ON VIEW public.v_commission_by_project IS
  'Aggregated commission totals per project, excluding cancelled.';

-- ─── 6. VIEW: Commission Summary by Type ───

CREATE OR REPLACE VIEW public.v_commission_by_type AS
SELECT
  c.commission_type,
  c.calculation_basis,
  COUNT(*) AS commission_count,
  SUM(c.commission_amount) AS total_commission,
  SUM(c.tax_withheld) AS total_tax_withheld,
  SUM(c.net_amount) AS total_net_amount
FROM public.commissions c
WHERE c.status != 'CANCELLED'
GROUP BY c.commission_type, c.calculation_basis
ORDER BY total_commission DESC;

COMMENT ON VIEW public.v_commission_by_type IS
  'Commission breakdown by type and calculation basis, excluding cancelled.';

-- ─── 7. VIEW: Commission Status Summary ───

CREATE OR REPLACE VIEW public.v_commission_status_summary AS
SELECT
  status,
  COUNT(*) AS commission_count,
  SUM(commission_amount) AS total_commission,
  SUM(tax_withheld) AS total_tax_withheld,
  SUM(net_amount) AS total_net_amount
FROM public.commissions
GROUP BY status
ORDER BY status;

COMMENT ON VIEW public.v_commission_status_summary IS
  'Commission totals grouped by payment status.';