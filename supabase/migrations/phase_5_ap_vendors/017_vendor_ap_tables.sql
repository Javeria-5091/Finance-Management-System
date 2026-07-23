-- ==========================================
-- PHASE 5: VENDORS, BILLS, PAYMENTS
-- ==========================================

-- 1. VENDOR MASTER
CREATE TABLE IF NOT EXISTS finance.vendors (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    vendor_code TEXT UNIQUE,
    name TEXT NOT NULL,
    contact_person TEXT,
    email TEXT,
    phone TEXT,
    address TEXT,
    city TEXT,
    country TEXT DEFAULT 'Pakistan',
    tax_registration TEXT, -- NTN / CNIC
    tax_type TEXT DEFAULT 'GST_REGISTERED',
    payment_terms TEXT DEFAULT 'NET_30',
    default_currency TEXT DEFAULT 'PKR',
    bank_name TEXT,
    bank_account TEXT,
    is_active BOOLEAN DEFAULT true,
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_vendors_code ON finance.vendors(vendor_code);

-- 2. VENDOR BILLS (Header)
CREATE TABLE IF NOT EXISTS finance.vendor_bills (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    bill_number TEXT UNIQUE,
    vendor_id UUID NOT NULL REFERENCES finance.vendors(id) ON DELETE RESTRICT,
    bill_date DATE NOT NULL DEFAULT CURRENT_DATE,
    due_date DATE,
    currency TEXT DEFAULT 'PKR',
    exchange_rate NUMERIC(18,4) DEFAULT 1,
    subtotal NUMERIC(18,2) DEFAULT 0,
    tax_amount NUMERIC(18,2) DEFAULT 0,
    withholding_amount NUMERIC(18,2) DEFAULT 0,
    discount_amount NUMERIC(18,2) DEFAULT 0,
    total_amount NUMERIC(18,2) NOT NULL,
    base_subtotal NUMERIC(18,2) DEFAULT 0,
    base_tax_amount NUMERIC(18,2) DEFAULT 0,
    base_withholding_amount NUMERIC(18,2) DEFAULT 0,
    base_discount_amount NUMERIC(18,2) DEFAULT 0,
    base_total_amount NUMERIC(18,2) NOT NULL,
    amount_paid NUMERIC(18,2) DEFAULT 0,
    outstanding_amount NUMERIC(18,2) DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'SUBMITTED', 'VERIFIED', 'APPROVED', 'POSTED', 'PARTIALLY_PAID', 'PAID', 'REVERSED', 'CANCELLED')),
    project_id UUID REFERENCES public.projects(id) ON DELETE SET NULL,
    description TEXT,
    attachment_ids UUID[],
    submitted_by UUID, submitted_at TIMESTAMPTZ,
    verified_by UUID, verified_at TIMESTAMPTZ,
    approved_by UUID, approved_at TIMESTAMPTZ,
    posted_by UUID, posted_at TIMESTAMPTZ,
    rejection_reason TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL
);

-- 3. VENDOR BILL LINES (Detail)
CREATE TABLE IF NOT EXISTS finance.vendor_bill_lines (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    vendor_bill_id UUID NOT NULL REFERENCES finance.vendor_bills(id) ON DELETE CASCADE,
    line_number INTEGER NOT NULL,
    account_id UUID NOT NULL REFERENCES finance.chart_of_accounts(id),
    description TEXT NOT NULL,
    quantity NUMERIC(18,4) DEFAULT 1,
    unit_price NUMERIC(18,2) NOT NULL,
    tax_code_id UUID,
    tax_rate NUMERIC(5,2) DEFAULT 0,
    tax_amount NUMERIC(18,2) DEFAULT 0,
    withholding_rate NUMERIC(5,2) DEFAULT 0,
    withholding_amount NUMERIC(18,2) DEFAULT 0,
    line_total NUMERIC(18,2) NOT NULL, -- (qty * unit_price) + tax_amount + withholding_amount
    project_id UUID,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 4. VENDOR PAYMENTS (Header)
CREATE TABLE IF NOT EXISTS finance.vendor_payments (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    payment_number TEXT UNIQUE,
    payment_date DATE NOT NULL DEFAULT CURRENT_DATE,
    amount NUMERIC(18,2) NOT NULL,
    currency TEXT DEFAULT 'PKR',
    exchange_rate NUMERIC(18,4) DEFAULT 1,
    base_amount NUMERIC(18,2) NOT NULL,
    vendor_id UUID NOT NULL REFERENCES finance.vendors(id),
    financial_account_id UUID, -- Will link to Phase 6 Bank Accounts
    payment_method TEXT NOT NULL CHECK (payment_method IN ('BANK_TRANSFER', 'CHEQUE', 'CASH', 'PLATFORM', 'OTHER')),
    reference TEXT,
    description TEXT,
    status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'APPROVED', 'POSTED', 'REVERSED')),
    is_batch BOOLEAN DEFAULT false,
    batch_id UUID,
    journal_entry_id UUID,
    period_id UUID REFERENCES finance.accounting_periods(id),
    approved_by UUID, approved_at TIMESTAMPTZ,
    posted_by UUID, posted_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL
);

