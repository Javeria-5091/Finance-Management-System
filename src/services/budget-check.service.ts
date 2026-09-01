import { supabase as browserSupabase } from '@/lib/supabase';
import type { SupabaseClient } from '@supabase/supabase-js';

// ─── Types ───────────────────────────────────────────────────────────────────

type SClient = SupabaseClient<any, any, any>;

export type BudgetWarningLevel = 'OK' | 'CAUTION' | 'WARNING' | 'BLOCKED';
export type BudgetEnforcementMode = 'WARN_ONLY' | 'HARD_BLOCK';

export interface BudgetPolicyConfig {
  enforcement_mode: BudgetEnforcementMode;
  caution_threshold: number;
  warning_threshold: number;
  block_threshold: number;
}

export interface BudgetCheckInput {
  budget_id?: string;
  project_id?: string;
  department?: string;
  category?: string;
  /**
   * AP-04 FIX: MUST already be converted to the organization's base
   * currency (PKR) — e.g. `amount_in_original_currency * exchange_rate`.
   * public.budgets has no currency column at all (every budget is a PKR
   * ceiling), and finance.budget_lines/reporting.budget_gl_actual are
   * likewise base-currency only (the latter reads journal_lines'
   * base_debit/base_credit). There is nowhere in this function to convert
   * a foreign-currency amount, so it does not attempt to — see `currency`
   * below for the guard that catches a caller who forgets to convert.
   */
  amount: number;
  /**
   * AP-04 FIX: informational/defensive only — NOT used to convert `amount`.
   * If provided and not 'PKR', checkBudgetForTransaction throws rather than
   * silently comparing a foreign-currency `amount` against a PKR budget
   * ceiling (which is exactly how AP-04 happened: callers passed
   * expense.amount/bill.total_amount/invoice.total_amount — all in the
   * transaction's own currency — straight through with `currency` set to
   * that same non-PKR code, and this function ignored the field entirely).
   * Omit this (or pass 'PKR') once `amount` has been converted.
   */
  currency?: string;
  organization_id: string | null;
  /**
   * BUG-007 FIX: Optional server-side authenticated supabase client.
   * API routes pass their server-side client (from getAuthSupabase()) so
   * budget checks run with the authenticated user's RLS context.
   * Frontend callers omit this and the browser client is used.
   */
  supabaseClient?: SClient | null;
}

export interface BudgetCheckResult {
  type: 'PROJECT_BUDGET' | 'CATEGORY_BUDGET' | 'DEPARTMENT_BUDGET' | 'DIRECT_BUDGET';
  budget_id: string;
  budget_name?: string;
  category?: string;
  department?: string;
  total_budget: number;
  committed: number;
  actual: number;
  available: number;
  transaction_amount: number;
  exceeds_budget: boolean;
  utilization_before: number;
  utilization_after: number;
  warning_level: BudgetWarningLevel;
}

export interface BudgetCheckResponse {
  allowed: boolean;
  blocked: boolean;
  warning: boolean;
  enforcement_mode: BudgetEnforcementMode;
  policy: BudgetPolicyConfig;
  checks: BudgetCheckResult[];
  message: string;
  notifications?: BudgetAlertNotification[];
}

export interface BudgetAlertNotification {
  type: 'BUDGET_CAUTION' | 'BUDGET_WARNING' | 'BUDGET_BLOCKED' | 'BUDGET_EXCEEDED';
  budget_id: string;
  budget_name?: string;
  recipient_roles: string[];
  severity: 'info' | 'medium' | 'high' | 'critical';
  message: string;
  project_id?: string;
  department?: string;
  category?: string;
  utilization_after: number;
  available_remaining: number;
}

// ─── Default Policy ──────────────────────────────────────────────────────────

const DEFAULT_POLICY: BudgetPolicyConfig = {
  enforcement_mode: 'HARD_BLOCK',
  caution_threshold: 75,
  warning_threshold: 90,
  block_threshold: 100,
};

