-- ═════════════════════════════════════════════════════════════════════
--  PLATFORM FEE DIRECTORY & FEE RULES
--  Phase 4 P0 — Payment channel fees, platform commissions
-- ═════════════════════════════════════════════════════════════════════

-- Platform / Payment Channel Directory
CREATE TABLE IF NOT EXISTS finance.platforms (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(200) NOT NULL,
  code VARCHAR(50) UNIQUE NOT NULL,
  platform_type VARCHAR(50) NOT NULL DEFAULT 'PAYMENT_GATEWAY'
    CHECK (platform_type IN ('PAYMENT_GATEWAY', 'BANK_TRANSFER', 'MARKETPLACE', 'WALLET', 'OTHER')),
  description TEXT,
  is_active BOOLEAN DEFAULT true,
  integration_config JSONB DEFAULT '{}',
  created_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Fee Rules Table
CREATE TABLE IF NOT EXISTS finance.fee_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  platform_id UUID NOT NULL REFERENCES finance.platforms(id),
  name VARCHAR(200) NOT NULL,
  fee_type VARCHAR(30) NOT NULL DEFAULT 'PERCENTAGE'
    CHECK (fee_type IN ('PERCENTAGE', 'FIXED', 'TIERED', 'SLAB')),
  fee_value NUMERIC(18,4) NOT NULL DEFAULT 0,        -- percentage or fixed amount
  min_fee NUMERIC(18,4) DEFAULT 0,                   -- minimum fee floor
  max_fee NUMERIC(18,4) DEFAULT 0,                   -- maximum fee cap (0 = no cap)
  applies_to VARCHAR(50) NOT NULL DEFAULT 'EXPENSE'
    CHECK (applies_to IN ('EXPENSE', 'INVOICE', 'VENDOR_BILL', 'PAYMENT_RECEIPT', 'ALL')),
  is_active BOOLEAN DEFAULT true,
  effective_from DATE DEFAULT CURRENT_DATE,
  effective_to DATE,
  priority INTEGER DEFAULT 0,                         -- higher = checked first
  created_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  CONSTRAINT fee_rules_platform_name_unique UNIQUE (platform_id, name)
);

-- Fee Tier Breakpoints (for TIERED fee_type)
CREATE TABLE IF NOT EXISTS finance.fee_tiers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  fee_rule_id UUID NOT NULL REFERENCES finance.fee_rules(id) ON DELETE CASCADE,
  tier_from NUMERIC(18,4) NOT NULL DEFAULT 0,
  tier_to NUMERIC(18,4) NOT NULL DEFAULT 0,          -- 0 = unlimited
  fee_percent NUMERIC(8,4) NOT NULL DEFAULT 0,
  fee_fixed NUMERIC(18,4) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Fee Computation Log
CREATE TABLE IF NOT EXISTS finance.fee_computation_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_type VARCHAR(50),
  source_id UUID,
  platform_id UUID REFERENCES finance.platforms(id),
  fee_rule_id UUID REFERENCES finance.fee_rules(id),
  base_amount NUMERIC(18,4) NOT NULL DEFAULT 0,
  fee_amount NUMERIC(18,4) NOT NULL DEFAULT 0,
  computed_by UUID REFERENCES auth.users(id),
  computed_at TIMESTAMPTZ DEFAULT now(),
  details JSONB DEFAULT '{}'
);

-- ═════════════════════════════════════════════════════════
--  FEE COMPUTATION FUNCTION
-- ═════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION finance.compute_platform_fee(
  p_platform_id UUID,
  p_amount NUMERIC(18,4),
  p_source_type VARCHAR(50) DEFAULT 'EXPENSE'
) RETURNS NUMERIC AS $$
DECLARE
  v_fee NUMERIC(18,4) := 0;
  v_rule RECORD;
  v_tiers RECORD;
  v_remaining NUMERIC(18,4);
  v_tier_min NUMERIC(18,4);
  v_tier_max NUMERIC(18,4);
