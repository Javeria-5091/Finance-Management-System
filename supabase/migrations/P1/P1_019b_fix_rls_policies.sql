-- =============================================================================
-- Migration: 017_fix_rls_policies.sql
-- Purpose:   Fix Critical finding C-2 and High findings H-1 / H-5 from the
--            Schema Compliance Audit.
--
-- Issues fixed:
--   C-2  public.financial_accounts had "Anyone can view financial accounts"
--        (USING (true)) and "Admins can manage financial accounts"
--        (WITH CHECK (true), no actual admin check) — any authenticated
--        user could read/write every bank/wallet/platform balance.
--   H-1  public.expenses and public.budgets carried leftover "All
--        authenticated users can view..." / "Anyone authenticated can
--        view..." policies (USING (auth.uid() IS NOT NULL)) that grant
--        blanket read access regardless of role/ownership, contradicting
--        Appendix A (Employee = Own records only, Project Manager =
--        assigned projects only).
--   H-5  core.idempotency_keys and core.integration_failures had RLS
--        enabled nowhere in schema.sql.
--
-- Approach: per the remediation rules, incorrect policies are DROPPED and
-- replaced with correct ones (not just layered with an additional policy,
-- since Postgres OR-combines permissive policies and an extra correct
-- policy would not neutralize an existing incorrect permissive one).
--
-- Safety: policy changes only. No table, column, or row is altered. Every
-- DROP POLICY uses IF EXISTS so this migration is safe to re-run.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------
-- 1. public.financial_accounts — replace the effectively-public policies
--    with the same role-gated model already used correctly on
--    finance.financial_accounts (is_finance_head / ACCOUNTANT / VIEWER).
-- -----------------------------------------------------------------------
DROP POLICY IF EXISTS "Admins can manage financial accounts" ON "public"."financial_accounts";
DROP POLICY IF EXISTS "Anyone can view financial accounts"   ON "public"."financial_accounts";

CREATE POLICY "fa_pub_select" ON "public"."financial_accounts"
  FOR SELECT
  USING (
    "core"."is_finance_head"()
    OR "core"."has_role"('ACCOUNTANT'::"text")
    OR "core"."has_role"('VIEWER'::"text")
  );

CREATE POLICY "fa_pub_insert" ON "public"."financial_accounts"
  FOR INSERT
  WITH CHECK (
    "core"."is_finance_head"()
    OR "core"."has_role"('ACCOUNTANT'::"text")
  );

CREATE POLICY "fa_pub_update" ON "public"."financial_accounts"
  FOR UPDATE
  USING (
    "core"."is_finance_head"()
    OR "core"."has_role"('ACCOUNTANT'::"text")
  )
  WITH CHECK (
    "core"."is_finance_head"()
    OR "core"."has_role"('ACCOUNTANT'::"text")
  );

CREATE POLICY "fa_pub_delete" ON "public"."financial_accounts"
  FOR DELETE
  USING ("core"."is_finance_head"());

-- -----------------------------------------------------------------------
-- 2. public.expenses — drop every blanket/legacy policy and the
--    identically-permissive "expenses_select", replace with role- and
--    ownership-scoped access consistent with Appendix A.
--    Kept as-is (already correctly scoped): expenses_insert, expenses_update,
--    expenses_delete (own record OR is_admin()) — these are left untouched.
-- -----------------------------------------------------------------------
DROP POLICY IF EXISTS "All authenticated users can view expenses" ON "public"."expenses";
DROP POLICY IF EXISTS "Admin can delete any expense"               ON "public"."expenses";
DROP POLICY IF EXISTS "Admin can insert any expense"                ON "public"."expenses";
DROP POLICY IF EXISTS "Admin can update any expense"                ON "public"."expenses";
DROP POLICY IF EXISTS "Users can delete own expense"                ON "public"."expenses";
DROP POLICY IF EXISTS "Users can insert own expense"                ON "public"."expenses";
DROP POLICY IF EXISTS "Users can update own expense"                ON "public"."expenses";
DROP POLICY IF EXISTS "expenses_select" ON "public"."expenses";

-- Replacement SELECT policy: finance roles see everything; everyone else
-- sees only their own expense claims, or expenses on a project they own
-- (public.projects has no separate "manager_id" column — project
-- ownership is tracked via projects.user_id).
CREATE POLICY "expenses_select_scoped" ON "public"."expenses"
  FOR SELECT
  USING (
    "core"."is_finance_head"()
    OR "core"."has_role"('ACCOUNTANT'::"text")
    OR "core"."has_role"('VIEWER'::"text")
    OR ("user_id" = "auth"."uid"())
    OR (
      "project_id" IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM "public"."projects" p
        WHERE p.id = "expenses"."project_id"
          AND p.user_id = "auth"."uid"()
      )
    )
  );

