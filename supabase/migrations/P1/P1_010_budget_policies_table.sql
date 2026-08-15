-- ============================================================================
-- P0 FIX: Create core.budget_policies table
-- Gap Report Bug 3.2: budget-check.service.ts queries core.budget_policies
-- but this table was never created in any migration.
-- Without this table, HARD_BLOCK budget enforcement never works.
-- ============================================================================

CREATE TABLE IF NOT EXISTS core.budget_policies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES core.organizations(id) ON DELETE CASCADE,
  enforcement_mode TEXT NOT NULL DEFAULT 'HARD_BLOCK'
    CONSTRAINT chk_enforcement_mode CHECK (enforcement_mode IN ('WARN_ONLY', 'HARD_BLOCK')),
  caution_threshold NUMERIC(5,2) NOT NULL DEFAULT 75
    CONSTRAINT chk_caution CHECK (caution_threshold >= 0 AND caution_threshold <= 100),
  warning_threshold NUMERIC(5,2) NOT NULL DEFAULT 90
    CONSTRAINT chk_warning CHECK (warning_threshold >= 0 AND warning_threshold <= 100),
  block_threshold NUMERIC(5,2) NOT NULL DEFAULT 100
    CONSTRAINT chk_block CHECK (block_threshold >= 0 AND block_threshold <= 100),
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- FIX: Ensure one active policy per organization using a Partial Unique Index
CREATE UNIQUE INDEX IF NOT EXISTS uq_org_active_policy 
  ON core.budget_policies (organization_id) 
  WHERE (is_active = true);

-- RLS: Organization-level isolation
ALTER TABLE core.budget_policies ENABLE ROW LEVEL SECURITY;

CREATE POLICY budget_policies_org_isolation ON core.budget_policies
  FOR ALL
  USING (organization_id = (SELECT organization_id FROM core.user_roles WHERE user_id = auth.uid() AND is_active = true LIMIT 1));

-- Index for fast lookup
CREATE INDEX IF NOT EXISTS idx_budget_policies_org_active
  ON core.budget_policies(organization_id, is_active);

-- Comment
COMMENT ON TABLE core.budget_policies IS 'Per-organization budget enforcement policy configuration. Referenced by budget-check.service.ts.';
