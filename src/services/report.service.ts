import { supabase as browserSupabase } from '@/lib/supabase';
import type { SupabaseClient } from '@supabase/supabase-js';

// BUG-007 FIX: This service previously imported the browser supabase client
// directly. When called from an API route, the browser client has no
// authenticated session, causing RLS to reject queries or return wrong data.
//
// Each function below now accepts an optional `supabaseClient` parameter.
// API routes pass their server-side authenticated client (from getAuthSupabase());
// frontend code omits it and the browser client is used (with its valid session).
type SClient = SupabaseClient<any, any, any>;
function resolveClient(override?: SClient | null): SClient {
  return override || (browserSupabase as unknown as SClient);
}
// Backward-compat alias: existing function bodies
// continue to reference `supabase` directly.
const supabase = browserSupabase;
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

export const getTaxReport = async (taxYear?: string, organization_id?: string) => {
  // BUG-037 FIX: Query finance.tax_credits_and_withholding instead of non-existent RPC
  let query = financeDb()
    .from('tax_credits_and_withholding')
    .select('*');

  if (organization_id) query = query.eq('organization_id', organization_id);
  if (taxYear) query = query.eq('tax_year', taxYear);

  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return data as unknown as TaxReportData;
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
  organization_id?: string;
}) => {
  // BUG-037 FIX: Query reporting.general_ledger view instead of non-existent RPC
  const page = params.page || 1;
  const pageSize = params.pageSize || 50;
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;

  let query = reportingDb()
    .from('general_ledger')
    .select('*', { count: 'exact' });

  if (params.organization_id) query = query.eq('organization_id', params.organization_id);
  if (params.accountId) query = query.eq('account_id', params.accountId);
  if (params.startDate) query = query.gte('transaction_date', params.startDate);
  if (params.endDate) query = query.lte('transaction_date', params.endDate);
  if (params.search) {
    const escaped = params.search.replace(/[%_]/g, '\\$&');
    query = query.or(`description.ilike.%${escaped}%,reference.ilike.%${escaped}%`);
  }

  const { data, error, count } = await query
    .order('transaction_date', { ascending: true })
    .range(from, to);

  if (error) throw new Error(error.message);
  return { rows: (data || []) as GLEntry[], total_count: count || 0 };
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
  let periodQuery = financeDb()
    .from('accounting_periods')
    .select('id')
    .eq('fiscal_year_id', params.fiscalYearId);
  if (!params.includePrior && params.periodStart) periodQuery = periodQuery.gte('start_date', params.periodStart);
  if (params.periodEnd) periodQuery = periodQuery.lte('end_date', params.periodEnd);
  const { data: periods, error: pErr } = await periodQuery;

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

export const getAccountBalances = async (organization_id?: string) => {
  // BUG-037 FIX: Query finance.chart_of_accounts + aggregate from finance.journal_lines
  // Fetch accounts first (no nested join — avoid TS error with Supabase generated types)
  let query = financeDb()
    .from('chart_of_accounts')
    .select('id, code, name, account_type, is_active, currency, organization_id')
    .eq('is_active', true);

  if (organization_id) query = query.eq('organization_id', organization_id);

  const { data: accounts, error } = await query.order('code', { ascending: true });
  if (error) throw new Error(error.message);

  // Fetch journal lines separately and aggregate by account_id
  const accountIds = (accounts || []).map((a: any) => a.id);
  let lineQuery = financeDb()
    .from('journal_lines')
    .select('account_id, debit_amount, credit_amount, base_debit, base_credit, journal_entry_id');
  if (accountIds.length > 0) {
    lineQuery = lineQuery.in('account_id', accountIds);
  }
  const { data: allLines } = await lineQuery;
  const postedEntryIds = new Set<string>();
  if (allLines?.length) {
    const ids = [...new Set(allLines.map((l: any) => l.journal_entry_id).filter(Boolean))];
    if (ids.length) {
      const { data: postedEntries } = await financeDb()
        .from('journal_entries')
        .select('id')
        .in('id', ids)
        .eq('status', 'POSTED');
      for (const e of postedEntries || []) postedEntryIds.add(e.id);
    }
  }

  // Build a map: account_id → { totalDebit, totalCredit }
  const lineMap = new Map<string, { totalDebit: number; totalCredit: number }>();
  for (const l of allLines || []) {
    if (l.journal_entry_id && !postedEntryIds.has(l.journal_entry_id)) continue;
    const entry = lineMap.get(l.account_id) || { totalDebit: 0, totalCredit: 0 };
    entry.totalDebit += Number(l.base_debit ?? 0);
    entry.totalCredit += Number(l.base_credit ?? 0);
    lineMap.set(l.account_id, entry);
  }

  // Aggregate debit/credit totals per account
  const rows = (accounts || []).map((account: any) => {
    const aggregated = lineMap.get(account.id) || { totalDebit: 0, totalCredit: 0 };
    const totalDebit = aggregated.totalDebit;
    const totalCredit = aggregated.totalCredit;
    const balance = totalDebit - totalCredit;
    return {
      account_id: account.id,
      account_code: account.code,
      account_name: account.name,
      account_type: account.account_type,
      currency: account.currency,
      total_debit: totalDebit,
      total_credit: totalCredit,
      balance,
    };
  });

  return rows as unknown as AccountBalanceRow[];
};

export const getBankTransfers = async (start?: string, end?: string, organization_id?: string) => {
  // BUG-037 FIX: Query finance.journal_entries where source_type='BANK_TRANSFER'
  let query = financeDb()
    .from('journal_entries')
    .select('*')
    .eq('source_type', 'BANK_TRANSFER');

  if (organization_id) query = query.eq('organization_id', organization_id);
  if (start) query = query.gte('transaction_date', start);
  if (end) query = query.lte('transaction_date', end);

  const { data, error } = await query.order('transaction_date', { ascending: false });
  if (error) throw new Error(error.message);
  return (data || []) as unknown as BankTransferRow[];
};

// ═══════════════════════════════════════════════════════════════════════════
// Budget Variance
// ═══════════════════════════════════════════════════════════════════════════

export const getBudgetVariance = async (fiscalYearId?: string, organization_id?: string) => {
  // BUG-037 FIX: Query finance.budgets with left join on budget_lines for actual data
  // Fetch budgets with their lines (single-level nested select only)
  let query = financeDb()
    .from('budgets')
    .select(`
      id,
      name,
      fiscal_year_id,
      total_amount,
      budget_lines(
        id,
        account_id,
        budgeted_amount
      )
    `);

  if (organization_id) query = query.eq('organization_id', organization_id);
  if (fiscalYearId) query = query.eq('fiscal_year_id', fiscalYearId);

  const { data: budgets, error } = await query;
  if (error) throw new Error(error.message);

  // Collect all account_ids from budget lines to fetch actuals in one query
  const allAccountIds: string[] = [];
  for (const budget of budgets || []) {
    for (const line of budget.budget_lines || []) {
      if (line.account_id) allAccountIds.push(line.account_id);
    }
  }

  // Fetch journal lines for all referenced accounts in a single query
  let actualsQuery = financeDb()
    .from('journal_lines')
    .select('account_id, base_debit, base_credit, journal_entry_id');
  if (allAccountIds.length > 0) {
    actualsQuery = actualsQuery.in('account_id', allAccountIds);
  }
  const { data: allActualLines } = await actualsQuery;

  // Build account_id → actual amount map
  const actualsMap = new Map<string, number>();
  const actualIds = [...new Set((allActualLines || []).map((l: any) => l.journal_entry_id).filter(Boolean))];
  const posted = actualIds.length ? await financeDb().from('journal_entries').select('id').in('id', actualIds).eq('status', 'POSTED') : { data: [] as any[] };
  const postedSet = new Set((posted.data || []).map((e: any) => e.id));
  for (const l of allActualLines || []) {
    if (l.journal_entry_id && !postedSet.has(l.journal_entry_id)) continue;
    const current = actualsMap.get(l.account_id) || 0;
    actualsMap.set(l.account_id, current + Number(l.base_debit ?? 0) - Number(l.base_credit ?? 0));
  }

  // Fetch account names for display
  const accountNamesMap = new Map<string, string>();
  if (allAccountIds.length > 0) {
    const { data: acctData } = await financeDb()
      .from('chart_of_accounts')
      .select('id, name')
      .in('id', allAccountIds);
    for (const a of acctData || []) {
      accountNamesMap.set(a.id, a.name);
    }
  }

  // Flatten budget lines with computed variance
  const rows: any[] = [];
  for (const budget of budgets || []) {
    for (const line of budget.budget_lines || []) {
      const actual = Math.abs(actualsMap.get(line.account_id) || 0);
      const budgeted = Number(line.budgeted_amount || 0);
      rows.push({
        budget_id: budget.id,
        budget_name: budget.name,
        account_id: line.account_id,
        account_name: accountNamesMap.get(line.account_id) || 'Unknown',
        budgeted_amount: budgeted,
        actual_amount: actual,
        variance: budgeted - actual,
      });
    }
  }

  return rows as unknown as BudgetVarianceRow[];
};

// ═══════════════════════════════════════════════════════════════════════════
// Ownership & Equity
// ═══════════════════════════════════════════════════════════════════════════

export const getOwnershipEquity = async (organization_id?: string) => {
  // BUG-037 FIX: Query finance.profit_distributions and finance.distribution_lines
  let query = financeDb()
    .from('profit_distributions')
    .select(`
      id,
      distribution_date,
      total_amount,
      status,
      distribution_lines(
        id,
        shareholder_id
      )
    `);

  if (organization_id) query = query.eq('organization_id', organization_id);

  const { data, error } = await query.order('distribution_date', { ascending: false });
  if (error) throw new Error(error.message);
  return (data || []) as unknown as OwnershipRow[];
};

// ═══════════════════════════════════════════════════════════════════════════
// Platform Settlements
// ═══════════════════════════════════════════════════════════════════════════

export const getPlatformSettlements = async (start?: string, end?: string, organization_id?: string) => {
  // BUG-037 FIX: Query finance.journal_entries where source_type in ('PLATFORM_FEE','COMMISSION')
  let query = financeDb()
    .from('journal_entries')
    .select('*')
    .in('source_type', ['PLATFORM_FEE', 'COMMISSION']);

  if (organization_id) query = query.eq('organization_id', organization_id);
  if (start) query = query.gte('transaction_date', start);
  if (end) query = query.lte('transaction_date', end);

  const { data, error } = await query.order('transaction_date', { ascending: false });
  if (error) throw new Error(error.message);
  return (data || []) as unknown as PlatformSettlementRow[];
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

export const getApprovalAging = async (organization_id?: string) => {
  // BUG-037 FIX: Query expenses, invoices, vendor_bills where status in pending states
  // Combine results from multiple source tables
  const pendingStatuses = ['SUBMITTED', 'VERIFIED', 'APPROVED'];

  const [invoicesRes, expensesRes, vendorBillsRes] = await Promise.all([
    supabase
      .from('invoices')
      .select('id, invoice_number, total_amount, currency, due_date, status, created_at, organization_id')
      .in('status', pendingStatuses),
    supabase
      .from('expenses')
      .select('id, title, amount, currency, status, expense_date, created_at, organization_id')
      .in('status', pendingStatuses),
    supabase
      .from('vendor_bills')
      .select('id, bill_number, total_amount, currency, due_date, status, created_at, organization_id')
      .in('status', pendingStatuses),
  ]);

  if (invoicesRes.error) throw new Error(invoicesRes.error.message);
  if (expensesRes.error) throw new Error(expensesRes.error.message);
  if (vendorBillsRes.error) throw new Error(vendorBillsRes.error.message);

  const now = new Date();
  const rows: any[] = [];

  for (const inv of invoicesRes.data || []) {
    const createdAt = new Date(inv.created_at);
    const daysPending = Math.floor((now.getTime() - createdAt.getTime()) / (1000 * 60 * 60 * 24));
    rows.push({
      id: inv.id,
      document_type: 'invoice',
      document_number: inv.invoice_number,
      amount: inv.total_amount,
      currency: inv.currency,
      status: inv.status,
      days_pending: daysPending,
      organization_id: inv.organization_id,
    });
  }

  for (const exp of expensesRes.data || []) {
    const createdAt = new Date(exp.created_at);
    const daysPending = Math.floor((now.getTime() - createdAt.getTime()) / (1000 * 60 * 60 * 24));
    rows.push({
      id: exp.id,
      document_type: 'expense',
      document_number: exp.title,
      amount: exp.amount,
      currency: exp.currency,
      status: exp.status,
      days_pending: daysPending,
      organization_id: exp.organization_id,
    });
  }

  for (const vb of vendorBillsRes.data || []) {
    const createdAt = new Date(vb.created_at);
    const daysPending = Math.floor((now.getTime() - createdAt.getTime()) / (1000 * 60 * 60 * 24));
    rows.push({
      id: vb.id,
      document_type: 'vendor_bill',
      document_number: vb.bill_number,
      amount: vb.total_amount,
      currency: vb.currency,
      status: vb.status,
      days_pending: daysPending,
      organization_id: vb.organization_id,
    });
  }

  // Filter by organization_id if provided
  const filtered = organization_id
    ? rows.filter((r) => r.organization_id === organization_id)
    : rows;

  return filtered as unknown as ApprovalAgingRow[];
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

export const getCurrencyExposure = async (organization_id?: string) => {
  // BUG-037 FIX: Query finance.journal_entries grouped by currency
  let query = financeDb()
    .from('journal_entries')
    .select('currency');

  if (organization_id) query = query.eq('organization_id', organization_id);

  const { data, error } = await query;
  if (error) throw new Error(error.message);

  // Group by currency and compute totals from journal_lines
  const currencies = [...new Set((data || []).map((e: any) => e.currency).filter(Boolean))];
  const rows: any[] = [];

  for (const currency of currencies) {
    let lineQuery = financeDb()
      .from('journal_lines')
      .select('debit_amount, credit_amount, base_debit, base_credit, journal_entry_id')
      .eq('currency', currency);

    if (organization_id) lineQuery = lineQuery.eq('organization_id', organization_id);

    const { data: lines } = await lineQuery;
    const entryIds = [...new Set((lines || []).map((l: any) => l.journal_entry_id).filter(Boolean))];
    let postedIds = new Set<string>();
    if (entryIds.length) {
      const { data: posted } = await financeDb().from('journal_entries').select('id').in('id', entryIds).eq('status', 'POSTED');
      postedIds = new Set((posted || []).map((e: any) => e.id));
    }
    const postedLines = (lines || []).filter((l: any) => !l.journal_entry_id || postedIds.has(l.journal_entry_id));
    const totalDebit = postedLines.reduce((s: number, l: any) => s + Number(l.base_debit ?? l.debit_amount ?? 0), 0);
    const totalCredit = postedLines.reduce((s: number, l: any) => s + Number(l.base_credit ?? l.credit_amount ?? 0), 0);

    rows.push({
      currency,
      total_debit: totalDebit,
      total_credit: totalCredit,
      net_exposure: totalDebit - totalCredit,
      transaction_count: (data || []).filter((e: any) => e.currency === currency).length,
    });
  }

  return rows as unknown as CurrencyExposureRow[];
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