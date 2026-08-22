import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/context/AuthContext';
import * as svc from '../services/tax-equity.service';

const useOrgId = () => {
  const { user, profile } = useAuth();
  return { user, orgId: profile?.organization_id ?? null };
};

// ===== TAX PROFILE =====
export const useTaxpayerProfile = () => {
  const { orgId } = useOrgId();
  return useQuery({ queryKey: ['taxpayer_profile', orgId], queryFn: () => svc.getTaxpayerProfile(orgId!).then(r => r.data), enabled: !!orgId, staleTime: 10 * 60 * 1000 });
};
export const useUpdateTaxpayerProfile = () => {
  const qc = useQueryClient();
  return useMutation({ mutationFn: ({ id, ...payload }: any) => svc.updateTaxpayerProfile(id, payload), onSuccess: () => qc.invalidateQueries({ queryKey: ['taxpayer_profile'] }) });
};

// ===== TAX RULE SETS =====
export const useTaxRuleSets = () => {
  const { orgId } = useOrgId();
  return useQuery({ queryKey: ['tax_rule_sets', orgId], queryFn: () => svc.getTaxRuleSets(orgId!).then(r => r.data), enabled: !!orgId });
};
export const useTaxRuleSetWithSlabs = (id: string) => {
  const { orgId } = useOrgId();
  return useQuery({ queryKey: ['tax_rule_set', orgId, id], queryFn: () => svc.getTaxRuleSetWithSlabs(orgId!, id).then(r => r.data), enabled: !!id && !!orgId });
};
export const useCreateTaxRuleSet = () => {
  const qc = useQueryClient(); const { orgId, user } = useOrgId();
  return useMutation({ mutationFn: (payload: any) => svc.createTaxRuleSet(orgId!, { ...payload, created_by: payload.created_by || user?.id }), onSuccess: () => qc.invalidateQueries({ queryKey: ['tax_rule_sets'] }) });
};
export const useUpdateRuleSetStatus = () => {
  const qc = useQueryClient();
  return useMutation({ mutationFn: ({ id, status, userId }: any) => svc.updateTaxRuleSetStatus(id, status, userId), onSuccess: () => { qc.invalidateQueries({ queryKey: ['tax_rule_sets'] }); qc.invalidateQueries({ queryKey: ['tax_rule_set'] }); }, onError: (err) => console.error('Status update failed:', err) });
};

// ===== TAX SLABS =====
export const useTaxSlabs = (ruleSetId: string) => {
  const { orgId } = useOrgId();
  return useQuery({ queryKey: ['tax_slabs', orgId, ruleSetId], queryFn: () => svc.getTaxSlabs(orgId!, ruleSetId).then(r => r.data), enabled: !!ruleSetId && !!orgId });
};
export const useSaveTaxSlabs = () => {
  const qc = useQueryClient(); const { orgId } = useOrgId();
  return useMutation({ mutationFn: (slabs: any[]) => svc.saveTaxSlabs(orgId!, slabs), onSuccess: () => qc.invalidateQueries({ queryKey: ['tax_slabs'] }) });
};
export const useDeleteTaxSlab = () => {
  const qc = useQueryClient();
  return useMutation({ mutationFn: svc.deleteTaxSlab, onSuccess: () => qc.invalidateQueries({ queryKey: ['tax_slabs'] }) });
};

