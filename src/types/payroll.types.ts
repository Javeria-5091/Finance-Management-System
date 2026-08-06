// --- Payroll Types ---
export interface PayrollEmployee {
  id: string;
  employee_code: string;
  name: string;
  email: string | null;
  phone: string | null;
  designation: string | null;
  department: string | null;
  employment_type: string;
  status: string;
  join_date: string | null;
  bank_name: string | null;
  bank_account: string | null;
  cnic: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
  payroll_compensation?: PayrollCompensation[];
}

export interface PayrollCompensation {
  id: string;
  employee_id: string;
  compensation_type: string;
  amount: number;
  currency: string;
  effective_from: string;
  effective_to: string | null;
  is_active: boolean;
  project_id: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface PayrollRun {
  id: string;
  payroll_period: string;
  period_start: string;
  period_end: string;
  status: string;
  total_gross_pay: number;
  total_deductions: number;
  total_net_pay: number;
  total_employer_cost: number;
  total_employees: number;
  calculated_by: string | null;
  calculated_at: string | null;
  approved_by: string | null;
  approved_at: string | null;
  posted_by: string | null;
  posted_at: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
  payroll_lines?: PayrollLine[];
}

export interface PayrollLine {
  id: string;
  payroll_run_id: string;
  employee_id: string;
  basic_salary: number;
  housing_allow: number;
  medical_allow: number;
  conveyance_allow: number;
  other_allowances: number;
  overtime_pay: number;
  commission_pay: number;
  bonus_pay: number;
  gross_pay: number;
  tax_deduction: number;
  provident_fund: number;
  eobi: number;
  advance_deduction: number;
  other_deductions: number;
  total_deductions: number;
  net_pay: number;
  employer_cost: number;
  payment_status: string;
  payment_date: string | null;
  payment_ref: string | null;
  bank_name: string | null;
  bank_account: string | null;
  project_id: string | null;
  employee_name: string | null;
  employee_code: string | null;
  designation: string | null;
  department: string | null;
  notes: string | null;
  created_at: string;
}

export interface PayrollAdvance {
  id: string;
  employee_id: string;
  amount: number;
  purpose: string | null;
  request_date: string;
  approval_status: string;
  approved_by: string | null;
  approved_at: string | null;
  total_deducted: number;
  remaining_balance: number;
  monthly_deduction: number | null;
  start_deduction_month: string | null;
  notes: string | null;
  created_at: string;
  payroll_employees?: { id: string; name: string; employee_code: string; department: string | null } | null;
}

export interface PayrollCommission {
  id: string;
  employee_id: string;
  project_id: string | null;
  commission_type: string;
  description: string | null;
  base_amount: number;
  commission_rate: number;
  commission_amount: number;
  period_month: string | null;
  status: string;
  approved_by: string | null;
  approved_at: string | null;
  paid_date: string | null;
  payment_ref: string | null;
  notes: string | null;
  created_at: string;
  // Joined
  payroll_employees?: { id: string; name: string; employee_code: string; department: string | null } | null;
}

export interface PayrollDeduction {
  id: string;
  employeeId: string;
  deductionType: string;
  amount: number;
  percentage?: number;
  effectiveFrom: string;
  effectiveTo?: string;
  isActive: boolean;
  notes?: string;
  createdAt: string;
  updatedAt: string;
}

// ─── Form Data Types (FIXED: added export) ───
export interface EmployeeFormData {
  name: string;
  email: string;
  phone: string;
  designation: string;
  department: string;
  employment_type: string;
  join_date: string;
  bank_name: string;
  bank_account: string;
  cnic: string;
  notes: string;
}

export interface CompensationFormData {
  employee_id: string;
  compensation_type: string;
  amount: string;
  effective_from: string;
  effective_to: string;
  project_id: string;
  notes: string;
}

// --- Subscription Types ---
export interface Subscription {
  id: string;
  name: string;
  vendor?: string;
  category: string;
  amount: number;
  currency: string;
  billingFrequency: string;
  startDate: string;
  renewalDate?: string;
  cancellationNotice?: number;
  autoRenew: boolean;
  projectId?: string;
  ownerId?: string;
  status: string;
  notes?: string;
  createdAt: string;
  updatedAt: string;
}

// --- Dashboard Types ---
export interface DashboardStats {
  totalAssets: number;
  totalAssetValue: number;
  totalDepreciated: number;
  activeEmployees: number;
  monthlyPayroll: number;
  upcomingRenewals: number;
  pendingAdvances: number;
  pendingCommissions: number;
}

// --- Common Types ---
export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
}

export interface PaginationParams {
  page?: number;
  limit?: number;
  search?: string;
  status?: string;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
}
