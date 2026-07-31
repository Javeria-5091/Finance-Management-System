import { supabase } from '@/lib/supabase';

const db = supabase.schema('finance');

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

export const getTaxpayerProfile = async () => {
  const { data, error } = await db.from('taxpayer_profile').select('*').single();
  return { data: data as TaxpayerProfile, error };
};

export const updateTaxpayerProfile = async (id: string, payload: Partial<TaxpayerProfile>) => {
  const { data, error } = await db.from('taxpayer_profile').update({ ...payload, updated_at: new Date().toISOString() }).eq('id', id).select().single();
  return { data: data as TaxpayerProfile, error };
};

// ==================== TAX RULE SETS ====================

// ==================== TAX RULE SETS ====================

export const getTaxRuleSets = async () => {
  const { data, error } = await db.from('tax_rule_sets').select('*').order('tax_year', { ascending: false });
  return { data: data as TaxRuleSet[], error };
};

export const getTaxRuleSetWithSlabs = async (id: string) => {
  const { data, error } = await db.from('tax_rule_sets').select('*, tax_slabs(*)').eq('id', id).single();
  return { data: data as TaxRuleSet, error };
};

export const createTaxRuleSet = async (payload: Partial<TaxRuleSet> & { created_by: string }) => {
  const { data, error } = await db.from('tax_rule_sets').insert(payload).select().single();
  return { data: data as TaxRuleSet, error };
};

export const updateTaxRuleSetStatus = async (id: string, status: string, userId?: string) => {
  const updates: any = { status, updated_at: new Date().toISOString() };
  
  if (status === 'APPROVED' || status === 'LOCKED') {
    updates.approved_by = userId || null;  
    updates.approved_at = new Date().toISOString();
  }

  console.log('🔧 [TAX] Updating rule set:', { id, status, userId, updates });

  const { data, error } = await db
    .from('tax_rule_sets')
    .update(updates)
    .eq('id', id)
    .select()
    .single();

  // YEH LINE MISSING THI — Error throw karo, warna silent fail hota hai
  if (error) {
    console.error(' [TAX] DB Error:', error);
    throw error;
  }

  // YEH BHI MISSING THI — Agar data null aaye to bhi throw karo
  if (!data) {
    console.error(' [TAX] No data returned for id:', id);
    throw new Error('Update failed — no data returned. Check RLS policies or if row exists.');
  }

  console.log(' [TAX] Update success:', data);
  return { data: data as TaxRuleSet, error: null };
};

// ==================== TAX SLABS ====================

export const getTaxSlabs = async (ruleSetId: string) => {
  const { data, error } = await db.from('tax_slabs').select('*').eq('tax_rule_set_id', ruleSetId).order('sort_order', { ascending: true });
  return { data: data as TaxSlab[], error };
};

export const saveTaxSlabs = async (slabs: Omit<TaxSlab, 'id' | 'created_at' | 'updated_at'>[]) => {
  const { data, error } = await db.from('tax_slabs').upsert(slabs, { onConflict: 'id' }).select();
  return { data, error };
};

export const deleteTaxSlab = async (id: string) => {
  const { error } = await db.from('tax_slabs').delete().eq('id', id);
  return { error };
};

// ==================== TAX RECONCILIATIONS ====================

export const getTaxReconciliations = async () => {
  const { data, error } = await db.from('tax_reconciliations').select('*, tax_rule_sets(name)').order('tax_year', { ascending: false });
  return { data: data as TaxReconciliation[], error };
};

export const getTaxReconciliation = async (id: string) => {
  const { data, error } = await db.from('tax_reconciliations').select('*, tax_rule_sets(*)').eq('id', id).single();
  return { data: data as TaxReconciliation, error };
};

export const createTaxReconciliation = async (payload: any) => {
  const { data, error } = await db.from('tax_reconciliations').insert(payload).select().single();
  return { data: data as TaxReconciliation, error };
};

export const updateTaxReconciliation = async (id: string, payload: any) => {
  const { data, error } = await db.from('tax_reconciliations').update({ ...payload, updated_at: new Date().toISOString() }).eq('id', id).select().single();
  return { data: data as TaxReconciliation, error };
};

export const computeTax = async (reconId: string) => {
  const { data, error } = await db.rpc('compute_tax_liability', { p_tax_recon_id: reconId });
  return { data, error };
};

// ==================== TAX ADJUSTMENTS ====================

export const getTaxAdjustments = async (reconId: string) => {
  const { data, error } = await db.from('tax_adjustments').select('*').eq('tax_reconciliation_id', reconId).order('created_at', { ascending: true });
  return { data: data as TaxAdjustment[], error };
};

export const addTaxAdjustment = async (payload: Omit<TaxAdjustment, 'id' | 'created_at' | 'updated_at'>) => {
  const { data, error } = await db.from('tax_adjustments').insert(payload).select().single();
  return { data: data as TaxAdjustment, error };
};

