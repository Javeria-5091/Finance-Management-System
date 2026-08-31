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

// BUG-009: income tax inputs are validated together so a tax calculation
// cannot silently proceed with a missing/invalid rate.
export const incomeTaxSchema = z.object({
  tax_rate: z.number().min(0).max(100),
  tax_amount: z.number().min(0),
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
  // P0-02 FIX: enum was missing 'budget' and 'credit_note', which exist in the
  // MODULES dict in workflow/route.ts. Without these, credit notes could never
  // reach APPROVED (blocking GL posting) and budgets could never reach APPROVED
  // (silently disabling budget enforcement system-wide).
  module: z.enum(['expense', 'income', 'invoice', 'vendor_bill', 'journal_entry', 'budget', 'credit_note']),
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
 


// ─── Invoice Create ────────────────────────────────────────────────────────
// Status, organization, ownership and accounting balances are intentionally
// server-controlled. They must never be accepted from the client.
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD');
const currencyCode = z.string().trim().length(3).transform(v => v.toUpperCase());
const nonNegativeAmount = z.number().finite().min(0);

export const invoiceCreateSchema = z.object({
  client_name: z.string().trim().min(1).max(255),
  client_id: uuidSchema.nullable().optional(),
  project_id: uuidSchema.nullable().optional(),
  amount: nonNegativeAmount,
  subtotal: nonNegativeAmount.optional(),
  tax_amount: nonNegativeAmount.optional(),
  discount_amount: nonNegativeAmount.optional(),
  total_amount: nonNegativeAmount.optional(),
  currency: currencyCode.optional().default('PKR'),
  exchange_rate: z.number().finite().positive().optional().default(1),
  issue_date: isoDate.optional(),
  due_date: isoDate,
  notes: z.string().max(2000).nullable().optional(),
}).strict();

// ─── Project Create / Update ───────────────────────────────────────────────
export const projectCreateSchema = z.object({
  name: z.string().trim().min(1).max(255),
  client_id: uuidSchema.nullable().optional(),
  manager_id: uuidSchema.nullable().optional(),
  platform: z.string().max(100).nullable().optional(),
  contract_value: nonNegativeAmount.optional(),
  currency: currencyCode.optional().default('PKR'),
  start_date: isoDate.nullable().optional(),
  end_date: isoDate.nullable().optional(),
  description: z.string().max(5000).nullable().optional(),
  budget_amount: nonNegativeAmount.optional(),
  department: z.string().max(100).nullable().optional(),
  cost_center: z.string().max(100).nullable().optional(),
  is_confidential: z.boolean().optional(),
}).strict();

export const projectUpdateSchema = z.object({
  name: z.string().trim().min(1).max(255).optional(),
  client_id: uuidSchema.nullable().optional(),
  manager_id: uuidSchema.nullable().optional(),
  platform: z.string().max(100).nullable().optional(),
  contract_value: nonNegativeAmount.optional(),
  currency: currencyCode.optional(),
  start_date: isoDate.nullable().optional(),
  end_date: isoDate.nullable().optional(),
  description: z.string().max(5000).nullable().optional(),
  budget_amount: nonNegativeAmount.optional(),
  department: z.string().max(100).nullable().optional(),
  cost_center: z.string().max(100).nullable().optional(),
  is_confidential: z.boolean().optional(),
  status: z.enum(['ACTIVE', 'ON_HOLD', 'CLOSED', 'CANCELLED']).optional(),
  closure_reason: z.string().max(1000).nullable().optional(),
  override_reason: z.string().trim().min(1).max(1000).optional(),
}).strict();

// ─── Client Update ─────────────────────────────────────────────────────────
export const clientUpdateSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  contact_person: z.string().max(200).nullable().optional(),
  email: z.string().email().nullable().optional(),
  phone: z.string().max(50).nullable().optional(),
  address: z.string().max(500).nullable().optional(),
  city: z.string().max(100).nullable().optional(),
  country: z.string().max(100).nullable().optional(),
  tax_registration: z.string().max(100).nullable().optional(),
  tax_type: z.string().max(100).nullable().optional(),
  payment_terms: z.string().max(50).optional(),
  default_currency: currencyCode.optional(),
  notes: z.string().max(2000).nullable().optional(),
  website: z.string().url().nullable().optional(),
  is_active: z.boolean().optional(),
}).strict();

