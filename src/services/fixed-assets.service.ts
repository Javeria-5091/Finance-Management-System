// =============================================================================
// P1 Service: Fixed Assets and Depreciation
// Convention: P0 uses src/services/*.service.ts + financeDB from @/lib/supabase
// =============================================================================

import { financeDB, reportingDB } from '@/lib/supabase';

async function getCurrentOrgId(): Promise<string> {
  const { data: { user } } = await financeDB.auth.getUser();
  if (!user) throw new Error('Authentication required');
  const { data: profile, error } = await financeDB.schema('public').from('profiles').select('organization_id').eq('user_id', user.id).maybeSingle();
  if (error || !profile?.organization_id) throw new Error('Organization context is required');
  return profile.organization_id;
}
import type {
  FixedAsset, FixedAssetFormInput, AssetCategory, AssetCategoryFormInput,
  DepreciationSchedule, AssetVerification, AssetVerificationLine,
  AssetRegisterRow, AssetKPIs, AssetStatus
} from '@/types/fixed-assets.types';

// ─── Asset Categories ────────────────────────────────────────────────────────

export const getAssetCategories = async (): Promise<AssetCategory[]> => {
  const orgId = await getCurrentOrgId();
  const { data, error } = await financeDB
    .from('asset_categories')
    .select(`
      *,
      asset_account:linked_asset_account_id(name),
      depreciation_account:linked_depreciation_account_id(name),
      expense_account:linked_expense_account_id(name)
    `)
    .eq('active', true)
    .eq('organization_id', orgId)
    .order('code');

  if (error) throw new Error(`Failed to fetch asset categories: ${error.message}`);
  return (data || []).map(mapCategoryJoins);
};

export const getAssetCategoryById = async (id: string): Promise<AssetCategory | null> => {
  const orgId = await getCurrentOrgId();
  const { data, error } = await financeDB
    .from('asset_categories')
    .select(`
      *,
      asset_account:linked_asset_account_id(name),
      depreciation_account:linked_depreciation_account_id(name),
      expense_account:linked_expense_account_id(name)
    `)
    .eq('id', id)
    .eq('organization_id', orgId)
    .single();

  if (error) throw new Error(`Failed to fetch asset category: ${error.message}`);
  return data ? mapCategoryJoins(data) : null;
};

export const createAssetCategory = async (input: AssetCategoryFormInput, userId: string): Promise<AssetCategory> => {
  const orgId = await getCurrentOrgId();
  const { data, error } = await financeDB
    .from('asset_categories')
    .insert({ ...input, created_by: userId, organization_id: orgId })
    .select()
    .single();

  if (error) throw new Error(`Failed to create asset category: ${error.message}`);
  return data;
};

export const updateAssetCategory = async (id: string, input: Partial<AssetCategoryFormInput>): Promise<AssetCategory> => {
  const orgId = await getCurrentOrgId();
  const { data, error } = await financeDB
    .from('asset_categories')
    .update(input)
    .eq('id', id)
    .eq('organization_id', orgId)
    .select()
    .single();

  if (error) throw new Error(`Failed to update asset category: ${error.message}`);
  return data;
};

// ─── Fixed Assets ────────────────────────────────────────────────────────────

export const getFixedAssets = async (filters?: {
  status?: AssetStatus;
  category_id?: string;
  project_id?: string;
  search?: string;
}): Promise<FixedAsset[]> => {
  const orgId = await getCurrentOrgId();
  let query = financeDB
    .from('fixed_assets')
    .select(`
      *,
      category:asset_categories(name, code),
      vendor:vendors(name),
      asset_account:linked_asset_account_id(name),
      depreciation_account:linked_depreciation_account_id(name),
      expense_account:linked_expense_account_id(name)
    `)
    .order('code');

  if (filters?.status) query = query.eq('status', filters.status);
  if (filters?.category_id) query = query.eq('category_id', filters.category_id);
  if (filters?.project_id) query = query.eq('project_id', filters.project_id);
  if (filters?.search) {
    query = query.or(`code.ilike.%${filters.search}%,name.ilike.%${filters.search}%,serial_number.ilike.%${filters.search}%`);
  }

  const { data, error } = await query;
  if (error) throw new Error(`Failed to fetch fixed assets: ${error.message}`);
  return (data || []).map(mapAssetJoins);
};

