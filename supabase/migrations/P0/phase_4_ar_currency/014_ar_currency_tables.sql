-- ==========================================
-- PHASE 4: PAYMENTS, ALLOCATIONS & CREDIT NOTES
-- ==========================================

-- 1. PAYMENT RECEIPTS (The money coming in)
CREATE TABLE IF NOT EXISTS finance.payment_receipts (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    receipt_number TEXT UNIQUE,
    payment_date DATE NOT NULL DEFAULT CURRENT_DATE,
    amount NUMERIC(18,2) NOT NULL CHECK (amount >= 0),
    currency TEXT NOT NULL DEFAULT 'PKR',
    exchange_rate NUMERIC(18,4) DEFAULT 1,
    base_amount NUMERIC(18,2) NOT NULL,
    client_id UUID NOT NULL,
    project_id UUID REFERENCES public.projects(id) ON DELETE SET NULL,
    financial_account_id UUID, 
    payment_method TEXT NOT NULL CHECK (payment_method IN ('BANK_TRANSFER', 'PLATFORM', 'CASH', 'CHEQUE', 'OTHER')),
    reference TEXT,
    description TEXT,
    status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'APPROVED', 'POSTED', 'REVERSED')),
    journal_entry_id UUID,
    period_id UUID REFERENCES finance.accounting_periods(id),
    created_by UUID REFERENCES auth.users(id) NOT NULL,
    approved_by UUID, approved_at TIMESTAMPTZ,
    posted_by UUID, posted_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. PAYMENT ALLOCATIONS (Linking Payments to Invoices)
CREATE TABLE IF NOT EXISTS finance.payment_allocations (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    payment_receipt_id UUID NOT NULL REFERENCES finance.payment_receipts(id) ON DELETE CASCADE,
    invoice_id UUID NOT NULL REFERENCES public.invoices(id) ON DELETE CASCADE,
    allocated_amount NUMERIC(18,2) NOT NULL CHECK (allocated_amount > 0),
    base_allocated_amount NUMERIC(18,2) NOT NULL,
    allocated_by UUID NOT NULL REFERENCES auth.users(id),
    allocated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 3. CREDIT NOTES (Adjustments/Refunds)
CREATE TABLE IF NOT EXISTS finance.credit_notes (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    credit_note_number TEXT UNIQUE,
    invoice_id UUID NOT NULL REFERENCES public.invoices(id) ON DELETE CASCADE,
    reason TEXT NOT NULL,
    amount NUMERIC(18,2) NOT NULL CHECK (amount > 0),
    currency TEXT NOT NULL DEFAULT 'PKR',
    exchange_rate NUMERIC(18,4) DEFAULT 1,
    base_amount NUMERIC(18,2) NOT NULL,
    status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'APPROVED', 'POSTED', 'REVERSED')),
    journal_entry_id UUID,
    period_id UUID REFERENCES finance.accounting_periods(id),
    created_by UUID REFERENCES auth.users(id) NOT NULL,
    approved_by UUID, approved_at TIMESTAMPTZ,
    posted_by UUID, posted_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

DROP TABLE IF EXISTS finance.exchange_rates CASCADE;

CREATE TABLE finance.exchange_rates (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    from_currency TEXT NOT NULL,
    to_currency TEXT NOT NULL,
    rate NUMERIC(18,6) NOT NULL,
    rate_date DATE NOT NULL,
    rate_time TIME,
    rate_type TEXT NOT NULL CHECK (rate_type IN ('PLATFORM', 'BANK', 'MANUAL', 'PAYMENT_CHANNEL')),
    source_platform TEXT,
    entered_by UUID NOT NULL REFERENCES auth.users(id),
    approved_by UUID,
    approved_at TIMESTAMPTZ,
    is_locked BOOLEAN DEFAULT false,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_alloc_payment ON finance.payment_allocations(payment_receipt_id);
CREATE INDEX IF NOT EXISTS idx_alloc_invoice ON finance.payment_allocations(invoice_id);
CREATE INDEX IF NOT EXISTS idx_fx_rate_date ON finance.exchange_rates(rate_date DESC);

-- YEH WAHI UNIQUE INDEX HAI JO ERROR DE RAHA THA (Ab table ke baad hai, isliye chalega)
CREATE UNIQUE INDEX IF NOT EXISTS unique_exchange_rate 
ON finance.exchange_rates (from_currency, to_currency, rate_date, rate_type, source_platform);

-- RLS Policies
ALTER TABLE finance.payment_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE finance.payment_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE finance.credit_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE finance.exchange_rates ENABLE ROW LEVEL SECURITY;

CREATE POLICY "pr_select" ON finance.payment_receipts FOR SELECT USING (auth.uid() IS NOT NULL);
CREATE POLICY "pr_insert" ON finance.payment_receipts FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);
CREATE POLICY "pr_update" ON finance.payment_receipts FOR UPDATE USING (auth.uid() IS NOT NULL);

CREATE POLICY "pa_select" ON finance.payment_allocations FOR SELECT USING (auth.uid() IS NOT NULL);
CREATE POLICY "pa_insert" ON finance.payment_allocations FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);

CREATE POLICY "cn_select" ON finance.credit_notes FOR SELECT USING (auth.uid() IS NOT NULL);
CREATE POLICY "cn_insert" ON finance.credit_notes FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);

CREATE POLICY "fx_select" ON finance.exchange_rates FOR SELECT USING (auth.uid() IS NOT NULL);
CREATE POLICY "fx_insert" ON finance.exchange_rates FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);