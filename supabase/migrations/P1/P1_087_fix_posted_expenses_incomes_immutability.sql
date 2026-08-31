-- =============================================================================
-- Migration: P1_087_fix_posted_expenses_incomes_immutability.sql
-- Purpose:   Fixes FND-FIN-003 and FND-FIN-004 (Severity P1).
--
--   FND-FIN-003  expenses_update_org_scoped / expenses_delete_org_scoped
--                had no journal_entry_id IS NULL gate, so a POSTED expense
--                (one already linked to a journal entry) could be updated
--                or deleted directly by its creator/admin via the
--                Supabase JS client, e.g.
--                  supabase.from('expenses').update({amount: 999999}).eq('id', id)
--                This left the GL (finance.journal_lines.debit_amount)
--                showing the original amount while the source expense row
--                showed a different amount -- a permanent GL-vs-source
--                mismatch (Spec 4.1, 11.3: posted records are immutable;
--                corrections happen only via reversal).
--
--   FND-FIN-004  incomes_update_org_scoped / incomes_delete_org_scoped had
--                the identical gap for the income module.
--
-- Fix:       Add "AND journal_entry_id IS NULL" to the USING (and, for
--            UPDATE, WITH CHECK) clauses of the expenses/incomes UPDATE
--            and DELETE policies. This is the same pattern already applied
--            to public.invoices in P1_019_rls_policy_hardening.sql
--            (invoices_update_org_scoped / invoices_delete_org_scoped) --
--            we're just closing the same hole for expenses and incomes.
--
--            Legitimate corrections to POSTED rows still work: they go
--            through finance.reverse_expense_atomic() / 
--            reverse_income_atomic() (see P1_074), which are
--            SECURITY DEFINER functions that bypass RLS, post a reversing
--            journal entry, and only then flip the row to REVERSED. Once a
--            row is REVERSED its journal_entry_id is repointed to the
--            reversal entry (still NOT NULL), so it correctly stays
--            immutable too -- exactly mirroring the invoices behavior.
--
--            DRAFT/SUBMITTED/VERIFIED/APPROVED/REJECTED/CANCELLED rows
--            (journal_entry_id IS NULL) are completely unaffected and
--            remain editable/deletable by their owner or admin/finance_head
--            as before.
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- expenses (FND-FIN-003)
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS "expenses_update_org_scoped" ON "public"."expenses";
CREATE POLICY "expenses_update_org_scoped" ON "public"."expenses"
  FOR UPDATE TO "authenticated"
  USING (
    "core"."same_org"("organization_id")
    AND (("auth"."uid"() = "user_id") OR "public"."is_admin"())
    AND "journal_entry_id" IS NULL
  )
  WITH CHECK (
    "core"."same_org"("organization_id")
    AND (("auth"."uid"() = "user_id") OR "public"."is_admin"())
    AND "journal_entry_id" IS NULL
  );

DROP POLICY IF EXISTS "expenses_delete_org_scoped" ON "public"."expenses";
CREATE POLICY "expenses_delete_org_scoped" ON "public"."expenses"
  FOR DELETE TO "authenticated"
  USING (
    "core"."same_org"("organization_id")
    AND (("auth"."uid"() = "user_id") OR "public"."is_admin"())
    AND "journal_entry_id" IS NULL
  );

-- ---------------------------------------------------------------------------
-- incomes (FND-FIN-004)
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS "incomes_update_org_scoped" ON "public"."incomes";
CREATE POLICY "incomes_update_org_scoped" ON "public"."incomes"
  FOR UPDATE TO "authenticated"
  USING (
    "core"."same_org"("organization_id")
    AND (("auth"."uid"() = "user_id") OR "core"."is_finance_head"())
    AND "journal_entry_id" IS NULL
  )
  WITH CHECK (
    "core"."same_org"("organization_id")
    AND (("auth"."uid"() = "user_id") OR "core"."is_finance_head"())
    AND "journal_entry_id" IS NULL
  );

DROP POLICY IF EXISTS "incomes_delete_org_scoped" ON "public"."incomes";
CREATE POLICY "incomes_delete_org_scoped" ON "public"."incomes"
  FOR DELETE TO "authenticated"
  USING (
    "core"."same_org"("organization_id")
    AND (("auth"."uid"() = "user_id") OR "core"."is_finance_head"())
    AND "journal_entry_id" IS NULL
  );

COMMIT;