// ─── Admin User Management ─────────────────────────────────────────────────
export const adminRoleSchema = z.enum([
  'CEO', 'FINANCE_HEAD', 'ACCOUNTANT', 'PROJECT_MANAGER', 'EMPLOYEE',
  'VIEWER', 'AUDITOR', 'TECH_ADMIN', 'TECHNICAL_ADMIN', 'Admin',
]);

const adminDate = isoDate;
export const adminInviteSchema = z.object({
  action: z.literal('invite'),
  email: z.string().trim().email().max(320),
  fullName: z.string().trim().max(200).optional().nullable(),
  role: adminRoleSchema.optional(),
  effectiveFrom: adminDate.optional(),
  effectiveTo: adminDate.nullable().optional(),
}).strict();

export const adminAssignRoleSchema = z.object({
  action: z.literal('assign_role'),
  userId: uuidSchema,
  role: adminRoleSchema,
  effectiveFrom: adminDate.optional(),
  effectiveTo: adminDate.nullable().optional(),
}).strict();

export const adminResetPasswordSchema = z.object({
  action: z.literal('reset_password'),
  userId: uuidSchema,
  email: z.string().trim().email().max(320),
}).strict();

export const adminPostSchema = z.discriminatedUnion('action', [
  adminInviteSchema,
  adminAssignRoleSchema,
  adminResetPasswordSchema,
]);

export const adminUserPatchSchema = z.object({
  userId: uuidSchema,
  fullName: z.string().trim().max(200).optional().nullable(),
  isActive: z.boolean().optional(),
}).strict();

// ─── Numbering Sequence Management ────────────────────────────────────────
const numberingSequenceBase = {
  sequence_code: z.string().trim().min(1).max(50).regex(/^[A-Z0-9_-]+$/, 'Invalid sequence code'),
  prefix: z.string().trim().min(1).max(30),
  description: z.string().max(500).nullable().optional(),
  current_number: z.number().int().min(0).max(2147483647).optional(),
  padding: z.number().int().min(1).max(10).optional(),
  reset_period: z.enum(['YEARLY', 'PERIOD']).optional(),
  format: z.string().max(100).regex(/\{PREFIX\}/, 'Format must contain {PREFIX}').regex(/\{NUMBER\}/, 'Format must contain {NUMBER}').optional(),
};
export const numberingCreateSchema = z.object({
  action: z.literal('create'), ...numberingSequenceBase,
  prefix: z.string().trim().min(1).max(30),
}).strict();
export const numberingUpdateSchema = z.object({
  action: z.literal('update'), ...numberingSequenceBase,
}).strict();
export const numberingResetSchema = z.object({
  action: z.literal('reset'), sequence_code: numberingSequenceBase.sequence_code,
}).strict();
export const numberingPostSchema = z.discriminatedUnion('action', [
  numberingCreateSchema, numberingUpdateSchema, numberingResetSchema,
]);

// ─── Platform Fee Management ──────────────────────────────────────────────
const feeType = z.enum(['PERCENTAGE', 'FIXED', 'TIERED', 'SLAB']);
const appliesTo = z.enum(['EXPENSE', 'INVOICE', 'VENDOR_BILL', 'PAYMENT_RECEIPT', 'SETTLEMENT', 'ALL']);
const feeNumber = z.number().finite().min(0).max(9999999999999999.99);
// BUG-019 FIX: this endpoint now targets finance.fee_rules (+ optional
// finance.fee_tiers rows for TIERED/SLAB), not the orphaned
// core.platform_fee_directory table it used to write to — see
// src/app/api/admin/platform-fees/route.ts. `min_amount`/`max_amount`
// map to fee_rules' `min_fee`/`max_fee` (a floor/cap on the *computed
// fee*, not the transaction amount — that's the only min/max concept
// finance.compute_platform_fee() actually implements).
const feeTierSchema = z.object({
  tier_from: feeNumber,
  tier_to: feeNumber, // 0 = unlimited
  fee_percent: feeNumber,
  fee_fixed: feeNumber,
});
const platformFeeFields = {
  platform: z.string().trim().min(1).max(200), // finance.platforms.code or .name
  fee_type: feeType,
  applies_to: appliesTo.optional(),
  priority: z.number().int().min(0).max(1000).optional(),
  fee_rate: feeNumber.nullable().optional(),
  fee_fixed_amount: feeNumber.nullable().optional(),
  description: z.string().max(2000).nullable().optional(),
  currency: currencyCode.optional(),
  min_amount: feeNumber.nullable().optional(),
  max_amount: feeNumber.nullable().optional(),
  tiers: z.array(feeTierSchema).max(20).optional(),
};
export const platformFeeCreateSchema = z.object({ action: z.literal('create'), ...platformFeeFields }).strict();
export const platformFeeUpdateSchema = z.object({
  action: z.literal('update'),
  id: uuidSchema,
  fee_rate: feeNumber.nullable().optional(),
  fee_fixed_amount: feeNumber.nullable().optional(),
  description: z.string().max(2000).nullable().optional(),
  min_amount: feeNumber.nullable().optional(),
  max_amount: feeNumber.nullable().optional(),
  priority: z.number().int().min(0).max(1000).optional(),
}).strict();
export const platformFeeToggleSchema = z.object({ action: z.literal('toggle'), id: uuidSchema }).strict();
export const platformFeePostSchema = z.discriminatedUnion('action', [
  platformFeeCreateSchema, platformFeeUpdateSchema, platformFeeToggleSchema,
]);

