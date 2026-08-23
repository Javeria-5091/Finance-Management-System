-- =====================================================================
-- OSYSTIC Finance — remaining DATABASE-level fixes (verified against
-- your full source + migration history in Finance-Management-System-
-- source.zip). Run this whole file once in the Supabase SQL editor.
-- Safe to re-run (idempotent).
--
-- CORRECTION FROM THE FIRST VERSION OF THIS FILE:
-- After checking your supabase/migrations/ folder, two things I
-- "fixed" earlier were not actually bugs, so they've been REMOVED
-- from this version:
--   - finance.journal_lines RLS: already safe. Its policies gate
--     access through journal_entries via EXISTS, and journal_entries
--     already has same_org() on it — Postgres RLS applies the
--     referenced table's own policy inside that EXISTS automatically.
--     Your own P1_040_rls_priority_table.sql migration explains this
--     exact design on purpose.
--   - finance.asset_verification_lines RLS: same reasoning —
--     finance.asset_verifications already has same_org() on it, so
--     the EXISTS check already inherited it.
--   - A new base_debit/base_credit enforcement trigger: not needed —
--     your own P1_064_database_audit_fixes.sql already added
--     finance.enforce_base_amounts_on_post() for this. Only the
--     one-time backfill for old rows was still worth doing (kept
--     below as Section 6).
-- =====================================================================