// ===== TAX RECONCILIATIONS =====
export const useTaxReconciliations = () => {
  const { orgId } = useOrgId();
  return useQuery({ queryKey: ['tax_reconciliations', orgId], queryFn: () => svc.getTaxReconciliations(orgId!).then(r => r.data), enabled: !!orgId });
};
export const useTaxReconciliation = (id: string) => {
  const { orgId } = useOrgId();
  return useQuery({ queryKey: ['tax_reconciliation', orgId, id], queryFn: () => svc.getTaxReconciliation(orgId!, id).then(r => r.data), enabled: !!id && !!orgId });
};
export const useCreateTaxReconciliation = () => {
  const qc = useQueryClient(); const { orgId } = useOrgId();
  return useMutation({ mutationFn: (payload: any) => svc.createTaxReconciliation(orgId!, payload), onSuccess: () => qc.invalidateQueries({ queryKey: ['tax_reconciliations'] }) });
};
export const useUpdateTaxReconciliation = () => {
  const qc = useQueryClient();
  return useMutation({ mutationFn: ({ id, ...payload }: any) => svc.updateTaxReconciliation(id, payload), onSuccess: (_d, v) => { qc.invalidateQueries({ queryKey: ['tax_reconciliations'] }); qc.invalidateQueries({ queryKey: ['tax_reconciliation', v.id] }); } });
};
export const useComputeTax = () => {
  const qc = useQueryClient(); const { orgId } = useOrgId();
  return useMutation({ mutationFn: (reconId: string) => svc.computeTax(orgId!, reconId), onSuccess: (_d, id) => { qc.invalidateQueries({ queryKey: ['tax_reconciliation', id] }); qc.invalidateQueries({ queryKey: ['tax_reconciliations'] }); } });
};

// ===== TAX ADJUSTMENTS =====
export const useTaxAdjustments = (reconId: string) => {
  const { orgId } = useOrgId();
  return useQuery({ queryKey: ['tax_adjustments', orgId, reconId], queryFn: () => svc.getTaxAdjustments(orgId!, reconId).then(r => r.data), enabled: !!reconId && !!orgId });
};
export const useAddTaxAdjustment = () => {
  const qc = useQueryClient(); const { orgId } = useOrgId();
  return useMutation({ mutationFn: (payload: any) => svc.addTaxAdjustment(orgId!, payload), onSuccess: (_d, v) => qc.invalidateQueries({ queryKey: ['tax_adjustments', orgId, v.tax_reconciliation_id] }) });
};
export const useUpdateTaxAdjustment = () => {
  const qc = useQueryClient();
  return useMutation({ mutationFn: ({ id, ...payload }: any) => svc.updateTaxAdjustment(id, payload), onSuccess: (_d, v) => qc.invalidateQueries({ queryKey: ['tax_adjustments', v.tax_reconciliation_id] }) });
};
export const useDeleteTaxAdjustment = () => {
  const qc = useQueryClient();
  return useMutation({ mutationFn: svc.deleteTaxAdjustment, onSuccess: (_d, v: any) => qc.invalidateQueries({ queryKey: ['tax_adjustments', v.tax_reconciliation_id] }) });
};

// ===== OWNERS =====
export const useOwners = () => { const { orgId } = useOrgId(); return useQuery({ queryKey: ['owners', orgId], queryFn: () => svc.getOwners(orgId!).then(r => r.data), enabled: !!orgId }); };
export const useCreateOwner = () => { const qc = useQueryClient(); const { orgId } = useOrgId(); return useMutation({ mutationFn: (payload: any) => svc.createOwner(orgId!, payload), onSuccess: () => { qc.invalidateQueries({ queryKey: ['owners'] }); qc.invalidateQueries({ queryKey: ['ownership_history'] }); } }); };
export const useUpdateOwner = () => { const qc = useQueryClient(); return useMutation({ mutationFn: ({ id, ...payload }: any) => svc.updateOwner(id, payload), onSuccess: () => qc.invalidateQueries({ queryKey: ['owners'] }) }); };

// ===== OWNERSHIP HISTORY =====
export const useOwnershipHistory = () => { const { orgId } = useOrgId(); return useQuery({ queryKey: ['ownership_history', orgId], queryFn: () => svc.getOwnershipHistory(orgId!).then(r => r.data), enabled: !!orgId }); };
export const useAddOwnershipEntry = () => { const qc = useQueryClient(); const { orgId } = useOrgId(); return useMutation({ mutationFn: (payload: any) => svc.addOwnershipEntry(orgId!, payload), onSuccess: () => { qc.invalidateQueries({ queryKey: ['ownership_history'] }); qc.invalidateQueries({ queryKey: ['owners'] }); } }); };

