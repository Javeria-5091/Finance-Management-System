-- ==========================================
-- PHASE 2 - STEP 2.4: Upgrade Existing Tables
-- ==========================================

-- INCOME TABLE UPGRADE
ALTER TABLE public.incomes ADD COLUMN IF NOT EXISTS status TEXT 
  DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'SUBMITTED', 'VERIFIED', 'APPROVED', 'POSTED', 'REVERSED', 'REJECTED', 'CANCELLED'));
ALTER TABLE public.incomes ADD COLUMN IF NOT EXISTS journal_entry_id UUID REFERENCES finance.journal_entries(id);
ALTER TABLE public.incomes ADD COLUMN IF NOT EXISTS period_id UUID REFERENCES finance.accounting_periods(id);
ALTER TABLE public.incomes ADD COLUMN IF NOT EXISTS currency TEXT DEFAULT 'PKR';
ALTER TABLE public.incomes ADD COLUMN IF NOT EXISTS exchange_rate NUMERIC(18,4) DEFAULT 1;
ALTER TABLE public.incomes ADD COLUMN IF NOT EXISTS base_amount NUMERIC(18,2);
ALTER TABLE public.incomes ADD COLUMN IF NOT EXISTS submitted_by UUID;
ALTER TABLE public.incomes ADD COLUMN IF NOT EXISTS submitted_at TIMESTAMPTZ;
ALTER TABLE public.incomes ADD COLUMN IF NOT EXISTS approved_by UUID;
ALTER TABLE public.incomes ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ;
ALTER TABLE public.incomes ADD COLUMN IF NOT EXISTS posted_at TIMESTAMPTZ;
ALTER TABLE public.incomes ADD COLUMN IF NOT EXISTS rejection_reason TEXT;
ALTER TABLE public.incomes ADD COLUMN IF NOT EXISTS account_id UUID REFERENCES finance.chart_of_accounts(id);

-- EXPENSE TABLE UPGRADE
ALTER TABLE public.expenses ADD COLUMN IF NOT EXISTS status TEXT 
  DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'SUBMITTED', 'VERIFIED', 'APPROVED', 'POSTED', 'REVERSED', 'REJECTED', 'CANCELLED'));
ALTER TABLE public.expenses ADD COLUMN IF NOT EXISTS journal_entry_id UUID REFERENCES finance.journal_entries(id);
ALTER TABLE public.expenses ADD COLUMN IF NOT EXISTS period_id UUID REFERENCES finance.accounting_periods(id);
ALTER TABLE public.expenses ADD COLUMN IF NOT EXISTS currency TEXT DEFAULT 'PKR';
ALTER TABLE public.expenses ADD COLUMN IF NOT EXISTS exchange_rate NUMERIC(18,4) DEFAULT 1;
ALTER TABLE public.expenses ADD COLUMN IF NOT EXISTS base_amount NUMERIC(18,2);
ALTER TABLE public.expenses ADD COLUMN IF NOT EXISTS submitted_by UUID;
ALTER TABLE public.expenses ADD COLUMN IF NOT EXISTS submitted_at TIMESTAMPTZ;
ALTER TABLE public.expenses ADD COLUMN IF NOT EXISTS approved_by UUID;
ALTER TABLE public.expenses ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ;
ALTER TABLE public.expenses ADD COLUMN IF NOT EXISTS posted_at TIMESTAMPTZ;
ALTER TABLE public.expenses ADD COLUMN IF NOT EXISTS rejection_reason TEXT;
ALTER TABLE public.expenses ADD COLUMN IF NOT EXISTS account_id UUID REFERENCES finance.chart_of_accounts(id);
ALTER TABLE public.expenses ADD COLUMN IF NOT EXISTS vendor_id UUID;
ALTER TABLE public.expenses ADD COLUMN IF NOT EXISTS has_receipt BOOLEAN DEFAULT false;
ALTER TABLE public.expenses ADD COLUMN IF NOT EXISTS receipt_attachment_id UUID;

-- MIGRATE HISTORICAL DATA (Existing entries assume POSTED to keep GL accurate initially)
UPDATE public.incomes SET status = 'POSTED' WHERE status = 'DRAFT';
UPDATE public.expenses SET status = 'POSTED' WHERE status = 'DRAFT';