// ─── H4: Sanitize PostgREST search strings ───
// Escapes characters that have special meaning in PostgREST filter syntax.
//
// PostgREST uses '.', ',', '(', ')' as structural separators inside the
// `.or()` / `.filter()` syntax. A user-supplied search term containing any of
// those characters could otherwise be parsed as additional filter clauses
// (PostgREST filter injection), causing either unexpected query results or
// errors. Single quotes must be doubled for SQL string literals; '%' and '_'
// are ILIKE wildcards that must be backslash-escaped so a user searching for
// "100%_done" doesn't match every record.
//
// Backslash itself must be escaped FIRST so the later escapes are not
// double-escaped by an earlier backslash.
export function sanitizeSearch(input: string): string {
  if (typeof input !== 'string') return '';
  return input
    .replace(/\\/g, '\\\\')   // backslash first — must escape the escape char itself
    .replace(/%/g, '\\%')     // ILIKE wildcard
    .replace(/_/g, '\\_')     // ILIKE single-char wildcard
    .replace(/'/g, "''")      // SQL string literal escape (doubled quote)
    .replace(/,/g, '\\,')     // PostgREST or-filter separator
    .replace(/\./g, '\\.')    // PostgREST operator separator
    .replace(/\(/g, '\\(')    // PostgREST in()/is() grouping
    .replace(/\)/g, '\\)');   // PostgREST in()/is() grouping
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

// ─── Currency / exchange-rate validation helper (BUG-008 FIX) ────────────
// Spec 11.2 requires explicit input schemas with allowed values; spec 6.1
// forbids inventing business rules but Section 13.1 requires "Original-currency
// balances and transactions alongside consolidated PKR equivalents and
// effective conversion rates". A non-PKR transaction with no exchange rate
// silently defaults to 1.0 across the posting routes, producing wrong PKR
// amounts in the GL. This helper is called from every posting route to enforce
// that:
//   - PKR transactions may omit the rate (defaults to 1)
//   - Non-PKR transactions MUST provide a positive exchange_rate > 0
// The caller is expected to have already fetched the source record
// (expense / income / invoice / vendor_bill / distribution / journal).
//
// Returns null when acceptable, or an error string suitable for
// NextResponse.json({ error }, { status: 400 }).
export function validateExchangeRate(
  currency: string | null | undefined,
  exchangeRate: number | null | undefined
): string | null {
  const cur = (currency || 'PKR').toUpperCase();
  const rate = Number(exchangeRate);
  if (cur === 'PKR') {
    // PKR is the base currency; rate may be omitted or must be 1
    if (exchangeRate !== undefined && exchangeRate !== null && rate !== 1) {
      return `Exchange rate for PKR (base currency) must be 1, received ${rate}`;
    }
    return null;
  }
  if (!exchangeRate || isNaN(rate) || rate <= 0) {
    return `Exchange rate is required for non-PKR currency ${cur} (received: ${exchangeRate ?? 'undefined'})`;
  }
  return null;
}