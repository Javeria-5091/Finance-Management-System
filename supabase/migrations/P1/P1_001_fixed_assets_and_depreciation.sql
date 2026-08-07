-- =============================================================================
-- P1.001: Fixed Assets and Depreciation
-- OSYSTIC Finance Management System
-- Creates: asset categories, fixed assets, depreciation schedules, disposal tracking
-- RLS: Same pattern as P0 finance tables (auth.uid() IS NOT NULL)
-- Currency: TEXT columns (same as P0 — no finance.currencies table)
-- =============================================================================

BEGIN;

-- Asset Categories
CREATE TABLE IF NOT EXISTS finance.asset_categories (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code            VARCHAR(50) NOT NULL,
    name            VARCHAR(200) NOT NULL,
    description     TEXT,

    -- Depreciation defaults
    useful_life_months  INTEGER NOT NULL DEFAULT 60,
    residual_value_pct  NUMERIC(5,2) NOT NULL DEFAULT 0,
    depreciation_method VARCHAR(50) NOT NULL DEFAULT 'straight_line'
        CHECK (depreciation_method IN ('straight_line','declining_balance','units_of_production')),

    -- Capitalization control
    capitalization_threshold NUMERIC(18,2) NOT NULL DEFAULT 0,

    -- Ledger mapping
    linked_asset_account_id        UUID NOT NULL REFERENCES finance.chart_of_accounts(id),
    linked_depreciation_account_id  UUID NOT NULL REFERENCES finance.chart_of_accounts(id),
    linked_expense_account_id       UUID NOT NULL REFERENCES finance.chart_of_accounts(id),

    active          BOOLEAN NOT NULL DEFAULT TRUE,
    created_by      UUID NOT NULL REFERENCES auth.users(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

    UNIQUE(code)
);

CREATE INDEX idx_asset_categories_active ON finance.asset_categories(active);

-- Fixed Assets Register
CREATE TABLE IF NOT EXISTS finance.fixed_assets (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code            VARCHAR(50) NOT NULL,
    name            VARCHAR(300) NOT NULL,
    category_id     UUID NOT NULL REFERENCES finance.asset_categories(id),
    description     TEXT,

    -- Purchase details
    vendor_id       UUID REFERENCES finance.vendors(id),
    purchase_date   DATE NOT NULL,
    purchase_cost   NUMERIC(18,2) NOT NULL CHECK (purchase_cost >= 0),
    currency        TEXT NOT NULL DEFAULT 'PKR',
    base_cost       NUMERIC(18,2) NOT NULL CHECK (base_cost >= 0),
    exchange_rate_id UUID REFERENCES finance.exchange_rates(id),

    -- Identification
    serial_number   VARCHAR(200),
    warranty_start  DATE,
    warranty_end    DATE,

    -- Assignment
    location        VARCHAR(200),
    assigned_user_id UUID REFERENCES auth.users(id),

    -- Depreciation parameters (can override category defaults)
    useful_life_months  INTEGER,
    residual_value_pct  NUMERIC(5,2),
    depreciation_method VARCHAR(50)
        CHECK (depreciation_method IS NULL OR depreciation_method IN ('straight_line','declining_balance','units_of_production')),
    residual_value_amount NUMERIC(18,2),

    -- Calculated / maintained values
    accumulated_depreciation NUMERIC(18,2) NOT NULL DEFAULT 0,
    net_book_value           NUMERIC(18,2) NOT NULL DEFAULT 0,

    -- Ledger accounts (override category defaults)
    linked_asset_account_id        UUID REFERENCES finance.chart_of_accounts(id),
    linked_depreciation_account_id  UUID REFERENCES finance.chart_of_accounts(id),
    linked_expense_account_id       UUID REFERENCES finance.chart_of_accounts(id),

    -- Dimensional allocation
    project_id      UUID REFERENCES public.projects(id),
    department_id   UUID,
    cost_center_id  UUID,

    -- Status lifecycle
    status          VARCHAR(50) NOT NULL DEFAULT 'pending_capitalization'
        CHECK (status IN (
            'pending_capitalization','active','fully_depreciated',
            'under_repair','disposed','sold'
        )),

    -- Disposal details
    disposal_date       DATE,
    disposal_value      NUMERIC(18,2),
    disposal_currency   TEXT,
    disposal_method     VARCHAR(100),
    gain_loss_amount    NUMERIC(18,2),
    disposal_journal_id UUID REFERENCES finance.journal_entries(id),

    -- Approval
    approved_by     UUID REFERENCES auth.users(id),
    approved_at     TIMESTAMPTZ,

    -- Audit
    created_by      UUID NOT NULL REFERENCES auth.users(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

    UNIQUE(code)
);

CREATE INDEX idx_fixed_assets_category ON finance.fixed_assets(category_id);
CREATE INDEX idx_fixed_assets_status ON finance.fixed_assets(status);
CREATE INDEX idx_fixed_assets_project ON finance.fixed_assets(project_id);
CREATE INDEX idx_fixed_assets_vendor ON finance.fixed_assets(vendor_id);

-- Depreciation Schedule
CREATE TABLE IF NOT EXISTS finance.depreciation_schedule (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    asset_id        UUID NOT NULL REFERENCES finance.fixed_assets(id),
    period_id       UUID NOT NULL REFERENCES finance.accounting_periods(id),
    fiscal_year_id  UUID NOT NULL REFERENCES finance.fiscal_years(id),

    opening_nbv         NUMERIC(18,2) NOT NULL,
    depreciation_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
    closing_nbv         NUMERIC(18,2) NOT NULL,

    method          VARCHAR(50) NOT NULL DEFAULT 'straight_line',
    rate            NUMERIC(8,4) NOT NULL DEFAULT 0,
    days_in_period  INTEGER NOT NULL DEFAULT 30,

    journal_entry_id UUID REFERENCES finance.journal_entries(id),
    status          VARCHAR(30) NOT NULL DEFAULT 'calculated'
        CHECK (status IN ('calculated','posted','reversed','skipped')),

    calculated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    posted_at        TIMESTAMPTZ,

    created_by      UUID NOT NULL REFERENCES auth.users(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

    UNIQUE(asset_id, period_id)
);

CREATE INDEX idx_depreciation_schedule_asset ON finance.depreciation_schedule(asset_id);
CREATE INDEX idx_depreciation_schedule_period ON finance.depreciation_schedule(period_id);
CREATE INDEX idx_depreciation_schedule_status ON finance.depreciation_schedule(status);

-- Asset Physical Verification
CREATE TABLE IF NOT EXISTS finance.asset_verifications (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    verification_code VARCHAR(50) NOT NULL,
    verification_date DATE NOT NULL,
    verified_by     UUID NOT NULL REFERENCES auth.users(id),
    notes           TEXT,
    status          VARCHAR(30) NOT NULL DEFAULT 'in_progress'
        CHECK (status IN ('in_progress','completed','discrepancy_found')),

    created_by      UUID NOT NULL REFERENCES auth.users(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

    UNIQUE(verification_code)
);

-- Asset Verification Lines
CREATE TABLE IF NOT EXISTS finance.asset_verification_lines (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    verification_id     UUID NOT NULL REFERENCES finance.asset_verifications(id) ON DELETE CASCADE,
    asset_id            UUID NOT NULL REFERENCES finance.fixed_assets(id),

    physical_location   VARCHAR(200),
    physical_condition  VARCHAR(100),
    is_verified         BOOLEAN NOT NULL DEFAULT FALSE,
    discrepancy_notes   TEXT,

    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

    UNIQUE(verification_id, asset_id)
);

ALTER TABLE finance.asset_verification_lines
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();

DROP TRIGGER IF EXISTS trg_asset_verification_lines_ts
  ON finance.asset_verification_lines;

CREATE TRIGGER trg_asset_verification_lines_ts
    BEFORE UPDATE ON finance.asset_verification_lines
    FOR EACH ROW EXECUTE FUNCTION finance.fn_update_timestamp();
    
-- =============================================================================
-- RLS Policies — Same pattern as P0 finance tables (auth.uid() IS NOT NULL)
-- =============================================================================

ALTER TABLE finance.asset_categories ENABLE ROW LEVEL SECURITY;

CREATE POLICY "asset_categories_select" ON finance.asset_categories
    FOR SELECT USING (auth.uid() IS NOT NULL);
CREATE POLICY "asset_categories_insert" ON finance.asset_categories
    FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);
CREATE POLICY "asset_categories_update" ON finance.asset_categories
    FOR UPDATE USING (auth.uid() IS NOT NULL);

ALTER TABLE finance.fixed_assets ENABLE ROW LEVEL SECURITY;

CREATE POLICY "fixed_assets_select" ON finance.fixed_assets
    FOR SELECT USING (auth.uid() IS NOT NULL);
CREATE POLICY "fixed_assets_insert" ON finance.fixed_assets
    FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);
CREATE POLICY "fixed_assets_update" ON finance.fixed_assets
    FOR UPDATE USING (auth.uid() IS NOT NULL);
CREATE POLICY "fixed_assets_delete" ON finance.fixed_assets
    FOR DELETE USING (auth.uid() = created_by AND status = 'pending_capitalization');

ALTER TABLE finance.depreciation_schedule ENABLE ROW LEVEL SECURITY;

CREATE POLICY "depreciation_schedule_select" ON finance.depreciation_schedule
    FOR SELECT USING (auth.uid() IS NOT NULL);
CREATE POLICY "depreciation_schedule_insert" ON finance.depreciation_schedule
    FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);
CREATE POLICY "depreciation_schedule_update" ON finance.depreciation_schedule
    FOR UPDATE USING (auth.uid() IS NOT NULL);
CREATE POLICY "depreciation_schedule_delete" ON finance.depreciation_schedule
    FOR DELETE USING (auth.uid() = created_by AND status = 'calculated');

ALTER TABLE finance.asset_verifications ENABLE ROW LEVEL SECURITY;

CREATE POLICY "asset_verifications_select" ON finance.asset_verifications
    FOR SELECT USING (auth.uid() IS NOT NULL);
CREATE POLICY "asset_verifications_insert" ON finance.asset_verifications
    FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);