-- #####################################################################
-- SECTION 1: DELETE policies that checked role only, not organization
-- (core.is_ceo_or_admin() / core.is_finance_head() only check WHICH
-- ROLE the caller has, not which org that role assignment belongs to
-- — verified by reading their definitions in schema.sql. So a CEO or
-- Finance Head in Org A could delete another org's row here.)
-- #####################################################################

DROP POLICY IF EXISTS "bt_delete_restricted" ON "finance"."bank_transfers";
CREATE POLICY "bt_delete_restricted" ON "finance"."bank_transfers" FOR DELETE USING (
  (core.is_ceo_or_admin() OR core.is_finance_head())
  AND core.same_org(organization_id)
);

DROP POLICY IF EXISTS "dimensions_delete" ON "finance"."dimensions";
CREATE POLICY "dimensions_delete" ON "finance"."dimensions" FOR DELETE USING (
  (core.is_ceo_or_admin() OR core.is_finance_head())
  AND core.same_org(organization_id)
);

DROP POLICY IF EXISTS "ta_delete_restricted" ON "finance"."tax_adjustments";
CREATE POLICY "ta_delete_restricted" ON "finance"."tax_adjustments" FOR DELETE USING (
  (core.is_ceo_or_admin() OR core.is_finance_head())
  AND core.same_org(organization_id)
);

DROP POLICY IF EXISTS "tsl_delete_restricted" ON "finance"."tax_slabs";
CREATE POLICY "tsl_delete_restricted" ON "finance"."tax_slabs" FOR DELETE USING (
  (core.is_ceo_or_admin() OR core.is_finance_head())
  AND core.same_org(organization_id)
);


-- #####################################################################
-- SECTION 2: finance.fee_rules / finance.platforms admin write policies
-- checked ADMIN_CONFIG permission only, not which org the row belongs
-- to (their own SELECT policies were already org-scoped, but
-- INSERT/UPDATE/DELETE were not).
-- #####################################################################

DROP POLICY IF EXISTS "admin_write_fee_rules" ON "finance"."fee_rules";
CREATE POLICY "admin_write_fee_rules" ON "finance"."fee_rules" USING (
  core.has_permission(auth.uid(), 'ADMIN_CONFIG') AND core.same_org(organization_id)
) WITH CHECK (
  core.has_permission(auth.uid(), 'ADMIN_CONFIG') AND core.same_org(organization_id)
);

DROP POLICY IF EXISTS "admin_write_platforms" ON "finance"."platforms";
CREATE POLICY "admin_write_platforms" ON "finance"."platforms" USING (
  core.has_permission(auth.uid(), 'ADMIN_CONFIG') AND core.same_org(organization_id)
) WITH CHECK (
  core.has_permission(auth.uid(), 'ADMIN_CONFIG') AND core.same_org(organization_id)
);


-- #####################################################################
-- SECTION 3: core.approval_requests / approval_steps / approval_actions
-- — a CEO/Finance Head could read or act on approval-workflow rows
-- belonging to another organization, because the is_ceo_or_admin() /
-- is_finance_head() branches in these policies were plain booleans,
-- not gated behind any table reference that would have inherited org
-- scoping the way journal_lines does.
-- #####################################################################

DROP POLICY IF EXISTS "approval_requests_select" ON "core"."approval_requests";
CREATE POLICY "approval_requests_select" ON "core"."approval_requests" FOR SELECT USING (
  core.same_org(organization_id) AND (
    requested_by = auth.uid()
    OR core.is_ceo_or_admin()
    OR core.is_finance_head()
    OR EXISTS (
      SELECT 1 FROM core.approval_steps s
      WHERE s.approval_request_id = approval_requests.id
        AND s.assigned_user_id = auth.uid()
    )
  )
);

DROP POLICY IF EXISTS "approval_requests_insert" ON "core"."approval_requests";
CREATE POLICY "approval_requests_insert" ON "core"."approval_requests" FOR INSERT WITH CHECK (
  core.same_org(organization_id) AND requested_by = auth.uid()
);

DROP POLICY IF EXISTS "approval_requests_update" ON "core"."approval_requests";
CREATE POLICY "approval_requests_update" ON "core"."approval_requests" FOR UPDATE USING (
  core.same_org(organization_id) AND (
    core.is_ceo_or_admin()
    OR core.is_finance_head()
    OR EXISTS (
      SELECT 1 FROM core.approval_steps s
      WHERE s.approval_request_id = approval_requests.id
        AND s.assigned_user_id = auth.uid()
    )
  )
);

DROP POLICY IF EXISTS "approval_steps_select" ON "core"."approval_steps";
CREATE POLICY "approval_steps_select" ON "core"."approval_steps" FOR SELECT USING (
  EXISTS (
    SELECT 1 FROM core.approval_requests r
    WHERE r.id = approval_steps.approval_request_id
      AND core.same_org(r.organization_id)
      AND (
        r.requested_by = auth.uid()
        OR approval_steps.assigned_user_id = auth.uid()
        OR core.is_ceo_or_admin()
        OR core.is_finance_head()
      )
  )
);

DROP POLICY IF EXISTS "approval_steps_insert" ON "core"."approval_steps";
CREATE POLICY "approval_steps_insert" ON "core"."approval_steps" FOR INSERT WITH CHECK (
  EXISTS (
    SELECT 1 FROM core.approval_requests r
    WHERE r.id = approval_steps.approval_request_id
      AND core.same_org(r.organization_id)
  )
);

DROP POLICY IF EXISTS "approval_steps_update" ON "core"."approval_steps";
CREATE POLICY "approval_steps_update" ON "core"."approval_steps" FOR UPDATE USING (
  EXISTS (
    SELECT 1 FROM core.approval_requests r
    WHERE r.id = approval_steps.approval_request_id
      AND core.same_org(r.organization_id)
      AND (assigned_user_id = auth.uid() OR core.is_ceo_or_admin() OR core.is_finance_head())
  )
);

DROP POLICY IF EXISTS "approval_actions_select" ON "core"."approval_actions";
CREATE POLICY "approval_actions_select" ON "core"."approval_actions" FOR SELECT USING (
  EXISTS (
    SELECT 1 FROM core.approval_steps s
    JOIN core.approval_requests r ON r.id = s.approval_request_id
    WHERE s.id = approval_actions.approval_step_id
      AND core.same_org(r.organization_id)
      AND (
        actor_user_id = auth.uid()
        OR r.requested_by = auth.uid()
        OR core.is_ceo_or_admin()
        OR core.is_finance_head()
      )
  )
);

DROP POLICY IF EXISTS "approval_actions_insert" ON "core"."approval_actions";
CREATE POLICY "approval_actions_insert" ON "core"."approval_actions" FOR INSERT WITH CHECK (
  actor_user_id = auth.uid()
  AND EXISTS (
    SELECT 1 FROM core.approval_steps s
    JOIN core.approval_requests r ON r.id = s.approval_request_id
    WHERE s.id = approval_actions.approval_step_id
      AND core.same_org(r.organization_id)
  )
);


-- #####################################################################
-- SECTION 4: core.integration_events / integration_failures — visible
-- to any CEO/Finance Head across every organization, not just their
-- own; integration_failures had no org check anywhere in its policy.
-- #####################################################################

DROP POLICY IF EXISTS "integration_events_select" ON "core"."integration_events";
CREATE POLICY "integration_events_select" ON "core"."integration_events" FOR SELECT USING (
  (core.is_ceo_or_admin() OR core.is_finance_head())
  AND ((organization_id IS NULL) OR core.same_org(organization_id))
);

DROP POLICY IF EXISTS "integration_failures_read_finance" ON "core"."integration_failures";
CREATE POLICY "integration_failures_read_finance" ON "core"."integration_failures" FOR SELECT TO authenticated USING (
  core.is_finance_head()
  AND EXISTS (
    SELECT 1 FROM core.integration_events e
    WHERE e.id = integration_failures.integration_event_id
      AND ((e.organization_id IS NULL) OR core.same_org(e.organization_id))
  )
);


-- #####################################################################
-- SECTION 5: core.organization_config / organization_modules — a CEO
-- could insert or update ANY organization's config (base currency,
-- fiscal year months, rounding method, enabled modules, etc.), not
-- just their own, because these write policies never checked org_id.
-- #####################################################################

