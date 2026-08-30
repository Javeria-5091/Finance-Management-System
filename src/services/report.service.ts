import { supabase as browserSupabase } from '@/lib/supabase';
import type { SupabaseClient } from '@supabase/supabase-js';

type SClient = SupabaseClient<any, any, any>;
function resolveClient(override?: SClient | null): SClient {
  return override || (browserSupabase as unknown as SClient);
}

const supabase = browserSupabase;
import { getCurrentOrganizationId } from '@/lib/organization';
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
const coreDb = () => supabase.schema('core');


const PL_SECTION_KEYS = ['revenue', 'cost_of_sales', 'operating_expenses', 'other_income', 'other_expenses'] as const;

export const getProfitAndLoss = async (start?: string, end?: string) => {
  const organization_id = await getCurrentOrganizationId();
  const { data, error } = await reportingDb().rpc('get_profit_and_loss', {
    p_start_date: start || null,
    p_end_date: end || null,
    p_organization_id: organization_id,
  });
  if (error) throw new Error(error.message);

  const result: PLData = { revenue: [], cost_of_sales: [], operating_expenses: [], other_income: [], other_expenses: [] };
  for (const row of (data || []) as any[]) {
    const key = PL_SECTION_KEYS[(row.section_order || 6) - 1];
    if (!key) continue; // section_order 6 (unmapped account_type) — nothing to bucket into
    result[key].push({
      code: row.code,
      account_name: row.account_name,
      total: Number(row.net_amount ?? 0),
      debit_total: Number(row.debit_total ?? 0),
      credit_total: Number(row.credit_total ?? 0),
    });
  }
  return result;
};

// BUG-006 FIX: reporting.get_balance_sheet returns FLAT rows
// {section_order, section, code, account_name, net_amount} but the page reads
// a GROUPED BSData object {assets:[...], liabilities:[...], equity:[...]}.
// section_order is 1=ASSET, 2=LIABILITY, 3=EQUITY per the RPC's CASE expression.
const BS_SECTION_KEYS = ['assets', 'liabilities', 'equity'] as const;

export const getBalanceSheet = async (asOfDate?: string) => {
  const organization_id = await getCurrentOrganizationId();
  const { data, error } = await reportingDb().rpc('get_balance_sheet', {
    p_as_of_date: asOfDate || null,
    p_organization_id: organization_id,
  });
  if (error) throw new Error(error.message);

  const result: BSData = { assets: [], liabilities: [], equity: [] };
  for (const row of (data || []) as any[]) {
    const key = BS_SECTION_KEYS[(row.section_order || 0) - 1];
    if (!key) continue;
    result[key].push({
      code: row.code,
      account_name: row.account_name,
      account_type: key === 'assets' ? 'ASSET' : key === 'liabilities' ? 'LIABILITY' : 'EQUITY',
      total: Number(row.net_amount ?? 0),
    });
  }
  return result;
};

export const getCashFlow = async (start?: string, end?: string) => {
  const organization_id = await getCurrentOrganizationId();
  const { data, error } = await reportingDb().rpc('get_cash_flow', {
    p_start_date: start || null,
    p_end_date: end || null,
    p_organization_id: organization_id,
  });
  if (error) throw new Error(error.message);

  const result: CFData = { operating: [], investing: [], financing: [], cash_balance: 0 };
  const sectionMap: Record<string, keyof Omit<CFData, 'cash_balance'>> = {
    OPERATING: 'operating', INVESTING: 'investing', FINANCING: 'financing',
  };
  for (const row of (data || []) as any[]) {
    const key = sectionMap[row.section];
    if (!key) continue;
    result[key].push({ account_name: row.account_name, total: Number(row.amount ?? 0) });
  }

  // Cash balance as of end date: opening_balance + posted movement on each active
  // financial account's linked ledger account, up to and including end date.
  const { data: accounts } = await financeDb()
    .from('financial_accounts')
    .select('opening_balance, linked_ledger_account_id')
    .eq('organization_id', organization_id)
    .eq('is_active', true);

  const linkedIds = [...new Set((accounts || []).map((a: any) => a.linked_ledger_account_id).filter(Boolean))];
  let movementByAccount = new Map<string, number>();
  if (linkedIds.length) {
    let lineQuery = financeDb()
      .from('journal_lines')
      .select('account_id, base_debit, base_credit, journal_entry_id')
      .in('account_id', linkedIds);
    const { data: lines } = await lineQuery;
    const entryIds = [...new Set((lines || []).map((l: any) => l.journal_entry_id).filter(Boolean))];
    let postedIds = new Set<string>();
    if (entryIds.length) {
      let postedQuery = financeDb().from('journal_entries').select('id').in('id', entryIds).eq('status', 'POSTED');
      if (end) postedQuery = postedQuery.lte('transaction_date', end);
      const { data: posted } = await postedQuery;
      postedIds = new Set((posted || []).map((e: any) => e.id));
    }
    for (const l of lines || []) {
      if (!l.journal_entry_id || !postedIds.has(l.journal_entry_id)) continue;
      movementByAccount.set(l.account_id, (movementByAccount.get(l.account_id) || 0) + Number(l.base_debit ?? 0) - Number(l.base_credit ?? 0));
    }
  }
  result.cash_balance = (accounts || []).reduce(
    (sum: number, a: any) => sum + Number(a.opening_balance ?? 0) + (movementByAccount.get(a.linked_ledger_account_id) || 0),
    0
  );

  return result;
};

