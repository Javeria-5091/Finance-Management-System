export interface PLAccount {
  code: string;
  account_name: string;
  total: number;
  credit_total?: number;
  debit_total?: number;
}

export interface PLData {
  revenue: PLAccount[];
  cost_of_sales: PLAccount[];
  operating_expenses: PLAccount[];
  other_income: PLAccount[];
  other_expenses: PLAccount[];
}

export interface BSAccount {
  code: string;
  account_name: string;
  account_type: string;
  total: number;
}

export interface BSData {
  assets: BSAccount[];
  liabilities: BSAccount[];
  equity: BSAccount[];
}

export interface CFItem {
  account_name: string;
  account_type?: string;
  total: number;
}

export interface CFData {
  operating: CFItem[];
  investing: CFItem[];
  financing: CFItem[];
  cash_balance: number;
}

export interface AgingItem {
  client_name?: string;
  vendor_name?: string;
  invoice_number?: string;
  bill_number?: string;
  due_date: string;
  total: number;
  current_amount: number;
  overdue_1_30: number;
  overdue_31_60: number;
  overdue_61_90: number;
  overdue_over_90: number;
}

export interface AgingData {
  receivable: AgingItem[];
  payable: AgingItem[];
}

export interface ProjectProfitRow {
  project_id: string;
  project_name: string;
  client_name: string;
  status: string;
  revenue: number;
  direct_costs: number;
  platform_fees: number;
  allocated_overhead: number;
  total_costs: number;
  gross_profit: number;
  net_profit: number;
  revenue_entries: number;
  cost_entries: number;
}

export interface TaxReportData {
  profit_before_tax: number;
  adjustments: any[];
  taxable_income: number;
  gross_estimated_tax: number;
  tax_adjustments: number;
  adjustable_wht_credits: number;
  net_tax_payable: number;
  net_tax_refund: number;
  profit_after_tax: number;
  effective_tax_rate: number;
  components: {
    code: string;
    account_name: string;
    amount: number;
    component_type: string;
  }[];
  pnl_breakdown: {
    section: string;
    total: number;
  }[];
}