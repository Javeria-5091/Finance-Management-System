import { supabase } from '@/lib/supabase';
import type { TransactionSummary, TransactionRow, TransactionDetail } from '@/types/transaction.types';

// FIX: All three functions exist in the reporting schema, not public.
// Using supabase.schema('reporting').rpc() routes the call to the correct schema.

const reportingDb = () => supabase.schema('reporting');

export const getTransactionSummary = async () => {
  const { data, error } = await reportingDb().rpc('transaction_summary');
  if (error) throw new Error(error.message);
  return data as TransactionSummary;
};

export const getTransactionList = async (params: {
  search?: string; type?: string; status?: string;
  project_id?: string | null; date_from?: string | null;
  date_to?: string | null; limit?: number; offset?: number;
}) => {
  const { data, error } = await reportingDb().rpc('transaction_list', {
    p_search: params.search || '',
    p_type: params.type || 'ALL',
    p_status: params.status || 'ALL',
    p_project_id: params.project_id || null,
    p_date_from: params.date_from || null,
    p_date_to: params.date_to || null,
    p_limit: params.limit || 25,
    p_offset: params.offset || 0,
  });
  if (error) throw new Error(error.message);
  return (data || []) as TransactionRow[];
};

export const getTransactionDetail = async (id: string) => {
  const { data, error } = await reportingDb().rpc('transaction_detail', { p_id: id });
  if (error) throw new Error(error.message);
  return data as TransactionDetail;
};