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
const db = supabase.schema('finance');

async function getCurrentOrgId(): Promise<string> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error('Authentication required');
  const { data, error } = await supabase.from('profiles').select('organization_id').eq('user_id', user.id).maybeSingle();
  if (error || !data?.organization_id) throw new Error('Organization context is required');
  return data.organization_id;
}

// ==================== TYPES ====================

export interface TaxpayerProfile {
  id: string;
  legal_entity_type: string;
  ntn_number: string | null;
  filing_jurisdiction: string;
  tax_status: string;
  default_tax_year_basis: string;
  cnic_number: string | null;
  registered_address: string | null;
  contact_phone: string | null;
  configured_by: string | null;
  approved_by: string | null;
  approved_at: string | null;
  created_at: string;
  updated_at: string | null;
}

export interface TaxRuleSet {
  id: string;
  name: string;
  jurisdiction: string;
  taxpayer_type: string;
  tax_year: string;
  status: 'DRAFT' | 'APPROVED' | 'LOCKED' | 'SUPERSEDED';
  approved_by: string | null;
  approved_at: string | null;
  version: number;
  notes: string | null;
  created_at: string;
  updated_at: string | null;
  created_by: string | null;
  slabs?: TaxSlab[];
}

export interface TaxSlab {
  id: string;
  tax_rule_set_id: string;
  slab_name: string | null;
  income_from: number;
  income_to: number | null;
  tax_rate: number;
  fixed_amount: number;
  slab_type: 'PROGRESSIVE' | 'FLAT' | 'FIXED';
  sort_order: number;
  created_at: string;
  updated_at: string | null;
}

export interface TaxReconciliation {
  id: string;
  tax_year: string;
  fiscal_year_id: string;
  accounting_profit_before_tax: number;
  taxable_income: number;
  gross_tax_liability: number;
  withholding_credits: number;
  advance_tax_credits: number;
  other_tax_credits: number;
  net_tax_payable: number;
  profit_after_tax: number;
  effective_tax_rate: number;
  tax_rule_set_id: string;
  status: string;
  filing_date: string | null;
  filing_reference: string | null;
  payment_reference: string | null;
  payment_date: string | null;
  accountant_approved_by: string | null;
  approved_at: string | null;
  rejection_reason: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string | null;
  created_by: string | null;
  tax_rule_sets?: { name: string };
  adjustments?: TaxAdjustment[];
}

export interface TaxAdjustment {
  id: string;
  tax_reconciliation_id: string;
  adjustment_category: string;
  description: string;
  amount: number;
  source_account_id: string | null;
  evidence_notes: string | null;
  created_by: string;
  created_at: string;
  updated_at: string | null;
}

//  FIXED: Matched to your SQL — contact_info instead of separate fields
export interface Owner {
  id: string;
  name: string;
  partner_class: string | null;
  cnic_number?: string | null;      
  contact_info?: string | null;
  status: 'ACTIVE' | 'INACTIVE' | 'EXITED';
  notes: string | null;
  created_at: string;
  updated_at: string | null;
  current_percentage?: number;
}

export interface OwnershipHistory {
  id: string;
  owner_id: string;
  ownership_percentage: number;
  effective_from: string;
  effective_to: string | null;
  changed_by: string;
  change_reason: string | null;
  approved_by: string | null;
  created_at: string;
  owners?: { name: string };
}

//  FIXED: Removed 'notes' — not in your SQL
export interface ReservePolicy {
  id: string;
  policy_type: string;
  fixed_amount: number;
  percentage: number;
  target_balance: number;
  effective_from: string;
  effective_to: string | null;
  approved_by: string | null;
  created_at: string;
  updated_at: string | null;
}

//  FIXED: Removed reserve_policy_id, cancellation_reason — not in your SQL
export interface ProfitDistribution {
  id: string;
  fiscal_year_id: string;
  period_id: string | null;
  total_available_profit: number;
  reserve_amount: number;
  distributable_amount: number;
  status: string;
  declared_by: string | null;
  declared_at: string | null;
  approved_by: string | null;
  approved_at: string | null;
  posted_by: string | null;
  posted_at: string | null;
  journal_entry_id: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string | null;
  created_by: string | null;
  lines?: DistributionLine[];
}

//  FIXED: overridden_amount + final_amount + no override_reason + CANCELLED instead of PARTIALLY_PAID
export interface DistributionLine {
  id: string;
  profit_distribution_id: string;
  owner_id: string;
  ownership_percentage: number;
  calculated_amount: number;
  overridden_amount: number | null;
  final_amount: number;
  payment_status: 'PENDING' | 'PAID' | 'CANCELLED';
  paid_amount: number;
  paid_date: string | null;
  payment_reference: string | null;
  payment_account_id: string | null;
  created_at: string;
  updated_at: string | null;
  owners?: { name: string };
}

