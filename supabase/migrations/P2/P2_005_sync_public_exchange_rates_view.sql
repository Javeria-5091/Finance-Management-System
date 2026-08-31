-- =====================================================================
-- RELATED TO FND-ADMIN-FX-001 (not required to close that ticket — the
-- ticket's own fix is entirely in src/app/api/admin/exchange-rates/route.ts,
-- since finance.exchange_rates already has the correct columns).
--
-- Found during review: public.exchange_rates (schema.sql ~10766) is a
-- plain security_invoker view over finance.exchange_rates, but it was
-- never updated after migration 040 made organization_id NOT NULL and
-- after evidence_reference was added as NOT NULL + non-blank. The view's
-- SELECT list still only has the original 14 columns — it does not expose
-- organization_id, evidence_reference, or created_by at all.
--
-- src/app/dashboard/settings/exchange-rates/page.tsx inserts directly
-- into "exchange_rates" (default/public schema, i.e. this view) with
-- organization_id and evidence_reference in the payload. Postgres can only
-- insert through a simple view for columns the view actually projects, so
-- today that insert fails with "column organization_id/evidence_reference
-- of relation exchange_rates does not exist" — the dashboard's own manual
-- FX entry screen is broken by the same schema-drift pattern as
-- FND-ADMIN-FX-001, just one level removed (view vs. table).
--
-- This migration only widens the view's SELECT list (adds 3 columns,
-- removes none, does not reorder existing ones), so nothing that already
-- reads this view can regress — it can only gain columns it previously
-- couldn't see.
--
-- Idempotent: CREATE OR REPLACE VIEW is safe to run more than once.
-- =====================================================================

BEGIN;

CREATE OR REPLACE VIEW "public"."exchange_rates" WITH ("security_invoker"='true') AS
 SELECT "id",
    "from_currency",
    "to_currency",
    "rate",
    "rate_date",
    "rate_time",
    "rate_type",
    "source_platform",
    "entered_by",
    "approved_by",
    "approved_at",
    "is_locked",
    "created_at",
    "updated_at",
    "created_by",
    "organization_id",
    "evidence_reference"
   FROM "finance"."exchange_rates";

COMMENT ON VIEW "public"."exchange_rates" IS 'Sync fix (related to FND-ADMIN-FX-001): added organization_id, evidence_reference and created_by, which finance.exchange_rates requires as NOT NULL but this view never exposed — the dashboard exchange-rates page inserts through this view and needs all three.';

COMMIT;