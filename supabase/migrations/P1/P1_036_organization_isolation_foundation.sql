-- =============================================================================
-- Migration 027: Organization-scoping helper functions
-- =============================================================================
-- PURPOSE
--   Foundation for fixing Compliance Audit Finding 2.1 (HIGH): organization_id
--   is not threaded through most of core/finance, so RLS cannot enforce
--   cross-tenant isolation. This migration adds no columns and changes no
--   policies -- it only introduces the two helper functions that migrations
--   028-030 build on, so they can be reviewed/tested in isolation first.
--
-- ISSUES FIXED (partial -- foundation only, see 028/029/030 for the rest)
--   - Spec Section 17 (Multi-Tenancy / Organization Isolation)
--   - Spec Section 18 (RLS/Security Audit) -- "does the condition correctly
--     identify the user's organization?"
--
-- SAFETY
--   Additive only. No existing object is modified or dropped.
-- =============================================================================

CREATE OR REPLACE FUNCTION "core"."current_user_org_id"()
RETURNS "uuid"
LANGUAGE "plpgsql"
STABLE
SECURITY DEFINER
SET "search_path" TO 'pg_catalog', 'core', 'public'
AS $$
DECLARE
  v_org_id uuid;
BEGIN
  SELECT organization_id INTO v_org_id
  FROM public.profiles
  WHERE user_id = auth.uid()
  LIMIT 1;

  RETURN v_org_id;
END;
$$;

ALTER FUNCTION "core"."current_user_org_id"() OWNER TO "postgres";

REVOKE ALL ON FUNCTION "core"."current_user_org_id"() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "core"."current_user_org_id"() TO "authenticated", "service_role";

COMMENT ON FUNCTION "core"."current_user_org_id"() IS
  'Returns the organization_id of the currently authenticated user, sourced from public.profiles.organization_id. Introduced in migration 027 to support organization-scoped RLS (Compliance Audit Finding 2.1). Returns NULL if the caller has no profile row or no organization assigned; policies built on this function must treat NULL as "no access", never as "all access" -- see core.same_org() below, which enforces that fail-closed behavior.';

CREATE OR REPLACE FUNCTION "core"."same_org"("p_organization_id" "uuid")
RETURNS boolean
LANGUAGE "sql"
STABLE
SECURITY DEFINER
SET "search_path" TO 'pg_catalog', 'core', 'public'
AS $$
  SELECT p_organization_id IS NOT NULL
     AND core.current_user_org_id() IS NOT NULL
     AND p_organization_id = core.current_user_org_id();
$$;

ALTER FUNCTION "core"."same_org"("uuid") OWNER TO "postgres";

REVOKE ALL ON FUNCTION "core"."same_org"("uuid") FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "core"."same_org"("uuid") TO "authenticated", "service_role";

COMMENT ON FUNCTION "core"."same_org"("uuid") IS
  'True only when the supplied organization_id matches the caller''s own organization_id AND neither value is NULL. Deliberately fails closed (returns false, not true) when either side is NULL, to avoid accidentally granting access to unscoped rows during the transition period before every table has organization_id populated. Used by the RLS policies added in migration 030.';

  -- =============================================================================