export const getStatementOfChangesInEquity = async (start?: string, end?: string) => {
  const organization_id = await getCurrentOrganizationId();
  const { data, error } = await reportingDb().rpc('get_statement_of_changes_in_equity', {
    p_period_start: start || null,
    p_period_end: end || null,
    p_organization_id: organization_id,
  });
  if (error) throw new Error(error.message);

  const items = ((data || []) as any[]).map((row) => {
    const movement = Number(row.period_movement ?? 0);
    return {
      account_name: row.account_name,
      opening_balance: Number(row.opening_balance ?? 0),
      additions: movement > 0 ? movement : 0,
      deductions: movement < 0 ? -movement : 0,
      transfers: 0,
      closing_balance: Number(row.closing_balance ?? 0),
    };
  });

  const result: SOCEData = {
    items,
    total_opening: items.reduce((s, i) => s + i.opening_balance, 0),
    total_additions: items.reduce((s, i) => s + i.additions, 0),
    total_deductions: items.reduce((s, i) => s + i.deductions, 0),
    total_closing: items.reduce((s, i) => s + i.closing_balance, 0),
  };
  return result;
};

export const getAgingReport = async () => {
  const { data: receivable, error: arErr } = await reportingDb()
    .from('receivable_aging')
    .select('*');
  if (arErr) throw new Error(arErr.message);

  const { data: payable, error: apErr } = await reportingDb()
    .from('payable_aging')
    .select('*');
  if (apErr) throw new Error(apErr.message);

  const result: AgingData = {
    receivable: ((receivable || []) as any[]).map((r) => ({
      client_name: r.client_name,
      invoice_number: r.invoice_number,
      due_date: r.due_date,
      total: Number(r.outstanding_base_amount ?? r.outstanding_amount ?? 0),
      current_amount: Number(r.current_amount ?? 0),
      overdue_1_30: Number(r.overdue_1_30_days ?? 0),
      overdue_31_60: Number(r.overdue_31_60_days ?? 0),
      overdue_61_90: Number(r.overdue_61_90_days ?? 0),
      overdue_over_90: Number(r.overdue_over_90_days ?? 0),
    })),
    payable: ((payable || []) as any[]).map((p) => ({
      vendor_name: p.vendor_name,
      bill_number: p.bill_number,
      due_date: p.due_date,
      total: Number(p.outstanding_amount ?? 0),
      current_amount: Number(p.current_amount ?? 0),
      overdue_1_30: Number(p.overdue_1_30_days ?? 0),
      overdue_31_60: Number(p.overdue_31_60_days ?? 0),
      overdue_61_90: Number(p.overdue_61_90_days ?? 0),
      overdue_over_90: Number(p.overdue_over_90_days ?? 0),
    })),
  };
  return result;
};

// ═══════════════════════════════════════════════════════════════════════════
// Project Profitability
// ═══════════════════════════════════════════════════════════════════════════

