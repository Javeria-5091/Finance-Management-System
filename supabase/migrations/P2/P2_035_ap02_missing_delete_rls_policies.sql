-- ═══════════════════════════════════════════════════════════════════════
-- P2_035: AP-02 — missing DELETE RLS policies on AP tables
-- ═══════════════════════════════════════════════════════════════════════
-- Apply this migration to the database (e.g. via the Supabase CLI /
-- migration runner). schema.sql in this repo has already been updated to
-- match the end state produced by this migration.
--
-- AP-02 (P0, financial / data-integrity)
-- ---------------------------------------------------------------------
-- finance.vendor_payment_allocations, finance.vendor_payments and
-- finance.vendor_bills all have RLS enabled but NONE of them ever had a
-- DELETE policy defined (verified against every CREATE POLICY statement
-- in schema.sql). With RLS enabled and no matching policy, a DELETE
-- statement is not an error — it simply matches zero rows and returns
-- success, which is exactly what PostgREST (and therefore every route
-- below) reported back to the client.
--
-- Three call sites relied on DELETE actually working and were silently
-- no-oping:
--   1. src/app/api/finance/vendor-payments/[id]/route.ts (cancel action) —
--      deletes a payment's finance.vendor_payment_allocations rows so the
--      finance.auto_update_bill_status trigger restores the bill's
--      outstanding_amount/status, then marks the payment REVERSED. The
--      allocations survived, so the bill stayed PARTIALLY_PAID forever
--      and finance.validate_vendor_payment_allocation kept counting the
--      ghost allocations against the bill, and reporting.payable_aging
--      understated AP — while the API returned success:true.
--   2. src/app/api/finance/vendor-payments/route.ts (create) — on
--      allocation-insert failure, tries to delete the just-created DRAFT
--      finance.vendor_payments row to avoid leaving an orphan. Silently
--      failed, leaving orphaned DRAFT payments with no allocations.
--   3. src/app/api/finance/vendor-bills/recurring/generate/route.ts — on
--      bill-line-insert failure, tries to delete the just-created DRAFT
--      finance.vendor_bills row. Silently failed, leaving orphaned DRAFT
--      bills with no lines.
--
-- Fix: add narrowly-scoped DELETE policies, matching the existing
-- role/org convention used by every other policy on these tables
-- (core.is_finance_head() OR core.has_role('ACCOUNTANT'), plus
-- core.same_org(...)). Deletion is further restricted to rows that are
-- financially inert so this can never become a way to erase posted,
-- GL-linked history:
--   - vpa_delete_org_scoped:  only allocations whose parent
--     vendor_payment is NOT status='POSTED' (mirrors the org-scoping
--     already used by vpa_insert_org_scoped / vpa_select_org_scoped, via
--     a join to vendor_bills and vendor_payments).
--   - vp_delete_draft_org_scoped:  only vendor_payments rows that are
--     still status='DRAFT' (a POSTED or REVERSED payment can never be
--     deleted this way).
--   - vb_delete_draft_org_scoped:  only vendor_bills rows that are still
--     status='DRAFT'.
--
-- The three route handlers above are updated in the same change set to
-- verify the actual row count returned by each delete instead of trusting
-- a no-error response, so any future RLS/permission regression fails
-- loudly instead of silently corrupting balances again.
-- ═══════════════════════════════════════════════════════════════════════

CREATE POLICY "vpa_delete_org_scoped" ON "finance"."vendor_payment_allocations"
  FOR DELETE
  USING (
    ("core"."is_finance_head"() OR "core"."has_role"('ACCOUNTANT'::"text"))
    AND EXISTS (
      SELECT 1 FROM "finance"."vendor_payments" "vp"
      WHERE "vp"."id" = "vendor_payment_allocations"."vendor_payment_id"
        AND "core"."same_org"("vp"."organization_id")
        AND "vp"."status" <> 'POSTED'
    )
    AND EXISTS (
      SELECT 1 FROM "finance"."vendor_bills" "vb"
      WHERE "vb"."id" = "vendor_payment_allocations"."vendor_bill_id"
        AND "core"."same_org"("vb"."organization_id")
    )
  );

CREATE POLICY "vp_delete_draft_org_scoped" ON "finance"."vendor_payments"
  FOR DELETE
  USING (
    ("core"."is_finance_head"() OR "core"."has_role"('ACCOUNTANT'::"text"))
    AND "core"."same_org"("organization_id")
    AND "status" = 'DRAFT'
  );

CREATE POLICY "vb_delete_draft_org_scoped" ON "finance"."vendor_bills"
  FOR DELETE
  USING (
    ("core"."is_finance_head"() OR "core"."has_role"('ACCOUNTANT'::"text"))
    AND "core"."same_org"("organization_id")
    AND "status" = 'DRAFT'
  );