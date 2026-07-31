// services/dashboard.service.ts

import { supabase } from '@/lib/supabase';
import type {
  CEOKPIs, PendingApproval, UnreconciledItem, ProjectProfit,
  AgingBoth, CashAccount, MonthlyRevenue, CategoriesData,
  ShareholderData, TaxData, AuditEntry, FiscalPeriod, BudgetData
} from '@/types/dashboard.types';

export const getCEOKPIs = async () => {
  const { data, error } = await supabase.rpc('ceo_dashboard_kpis');
  if (error) throw new Error(error.message);
  return data as CEOKPIs;
};

export const getPendingApprovals = async () => {
  const { data, error } = await supabase.rpc('pending_approvals_list');
  if (error) throw new Error(error.message);
  return (data || []) as PendingApproval[];
};

export const getUnreconciled = async () => {
  const { data, error } = await supabase.rpc('unreconciled_summary');
  if (error) throw new Error(error.message);
  return (data || []) as UnreconciledItem[];
};

export const getProjectProfit = async () => {
  const { data, error } = await supabase.rpc('project_profitability');
  if (error) throw new Error(error.message);
  return (data || []) as ProjectProfit[];
};

// FIXED: RPC name + return type
export const getAging = async () => {
  const { data, error } = await supabase.rpc('ceo_chart_aging');
  if (error) throw new Error(error.message);
  return data as AgingBoth;
};

// FIXED: RPC name
export const getMonthlyRevExp = async () => {
  const { data, error } = await supabase.rpc('ceo_chart_monthly');
  if (error) throw new Error(error.message);
  return (data || []) as MonthlyRevenue[];
};

export const getCategories = async () => {
  const { data, error } = await supabase.rpc('ceo_chart_categories');
  if (error) throw new Error(error.message);
  return data as CategoriesData;
};

export const getCashAccounts = async () => {
  const { data, error } = await supabase.rpc('ceo_chart_cash');
  if (error) throw new Error(error.message);
  return (data || []) as CashAccount[];
};

export const getBudgetActual = async () => {
  const { data, error } = await supabase.rpc('ceo_chart_budget');
  if (error) throw new Error(error.message);
  return (data || []) as BudgetData[];
};

export const getEquityTax = async () => {
  const { data, error } = await supabase.rpc('ceo_table_equity_tax');
  if (error) throw new Error(error.message);
  return data as { shareholders: ShareholderData[]; tax: TaxData };
};

export const getAudit = async () => {
  const { data, error } = await supabase.rpc('ceo_table_audit');
  if (error) throw new Error(error.message);
  return (data || []) as AuditEntry[];
};

export const getFiscal = async () => {
  const { data, error } = await supabase.rpc('ceo_table_fiscal');
  if (error) throw new Error(error.message);
  return (data || []) as FiscalPeriod[];
};