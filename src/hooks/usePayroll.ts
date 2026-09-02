// =============================================================================
// P1 Hook: Payroll — REWRITTEN to follow P0's TanStack React Query pattern
// Convention: P0 uses src/hooks/use*.ts with @tanstack/react-query
// ★★★ FIX #4: Converted from useState/useEffect to React Query pattern ★★★
// =============================================================================

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import * as S from '@/services/payroll.service';

// ─── Queries ─────────────────────────────────────────────────────────────────

export const usePayrollStats = () =>
  useQuery({
    queryKey: ['payroll-stats'],
    queryFn: S.fetchPayrollStats,
    staleTime: 30000,
  });

export const usePayrollEmployees = (search?: string) =>
  useQuery({
    queryKey: ['payroll-employees', search],
    queryFn: () => S.fetchEmployees(search),
    staleTime: 15000,
  });

export const usePayrollEmployeeWithCompensation = (employeeId: string | null) =>
  useQuery({
    queryKey: ['payroll-employee-detail', employeeId],
    queryFn: () => S.fetchEmployeeWithCompensation(employeeId!),
    enabled: !!employeeId,
    staleTime: 10000,
  });

export const usePayrollRuns = () =>
  useQuery({
    queryKey: ['payroll-runs'],
    queryFn: S.fetchPayrollRuns,
    staleTime: 15000,
  });

export const usePayrollLines = (runId: string | null) =>
  useQuery({
    queryKey: ['payroll-lines', runId],
    queryFn: () => S.fetchPayrollLines(runId!),
    enabled: !!runId,
    staleTime: 10000,
  });

export const usePayrollDeductions = (employeeId: string | null) =>
  useQuery({
    queryKey: ['payroll-deductions', employeeId],
    queryFn: () => S.fetchDeductions(employeeId!),
    enabled: !!employeeId,
    staleTime: 10000,
  });

export const usePayrollAdvances = () =>
  useQuery({
    queryKey: ['payroll-advances'],
    queryFn: S.fetchAdvances,
    staleTime: 15000,
  });

export const usePayrollCommissions = () =>
  useQuery({
    queryKey: ['payroll-commissions'],
    queryFn: S.fetchCommissions,
    staleTime: 15000,
  });

// ─── Mutations ───────────────────────────────────────────────────────────────

export const useCreatePayrollEmployee = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: any) => S.createEmployee(input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['payroll-employees'] });
      qc.invalidateQueries({ queryKey: ['payroll-stats'] });
    },
  });
};

export const useUpdatePayrollEmployee = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, updates }: { id: string; updates: any }) => S.updateEmployee(id, updates),
    onSuccess: (_, variables) => {
      qc.invalidateQueries({ queryKey: ['payroll-employees'] });
      qc.invalidateQueries({ queryKey: ['payroll-employee-detail', variables.id] });
    },
  });
};

export const useSetCompensation = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ employeeId, compData }: { employeeId: string; compData: any }) =>
      S.setCompensation(employeeId, compData),
    onSuccess: (_, variables) => {
      qc.invalidateQueries({ queryKey: ['payroll-employee-detail', variables.employeeId] });
      qc.invalidateQueries({ queryKey: ['payroll-employees'] });
    },
  });
};

export const useSetDeduction = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ employeeId, dedData }: { employeeId: string; dedData: any }) =>
      S.setDeduction(employeeId, dedData),
    onSuccess: (_, variables) => {
      qc.invalidateQueries({ queryKey: ['payroll-deductions', variables.employeeId] });
    },
  });
};