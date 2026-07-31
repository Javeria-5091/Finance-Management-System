// types/accounting.types.ts
// ==========================================
// PHASE 1 TYPES - Accounting Foundation
// Organized by module with clear sections
// ==========================================

// ══════════════════════════════════════════
// § 1: ORGANIZATION CONFIG
// ══════════════════════════════════════════

export type RoundingMethod = 'HALF_UP' | 'HALF_DOWN' | 'CEILING' | 'FLOOR' | 'UP' | 'DOWN';

export interface OrganizationConfig {
  id: string;
  org_name: string;
  base_currency: string;
  enabled_currencies: string[];
  timezone: string;
  date_format: string;
  number_format: string;
  fiscal_year_start_month: number;
  fiscal_year_end_month: number;
  decimal_precision: number;
  rounding_method: RoundingMethod;
  logo_url: string | null;
  active: boolean;
  created_at: string;
  updated_at: string;
  created_by: string | null;
}

// ══════════════════════════════════════════
// § 2: CHART OF ACCOUNTS
// ══════════════════════════════════════════

export type AccountType =
  | 'ASSET'
  | 'LIABILITY'
  | 'EQUITY'
  | 'REVENUE'
  | 'COST_OF_SALES'
  | 'OPERATING_EXPENSE'
  | 'OTHER_INCOME'
  | 'OTHER_EXPENSE';

export type NormalBalance = 'DEBIT' | 'CREDIT';

export interface ChartOfAccount {
  id: string;
  code: string;
  name: string;
  parent_id: string | null;
  account_type: AccountType;
  normal_balance: NormalBalance;
  currency: string;
  is_active: boolean;
  posting_allowed: boolean;
  is_control_account: boolean;
  report_mapping: string | null;
  description: string | null;
  display_order: number;
  level: number;
  created_at: string;
  updated_at: string;
  created_by: string | null;
}

// Recursive CTE tree view
export interface ChartOfAccountTree extends ChartOfAccount {
  path_ids: string[];
  path_codes: string[];
  depth: number;
  children?: ChartOfAccountTree[];
  isExpanded?: boolean;
}

// Lightweight version for dropdowns
export interface PostableAccount {
  id: string;
  code: string;
  name: string;
  account_type: AccountType;
  normal_balance: NormalBalance;
  currency: string;
  is_control_account: boolean;
  report_mapping: string | null;
}

// ══════════════════════════════════════════
// § 3: FISCAL YEARS
// ══════════════════════════════════════════

export type FiscalYearStatus = 'OPEN' | 'SOFT_CLOSED' | 'HARD_CLOSED';

export interface FiscalYear {
  id: string;
  name: string;
  start_date: string;
  end_date: string;
  status: FiscalYearStatus;
  description: string | null;
  closed_by: string | null;
  closed_at: string | null;
  reopening_reason: string | null;
  created_at: string;
  updated_at: string;
  created_by: string | null;
}

// View: finance.fiscal_year_summary — includes period counts
export interface FiscalYearSummary {
  id: string;
  name: string;
  start_date: string;
  end_date: string;
  status: FiscalYearStatus;
  description: string | null;
  closed_at: string | null;
  created_at: string;
  updated_at: string;
  created_by: string | null;
  closed_by: string | null;
  reopening_reason: string | null;
  // Period counts from the view
  total_periods: number;
  pending_periods: number;
  open_periods: number;
  soft_closed_periods: number;
  hard_closed_periods: number;
}

// ══════════════════════════════════════════
// § 4: ACCOUNTING PERIODS
// ══════════════════════════════════════════

export type PeriodStatus = 'PENDING' | 'OPEN' | 'SOFT_CLOSED' | 'HARD_CLOSED';

export interface AccountingPeriod {
  id: string;
  fiscal_year_id: string;
  period_number: number;
  name: string;
  start_date: string;
  end_date: string;
  status: PeriodStatus;
  closed_by: string | null;
  closed_at: string | null;
  reopening_reason: string | null;
  created_at: string;
  updated_at: string;
  created_by: string | null;
}

// Returned by finance.get_current_period()
export interface CurrentPeriod {
  period_id: string;
  fiscal_year_id: string;
  fiscal_year_name: string;
  period_number: number;
  period_name: string;
  period_start: string;
  period_end: string;
  period_status: string;
}

// ══════════════════════════════════════════
// § 5: NUMBERING SEQUENCES
// ══════════════════════════════════════════

export interface NumberingSequence {
  id: string;
  sequence_type: string;
  prefix: string;
  current_number: number;
  padding: number;
  fiscal_year_id: string | null;
  reset_per_period: boolean;
  format: string;
  created_at: string;
  updated_at: string;
}

export interface SequenceStatus extends NumberingSequence {
  next_number_preview: string;
}

// ══════════════════════════════════════════
// § 6: JOURNAL ENTRIES
// ══════════════════════════════════════════

export type JournalStatus =
  | 'DRAFT'
  | 'SUBMITTED'
  | 'VERIFIED'
  | 'APPROVED'
  | 'POSTED'
  | 'REVERSED'
  | 'REJECTED'
  | 'CANCELLED';

export interface JournalEntry {
  id: string;
  reference: string;
  description: string;
  status: JournalStatus;
  transaction_date: string;
  posting_date: string | null;
  period_id: string;
  fiscal_year_id: string;
  currency: string;
  exchange_rate: number;
  total_debit: number;
  total_credit: number;
  source_type: string | null;
  source_id: string | null;
  project_id: string | null;
  notes: string | null;
  rejection_reason: string | null;
  reversal_of_id: string | null;
  // Who & When
  created_by: string;
  created_at: string;
  submitted_by: string | null;
  submitted_at: string | null;
  approved_by: string | null;
  approved_at: string | null;
  posted_by: string | null;
  posted_at: string | null;
}

