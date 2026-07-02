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
  created_at: string;
}

export type ProjectFormData = Omit<Project, "id" | "user_id" | "created_at">;

export const PROJECT_STATUSES = ["Active", "Completed", "On Hold"] as const;


// ==========================================
// 2. EXPENSE TYPES
// ==========================================
export interface Expense {
  id: string;
  user_id: string;
  project_id: string | null; // Foreign Key 
  title: string;
  amount: number;
  category: string;
  expense_date: string;
  notes: string | null;
  created_at: string;
}

export type ExpenseFormData = Omit<Expense, "id" | "user_id" | "created_at">;
export const EXPENSE_CATEGORIES = ["Domain", "Hosting", "Software", "Marketing", "Salary", "Freelance", "Other"];


// ==========================================
// 3. INCOME TYPES (UPDATED - Project ID Added)
// ==========================================
export interface Income {
  id: string;
  user_id: string;
  project_id: string | null; 
  title: string;
  amount: number;
  category: string;
  description: string | null;
  income_date: string;
  created_at: string;
  updated_at: string;
}

export type IncomeFormData = Omit<Income, "id" | "user_id" | "created_at" | "updated_at">;
export const INCOME_CATEGORIES = ["Salary", "Freelance", "Business", "Investment", "Rental", "Other"];

// ==========================================
// 4. INVOICE TYPES
// ==========================================
export interface Invoice {
  id: string;
  user_id: string;
  project_id: string | null;
  invoice_number: string;
  client_name: string;
  amount: number;
  status: "Draft" | "Pending" | "Paid" | "Overdue";
  issue_date: string;
  due_date: string;
  notes: string | null;
  created_at: string;
}

export type InvoiceFormData = Omit<Invoice, "id" | "user_id" | "created_at">;
export const INVOICE_STATUSES = ["Draft", "Pending", "Paid", "Overdue"] as const;

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