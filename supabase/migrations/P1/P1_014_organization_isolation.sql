not executed contains error 


-- =============================================================================
-- Migration: 029_organization_isolation.sql
-- Purpose  : CRITICAL-3 remediation (spec Section 3, 10.1, 17, Appendix D).
--            Adds `organization_id` to every organization-owned "header" /
--            master-data table across core, finance, and public schemas that
--            was missing it, with a FK to core.organizations and a backing
--            index, so RLS (migration 030) and the shared-Supabase,
--            multi-org-ready architecture the spec requires can actually be
--            enforced.
--
-- Scope decision (documented, not silent):
--   * Pure line-item / child tables that already carry a FK to a
--     header table in the same migration set (finance.journal_lines ->
--     journal_entries, finance.vendor_bill_lines -> vendor_bills,
--     finance.statement_lines -> bank_statements, finance.fee_tiers ->
--     fee_rules, finance.payment_allocations / vendor_payment_allocations,
--     finance.distribution_lines -> profit_distributions,
--     finance.asset_verification_lines -> asset_verifications,
--     finance.tax_slabs -> tax_rule_sets, finance.credit_notes is NOT a
--     line table (kept as header) are intentionally NOT given their own
--     organization_id column. They inherit organization scope from their
--     parent via FK, and RLS on these child tables (migration 030) joins to
--     the parent to enforce the same scope. This avoids duplicating and
--     risking drift of the tenant column on every child row while still
--     closing the cross-tenant leakage gap end-to-end.
--   * core.permissions, core.roles, ai.ai_model_registry,
--     ai.ai_prompt_versions remain organization-agnostic platform/reference
--     catalogs, consistent with how they are already used elsewhere in
--     schema.sql (role_permissions references them without any org
--     scoping). If OSYSTIC later wants per-organization custom roles, that
--     is a separate, larger design decision outside this remediation's
--     scope and is flagged in the final compliance matrix as
--     REQUIRES VERIFICATION / business decision, not a schema defect.
--   * public.notifications is user-scoped (user_id) rather than
--     organization-scoped; it is left as-is.
--
-- Data safety:
--   This migration auto-backfills organization_id ONLY when it can do so
--   unambiguously:
--     - if core.organizations has zero rows, it creates one default
--       organization using the OSYSTIC seed values named in Appendix D.3
--       (PKR base currency, 1 July fiscal year) and backfills every row to it;
--     - if core.organizations has exactly one row, it backfills every
--       existing row in every affected table to that single organization
--       (safe because a single-organization database has only one possible
--       correct value for every existing row);
--     - if core.organizations already has MORE THAN ONE row, this migration
--       does NOT guess. It adds the columns as NULLABLE, raises a NOTICE
--       naming every affected table, and stops short of NOT NULL/backfill.
--       A follow-up, manually-reviewed data migration must assign the
--       correct organization_id per existing row before a future migration
--       can safely enforce NOT NULL. This branch intentionally leaves
--       existing data untouched rather than risk assigning records to the
--       wrong tenant.
-- =============================================================================

DO $migration$
DECLARE
  v_org_count integer;
  v_default_org_id uuid;
  v_multi_org boolean := false;
  v_tbl record;
  v_tables text[] := ARRAY[
    -- 'schema.table'
    'core.organization_config',
    'finance.accounting_periods',
    'finance.asset_categories',
    'finance.asset_verifications',
    'finance.attachments',
    'finance.bank_statements',
    'finance.bank_transfers',
    'finance.budget_lines',
    'finance.chart_of_accounts',
    'finance.credit_notes',
    'finance.depreciation_schedule',
    'finance.exchange_rates',
    'finance.fee_computation_log',
    'finance.fee_rules',
    'finance.financial_accounts',
    'finance.fiscal_years',
    'finance.fixed_assets',
    'finance.journal_entries',
    'finance.numbering_sequences',
    'finance.owners',
    'finance.ownership_history',
    'finance.payment_receipts',
    'finance.platforms',
    'finance.profit_distributions',
    'finance.reserve_policies',
    'finance.tax_adjustments',
    'finance.tax_reconciliations',
    'finance.tax_rule_sets',
    'finance.taxpayer_profile',
    'finance.vendor_bills',
    'finance.vendor_payments',
    'finance.vendors',
    'public.budgets',
    'public.clients',
    'public.commissions',
    'public.contractors',
    'public.expenses',
    'public.financial_accounts',
    'public.incomes',
    'public.invoices',
    'public.numbering_sequences',
    'public.payments',
    'public.payroll_advances',
    'public.payroll_commissions',
    'public.payroll_compensation',
    'public.payroll_deductions',
    'public.payroll_employees',
    'public.payroll_reimbursements',
    'public.payroll_runs',
    'public.subscriptions',
    'public.tax_returns'
  ];
BEGIN
  SELECT count(*) INTO v_org_count FROM core.organizations;

  IF v_org_count = 0 THEN
    INSERT INTO core.organizations (
      name, legal_name, type, base_currency, timezone, date_format,
      number_format, fiscal_year_start_month, country
    ) VALUES (
      'OSYSTIC', 'OSYSTIC', 'COMPANY', 'PKR', 'Asia/Karachi', 'DD/MM/YYYY',
      'EN', 7, 'Pakistan'
    )
    RETURNING id INTO v_default_org_id;
    RAISE NOTICE 'Migration 029: no organization existed; created default OSYSTIC organization %', v_default_org_id;
  ELSIF v_org_count = 1 THEN
    SELECT id INTO v_default_org_id FROM core.organizations LIMIT 1;
  ELSE
    v_multi_org := true;
    RAISE NOTICE 'Migration 029: % organizations already exist. Skipping auto-backfill/NOT NULL — organization_id will be added as NULLABLE on all target tables. Manual data migration required before enforcing NOT NULL.', v_org_count;
  END IF;

  FOR v_tbl IN SELECT unnest(v_tables[:,1:1]) AS schema_name, unnest(v_tables[:,2:2]) AS table_name
  LOOP
    -- Add column if missing
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = v_tbl.schema_name AND table_name = v_tbl.table_name AND column_name = 'organization_id'
    ) THEN
      EXECUTE format('ALTER TABLE %I.%I ADD COLUMN organization_id uuid', v_tbl.schema_name, v_tbl.table_name);
    END IF;

    -- Backfill only in the unambiguous single/zero-organization case
    IF NOT v_multi_org THEN
      EXECUTE format(
        'UPDATE %I.%I SET organization_id = $1 WHERE organization_id IS NULL',
        v_tbl.schema_name, v_tbl.table_name
      ) USING v_default_org_id;
    END IF;

    -- Add FK if missing
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.table_constraints tc
      WHERE tc.table_schema = v_tbl.schema_name AND tc.table_name = v_tbl.table_name
        AND tc.constraint_type = 'FOREIGN KEY'
        AND tc.constraint_name = v_tbl.table_name || '_organization_id_fkey'
    ) THEN
      EXECUTE format(
        'ALTER TABLE %I.%I ADD CONSTRAINT %I FOREIGN KEY (organization_id) REFERENCES core.organizations(id) ON DELETE RESTRICT',
        v_tbl.schema_name, v_tbl.table_name, v_tbl.table_name || '_organization_id_fkey'
      );
    END IF;

    -- Add supporting index if missing
    IF NOT EXISTS (
      SELECT 1 FROM pg_indexes WHERE schemaname = v_tbl.schema_name AND tablename = v_tbl.table_name
        AND indexname = 'idx_' || v_tbl.table_name || '_org'
    ) THEN
      EXECUTE format(
        'CREATE INDEX %I ON %I.%I (organization_id)',
        'idx_' || v_tbl.table_name || '_org', v_tbl.schema_name, v_tbl.table_name
      );
    END IF;

    -- Enforce NOT NULL only when backfill was safe and complete
    IF NOT v_multi_org THEN
      EXECUTE format('ALTER TABLE %I.%I ALTER COLUMN organization_id SET NOT NULL', v_tbl.schema_name, v_tbl.table_name);
    END IF;
  END LOOP;
