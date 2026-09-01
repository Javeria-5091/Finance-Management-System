import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/context/AuthContext';
import * as bankService from '../services/bank.service';

const useOrgId = () => useAuth().profile?.organization_id ?? null;

// ==================== ACCOUNTS ====================

export const useFinancialAccounts = () => {
  const orgId = useOrgId();
  return useQuery({
    queryKey: ['financial_accounts', orgId],
    queryFn: () => bankService.getFinancialAccounts(orgId!).then(r => r.data),
    enabled: !!orgId,
  });
};

export const useReconciliationSummary = () => {
  const orgId = useOrgId();
  return useQuery({
    queryKey: ['reconciliation_summary', orgId],
    queryFn: () => bankService.getReconciliationSummary(orgId!).then(r => r.data),
    enabled: !!orgId,
  });
};

export const useAssetAccounts = () => {
  const orgId = useOrgId();
  return useQuery({
    queryKey: ['asset_accounts', orgId],
    queryFn: () => bankService.getAssetAccounts(orgId!).then(r => r.data),
    enabled: !!orgId,
  });
};


export const useDeactivateAccount = () => {
  const qc = useQueryClient();
  const orgId = useOrgId();

  return useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) => {
      if (!orgId) throw new Error('Organization context is required');
      return bankService.deactivateFinancialAccount(id, orgId, reason);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['financial_accounts'] });
      qc.invalidateQueries({ queryKey: ['reconciliation_summary'] });
    },
  });
};

export const useCreateAccount = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: bankService.createFinancialAccount,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['financial_accounts'] });
      qc.invalidateQueries({ queryKey: ['reconciliation_summary'] });
    },
  });
};

// ==================== STATEMENTS ====================

export const useBankStatements = (accountId: string) => {
  const orgId = useOrgId();
  return useQuery({
    queryKey: ['bank_statements', accountId],
    queryFn: () => bankService.getBankStatements(orgId!, accountId).then(r => r.data),
    enabled: !!accountId && !!orgId,
  });
};

export const useStatementLines = (statementId: string) => {
  const orgId = useOrgId();
  return useQuery({
    queryKey: ['statement_lines', statementId],
    queryFn: () => bankService.getStatementLines(orgId!, statementId).then(r => r.data),
    enabled: !!statementId && !!orgId,
  });
};

// FND-BANK-03 FIX: single atomic import (statement header + every line
// in one DB transaction, server-resolved organization_id, duplicate
// lines skipped) replacing the previous two-hook / two-request flow.
export const useImportBankStatement = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: bankService.importBankStatement,
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: ['bank_statements', variables.financial_account_id] });
      qc.invalidateQueries({ queryKey: ['statement_lines'] });
      qc.invalidateQueries({ queryKey: ['reconciliation_summary'] });
    },
  });
};

// ==================== RECONCILIATION ====================

export const useAutoMatch = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: bankService.runAutoMatch,
    onSuccess: (_data, statementId) => {
      qc.invalidateQueries({ queryKey: ['statement_lines', statementId] });
      qc.invalidateQueries({ queryKey: ['bank_statements'] });
      qc.invalidateQueries({ queryKey: ['reconciliation_summary'] });
    },
  });
};

export const useDetectDuplicates = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: bankService.detectDuplicates,
    onSuccess: (_data, statementId) => {
      qc.invalidateQueries({ queryKey: ['statement_lines', statementId] });
    },
  });
};

export const useManualMatch = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ lineId, journalLineId, reason }: { lineId: string; journalLineId: string; reason?: string }) =>
      bankService.manualMatchLine(lineId, journalLineId, reason),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ['statement_lines'] });
      qc.invalidateQueries({ queryKey: ['reconciliation_summary'] });
    },
  });
};

export const useUnmatchLine = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: bankService.unmatchLine,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['statement_lines'] });
      qc.invalidateQueries({ queryKey: ['reconciliation_summary'] });
    },
  });
};

export const useExcludeLine = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ lineId, reason }: { lineId: string; reason: string }) =>
      bankService.excludeLine(lineId, reason),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['statement_lines'] });
      qc.invalidateQueries({ queryKey: ['reconciliation_summary'] });
    },
  });
};

export const useFinalizeReconciliation = () => {
  const qc = useQueryClient();
  const { profile } = useAuth();
  return useMutation({
    mutationFn: (statementId: string) => {
      if (!profile?.organization_id || !profile?.user_id) throw new Error('Authentication context is unavailable');
      return bankService.finalizeReconciliation(statementId, profile.user_id, profile.organization_id);
    },
    onSuccess: (_data, statementId) => {
      qc.invalidateQueries({ queryKey: ['bank_statements'] });
      qc.invalidateQueries({ queryKey: ['statement_lines', statementId] });
      qc.invalidateQueries({ queryKey: ['reconciliation_summary'] });
    },
  });
};

// ==================== TRANSFERS ====================

export const useBankTransfers = () => {
  const orgId = useOrgId();
  return useQuery({
    queryKey: ['bank_transfers', orgId],
    queryFn: () => bankService.getBankTransfers(orgId!).then(r => r.data),
    enabled: !!orgId,
  });
};

export const useCreateTransfer = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: bankService.createBankTransfer,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['bank_transfers'] });
    },
  });
};

export const useUpdateTransferStatus = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, updates }: { id: string; updates: any }) =>
      bankService.updateTransferStatus(id, updates),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['bank_transfers'] });
    },
  });
};

export const usePostTransfer = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ transferId, periodId, date }: { transferId: string; periodId: string; date: string }) =>
      bankService.postBankTransfer(transferId, periodId, date),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['bank_transfers'] });
      qc.invalidateQueries({ queryKey: ['reconciliation_summary'] });
    },
  });
};

export const useOpenPeriod = () => {
  const orgId = useOrgId();
  return useQuery({
    queryKey: ['open_period', orgId],
    queryFn: () => bankService.getOpenPeriod(orgId!).then(r => r.data),
    enabled: !!orgId,
    staleTime: 5 * 60 * 1000,
  });
};
export const useReverseTransfer = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ transferId, reversalDate, reason }: { transferId: string; reversalDate: string; reason: string }) =>
      bankService.reverseBankTransfer(transferId, reversalDate, reason),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['bank_transfers'] });
      qc.invalidateQueries({ queryKey: ['reconciliation_summary'] });
    },
  });
};
