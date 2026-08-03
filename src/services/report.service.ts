import { supabase } from '@/lib/supabase';
import type { PLData, BSData, CFData, AgingData, ProjectProfitRow, TaxReportData } from '@/types/reports.types';

export const getProfitAndLoss = async (start?: string, end?: string) => {
  const { data, error } = await supabase.rpc('profit_and_loss', {
    p_start: start || null, p_end: end || null
  });
  if (error) throw new Error(error.message);
  return data as PLData;
};

export const getBalanceSheet = async () => {
  const { data, error } = await supabase.rpc('balance_sheet');
  if (error) throw new Error(error.message);
  return data as BSData;
};

export const getCashFlow = async (start?: string, end?: string) => {
  const { data, error } = await supabase.rpc('cash_flow', {
    p_start: start || null, p_end: end || null
  });
  if (error) throw new Error(error.message);
  return data as CFData;
};

export const getAgingReport = async () => {
  const { data, error } = await supabase.rpc('aging_report');
  if (error) throw new Error(error.message);
  return data as AgingData;
};

// ... existing functions remain ...

export const getProjectProfitability = async (start?: string, end?: string) => {
  const { data, error } = await supabase.rpc('project_profitability_report', {
    p_start: start || null, p_end: end || null
  });
  if (error) throw new Error(error.message);
  return (data || []) as ProjectProfitRow[];
};

export const getTaxReport = async (taxYear?: string) => {
  const { data, error } = await supabase.rpc('tax_report', {
    p_tax_year: taxYear || null
  });
  if (error) throw new Error(error.message);
  return data as TaxReportData;
};

export default {
  getProfitAndLoss,
  getBalanceSheet,
  getCashFlow,
  getAgingReport,
  getProjectProfitability,
  getTaxReport,
};