-- =====================================================================
-- Migration: 020_security_invoker_views.sql
-- Purpose:   Fix (H7): only 4 of ~49 views declared security_invoker.
--            Without it, a view runs with the privileges/row-visibility
--            of the view OWNER, not the querying user -- meaning RLS on
--            the underlying tables may not apply the way the caller
--            expects when queried through these views. This is
--            required for the AI text-to-SQL layer (spec 9.5) and any
--            role-scoped dashboard/report to be trustworthy.
-- Spec refs: 7.5, 9.5
-- Non-destructive: yes. Uses ALTER VIEW ... SET, which changes only the
-- view's execution option -- it does NOT redefine the view body, so
-- there is zero risk of transcription error in the SELECT logic.
-- REQUIRES PostgreSQL 15+ (security_invoker option). Supabase projects
-- created from 2023 onward are on PG15+; verify with `SELECT version();`
-- before running if your project predates that.
-- =====================================================================

BEGIN;

ALTER VIEW "audit"."v_unsafe_security_definer_functions" SET (security_invoker = true);

ALTER VIEW "finance"."account_type_summary" SET (security_invoker = true);
ALTER VIEW "finance"."coa_tree" SET (security_invoker = true);
ALTER VIEW "finance"."fiscal_year_summary" SET (security_invoker = true);
ALTER VIEW "finance"."postable_accounts" SET (security_invoker = true);
ALTER VIEW "finance"."sequence_status" SET (security_invoker = true);

ALTER VIEW "public"."chart_of_accounts" SET (security_invoker = true);
ALTER VIEW "public"."coa_tree" SET (security_invoker = true);
ALTER VIEW "public"."credit_notes" SET (security_invoker = true);
ALTER VIEW "public"."exchange_rates" SET (security_invoker = true);
ALTER VIEW "public"."general_ledger" SET (security_invoker = true);
ALTER VIEW "public"."journal_entries" SET (security_invoker = true);
ALTER VIEW "public"."journal_lines" SET (security_invoker = true);
ALTER VIEW "public"."organization_config" SET (security_invoker = true);
ALTER VIEW "public"."payment_allocations" SET (security_invoker = true);
ALTER VIEW "public"."payment_receipts" SET (security_invoker = true);
ALTER VIEW "public"."permissions" SET (security_invoker = true);
ALTER VIEW "public"."postable_accounts" SET (security_invoker = true);
ALTER VIEW "public"."role_permissions" SET (security_invoker = true);
ALTER VIEW "public"."roles" SET (security_invoker = true);
ALTER VIEW "public"."v_commission_by_person" SET (security_invoker = true);
ALTER VIEW "public"."v_commission_by_project" SET (security_invoker = true);
ALTER VIEW "public"."v_commission_by_type" SET (security_invoker = true);
ALTER VIEW "public"."v_commission_status_summary" SET (security_invoker = true);
ALTER VIEW "public"."v_contractor_costs" SET (security_invoker = true);
ALTER VIEW "public"."v_contractor_expirations" SET (security_invoker = true);
ALTER VIEW "public"."v_contractor_project_costs" SET (security_invoker = true);
ALTER VIEW "public"."v_payroll_summary" SET (security_invoker = true);
ALTER VIEW "public"."v_permissions" SET (security_invoker = true);
ALTER VIEW "public"."v_role_permissions" SET (security_invoker = true);
ALTER VIEW "public"."v_roles" SET (security_invoker = true);
ALTER VIEW "public"."v_subscription_renewals" SET (security_invoker = true);
ALTER VIEW "public"."v_subscription_spend" SET (security_invoker = true);
ALTER VIEW "public"."v_user_roles" SET (security_invoker = true);

ALTER VIEW "reporting"."budget_category_summary" SET (security_invoker = true);
ALTER VIEW "reporting"."budget_gl_actual" SET (security_invoker = true);
ALTER VIEW "reporting"."budget_vs_actual" SET (security_invoker = true);
ALTER VIEW "reporting"."general_ledger" SET (security_invoker = true);
ALTER VIEW "reporting"."payable_aging" SET (security_invoker = true);
ALTER VIEW "reporting"."receivable_aging" SET (security_invoker = true);
ALTER VIEW "reporting"."reconciliation_summary" SET (security_invoker = true);
ALTER VIEW "reporting"."unreconciled_lines" SET (security_invoker = true);

COMMIT;

-- NOTE: Enabling security_invoker means these views now enforce RLS
-- based on the CALLING user, not the view owner. If any of these views
-- were previously relied upon to give a low-privilege user broader
-- visibility than their own RLS would normally allow (a common but
-- unsafe pattern), that access will now correctly be restricted. Test
-- role-based dashboard access after applying this migration (see
-- verification queries).