-- ═════════════════════════════════════════════════════════════════════
--  BUG-021 FIX: Credit notes can never take effect.
--
--  src/app/api/finance/credit-notes/route.ts and [id]/route.ts query
--  `credit_notes` (resolving to the public.credit_notes VIEW, 18
--  columns) while reading/writing organization_id, client_id,
--  line_items, total_amount, tax_amount, notes — none of which the view
--  exposes, and some of which (client_id, line_items, tax_amount,
--  notes) don't exist on the real finance.credit_notes table either.
--  This migration:
--    1. Adds the missing columns to finance.credit_notes.
--    2. Rebuilds public.credit_notes to expose them (aliasing the real
--       `amount` column as `total_amount`, which is what the app code
--       already treats as the credit note's GL-relevant amount).
--    3. Adds the missing UPDATE RLS policy (SELECT/INSERT existed,
--       UPDATE did not — every PATCH/approve/post on this table was
--       silently matching zero rows under RLS).
--    4. Widens the status CHECK to add REJECTED, and the credit_note
--       lifecycle is wired into the generic approval workflow (see
--       src/app/api/finance/workflow/route.ts) so DRAFT can actually
--       reach APPROVED — nothing did that before.
-- ═════════════════════════════════════════════════════════════════════

ALTER TABLE finance.credit_notes
  ADD COLUMN IF NOT EXISTS client_id UUID,
  ADD COLUMN IF NOT EXISTS line_items JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS tax_amount NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (tax_amount >= 0),
  ADD COLUMN IF NOT EXISTS notes TEXT,
  ADD COLUMN IF NOT EXISTS credit_note_date DATE NOT NULL DEFAULT CURRENT_DATE,
  ADD COLUMN IF NOT EXISTS rejection_reason TEXT;

COMMENT ON COLUMN finance.credit_notes.tax_amount IS 'Informational breakdown only — GL posting in credit-notes/[id]/route.ts uses `amount` (exposed as total_amount) for both the revenue debit and receivable credit lines; tax_amount does not separately hit a tax account.';

ALTER TABLE finance.credit_notes DROP CONSTRAINT IF EXISTS credit_notes_status_check;
ALTER TABLE finance.credit_notes ADD CONSTRAINT credit_notes_status_check
  CHECK (status = ANY (ARRAY['DRAFT','APPROVED','POSTED','REVERSED','REJECTED']::text[]));

-- ---------------------------------------------------------------------
-- Missing UPDATE policy — SELECT/INSERT existed (P1_062), UPDATE never
-- did, so approve/post/PATCH all silently affected zero rows under RLS.
-- ---------------------------------------------------------------------
DROP POLICY IF EXISTS "cn_update_org_scoped" ON finance.credit_notes;
CREATE POLICY "cn_update_org_scoped" ON finance.credit_notes
  FOR UPDATE USING (((auth.uid() IS NOT NULL) AND core.same_org(organization_id)))
  WITH CHECK (((auth.uid() IS NOT NULL) AND core.same_org(organization_id)));

-- ---------------------------------------------------------------------
-- Rebuild the public view with every column the routes actually need,
-- including organization_id (without which every `.eq('organization_id',
-- ...)` filter in the routes would error against this view).
--
-- NOTE: this must be DROP + CREATE, not CREATE OR REPLACE. Postgres only
-- allows CREATE OR REPLACE VIEW to append new columns at the end and
-- keep every existing column in the same name/position — it cannot
-- reorder columns or rename "amount" to "total_amount" in place (that
-- errors with "cannot change name of view column ... to ..."). The only
-- dependents are GRANT statements (checked against schema.sql — no other
-- view/function selects from public.credit_notes), which are re-applied
-- below, so DROP is safe here.
-- ---------------------------------------------------------------------
DROP VIEW IF EXISTS "public"."credit_notes";

CREATE VIEW "public"."credit_notes" WITH ("security_invoker"='true') AS
 SELECT "id",
    "credit_note_number",
    "invoice_id",
    "vendor_bill_id",
    "credit_note_type",
    "client_id",
    "reason",
    "amount" AS "total_amount",
    "tax_amount",
    "line_items",
    "notes",
    "currency",
    "exchange_rate",
    "base_amount",
    "credit_note_date",
    "status",
    "rejection_reason",
    "journal_entry_id",
    "period_id",
    "created_by",
    "approved_by",
    "approved_at",
    "posted_by",
    "posted_at",
    "created_at",
    "updated_at",
    "organization_id"
   FROM "finance"."credit_notes";

ALTER VIEW "public"."credit_notes" OWNER TO "postgres";
GRANT ALL ON TABLE "public"."credit_notes" TO "authenticated";
GRANT ALL ON TABLE "public"."credit_notes" TO "service_role";

COMMENT ON VIEW "public"."credit_notes" IS 'BUG-021 fix: previously exposed only 18 columns, missing organization_id/client_id/line_items/tax_amount/notes that src/app/api/finance/credit-notes/*.ts read and wrote — every query against this view failed.';