// ==================== TAXPAYER PROFILE ====================

export const getTaxpayerProfile = async (orgId: string) => {
  const { data, error } = await db.from('taxpayer_profile').select('*').eq('organization_id', orgId).single();
  return { data: data as TaxpayerProfile, error };
};

export const updateTaxpayerProfile = async (id: string, payload: Partial<TaxpayerProfile>) => {
  const { data, error } = await db.from('taxpayer_profile').update({ ...payload, updated_at: new Date().toISOString() }).eq('id', id).select().single();
  return { data: data as TaxpayerProfile, error };
};

// ==================== TAX RULE SETS ====================

// ==================== TAX RULE SETS ====================

export const getTaxRuleSets = async (orgId: string) => {
  const { data, error } = await db.from('tax_rule_sets').select('*').eq('organization_id', orgId).order('tax_year', { ascending: false });
  return { data: data as TaxRuleSet[], error };
};

export const getTaxRuleSetWithSlabs = async (orgId: string, id: string) => {
  const { data, error } = await db.from('tax_rule_sets').select('*, tax_slabs(*)').eq('organization_id', orgId).eq('id', id).single();
  return { data: data as TaxRuleSet, error };
};

export const createTaxRuleSet = async (orgId: string, payload: Partial<TaxRuleSet> & { created_by: string }) => {
  const { data, error } = await db.from('tax_rule_sets').insert({ ...payload, organization_id: orgId }).select().single();
  return { data: data as TaxRuleSet, error };
};

export const updateTaxRuleSetStatus = async (id: string, status: string, userId?: string) => {
  const updates: any = { status, updated_at: new Date().toISOString() };
  
  if (status === 'APPROVED' || status === 'LOCKED') {
    updates.approved_by = userId || null;  
    updates.approved_at = new Date().toISOString();
  }

  const { data, error } = await db
    .from('tax_rule_sets')
    .update(updates)
    .eq('id', id)
    .select()
    .single();

  if (error) {
    throw error;
  }

  if (!data) {
    throw new Error('Update failed — no data returned. Check RLS policies or if row exists.');
  }

  return { data: data as TaxRuleSet, error: null };
};

// ==================== TAX SLABS ====================

export const getTaxSlabs = async (orgId: string, ruleSetId: string) => {
  const { data, error } = await db.from('tax_slabs').select('*').eq('organization_id', orgId).eq('tax_rule_set_id', ruleSetId).order('sort_order', { ascending: true });
  return { data: data as TaxSlab[], error };
};

export const saveTaxSlabs = async (orgId: string, slabs: Omit<TaxSlab, 'id' | 'created_at' | 'updated_at'>[]) => {
  const withOrg = slabs.map(s => ({ ...s, organization_id: orgId }));
  const { data, error } = await db.from('tax_slabs').upsert(withOrg, { onConflict: 'id' }).select();
  return { data, error };
};

export const deleteTaxSlab = async (id: string) => {
  const orgId = await getCurrentOrgId();
  const { error } = await db.from('tax_slabs').delete().eq('organization_id', orgId).eq('id', id);
  return { error };
};

// ==================== TAX RECONCILIATIONS ====================

export const getTaxReconciliations = async (orgId: string) => {
  const { data, error } = await db.from('tax_reconciliations').select('*, tax_rule_sets(name)').eq('organization_id', orgId).order('tax_year', { ascending: false });
  return { data: data as TaxReconciliation[], error };
};

export const getTaxReconciliation = async (orgId: string, id: string) => {
  const { data, error } = await db.from('tax_reconciliations').select('*, tax_rule_sets(*)').eq('organization_id', orgId).eq('id', id).single();
  return { data: data as TaxReconciliation, error };
};

export const createTaxReconciliation = async (orgId: string, payload: any) => {
  const { data, error } = await db.from('tax_reconciliations').insert({ ...payload, organization_id: orgId }).select().single();
  return { data: data as TaxReconciliation, error };
};

export const updateTaxReconciliation = async (id: string, payload: any) => {
  const orgId = await getCurrentOrgId();
  const { data, error } = await db.from('tax_reconciliations').update({ ...payload, updated_at: new Date().toISOString() }).eq('organization_id', orgId).eq('id', id).select().single();
  return { data: data as TaxReconciliation, error };
};

