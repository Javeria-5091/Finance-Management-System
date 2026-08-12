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
  vendorBillId: uuidSchema,
});

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