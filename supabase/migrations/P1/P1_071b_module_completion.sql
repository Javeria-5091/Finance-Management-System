-- OSYSTIC Phase 2: Projects + Budgets completion
-- Scope: organization integrity, budget revision correctness, performance.

ALTER TABLE public.projects
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz,
  ADD COLUMN IF NOT EXISTS deleted_by uuid;

CREATE INDEX IF NOT EXISTS idx_projects_org_status
  ON public.projects (organization_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_projects_org_budget
  ON public.projects (organization_id, budget_id);
CREATE INDEX IF NOT EXISTS idx_budgets_org_status_dates
  ON public.budgets (organization_id, status, start_date, end_date);
CREATE INDEX IF NOT EXISTS idx_budget_revisions_org_budget
  ON finance.budget_revisions (organization_id, budget_id, revision_number DESC);

-- A revision number must be present and unique per budget.
ALTER TABLE finance.budget_revisions
  ALTER COLUMN revision_number SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'finance.budget_revisions'::regclass
      AND conname = 'budget_revisions_unique_org_number'
  ) THEN
    ALTER TABLE finance.budget_revisions
      ADD CONSTRAINT budget_revisions_unique_org_number UNIQUE (organization_id, budget_id, revision_number);
  END IF;
END $$;

-- Prevent negative budget revision amounts.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'finance.budget_revisions'::regclass
      AND conname = 'budget_revisions_amount_check'
  ) THEN
    ALTER TABLE finance.budget_revisions
      ADD CONSTRAINT budget_revisions_amount_check
      CHECK (previous_amount >= 0 AND revised_amount >= 0);
  END IF;
END $$;

COMMENT ON TABLE public.projects IS
  'Project master data. Organization-scoped. Soft deletion uses deleted_at/deleted_by; status remains Active/Completed/On Hold for compatibility with the existing schema and UI.';
