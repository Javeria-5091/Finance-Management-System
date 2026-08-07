// =============================================================================
// OSYSTIC — Subscription Types (P1)
// File: src/types/subscription.types.ts
// Spec: Section 5.11 — Recurring Costs, Subscriptions, and Commitments
// Convention: Follows payroll.types.ts pattern (snake_case DB rows)
// =============================================================================

// ─── DB Row (snake_case — what Supabase returns) ───
export interface SubscriptionRow {
  id: string;
  name: string;
  vendor: string | null;
  category: string;
  amount: number;
  currency: string;
  billing_frequency: string;
  start_date: string;
  renewal_date: string | null;
  cancellation_notice_days: number;
  auto_renew: boolean;
  project_id: string | null;
  owner: string | null;
  status: string;
  notes: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

// ─── Renewal View Row ───
export interface SubscriptionRenewalRow extends SubscriptionRow {
  renewal_bucket: string | null;
  days_until_renewal: number | null;
  notice_date: string | null;
}

// ─── Spend View Row ───
export interface SubscriptionSpendRow {
  category: string;
  subscription_count: number;
  raw_total: number;
  annualized_amount: number;
  normalized_monthly: number;
}

// ─── Form Data (string values for form inputs, converted before DB insert) ───
export interface SubscriptionFormData {
  name: string;
  vendor: string;
  category: string;
  amount: string;
  currency: string;
  billing_frequency: string;
  start_date: string;
  renewal_date: string;
  cancellation_notice_days: string;
  auto_renew: boolean;
  project_id: string;
  owner: string;
  status: string;
  notes: string;
}

// ─── Stats ───
export interface SubscriptionStats {
  activeCount: number;
  normalizedMonthly: number;
  annualizedTotal: number;
  upcoming30Days: number;
  overdueCount: number;
}

// ─── Constants ───
export const SUBSCRIPTION_CATEGORIES = [
  'HOSTING','DOMAIN','AI_API','DATABASE','EMAIL',
  'INTERNET','RENT','UTILITIES','SOFTWARE','HARDWARE',
  'INSURANCE','MEMBERSHIP','CLOUD_STORAGE','CRM',
  'PROJECT_MANAGEMENT','COMMUNICATION','SECURITY','OTHER',
] as const;

export const BILLING_FREQUENCIES = [
  'WEEKLY','MONTHLY','QUARTERLY','SEMI_ANNUALLY',
  'ANNUALLY','BIENNIAL','ONE_TIME',
] as const;

export const SUBSCRIPTION_STATUSES = [
  'ACTIVE','PAUSED','CANCELLED','EXPIRED','PENDING_SETUP',
] as const;
