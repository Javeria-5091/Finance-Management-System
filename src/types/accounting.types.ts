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

// ══════════════════════════════════════════════════════════════════════════════
// § 8: AUDIT LOG (Spec v1.3 Section 8 — Revised to match 01_audit_schema_v1_3_spec.sql)
//
// NOTE: this interface is a 1:1 mirror of the `public.v_audit_log` view columns.
// If a column is renamed/added/removed in the SQL migration, mirror it here too
// so the frontend never silently drifts from the database contract.
// ══════════════════════════════════════════════════════════════════════════════

export type AuditAction =
  | 'INSERT' | 'UPDATE' | 'DELETE' | 'STATUS_CHANGE'
  | 'CREATE' | 'APPROVE' | 'REJECT' | 'REVERSE' | 'POST' | 'UNPOST'
  | 'LOGIN' | 'LOGOUT' | 'ACCESS_DENIED' | 'ERROR'
  | 'PERMISSION_CHANGE' | 'ROLE_CHANGE' | 'CONFIG_CHANGE'
  | 'EXPORT' | 'VIEW' | 'IMPORT' | 'BULK_ACTION'
  | 'PERIOD_CLOSE' | 'PERIOD_REOPEN'
  // AI actions (Spec 8.2: "AI question, generated query/tool, result access,
  // document extraction, recommendation acceptance/rejection, and detected
  // policy violation") — mirrors audit.log_ai_event() p_action examples.
  | 'AI_QUERY' | 'AI_TOOL_CALL' | 'AI_EXTRACTION'
  | 'AI_SUGGESTION_ACCEPTED' | 'AI_SUGGESTION_REJECTED'
  | 'AI_POLICY_VIOLATION_DETECTED'
  | 'RATE_CHANGE' | 'FISCAL_YEAR_CLOSED'
  | 'WORKFLOW_SUBMIT' | 'WORKFLOW_VERIFY' | 'WORKFLOW_APPROVE'
  | 'WORKFLOW_REJECT' | 'WORKFLOW_REVERSE' | 'WORKFLOW_CANCEL' | 'WORKFLOW_REOPEN';

export type AuditSeverity = 'info' | 'low' | 'medium' | 'high' | 'critical';
export type AuditStatus = 'success' | 'denied' | 'error';

export interface AuditLog {
  id: string;
  // Actor (Spec 8.1)
  user_id: string | null;
  user_email: string | null;
  user_name: string | null;
  role_snapshot: string | null;
  session_id: string | null;
  auth_method: string | null;
  // Event (Spec 8.1)
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  status: AuditStatus;
  severity: AuditSeverity;
  // Time and source (Spec 8.1)
  created_at: string;
  org_timezone: string | null;
  ip_address: string | null;
  user_agent: string | null;
  request_id: string | null;
  // Change (Spec 8.1)
  description: string | null;
  old_values: Record<string, unknown> | null;
  new_values: Record<string, unknown> | null;
  changed_columns: string[] | null;
  reason: string | null;
  approval_comments: string | null;
  // Workflow (Spec 8.1)
  previous_status: string | null;
  new_status: string | null;
  approval_level: string | null;
  delegated_authority: string | null;
  limit_decision: string | null;
  // Evidence (Spec 8.1)
  attachment_ids: string[] | null;
  import_batch_id: string | null;
  external_ref: string | null;
  related_journal_id: string | null;
  related_payment_id: string | null;
  // Spec 8.3 REQUIRED filter dimensions: project + amount
  project_id: string | null;
  amount: number | null;
  amount_currency: string | null;
  // Source
  source_module: string | null;
  source_table: string | null;
  source_schema: string | null;
  // AI field group (Spec 8.1 "AI" row / 9.9 ai_query_audit-equivalent)
  ai_question: string | null;
  ai_normalized_intent: string | null;
  ai_selected_tool: string | null;
  ai_generated_sql: string | null;
  ai_template_id: string | null;
  ai_row_count: number | null;
  ai_model: string | null;
  ai_latency_ms: number | null;
  ai_cost_usd: number | null;
  ai_input_tokens: number | null;
  ai_output_tokens: number | null;
  ai_refusal_reason: string | null;
  // Misc
  error_message: string | null;
  // Integrity (Spec 8.3)
  entry_hash: string | null;
}

/**
 * @deprecated The `audit.audit_log_enriched` view this used to map to does
 * not exist in the schema. `public.v_audit_log` already carries user_name /
 * user_email / role_snapshot as point-in-time snapshots, so no separate
 * "enriched" shape is needed. Kept as an alias only so older imports don't
 * break at compile time — prefer `AuditLog` directly in new code.
 */
export type AuditLogEnriched = AuditLog;

export interface AuditLogFilters {
  search?: string;
  module?: string;
  action?: string | 'ALL';
  severity?: AuditSeverity | 'ALL';
  status?: AuditStatus | 'ALL';
  dateFrom?: string;
  dateTo?: string;
  userId?: string;
  // Spec 8.3 REQUIRED filters that were previously missing end-to-end
  projectId?: string;
  minAmount?: number;
  maxAmount?: number;
  approvalLevel?: string;
  aiTool?: string;
  page?: number;
  pageSize?: number;
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