export const getFixedAssetById = async (id: string): Promise<FixedAsset | null> => {
  const orgId = await getCurrentOrgId();
  const { data, error } = await financeDB
    .from('fixed_assets')
    .select(`
      *,
      category:asset_categories(name, code, useful_life_months, residual_value_pct, depreciation_method),
      vendor:vendors(name),
      asset_account:linked_asset_account_id(name),
      depreciation_account:linked_depreciation_account_id(name),
      expense_account:linked_expense_account_id(name)
    `)
    .eq('id', id)
    .eq('organization_id', orgId)
    .single();

  if (error) throw new Error(`Failed to fetch fixed asset: ${error.message}`);
  return data ? mapAssetJoins(data) : null;
};

export const createFixedAsset = async (input: FixedAssetFormInput, userId: string): Promise<FixedAsset> => {
  const orgId = await getCurrentOrgId();
  // If no override accounts, get from category
  let assetAccountId = input.linked_asset_account_id;
  let depAccountId = input.linked_depreciation_account_id;
  let expAccountId = input.linked_expense_account_id;

  if (!assetAccountId || !depAccountId || !expAccountId) {
    const { data: cat } = await financeDB
      .from('asset_categories')
      .select('linked_asset_account_id, linked_depreciation_account_id, linked_expense_account_id')
      .eq('id', input.category_id)
      .eq('organization_id', orgId)
      .single();

    if (cat) {
      assetAccountId = assetAccountId || cat.linked_asset_account_id;
      depAccountId = depAccountId || cat.linked_depreciation_account_id;
      expAccountId = expAccountId || cat.linked_expense_account_id;
    }
  }

  // Convert empty strings to null for date columns (PostgreSQL rejects "" for DATE type)
  const insertPayload = {
    ...input,
    warranty_start: input.warranty_start || null,
    warranty_end: input.warranty_end || null,
    linked_asset_account_id: assetAccountId,
    linked_depreciation_account_id: depAccountId,
    linked_expense_account_id: expAccountId,
    status: 'pending_capitalization',
    created_by: userId,
    organization_id: orgId
  };

  const { data, error } = await financeDB
    .from('fixed_assets')
    .insert(insertPayload)
    .select()
    .single();

  if (error) throw new Error(`Failed to create fixed asset: ${error.message}`);
  return data;
};

export const updateFixedAsset = async (id: string, input: Partial<FixedAssetFormInput & { status?: AssetStatus }>): Promise<FixedAsset> => {
  const orgId = await getCurrentOrgId();
  // Convert empty strings to null for date columns
  const updatePayload: Record<string, unknown> = { ...input, updated_at: new Date().toISOString() };
  if ('warranty_start' in updatePayload) updatePayload.warranty_start = (updatePayload.warranty_start as string) || null;
  if ('warranty_end' in updatePayload) updatePayload.warranty_end = (updatePayload.warranty_end as string) || null;

  const { data, error } = await financeDB
    .from('fixed_assets')
    .update(updatePayload)
    .eq('id', id)
    .eq('organization_id', orgId)
    .select()
    .single();

  if (error) throw new Error(`Failed to update fixed asset: ${error.message}`);
  return data;
};

export const capitalizeAsset = async (id: string, userId: string): Promise<FixedAsset> => {
  const { data, error } = await financeDB.rpc('post_asset_capitalization', {
    p_asset_id: id,
    p_posted_by: userId,
  });
  if (error) throw new Error(`Failed to capitalize asset: ${error.message}`);
  return data as FixedAsset;
};

