import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@/context/AuthContext';
import * as S from '@/services/dashboard.service';

const useOrgId = () => useAuth().profile?.organization_id ?? null;
const query = (key: string, fn: (orgId: string) => Promise<any>, staleTime?: number, refetchInterval?: number) => {
  const orgId = useOrgId();
  return useQuery({ queryKey: [key, orgId], queryFn: () => fn(orgId!), enabled: !!orgId, staleTime, refetchInterval });
};
export const useCEOKPIs = () => query('ceo-kpis', S.getCEOKPIs, undefined, 30000);
export const useMonthlyRevExp = () => query('ceo-monthly', S.getMonthlyRevExp, 60000);
export const useCategories = () => query('ceo-categories', S.getCategories, 60000);
export const useAging = () => query('ceo-aging', S.getAging, 60000);
export const useCashAccounts = () => query('ceo-cash', S.getCashAccounts, 30000);
export const useBudgetActual = () => query('ceo-budget', S.getBudgetActual, 60000);
export const useEquityTax = () => query('ceo-equity-tax', S.getEquityTax, 60000);
export const useAudit = () => query('ceo-audit', S.getAudit, 30000);
export const useFiscal = () => query('ceo-fiscal', S.getFiscal, 60000);
export const useApprovals = () => query('ceo-approvals', S.getPendingApprovals, undefined, 15000);
export const useUnreconciled = () => query('ceo-unreconciled', S.getUnreconciled);
export const useProjectProfit = () => query('ceo-proj-profit', S.getProjectProfit);