export interface JournalLine {
  id: string;
  journal_entry_id: string;
  line_number: number;
  account_id: string;
  description: string | null;
  debit_amount: number;
  credit_amount: number;
  base_debit: number | null;
  base_credit: number | null;
  // Joined from chart_of_accounts
  account_code?: string;
  account_name?: string;
}

// ══════════════════════════════════════════
// § 7: REPORTS (GL / Trial Balance)
// ══════════════════════════════════════════

export interface GeneralLedgerRow {
  journal_entry_id: string;
  journal_reference: string;
  journal_description: string;
  transaction_date: string;
  account_id: string;
  account_code: string;
  account_name: string;
  debit_amount: number;
  credit_amount: number;
  running_balance: number;
}

export interface TrialBalanceRow {
  account_id: string;
  code: string;
  name: string;
  account_type: string;
  normal_balance: string;
  total_debit: number;
  total_credit: number;
  net_balance: number;
}

// ══════════════════════════════════════════
// § 8: AUDIT LOG
// ══════════════════════════════════════════

export type AuditAction =
  | 'INSERT'
  | 'UPDATE'
  | 'DELETE'
  | 'STATUS_CHANGE'
  | 'APPROVE'
  | 'REJECT'
  | 'REVERSE'
  | 'LOGIN'
  | 'LOGOUT'
  | 'PERMISSION_CHANGE'
  | 'EXPORT'
  | 'PERIOD_CLOSE'
  | 'PERIOD_REOPEN'
  | 'AI_QUERY'
  | 'RATE_CHANGE'
  | 'CONFIG_CHANGE'
  | 'POST'
  | 'UNPOST';

export interface AuditLog {
  id: string;
  table_schema: string;
  table_name: string;
  record_id: string;
  action: AuditAction;
  old_values: Record<string, unknown> | null;
  new_values: Record<string, unknown> | null;
  changed_columns: string[] | null;
  changed_by: string;
  changed_at: string;
  ip_address: string | null;
  user_agent: string | null;
  reason: string | null;
  approval_ref_id: string | null;
  source_module: string | null;
  source_id: string | null;
  session_id: string | null;
}

// View: with user info joined
export interface AuditLogEnriched extends AuditLog {
  changed_by_name: string | null;
  changed_by_email: string | null;
  changed_by_role: string | null;
}

// ══════════════════════════════════════════
// § 9: FILTER / QUERY TYPES
// ══════════════════════════════════════════

export interface AuditLogFilters {
  search?: string;
  module?: string;
  action?: AuditAction | 'ALL';
  dateFrom?: string;
  dateTo?: string;
  userId?: string;
  page?: number;
  pageSize?: number;
}

export interface COAFilters {
  search?: string;
  accountType?: AccountType | 'ALL';
  status?: 'active' | 'inactive' | 'ALL';
}

// ══════════════════════════════════════════
// § 10: FORM INPUT TYPES
// ══════════════════════════════════════════

// --- COA ---
export interface CreateAccountInput {
  code: string;
  name: string;
  parent_id: string | null;
  account_type: AccountType;
  normal_balance: NormalBalance;
  currency: string;
  posting_allowed: boolean;
  is_control_account: boolean;
  report_mapping: string | null;
  description: string | null;
}

// --- Fiscal Year ---
export interface CreateFiscalYearInput {
  name: string;
  start_date: string;
  end_date: string;
  description?: string;
}

// --- Period Actions ---
export interface OpenPeriodInput {
  period_id: string;
}

export interface ClosePeriodInput {
  period_id: string;
  reason: string;
  status: 'SOFT_CLOSED' | 'HARD_CLOSED';
}

export interface ReopenPeriodInput {
  period_id: string;
  reason: string;
}

// --- Journal ---
export interface CreateJournalInput {
  description: string;
  transaction_date: string;
  period_id: string;
  currency: string;
  exchange_rate: number;
  source_type?: string | null;
  source_id?: string | null;
  project_id?: string | null;
  notes?: string | null;
  lines: Omit<JournalLine, 'id' | 'journal_entry_id' | 'base_debit' | 'base_credit' | 'account_code' | 'account_name'>[];
}

// ══════════════════════════════════════════
// § 11: REPORTING TYPES (Phase 8)
// ══════════════════════════════════════════

export interface ProfitAndLossRow {
  section_order: number;
  section: string;
  code: string;
  account_name: string;
  debit_total: number;
  credit_total: number;
  net_amount: number;
}

export interface BalanceSheetRow {
  section_order: number;
  section: string;
  code: string;
  account_name: string;
  net_amount: number;
}

export interface CashFlowRow {
  section: 'OPERATING' | 'INVESTING' | 'FINANCING';
  account_name: string;
  amount: number;
}

export interface ProjectProfitabilityRow {
  project_id: string;
  project_name: string;
  total_revenue: number;
  total_costs: number;
  gross_profit: number;
  margin_pct: number;
}

export interface CEODashboardMetrics {
  total_cash: number;
  total_receivables: number;
  total_payables: number;
  current_month_pl: number;
}

// ══════════════════════════════════════════
// § 12: MIGRATION TYPES
// ══════════════════════════════════════════

export interface MigrationMapping {
  category: string;
  type: 'income' | 'expense';
  target_account_id: string;
  default_cash_account_id: string;
}