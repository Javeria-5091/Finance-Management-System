import type { Project } from './index';

// ─── Client Types ───
// Type definitions for client management module

export interface Client {
  id: string;
  client_code: string;
  name: string;
  contact_person?: string | null;
  email?: string | null;
  phone?: string | null;
  address?: string | null;
  city?: string | null;
  country?: string | null;
  tax_registration?: string | null;
  tax_type?: string | null;
  payment_terms?: string | null;
  default_currency?: string;
  notes?: string | null;
  website?: string | null;
  is_active: boolean;
  organization_id: string;
  created_by: string;
  created_at: string;
  updated_at?: string;
}

export interface ClientWithRelations extends Client {
  projects?: ProjectSummary[];
  invoices?: InvoiceSummary[];
}

export interface ProjectSummary {
  id: string;
  name: string;
  status: string;
}

export interface InvoiceSummary {
  id: string;
  invoice_number: string;
  status: string;
  total_amount: number;
  currency: string;
}

// ─── Project Types ───

export interface ProjectWithRelations extends Project {
  client?: { id: string; name: string; client_code: string } | null;
  manager?: { id: string; full_name: string; email?: string | null } | null;
  profitability?: ProjectProfitability | null;
  invoices?: any[];
  expenses?: any[];
  budget?: any;
}

export interface ProjectProfitability {
  project_id: string;
  total_revenue: number;
  total_costs: number;
  gross_profit: number;
  gross_margin_percent: number;
  invoiced_amount: number;
  received_amount: number;
  outstanding_amount: number;
  committed_amount: number;
  budget_variance: number;
}

// ─── Credit Note Types ───

export interface CreditNote {
  id: string;
  credit_note_number: string;
  invoice_id: string;
  client_id: string;
  reason: string;
  line_items?: any[];
  total_amount: number;
  tax_amount: number;
  currency: string;
  exchange_rate: number;
  notes?: string | null;
  status: 'DRAFT' | 'SUBMITTED' | 'APPROVED' | 'POSTED' | 'REVERSED';
  posted_at?: string | null;
  journal_entry_id?: string | null;
  posted_by?: string | null;
  organization_id: string;
  created_by: string;
  created_at: string;
}

// ─── Payment Receipt Types ───

export interface PaymentReceipt {
  id: string;
  receipt_number: string;
  client_id: string;
  amount: number;
  currency: string;
  exchange_rate: number;
  received_date: string;
  payment_method: 'BANK_TRANSFER' | 'CASH' | 'CHEQUE' | 'PLATFORM_SETTLEMENT' | 'OTHER';
  reference?: string | null;
  financial_account_id: string;
  notes?: string | null;
  amount_allocated: number;
  unallocated_amount: number;
  status: 'PARTIALLY_ALLOCATED' | 'FULLY_ALLOCATED' | 'REVERSED';
  journal_entry_id?: string | null;
  reversed_at?: string | null;
  reversed_by?: string | null;
  reversal_reason?: string | null;
  reversal_journal_id?: string | null;
  organization_id: string;
  created_by: string;
  created_at: string;
}

export interface PaymentAllocation {
  id: string;
  payment_receipt_id: string;
  invoice_id: string;
  amount: number;
  allocated_by: string;
  status?: 'ACTIVE' | 'REVERSED';
  reversed_at?: string | null;
  reversed_by?: string | null;
  organization_id: string;
  created_at: string;
}

// ─── Admin Types ───


export interface ExchangeRate {
  id: string;
  from_currency: string;
  to_currency: string;
  rate: number;
  effective_date: string;
  source: 'MANUAL' | 'PLATFORM' | 'BANK';
  valid_until?: string | null;
  notes?: string | null;
  is_active: boolean;
  organization_id: string;
  entered_by: string;
  created_at: string;
}

export interface PlatformFee {
  id: string;
  platform: string;
  fee_type: 'PERCENTAGE' | 'FIXED' | 'TIERED';
  fee_rate?: number | null;
  fee_fixed_amount?: number | null;
  description?: string | null;
  currency: string;
  min_amount?: number | null;
  max_amount?: number | null;
  is_active: boolean;
  organization_id: string;
  created_by: string;
  created_at: string;
}

// ─── Notification Types ───


// ─── Budget Check Types ───

export interface BudgetCheckResult {
  allowed: boolean;
  blocked: boolean;
  warning: boolean;
  checks: BudgetCheck[];
  message: string;
}

export interface BudgetCheck {
  type: 'PROJECT_BUDGET' | 'CATEGORY_BUDGET' | 'DIRECT_BUDGET';
  budget_id: string;
  total_budget: number;
  committed: number;
  actual: number;
  available: number;
  transaction_amount: number;
  exceeds_budget: boolean;
  utilization_after_transaction: string;
  warning_level: 'BLOCKED' | 'WARNING' | 'CAUTION' | 'OK';
}
