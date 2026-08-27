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
//  Finance schema reference
const db = supabase.schema('finance');
const rpt = supabase.schema('reporting');

// ==================== TYPES ====================

export interface FinancialAccount {
  id: string;
  account_name: string;
  institution_name: string;
  institution_type: 'BANK' | 'CASH' | 'WALLET' | 'PLATFORM' | 'PAYMENT_GATEWAY' | 'CARD' | 'CLEARING';
  account_type: 'CURRENT' | 'SAVINGS' | 'DIGITAL_WALLET' | 'PLATFORM_BALANCE' | 'PETTY_CASH' | 'CLEARING';
  currency: string;
  masked_identifier: string | null;
  opening_balance: number;
  opening_date: string | null;
  linked_ledger_account_id: string;
  reconciliation_method: 'MANUAL' | 'AUTO' | 'IMPORT';
  responsible_user_id: string | null;
  is_active: boolean;
  is_default: boolean;
  requires_dual_approval: boolean;
  min_dual_approval_amount: number | null;
  notes: string | null;
  created_at: string;
  updated_at: string | null;
  created_by: string | null;
}

export interface BankStatement {
  id: string;
  financial_account_id: string;
  statement_date: string;
  opening_balance: number;
  closing_balance: number;
  currency: string;
  total_debits: number;
  total_credits: number;
  line_count: number;
  imported_at: string;
  imported_by: string;
  file_name: string | null;
  reconciliation_status: 'PENDING' | 'IN_PROGRESS' | 'COMPLETED' | 'PARTIAL';
  reconciled_at: string | null;
  reconciled_by: string | null;
  created_at: string;
  updated_at: string | null;
  // Joined
  financial_accounts?: FinancialAccount;
}

export interface StatementLine {
  id: string;
  bank_statement_id: string;
  line_number: number | null;
  transaction_date: string;
  description: string | null;
  reference: string | null;
  counterparty: string | null;
  transaction_identifier: string | null;
  amount: number;
  balance_after: number | null;
  reconciliation_status: 'UNRECONCILED' | 'MATCHED' | 'EXCLUDED' | 'DUPLICATE' | 'MANUAL_MATCH';
  matched_journal_line_id: string | null;
  matched_at: string | null;
  matched_by: string | null;
  match_method: string | null;
  exclusion_reason: string | null;
  created_at: string;
  updated_at: string | null;
}

export interface BankTransfer {
  id: string;
  transfer_number: string | null;
  description: string | null;
  from_account_id: string;
  from_currency: string;
  from_amount: number;
  to_account_id: string;
  to_currency: string;
  to_amount: number;
  exchange_rate: number;
  fx_rate_date: string | null;
  transfer_date: string;
  status: 'DRAFT' | 'SUBMITTED' | 'APPROVED' | 'POSTED' | 'REVERSED' | 'REJECTED' | 'CANCELLED';
  requires_dual_approval: boolean;
  approved_by: string | null;
  approved_at: string | null;
  second_approved_by: string | null;
  second_approved_at: string | null;
  rejected_by: string | null;
  rejected_at: string | null;
  rejection_reason: string | null;
  journal_entry_id: string | null;
  period_id: string | null;
  posted_by: string | null;
  posted_at: string | null;
  reversal_reason: string | null;
  reversed_at: string | null;
  created_at: string;
  updated_at: string | null;
  created_by: string | null;
  // Joined
  from_account?: { account_name: string; currency: string; masked_identifier: string | null };
  to_account?: { account_name: string; currency: string; masked_identifier: string | null };
}

export interface ReconciliationSummary {
  financial_account_id: string;
  account_name: string;
  institution_name: string;
  currency: string;
  masked_identifier: string | null;
  ledger_balance: number;
  statement_balance: number;
  difference: number;
  total_lines: number;
  matched_lines: number;
  unreconciled_lines: number;
  reconciliation_pct: number;
  latest_statement_date: string | null;
}

