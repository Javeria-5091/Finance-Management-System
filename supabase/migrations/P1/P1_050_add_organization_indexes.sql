-- =============================================================================
-- Migration: 038_add_organization_indexes.sql
-- Purpose:   Every RLS policy touched in migration 039 will filter on
--            organization_id via core.same_org()/core.current_user_org_id().
--            Without an index, every SELECT/UPDATE/DELETE on these tables
--            forces a sequential scan to evaluate the policy predicate.
--            This is a straightforward, low-risk performance fix that
--            belongs alongside the organization-scoping work.
--
-- Safety: CREATE INDEX IF NOT EXISTS -- fully additive, no locking beyond a
--         normal index build. For very large existing tables, consider
--         changing these to CREATE INDEX CONCURRENTLY (cannot run inside a
--         transaction block / this migration's BEGIN...COMMIT) if the
--         table is large enough that a brief write-lock is unacceptable.
-- =============================================================================

BEGIN;

CREATE INDEX IF NOT EXISTS "idx_invoices_organization_id" ON "public"."invoices" USING "btree" ("organization_id");
CREATE INDEX IF NOT EXISTS "idx_expenses_organization_id" ON "public"."expenses" USING "btree" ("organization_id");
CREATE INDEX IF NOT EXISTS "idx_projects_organization_id" ON "public"."projects" USING "btree" ("organization_id");
CREATE INDEX IF NOT EXISTS "idx_budgets_organization_id" ON "public"."budgets" USING "btree" ("organization_id");
CREATE INDEX IF NOT EXISTS "idx_clients_organization_id" ON "public"."clients" USING "btree" ("organization_id");
CREATE INDEX IF NOT EXISTS "idx_audit_log_organization_id" ON "audit"."audit_log" USING "btree" ("organization_id");

CREATE INDEX IF NOT EXISTS "idx_je_organization_id" ON "finance"."journal_entries" USING "btree" ("organization_id");
CREATE INDEX IF NOT EXISTS "idx_coa_organization_id" ON "finance"."chart_of_accounts" USING "btree" ("organization_id");
CREATE INDEX IF NOT EXISTS "idx_fa_organization_id" ON "finance"."financial_accounts" USING "btree" ("organization_id");
CREATE INDEX IF NOT EXISTS "idx_vb_organization_id" ON "finance"."vendor_bills" USING "btree" ("organization_id");

-- profiles.organization_id backs core.current_user_org_id(), which is
-- invoked by same_org() on every RLS check across the whole schema. It
-- was previously unindexed.
CREATE INDEX IF NOT EXISTS "idx_profiles_organization_id" ON "public"."profiles" USING "btree" ("organization_id");

COMMIT;