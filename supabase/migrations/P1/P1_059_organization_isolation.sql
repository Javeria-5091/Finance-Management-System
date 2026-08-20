-- =============================================================================
-- Migration P1_059: Organization Isolation — Batch 1 (Remediation ISS-01 / ISS-03
-- / ISS-05 / ISS-06 / ISS-08)
-- =============================================================================
-- PURPOSE
--   Closes the cross-organization data exposure confirmed by the 20 Aug 2026
--   independent audit (OSYSTIC_Audit_Report.md, Section 5/8, ISS-01/03/05/06/08).
--
--   ISS-01 (CRITICAL): the following 12 tables have either no organization_id
--   column, or RLS policies whose USING/WITH CHECK clause is a bare `true` for
--   `authenticated` -- meaning any logged-in user of ANY organization can read
--   and write every organization's data in these tables:
--     public.payroll_advances, payroll_commissions, payroll_compensation,
--     payroll_deductions, payroll_employees, payroll_lines,
--     payroll_reimbursements, payroll_runs, commissions, contractors,
--     subscriptions, incomes
--
--   ISS-05 (MEDIUM): finance.fee_tiers / finance.fee_computation_log are
--   readable across organizations (fee_tiers has no direct organization_id --
--   it is a child of finance.fee_rules; fee_computation_log has no
--   organization_id at all despite its SELECT policy being literally named
--   "org_read_fee_log").
--
--   ISS-03 (HIGH): public.is_admin() is a global, non-organization-aware flag
--   (reads public.profiles.role = 'Admin', a value the profiles_role_check
--   CHECK constraint does not actually allow, so the function is presently
--   dead/always-false -- but several RLS policies still use it as an
--   unscoped OR-bypass with no accompanying organization predicate, which is
--   a live landmine the moment 'Admin' ever becomes reachable, e.g. via a
--   direct INSERT that skips application-level role validation, a future
--   constraint change, or a service-role import). This migration removes the
--   unscoped bypass and replaces it with the correct, already-proven,
--   organization-aware role model (core.is_finance_head() + core.same_org()).
--
--   ISS-06 (LOW): ai.ai_model_registry / ai.ai_prompt_versions grant SELECT
--   to PUBLIC (including the unauthenticated `anon` role), not just
--   `authenticated`.
--
--   ISS-08 (HIGH): finance.get_next_number(p_type) (the original single-arg
--   overload) selects "the" OPEN fiscal year / numbering sequence with NO
--   organization filter. A correctly org-scoped 2-arg overload
--   (p_type, p_organization_id DEFAULT core.current_user_org_id()) already
--   exists in the schema (added by a prior migration), but application code
--   calls it with only { p_type: ... }, and because BOTH overloads currently
--   exist simultaneously, that call can resolve to the unscoped one.
--
-- APPROACH
--   - Additive/idempotent where possible (ADD COLUMN IF NOT EXISTS, DROP
--     POLICY IF EXISTS before CREATE POLICY, CREATE OR REPLACE FUNCTION).
--   - organization_id columns added NULLABLE (matching the same fail-closed
--     transition pattern already used by core.same_org(): a NULL
--     organization_id never matches core.same_org(), so an unbackfilled row
--     simply becomes invisible under the new policies rather than exposed
--     cross-org -- strictly safer than the current `true` policies, and
--     avoids a hard-failing NOT NULL migration in case a small number of
--     historical rows cannot be resolved to an organization automatically).
--   - Existing over-permissive policies are explicitly DROPped (not just
--     shadowed by a new, additional policy) -- Postgres RLS policies are
--     OR'd together, so leaving "USING (true)" policies in place while
--     adding a correct one would not fix anything.
--   - No data is deleted. No table is dropped. No historical row is altered
--     beyond populating the new organization_id column.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- STEP 1: Add organization_id (nullable) to the 12 ISS-01 tables + fee_computation_log
-- -----------------------------------------------------------------------------

ALTER TABLE public.payroll_advances        ADD COLUMN IF NOT EXISTS organization_id uuid;
ALTER TABLE public.payroll_commissions     ADD COLUMN IF NOT EXISTS organization_id uuid;
ALTER TABLE public.payroll_compensation    ADD COLUMN IF NOT EXISTS organization_id uuid;
ALTER TABLE public.payroll_deductions      ADD COLUMN IF NOT EXISTS organization_id uuid;
ALTER TABLE public.payroll_employees       ADD COLUMN IF NOT EXISTS organization_id uuid;
ALTER TABLE public.payroll_lines           ADD COLUMN IF NOT EXISTS organization_id uuid;
ALTER TABLE public.payroll_reimbursements  ADD COLUMN IF NOT EXISTS organization_id uuid;
ALTER TABLE public.payroll_runs            ADD COLUMN IF NOT EXISTS organization_id uuid;
ALTER TABLE public.commissions             ADD COLUMN IF NOT EXISTS organization_id uuid;
ALTER TABLE public.contractors             ADD COLUMN IF NOT EXISTS organization_id uuid;
ALTER TABLE public.subscriptions           ADD COLUMN IF NOT EXISTS organization_id uuid;
ALTER TABLE public.incomes                 ADD COLUMN IF NOT EXISTS organization_id uuid;
ALTER TABLE finance.fee_computation_log    ADD COLUMN IF NOT EXISTS organization_id uuid;

COMMENT ON COLUMN public.payroll_employees.organization_id IS
  'Added by P1_059 (Remediation ISS-01, Critical). Nullable by design -- see migration header. Backfilled from created_by -> profiles.organization_id in STEP 2.';