export const disposeAsset = async (
  id: string,
  disposalDate: string,
  disposalValue: number,
  disposalCurrencyId: string,
  disposalMethod: string
): Promise<FixedAsset> => {
  const { data, error } = await financeDB.rpc('post_asset_disposal', {
    p_asset_id: id,
    p_disposal_date: disposalDate,
    p_disposal_value: disposalValue,
    p_disposal_currency: disposalCurrencyId,
    p_disposal_method: disposalMethod,
  });
  if (error) throw new Error(`Failed to dispose asset: ${error.message}`);
  return data as FixedAsset;
};

// ─── Depreciation ────────────────────────────────────────────────────────────

export const getDepreciationSchedule = async (filters?: {
  asset_id?: string;
  period_id?: string;
  fiscal_year_id?: string;
  status?: string;
}): Promise<DepreciationSchedule[]> => {
  let query = financeDB
    .from('depreciation_schedule')
    .select(`
      *,
      asset:fixed_assets(code, name),
      period:accounting_periods(name),
      fiscal_year:fiscal_years(name)
    `)
    .order('created_at', { ascending: false });

  if (filters?.asset_id) query = query.eq('asset_id', filters.asset_id);
  if (filters?.period_id) query = query.eq('period_id', filters.period_id);
  if (filters?.fiscal_year_id) query = query.eq('fiscal_year_id', filters.fiscal_year_id);
  if (filters?.status) query = query.eq('status', filters.status);

  const { data, error } = await query;
  if (error) throw new Error(`Failed to fetch depreciation schedule: ${error.message}`);
  return (data || []).map(mapDepreciationJoins);
};

export const generateDepreciationForPeriod = async (periodId: string, userId: string): Promise<{
  generated: number;
  total_amount: number;
  details: { asset_id: string; asset_code: string; asset_name: string; depreciation_amount: number; status: string }[];
}> => {
  const { data, error } = await financeDB.rpc('fn_generate_depreciation_for_period', {
    p_period_id: periodId,
    p_created_by: userId
  });

  if (error) throw new Error(`Failed to generate depreciation: ${error.message}`);

  const details = (data || []).map((row: Record<string, unknown>) => ({
    asset_id: row.asset_id as string,
    asset_code: row.asset_code as string,
    asset_name: row.asset_name as string,
    depreciation_amount: Number(row.depreciation_amount),
    status: row.status as string
  }));

  return {
    generated: details.length,
    total_amount: details.reduce((sum:any, d:any) => sum + d.depreciation_amount, 0),
    details
  };
};

export const postDepreciationForPeriod = async (periodId: string): Promise<{
  posted: number;
  total_amount: number;
}> => {
  const { data: schedule, error: fetchError } = await financeDB
    .from('depreciation_schedule')
    .select('id, asset_id, depreciation_amount')
    .eq('period_id', periodId)
    .eq('status', 'calculated');

  if (fetchError) throw new Error(`Failed to fetch depreciation: ${fetchError.message}`);
  if (!schedule || schedule.length === 0) throw new Error('No calculated depreciation found for this period');

  const totalAmount = schedule.reduce((sum, s) => sum + Number(s.depreciation_amount), 0);

  // Post the depreciation journal and mark all schedule rows in one DB transaction.
  const { data: postedCount, error: postError } = await financeDB.rpc('post_depreciation_for_period', {
    p_period_id: periodId,
    p_created_by: (await financeDB.auth.getUser()).data.user?.id || null,
  });
  if (postError) throw new Error(`Failed to post depreciation: ${postError.message}`);

  return { posted: Number(postedCount || 0), total_amount: totalAmount };
};

// ─── Asset Verifications ─────────────────────────────────────────────────────

export const getAssetVerifications = async (): Promise<AssetVerification[]> => {
  const { data, error } = await financeDB
    .from('asset_verifications')
    .select(`
      *,
      lines:asset_verification_lines(
        *,
        asset:fixed_assets(code, name, location, status)
      )
    `)
    .order('verification_date', { ascending: false });

  if (error) throw new Error(`Failed to fetch asset verifications: ${error.message}`);
  return (data || []).map(mapVerificationJoins);
};
 
