// ═══════════════════════════════════════════════════════════════════════════
// OSYSTIC Reports Type Definitions — CEO Spec v1.3 Section 13
// ═══════════════════════════════════════════════════════════════════════════

// ─── Financial Statements ───
export interface PLAccount {
  code: string;
  account_name: string;
  total: number;
  credit_total?: number;
  debit_total?: number;
  budget_total?: number;
  prior_total?: number;
}

export interface PLData {
  revenue: PLAccount[];
  cost_of_sales: PLAccount[];
  operating_expenses: PLAccount[];
  other_income: PLAccount[];
  other_expenses: PLAccount[];
}

export interface BSAccount {
  code: string;
  account_name: string;
  account_type: string;
  total: number;
  prior_total?: number;
}

export interface BSData {
  assets: BSAccount[];
  liabilities: BSAccount[];
  equity: BSAccount[];
}

export interface CFItem {
  account_name: string;
  account_type?: string;
  total: number;
}

export interface CFData {
  operating: CFItem[];
  investing: CFItem[];
  financing: CFItem[];
  cash_balance: number;
}

export interface SOCEItem {
  account_name: string;
  opening_balance: number;
  additions: number;
  deductions: number;
  transfers: number;
  closing_balance: number;
}

export interface SOCEData {
  items: SOCEItem[];
  total_opening: number;
  total_additions: number;
  total_deductions: number;
  total_closing: number;
}

// ─── Aging Reports ───
export interface AgingItem {
  client_name?: string;
  vendor_name?: string;
  invoice_number?: string;
  bill_number?: string;
  due_date: string;
  total: number;
  current_amount: number;
  overdue_1_30: number;
  overdue_31_60: number;
  overdue_61_90: number;
  overdue_over_90: number;
}

export interface AgingData {
  receivable: AgingItem[];
  payable: AgingItem[];
}

// ─── Project Profitability ───
export interface ProjectProfitRow {
  project_id: string;
  project_name: string;
  client_name: string;
  status: string;
  revenue: number;
  direct_costs: number;
  platform_fees: number;
  allocated_overhead: number;
  total_costs: number;
  gross_profit: number;
  net_profit: number;
  budget_revenue?: number;
  budget_costs?: number;
  revenue_entries: number;
  cost_entries: number;
}

// ─── Tax Reports ───
export interface TaxAdjustment {
  code: string;
  account_name: string;
  amount: number;
  adjustment_type: "add_back" | "deduction";
  approved: boolean;
}

export interface TaxCredit {
  code: string;
  description: string;
  amount: number;
  type: "withholding" | "advance" | "rebate" | "credit";
}

export interface TaxReportData {
  profit_before_tax: number;
  adjustments: TaxAdjustment[];
  taxable_income: number;
  gross_estimated_tax: number;
  tax_adjustments: number;
  adjustable_wht_credits: number;
  net_tax_payable: number;
  net_tax_refund: number;
  profit_after_tax: number;
  effective_tax_rate: number;
  status: "draft_estimate" | "accountant_approved" | "filed" | "amended" | "paid" | "refund_pending";
  taxpayer_profile?: string;
  rule_set_version?: string;
  components: {
    code: string;
    account_name: string;
    amount: number;
    component_type: string;
  }[];
  pnl_breakdown: {
    section: string;
    total: number;
  }[];
}

// ─── General Ledger ───
export interface GLEntry {
  id: string;
  date: string;
  ref: string;
  description: string;
  debit: number;
  credit: number;
  running_balance: number;
  account_code: string;
  account_name: string;
 journal_number?: string;
  source_type?: string;
}

// ─── Trial Balance ───
export interface TBEntry {
  code: string;
  account_name: string;
  debit: number;
  credit: number;
  net: number;
  prior_debit?: number;
  prior_credit?: number;
  prior_net?: number;
}

// ─── Cash & Bank Reports ───
export interface AccountBalanceRow {
  account_id: string;
  account_name: string;
  account_type: string;
  currency: string;
  balance: number;
  pkr_equivalent: number;
  reconciliation_status: "reconciled" | "pending" | "unreconciled";
  last_reconciled_date?: string;
}

export interface BankTransferRow {
  id: string;
  date: string;
  from_account: string;
  to_account: string;
  amount: number;
  currency: string;
  status: string;
  platform_fee: number;
  net_amount: number;
}