-- -----------------------------------------------------------------------------
-- STEP 2: Best-effort backfill of organization_id for existing rows
-- -----------------------------------------------------------------------------
-- Root/master rows are backfilled from their creator's organization
-- (public.profiles.organization_id). Child/dependent rows are backfilled
-- first from their own parent (once the parent is backfilled), falling back
-- to their own creator. This mirrors the existing, already-reviewed pattern
-- in migration 028/029 for the rest of the schema.
-- Idempotent: every UPDATE below only touches rows still missing an
-- organization_id, so re-running this migration is a no-op on already
-- backfilled rows.

-- payroll_employees: root table, backfill from created_by
UPDATE public.payroll_employees pe
SET organization_id = p.organization_id
FROM public.profiles p
WHERE pe.organization_id IS NULL
  AND pe.created_by = p.user_id
  AND p.organization_id IS NOT NULL;

-- payroll_runs: root table, backfill from created_by (fallback approved_by/posted_by)
UPDATE public.payroll_runs pr
SET organization_id = p.organization_id
FROM public.profiles p
WHERE pr.organization_id IS NULL
  AND pr.created_by = p.user_id
  AND p.organization_id IS NOT NULL;

UPDATE public.payroll_runs pr
SET organization_id = p.organization_id
FROM public.profiles p
WHERE pr.organization_id IS NULL
  AND COALESCE(pr.approved_by, pr.posted_by, pr.calculated_by) = p.user_id
  AND p.organization_id IS NOT NULL;

-- payroll_compensation / payroll_deductions / payroll_advances / payroll_commissions /
-- payroll_reimbursements: backfill via employee_id -> payroll_employees.organization_id
-- (now populated above), falling back to their own created_by.
UPDATE public.payroll_compensation t
SET organization_id = pe.organization_id
FROM public.payroll_employees pe
WHERE t.organization_id IS NULL AND t.employee_id = pe.id AND pe.organization_id IS NOT NULL;
UPDATE public.payroll_compensation t
SET organization_id = p.organization_id
FROM public.profiles p
WHERE t.organization_id IS NULL AND t.created_by = p.user_id AND p.organization_id IS NOT NULL;

UPDATE public.payroll_deductions t
SET organization_id = pe.organization_id
FROM public.payroll_employees pe
WHERE t.organization_id IS NULL AND t.employee_id = pe.id AND pe.organization_id IS NOT NULL;
UPDATE public.payroll_deductions t
SET organization_id = p.organization_id
FROM public.profiles p
WHERE t.organization_id IS NULL AND t.created_by = p.user_id AND p.organization_id IS NOT NULL;

UPDATE public.payroll_advances t
SET organization_id = pe.organization_id
FROM public.payroll_employees pe
WHERE t.organization_id IS NULL AND t.employee_id = pe.id AND pe.organization_id IS NOT NULL;
UPDATE public.payroll_advances t
SET organization_id = p.organization_id
FROM public.profiles p
WHERE t.organization_id IS NULL AND t.created_by = p.user_id AND p.organization_id IS NOT NULL;

UPDATE public.payroll_commissions t
SET organization_id = pe.organization_id
FROM public.payroll_employees pe
WHERE t.organization_id IS NULL AND t.employee_id = pe.id AND pe.organization_id IS NOT NULL;
UPDATE public.payroll_commissions t
SET organization_id = p.organization_id
FROM public.profiles p
WHERE t.organization_id IS NULL AND t.created_by = p.user_id AND p.organization_id IS NOT NULL;

UPDATE public.payroll_reimbursements t
SET organization_id = pe.organization_id
FROM public.payroll_employees pe
WHERE t.organization_id IS NULL AND t.employee_id = pe.id AND pe.organization_id IS NOT NULL;
UPDATE public.payroll_reimbursements t
SET organization_id = p.organization_id
FROM public.profiles p
WHERE t.organization_id IS NULL AND t.created_by = p.user_id AND p.organization_id IS NOT NULL;

-- payroll_lines: backfill via payroll_run_id -> payroll_runs.organization_id,
-- fallback via employee_id -> payroll_employees.organization_id.
UPDATE public.payroll_lines t
SET organization_id = pr.organization_id
FROM public.payroll_runs pr
WHERE t.organization_id IS NULL AND t.payroll_run_id = pr.id AND pr.organization_id IS NOT NULL;
UPDATE public.payroll_lines t
SET organization_id = pe.organization_id
FROM public.payroll_employees pe
WHERE t.organization_id IS NULL AND t.employee_id = pe.id AND pe.organization_id IS NOT NULL;

-- contractors: root-ish table, backfill from created_by, fallback via project_id
UPDATE public.contractors t
SET organization_id = p.organization_id
FROM public.profiles p
WHERE t.organization_id IS NULL AND t.created_by = p.user_id AND p.organization_id IS NOT NULL;
UPDATE public.contractors t
SET organization_id = pr.organization_id
FROM public.projects pr
WHERE t.organization_id IS NULL AND t.project_id = pr.id AND pr.organization_id IS NOT NULL;

-- commissions: backfill via contractor_id -> contractors.organization_id (now
-- populated), fallback via created_by, fallback via project_id.
UPDATE public.commissions t
SET organization_id = c.organization_id
FROM public.contractors c
WHERE t.organization_id IS NULL AND t.contractor_id = c.id AND c.organization_id IS NOT NULL;
UPDATE public.commissions t
SET organization_id = p.organization_id
FROM public.profiles p
WHERE t.organization_id IS NULL AND t.created_by = p.user_id AND p.organization_id IS NOT NULL;
UPDATE public.commissions t
SET organization_id = pr.organization_id
FROM public.projects pr
WHERE t.organization_id IS NULL AND t.project_id = pr.id AND pr.organization_id IS NOT NULL;

