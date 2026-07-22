-- ==========================================
-- PHASE 4: INVOICES TABLE UPGRADE FOR AR
-- ==========================================

-- Add AR Columns to existing public.invoices
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS invoice_number TEXT UNIQUE;
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS client_id UUID;
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS currency TEXT DEFAULT 'PKR';
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS exchange_rate NUMERIC(18,4) DEFAULT 1;
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS subtotal NUMERIC(18,2) DEFAULT 0;
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS tax_amount NUMERIC(18,2) DEFAULT 0;
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS discount_amount NUMERIC(18,2) DEFAULT 0;
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS total_amount NUMERIC(18,2) DEFAULT 0;
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS base_subtotal NUMERIC(18,2) DEFAULT 0;
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS base_tax_amount NUMERIC(18,2) DEFAULT 0;
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS base_discount_amount NUMERIC(18,2) DEFAULT 0;
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS base_total_amount NUMERIC(18,2) DEFAULT 0;
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS amount_paid NUMERIC(18,2) DEFAULT 0;
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS base_amount_paid NUMERIC(18,2) DEFAULT 0;
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS outstanding_amount NUMERIC(18,2) DEFAULT 0;
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS base_outstanding_amount NUMERIC(18,2) DEFAULT 0;
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS due_date DATE;
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS issue_date DATE;
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS journal_entry_id UUID;
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS period_id UUID REFERENCES finance.accounting_periods(id);
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS approved_by UUID;
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ;
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS issued_by UUID;
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS issued_at TIMESTAMPTZ;
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS void_reason TEXT;
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS voided_by UUID;
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS voided_at TIMESTAMPTZ;

UPDATE public.invoices 
SET 
  status = 'Draft', 
  subtotal = amount, 
  total_amount = amount, 
  base_subtotal = amount, 
  base_total_amount = amount,
  outstanding_amount = amount,
  base_outstanding_amount = amount,
  issue_date = COALESCE(issue_date, created_at::date)
WHERE status NOT IN ('Draft', 'Pending', 'Paid');

ALTER TABLE public.invoices DROP CONSTRAINT IF EXISTS invoices_status_check CASCADE;

ALTER TABLE public.invoices ADD CONSTRAINT invoices_status_check CHECK (
  status IN ('DRAFT', 'SUBMITTED', 'APPROVED', 'ISSUED', 'PARTIALLY_PAID', 'PAID', 'OVERDUE', 'VOID', 'REVERSED', 'Draft', 'Pending', 'Paid')
);

UPDATE public.invoices 
SET status = 'ISSUED'
WHERE status = 'Draft';