// ===== RESERVE POLICIES =====
export const useReservePolicies = () => { const { orgId } = useOrgId(); return useQuery({ queryKey: ['reserve_policies', orgId], queryFn: () => svc.getReservePolicies(orgId!).then(r => r.data), enabled: !!orgId }); };
export const useCreateReservePolicy = () => { const qc = useQueryClient(); const { orgId } = useOrgId(); return useMutation({ mutationFn: (payload: any) => svc.createReservePolicy(orgId!, payload), onSuccess: () => qc.invalidateQueries({ queryKey: ['reserve_policies'] }) }); };
export const useUpdateReservePolicy = () => { const qc = useQueryClient(); return useMutation({ mutationFn: ({ id, ...payload }: any) => svc.updateReservePolicy(id, payload), onSuccess: () => qc.invalidateQueries({ queryKey: ['reserve_policies'] }) }); };
export const useCalculateReserve = () => { const { orgId } = useOrgId(); return useMutation({ mutationFn: ({ profit, date }: { profit: number; date?: string }) => svc.calculateReserve(orgId!, profit, date) }); };

// ===== PROFIT DISTRIBUTIONS =====
export const useProfitDistributions = () => { const { orgId } = useOrgId(); return useQuery({ queryKey: ['profit_distributions', orgId], queryFn: () => svc.getProfitDistributions(orgId!).then(r => r.data), enabled: !!orgId }); };
export const useProfitDistributionDetail = (id: string) => { const { orgId } = useOrgId(); return useQuery({ queryKey: ['profit_distribution', orgId, id], queryFn: () => svc.getProfitDistributionWithLines(orgId!, id).then(r => r.data), enabled: !!id && !!orgId }); };
export const useCreateProfitDistribution = () => { const qc = useQueryClient(); const { orgId } = useOrgId(); return useMutation({ mutationFn: (payload: any) => svc.createProfitDistribution(orgId!, payload), onSuccess: () => qc.invalidateQueries({ queryKey: ['profit_distributions'] }) }); };
export const useUpdateProfitDistribution = () => { const qc = useQueryClient(); return useMutation({ mutationFn: ({ id, ...payload }: any) => svc.updateProfitDistribution(id, payload), onSuccess: () => qc.invalidateQueries({ queryKey: ['profit_distributions'] }) }); };
export const useSaveDistributionLines = () => { const qc = useQueryClient(); const { orgId } = useOrgId(); return useMutation({ mutationFn: (lines: any[]) => svc.saveDistributionLines(orgId!, lines), onSuccess: (_d, v: any) => { const distId = v?.[0]?.profit_distribution_id; if (distId) qc.invalidateQueries({ queryKey: ['profit_distribution', distId] }); } }); };
export const usePostProfitDistribution = () => { const qc = useQueryClient(); const { orgId } = useOrgId(); return useMutation({ mutationFn: ({ distId, periodId, date }: { distId: string; periodId: string; date: string }) => svc.postProfitDistribution(orgId!, distId, periodId, date), onSuccess: () => qc.invalidateQueries({ queryKey: ['profit_distributions'] }) }); };

// ===== DROPDOWNS =====
export const useFiscalYears = () => { const { orgId } = useOrgId(); return useQuery({ queryKey: ['fiscal_years', orgId], queryFn: () => svc.getFiscalYears(orgId!).then(r => r.data), enabled: !!orgId, staleTime: 10 * 60 * 1000 }); };
export const useOpenPeriod = () => { const { orgId } = useOrgId(); return useQuery({ queryKey: ['open_period', orgId], queryFn: () => svc.getOpenPeriod(orgId!).then(r => r.data), enabled: !!orgId, staleTime: 5 * 60 * 1000 }); };
export const useExpenseAccounts = () => { const { orgId } = useOrgId(); return useQuery({ queryKey: ['expense_accounts', orgId], queryFn: () => svc.getExpenseAccounts(orgId!).then(r => r.data), enabled: !!orgId, staleTime: 10 * 60 * 1000 }); };
