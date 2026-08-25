BEGIN;

-- OSYSTIC FMS — Payment Receipt relationship + Audit RPC permission fix
-- Safe for development/test data. Does not delete or rewrite existing rows.

-- 1) Ensure PostgREST can see the payment_receipts -> clients relationship.
DO $$
DECLARE
  v_has_fk boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1
    FROM pg_constraint c
    JOIN pg_class child ON child.oid = c.conrelid
    JOIN pg_namespace child_ns ON child_ns.oid = child.relnamespace
    JOIN pg_class parent ON parent.oid = c.confrelid
    JOIN pg_namespace parent_ns ON parent_ns.oid = parent.relnamespace
    WHERE c.contype = 'f'
      AND child_ns.nspname = 'finance'
      AND child.relname = 'payment_receipts'
      AND parent_ns.nspname = 'public'
      AND parent.relname = 'clients'
      AND pg_get_constraintdef(c.oid) ILIKE '%(client_id)%'
  ) INTO v_has_fk;

  IF NOT v_has_fk THEN
    ALTER TABLE finance.payment_receipts
      ADD CONSTRAINT payment_receipts_client_id_fkey
      FOREIGN KEY (client_id)
      REFERENCES public.clients(id)
      ON DELETE RESTRICT
      NOT VALID;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_payment_receipts_client_id
  ON finance.payment_receipts(client_id);

-- 2) Enforce same-organization client/receipt pairing for future writes.
CREATE OR REPLACE FUNCTION finance.enforce_payment_receipt_client_org()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO pg_catalog, finance, public, core
AS $$
DECLARE
  v_client_org uuid;
BEGIN
  IF NEW.client_id IS NULL THEN
    RAISE EXCEPTION 'Payment receipt client_id is required';
  END IF;

  SELECT c.organization_id INTO v_client_org
  FROM public.clients c
  WHERE c.id = NEW.client_id;

  IF v_client_org IS NULL THEN
    RAISE EXCEPTION 'Client % does not exist or has no organization', NEW.client_id;
  END IF;

  IF NEW.organization_id IS NULL THEN
    RAISE EXCEPTION 'Payment receipt organization_id is required';
  END IF;

  IF v_client_org IS DISTINCT FROM NEW.organization_id THEN
    RAISE EXCEPTION 'Payment receipt client belongs to a different organization';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_payment_receipt_client_org
  ON finance.payment_receipts;

CREATE TRIGGER trg_payment_receipt_client_org
BEFORE INSERT OR UPDATE OF client_id, organization_id
ON finance.payment_receipts
FOR EACH ROW
EXECUTE FUNCTION finance.enforce_payment_receipt_client_org();

-- 3) The current database is missing the audit schema grants that the
-- authoritative schema dump contains. Restore only the permissions required
-- by the existing audit RPCs. Resolve signatures from pg_proc so this remains
-- correct even if optional/default parameters differ in the live database.
GRANT USAGE ON SCHEMA audit TO authenticated;
GRANT USAGE ON SCHEMA audit TO service_role;

DO $$
DECLARE
  v_args text;
BEGIN
  SELECT pg_get_function_identity_arguments(p.oid)
    INTO v_args
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'audit'
    AND p.proname = 'log_action'
  ORDER BY p.oid
  LIMIT 1;

  IF v_args IS NULL THEN
    RAISE EXCEPTION 'audit.log_action function is missing from the database';
  END IF;

  EXECUTE format('GRANT EXECUTE ON FUNCTION audit.log_action(%s) TO authenticated', v_args);
END $$;

DO $$
DECLARE
  v_args text;
BEGIN
  SELECT pg_get_function_identity_arguments(p.oid)
    INTO v_args
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'audit'
    AND p.proname = 'log_security_event'
  ORDER BY p.oid
  LIMIT 1;

  IF v_args IS NULL THEN
    RAISE EXCEPTION 'audit.log_security_event function is missing from the database';
  END IF;

  EXECUTE format('GRANT EXECUTE ON FUNCTION audit.log_security_event(%s) TO authenticated', v_args);
END $$;

-- Existing frontend fallback is intentionally not relied upon; RPCs are the
-- primary audit path. Do not broaden audit table privileges here.

-- 4) Refresh PostgREST schema cache.
NOTIFY pgrst, 'reload schema';

COMMIT;