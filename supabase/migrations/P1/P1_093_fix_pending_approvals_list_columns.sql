-- ============================================================================
-- P1_093_fix_pending_approvals_list_columns.sql
--
-- FE-01 FIX: reporting.pending_approvals_list() referenced columns that do
-- not exist on the underlying tables, so every call raised a Postgres
-- "column does not exist" error and PostgREST turned it into a 400/500 on
-- the CEO dashboard. The "Pending Approvals" widget was therefore
-- permanently dead (CEODashboard.tsx:447, calling
-- dashboard.service.ts:getPendingApprovals -> RPC pending_approvals_list).
--
-- Concretely, three bugs in the UNION ALL:
--   1. public.invoices has no "created_by" column (it has "user_id",
--      "submitted_by", "issued_by", etc). Fixed to alias user_id AS created_by.
--   2. finance.vendor_bills has no "vendor_name" column - vendor name lives
--      on finance.vendors via vendor_id. Fixed by LEFT JOIN finance.vendors.
--   3. public.expenses has no "reference_number", "description", "purpose",
--      "total_amount", or "created_by" columns. It actually has "title",
--      "notes", "amount", and "user_id". Fixed to use the real columns and
--      synthesize a reference from the row id.
-- ============================================================================

DROP FUNCTION IF EXISTS "reporting"."pending_approvals_list"("uuid");

CREATE OR REPLACE FUNCTION "reporting"."pending_approvals_list"("p_organization_id" "uuid" DEFAULT NULL::"uuid") RETURNS json
    LANGUAGE "plpgsql" STABLE
    SET "search_path" TO 'pg_catalog', 'reporting', 'finance', 'public', 'core'
    AS $$ DECLARE
  v_org_id UUID;
BEGIN
  IF NOT core.is_finance_head() THEN
    RAISE EXCEPTION 'Access denied: CEO dashboard is restricted to CEO/Finance Head roles';
  END IF;
  v_org_id := COALESCE(p_organization_id, core.current_user_org_id());
  IF v_org_id IS NULL OR NOT core.same_org(v_org_id) THEN
    RAISE EXCEPTION 'Access denied: organization scope mismatch';
  END IF;

  RETURN COALESCE(
    json_agg(row_to_json(t) ORDER BY t.created_at DESC)
  , '[]'::JSON) FROM (
    -- Invoices
    SELECT i.id, 'INVOICE' AS module_type, i.invoice_number AS reference,
      COALESCE(i.client_name, 'N/A') AS description,
      COALESCE(i.total_amount, 0) AS amount,
      i.user_id AS created_by, i.created_at,
      CASE WHEN i.due_date < CURRENT_DATE THEN 'HIGH' ELSE 'NORMAL' END AS urgency
    FROM public.invoices i
    WHERE i.status = 'SUBMITTED' AND i.organization_id = v_org_id

    UNION ALL

    -- Vendor Bills
    SELECT vb.id, 'VENDOR_BILL' AS module_type, vb.bill_number AS reference,
      COALESCE(v.name, vb.description, 'N/A') AS description,
      COALESCE(vb.total_amount, 0) AS amount,
      vb.created_by, vb.created_at,
      CASE WHEN vb.due_date < CURRENT_DATE THEN 'HIGH' ELSE 'NORMAL' END AS urgency
    FROM finance.vendor_bills vb
    LEFT JOIN finance.vendors v ON v.id = vb.vendor_id
    WHERE vb.status IN ('SUBMITTED','VERIFIED') AND vb.organization_id = v_org_id

    UNION ALL

    -- Expenses
    SELECT e.id, 'EXPENSE' AS module_type,
      'EXP-' || substr(e.id::text, 1, 8) AS reference,
      COALESCE(e.title, e.notes, 'N/A') AS description,
      COALESCE(e.amount, 0) AS amount,
      e.user_id AS created_by, e.created_at,
      'NORMAL' AS urgency
    FROM public.expenses e
    WHERE e.status = 'SUBMITTED' AND e.organization_id = v_org_id
  ) t;
END;
 $$;

ALTER FUNCTION "reporting"."pending_approvals_list"("p_organization_id" "uuid") OWNER TO "postgres";

COMMENT ON FUNCTION "reporting"."pending_approvals_list"("p_organization_id" "uuid") IS 'FE-01 fix: previously referenced invoices.created_by, vendor_bills.vendor_name, and expenses.reference_number/description/purpose/total_amount/created_by, none of which exist on those tables, so every call errored and the CEO dashboard Pending Approvals widget was permanently dead. Now uses the real columns (user_id, a finance.vendors join, title/notes/amount).';

REVOKE ALL ON FUNCTION "reporting"."pending_approvals_list"("p_organization_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "reporting"."pending_approvals_list"("p_organization_id" "uuid") TO "authenticated";