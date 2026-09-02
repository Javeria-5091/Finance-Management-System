-- P2_031: Wire the vendor payment batch UI to the authoritative batch tables
-- and make submit/approve transitions atomic across the batch and its child
-- vendor_payments rows.

CREATE OR REPLACE FUNCTION finance.transition_vendor_payment_batch_atomic(
  p_batch_id uuid,
  p_action text,
  p_user_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO pg_catalog, finance, core, public
AS $$
DECLARE
  v_org uuid := core.current_user_org_id();
  v_batch finance.vendor_payment_batches%ROWTYPE;
  v_child_count integer;
  v_expected_count integer;
BEGIN
  IF auth.uid() IS NULL OR p_user_id IS DISTINCT FROM auth.uid() OR v_org IS NULL THEN
    RAISE EXCEPTION 'Authentication and organization context are required';
  END IF;

  IF p_action NOT IN ('submit', 'approve') THEN
    RAISE EXCEPTION 'Unsupported batch transition: %', p_action;
  END IF;

  IF p_action = 'submit' AND NOT core.has_permission(auth.uid(), 'VENDOR_PAYMENT_UPDATE') THEN
    RAISE EXCEPTION 'VENDOR_PAYMENT_UPDATE permission required';
  END IF;

  IF p_action = 'approve' AND NOT core.has_permission(auth.uid(), 'VENDOR_PAYMENT_APPROVE') THEN
    RAISE EXCEPTION 'VENDOR_PAYMENT_APPROVE permission required';
  END IF;

  SELECT *
    INTO v_batch
    FROM finance.vendor_payment_batches
   WHERE id = p_batch_id
     AND organization_id = v_org
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Batch not found in your organization';
  END IF;

  SELECT COUNT(*), COALESCE(MAX(v_batch.payment_count), 0)
    INTO v_child_count, v_expected_count
    FROM finance.vendor_payments
   WHERE batch_id = p_batch_id
     AND organization_id = v_org
     AND is_batch = true;

  IF v_child_count <> v_expected_count OR v_child_count = 0 THEN
    RAISE EXCEPTION 'Batch child-payment count is inconsistent with the batch header';
  END IF;

  IF p_action = 'submit' THEN
    IF v_batch.status <> 'DRAFT' THEN
      RAISE EXCEPTION 'Only DRAFT batches can be submitted. Current: %', v_batch.status;
    END IF;

    UPDATE finance.vendor_payment_batches
       SET status = 'SUBMITTED',
           submitted_by = p_user_id,
           submitted_at = now(),
           updated_at = now()
     WHERE id = p_batch_id
       AND organization_id = v_org
       AND status = 'DRAFT';

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Batch submission failed due to a concurrent change';
    END IF;
  ELSE
    IF v_batch.status <> 'SUBMITTED' THEN
      RAISE EXCEPTION 'Only SUBMITTED batches can be approved. Current: %', v_batch.status;
    END IF;

    IF v_batch.created_by IS NOT NULL AND v_batch.created_by = p_user_id THEN
      RAISE EXCEPTION 'Maker-checker violation: the batch creator cannot approve their own batch';
    END IF;

    -- Lock and validate every child before changing any status. Because this
    -- function runs in one transaction, a failure rolls back both the child
    -- approvals and the batch header update.
    PERFORM 1
      FROM finance.vendor_payments
     WHERE batch_id = p_batch_id
       AND organization_id = v_org
       AND is_batch = true
       AND status <> 'DRAFT'
     FOR UPDATE;

    IF FOUND THEN
      RAISE EXCEPTION 'Every child payment must be DRAFT before batch approval';
    END IF;

    UPDATE finance.vendor_payments
       SET status = 'APPROVED',
           approved_by = p_user_id,
           approved_at = now(),
           updated_at = now()
     WHERE batch_id = p_batch_id
       AND organization_id = v_org
       AND is_batch = true
       AND status = 'DRAFT';

    GET DIAGNOSTICS v_child_count = ROW_COUNT;
    IF v_child_count <> v_batch.payment_count THEN
      RAISE EXCEPTION 'Expected to approve % child payments but approved %',
        v_batch.payment_count, v_child_count;
    END IF;

    UPDATE finance.vendor_payment_batches
       SET status = 'APPROVED',
           approved_by = p_user_id,
           approved_at = now(),
           updated_at = now()
     WHERE id = p_batch_id
       AND organization_id = v_org
       AND status = 'SUBMITTED';

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Batch approval failed due to a concurrent change';
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'batch_id', p_batch_id,
    'status', CASE WHEN p_action = 'submit' THEN 'SUBMITTED' ELSE 'APPROVED' END,
    'payment_count', v_batch.payment_count
  );
END;
$$;

ALTER FUNCTION finance.transition_vendor_payment_batch_atomic(uuid, text, uuid) OWNER TO postgres;

REVOKE ALL ON FUNCTION finance.transition_vendor_payment_batch_atomic(uuid, text, uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION finance.transition_vendor_payment_batch_atomic(uuid, text, uuid) TO authenticated;