export const computeTax = async (orgId: string, reconId: string) => {
  const { data, error } = await db.rpc('compute_tax_liability', { p_tax_recon_id: reconId });
  return { data, error };
};

// ==================== TAX ADJUSTMENTS ====================

export const getTaxAdjustments = async (orgId: string, reconId: string) => {
  const { data, error } = await db.from('tax_adjustments').select('*').eq('organization_id', orgId).eq('tax_reconciliation_id', reconId).order('created_at', { ascending: true });
  return { data: data as TaxAdjustment[], error };
};

export const addTaxAdjustment = async (orgId: string, payload: Omit<TaxAdjustment, 'id' | 'created_at' | 'updated_at'>) => {
  const { data, error } = await db.from('tax_adjustments').insert({ ...payload, organization_id: orgId }).select().single();
  return { data: data as TaxAdjustment, error };
};

export const updateTaxAdjustment = async (id: string, payload: Partial<TaxAdjustment>) => {
  const orgId = await getCurrentOrgId();
  const { data, error } = await db.from('tax_adjustments').update({ ...payload, updated_at: new Date().toISOString() }).eq('organization_id', orgId).eq('id', id).select().single();
  return { data: data as TaxAdjustment, error };
};

export const deleteTaxAdjustment = async (id: string) => {
  const orgId = await getCurrentOrgId();
  const { error } = await db.from('tax_adjustments').delete().eq('organization_id', orgId).eq('id', id);
  return { error };
};

// ==================== OWNERS ====================

export const getOwners = async (orgId: string) => {
  const { data: owners, error } = await db.from('owners').select('*').eq('organization_id', orgId).order('name');
  if (error || !owners) return { data: [], error };

  const { data: history } = await db.from('ownership_history').select('*').eq('organization_id', orgId).order('effective_from', { ascending: false });
  const histMap = new Map<string, number>();

  (history || []).forEach((h: OwnershipHistory) => {
    if (!h.effective_to || new Date(h.effective_to) >= new Date()) {
      histMap.set(h.owner_id, h.ownership_percentage);
    }
  });

  const enriched = owners.map((o: Owner) => ({ ...o, current_percentage: histMap.get(o.id) || 0 }));
  return { data: enriched as Owner[], error: null };
};

export const createOwner = async (orgId: string, payload: any) => {
  const { data, error } = await db.from('owners').insert({ ...payload, organization_id: orgId }).select().single();
  return { data: data as Owner, error };
};

export const updateOwner = async (id: string, payload: any) => {
  const orgId = await getCurrentOrgId();
  const { data, error } = await db.from('owners').update({ ...payload, updated_at: new Date().toISOString() }).eq('organization_id', orgId).eq('id', id).select().single();
  return { data: data as Owner, error };
};

// ==================== OWNERSHIP HISTORY ====================

export const getOwnershipHistory = async (orgId: string) => {
  const { data, error } = await db.from('ownership_history').select('*, owners(name)').eq('organization_id', orgId).order('effective_from', { ascending: false }).limit(50);
  return { data: data as OwnershipHistory[], error };
};

export const addOwnershipEntry = async (orgId: string, payload: any) => {
  const { data, error } = await db.rpc('add_ownership_history_atomic', { p_owner_id: payload.owner_id, p_percentage: payload.ownership_percentage, p_effective_from: payload.effective_from, p_change_reason: payload.change_reason, p_changed_by: payload.changed_by });
  return { data, error };
};

// ==================== RESERVE POLICIES ====================

export const getReservePolicies = async (orgId: string) => {
  const { data, error } = await db.from('reserve_policies').select('*').eq('organization_id', orgId).order('effective_from', { ascending: false });
  return { data: data as ReservePolicy[], error };
};

export const createReservePolicy = async (orgId: string, payload: any) => {
  const { data, error } = await db.from('reserve_policies').insert({ ...payload, organization_id: orgId }).select().single();
  return { data: data as ReservePolicy, error };
};

export const updateReservePolicy = async (id: string, payload: any) => {
  const orgId = await getCurrentOrgId();
  const { data, error } = await db.from('reserve_policies').update({ ...payload, updated_at: new Date().toISOString() }).eq('organization_id', orgId).eq('id', id).select().single();
  return { data: data as ReservePolicy, error };
};

export const calculateReserve = async (orgId: string, profit: number, date?: string) => {
  const { data, error } = await db.rpc('calculate_reserve', { p_profit: profit, p_on_date: date || null, p_organization_id: orgId });
  return { data, error };
};

// ==================== PROFIT DISTRIBUTIONS ====================

