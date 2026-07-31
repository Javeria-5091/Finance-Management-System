// hooks/useDashboard.ts

import { useQuery } from '@tanstack/react-query';
import * as S from '@/services/dashboard.service';

export const useCEOKPIs = () =>
  useQuery({ queryKey: ['ceo-kpis'], queryFn: S.getCEOKPIs, refetchInterval: 30000 });

export const useMonthlyRevExp = () =>
  useQuery({ queryKey: ['ceo-monthly'], queryFn: S.getMonthlyRevExp, staleTime: 60000 });

export const useCategories = () =>
  useQuery({ queryKey: ['ceo-categories'], queryFn: S.getCategories, staleTime: 60000 });

export const useAging = () =>
  useQuery({ queryKey: ['ceo-aging'], queryFn: S.getAging, staleTime: 60000 });

export const useCashAccounts = () =>
  useQuery({ queryKey: ['ceo-cash'], queryFn: S.getCashAccounts, staleTime: 30000 });

export const useBudgetActual = () =>
  useQuery({ queryKey: ['ceo-budget'], queryFn: S.getBudgetActual, staleTime: 60000 });

export const useEquityTax = () =>
  useQuery({ queryKey: ['ceo-equity-tax'], queryFn: S.getEquityTax, staleTime: 60000 });

export const useAudit = () =>
  useQuery({ queryKey: ['ceo-audit'], queryFn: S.getAudit, staleTime: 30000 });

export const useFiscal = () =>
  useQuery({ queryKey: ['ceo-fiscal'], queryFn: S.getFiscal, staleTime: 60000 });

export const useApprovals = () =>
  useQuery({ queryKey: ['ceo-approvals'], queryFn: S.getPendingApprovals, refetchInterval: 15000 });

export const useUnreconciled = () =>
  useQuery({ queryKey: ['ceo-unreconciled'], queryFn: S.getUnreconciled });

export const useProjectProfit = () =>
  useQuery({ queryKey: ['ceo-proj-profit'], queryFn: S.getProjectProfit });