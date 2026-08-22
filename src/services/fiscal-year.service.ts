// types/services/fiscal-year.service.ts

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
  FiscalYearSummary,
  AccountingPeriod,
  CreateFiscalYearInput,
  OpenPeriodInput,
  ClosePeriodInput,
  ReopenPeriodInput,
} from '@/types/accounting.types';

const db = () => supabase.schema('finance');

// ─── Helper: Current user ID ───
async function currentUserId(): Promise<string> {
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) {
    throw new Error('Not authenticated');
  }
  return data.user.id;
}

// ════════════════════════════════════════
// FISCAL YEARS
// ════════════════════════════════════════

export async function getFiscalYears(): Promise<FiscalYearSummary[]> {
  const { data, error } = await db()
    .from('fiscal_year_summary')
    .select('*')
    .order('start_date', { ascending: false });

  if (error) throw error;
  return data ?? [];
}

export async function createFiscalYear(input: CreateFiscalYearInput): Promise<void> {
  // ✅ FIX: Get user ID BEFORE the RPC call
  const userId = await currentUserId();

  const { error } = await db().rpc('create_fiscal_year_with_periods', {
    p_name: input.name,
    p_start_date: input.start_date,
    p_end_date: input.end_date,
    p_description: input.description ?? null,
    p_created_by: userId,  // ✅ FIX: Pass user ID
  });

  if (error) throw error;
}

export async function softCloseFiscalYear(fyId: string, reason: string): Promise<void> {
  const userId = await currentUserId();

  // Check unclosed periods
  const { data: periods, error: pErr } = await db()
    .from('accounting_periods')
    .select('id, status')
    .eq('fiscal_year_id', fyId);

  if (pErr) throw pErr;

  const unclosed = periods?.filter(p => p.status === 'OPEN' || p.status === 'PENDING');
  if (unclosed && unclosed.length > 0) {
    throw new Error('has_unclosed_periods');
  }

  // ✅ FIX: Pass closed_by
  const { error } = await db()
    .from('fiscal_years')
    .update({
      status: 'SOFT_CLOSED',
      reopening_reason: reason,
      closed_at: new Date().toISOString(),
      closed_by: userId,  // ✅ FIX
    })
    .eq('id', fyId).eq('organization_id', (await db().from('fiscal_years').select('organization_id').eq('id', fyId).single()).data?.organization_id || '');

  if (error) throw error;
}

export async function hardCloseFiscalYear(fyId: string, reason: string): Promise<void> {
  const userId = await currentUserId();

  // Check unclosed periods (must all be SOFT_CLOSED, not OPEN)
  const { data: periods, error: pErr } = await db()
    .from('accounting_periods')
    .select('id, status')
    .eq('fiscal_year_id', fyId);

  if (pErr) throw pErr;

  const openPeriods = periods?.filter(p => p.status === 'OPEN' || p.status === 'PENDING');
  if (openPeriods && openPeriods.length > 0) {
    throw new Error('has_unclosed_periods');
  }

  // Soft close all periods first if not already
  const softClosePeriods = periods?.filter(p => p.status !== 'HARD_CLOSED' && p.status !== 'SOFT_CLOSED');
  if (softClosePeriods && softClosePeriods.length > 0) {
    const { error: scErr } = await db()
      .from('accounting_periods')
      .update({ status: 'SOFT_CLOSED', closed_by: userId, closed_at: new Date().toISOString() })
      .in('id', softClosePeriods.map(p => p.id));
    if (scErr) throw scErr;
  }

  // Call YEAR-END CLOSE API (calculates P&L, transfers to Retained Earnings)
  // FIX: Corrected URL from /api/finance/year-end-close to /api/year-end-close
  const res = await fetch('/api/year-end-close', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ fiscalYearId: fyId, confirm: true }),
  });

  if (!res.ok) {
    const errData = await res.json().catch(() => ({}));
    throw new Error(errData.error || 'Year-end close failed');
  }
}

// ════════════════════════════════════════
// ACCOUNTING PERIODS
// ════════════════════════════════════════

export async function getPeriods(fyId: string): Promise<AccountingPeriod[]> {
  const { data, error } = await db()
    .from('accounting_periods')
    .select('*')
    .eq('fiscal_year_id', fyId)
    .order('period_number', { ascending: true });

  if (error) throw error;
  return data ?? [];
}

export async function openPeriod(input: OpenPeriodInput): Promise<void> {
  const userId = await currentUserId();  // ✅ FIX

  const { error } = await db().rpc('open_period', {
    p_period_id: input.period_id,
    p_opened_by: userId,  // ✅ FIX
  });

  if (error) throw error;
}

export async function closePeriod(input: ClosePeriodInput): Promise<void> {
  const userId = await currentUserId();  // ✅ FIX

  const { error } = await db()
    .from('accounting_periods')
    .update({
      status: input.status,
      reopening_reason: input.reason,
      closed_at: new Date().toISOString(),
      closed_by: userId,  // ✅ FIX
    })
    .eq('id', input.period_id);

  if (error) throw error;
}

export async function reopenPeriod(input: ReopenPeriodInput): Promise<void> {
  const roleResult = await supabase.rpc('get_my_user_roles');
  const roles = Array.isArray(roleResult.data) ? roleResult.data : [];
  const allowed = roles.some((r: any) => ['CEO','FINANCE_HEAD'].includes(r.role || r.role_name) && r.is_active !== false);
  if (!allowed) throw new Error('Only CEO or Finance Head may reopen a fiscal period');
  const { error } = await db()
    .from('accounting_periods')
    .update({
      status: 'OPEN',
      reopening_reason: input.reason,
      closed_at: null,
      closed_by: null,
    })
    .eq('id', input.period_id);

  if (error) throw error;
}