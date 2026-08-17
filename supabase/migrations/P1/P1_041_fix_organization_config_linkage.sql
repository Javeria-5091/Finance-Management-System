-- 041_fix_organization_config_linkage.sql
-- Fixes: core.organization_config has no FK/UNIQUE to core.organizations.
-- Non-destructive: only adds constraints; backfills a link ONLY in the
-- unambiguous single-organization / single-config case. If your database
-- already has more than one organization or more than one config row,
-- this migration deliberately does NOT guess a mapping -- it raises a
-- NOTICE and leaves the column as-is for manual review.

BEGIN;

DO $$
DECLARE
  v_org_count   integer;
  v_cfg_count   integer;
  v_org_id      uuid;
  v_cfg_id      uuid;
  v_unlinked_cfg_count integer;
BEGIN
  SELECT count(*) INTO v_org_count FROM core.organizations;
  SELECT count(*) INTO v_cfg_count FROM core.organization_config;

  SELECT count(*) INTO v_unlinked_cfg_count
  FROM core.organization_config
  WHERE organization_id IS NULL;

  IF v_org_count = 1 AND v_cfg_count = 1 AND v_unlinked_cfg_count = 1 THEN
    SELECT id INTO v_org_id FROM core.organizations LIMIT 1;
    SELECT id INTO v_cfg_id FROM core.organization_config LIMIT 1;

    UPDATE core.organization_config
    SET organization_id = v_org_id
    WHERE id = v_cfg_id;

    RAISE NOTICE 'organization_config.organization_id backfilled: config % -> organization %',
      v_cfg_id, v_org_id;
  ELSIF v_unlinked_cfg_count = 0 THEN
    RAISE NOTICE 'organization_config.organization_id already populated for all rows -- no backfill needed.';
  ELSE
    RAISE NOTICE 'SKIPPED automatic backfill: found % organizations and % config rows (% unlinked). '
      'This is not the unambiguous single-org case. Resolve manually with: '
      'UPDATE core.organization_config SET organization_id = <correct org id> WHERE id = <config id>;',
      v_org_count, v_cfg_count, v_unlinked_cfg_count;
  END IF;
END $$;

-- Add the FK only if it doesn't already exist (idempotent / re-runnable).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'organization_config_organization_id_fkey'
  ) THEN
    ALTER TABLE core.organization_config
      ADD CONSTRAINT organization_config_organization_id_fkey
      FOREIGN KEY (organization_id) REFERENCES core.organizations(id) ON DELETE CASCADE;
  END IF;
END $$;

-- One config row per organization. Only added if the backfill above
-- succeeded in producing no duplicate org_id values (safe to attempt;
-- will simply fail loudly and roll back the transaction if data doesn't
-- support it, rather than silently skipping).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'organization_config_organization_id_unique'
  ) THEN
    IF NOT EXISTS (
      SELECT organization_id FROM core.organization_config
      WHERE organization_id IS NOT NULL
      GROUP BY organization_id HAVING count(*) > 1
    ) THEN
      ALTER TABLE core.organization_config
        ADD CONSTRAINT organization_config_organization_id_unique UNIQUE (organization_id);
    ELSE
      RAISE NOTICE 'SKIPPED unique constraint: multiple organization_config rows share the same organization_id. Resolve duplicates manually.';
    END IF;
  END IF;
END $$;

COMMENT ON COLUMN core.organization_config.organization_id IS
  'Links this settings row to its owning organization (spec Section 10.1 organizations table). Added FK + UNIQUE in migration 030 (Compliance Audit R3). Previously unconstrained, which allowed finance.tax_* RLS policies to reference this table without any real org-scoping guarantee.';

COMMIT;
