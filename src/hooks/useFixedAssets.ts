// =============================================================================
// P1 Hook: Fixed Assets — follows P0's TanStack React Query pattern
// Convention: P0 uses src/hooks/use*.ts with @tanstack/react-query
// =============================================================================

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import * as S from '@/services/fixed-assets.service';
import type { AssetStatus, FixedAssetFormInput } from '@/types/fixed-assets.types';

// ─── Queries ─────────────────────────────────────────────────────────────────

export const useAssetCategories = () =>
  useQuery({
    queryKey: ['asset-categories'],
    queryFn: S.getAssetCategories,
    staleTime: 30000,
  });

export const useFixedAssets = (filters?: {
  status?: AssetStatus;
  category_id?: string;
  project_id?: string;
  search?: string;
}) =>
  useQuery({
    queryKey: ['fixed-assets', filters],
    queryFn: () => S.getFixedAssets(filters),
    staleTime: 15000,
  });

export const useFixedAssetById = (id: string | null) =>
  useQuery({
    queryKey: ['fixed-asset', id],
    queryFn: () => S.getFixedAssetById(id!),
    enabled: !!id,
    staleTime: 10000,
  });

export const useAssetKPIs = () =>
  useQuery({
    queryKey: ['asset-kpis'],
    queryFn: S.getAssetKPIs,
    staleTime: 30000,
  });

export const useDepreciationSchedule = (filters?: {
  asset_id?: string;
  period_id?: string;
  fiscal_year_id?: string;
  status?: string;
}) =>
  useQuery({
    queryKey: ['depreciation-schedule', filters],
    queryFn: () => S.getDepreciationSchedule(filters),
    staleTime: 15000,
  });

export const useAssetVerifications = () =>
  useQuery({
    queryKey: ['asset-verifications'],
    queryFn: S.getAssetVerifications,
    staleTime: 30000,
  });

// ─── Mutations ───────────────────────────────────────────────────────────────

export const useCreateFixedAsset = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ input, userId }: { input: FixedAssetFormInput; userId: string }) =>
      S.createFixedAsset(input, userId),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['fixed-assets'] }); qc.invalidateQueries({ queryKey: ['asset-kpis'] }); },
  });
};

export const useCapitalizeAsset = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, userId }: { id: string; userId: string }) => S.capitalizeAsset(id, userId),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['fixed-assets'] }); qc.invalidateQueries({ queryKey: ['asset-kpis'] }); },
  });
};

export const useDisposeAsset = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (params: { id: string; date: string; value: number; currencyId: string; method: string }) =>
      S.disposeAsset(params.id, params.date, params.value, params.currencyId, params.method),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['fixed-assets'] }); qc.invalidateQueries({ queryKey: ['asset-kpis'] }); },
  });
};

export const useGenerateDepreciation = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ periodId, userId }: { periodId: string; userId: string }) =>
      S.generateDepreciationForPeriod(periodId, userId),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['depreciation-schedule'] }); qc.invalidateQueries({ queryKey: ['asset-kpis'] }); },
  });
};

export const usePostDepreciation = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (periodId: string) => S.postDepreciationForPeriod(periodId),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['depreciation-schedule'] }); qc.invalidateQueries({ queryKey: ['asset-kpis'] }); },
  });
};

export const useCreateVerification = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ date, userId }: { date: string; userId: string }) =>
      S.createAssetVerification(date, userId),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['asset-verifications'] }); },
  });
};

export const useNextAssetCode = () =>
  useQuery({
    queryKey: ['next-asset-code'],
    queryFn: S.generateNextAssetCode,
    staleTime: 60000,
  });