export const getProjectProfitability = async (start?: string, end?: string) => {
  const { data, error } = await reportingDb().rpc('get_project_profitability', {
    p_start_date: start || null,
    p_end_date: end || null,
  });
  if (error) throw new Error(error.message);
  const rows = (data || []) as any[];

  const projectIds = [...new Set(rows.map((r) => r.project_id).filter(Boolean))];
  const clientByProject = new Map<string, { client_name: string; status: string }>();
  if (projectIds.length) {
    // public.projects stores client_name directly (no separate clients table FK)
    const { data: projects } = await supabase
      .from('projects')
      .select('id, status, client_name')
      .in('id', projectIds);
    for (const p of projects || []) {
      clientByProject.set(p.id, { client_name: p.client_name || 'Unassigned', status: p.status || 'Active' });
    }
  }

  return rows.map((r) => {
    const meta = clientByProject.get(r.project_id) || { client_name: 'Unassigned', status: 'ACTIVE' };
    const totalCosts = Number(r.total_costs ?? 0);
    const grossProfit = Number(r.gross_profit ?? 0);
    return {
      project_id: r.project_id,
      project_name: r.project_name,
      client_name: meta.client_name,
      status: meta.status,
      revenue: Number(r.total_revenue ?? 0),
      direct_costs: totalCosts,
      platform_fees: 0,
      allocated_overhead: 0,
      total_costs: totalCosts,
      gross_profit: grossProfit,
      net_profit: grossProfit,
      revenue_entries: 0,
      cost_entries: 0,
    };
  }) as ProjectProfitRow[];
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

  const page = params.page || 1;
  const pageSize = params.pageSize || 50;
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;

  let query = reportingDb()
    .from('general_ledger')
    .select('*', { count: 'exact' });

  if (params.accountId) query = query.eq('account_id', params.accountId);
  if (params.startDate) query = query.gte('transaction_date', params.startDate);
  if (params.endDate) query = query.lte('transaction_date', params.endDate);
  if (params.search) {
    const escaped = params.search.replace(/[%_]/g, '\\$&');
    query = query.or(`line_description.ilike.%${escaped}%,journal_description.ilike.%${escaped}%,journal_reference.ilike.%${escaped}%`);
  }

  const { data, error, count } = await query
    .order('transaction_date', { ascending: true })
    .range(from, to);

  if (error) throw new Error(error.message);

  const rows: GLEntry[] = ((data || []) as any[]).map((r) => ({
    id: r.line_id,
    date: r.transaction_date,
    ref: r.journal_reference,
    journal_number: r.journal_reference,
    description: r.line_description || r.journal_description,
    debit: Number(r.base_debit ?? r.debit_amount ?? 0),
    credit: Number(r.base_credit ?? r.credit_amount ?? 0),
    running_balance: Number(r.running_balance ?? 0),
    account_code: r.account_code,
    account_name: r.account_name,
    source_type: r.source_type,
  }));

  return { rows, total_count: count || 0 };
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
  const organization_id = await getCurrentOrganizationId();

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
    p_organization_id: organization_id,
  });
  if (error) throw new Error(error.message);

  // BUG-006 FIX: the RPC returns {code, name, total_debit, total_credit, net_balance}
  // but trial-balance/page.tsx reads {code, account_name, debit, credit, net}. The RPC
  // also has no concept of a prior-period comparison, so prior_debit/prior_credit/prior_net
  // are intentionally left undefined (the page already guards with `e.prior_net !== undefined`)
  // rather than fabricated as zero, which would misleadingly render as "no change".
  return ((data || []) as any[]).map((row) => ({
    code: row.code,
    account_name: row.name,
    debit: Number(row.total_debit ?? 0),
    credit: Number(row.total_credit ?? 0),
    net: Number(row.net_balance ?? 0),
  })) as TBEntry[];
};

// ═══════════════════════════════════════════════════════════════════════════
// Cash & Bank
// ═══════════════════════════════════════════════════════════════════════════

