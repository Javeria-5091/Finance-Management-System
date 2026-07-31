import { supabase } from '@/lib/supabase';
import type { 
  CEODashboardMetrics, 
  ProfitAndLossRow, 
  BalanceSheetRow, 
  CashFlowRow, 
  ProjectProfitabilityRow 
} from '@/types/accounting.types';

const db = () => supabase.schema('reporting');

export const reportService = {
  getCEOMetrics: async (): Promise<CEODashboardMetrics> => {
    const { data, error } = await db().rpc('get_ceo_metrics');
    if (error) throw error;
    return data[0];
  },

  getProfitAndLoss: async (startDate: string, endDate: string): Promise<ProfitAndLossRow[]> => {
    const { data, error } = await db().rpc('get_profit_and_loss', {
      p_start_date: startDate,
      p_end_date: endDate,
    });
    if (error) throw error;
    return data ?? [];
  },

  getBalanceSheet: async (asOfDate: string): Promise<BalanceSheetRow[]> => {
    const { data, error } = await db().rpc('get_balance_sheet', {
      p_as_of_date: asOfDate,
    });
    if (error) throw error;
    return data ?? [];
  },

  getCashFlow: async (startDate: string, endDate: string): Promise<CashFlowRow[]> => {
    const { data, error } = await db().rpc('get_cash_flow', {
      p_start_date: startDate,
      p_end_date: endDate,
    });
    if (error) throw error;
    return data ?? [];
  },

  getProjectProfitability: async (startDate: string, endDate: string): Promise<ProjectProfitabilityRow[]> => {
    const { data, error } = await db().rpc('get_project_profitability', {
      p_start_date: startDate,
      p_end_date: endDate,
    });
    if (error) throw error;
    return data ?? [];
  }
};