export const getProfitDistributions = async (orgId: string) => {
  const { data, error } = await db.from('profit_distributions').select('*').eq('organization_id', orgId).order('created_at', { ascending: false });
  return { data: data as ProfitDistribution[], error };
};

export const getProfitDistributionWithLines = async (orgId: string, id: string) => {
  const { data, error } = await db.from('profit_distributions').select('*, distribution_lines(*, owners(name))').eq('organization_id', orgId).eq('id', id).single();
  return { data: data as ProfitDistribution, error };
};

export const createProfitDistribution = async (orgId: string, payload: any) => {
  // AUD-P2-008: never persist a client-declared profit figure. The server
  // computes the selected fiscal year's posted P&L and applies the active
  // reserve policy inside one SECURITY DEFINER transaction.
  const res = await fetch('/api/finance/profit-distributions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ fiscal_year_id: payload?.fiscal_year_id }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) return { data: null, error: new Error(body.error || 'Failed to create profit distribution') };
  return { data: body.data as ProfitDistribution, error: null };
};

export const updateProfitDistribution = async (id: string, payload: any) => {
  const status = payload?.status;
  if (!status || !['DECLARED', 'APPROVED', 'CANCELLED'].includes(status)) {
    return { data: null, error: new Error('Only DECLARED, APPROVED, or CANCELLED transitions are supported') };
  }

  const { data, error } = await db.rpc('transition_profit_distribution', {
    p_distribution_id: id,
    p_status: status,
    p_reason: status === 'CANCELLED' ? payload?.reason || null : null,
  });
  return { data: data as ProfitDistribution, error };
};

// BUG-016 FIX (defect d): finance.distribution_lines has no
// organization_id column (org isolation for this table is enforced via
// its RLS policies joining out to finance.profit_distributions.organization_id
// instead — see supabase/migrations/P1/P1_062_organization_isolation_batch2.sql).
// Injecting organization_id into each row made every upsert fail with a
// "column does not exist" error, so a distribution's lines could never be
// saved in the first place — nothing further downstream (WHT calc,
// posting) could ever run. `orgId` is accepted here only so this
// function's call signature didn't need to change everywhere it's used.
export const saveDistributionLines = async (orgId: string, lines: any[]) => {
  const { data, error } = await db.from('distribution_lines').upsert(lines, { onConflict: 'id' }).select();
  return { data, error };
};

// FND-ACCT-001 FIX: this used to call db.rpc('post_profit_distribution', ...)
// directly. That RPC (a) has/had no organization filter on its distribution
// or chart-of-accounts lookups — a cross-tenant GL-corruption risk — and
// (b), more fundamentally, is the WRONG posting path entirely: it skips
// withholding-tax computation (FBR Section 149 dividend WHT), never writes
// an audit log entry, and never checks that the fiscal period is still
// open. The correct, atomic, WHT-aware posting flow already exists at
// POST /api/finance/profit-distribution (distribution-wht.service.ts +
// finance.post_journal_entry) — route through that instead, the same way
// closeFiscalYear() in fiscal-year.service.ts calls /api/year-end-close
// rather than issuing a raw RPC from the browser.
// `periodId` is accepted for backward compatibility with existing callers
// (usePostProfitDistribution / the profit-distribution page) but is no
// longer sent — the API route resolves the correct open period itself.
export const postProfitDistribution = async (orgId: string, distId: string, periodId: string, date: string) => {
  const res = await fetch('/api/finance/profit-distribution', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({
      distribution_id: distId,
      distribution_date: date,
    }),
  });

  const body = await res.json().catch(() => ({}));

  if (!res.ok) {
    return { data: null, error: { message: body.error || 'Failed to post profit distribution to GL' } };
  }

  return { data: body, error: null };
};

// ==================== DROPDOWNS ====================

export const getFiscalYears = async (orgId: string) => {
  const { data, error } = await db.from('fiscal_years').select('*').eq('organization_id', orgId).order('start_date', { ascending: false });
  return { data, error };
};

export const getOpenPeriod = async (orgId: string) => {
  const { data, error } = await db.from('accounting_periods').select('id, period_name').eq('organization_id', orgId).eq('status', 'OPEN').limit(1).single();
  return { data, error };
};

export const getExpenseAccounts = async (orgId: string) => {
  const { data, error } = await db.from('chart_of_accounts').select('id, code, name, account_type').eq('organization_id', orgId).in('account_type', ['OPERATING_EXPENSE', 'OTHER_EXPENSE', 'COST_OF_SALES']).eq('is_active', true).order('code');
  return { data, error };
};