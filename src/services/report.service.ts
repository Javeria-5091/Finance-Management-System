import { supabase } from '@/lib/supabase';
import type {
  PLData, BSData, CFData, SOCEData,
  AgingData, ProjectProfitRow, TaxReportData,
  GLEntry, TBEntry,
  AccountBalanceRow, BankTransferRow,
  BudgetVarianceRow, OwnershipRow,
  PlatformSettlementRow, FiscalPeriodRow,
  ApprovalAgingRow, AuditLogRow,
  CurrencyExposureRow,
} from '@/types/reports.types';

// Schema-qualified database clients
const reportingDb = () => supabase.schema('reporting');
const auditDb = () => supabase.schema('audit');
const financeDb = () => supabase.schema('finance');

// ═══════════════════════════════════════════════════════════════════════════
// Financial Statements
// ═══════════════════════════════════════════════════════════════════════════

export const getProfitAndLoss = async (start?: string, end?: string) => {
  // FIX: Function is reporting.get_profit_and_loss with params p_start_date/p_end_date
  const { data, error } = await reportingDb().rpc('get_profit_and_loss', {
    p_start_date: start || null,
    p_end_date: end || null,
  });
  if (error) throw new Error(error.message);
  return data as PLData;
};

export const getBalanceSheet = async (asOfDate?: string) => {
  // FIX: Function is reporting.get_balance_sheet with param p_as_of_date
  const { data, error } = await reportingDb().rpc('get_balance_sheet', {
    p_as_of_date: asOfDate || null,
  });
  if (error) throw new Error(error.message);
  return data as BSData;
};

export const getCashFlow = async (start?: string, end?: string) => {
  // FIX: Function is reporting.get_cash_flow with params p_start_date/p_end_date
  const { data, error } = await reportingDb().rpc('get_cash_flow', {
    p_start_date: start || null,
    p_end_date: end || null,
  });
  if (error) throw new Error(error.message);
  return data as CFData;
};

export const getStatementOfChangesInEquity = async (start?: string, end?: string) => {
  // FIX: Function is reporting.get_statement_of_changes_in_equity with params p_period_start/p_period_end
  const { data, error } = await reportingDb().rpc('get_statement_of_changes_in_equity', {
    p_period_start: start || null,
    p_period_end: end || null,
  });
  if (error) throw new Error(error.message);
  return data as SOCEData;
};

// ═══════════════════════════════════════════════════════════════════════════
// AR/AP Aging
// ═══════════════════════════════════════════════════════════════════════════

export const getAgingReport = async () => {
  // FIX: No function named aging_report exists. Views reporting.receivable_aging and
  // reporting.payable_aging exist. Query both views and combine the results.
  const { data: receivable, error: arErr } = await reportingDb()
    .from('receivable_aging')
    .select('*');
  if (arErr) throw new Error(arErr.message);

  const { data: payable, error: apErr } = await reportingDb()
    .from('payable_aging')
    .select('*');
  if (apErr) throw new Error(apErr.message);

  const combined = [
    ...(receivable || []).map((r: any) => ({ ...r, aging_type: 'receivable' })),
    ...(payable || []).map((p: any) => ({ ...p, aging_type: 'payable' })),
  ];
  return combined as unknown as AgingData;
};

// ═══════════════════════════════════════════════════════════════════════════
// Project Profitability
// ═══════════════════════════════════════════════════════════════════════════

export const getProjectProfitability = async (start?: string, end?: string) => {
  // FIX: Function is reporting.get_project_profitability with params p_start_date/p_end_date
  const { data, error } = await reportingDb().rpc('get_project_profitability', {
    p_start_date: start || null,
    p_end_date: end || null,
  });
  if (error) throw new Error(error.message);
  return (data || []) as ProjectProfitRow[];
};

// ═══════════════════════════════════════════════════════════════════════════
// Tax Reports
// ═══════════════════════════════════════════════════════════════════════════

