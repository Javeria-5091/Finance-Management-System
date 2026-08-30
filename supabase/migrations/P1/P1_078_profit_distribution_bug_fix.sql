-- ═════════════════════════════════════════════════════════════════════
--  BUG-016 FIX (DB layer): Profit distribution posting is impossible
--  end-to-end (4 independent defects) — this migration fixes the two
--  that require schema changes:
--
--  (a) core.distribution_tax_config does not exist anywhere in the
--      schema, so getWithholdingTaxConfig() in
--      src/services/distribution-wht.service.ts always falls back to
--      DEFAULT_WHT_CONFIG, whose account IDs are deliberately empty
--      strings ("must be configured per organization") — so
--      postDistributionWithWHT() always returns 400 "no withholding tax
--      account configured".
--
--  (c, partial) finance.distribution_lines has no withholding_amount /
--      withholding_rate / net_amount / withholding_exempt columns, so
--      the per-owner WHT breakdown computed by calculateWithholdingTax()
--      could never be persisted even after the route/column-name bugs
--      in profit-distribution/route.ts are fixed.
--
--  Also fixes a related, previously-unreported gap found while wiring
--  this up: finance.chart_of_accounts has no seeded "Withholding Tax
--  Payable" liability account at all (only "1410 Withholding Tax
--  Receivable", an ASSET for tax withheld from *us*, not the liability
--  for tax *we* withhold from owners) — so even a correctly-configured
--  core.distribution_tax_config row would have nowhere valid to point.
-- ═════════════════════════════════════════════════════════════════════

-- ---------------------------------------------------------------------
-- 1. core.distribution_tax_config — per-organization dividend/profit
--    distribution withholding tax configuration. Same shape/pattern as
--    core.budget_policies (P1_010).
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS core.distribution_tax_config (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES core.organizations(id) ON DELETE CASCADE,
  enabled BOOLEAN NOT NULL DEFAULT true,
  rate NUMERIC(5,2) NOT NULL DEFAULT 15
    CONSTRAINT chk_dtc_rate CHECK (rate >= 0 AND rate <= 100),
  minimum_threshold NUMERIC(18,2) NOT NULL DEFAULT 0
    CONSTRAINT chk_dtc_min CHECK (minimum_threshold >= 0),
  maximum_cap NUMERIC(18,2) NOT NULL DEFAULT 0
    CONSTRAINT chk_dtc_cap CHECK (maximum_cap >= 0),
  withholding_tax_account_id UUID REFERENCES finance.chart_of_accounts(id),
  withholding_payable_account_id UUID REFERENCES finance.chart_of_accounts(id),
  effective_from DATE NOT NULL DEFAULT CURRENT_DATE,
  tax_reference TEXT,
  created_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_distribution_tax_config_org_enabled
  ON core.distribution_tax_config (organization_id, enabled, effective_from DESC);

ALTER TABLE core.distribution_tax_config ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS distribution_tax_config_select ON core.distribution_tax_config;
CREATE POLICY distribution_tax_config_select ON core.distribution_tax_config
  FOR SELECT USING (core.same_org(organization_id) AND (core.is_ceo_or_admin() OR core.is_finance_head() OR core.has_role('ACCOUNTANT')));

DROP POLICY IF EXISTS distribution_tax_config_write ON core.distribution_tax_config;
CREATE POLICY distribution_tax_config_write ON core.distribution_tax_config
  FOR ALL
  USING (core.same_org(organization_id) AND (core.is_ceo_or_admin() OR core.is_finance_head()))
  WITH CHECK (core.same_org(organization_id) AND (core.is_ceo_or_admin() OR core.is_finance_head()));

COMMENT ON TABLE core.distribution_tax_config IS 'Per-organization dividend/profit-distribution withholding tax configuration. Referenced by src/services/distribution-wht.service.ts. Added by BUG-016 fix — table never existed, so WHT config always silently fell back to an unusable hardcoded default.';

-- ---------------------------------------------------------------------
-- 2. finance.distribution_lines — add the WHT breakdown columns that
--    profit-distribution/route.ts's post-time update already tries (and
--    previously failed) to write.
-- ---------------------------------------------------------------------
ALTER TABLE finance.distribution_lines
  ADD COLUMN IF NOT EXISTS withholding_rate NUMERIC(5,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS withholding_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS net_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS withholding_exempt BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS withholding_exempt_reason TEXT;

COMMENT ON COLUMN finance.distribution_lines.withholding_amount IS 'BUG-016 fix: column did not exist; profit-distribution/route.ts silently failed to persist the per-owner WHT split computed by calculateWithholdingTax().';

-- ---------------------------------------------------------------------
-- 3. Seed a "Withholding Tax Payable" LIABILITY account (code 2230,
--    under the 2200 Tax Payables parent) for every organization that
--    already has a chart of accounts, and wire up a default
--    core.distribution_tax_config row pointing at it — so a fresh org
--    can post a distribution immediately instead of hitting the same
--    "no withholding tax account configured" error the moment the table
--    above exists but is empty.
-- ---------------------------------------------------------------------
DO $$
DECLARE
  v_org RECORD;
  v_parent_id UUID;
  v_wht_account_id UUID;
BEGIN
  FOR v_org IN
    SELECT DISTINCT organization_id FROM finance.chart_of_accounts WHERE organization_id IS NOT NULL
  LOOP
    -- Skip if this org already has a 2230 account (idempotent re-run).
    SELECT id INTO v_wht_account_id
    FROM finance.chart_of_accounts
    WHERE organization_id = v_org.organization_id AND code = '2230';

    IF v_wht_account_id IS NULL THEN
      SELECT id INTO v_parent_id
      FROM finance.chart_of_accounts
      WHERE organization_id = v_org.organization_id AND code = '2200';

      INSERT INTO finance.chart_of_accounts (
        code, name, account_type, normal_balance, level, parent_id,
        is_control_account, report_mapping, display_order, organization_id, is_active, posting_allowed
      ) VALUES (
        '2230', 'Withholding Tax Payable', 'LIABILITY', 'CREDIT', 2, v_parent_id,
        true, 'BALANCE_SHEET_CURRENT_LIABILITIES', 3, v_org.organization_id, true, true
      )
      RETURNING id INTO v_wht_account_id;
    END IF;

    -- Default config row, only if this org has none yet.
    IF NOT EXISTS (
      SELECT 1 FROM core.distribution_tax_config WHERE organization_id = v_org.organization_id
    ) THEN
      INSERT INTO core.distribution_tax_config (
        organization_id, enabled, rate, minimum_threshold, maximum_cap,
        withholding_tax_account_id, withholding_payable_account_id,
        effective_from, tax_reference
      ) VALUES (
        v_org.organization_id, true, 15, 0, 0,
        v_wht_account_id, v_wht_account_id,
        '2026-07-01', 'Pakistani Dividend Withholding Tax under Section 149 of Income Tax Ordinance 2001'
      );
    END IF;
  END LOOP;
END $$;