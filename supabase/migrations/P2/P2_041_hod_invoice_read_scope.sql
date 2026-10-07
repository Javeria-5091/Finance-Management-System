-- =============================================================================
-- Migration: P2_041_hod_invoice_read_scope.sql
-- Investigated: DEF-04 (overdue invoice missing from Aging), DEF-05 (vendor
-- bill missing from Aging)
--
-- FINDING: reporting.receivable_aging and reporting.payable_aging both read
-- straight from public.invoices / finance.vendor_bills with correct bucket
-- logic (verified: INV-VL-004's own numbers reproduce the report's exact
-- 141,600 outstanding figure). Both views are security_invoker, so access
-- depends entirely on the RLS SELECT policy of the underlying table.
--
-- invoices_select_org_scoped currently allows only: CEO/FINANCE_HEAD,
-- ACCOUNTANT, VIEWER, the invoice's own creator, or the owner of the linked
-- project. Per spec Appendix A, "Invoices/receipts" should be "Limited" for
-- HOD -- but HOD has no branch in this policy at all. If WF-008 (Aging) was
-- tested while logged in as Sara (HOD) -- plausible, since HOD was the
-- central role being tested around that point in the session -- "Total
-- Receivables: PKR 0" is fully explained by RLS silently returning zero
-- rows, not by anything being broken in GL/Aging itself.
--
-- This migration closes that specific, confirmable gap for invoices.
--
-- vendor_bills (DEF-05) is NOT touched here: spec says HOD should also get
-- "Limited" access to Bills/payments, but vendor_bills has no reliable way
-- to scope "HOD's department" -- it has no employee owner column, and
-- projects.department is a free-text varchar, not a foreign key to
-- core.departments/profiles.department_id, so joining on it could silently
-- match the wrong department by a text coincidence. Scoping this correctly
-- needs a decision: either make projects.department a real foreign key, or
-- define HOD's bill visibility some other way (e.g. by project, as
-- PROJECT_MANAGER already has). Flagged for Sir/Umar rather than guessed at.
-- =============================================================================

BEGIN;

DROP POLICY IF EXISTS "invoices_select_org_scoped" ON "public"."invoices";
CREATE POLICY "invoices_select_org_scoped" ON "public"."invoices"
  FOR SELECT TO "authenticated"
  USING (
    "core"."same_org"("organization_id")
    AND (
         "core"."is_finance_head"()
      OR "core"."has_role"('ACCOUNTANT'::"text")
      OR "core"."has_role"('VIEWER'::"text")
      OR ("user_id" = "auth"."uid"())
      OR (
           EXISTS (
             SELECT 1 FROM "public"."projects" "p"
             WHERE "p"."id" = "invoices"."project_id"
               AND "p"."user_id" = "auth"."uid"()
           )
         )
      -- DEF-04: HOD sees invoices they themselves created/own in their
      -- department scope (same helper as the DEF-01/02/03 expense fix).
      OR "core"."is_hod_for_user"("user_id")
    )
  );

-- ---------------------------------------------------------------------------
-- DEF-13 (budget_gl_actuals "permission denied"): checked budgets_select_org
-- _scoped and found the EXACT same pattern as invoices had -- CEO/FH,
-- ACCOUNTANT, VIEWER, owner, or project-owner, with no HOD branch, even
-- though spec Appendix A lists Budgets as "Limited" for HOD. reporting.
-- budget_gl_actual INNER JOINs public.budgets, so a HOD would see this view
-- return zero rows -- enough to look like "denied" even though no actual
-- grant/RLS error occurs. Same fix pattern as invoices above.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "budgets_select_org_scoped" ON "public"."budgets";
CREATE POLICY "budgets_select_org_scoped" ON "public"."budgets"
  FOR SELECT TO "authenticated"
  USING (
    "core"."same_org"("organization_id")
    AND (
         "core"."is_finance_head"()
      OR "core"."has_role"('ACCOUNTANT'::"text")
      OR "core"."has_role"('VIEWER'::"text")
      OR ("user_id" = "auth"."uid"())
      OR (
           ("project_id" IS NOT NULL)
           AND EXISTS (
             SELECT 1 FROM "public"."projects" "p"
             WHERE "p"."id" = "budgets"."project_id"
               AND "p"."user_id" = "auth"."uid"()
           )
         )
      OR "core"."is_hod_for_user"("user_id")
    )
  );

COMMIT;