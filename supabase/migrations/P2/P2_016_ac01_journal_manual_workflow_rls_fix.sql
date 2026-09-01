-- =====================================================================
-- Finance Management System — Critical Fix
--   AC-01 (P0): Manual journal workflow is dead-ended by RLS.
--
-- Root cause: the only UPDATE policy on finance.journal_entries is
--
--   CREATE POLICY "je_update" ON finance.journal_entries FOR UPDATE
--     USING ((is_finance_head() OR has_role('ACCOUNTANT'))
--            AND status = 'DRAFT' AND same_org(organization_id));
--
-- with no WITH CHECK clause. In PostgreSQL, an UPDATE policy with no
-- WITH CHECK defaults the check expression to the USING expression, so
-- the resulting (NEW) row is ALSO required to satisfy status = 'DRAFT'.
--
-- Concretely, for every transition the workflow route
-- (src/app/api/finance/workflow/route.ts) drives:
--   * submit  (DRAFT -> SUBMITTED): OLD row passes USING (status=DRAFT),
--     but the implicit WITH CHECK re-evaluates the same expression
--     against the NEW row, whose status is now SUBMITTED -> rejected
--     with 42501 (RLS policy violation).
--   * verify/approve/reject/reopen (SUBMITTED/VERIFIED/REJECTED ->
--     anything): the OLD row's status is never DRAFT, so USING itself
--     excludes the row -> the conditional UPDATE in the workflow route
--     (`.eq('status', currentStatus)`) matches 0 rows -> the route's
--     TOCTOU guard reports 409 Concurrent modification, even though
--     nothing else touched the row.
--
-- Net effect: a manually created journal entry can never leave DRAFT
-- through the workflow route. Only the *_atomic posting RPCs (which run
-- SECURITY DEFINER and effectively bypass this policy) ever move a
-- journal to POSTED, so the entire manual journal entry module (create
-- -> submit -> verify -> approve -> post) is non-functional end to end.
--
-- Fix: replace the single blanket "status = 'DRAFT'" gate with a gate
-- that matches how every sibling finance table already does this
-- (finance.vendor_bills' "vb_update", finance.credit_notes'
-- "cn_update_org_scoped", public.expenses/incomes/invoices' *_update_
-- org_scoped policies): allow role+org-scoped updates for any row that
-- is not yet locked into the ledger, and forbid updates once it is.
-- journal_entries has no separate "journal_entry_id is null" flag the
-- way expense/income/invoice do (a journal entry doesn't point to
-- itself), so the equivalent lock condition here is the terminal
-- statuses themselves: POSTED and REVERSED. Both directions of the
-- generic UPDATE (old row via USING, new row via an explicit WITH
-- CHECK) are gated the same way, so:
--   * DRAFT <-> SUBMITTED <-> VERIFIED <-> APPROVED <-> REJECTED <->
--     DRAFT (reopen) all remain updatable by Finance Head / Accountant
--     in their own org, matching the transitions actually wired up in
--     the workflow route.
--   * POSTED and REVERSED rows can never be UPDATEd through this
--     policy by an ordinary authenticated request — posting is only
--     ever done via finance.post_existing_journal_entry() /
--     finance.approve_and_post_journal_entry(), and reversal only via
--     finance.reverse_journal_entry(), all SECURITY DEFINER functions
--     owned by postgres that run outside this policy's role context.
--     This preserves posted/reversed-journal immutability, consistent
--     with the equivalent guarantee already given to expenses/incomes/
--     invoices via their "journal_entry_id IS NULL" clause.
--
-- This is a policy-only change. It does not weaken any other control:
--   * finance.enforce_maker_checker() (trg_maker_checker on
--     journal_entries) still independently rejects an UPDATE where
--     approved_by = created_by, regardless of RLS.
--   * finance.prevent_closed_period_posting() (trg_prevent_closed_period
--     / trg_prevent_closed_period_posting) still independently blocks
--     any UPDATE into a closed accounting period.
--   * The workflow route's own application-level maker-checker check,
--     permission check, approval-limit check and period-open check are
--     unchanged and still run before this policy is ever evaluated.
--   * The route's existing TOCTOU-safe conditional update pattern
--     (`.eq('id', recordId).eq('status', currentStatus)
--       .eq('organization_id', auth.orgId)`) is untouched by this
--     migration and continues to work exactly as it does for the other
--     modules that share this route (expense, invoice, vendor bill,
--     credit note, income, capital transaction).
-- =====================================================================

BEGIN;

DROP POLICY IF EXISTS "je_update" ON "finance"."journal_entries";

CREATE POLICY "je_update" ON "finance"."journal_entries"
  FOR UPDATE
  USING (
    (core.is_finance_head() OR core.has_role('ACCOUNTANT'))
    AND status NOT IN ('POSTED', 'REVERSED')
    AND core.same_org(organization_id)
  )
  WITH CHECK (
    (core.is_finance_head() OR core.has_role('ACCOUNTANT'))
    AND status NOT IN ('POSTED', 'REVERSED')
    AND core.same_org(organization_id)
  );

COMMENT ON POLICY "je_update" ON "finance"."journal_entries" IS
  'AC-01 FIX (P0): previously USING-only with status = ''DRAFT'', which — '
  'because PostgreSQL defaults an omitted WITH CHECK to the USING '
  'expression — required the post-update row to ALSO be DRAFT, so no '
  'workflow transition (submit/verify/approve/reject/reopen) could ever '
  'succeed via the shared finance workflow route. Now allows Finance '
  'Head/Accountant, in their own org, to update a journal entry in any '
  'status except POSTED/REVERSED (both directions of the update are '
  'checked), matching the immutability pattern already used by '
  'finance.vendor_bills / finance.credit_notes / public.expenses / '
  'public.incomes / public.invoices. POSTED and REVERSED remain '
  'reachable only through the SECURITY DEFINER RPCs '
  '(post_existing_journal_entry / approve_and_post_journal_entry / '
  'reverse_journal_entry), which run outside this policy.';

COMMIT;