// ─── Helper ──────────────────────────────────────────────────────────────────

function getData<T = any>(res: any): T | null {
  return res?.data ?? null;
}

/**
 * BUG-007 FIX: Resolve which supabase client to use.
 * - If the caller passes an explicit supabaseClient (API-route caller), use it.
 * - Otherwise fall back to the browser client (frontend caller).
 */
function resolveClient(override?: SClient | null): SClient {
  return override || (browserSupabase as unknown as SClient);
}

function computeWarningLevel(
  utilizationAfter: number,
  policy: BudgetPolicyConfig
): BudgetWarningLevel {
  if (utilizationAfter >= policy.block_threshold) return 'BLOCKED';
  if (utilizationAfter >= policy.warning_threshold) return 'WARNING';
  if (utilizationAfter >= policy.caution_threshold) return 'CAUTION';
  return 'OK';
}

// ─── Fetch Budget Policy from DB (configurable per organization) ────────────

export async function getBudgetPolicy(
  organizationId: string,
  supabaseClient?: SClient | null
): Promise<BudgetPolicyConfig> {
  const supabase = resolveClient(supabaseClient);
  try {
    // BUG-009 FIX: Changed supabase.schema('core').from('budget_policies') to
    // supabase.schema('core').from('budget_policies').
    // Supabase JS client does NOT support schema.table dot syntax in .from().
    const policy = getData<{ enforcement_mode: BudgetEnforcementMode; caution_threshold: number; warning_threshold: number; block_threshold: number }>(
      await supabase
        .schema('core')
        .from('budget_policies')
        .select('enforcement_mode, caution_threshold, warning_threshold, block_threshold')
        .eq('organization_id', organizationId)
        .eq('is_active', true)
        .maybeSingle()
    );

    if (policy) {
      return {
        enforcement_mode: policy.enforcement_mode || DEFAULT_POLICY.enforcement_mode,
        caution_threshold: policy.caution_threshold || DEFAULT_POLICY.caution_threshold,
        warning_threshold: policy.warning_threshold || DEFAULT_POLICY.warning_threshold,
        block_threshold: policy.block_threshold || DEFAULT_POLICY.block_threshold,
      };
    }
  } catch (err) {
    console.error('Failed to fetch budget policy, using defaults:', err);
  }
  return { ...DEFAULT_POLICY };
}

// ─── Check Single Budget ────────────────────────────────────────────────────

function checkSingleBudget(
  budget: any,
  transactionAmount: number,
  type: BudgetCheckResult['type'],
  policy: BudgetPolicyConfig,
  amounts?: { committed?: number; actual?: number }
): BudgetCheckResult {
  const totalBudget = Number(budget.total_amount) || 0;
  const committed = Number(amounts?.committed ?? 0);
  const actual = Number(amounts?.actual ?? 0);
  const available = totalBudget - committed - actual;

  const utilizationBefore = totalBudget > 0
    ? ((committed + actual) / totalBudget) * 100
    : 0;
  const utilizationAfter = totalBudget > 0
    ? ((committed + actual + transactionAmount) / totalBudget) * 100
    : (transactionAmount > 0 ? Infinity : 0);
  const exceedsBudget = transactionAmount > available;

  return {
    type,
    budget_id: budget.id,
    budget_name: budget.name || budget.budget_name || null,
    category: budget.category || null,
    department: budget.department || null,
    total_budget: totalBudget,
    committed,
    actual,
    available: Math.max(0, available),
    transaction_amount: transactionAmount,
    exceeds_budget: exceedsBudget,
    utilization_before: Math.round(utilizationBefore * 10) / 10,
    utilization_after: Math.min(Math.round(utilizationAfter * 10) / 10, 99999.9),
    warning_level: computeWarningLevel(utilizationAfter, policy),
  };
}