END;
$migration$;

-- -----------------------------------------------------------------------------
-- Helper: the caller's current organization, derived from their profile.
-- SECURITY DEFINER + pinned search_path so it is safe to use inside RLS
-- policies without re-triggering RLS recursion on profiles.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION "core"."current_org_id"()
RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, core
AS $$
  SELECT organization_id FROM public.profiles WHERE user_id = auth.uid();
$$;

ALTER FUNCTION "core"."current_org_id"() OWNER TO "postgres";
COMMENT ON FUNCTION "core"."current_org_id"() IS 'Returns the calling user''s organization_id from public.profiles, for use in RLS policies (spec Section 3, 17).';

REVOKE ALL ON FUNCTION "core"."current_org_id"() FROM "anon";
GRANT EXECUTE ON FUNCTION "core"."current_org_id"() TO "authenticated", "service_role";

-- profiles.organization_id must itself be populated for current_org_id() to
-- work; backfill it the same way (single/zero-org case only), consistent
-- with the logic above.
DO $backfill_profiles$
DECLARE
  v_org_count integer;
  v_default_org_id uuid;
BEGIN
  SELECT count(*) INTO v_org_count FROM core.organizations;
  IF v_org_count = 1 THEN
    SELECT id INTO v_default_org_id FROM core.organizations LIMIT 1;
    UPDATE public.profiles SET organization_id = v_default_org_id WHERE organization_id IS NULL;
  END IF;
END;
$backfill_profiles$;