// ============================================================
// OSYSTIC FINANCE — AI Schema Reference
// Concise schema for Text-to-SQL generation (Spec 9.5)
// ONLY includes tables/views the AI is allowed to query.
// ============================================================

export const DATABASE_SCHEMA = `
-- ============================================================
-- SCHEMA: reporting (READ-ONLY VIEWS)
-- ============================================================

-- Cash & bank balances
CREATE VIEW reporting.v_cash_position AS
  SELECT
    account_id, account_name, institution_name, account_type, currency,
    opening_balance, current_balance, current_balance_base,
    base_currency, is_active, is_default, organization_id, data_as_of
  FROM reporting.v_cash_position;

-- Project revenue, cost, margin
CREATE VIEW reporting.v_project_profitability AS
  SELECT
    project_id, project_name, client_name, project_status, user_id,
    revenue, direct_cost, gross_profit, margin_percent,
    organization_id, base_currency, data_as_of
  FROM reporting.v_project_profitability;

-- Tax computation: PBT, taxable income, tax liability
CREATE VIEW reporting.v_tax_computation_summary AS
  SELECT
    tax_reconciliation_id, tax_year, fiscal_year_id,
    accounting_profit_before_tax, taxable_income, net_tax_adjustments,
    gross_tax_liability, withholding_credits, advance_tax_credits,
    other_tax_credits, net_tax_payable, profit_after_tax,
    effective_tax_rate, status, filing_date, filing_reference,
    payment_date, tax_rule_set_name, organization_id
  FROM reporting.v_tax_computation_summary;

-- Full general ledger with running balance
CREATE VIEW reporting.general_ledger AS
  SELECT
    journal_entry_id, journal_reference, journal_description,
    transaction_date, posting_date, period_id, fiscal_year_id,
    project_id, source_type, source_id,
    line_id, line_number, account_id,
    account_code, account_name, account_type, normal_balance,
    line_description, debit_amount, credit_amount,
    base_debit, base_credit, currency, exchange_rate,
    running_balance
  FROM reporting.general_ledger;

-- Budget vs actual spending
CREATE VIEW reporting.budget_vs_actual AS
  SELECT
    budget_id, budget_name, budget_category, budgeted_amount,
    start_date, end_date, actual_amount, remaining_amount,
    utilization_pct, project_id, project_name
  FROM reporting.budget_vs_actual;

-- Budget category summary
CREATE VIEW reporting.budget_category_summary AS
  SELECT
    budget_id, budget_name, category, total_budgeted,
    total_actual, variance, utilization_pct
  FROM reporting.budget_category_summary;

-- Vendor bill aging (current, 1-30, 31-60, 61-90, 90+ days)
CREATE VIEW reporting.payable_aging AS
  SELECT
    bill_id, bill_number, vendor_id, vendor_name, project_id,
    total_amount, amount_paid, outstanding_amount, due_date, bill_date, status,
    current_amount, overdue_1_30_days, overdue_31_60_days,
    overdue_61_90_days, overdue_over_90_days
  FROM reporting.payable_aging;

-- Invoice receivable aging
CREATE VIEW reporting.receivable_aging AS
  SELECT
    invoice_id, invoice_number, client_name, project_id, currency,
    total_amount, total_base_amount, amount_paid, paid_base_amount,
    outstanding_amount, outstanding_base_amount, due_date, issue_date, status,
    current_amount, overdue_1_30_days, overdue_31_60_days,
    overdue_61_90_days, overdue_over_90_days
  FROM reporting.receivable_aging;

-- Bank reconciliation status
CREATE VIEW reporting.reconciliation_summary AS
  SELECT
    financial_account_id, account_name, institution_name, currency,
    masked_identifier, ledger_balance, statement_balance,
    difference, last_reconciled_at, reconciliation_status, statement_date
  FROM reporting.reconciliation_summary;

-- Unreconciled bank lines
CREATE VIEW reporting.unreconciled_lines AS
  SELECT
    id, financial_account_id, statement_date, description,
    amount, type, reference, is_reconciled, matched_journal_line_id
  FROM reporting.unreconciled_lines;

-- Asset register with NBV
CREATE VIEW reporting.v_asset_register AS
  SELECT
    asset_id, asset_name, category, acquisition_date, acquisition_cost,
    accumulated_depreciation, net_book_value, status, location,
    supplier, project_id, organization_id
  FROM reporting.v_asset_register;

-- Depreciation summary by period
CREATE VIEW reporting.v_depreciation_summary AS
  SELECT
    fiscal_year_id, fiscal_year_name, period_id, period_name,
    start_date, end_date, assets_depreciated, total_depreciation,
    total_opening_nbv, total_closing_nbv, posted_count, pending_count
  FROM reporting.v_depreciation_summary;

-- ============================================================
`;
