import { reportingDB, financeDB, auditDB } from '@/lib/supabase';
import type {
  CEOKPIs, PendingApproval, UnreconciledItem, ProjectProfit,
  AgingBoth, CashAccount, MonthlyRevenue, CategoriesData,
  ShareholderData, TaxData, AuditEntry, FiscalPeriod, BudgetData
} from '@/types/dashboard.types';

export const getCEOKPIs = async (orgId: string) => {
  const { data, error } = await reportingDB.rpc('ceo_dashboard_kpis', {
    p_organization_id: orgId,
  });
  if (error) throw new Error(error.message);
  return data as CEOKPIs;
};

export const getPendingApprovals = async (orgId: string) => {
  const { data, error } = await reportingDB.rpc('pending_approvals_list', {
    p_organization_id: orgId,
  });
  if (error) throw new Error(error.message);
  return (data || []) as PendingApproval[];
};

export const getUnreconciled = async (orgId: string) => {
  const { data, error } = await reportingDB.rpc('unreconciled_summary', {
    p_organization_id: orgId,
  });
  if (error) throw new Error(error.message);
  return (data || []) as UnreconciledItem[];
};

export const getProjectProfit = async (orgId: string) => {
  const { data, error } = await reportingDB.rpc('project_profitability', {
    p_organization_id: orgId,
  });
  if (error) throw new Error(error.message);
  return (data || []) as ProjectProfit[];
};

export const getAging = async (orgId: string) => {
  const { data, error } = await reportingDB.rpc('ceo_chart_aging', {
    p_organization_id: orgId,
  });
  if (error) throw new Error(error.message);
  return data as AgingBoth;
};

export const getMonthlyRevExp = async (orgId: string) => {
  const { data, error } = await reportingDB.rpc('ceo_chart_monthly', {
    p_organization_id: orgId,
  });
  if (error) throw new Error(error.message);
  return (data || []) as MonthlyRevenue[];
};

export const getCategories = async (orgId: string) => {
  const { data, error } = await reportingDB.rpc('ceo_chart_categories', {
    p_organization_id: orgId,
  });
  if (error) throw new Error(error.message);
  return data as CategoriesData;
};

export const getCashAccounts = async (orgId: string) => {
  const { data, error } = await reportingDB.rpc('ceo_chart_cash', {
    p_organization_id: orgId,
  });
  if (error) throw new Error(error.message);
  return (data || []) as CashAccount[];
};

export const getBudgetActual = async (orgId: string) => {
  const { data, error } = await reportingDB.rpc('ceo_chart_budget', {
    p_organization_id: orgId,
  });
  if (error) throw new Error(error.message);
  return (data || []) as BudgetData[];
};

export const getEquityTax = async (orgId: string) => {
  const { data, error } = await reportingDB.rpc('ceo_table_equity_tax', {
    p_organization_id: orgId,
  });
  if (error) throw new Error(error.message);
  return data as { shareholders: ShareholderData[]; tax: TaxData };
};

export const getAudit = async (orgId: string) => {
  const { data, error } = await reportingDB.rpc('ceo_table_audit', {
    p_organization_id: orgId,
  });
  if (error) throw new Error(error.message);
  return (data || []) as AuditEntry[];
};

export const getFiscal = async (orgId: string) => {
  const { data, error } = await reportingDB.rpc('ceo_table_fiscal', {
    p_organization_id: orgId,
  });
  if (error) throw new Error(error.message);
  return (data || []) as FiscalPeriod[];
};