async function getBudgetAmounts(
  supabase: SClient,
  budgetId: string,
  organizationId: string
): Promise<{ committed: number; actual: number }> {
  // The parent public.budgets table intentionally stores only the allocation.
  // Committed is maintained on canonical finance.budget_lines and actuals come
  // from canonical reporting.budget_gl_actual.
  const [{ data: lines, error: linesError }, { data: actualRows, error: actualError }] = await Promise.all([
    supabase
      .schema('finance')
      .from('budget_lines')
      .select('committed_amount')
      .eq('budget_id', budgetId)
      .eq('organization_id', organizationId),
    supabase
      .schema('reporting')
      .from('budget_gl_actual')
      .select('actual_spent')
      .eq('budget_id', budgetId),
  ]);

  if (linesError) throw new Error(`Budget commitment lookup failed: ${linesError.message}`);
  if (actualError) throw new Error(`Budget GL actual lookup failed: ${actualError.message}`);

  const committed = (lines || []).reduce((sum: number, row: any) => sum + Number(row.committed_amount || 0), 0);
  const actual = (actualRows || []).reduce((sum: number, row: any) => sum + Number(row.actual_spent || 0), 0);
  return { committed, actual };
}

// ─── Build Alert Notifications (Spec 13.4) ──────────────────────────────────

function buildNotifications(
  checks: BudgetCheckResult[]
): BudgetAlertNotification[] {
  const notifications: BudgetAlertNotification[] = [];

  for (const check of checks) {
    if (check.warning_level === 'OK') continue;

    let recipientRoles: string[] = [];
    let alertType: BudgetAlertNotification['type'];
    let severity: BudgetAlertNotification['severity'];

    switch (check.warning_level) {
      case 'CAUTION':
        recipientRoles = ['PROJECT_MANAGER'];
        alertType = 'BUDGET_CAUTION';
        severity = 'info';
        break;
      case 'WARNING':
        recipientRoles = ['PROJECT_MANAGER', 'HOD', 'ACCOUNTANT'];
        alertType = 'BUDGET_WARNING';
        severity = 'medium';
        break;
      case 'BLOCKED':
        recipientRoles = ['PROJECT_MANAGER', 'HOD', 'FINANCE_HEAD', 'ACCOUNTANT', 'CEO'];
        alertType = 'BUDGET_BLOCKED';
        severity = 'high';
        break;
      default:
        continue;
    }

    notifications.push({
      type: alertType,
      budget_id: check.budget_id,
      budget_name: check.budget_name,
      recipient_roles: recipientRoles,
      severity,
      message: `Budget ${check.budget_name || check.budget_id} at ${check.utilization_after}% utilization (${check.warning_level}). Available: PKR ${check.available.toLocaleString()}, Transaction: PKR ${check.transaction_amount.toLocaleString()}`,
      project_id: undefined,
      department: check.department,
      category: check.category,
      utilization_after: check.utilization_after,
      available_remaining: check.available,
    });
  }

  return notifications;
}

// ─── Resolve Applicable Budget (used by encumbrance sources) ───────────────

/**
 * AP-03 FIX: finds the single APPROVED budget that a purchase request (or
 * similar not-yet-posted commitment) should encumber, using the same
 * project-first-then-category resolution order checkBudgetForTransaction
 * uses for its own project/category checks above. Returns null if nothing
 * matches, so callers can treat "no budget configured for this scope" as a
 * no-op rather than an error — mirrors checkBudgetForTransaction's own
 * behavior of simply not adding a check when no budget row is found.
 */
export async function resolveApplicableBudgetId(
  supabase: SClient,
  input: { organization_id: string | null; project_id?: string | null; category?: string | null }
): Promise<string | null> {
  const { organization_id, project_id, category } = input;

  if (project_id) {
    // .limit(1) instead of .maybeSingle(): unlike the project-budget check
    // in checkBudgetForTransaction (which relies on there being at most one
    // APPROVED budget per project), this helper must not throw if that
    // invariant is ever violated — it just needs *a* budget to encumber.
    const { data: budgets, error } = await supabase
      .from('budgets')
      .select('id')
      .eq('project_id', project_id)
      .eq('organization_id', organization_id)
      .eq('status', 'APPROVED')
      .limit(1);
    if (error) throw new Error(`Budget lookup failed: ${error.message}`);
    if (budgets && budgets.length > 0) return budgets[0].id;
  }

  if (category) {
    const { data: budgets, error } = await supabase
      .from('budgets')
      .select('id')
      .eq('category', category)
      .eq('organization_id', organization_id)
      .eq('status', 'APPROVED')
      .limit(1);
    if (error) throw new Error(`Budget lookup failed: ${error.message}`);
    if (budgets && budgets.length > 0) return budgets[0].id;
  }

  return null;
}