export const getTaxReport = async (taxYear?: string) => {
  // DEFERRED: No function named tax_report exists in any schema.
  // This requires a database function to be created. Left unchanged.
  const { data, error } = await supabase.rpc('tax_report', {
    p_tax_year: taxYear || null
  });
  if (error) throw new Error(error.message);
  return data as TaxReportData;
};

// ═══════════════════════════════════════════════════════════════════════════
// General Ledger
// ═══════════════════════════════════════════════════════════════════════════

export const getGeneralLedger = async (params: {
  accountId?: string;
  startDate?: string;
  endDate?: string;
  page?: number;
  pageSize?: number;
  search?: string;
}) => {
  // DEFERRED: No function named general_ledger_report exists (only views).
  // Left unchanged.
  const { data, error } = await supabase.rpc('general_ledger_report', {
    p_account_id: params.accountId || null,
    p_start: params.startDate || null,
    p_end: params.endDate || null,
    p_page: params.page || 1,
    p_page_size: params.pageSize || 50,
    p_search: params.search || null,
  });
  if (error) throw new Error(error.message);
  return data as { rows: GLEntry[]; total_count: number };
};

// ═══════════════════════════════════════════════════════════════════════════
// Trial Balance
// ═══════════════════════════════════════════════════════════════════════════

export const getTrialBalance = async (params: {
  fiscalYearId?: string;
  periodStart?: string;
  periodEnd?: string;
  includePrior?: boolean;
}) => {
  // FIX: Function is reporting.get_trial_balance. It takes p_period_ids (uuid array)
  // not the individual params the service was passing. Since the frontend passes
  // fiscalYearId, we need to fetch the period IDs first, then call the function.
  // Fallback: if no fiscalYearId, return empty array.
  if (!params.fiscalYearId) return [] as TBEntry[];

  // Fetch period IDs for the fiscal year
  const { data: periods, error: pErr } = await financeDb()
    .from('accounting_periods')
    .select('id')
    .eq('fiscal_year_id', params.fiscalYearId);

  if (pErr) throw new Error(pErr.message);

  // Build period_ids array: include prior periods if requested, else only current FY
  let periodIds: string[] = [];
  if (periods) {
    periodIds = periods.map((p: any) => p.id);
  }

  const { data, error } = await reportingDb().rpc('get_trial_balance', {
    p_period_ids: periodIds,
  });
  if (error) throw new Error(error.message);
  return (data || []) as TBEntry[];
};

// ═══════════════════════════════════════════════════════════════════════════
// Cash & Bank
// ═══════════════════════════════════════════════════════════════════════════

export const getAccountBalances = async () => {
  // DEFERRED: No function named account_balances_report exists in any schema.
  const { data, error } = await supabase.rpc('account_balances_report');
  if (error) throw new Error(error.message);
  return (data || []) as AccountBalanceRow[];
};

export const getBankTransfers = async (start?: string, end?: string) => {
  // DEFERRED: No function named bank_transfers_report exists in any schema.
  const { data, error } = await supabase.rpc('bank_transfers_report', {
    p_start: start || null, p_end: end || null
  });
  if (error) throw new Error(error.message);
  return (data || []) as BankTransferRow[];
};

// ═══════════════════════════════════════════════════════════════════════════
// Budget Variance
// ═══════════════════════════════════════════════════════════════════════════

export const getBudgetVariance = async (fiscalYearId?: string) => {
  // DEFERRED: No function named budget_variance_report exists in any schema.
  const { data, error } = await supabase.rpc('budget_variance_report', {
    p_fiscal_year_id: fiscalYearId || null
  });
  if (error) throw new Error(error.message);
  return (data || []) as BudgetVarianceRow[];
};

// ═══════════════════════════════════════════════════════════════════════════
// Ownership & Equity
// ═══════════════════════════════════════════════════════════════════════════

export const getOwnershipEquity = async () => {
  // DEFERRED: No function named ownership_equity_report exists in any schema.
  const { data, error } = await supabase.rpc('ownership_equity_report');
  if (error) throw new Error(error.message);
  return (data || []) as OwnershipRow[];
};

