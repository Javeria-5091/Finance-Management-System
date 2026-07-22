// ==========================================
// 1. PROJECT TYPES
// ==========================================
export interface Project {
  id: string;
  user_id: string;
  name: string;
  client_name: string;
  description: string | null;
  status: "Active" | "Completed" | "On Hold";
  start_date: string;
  end_date: string | null;
  budget_id: string | null;
  created_at: string;
}
export type ProjectFormData = Omit<Project, "id" | "user_id" | "created_at">;
export const PROJECT_STATUSES = ["Active", "Completed", "On Hold"] as const;

// ==========================================
// 2. INCOME TYPES (PHASE 2 UPDATED)
// ==========================================
export interface Income {
  id: string;
  user_id: string;
  title: string;
  amount: number;
  category: string;
  description?: string | null;
  income_date: string;
  project_id?: string | null;
  created_at: string;
  updated_at: string;
  
  status: 'DRAFT' | 'SUBMITTED' | 'VERIFIED' | 'APPROVED' | 'POSTED' | 'REVERSED' | 'REJECTED' | 'CANCELLED';
  journal_entry_id?: string | null;
  period_id?: string | null;
  account_id?: string | null;
  currency?: string;
  exchange_rate?: number;
  base_amount?: number;
  submitted_by?: string | null;
  submitted_at?: string | null;
  approved_by?: string | null;
  approved_at?: string | null;
  posted_at?: string | null;
  rejection_reason?: string | null;
}

export const INCOME_CATEGORIES = ["Project Revenue", "Consulting", "Maintenance", "Other"];

export interface IncomeFormData {
  title: string;
  amount: number;
  category: string;
  description?: string | null;
  income_date: string;
  project_id?: string | null;
  account_id?: string | null; 
}

// ==========================================
// 3. EXPENSE TYPES (PHASE 2 UPDATED)
// ==========================================
export interface Expense {
  id: string;
  user_id: string;
  title: string;
  amount: number;
  category: string;
  expense_date: string;
  notes?: string | null;
  project_id?: string | null;
  created_at: string;

  status: 'DRAFT' | 'SUBMITTED' | 'VERIFIED' | 'APPROVED' | 'POSTED' | 'REVERSED' | 'REJECTED' | 'CANCELLED';
  journal_entry_id?: string | null;
  period_id?: string | null;
  account_id?: string | null;
  currency?: string;
  exchange_rate?: number;
  base_amount?: number;
  submitted_by?: string | null;
  submitted_at?: string | null;
  approved_by?: string | null;
  approved_at?: string | null;
  posted_at?: string | null;
  rejection_reason?: string | null;
  has_receipt?: boolean;
}

export const EXPENSE_CATEGORIES = ["Operations", "Software", "Marketing", "Salary", "Utilities", "Other"];

export interface ExpenseFormData {
  title: string;
  amount: number;
  category: string;
  expense_date: string;
  notes?: string | null;
  project_id?: string | null;
  account_id?: string | null; 
}

// ==========================================
// INVOICE TYPES (Phase 4 Upgrade)
// ==========================================

export interface Invoice {
  id: string;
  user_id: string;
  project_id: string | null;
  invoice_number: string | null;
  client_name: string;
  amount: number; 
  status: string;
  issue_date: string;
  due_date: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
  currency: string;
  exchange_rate: number; 
  subtotal: number;    
  tax_amount: number;    
  discount_amount: number; 
  total_amount: number; 
  base_subtotal: number; 
  base_tax_amount: number; 
  base_discount_amount: number;
  base_total_amount: number; 
  amount_paid: number;  
  base_amount_paid: number; 
  inv_outstanding_amount: number; 
  base_outstanding_amount: number; 
}

export type InvoiceFormData = Omit<Invoice, "id" | "user_id" | "created_at" | "updated_at">;
export const INVOICE_STATUSES = [
  "DRAFT", 
  "SUBMITTED", 
  "APPROVED", 
  "ISSUED", 
  "PARTIALLY_PAID", 
  "PAID", 
  "OVERDUE", 
  "VOID", 
  "REVERSED" 
] as const;

// ==========================================
// 5. AUDIT LOG TYPES
// ==========================================
export interface AuditLog {
  id: string;
  user_id: string | null;
  action: string;
  module: string;
  details: string | null;
  created_at: string;
}

// ==========================================
// 6. NOTIFICATION TYPES
// ==========================================
export interface Notification {
  id: string;
  user_id: string;
  title: string;
  message: string;
  is_read: boolean;
  created_at: string;
}

// ==========================================
// 7. USER PROFILE TYPES
// ==========================================
export interface UserProfile {
  id: string;
  user_id: string;
  email: string;
  full_name: string;
  role: string;
  can_create_project: boolean;
  can_edit_project: boolean;  
  can_delete_project: boolean;
  can_add_income: boolean;
  can_edit_income: boolean;    
  can_delete_income: boolean;  
  can_add_expense: boolean;
  can_edit_expense: boolean;  
  can_delete_expense: boolean; 
  can_create_invoice: boolean;
  can_edit_invoice: boolean;   
  can_delete_invoice: boolean;
  created_at: string;
}

// ==========================================
// 8. BUDGET TYPES
// ==========================================
export interface Budget {
  id: string;
  user_id: string;
  name: string;
  category: string;
  total_amount: number;
  start_date: string;
  end_date: string;
  description: string | null;
  created_at: string;
}
export type BudgetFormData = Omit<Budget, "id" | "user_id" | "created_at">;
export const BUDGET_CATEGORIES = ["Operational", "Project Specific", "Marketing", "Salary", "IT & Infrastructure", "Misc"];

// ==========================================
// 9. PAYMENT TYPES
// ==========================================
export interface Payment {
  id: string;
  user_id: string;
  invoice_id: string | null;
  project_id: string | null;
  amount: number;
  payment_date: string;
  payment_method: string;
  status: "Pending" | "Paid" | "Partial Payment" | "Overdue";
  notes: string | null;
  created_at: string;
}
export type PaymentFormData = Omit<Payment, "id" | "user_id" | "created_at">;
export const PAYMENT_METHODS = ["Bank Transfer", "JazzCash", "EasyPaisa", "Cheque", "Cash"];
export const PAYMENT_STATUSES = ["Pending", "Paid", "Partial Payment", "Overdue"];