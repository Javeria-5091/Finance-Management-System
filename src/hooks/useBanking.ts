import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import * as bankService from '@/types/services/bank.service';

// ==================== ACCOUNTS ====================

export const useFinancialAccounts = () => {
  return useQuery({
    queryKey: ['financial_accounts'],
    queryFn: () => bankService.getFinancialAccounts().then(r => r.data),
  });
};

export const useReconciliationSummary = () => {
  return useQuery({
    queryKey: ['reconciliation_summary'],
    queryFn: () => bankService.getReconciliationSummary().then(r => r.data),
  });
};

export const useAssetAccounts = () => {
  return useQuery({
    queryKey: ['asset_accounts'],
    queryFn: () => bankService.getAssetAccounts().then(r => r.data),
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
  return useQuery({
    queryKey: ['bank_statements', accountId],
    queryFn: () => bankService.getBankStatements(accountId).then(r => r.data),
    enabled: !!accountId,
  });
};

export const useStatementLines = (statementId: string) => {
  return useQuery({
    queryKey: ['statement_lines', statementId],
    queryFn: () => bankService.getStatementLines(statementId).then(r => r.data),
    enabled: !!statementId,
  });
};

export const useCreateStatement = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: bankService.createBankStatement,
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: ['bank_statements', variables.financial_account_id] });
    },
  });
};

export const useImportLines = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: bankService.importStatementLines,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['statement_lines'] });
      qc.invalidateQueries({ queryKey: ['bank_statements'] });
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

// ==================== TRANSFERS ====================

export const useBankTransfers = () => {
  return useQuery({
    queryKey: ['bank_transfers'],
    queryFn: () => bankService.getBankTransfers().then(r => r.data),
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
  return useQuery({
    queryKey: ['open_period'],
    queryFn: () => bankService.getOpenPeriod().then(r => r.data),
    staleTime: 5 * 60 * 1000,
  });
};