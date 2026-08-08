// =============================================================================
// P1 Hook: Commissions — TanStack React Query pattern
// File: src/hooks/useCommissions.ts
// Convention: Follows useContractors.ts exactly
// =============================================================================

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import * as S from '@/services/commission.service';

// ─── Queries ─────────────────────────────────────────────────────────────────

export const useCommissionStats = () =>
  useQuery({
    queryKey: ['commission-stats'],
    queryFn: S.fetchCommissionStats,
    staleTime: 30000,
  });

export const useCommissions = (filters?: {
    search?: string;
    status?: string;
    commission_type?: string;
    person_type?: string;
    project_id?: string;
    contractor_id?: string;
  }) =>
  useQuery({
    queryKey: [
      'commissions',
      filters?.search,
      filters?.status,
      filters?.commission_type,
      filters?.person_type,
      filters?.project_id,
      filters?.contractor_id,
    ],
    queryFn: () => S.fetchCommissions(filters),
    staleTime: 15000,
  });

export const useCommissionByPerson = () =>
  useQuery({
    queryKey: ['commission-by-person'],
    queryFn: S.fetchCommissionByPerson,
    staleTime: 30000,
  });

export const useCommissionByProject = () =>
  useQuery({
    queryKey: ['commission-by-project'],
    queryFn: S.fetchCommissionByProject,
    staleTime: 30000,
  });

export const useCommissionByType = () =>
  useQuery({
    queryKey: ['commission-by-type'],
    queryFn: S.fetchCommissionByType,
    staleTime: 30000,
  });

export const useCommissionStatusSummary = () =>
  useQuery({
    queryKey: ['commission-status-summary'],
    queryFn: S.fetchCommissionStatusSummary,
    staleTime: 30000,
  });

// ─── Mutations ───────────────────────────────────────────────────────────────

export const useCreateCommission = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: any) => S.createCommission(input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['commissions'] });
      qc.invalidateQueries({ queryKey: ['commission-stats'] });
      qc.invalidateQueries({ queryKey: ['commission-by-person'] });
      qc.invalidateQueries({ queryKey: ['commission-by-project'] });
      qc.invalidateQueries({ queryKey: ['commission-by-type'] });
      qc.invalidateQueries({ queryKey: ['commission-status-summary'] });
    },
  });
};

export const useUpdateCommission = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, updates }: { id: string; updates: any }) => S.updateCommission(id, updates),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['commissions'] });
      qc.invalidateQueries({ queryKey: ['commission-stats'] });
      qc.invalidateQueries({ queryKey: ['commission-by-person'] });
      qc.invalidateQueries({ queryKey: ['commission-by-project'] });
      qc.invalidateQueries({ queryKey: ['commission-by-type'] });
      qc.invalidateQueries({ queryKey: ['commission-status-summary'] });
    },
  });
};

export const useDeleteCommission = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => S.deleteCommission(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['commissions'] });
      qc.invalidateQueries({ queryKey: ['commission-stats'] });
      qc.invalidateQueries({ queryKey: ['commission-by-person'] });
      qc.invalidateQueries({ queryKey: ['commission-by-project'] });
      qc.invalidateQueries({ queryKey: ['commission-by-type'] });
      qc.invalidateQueries({ queryKey: ['commission-status-summary'] });
    },
  });
};

export const useApproveCommission = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, approvedBy }: { id: string; approvedBy: string }) =>
      S.approveCommission(id, approvedBy),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['commissions'] });
      qc.invalidateQueries({ queryKey: ['commission-stats'] });
      qc.invalidateQueries({ queryKey: ['commission-status-summary'] });
      qc.invalidateQueries({ queryKey: ['commission-by-person'] });
      qc.invalidateQueries({ queryKey: ['commission-by-project'] });
      qc.invalidateQueries({ queryKey: ['commission-by-type'] });
    },
  });
};

export const useMarkCommissionPaid = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, paymentDate, paymentRef }: { id: string; paymentDate: string; paymentRef: string }) =>
      S.markCommissionPaid(id, paymentDate, paymentRef),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['commissions'] });
      qc.invalidateQueries({ queryKey: ['commission-stats'] });
      qc.invalidateQueries({ queryKey: ['commission-status-summary'] });
      qc.invalidateQueries({ queryKey: ['commission-by-person'] });
      qc.invalidateQueries({ queryKey: ['commission-by-project'] });
      qc.invalidateQueries({ queryKey: ['commission-by-type'] });
    },
  });
};
