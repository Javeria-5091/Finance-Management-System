// =============================================================================
// P1 Hook: Contractors — TanStack React Query pattern
// File: src/hooks/useContractors.ts
// Convention: Follows useSubscriptions.ts exactly
// =============================================================================

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import * as S from '@/services/contractor.service';

// ─── Queries ─────────────────────────────────────────────────────────────────

export const useContractorStats = () =>
  useQuery({
    queryKey: ['contractor-stats'],
    queryFn: S.fetchContractorStats,
    staleTime: 30000,
  });

export const useContractors = (filters?: {
    search?: string;
    role?: string;
    status?: string;
  }) =>
  useQuery({
    queryKey: ['contractors', filters?.search, filters?.role, filters?.status],
    queryFn: () => S.fetchContractors(filters),
    staleTime: 15000,
  });

export const useExpiringContracts = () =>
  useQuery({
    queryKey: ['contractor-expirations'],
    queryFn: S.fetchExpiringContracts,
    staleTime: 15000,
  });

export const useCostByRole = () =>
  useQuery({
    queryKey: ['contractor-cost-role'],
    queryFn: S.fetchCostByRole,
    staleTime: 30000,
  });

export const useCostByProject = () =>
  useQuery({
    queryKey: ['contractor-cost-project'],
    queryFn: S.fetchCostByProject,
    staleTime: 30000,
  });

// ─── Mutations ───────────────────────────────────────────────────────────────

export const useCreateContractor = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: any) => S.createContractor(input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['contractors'] });
      qc.invalidateQueries({ queryKey: ['contractor-stats'] });
      qc.invalidateQueries({ queryKey: ['contractor-expirations'] });
      qc.invalidateQueries({ queryKey: ['contractor-cost-role'] });
      qc.invalidateQueries({ queryKey: ['contractor-cost-project'] });
    },
  });
};

export const useUpdateContractor = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, updates }: { id: string; updates: any }) => S.updateContractor(id, updates),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['contractors'] });
      qc.invalidateQueries({ queryKey: ['contractor-stats'] });
      qc.invalidateQueries({ queryKey: ['contractor-expirations'] });
      qc.invalidateQueries({ queryKey: ['contractor-cost-role'] });
      qc.invalidateQueries({ queryKey: ['contractor-cost-project'] });
    },
  });
};

export const useDeleteContractor = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => S.deleteContractor(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['contractors'] });
      qc.invalidateQueries({ queryKey: ['contractor-stats'] });
      qc.invalidateQueries({ queryKey: ['contractor-expirations'] });
      qc.invalidateQueries({ queryKey: ['contractor-cost-role'] });
      qc.invalidateQueries({ queryKey: ['contractor-cost-project'] });
    },
  });
};