CREATE POLICY "asset_verifications_update" ON finance.asset_verifications
    FOR UPDATE USING (auth.uid() IS NOT NULL);

ALTER TABLE finance.asset_verification_lines ENABLE ROW LEVEL SECURITY;

CREATE POLICY "asset_verification_lines_select" ON finance.asset_verification_lines
    FOR SELECT USING (
        EXISTS (SELECT 1 FROM finance.asset_verifications v WHERE v.id = asset_verification_lines.verification_id)
    );
CREATE POLICY "asset_verification_lines_insert" ON finance.asset_verification_lines
    FOR INSERT WITH CHECK (
        EXISTS (SELECT 1 FROM finance.asset_verifications v WHERE v.id = asset_verification_lines.verification_id AND v.status = 'in_progress')
    );
CREATE POLICY "asset_verification_lines_update" ON finance.asset_verification_lines
    FOR UPDATE USING (
        EXISTS (SELECT 1 FROM finance.asset_verifications v WHERE v.id = asset_verification_lines.verification_id AND v.status = 'in_progress')
    );

-- =============================================================================
-- Triggers
-- =============================================================================

CREATE OR REPLACE FUNCTION finance.fn_update_timestamp()
RETURNS TRIGGER AS $$ BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
 $$ LANGUAGE plpgsql;

