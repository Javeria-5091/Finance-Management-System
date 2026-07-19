-- ==========================================
-- PHASE 1 - STEP 1.4: Fiscal Years & Accounting Periods
-- FIXED: Removed subquery from CHECK constraint
-- ==========================================

-- Drop existing tables if re-running
DROP TABLE IF EXISTS finance.accounting_periods CASCADE;
DROP TABLE IF EXISTS finance.fiscal_years CASCADE;
DROP VIEW IF EXISTS finance.fiscal_year_summary CASCADE;

-- ==========================================
-- FISCAL YEARS TABLE
-- ==========================================
CREATE TABLE finance.fiscal_years (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    
    name TEXT NOT NULL,
    start_date DATE NOT NULL,
    end_date DATE NOT NULL,
    status TEXT NOT NULL DEFAULT 'OPEN' 
        CHECK (status IN ('OPEN', 'SOFT_CLOSED', 'HARD_CLOSED')),
    description TEXT,
    closed_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    closed_at TIMESTAMPTZ,
    reopening_reason TEXT,
    
    -- Constraints
    CONSTRAINT fy_dates_valid CHECK (end_date > start_date),
    CONSTRAINT fy_name_not_empty CHECK (TRIM(name) != ''),
    CONSTRAINT fy_reopening_requires_reason CHECK (
        (status != 'OPEN' AND reopening_reason IS NOT NULL) OR status = 'OPEN'
    )
);

-- Indexes
CREATE INDEX idx_fy_status ON finance.fiscal_years(status);
CREATE INDEX idx_fy_dates ON finance.fiscal_years(start_date, end_date);

-- Trigger
CREATE TRIGGER fy_updated_at
    BEFORE UPDATE ON finance.fiscal_years
    FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();

-- ==========================================
-- ACCOUNTING PERIODS TABLE
-- ==========================================
CREATE TABLE finance.accounting_periods (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    
    fiscal_year_id UUID NOT NULL REFERENCES finance.fiscal_years(id) ON DELETE CASCADE,
    period_number INTEGER NOT NULL CHECK (period_number BETWEEN 1 AND 12),
    name TEXT NOT NULL,
    start_date DATE NOT NULL,
    end_date DATE NOT NULL,
    status TEXT NOT NULL DEFAULT 'OPEN'
        CHECK (status IN ('OPEN', 'SOFT_CLOSED', 'HARD_CLOSED')),
    closed_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    closed_at TIMESTAMPTZ,
    reopening_reason TEXT,
    
    -- Constraints (Subquery constraint removed - handled by app logic/seed data)
    CONSTRAINT ap_dates_valid CHECK (end_date > start_date),
    CONSTRAINT ap_fy_period_unique UNIQUE (fiscal_year_id, period_number),
    CONSTRAINT ap_name_not_empty CHECK (TRIM(name) != ''),
    CONSTRAINT ap_reopening_requires_reason CHECK (
        (status != 'OPEN' AND reopening_reason IS NOT NULL) OR status = 'OPEN'
    )
);

-- Indexes
CREATE INDEX idx_ap_fy_id ON finance.accounting_periods(fiscal_year_id);
CREATE INDEX idx_ap_status ON finance.accounting_periods(status);
CREATE INDEX idx_ap_dates ON finance.accounting_periods(start_date, end_date);
CREATE INDEX idx_ap_period_number ON finance.accounting_periods(fiscal_year_id, period_number);

-- Trigger
CREATE TRIGGER ap_updated_at
    BEFORE UPDATE ON finance.accounting_periods
    FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();

-- ==========================================
-- HELPER FUNCTIONS
-- ==========================================

-- Get Current Open Period
CREATE OR REPLACE FUNCTION finance.get_current_period()
RETURNS TABLE (
    period_id UUID,
    fiscal_year_id UUID,
    fiscal_year_name TEXT,
    period_number INTEGER,
    period_name TEXT,
    period_start DATE,
    period_end DATE,
    period_status TEXT
) AS $$ BEGIN
    RETURN QUERY
    SELECT 
        ap.id,
        ap.fiscal_year_id,
        fy.name,
        ap.period_number,
        ap.name,
        ap.start_date,
        ap.end_date,
        ap.status
    FROM finance.accounting_periods ap
    JOIN finance.fiscal_years fy ON ap.fiscal_year_id = fy.id
    WHERE ap.status = 'OPEN'
      AND fy.status = 'OPEN'
      AND CURRENT_DATE BETWEEN ap.start_date AND ap.end_date
    LIMIT 1;
END;
 $$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

-- Check if date is in open period
CREATE OR REPLACE FUNCTION finance.is_date_in_open_period(p_date DATE)
RETURNS BOOLEAN AS $$ DECLARE
    v_is_open BOOLEAN;
BEGIN
    SELECT EXISTS (
        SELECT 1 
        FROM finance.accounting_periods ap
        JOIN finance.fiscal_years fy ON ap.fiscal_year_id = fy.id
        WHERE ap.status = 'OPEN'
          AND fy.status = 'OPEN'
          AND p_date BETWEEN ap.start_date AND ap.end_date
    ) INTO v_is_open;
    
    RETURN v_is_open;
END;
 $$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

