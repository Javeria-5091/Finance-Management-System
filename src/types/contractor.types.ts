// ================================================================
// OSYSTIC Finance Management System — Contractor Types (P1)
// ================================================================
// Spec: Section 5.9 — Payroll, Contractors, Commissions, Team Payables
// Route: src/types/contractor.types.ts
// ================================================================

// ─── DB Row (snake_case — what Supabase returns) ───────────────────────

export interface ContractorRow {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  company: string | null;
  role: string;
  specialization: string | null;
  rate_type: string;
  rate: number;
  currency: string;
  contract_start: string | null;
  contract_end: string | null;
  project_id: string | null;
  status: string;
  tax_withholding_pct: number;
  payment_terms: string;
  bank_name: string | null;
  bank_account: string | null;
  notes: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

// ─── Expiration View Row ────────────────────────────────────────────────

export interface ContractorExpirationRow extends ContractorRow {
  expiry_bucket: string | null;
  days_until_expiry: number | null;
}

// ─── Cost View Row (by role) ─────────────────────────────────────────────

export interface ContractorCostRow {
  role: string;
  contractor_count: number;
  raw_total_rate: number;
  annualized_cost: number;
  normalized_monthly: number;
}

// ─── Project Cost View Row ──────────────────────────────────────────────

export interface ContractorProjectCostRow {
  project_name: string;
  project_id: string;
  contractor_count: number;
  annualized_cost: number;
  normalized_monthly: number;
}

// ─── Form Data (string values for form inputs) ──────────────────────────

export interface ContractorFormData {
  name: string;
  email: string;
  phone: string;
  company: string;
  role: string;
  specialization: string;
  rate_type: string;
  rate: string;
  currency: string;
  contract_start: string;
  contract_end: string;
  project_id: string;
  status: string;
  tax_withholding_pct: string;
  payment_terms: string;
  bank_name: string;
  bank_account: string;
  notes: string;
}

// ─── Stats ───────────────────────────────────────────────────────────────

export interface ContractorStats {
  activeCount: number;
  normalizedMonthly: number;
  annualizedTotal: number;
  expiring30Days: number;
  expiredCount: number;
  topCurrency: string;
}

// ─── Constants ───────────────────────────────────────────────────────────

export const ROLES = [
  { value: 'DEVELOPER', label: 'Developer' },
  { value: 'DESIGNER', label: 'Designer' },
  { value: 'CONSULTANT', label: 'Consultant' },
  { value: 'PM', label: 'Project Manager' },
  { value: 'QA_TESTER', label: 'QA / Tester' },
  { value: 'DEVOPS', label: 'DevOps' },
  { value: 'DATA_ANALYST', label: 'Data Analyst' },
  { value: 'CONTENT_WRITER', label: 'Content Writer' },
  { value: 'OTHER', label: 'Other' },
] as const;

export const RATE_TYPES = [
  { value: 'HOURLY', label: 'Hourly' },
  { value: 'DAILY', label: 'Daily' },
  { value: 'WEEKLY', label: 'Weekly' },
  { value: 'MONTHLY', label: 'Monthly' },
  { value: 'FIXED_PROJECT', label: 'Fixed / Project' },
] as const;

export const STATUSES = [
  { value: 'ACTIVE', label: 'Active' },
  { value: 'ON_HOLD', label: 'On Hold' },
  { value: 'TERMINATED', label: 'Terminated' },
  { value: 'COMPLETED', label: 'Completed' },
] as const;

export const PAYMENT_TERMS = [
  { value: 'NET_15', label: 'Net 15' },
  { value: 'NET_30', label: 'Net 30' },
  { value: 'NET_45', label: 'Net 45' },
  { value: 'NET_60', label: 'Net 60' },
  { value: 'UPFRONT', label: 'Upfront' },
  { value: 'MILESTONE', label: 'Milestone' },
] as const;
