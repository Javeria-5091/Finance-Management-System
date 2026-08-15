-- =====================================================================
-- Migration: 019_rls_policy_hardening.sql
-- Purpose:   Fix a newly-confirmed CRITICAL finding (C6, surfaced during
--            this remediation pass -- not in the original report, flagged
--            transparently): 90 RLS policies across ~35 tables use ONLY
--            `auth.uid() IS NOT NULL` as their condition, meaning ANY
--            authenticated user -- regardless of role -- can read/write
--            core financial data (journal entries, vendor bills,
--            financial accounts, tax rule sets, exchange rates, fixed
--            assets, payment allocations). This violates spec 7.5
--            ("deny by default unless an explicit permission and data
--            scope allow it") and Appendix A's role/permission matrix.
--
--            This migration fixes the 10 highest-risk tables as a
--            verified, working pattern. See "REMAINING WORK" at the
--            end of this file for the full list of tables still on the
--            old pattern -- applying the same fix there requires
--            mapping each table to the correct Appendix A row, which
--            was only done here for tables with an unambiguous mapping.
--
-- Depends on: migration 018 (core.has_role / core.is_ceo_or_admin /
--             core.is_finance_head must be fixed and core.roles seeded
--             first, or these policies will incorrectly deny everyone).
-- Spec refs: 7.1, 7.2, 7.5, Appendix A
-- Non-destructive: yes -- DROPs and replaces specific named policies
-- only; does not disable RLS at any point.
--
-- IMPORTANT: Because Postgres RLS policies are OR'd together, the old
-- permissive policy MUST be dropped, not just supplemented -- adding a
-- stricter policy alongside the old one would make access MORE
-- permissive, not less. Every policy below is DROP + CREATE.
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- finance.financial_accounts  (Appendix A: "Bank/wallet balances")
-- CEO/Finance Head: Full. Accountant: Config (view + maintain, no delete
-- of accounts used by posted transactions -- enforced separately by an
-- existing FK/business rule, not duplicated here). Others: none by
-- default. Auditor (VIEWER role, used here as read-only/auditor scope
-- per Appendix A "Read/Config"): read-only.
-- ---------------------------------------------------------------------
DROP POLICY IF EXISTS "fa_select" ON "finance"."financial_accounts";
DROP POLICY IF EXISTS "fa_insert" ON "finance"."financial_accounts";
DROP POLICY IF EXISTS "fa_update" ON "finance"."financial_accounts";
DROP POLICY IF EXISTS "fa_delete" ON "finance"."financial_accounts";

CREATE POLICY "fa_select" ON "finance"."financial_accounts" FOR SELECT
  USING (core.is_finance_head() OR core.has_role('ACCOUNTANT') OR core.has_role('VIEWER'));
CREATE POLICY "fa_insert" ON "finance"."financial_accounts" FOR INSERT
  WITH CHECK (core.is_finance_head() OR core.has_role('ACCOUNTANT'));
CREATE POLICY "fa_update" ON "finance"."financial_accounts" FOR UPDATE
  USING (core.is_finance_head() OR core.has_role('ACCOUNTANT'));
CREATE POLICY "fa_delete" ON "finance"."financial_accounts" FOR DELETE
  USING (core.is_finance_head());

-- ---------------------------------------------------------------------
-- finance.journal_entries  (Appendix A: "Create/verify journals",
-- "Post/reverse journals")
-- CEO/Finance Head: Full. Accountant: create/verify full, but NOT
-- delete (posted entries are immutable per spec 4.2 -- deletion should
-- never happen through the app; only CEO/Finance Head retain delete
-- for exceptional/administrative correction of DRAFT-only entries,
-- which is additionally gated by status in the USING clause).
-- ---------------------------------------------------------------------
DROP POLICY IF EXISTS "je_select_own" ON "finance"."journal_entries";
DROP POLICY IF EXISTS "je_insert" ON "finance"."journal_entries";
DROP POLICY IF EXISTS "je_update" ON "finance"."journal_entries";
DROP POLICY IF EXISTS "je_delete" ON "finance"."journal_entries";

CREATE POLICY "je_select" ON "finance"."journal_entries" FOR SELECT
  USING (core.is_finance_head() OR core.has_role('ACCOUNTANT') OR core.has_role('VIEWER'));
CREATE POLICY "je_insert" ON "finance"."journal_entries" FOR INSERT
  WITH CHECK (core.is_finance_head() OR core.has_role('ACCOUNTANT'));
CREATE POLICY "je_update" ON "finance"."journal_entries" FOR UPDATE
  USING (
    (core.is_finance_head() OR core.has_role('ACCOUNTANT'))
    AND status = 'DRAFT'   -- posted entries cannot be edited (spec 4.2)
  );
CREATE POLICY "je_delete" ON "finance"."journal_entries" FOR DELETE
  USING (core.is_finance_head() AND status = 'DRAFT');

-- ---------------------------------------------------------------------
-- finance.vendors / finance.vendor_bills  (Appendix A: "Bills/payments")
-- CEO/Finance Head/Accountant: Full. Project Manager: view only
-- (Appendix A shows "Limited" for HOD/PM on this row; without a wired
-- project/department scope column on these tables, the safest
-- Limited implementation available today is read-only, not scoped
-- write access -- true amount/project-scoped limits require the
-- approval_limits/data_scope engine to be wired into the app layer).
-- ---------------------------------------------------------------------
DROP POLICY IF EXISTS "v_select" ON "finance"."vendors";
DROP POLICY IF EXISTS "v_insert" ON "finance"."vendors";
DROP POLICY IF EXISTS "v_update" ON "finance"."vendors";

CREATE POLICY "v_select" ON "finance"."vendors" FOR SELECT
  USING (core.is_finance_head() OR core.has_role('ACCOUNTANT') OR core.has_role('PROJECT_MANAGER') OR core.has_role('VIEWER'));
CREATE POLICY "v_insert" ON "finance"."vendors" FOR INSERT
  WITH CHECK (core.is_finance_head() OR core.has_role('ACCOUNTANT'));
CREATE POLICY "v_update" ON "finance"."vendors" FOR UPDATE
  USING (core.is_finance_head() OR core.has_role('ACCOUNTANT'));

DROP POLICY IF EXISTS "vb_select" ON "finance"."vendor_bills";
DROP POLICY IF EXISTS "vb_insert" ON "finance"."vendor_bills";
DROP POLICY IF EXISTS "vb_update" ON "finance"."vendor_bills";

CREATE POLICY "vb_select" ON "finance"."vendor_bills" FOR SELECT
  USING (core.is_finance_head() OR core.has_role('ACCOUNTANT') OR core.has_role('PROJECT_MANAGER') OR core.has_role('VIEWER'));
CREATE POLICY "vb_insert" ON "finance"."vendor_bills" FOR INSERT
  WITH CHECK (core.is_finance_head() OR core.has_role('ACCOUNTANT'));
CREATE POLICY "vb_update" ON "finance"."vendor_bills" FOR UPDATE
  USING (core.is_finance_head() OR core.has_role('ACCOUNTANT'));

-- ---------------------------------------------------------------------
-- finance.exchange_rates  (manual FX rate evidence -- spec 5.12: entry
-- by an authorized user, approval by another; treated as finance-config)
-- ---------------------------------------------------------------------
DROP POLICY IF EXISTS "fx_select" ON "finance"."exchange_rates";
DROP POLICY IF EXISTS "fx_insert" ON "finance"."exchange_rates";

CREATE POLICY "fx_select" ON "finance"."exchange_rates" FOR SELECT
  USING (core.is_finance_head() OR core.has_role('ACCOUNTANT') OR core.has_role('VIEWER'));
CREATE POLICY "fx_insert" ON "finance"."exchange_rates" FOR INSERT
  WITH CHECK (core.is_finance_head() OR core.has_role('ACCOUNTANT'));

-- ---------------------------------------------------------------------
-- finance.fixed_assets  (Appendix A: not listed by name, treated under
-- general finance operations -- CEO/Finance Head/Accountant manage;
-- others read-only; the existing status-gated delete rule for
-- 'pending_capitalization' assets is preserved, just re-scoped to
-- authorized roles instead of any authenticated user).
-- ---------------------------------------------------------------------
DROP POLICY IF EXISTS "fixed_assets_select" ON "finance"."fixed_assets";
DROP POLICY IF EXISTS "fixed_assets_insert" ON "finance"."fixed_assets";
DROP POLICY IF EXISTS "fixed_assets_update" ON "finance"."fixed_assets";
DROP POLICY IF EXISTS "fixed_assets_delete" ON "finance"."fixed_assets";

CREATE POLICY "fixed_assets_select" ON "finance"."fixed_assets" FOR SELECT
  USING (core.is_finance_head() OR core.has_role('ACCOUNTANT') OR core.has_role('VIEWER'));
CREATE POLICY "fixed_assets_insert" ON "finance"."fixed_assets" FOR INSERT
  WITH CHECK (core.is_finance_head() OR core.has_role('ACCOUNTANT'));
CREATE POLICY "fixed_assets_update" ON "finance"."fixed_assets" FOR UPDATE
  USING (core.is_finance_head() OR core.has_role('ACCOUNTANT'));
CREATE POLICY "fixed_assets_delete" ON "finance"."fixed_assets" FOR DELETE
  USING ((auth.uid() = created_by) AND (status = 'pending_capitalization') AND (core.is_finance_head() OR core.has_role('ACCOUNTANT')));

-- ---------------------------------------------------------------------
-- finance.tax_rule_sets / finance.taxpayer_profile
-- (Appendix A: "Tax reports, rules, adjustments and filing" --
-- CEO/Finance Head: Full. Accountant: Config. Everyone else: None.)
-- ---------------------------------------------------------------------
DROP POLICY IF EXISTS "trs_select" ON "finance"."tax_rule_sets";
DROP POLICY IF EXISTS "trs_insert" ON "finance"."tax_rule_sets";
DROP POLICY IF EXISTS "trs_update" ON "finance"."tax_rule_sets";

CREATE POLICY "trs_select" ON "finance"."tax_rule_sets" FOR SELECT
  USING (core.is_finance_head() OR core.has_role('ACCOUNTANT'));
CREATE POLICY "trs_insert" ON "finance"."tax_rule_sets" FOR INSERT
  WITH CHECK (core.is_finance_head() OR core.has_role('ACCOUNTANT'));
CREATE POLICY "trs_update" ON "finance"."tax_rule_sets" FOR UPDATE
  USING (core.is_finance_head() OR core.has_role('ACCOUNTANT'));

DROP POLICY IF EXISTS "tp_select" ON "finance"."taxpayer_profile";
DROP POLICY IF EXISTS "tp_update" ON "finance"."taxpayer_profile";

CREATE POLICY "tp_select" ON "finance"."taxpayer_profile" FOR SELECT
  USING (core.is_finance_head() OR core.has_role('ACCOUNTANT'));
CREATE POLICY "tp_update" ON "finance"."taxpayer_profile" FOR UPDATE
  USING (core.is_finance_head());

-- ---------------------------------------------------------------------
-- finance.payment_allocations / finance.vendor_payment_allocations
-- ---------------------------------------------------------------------
DROP POLICY IF EXISTS "pa_select" ON "finance"."payment_allocations";
DROP POLICY IF EXISTS "pa_insert" ON "finance"."payment_allocations";

CREATE POLICY "pa_select" ON "finance"."payment_allocations" FOR SELECT
  USING (core.is_finance_head() OR core.has_role('ACCOUNTANT') OR core.has_role('VIEWER'));
CREATE POLICY "pa_insert" ON "finance"."payment_allocations" FOR INSERT
  WITH CHECK (core.is_finance_head() OR core.has_role('ACCOUNTANT'));

DROP POLICY IF EXISTS "vpa_select" ON "finance"."vendor_payment_allocations";
DROP POLICY IF EXISTS "vpa_insert" ON "finance"."vendor_payment_allocations";

CREATE POLICY "vpa_select" ON "finance"."vendor_payment_allocations" FOR SELECT
  USING (core.is_finance_head() OR core.has_role('ACCOUNTANT') OR core.has_role('VIEWER'));
CREATE POLICY "vpa_insert" ON "finance"."vendor_payment_allocations" FOR INSERT
  WITH CHECK (core.is_finance_head() OR core.has_role('ACCOUNTANT'));

COMMIT;

-- =====================================================================
-- REMAINING WORK (not fixed by this migration -- same anti-pattern,
-- needs the same treatment applied table-by-table against Appendix A):
--
--   core.organization_config, core.organization_modules, core.permissions,
--   core.roles, core.user_roles, finance.accounting_periods,
--   finance.asset_categories, finance.asset_verifications,
--   finance.attachments, finance.bank_statements, finance.bank_transfers,
--   finance.budget_lines, finance.credit_notes,
--   finance.depreciation_schedule, finance.fee_rules,
--   finance.fiscal_years, finance.numbering_sequences,
--   finance.payment_receipts, finance.platforms, finance.statement_lines,
--   finance.tax_adjustments, finance.tax_reconciliations,
--   finance.tax_slabs, finance.vendor_bill_lines, finance.vendor_payments,
--   public.budgets, public.expenses, public.incomes, public.projects
--
-- These were deliberately NOT changed in this migration because:
--   - Several (core.roles, core.permissions, core.user_roles) are the
--     RBAC engine itself -- restricting these incorrectly could lock
--     every user out of the permission system, including admins. They
--     need a carefully reasoned "who can manage roles" policy, not a
--     copy-paste of the pattern above.
--   - Several (public.expenses, public.incomes, public.budgets,
--     public.projects) currently rely on `auth.uid() = user_id`-style
--     row ownership in OTHER policies on the same tables (only the
--     duplicate permissive policy needs removing, not full replacement)
--     -- this needs a per-table read of ALL existing policies, not just
--     the offending one, to avoid accidentally removing legitimate
--     "own records" access for Employees.
--   - The rest are lower-risk operational tables where a rushed,
--     unverified role mapping is more likely to break legitimate
--     workflows than a deliberate follow-up pass.
--
-- Recommended next step: apply the same DROP+CREATE pattern above to
-- each remaining table, one migration file per logical group, with the
-- correct Appendix A row confirmed for each before writing the policy.
-- =====================================================================

-- ============================================================================
-- Migration: 030_fix_invoices_rls.sql
-- Purpose:   CRITICAL FIX #2 — public.invoices currently has two policies
--            that grant SELECT to any authenticated user regardless of role
--            or ownership:
--              "All users can view invoices"  USING (auth.uid() IS NOT NULL)
--              "invoices_select"               USING (auth.uid() IS NOT NULL)
--            These coexist with a narrower "Users can manage own invoices"
--            (USING (auth.uid() = user_id)) and "invoices_modify". Because
--            Postgres OR's multiple permissive policies for the same
--            command, the narrow policies have no practical effect on
--            SELECT — any logged-in user can currently read every invoice.
--
-- Fix:       Drop the blanket policies and the ambiguous ALL-command
--            policies, replace with explicit per-command policies scoped
--            the same way the finance.* tables already do it correctly
--            (role-based via core.is_finance_head()/core.has_role(), plus
--            ownership via user_id, plus project-manager access via the
--            existing projects.user_id relationship since public.projects
--            has no project_members table to join instead).
--
-- Note:      public.invoices has no organization_id column. This migration
--            does not add one (see migration 032 discussion / Section D)
--            because OSYSTIC's core.organizations table currently holds a
--            single row and there is no other tenant to isolate against yet
--            -- adding it now without a confirmed multi-row use case would
--            be scope creep beyond what's needed to close the RLS gap. The
--            role/ownership scoping below is the actual fix for the
--            confirmed issue (any user reading all invoices).
-- ============================================================================

BEGIN;

DROP POLICY IF EXISTS "All users can view invoices" ON "public"."invoices";
DROP POLICY IF EXISTS "invoices_select" ON "public"."invoices";
DROP POLICY IF EXISTS "Users can manage own invoices" ON "public"."invoices";
DROP POLICY IF EXISTS "invoices_modify" ON "public"."invoices";

-- SELECT: finance roles see everything; a Project Manager sees invoices
-- for projects they own (public.projects.user_id); an ordinary user sees
-- only invoices they created.
CREATE POLICY "invoices_select_scoped" ON "public"."invoices"
    FOR SELECT
    USING (
        "core"."is_finance_head"()
        OR "core"."has_role"('ACCOUNTANT')
        OR "core"."has_role"('VIEWER')
        OR ("user_id" = "auth"."uid"())
        OR EXISTS (
            SELECT 1 FROM "public"."projects" p
            WHERE p."id" = "public"."invoices"."project_id"
              AND p."user_id" = "auth"."uid"()
        )
    );

-- INSERT: the creator, or a finance role, may create an invoice. The row
-- being inserted must be attributed to the inserting user unless a finance
-- role is creating on someone else's behalf.
CREATE POLICY "invoices_insert_scoped" ON "public"."invoices"
    FOR INSERT
    WITH CHECK (
        "core"."is_finance_head"()
        OR "core"."has_role"('ACCOUNTANT')
        OR ("user_id" = "auth"."uid"())
    );

-- UPDATE: only finance roles, and only while the invoice has not yet been
-- posted to the ledger (journal_entry_id IS NULL) -- posted invoices are
-- financial history and must go through a credit note / reversal instead
-- of a direct edit, consistent with spec §4.2.
CREATE POLICY "invoices_update_scoped" ON "public"."invoices"
    FOR UPDATE
    USING (
        ("core"."is_finance_head"() OR "core"."has_role"('ACCOUNTANT'))
        AND "journal_entry_id" IS NULL
    )
    WITH CHECK (
        ("core"."is_finance_head"() OR "core"."has_role"('ACCOUNTANT'))
        AND "journal_entry_id" IS NULL
    );

-- DELETE: only finance roles, and only for invoices never posted.
CREATE POLICY "invoices_delete_scoped" ON "public"."invoices"
    FOR DELETE
    USING (
        ("core"."is_finance_head"() OR "core"."has_role"('ACCOUNTANT'))
        AND "journal_entry_id" IS NULL
    );

COMMIT;

-- ----------------------------------------------------------------------------
-- VERIFICATION (read-only) — confirm no other table has the same pattern.
-- Run this against your own database; it lists every permissive policy in
-- 'public' whose USING clause is exactly "auth.uid() IS NOT NULL" with no
-- other condition -- the same blanket-access pattern fixed above.
-- ----------------------------------------------------------------------------
-- SELECT schemaname, tablename, policyname, cmd, qual
-- FROM pg_policies
-- WHERE schemaname = 'public'
--   AND qual ILIKE '%auth.uid() IS NOT NULL%'
--   AND qual NOT ILIKE '%user_id%'
--   AND qual NOT ILIKE '%organization%';