// ==================== FINANCIAL ACCOUNTS ====================

export const getFinancialAccounts = async (orgId: string) => {
  const { data, error } = await db
    .from('financial_accounts')
    .select('*')
    .eq('organization_id', orgId)
    .eq('is_active', true)
    .order('institution_type', { ascending: true })
    .order('account_name', { ascending: true });
  return { data: data as FinancialAccount[], error };
};

export const getReconciliationSummary = async (orgId: string) => {
  const { data, error } = await rpt
    .from('reconciliation_summary')
    .select('*')
    .eq('organization_id', orgId)
    .order('account_name', { ascending: true });
  return { data: data as ReconciliationSummary[], error };
};

export const getAssetAccounts = async (orgId: string) => {
  const { data, error } = await db
    .from('chart_of_accounts')
    .select('id, code, name, account_type')
    .eq('organization_id', orgId)
    .eq('posting_allowed', true)
    .eq('is_active', true)
    .like('code', '1%')
    .order('code', { ascending: true });
  return { data, error };
};

export const createFinancialAccount = async (payload: Partial<FinancialAccount> & { created_by: string }) => {
  const { data, error } = await db
    .from('financial_accounts')
    .insert(payload)
    .select()
    .single();
  return { data: data as FinancialAccount, error };
};

export const updateFinancialAccount = async (id: string, payload: Partial<FinancialAccount>) => {
  const { data, error } = await db
    .from('financial_accounts')
    .update({ ...payload, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select()
    .single();
  return { data: data as FinancialAccount, error };
};

export const deactivateFinancialAccount = async (id: string, orgId: string, reason: string) => {
  const reasonText = reason.trim();
  if (!reasonText) {
    throw new Error('A deactivation reason is required.');
  }

  const { data: existing, error: fetchError } = await db
    .from('financial_accounts')
    .select('notes')
    .eq('id', id)
    .eq('organization_id', orgId)
    .eq('is_active', true)
    .single();

  if (fetchError) {
    throw new Error(fetchError.message || 'Financial account was not found or is already inactive.');
  }

  const previousNotes = typeof existing?.notes === 'string' ? existing.notes.trim() : '';
  const notes = previousNotes
    ? `${previousNotes}\nDeactivated: ${reasonText}`
    : `Deactivated: ${reasonText}`;

  const { data, error } = await db
    .from('financial_accounts')
    .update({
      is_active: false,
      notes,
      updated_at: new Date().toISOString(),
    })
    .eq('id', id)
    .eq('organization_id', orgId)
    .eq('is_active', true)
    .select()
    .single();

  if (error || !data) {
    throw new Error(error?.message || 'Unable to deactivate financial account.');
  }

  return { data: data as FinancialAccount, error: null };
};

// ==================== BANK STATEMENTS ====================

export const getBankStatements = async (orgId: string, accountId: string) => {
  const { data, error } = await db
    .from('bank_statements')
    .select('*, financial_accounts(account_name, currency, masked_identifier)')
    .eq('organization_id', orgId)
    .eq('financial_account_id', accountId)
    .order('statement_date', { ascending: false });
  return { data: data as BankStatement[], error };
};

export const createBankStatement = async (payload: {
  financial_account_id: string;
  statement_date: string;
  opening_balance: number;
  closing_balance: number;
  currency: string;
  imported_by: string;
  file_name?: string;
}) => {
  const { data, error } = await db
    .from('bank_statements')
    .insert(payload)
    .select()
    .single();
  return { data: data as BankStatement, error };
};

export const importStatementLines = async (lines: Omit<StatementLine, 'id' | 'created_at' | 'updated_at'>[]) => {
  const { data, error } = await db
    .from('statement_lines')
    .insert(lines)
    .select();
  return { data, error };
};

// ==================== STATEMENT LINES ====================

export const getStatementLines = async (orgId: string, statementId: string) => {
  const { data, error } = await db
    .from('statement_lines')
    .select('*')
    .eq('organization_id', orgId)
    .eq('bank_statement_id', statementId)
    .order('line_number', { ascending: true });
  return { data: data as StatementLine[], error };
};

export const getUnreconciledLines = async (orgId: string) => {
  const { data, error } = await rpt
    .from('unreconciled_lines')
    .select('*')
    .eq('organization_id', orgId)
    .limit(100);
  return { data, error };
};

// ==================== RECONCILIATION RPCs ====================

export const runAutoMatch = async (statementId: string) => {
  const { data, error } = await db.schema('finance').rpc('auto_match_statement_lines', {
    p_statement_id: statementId
  });
  return { data, error };
};

export const detectDuplicates = async (statementId: string) => {
  const { data, error } = await db.schema('finance').rpc('detect_duplicate_statement_lines', {
    p_statement_id: statementId
  });
  return { data, error };
};

export const manualMatchLine = async (lineId: string, journalLineId: string, reason?: string) => {
  const { data, error } = await db.schema('finance').rpc('manual_match_statement_line', {
    p_line_id: lineId,
    p_journal_line_id: journalLineId,
    p_reason: reason || null
  });
  return { data, error };
};

export const unmatchLine = async (lineId: string) => {
  const { data, error } = await db.schema('finance').rpc('unmatch_statement_line', {
    p_line_id: lineId
  });
  return { data, error };
};

export const excludeLine = async (lineId: string, reason: string) => {
  const { data, error } = await db.schema('finance').rpc('exclude_statement_line', {
    p_line_id: lineId,
    p_reason: reason
  });
  return { data, error };
};

// ==================== BANK TRANSFERS ====================

export const getBankTransfers = async (orgId: string) => {
  const { data: transfers, error } = await db
    .from('bank_transfers')
    .select('*')
    .eq('organization_id', orgId)
    .order('transfer_date', { ascending: false });

  if (error || !transfers) return { data: [], error };

  // Fetch account names separately to avoid FK join issues
  const { data: accounts } = await db
    .from('financial_accounts')
    .select('id, account_name, currency, masked_identifier')
    .eq('organization_id', orgId);

  const accMap = new Map((accounts || []).map((a: any) => [a.id, a]));

  const enriched = (transfers as BankTransfer[]).map(t => ({
    ...t,
    from_account: accMap.get(t.from_account_id),
    to_account: accMap.get(t.to_account_id),
  }));

  return { data: enriched, error: null };
};

export const createBankTransfer = async (payload: Partial<BankTransfer> & { created_by: string }) => {
  // Don't send transfer_number - trigger will auto-generate
  const { transfer_number, ...rest } = payload as any;
  const { data, error } = await db
    .from('bank_transfers')
    .insert(rest)
    .select()
    .single();
  return { data: data as BankTransfer, error };
};

export const updateTransferStatus = async (
  id: string,
  updates: Partial<BankTransfer>
) => {
  const { data, error } = await db.rpc('update_bank_transfer_status', {
    p_transfer_id: id,
    p_status: updates.status,
    p_rejection_reason: updates.rejection_reason || null,
  });
  return { data: data as BankTransfer, error };
};

export const postBankTransfer = async (
  transferId: string,
  periodId: string,
  date: string
) => {
  const { data, error } = await db.schema('finance').rpc('post_bank_transfer', {
    p_transfer_id: transferId,
    p_period_id: periodId,
    p_transaction_date: date
  });
  return { data, error };
};

// ==================== OPEN PERIOD ====================

export const getOpenPeriod = async (orgId: string) => {
  const { data, error } = await db
    .from('accounting_periods')
    .select('id, period_name, start_date, end_date')
    .eq('organization_id', orgId)
    .eq('status', 'OPEN')
    .order('start_date', { ascending: false })
    .limit(1)
    .single();
  return { data, error };
};
