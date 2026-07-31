// dashboard.types.ts

// ==========================================
// KPIs - Single merged definition
// ==========================================
export interface CEOKPIs {
  revenue_mtd: number;
  revenue_prev: number;
  cogs_mtd: number;
  opex_mtd: number;
  other_income_mtd: number;
  other_expense_mtd: number;
  net_profit_mtd: number;
  net_profit_prev: number;
  total_assets: number;
  current_assets: number;
  fixed_assets_net: number;
  total_liabilities: number;
  current_liabilities: number;
  total_cash: number;
  cash_runway_months: number;
  accounts_receivable: number;
  accounts_payable: number;
  retained_earnings: number;
  reserve_balance: number;
  owner_capital: number;
  owner_drawings: number;
  distributable_profit: number;
  pending_approvals: number;
  unreconciled_lines: number;
  risk_overdue_receivables: number;
  risk_overdue_payables: number;
  risk_unreconciled: number;
  risk_pending_period_close: number;
}

// ==========================================
// Charts & Tables
// ==========================================
export interface CategoriesData {
  expenses: { category: string; total: number }[];
  assets: { category: string; total: number }[];
  liabilities: { category: string; total: number }[];
}

export interface AgingBoth {
  receivable: {
    current: number;
    overdue_1_30: number;
    overdue_31_60: number;
    overdue_61_90: number;
    overdue_over_90: number;
    total: number;
  };
  payable: {
    current: number;
    overdue_1_30: number;
    overdue_31_60: number;
    overdue_61_90: number;
    overdue_over_90: number;
    total: number;
  };
}

export interface ShareholderData {
  label: string;
  balance: number;
  code: string;
}

export interface TaxData {
  profit_before_tax: number;
  estimated_tax: number;
  withholding_credits: number;
  tax_payable: number;
  profit_after_tax: number;
}

export interface AuditEntry {
  id: string;
  action: string;
  module: string;
  details: string;
  created_at: string;
  user_name: string;
  table_name: string;
}

export interface FiscalPeriod {
  id: string;
  name: string;
  start_date: string;
  end_date: string;
  status: string;
  month_num: number;
  total_months: number;
}

export interface BudgetData {
  category: string;
  budget: number;
  actual: number;
  variance: number;
}

export interface PendingApproval {
  id: string;
  module_type: string;
  reference: string;
  description: string;
  amount: number;
  created_by: string;
  created_at: string;
  urgency: string;
}

export interface UnreconciledItem {
  account_id: string;
  account_name: string;
  institution_type: string;
  unreconciled_count: number;
  unreconciled_amount: number;
  last_statement_date: string;
}

export interface ProjectProfit {
  id: string;
  project_name: string;
  client_name: string;
  revenue: number;
  costs: number;
  gross_profit: number;
  margin: number;
  status: string;
}

export interface CashAccount {
  id: string;
  account_name: string;
  institution_type: string;
  currency: string;
  masked_identifier: string;
  balance: number;
}

export interface MonthlyRevenue {
  month: string;
  month_short: string;
  revenue: number;
  expenses: number;
}