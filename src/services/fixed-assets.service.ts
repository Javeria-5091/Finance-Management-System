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

export const createFixedAsset = async (input: FixedAssetFormInput, _userId: string): Promise<FixedAsset> => {
  const response = await fetch('/api/finance/assets', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
    body: JSON.stringify(input),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || 'Failed to create fixed asset');
  return payload.data as FixedAsset;
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

async function callAssetAction<T>(body: Record<string, unknown>): Promise<T> {
  const response = await fetch('/api/finance/assets/actions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || 'Fixed asset operation failed');
  return payload.data as T;
}

export const capitalizeAsset = async (id: string, _userId: string): Promise<FixedAsset> =>
  callAssetAction<FixedAsset>({ action: 'capitalize', asset_id: id });

export const disposeAsset = async (
  id: string, disposalDate: string, disposalValue: number, disposalCurrencyId: string, disposalMethod: string
): Promise<FixedAsset> =>
  callAssetAction<FixedAsset>({ action: 'dispose', asset_id: id, disposal_date: disposalDate, disposal_value: disposalValue, disposal_currency: disposalCurrencyId, disposal_method: disposalMethod });

export const impairAsset = async (id: string, adjustmentDate: string, amount: number, reason: string): Promise<FixedAsset> =>
  callAssetAction<FixedAsset>({ action: 'impair', asset_id: id, adjustment_date: adjustmentDate, amount, reason });

export const transferAsset = async (params: {
  id: string; date: string; location: string | null; assigned_user_id: string | null;
  project_id: string | null; department_id: string | null; cost_center_id: string | null; reason: string;
}): Promise<FixedAsset> =>
  callAssetAction<FixedAsset>({
    action: 'transfer', asset_id: params.id, transfer_date: params.date, location: params.location,
    assigned_user_id: params.assigned_user_id, project_id: params.project_id,
    department_id: params.department_id, cost_center_id: params.cost_center_id, reason: params.reason,
  });

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

export const generateDepreciationForPeriod = async (periodId: string, _userId: string): Promise<{
  generated: number; total_amount: number; details: { asset_id: string; asset_code: string; asset_name: string; depreciation_amount: number; status: string }[];
}> => callAssetAction({ action: 'generate_depreciation', period_id: periodId });

export const postDepreciationForPeriod = async (periodId: string): Promise<{ posted: number; total_amount: number }> =>
  callAssetAction({ action: 'post_depreciation', period_id: periodId });

export const getAssetVerifications = async (): Promise<AssetVerification[]> => {
  const orgId = await getCurrentOrgId();
  const { data, error } = await financeDB
    .from('asset_verifications')
    .select(`
      *,
      lines:asset_verification_lines(
        *,
        asset:fixed_assets(code, name, location, status)
      )
    `)
    .eq('organization_id', orgId)
    .order('verification_date', { ascending: false })
    .order('created_at', { ascending: false });

  if (error) throw new Error(`Failed to fetch asset verifications: ${error.message}`);
  return (data || []).map((row) => mapVerificationJoins(row as Record<string, unknown>));
};

export const getAssetVerificationById = async (id: string): Promise<AssetVerification | null> => {
  const orgId = await getCurrentOrgId();
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
    .eq('organization_id', orgId)
    .maybeSingle();

  if (error) throw new Error(`Failed to fetch asset verification: ${error.message}`);
  return data ? mapVerificationJoins(data as Record<string, unknown>) : null;
};

export const updateVerificationLine = async (
  lineId: string,
  updates: {
    is_verified?: boolean;
    physical_location?: string;
    physical_condition?: string;
    discrepancy_notes?: string;
  }
): Promise<AssetVerificationLine> => {
  const response = await fetch('/api/finance/assets/verifications', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({
      action: 'update_line',
      line_id: lineId,
      ...updates,
    }),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || 'Failed to update verification line');
  return payload.data as AssetVerificationLine;
};

export const getAccountingPeriods = async (): Promise<Array<{
  id: string;
  fiscal_year_id: string;
  period_number: number;
  name: string;
  start_date: string;
  end_date: string;
  status: string;
}>> => {
  const orgId = await getCurrentOrgId();
  const { data, error } = await financeDB
    .from('accounting_periods')
    .select('id, fiscal_year_id, period_number, name, start_date, end_date, status')
    .eq('organization_id', orgId)
    .in('status', ['OPEN', 'PENDING'])
    .order('start_date', { ascending: false });

  if (error) throw new Error(`Failed to fetch accounting periods: ${error.message}`);
  return data || [];
};

export const createAssetVerification = async (verificationDate: string, _userId: string): Promise<AssetVerification> => {
  const response = await fetch('/api/finance/assets/verifications', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
    body: JSON.stringify({ action: 'create', verification_date: verificationDate }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || 'Failed to create verification');
  return payload.data as AssetVerification;
};

export const completeVerification = async (verificationId: string, notes: string): Promise<AssetVerification> => {
  const response = await fetch('/api/finance/assets/verifications', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
    body: JSON.stringify({ action: 'complete', verification_id: verificationId, notes }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || 'Failed to complete verification');
  return payload.data as AssetVerification;
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
  const response = await fetch('/api/finance/assets/next-code', { credentials: 'include' });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || 'Failed to generate asset code');
  return payload.data as string;
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