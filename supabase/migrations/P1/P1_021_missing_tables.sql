-- =====================================================================
-- Migration: 021_missing_tables.sql
-- Purpose:   Add tables required by the specification that are
--            completely absent from the current schema:
--              (H4) finance.dimensions (departments/cost centers) +
--                   public.profiles.department_id / manager_id
--              (H5) finance.budget_revisions
--              (H8) core.approval_requests / approval_steps /
--                   approval_actions (generic maker-checker engine)
--              (H6) Appendix D employee/payroll integration contract:
--                   core.employee_links, finance.attendance_period_snapshots,
--                   core.integration_events, core.integration_failures,
--                   core.idempotency_keys
-- Spec refs: 5.1, 5.3, 5.4, 5.9, 7.3, 10.2, 10.3, 10.4, Appendix D
-- Non-destructive: yes. Pure additions (CREATE TABLE IF NOT EXISTS,
-- ADD COLUMN IF NOT EXISTS). Nothing existing is altered or dropped.
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- H4: Departments / cost centers as a generic dimension table
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "finance"."dimensions" (
    "id"          "uuid" DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    "organization_id" "uuid" NOT NULL REFERENCES "core"."organizations"("id") ON DELETE CASCADE,
    "type"        "text" NOT NULL,                -- e.g. 'DEPARTMENT', 'COST_CENTER', 'BUSINESS_UNIT'
    "code"        "text" NOT NULL,
    "name"        "text" NOT NULL,
    "parent_id"   "uuid" REFERENCES "finance"."dimensions"("id") ON DELETE SET NULL,
    "manager_user_id" "uuid",
    "is_active"   boolean DEFAULT true NOT NULL,
    "created_at"  timestamp with time zone DEFAULT now(),
    "updated_at"  timestamp with time zone DEFAULT now(),
    "created_by"  "uuid",
    CONSTRAINT "dimensions_type_check" CHECK ("type" IN ('DEPARTMENT','COST_CENTER','BUSINESS_UNIT')),
    CONSTRAINT "dimensions_org_code_unique" UNIQUE ("organization_id", "type", "code")
);

COMMENT ON TABLE "finance"."dimensions" IS
  'Departments / cost centers / business units transactions can be tagged against. Added migration 021 (audit issue H4).';

-- Link profiles to departments/managers as required by spec 5.1.
ALTER TABLE "public"."profiles" ADD COLUMN IF NOT EXISTS "department_id" "uuid" REFERENCES "finance"."dimensions"("id") ON DELETE SET NULL;
ALTER TABLE "public"."profiles" ADD COLUMN IF NOT EXISTS "manager_id" "uuid" REFERENCES "auth"."users"("id") ON DELETE SET NULL;