export const updateTaxAdjustment = async (id: string, payload: Partial<TaxAdjustment>) => {
  const { data, error } = await db.from('tax_adjustments').update({ ...payload, updated_at: new Date().toISOString() }).eq('id', id).select().single();
  return { data: data as TaxAdjustment, error };
};

export const deleteTaxAdjustment = async (id: string) => {
  const { error } = await db.from('tax_adjustments').delete().eq('id', id);
  return { error };
};

// ==================== OWNERS ====================

export const getOwners = async () => {
  const { data: owners, error } = await db.from('owners').select('*').order('name');
  if (error || !owners) return { data: [], error };

  const { data: history } = await db.from('ownership_history').select('*').order('effective_from', { ascending: false });
  const histMap = new Map<string, number>();

  (history || []).forEach((h: OwnershipHistory) => {
    if (!h.effective_to || new Date(h.effective_to) >= new Date()) {
      histMap.set(h.owner_id, h.ownership_percentage);
    }
  });

  const enriched = owners.map((o: Owner) => ({ ...o, current_percentage: histMap.get(o.id) || 0 }));
  return { data: enriched as Owner[], error: null };
};

export const createOwner = async (payload: any) => {
  const { data, error } = await db.from('owners').insert(payload).select().single();
  return { data: data as Owner, error };
};

export const updateOwner = async (id: string, payload: any) => {
  const { data, error } = await db.from('owners').update({ ...payload, updated_at: new Date().toISOString() }).eq('id', id).select().single();
  return { data: data as Owner, error };
};

// ==================== OWNERSHIP HISTORY ====================

export const getOwnershipHistory = async () => {
  const { data, error } = await db.from('ownership_history').select('*, owners(name)').order('effective_from', { ascending: false }).limit(50);
  return { data: data as OwnershipHistory[], error };
};

export const addOwnershipEntry = async (payload: any) => {
  const { data, error } = await db.from('ownership_history').insert(payload).select().single();
  return { data, error };
};

// ==================== RESERVE POLICIES ====================

export const getReservePolicies = async () => {
  const { data, error } = await db.from('reserve_policies').select('*').order('effective_from', { ascending: false });
  return { data: data as ReservePolicy[], error };
};

export const createReservePolicy = async (payload: any) => {
  const { data, error } = await db.from('reserve_policies').insert(payload).select().single();
  return { data: data as ReservePolicy, error };
};

export const updateReservePolicy = async (id: string, payload: any) => {
  const { data, error } = await db.from('reserve_policies').update({ ...payload, updated_at: new Date().toISOString() }).eq('id', id).select().single();
  return { data: data as ReservePolicy, error };
};

export const calculateReserve = async (profit: number, date?: string) => {
  const { data, error } = await db.rpc('calculate_reserve', { p_profit: profit, p_on_date: date || null });
  return { data, error };
};

// ==================== PROFIT DISTRIBUTIONS ====================

export const getProfitDistributions = async () => {
  const { data, error } = await db.from('profit_distributions').select('*').order('created_at', { ascending: false });
  return { data: data as ProfitDistribution[], error };
};

export const getProfitDistributionWithLines = async (id: string) => {
  const { data, error } = await db.from('profit_distributions').select('*, distribution_lines(*, owners(name))').eq('id', id).single();
  return { data: data as ProfitDistribution, error };
};

export const createProfitDistribution = async (payload: any) => {
  const { data, error } = await db.from('profit_distributions').insert(payload).select().single();
  return { data: data as ProfitDistribution, error };
};

export const updateProfitDistribution = async (id: string, payload: any) => {
  const { data, error } = await db.from('profit_distributions').update({ ...payload, updated_at: new Date().toISOString() }).eq('id', id).select().single();
  return { data: data as ProfitDistribution, error };
};

export const saveDistributionLines = async (lines: any[]) => {
  const { data, error } = await db.from('distribution_lines').upsert(lines, { onConflict: 'id' }).select();
  return { data, error };
};

export const postProfitDistribution = async (distId: string, periodId: string, date: string) => {
  const { data, error } = await db.rpc('post_profit_distribution', { p_distribution_id: distId, p_period_id: periodId, p_transaction_date: date });
  return { data, error };
};

// ==================== DROPDOWNS ====================

export const getFiscalYears = async () => {
  const { data, error } = await db.from('fiscal_years').select('*').order('start_date', { ascending: false });
  return { data, error };
};

export const getOpenPeriod = async () => {
  const { data, error } = await db.from('accounting_periods').select('id, period_name').eq('status', 'OPEN').limit(1).single();
  return { data, error };
};

export const getExpenseAccounts = async () => {
  const { data, error } = await db.from('chart_of_accounts').select('id, code, name, account_type').in('account_type', ['OPERATING_EXPENSE', 'OTHER_EXPENSE', 'COST_OF_SALES']).eq('is_active', true).order('code');
  return { data, error };
};