BEGIN
  -- Get the highest-priority active rule for this platform
  SELECT * INTO v_rule
  FROM finance.fee_rules
  WHERE platform_id = p_platform_id
    AND is_active = true
    AND (applies_to = 'ALL' OR applies_to = p_source_type)
    AND (effective_from IS NULL OR effective_from <= CURRENT_DATE)
    AND (effective_to IS NULL OR effective_to >= CURRENT_DATE)
  ORDER BY priority DESC
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN 0;
  END IF;

  -- PERCENTAGE: fee = amount * fee_value / 100
  IF v_rule.fee_type = 'PERCENTAGE' THEN
    v_fee := p_amount * v_rule.fee_value / 100;
    IF v_rule.min_fee > 0 AND v_fee < v_rule.min_fee THEN v_fee := v_rule.min_fee; END IF;
    IF v_rule.max_fee > 0 AND v_fee > v_rule.max_fee THEN v_fee := v_rule.max_fee; END IF;

  -- FIXED: flat fee
  ELSIF v_rule.fee_type = 'FIXED' THEN
    v_fee := v_rule.fee_value;

  -- TIERED: graduated calculation
  ELSIF v_rule.fee_type = 'TIERED' THEN
    v_remaining := p_amount;
    FOR v_tiers IN (
      SELECT * FROM finance.fee_tiers 
      WHERE fee_rule_id = v_rule.id 
      ORDER BY tier_from ASC
    ) LOOP
      v_tier_min := v_tiers.tier_from;
      v_tier_max := CASE WHEN v_tiers.tier_to = 0 THEN p_amount ELSE LEAST(v_tiers.tier_to, p_amount) END;
      
      IF v_remaining <= 0 THEN EXIT; END IF;
      
      DECLARE
        v_tierable NUMERIC(18,4);
      BEGIN
        v_tierable := LEAST(GREATEST(v_remaining, 0), v_tier_max - v_tier_min);
        IF v_tierable > 0 THEN
          v_fee := v_fee + (v_tierable * v_tiers.fee_percent / 100) + v_tiers.fee_fixed;
          v_remaining := v_remaining - v_tierable;
        END IF;
      END;
    END LOOP;

  -- SLAB: find the matching slab
  ELSIF v_rule.fee_type = 'SLAB' THEN
    SELECT (p_amount * fee_percent / 100) + fee_fixed INTO v_fee
    FROM finance.fee_tiers
    WHERE fee_rule_id = v_rule.id
      AND p_amount >= tier_from
      AND (tier_to = 0 OR p_amount < tier_to)
    ORDER BY tier_from DESC
    LIMIT 1;
  END IF;

  -- Log the computation
  INSERT INTO finance.fee_computation_log (
    source_type, platform_id, fee_rule_id, base_amount, fee_amount
  ) VALUES (
    p_source_type, p_platform_id, v_rule.id, p_amount, COALESCE(v_fee, 0)
  );

  RETURN COALESCE(v_fee, 0);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ═════════════════════════════════════════════════════════
--  RLS POLICIES — Using core.has_permission() to avoid
--  direct dependency on core.user_roles internal structure
-- ═════════════════════════════════════════════════════════
ALTER TABLE finance.platforms ENABLE ROW LEVEL SECURITY;
ALTER TABLE finance.fee_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE finance.fee_tiers ENABLE ROW LEVEL SECURITY;
ALTER TABLE finance.fee_computation_log ENABLE ROW LEVEL SECURITY;

-- platforms: authenticated users read, CEO/ADMIN_CONFIG writes
CREATE POLICY "org_read_platforms" ON finance.platforms
  FOR SELECT USING (auth.uid() IS NOT NULL);
CREATE POLICY "admin_write_platforms" ON finance.platforms
  FOR ALL USING (core.has_permission(auth.uid(), 'ADMIN_CONFIG'));

-- fee_rules: authenticated users read, CEO/ADMIN_CONFIG writes
CREATE POLICY "org_read_fee_rules" ON finance.fee_rules
  FOR SELECT USING (auth.uid() IS NOT NULL);
CREATE POLICY "admin_write_fee_rules" ON finance.fee_rules
  FOR ALL USING (core.has_permission(auth.uid(), 'ADMIN_CONFIG'));

-- fee_tiers: authenticated users read, CEO/ADMIN_CONFIG writes
CREATE POLICY "authenticated_read_tiers" ON finance.fee_tiers
  FOR SELECT TO authenticated USING (true);
CREATE POLICY "admin_write_tiers" ON finance.fee_tiers
  FOR ALL USING (core.has_permission(auth.uid(), 'ADMIN_CONFIG'));

-- fee_computation_log: all authenticated users read
CREATE POLICY "org_read_fee_log" ON finance.fee_computation_log
  FOR SELECT USING (true);

-- ═════════════════════════════════════════════════════════
--  SEED: Common platforms
-- ═════════════════════════════════════════════════════════
INSERT INTO finance.platforms (name, code, platform_type, description) VALUES
  ('JazzCash Business', 'JAZZCASH', 'PAYMENT_GATEWAY', 'JazzCash Business payment collection'),
  ('EasyPaisa Business', 'EASYPAYSA', 'PAYMENT_GATEWAY', 'EasyPaisa Business payment collection'),
  ('Bank Transfer', 'BANK_TRANSFER', 'BANK_TRANSFER', 'Direct bank-to-bank transfer'),
  ('Cheque', 'CHEQUE', 'OTHER', 'Cheque payment method'),
  ('Cash', 'CASH', 'WALLET', 'Physical cash payment')
ON CONFLICT (code) DO NOTHING;

-- Seed default fee rules (1.5% for digital, 0% for bank/cash)
INSERT INTO finance.fee_rules (platform_id, name, fee_type, fee_value, applies_to, is_active) VALUES
  ((SELECT id FROM finance.platforms WHERE code = 'JAZZCASH'), 'JazzCash Collection Fee', 'PERCENTAGE', 1.5, 'ALL', true),
  ((SELECT id FROM finance.platforms WHERE code = 'EASYPAYSA'), 'EasyPaisa Collection Fee', 'PERCENTAGE', 1.5, 'ALL', true),
  ((SELECT id FROM finance.platforms WHERE code = 'BANK_TRANSFER'), 'Bank Transfer Fee', 'FIXED', 0, 'ALL', true),
  ((SELECT id FROM finance.platforms WHERE code = 'CHEQUE'), 'Cheque Processing Fee', 'FIXED', 0, 'ALL', true),
  ((SELECT id FROM finance.platforms WHERE code = 'CASH'), 'Cash Handling Fee', 'FIXED', 0, 'ALL', true)
ON CONFLICT (platform_id, name) DO NOTHING;