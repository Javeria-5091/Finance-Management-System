// ================================================================
// OSYSTIC Finance Management System — Commission Types (P1)
// ================================================================
// Spec: Section 5.9 — Payroll, Contractors, Commissions, Team Payables
// Route: src/types/commission.types.ts
// ================================================================

// ─── DB Row (snake_case — what Supabase returns) ───────────────────────

export interface CommissionRow {
  id: string;
  contractor_id: string | null;
  person_name: string;
  person_type: string;
  commission_type: string;
  calculation_basis: string;
  rate_or_amount: number;
  project_id: string | null;
  client_id: string | null;
  invoice_ref: string | null;
  milestone_ref: string | null;
  period_start: string | null;
  period_end: string | null;
  base_amount: number;
  commission_amount: number;
  currency: string;
  tax_withheld: number;
  net_amount: number;
  status: string;
  payment_date: string | null;
  payment_ref: string | null;
  approved_by: string | null;
  approved_at: string | null;
  notes: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

// ─── View Rows ───────────────────────────────────────────────────────────

export interface CommissionByPersonRow {
  person_name: string;
  person_type: string;
  contractor_id: string | null;
  commission_count: number;
  total_base_amount: number;
  total_commission: number;
  total_tax_withheld: number;
  total_net_amount: number;
  currency: string;
}

export interface CommissionByProjectRow {
  project_name: string;
  project_id: string;
  commission_count: number;
  total_base_amount: number;
  total_commission: number;
  total_tax_withheld: number;
  total_net_amount: number;
  currency: string;
}

export interface CommissionByTypeRow {
  commission_type: string;
  calculation_basis: string;
  commission_count: number;
  total_commission: number;
  total_tax_withheld: number;
  total_net_amount: number;
}

export interface CommissionStatusRow {
  status: string;
  commission_count: number;
  total_commission: number;
  total_tax_withheld: number;
  total_net_amount: number;
}

// ─── Form Data (string values for form inputs) ──────────────────────────

export interface CommissionFormData {
  contractor_id: string;
  person_name: string;
  person_type: string;
  commission_type: string;
  calculation_basis: string;
  rate_or_amount: string;
  project_id: string;
  invoice_ref: string;
  milestone_ref: string;
  period_start: string;
  period_end: string;
  base_amount: string;
  commission_amount: string;
  currency: string;
  tax_withheld: string;
  status: string;
  payment_date: string;
  payment_ref: string;
  notes: string;
}

// ─── Stats ───────────────────────────────────────────────────────────────

export interface CommissionStats {
  totalRecords: number;
  pendingCount: number;
  pendingAmount: number;
  approvedCount: number;
  approvedAmount: number;
  paidCount: number;
  paidAmount: number;
  totalCommission: number;
  totalTaxWithheld: number;
  totalNetPaid: number;
  topCurrency: string;
}

// ─── Constants ───────────────────────────────────────────────────────────

export const COMMISSION_TYPES = [
  { value: 'PERCENTAGE', label: 'Percentage (%)' },
  { value: 'FIXED_AMOUNT', label: 'Fixed Amount' },
  { value: 'TIERED', label: 'Tiered' },
  { value: 'FLAT_BONUS', label: 'Flat Bonus' },
  { value: 'REFERRAL', label: 'Referral' },
] as const;

export const CALCULATION_BASES = [
  { value: 'PROJECT_REVENUE', label: 'Project Revenue' },
  { value: 'INVOICE_AMOUNT', label: 'Invoice Amount' },
  { value: 'MILESTONE_VALUE', label: 'Milestone Value' },
  { value: 'CLIENT_PAYMENT', label: 'Client Payment' },
  { value: 'SALES_TARGET', label: 'Sales Target' },
  { value: 'FIXED_AMOUNT', label: 'Fixed (No Calculation)' },
] as const;

export const COMMISSION_STATUSES = [
  { value: 'PENDING', label: 'Pending' },
  { value: 'APPROVED', label: 'Approved' },
  { value: 'PAID', label: 'Paid' },
  { value: 'CANCELLED', label: 'Cancelled' },
  { value: 'HELD', label: 'Held' },
] as const;

export const PERSON_TYPES = [
  { value: 'CONTRACTOR', label: 'Contractor' },
  { value: 'EMPLOYEE', label: 'Employee' },
] as const;
