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

-- ─── 3. TECHNICAL ADMIN ROLE SEED (FINAL FIX) ───
DO $$ BEGIN
    -- ── finance.roles ──
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'finance' AND table_name = 'roles') THEN
        IF EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_schema = 'finance' AND table_name = 'roles' AND column_name = 'display_name') THEN
            INSERT INTO finance.roles (name, display_name, description, level)
            SELECT 'TECHNICAL_ADMIN', 'Technical Admin', 'Database/system access without finance data permissions', 15
            WHERE NOT EXISTS (SELECT 1 FROM finance.roles WHERE name = 'TECHNICAL_ADMIN');
        ELSIF EXISTS (SELECT 1 FROM information_schema.columns 
                      WHERE table_schema = 'finance' AND table_name = 'roles' AND column_name = 'is_active') THEN
            INSERT INTO finance.roles (name, description, is_active, level)
            SELECT 'TECHNICAL_ADMIN', 'Database/system access without finance data permissions', true, 15
            WHERE NOT EXISTS (SELECT 1 FROM finance.roles WHERE name = 'TECHNICAL_ADMIN');
        ELSE
            INSERT INTO finance.roles (name, description, level)
            SELECT 'TECHNICAL_ADMIN', 'Database/system access without finance data permissions', 15
            WHERE NOT EXISTS (SELECT 1 FROM finance.roles WHERE name = 'TECHNICAL_ADMIN');
        END IF;
    END IF;

    -- ── public.roles ──
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'roles') THEN
        IF EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_schema = 'public' AND table_name = 'roles' AND column_name = 'display_name') THEN
            INSERT INTO public.roles (name, display_name, description, level)
            SELECT 'TECHNICAL_ADMIN', 'Technical Admin', 'Database/system access without finance data permissions', 15
            WHERE NOT EXISTS (SELECT 1 FROM public.roles WHERE name = 'TECHNICAL_ADMIN');
        ELSIF EXISTS (SELECT 1 FROM information_schema.columns 
                      WHERE table_schema = 'public' AND table_name = 'roles' AND column_name = 'is_active') THEN
            INSERT INTO public.roles (name, description, is_active, level)
            SELECT 'TECHNICAL_ADMIN', 'Database/system access without finance data permissions', true, 15
            WHERE NOT EXISTS (SELECT 1 FROM public.roles WHERE name = 'TECHNICAL_ADMIN');
        ELSE
            INSERT INTO public.roles (name, description, level)
            SELECT 'TECHNICAL_ADMIN', 'Database/system access without finance data permissions', 15
            WHERE NOT EXISTS (SELECT 1 FROM public.roles WHERE name = 'TECHNICAL_ADMIN');
        END IF;
    END IF;

    -- ── core.roles (tumhare RBAC functions ye use karte hain) ──
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'core' AND table_name = 'roles') THEN
        IF EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_schema = 'core' AND table_name = 'roles' AND column_name = 'display_name') THEN
            INSERT INTO core.roles (name, display_name, description, level)
            SELECT 'TECHNICAL_ADMIN', 'Technical Admin', 'Database/system access without finance data permissions', 15
            WHERE NOT EXISTS (SELECT 1 FROM core.roles WHERE name = 'TECHNICAL_ADMIN');
        ELSIF EXISTS (SELECT 1 FROM information_schema.columns 
                      WHERE table_schema = 'core' AND table_name = 'roles' AND column_name = 'is_active') THEN
            INSERT INTO core.roles (name, description, is_active, level)
            SELECT 'TECHNICAL_ADMIN', 'Database/system access without finance data permissions', true, 15
            WHERE NOT EXISTS (SELECT 1 FROM core.roles WHERE name = 'TECHNICAL_ADMIN');
        ELSE
            INSERT INTO core.roles (name, description, level)
            SELECT 'TECHNICAL_ADMIN', 'Database/system access without finance data permissions', 15
            WHERE NOT EXISTS (SELECT 1 FROM core.roles WHERE name = 'TECHNICAL_ADMIN');
        END IF;
    END IF;
END $$;