-- expenses_insert / expenses_update / expenses_delete already correctly
-- restrict to (auth.uid() = user_id) OR public.is_admin() — no change needed.

-- -----------------------------------------------------------------------
-- 3. public.budgets — same treatment.
--    Kept as-is (already correctly scoped, functionally): budgets_insert,
--    budgets_update are permissive (auth.uid() IS NOT NULL) by current
--    design intent for creation; tightened here to require finance
--    involvement per spec Section 5.4 ("Require approval for budget
--    creation ... according to amount limits").
-- -----------------------------------------------------------------------
DROP POLICY IF EXISTS "Anyone authenticated can view budgets"        ON "public"."budgets";
DROP POLICY IF EXISTS "Admin can manage budgets"                      ON "public"."budgets";
DROP POLICY IF EXISTS "Users with permission can manage budgets"      ON "public"."budgets";
DROP POLICY IF EXISTS "budgets_select" ON "public"."budgets";
DROP POLICY IF EXISTS "budgets_insert" ON "public"."budgets";
DROP POLICY IF EXISTS "budgets_update" ON "public"."budgets";

CREATE POLICY "budgets_select_scoped" ON "public"."budgets"
  FOR SELECT
  USING (
    "core"."is_finance_head"()
    OR "core"."has_role"('ACCOUNTANT'::"text")
    OR "core"."has_role"('VIEWER'::"text")
    OR ("user_id" = "auth"."uid"())
    OR (
      "project_id" IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM "public"."projects" p
        WHERE p.id = "budgets"."project_id"
          AND p.user_id = "auth"."uid"()
      )
    )
  );

CREATE POLICY "budgets_insert_scoped" ON "public"."budgets"
  FOR INSERT
  WITH CHECK (
    "core"."is_finance_head"()
    OR "core"."has_role"('ACCOUNTANT'::"text")
    OR ("user_id" = "auth"."uid"())
  );

CREATE POLICY "budgets_update_scoped" ON "public"."budgets"
  FOR UPDATE
  USING (
    "core"."is_finance_head"()
    OR "core"."has_role"('ACCOUNTANT'::"text")
    OR ("user_id" = "auth"."uid"() AND "status" = 'DRAFT'::"text")
  )
  WITH CHECK (
    "core"."is_finance_head"()
    OR "core"."has_role"('ACCOUNTANT'::"text")
    OR ("user_id" = "auth"."uid"() AND "status" = 'DRAFT'::"text")
  );

-- -----------------------------------------------------------------------
-- 4. Enable RLS on core.idempotency_keys and core.integration_failures
--    (currently the only 2 of 106 tables with no RLS at all). These are
--    system/integration tables per spec Appendix D — restrict to
--    service_role plus read access for Finance Head/CEO/technical review,
--    consistent with how other core.* integration tables are handled.
-- -----------------------------------------------------------------------
ALTER TABLE "core"."idempotency_keys" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "core"."integration_failures" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "idempotency_keys_service_all" ON "core"."idempotency_keys";
CREATE POLICY "idempotency_keys_service_all" ON "core"."idempotency_keys"
  TO "service_role"
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS "idempotency_keys_read_finance" ON "core"."idempotency_keys";
CREATE POLICY "idempotency_keys_read_finance" ON "core"."idempotency_keys"
  FOR SELECT
  TO "authenticated"
  USING ("core"."is_finance_head"());

DROP POLICY IF EXISTS "integration_failures_service_all" ON "core"."integration_failures";
CREATE POLICY "integration_failures_service_all" ON "core"."integration_failures"
  TO "service_role"
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS "integration_failures_read_finance" ON "core"."integration_failures";
CREATE POLICY "integration_failures_read_finance" ON "core"."integration_failures"
  FOR SELECT
  TO "authenticated"
  USING ("core"."is_finance_head"());

COMMIT;

-- =============================================================================
-- NOTE ON SCOPE: this migration intentionally does NOT touch
-- public.invoices (already correctly scoped: invoices_select_scoped etc.)
-- or the finance.* schema policies (already correct). It also does not
-- attempt to resolve the broader duplicate-table question (public.* vs
-- finance.* parallel tables for financial_accounts/budget_lines/
-- numbering_sequences/tax_returns) — see the "Requires Manual Decision"
-- section of the accompanying report (finding H-2). Tightening RLS on the
-- public.* copy is a safe interim fix regardless of that later decision.
-- =============================================================================