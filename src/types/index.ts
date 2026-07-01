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

// Form ke liye (id aur user_id form se nahi aate)
export type ProjectFormData = Omit<Project, "id" | "user_id" | "created_at">;

// Dropdown ke liye statuses
export const PROJECT_STATUSES = ["Active", "Completed", "On Hold"] as const;


// ==========================================
// 2. EXPENSE TYPES
// ==========================================
export interface Expense {
  id: string;
  user_id: string;
  project_id: string | null; // Yeh Foreign Key hai
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
  project_id: string | null; // <--- YEH NAYA ADD HUA HAI
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