// ─── Core: checkBudgetForTransaction ────────────────────────────────────────

export async function checkBudgetForTransaction(
  input: BudgetCheckInput
): Promise<BudgetCheckResponse> {
  const { budget_id, project_id, department, category, amount, organization_id, supabaseClient } = input;
  const transactionAmount = Number(amount);
  const supabase = resolveClient(supabaseClient);

  // AP-04 FIX: budgets (public.budgets.total_amount), the committed figure
  // (finance.budget_lines.committed_amount) and the actual figure
  // (reporting.budget_gl_actual.actual_spent, sourced from journal_lines'
  // base_debit/base_credit) are ALL in the organization's base currency
  // (PKR) — there is no per-budget currency. Previously this function
  // accepted a `currency` field and never looked at it again, so callers
  // that passed a foreign-currency transaction amount (e.g. a $1,000 USD
  // expense) had it compared directly against a PKR budget ceiling as if
  // $1,000 == PKR 1,000. Fail closed instead: a non-PKR `currency` means
  // the caller forgot to convert `amount` first.
  const inputCurrency = (input.currency || 'PKR').toUpperCase();
  if (inputCurrency !== 'PKR') {
    throw new Error(
      `Budget check received a ${inputCurrency} amount, but budgets are tracked in PKR (base currency) only. ` +
      `Convert the amount to PKR first (amount × exchange_rate, e.g. expense.base_amount / bill.base_total_amount / invoice.base_total_amount) ` +
      `and pass currency: 'PKR' (or omit currency).`
    );
  }

  if (!organization_id) {
    return {
      allowed: false,
      blocked: false,
      warning: false,
      enforcement_mode: 'WARN_ONLY',
      policy: DEFAULT_POLICY,
      checks: [],
      message: 'Organization ID is required for budget check',
    };
  }

  const policy = await getBudgetPolicy(organization_id, supabaseClient);

  const results: BudgetCheckResult[] = [];

  // ── 1. Check project budget if project_id provided ──
  if (project_id) {
    // BUG-009 FIX: Changed supabase.schema('finance').from('budgets') to
    // supabase.schema('finance').from('budgets').
    // Also added .eq('organization_id', organization_id) for org isolation.
    const { data: budget, error: projectBudgetError } = await supabase
      .from('budgets')
      .select('*')
      .eq('project_id', project_id)
      .eq('organization_id', organization_id)
      .eq('status', 'APPROVED')
      .maybeSingle();
    if (projectBudgetError) {
      throw new Error(`Budget check unavailable: ${projectBudgetError.message}`);
    }

    if (budget) {
      results.push(checkSingleBudget(budget, transactionAmount, 'PROJECT_BUDGET', policy, await getBudgetAmounts(supabase, budget.id, organization_id)));
    }
  }

  // ── 2. Check category/department budgets ──
  if (category || department) {
    // BUG-013 FIX: `budgets` lives in the `public` schema (see
    // supabase/migrations/P0/phase_0/.sql: `CREATE TABLE IF NOT EXISTS
    // budgets (...)`, no schema prefix) — same table the project-budget
    // and direct-budget checks above already query correctly with plain
    // `supabase.from('budgets')`. This branch alone still called
    // `.schema('finance').from('budgets')`, which doesn't exist, so any
    // expense with a category or department (i.e. almost every expense)
    // made this query throw and post-expense fail closed with a 500 for
    // every single expense, even ones with no category/department budget
    // configured at all.
    let query = supabase
      .from('budgets')
      .select('*')
      .eq('status', 'APPROVED')
      .eq('organization_id', organization_id);

    if (category) query = query.eq('category', category);
    if (department) query = query.eq('department', department);

    const { data: catBudgets, error: categoryBudgetError } = await query;
    if (categoryBudgetError) {
      throw new Error(`Budget check unavailable: ${categoryBudgetError.message}`);
    }

    if (catBudgets && catBudgets.length > 0) {
      for (const budget of catBudgets) {
        const type: BudgetCheckResult['type'] = category ? 'CATEGORY_BUDGET' : 'DEPARTMENT_BUDGET';
        results.push(checkSingleBudget(budget, transactionAmount, type, policy, await getBudgetAmounts(supabase, budget.id, organization_id)));
      }
    }
  }

  // ── 3. Check budget by direct ID if provided ──
  if (budget_id) {
    // BUG-009 FIX: Changed supabase.schema('finance').from('budgets') to
    // supabase.schema('finance').from('budgets').
    const { data: budget, error: directBudgetError } = await supabase
      .from('budgets')
      .select('*')
      .eq('id', budget_id)
      .eq('organization_id', organization_id)
      .maybeSingle();
    if (directBudgetError) {
      throw new Error(`Budget check unavailable: ${directBudgetError.message}`);
    }

    if (budget) {
      results.push(checkSingleBudget(budget, transactionAmount, 'DIRECT_BUDGET', policy, await getBudgetAmounts(supabase, budget.id, organization_id)));
    }
  }

  // ── Determine overall result based on policy ──
  const hasBlocked = results.some(r => r.warning_level === 'BLOCKED');
  const hasWarning = results.some(r => r.warning_level === 'WARNING' || r.warning_level === 'CAUTION');

  const isBlocked = policy.enforcement_mode === 'HARD_BLOCK' && hasBlocked;
  const allowed = !isBlocked;

  const notifications = buildNotifications(results);

  return {
    allowed,
    blocked: isBlocked,
    warning: hasWarning,
    enforcement_mode: policy.enforcement_mode,
    policy,
    checks: results,
    message: isBlocked
      ? `Transaction BLOCKED: exceeds budget limit (policy: ${policy.enforcement_mode})`
      : hasWarning
        ? `WARNING: Transaction approaches budget limit (${policy.enforcement_mode} mode)`
        : 'OK: Within all budget limits',
    notifications: notifications.length > 0 ? notifications : undefined,
  };
}

