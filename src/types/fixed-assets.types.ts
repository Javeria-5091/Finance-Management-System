// =============================================================================
// P1 Types: Fixed Assets & Depreciation
// Convention: P0 uses .types.ts suffix, types in src/types/
// =============================================================================

export type DepreciationMethod = 'straight_line' | 'declining_balance' | 'units_of_production';
export type AssetStatus = 'pending_capitalization' | 'active' | 'fully_depreciated' | 'under_repair' | 'disposed' | 'sold';
export type DepreciationScheduleStatus = 'calculated' | 'posted' | 'reversed' | 'skipped';
export type VerificationStatus = 'in_progress' | 'completed' | 'discrepancy_found';

export interface AssetCategory {
  id: string;
  code: string;
  name: string;
  description?: string;
  useful_life_months: number;
  residual_value_pct: number;
  depreciation_method: DepreciationMethod;
  capitalization_threshold: number;
  linked_asset_account_id: string;
  linked_depreciation_account_id: string;
  linked_expense_account_id: string;
  active: boolean;
  created_by: string;
  created_at: string;
  updated_at: string;
  // Joined fields
  asset_account_name?: string;
  depreciation_account_name?: string;
  expense_account_name?: string;
  asset_count?: number;
}

export interface FixedAsset {
  id: string;
  code: string;
  name: string;
  category_id: string;
  description?: string;
  vendor_id?: string;
  purchase_date: string;
  purchase_cost: number;
  currency_id: string;
  base_cost: number;
  exchange_rate_id?: string;
  serial_number?: string;
  warranty_start?: string;
  warranty_end?: string;
  location?: string;
  assigned_user_id?: string;
  useful_life_months?: number;
  residual_value_pct?: number;
  depreciation_method?: DepreciationMethod;
  residual_value_amount?: number;
  accumulated_depreciation: number;
  net_book_value: number;
  linked_asset_account_id?: string;
  linked_depreciation_account_id?: string;
  linked_expense_account_id?: string;
  project_id?: string;
  department_id?: string;
  cost_center_id?: string;
  status: AssetStatus;
  disposal_date?: string;
  disposal_value?: number;
  disposal_currency?: string;
  disposal_method?: string;
  gain_loss_amount?: number;
  disposal_journal_id?: string;
  approved_by?: string;
  approved_at?: string;
  created_by: string;
  created_at: string;
  updated_at: string;
  // Joined fields
  category_name?: string;
  vendor_name?: string;
  currency_code?: string;
  project_name?: string;
  assigned_user_name?: string;
  asset_account_name?: string;
  depreciation_account_name?: string;
  expense_account_name?: string;
}

export interface DepreciationSchedule {
  id: string;
  asset_id: string;
  period_id: string;
  fiscal_year_id: string;
  opening_nbv: number;
  depreciation_amount: number;
  closing_nbv: number;
  method: DepreciationMethod;
  rate: number;
  days_in_period: number;
  journal_entry_id?: string;
  status: DepreciationScheduleStatus;
  calculated_at: string;
  posted_at?: string;
  created_by: string;
  created_at: string;
  updated_at: string;
  // Joined fields
  asset_code?: string;
  asset_name?: string;
  period_name?: string;
  fiscal_year_name?: string;
}

export interface AssetVerification {
  id: string;
  verification_code: string;
  verification_date: string;
  verified_by: string;
  notes?: string;
  status: VerificationStatus;
  created_by: string;
  created_at: string;
  updated_at: string;
  verified_by_name?: string;
  lines?: AssetVerificationLine[];
  total_assets?: number;
  verified_count?: number;
  discrepancy_count?: number;
}

export interface AssetVerificationLine {
  id: string;
  verification_id: string;
  asset_id: string;
  physical_location?: string;
  physical_condition?: string;
  is_verified: boolean;
  discrepancy_notes?: string;
  created_at: string;
  // Joined fields
  asset_code?: string;
  asset_name?: string;
  asset_location?: string;
  asset_status?: string;
}

export interface AssetRegisterRow {
  id: string;
  code: string;
  name: string;
  category_name: string;
  purchase_date: string;
  purchase_cost: number;
  currency_code: string;
  base_cost: number;
  accumulated_depreciation: number;
  net_book_value: number;
  serial_number?: string;
  location?: string;
  status: AssetStatus;
  useful_life_months: number;
  residual_value_pct: number;
  project_name?: string;
  disposal_date?: string;
  disposal_value?: number;
  gain_loss_amount?: number;
}

export interface AssetKPIs {
  total_assets: number;
  total_cost: number;
  total_accumulated_depreciation: number;
  total_net_book_value: number;
  active_count: number;
  fully_depreciated_count: number;
  disposed_count: number;
  pending_capitalization_count: number;
  this_period_depreciation: number;
}

// Form input types
export interface AssetCategoryFormInput {
  code: string;
  name: string;
  description?: string;
  useful_life_months: number;
  residual_value_pct: number;
  depreciation_method: DepreciationMethod;
  capitalization_threshold: number;
  linked_asset_account_id: string;
  linked_depreciation_account_id: string;
  linked_expense_account_id: string;
}

export interface FixedAssetFormInput {
  code: string;
  name: string;
  category_id: string;
  description?: string;
  vendor_id?: string;
  purchase_date: string;
  purchase_cost: number;
  currency_id: string;
  base_cost: number;
  serial_number?: string;
  warranty_start?: string;
  warranty_end?: string;
  location?: string;
  assigned_user_id?: string;
  useful_life_months?: number;
  residual_value_pct?: number;
  depreciation_method?: DepreciationMethod;
  residual_value_amount?: number;
  project_id?: string;
  department_id?: string;
  cost_center_id?: string;
  linked_asset_account_id?: string;
  linked_depreciation_account_id?: string;
  linked_expense_account_id?: string;
}