export const getAssetVerificationById = async (id: string): Promise<AssetVerification | null> => {
  const { data, error } = await financeDB
    .from('asset_verifications')
    .select(`
      *,
      lines:asset_verification_lines(
        *,
        asset:fixed_assets(code, name, location, status)
      )
    `)
    .eq('id', id)
    .single();

  if (error) throw new Error(`Failed to fetch verification: ${error.message}`);
  return data ? mapVerificationJoins(data) : null;
};

// ─── Update Verification Line ───────────────────────────────────────────────

export const updateVerificationLine = async (
  lineId: string,
  updates: {
    is_verified?: boolean;
    physical_location?: string;
    physical_condition?: string;
    discrepancy_notes?: string;
  }
): Promise<void> => {
  const { error } = await financeDB
    .from('asset_verification_lines')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('id', lineId);

  if (error) throw new Error(`Failed to update verification line: ${error.message}`);
};

// ─── Get Accounting Periods (for depreciation page) ─────────────────────────

export const getAccountingPeriods = async () => {
  const { data, error } = await financeDB
    .from('accounting_periods')
    .select('id, name, start_date, end_date')
    .order('start_date', { ascending: false });

  if (error) throw new Error(`Failed to fetch accounting periods: ${error.message}`);
  return data || [];
};

export const createAssetVerification = async (verificationDate: string, userId: string): Promise<AssetVerification> => {
  const code = `VER-${verificationDate.replace(/-/g, '').slice(0, 8)}-${Date.now().toString(36).toUpperCase()}`;

  const { data: assets } = await financeDB
    .from('fixed_assets')
    .select('id')
    .in('status', ['active', 'fully_depreciated', 'under_repair']);

  const { data: verification, error } = await financeDB
    .from('asset_verifications')
    .insert({
      verification_code: code,
      verification_date: verificationDate,
      verified_by: userId,
      status: 'in_progress',
      created_by: userId
    })
    .select()
    .single();

  if (error) throw new Error(`Failed to create verification: ${error.message}`);

  if (assets && assets.length > 0) {
    const lines = assets.map(a => ({ verification_id: verification.id, asset_id: a.id, is_verified: false }));
    await financeDB.from('asset_verification_lines').insert(lines);
  }

  return verification;
};

export const completeVerification = async (verificationId: string, notes: string): Promise<AssetVerification> => {
  const { data: lines } = await financeDB
    .from('asset_verification_lines')
    .select('id, is_verified, discrepancy_notes')
    .eq('verification_id', verificationId);

  const hasDiscrepancies = lines?.some((l: { is_verified: boolean; discrepancy_notes?: string }) => !l.is_verified || !!l.discrepancy_notes);

  const { data, error } = await financeDB
    .from('asset_verifications')
    .update({
      status: hasDiscrepancies ? 'discrepancy_found' : 'completed',
      notes
    })
    .eq('id', verificationId)
    .select()
    .single();

  if (error) throw new Error(`Failed to complete verification: ${error.message}`);
  return data;
};

// ─── Asset Register (Reporting View) ─────────────────────────────────────────

export const getAssetRegister = async (filters?: {
  category_name?: string;
  status?: AssetStatus;
}): Promise<AssetRegisterRow[]> => {
  let query = reportingDB
    .from('v_asset_register')
    .select('*')
    .order('code');

  if (filters?.category_name) query = query.eq('category_name', filters.category_name);
  if (filters?.status) query = query.eq('status', filters.status);

  const { data, error } = await query;
  if (error) throw new Error(`Failed to fetch asset register: ${error.message}`);
  return data || [];
};

// ─── KPIs ────────────────────────────────────────────────────────────────────

