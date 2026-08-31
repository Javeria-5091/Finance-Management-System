-- P1_089: Tax workflow hardening and fiscal-year close checklist
-- Fixes FND-ACCT-002..009 without changing existing financial schemas beyond
-- the explicit idempotency key required by Spec 11.2 for payment commands.

-- ---------------------------------------------------------------------------
-- Tax payment idempotency
-- ---------------------------------------------------------------------------
ALTER TABLE finance.tax_payments_and_refunds
  ADD COLUMN IF NOT EXISTS idempotency_key text;

CREATE UNIQUE INDEX IF NOT EXISTS tax_payments_idempotency_uq
  ON finance.tax_payments_and_refunds (organization_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

COMMENT ON COLUMN finance.tax_payments_and_refunds.idempotency_key IS
  'Spec 11.2: caller supplied idempotency key for duplicate-sensitive tax payment/refund commands.';

-- ---------------------------------------------------------------------------
-- Atomic tax payment/refund posting.
-- Inserts the source row, posts the journal with the source row id, and marks
-- the source completed in ONE database transaction. Approved manual FX is
-- resolved inside the same transaction so the API cannot silently use 1.0.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION finance.post_tax_payment_atomic(
  p_tax_computation_id uuid DEFAULT NULL,
  p_tax_return_id uuid DEFAULT NULL,
  p_fiscal_year_id uuid DEFAULT NULL,
  p_period_id uuid DEFAULT NULL,
  p_payment_type text DEFAULT 'PAYMENT',
  p_tax_authority text DEFAULT 'FBR',
  p_cpr_number text DEFAULT NULL,
  p_prs_number text DEFAULT NULL,
  p_amount numeric DEFAULT 0,
  p_currency text DEFAULT 'PKR',
  p_penalty_amount numeric DEFAULT 0,
  p_surcharge_amount numeric DEFAULT 0,
  p_payment_reference text DEFAULT NULL,
  p_payment_method text DEFAULT 'bank_transfer',
  p_payment_date date DEFAULT CURRENT_DATE,
  p_financial_account_id uuid DEFAULT NULL,
  p_debit_account_id uuid DEFAULT NULL,
  p_credit_account_id uuid DEFAULT NULL,
  p_notes text DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO pg_catalog, finance, public, core
AS $$
DECLARE
  v_org uuid := core.current_user_org_id();
  v_user uuid := auth.uid();
  v_payment_id uuid;
  v_journal_id uuid;
  v_rate numeric := 1;
  v_total numeric := round(COALESCE(p_amount,0) + COALESCE(p_penalty_amount,0) + COALESCE(p_surcharge_amount,0), 2);
  v_existing finance.tax_payments_and_refunds;
  v_account_org uuid;
  v_period_org uuid;
  v_fy_org uuid;
  v_comp_org uuid;
  v_return_org uuid;
  v_debit_org uuid;
  v_credit_org uuid;
  v_fin_org uuid;
  v_fin_ledger uuid;
  v_lines jsonb;
BEGIN
  IF v_org IS NULL OR v_user IS NULL THEN RAISE EXCEPTION 'Authentication and organization context are required'; END IF;
  IF NOT (core.is_finance_head() OR core.has_role('ACCOUNTANT')) THEN RAISE EXCEPTION 'Insufficient privileges'; END IF;
  IF p_amount <= 0 THEN RAISE EXCEPTION 'Tax payment amount must be positive'; END IF;
  IF p_currency !~ '^[A-Z]{3}$' THEN RAISE EXCEPTION 'Currency must be a three-letter uppercase code'; END IF;
  IF p_payment_type NOT IN ('PAYMENT','REFUND','ADVANCE_PAYMENT','ADJUSTMENT') THEN RAISE EXCEPTION 'Invalid payment type'; END IF;
  IF p_payment_method NOT IN ('bank_transfer','cheque','online','adjustment') THEN RAISE EXCEPTION 'Invalid payment method'; END IF;
  IF p_idempotency_key IS NULL OR btrim(p_idempotency_key) = '' THEN RAISE EXCEPTION 'Idempotency-Key is required'; END IF;
  IF p_period_id IS NULL THEN RAISE EXCEPTION 'period_id is required for a posted tax payment'; END IF;
  IF p_debit_account_id IS NULL OR p_credit_account_id IS NULL THEN RAISE EXCEPTION 'Both debit_account_id and credit_account_id are required for a posted tax payment'; END IF;

  SELECT * INTO v_existing
  FROM finance.tax_payments_and_refunds
  WHERE organization_id = v_org AND idempotency_key = p_idempotency_key
  FOR UPDATE;
  IF FOUND THEN
    RETURN jsonb_build_object('payment_id', v_existing.id, 'journal_entry_id', v_existing.journal_entry_id, 'status', v_existing.status, 'idempotent_replay', true);
  END IF;

  IF p_tax_computation_id IS NOT NULL THEN
    SELECT organization_id INTO v_comp_org FROM finance.tax_computations WHERE id = p_tax_computation_id;
    IF v_comp_org IS DISTINCT FROM v_org THEN RAISE EXCEPTION 'Tax computation not found or access denied'; END IF;
  END IF;
  IF p_tax_return_id IS NOT NULL THEN
    SELECT organization_id INTO v_return_org FROM finance.tax_returns WHERE id = p_tax_return_id;
    IF v_return_org IS DISTINCT FROM v_org THEN RAISE EXCEPTION 'Tax return not found or access denied'; END IF;
  END IF;
  IF p_fiscal_year_id IS NOT NULL THEN
    SELECT organization_id INTO v_fy_org FROM finance.fiscal_years WHERE id = p_fiscal_year_id;
    IF v_fy_org IS DISTINCT FROM v_org THEN RAISE EXCEPTION 'Fiscal year not found or access denied'; END IF;
  END IF;

  SELECT organization_id INTO v_period_org
  FROM finance.accounting_periods
  WHERE id = p_period_id AND status = 'OPEN';
  IF v_period_org IS DISTINCT FROM v_org THEN RAISE EXCEPTION 'Accounting period is invalid, closed, or belongs to another organization'; END IF;

  SELECT organization_id INTO v_debit_org FROM finance.chart_of_accounts WHERE id = p_debit_account_id AND is_active = true;
  SELECT organization_id INTO v_credit_org FROM finance.chart_of_accounts WHERE id = p_credit_account_id AND is_active = true;
  IF v_debit_org IS DISTINCT FROM v_org OR v_credit_org IS DISTINCT FROM v_org THEN RAISE EXCEPTION 'Ledger accounts must belong to the caller organization and be active'; END IF;

  IF p_financial_account_id IS NOT NULL THEN
    SELECT organization_id, linked_ledger_account_id INTO v_fin_org, v_fin_ledger
    FROM finance.financial_accounts
    WHERE id = p_financial_account_id AND is_active = true;
    IF v_fin_org IS DISTINCT FROM v_org THEN RAISE EXCEPTION 'Financial account not found or inactive'; END IF;
    IF v_fin_ledger IS NOT NULL AND v_fin_ledger IS DISTINCT FROM p_credit_account_id THEN
      RAISE EXCEPTION 'Credit ledger account must match the selected financial account ledger mapping';
    END IF;
  END IF;

  IF p_currency <> 'PKR' THEN
    SELECT er.rate INTO v_rate
    FROM finance.exchange_rates er
    WHERE er.organization_id = v_org
      AND er.from_currency = p_currency
      AND er.to_currency = 'PKR'
      AND er.rate_date <= p_payment_date
      AND er.approved_by IS NOT NULL
      AND er.is_locked = true
    ORDER BY er.rate_date DESC, er.rate_time DESC NULLS LAST, er.created_at DESC
    LIMIT 1;
    IF v_rate IS NULL OR v_rate <= 0 THEN
      RAISE EXCEPTION 'No approved and locked %/PKR exchange rate exists on or before %', p_currency, p_payment_date;
    END IF;
  END IF;

  INSERT INTO finance.tax_payments_and_refunds (
    organization_id, tax_computation_id, tax_return_id, fiscal_year_id, period_id,
    payment_type, tax_authority, cpr_number, prs_number, amount, currency,
    penalty_amount, surcharge_amount, payment_reference, payment_method, payment_date,
    financial_account_id, journal_entry_id, status, notes, created_by, idempotency_key
  ) VALUES (
    v_org, p_tax_computation_id, p_tax_return_id, p_fiscal_year_id, p_period_id,
    p_payment_type, COALESCE(p_tax_authority,'FBR'), p_cpr_number, p_prs_number,
    round(p_amount,2), p_currency, round(COALESCE(p_penalty_amount,0),2), round(COALESCE(p_surcharge_amount,0),2),
    p_payment_reference, p_payment_method, p_payment_date, p_financial_account_id, NULL,
    'PENDING', p_notes, v_user, p_idempotency_key
  ) RETURNING id INTO v_payment_id;

  v_lines := jsonb_build_array(
    jsonb_build_object('account_id', p_debit_account_id, 'debit_amount', v_total, 'credit_amount', 0, 'description', 'Tax ' || p_payment_type),
    jsonb_build_object('account_id', p_credit_account_id, 'debit_amount', 0, 'credit_amount', v_total, 'description', 'Tax ' || p_payment_type)
  );

  v_journal_id := finance.post_journal_entry(
    'Tax ' || p_payment_type,
    p_payment_date,
    p_period_id,
    v_lines,
    p_currency,
    v_rate,
    'TAX_PAYMENT',
    v_payment_id,
    NULL,
    NULL
  );

  UPDATE finance.tax_payments_and_refunds
  SET journal_entry_id = v_journal_id, status = 'COMPLETED', updated_at = now()
  WHERE id = v_payment_id AND organization_id = v_org;

  RETURN jsonb_build_object('payment_id', v_payment_id, 'journal_entry_id', v_journal_id, 'status', 'COMPLETED', 'exchange_rate', v_rate, 'idempotent_replay', false);
END;
$$;

REVOKE ALL ON FUNCTION finance.post_tax_payment_atomic(uuid,uuid,uuid,uuid,text,text,text,text,numeric,text,numeric,numeric,text,text,date,uuid,uuid,uuid,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION finance.post_tax_payment_atomic(uuid,uuid,uuid,uuid,text,text,text,text,numeric,text,numeric,numeric,text,text,date,uuid,uuid,uuid,text,text) TO authenticated;

-- ---------------------------------------------------------------------------
-- Distribution payment organization isolation
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION finance.post_distribution_payment(
  p_line_id uuid,
  p_period_id uuid,
  p_transaction_date date,
  p_bank_account_id uuid
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO pg_catalog, finance, public, core
AS $$
DECLARE
  v_org uuid := core.current_user_org_id();
  v_line record; v_dist record; v_lines jsonb := '[]'::jsonb;
  v_payable uuid; v_bank_ledger uuid; v_owner_name text; v_period_org uuid; v_bank_org uuid;
BEGIN
  IF v_org IS NULL THEN RAISE EXCEPTION 'Organization context is required'; END IF;
  IF NOT (core.is_finance_head() OR core.has_role('ACCOUNTANT')) THEN RAISE EXCEPTION 'Insufficient privileges'; END IF;

  SELECT organization_id INTO v_period_org FROM finance.accounting_periods WHERE id = p_period_id AND status = 'OPEN';
  IF v_period_org IS DISTINCT FROM v_org THEN RAISE EXCEPTION 'Accounting period is invalid, closed, or belongs to another organization'; END IF;

  SELECT dl.*, pd.organization_id AS distribution_org INTO v_line
  FROM finance.distribution_lines dl
  JOIN finance.profit_distributions pd ON pd.id = dl.profit_distribution_id
  WHERE dl.id = p_line_id AND pd.organization_id = v_org
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Distribution line not found or access denied'; END IF;
  IF v_line.payment_status <> 'PENDING' THEN RAISE EXCEPTION 'Already paid or cancelled'; END IF;

  SELECT organization_id, linked_ledger_account_id INTO v_bank_org, v_bank_ledger
  FROM finance.financial_accounts WHERE id = p_bank_account_id AND is_active = true;
  IF v_bank_org IS DISTINCT FROM v_org THEN RAISE EXCEPTION 'Bank account not found or access denied'; END IF;
  IF v_bank_ledger IS NULL THEN RAISE EXCEPTION 'Selected bank account has no linked ledger account'; END IF;

  SELECT name INTO v_owner_name FROM finance.owners WHERE id = v_line.owner_id AND organization_id = v_org;
  IF v_owner_name IS NULL THEN RAISE EXCEPTION 'Owner not found or access denied'; END IF;
  SELECT id INTO v_payable FROM finance.chart_of_accounts WHERE code = '2410' AND organization_id = v_org AND is_active = true AND posting_allowed IS NOT FALSE LIMIT 1;
  IF v_payable IS NULL THEN RAISE EXCEPTION 'Distribution payable account 2410 not found in your organization'; END IF;

  v_lines := v_lines || jsonb_build_object('account_id', v_payable, 'debit_amount', v_line.final_amount, 'credit_amount', 0, 'description', 'Payout to ' || v_owner_name);
  v_lines := v_lines || jsonb_build_object('account_id', v_bank_ledger, 'debit_amount', 0, 'credit_amount', v_line.final_amount, 'description', 'Payout to ' || v_owner_name);

  RETURN finance.post_journal_entry('Owner Payout', p_transaction_date, p_period_id, v_lines, 'PKR', 1.0, 'DISTRIBUTION_PAYMENT', p_line_id, NULL, NULL);
END;
$$;

REVOKE ALL ON FUNCTION finance.post_distribution_payment(uuid,uuid,date,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION finance.post_distribution_payment(uuid,uuid,date,uuid) TO authenticated;

-- ---------------------------------------------------------------------------
-- Make the legacy tax permission name harmless if an old seed is re-run.
-- Canonical application permissions are TAX_READ / TAX_MANAGE / TAX_APPROVE.
-- ---------------------------------------------------------------------------
INSERT INTO core.permissions (code, name, module, action, is_system, description)
VALUES
  ('TAX_READ', 'View Tax', 'tax', 'read', true, 'View tax records and reconciliation'),
  ('TAX_MANAGE', 'Manage Tax', 'tax', 'create', true, 'Create and edit tax records'),
  ('TAX_APPROVE', 'Approve Tax', 'tax', 'approve', true, 'Approve tax records and reconciliations')
ON CONFLICT (code) DO NOTHING;


-- Harden the existing approval RPC: the actor identity is always the authenticated caller.
CREATE OR REPLACE FUNCTION finance.approve_tax_reconciliation(
  p_recon_id uuid, p_user_id uuid, p_organization_id uuid DEFAULT NULL::uuid
) RETURNS finance.tax_reconciliations
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO pg_catalog, finance, public, core
AS $$
DECLARE v_recon finance.tax_reconciliations; v_org uuid := core.current_user_org_id(); v_result finance.tax_reconciliations;
BEGIN
  IF v_org IS NULL OR p_organization_id IS DISTINCT FROM v_org THEN RAISE EXCEPTION 'Organization context mismatch'; END IF;
  IF p_user_id IS DISTINCT FROM auth.uid() THEN RAISE EXCEPTION 'Approving user must be the authenticated caller'; END IF;
  IF NOT core.is_finance_head() THEN RAISE EXCEPTION 'Only CEO or Finance Head may approve a tax reconciliation'; END IF;
  SELECT * INTO v_recon FROM finance.tax_reconciliations WHERE id=p_recon_id AND organization_id=v_org FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Tax reconciliation not found or access denied'; END IF;
  IF v_recon.status NOT IN ('CALCULATED','UNDER_REVIEW') THEN RAISE EXCEPTION 'Tax reconciliation must be CALCULATED or UNDER_REVIEW to approve, current: %',v_recon.status; END IF;
  IF v_recon.created_by IS NOT NULL AND v_recon.created_by=auth.uid() THEN RAISE EXCEPTION 'Maker-checker: the user who created this reconciliation cannot also approve it'; END IF;
  UPDATE finance.tax_reconciliations SET status='ACCOUNTANT_APPROVED', accountant_approved_by=auth.uid(), approved_at=now(), updated_at=now() WHERE id=v_recon.id AND organization_id=v_org RETURNING * INTO v_result;
  RETURN v_result;
END; $$;
ALTER FUNCTION finance.approve_tax_reconciliation(uuid,uuid,uuid) OWNER TO postgres;
GRANT EXECUTE ON FUNCTION finance.approve_tax_reconciliation(uuid,uuid,uuid) TO authenticated;
