-- =============================================================================
-- OSYSTIC Finance Management System — Contractors Module (P1)
-- =============================================================================

-- ─── 1. CONTRACTORS TABLE ───
CREATE TABLE IF NOT EXISTS public.contractors (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                  VARCHAR(200) NOT NULL,
  email                 VARCHAR(255),
  phone                 VARCHAR(50),
  company               VARCHAR(200),
  role                  VARCHAR(50) NOT NULL DEFAULT 'DEVELOPER'
                        CHECK (role IN (
                          'DEVELOPER','DESIGNER','CONSULTANT','PM','QA_TESTER',
                          'DEVOPS','DATA_ANALYST','CONTENT_WRITER','OTHER'
                        )),
  specialization        VARCHAR(200),
  rate_type             VARCHAR(20) NOT NULL DEFAULT 'MONTHLY'
                        CHECK (rate_type IN (
                          'HOURLY','DAILY','WEEKLY','MONTHLY','FIXED_PROJECT'
                        )),
  rate                  NUMERIC(14,2) NOT NULL CHECK (rate >= 0),
  currency              VARCHAR(3) NOT NULL DEFAULT 'PKR',
  contract_start        DATE,
  contract_end          DATE,
  project_id            UUID REFERENCES public.projects(id) ON DELETE SET NULL,
  status                VARCHAR(20) NOT NULL DEFAULT 'ACTIVE'
                        CHECK (status IN (
                          'ACTIVE','ON_HOLD','TERMINATED','COMPLETED'
                        )),
  tax_withholding_pct   NUMERIC(5,2) DEFAULT 0 CHECK (tax_withholding_pct >= 0 AND tax_withholding_pct <= 100),
  payment_terms         VARCHAR(50) DEFAULT 'NET_30'
                        CHECK (payment_terms IN (
                          'NET_15','NET_30','NET_45','NET_60','UPFRONT','MILESTONE'
                        )),
  bank_name             VARCHAR(200),
  bank_account          VARCHAR(100),
  notes                 TEXT,
  created_by            UUID REFERENCES auth.users(id),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_contractors_role ON public.contractors(role);
CREATE INDEX IF NOT EXISTS idx_contractors_status ON public.contractors(status);
CREATE INDEX IF NOT EXISTS idx_contractors_project ON public.contractors(project_id);
CREATE INDEX IF NOT EXISTS idx_contractors_contract_end ON public.contractors(contract_end) WHERE status = 'ACTIVE';

COMMENT ON TABLE public.contractors IS
  'External contractor engagements with rates, contract periods, project allocation, and cost tracking.';

-- ─── 2. ROW LEVEL SECURITY ───

ALTER TABLE public.contractors ENABLE ROW LEVEL SECURITY;

-- Service role full access
CREATE POLICY "Service role full access on contractors"
  ON public.contractors FOR ALL
  TO service_role USING (true) WITH CHECK (true);

-- Authenticated: all operations
CREATE POLICY "Authenticated insert on contractors"
  ON public.contractors FOR INSERT
  TO authenticated WITH CHECK (true);

CREATE POLICY "Authenticated select on contractors"
  ON public.contractors FOR SELECT
  TO authenticated USING (true);

CREATE POLICY "Authenticated update on contractors"
  ON public.contractors FOR UPDATE
  TO authenticated USING (true) WITH CHECK (true);

CREATE POLICY "Authenticated delete on contractors"
  ON public.contractors FOR DELETE
  TO authenticated USING (true);

-- ─── 3. AUTO-UPDATE TRIGGER ───

CREATE TRIGGER trg_contractors_updated
  BEFORE UPDATE ON public.contractors
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- ─── 4. VIEW: Expiring Contracts with Time Buckets ───

CREATE OR REPLACE VIEW public.v_contractor_expirations AS
SELECT
  c.*,
  CASE
    WHEN c.contract_end IS NULL THEN NULL
    WHEN c.contract_end < CURRENT_DATE THEN 'EXPIRED'
    WHEN c.contract_end <= CURRENT_DATE + 7 THEN '7_DAYS'
    WHEN c.contract_end <= CURRENT_DATE + 30 THEN '30_DAYS'
    WHEN c.contract_end <= CURRENT_DATE + 60 THEN '60_DAYS'
    WHEN c.contract_end <= CURRENT_DATE + 90 THEN '90_DAYS'
    ELSE 'LATER'
  END AS expiry_bucket,
  (c.contract_end - CURRENT_DATE) AS days_until_expiry
FROM public.contractors c
WHERE c.status = 'ACTIVE' AND c.contract_end IS NOT NULL
ORDER BY c.contract_end ASC;

COMMENT ON VIEW public.v_contractor_expirations IS
  'Active contractors with contract end date bucketed into urgency groups.';

-- ─── 5. VIEW: Contractor Cost Summary by Role ───

CREATE OR REPLACE VIEW public.v_contractor_costs AS
SELECT
  c.role,
  COUNT(*) AS contractor_count,
  SUM(c.rate) AS raw_total_rate,
  SUM(CASE
    WHEN c.rate_type = 'HOURLY'      THEN c.rate * 2080   -- 52 weeks * 40 hrs
    WHEN c.rate_type = 'DAILY'       THEN c.rate * 260    -- 52 weeks * 5 days
    WHEN c.rate_type = 'WEEKLY'      THEN c.rate * 52
    WHEN c.rate_type = 'MONTHLY'     THEN c.rate * 12
    WHEN c.rate_type = 'FIXED_PROJECT' THEN c.rate
    ELSE 0
  END) AS annualized_cost,
  SUM(CASE
    WHEN c.rate_type = 'HOURLY'      THEN c.rate * 2080 / 12
    WHEN c.rate_type = 'DAILY'       THEN c.rate * 260 / 12
    WHEN c.rate_type = 'WEEKLY'      THEN c.rate * 52 / 12
    WHEN c.rate_type = 'MONTHLY'     THEN c.rate
    WHEN c.rate_type = 'FIXED_PROJECT' THEN c.rate / 12
    ELSE 0
  END) AS normalized_monthly
FROM public.contractors c
WHERE c.status = 'ACTIVE'
GROUP BY c.role
ORDER BY annualized_cost DESC;

COMMENT ON VIEW public.v_contractor_costs IS
  'Role-wise annualized and normalized monthly contractor cost for active engagements.';

-- ─── 6. VIEW: Contractor Cost Summary by Project ───

CREATE OR REPLACE VIEW public.v_contractor_project_costs AS
SELECT
  COALESCE(p.name, 'Unassigned') AS project_name,
  COALESCE(p.id::text, 'none') AS project_id,
  COUNT(*) AS contractor_count,
  SUM(CASE
    WHEN c.rate_type = 'HOURLY'      THEN c.rate * 2080
    WHEN c.rate_type = 'DAILY'       THEN c.rate * 260
    WHEN c.rate_type = 'WEEKLY'      THEN c.rate * 52
    WHEN c.rate_type = 'MONTHLY'     THEN c.rate * 12
    WHEN c.rate_type = 'FIXED_PROJECT' THEN c.rate
    ELSE 0
  END) AS annualized_cost,
  SUM(CASE
    WHEN c.rate_type = 'HOURLY'      THEN c.rate * 2080 / 12
    WHEN c.rate_type = 'DAILY'       THEN c.rate * 260 / 12
    WHEN c.rate_type = 'WEEKLY'      THEN c.rate * 52 / 12
    WHEN c.rate_type = 'MONTHLY'     THEN c.rate
    WHEN c.rate_type = 'FIXED_PROJECT' THEN c.rate / 12
    ELSE 0
  END) AS normalized_monthly
FROM public.contractors c
LEFT JOIN public.projects p ON p.id = c.project_id
WHERE c.status = 'ACTIVE'
GROUP BY p.name, p.id
ORDER BY annualized_cost DESC;

COMMENT ON VIEW public.v_contractor_project_costs IS
  'Project-wise annualized and normalized monthly contractor cost.';

-- =============================================================================
-- PERMISSIONS
-- =============================================================================

INSERT INTO core.permissions (id, code, name, module, action, is_system, description)
VALUES
  (gen_random_uuid(), 'CONTRACTOR_READ',    'Contractor: Read',    'CONTRACTOR', 'READ',    true, 'View contractors and cost reports'),
  (gen_random_uuid(), 'CONTRACTOR_CREATE',  'Contractor: Create',  'CONTRACTOR', 'CREATE',  true, 'Add new contractors'),
  (gen_random_uuid(), 'CONTRACTOR_UPDATE',  'Contractor: Update',  'CONTRACTOR', 'UPDATE',  true, 'Edit contractor details and contracts'),
  (gen_random_uuid(), 'CONTRACTOR_DELETE',  'Contractor: Delete',  'CONTRACTOR', 'DELETE',  true, 'Remove contractor records')
ON CONFLICT (code) DO NOTHING;

-- Role-Permission Mappings

-- CEO: All
INSERT INTO core.role_permissions (role_id, permission_id, data_scope, amount_limit)
SELECT r.id, p.id, 'ALL'::text, NULL::numeric
FROM core.roles r CROSS JOIN core.permissions p
WHERE r.name = 'CEO' AND p.code IN ('CONTRACTOR_READ','CONTRACTOR_CREATE','CONTRACTOR_UPDATE','CONTRACTOR_DELETE')
ON CONFLICT DO NOTHING;

-- CFO: All except DELETE
INSERT INTO core.role_permissions (role_id, permission_id, data_scope, amount_limit)
SELECT r.id, p.id, 'ALL'::text, NULL::numeric
FROM core.roles r CROSS JOIN core.permissions p
WHERE r.name = 'CFO' AND p.code IN ('CONTRACTOR_READ','CONTRACTOR_CREATE','CONTRACTOR_UPDATE')
ON CONFLICT DO NOTHING;

-- FINANCE_HEAD: Same as CFO
INSERT INTO core.role_permissions (role_id, permission_id, data_scope, amount_limit)
SELECT r.id, p.id, 'ALL'::text, NULL::numeric
FROM core.roles r CROSS JOIN core.permissions p
WHERE r.name = 'FINANCE_HEAD' AND p.code IN ('CONTRACTOR_READ','CONTRACTOR_CREATE','CONTRACTOR_UPDATE')
ON CONFLICT DO NOTHING;

-- ACCOUNTANT: Read + Create/Update
INSERT INTO core.role_permissions (role_id, permission_id, data_scope, amount_limit)
SELECT r.id, p.id, 'ALL'::text, NULL::numeric
FROM core.roles r CROSS JOIN core.permissions p
WHERE r.name = 'ACCOUNTANT' AND p.code IN ('CONTRACTOR_READ','CONTRACTOR_CREATE','CONTRACTOR_UPDATE')
ON CONFLICT DO NOTHING;

-- HOD: Read only, DEPARTMENT scope
INSERT INTO core.role_permissions (role_id, permission_id, data_scope, amount_limit)
SELECT r.id, p.id, 'DEPARTMENT'::text, NULL::numeric
FROM core.roles r CROSS JOIN core.permissions p
WHERE r.name = 'HOD' AND p.code IN ('CONTRACTOR_READ')
ON CONFLICT DO NOTHING;

-- PROJECT_MANAGER: Read only, PROJECT scope
INSERT INTO core.role_permissions (role_id, permission_id, data_scope, amount_limit)
SELECT r.id, p.id, 'PROJECT'::text, NULL::numeric
FROM core.roles r CROSS JOIN core.permissions p
WHERE r.name = 'PROJECT_MANAGER' AND p.code IN ('CONTRACTOR_READ')
ON CONFLICT DO NOTHING;