export const getAssetKPIs = async (): Promise<AssetKPIs> => {
  const orgId = await getCurrentOrgId();
  const { data: assets, error } = await financeDB
    .from('fixed_assets')
    .select('status, base_cost, accumulated_depreciation, net_book_value')
    .eq('organization_id', orgId);

  if (error) throw new Error(`Failed to fetch asset KPIs: ${error.message}`);

  const list = assets || [];
  return {
    total_assets: list.length,
    total_cost: list.reduce((s, a) => s + Number(a.base_cost), 0),
    total_accumulated_depreciation: list.reduce((s, a) => s + Number(a.accumulated_depreciation), 0),
    total_net_book_value: list.reduce((s, a) => s + Number(a.net_book_value), 0),
    active_count: list.filter(a => a.status === 'active').length,
    fully_depreciated_count: list.filter(a => a.status === 'fully_depreciated').length,
    disposed_count: list.filter(a => a.status === 'disposed' || a.status === 'sold').length,
    pending_capitalization_count: list.filter(a => a.status === 'pending_capitalization').length,
    this_period_depreciation: 0
  };
};

// ─── Next Asset Code Generator ───────────────────────────────────────────────

export const generateNextAssetCode = async (): Promise<string> => {
  const { data, error } = await financeDB
    .from('fixed_assets')
    .select('code')
    .order('code', { ascending: false })
    .limit(1);

  if (error || !data || data.length === 0) return 'AST-0001';

  const lastCode = data[0].code;
  const match = lastCode.match(/AST-(\d+)/);
  if (!match) return 'AST-0001';

  const nextNum = parseInt(match[1], 10) + 1;
  return `AST-${nextNum.toString().padStart(4, '0')}`;
};

// ─── Mapping Helpers ─────────────────────────────────────────────────────────

function mapCategoryJoins(raw: Record<string, unknown>): AssetCategory {
  return {
    ...raw as unknown as AssetCategory,
    asset_account_name: (raw.asset_account as Record<string, unknown>)?.name as string,
    depreciation_account_name: (raw.depreciation_account as Record<string, unknown>)?.name as string,
    expense_account_name: (raw.expense_account as Record<string, unknown>)?.name as string,
  };
}

function mapAssetJoins(raw: Record<string, unknown>): FixedAsset {
  return {
    ...raw as unknown as FixedAsset,
    category_name: (raw.category as Record<string, unknown>)?.name as string,
    vendor_name: (raw.vendor as Record<string, unknown>)?.name as string,
    currency_code: raw.currency as string,
    project_name: (raw.project as Record<string, unknown>)?.name as string,
    asset_account_name: (raw.asset_account as Record<string, unknown>)?.name as string,
    depreciation_account_name: (raw.depreciation_account as Record<string, unknown>)?.name as string,
    expense_account_name: (raw.expense_account as Record<string, unknown>)?.name as string,
  };
}

function mapDepreciationJoins(raw: Record<string, unknown>): DepreciationSchedule {
  return {
    ...raw as unknown as DepreciationSchedule,
    asset_code: (raw.asset as Record<string, unknown>)?.code as string,
    asset_name: (raw.asset as Record<string, unknown>)?.name as string,
    period_name: (raw.period as Record<string, unknown>)?.name as string,
    fiscal_year_name: (raw.fiscal_year as Record<string, unknown>)?.name as string,
  };
}

function mapVerificationJoins(raw: Record<string, unknown>): AssetVerification {
  const lines = (raw.lines as Record<string, unknown>[])?.map((l: Record<string, unknown>) => ({
    ...l as unknown as AssetVerificationLine,
    asset_code: (l.asset as Record<string, unknown>)?.code as string,
    asset_name: (l.asset as Record<string, unknown>)?.name as string,
    asset_location: (l.asset as Record<string, unknown>)?.location as string,
    asset_status: (l.asset as Record<string, unknown>)?.status as string,
  }));

  return {
    ...raw as unknown as AssetVerification,
    lines,
    total_assets: lines?.length || 0,
    verified_count: lines?.filter(l => l.is_verified).length || 0,
    discrepancy_count: lines?.filter(l => l.discrepancy_notes).length || 0,
  };
}