import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import * as svc from '@/types/services/tax-equity.service';

// ===== TAX PROFILE =====
export const useTaxpayerProfile = () => useQuery({
  queryKey: ['taxpayer_profile'],
  queryFn: () => svc.getTaxpayerProfile().then(r => r.data),
  staleTime: 10 * 60 * 1000,
});
export const useUpdateTaxpayerProfile = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...payload }: any) => svc.updateTaxpayerProfile(id, payload),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['taxpayer_profile'] }),
  });
};

// ===== TAX RULE SETS =====
export const useTaxRuleSets = () => useQuery({
  queryKey: ['tax_rule_sets'],
  queryFn: () => svc.getTaxRuleSets().then(r => r.data),
});
export const useTaxRuleSetWithSlabs = (id: string) => useQuery({
  queryKey: ['tax_rule_set', id],
  queryFn: () => svc.getTaxRuleSetWithSlabs(id).then(r => r.data),
  enabled: !!id,
});
export const useCreateTaxRuleSet = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: svc.createTaxRuleSet,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['tax_rule_sets'] }),
  });
};
export const useUpdateRuleSetStatus = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, status, userId }: any) => svc.updateTaxRuleSetStatus(id, status, userId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['tax_rule_sets'] });
      qc.invalidateQueries({ queryKey: ['tax_rule_set'] });  
    },
    onError: (err) => {
      console.error('Status update failed:', err);
    },
  });
};

// ===== TAX SLABS =====
export const useTaxSlabs = (ruleSetId: string) => useQuery({
  queryKey: ['tax_slabs', ruleSetId],
  queryFn: () => svc.getTaxSlabs(ruleSetId).then(r => r.data),
  enabled: !!ruleSetId,
});
export const useSaveTaxSlabs = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: svc.saveTaxSlabs,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['tax_slabs'] }),
  });
};
export const useDeleteTaxSlab = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: svc.deleteTaxSlab,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['tax_slabs'] }),
  });
};

// ===== TAX RECONCILIATIONS =====
export const useTaxReconciliations = () => useQuery({
  queryKey: ['tax_reconciliations'],
  queryFn: () => svc.getTaxReconciliations().then(r => r.data),
});
export const useTaxReconciliation = (id: string) => useQuery({
  queryKey: ['tax_reconciliation', id],
  queryFn: () => svc.getTaxReconciliation(id).then(r => r.data),
  enabled: !!id,
});
export const useCreateTaxReconciliation = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: svc.createTaxReconciliation,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['tax_reconciliations'] }),
  });
};
export const useUpdateTaxReconciliation = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...payload }: any) => svc.updateTaxReconciliation(id, payload),
    onSuccess: (_d, v) => {
      qc.invalidateQueries({ queryKey: ['tax_reconciliations'] });
      qc.invalidateQueries({ queryKey: ['tax_reconciliation', v.id] });
    },
  });
};
export const useComputeTax = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: svc.computeTax,
    onSuccess: (_d, id) => {
      qc.invalidateQueries({ queryKey: ['tax_reconciliation', id] });
      qc.invalidateQueries({ queryKey: ['tax_reconciliations'] });
    },
  });
};

// ===== TAX ADJUSTMENTS =====
export const useTaxAdjustments = (reconId: string) => useQuery({
  queryKey: ['tax_adjustments', reconId],
  queryFn: () => svc.getTaxAdjustments(reconId).then(r => r.data),
  enabled: !!reconId,
});
export const useAddTaxAdjustment = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: svc.addTaxAdjustment,
    onSuccess: (_d, v) => qc.invalidateQueries({ queryKey: ['tax_adjustments', v.tax_reconciliation_id] }),
  });
};
export const useUpdateTaxAdjustment = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...payload }: any) => svc.updateTaxAdjustment(id, payload),
    onSuccess: (_d, v) => qc.invalidateQueries({ queryKey: ['tax_adjustments', v.tax_reconciliation_id] }),
  });
};
export const useDeleteTaxAdjustment = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: svc.deleteTaxAdjustment,
    onSuccess: (_d, v: any) => qc.invalidateQueries({ queryKey: ['tax_adjustments', v.tax_reconciliation_id] }),
  });
};

// ===== OWNERS =====
export const useOwners = () => useQuery({
  queryKey: ['owners'],
  queryFn: () => svc.getOwners().then(r => r.data),
});
export const useCreateOwner = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: svc.createOwner,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['owners'] });
      qc.invalidateQueries({ queryKey: ['ownership_history'] });
    },
  });
};
export const useUpdateOwner = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...payload }: any) => svc.updateOwner(id, payload),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['owners'] }),
  });
};

// ===== OWNERSHIP HISTORY =====
export const useOwnershipHistory = () => useQuery({
  queryKey: ['ownership_history'],
  queryFn: () => svc.getOwnershipHistory().then(r => r.data),
});
export const useAddOwnershipEntry = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: svc.addOwnershipEntry,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['ownership_history'] });
      qc.invalidateQueries({ queryKey: ['owners'] });
    },
  });
};

// ===== RESERVE POLICIES =====
export const useReservePolicies = () => useQuery({
  queryKey: ['reserve_policies'],
  queryFn: () => svc.getReservePolicies().then(r => r.data),
});
export const useCreateReservePolicy = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: svc.createReservePolicy,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['reserve_policies'] }),
  });
};
export const useUpdateReservePolicy = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...payload }: any) => svc.updateReservePolicy(id, payload),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['reserve_policies'] }),
  });
};
export const useCalculateReserve = () => useMutation({
  mutationFn: ({ profit, date }: { profit: number; date?: string }) =>
    svc.calculateReserve(profit, date),
});

// ===== PROFIT DISTRIBUTIONS =====
export const useProfitDistributions = () => useQuery({
  queryKey: ['profit_distributions'],
  queryFn: () => svc.getProfitDistributions().then(r => r.data),
});
export const useProfitDistributionDetail = (id: string) => useQuery({
  queryKey: ['profit_distribution', id],
  queryFn: () => svc.getProfitDistributionWithLines(id).then(r => r.data),
  enabled: !!id,
});
export const useCreateProfitDistribution = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: svc.createProfitDistribution,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['profit_distributions'] }),
  });
};
export const useUpdateProfitDistribution = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...payload }: any) => svc.updateProfitDistribution(id, payload),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['profit_distributions'] }),
  });
};
export const useSaveDistributionLines = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: svc.saveDistributionLines,
    onSuccess: (_d, v: any) => {
      const distId = v?.[0]?.profit_distribution_id;
      if (distId) qc.invalidateQueries({ queryKey: ['profit_distribution', distId] });
    },
  });
};
export const usePostProfitDistribution = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ distId, periodId, date }: { distId: string; periodId: string; date: string }) => 
      svc.postProfitDistribution(distId, periodId, date),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['profit_distributions'] }),
  });
};


// ===== DROPDOWNS =====
export const useFiscalYears = () => useQuery({
  queryKey: ['fiscal_years'],
  queryFn: () => svc.getFiscalYears().then(r => r.data),
  staleTime: 10 * 60 * 1000,
});
export const useOpenPeriod = () => useQuery({
  queryKey: ['open_period'],
  queryFn: () => svc.getOpenPeriod().then(r => r.data),
  staleTime: 5 * 60 * 1000,
});
export const useExpenseAccounts = () => useQuery({
  queryKey: ['expense_accounts'],
  queryFn: () => svc.getExpenseAccounts().then(r => r.data),
  staleTime: 10 * 60 * 1000,
});