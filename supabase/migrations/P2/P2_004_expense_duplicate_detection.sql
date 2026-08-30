-- ==========================================================================
-- MF-01 · Expense duplicate detection (Spec §5.5)
--
-- Spec §5.5 mandates: "Detect potential duplicates using reference, amount,
-- date, vendor, receipt hash, and AI similarity scoring." No column existed
-- on public.expenses to store a receipt's content hash, so a deterministic
-- "is this the same receipt file being re-submitted" check was impossible
-- without joining finance.attachments on every single comparison.
--
-- This migration adds a denormalized receipt_hash column, populated by the
-- API at expense-save time from the same SHA-256 hash already computed for
-- the attachment (see src/app/api/finance/attachment/route.ts
-- computeFileHash()), plus supporting indexes so the new duplicate-check
-- endpoint (src/app/api/finance/expenses/duplicate-check/route.ts) doesn't
-- force a sequential scan per lookup.
-- ==========================================================================

ALTER TABLE public.expenses
    ADD COLUMN IF NOT EXISTS receipt_hash text;

COMMENT ON COLUMN public.expenses.receipt_hash IS
    'SHA-256 hash of the uploaded receipt file, mirrored from finance.attachments.file_hash (see computeFileHash() in src/app/api/finance/attachment/route.ts). Denormalized here for fast duplicate-detection lookups (Spec 5.5). NULL when the expense has no receipt attached.';

-- Fast "has this exact receipt file already been used in this org" lookup.
-- Partial index (receipt_hash IS NOT NULL) since most historical rows won't
-- have one and we never need to match on NULL = NULL.
CREATE INDEX IF NOT EXISTS idx_expenses_receipt_hash
    ON public.expenses (organization_id, receipt_hash)
    WHERE receipt_hash IS NOT NULL;

-- Supports the amount + vendor + date-window duplicate check (Spec 5.5).
CREATE INDEX IF NOT EXISTS idx_expenses_dup_lookup
    ON public.expenses (organization_id, vendor_id, amount, expense_date);