import { supabase } from '@/lib/supabase';
import type {
  FiscalYear,
  FiscalYearSummary,
  AccountingPeriod,
  CurrentPeriod,
  CreateFiscalYearInput,
  ClosePeriodInput,
  ReopenPeriodInput,
} from '@/types/accounting.types';

// ⭐ Tables 'finance' schema mein hain
const SCHEMA = 'finance';

export async function getFiscalYears(): Promise<FiscalYearSummary[]> {
  const { data, error } = await supabase
    .schema(SCHEMA)
    .from('fiscal_year_summary')
    .select('*');

  if (error) throw error;
  return data as FiscalYearSummary[];
}

export async function getFiscalYear(id: string): Promise<FiscalYear> {
  const { data, error } = await supabase
    .schema(SCHEMA)
    .from('fiscal_years')
    .select('*')
    .eq('id', id)
    .single();

  if (error) throw error;
  return data as FiscalYear;
}

export async function getPeriods(fiscalYearId: string): Promise<AccountingPeriod[]> {
  const { data, error } = await supabase
    .schema(SCHEMA)
    .from('accounting_periods')
    .select('*')
    .eq('fiscal_year_id', fiscalYearId)
    .order('period_number');

  if (error) throw error;
  return data as AccountingPeriod[];
}

// ✅ FIX 1: supabase.schema(SCHEMA).rpc() likha
export async function getCurrentPeriod(): Promise<CurrentPeriod | null> {
  const { data, error } = await supabase.schema(SCHEMA).rpc('get_current_period');
  if (error) throw error;
  return data?.[0] ?? null;
}

// ✅ FIX 2: supabase.schema(SCHEMA).rpc() likha
export async function getPeriodByDate(date: string) {
  const { data, error } = await supabase.schema(SCHEMA).rpc('get_period_by_date', { 
    p_date: date 
  });
  if (error) throw error;
  return data?.[0] ?? null;
}

// ✅ FIX 3: supabase.schema(SCHEMA).rpc() likha
export async function isDateInOpenPeriod(date: string): Promise<boolean> {
  const { data, error } = await supabase.schema(SCHEMA).rpc('is_date_in_open_period', { 
    p_date: date 
  });
  if (error) throw error;
  return data ?? false;
}

export async function createFiscalYear(input: CreateFiscalYearInput): Promise<FiscalYear> {
  const { data: fy, error: fyError } = await supabase
    .schema(SCHEMA)
    .from('fiscal_years')
    .insert({
      name: input.name,
      start_date: input.start_date,
      end_date: input.end_date,
      description: input.description || null,
    })
    .select()
    .single();

  if (fyError) throw fyError;

  const periods = [];
  for (let i = 1; i <= 12; i++) {
    const monthStart = new Date(fy.start_date);
    monthStart.setMonth(monthStart.getMonth() + (i - 1));

    const monthEnd = new Date(monthStart);
    monthEnd.setMonth(monthEnd.getMonth() + 1);
    monthEnd.setDate(monthEnd.getDate() - 1);

    const monthName = monthStart.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

    periods.push({
      fiscal_year_id: fy.id,
      period_number: i,
      name: monthName,
      start_date: monthStart.toISOString().split('T')[0],
      end_date: monthEnd.toISOString().split('T')[0],
    });
  }

  const { error: periodsError } = await supabase.schema(SCHEMA).from('accounting_periods').insert(periods);
  if (periodsError) throw periodsError;

  return fy as FiscalYear;
}

export async function closePeriod(input: ClosePeriodInput): Promise<void> {
  const updateData: Record<string, unknown> = {
    status: input.status,
    closed_by: (await supabase.auth.getUser()).data.user?.id,
    closed_at: new Date().toISOString(),
  };

  const { error } = await supabase.schema(SCHEMA).from('accounting_periods').update(updateData).eq('id', input.period_id);
  if (error) throw error;

  // ✅ FIX 4: Audit schema ke liye alag se .schema('audit').rpc() lagaya
  await supabase.schema('audit').rpc('log_manual', {
    p_table_schema: 'finance',
    p_table_name: 'accounting_periods',
    p_record_id: input.period_id,
    p_action: 'PERIOD_CLOSE',
    p_reason: input.reason,
    p_source_module: 'fiscal_calendar',
  });
}

export async function reopenPeriod(input: ReopenPeriodInput): Promise<void> {
  const { error } = await supabase
    .schema(SCHEMA)
    .from('accounting_periods')
    .update({
      status: 'OPEN',
      reopening_reason: input.reason,
      closed_by: null,
      closed_at: null,
    })
    .eq('id', input.period_id);

  if (error) throw error;

  // ✅ FIX 5: Audit schema ke liye bhi .schema('audit').rpc()
  await supabase.schema('audit').rpc('log_manual', {
    p_table_schema: 'finance',
    p_table_name: 'accounting_periods',
    p_record_id: input.period_id,
    p_action: 'PERIOD_REOPEN',
    p_reason: input.reason,
    p_source_module: 'fiscal_calendar',
  });
}

export async function softCloseFiscalYear(fiscalYearId: string, reason: string): Promise<void> {
  const userId = (await supabase.auth.getUser()).data.user?.id;
  const { error } = await supabase.schema(SCHEMA).from('fiscal_years').update({
    status: 'SOFT_CLOSED',
    closed_by: userId,
    closed_at: new Date().toISOString(),
  }).eq('id', fiscalYearId);

  if (error) throw error;

  await supabase.schema(SCHEMA).from('accounting_periods').update({
    status: 'SOFT_CLOSED',
    closed_by: userId,
    closed_at: new Date().toISOString(),
  }).eq('fiscal_year_id', fiscalYearId).eq('status', 'OPEN');
}

export async function hardCloseFiscalYear(fiscalYearId: string, reason: string): Promise<void> {
  const userId = (await supabase.auth.getUser()).data.user?.id;
  const { error } = await supabase.schema(SCHEMA).from('fiscal_years').update({
    status: 'HARD_CLOSED',
    closed_by: userId,
    closed_at: new Date().toISOString(),
  }).eq('id', fiscalYearId);

  if (error) throw error;

  await supabase.schema(SCHEMA).from('accounting_periods').update({
    status: 'HARD_CLOSED',
    closed_by: userId,
    closed_at: new Date().toISOString(),
  }).eq('fiscal_year_id', fiscalYearId).neq('status', 'HARD_CLOSED');
}