-- ─── 4. BUDGET STATUS COLUMN (if not exists) ───
-- Ye theek hai, koi change nahi
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_name = 'budgets' AND table_schema = 'public' AND column_name = 'status') THEN
        ALTER TABLE public.budgets ADD COLUMN status TEXT NOT NULL DEFAULT 'DRAFT'
            CHECK (status IN ('DRAFT','SUBMITTED','APPROVED','REJECTED'));
        ALTER TABLE public.budgets ADD COLUMN submitted_by UUID;
        ALTER TABLE public.budgets ADD COLUMN submitted_at TIMESTAMPTZ;
        ALTER TABLE public.budgets ADD COLUMN approved_by UUID;
        ALTER TABLE public.budgets ADD COLUMN approved_at TIMESTAMPTZ;
        ALTER TABLE public.budgets ADD COLUMN rejection_reason TEXT;
    END IF;
END $$;


-- ─── 5. DUPLICATE VENDOR BILL PREVENTION ───
-- Ye theek hai, koi change nahi
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'uq_vendor_bill_number') THEN
        CREATE UNIQUE INDEX uq_vendor_bill_number 
        ON finance.vendor_bills (vendor_id, bill_number) 
        WHERE status NOT IN ('DRAFT', 'CANCELLED', 'REJECTED');
    END IF;
END $$;


-- ─── 6. FILE HASH COLUMN ON ATTACHMENTS ───
-- Ye theek hai, koi change nahi
DO $$ BEGIN
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

