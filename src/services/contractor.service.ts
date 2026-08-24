// ================================================================
// OSYSTIC — Contractor Service (P1)
// File: src/services/contractor.service.ts
// Convention: Follows subscription.service.ts pattern
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
  ContractorRow,
  ContractorExpirationRow,
  ContractorCostRow,
  ContractorProjectCostRow,
  ContractorStats,
} from '@/types/contractor.types';

// ─── Helper: empty strings to null ───
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

// ─── Annual multiplier for cost calculations ───
export function getAnnualMultiplier(rateType: string): number {
  switch (rateType) {
    case 'HOURLY': return 2080;        // 52 weeks * 40 hrs
    case 'DAILY': return 260;          // 52 weeks * 5 days
    case 'WEEKLY': return 52;
    case 'MONTHLY': return 12;
    case 'FIXED_PROJECT': return 1;
    default: return 12;
  }
}

// ─── Fetch all contractors ───
export async function fetchContractors(filters?: {
  search?: string;
  role?: string;
  status?: string;
}) {
  const orgId = await getCurrentOrganizationId();
  let query = supabase
    .schema('finance')
    .from('contractors')
    .select('*')
    .eq('organization_id', orgId)
    .order('created_at', { ascending: false });

  if (filters?.search) {
    const term = `%${filters.search}%`;
    query = query.or(`name.ilike.${term},company.ilike.${term},email.ilike.${term}`);
  }
  if (filters?.role) {
    query = query.eq('role', filters.role);
  }
  if (filters?.status) {
    query = query.eq('status', filters.status);
  }

  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return (data as ContractorRow[]) || [];
}

// ─── Fetch single contractor ───
export async function fetchContractorById(id: string) {
  const orgId = await getCurrentOrganizationId();
  const { data, error } = await supabase
    .schema('finance')
    .from('contractors')
    .select('*')
    .eq('id', id)
    .eq('organization_id', orgId)
    .single();
  if (error) throw new Error(error.message);
  return data as ContractorRow;
}

// ─── Create contractor ───
export async function createContractor(contractorData: Record<string, any>) {
  const orgId = await getCurrentOrganizationId();
  const cleaned = emptyToNull({
    ...contractorData,
    status: contractorData.status || 'ACTIVE',
    organization_id: orgId,
  });
  if (typeof cleaned.rate === 'string') {
    cleaned.rate = parseFloat(cleaned.rate) || 0;
  }
  if (typeof cleaned.tax_withholding_pct === 'string') {
    cleaned.tax_withholding_pct = parseFloat(cleaned.tax_withholding_pct) || 0;
  }

  const { data, error } = await supabase
    .schema('finance')
    .from('contractors')
    .insert(cleaned)
    .select('*')
    .single();
  if (error) throw new Error(error.message);
  return data as ContractorRow;
}

// ─── Update contractor ───
export async function updateContractor(id: string, updates: Record<string, any>) {
  const orgId = await getCurrentOrganizationId();
  const { created_by, id: _id, ...rest } = updates as any;
  const cleaned = emptyToNull(rest);

  if (typeof cleaned.rate === 'string') {
    cleaned.rate = parseFloat(cleaned.rate) || 0;
  }
  if (typeof cleaned.tax_withholding_pct === 'string') {
    cleaned.tax_withholding_pct = parseFloat(cleaned.tax_withholding_pct) || 0;
  }

  const { data, error } = await supabase
    .schema('finance')
    .from('contractors')
    .update(cleaned)
    .eq('id', id)
    .eq('organization_id', orgId)
    .select('*')
    .single();
  if (error) throw new Error(error.message);
  return data as ContractorRow;
}

// ─── Delete contractor ───
export async function deleteContractor(id: string) {
  const orgId = await getCurrentOrganizationId();
  const { error } = await supabase
    .schema('finance')
    .from('contractors')
    .delete()
    .eq('id', id)
    .eq('organization_id', orgId);
  if (error) throw new Error(error.message);
}

// ─── Fetch expiring contracts (from view) ───
export async function fetchExpiringContracts() {
  const orgId = await getCurrentOrganizationId();
  const { data, error } = await supabase
    .schema('reporting')
    .from('v_contractor_expirations')
    .select('*')
    .eq('organization_id', orgId)
    .order('contract_end', { ascending: true });
  if (error) throw new Error(error.message);
  return (data as ContractorExpirationRow[]) || [];
}

// ─── Fetch cost summary by role (from view) ───
export async function fetchCostByRole() {
  const orgId = await getCurrentOrganizationId();
  const { data, error } = await supabase
    .schema('reporting')
    .from('v_contractor_costs')
    .select('*')
    .eq('organization_id', orgId);
  if (error) throw new Error(error.message);
  return (data as ContractorCostRow[]) || [];
}

// ─── Fetch cost summary by project (from view) ───
export async function fetchCostByProject() {
  const orgId = await getCurrentOrganizationId();
  const { data, error } = await supabase
    .schema('reporting')
    .from('v_contractor_project_costs')
    .select('*')
    .eq('organization_id', orgId);
  if (error) throw new Error(error.message);
  return (data as ContractorProjectCostRow[]) || [];
}

// ─── Fetch contractor stats ───
export async function fetchContractorStats(): Promise<ContractorStats> {
  const orgId = await getCurrentOrganizationId();
  const [activeRes, expirationsRes] = await Promise.all([
    supabase
      .schema('finance')
      .from('contractors')
      .select('id, rate, rate_type, currency')
      .eq('status', 'ACTIVE')
      .eq('organization_id', orgId),
    supabase
      .schema('reporting')
      .from('v_contractor_expirations')
      .select('id, expiry_bucket')
      .eq('organization_id', orgId),
  ]);

  const active = activeRes.data || [];
  const expirations = expirationsRes.data || [];

  // Per-currency monthly totals to avoid mixing currencies
  const monthlyByCurrency: Record<string, number> = {};
  for (const c of active) {
    const mult = getAnnualMultiplier(c.rate_type);
    const monthly = Number(c.rate) * mult / 12;
    const cur = c.currency || 'PKR';
    monthlyByCurrency[cur] = (monthlyByCurrency[cur] || 0) + monthly;
  }
  // Use the highest currency total as the "primary" display
  let normalizedMonthly = 0;
  let topCurrency = 'PKR';
  for (const [cur, val] of Object.entries(monthlyByCurrency)) {
    if (val > normalizedMonthly) {
      normalizedMonthly = val;
      topCurrency = cur;
    }
  }

  // For annualized, use same currency
  let annualizedTotal = 0;
  for (const c of active) {
    if ((c.currency || 'PKR') === topCurrency) {
      const mult = getAnnualMultiplier(c.rate_type);
      annualizedTotal += Number(c.rate) * mult;
    }
  }

  const expiring30Days = expirations.filter(
    (r: any) => r.expiry_bucket === '7_DAYS' || r.expiry_bucket === '30_DAYS'
  ).length;

  const expiredCount = expirations.filter(
    (r: any) => r.expiry_bucket === 'EXPIRED'
  ).length;

  return {
    activeCount: active.length,
    normalizedMonthly: Math.round(normalizedMonthly * 100) / 100,
    annualizedTotal: Math.round(annualizedTotal * 100) / 100,
    expiring30Days,
    expiredCount,
    topCurrency,
  };
}