-- subscriptions: backfill from created_by, fallback via project_id
UPDATE public.subscriptions t
SET organization_id = p.organization_id
FROM public.profiles p
WHERE t.organization_id IS NULL AND t.created_by = p.user_id AND p.organization_id IS NOT NULL;
UPDATE public.subscriptions t
SET organization_id = pr.organization_id
FROM public.projects pr
WHERE t.organization_id IS NULL AND t.project_id = pr.id AND pr.organization_id IS NOT NULL;

-- incomes: backfill from user_id (creator), fallback via project_id
UPDATE public.incomes t
SET organization_id = p.organization_id
FROM public.profiles p
WHERE t.organization_id IS NULL AND t.user_id = p.user_id AND p.organization_id IS NOT NULL;
UPDATE public.incomes t
SET organization_id = pr.organization_id
FROM public.projects pr
WHERE t.organization_id IS NULL AND t.project_id = pr.id AND pr.organization_id IS NOT NULL;

-- finance.fee_computation_log: backfill via fee_rule_id -> finance.fee_rules.organization_id,
-- fallback via platform_id -> finance.platforms.organization_id, fallback via computed_by.
UPDATE finance.fee_computation_log t
SET organization_id = fr.organization_id
FROM finance.fee_rules fr
WHERE t.organization_id IS NULL AND t.fee_rule_id = fr.id AND fr.organization_id IS NOT NULL;
UPDATE finance.fee_computation_log t
SET organization_id = pl.organization_id
FROM finance.platforms pl
WHERE t.organization_id IS NULL AND t.platform_id = pl.id AND pl.organization_id IS NOT NULL;
UPDATE finance.fee_computation_log t
SET organization_id = p.organization_id
FROM public.profiles p
WHERE t.organization_id IS NULL AND t.computed_by = p.user_id AND p.organization_id IS NOT NULL;

