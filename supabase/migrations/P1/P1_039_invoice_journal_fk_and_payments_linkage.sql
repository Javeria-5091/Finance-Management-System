-- =============================================================================
-- Migration: 026_invoice_journal_fk_and_payments_linkage.sql
-- Purpose:   Fix HIGH findings H2 and H1 from the second-opinion audit.
--
-- H2 VERIFICATION NOTE: the audit report claimed "Both [public.expenses and
--   public.invoices] have a journal_entry_id uuid column, but no foreign
--   key constraint exists on either." This was checked directly against
--   schema.sql and is only PARTIALLY VERIFIED:
--     - public.expenses.journal_entry_id ALREADY has a foreign key
--       (expenses_journal_entry_id_fkey, confirmed present) -- no action
--       needed there.
--     - public.invoices.journal_entry_id has NO foreign key (confirmed --
--       the only invoices_*_fkey constraints in the schema are
--       invoices_project_id_fkey and invoices_user_id_fkey). This part of
--       H2 is real and is fixed by this migration.
--   Per the task's Section 4 instruction to verify rather than blindly
--   trust the input report, this migration does NOT touch
--   public.expenses.journal_entry_id, since doing so would be redundant
--   with an already-correct constraint.
--
-- H1: public.payments (confirmed: amount numeric(12,2) vs numeric(18,2)
--   elsewhere, status enum 'Pending'/'Paid'/'Partial Payment'/'Overdue' not
--   matching the spec Section 4.2 state machine, no organization_id, no
--   journal_entry_id) is a legacy table with no ledger link. This
--   migration adds the missing linkage columns as safe, additive,
--   nullable infrastructure. It does NOT retire the table, rewrite its
--   status values, or force every row to link to a journal -- confirming
--   whether the frontend still writes to this table (and, if so, wiring it
--   into the posting engine or migrating it to finance.payment_receipts /
--   finance.vendor_payments) is a product/application decision, not a safe
--   automatic schema change. See "Application Code Changes Required" in
--   the response accompanying this migration set.
--
-- Fix:
--   1. Add invoices_journal_entry_id_fkey (NOT VALID initially -- see
--      validation note below).
--   2. Add organization_id and journal_entry_id (both nullable) to
--      public.payments, with FKs, so a future reconciliation pass has
--      somewhere to record the linkage without a breaking schema change
--      at that time.
--
-- Data safety: Additive. The invoices FK is added NOT VALID so this
--            migration cannot fail outright if some existing invoice row
--            has a stale/orphaned journal_entry_id -- see the verification
--            query below to find any such rows before running VALIDATE
--            CONSTRAINT. The public.payments columns are new, nullable,
--            and unpopulated; no existing row is touched.
-- =============================================================================

BEGIN;

ALTER TABLE "public"."invoices"
  DROP CONSTRAINT IF EXISTS "invoices_journal_entry_id_fkey";

ALTER TABLE "public"."invoices"
  ADD CONSTRAINT "invoices_journal_entry_id_fkey"
  FOREIGN KEY ("journal_entry_id") REFERENCES "finance"."journal_entries"("id")
  ON DELETE SET NULL
  NOT VALID;

ALTER TABLE "public"."payments"
  ADD COLUMN IF NOT EXISTS "organization_id" uuid,
  ADD COLUMN IF NOT EXISTS "journal_entry_id" uuid;

ALTER TABLE "public"."payments"
  DROP CONSTRAINT IF EXISTS "payments_journal_entry_id_fkey";

ALTER TABLE "public"."payments"
  ADD CONSTRAINT "payments_journal_entry_id_fkey"
  FOREIGN KEY ("journal_entry_id") REFERENCES "finance"."journal_entries"("id")
  ON DELETE SET NULL;

ALTER TABLE "public"."payments"
  DROP CONSTRAINT IF EXISTS "payments_organization_id_fkey";

ALTER TABLE "public"."payments"
  ADD CONSTRAINT "payments_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "core"."organization_config"("id")
  ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS "idx_payments_journal_entry" ON "public"."payments" USING btree ("journal_entry_id");

COMMENT ON TABLE "public"."payments" IS
  'LEGACY payment table -- amount precision (numeric(12,2)) and status enum '
  'do not match the finance.* schema convention, and it predates the '
  'properly-modeled finance.payment_receipts (AR) / finance.vendor_payments '
  '(AP) tables with allocations and reconciliation. journal_entry_id / '
  'organization_id added by Migration 026 as nullable linkage '
  'infrastructure only -- confirm with the implementation team whether the '
  'frontend still writes to this table before deciding to wire it into the '
  'posting engine or retire it in favor of finance.payment_receipts / '
  'finance.vendor_payments. See compliance audit Section H1.';

COMMIT;

-- -----------------------------------------------------------------------------
-- Verification (read-only) -- run BEFORE validating the invoices FK for real
-- -----------------------------------------------------------------------------
-- Any invoice with a journal_entry_id that doesn't exist in finance.journal_entries
-- (must be resolved -- e.g. set to NULL with a recorded reason, or the
-- correct journal identified -- before VALIDATE CONSTRAINT will succeed):
-- SELECT i.id, i.invoice_number, i.journal_entry_id
--   FROM public.invoices i
--   LEFT JOIN finance.journal_entries je ON je.id = i.journal_entry_id
--  WHERE i.journal_entry_id IS NOT NULL AND je.id IS NULL;
--
-- Once the above returns zero rows, validate the constraint for real:
-- ALTER TABLE public.invoices VALIDATE CONSTRAINT invoices_journal_entry_id_fkey;
--
-- Confirm whether public.payments is still receiving writes (informs the
-- H1 retirement/wiring decision):
-- SELECT COUNT(*), MAX(created_at) FROM public.payments;