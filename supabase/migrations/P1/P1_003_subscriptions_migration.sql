-- =============================================================================
-- OSYSTIC Finance Management System — Subscriptions Module (P1)
-- =============================================================================
-- Spec Reference: Section 5.11 — Recurring Costs, Subscriptions, and Commitments
-- Priority: P1
-- Purpose: Track recurring costs, prevent missed renewals, show future cash
--          obligations, report upcoming commitments and annualized spend.
-- Schema: public
-- =============================================================================

-- ─── 1. SUBSCRIPTIONS TABLE ───
CREATE TABLE IF NOT EXISTS public.subscriptions (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                  VARCHAR(200) NOT NULL,
  vendor                VARCHAR(200),
  category              VARCHAR(50) NOT NULL DEFAULT 'SOFTWARE'
                        CHECK (category IN (
                          'HOSTING','DOMAIN','AI_API','DATABASE','EMAIL',
                          'INTERNET','RENT','UTILITIES','SOFTWARE','HARDWARE',
                          'INSURANCE','MEMBERSHIP','CLOUD_STORAGE','CRM',
                          'PROJECT_MANAGEMENT','COMMUNICATION','SECURITY','OTHER'
                        )),
  amount                NUMERIC(14,2) NOT NULL CHECK (amount >= 0),
  currency              VARCHAR(3) NOT NULL DEFAULT 'PKR',
  billing_frequency     VARCHAR(20) NOT NULL DEFAULT 'MONTHLY'
                        CHECK (billing_frequency IN (
                          'WEEKLY','MONTHLY','QUARTERLY','SEMI_ANNUALLY',
                          'ANNUALLY','BIENNIAL','ONE_TIME'
                        )),
  start_date            DATE NOT NULL DEFAULT CURRENT_DATE,
  renewal_date          DATE,
  cancellation_notice_days INTEGER NOT NULL DEFAULT 30,
  auto_renew            BOOLEAN NOT NULL DEFAULT true,
  project_id            UUID REFERENCES public.projects(id) ON DELETE SET NULL,
  owner                 VARCHAR(200),
  status                VARCHAR(20) NOT NULL DEFAULT 'ACTIVE'
                        CHECK (status IN (
                          'ACTIVE','PAUSED','CANCELLED','EXPIRED','PENDING_SETUP'
                        )),
  notes                 TEXT,
  created_by            UUID REFERENCES auth.users(id),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_subscriptions_category ON public.subscriptions(category);
CREATE INDEX IF NOT EXISTS idx_subscriptions_status ON public.subscriptions(status);
CREATE INDEX IF NOT EXISTS idx_subscriptions_renewal ON public.subscriptions(renewal_date) WHERE status = 'ACTIVE';
CREATE INDEX IF NOT EXISTS idx_subscriptions_project ON public.subscriptions(project_id);

COMMENT ON TABLE public.subscriptions IS
  'Recurring costs and subscriptions with renewal tracking and annualized spend reporting.';

-- ─── 2. ROW LEVEL SECURITY ───

ALTER TABLE public.subscriptions ENABLE ROW LEVEL SECURITY;

-- Service role full access
CREATE POLICY "Service role full access on subscriptions"
  ON public.subscriptions FOR ALL
  TO service_role USING (true) WITH CHECK (true);

-- Authenticated: all operations
CREATE POLICY "Authenticated insert on subscriptions"
  ON public.subscriptions FOR INSERT
  TO authenticated WITH CHECK (true);

CREATE POLICY "Authenticated select on subscriptions"
  ON public.subscriptions FOR SELECT
  TO authenticated USING (true);

CREATE POLICY "Authenticated update on subscriptions"
  ON public.subscriptions FOR UPDATE
  TO authenticated USING (true) WITH CHECK (true);

CREATE POLICY "Authenticated delete on subscriptions"
  ON public.subscriptions FOR DELETE
  TO authenticated USING (true);

-- ─── 3. AUTO-UPDATE TRIGGER ───
-- FIX #2: Changed from non-existent payroll_update_timestamp() to the actual
-- update_updated_at() function that exists in the schema.

CREATE TRIGGER trg_subscriptions_updated
  BEFORE UPDATE ON public.subscriptions
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- ─── 4. VIEW: Upcoming Renewals with Time Buckets ───

CREATE OR REPLACE VIEW public.v_subscription_renewals AS
SELECT
  s.*,
  CASE
    WHEN s.renewal_date IS NULL THEN NULL
    WHEN s.renewal_date < CURRENT_DATE THEN 'OVERDUE'
    WHEN s.renewal_date <= CURRENT_DATE + 7 THEN '7_DAYS'
    WHEN s.renewal_date <= CURRENT_DATE + 30 THEN '30_DAYS'
    WHEN s.renewal_date <= CURRENT_DATE + 60 THEN '60_DAYS'
    WHEN s.renewal_date <= CURRENT_DATE + 90 THEN '90_DAYS'
    ELSE 'LATER'
  END AS renewal_bucket,
  (s.renewal_date - CURRENT_DATE) AS days_until_renewal,
  -- FIX #7: Cast to DATE properly instead of date - integer (which returns integer in PG)
  (s.renewal_date - (s.cancellation_notice_days || ' days')::INTERVAL)::DATE AS notice_date
FROM public.subscriptions s
WHERE s.status = 'ACTIVE' AND s.renewal_date IS NOT NULL
ORDER BY s.renewal_date ASC;

COMMENT ON VIEW public.v_subscription_renewals IS
  'Active subscriptions with renewal date bucketed into urgency groups.';

-- ─── 5. VIEW: Annualized Spend by Category ───

CREATE OR REPLACE VIEW public.v_subscription_spend AS
SELECT
  s.category,
  COUNT(*) AS subscription_count,
  SUM(s.amount) AS raw_total,
  SUM(CASE
    WHEN s.billing_frequency = 'WEEKLY' THEN s.amount * 52
    WHEN s.billing_frequency = 'MONTHLY' THEN s.amount * 12
    WHEN s.billing_frequency = 'QUARTERLY' THEN s.amount * 4
    WHEN s.billing_frequency = 'SEMI_ANNUALLY' THEN s.amount * 2
    WHEN s.billing_frequency = 'ANNUALLY' THEN s.amount
    WHEN s.billing_frequency = 'BIENNIAL' THEN s.amount / 2
    ELSE 0
  END) AS annualized_amount,
  SUM(CASE
    WHEN s.billing_frequency = 'WEEKLY' THEN s.amount * 52 / 12
    WHEN s.billing_frequency = 'MONTHLY' THEN s.amount
    WHEN s.billing_frequency = 'QUARTERLY' THEN s.amount * 4 / 12
    WHEN s.billing_frequency = 'SEMI_ANNUALLY' THEN s.amount * 2 / 12
    WHEN s.billing_frequency = 'ANNUALLY' THEN s.amount / 12
    WHEN s.billing_frequency = 'BIENNIAL' THEN s.amount / 24
    ELSE 0
  END) AS normalized_monthly
FROM public.subscriptions s
WHERE s.status = 'ACTIVE'
GROUP BY s.category
ORDER BY annualized_amount DESC;

COMMENT ON VIEW public.v_subscription_spend IS
  'Category-wise annualized and normalized monthly spend for active subscriptions.';

-- =============================================================================
-- PERMISSIONS
-- =============================================================================

INSERT INTO core.permissions (id, code, name, module, action, is_system, description)
VALUES
  (gen_random_uuid(), 'SUBSCRIPTION_READ',    'Subscription: Read',    'SUBSCRIPTION', 'READ',    true, 'View subscriptions and spend reports'),
  (gen_random_uuid(), 'SUBSCRIPTION_CREATE',  'Subscription: Create',  'SUBSCRIPTION', 'CREATE',  true, 'Add new subscriptions'),
  (gen_random_uuid(), 'SUBSCRIPTION_UPDATE',  'Subscription: Update',  'SUBSCRIPTION', 'UPDATE',  true, 'Edit subscription details and renewal dates'),
  (gen_random_uuid(), 'SUBSCRIPTION_DELETE',  'Subscription: Delete',  'SUBSCRIPTION', 'DELETE',  true, 'Remove subscription records')
ON CONFLICT (code) DO NOTHING;

-- Role-Permission Mappings

-- CEO: All
INSERT INTO core.role_permissions (role_id, permission_id, data_scope, amount_limit)
SELECT r.id, p.id, 'ALL'::text, NULL::numeric
FROM core.roles r CROSS JOIN core.permissions p
WHERE r.name = 'CEO' AND p.code IN ('SUBSCRIPTION_READ','SUBSCRIPTION_CREATE','SUBSCRIPTION_UPDATE','SUBSCRIPTION_DELETE')
ON CONFLICT DO NOTHING;

-- CFO: All except DELETE
INSERT INTO core.role_permissions (role_id, permission_id, data_scope, amount_limit)
SELECT r.id, p.id, 'ALL'::text, NULL::numeric
FROM core.roles r CROSS JOIN core.permissions p
WHERE r.name = 'CFO' AND p.code IN ('SUBSCRIPTION_READ','SUBSCRIPTION_CREATE','SUBSCRIPTION_UPDATE')
ON CONFLICT DO NOTHING;

-- FINANCE_HEAD: Same as CFO
INSERT INTO core.role_permissions (role_id, permission_id, data_scope, amount_limit)
SELECT r.id, p.id, 'ALL'::text, NULL::numeric
FROM core.roles r CROSS JOIN core.permissions p
WHERE r.name = 'FINANCE_HEAD' AND p.code IN ('SUBSCRIPTION_READ','SUBSCRIPTION_CREATE','SUBSCRIPTION_UPDATE')
ON CONFLICT DO NOTHING;

-- ACCOUNTANT: Read + Create/Update
INSERT INTO core.role_permissions (role_id, permission_id, data_scope, amount_limit)
SELECT r.id, p.id, 'ALL'::text, NULL::numeric
FROM core.roles r CROSS JOIN core.permissions p
WHERE r.name = 'ACCOUNTANT' AND p.code IN ('SUBSCRIPTION_READ','SUBSCRIPTION_CREATE','SUBSCRIPTION_UPDATE')
ON CONFLICT DO NOTHING;

-- HOD: Read only, DEPARTMENT scope
INSERT INTO core.role_permissions (role_id, permission_id, data_scope, amount_limit)
SELECT r.id, p.id, 'DEPARTMENT'::text, NULL::numeric
FROM core.roles r CROSS JOIN core.permissions p
WHERE r.name = 'HOD' AND p.code IN ('SUBSCRIPTION_READ')
ON CONFLICT DO NOTHING;

-- PROJECT_MANAGER: Read only, PROJECT scope
INSERT INTO core.role_permissions (role_id, permission_id, data_scope, amount_limit)
SELECT r.id, p.id, 'PROJECT'::text, NULL::numeric
FROM core.roles r CROSS JOIN core.permissions p
WHERE r.name = 'PROJECT_MANAGER' AND p.code IN ('SUBSCRIPTION_READ')
ON CONFLICT DO NOTHING;