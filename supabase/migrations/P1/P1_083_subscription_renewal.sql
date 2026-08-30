-- ############################################################################
-- BUG-027 FIX (Subscriptions: missing subscription_renewal_events table)
-- Note: subscription.service.ts's wrong-schema queries (.schema('finance')/
-- .schema('reporting') instead of default public) are fixed directly in the
-- TypeScript file, delivered separately -- there is nothing to change in the
-- database for that half of the bug, since public.subscriptions and its
-- views were always correctly defined; only the application code was
-- pointing at the wrong schema.
-- ############################################################################
 
-- ============================================================================
-- BUG-027 FIX (part 2): src/app/api/finance/subscriptions/renewel/route.ts
-- reads and writes public.subscription_renewal_events, which does not exist
-- anywhere in the dump or migrations, so every action in that route
-- ('generate', 'acknowledge', 'draft_bill') fails outright. This is the
-- missing table, matching exactly the columns/values the route already
-- reads and writes.
--
-- Note: this route currently has zero callers from the frontend (per the
-- ticket's own evidence) -- creating this table makes the route itself
-- functionally correct end-to-end, but does not add a UI entry point to
-- actually trigger renewal-reminder generation or draft-bill creation.
-- Wiring that into the Subscriptions page is a separate frontend task, not
-- a "fix" of existing broken code, so it isn't included here.
-- ============================================================================
 
CREATE TABLE IF NOT EXISTS "public"."subscription_renewal_events" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "subscription_id" "uuid" NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "renewal_date" "date" NOT NULL,
    "reminder_days" integer DEFAULT 30 NOT NULL,
    "status" "text" DEFAULT 'PENDING'::"text" NOT NULL,
    "acknowledged_by" "uuid",
    "acknowledged_at" timestamp with time zone,
    "draft_vendor_bill_id" "uuid",
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "subscription_renewal_events_status_check" CHECK (("status" = ANY (ARRAY['PENDING'::"text", 'ACKNOWLEDGED'::"text", 'DRAFT_BILL_CREATED'::"text"]))),
    CONSTRAINT "subscription_renewal_events_reminder_days_check" CHECK (("reminder_days" >= 0 AND "reminder_days" <= 365)),
    CONSTRAINT "subscription_renewal_events_subscription_id_renewal_date_key" UNIQUE ("subscription_id", "renewal_date")
);
 
ALTER TABLE "public"."subscription_renewal_events" OWNER TO "postgres";
 
COMMENT ON TABLE "public"."subscription_renewal_events" IS 'Generated renewal reminders for subscriptions nearing their renewal date, with acknowledgement and optional draft-vendor-bill linkage (spec 5.11).';
 
ALTER TABLE ONLY "public"."subscription_renewal_events"
    ADD CONSTRAINT "subscription_renewal_events_pkey" PRIMARY KEY ("id");
 
ALTER TABLE ONLY "public"."subscription_renewal_events"
    ADD CONSTRAINT "subscription_renewal_events_subscription_id_fkey" FOREIGN KEY ("subscription_id") REFERENCES "public"."subscriptions"("id") ON DELETE CASCADE;
 
ALTER TABLE ONLY "public"."subscription_renewal_events"
    ADD CONSTRAINT "subscription_renewal_events_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "core"."organizations"("id");
 
ALTER TABLE ONLY "public"."subscription_renewal_events"
    ADD CONSTRAINT "subscription_renewal_events_acknowledged_by_fkey" FOREIGN KEY ("acknowledged_by") REFERENCES "auth"."users"("id");
 
ALTER TABLE ONLY "public"."subscription_renewal_events"
    ADD CONSTRAINT "subscription_renewal_events_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");
 
ALTER TABLE ONLY "public"."subscription_renewal_events"
    ADD CONSTRAINT "subscription_renewal_events_draft_vendor_bill_id_fkey" FOREIGN KEY ("draft_vendor_bill_id") REFERENCES "finance"."vendor_bills"("id");
 
CREATE INDEX "idx_sre_org" ON "public"."subscription_renewal_events" USING "btree" ("organization_id");
CREATE INDEX "idx_sre_subscription" ON "public"."subscription_renewal_events" USING "btree" ("subscription_id");
CREATE INDEX "idx_sre_status" ON "public"."subscription_renewal_events" USING "btree" ("status");
 
CREATE OR REPLACE TRIGGER "trg_subscription_renewal_events_updated" BEFORE UPDATE ON "public"."subscription_renewal_events" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at"();
 
ALTER TABLE "public"."subscription_renewal_events" ENABLE ROW LEVEL SECURITY;
 
CREATE POLICY "Service role full access on subscription_renewal_events" ON "public"."subscription_renewal_events" TO "service_role" USING (true) WITH CHECK (true);
 
CREATE POLICY "sre_select_org_scoped" ON "public"."subscription_renewal_events" FOR SELECT TO "authenticated" USING (("core"."same_org"("organization_id") AND ("core"."is_finance_head"() OR "core"."has_role"('ACCOUNTANT'::"text") OR "core"."has_role"('VIEWER'::"text") OR "core"."has_role"('PROJECT_MANAGER'::"text"))));
 
CREATE POLICY "sre_insert_org_scoped" ON "public"."subscription_renewal_events" FOR INSERT TO "authenticated" WITH CHECK (("core"."same_org"("organization_id") AND ("core"."is_finance_head"() OR "core"."has_role"('ACCOUNTANT'::"text"))));
 
CREATE POLICY "sre_update_org_scoped" ON "public"."subscription_renewal_events" FOR UPDATE TO "authenticated" USING (("core"."same_org"("organization_id") AND ("core"."is_finance_head"() OR "core"."has_role"('ACCOUNTANT'::"text")))) WITH CHECK (("core"."same_org"("organization_id") AND ("core"."is_finance_head"() OR "core"."has_role"('ACCOUNTANT'::"text"))));
 
CREATE POLICY "sre_delete_org_scoped" ON "public"."subscription_renewal_events" FOR DELETE TO "authenticated" USING (("core"."same_org"("organization_id") AND "core"."is_finance_head"()));
 