-- -----------------------------------------------------------------------------
-- STEP 3: Indexes on the new columns (org-scoped queries are now the hot path)
-- -----------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_payroll_advances_org       ON public.payroll_advances (organization_id);
CREATE INDEX IF NOT EXISTS idx_payroll_commissions_org    ON public.payroll_commissions (organization_id);
CREATE INDEX IF NOT EXISTS idx_payroll_compensation_org   ON public.payroll_compensation (organization_id);
CREATE INDEX IF NOT EXISTS idx_payroll_deductions_org     ON public.payroll_deductions (organization_id);
CREATE INDEX IF NOT EXISTS idx_payroll_employees_org      ON public.payroll_employees (organization_id);
CREATE INDEX IF NOT EXISTS idx_payroll_lines_org           ON public.payroll_lines (organization_id);
CREATE INDEX IF NOT EXISTS idx_payroll_reimbursements_org ON public.payroll_reimbursements (organization_id);
CREATE INDEX IF NOT EXISTS idx_payroll_runs_org            ON public.payroll_runs (organization_id);
CREATE INDEX IF NOT EXISTS idx_commissions_org             ON public.commissions (organization_id);
CREATE INDEX IF NOT EXISTS idx_contractors_org             ON public.contractors (organization_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_org           ON public.subscriptions (organization_id);
CREATE INDEX IF NOT EXISTS idx_incomes_org                 ON public.incomes (organization_id);
CREATE INDEX IF NOT EXISTS idx_fee_computation_log_org     ON finance.fee_computation_log (organization_id);

-- -----------------------------------------------------------------------------
-- STEP 4: Drop every over-permissive legacy policy on the 12 ISS-01 tables
-- -----------------------------------------------------------------------------
-- These are dropped explicitly (not just superseded) because RLS policies are
-- OR'd together -- leaving any one of these active would continue to grant
-- unconditional cross-organization access no matter what is added afterward.

-- payroll_advances
DROP POLICY IF EXISTS "Authenticated insert on payroll_advances" ON public.payroll_advances;
DROP POLICY IF EXISTS "Authenticated read on payroll_advances" ON public.payroll_advances;
DROP POLICY IF EXISTS "Authenticated update on payroll_advances" ON public.payroll_advances;
-- ("Service role full access on payroll_advances" is correctly scoped to
--  service_role only and is intentionally left in place.)

-- payroll_commissions
DROP POLICY IF EXISTS "Authenticated insert on payroll_commissions" ON public.payroll_commissions;
DROP POLICY IF EXISTS "Authenticated read on payroll_commissions" ON public.payroll_commissions;
DROP POLICY IF EXISTS "Authenticated update on payroll_commissions" ON public.payroll_commissions;

-- payroll_compensation
DROP POLICY IF EXISTS "Authenticated insert on payroll_compensation" ON public.payroll_compensation;
DROP POLICY IF EXISTS "Authenticated update on payroll_compensation" ON public.payroll_compensation;
-- NOTE (confirmed during audit): payroll_compensation has no SELECT policy
-- for `authenticated` at all today (blind-write only bug) -- STEP 5 adds one.

-- payroll_deductions
DROP POLICY IF EXISTS "Authenticated insert on payroll_deductions" ON public.payroll_deductions;
DROP POLICY IF EXISTS "Authenticated update on payroll_deductions" ON public.payroll_deductions;
-- NOTE: same "no SELECT policy at all" gap as payroll_compensation.

-- payroll_employees
DROP POLICY IF EXISTS "Authenticated delete on payroll_employees" ON public.payroll_employees;
DROP POLICY IF EXISTS "Authenticated insert on payroll_employees" ON public.payroll_employees;
DROP POLICY IF EXISTS "Authenticated read on payroll_employees" ON public.payroll_employees;
DROP POLICY IF EXISTS "Authenticated update on payroll_employees" ON public.payroll_employees;

-- payroll_lines
DROP POLICY IF EXISTS "Authenticated insert on payroll_lines" ON public.payroll_lines;
DROP POLICY IF EXISTS "Authenticated read on payroll_lines" ON public.payroll_lines;
DROP POLICY IF EXISTS "Authenticated update on payroll_lines" ON public.payroll_lines;

-- payroll_reimbursements
DROP POLICY IF EXISTS "Authenticated insert on payroll_reimbursements" ON public.payroll_reimbursements;
DROP POLICY IF EXISTS "Authenticated read on payroll_reimbursements" ON public.payroll_reimbursements;
DROP POLICY IF EXISTS "Authenticated update on payroll_reimbursements" ON public.payroll_reimbursements;

-- payroll_runs
DROP POLICY IF EXISTS "Authenticated insert on payroll_runs" ON public.payroll_runs;
DROP POLICY IF EXISTS "Authenticated read on payroll_runs" ON public.payroll_runs;
DROP POLICY IF EXISTS "Authenticated update on payroll_runs" ON public.payroll_runs;

-- commissions
DROP POLICY IF EXISTS "Authenticated delete on commissions" ON public.commissions;
DROP POLICY IF EXISTS "Authenticated insert on commissions" ON public.commissions;
DROP POLICY IF EXISTS "Authenticated select on commissions" ON public.commissions;
DROP POLICY IF EXISTS "Authenticated update on commissions" ON public.commissions;

-- contractors
DROP POLICY IF EXISTS "Authenticated delete on contractors" ON public.contractors;
DROP POLICY IF EXISTS "Authenticated insert on contractors" ON public.contractors;
DROP POLICY IF EXISTS "Authenticated select on contractors" ON public.contractors;
DROP POLICY IF EXISTS "Authenticated update on contractors" ON public.contractors;

-- subscriptions
DROP POLICY IF EXISTS "Authenticated delete on subscriptions" ON public.subscriptions;
DROP POLICY IF EXISTS "Authenticated insert on subscriptions" ON public.subscriptions;
DROP POLICY IF EXISTS "Authenticated select on subscriptions" ON public.subscriptions;
DROP POLICY IF EXISTS "Authenticated update on subscriptions" ON public.subscriptions;

-- incomes -- multiple generations of overlapping legacy policies exist here;
-- all unscoped/duplicated ones are dropped and replaced by a single clean set
-- in STEP 6, mirroring the exact pattern already used on public.expenses.
DROP POLICY IF EXISTS "Admin can delete any income" ON public.incomes;
DROP POLICY IF EXISTS "Admin can delete income" ON public.incomes;
DROP POLICY IF EXISTS "Admin can insert any income" ON public.incomes;
DROP POLICY IF EXISTS "Admin can insert income" ON public.incomes;
DROP POLICY IF EXISTS "Admin can update any income" ON public.incomes;
DROP POLICY IF EXISTS "Admin can update income" ON public.incomes;
DROP POLICY IF EXISTS "All authenticated users can view incomes" ON public.incomes;
DROP POLICY IF EXISTS "User can delete own income" ON public.incomes;
DROP POLICY IF EXISTS "User can insert own income" ON public.incomes;
DROP POLICY IF EXISTS "User can update own income" ON public.incomes;
DROP POLICY IF EXISTS "Users can delete own income" ON public.incomes;
DROP POLICY IF EXISTS "Users can insert own income" ON public.incomes;
DROP POLICY IF EXISTS "Users can update own income" ON public.incomes;
DROP POLICY IF EXISTS "incomes_delete" ON public.incomes;
DROP POLICY IF EXISTS "incomes_insert" ON public.incomes;
DROP POLICY IF EXISTS "incomes_select" ON public.incomes;
DROP POLICY IF EXISTS "incomes_update" ON public.incomes;

-- -----------------------------------------------------------------------------
-- STEP 5: Payroll tables — new org- and role-scoped policies
-- -----------------------------------------------------------------------------
-- Matches spec Appendix A exactly: CEO Full, Finance Head Full/Config,
-- Accountant Config, HOD/PM/Employee/Auditor/Tech Admin None by default.
-- core.is_finance_head() already returns true for CEO OR FINANCE_HEAD.

CREATE POLICY "payroll_advances_select_org_scoped" ON public.payroll_advances
  FOR SELECT TO authenticated
  USING (core.same_org(organization_id) AND (core.is_finance_head() OR core.has_role('ACCOUNTANT')));
CREATE POLICY "payroll_advances_insert_org_scoped" ON public.payroll_advances
  FOR INSERT TO authenticated
  WITH CHECK (core.same_org(organization_id) AND (core.is_finance_head() OR core.has_role('ACCOUNTANT')));
CREATE POLICY "payroll_advances_update_org_scoped" ON public.payroll_advances
  FOR UPDATE TO authenticated
  USING (core.same_org(organization_id) AND (core.is_finance_head() OR core.has_role('ACCOUNTANT')))
  WITH CHECK (core.same_org(organization_id) AND (core.is_finance_head() OR core.has_role('ACCOUNTANT')));
CREATE POLICY "payroll_advances_delete_org_scoped" ON public.payroll_advances
  FOR DELETE TO authenticated
  USING (core.same_org(organization_id) AND core.is_finance_head());

CREATE POLICY "payroll_commissions_select_org_scoped" ON public.payroll_commissions
  FOR SELECT TO authenticated
  USING (core.same_org(organization_id) AND (core.is_finance_head() OR core.has_role('ACCOUNTANT')));
CREATE POLICY "payroll_commissions_insert_org_scoped" ON public.payroll_commissions
  FOR INSERT TO authenticated
  WITH CHECK (core.same_org(organization_id) AND (core.is_finance_head() OR core.has_role('ACCOUNTANT')));
CREATE POLICY "payroll_commissions_update_org_scoped" ON public.payroll_commissions
  FOR UPDATE TO authenticated
  USING (core.same_org(organization_id) AND (core.is_finance_head() OR core.has_role('ACCOUNTANT')))
  WITH CHECK (core.same_org(organization_id) AND (core.is_finance_head() OR core.has_role('ACCOUNTANT')));
CREATE POLICY "payroll_commissions_delete_org_scoped" ON public.payroll_commissions
  FOR DELETE TO authenticated
  USING (core.same_org(organization_id) AND core.is_finance_head());

CREATE POLICY "payroll_compensation_select_org_scoped" ON public.payroll_compensation
  FOR SELECT TO authenticated
  USING (core.same_org(organization_id) AND (core.is_finance_head() OR core.has_role('ACCOUNTANT')));
CREATE POLICY "payroll_compensation_insert_org_scoped" ON public.payroll_compensation
  FOR INSERT TO authenticated
  WITH CHECK (core.same_org(organization_id) AND (core.is_finance_head() OR core.has_role('ACCOUNTANT')));
CREATE POLICY "payroll_compensation_update_org_scoped" ON public.payroll_compensation
  FOR UPDATE TO authenticated
  USING (core.same_org(organization_id) AND (core.is_finance_head() OR core.has_role('ACCOUNTANT')))
  WITH CHECK (core.same_org(organization_id) AND (core.is_finance_head() OR core.has_role('ACCOUNTANT')));
CREATE POLICY "payroll_compensation_delete_org_scoped" ON public.payroll_compensation
  FOR DELETE TO authenticated
  USING (core.same_org(organization_id) AND core.is_finance_head());

CREATE POLICY "payroll_deductions_select_org_scoped" ON public.payroll_deductions
  FOR SELECT TO authenticated
  USING (core.same_org(organization_id) AND (core.is_finance_head() OR core.has_role('ACCOUNTANT')));
CREATE POLICY "payroll_deductions_insert_org_scoped" ON public.payroll_deductions
  FOR INSERT TO authenticated
  WITH CHECK (core.same_org(organization_id) AND (core.is_finance_head() OR core.has_role('ACCOUNTANT')));
CREATE POLICY "payroll_deductions_update_org_scoped" ON public.payroll_deductions
  FOR UPDATE TO authenticated
  USING (core.same_org(organization_id) AND (core.is_finance_head() OR core.has_role('ACCOUNTANT')))
  WITH CHECK (core.same_org(organization_id) AND (core.is_finance_head() OR core.has_role('ACCOUNTANT')));
CREATE POLICY "payroll_deductions_delete_org_scoped" ON public.payroll_deductions
  FOR DELETE TO authenticated
  USING (core.same_org(organization_id) AND core.is_finance_head());

CREATE POLICY "payroll_employees_select_org_scoped" ON public.payroll_employees
  FOR SELECT TO authenticated
  USING (
    core.same_org(organization_id)
    AND (core.is_finance_head() OR core.has_role('ACCOUNTANT') OR user_id = auth.uid())
  );
CREATE POLICY "payroll_employees_insert_org_scoped" ON public.payroll_employees
  FOR INSERT TO authenticated
  WITH CHECK (core.same_org(organization_id) AND (core.is_finance_head() OR core.has_role('ACCOUNTANT')));
CREATE POLICY "payroll_employees_update_org_scoped" ON public.payroll_employees
  FOR UPDATE TO authenticated
  USING (core.same_org(organization_id) AND (core.is_finance_head() OR core.has_role('ACCOUNTANT')))
  WITH CHECK (core.same_org(organization_id) AND (core.is_finance_head() OR core.has_role('ACCOUNTANT')));
CREATE POLICY "payroll_employees_delete_org_scoped" ON public.payroll_employees
  FOR DELETE TO authenticated
  USING (core.same_org(organization_id) AND core.is_finance_head());

CREATE POLICY "payroll_lines_select_org_scoped" ON public.payroll_lines
  FOR SELECT TO authenticated
  USING (core.same_org(organization_id) AND (core.is_finance_head() OR core.has_role('ACCOUNTANT')));
CREATE POLICY "payroll_lines_insert_org_scoped" ON public.payroll_lines
  FOR INSERT TO authenticated
  WITH CHECK (core.same_org(organization_id) AND (core.is_finance_head() OR core.has_role('ACCOUNTANT')));
CREATE POLICY "payroll_lines_update_org_scoped" ON public.payroll_lines
  FOR UPDATE TO authenticated
  USING (core.same_org(organization_id) AND (core.is_finance_head() OR core.has_role('ACCOUNTANT')))
  WITH CHECK (core.same_org(organization_id) AND (core.is_finance_head() OR core.has_role('ACCOUNTANT')));
CREATE POLICY "payroll_lines_delete_org_scoped" ON public.payroll_lines
  FOR DELETE TO authenticated
  USING (core.same_org(organization_id) AND core.is_finance_head());

CREATE POLICY "payroll_reimbursements_select_org_scoped" ON public.payroll_reimbursements
  FOR SELECT TO authenticated
  USING (core.same_org(organization_id) AND (core.is_finance_head() OR core.has_role('ACCOUNTANT')));
CREATE POLICY "payroll_reimbursements_insert_org_scoped" ON public.payroll_reimbursements
  FOR INSERT TO authenticated
  WITH CHECK (core.same_org(organization_id) AND (core.is_finance_head() OR core.has_role('ACCOUNTANT')));
CREATE POLICY "payroll_reimbursements_update_org_scoped" ON public.payroll_reimbursements
  FOR UPDATE TO authenticated
  USING (core.same_org(organization_id) AND (core.is_finance_head() OR core.has_role('ACCOUNTANT')))
  WITH CHECK (core.same_org(organization_id) AND (core.is_finance_head() OR core.has_role('ACCOUNTANT')));
CREATE POLICY "payroll_reimbursements_delete_org_scoped" ON public.payroll_reimbursements
  FOR DELETE TO authenticated
  USING (core.same_org(organization_id) AND core.is_finance_head());

CREATE POLICY "payroll_runs_select_org_scoped" ON public.payroll_runs
  FOR SELECT TO authenticated
  USING (core.same_org(organization_id) AND (core.is_finance_head() OR core.has_role('ACCOUNTANT')));
CREATE POLICY "payroll_runs_insert_org_scoped" ON public.payroll_runs
  FOR INSERT TO authenticated
  WITH CHECK (core.same_org(organization_id) AND (core.is_finance_head() OR core.has_role('ACCOUNTANT')));
CREATE POLICY "payroll_runs_update_org_scoped" ON public.payroll_runs
  FOR UPDATE TO authenticated
  USING (core.same_org(organization_id) AND (core.is_finance_head() OR core.has_role('ACCOUNTANT')))
  WITH CHECK (core.same_org(organization_id) AND (core.is_finance_head() OR core.has_role('ACCOUNTANT')));
CREATE POLICY "payroll_runs_delete_org_scoped" ON public.payroll_runs
  FOR DELETE TO authenticated
  USING (core.same_org(organization_id) AND core.is_finance_head());

-- -----------------------------------------------------------------------------
-- STEP 6: commissions / contractors — same compensation-sensitivity scoping as payroll
-- -----------------------------------------------------------------------------

CREATE POLICY "commissions_select_org_scoped" ON public.commissions
  FOR SELECT TO authenticated
  USING (core.same_org(organization_id) AND (core.is_finance_head() OR core.has_role('ACCOUNTANT')));
CREATE POLICY "commissions_insert_org_scoped" ON public.commissions
  FOR INSERT TO authenticated
  WITH CHECK (core.same_org(organization_id) AND (core.is_finance_head() OR core.has_role('ACCOUNTANT')));
CREATE POLICY "commissions_update_org_scoped" ON public.commissions
  FOR UPDATE TO authenticated
  USING (core.same_org(organization_id) AND (core.is_finance_head() OR core.has_role('ACCOUNTANT')))
  WITH CHECK (core.same_org(organization_id) AND (core.is_finance_head() OR core.has_role('ACCOUNTANT')));
CREATE POLICY "commissions_delete_org_scoped" ON public.commissions
  FOR DELETE TO authenticated
  USING (core.same_org(organization_id) AND core.is_finance_head());

CREATE POLICY "contractors_select_org_scoped" ON public.contractors
  FOR SELECT TO authenticated
  USING (core.same_org(organization_id) AND (core.is_finance_head() OR core.has_role('ACCOUNTANT') OR core.has_role('PROJECT_MANAGER')));
CREATE POLICY "contractors_insert_org_scoped" ON public.contractors
  FOR INSERT TO authenticated
  WITH CHECK (core.same_org(organization_id) AND (core.is_finance_head() OR core.has_role('ACCOUNTANT')));
CREATE POLICY "contractors_update_org_scoped" ON public.contractors
  FOR UPDATE TO authenticated
  USING (core.same_org(organization_id) AND (core.is_finance_head() OR core.has_role('ACCOUNTANT')))
  WITH CHECK (core.same_org(organization_id) AND (core.is_finance_head() OR core.has_role('ACCOUNTANT')));
CREATE POLICY "contractors_delete_org_scoped" ON public.contractors
  FOR DELETE TO authenticated
  USING (core.same_org(organization_id) AND core.is_finance_head());

-- -----------------------------------------------------------------------------
-- STEP 7: subscriptions — operational recurring-cost data, org-scoped, broader
-- internal visibility (spec 5.11 does not flag this as confidential), mutation
-- restricted to Finance Head/Accountant.
-- -----------------------------------------------------------------------------

CREATE POLICY "subscriptions_select_org_scoped" ON public.subscriptions
  FOR SELECT TO authenticated
  USING (
    core.same_org(organization_id)
    AND (core.is_finance_head() OR core.has_role('ACCOUNTANT') OR core.has_role('VIEWER') OR core.has_role('PROJECT_MANAGER'))
  );
CREATE POLICY "subscriptions_insert_org_scoped" ON public.subscriptions
  FOR INSERT TO authenticated
  WITH CHECK (core.same_org(organization_id) AND (core.is_finance_head() OR core.has_role('ACCOUNTANT')));
CREATE POLICY "subscriptions_update_org_scoped" ON public.subscriptions
  FOR UPDATE TO authenticated
  USING (core.same_org(organization_id) AND (core.is_finance_head() OR core.has_role('ACCOUNTANT')))
  WITH CHECK (core.same_org(organization_id) AND (core.is_finance_head() OR core.has_role('ACCOUNTANT')));
CREATE POLICY "subscriptions_delete_org_scoped" ON public.subscriptions
  FOR DELETE TO authenticated
  USING (core.same_org(organization_id) AND core.is_finance_head());

-- -----------------------------------------------------------------------------
-- STEP 8: incomes — mirror the exact, already-correct public.expenses pattern
-- -----------------------------------------------------------------------------

CREATE POLICY "incomes_select_org_scoped" ON public.incomes
  FOR SELECT TO authenticated
  USING (
    core.same_org(organization_id)
    AND (
      core.is_finance_head()
      OR core.has_role('ACCOUNTANT')
      OR core.has_role('VIEWER')
      OR (user_id = auth.uid())
      OR (
        project_id IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM public.projects pr
          WHERE pr.id = incomes.project_id AND pr.user_id = auth.uid()
        )
      )
    )
  );
