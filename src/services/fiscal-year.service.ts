// types/services/fiscal-year.service.ts

import { supabase } from '@/lib/supabase';
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

// ══════════════════════════════════════════
// FISCAL YEARS
// ══════════════════════════════════════════

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
    .eq('id', fyId);

  if (error) throw error;
}

export async function hardCloseFiscalYear(fyId: string, reason: string): Promise<void> {
  const userId = await currentUserId();

  const { data: periods, error: pErr } = await db()
    .from('accounting_periods')
    .select('id, status')
    .eq('fiscal_year_id', fyId);

  if (pErr) throw pErr;

  const notHardClosed = periods?.filter(p => p.status !== 'HARD_CLOSED');
  if (notHardClosed && notHardClosed.length > 0) {
    throw new Error('has_unclosed_periods');
  }

  const { error } = await db()
    .from('fiscal_years')
    .update({
      status: 'HARD_CLOSED',
      reopening_reason: reason,
      closed_at: new Date().toISOString(),
      closed_by: userId,  // ✅ FIX
    })
    .eq('id', fyId);

  if (error) throw error;
}

// ══════════════════════════════════════════
// ACCOUNTING PERIODS
// ══════════════════════════════════════════

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