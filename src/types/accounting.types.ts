// ==========================================
// PHASE 1 TYPES - Accounting Foundation
// ==========================================

// ---- Organization Config ----
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
  rounding_method: 'HALF_UP' | 'HALF_DOWN' | 'CEILING' | 'FLOOR' | 'UP' | 'DOWN';
  logo_url: string | null;
  active: boolean;
  created_at: string;
  updated_at: string;
  created_by: string | null;
}

// ---- Chart of Accounts ----
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

// COA Tree view (from recursive CTE)
export interface ChartOfAccountTree extends ChartOfAccount {
  path_ids: string[];
  path_codes: string[];
  depth: number;
  // Frontend-only: children for tree rendering
  children?: ChartOfAccountTree[];
  isExpanded?: boolean;
}

// Postable account (for dropdowns)
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

// ---- Fiscal Years ----
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

// Fiscal Year with period counts
export interface FiscalYearSummary extends FiscalYear {
  total_periods: number;
  open_periods: number;
  soft_closed_periods: number;
  hard_closed_periods: number;
}

// ---- Accounting Periods ----
export type PeriodStatus = 'OPEN' | 'SOFT_CLOSED' | 'HARD_CLOSED';

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

// Current period response
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

// ---- Numbering Sequences ----
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

// ---- Audit Log ----
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

// Enriched audit log (with user info from view)
export interface AuditLogEnriched extends AuditLog {
  changed_by_name: string | null;
  changed_by_email: string | null;
  changed_by_role: string | null;
}

// ---- Filter Types ----
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

// ---- Form Types ----
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

export interface CreateFiscalYearInput {
  name: string;
  start_date: string;
  end_date: string;
  description?: string;
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