CREATE TRIGGER trg_asset_categories_ts
    BEFORE UPDATE ON finance.asset_categories
    FOR EACH ROW EXECUTE FUNCTION finance.fn_update_timestamp();

CREATE TRIGGER trg_fixed_assets_ts
    BEFORE UPDATE ON finance.fixed_assets
    FOR EACH ROW EXECUTE FUNCTION finance.fn_update_timestamp();

CREATE TRIGGER trg_depreciation_schedule_ts
    BEFORE UPDATE ON finance.depreciation_schedule
    FOR EACH ROW EXECUTE FUNCTION finance.fn_update_timestamp();

CREATE TRIGGER trg_asset_verifications_ts
    BEFORE UPDATE ON finance.asset_verifications
    FOR EACH ROW EXECUTE FUNCTION finance.fn_update_timestamp();

-- =============================================================================
-- fn_update_asset_nbv
-- =============================================================================
CREATE OR REPLACE FUNCTION finance.fn_update_asset_nbv()
RETURNS TRIGGER AS $$ DECLARE
    rv NUMERIC(18,2);
BEGIN
    IF NEW.accumulated_depreciation IS NULL THEN
        NEW.accumulated_depreciation := 0;
    END IF;

    IF NEW.residual_value_amount IS NOT NULL THEN
        rv := NEW.residual_value_amount;
    ELSE
        rv := COALESCE(NEW.residual_value_pct,
            (SELECT residual_value_pct FROM finance.asset_categories WHERE id = NEW.category_id), 0)
            * NEW.base_cost / 100;
    END IF;
    NEW.net_book_value := GREATEST(NEW.base_cost - NEW.accumulated_depreciation, rv);

    IF NEW.base_cost > 0 AND NEW.net_book_value <= rv AND NEW.status = 'active' THEN
        NEW.status := 'fully_depreciated';
    END IF;

    RETURN NEW;
END;
 $$ LANGUAGE plpgsql;

CREATE TRIGGER trg_fixed_assets_nbv
    BEFORE INSERT OR UPDATE ON finance.fixed_assets
    FOR EACH ROW EXECUTE FUNCTION finance.fn_update_asset_nbv();

