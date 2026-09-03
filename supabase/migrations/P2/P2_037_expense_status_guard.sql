-- =============================================================================
-- Migration: P2_034_expense_status_guard.sql
-- Purpose:   Fixes EXP-02 (Severity P1).
--
--   EXP-02  expenses_update_org_scoped / expenses_delete_org_scoped only
--           gated on "journal_entry_id IS NULL" (added by P1_087 to protect
--           POSTED rows). journal_entry_id stays NULL all the way through
--           SUBMITTED and APPROVED -- it's only set when the expense is
--           actually posted to the GL -- so an owner could still edit or
--           delete their own expense after it was approved, entirely via
--           the browser's direct PostgREST call:
--             supabase.from('expenses').update({amount: 999999}).eq('id', id)
--           The dashboard's "Only DRAFT expenses can be edited/deleted"
--           check (src/app/dashboard/expenses/page.tsx) was client-side
--           only. /api/finance/post-expense then posts whatever amount the
--           row carries at that moment -- not the amount the approver
--           actually approved (Spec 12.9: a service must reject changes
--           not allowed for the current status).
--
-- Fix:       Two independent, narrowly-scoped guards:
--
--   1. expenses_delete_org_scoped gets an explicit "status = 'DRAFT'"
--      predicate. DELETE is all-or-nothing (no partial-field concern like
--      UPDATE has below) and no code path -- including the workflow API --
--      ever deletes an expense row, so this cannot break any legitimate
--      flow.
--
--   2. A BEFORE UPDATE trigger on public.expenses blocks changes to the
--      financial/descriptive fields (amount, title, category,
--      expense_date, currency, exchange_rate, project_id, account_id,
--      vendor_id, notes) whenever the row being updated is not currently
--      DRAFT. This is deliberately a trigger and NOT an extra predicate on
--      expenses_update_org_scoped, because the UPDATE policy is also used
--      by the legitimate status-transition path
--      (/api/finance/workflow submit/verify/approve/reject/reverse/reopen,
--      and finance.reverse_expense_atomic / post_expense_atomic), which
--      runs through the same request-scoped RLS client and must still be
--      able to flip a non-DRAFT row's status/approval metadata. A blanket
--      "status = 'DRAFT'" USING clause on the UPDATE policy would block
--      those transitions outright (e.g. reopen moves a REJECTED row, not a
--      DRAFT one). The trigger instead allows status/workflow-metadata
--      columns to change at any status, but locks the fields that actually
--      determine the transaction's value the moment the row leaves DRAFT --
--      which is exactly the gap this finding describes. A row that needs a
--      genuine correction goes back through the existing reopen action
--      (status -> DRAFT) first, same as every other module in this system.
--
--      This also protects the row against any future direct-SQL or
--      service-role write path that bypasses RLS entirely -- RLS predicates
--      alone can't do that, but a table trigger always fires.
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. DELETE: only a DRAFT expense may be deleted.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "expenses_delete_org_scoped" ON "public"."expenses";
CREATE POLICY "expenses_delete_org_scoped" ON "public"."expenses"
  FOR DELETE TO "authenticated"
  USING (
    "core"."same_org"("organization_id")
    AND (("auth"."uid"() = "user_id") OR "public"."is_admin"())
    AND "journal_entry_id" IS NULL
    AND "status" = 'DRAFT'
  );

-- ---------------------------------------------------------------------------
-- 2. UPDATE: financial/descriptive fields become immutable once the row
--    leaves DRAFT, regardless of who is writing or which RLS policy let the
--    UPDATE through.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION "public"."enforce_expense_fields_immutable_after_draft"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status <> 'DRAFT' THEN
    IF NEW.amount IS DISTINCT FROM OLD.amount
    OR NEW.title IS DISTINCT FROM OLD.title
    OR NEW.category IS DISTINCT FROM OLD.category
    OR NEW.expense_date IS DISTINCT FROM OLD.expense_date
    OR NEW.currency IS DISTINCT FROM OLD.currency
    OR NEW.exchange_rate IS DISTINCT FROM OLD.exchange_rate
    OR NEW.project_id IS DISTINCT FROM OLD.project_id
    OR NEW.account_id IS DISTINCT FROM OLD.account_id
    OR NEW.vendor_id IS DISTINCT FROM OLD.vendor_id
    OR NEW.notes IS DISTINCT FROM OLD.notes
    THEN
      RAISE EXCEPTION
        'Expense % cannot have its amount or details changed once it has left DRAFT status (current status: %). Reopen it first (status -> DRAFT) to make corrections.',
        OLD.id, OLD.status
        USING ERRCODE = '23514'; -- check_violation, so callers can distinguish this from a generic 500
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "trg_expenses_immutable_after_draft" ON "public"."expenses";
CREATE TRIGGER "trg_expenses_immutable_after_draft"
  BEFORE UPDATE ON "public"."expenses"
  FOR EACH ROW
  EXECUTE FUNCTION "public"."enforce_expense_fields_immutable_after_draft"();

COMMENT ON TRIGGER "trg_expenses_immutable_after_draft" ON "public"."expenses" IS
  'EXP-02: blocks amount/title/category/expense_date/currency/exchange_rate/project_id/account_id/vendor_id/notes changes once status leaves DRAFT. Status + workflow metadata (submitted_by/at, verified_by/at, approved_by/at, rejection_reason, reversal fields, journal_entry_id, posted_at, etc.) may still change so submit/verify/approve/reject/reverse/reopen and posting continue to work unmodified.';

COMMIT;