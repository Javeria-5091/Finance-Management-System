-- =============================================================================
-- Migration: 037_enforce_organization_constraints.sql
-- Purpose:   Complete Finding 4.1 / 4.5 / 4.6 by adding referential integrity
--            (FOREIGN KEY to core.organizations) and mandatory-ness (NOT NULL)
--            for organization_id, everywhere it is now safe to do so.
--
-- Spec refs: Section 17, Section 10.5 ("Is it NOT NULL where required?",
--            "Foreign keys, not free text, connect ... records").
--
-- What this migration does, per table:
--   1. Adds FK organization_id -> core.organizations(id) ON DELETE RESTRICT
--      (RESTRICT, not CASCADE: deleting an organization must never silently
--      delete financial/master-data history -- consistent with spec Section
--      10.5's "financial history is retained" principle). The constraint is
--      added only if it does not already exist, and only after implicitly
--      validating existing data (ADD CONSTRAINT validates by default).
--   2. Conditionally sets organization_id NOT NULL -- but ONLY on tables
--      where a fresh check confirms zero remaining NULL rows. If any table
--      still has unresolved rows (see migration 036's NOTICE output), this
--      migration deliberately SKIPS the NOT NULL step for that table and
--      raises a NOTICE, rather than either failing the whole migration or
--      silently leaving a gap unreported.
--
-- Safety:
--   - Idempotent: safe to re-run. FK additions are guarded by pg_constraint
--     lookups; NOT NULL additions are guarded by a live NULL-count check.
--   - No data is deleted or invented.
--   - If this migration reports any "SKIPPED" notices, those tables remain
--     exactly as they were after migration 036 (nullable, but FK-protected
--     wherever the FK could be safely added) until the underlying data gap
--     is resolved manually.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------
-- 1. Foreign keys: organization_id -> core.organizations(id)
-- -----------------------------------------------------------------------

DO $$
DECLARE
  v_targets text[][] := ARRAY[
    ARRAY['public',  'invoices',           'invoices_organization_id_fkey'],
    ARRAY['public',  'expenses',           'expenses_organization_id_fkey'],
    ARRAY['public',  'projects',           'projects_organization_id_fkey'],
    ARRAY['public',  'budgets',            'budgets_organization_id_fkey'],
    ARRAY['public',  'clients',            'clients_organization_id_fkey'],
    ARRAY['audit',   'audit_log',          'audit_log_organization_id_fkey'],
    ARRAY['finance', 'journal_entries',    'journal_entries_organization_id_fkey'],
    ARRAY['finance', 'chart_of_accounts',  'chart_of_accounts_organization_id_fkey'],
    ARRAY['finance', 'financial_accounts', 'financial_accounts_organization_id_fkey'],
    ARRAY['finance', 'vendor_bills',       'vendor_bills_organization_id_fkey']
  ];
  v_row text[];
BEGIN
  FOREACH v_row SLICE 1 IN ARRAY v_targets LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname = v_row[1] AND t.relname = v_row[2] AND c.conname = v_row[3]
    ) THEN
      EXECUTE format(
        'ALTER TABLE %I.%I ADD CONSTRAINT %I FOREIGN KEY (organization_id) REFERENCES core.organizations(id) ON DELETE RESTRICT',
        v_row[1], v_row[2], v_row[3]
      );
      RAISE NOTICE 'Added FK % on %.%', v_row[3], v_row[1], v_row[2];
    ELSE
      RAISE NOTICE 'FK % already exists on %.% -- skipped', v_row[3], v_row[1], v_row[2];
    END IF;
  END LOOP;
END $$;

-- -----------------------------------------------------------------------
-- 2. Conditional NOT NULL -- only where the data is actually clean.
-- -----------------------------------------------------------------------

DO $$
DECLARE
  v_targets text[][] := ARRAY[
    ARRAY['public',  'invoices'],
    ARRAY['public',  'expenses'],
    ARRAY['public',  'projects'],
    ARRAY['public',  'budgets'],
    ARRAY['public',  'clients'],
    ARRAY['audit',   'audit_log'],
    ARRAY['finance', 'journal_entries'],
    ARRAY['finance', 'chart_of_accounts'],
    ARRAY['finance', 'financial_accounts'],
    ARRAY['finance', 'vendor_bills']
  ];
  v_row text[];
  v_null_count integer;
  v_already_not_null boolean;
BEGIN
  FOREACH v_row SLICE 1 IN ARRAY v_targets LOOP

    SELECT NOT a.attnotnull INTO v_already_not_null
    FROM pg_attribute a
    JOIN pg_class t ON t.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = v_row[1] AND t.relname = v_row[2] AND a.attname = 'organization_id';

    IF v_already_not_null IS FALSE THEN
      RAISE NOTICE '%.%.organization_id is already NOT NULL -- skipped', v_row[1], v_row[2];
      CONTINUE;
    END IF;

    EXECUTE format('SELECT count(*) FROM %I.%I WHERE organization_id IS NULL', v_row[1], v_row[2])
      INTO v_null_count;

    IF v_null_count = 0 THEN
      EXECUTE format('ALTER TABLE %I.%I ALTER COLUMN organization_id SET NOT NULL', v_row[1], v_row[2]);
      RAISE NOTICE 'Set NOT NULL on %.%.organization_id', v_row[1], v_row[2];
    ELSE
      RAISE NOTICE 'SKIPPED NOT NULL on %.%.organization_id -- % row(s) still NULL. Resolve manually (see Data Migration Requirements), then run: ALTER TABLE %I.%I ALTER COLUMN organization_id SET NOT NULL;',
        v_row[1], v_row[2], v_null_count, v_row[1], v_row[2];
    END IF;
  END LOOP;
END $$;

COMMIT;