export const getAccountBalances = async (organization_id?: string) => {
  const orgId = organization_id || (await getCurrentOrganizationId());

  const { data: org } = await coreDb().from('organizations').select('base_currency').eq('id', orgId).maybeSingle();
  const baseCurrency = org?.base_currency || 'PKR';

  const { data: accounts, error } = await financeDb()
    .from('financial_accounts')
    .select('id, account_name, account_type, currency, opening_balance, linked_ledger_account_id')
    .eq('organization_id', orgId)
    .eq('is_active', true)
    .order('account_name', { ascending: true });
  if (error) throw new Error(error.message);

  const linkedIds = [...new Set((accounts || []).map((a: any) => a.linked_ledger_account_id).filter(Boolean))];
  const movementByAccount = new Map<string, number>();
  if (linkedIds.length) {
    const { data: lines } = await financeDb()
      .from('journal_lines')
      .select('account_id, base_debit, base_credit, journal_entry_id')
      .in('account_id', linkedIds);
    const entryIds = [...new Set((lines || []).map((l: any) => l.journal_entry_id).filter(Boolean))];
    let postedIds = new Set<string>();
    if (entryIds.length) {
      const { data: posted } = await financeDb().from('journal_entries').select('id').in('id', entryIds).eq('status', 'POSTED');
      postedIds = new Set((posted || []).map((e: any) => e.id));
    }
    for (const l of lines || []) {
      if (!l.journal_entry_id || !postedIds.has(l.journal_entry_id)) continue;
      movementByAccount.set(l.account_id, (movementByAccount.get(l.account_id) || 0) + Number(l.base_debit ?? 0) - Number(l.base_credit ?? 0));
    }
  }

  // Most recent bank_statement per financial account, for reconciliation status
  const accountIds = (accounts || []).map((a: any) => a.id);
  const latestStatement = new Map<string, { status: string; reconciled_at?: string }>();
  if (accountIds.length) {
    const { data: statements } = await financeDb()
      .from('bank_statements')
      .select('financial_account_id, reconciliation_status, reconciled_at, statement_date')
      .in('financial_account_id', accountIds)
      .order('statement_date', { ascending: false });
    for (const s of statements || []) {
      if (!latestStatement.has(s.financial_account_id)) {
        latestStatement.set(s.financial_account_id, { status: s.reconciliation_status, reconciled_at: s.reconciled_at });
      }
    }
  }

  // Latest manual exchange rate per foreign currency -> base currency, if any exists
  const foreignCurrencies = [...new Set((accounts || []).map((a: any) => a.currency).filter((c: string) => c && c !== baseCurrency))];
  const rateByCurrency = new Map<string, number>();
  if (foreignCurrencies.length) {
    const { data: rates } = await financeDb()
      .from('exchange_rates')
      .select('from_currency, to_currency, rate, rate_date')
      .in('from_currency', foreignCurrencies)
      .eq('to_currency', baseCurrency)
      .order('rate_date', { ascending: false });
    for (const r of rates || []) {
      if (!rateByCurrency.has(r.from_currency)) rateByCurrency.set(r.from_currency, Number(r.rate));
    }
  }

  return (accounts || []).map((a: any) => {
    const balance = Number(a.opening_balance ?? 0) + (movementByAccount.get(a.linked_ledger_account_id) || 0);
    const stmt = latestStatement.get(a.id);
    const reconciliation_status: AccountBalanceRow['reconciliation_status'] =
      stmt?.status === 'COMPLETED' ? 'reconciled' : stmt?.status === 'PARTIAL' || stmt?.status === 'IN_PROGRESS' ? 'pending' : 'unreconciled';
    const rate = a.currency === baseCurrency ? 1 : rateByCurrency.get(a.currency);
    return {
      account_id: a.id,
      account_name: a.account_name,
      account_type: a.account_type,
      currency: a.currency,
      balance,
      pkr_equivalent: rate !== undefined ? balance * rate : balance,
      reconciliation_status,
      last_reconciled_date: stmt?.reconciled_at,
    };
  }) as AccountBalanceRow[];
};

// BUG-006 FIX: cash-bank/page.tsx ("Transfers & Fees" tab) reads BankTransferRow
// {date, from_account, to_account, amount, currency, platform_fee, net_amount, status}
// but this previously queried finance.journal_entries directly (raw header rows with
// no from/to account, fee, or net_amount fields at all). finance.bank_transfers is the
// actual dedicated table for this workflow (spec 5.8) and already has from_account_id/
// to_account_id/from_amount/to_amount. Fee is only meaningful when both legs are the
// same currency (a same-currency difference is a transfer/wire charge); when
// currencies differ the difference is FX conversion, not a fee.
export const getBankTransfers = async (start?: string, end?: string, organization_id?: string) => {
  const orgId = organization_id || (await getCurrentOrganizationId());

  let query = financeDb()
    .from('bank_transfers')
    .select('id, transfer_date, from_account_id, to_account_id, from_amount, to_amount, from_currency, to_currency, status')
    .eq('organization_id', orgId);

  if (start) query = query.gte('transfer_date', start);
  if (end) query = query.lte('transfer_date', end);

  const { data, error } = await query.order('transfer_date', { ascending: false });
  if (error) throw new Error(error.message);
  const rows = (data || []) as any[];

  const accountIds = [...new Set([...rows.map((r) => r.from_account_id), ...rows.map((r) => r.to_account_id)].filter(Boolean))];
  const nameById = new Map<string, string>();
  if (accountIds.length) {
    const { data: accounts } = await financeDb().from('financial_accounts').select('id, account_name').in('id', accountIds);
    for (const a of accounts || []) nameById.set(a.id, a.account_name);
  }

  return rows.map((r) => {
    const sameCurrency = r.from_currency === r.to_currency;
    const fee = sameCurrency ? Number(r.from_amount ?? 0) - Number(r.to_amount ?? 0) : 0;
    return {
      id: r.id,
      date: r.transfer_date,
      from_account: nameById.get(r.from_account_id) || 'Unknown',
      to_account: nameById.get(r.to_account_id) || 'Unknown',
      amount: Number(r.from_amount ?? 0),
      currency: r.from_currency,
      status: r.status,
      platform_fee: fee,
      net_amount: Number(r.to_amount ?? 0),
    };
  }) as BankTransferRow[];
};