DROP POLICY IF EXISTS "org_config_insert" ON "core"."organization_config";
CREATE POLICY "org_config_insert" ON "core"."organization_config" FOR INSERT WITH CHECK (
  core.is_ceo_or_admin() AND ((organization_id IS NULL) OR core.same_org(organization_id))
);

DROP POLICY IF EXISTS "org_config_update" ON "core"."organization_config";
CREATE POLICY "org_config_update" ON "core"."organization_config" FOR UPDATE USING (
  core.is_ceo_or_admin() AND core.same_org(organization_id)
) WITH CHECK (
  core.is_ceo_or_admin() AND core.same_org(organization_id)
);

DROP POLICY IF EXISTS "org_modules_manage" ON "core"."organization_modules";
CREATE POLICY "org_modules_manage" ON "core"."organization_modules" USING (
  core.has_permission(auth.uid(), 'ADMIN_CONFIG') AND core.same_org(organization_id)
) WITH CHECK (
  core.has_permission(auth.uid(), 'ADMIN_CONFIG') AND core.same_org(organization_id)
);


-- #####################################################################
-- SECTION 6: one-time backfill only for OLD journal_lines rows already
-- POSTED with a NULL base_debit/base_credit — from before your
-- finance.enforce_base_amounts_on_post trigger (P1_064) existed. That
-- trigger already blocks any NEW posting from having a NULL base
-- amount, so nothing else needs adding here, just this cleanup.
-- #####################################################################

UPDATE finance.journal_lines
SET base_debit = debit_amount,
    base_credit = credit_amount
WHERE currency = 'PKR'
  AND (base_debit IS NULL OR base_credit IS NULL);
-- Rows in a non-PKR currency that are still NULL are left untouched on
-- purpose — they need their real converted PKR amount (the exchange
-- rate in effect on their transaction_date), not a copy of the
-- transaction-currency amount. Review those manually:
--   SELECT * FROM finance.journal_lines
--   WHERE currency <> 'PKR' AND (base_debit IS NULL OR base_credit IS NULL);


-- #####################################################################
-- SECTION 7: public.invoices.amount used numeric(12,2) while every
-- other money column in the same table (and the rest of finance) uses
-- numeric(18,2) — widened for consistency. This cannot lose data:
-- (18,2) is a strict superset of (12,2). No view depends on the old
-- precision (checked).
-- #####################################################################

ALTER TABLE public.invoices
  ALTER COLUMN amount TYPE numeric(18,2);


-- #####################################################################
-- SECTION 8: public.payments (legacy table) — organization_id FK was
-- ON DELETE SET NULL, meaning a deleted organization would silently
-- orphan posted payment rows with no org attached. Changed to RESTRICT
-- so an org cannot be deleted while it still has payment history.
-- #####################################################################

ALTER TABLE public.payments
  DROP CONSTRAINT IF EXISTS payments_organization_id_fkey;

ALTER TABLE public.payments
  ADD CONSTRAINT payments_organization_id_fkey
  FOREIGN KEY (organization_id) REFERENCES core.organizations(id) ON DELETE RESTRICT;