-- =============================================================================
-- fn_add_accumulated_depreciation
-- =============================================================================
CREATE OR REPLACE FUNCTION finance.fn_add_accumulated_depreciation(
    p_asset_id UUID,
    p_amount NUMERIC(18,2)
)
RETURNS VOID AS $$ BEGIN
    UPDATE finance.fixed_assets
    SET accumulated_depreciation = accumulated_depreciation + p_amount
    WHERE id = p_asset_id;
END;
 $$ LANGUAGE plpgsql;

-- =============================================================================
-- fn_calculate_sl_depreciation
-- =============================================================================
CREATE OR REPLACE FUNCTION finance.fn_calculate_sl_depreciation(
    p_asset_id UUID,
    p_period_id UUID
)
RETURNS NUMERIC(18,2) AS $$ DECLARE
    v_asset        RECORD;
    v_period       RECORD;
    v_depreciation NUMERIC(18,2) := 0;
    v_residual     NUMERIC(18,2);
    v_life         INTEGER;
    v_existing_dep NUMERIC(18,2) := 0;
    v_days         INTEGER;
BEGIN
    SELECT * INTO v_asset FROM finance.fixed_assets WHERE id = p_asset_id;
    SELECT * INTO v_period FROM finance.accounting_periods WHERE id = p_period_id;

    IF NOT FOUND OR v_asset.status NOT IN ('active','fully_depreciated') THEN
        RETURN 0;
    END IF;

    v_life := COALESCE(v_asset.useful_life_months,
        (SELECT useful_life_months FROM finance.asset_categories WHERE id = v_asset.category_id));

    v_residual := COALESCE(v_asset.residual_value_amount,
        COALESCE(v_asset.residual_value_pct, 0) * v_asset.base_cost / 100);

    SELECT COALESCE(SUM(depreciation_amount), 0) INTO v_existing_dep
    FROM finance.depreciation_schedule
    WHERE asset_id = p_asset_id AND status IN ('calculated','posted');

    IF v_existing_dep >= (v_asset.base_cost - v_residual) THEN
        RETURN 0;
    END IF;

    v_depreciation := (v_asset.base_cost - v_residual) / v_life;

    v_days := EXTRACT(DAY FROM v_period.end_date::timestamp - v_period.start_date::timestamp)::INTEGER + 1;
    v_depreciation := v_depreciation * (v_days::NUMERIC / 30);

    IF (v_existing_dep + v_depreciation) > (v_asset.base_cost - v_residual) THEN
        v_depreciation := (v_asset.base_cost - v_residual) - v_existing_dep;
    END IF;

    RETURN ROUND(v_depreciation, 2);
END;
 $$ LANGUAGE plpgsql;

-- =============================================================================
-- fn_generate_depreciation_for_period
-- =============================================================================
CREATE OR REPLACE FUNCTION finance.fn_generate_depreciation_for_period(
    p_period_id UUID,
    p_created_by UUID
)
RETURNS TABLE (
    asset_id UUID,
    asset_code VARCHAR,
    asset_name VARCHAR,
    depreciation_amount NUMERIC(18,2),
    status TEXT
) AS $$ DECLARE
    v_period RECORD;
    v_fy_id  UUID;