// ═══════════════════════════════════════════════════════════════════════════
// Budget Variance
// ═══════════════════════════════════════════════════════════════════════════


export const getBudgetVariance = async (fiscalYearId?: string, organization_id?: string) => {
  const orgId = organization_id || (await getCurrentOrganizationId());

  let budgetQuery = supabase
    .from('budgets')
    .select('id, name, category, total_amount, fiscal_year_id')
    .eq('organization_id', orgId);
  if (fiscalYearId) budgetQuery = budgetQuery.eq('fiscal_year_id', fiscalYearId);
  const { data: budgets, error } = await budgetQuery;
  if (error) throw new Error(error.message);

  const budgetIds = (budgets || []).map((b: any) => b.id);
  if (!budgetIds.length) return [] as BudgetVarianceRow[];

  const { data: lines } = await financeDb()
    .from('budget_lines')
    .select('id, budget_id, account_id, budgeted_amount, committed_amount')
    .in('budget_id', budgetIds);

  const { data: revisions } = await financeDb()
    .from('budget_revisions')
    .select('budget_id, revised_amount, status, created_at')
    .in('budget_id', budgetIds)
    .eq('status', 'APPROVED')
    .order('created_at', { ascending: false });
  const latestRevisionByBudget = new Map<string, number>();
  for (const r of revisions || []) {
    if (!latestRevisionByBudget.has(r.budget_id)) latestRevisionByBudget.set(r.budget_id, Number(r.revised_amount));
  }

  const accountIds = [...new Set((lines || []).map((l: any) => l.account_id).filter(Boolean))];
  const actualsMap = new Map<string, number>();
  if (accountIds.length) {
    const { data: actualLines } = await financeDb()
      .from('journal_lines')
      .select('account_id, base_debit, base_credit, journal_entry_id')
      .in('account_id', accountIds);
    const entryIds = [...new Set((actualLines || []).map((l: any) => l.journal_entry_id).filter(Boolean))];
    let postedSet = new Set<string>();
    if (entryIds.length) {
      const { data: posted } = await financeDb().from('journal_entries').select('id').in('id', entryIds).eq('status', 'POSTED');
      postedSet = new Set((posted || []).map((e: any) => e.id));
    }
    for (const l of actualLines || []) {
      if (l.journal_entry_id && !postedSet.has(l.journal_entry_id)) continue;
      actualsMap.set(l.account_id, (actualsMap.get(l.account_id) || 0) + Number(l.base_debit ?? 0) - Number(l.base_credit ?? 0));
    }
  }

  const linesByBudget = new Map<string, any[]>();
  for (const l of lines || []) {
    const arr = linesByBudget.get(l.budget_id) || [];
    arr.push(l);
    linesByBudget.set(l.budget_id, arr);
  }

  return (budgets || []).map((budget: any) => {
    const budgetLines = linesByBudget.get(budget.id) || [];
    const committed = budgetLines.reduce((s, l) => s + Number(l.committed_amount ?? 0), 0);
    const actual = budgetLines.reduce((s, l) => s + Math.abs(actualsMap.get(l.account_id) || 0), 0);
    const originalBudget = Number(budget.total_amount ?? 0);
    const revisedBudget = latestRevisionByBudget.get(budget.id) ?? originalBudget;
    const forecast = actual + committed;
    const variance = actual - revisedBudget;
    return {
      category_id: budget.id,
      category_name: budget.category || budget.name,
      original_budget: originalBudget,
      revised_budget: revisedBudget,
      committed,
      actual,
      forecast,
      variance,
      variance_pct: revisedBudget !== 0 ? (variance / revisedBudget) * 100 : 0,
    };
  }) as BudgetVarianceRow[];
};