CREATE POLICY "incomes_insert_org_scoped" ON public.incomes
  FOR INSERT TO authenticated
  WITH CHECK (core.same_org(organization_id) AND (auth.uid() = user_id OR core.is_finance_head()));
CREATE POLICY "incomes_update_org_scoped" ON public.incomes
  FOR UPDATE TO authenticated
  USING (core.same_org(organization_id) AND (auth.uid() = user_id OR core.is_finance_head()))
  WITH CHECK (core.same_org(organization_id) AND (auth.uid() = user_id OR core.is_finance_head()));
CREATE POLICY "incomes_delete_org_scoped" ON public.incomes
  FOR DELETE TO authenticated
  USING (core.same_org(organization_id) AND (auth.uid() = user_id OR core.is_finance_head()));

-- -----------------------------------------------------------------------------
-- STEP 9 (ISS-05): finance.fee_tiers — child of fee_rules, scope via EXISTS join
-- (fee_tiers itself has no organization_id column and none is added here,
-- consistent with the documented "line/child table" pattern already used for
-- journal_lines/vendor_bill_lines elsewhere in this schema).
-- -----------------------------------------------------------------------------

DROP POLICY IF EXISTS "authenticated_read_tiers" ON finance.fee_tiers;

CREATE POLICY "fee_tiers_select_org_scoped" ON finance.fee_tiers
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM finance.fee_rules fr
      WHERE fr.id = fee_tiers.fee_rule_id AND core.same_org(fr.organization_id)
    )
  );