// ─── Budget Reports ───
export interface BudgetVarianceRow {
  category_id: string;
  category_name: string;
  original_budget: number;
  revised_budget: number;
  committed: number;
  actual: number;
  forecast: number;
  variance: number;
  variance_pct: number;
}

// ─── Ownership & Equity ───
export interface OwnershipRow {
  shareholder_name: string;
  capital: number;
  owner_loans: number;
  configurable_reserve: number;
  retained_earnings: number;
  total: number;
  distributions_declared: number;
  distributions_paid: number;
  payment_status: string;
}

// ─── Platform Settlements ───
export interface PlatformSettlementRow {
  platform_name: string;
  account_name: string;
  client_name: string;
  project_name?: string;
  currency: string;
  gross_settlement: number;
  expected_fee: number;
  actual_fee: number;
  effective_rate: number;
  deductions: number;
  net_payout: number;
  reconciliation_status: string;
  fee_variance: number;
}

// ─── Fiscal Calendar & Close ───
export interface FiscalPeriodRow {
  period_name: string;
  period_start: string;
  period_end: string;
  status: "open" | "closed" | "adjusting" | "future";
  journal_count: number;
  debit_total: number;
  credit_total: number;
  adjustment_count: number;
  close_checklist_complete: boolean;
}

// ─── Controls & Audit ───
export interface ApprovalAgingRow {
  id: string;
  type: string;
  requester: string;
  approver: string;
  submitted_at: string;
  amount: number;
  status: string;
  days_pending: number;
  sla_days: number;
  overdue: boolean;
}

export interface PolicyExceptionRow {
  id: string;
  rule_description: string;
  entity_type: string;
  entity_name: string;
  exception_reason: string;
  approved_by: string;
  approved_at: string;
  expires_at: string;
}

export interface AuditLogRow {
  id: string;
  timestamp: string;
  user_email: string;
  action: string;
  resource: string;
  resource_id: string;
  details: Record<string, unknown>;
  ip_address: string;
}

// ─── Report Filter State ───
export interface ReportFilters {
  startDate?: string;
  endDate?: string;
  fiscalYear?: string;
  currency?: string;
  comparison?: string;
  entity?: string;
  includePrior?: string;
}

// ─── Currency / FX ───
export interface CurrencyExposureRow {
  currency: string;
  total_receivable: number;
  total_payable: number;
  net_exposure: number;
  pkr_equivalent: number;
  realized_gain_loss: number;
  unrealized_gain_loss: number;
}

// ─── MF-03: Original-currency ledgers ───
export interface GLMultiCurrencyEntry {
  id: string;
  date: string;
  ref: string;
  description: string;
  account_code: string;
  account_name: string;
  original_currency: string;
  original_debit: number;
  original_credit: number;
  base_currency: string;
  base_debit: number;
  base_credit: number;
  applied_exchange_rate: number;
  running_balance_base: number;
}

// ─── MF-04: Manual-rate history ───
export interface ExchangeRateHistoryRow {
  id: string;
  from_currency: string;
  to_currency: string;
  rate: number;
  rate_date: string;
  rate_time?: string;
  rate_type: 'PLATFORM' | 'BANK' | 'MANUAL' | 'PAYMENT_CHANNEL';
  source_platform?: string;
  evidence_reference: string;
  entered_by: string;
  entered_by_name?: string;
  entered_by_email?: string;
  approved_by?: string;
  approved_by_name?: string;
  approved_by_email?: string;
  approved_at?: string;
  is_locked: boolean;
  approval_status: 'PENDING_APPROVAL' | 'APPROVED' | 'N/A';
  created_at: string;
}

// ─── MF-05: PKR conversion report ───
export type RateMethod =
  | 'BASE_CURRENCY'
  | 'ACTUAL_PLATFORM_BANK_RATE'
  | 'APPROVED_ACCOUNTING_RATE'
  | 'PENDING_APPROVAL'
  | 'PENDING_CONVERSION';

export interface PkrConversionRow {
  journal_entry_id: string;
  line_id: string;
  journal_reference: string;
  journal_description: string;
  transaction_date: string;
  account_code: string;
  account_name: string;
  original_currency: string;
  base_currency: string;
  original_debit: number;
  original_credit: number;
  pkr_debit: number;
  pkr_credit: number;
  applied_rate: number;
  rate_date: string;
  rate_period_id?: string;
  matched_rate_type?: string;
  matched_rate_value?: number;
  matched_rate_evidence?: string;
  rate_method: RateMethod;
}
