// --- Payroll Types ---
export interface PayrollEmployee {
  id: string;
  employeeCode: string;
  userId?: string;
  name: string;
  email?: string;
  phone?: string;
  departmentId?: string;
  designation?: string;
  employmentType: string;
  status: string;
  joinDate?: string;
  bankName?: string;
  bankAccount?: string;
  cnic?: string;
  notes?: string;
  createdAt: string;
  updatedAt: string;
  compensation?: PayrollCompensation[];
  department?: { id: string; name: string; code: string };
}

export interface PayrollCompensation {
  id: string;
  employeeId: string;
  compensationType: string;
  amount: number;
  currency: string;
  effectiveFrom: string;
  effectiveTo?: string;
  isActive: boolean;
  notes?: string;
  createdAt: string;
  updatedAt: string;
}

export interface PayrollRun {
  id: string;
  payrollPeriod: string;
  periodStartDate: string;
  periodEndDate: string;
  status: string;
  totalGrossPay: number;
  totalDeductions: number;
  totalNetPay: number;
  totalEmployees: number;
  calculatedBy?: string;
  calculatedAt?: string;
  approvedBy?: string;
  approvedAt?: string;
  postedBy?: string;
  postedAt?: string;
  notes?: string;
  createdAt: string;
  updatedAt: string;
  payrollLines?: PayrollLine[];
}

export interface PayrollLine {
  id: string;
  payrollRunId: string;
  employeeId: string;
  basicSalary: number;
  allowances: number;
  overtimePay: number;
  commissionPay: number;
  bonusPay: number;
  grossPay: number;
  taxDeduction: number;
  providentFund: number;
  advanceDeduction: number;
  otherDeductions: number;
  totalDeductions: number;
  netPay: number;
  paymentStatus: string;
  paymentDate?: string;
  paymentRef?: string;
  bankName?: string;
  bankAccount?: string;
  notes?: string;
  createdAt: string;
  updatedAt: string;
  employee?: PayrollEmployee;
}

export interface PayrollAdvance {
  id: string;
  employeeId: string;
  amount: number;
  purpose?: string;
  requestDate: string;
  approvalStatus: string;
  approvedBy?: string;
  approvedAt?: string;
  totalDeducted: number;
  remainingBalance: number;
  monthlyDeduction?: number;
  startDeductionMonth?: string;
  notes?: string;
  createdAt: string;
  updatedAt: string;
  employee?: PayrollEmployee;
}

export interface PayrollCommission {
  id: string;
  employeeId: string;
  projectId?: string;
  commissionType: string;
  description?: string;
  baseAmount: number;
  commissionRate: number;
  commissionAmount: number;
  periodMonth?: string;
  status: string;
  approvedBy?: string;
  approvedAt?: string;
  paidDate?: string;
  paymentRef?: string;
  notes?: string;
  createdAt: string;
  updatedAt: string;
  employee?: PayrollEmployee;
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