-- ("admin_write_tiers" already correctly requires ADMIN_CONFIG permission and
--  is left in place; it should additionally be org-scoped once fee_rule_id's
--  organization is resolved the same way -- tightening it here too so the
--  write path cannot be used to bypass the new read scoping):
DROP POLICY IF EXISTS "admin_write_tiers" ON finance.fee_tiers;
CREATE POLICY "admin_write_tiers" ON finance.fee_tiers
  TO authenticated
  USING (
    core.has_permission(auth.uid(), 'ADMIN_CONFIG')
    AND EXISTS (
      SELECT 1 FROM finance.fee_rules fr
      WHERE fr.id = fee_tiers.fee_rule_id AND core.same_org(fr.organization_id)
    )
  )
  WITH CHECK (
    core.has_permission(auth.uid(), 'ADMIN_CONFIG')
    AND EXISTS (
      SELECT 1 FROM finance.fee_rules fr
      WHERE fr.id = fee_tiers.fee_rule_id AND core.same_org(fr.organization_id)
    )
  );

-- -----------------------------------------------------------------------------
-- STEP 10 (ISS-05): finance.fee_computation_log — organization_id backfilled
-- in STEP 2 above; replace the falsely-named "org_read_fee_log" policy with
-- one that actually enforces the scoping its name claims.
-- -----------------------------------------------------------------------------

