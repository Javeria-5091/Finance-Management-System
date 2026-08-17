-- 031_add_org_scoping_helpers.sql

BEGIN;

CREATE OR REPLACE FUNCTION core.current_user_org_config_id()
RETURNS uuid
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'pg_catalog', 'core', 'public'
AS $$
DECLARE
  v_config_id uuid;
BEGIN
  SELECT oc.id INTO v_config_id
  FROM core.organization_config oc
  WHERE oc.organization_id = core.current_user_org_id()
  LIMIT 1;

  RETURN v_config_id;
END;
$$;

REVOKE ALL ON FUNCTION core.current_user_org_config_id() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.current_user_org_config_id() TO authenticated, service_role;

COMMENT ON FUNCTION core.current_user_org_config_id() IS
  'Returns the organization_config.id row belonging to the current user''s organization (via core.current_user_org_id() -> core.organization_config.organization_id). Added migration 031 (Compliance Audit R2) to replace the unscoped "SELECT id FROM organization_config LIMIT 1" pattern previously used in finance.tax_* RLS policies.';

COMMIT;