-- Migration 028: Add organization_id columns (nullable) to org-owned tables
-- =============================================================================
-- PURPOSE
--   Adds the missing organization_id column identified in Compliance Audit
--   Finding 2.1 to the tables that hold organization-owned master/transaction
--   data. Columns are added NULLABLE here on purpose -- migration 029
--   backfills them and only then adds NOT NULL + FK + index, so this
--   migration can never fail or block on existing data.
--
-- SCOPE DECISIONS (per "do not blindly add everything")
--   Added here: true organization-owned header/master entities.
--   Deliberately NOT added here (and why):
--     - finance.journal_lines, vendor_bill_lines, vendor_payment_allocations,
--       payment_allocations, distribution_lines, asset_verification_lines,
--       statement_lines, fee_tiers, fee_computation_log, depreciation_schedule,
--       core.approval_steps, core.approval_actions, core.role_permissions,
--       core.user_roles, core.user_permission_overrides, core.employee_links,
--       core.integration_failures
--       -> these are line/child/link tables whose organization is always
--          reachable via an existing FK to a Tier-1 parent (e.g. journal_lines
--          -> journal_entries). Postgres RLS evaluates the referenced table's
--          own policies when a policy does an EXISTS/JOIN against it, so once
--          the parent is org-scoped (migration 030) these are automatically
--          org-scoped too, with no denormalized column and no drift risk.
--     - core.permissions: this is the global, system-wide catalog of atomic
--       (resource, action) permissions (spec 7.2). It is not organization
--       data; core.roles and core.role_permissions carry the org-specific
--       configuration on top of it.
--     - core.organizations, core.idempotency_keys: not organization-owned
--       data (the former *is* the organization table; the latter is a
--       technical cross-cutting dedup guard keyed by its own "scope" column).
--     - core.integration_events, core.budget_policies, core.shared_people,
--       finance.dimensions, finance.opening_balance_imports,
--       finance.tax_computations, finance.tax_credits_and_withholding,
--       finance.tax_payments_and_refunds, finance.tax_returns:
--       already have organization_id (verified against schema.sql before
--       writing this migration) -- listing them here would be a no-op, so
--       they are intentionally excluded to keep this migration honest about
--       what it actually changes.
--
-- SAFETY
--   ADD COLUMN IF NOT EXISTS, nullable, no default that touches existing
--   rows, no lock beyond a brief metadata lock. Fully idempotent/re-runnable.
-- =============================================================================

DO $$
DECLARE
  tables text[][] := ARRAY[
    ARRAY['core','roles'],
    ARRAY['core','organization_config'],
    ARRAY['core','approval_limits'],
    ARRAY['core','approval_requests'],
    ARRAY['core','delegations'],
    ARRAY['finance','chart_of_accounts'],
    ARRAY['finance','accounting_periods'],
    ARRAY['finance','fiscal_years'],
    ARRAY['finance','journal_entries'],
    ARRAY['finance','financial_accounts'],
    ARRAY['finance','vendors'],
    ARRAY['finance','vendor_bills'],
    ARRAY['finance','vendor_payments'],
    ARRAY['finance','credit_notes'],
    ARRAY['finance','payment_receipts'],
    ARRAY['finance','exchange_rates'],
    ARRAY['finance','platforms'],
    ARRAY['finance','fee_rules'],
    ARRAY['finance','owners'],
    ARRAY['finance','ownership_history'],
    ARRAY['finance','reserve_policies'],
    ARRAY['finance','profit_distributions'],
    ARRAY['finance','capital_transactions'],
    ARRAY['finance','taxpayer_profile'],
    ARRAY['finance','tax_rule_sets'],
    ARRAY['finance','tax_slabs'],
    ARRAY['finance','tax_adjustments'],
    ARRAY['finance','tax_reconciliations'],
    ARRAY['finance','asset_categories'],
    ARRAY['finance','fixed_assets'],
    ARRAY['finance','asset_verifications'],
    ARRAY['finance','bank_statements'],
    ARRAY['finance','bank_transfers'],
    ARRAY['finance','budget_lines'],
    ARRAY['finance','budget_revisions'],
    ARRAY['finance','numbering_sequences'],
    ARRAY['finance','attachments']
  ];
  i int;
  v_schema text;
  v_table text;
BEGIN
  FOR i IN 1..array_length(tables, 1) LOOP
    v_schema := tables[i][1];
    v_table  := tables[i][2];

    -- Guard: only proceed if the table actually exists (keeps this migration
    -- safe to run against slightly different environments/branches).
    IF EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = v_schema AND table_name = v_table
    ) THEN
      EXECUTE format(
        'ALTER TABLE %I.%I ADD COLUMN IF NOT EXISTS organization_id uuid;',
        v_schema, v_table
      );
    ELSE
      RAISE NOTICE 'Migration 028: skipped %.% (table not found in this database)', v_schema, v_table;
    END IF;
  END LOOP;
END $$;

COMMENT ON COLUMN "core"."roles"."organization_id" IS
  'Added migration 028 (Compliance Audit Finding 2.1). Nullable until migration 029 backfills and constrains it. NULL means "not yet scoped" during the transition window only.';

  