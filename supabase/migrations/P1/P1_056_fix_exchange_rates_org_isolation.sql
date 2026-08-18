-- =============================================================================
-- Migration: 040_fix_exchange_rates_org_isolation.sql
-- Purpose:   Close the last open finding from the Schema Compliance Audit
--            (Rev 2): finance.exchange_rates has no organization boundary in
--            its RLS policies, and organization_id is nullable, allowing any
--            Accountant/Finance Head/Viewer in ANY organization to read every
--            other organization's manual exchange rates, and any
--            Accountant/Finance Head to insert rate rows without a tenant
--            check. Spec refs: §17 (Multi-Tenancy/Organization Isolation),
--            §18 (RLS/Security Audit), §5.12 (manual FX evidence), §15.4
--            (release gate: "any user can access another scope" blocks
--            production).
--
-- Safety:    Non-destructive. Backfills NULL organization_id only when it can
--            be deterministically derived (see Step 1). Drops and recreates
--            only the two specific policies that were found incorrect
--            (fx_select, fx_insert) -- every other policy on this table is
--            untouched. Adds NOT NULL only after backfill succeeds, and only
--            if no ambiguous rows remain (see guard in Step 2).
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- STEP 0: Pre-flight visibility (does not alter data). Surfaces exactly what
-- this migration is about to do, and what it will refuse to do.
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  v_null_org_rows integer;
  v_org_count integer;
BEGIN
  SELECT count(*) INTO v_null_org_rows
  FROM finance.exchange_rates
  WHERE organization_id IS NULL;

  SELECT count(*) INTO v_org_count
  FROM core.organizations;

  RAISE NOTICE 'finance.exchange_rates: % row(s) currently have a NULL organization_id.', v_null_org_rows;
  RAISE NOTICE 'core.organizations: % organization(s) currently exist.', v_org_count;
END $$;

-- -----------------------------------------------------------------------------
-- STEP 1: Deterministic backfill of NULL organization_id.
--
-- A NULL organization_id can only be safely and deterministically resolved
-- when there is exactly ONE organization in the system -- in that case every
-- existing row unambiguously belongs to it. If more than one organization
-- exists, we do NOT guess which org an orphaned rate row belongs to; those
-- rows are left as-is and Step 2's guard will stop the migration before it
-- adds a NOT NULL constraint that would either fail or (worse) silently
-- misattribute financial data.
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  v_org_count integer;
  v_single_org_id uuid;
  v_updated integer;
BEGIN
  SELECT count(*) INTO v_org_count FROM core.organizations;

  IF v_org_count = 1 THEN
    SELECT id INTO v_single_org_id FROM core.organizations LIMIT 1;

    UPDATE finance.exchange_rates
    SET organization_id = v_single_org_id
    WHERE organization_id IS NULL;

    GET DIAGNOSTICS v_updated = ROW_COUNT;
    RAISE NOTICE 'Backfilled % row(s) in finance.exchange_rates to the single existing organization (%).', v_updated, v_single_org_id;
  ELSE
    RAISE NOTICE 'Skipping automatic backfill: % organizations exist, so NULL organization_id on finance.exchange_rates cannot be resolved deterministically. Manual data correction required (see Section D of the response).', v_org_count;
  END IF;
END $$;

-- -----------------------------------------------------------------------------
-- STEP 2: Guarded NOT NULL. Only proceeds if the backfill above (or prior
-- application data) has left zero NULL rows. If any remain, this raises a
-- clear exception and the whole migration rolls back rather than silently
-- leaving the column nullable -- per the "no destructive/ambiguous action
-- without an explicit stop" instruction.
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  v_remaining integer;
BEGIN
  SELECT count(*) INTO v_remaining
  FROM finance.exchange_rates
  WHERE organization_id IS NULL;

  IF v_remaining > 0 THEN
    RAISE EXCEPTION
      'Aborting migration 040: % row(s) in finance.exchange_rates still have a NULL organization_id and cannot be deterministically backfilled (multiple organizations exist). Resolve these rows manually (e.g. UPDATE finance.exchange_rates SET organization_id = ... WHERE id = ...) and re-run this migration.',
      v_remaining;
  END IF;

  ALTER TABLE finance.exchange_rates
    ALTER COLUMN organization_id SET NOT NULL;

  RAISE NOTICE 'finance.exchange_rates.organization_id is now NOT NULL.';
END $$;

-- -----------------------------------------------------------------------------
-- STEP 3: Replace the two incorrect policies with organization-scoped
-- versions. Every other policy on finance.exchange_rates (there are none
-- besides fx_select/fx_insert as of the audited schema -- UPDATE and DELETE
-- are correctly left with no policy, i.e. denied by default, preserving the
-- "never overwrite historic exchange rates" requirement from §5.12) is left
-- untouched.
-- -----------------------------------------------------------------------------
DROP POLICY IF EXISTS "fx_select" ON "finance"."exchange_rates";
DROP POLICY IF EXISTS "fx_insert" ON "finance"."exchange_rates";

CREATE POLICY "fx_select" ON "finance"."exchange_rates"
  FOR SELECT
  USING (
    (core.is_finance_head() OR core.has_role('ACCOUNTANT') OR core.has_role('VIEWER'))
    AND core.same_org(organization_id)
  );

CREATE POLICY "fx_insert" ON "finance"."exchange_rates"
  FOR INSERT
  WITH CHECK (
    (core.is_finance_head() OR core.has_role('ACCOUNTANT'))
    AND core.same_org(organization_id)
  );

COMMENT ON POLICY "fx_select" ON "finance"."exchange_rates" IS
  'Migration 040: added core.same_org(organization_id) tenant check. Previously this policy had no organization boundary at all, letting any Finance Head/Accountant/Viewer in ANY organization read every other organization''s manual FX rates (Compliance Audit Rev 2, CRITICAL-1).';

COMMENT ON POLICY "fx_insert" ON "finance"."exchange_rates" IS
  'Migration 040: added core.same_org(organization_id) tenant check. Previously this policy had no organization boundary at all, letting any Finance Head/Accountant in ANY organization insert exchange rates against another organization''s organization_id (Compliance Audit Rev 2, CRITICAL-1).';

COMMENT ON COLUMN "finance"."exchange_rates"."organization_id" IS
  'Migration 040: now NOT NULL. Every manual exchange rate must belong to exactly one organization; a NULL value previously made the row invisible to the tenant boundary entirely (it satisfied neither side of core.same_org(), which fails closed, but also was never actually checked by the old fx_select/fx_insert policies).';

COMMIT;