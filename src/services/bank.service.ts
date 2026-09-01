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
  supporting_evidence_reference: string | null;
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
  financial_account_id?: string;
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
  if (!reasonText) throw new Error('A deactivation reason is required.');
  const { data, error } = await db.schema('finance').rpc('request_financial_account_change', {
    p_account_id: id, p_changes: { is_active: false, notes: `[DEACTIVATED] ${reasonText}` }, p_reason: reasonText
  });
  return { data, error };
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

// FND-BANK-03 FIX: createBankStatement()/importStatementLines() used to
// insert directly into finance.bank_statements / finance.statement_lines
// from the browser client, in two separate, non-transactional calls:
//   1) createBankStatement() never included organization_id, which
//      bank_statements_org_required_going_forward (CHECK organization_id
//      IS NOT NULL) rejects unconditionally -- every import failed here.
//   2) importStatementLines() then inserted lines in client-side batches
//      with no transactional link to the header row and no duplicate
//      defense, so a failure partway left an orphan statement, and a
//      repeat import silently duplicated everything.
// Both calls are replaced by one atomic RPC -- see finance.import_
// bank_statement() (P2_009 migration) -- that resolves organization_id
// server-side and writes the header + every line in a single DB
// transaction, skipping exact-duplicate lines via ON CONFLICT DO NOTHING.
export interface ImportBankStatementPayload {
  financial_account_id: string;
  statement_date: string;
  opening_balance: number;
  closing_balance: number;
  currency: string;
  file_name?: string | null;
  lines: Array<{
    transaction_date: string;
    description?: string | null;
    reference?: string | null;
    counterparty?: string | null;
    transaction_identifier?: string | null;
    amount: number;
    balance_after?: number | null;
  }>;
}

export interface ImportBankStatementResult {
  statement_id: string;
  lines_submitted: number;
  lines_inserted: number;
  duplicates_skipped: number;
}

export const importBankStatement = async (payload: ImportBankStatementPayload) => {
  const { data, error } = await db.rpc('import_bank_statement', {
    p_financial_account_id: payload.financial_account_id,
    p_statement_date: payload.statement_date,
    p_opening_balance: payload.opening_balance,
    p_closing_balance: payload.closing_balance,
    p_currency: payload.currency,
    p_file_name: payload.file_name ?? null,
    p_lines: payload.lines,
  });
  return { data: data as ImportBankStatementResult | null, error };
};

// ==================== STATEMENT LINES ====================

export const getStatementLines = async (orgId: string, statementId: string) => {
  const { data, error } = await db
    .from('statement_lines')
    .select('*')
    .eq('bank_statement_id', statementId)
    .eq('financial_account_id', (await db.from('bank_statements').select('financial_account_id').eq('id', statementId).eq('organization_id', orgId).single()).data?.financial_account_id || '00000000-0000-0000-0000-000000000000')
    .order('line_number', { ascending: true });
  return { data: data as StatementLine[], error };
};

export const getUnreconciledLines = async (orgId: string) => {
  const { data, error } = await rpt
    .from('unreconciled_lines')
    .select('*')
    
    .limit(100);
  return { data, error };
};

// ==================== RECONCILIATION RPCs ====================

export const runAutoMatch = async (statementId: string) => {
  const { data, error } = await db.schema('finance').rpc('suggest_bank_statement_matches', {
    p_statement_id: statementId
  });
  if (error) throw new Error(error.message);
  return Array.isArray(data) ? data : [];
};

export const confirmSuggestedMatch = async (lineId: string, journalLineId: string, reason?: string) => {
  const { data, error } = await db.schema('finance').rpc('manual_match_statement_line', {
    p_line_id: lineId, p_journal_line_id: journalLineId, p_reason: reason || 'User confirmed automatic match suggestion'
  });
  return { data, error };
};

export const finalizeReconciliation = async (statementId: string, userId: string, orgId: string) => {
  const { data, error } = await db.schema('finance').rpc('finalize_bank_reconciliation', {
    p_statement_id: statementId, p_user_id: userId, p_organization_id: orgId
  });
  return { data, error };
};

export const requestFinancialAccountChange = async (accountId: string, changes: Record<string, unknown>, reason: string) => {
  const { data, error } = await db.schema('finance').rpc('request_financial_account_change', {
    p_account_id: accountId, p_changes: changes, p_reason: reason
  });
  return { data, error };
};

export const getFinancialAccountChangeRequests = async (orgId: string) => {
  const { data, error } = await db.from('financial_account_change_requests')
    .select('*, financial_accounts(account_name)')
    .eq('organization_id', orgId).eq('status', 'PENDING').order('requested_at', { ascending: false });
  return { data, error };
};

export const approveFinancialAccountChange = async (requestId: string, reason?: string) => {
  const { data, error } = await db.schema('finance').rpc('approve_financial_account_change', {
    p_request_id: requestId, p_reason: reason || null
  });
  return { data, error };
};

export const reverseBankTransfer = async (transferId: string, reversalDate: string, reason: string) => {
  const { data, error } = await db.schema('finance').rpc('reverse_bank_transfer', {
    p_transfer_id: transferId, p_reversal_date: reversalDate, p_reason: reason
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
    .eq('organization_id', orgId)
    ;

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
  let orgId = (payload as any).organization_id as string | undefined;
  if (!orgId) {
    const { data: { user } } = await browserSupabase.auth.getUser();
    if (!user) return { data: null as any, error: new Error('Authentication required') };
    const { data: profile, error: profileError } = await browserSupabase
      .from('profiles').select('organization_id').eq('user_id', user.id).maybeSingle();
    if (profileError || !profile?.organization_id) return { data: null as any, error: new Error('Organization context is required') };
    orgId = profile.organization_id;
  }
  rest.organization_id = orgId;

  // FND-PBV-006 FIX: nothing in the create flow (this service, TransferForm,
  // or the banking dashboard page) ever set requires_dual_approval, so it
  // was always the column default (false) regardless of the source
  // account's own policy. finance.update_bank_transfer_status()'s entire
  // second-approval branch is gated on this flag (see schema.sql) — with it
  // always false, a transfer out of an account flagged
  // requires_dual_approval, or over its min_dual_approval_amount, only ever
  // got a single approval, silently skipping the second sign-off spec §5.7
  // requires for large/sensitive transfers.
  if (rest.from_account_id && rest.from_amount != null) {
    const { data: fromAccount } = await db
      .from('financial_accounts')
      .select('requires_dual_approval, min_dual_approval_amount')
      .eq('id', rest.from_account_id)
      .eq('organization_id', orgId)
      .eq('is_active', true)
      .maybeSingle();

    if (fromAccount) {
      const overThreshold =
        fromAccount.min_dual_approval_amount != null &&
        Number(rest.from_amount) >= Number(fromAccount.min_dual_approval_amount);

      rest.requires_dual_approval = Boolean(fromAccount.requires_dual_approval) || overThreshold;
    }
  }

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
    .schema('finance').from('accounting_periods')
    .select('id, name, start_date, end_date')
    
    .eq('status', 'OPEN')
    .order('start_date', { ascending: false })
    .limit(1)
    .single();
  return { data, error };
};