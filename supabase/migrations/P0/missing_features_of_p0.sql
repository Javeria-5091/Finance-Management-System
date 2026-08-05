-- ============================================================
-- OSYSTIC P0 MISSING FEATURES - MIGRATION
-- Run this in Supabase SQL Editor (Staging first)
-- ============================================================

-- ─── 1. MFA ENROLLMENT TRACKING TABLE ───
CREATE TABLE IF NOT EXISTS public.user_mfa (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    factor_id TEXT NOT NULL,           -- Supabase MFA factor ID
    factor_type TEXT NOT NULL DEFAULT 'totp',
    is_verified BOOLEAN NOT NULL DEFAULT FALSE,
    verified_at TIMESTAMPTZ,
    enrolled_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_used_at TIMESTAMPTZ,
    UNIQUE(user_id, factor_id)
);

-- RLS
ALTER TABLE public.user_mfa ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users see own MFA" ON public.user_mfa
    FOR ALL USING (auth.uid() = user_id);

-- Admin/Service role can check MFA status
CREATE POLICY "Admin can read MFA status" ON public.user_mfa
    FOR SELECT USING (
        EXISTS (SELECT 1 FROM public.profiles p WHERE p.user_id = auth.uid() AND p.role IN ('CEO','Admin'))
    );

-- ─── 2. ADD mfa_required TO PROFILES (if not exists) ───
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_name = 'profiles' AND column_name = 'mfa_required') THEN
        ALTER TABLE public.profiles ADD COLUMN mfa_required BOOLEAN NOT NULL DEFAULT FALSE;
    END IF;
END $$;

-- ─── 3. TECHNICAL ADMIN ROLE SEED ───
-- Add TECHNICAL_ADMIN to the roles table (adjust schema name if different)
DO $$ BEGIN
    -- Try finance.roles first, fallback to public.roles
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'finance' AND table_name = 'roles') THEN
        INSERT INTO finance.roles (name, description, is_active, level)
        SELECT 'TECHNICAL_ADMIN', 'Database/system access without finance data permissions', true, 15
        WHERE NOT EXISTS (SELECT 1 FROM finance.roles WHERE name = 'TECHNICAL_ADMIN');
    END IF;

    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'roles') THEN
        INSERT INTO public.roles (name, description, is_active, level)
        SELECT 'TECHNICAL_ADMIN', 'Database/system access without finance data permissions', true, 15
        WHERE NOT EXISTS (SELECT 1 FROM public.roles WHERE name = 'TECHNICAL_ADMIN');
    END IF;
END $$;

-- ─── 4. BUDGET STATUS COLUMN (if not exists) ───
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_name = 'budgets' AND column_name = 'status') THEN
        ALTER TABLE finance.budgets ADD COLUMN status TEXT NOT NULL DEFAULT 'DRAFT'
            CHECK (status IN ('DRAFT','SUBMITTED','APPROVED','REJECTED'));
        ALTER TABLE finance.budgets ADD COLUMN submitted_by UUID;
        ALTER TABLE finance.budgets ADD COLUMN submitted_at TIMESTAMPTZ;
        ALTER TABLE finance.budgets ADD COLUMN approved_by UUID;
        ALTER TABLE finance.budgets ADD COLUMN approved_at TIMESTAMPTZ;
        ALTER TABLE finance.budgets ADD COLUMN rejection_reason TEXT;
    END IF;
END $$;

-- ─── 5. DUPLICATE VENDOR BILL PREVENTION ───
-- Partial unique index: one vendor_bill_number per vendor per org (only for non-draft)
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'uq_vendor_bill_number') THEN
        CREATE UNIQUE INDEX uq_vendor_bill_number 
        ON finance.vendor_bills (organization_id, vendor_id, bill_number) 
        WHERE status NOT IN ('DRAFT', 'CANCELLED', 'REJECTED');
    END IF;
END $$;

-- ─── 6. FILE HASH COLUMN ON ATTACHMENTS (if not exists) ───
DO $$ BEGIN
    -- Check if a finance.attachments or public.attachments table exists
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'attachments' AND table_schema = 'finance') THEN
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                       WHERE table_name = 'attachments' AND table_schema = 'finance' AND column_name = 'file_hash') THEN
            ALTER TABLE finance.attachments ADD COLUMN file_hash TEXT;
            CREATE INDEX idx_attachments_file_hash ON finance.attachments(file_hash);
        END IF;
    END IF;
    
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'attachments' AND table_schema = 'public') THEN
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                       WHERE table_name = 'attachments' AND table_schema = 'public' AND column_name = 'file_hash') THEN
            ALTER TABLE public.attachments ADD COLUMN file_hash TEXT;
            CREATE INDEX idx_attachments_file_hash ON public.attachments(file_hash);
        END IF;
    END IF;
END $$;

-- ─── 7. OPENING BALANCE IMPORT LOG TABLE ───
CREATE TABLE IF NOT EXISTS finance.opening_balance_imports (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES core.organizations(id),
    import_batch_id TEXT NOT NULL,
    account_id UUID NOT NULL REFERENCES finance.chart_of_accounts(id),
    account_code TEXT NOT NULL,
    account_name TEXT NOT NULL,
    debit_amount NUMERIC(18,2) DEFAULT 0,
    credit_amount NUMERIC(18,2) DEFAULT 0,
    currency TEXT NOT NULL DEFAULT 'PKR',
    exchange_rate NUMERIC(18,6) DEFAULT 1,
    base_amount NUMERIC(18,2) DEFAULT 0,
    fiscal_year_id UUID,
    status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','IMPORTED','FAILED','REVERSED')),
    journal_entry_id UUID,
    error_message TEXT,
    imported_by UUID NOT NULL,
    imported_at TIMESTAMPTZ DEFAULT now(),
    created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE finance.opening_balance_imports ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Org scope opening balance imports" ON finance.opening_balance_imports
    FOR ALL USING (organization_id = (SELECT organization_id FROM public.profiles WHERE user_id = auth.uid()));

-- ─── 8. AUTO-NUMBER FOR OPENING BALANCE BATCHES ───
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM finance.numbering_sequences WHERE sequence_code = 'OBI') THEN
        INSERT INTO finance.numbering_sequences (organization_id, sequence_code, prefix, current_number, fiscal_year_id)
        VALUES (
            (SELECT id FROM core.organizations LIMIT 1),
            'OBI', 'OBI-', 0,
            (SELECT id FROM finance.fiscal_years WHERE is_current = true LIMIT 1)
        );
    END IF;
END $$;

-- ============================================================
-- DONE: Verify with:
-- SELECT * FROM public.user_mfa LIMIT 0;
-- SELECT mfa_required FROM public.profiles LIMIT 0;
-- SELECT status FROM finance.budgets LIMIT 0;
-- SELECT file_hash FROM finance.attachments LIMIT 0;
-- ============================================================
