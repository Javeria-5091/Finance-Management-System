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

// ═══════════════════════════════════════════════════════════════════════════
// Financial Statements
// ═══════════════════════════════════════════════════════════════════════════

export const getProfitAndLoss = async (start?: string, end?: string) => {
  const { data, error } = await supabase.rpc('profit_and_loss', {
    p_start: start || null, p_end: end || null
  });
  if (error) throw new Error(error.message);
  return data as PLData;
};

export const getBalanceSheet = async () => {
  const { data, error } = await supabase.rpc('balance_sheet');
  if (error) throw new Error(error.message);
  return data as BSData;
};

export const getCashFlow = async (start?: string, end?: string) => {
  const { data, error } = await supabase.rpc('cash_flow', {
    p_start: start || null, p_end: end || null
  });
  if (error) throw new Error(error.message);
  return data as CFData;
};

export const getStatementOfChangesInEquity = async (start?: string, end?: string) => {
  const { data, error } = await supabase.rpc('statement_of_changes_in_equity', {
    p_start: start || null, p_end: end || null
  });
  if (error) throw new Error(error.message);
  return data as SOCEData;
};

// ═══════════════════════════════════════════════════════════════════════════
// AR/AP Aging
// ═══════════════════════════════════════════════════════════════════════════

export const getAgingReport = async () => {
  const { data, error } = await supabase.rpc('aging_report');
  if (error) throw new Error(error.message);
  return data as AgingData;
};

// ═══════════════════════════════════════════════════════════════════════════
// Project Profitability
// ═══════════════════════════════════════════════════════════════════════════

export const getProjectProfitability = async (start?: string, end?: string) => {
  const { data, error } = await supabase.rpc('project_profitability_report', {
    p_start: start || null, p_end: end || null
  });
  if (error) throw new Error(error.message);
  return (data || []) as ProjectProfitRow[];
};

// ═══════════════════════════════════════════════════════════════════════════
// Tax Reports
// ═══════════════════════════════════════════════════════════════════════════

export const getTaxReport = async (taxYear?: string) => {
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
  const { data, error } = await supabase.rpc('get_trial_balance', {
    p_fiscal_year_id: params.fiscalYearId || null,
    p_period_start: params.periodStart || null,
    p_period_end: params.periodEnd || null,
    p_include_prior: params.includePrior || false,
  });
  if (error) throw new Error(error.message);
  return data as TBEntry[];
};

// ═══════════════════════════════════════════════════════════════════════════
// Cash & Bank
// ═══════════════════════════════════════════════════════════════════════════

export const getAccountBalances = async () => {
  const { data, error } = await supabase.rpc('account_balances_report');
  if (error) throw new Error(error.message);
  return (data || []) as AccountBalanceRow[];
};

export const getBankTransfers = async (start?: string, end?: string) => {
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
  const { data, error } = await supabase.rpc('ownership_equity_report');
  if (error) throw new Error(error.message);
  return (data || []) as OwnershipRow[];
};

// ═══════════════════════════════════════════════════════════════════════════
// Platform Settlements
// ═══════════════════════════════════════════════════════════════════════════

export const getPlatformSettlements = async (start?: string, end?: string) => {
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
  const { data, error } = await supabase.rpc('fiscal_close_status_report', {
    p_fiscal_year_id: fiscalYearId || null
  });
  if (error) throw new Error(error.message);
  return (data || []) as FiscalPeriodRow[];
};

// ═══════════════════════════════════════════════════════════════════════════
// Controls & Audit
// ═══════════════════════════════════════════════════════════════════════════

export const getApprovalAging = async () => {
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
  const { data, error } = await supabase.rpc('audit_log_report', {
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
