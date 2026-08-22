// =============================================================================
// P1 Hook: Commissions — TanStack React Query pattern
// File: src/hooks/useCommissions.ts
// Convention: Follows useContractors.ts exactly
// =============================================================================

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/context/AuthContext';
import * as S from '@/services/commission.service';

const useOrgId = () => useAuth().profile?.organization_id ?? null;

// ─── Queries ─────────────────────────────────────────────────────────────────

export const useCommissionStats = () => {
  const orgId = useOrgId();
  return useQuery({
    queryKey: ['commission-stats', orgId],
    queryFn: () => S.fetchCommissionStats(orgId!),
    enabled: !!orgId,
    staleTime: 30000,
  });
};

export const useCommissions = (filters?: {
    search?: string;
    status?: string;
    commission_type?: string;
    person_type?: string;
    project_id?: string;
    contractor_id?: string;
  }) => {
  const orgId = useOrgId();
  return useQuery({
    queryKey: [
      'commissions',
      orgId,
      filters?.search,
      filters?.status,
      filters?.commission_type,
      filters?.person_type,
      filters?.project_id,
      filters?.contractor_id,
    ],
    queryFn: () => S.fetchCommissions(orgId!, filters),
    enabled: !!orgId,
    staleTime: 15000,
  });
};

export const useCommissionByPerson = () => {
  const orgId = useOrgId();
  return useQuery({
    queryKey: ['commission-by-person', orgId],
    queryFn: () => S.fetchCommissionByPerson(orgId!),
    enabled: !!orgId,
    staleTime: 30000,
  });
};

export const useCommissionByProject = () => {
  const orgId = useOrgId();
  return useQuery({
    queryKey: ['commission-by-project', orgId],
    queryFn: () => S.fetchCommissionByProject(orgId!),
    enabled: !!orgId,
    staleTime: 30000,
  });
};

export const useCommissionByType = () => {
  const orgId = useOrgId();
  return useQuery({
    queryKey: ['commission-by-type', orgId],
    queryFn: () => S.fetchCommissionByType(orgId!),
    enabled: !!orgId,
    staleTime: 30000,
  });
};

export const useCommissionStatusSummary = () => {
  const orgId = useOrgId();
  return useQuery({
    queryKey: ['commission-status-summary', orgId],
    queryFn: () => S.fetchCommissionStatusSummary(orgId!),
    enabled: !!orgId,
    staleTime: 30000,
  });
};

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
  const orgId = useOrgId();
  return useMutation({
    mutationFn: ({ id, updates }: { id: string; updates: any }) => S.updateCommission(orgId!, id, updates),
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
