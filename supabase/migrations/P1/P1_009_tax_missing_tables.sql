-- ═══════════════════════════════════════════════════════════════════════════
-- P1_009_tax_missing_tables.sql
-- Creates the 3 missing tax tables required by Spec Section 10.2:
--   1. finance.tax_computations        — stores computed tax liability per period
--   2. finance.tax_credits_and_withholding  — WHT credits, tax credits, adjustments
--   3. finance.tax_payments_and_refunds     — actual tax payments to FBR & refunds
--
-- Also attaches audit triggers to all three.
--
-- Run AFTER P1_002 (payroll) and 023_tax_configuration (tax base tables).
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. finance.tax_computations
-- Stores the computed tax liability for each period/type.
-- Populated by the tax computation engine, reviewed before filing.
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS finance.tax_computations (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES core.organization_config(id),
  tax_rule_set_id UUID REFERENCES finance.tax_rule_sets(id),
  fiscal_year_id  UUID REFERENCES finance.fiscal_years(id),
  period_id       UUID REFERENCES finance.accounting_periods(id),

  -- What type of tax (corporate, sales, withholding)
  tax_type        TEXT NOT NULL DEFAULT 'corporate'
                  CHECK (tax_type IN ('corporate', 'sales', 'withholding', 'presumptive')),

  -- Computation window
  period_start    DATE NOT NULL,
  period_end      DATE NOT NULL,

  -- Amounts
  gross_income    NUMERIC(18,2) DEFAULT 0,
  total_deductions NUMERIC(18,2) DEFAULT 0,
  taxable_income  NUMERIC(18,2) DEFAULT 0,
  tax_rate        NUMERIC(8,4) DEFAULT 0,
  computed_tax    NUMERIC(18,2) NOT NULL DEFAULT 0,
  surcharge       NUMERIC(18,2) DEFAULT 0,
  extra_tax       NUMERIC(18,2) DEFAULT 0,
  total_tax       NUMERIC(18,2) GENERATED ALWAYS AS (computed_tax + COALESCE(surcharge,0) + COALESCE(extra_tax,0)) STORED,

  -- Status workflow
  status          TEXT NOT NULL DEFAULT 'DRAFT'
                  CHECK (status IN ('DRAFT', 'REVIEWED', 'APPROVED', 'FILED', 'ADJUSTED')),
  reviewed_by     UUID,
  reviewed_at     TIMESTAMPTZ,
  approved_by     UUID,
  approved_at     TIMESTAMPTZ,

  -- Reference to the actual tax return filing
  tax_return_id   UUID REFERENCES finance.tax_returns(id),

  -- Notes
  notes           TEXT,
  computation_json JSONB,   -- full breakdown for audit

  created_by      UUID,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_tax_comp_org ON finance.tax_computations(organization_id);
CREATE INDEX idx_tax_comp_period ON finance.tax_computations(period_id);
CREATE INDEX idx_tax_comp_fy ON finance.tax_computations(fiscal_year_id);
CREATE INDEX idx_tax_comp_status ON finance.tax_computations(status);

ALTER TABLE finance.tax_computations ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tax_comp_select" ON finance.tax_computations
  FOR SELECT TO authenticated
  USING (organization_id = (SELECT id FROM core.organization_config LIMIT 1));
CREATE POLICY "tax_comp_insert" ON finance.tax_computations
  FOR INSERT TO authenticated
  WITH CHECK (organization_id = (SELECT id FROM core.organization_config LIMIT 1));
CREATE POLICY "tax_comp_update" ON finance.tax_computations
  FOR UPDATE TO authenticated
  USING (organization_id = (SELECT id FROM core.organization_config LIMIT 1));
CREATE POLICY "tax_comp_delete" ON finance.tax_computations
  FOR DELETE TO authenticated
  USING (organization_id = (SELECT id FROM core.organization_config LIMIT 1));
CREATE POLICY "tax_comp_service" ON finance.tax_computations FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. finance.tax_credits_and_withholding
-- WHT deductions received, tax credits, and withholding adjustments.
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS finance.tax_credits_and_withholding (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES core.organization_config(id),
  tax_computation_id UUID REFERENCES finance.tax_computations(id),
  fiscal_year_id  UUID REFERENCES finance.fiscal_years(id),
  period_id       UUID REFERENCES finance.accounting_periods(id),

  -- Credit type
  credit_type     TEXT NOT NULL
                  CHECK (credit_type IN (
                    'WHT_DEDUCTED',         -- WHT deducted from our income payments
                    'WHT_COLLECTED',        -- WHT we collected from vendors/contractors
                    'TAX_CREDIT',           -- Other admissible tax credits
                    'CARRY_FORWARD',        -- Loss carry-forward credit
                    'ADJUSTMENT',           -- Manual adjustment
                    'PREVIOUS_YEAR_CREDIT'  -- Credit brought forward from prior year
                  )),

  -- Counterparty (for WHT)
  counterparty_name  TEXT,
  counterparty_cnic  TEXT,
  counterparty_ntn   TEXT,

  -- Reference to the source document
  source_type        TEXT,   -- invoice, vendor_bill, payroll_run, etc.
  source_id          UUID,

  -- Amounts
  gross_amount       NUMERIC(18,2) NOT NULL DEFAULT 0,
  wht_rate           NUMERIC(8,4) DEFAULT 0,
  credit_amount      NUMERIC(18,2) NOT NULL DEFAULT 0,
  currency           TEXT DEFAULT 'PKR',

  -- Status
  status             TEXT NOT NULL DEFAULT 'PENDING'
                     CHECK (status IN ('PENDING', 'CLAIMED', 'REJECTED', 'ADJUSTED')),

  -- Filing linkage
  tax_return_id      UUID REFERENCES finance.tax_returns(id),

  notes              TEXT,
  created_by         UUID,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_tax_cw_org ON finance.tax_credits_and_withholding(organization_id);
CREATE INDEX idx_tax_cw_comp ON finance.tax_credits_and_withholding(tax_computation_id);
CREATE INDEX idx_tax_cw_type ON finance.tax_credits_and_withholding(credit_type);
CREATE INDEX idx_tax_cw_period ON finance.tax_credits_and_withholding(period_id);
CREATE INDEX idx_tax_cw_status ON finance.tax_credits_and_withholding(status);

ALTER TABLE finance.tax_credits_and_withholding ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tax_cw_select" ON finance.tax_credits_and_withholding
  FOR SELECT TO authenticated
  USING (organization_id = (SELECT id FROM core.organization_config LIMIT 1));
CREATE POLICY "tax_cw_insert" ON finance.tax_credits_and_withholding
  FOR INSERT TO authenticated
  WITH CHECK (organization_id = (SELECT id FROM core.organization_config LIMIT 1));
CREATE POLICY "tax_cw_update" ON finance.tax_credits_and_withholding
  FOR UPDATE TO authenticated
  USING (organization_id = (SELECT id FROM core.organization_config LIMIT 1));
CREATE POLICY "tax_cw_delete" ON finance.tax_credits_and_withholding
  FOR DELETE TO authenticated
  USING (organization_id = (SELECT id FROM core.organization_config LIMIT 1));
CREATE POLICY "tax_cw_service" ON finance.tax_credits_and_withholding FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. finance.tax_payments_and_refunds
-- Actual tax payments made to FBR and refunds received.
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS finance.tax_payments_and_refunds (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES core.organization_config(id),
  tax_computation_id UUID REFERENCES finance.tax_computations(id),
  tax_return_id   UUID REFERENCES finance.tax_returns(id),
  fiscal_year_id  UUID REFERENCES finance.fiscal_years(id),
  period_id       UUID REFERENCES finance.accounting_periods(id),

  -- Payment or refund
  payment_type    TEXT NOT NULL
                  CHECK (payment_type IN ('PAYMENT', 'REFUND', 'ADVANCE_PAYMENT', 'ADJUSTMENT')),

  -- Tax authority details
  tax_authority   TEXT DEFAULT 'FBR',
  cpr_number      TEXT,            -- Computerized Payment Receipt number
  prs_number      TEXT,            -- Payment Receipt Sheet number

  -- Amounts
  amount          NUMERIC(18,2) NOT NULL DEFAULT 0,
  currency        TEXT DEFAULT 'PKR',
  penalty_amount  NUMERIC(18,2) DEFAULT 0,
  surcharge_amount NUMERIC(18,2) DEFAULT 0,
  total_paid      NUMERIC(18,2) GENERATED ALWAYS AS (amount + COALESCE(penalty_amount,0) + COALESCE(surcharge_amount,0)) STORED,

  -- Payment reference
  payment_reference TEXT,          -- Bank reference / cheque number
  payment_method    TEXT DEFAULT 'bank_transfer'
                    CHECK (payment_method IN ('bank_transfer', 'cheque', 'online', 'adjustment')),
  payment_date      DATE NOT NULL DEFAULT CURRENT_DATE,

  -- Financial account used
  financial_account_id UUID REFERENCES finance.financial_accounts(id),
  journal_entry_id    UUID REFERENCES finance.journal_entries(id),

  -- Status
  status            TEXT NOT NULL DEFAULT 'PENDING'
                    CHECK (status IN ('PENDING', 'COMPLETED', 'FAILED', 'REVERSED')),

  notes             TEXT,
  created_by        UUID,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_tax_pay_org ON finance.tax_payments_and_refunds(organization_id);
CREATE INDEX idx_tax_pay_comp ON finance.tax_payments_and_refunds(tax_computation_id);
CREATE INDEX idx_tax_pay_return ON finance.tax_payments_and_refunds(tax_return_id);
CREATE INDEX idx_tax_pay_period ON finance.tax_payments_and_refunds(period_id);
CREATE INDEX idx_tax_pay_status ON finance.tax_payments_and_refunds(status);
CREATE INDEX idx_tax_pay_date ON finance.tax_payments_and_refunds(payment_date);

ALTER TABLE finance.tax_payments_and_refunds ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tax_pay_select" ON finance.tax_payments_and_refunds
  FOR SELECT TO authenticated
  USING (organization_id = (SELECT id FROM core.organization_config LIMIT 1));
CREATE POLICY "tax_pay_insert" ON finance.tax_payments_and_refunds
  FOR INSERT TO authenticated
  WITH CHECK (organization_id = (SELECT id FROM core.organization_config LIMIT 1));
CREATE POLICY "tax_pay_update" ON finance.tax_payments_and_refunds
  FOR UPDATE TO authenticated
  USING (organization_id = (SELECT id FROM core.organization_config LIMIT 1));
CREATE POLICY "tax_pay_delete" ON finance.tax_payments_and_refunds
  FOR DELETE TO authenticated
  USING (organization_id = (SELECT id FROM core.organization_config LIMIT 1));
CREATE POLICY "tax_pay_service" ON finance.tax_payments_and_refunds FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ═══════════════════════════════════════════════════════════════════════════
-- Attach audit triggers to all 3 new tables
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TRIGGER tax_computations_audit
  AFTER INSERT OR UPDATE OR DELETE ON finance.tax_computations
  FOR EACH ROW EXECUTE FUNCTION audit.trigger_audit_log();

CREATE TRIGGER tax_credits_and_wh_audit
  AFTER INSERT OR UPDATE OR DELETE ON finance.tax_credits_and_withholding
  FOR EACH ROW EXECUTE FUNCTION audit.trigger_audit_log();

CREATE TRIGGER tax_payments_ref_audit
  AFTER INSERT OR UPDATE OR DELETE ON finance.tax_payments_and_refunds
  FOR EACH ROW EXECUTE FUNCTION audit.trigger_audit_log();

-- ═══════════════════════════════════════════════════════════════════════════
-- Also add trigger to tax_returns (was missing even though table existed)
-- ═══════════════════════════════════════════════════════════════════════════
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'finance' AND c.relname = 'tax_returns' AND t.tgname = 'tax_returns_audit'
  ) THEN
    CREATE TRIGGER tax_returns_audit
      AFTER INSERT OR UPDATE OR DELETE ON finance.tax_returns
      FOR EACH ROW EXECUTE FUNCTION audit.trigger_audit_log();
    RAISE NOTICE 'Attached audit trigger to finance.tax_returns';
  END IF;
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- Permissions (aligned with existing TAX_* permissions from 012c)
-- ═══════════════════════════════════════════════════════════════════════════
-- Permissions are already handled by the org-scoped RLS above.
-- If you want column-level grants for specific roles, add them here.

COMMIT;