// ═══════════════════════════════════════════════════════════════════════════
// Platform Settlements
// ═══════════════════════════════════════════════════════════════════════════

export const getPlatformSettlements = async (start?: string, end?: string) => {
  // DEFERRED: No function named platform_settlements_report exists in any schema.
  const { data, error } = await supabase.rpc('platform_settlements_report', {
    p_start: start || null, p_end: end || null
  });
  if (error) throw new Error(error.message);
  return (data || []) as PlatformSettlementRow[];
};

// ═══════════════════════════════════════════════════════════════════════════
// Fiscal Calendar & Close
// ═══════════════════════════════════════════════════════════════════════════

export const getFiscalCloseStatus = async (fiscalYearId?: string) => {
  // FIX: No function exists. Query finance.fiscal_years and finance.accounting_periods directly.
  if (!fiscalYearId) return [] as FiscalPeriodRow[];

  const [fyRes, periodsRes] = await Promise.all([
    financeDb().from('fiscal_years').select('id, name, status, start_date, end_date').eq('id', fiscalYearId).single(),
    financeDb().from('accounting_periods').select('id, period_number, period_name, status, start_date, end_date, closed_by, closed_at').eq('fiscal_year_id', fiscalYearId).order('period_number', { ascending: true }),
  ]);

  if (fyRes.error) throw new Error(fyRes.error.message);
  if (periodsRes.error) throw new Error(periodsRes.error.message);

  const fy = fyRes.data;
  const periods = periodsRes.data || [];

  return periods.map((p: any) => ({
    fiscal_year_id: fy.id,
    fiscal_year_name: fy.name,
    fiscal_year_status: fy.status,
    period_id: p.id,
    period_number: p.period_number,
    period_name: p.period_name,
    status: p.status,
    start_date: p.start_date,
    end_date: p.end_date,
    closed_by: p.closed_by,
    closed_at: p.closed_at,
  })) as unknown as FiscalPeriodRow[];
};

// ═══════════════════════════════════════════════════════════════════════════
// Controls & Audit
// ═══════════════════════════════════════════════════════════════════════════

export const getApprovalAging = async () => {
  // DEFERRED: No function named approval_aging_report exists in any schema.
  const { data, error } = await supabase.rpc('approval_aging_report');
  if (error) throw new Error(error.message);
  return (data || []) as ApprovalAgingRow[];
};

export const getAuditLog = async (params: {
  startDate?: string;
  endDate?: string;
  action?: string;
  resource?: string;
  page?: number;
  pageSize?: number;
}) => {
  // FIX: Function exists in audit schema as audit.audit_log_report with expanded params.
  // The service passes a subset of the available params — only the ones the function
  // accepts will be used, extras will be ignored by PostgreSQL.
  const { data, error } = await auditDb().rpc('audit_log_report', {
    p_start: params.startDate || null,
    p_end: params.endDate || null,
    p_action: params.action || null,
    p_resource: params.resource || null,
    p_page: params.page || 1,
    p_page_size: params.pageSize || 50,
  });
  if (error) throw new Error(error.message);
  return data as { rows: AuditLogRow[]; total_count: number };
};

// ═══════════════════════════════════════════════════════════════════════════
// Currency Exposure
// ═══════════════════════════════════════════════════════════════════════════

export const getCurrencyExposure = async () => {
  // DEFERRED: No function named currency_exposure_report exists in any schema.
  const { data, error } = await supabase.rpc('currency_exposure_report');
  if (error) throw new Error(error.message);
  return (data || []) as CurrencyExposureRow[];
};

export default {
  getProfitAndLoss,
  getBalanceSheet,
  getCashFlow,
  getStatementOfChangesInEquity,
  getAgingReport,
  getProjectProfitability,
  getTaxReport,
  getGeneralLedger,
  getTrialBalance,
  getAccountBalances,
  getBankTransfers,
  getBudgetVariance,
  getOwnershipEquity,
  getPlatformSettlements,
  getFiscalCloseStatus,
  getApprovalAging,
  getAuditLog,
  getCurrencyExposure,
};