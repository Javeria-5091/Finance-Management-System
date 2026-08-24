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
  tax_rate?: number;
  tax_amount?: number;
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
  tax_rate?: number;
  tax_amount?: number;
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
  tax_rate?: number;
  tax_amount?: number;
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
// 5. AUDIT LOG TYPES (UPDATED FOR SPEC 8.1)
// ==========================================
export interface AuditLog {
  id: string;
  user_id: string | null;
  user_email?: string | null;
  role_snapshot?: string | null;      // Spec 8.1: Role at the time of action
  action: string;                     // e.g., 'CREATE', 'APPROVE', 'AI_QUERY'
  entity_type: string;                // e.g., 'expense', 'invoice', 'ai_tool'
  entity_id: string | null;
  severity: 'INFO' | 'WARNING' | 'CRITICAL';
  before_values?: Record<string, any> | null;
  after_values?: Record<string, any> | null;
  reason?: string | null;
  ip_address?: string | null;
  ai_metadata?: {                     // Spec 8.1: AI specific fields
    question?: string;
    tool_name?: string;
    model?: string;
    latency_ms?: number;
    refusal_reason?: string;
  } | null;
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
  organization_id?: string | null;
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

// =============================================================================
// AI Types — Spec 9.9, 9.10
// =============================================================================

export interface AIConversation {
  id: string;
  user_id: string;
  organization_id: string;
  title: string | null;
  status: 'active' | 'archived' | 'deleted';
  created_at: string;
  updated_at: string;
}

export interface AIMessage {
  id: string;
  conversation_id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  content_type: 'text' | 'json' | 'error';
  classification: string | null;
  metadata: {
    request_id?: string;
    tool?: string;
    confidence?: 'high' | 'medium' | 'low';
    warnings?: string[];
    model?: string;
  };
  created_at: string;
}

export interface AIToolCall {
  id: string;
  message_id: string;
  conversation_id: string;
  user_id: string;
  organization_id: string;
  tool_name: string;
  input_params: Record<string, any>;
  input_hash: string | null;
  permission_check: 'passed' | 'denied' | 'skipped';
  user_role: string;
  status: 'success' | 'error' | 'timeout' | 'blocked';
  result_rows: number | null;
  latency_ms: number;
  model: string;
  error_message: string | null;
  created_at: string;
}

export interface AIQueryAudit {
  id: string;
  tool_call_id: string | null;
  conversation_id: string;
  user_id: string;
  organization_id: string;
  question: string;
  normalized_intent: string;
  tool_or_report: string;
  sql_or_params: Record<string, any> | null;
  row_count: number;
  timed_out: boolean;
  result_hash: string | null;
  status: string;
  created_at: string;
}

export interface AISuggestion {
  id: string;
  user_id: string;
  organization_id: string;
  entity_type: string;
  entity_id: string | null;
  suggestion_type: 'account_coding' | 'duplicate' | 'reconciliation' | 'anomaly' | 'category';
  suggestion_data: Record<string, any>;
  confidence: number | null;
  reasons: string[] | null;
  status: 'pending' | 'accepted' | 'rejected' | 'expired';
  created_at: string;
  resolved_at: string | null;
  resolved_by: string | null;
}

export interface AIFeedback {
  id: string;
  user_id: string;
  organization_id: string;
  message_id: string | null;
  tool_call_id: string | null;
  feedback_type: 'message_rating' | 'suggestion_rating' | 'correction' | 'general';
  rating: number | null;
  correction: string | null;
  reason: string | null;
  created_at: string;
}

// Spec 9.10 — AI Response Contract
export interface AIResponseContract {
  answer: string;
  metric_or_report: string | null;
  period: { from: string; to: string };
  currency: string;
  filters: { field: string; value: string }[];
  data_as_of: string;
  confidence: 'high' | 'medium' | 'low';
  warnings: string[];
  source_rows_or_report: string | null;
  suggested_safe_actions: string[];
  conversation_id?: string;
  request_id?: string;
}