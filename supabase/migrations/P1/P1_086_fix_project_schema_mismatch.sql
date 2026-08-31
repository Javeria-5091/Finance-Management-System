-- =====================================================================
-- FND-PROJ-001 (P0): public.projects is missing every column the
-- Projects API inserts/updates, and its status CHECK constraint only
-- allows the legacy vocabulary (Active/Completed/On Hold).
--
-- Affected code (unchanged by this migration, already assumes this
-- schema):
--   src/app/api/projects/route.ts            POST
--   src/app/api/projects/[id]/route.ts        PATCH, DELETE
--   src/services/project.service.ts           createProject/closeProject
--
-- This migration only ALTERs public.projects. It is purely additive
-- (new nullable/defaulted columns, a widened CHECK) plus relaxing two
-- legacy NOT NULL constraints that the current API contract does not
-- populate — nothing here removes or renames a column, so existing
-- rows, existing RLS policies, and any code still reading/writing the
-- legacy columns (user_id, client_name, status = Active/Completed/On
-- Hold) keep working unchanged.
--
-- Idempotent: safe to run more than once.
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- 1. Add every column the API inserts/updates that does not exist yet.
-- ---------------------------------------------------------------------
ALTER TABLE "public"."projects"
  ADD COLUMN IF NOT EXISTS "project_code"     character varying(50),
  ADD COLUMN IF NOT EXISTS "client_id"        uuid,
  ADD COLUMN IF NOT EXISTS "manager_id"       uuid,
  ADD COLUMN IF NOT EXISTS "platform"         character varying(100),
  ADD COLUMN IF NOT EXISTS "contract_value"   numeric(18,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "currency"         text DEFAULT 'PKR',
  ADD COLUMN IF NOT EXISTS "budget_amount"    numeric(18,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "department"       character varying(100),
  ADD COLUMN IF NOT EXISTS "cost_center"      character varying(100),
  ADD COLUMN IF NOT EXISTS "is_confidential"  boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS "is_active"        boolean DEFAULT true,
  ADD COLUMN IF NOT EXISTS "created_by"       uuid,
  ADD COLUMN IF NOT EXISTS "closure_reason"   text,
  ADD COLUMN IF NOT EXISTS "closed_by"        uuid,
  ADD COLUMN IF NOT EXISTS "closed_at"        timestamp with time zone;

-- ---------------------------------------------------------------------
-- 2. Foreign keys, following the same conventions already used
--    elsewhere in this schema (client_id -> clients(id),
--    created_by/closed_by -> auth.users(id), manager_id -> the unique
--    profiles.user_id, exactly like profiles.manager_id itself does).
-- ---------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'projects_client_id_fkey'
  ) THEN
    ALTER TABLE "public"."projects"
      ADD CONSTRAINT "projects_client_id_fkey"
      FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'projects_manager_id_fkey'
  ) THEN
    ALTER TABLE "public"."projects"
      ADD CONSTRAINT "projects_manager_id_fkey"
      FOREIGN KEY ("manager_id") REFERENCES "public"."profiles"("user_id") ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'projects_created_by_fkey'
  ) THEN
    ALTER TABLE "public"."projects"
      ADD CONSTRAINT "projects_created_by_fkey"
      FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'projects_closed_by_fkey'
  ) THEN
    ALTER TABLE "public"."projects"
      ADD CONSTRAINT "projects_closed_by_fkey"
      FOREIGN KEY ("closed_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'projects_project_code_key'
  ) THEN
    ALTER TABLE "public"."projects"
      ADD CONSTRAINT "projects_project_code_key" UNIQUE ("project_code");
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- 3. Status vocabulary: the API/services layer uses
--    ACTIVE / ON_HOLD / CLOSED / CANCELLED (see projectUpdateSchema,
--    project.service.ts, DELETE handler). The existing CHECK only
--    allowed the legacy Active / Completed / On Hold values used by
--    the dashboard's ProjectForm. Widen the CHECK to accept both so
--    neither call site regresses.
-- ---------------------------------------------------------------------
ALTER TABLE "public"."projects" DROP CONSTRAINT IF EXISTS "projects_status_check";
ALTER TABLE "public"."projects"
  ADD CONSTRAINT "projects_status_check"
  CHECK ((("status")::"text" = ANY ((ARRAY[
    'Active','Completed','On Hold',                 -- legacy vocabulary
    'ACTIVE','ON_HOLD','CLOSED','CANCELLED'          -- API vocabulary
  ])::"text"[])));

-- ---------------------------------------------------------------------
-- 4. Relax legacy NOT NULL constraints the current API contract does
--    not (and, per the new client_id/manager_id/created_by columns,
--    no longer needs to) populate on every insert. Existing rows and
--    any code path that still supplies these values are unaffected —
--    this only stops NEW inserts that omit them from failing.
-- ---------------------------------------------------------------------
ALTER TABLE "public"."projects" ALTER COLUMN "user_id" DROP NOT NULL;
ALTER TABLE "public"."projects" ALTER COLUMN "client_name" DROP NOT NULL;
ALTER TABLE "public"."projects" ALTER COLUMN "start_date" DROP NOT NULL;

-- ---------------------------------------------------------------------
-- 5. Supporting indexes for the new filter/join columns used by
--    GET /api/projects (client_id, manager_id) and project_code search.
-- ---------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS "idx_projects_client_id"   ON "public"."projects" USING "btree" ("client_id");
CREATE INDEX IF NOT EXISTS "idx_projects_manager_id"  ON "public"."projects" USING "btree" ("manager_id");
CREATE INDEX IF NOT EXISTS "idx_projects_project_code" ON "public"."projects" USING "btree" ("project_code");

COMMENT ON TABLE "public"."projects" IS 'Project master data. Organization-scoped. Soft deletion uses deleted_at/deleted_by. status accepts both the legacy Active/Completed/On Hold vocabulary (dashboard ProjectForm) and the ACTIVE/ON_HOLD/CLOSED/CANCELLED vocabulary used by the Projects API and project.service.ts.';

COMMIT;