-- 5. VENDOR PAYMENT ALLOCATIONS (Linking Payment to Bills)
CREATE TABLE IF NOT EXISTS finance.vendor_payment_allocations (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    vendor_payment_id UUID NOT NULL REFERENCES finance.vendor_payments(id) ON DELETE CASCADE,
    vendor_bill_id UUID NOT NULL REFERENCES finance.vendor_bills(id) ON DELETE CASCADE,
    allocated_amount NUMERIC(18,2) NOT NULL CHECK (allocated_amount > 0),
    base_allocated_amount NUMERIC(18,2) NOT NULL,
    allocated_by UUID NOT NULL REFERENCES auth.users(id),
    allocated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_vb_vendor ON finance.vendor_bills(vendor_id);
CREATE INDEX IF NOT EXISTS idx_vbl_bill ON finance.vendor_bill_lines(vendor_bill_id);
CREATE INDEX IF NOT EXISTS idx_vpa_payment ON finance.vendor_payment_allocations(vendor_payment_id);
CREATE INDEX IF NOT EXISTS idx_vp_vendor ON finance.vendor_payments(vendor_id);

-- ==========================================
-- RLS POLICIES
-- ==========================================
ALTER TABLE finance.vendors ENABLE ROW LEVEL SECURITY;
ALTER TABLE finance.vendor_bills ENABLE ROW LEVEL SECURITY;
ALTER TABLE finance.vendor_bill_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE finance.vendor_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE finance.vendor_payment_allocations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "v_select" ON finance.vendors FOR SELECT USING (auth.uid() IS NOT NULL);
CREATE POLICY "v_insert" ON finance.vendors FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);
CREATE POLICY "v_update" ON finance.vendors FOR UPDATE USING (auth.uid() IS NOT NULL);

CREATE POLICY "vb_select" ON finance.vendor_bills FOR SELECT USING (auth.uid() IS NOT NULL);
CREATE POLICY "vb_insert" ON finance.vendor_bills FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);
CREATE POLICY "vb_update" ON finance.vendor_bills FOR UPDATE USING (auth.uid() IS NOT NULL);

CREATE POLICY "vbl_select" ON finance.vendor_bill_lines FOR SELECT USING (auth.uid() IS NOT NULL);
CREATE POLICY "vbl_insert" ON finance.vendor_bill_lines FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);
CREATE POLICY "vbl_update" ON finance.vendor_bill_lines FOR UPDATE USING (auth.uid() IS NOT NULL);

CREATE POLICY "vp_select" ON finance.vendor_payments FOR SELECT USING (auth.uid() IS NOT NULL);
CREATE POLICY "vp_insert" ON finance.vendor_payments FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);
CREATE POLICY "vp_update" ON finance.vendor_payments FOR UPDATE USING (auth.uid() IS NOT NULL);

CREATE POLICY "vpa_select" ON finance.vendor_payment_allocations FOR SELECT USING (auth.uid() IS NOT NULL);
CREATE POLICY "vpa_insert" ON finance.vendor_payment_allocations FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);