-- ---------------------------------------------------------------------
-- H5: Budget revision history (spec 5.4: "complete budget revision
-- history and reasons")
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "finance"."budget_revisions" (
    "id"              "uuid" DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    "budget_id"       "uuid" NOT NULL REFERENCES "public"."budgets"("id") ON DELETE CASCADE,
    "revision_number" integer NOT NULL,
    "previous_amount" numeric(18,2) NOT NULL,
    "revised_amount"  numeric(18,2) NOT NULL,
    "change_amount"   numeric(18,2) GENERATED ALWAYS AS ("revised_amount" - "previous_amount") STORED,
    "reason"          "text" NOT NULL,
    "requested_by"    "uuid" NOT NULL,
    "approved_by"     "uuid",
    "approved_at"     timestamp with time zone,
    "status"          "text" DEFAULT 'PENDING' NOT NULL,
    "created_at"      timestamp with time zone DEFAULT now(),
    CONSTRAINT "budget_revisions_status_check" CHECK ("status" IN ('PENDING','APPROVED','REJECTED')),
    CONSTRAINT "budget_revisions_reason_not_blank" CHECK (btrim("reason") <> ''),
    CONSTRAINT "budget_revisions_unique_number" UNIQUE ("budget_id", "revision_number")
);

COMMENT ON TABLE "finance"."budget_revisions" IS
  'Budget revision history with reasons and approvals. Added migration 021 (audit issue H5).';

-- ---------------------------------------------------------------------
-- H8: Generic maker-checker approval workflow engine
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "core"."approval_requests" (
    "id"              "uuid" DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    "entity_type"     "text" NOT NULL,     -- e.g. 'expense', 'vendor_bill', 'journal_entry'
    "entity_id"       "uuid" NOT NULL,
    "transaction_type" "text" NOT NULL,    -- maps to approval_limits.transaction_type
    "amount"          numeric(18,2),
    "currency"        "text" DEFAULT 'PKR',
    "requested_by"    "uuid" NOT NULL,
    "current_step"    integer DEFAULT 1 NOT NULL,
    "status"          "text" DEFAULT 'PENDING' NOT NULL,
    "created_at"      timestamp with time zone DEFAULT now(),
    "updated_at"      timestamp with time zone DEFAULT now(),
    CONSTRAINT "approval_requests_status_check" CHECK ("status" IN ('PENDING','APPROVED','REJECTED','ESCALATED','CANCELLED'))
);

CREATE TABLE IF NOT EXISTS "core"."approval_steps" (
    "id"                  "uuid" DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    "approval_request_id" "uuid" NOT NULL REFERENCES "core"."approval_requests"("id") ON DELETE CASCADE,
    "step_number"         integer NOT NULL,
    "required_role_id"    "uuid" REFERENCES "core"."roles"("id") ON DELETE SET NULL,
    "assigned_user_id"    "uuid",
    "sla_hours"           integer,
    "escalate_to_user_id" "uuid",
    "status"              "text" DEFAULT 'PENDING' NOT NULL,
    "created_at"          timestamp with time zone DEFAULT now(),
    CONSTRAINT "approval_steps_status_check" CHECK ("status" IN ('PENDING','APPROVED','REJECTED','ESCALATED','SKIPPED')),
    CONSTRAINT "approval_steps_unique_step" UNIQUE ("approval_request_id", "step_number")
);

CREATE TABLE IF NOT EXISTS "core"."approval_actions" (
    "id"                  "uuid" DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    "approval_step_id"    "uuid" NOT NULL REFERENCES "core"."approval_steps"("id") ON DELETE CASCADE,
    "actor_user_id"       "uuid" NOT NULL,
    "action"              "text" NOT NULL,
    "comment"             "text",
    "delegated_from"      "uuid",
    "created_at"          timestamp with time zone DEFAULT now(),
    CONSTRAINT "approval_actions_action_check" CHECK ("action" IN ('APPROVE','REJECT','ESCALATE','DELEGATE','RETURN'))
);

COMMENT ON TABLE "core"."approval_requests" IS 'Generic maker-checker approval chain header. Added migration 021 (audit issue H8).';
COMMENT ON TABLE "core"."approval_steps" IS 'Per-level approval steps with SLA/escalation. Added migration 021 (audit issue H8).';
COMMENT ON TABLE "core"."approval_actions" IS 'Immutable log of individual approve/reject/escalate/delegate actions. Added migration 021 (audit issue H8).';

-- ---------------------------------------------------------------------
-- H6 / Appendix D: Employee/payroll integration contract
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "core"."employee_links" (
    "id"                "uuid" DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    "shared_person_id"  "uuid" NOT NULL REFERENCES "core"."shared_people"("id") ON DELETE CASCADE,
    "source_module"     "text" NOT NULL DEFAULT 'FINANCE',
    "external_employee_id" "text",
    "schema_version"    integer DEFAULT 1 NOT NULL,
    "created_at"        timestamp with time zone DEFAULT now(),
    "updated_at"        timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "finance"."attendance_period_snapshots" (
    "id"                "uuid" DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    "shared_person_id"  "uuid" NOT NULL REFERENCES "core"."shared_people"("id") ON DELETE RESTRICT,
    "period_start"      "date" NOT NULL,
    "period_end"        "date" NOT NULL,
    "source_event_id"   "uuid",       -- links to core.integration_events
    "snapshot_payload"  "jsonb" NOT NULL,   -- immutable copy of attendance/leave/overtime inputs used
    "payload_hash"      "text" NOT NULL,
    "locked"            boolean DEFAULT true NOT NULL,
    "received_at"       timestamp with time zone DEFAULT now(),
    CONSTRAINT "attendance_snapshot_period_valid" CHECK ("period_end" >= "period_start"),
    CONSTRAINT "attendance_snapshot_unique" UNIQUE ("shared_person_id", "period_start", "period_end")
);

COMMENT ON TABLE "finance"."attendance_period_snapshots" IS
  'Immutable, versioned attendance/payroll-input snapshot consumed by payroll calculation. Once locked=true, snapshot_payload must never be edited -- payroll runs must reference this row, not live attendance data. Added migration 021 (audit issue H6 / Appendix D).';

CREATE TABLE IF NOT EXISTS "core"."integration_events" (
    "id"              "uuid" DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    "schema_version"  integer DEFAULT 1 NOT NULL,
    "source_module"   "text" NOT NULL,
    "event_type"      "text" NOT NULL,
    "organization_id" "uuid" REFERENCES "core"."organizations"("id") ON DELETE CASCADE,
    "idempotency_key" "text" NOT NULL,
    "occurred_at"     timestamp with time zone NOT NULL,
    "effective_business_date" "date",
    "actor_user_id"   "uuid",
    "correlation_id"  "uuid",
    "payload"         "jsonb" NOT NULL,
    "payload_hash"    "text" NOT NULL,
    "processing_status" "text" DEFAULT 'PENDING' NOT NULL,
    "processed_at"    timestamp with time zone,
    "created_at"      timestamp with time zone DEFAULT now(),
    CONSTRAINT "integration_events_status_check" CHECK ("processing_status" IN ('PENDING','PROCESSED','FAILED','DEAD_LETTER')),
    CONSTRAINT "integration_events_idempotency_unique" UNIQUE ("source_module", "event_type", "idempotency_key")
);

CREATE TABLE IF NOT EXISTS "core"."integration_failures" (
    "id"                 "uuid" DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    "integration_event_id" "uuid" NOT NULL REFERENCES "core"."integration_events"("id") ON DELETE CASCADE,
    "retry_count"        integer DEFAULT 0 NOT NULL,
    "last_error"         "text",
    "next_retry_at"      timestamp with time zone,
    "dead_letter"        boolean DEFAULT false NOT NULL,
    "created_at"         timestamp with time zone DEFAULT now(),
    "updated_at"         timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "core"."idempotency_keys" (
    "id"              "uuid" DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    "scope"           "text" NOT NULL,     -- e.g. 'payment', 'import', 'webhook', 'posting'
    "key"             "text" NOT NULL,
    "request_hash"    "text",
    "response_snapshot" "jsonb",
    "created_at"      timestamp with time zone DEFAULT now(),
    CONSTRAINT "idempotency_keys_unique" UNIQUE ("scope", "key")
);

COMMENT ON TABLE "core"."integration_events" IS 'Versioned, idempotent cross-module events (Appendix D). Added migration 021 (audit issue H6).';
COMMENT ON TABLE "core"."integration_failures" IS 'Retry/dead-letter tracking for integration_events. Added migration 021 (audit issue H6).';
COMMENT ON TABLE "core"."idempotency_keys" IS 'General-purpose idempotency guard for payment/import/webhook/posting commands (spec 11.2). Added migration 021.';

-- ---------------------------------------------------------------------
-- Indexes for the new tables
-- ---------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS "idx_dimensions_org" ON "finance"."dimensions" ("organization_id");
CREATE INDEX IF NOT EXISTS "idx_dimensions_parent" ON "finance"."dimensions" ("parent_id");
CREATE INDEX IF NOT EXISTS "idx_profiles_department" ON "public"."profiles" ("department_id");
CREATE INDEX IF NOT EXISTS "idx_budget_revisions_budget" ON "finance"."budget_revisions" ("budget_id");
CREATE INDEX IF NOT EXISTS "idx_approval_requests_entity" ON "core"."approval_requests" ("entity_type", "entity_id");
CREATE INDEX IF NOT EXISTS "idx_approval_requests_status" ON "core"."approval_requests" ("status");
CREATE INDEX IF NOT EXISTS "idx_approval_steps_request" ON "core"."approval_steps" ("approval_request_id");
CREATE INDEX IF NOT EXISTS "idx_approval_actions_step" ON "core"."approval_actions" ("approval_step_id");
CREATE INDEX IF NOT EXISTS "idx_employee_links_person" ON "core"."employee_links" ("shared_person_id");
CREATE INDEX IF NOT EXISTS "idx_attendance_snapshots_person" ON "finance"."attendance_period_snapshots" ("shared_person_id");
CREATE INDEX IF NOT EXISTS "idx_integration_events_status" ON "core"."integration_events" ("processing_status");
CREATE INDEX IF NOT EXISTS "idx_integration_events_org" ON "core"."integration_events" ("organization_id");
CREATE INDEX IF NOT EXISTS "idx_integration_failures_event" ON "core"."integration_failures" ("integration_event_id");

COMMIT;