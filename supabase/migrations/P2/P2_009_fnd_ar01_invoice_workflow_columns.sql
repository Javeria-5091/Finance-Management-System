-- =====================================================================
-- Finance Management System — Critical Fix
--   FND-AR-01 (P0): invoice workflow (submit/verify/reject/reopen) writes
--                    columns that don't exist on public.invoices, so
--                    PostgREST returns PGRST204 and the invoice lifecycle
--                    can never leave DRAFT (approve requires SUBMITTED,
--                    which is unreachable).
--
-- Evidence: src/app/api/finance/workflow/route.ts sets submitted_by,
-- submitted_at, verified_by, verified_at, rejection_reason generically
-- for every module that goes through submit/verify/reject/reopen -- every
-- OTHER module already using this route (expenses, incomes, vendor_bills)
-- has these columns; public.invoices never got them.
--
-- Fix: add the missing columns so public.invoices matches the same
-- workflow-audit shape as public.expenses / public.incomes /
-- finance.vendor_bills. Purely additive (nullable columns, no defaults
-- that change existing rows), so safe to run on a live table.
-- =====================================================================

BEGIN;

ALTER TABLE "public"."invoices"
  ADD COLUMN IF NOT EXISTS "submitted_by" "uuid",
  ADD COLUMN IF NOT EXISTS "submitted_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "verified_by" "uuid",
  ADD COLUMN IF NOT EXISTS "verified_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "rejection_reason" "text";

COMMENT ON COLUMN "public"."invoices"."submitted_by" IS 'FND-AR-01 fix: set by /api/finance/workflow on submit (DRAFT -> SUBMITTED). Previously missing, which made PostgREST reject every submit with PGRST204.';
COMMENT ON COLUMN "public"."invoices"."submitted_at" IS 'FND-AR-01 fix: timestamp paired with submitted_by.';
COMMENT ON COLUMN "public"."invoices"."verified_by" IS 'FND-AR-01 fix: reserved for parity with expenses/incomes/vendor_bills workflow shape. The invoice module currently has no verify step (DRAFT -> SUBMITTED -> APPROVED -> ISSUED), so this stays NULL today but is safe for a future verify step without another migration.';
COMMENT ON COLUMN "public"."invoices"."verified_at" IS 'FND-AR-01 fix: timestamp paired with verified_by.';
COMMENT ON COLUMN "public"."invoices"."rejection_reason" IS 'FND-AR-01 fix: set by /api/finance/workflow on reject, cleared on reopen. Previously missing, which made PostgREST reject every reject/reopen with PGRST204.';

COMMIT;

-- ---------------------------------------------------------------------
-- Verification:
--   1) As the invoice's own creator, submit it:
--        select * from public.invoices where id = '<draft-invoice-id>';
--        -- then call POST /api/finance/workflow {module:'invoice', recordId, action:'submit'}
--        -- expect status -> SUBMITTED, submitted_by/submitted_at populated, no PGRST204.
--   2) As a different user with APPROVE_INVOICE, approve it:
--        POST /api/finance/workflow {module:'invoice', recordId, action:'approve'}
--        -- expect status -> APPROVED (previously unreachable).
--   3) issue it, then confirm /api/finance/post-invoice can post an
--      ISSUED invoice, closing the full DRAFT -> SUBMITTED -> APPROVED ->
--      ISSUED -> POSTED chain end to end.
-- ---------------------------------------------------------------------