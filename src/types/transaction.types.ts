export interface TransactionSummary {
  total_inflow: number;
  total_outflow: number;
  net_flow: number;
  this_month_count: number;
  posted_count: number;
  pending_count: number;
}

export interface TransactionRow {
  id: string;
  reference: string;
  description: string;
  status: string;
  entry_date: string;
  source_type: string;
  source_reference: string | null;
  project_name: string | null;
  total_debit: number;
  total_credit: number;
  net_amount: number;
  account_names: string[];
  created_by_name: string | null;
  created_at: string;
}

export interface SettlementLine {
  label: string;
  amount: number;
  original_amount: number | null;
  original_currency: string | null;
  type: 'GROSS' | 'DEDUCTION' | 'ADJUSTMENT' | 'NET';
  color: string;
}

export interface JournalLine {
  account_code: string;
  account_name: string;
  account_type: string;
  debit_amount: number;
  credit_amount: number;
}

export interface StatusStep {
  status: string;
  label: string;
  date: string | null;
  is_completed: boolean;
  is_current: boolean;
}

export interface TransactionDetail {
  id: string;
  reference: string;
  description: string;
  status: string;
  entry_date: string;
  source_type: string;
  source_reference: string | null;
  project_name: string | null;
  period_name: string | null;
  total_debit: number;
  total_credit: number;
  created_by_name: string | null;
  created_at: string;
  settlement_lines: SettlementLine[];
  journal_lines: JournalLine[];
  status_timeline: StatusStep[];
  attachments_count: number;
}