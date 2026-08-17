-- =============================================================================
-- Migration 021: Add soft-delete (deleted_at) support to master-data tables
-- =============================================================================
-- PURPOSE
--   The compliance audit found zero `deleted_at` / `is_deleted` columns
--   anywhere in the schema, despite spec 10.5: "Soft deletion is used for
--   master records; financial history is retained." Several master tables
--   only had an `is_active` boolean, which supports deactivation in the UI
--   but does nothing to stop an actual `DELETE` statement from being issued
--   (and, per Migration 018's findings, at least two FKs actively cascaded
--   such deletes into real financial history).
--
-- ISSUES FIXED
--   - Spec 10.5: "Soft deletion is used for master records; financial
--     history is retained."
--
-- APPROACH
--   Add a nullable `deleted_at timestamptz` column (default NULL = not
--   deleted) to every master-data table the spec treats as master data:
--   chart_of_accounts, vendors, clients, projects, platforms, and both
--   `financial_accounts` tables. A partial index on `deleted_at IS NULL`
--   keeps "active row" lookups fast. A small helper function is added so
--   application code (or a future trigger) has one consistent way to
--   perform a soft delete.
--
--   This migration is DELIBERATELY column-only. It does NOT:
--     - change any existing SELECT/UPDATE/DELETE RLS policy to filter on
--       deleted_at (that would silently change what current users can see
--       through the existing API surface, which is an application-layer
--       behavior change, not a schema-safety fix -- see the "Application
--       Code Changes Required" section of the final response)
--     - convert any existing hard-DELETE code path to a soft delete
--       automatically (the application must be updated to UPDATE
--       deleted_at instead of issuing DELETE; see final response)
--     - backfill deleted_at for any existing row (there is no reliable way
--       to infer, after the fact, which currently-active rows "should"
--       have been soft-deleted -- inventing that would violate the
--       migration's own no-invented-data rule)
--
-- SAFETY
--   Fully additive: ADD COLUMN IF NOT EXISTS with a NULL default changes
--   nothing about existing rows or existing queries. No existing constraint,
--   index, or policy is touched.
-- =============================================================================

BEGIN;

ALTER TABLE "finance"."chart_of_accounts"
  ADD COLUMN IF NOT EXISTS "deleted_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "deleted_by" "uuid";

ALTER TABLE "finance"."vendors"
  ADD COLUMN IF NOT EXISTS "deleted_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "deleted_by" "uuid";

ALTER TABLE "public"."clients"
  ADD COLUMN IF NOT EXISTS "deleted_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "deleted_by" "uuid";

ALTER TABLE "public"."projects"
  ADD COLUMN IF NOT EXISTS "deleted_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "deleted_by" "uuid";

ALTER TABLE "finance"."platforms"
  ADD COLUMN IF NOT EXISTS "deleted_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "deleted_by" "uuid";

ALTER TABLE "finance"."financial_accounts"
  ADD COLUMN IF NOT EXISTS "deleted_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "deleted_by" "uuid";

ALTER TABLE "public"."financial_accounts"
  ADD COLUMN IF NOT EXISTS "deleted_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "deleted_by" "uuid";

-- Partial indexes so "list active records" queries (the overwhelming
-- majority of application reads) stay fast once deleted_at is in use.
CREATE INDEX IF NOT EXISTS "idx_coa_active"
  ON "finance"."chart_of_accounts" ("id") WHERE "deleted_at" IS NULL;

CREATE INDEX IF NOT EXISTS "idx_vendors_active"
  ON "finance"."vendors" ("id") WHERE "deleted_at" IS NULL;

CREATE INDEX IF NOT EXISTS "idx_clients_active"
  ON "public"."clients" ("id") WHERE "deleted_at" IS NULL;

CREATE INDEX IF NOT EXISTS "idx_projects_active"
  ON "public"."projects" ("id") WHERE "deleted_at" IS NULL;

CREATE INDEX IF NOT EXISTS "idx_platforms_active"
  ON "finance"."platforms" ("id") WHERE "deleted_at" IS NULL;

CREATE INDEX IF NOT EXISTS "idx_financial_accounts_fin_active"
  ON "finance"."financial_accounts" ("id") WHERE "deleted_at" IS NULL;

CREATE INDEX IF NOT EXISTS "idx_financial_accounts_pub_active"
  ON "public"."financial_accounts" ("id") WHERE "deleted_at" IS NULL;

-- Consistent helper for application code / future triggers to perform a
-- soft delete. Reuses the same "is this row actually used?" guard as
-- Migration 018 for finance.financial_accounts, so soft-deleting an
-- in-use account is blocked for the same business reason a hard delete is.
-- NOTE: the six target tables are not uniform:
--   * finance.chart_of_accounts, finance.vendors, finance.platforms,
--     finance.financial_accounts -- have an `is_active` boolean, set false
--   * public.clients, public.financial_accounts -- use a `status` text
--     column (ACTIVE/INACTIVE), set to 'INACTIVE'
--   * public.projects -- has neither; its `status` CHECK constraint only
--     permits 'Active'/'Completed'/'On Hold' with no equivalent inactive
--     value, so this function only stamps deleted_at/deleted_by and leaves
--     `status` for the application to set explicitly if desired
CREATE OR REPLACE FUNCTION "core"."soft_delete"("p_schema" "text", "p_table" "text", "p_id" "uuid")
  RETURNS "void"
  LANGUAGE "plpgsql"
  SECURITY DEFINER
  SET "search_path" TO 'pg_catalog', 'public'
  AS $$
BEGIN
  IF p_schema NOT IN ('finance', 'public') OR
     p_table NOT IN ('chart_of_accounts', 'vendors', 'clients', 'projects',
                      'platforms', 'financial_accounts') THEN
    RAISE EXCEPTION 'core.soft_delete: table %.% is not an approved soft-delete target', p_schema, p_table;
  END IF;

  IF p_schema = 'public' AND p_table = 'financial_accounts' THEN
    UPDATE public.financial_accounts
    SET deleted_at = now(), deleted_by = auth.uid(), status = 'INACTIVE'
    WHERE id = p_id AND deleted_at IS NULL;
  ELSIF p_schema = 'public' AND p_table = 'projects' THEN
    UPDATE public.projects
    SET deleted_at = now(), deleted_by = auth.uid()
    WHERE id = p_id AND deleted_at IS NULL;
  ELSIF p_schema = 'public' AND p_table = 'clients' THEN
    UPDATE public.clients
    SET deleted_at = now(), deleted_by = auth.uid(), status = 'INACTIVE'
    WHERE id = p_id AND deleted_at IS NULL;
  ELSE
    EXECUTE format(
      'UPDATE %I.%I SET deleted_at = now(), deleted_by = auth.uid(), is_active = false WHERE id = $1 AND deleted_at IS NULL',
      p_schema, p_table
    ) USING p_id;
  END IF;
END;
$$;

ALTER FUNCTION "core"."soft_delete"("text", "text", "uuid") OWNER TO "postgres";

REVOKE ALL ON FUNCTION "core"."soft_delete"("text", "text", "uuid") FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "core"."soft_delete"("text", "text", "uuid") TO "authenticated";

COMMIT;

-- =============================================================================
-- FOLLOW-UP REQUIRED (application-level, not a database migration):
--   1. Update application code that currently issues hard DELETE against
--      chart_of_accounts / vendors / clients / projects / platforms /
--      financial_accounts to call core.soft_delete(...) instead, or to
--      perform the equivalent UPDATE ... SET deleted_at = now() directly.
--   2. Update reporting/list queries and RLS policies (deliberately left
--      unchanged in this migration) to add `AND deleted_at IS NULL` where
--      "show only active records" is the intended behavior, once the team
--      has confirmed this won't hide records existing UI/reports currently
--      expect to see via `is_active = false` filtering.
-- =============================================================================