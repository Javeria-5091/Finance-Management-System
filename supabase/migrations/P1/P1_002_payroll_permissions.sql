-- =============================================================================
-- STEP 1: ALTER — linked account columns ko nullable bana do
-- (AssetForm already allows empty — code matches this)
-- =============================================================================

ALTER TABLE finance.asset_categories
    ALTER COLUMN linked_asset_account_id DROP NOT NULL,
    ALTER COLUMN linked_depreciation_account_id DROP NOT NULL,
    ALTER COLUMN linked_expense_account_id DROP NOT NULL;

-- Optional: fixed_assets ke override columns bhi nullable hon chahiye
ALTER TABLE finance.fixed_assets
    ALTER COLUMN exchange_rate_id DROP NOT NULL;

-- =============================================================================
-- STEP 2: SEED DATA — 10 default asset categories
-- =============================================================================

INSERT INTO finance.asset_categories (
    id, code, name, description,
    depreciation_method, useful_life_months, residual_value_pct,
    capitalization_threshold,
    linked_asset_account_id, linked_depreciation_account_id, linked_expense_account_id,
    active, created_by, created_at
) VALUES

-- IT Equipment (3 years)
(gen_random_uuid(), 'IT-EQ', 'IT Equipment', 'Computers, laptops, servers, networking gear',
    'straight_line', 36, 10, 50000,
    NULL, NULL, NULL,
    true, auth.uid(), now()),

-- Vehicles (5 years)
(gen_random_uuid(), 'VEH', 'Vehicles', 'Cars, motorcycles, delivery vans',
    'straight_line', 60, 15, 100000,
    NULL, NULL, NULL,
    true, auth.uid(), now()),

-- Furniture & Fixtures (10 years)
(gen_random_uuid(), 'FF', 'Furniture & Fixtures', 'Desks, chairs, cabinets, partitions',
    'straight_line', 120, 10, 25000,
    NULL, NULL, NULL,
    true, auth.uid(), now()),

-- Office Equipment (5 years)
(gen_random_uuid(), 'OFF-EQ', 'Office Equipment', 'Printers, scanners, AC units, generators',
    'straight_line', 60, 10, 25000,
    NULL, NULL, NULL,
    true, auth.uid(), now()),

-- Machinery (10 years)
(gen_random_uuid(), 'MCH', 'Machinery', 'Production machinery, industrial equipment',
    'declining_balance', 120, 5, 100000,
    NULL, NULL, NULL,
    true, auth.uid(), now()),

-- Buildings (25 years)
(gen_random_uuid(), 'BLD', 'Buildings', 'Office buildings, warehouses, factories',
    'straight_line', 300, 0, 500000,
    NULL, NULL, NULL,
    true, auth.uid(), now()),

-- Land (non-depreciable)
(gen_random_uuid(), 'LND', 'Land', 'Plots, land — no depreciation',
    'none', 0, 100, 0,
    NULL, NULL, NULL,
    true, auth.uid(), now()),

-- Electrical Equipment (5 years)
(gen_random_uuid(), 'ELC', 'Electrical Equipment', 'UPS, transformers, wiring installations',
    'straight_line', 60, 5, 25000,
    NULL, NULL, NULL,
    true, auth.uid(), now()),

-- Plumbing & HVAC (10 years)
(gen_random_uuid(), 'PHV', 'Plumbing & HVAC', 'Water systems, heating, ventilation',
    'straight_line', 120, 10, 50000,
    NULL, NULL, NULL,
    true, auth.uid(), now()),

-- Software Licenses (3 years)
(gen_random_uuid(), 'SW', 'Software Licenses', 'ERP, CRM, development tools licenses',
    'straight_line', 36, 0, 10000,
    NULL, NULL, NULL,
    true, auth.uid(), now());

-- =============================================================================
-- DONE!
-- Ab AssetForm mein category dropdown mein 10 options dikhenge.
-- Linked accounts baad mein category edit karke ya individual UPDATE se link kar sakti ho.
-- =============================================================================