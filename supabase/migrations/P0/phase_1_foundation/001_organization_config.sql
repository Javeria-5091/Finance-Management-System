-- ==========================================
-- PHASE 1 - STEP 1.2: Organization Configuration
-- ==========================================

-- Table create karo
CREATE TABLE IF NOT EXISTS core.organization_config (
    -- Default columns (RULE 3)
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    
    -- Business columns
    org_name TEXT NOT NULL,
    base_currency TEXT NOT NULL DEFAULT 'PKR',
    enabled_currencies TEXT[] DEFAULT '{"PKR","USD"}',
    timezone TEXT DEFAULT 'Asia/Karachi',
    date_format TEXT DEFAULT 'DD/MM/YYYY',
    number_format TEXT DEFAULT 'en-PK',
    fiscal_year_start_month INTEGER NOT NULL DEFAULT 7 CHECK (fiscal_year_start_month BETWEEN 1 AND 12),
    fiscal_year_end_month INTEGER NOT NULL DEFAULT 6 CHECK (fiscal_year_end_month BETWEEN 1 AND 12),
    decimal_precision INTEGER DEFAULT 2 CHECK (decimal_precision BETWEEN 0 AND 6),
    rounding_method TEXT DEFAULT 'HALF_UP' CHECK (rounding_method IN ('HALF_UP', 'HALF_DOWN', 'CEILING', 'FLOOR', 'UP', 'DOWN')),
    logo_url TEXT,
    active BOOLEAN DEFAULT true,
    
    -- Business constraint: start aur end month different honay chahiye
    CONSTRAINT valid_fiscal_months CHECK (fiscal_year_start_month != fiscal_year_end_month)
);

-- Index
CREATE INDEX IF NOT EXISTS idx_org_config_active ON core.organization_config(active);

-- Updated_at trigger
DROP TRIGGER IF EXISTS org_config_updated_at ON core.organization_config;
CREATE TRIGGER org_config_updated_at
    BEFORE UPDATE ON core.organization_config
    FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();

-- ==========================================
-- SEED DATA
-- ==========================================
INSERT INTO core.organization_config (
    org_name, 
    base_currency, 
    enabled_currencies, 
    timezone, 
    fiscal_year_start_month, 
    fiscal_year_end_month,
    created_by
)
VALUES (
    'OSYSTIC', 
    'PKR', 
    '{"PKR","USD","EUR"}', 
    'Asia/Karachi', 
    7, 
    6,
    (SELECT id FROM auth.users LIMIT 1)
)
ON CONFLICT DO NOTHING;

-- ==========================================
-- ROW LEVEL SECURITY
-- ==========================================
ALTER TABLE core.organization_config ENABLE ROW LEVEL SECURITY;

-- SELECT: Sab authenticated users dekh sakte hain (single org system)
CREATE POLICY "org_config_select" ON core.organization_config
    FOR SELECT USING (auth.uid() IS NOT NULL);

-- INSERT: Sirf CEO ya Admin
CREATE POLICY "org_config_insert" ON core.organization_config
    FOR INSERT WITH CHECK (core.is_ceo_or_admin());

-- UPDATE: Sirf CEO ya Admin
CREATE POLICY "org_config_update" ON core.organization_config
    FOR UPDATE USING (core.is_ceo_or_admin());

-- DELETE: DENY FOR ALL (RULE 4: soft delete only)
-- No delete policy = implicitly denied

-- ==========================================
-- AUDIT TRIGGER
-- ==========================================
-- (Step 1.5 mein audit trigger function banegi, phir yeh trigger lagayenge)
-- Abhi placeholder comment rakhte hain
-- CREATE TRIGGER org_config_audit AFTER INSERT OR UPDATE ON core.organization_config
--     FOR EACH ROW EXECUTE FUNCTION audit.trigger_audit_log();