-- ═══════════════════════════════════════════════════════════
-- STEP 7: OPENING BALANCE IMPORT LOG TABLE
-- ═══════════════════════════════════════════════════════════
DO $$ BEGIN
    DECLARE
        v_org_schema TEXT;
    BEGIN
        IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'core' AND table_name = 'organizations') THEN
            v_org_schema := 'core';
        ELSIF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'organizations') THEN
            v_org_schema := 'public';
        ELSE
            RAISE NOTICE 'SKIPPED: opening_balance_imports — no organizations table found';
            RETURN;
        END IF;

        IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'finance' AND table_name = 'opening_balance_imports') THEN
            RAISE NOTICE 'SKIPPED: opening_balance_imports already exists';
            RETURN;
        END IF;

        EXECUTE format('
            CREATE TABLE finance.opening_balance_imports (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                organization_id UUID NOT NULL REFERENCES %I.organizations(id),
                import_batch_id TEXT NOT NULL,
                account_id UUID NOT NULL REFERENCES finance.chart_of_accounts(id),
                account_code TEXT NOT NULL,
                account_name TEXT NOT NULL,
                debit_amount NUMERIC(18,2) DEFAULT 0,
                credit_amount NUMERIC(18,2) DEFAULT 0,
                currency TEXT NOT NULL DEFAULT ''PKR'',
                exchange_rate NUMERIC(18,6) DEFAULT 1,
                base_amount NUMERIC(18,2) DEFAULT 0,
                fiscal_year_id UUID,
                status TEXT NOT NULL DEFAULT ''PENDING'' CHECK (status IN (''PENDING'',''IMPORTED'',''FAILED'',''REVERSED'')),
                journal_entry_id UUID,
                error_message TEXT,
                imported_by UUID NOT NULL,
                imported_at TIMESTAMPTZ DEFAULT now(),
                created_at TIMESTAMPTZ DEFAULT now()
            );

            ALTER TABLE finance.opening_balance_imports ENABLE ROW LEVEL SECURITY;

            CREATE POLICY "Org scope opening balance imports" ON finance.opening_balance_imports
                FOR ALL USING (organization_id = (SELECT organization_id FROM public.profiles WHERE user_id = auth.uid()));
        ', v_org_schema);

        RAISE NOTICE 'Created finance.opening_balance_imports referencing %.organizations', v_org_schema;
    END;
END $$;


-- ═══════════════════════════════════════════════════════════
-- STEP 8: AUTO-NUMBER FOR OPENING BALANCE BATCHES (FIXED)
-- ═══════════════════════════════════════════════════════════
DO $$ BEGIN
    DECLARE
        v_org_schema TEXT;
        v_insert_sql TEXT;
    BEGIN
        -- Organizations dhundo
        IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'core' AND table_name = 'organizations') THEN
            v_org_schema := 'core';
        ELSIF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'organizations') THEN
            v_org_schema := 'public';
        ELSE
            RAISE NOTICE 'SKIPPED: OBI sequence — no organizations table';
            RETURN;
        END IF;

        -- numbering_sequences check
        IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'finance' AND table_name = 'numbering_sequences') THEN
            RAISE NOTICE 'SKIPPED: OBI sequence — numbering_sequences table not found';
            RETURN;
        END IF;

        -- Already exists?
        IF EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_schema = 'finance' AND table_name = 'numbering_sequences' AND column_name = 'sequence_type') THEN
            IF EXISTS (SELECT 1 FROM finance.numbering_sequences WHERE sequence_type = 'OBI') THEN
                RAISE NOTICE 'SKIPPED: OBI sequence already exists';
                RETURN;
            END IF;
        END IF;

        -- Dynamic INSERT build karo
        v_insert_sql := 'INSERT INTO finance.numbering_sequences (';

        IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'finance' AND table_name = 'numbering_sequences' AND column_name = 'organization_id') THEN
            v_insert_sql := v_insert_sql || 'organization_id, ';
        END IF;
        IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'finance' AND table_name = 'numbering_sequences' AND column_name = 'sequence_type') THEN
            v_insert_sql := v_insert_sql || 'sequence_type, ';
        ELSIF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'finance' AND table_name = 'numbering_sequences' AND column_name = 'sequence_code') THEN
            v_insert_sql := v_insert_sql || 'sequence_code, ';
        END IF;
        IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'finance' AND table_name = 'numbering_sequences' AND column_name = 'prefix') THEN
            v_insert_sql := v_insert_sql || 'prefix, ';
        END IF;
        IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'finance' AND table_name = 'numbering_sequences' AND column_name = 'format') THEN
            v_insert_sql := v_insert_sql || 'format, ';
        END IF;
        IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'finance' AND table_name = 'numbering_sequences' AND column_name = 'padding') THEN
            v_insert_sql := v_insert_sql || 'padding, ';
        END IF;
        IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'finance' AND table_name = 'numbering_sequences' AND column_name = 'current_number') THEN
            v_insert_sql := v_insert_sql || 'current_number, ';
        END IF;
        IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'finance' AND table_name = 'numbering_sequences' AND column_name = 'fiscal_year_id') THEN
            v_insert_sql := v_insert_sql || 'fiscal_year_id';
        END IF;

        v_insert_sql := REGEXP_REPLACE(v_insert_sql, ',\s*$', '') || ') VALUES (';

        -- Values
        IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'finance' AND table_name = 'numbering_sequences' AND column_name = 'organization_id') THEN
            v_insert_sql := v_insert_sql || format('(SELECT id FROM %I.organizations LIMIT 1), ', v_org_schema);
        END IF;
        IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'finance' AND table_name = 'numbering_sequences' AND column_name = 'sequence_type') THEN
            v_insert_sql := v_insert_sql || '''OBI'', ';
        ELSIF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'finance' AND table_name = 'numbering_sequences' AND column_name = 'sequence_code') THEN
            v_insert_sql := v_insert_sql || '''OBI'', ';
        END IF;
        IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'finance' AND table_name = 'numbering_sequences' AND column_name = 'prefix') THEN
            v_insert_sql := v_insert_sql || '''OBI-'', ';
        END IF;
        IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'finance' AND table_name = 'numbering_sequences' AND column_name = 'format') THEN
            v_insert_sql := v_insert_sql || '''{PREFIX}{NUMBER}'', ';
        END IF;
        IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'finance' AND table_name = 'numbering_sequences' AND column_name = 'padding') THEN
            v_insert_sql := v_insert_sql || '5, ';
        END IF;
        IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'finance' AND table_name = 'numbering_sequences' AND column_name = 'current_number') THEN
            v_insert_sql := v_insert_sql || '0, ';
        END IF;
        IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'finance' AND table_name = 'numbering_sequences' AND column_name = 'fiscal_year_id') THEN
            -- ✅ FIX: is_current = true HATA DO, status = 'OPEN' use karo
            v_insert_sql := v_insert_sql || '(SELECT id FROM finance.fiscal_years WHERE status = ''OPEN'' ORDER BY start_date DESC LIMIT 1)';
        END IF;

        v_insert_sql := REGEXP_REPLACE(v_insert_sql, ',\s*$', '') || ')';

        EXECUTE v_insert_sql;
        RAISE NOTICE 'Created OBI numbering sequence';
    END;
END $$;

-- ═══════════════════════════════════════════════════════════
-- VERIFY
-- ═══════════════════════════════════════════════════════════
-- SELECT * FROM core.organizations;
-- SELECT * FROM finance.opening_balance_imports LIMIT 0;
-- SELECT * FROM finance.numbering_sequences WHERE sequence_type = 'OBI' OR sequence_code = 'OBI';