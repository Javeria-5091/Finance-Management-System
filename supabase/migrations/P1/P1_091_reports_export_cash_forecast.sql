-- P1-091: Reports export authorization + cash-flow forecast persistence
-- Source: OSYSTIC Finance Management System Specification v1.3, §§11.2, 13.2, 13.3.

CREATE TABLE IF NOT EXISTS reporting.cash_flow_forecasts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES core.organizations(id) ON DELETE CASCADE,
  forecast_date date NOT NULL,
  horizon_days integer NOT NULL CHECK (horizon_days IN (30, 60, 90)),
  scenario text NOT NULL CHECK (scenario IN ('BASE', 'CONSERVATIVE', 'OPTIMISTIC')),
  opening_cash numeric(20,4) NOT NULL DEFAULT 0,
  expected_inflows numeric(20,4) NOT NULL DEFAULT 0,
  expected_outflows numeric(20,4) NOT NULL DEFAULT 0,
  ending_cash numeric(20,4) NOT NULL DEFAULT 0,
  assumptions jsonb NOT NULL DEFAULT '{}'::jsonb,
  confidence numeric(5,4) CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  calculated_at timestamptz NOT NULL DEFAULT now(),
  calculated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, forecast_date, horizon_days, scenario)
);

CREATE INDEX IF NOT EXISTS cash_flow_forecasts_org_date_idx
  ON reporting.cash_flow_forecasts (organization_id, forecast_date DESC, horizon_days, scenario);

ALTER TABLE reporting.cash_flow_forecasts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS cash_flow_forecasts_select_org ON reporting.cash_flow_forecasts;
CREATE POLICY cash_flow_forecasts_select_org
  ON reporting.cash_flow_forecasts
  FOR SELECT TO authenticated
  USING (organization_id = core.current_user_org_id());

DROP POLICY IF EXISTS cash_flow_forecasts_insert_org ON reporting.cash_flow_forecasts;
CREATE POLICY cash_flow_forecasts_insert_org
  ON reporting.cash_flow_forecasts
  FOR INSERT TO authenticated
  WITH CHECK (organization_id = core.current_user_org_id());

DROP POLICY IF EXISTS cash_flow_forecasts_update_org ON reporting.cash_flow_forecasts;
CREATE POLICY cash_flow_forecasts_update_org
  ON reporting.cash_flow_forecasts
  FOR UPDATE TO authenticated
  USING (organization_id = core.current_user_org_id())
  WITH CHECK (organization_id = core.current_user_org_id());

GRANT SELECT, INSERT, UPDATE ON reporting.cash_flow_forecasts TO authenticated;
GRANT ALL ON reporting.cash_flow_forecasts TO service_role;

COMMENT ON TABLE reporting.cash_flow_forecasts IS
  'Permission-scoped deterministic forecast scenarios. Forecasts are separate from actual reporting data per Spec §13.2/§13.3 and include assumptions/confidence metadata.';
