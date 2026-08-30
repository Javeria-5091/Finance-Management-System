-- =============================================================================
-- Migration: 042_notifications_table_extension.sql
-- Bug ref:   P0-06 (senior developer review) — "Service writes to
--            non-existent core.notifications table"
--
-- Problem:   src/services/notification.service.ts calls
--            .schema('core').from('notifications') in 4 places, but
--            core.notifications DOES NOT EXIST anywhere in this project
--            (see schema.sql / all migrations). Only public.notifications
--            exists, and it only has (id, user_id, title, message, is_read,
--            created_at) — none of the extra columns the service inserts
--            (notification_type, priority, action_url, entity_type,
--            entity_id, organization_id, recipient_roles, source_entity_*,
--            related_entity_*, triggered_by, metadata, read_at). Every
--            insert/update therefore fails with PGRST205, so the entire
--            Spec §13.4 notification subsystem is silently dead.
--
-- Fix:       Option (a) from the review: keep notifications in the
--            EXISTING public.notifications table (it already has RLS,
--            an audit trigger, a FK from public.notification_deliveries,
--            and grants set up — recreating all of that under a brand new
--            core.notifications table would duplicate/orphan that wiring)
--            and extend it, additively, with every column the service
--            layer needs. The application code is updated in the same
--            change to stop calling .schema('core') and use the default
--            (public) schema instead.
--
-- Data safety: Purely additive (ADD COLUMN IF NOT EXISTS only). No existing
--            column, row, or constraint is touched or dropped.
-- =============================================================================

BEGIN;

ALTER TABLE "public"."notifications"
  ADD COLUMN IF NOT EXISTS "notification_type" text,
  ADD COLUMN IF NOT EXISTS "priority" text DEFAULT 'medium',
  ADD COLUMN IF NOT EXISTS "action_url" text,
  ADD COLUMN IF NOT EXISTS "entity_type" text,
  ADD COLUMN IF NOT EXISTS "entity_id" uuid,
  ADD COLUMN IF NOT EXISTS "organization_id" uuid,
  ADD COLUMN IF NOT EXISTS "recipient_roles" text[],
  ADD COLUMN IF NOT EXISTS "source_entity_type" text,
  ADD COLUMN IF NOT EXISTS "source_entity_id" uuid,
  ADD COLUMN IF NOT EXISTS "related_entity_type" text,
  ADD COLUMN IF NOT EXISTS "related_entity_id" uuid,
  ADD COLUMN IF NOT EXISTS "triggered_by" uuid,
  ADD COLUMN IF NOT EXISTS "created_by" uuid,
  ADD COLUMN IF NOT EXISTS "metadata" jsonb,
  ADD COLUMN IF NOT EXISTS "read_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "expires_at" timestamp with time zone;

-- notification_type / priority CHECK constraints, matching the enum unions
-- used by notificationService.create() in notification.service.ts.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'notifications_notification_type_check'
  ) THEN
    ALTER TABLE "public"."notifications"
      ADD CONSTRAINT "notifications_notification_type_check"
      CHECK (
        "notification_type" IS NULL OR "notification_type" = ANY (ARRAY[
          'APPROVAL_PENDING','PAYMENT_DUE','BUDGET_ALERT','SYSTEM','WORKFLOW',
          'REMINDER','OVERDUE','INFO','BUDGET_CAUTION','BUDGET_WARNING',
          'BUDGET_BLOCKED','BUDGET_EXCEEDED'
        ])
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'notifications_priority_check'
  ) THEN
    ALTER TABLE "public"."notifications"
      ADD CONSTRAINT "notifications_priority_check"
      CHECK (
        "priority" IS NULL OR "priority" = ANY (ARRAY[
          'low','medium','high','urgent','info','critical'
        ])
      );
  END IF;
END $$;

-- FKs for the new relational columns. NOT VALID + separate VALIDATE keeps
-- this migration safe to run against existing data without locking/failing
-- on any historical rows that might not satisfy the new FK yet.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'notifications_organization_id_fkey'
  ) THEN
    ALTER TABLE "public"."notifications"
      ADD CONSTRAINT "notifications_organization_id_fkey"
      FOREIGN KEY ("organization_id") REFERENCES "core"."organizations"("id") ON DELETE CASCADE NOT VALID;
    ALTER TABLE "public"."notifications" VALIDATE CONSTRAINT "notifications_organization_id_fkey";
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'notifications_triggered_by_fkey'
  ) THEN
    ALTER TABLE "public"."notifications"
      ADD CONSTRAINT "notifications_triggered_by_fkey"
      FOREIGN KEY ("triggered_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL NOT VALID;
    ALTER TABLE "public"."notifications" VALIDATE CONSTRAINT "notifications_triggered_by_fkey";
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'notifications_created_by_fkey'
  ) THEN
    ALTER TABLE "public"."notifications"
      ADD CONSTRAINT "notifications_created_by_fkey"
      FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL NOT VALID;
    ALTER TABLE "public"."notifications" VALIDATE CONSTRAINT "notifications_created_by_fkey";
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "idx_notifications_org"
  ON "public"."notifications" USING btree ("organization_id");

CREATE INDEX IF NOT EXISTS "idx_notifications_user_unread"
  ON "public"."notifications" USING btree ("user_id", "is_read")
  WHERE ("is_read" = false);

CREATE INDEX IF NOT EXISTS "idx_notifications_entity"
  ON "public"."notifications" USING btree ("entity_type", "entity_id");

COMMENT ON TABLE "public"."notifications" IS
  'In-app notifications (Spec §13.4). Extended in migration 042 (P0-06 fix) '
  'with notification_type/priority/action_url/entity_*/organization_id/'
  'recipient_roles/source_entity_*/related_entity_*/triggered_by/created_by/'
  'metadata/read_at/expires_at so notification.service.ts inserts succeed. '
  'Table stays in the public schema (NOT core.notifications, which never '
  'existed) so it keeps its existing RLS policy, audit trigger, and the '
  'public.notification_deliveries FK intact.';

COMMIT;