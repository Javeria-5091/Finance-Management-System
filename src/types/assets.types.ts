// ============================================================
// p1 - Type Definitions
// ============================================================

// --- Asset Types ---
export interface LegacyAssetCategory {
  id: string;
  name: string;
  code: string;
  description?: string;
  usefulLifeYears: number;
  residualPercentage: number;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  assets?: LegacyFixedAsset[];
}

export interface LegacyFixedAsset {
  id: string;
  assetTag: string;
  name: string;
  categoryId: string;
  description?: string;
  serialNumber?: string;
  purchaseDate: string;
  purchaseCost: number;
  residualValue: number;
  usefulLifeYears: number;
  currentStatus: string;
  vendor?: string;
  warrantyExpiry?: string;
  location?: string;
  assignedUserId?: string;
  departmentId?: string;
  notes?: string;
  createdAt: string;
  updatedAt: string;
  category?: LegacyAssetCategory;
  assignedUser?: { id: string; name: string; email?: string };
  depreciationRuns?: AssetDepreciationRun[];
  events?: AssetEvent[];
}

export interface AssetDepreciationRun {
  id: string;
  assetId: string;
  fiscalYear: string;
  periodMonth: number;
  depreciationMethod: string;
  depreciationAmount: number;
  accumulatedDepreciation: number;
  netBookValue: number;
  status: string;
  postedBy?: string;
  postedAt?: string;
  journalEntryId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AssetEvent {
  id: string;
  assetId: string;
  eventType: string;
  eventDate: string;
  description?: string;
  oldValue?: string;
  newValue?: string;
  performedBy?: string;
  notes?: string;
  createdAt: string;
  updatedAt: string;
}