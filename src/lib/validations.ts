// ═════════════════════════════════════════════════════════════════════
// SHARED ZOD VALIDATION SCHEMAS
// Gap Report 7.6 + P0: No input validation on API routes.
// All critical endpoints now use these schemas.
// ═════════════════════════════════════════════════════════════════════

import { z } from 'zod';
 
// ─── UUID validation helper ───
export const uuidSchema = z.string().uuid();
 
// ─── Monetary amount — max 18 digits, 2 decimal places (matches DB NUMERIC(18,2)) ───
export const monetaryAmount = z.number()
  .positive('Amount must be positive')
  .max(9999999999999999.99, 'Amount exceeds maximum allowed value');
 
// ─── Year-End Close ───
export const yearEndCloseSchema = z.object({
  fiscal_year_id: uuidSchema,
  description: z.string().max(500).optional(),
});
 
// ─── Post Expense ───
export const postExpenseSchema = z.object({
  expenseId: uuidSchema,
  force_budget_override: z.boolean().optional(),
});
 
// ─── Post Income ───
export const postIncomeSchema = z.object({
  incomeId: uuidSchema,
});
 
// ─── Post Invoice ───
export const postInvoiceSchema = z.object({
  invoiceId: uuidSchema,
});
 
// ─── Post Vendor Bill ───
export const postVendorBillSchema = z.object({
  vendorBillId: z.string().uuid(),
  force_budget_override: z.boolean().optional().default(false),
})
 
// ─── Post Journal ───
export const postJournalSchema = z.object({
  journalId: uuidSchema,
});
 
// ─── Payment Reversal ───
export const paymentReversalSchema = z.object({
  paymentId: uuidSchema,
  reason: z.string().min(5, 'Reason must be at least 5 characters').max(500),
});

// ─── Workflow Action ───
export const workflowActionSchema = z.object({
  module: z.enum(['expense', 'income', 'invoice', 'vendor_bill', 'journal_entry']),
  recordId: uuidSchema,
  action: z.enum(['submit', 'verify', 'approve', 'post', 'reject', 'reverse', 'reopen', 'issue', 'cancel']),
  reason: z.string().max(500).optional(),
});
 
// ─── Attachment Upload ───
export const attachmentUploadSchema = z.object({
  action: z.literal('upload_url'),
  entityId: uuidSchema,
  entityType: z.string().min(1).max(50),
  fileName: z.string().min(1).max(255),
  fileType: z.string().min(1).max(100),
  fileSize: z.number().int().positive().max(10 * 1024 * 1024).optional(),
  fileBase64: z.string().max(15 * 1024 * 1024).optional(), // ~10MB base64
});
 
// ─── Attachment Download ───
export const attachmentDownloadSchema = z.object({
  action: z.literal('download_url'),
  entityId: z.string().min(1).max(500),
});

// ─── Budget Check ───
export const budgetCheckSchema = z.object({
  amount: monetaryAmount,
  budget_id: uuidSchema.optional(),
  project_id: uuidSchema.optional(),
  department: z.string().max(100).optional(),
  category: z.string().max(100).optional(),
  currency: z.string().length(3).default('PKR'),
  organization_id: uuidSchema.nullable(),
});
 
// ─── Payment Receipt ───
export const paymentReceiptSchema = z.object({
  client_id: uuidSchema,
  amount: monetaryAmount,
  currency: z.string().length(3).default('PKR'),
  exchange_rate: z.number().positive().optional(),
  received_date: z.string().optional(),
  payment_method: z.enum(['BANK_TRANSFER', 'CASH', 'CHEQUE', 'ONLINE', 'OTHER']).optional(),
  reference: z.string().max(200).optional(),
  financial_account_id: uuidSchema,
  notes: z.string().max(1000).optional(),
  allocations: z.array(z.object({
    invoice_id: uuidSchema,
    amount: monetaryAmount,
  })).optional(),
});
 
// ─── Credit Note Create ───
export const creditNoteCreateSchema = z.object({
  invoice_id: uuidSchema,
  reason: z.string().max(500).optional(),
  line_items: z.array(z.any()).optional(),
  total_amount: monetaryAmount,
  tax_amount: z.number().min(0).optional(),
  currency: z.string().length(3).optional(),
  exchange_rate: z.number().positive().optional(),
  notes: z.string().max(1000).optional(),
});
 
// ─── Payment Allocation ───
export const paymentAllocationSchema = z.object({
  payment_receipt_id: uuidSchema,
  allocations: z.array(z.object({
    invoice_id: uuidSchema,
    amount: monetaryAmount,
  })).min(1, 'At least one allocation is required'),
});
 
// ─── Credit Note Post Action ───
export const creditNotePostSchema = z.object({
  action: z.literal('post_to_gl'),
});
 
// ─── Notification Create ───
export const notificationCreateSchema = z.object({
  user_id: uuidSchema.optional(),
  title: z.string().min(1).max(200),
  message: z.string().min(1).max(2000),
  notification_type: z.enum(['APPROVAL_PENDING', 'PAYMENT_DUE', 'BUDGET_ALERT', 'SYSTEM', 'WORKFLOW', 'REMINDER', 'OVERDUE', 'INFO']).optional(),
  priority: z.enum(['low', 'medium', 'high', 'urgent']).optional(),
  action_url: z.string().max(500).optional(),
  entity_type: z.string().max(50).optional(),
  entity_id: uuidSchema.optional(),
  expires_at: z.string().optional(),
});
 
// ─── H4: Sanitize PostgREST search strings ───
// Escapes characters that have special meaning in PostgREST filter syntax
export function sanitizeSearch(input: string): string {
  return input
    .replace(/%/g, '\%')
    .replace(/_/g, '\_')
    .replace(/'/g, "''");
}
 
// ─── Helper: Validate request body and return error or parsed data ───
export function validateBody<T>(schema: z.ZodSchema<T>, body: unknown): { success: true; data: T } | { success: false; error: string } {
  const result = schema.safeParse(body);
  if (result.success) {
    return { success: true, data: result.data };
  }
  const firstError = result.error.issues[0];
  return {
    success: false,
    error: firstError ? `${firstError.path.join('.')}: ${firstError.message}` : 'Invalid request data',
  };
}