-- Get period by date
CREATE OR REPLACE FUNCTION finance.get_period_by_date(p_date DATE)
RETURNS TABLE (
    period_id UUID,
    fiscal_year_id UUID,
    fiscal_year_name TEXT,
    period_number INTEGER,
    period_name TEXT,
    period_start DATE,
    period_end DATE,
    period_status TEXT,
    fy_status TEXT
) AS $$ BEGIN
    RETURN QUERY
    SELECT 
        ap.id,
        ap.fiscal_year_id,
        fy.name,
        ap.period_number,
        ap.name,
        ap.start_date,
        ap.end_date,
        ap.status,
        fy.status
    FROM finance.accounting_periods ap
    JOIN finance.fiscal_years fy ON ap.fiscal_year_id = fy.id
    WHERE p_date BETWEEN ap.start_date AND ap.end_date
    LIMIT 1;
END;
 $$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

-- ==========================================
-- SEED DATA: FY 2024-25
-- ==========================================
INSERT INTO finance.fiscal_years (name, start_date, end_date, status, created_by) VALUES
('FY 2024-25', '2024-07-01', '2025-06-30', 'OPEN', (SELECT id FROM auth.users LIMIT 1));

-- Generate 12 periods for FY 2024-25
INSERT INTO finance.accounting_periods (fiscal_year_id, period_number, name, start_date, end_date, created_by)
SELECT 
    fy.id, 
    gs.period_num,
    TO_CHAR(gs.month_start, 'Month YYYY'),
    gs.month_start,
    (gs.month_start + INTERVAL '1 month' - INTERVAL '1 day')::date,
    (SELECT id FROM auth.users LIMIT 1)
FROM finance.fiscal_years fy,
    (
        SELECT 
            generate_series(1, 12) AS period_num,
            ('2024-07-01'::date + (generate_series(1, 12) - 1) * INTERVAL '1 month')::date AS month_start
    ) gs
WHERE fy.name = 'FY 2024-25';

-- ==========================================
-- SEED DATA: FY 2025-26
-- ==========================================
INSERT INTO finance.fiscal_years (name, start_date, end_date, status, created_by) VALUES
('FY 2025-26', '2025-07-01', '2026-06-30', 'OPEN', (SELECT id FROM auth.users LIMIT 1));

INSERT INTO finance.accounting_periods (fiscal_year_id, period_number, name, start_date, end_date, created_by)
SELECT 
    fy.id, 
    gs.period_num,
    TO_CHAR(gs.month_start, 'Month YYYY'),
    gs.month_start,
    (gs.month_start + INTERVAL '1 month' - INTERVAL '1 day')::date,
    (SELECT id FROM auth.users LIMIT 1)
FROM finance.fiscal_years fy,
    (
        SELECT 
            generate_series(1, 12) AS period_num,
            ('2025-07-01'::date + (generate_series(1, 12) - 1) * INTERVAL '1 month')::date AS month_start
    ) gs
WHERE fy.name = 'FY 2025-26';

-- ==========================================
-- VIEW: Fiscal Year Summary
-- ==========================================
CREATE OR REPLACE VIEW finance.fiscal_year_summary AS
SELECT 
    fy.id,                    -- Was: fiscal_year_id
    fy.name,                  -- Was: fiscal_year_name
    fy.start_date,            -- Was: fy_start_date
    fy.end_date,              -- Was: fy_end_date
    fy.status,                -- Was: fy_status
    fy.description,
    fy.closed_at,
    fy.created_at,
    fy.updated_at,
    fy.created_by,
    fy.closed_by,
    fy.reopening_reason,
    COUNT(ap.id) AS total_periods,
    COUNT(ap.id) FILTER (WHERE ap.status = 'OPEN') AS open_periods,
    COUNT(ap.id) FILTER (WHERE ap.status = 'SOFT_CLOSED') AS soft_closed_periods,
    COUNT(ap.id) FILTER (WHERE ap.status = 'HARD_CLOSED') AS hard_closed_periods
FROM finance.fiscal_years fy
LEFT JOIN finance.accounting_periods ap ON ap.fiscal_year_id = fy.id
GROUP BY fy.id, fy.name, fy.start_date, fy.end_date, fy.status, fy.description, 
         fy.closed_at, fy.created_at, fy.updated_at, fy.created_by, fy.closed_by, fy.reopening_reason
ORDER BY fy.start_date DESC;

-- ==========================================
-- ROW LEVEL SECURITY
-- ==========================================
ALTER TABLE finance.fiscal_years ENABLE ROW LEVEL SECURITY;
ALTER TABLE finance.accounting_periods ENABLE ROW LEVEL SECURITY;

-- FISCAL YEARS Policies
CREATE POLICY "fy_select" ON finance.fiscal_years
    FOR SELECT USING (auth.uid() IS NOT NULL);

CREATE POLICY "fy_insert" ON finance.fiscal_years
    FOR INSERT WITH CHECK (core.is_finance_head());

CREATE POLICY "fy_update" ON finance.fiscal_years
    FOR UPDATE USING (core.is_finance_head());

-- ACCOUNTING PERIODS Policies
CREATE POLICY "ap_select" ON finance.accounting_periods
    FOR SELECT USING (auth.uid() IS NOT NULL);

CREATE POLICY "ap_insert" ON finance.accounting_periods
    FOR INSERT WITH CHECK (core.is_finance_head());

CREATE POLICY "ap_update" ON finance.accounting_periods
    FOR UPDATE USING (core.is_finance_head());

-- Grant view access
GRANT SELECT ON finance.fiscal_year_summary TO authenticated;