-- #####################################################################
-- SECTION 9: organization_id was still nullable on ~35 finance/core/
-- public tables, so a buggy insert with no org would silently succeed
-- and become invisible/unownable data instead of failing loudly. Added
-- as NOT VALID so existing rows are untouched and nothing breaks
-- today, but every new INSERT/UPDATE from now on is required to set
-- org_id. (Checked: none of these table names already had this
-- constraint from an earlier migration, no name collisions.)
-- Run a VALIDATE CONSTRAINT pass later once any existing NULLs, if
-- there are any, have been backfilled or cleaned up.
-- #####################################################################

DO $$
DECLARE
  t text;
  tables text[] := ARRAY[
    'finance.accounting_periods',
    'finance.asset_categories',
    'finance.asset_verifications',
    'finance.attachments',
    'finance.bank_statements',
    'finance.bank_transfers',
    'finance.budget_lines',
    'finance.budget_revisions',
    'finance.capital_transactions',
    'finance.credit_notes',
    'finance.fee_computation_log',
    'finance.fee_rules',
    'finance.fiscal_years',
    'finance.fixed_assets',
    'finance.owners',
    'finance.ownership_history',
    'finance.payment_receipts',
    'finance.platforms',
    'finance.profit_distributions',
    'finance.reserve_policies',
    'finance.tax_adjustments',
    'finance.tax_reconciliations',
    'finance.tax_rule_sets',
    'finance.tax_slabs',
    'finance.taxpayer_profile',
    'finance.vendor_payments',
    'finance.vendors',
    'core.approval_limits',
    'core.approval_requests',
    'core.delegations',
    'core.integration_events',
    'public.commissions',
    'public.contractors',
    'public.incomes',
    'public.payroll_advances',
    'public.payroll_commissions',
    'public.payroll_compensation',
    'public.payroll_deductions',
    'public.payroll_employees',
    'public.payroll_lines',
    'public.payroll_reimbursements',
    'public.payroll_runs',
    'public.subscriptions'
  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    BEGIN
      EXECUTE format(
        'ALTER TABLE %s ADD CONSTRAINT %s_org_required_going_forward CHECK (organization_id IS NOT NULL) NOT VALID',
        t, replace(split_part(t, '.', 2), '.', '_')
      );
    EXCEPTION
      WHEN duplicate_object THEN
        -- constraint already added in an earlier run, skip
        NULL;
      WHEN undefined_column THEN
        -- table doesn't have this column in this environment, skip
        NULL;
      WHEN undefined_table THEN
        -- table doesn't exist in this environment, skip
        NULL;
    END;
  END LOOP;
END $$;


-- #####################################################################
-- SECTION 10: system-wide roles (AUDITOR, Admin, HOD, TECHNICAL_ADMIN)
-- were added to profiles_role_check / RLS policies but were never
-- seeded as actual rows in core.roles, so those policy branches and
-- any UI/permission code referencing them had nothing to attach to.
-- organization_id is left NULL on purpose — that is what makes them
-- global/system roles instead of per-org ones (see the
-- roles_name_system_unique index already in your schema).
-- #####################################################################

INSERT INTO core.roles (name, display_name, is_system, level, organization_id)
SELECT v.name, v.display_name, true, v.level, NULL
FROM (VALUES
  ('AUDITOR',         'Auditor',            40),
  ('Admin',           'Administrator',      90),
  ('HOD',             'Head of Department', 50),
  ('TECHNICAL_ADMIN', 'Technical Admin',    95)
) AS v(name, display_name, level)
WHERE NOT EXISTS (
  SELECT 1 FROM core.roles r WHERE r.name = v.name AND r.organization_id IS NULL
);


-- =====================================================================
-- STILL NOT fixed here — needs a decision from you, not a blind fix:
--
-- 1) finance.tax_computations / tax_credits_and_withholding /
--    tax_payments_and_refunds / tax_returns — their organization_id FK
--    points to core.organization_config(id), not core.organizations(id)
--    directly. Checked P1_041_fix_organization_config_linkage.sql:
--    organization_config.organization_id already has its own FK +
--    UNIQUE constraint back to core.organizations, so this is a
--    1-to-1 indirection, not a broken link — and the RLS policies on
--    these 4 tables consistently use core.current_user_org_config_id()
--    to match it. Not a live security hole. Leaving it alone.
--
-- 2) DB-level status-transition constraints (e.g. preventing
--    POSTED -> DRAFT, or an invoice going straight from DRAFT to PAID)
--    still don't exist as table constraints for most workflow tables.
--    This needs the actual list of allowed transitions per table
--    confirmed with you before I encode it as triggers.
-- =====================================================================