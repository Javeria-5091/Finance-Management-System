-- =====================================================================
-- FND-PBV-004 (P1): commission approve/pay actions never posted GL
-- journal entries — PATCH /api/finance/commissions/[id] just flipped
-- `status` on the commissions row directly, with no accounting impact
-- at all. commission.service.ts's approveCommission()/markCommissionPaid()
-- call RPCs (finance.post_commission_approval / finance.post_commission_
-- payment) that don't exist anywhere in the schema and aren't used by the
-- live dashboard flow anyway (it calls the PATCH route via
-- useApproveCommission()/useMarkCommissionPaid()).
--
-- This migration only adds two nullable linkage columns, following the
-- same pattern already used by finance.capital_transactions
-- (journal_entry_id) — nothing existing is renamed or removed, so this is
-- purely additive.
--
-- Idempotent: safe to run more than once.
-- =====================================================================

BEGIN;

ALTER TABLE "public"."commissions"
  ADD COLUMN IF NOT EXISTS "accrual_journal_id" uuid,
  ADD COLUMN IF NOT EXISTS "payment_journal_id" uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'commissions_accrual_journal_id_fkey'
  ) THEN
    ALTER TABLE "public"."commissions"
      ADD CONSTRAINT "commissions_accrual_journal_id_fkey"
      FOREIGN KEY ("accrual_journal_id") REFERENCES "finance"."journal_entries"("id") ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'commissions_payment_journal_id_fkey'
  ) THEN
    ALTER TABLE "public"."commissions"
      ADD CONSTRAINT "commissions_payment_journal_id_fkey"
      FOREIGN KEY ("payment_journal_id") REFERENCES "finance"."journal_entries"("id") ON DELETE SET NULL;
  END IF;
END $$;

COMMENT ON COLUMN "public"."commissions"."accrual_journal_id" IS 'FND-PBV-004 FIX: GL journal entry posted when this commission was approved (Dr Commission Expense / Cr Commission Payable [/ Cr Withholding Tax Payable]). Set once by PATCH .../commissions/[id] action=approve; null means never approved or approved before this fix.';
COMMENT ON COLUMN "public"."commissions"."payment_journal_id" IS 'FND-PBV-004 FIX: GL journal entry posted when this commission was paid (Dr Commission Payable / Cr the paying financial account''s linked ledger account). Set once by PATCH .../commissions/[id] action=pay.';

COMMIT;