// ═══════════════════════════════════════════════════════════════════════════
// Ownership & Equity
// ═══════════════════════════════════════════════════════════════════════════

export const getOwnershipEquity = async (organization_id?: string) => {
  const orgId = organization_id || (await getCurrentOrganizationId());

  const { data: owners, error } = await financeDb()
    .from('owners')
    .select('id, name')
    .eq('organization_id', orgId)
    .eq('status', 'ACTIVE');
  if (error) throw new Error(error.message);
  if (!owners?.length) return [] as OwnershipRow[];
  const ownerIds = owners.map((o: any) => o.id);

  const { data: history } = await financeDb()
    .from('ownership_history')
    .select('owner_id, ownership_percentage, effective_to')
    .in('owner_id', ownerIds)
    .is('effective_to', null);
  const pctByOwner = new Map<string, number>();
  for (const h of history || []) pctByOwner.set(h.owner_id, Number(h.ownership_percentage));

  const { data: capTx } = await financeDb()
    .from('capital_transactions')
    .select('owner_id, transaction_type, amount, base_amount')
    .in('owner_id', ownerIds)
    .eq('status', 'POSTED');
  const capitalByOwner = new Map<string, number>();
  const loansByOwner = new Map<string, number>();
  for (const t of capTx || []) {
    const amt = Number(t.base_amount ?? t.amount ?? 0);
    if (t.transaction_type === 'CAPITAL_CONTRIBUTION') capitalByOwner.set(t.owner_id, (capitalByOwner.get(t.owner_id) || 0) + amt);
    if (t.transaction_type === 'OWNER_LOAN_ADVANCE') loansByOwner.set(t.owner_id, (loansByOwner.get(t.owner_id) || 0) + amt);
    if (t.transaction_type === 'OWNER_LOAN_REPAYMENT') loansByOwner.set(t.owner_id, (loansByOwner.get(t.owner_id) || 0) - amt);
  }

  const { data: distLines } = await financeDb()
    .from('distribution_lines')
    .select('owner_id, final_amount, paid_amount, payment_status')
    .in('owner_id', ownerIds);
  const declaredByOwner = new Map<string, number>();
  const paidByOwner = new Map<string, number>();
  const statusByOwner = new Map<string, string>();
  for (const d of distLines || []) {
    declaredByOwner.set(d.owner_id, (declaredByOwner.get(d.owner_id) || 0) + Number(d.final_amount ?? 0));
    paidByOwner.set(d.owner_id, (paidByOwner.get(d.owner_id) || 0) + Number(d.paid_amount ?? 0));
    statusByOwner.set(d.owner_id, d.payment_status);
  }

  const { data: distributions } = await financeDb()
    .from('profit_distributions')
    .select('reserve_amount, status')
    .eq('organization_id', orgId)
    .in('status', ['POSTED', 'PAID']);
  const totalReserve = (distributions || []).reduce((s, d: any) => s + Number(d.reserve_amount ?? 0), 0);

  // No dedicated report_mapping value for "retained earnings" is established anywhere
  // else in this schema, so this identifies the account(s) by name — the same way an
  // accountant would recognize a "Retained Earnings" line in the chart of accounts.
  const { data: retainedAccounts } = await financeDb()
    .from('chart_of_accounts')
    .select('id')
    .eq('organization_id', orgId)
    .eq('account_type', 'EQUITY')
    .ilike('name', '%retained earnings%');
  const retainedIds = (retainedAccounts || []).map((a: any) => a.id);
  let totalRetained = 0;
  if (retainedIds.length) {
    const { data: lines } = await financeDb().from('journal_lines').select('account_id, base_debit, base_credit, journal_entry_id').in('account_id', retainedIds);
    const entryIds = [...new Set((lines || []).map((l: any) => l.journal_entry_id).filter(Boolean))];
    let postedSet = new Set<string>();
    if (entryIds.length) {
      const { data: posted } = await financeDb().from('journal_entries').select('id').in('id', entryIds).eq('status', 'POSTED');
      postedSet = new Set((posted || []).map((e: any) => e.id));
    }
    for (const l of lines || []) {
      if (l.journal_entry_id && !postedSet.has(l.journal_entry_id)) continue;
      totalRetained += Number(l.base_credit ?? 0) - Number(l.base_debit ?? 0);
    }
  }

  return owners.map((o: any) => {
    const pct = (pctByOwner.get(o.id) || 0) / 100;
    const capital = capitalByOwner.get(o.id) || 0;
    const owner_loans = loansByOwner.get(o.id) || 0;
    const configurable_reserve = totalReserve * pct;
    const retained_earnings = totalRetained * pct;
    return {
      shareholder_name: o.name,
      capital,
      owner_loans,
      configurable_reserve,
      retained_earnings,
      total: capital + owner_loans + configurable_reserve + retained_earnings,
      distributions_declared: declaredByOwner.get(o.id) || 0,
      distributions_paid: paidByOwner.get(o.id) || 0,
      payment_status: statusByOwner.get(o.id) || 'pending',
    };
  }) as OwnershipRow[];
};