BEGIN
    SELECT * INTO v_period FROM finance.accounting_periods WHERE id = p_period_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Period not found';
    END IF;

    SELECT fiscal_year_id INTO v_fy_id FROM finance.accounting_periods WHERE id = p_period_id;

    RETURN QUERY
    WITH active_assets AS (
        SELECT fa.*,
            ac.useful_life_months AS cat_life,
            ac.residual_value_pct AS cat_residual_pct,
            ac.depreciation_method AS cat_method
        FROM finance.fixed_assets fa
        JOIN finance.asset_categories ac ON ac.id = fa.category_id
        WHERE fa.status IN ('active','fully_depreciated')
        AND fa.purchase_date <= v_period.end_date
        AND NOT EXISTS (
            SELECT 1 FROM finance.depreciation_schedule ds
            WHERE ds.asset_id = fa.id AND ds.period_id = p_period_id
        )
    ),
    calc AS (
        SELECT
            aa.id AS asset_id,
            aa.code AS asset_code,
            aa.name AS asset_name,
            COALESCE(aa.accumulated_depreciation, 0) AS opening_dep,
            finance.fn_calculate_sl_depreciation(aa.id, p_period_id) AS dep_amount,
            GREATEST(aa.base_cost - COALESCE(aa.accumulated_depreciation, 0)
                - finance.fn_calculate_sl_depreciation(aa.id, p_period_id),
                COALESCE(aa.residual_value_amount,
                    COALESCE(aa.residual_value_pct, aa.cat_residual_pct, 0) * aa.base_cost / 100)) AS closing_nbv
        FROM active_assets aa
    )
    INSERT INTO finance.depreciation_schedule (
        asset_id, period_id, fiscal_year_id,
        opening_nbv, depreciation_amount, closing_nbv,
        method, rate, days_in_period,
        status, created_by
    )
    SELECT
        c.asset_id, p_period_id, v_fy_id,
        (SELECT base_cost FROM finance.fixed_assets WHERE id = c.asset_id) - c.opening_dep,
        c.dep_amount, c.closing_nbv,
        'straight_line',
        CASE WHEN c.dep_amount > 0
            THEN ROUND(c.dep_amount / NULLIF(GREATEST(
                (SELECT base_cost FROM finance.fixed_assets WHERE id = c.asset_id) - c.opening_dep, 0.01), 0.01) * 100, 4)
            ELSE 0 END,
        EXTRACT(DAY FROM v_period.end_date::timestamp - v_period.start_date::timestamp)::INTEGER + 1,
        'calculated', p_created_by
    FROM calc c
    WHERE c.dep_amount > 0
    RETURNING
        depreciation_schedule.asset_id,
        (SELECT code FROM finance.fixed_assets WHERE id = depreciation_schedule.asset_id),
        (SELECT name FROM finance.fixed_assets WHERE id = depreciation_schedule.asset_id),
        depreciation_schedule.depreciation_amount,
        depreciation_schedule.status;
END;
 $$ LANGUAGE plpgsql;

-- =============================================================================
-- Reporting Views
-- =============================================================================
CREATE OR REPLACE VIEW reporting.v_asset_register AS
SELECT
    fa.id,
    fa.code,
    fa.name,
    ac.name AS category_name,
    fa.purchase_date,
    fa.purchase_cost,
    fa.currency AS currency_code,
    fa.base_cost,
    fa.accumulated_depreciation,
    fa.net_book_value,
    fa.serial_number,
    fa.location,
    fa.status,
    COALESCE(fa.useful_life_months, ac.useful_life_months) AS useful_life_months,
    COALESCE(fa.residual_value_pct, ac.residual_value_pct) AS residual_value_pct,
    p.name AS project_name,
    fa.disposal_date,
    fa.disposal_value,
    fa.gain_loss_amount
FROM finance.fixed_assets fa
JOIN finance.asset_categories ac ON ac.id = fa.category_id
LEFT JOIN public.projects p ON p.id = fa.project_id
WHERE fa.status != 'pending_capitalization';

GRANT SELECT ON reporting.v_asset_register TO authenticated;

CREATE OR REPLACE VIEW reporting.v_depreciation_summary AS
SELECT
    ds.fiscal_year_id,
    fy.name AS fiscal_year_name,
    ds.period_id,
    ap.name AS period_name,
    ap.start_date,
    ap.end_date,
    COUNT(DISTINCT ds.asset_id) AS assets_depreciated,
    SUM(ds.depreciation_amount) AS total_depreciation,
    SUM(ds.opening_nbv) AS total_opening_nbv,
    SUM(ds.closing_nbv) AS total_closing_nbv,
    COUNT(*) FILTER (WHERE ds.status = 'posted') AS posted_count,
    COUNT(*) FILTER (WHERE ds.status = 'calculated') AS pending_count
FROM finance.depreciation_schedule ds
JOIN finance.fiscal_years fy ON fy.id = ds.fiscal_year_id
JOIN finance.accounting_periods ap ON ap.id = ds.period_id
GROUP BY ds.fiscal_year_id, fy.name, ds.period_id, ap.name, ap.start_date, ap.end_date
ORDER BY fy.name, ap.start_date;

GRANT SELECT ON reporting.v_depreciation_summary TO authenticated;

COMMIT;

-- =============================================================================
-- Add fn_subtract_accumulated_depreciation function
-- Used by the Reverse Depreciation button on the depreciation page
-- Run this in Supabase SQL Editor.
-- =============================================================================

CREATE OR REPLACE FUNCTION finance.fn_subtract_accumulated_depreciation(
    p_asset_id UUID,
    p_amount NUMERIC(18,2)
)
RETURNS VOID AS $$ BEGIN
    UPDATE finance.fixed_assets
    SET accumulated_depreciation = GREATEST(accumulated_depreciation - p_amount, 0)
    WHERE id = p_asset_id;
END;
$$ LANGUAGE plpgsql;