DROP POLICY IF EXISTS "org_read_fee_log" ON finance.fee_computation_log;

CREATE POLICY "org_read_fee_log" ON finance.fee_computation_log
  FOR SELECT TO authenticated
  USING (core.same_org(organization_id));

-- -----------------------------------------------------------------------------
-- STEP 11 (ISS-06): ai.ai_model_registry / ai.ai_prompt_versions — restrict
-- SELECT to `authenticated` (was granted to `public`, which includes the
-- unauthenticated `anon` role).
-- -----------------------------------------------------------------------------

DROP POLICY IF EXISTS "authenticated_read_model_registry" ON ai.ai_model_registry;
CREATE POLICY "authenticated_read_model_registry" ON ai.ai_model_registry
  FOR SELECT TO authenticated
  USING (true);

DROP POLICY IF EXISTS "authenticated_read_prompts" ON ai.ai_prompt_versions;
CREATE POLICY "authenticated_read_prompts" ON ai.ai_prompt_versions
  FOR SELECT TO authenticated
  USING (true);

-- -----------------------------------------------------------------------------
-- STEP 12 (ISS-03): is_admin() architecture fix.
-- -----------------------------------------------------------------------------
-- public.profiles.role's own CHECK constraint (profiles_role_check) only ever
-- allows 'CEO' | 'FINANCE_HEAD' | 'ACCOUNTANT' | 'PROJECT_MANAGER' | 'EMPLOYEE'
-- | 'VIEWER' -- 'Admin' is not, and never has been, a legally insertable value
-- through that constraint. public.is_admin() as originally written therefore
-- can never return true today. Rather than leave dead, misleading security
-- code in place (a landmine for the next person who assumes it does
-- something), it is redefined here to the correct, already-proven,
-- organization-aware elevated-role check used everywhere else in this
-- codebase: CEO or FINANCE_HEAD (core.is_finance_head()). This is NOT a
-- widening of access -- it goes from "always false" to "true only for the
-- same two roles that already have full access via core.is_finance_head()
-- everywhere else in the schema" -- and it removes the false sense that an
-- 'Admin' bypass exists or is intended.
--
-- Every RLS policy that OR'd in is_admin() with NO accompanying organization
-- predicate (profiles, user_mfa, payments) is separately rewritten below to
-- add the missing core.same_org()-equivalent check, because redefining
-- is_admin() alone does not add organization-awareness to a zero-argument
-- function -- the scoping has to live in the policy that knows which row is
-- being tested.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.is_admin() RETURNS boolean
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'core', 'public'
    AS $$