// ═══════════════════════════════════════════════════════════════════════════
// Platform Settlements
// ═══════════════════════════════════════════════════════════════════════════

export const getPlatformSettlements = async (start?: string, end?: string, organization_id?: string) => {
  const orgId = organization_id || (await getCurrentOrganizationId());

  let query = financeDb()
    .from('settlement_batches')
    .select('id, platform_id, financial_account_id, settlement_date, currency, gross_amount, expected_fee_amount, actual_fee_amount, withholding_amount, withdrawal_fee_amount, net_amount, status')
    .eq('organization_id', orgId);

  if (start) query = query.gte('settlement_date', start);
  if (end) query = query.lte('settlement_date', end);

  const { data, error } = await query.order('settlement_date', { ascending: false });
  if (error) throw new Error(error.message);
  const rows = (data || []) as any[];
  if (!rows.length) return [] as PlatformSettlementRow[];

  const platformIds = [...new Set(rows.map((r) => r.platform_id).filter(Boolean))];
  const accountIds = [...new Set(rows.map((r) => r.financial_account_id).filter(Boolean))];
  const batchIds = rows.map((r) => r.id);

  const [{ data: platforms }, { data: accounts }, { data: lines }] = await Promise.all([
    platformIds.length ? financeDb().from('platforms').select('id, name').in('id', platformIds) : Promise.resolve({ data: [] as any[] }),
    accountIds.length ? financeDb().from('financial_accounts').select('id, account_name').in('id', accountIds) : Promise.resolve({ data: [] as any[] }),
    financeDb().from('settlement_lines').select('settlement_batch_id, client_id, project_id').in('settlement_batch_id', batchIds),
  ]);
  const platformNameById = new Map((platforms || []).map((p: any) => [p.id, p.name]));
  const accountNameById = new Map((accounts || []).map((a: any) => [a.id, a.account_name]));

  const clientIds = [...new Set((lines || []).map((l: any) => l.client_id).filter(Boolean))];
  const projectIds = [...new Set((lines || []).map((l: any) => l.project_id).filter(Boolean))];
  const [{ data: clients }, { data: projects }] = await Promise.all([
    clientIds.length ? supabase.from('clients').select('id, name').in('id', clientIds) : Promise.resolve({ data: [] as any[] }),
    projectIds.length ? supabase.from('projects').select('id, name').in('id', projectIds) : Promise.resolve({ data: [] as any[] }),
  ]);
  const clientNameById = new Map((clients || []).map((c: any) => [c.id, c.name]));
  const projectNameById = new Map((projects || []).map((p: any) => [p.id, p.name]));
  const firstLineByBatch = new Map<string, { client_id?: string; project_id?: string }>();
  for (const l of lines || []) {
    if (!firstLineByBatch.has(l.settlement_batch_id)) firstLineByBatch.set(l.settlement_batch_id, l);
  }

  const statusMap: Record<string, string> = {
    RECONCILED: 'reconciled', POSTED: 'pending', APPROVED: 'pending', VERIFIED: 'pending',
    SUBMITTED: 'pending', DRAFT: 'pending', REJECTED: 'unreconciled', REVERSED: 'unreconciled',
  };

  return rows.map((r) => {
    const gross = Number(r.gross_amount ?? 0);
    const actualFee = Number(r.actual_fee_amount ?? 0);
    const expectedFee = Number(r.expected_fee_amount ?? 0);
    const line = firstLineByBatch.get(r.id);
    return {
      platform_name: platformNameById.get(r.platform_id) || 'Unknown',
      account_name: accountNameById.get(r.financial_account_id) || 'Unknown',
      client_name: (line?.client_id && clientNameById.get(line.client_id)) || 'N/A',
      project_name: (line?.project_id && projectNameById.get(line.project_id)) || undefined,
      currency: r.currency,
      gross_settlement: gross,
      expected_fee: expectedFee,
      actual_fee: actualFee,
      effective_rate: gross !== 0 ? (actualFee / gross) * 100 : 0,
      deductions: actualFee + Number(r.withholding_amount ?? 0) + Number(r.withdrawal_fee_amount ?? 0),
      net_payout: Number(r.net_amount ?? 0),
      reconciliation_status: statusMap[r.status] || 'unreconciled',
      fee_variance: actualFee - expectedFee,
    };
  }) as PlatformSettlementRow[];
};