// ─── Create Budget Alert Notifications in DB (Spec 13.4) ────────────────────

export async function createBudgetAlertNotifications(
  notifications: BudgetAlertNotification[],
  organizationId: string,
  triggeredBy: string,
  sourceEntityId: string,
  supabaseClient?: SClient | null
): Promise<void> {
  if (!notifications || notifications.length === 0) return;

  const supabase = resolveClient(supabaseClient);
  try {
    const notificationRecords = notifications.map(n => ({
      organization_id: organizationId,
      type: n.type,
      title: `Budget Alert: ${n.type.replace(/_/g, ' ')}`,
      message: n.message,
      severity: n.severity,
      recipient_roles: n.recipient_roles,
      source_entity_type: 'budget',
      source_entity_id: n.budget_id,
      related_entity_type: 'transaction',
      related_entity_id: sourceEntityId,
      triggered_by: triggeredBy,
      is_read: false,
      metadata: {
        budget_id: n.budget_id,
        budget_name: n.budget_name,
        utilization_after: n.utilization_after,
        available_remaining: n.available_remaining,
        department: n.department,
        category: n.category,
      },
    }));

    const { error } = await supabase
      .schema('core')
      .from('notifications')
      .insert(notificationRecords);

    if (error) {
      console.error('Failed to create budget alert notifications:', error);
    }
  } catch (err) {
    console.error('Budget notification creation error:', err);
  }
}