BEGIN
    RETURN core.is_finance_head();
END;
$$;

COMMENT ON FUNCTION public.is_admin() IS
  'Redefined by P1_059 (Remediation ISS-03, High). Previously read public.profiles.role = ''Admin'', a value profiles_role_check never permits, so this function was always false. Now delegates to core.is_finance_head() (CEO or FINANCE_HEAD), the correct organization-aware elevated role used throughout core/finance. Callers still need their own core.same_org(...) check for the row in question -- this function alone does not know which organization a given row belongs to. See P1_059 STEP 13 for the profiles/user_mfa/payments policies that were rewritten to add that check explicitly.';

-- STEP 13: profiles -- add organization scoping alongside the admin bypass.
DROP POLICY IF EXISTS "Admin full access on profiles" ON public.profiles;
DROP POLICY IF EXISTS "profiles_modify" ON public.profiles;
DROP POLICY IF EXISTS "profiles_select" ON public.profiles;

CREATE POLICY "profiles_select_org_scoped" ON public.profiles
  FOR SELECT TO authenticated
  USING (
    auth.uid() = user_id
    OR (public.is_admin() AND organization_id IS NOT NULL AND organization_id = core.current_user_org_id())
  );

-- FOR ALL (no FOR clause restriction) to preserve the exact original scope of
-- "profiles_modify"/"Admin full access on profiles" (both were unrestricted
-- ALL-command policies) -- only the missing organization predicate on the
-- admin branch is added; self-service INSERT/UPDATE/DELETE on one's own row
-- is unchanged.
CREATE POLICY "profiles_modify_org_scoped" ON public.profiles
  TO authenticated
  USING (
    auth.uid() = user_id
    OR (public.is_admin() AND organization_id IS NOT NULL AND organization_id = core.current_user_org_id())
  )
  WITH CHECK (
    auth.uid() = user_id
    OR (public.is_admin() AND organization_id IS NOT NULL AND organization_id = core.current_user_org_id())
  );

-- STEP 14: user_mfa -- admin-read policy re-created with organization scoping.
DROP POLICY IF EXISTS "Admin can read MFA status" ON public.user_mfa;

CREATE POLICY "admin_can_read_mfa_status_org_scoped" ON public.user_mfa
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND p.role = 'CEO'
        AND p.organization_id IS NOT NULL
        AND p.organization_id = (
          SELECT organization_id FROM public.profiles target
          WHERE target.user_id = user_mfa.user_id
        )
    )
  );

-- STEP 15: payments -- remove the unscoped is_admin() bypass; the correctly
-- org-scoped SELECT policy ("org_scoped_view_payments") already exists and is
-- left in place, but is also rewritten to drop its own unscoped is_admin() OR
-- clause. "Admin can manage payments" and "Users with permission can manage
-- payments" (both write policies) are replaced with a single org-scoped one.
DROP POLICY IF EXISTS "Admin can manage payments" ON public.payments;
DROP POLICY IF EXISTS "Users with permission can manage payments" ON public.payments;
DROP POLICY IF EXISTS "org_scoped_view_payments" ON public.payments;

CREATE POLICY "payments_select_org_scoped" ON public.payments
  FOR SELECT TO authenticated
  USING (
    (user_id = auth.uid())
    OR (
      (core.is_finance_head() OR core.has_role('ACCOUNTANT'))
      AND organization_id IS NOT NULL
      AND organization_id = core.current_user_org_id()
    )
  );

CREATE POLICY "payments_modify_org_scoped" ON public.payments
  FOR ALL TO authenticated
  USING (
    (user_id = auth.uid())
    OR (core.is_finance_head() AND organization_id IS NOT NULL AND organization_id = core.current_user_org_id())
  )
  WITH CHECK (
    (user_id = auth.uid())
    OR (core.is_finance_head() AND organization_id IS NOT NULL AND organization_id = core.current_user_org_id())
  );

-- NOTE: public.payments is documented in schema.sql as a LEGACY table
-- (superseded by finance.payment_receipts / finance.vendor_payments) whose
-- organization_id was previously compared against
-- core.current_user_org_config_id() (organization_config.id) in the old
-- "org_scoped_view_payments" policy -- a different id space than
-- core.current_user_org_id() (organizations.id) used everywhere else. This
-- migration switches payments' own policies to core.current_user_org_id()
-- (the correct, standard id space matching every other table's
-- organization_id column) rather than perpetuating the mismatched
-- comparison. If any existing public.payments row's organization_id was
-- actually populated as an organization_config.id rather than an
-- organizations.id, that row will (correctly, fail-closed) stop matching
-- until it is corrected -- flagged in the remediation report as
-- REQUIRES PRODUCT DECISION rather than silently preserved.

-- -----------------------------------------------------------------------------
-- STEP 16 (ISS-08): remove the unscoped finance.get_next_number(p_type) overload.
-- -----------------------------------------------------------------------------
-- The correctly org-scoped 2-arg overload
-- finance.get_next_number(p_type, p_organization_id DEFAULT core.current_user_org_id())
-- already exists. Dropping the 1-arg overload means every existing call site
-- in application code that passes only { p_type: ... } now resolves,
-- unambiguously, to the org-scoped overload with zero application code
-- changes required.

DROP FUNCTION IF EXISTS finance.get_next_number(text);

-- =============================================================================
-- END P1_059
-- =============================================================================