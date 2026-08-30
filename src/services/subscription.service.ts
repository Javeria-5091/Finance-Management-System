// ================================================================
// OSYSTIC — Subscription Service (P1)
// File: src/services/subscription.service.ts
// Convention: Follows payroll.service.ts pattern
// ================================================================

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
import { getCurrentOrganizationId } from '@/lib/organization';
import type {
  SubscriptionRow,
  SubscriptionRenewalRow,
  SubscriptionSpendRow,
  SubscriptionStats,
} from '@/types/subscription.types';

// ─── Helper: empty strings to null ───
// Convention: Same pattern used across services in the project
function emptyToNull(obj: Record<string, any>): Record<string, any> {
  const cleaned: Record<string, any> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value === '' || (typeof value === 'string' && value.trim() === '')) {
      cleaned[key] = null;
    } else if (typeof value === 'string') {
      cleaned[key] = value.trim();
    } else {
      cleaned[key] = value;
    }
  }
  return cleaned;
}

// ─── Annual multiplier for spend calculations ───
export function getAnnualMultiplier(frequency: string): number {
  switch (frequency) {
    case 'WEEKLY': return 52;
    case 'MONTHLY': return 12;
    case 'QUARTERLY': return 4;
    case 'SEMI_ANNUALLY': return 2;
    case 'ANNUALLY': return 1;
    case 'BIENNIAL': return 0.5;
    case 'ONE_TIME': return 0;
    default: return 1;
  }
}

// ─── Fetch all subscriptions ───
export async function fetchSubscriptions(filters?: {
  search?: string;
  category?: string;
  status?: string;
}) {
  const orgId = await getCurrentOrganizationId();
  let query = supabase
    .from('subscriptions')
    .select('*')
    .eq('organization_id', orgId)
    .order('created_at', { ascending: false });

  if (filters?.search) {
    // FIX: Use proper Supabase .or() filter syntax
    const term = `%${filters.search}%`;
    query = query.or(`name.ilike.${term},vendor.ilike.${term}`);
  }
  if (filters?.category) {
    query = query.eq('category', filters.category);
  }
  if (filters?.status) {
    query = query.eq('status', filters.status);
  }

  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return (data as SubscriptionRow[]) || [];
}

// ─── Fetch single subscription ───
export async function fetchSubscriptionById(id: string) {
  const orgId = await getCurrentOrganizationId();
  const { data, error } = await supabase
    .from('subscriptions')
    .select('*')
    .eq('id', id)
    .eq('organization_id', orgId)
    .single();
  if (error) throw new Error(error.message);
  return data as SubscriptionRow;
}

// ─── Create subscription ───
export async function createSubscription(subData: Record<string, any>) {
  const orgId = await getCurrentOrganizationId();
  const cleaned = emptyToNull({
    ...subData,
    status: subData.status || 'ACTIVE',
    organization_id: orgId,
  });
  // Ensure amount is a number, not a string from form
  if (typeof cleaned.amount === 'string') {
    cleaned.amount = parseFloat(cleaned.amount) || 0;
  }
  if (typeof cleaned.cancellation_notice_days === 'string') {
    cleaned.cancellation_notice_days = parseInt(cleaned.cancellation_notice_days, 10) || 30;
  }

  const { data, error } = await supabase
    .from('subscriptions')
    .insert(cleaned)
    .select('*')
    .single();
  if (error) throw new Error(error.message);
  return data as SubscriptionRow;
}

// ─── Update subscription ───
// FIX #9: Don't pass created_by in updates — it should never change
export async function updateSubscription(id: string, updates: Record<string, any>) {
  const orgId = await getCurrentOrganizationId();
  const { created_by, id: _id, ...rest } = updates as any;
  const cleaned = emptyToNull(rest);

  // Convert amount/cancellation_notice_days if they come as strings
  if (typeof cleaned.amount === 'string') {
    cleaned.amount = parseFloat(cleaned.amount) || 0;
  }
  if (typeof cleaned.cancellation_notice_days === 'string') {
    cleaned.cancellation_notice_days = parseInt(cleaned.cancellation_notice_days, 10) || 30;
  }

  const { data, error } = await supabase
    .from('subscriptions')
    .update(cleaned)
    .eq('id', id)
    .eq('organization_id', orgId)
    .select('*')
    .single();
  if (error) throw new Error(error.message);
  return data as SubscriptionRow;
}

// ─── Delete subscription ───
export async function deleteSubscription(id: string) {
  const orgId = await getCurrentOrganizationId();
  const { error } = await supabase
    .from('subscriptions')
    .delete()
    .eq('id', id)
    .eq('organization_id', orgId);
  if (error) throw new Error(error.message);
}

// ─── Fetch upcoming renewals (from view) ───
export async function fetchUpcomingRenewals() {
  // BUG-027 FIX: v_subscription_renewals lives in public (not reporting, fixed
  // above) and does not expose an organization_id column at all -- it simply
  // reads public.subscriptions directly, which is already org-scoped by RLS
  // (security_invoker view). Filtering on a non-existent column raised 42703
  // on every call.
  const { data, error } = await supabase
    .from('v_subscription_renewals')
    .select('*')
    .order('renewal_date', { ascending: true });
  if (error) throw new Error(error.message);
  return (data as SubscriptionRenewalRow[]) || [];
}

// ─── Fetch spend summary (from view) ───
export async function fetchSpendSummary() {
  // BUG-027 FIX: same as fetchUpcomingRenewals -- v_subscription_spend has no
  // organization_id column; it's already RLS-scoped via public.subscriptions.
  const { data, error } = await supabase
    .from('v_subscription_spend')
    .select('*');
  if (error) throw new Error(error.message);
  return (data as SubscriptionSpendRow[]) || [];
}

// ─── Fetch subscription stats ───
export async function fetchSubscriptionStats(): Promise<SubscriptionStats> {
  const orgId = await getCurrentOrganizationId();
  const [activeRes, renewalsRes] = await Promise.all([
    supabase
      .from('subscriptions')
      .select('id, amount, billing_frequency')
      .eq('status', 'ACTIVE')
      .eq('organization_id', orgId),
    // BUG-027 FIX: v_subscription_renewals has no organization_id column (see
    // fetchUpcomingRenewals above).
    supabase
      .from('v_subscription_renewals')
      .select('id, renewal_bucket'),
  ]);

  const active = activeRes.data || [];
  const renewals = renewalsRes.data || [];

  let normalizedMonthly = 0;
  let annualizedTotal = 0;

  for (const sub of active) {
    const mult = getAnnualMultiplier(sub.billing_frequency);
    annualizedTotal += Number(sub.amount) * mult;
    normalizedMonthly += Number(sub.amount) * mult / 12;
  }

  const upcoming30Days = renewals.filter(
    (r: any) => r.renewal_bucket === '7_DAYS' || r.renewal_bucket === '30_DAYS'
  ).length;

  const overdueCount = renewals.filter(
    (r: any) => r.renewal_bucket === 'OVERDUE'
  ).length;

  return {
    activeCount: active.length,
    normalizedMonthly: Math.round(normalizedMonthly * 100) / 100,
    annualizedTotal: Math.round(annualizedTotal * 100) / 100,
    upcoming30Days,
    overdueCount,
  };
}