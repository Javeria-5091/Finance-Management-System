/** Canonical approval-limit vocabulary shared by UI/API/workflow.
 * Keep these values aligned with core.approval_limits.transaction_type.
 */
export const APPROVAL_TRANSACTION_TYPES = [
  'EXPENSE',
  'INCOME',
  'INVOICE',
  'PURCHASE',
  'VENDOR_PAYMENT',
  'VENDOR_BILL',
  'BUDGET_REVISION',
  'JOURNAL_ENTRY',
  'BANK_TRANSFER',
  'SALARY_PAYROLL',
  'OWNER_DISTRIBUTION',
  'PERIOD_REOPEN',
  'INVOICE_CREDIT_NOTE',
  'RESERVE_ALLOCATION',
] as const;

export type ApprovalTransactionType = typeof APPROVAL_TRANSACTION_TYPES[number];

export const APPROVAL_SCOPES = ['OWN', 'PROJECT', 'DEPARTMENT', 'ALL'] as const;
