-- =============================================================================
-- Migration: 021_notification_preferences_deliveries.sql
-- Purpose:   Fix compliance gap identified in Section 7 (Compliance Matrix
--            item #24) of the Schema Compliance Audit. Spec ref: Section
--            10.4 target table group "notifications, notification_
--            preferences, notification_deliveries" and Section 13.4
--            (notification triggers/recipients/escalation behavior, which
--            requires per-user channel preference and delivery tracking to
--            be representable).
--
-- Problem:   Only public.notifications (a flat in-app notification table)
--            exists. There is no way to record a user's channel preferences
--            (e.g. "email me budget alerts but not login alerts") or to
--            track whether a given notification was actually delivered via
--            a given channel -- both explicitly listed in spec's target
--            table group.
--
-- Fix:       Add two new tables, additive only:
--              - public.notification_preferences: one row per (user,
--                category, channel) with an enabled flag.
--              - public.notification_deliveries: one row per delivery
--                attempt of a notification through a channel, with status
--                and error tracking, FK to public.notifications.
--            RLS follows the existing pattern used on public.notifications
--            (implicitly: a user manages their own records; this migration
--            makes it explicit since public.notifications itself was not
--            found to have an RLS policy scoping SELECT to auth.uid() =
--            user_id in the reviewed schema -- verify this at the same time
--            you review the policies below).
--
-- Data safety: Purely additive (new tables). No existing table, column, or
--            row is touched.
-- =============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS "public"."notification_preferences" (
    "id" uuid DEFAULT gen_random_uuid() NOT NULL,
    "user_id" uuid NOT NULL,
    "category" text NOT NULL,           -- e.g. 'APPROVAL', 'BUDGET_ALERT', 'INVOICE_DUE', 'SECURITY'
    "channel" text NOT NULL,            -- e.g. 'IN_APP', 'EMAIL', 'SMS'
    "enabled" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT now(),
    "updated_at" timestamp with time zone DEFAULT now(),
    CONSTRAINT "notification_preferences_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "notification_preferences_channel_check"
        CHECK (("channel" = ANY (ARRAY['IN_APP'::text, 'EMAIL'::text, 'SMS'::text]))),
    CONSTRAINT "notification_preferences_user_category_channel_key"
        UNIQUE ("user_id", "category", "channel")
);

ALTER TABLE "public"."notification_preferences" OWNER TO "postgres";

COMMENT ON TABLE "public"."notification_preferences" IS
  'Per-user, per-category, per-channel notification opt-in/out. Spec Section '
  '10.4. See Migration 021.';

CREATE TABLE IF NOT EXISTS "public"."notification_deliveries" (
    "id" uuid DEFAULT gen_random_uuid() NOT NULL,
    "notification_id" uuid NOT NULL,
    "channel" text NOT NULL,
    "status" text DEFAULT 'PENDING' NOT NULL,
    "attempted_at" timestamp with time zone DEFAULT now(),
    "delivered_at" timestamp with time zone,
    "error_message" text,
    "created_at" timestamp with time zone DEFAULT now(),
    CONSTRAINT "notification_deliveries_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "notification_deliveries_channel_check"
        CHECK (("channel" = ANY (ARRAY['IN_APP'::text, 'EMAIL'::text, 'SMS'::text]))),
    CONSTRAINT "notification_deliveries_status_check"
        CHECK (("status" = ANY (ARRAY['PENDING'::text, 'SENT'::text, 'DELIVERED'::text, 'FAILED'::text]))),
    CONSTRAINT "notification_deliveries_notification_id_fkey"
        FOREIGN KEY ("notification_id") REFERENCES "public"."notifications"("id") ON DELETE CASCADE
);

ALTER TABLE "public"."notification_deliveries" OWNER TO "postgres";

COMMENT ON TABLE "public"."notification_deliveries" IS
  'Per-channel delivery attempt/result for a notification. Spec Section 10.4. '
  'See Migration 021.';

CREATE INDEX IF NOT EXISTS "idx_notification_prefs_user"
  ON "public"."notification_preferences" USING btree ("user_id");

CREATE INDEX IF NOT EXISTS "idx_notification_deliveries_notification"
  ON "public"."notification_deliveries" USING btree ("notification_id");

CREATE INDEX IF NOT EXISTS "idx_notification_deliveries_status"
  ON "public"."notification_deliveries" USING btree ("status")
  WHERE ("status" IN ('PENDING', 'FAILED'));

ALTER TABLE "public"."notification_preferences" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."notification_deliveries" ENABLE ROW LEVEL SECURITY;

-- notification_preferences: a user manages only their own preferences.
CREATE POLICY "notification_prefs_select_own" ON "public"."notification_preferences"
  FOR SELECT TO "authenticated"
  USING (("user_id" = auth.uid()));

CREATE POLICY "notification_prefs_insert_own" ON "public"."notification_preferences"
  FOR INSERT TO "authenticated"
  WITH CHECK (("user_id" = auth.uid()));

CREATE POLICY "notification_prefs_update_own" ON "public"."notification_preferences"
  FOR UPDATE TO "authenticated"
  USING (("user_id" = auth.uid()))
  WITH CHECK (("user_id" = auth.uid()));

CREATE POLICY "notification_prefs_delete_own" ON "public"."notification_preferences"
  FOR DELETE TO "authenticated"
  USING (("user_id" = auth.uid()));

CREATE POLICY "notification_prefs_service_all" ON "public"."notification_preferences"
  TO "service_role" USING (true) WITH CHECK (true);

-- notification_deliveries: a user may read delivery status for their own
-- notifications only; writes are service-role only (delivery is a backend/
-- notification-service concern, not something a client should be able to
-- fabricate -- e.g. marking their own reminder as "DELIVERED" client-side
-- would be meaningless and potentially misleading).
CREATE POLICY "notification_deliveries_select_own" ON "public"."notification_deliveries"
  FOR SELECT TO "authenticated"
  USING (EXISTS (
    SELECT 1 FROM public.notifications n
     WHERE n.id = notification_deliveries.notification_id
       AND n.user_id = auth.uid()
  ));

CREATE POLICY "notification_deliveries_service_all" ON "public"."notification_deliveries"
  TO "service_role" USING (true) WITH CHECK (true);

COMMIT;