// ═══════════════════════════════════════════════════════════════════════════
// Fiscal Calendar & Close
// ═══════════════════════════════════════════════════════════════════════════


export const getFiscalCloseStatus = async (fiscalYearId?: string) => {
  if (!fiscalYearId) return [] as FiscalPeriodRow[];

  const { data: periods, error } = await financeDb()
    .from('accounting_periods')
    .select('id, name, status, start_date, end_date, closed_by')
    .eq('fiscal_year_id', fiscalYearId)
    .order('start_date', { ascending: true });
  if (error) throw new Error(error.message);
  if (!periods?.length) return [] as FiscalPeriodRow[];

  const periodIds = periods.map((p: any) => p.id);
  const { data: entries } = await financeDb()
    .from('journal_entries')
    .select('id, period_id, source_type')
    .in('period_id', periodIds)
    .eq('status', 'POSTED');
  const entryIds = (entries || []).map((e: any) => e.id);

  const totalsByPeriod = new Map<string, { journalCount: number; debit: number; credit: number; adjustments: number }>();
  for (const e of entries || []) {
    const t = totalsByPeriod.get(e.period_id) || { journalCount: 0, debit: 0, credit: 0, adjustments: 0 };
    t.journalCount += 1;
    if (e.source_type === 'REVERSAL') t.adjustments += 1;
    totalsByPeriod.set(e.period_id, t);
  }

  if (entryIds.length) {
    const { data: lines } = await financeDb()
      .from('journal_lines')
      .select('journal_entry_id, base_debit, base_credit')
      .in('journal_entry_id', entryIds);
    const periodByEntry = new Map<string, string>((entries || []).map((e: any) => [e.id, e.period_id]));
    for (const l of lines || []) {
      const periodId = periodByEntry.get(l.journal_entry_id);
      if (!periodId) continue;
      const t = totalsByPeriod.get(periodId)!;
      t.debit += Number(l.base_debit ?? 0);
      t.credit += Number(l.base_credit ?? 0);
    }
  }

  const statusMap: Record<string, FiscalPeriodRow['status']> = {
    PENDING: 'future', OPEN: 'open', SOFT_CLOSED: 'adjusting', HARD_CLOSED: 'closed',
  };

  return periods.map((p: any) => {
    const t = totalsByPeriod.get(p.id) || { journalCount: 0, debit: 0, credit: 0, adjustments: 0 };
    return {
      period_name: p.name,
      period_start: p.start_date,
      period_end: p.end_date,
      status: statusMap[p.status] || 'open',
      journal_count: t.journalCount,
      debit_total: t.debit,
      credit_total: t.credit,
      adjustment_count: t.adjustments,
      close_checklist_complete: p.status === 'HARD_CLOSED' && !!p.closed_by,
    };
  }) as FiscalPeriodRow[];
};

// ═══════════════════════════════════════════════════════════════════════════
// Controls & Audit
// ═══════════════════════════════════════════════════════════════════════════

export const getApprovalAging = async (organization_id?: string) => {
  if (!organization_id) throw new Error('Organization context is required for approval aging');
  // BUG-037 FIX: Query expenses, invoices, vendor_bills where status in pending states
  // Combine results from multiple source tables
  const pendingStatuses = ['SUBMITTED', 'VERIFIED', 'APPROVED'];

  const [invoicesRes, expensesRes, vendorBillsRes] = await Promise.all([
    supabase
      .from('invoices')
      .select('id, invoice_number, total_amount, currency, due_date, status, created_at, organization_id')
      .in('status', pendingStatuses)
      .eq('organization_id', organization_id || ''),
    supabase
      .from('expenses')
      .select('id, title, amount, currency, status, expense_date, created_at, organization_id')
      .in('status', pendingStatuses)
      .eq('organization_id', organization_id || ''),
    supabase
      .from('vendor_bills')
      .select('id, bill_number, total_amount, currency, due_date, status, created_at, organization_id')
      .in('status', pendingStatuses)
      .eq('organization_id', organization_id || ''),
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