-- ═══════════════════════════════════════════════════════════
-- STEP 0: CREATE ORGANIZATIONS TABLE (MISSING P0 REQUIREMENT)
-- ═══════════════════════════════════════════════════════════
DO $$ BEGIN
    -- core.organizations pehle check karo
    IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'core' AND table_name = 'organizations') THEN
        
        -- public.organizations bhi check karo
        IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'organizations') THEN
            
            -- ── PHLE organizations table banao ──
            CREATE TABLE core.organizations (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                name TEXT NOT NULL,
                legal_name TEXT,
                type TEXT DEFAULT 'COMPANY' CHECK (type IN ('COMPANY','SOLE_PROPRIETOR','PARTNERSHIP','AOP','OTHER')),
                tax_registration TEXT,
                ntn TEXT,
                base_currency TEXT NOT NULL DEFAULT 'PKR',
                timezone TEXT NOT NULL DEFAULT 'Asia/Karachi',
                date_format TEXT NOT NULL DEFAULT 'DD/MM/YYYY',
                number_format TEXT NOT NULL DEFAULT 'EN',
                fiscal_year_start_month INTEGER NOT NULL DEFAULT 7,
                is_active BOOLEAN NOT NULL DEFAULT TRUE,
                address TEXT,
                city TEXT,
                country TEXT NOT NULL DEFAULT 'Pakistan',
                phone TEXT,
                email TEXT,
                website TEXT,
                logo_url TEXT,
                config JSONB DEFAULT '{}'::JSONB,
                created_by UUID,
                created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
            );

            RAISE NOTICE 'Created core.organizations table';

            -- ── AB profiles mein organization_id column add karo ──
            IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                           WHERE table_schema = 'public' AND table_name = 'profiles' AND column_name = 'organization_id') THEN
                ALTER TABLE public.profiles ADD COLUMN organization_id UUID;
                RAISE NOTICE 'Added organization_id column to public.profiles';
            END IF;

            -- ── AB FK constraint add karo ──
            IF NOT EXISTS (
                SELECT 1 FROM information_schema.table_constraints 
                WHERE constraint_schema = 'public' 
                AND table_name = 'profiles' 
                AND constraint_name = 'fk_profiles_organization_id'
            ) THEN
                ALTER TABLE public.profiles 
                ADD CONSTRAINT fk_profiles_organization_id 
                FOREIGN KEY (organization_id) REFERENCES core.organizations(id) ON DELETE SET NULL;
                RAISE NOTICE 'Added FK constraint profiles.organization_id -> core.organizations.id';
            END IF;

            -- ── AB RLS enable karo ──
            ALTER TABLE core.organizations ENABLE ROW LEVEL SECURITY;

            -- ── AB policies banao (ab organization_id column exist karta hai) ──
            CREATE POLICY "Admins manage organizations" ON core.organizations
                FOR ALL USING (
                    EXISTS (
                        SELECT 1 FROM public.profiles p 
                        WHERE p.user_id = auth.uid() 
                        AND p.role IN ('CEO', 'Admin')
                    )
                );

            CREATE POLICY "Users can read their org" ON core.organizations
                FOR SELECT USING (
                    id = (SELECT organization_id FROM public.profiles WHERE user_id = auth.uid())
                );

            RAISE NOTICE 'Created RLS policies on core.organizations';

            -- ── Migration from organization_config ──
            IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'organization_config') THEN
                BEGIN
                    IF EXISTS (SELECT 1 FROM information_schema.columns 
                               WHERE table_name = 'organization_config' AND column_name = 'company_name') THEN
                        INSERT INTO core.organizations (name, legal_name, base_currency, timezone)
                        SELECT company_name, company_name, 
                               COALESCE(base_currency, 'PKR'), 
                               COALESCE(timezone, 'Asia/Karachi')
                        FROM organization_config 
                        WHERE NOT EXISTS (SELECT 1 FROM core.organizations)
                        LIMIT 1;
                    ELSIF EXISTS (SELECT 1 FROM information_schema.columns 
                                  WHERE table_name = 'organization_config' AND column_name = 'org_name') THEN
                        INSERT INTO core.organizations (name, legal_name, base_currency, timezone)
                        SELECT org_name, org_name, 
                               COALESCE(base_currency, 'PKR'), 
                               COALESCE(timezone, 'Asia/Karachi')
                        FROM organization_config 
                        WHERE NOT EXISTS (SELECT 1 FROM core.organizations)
                        LIMIT 1;
                    END IF;
                    RAISE NOTICE 'Migrated data from organization_config';
                EXCEPTION WHEN OTHERS THEN
                    RAISE NOTICE 'Could not migrate from organization_config: %', SQLERRM;
                END;
            END IF;

            -- ── Default OSYSTIC org ──
            IF NOT EXISTS (SELECT 1 FROM core.organizations LIMIT 1) THEN
                INSERT INTO core.organizations (name, legal_name, base_currency, timezone, country)
                VALUES ('OSYSTIC', 'OSYSTIC', 'PKR', 'Asia/Karachi', 'Pakistan');
                RAISE NOTICE 'Created default OSYSTIC organization';
            END IF;

            -- ── Profiles link karo ──
            UPDATE public.profiles 
            SET organization_id = (SELECT id FROM core.organizations LIMIT 1)
            WHERE organization_id IS NULL;
            
            RAISE NOTICE 'Linked profiles to organization';

        ELSE
            RAISE NOTICE 'public.organizations already exists, skipping creation';
        END IF;
    ELSE
        RAISE NOTICE 'core.organizations already exists, skipping creation';
    END IF;
END $$;