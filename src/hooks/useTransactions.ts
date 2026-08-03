import { useQuery } from '@tanstack/react-query';
import * as S from '@/services/transaction.service';

export const useTransactionSummary = () =>
  useQuery({ queryKey: ['txn-summary'], queryFn: S.getTransactionSummary, staleTime: 30000 });

export const useTransactionList = (params: {
  search?: string; type?: string; status?: string;
  project_id?: string | null; date_from?: string | null;
  date_to?: string | null; limit?: number; offset?: number;
}) =>
  useQuery({
    queryKey: ['txn-list', params],
    queryFn: () => S.getTransactionList(params),
    staleTime: 15000,
  });

export const useTransactionDetail = (id: string | null) =>
  useQuery({
    queryKey: ['txn-detail', id],
    queryFn: () => S.getTransactionDetail(id!),
    enabled: !!id,
    staleTime: 10000,
  });