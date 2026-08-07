// =============================================================================
// P1 Hook: Subscriptions — TanStack React Query pattern
// File: src/hooks/useSubscriptions.ts
// Convention: Follows usepayroll.ts exactly
// =============================================================================

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import * as S from '@/services/subscription.service';

// ─── Queries ─────────────────────────────────────────────────────────────────

export const useSubscriptionStats = () =>
  useQuery({
    queryKey: ['subscription-stats'],
    queryFn: S.fetchSubscriptionStats,
    staleTime: 30000,
  });

export const useSubscriptions = (filters?: {
  search?: string;
  category?: string;
  status?: string;
}) =>
  useQuery({
    queryKey: ['subscriptions', filters],
    queryFn: () => S.fetchSubscriptions(filters),
    staleTime: 15000,
  });

export const useUpcomingRenewals = () =>
  useQuery({
    queryKey: ['subscription-renewals'],
    queryFn: S.fetchUpcomingRenewals,
    staleTime: 15000,
  });

export const useSpendSummary = () =>
  useQuery({
    queryKey: ['subscription-spend'],
    queryFn: S.fetchSpendSummary,
    staleTime: 30000,
  });

// ─── Mutations ───────────────────────────────────────────────────────────────

export const useCreateSubscription = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: Record<string, any>) => S.createSubscription(input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['subscriptions'] });
      qc.invalidateQueries({ queryKey: ['subscription-stats'] });
      qc.invalidateQueries({ queryKey: ['subscription-renewals'] });
      qc.invalidateQueries({ queryKey: ['subscription-spend'] });
    },
  });
};

export const useUpdateSubscription = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, updates }: { id: string; updates: Record<string, any> }) =>
      S.updateSubscription(id, updates),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['subscriptions'] });
      qc.invalidateQueries({ queryKey: ['subscription-stats'] });
      qc.invalidateQueries({ queryKey: ['subscription-renewals'] });
      qc.invalidateQueries({ queryKey: ['subscription-spend'] });
    },
  });
};

export const useDeleteSubscription = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => S.deleteSubscription(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['subscriptions'] });
      qc.invalidateQueries({ queryKey: ['subscription-stats'] });
      qc.invalidateQueries({ queryKey: ['subscription-renewals'] });
      qc.invalidateQueries({ queryKey: ['subscription-spend'] });
    },
  });
};
