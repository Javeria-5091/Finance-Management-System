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
  amount: number;
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
  policy: BudgetPolicyConfig
): BudgetCheckResult {
  const totalBudget = Number(budget.total_amount) || 0;
  const committed = Number(budget.committed_amount) || 0;
  const actual = Number(budget.actual_amount) || 0;
  const available = totalBudget - committed - actual;

  // BUG-061 FIX: When total_budget is 0, utilization would be NaN (0/0).
  // Return 0 utilization instead of NaN to prevent downstream errors.
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

// ─── Core: checkBudgetForTransaction ────────────────────────────────────────

export async function checkBudgetForTransaction(
  input: BudgetCheckInput
): Promise<BudgetCheckResponse> {
  const { budget_id, project_id, department, category, amount, organization_id, supabaseClient } = input;
  const transactionAmount = Number(amount);
  const supabase = resolveClient(supabaseClient);

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
    const budget = getData(
      await supabase
        .schema('finance')
        .from('budgets')
        .select('*')
        .eq('project_id', project_id)
        .eq('organization_id', organization_id)
        .eq('status', 'APPROVED')
        .maybeSingle()
    );

    if (budget) {
      results.push(checkSingleBudget(budget, transactionAmount, 'PROJECT_BUDGET', policy));
    }
  }

  // ── 2. Check category/department budgets ──
  if (category || department) {
    // BUG-009 FIX: Changed supabase.schema('finance').from('budgets') to
    // supabase.schema('finance').from('budgets').
    let query = supabase
      .schema('finance')
      .from('budgets')
      .select('*')
      .eq('status', 'APPROVED')
      .eq('organization_id', organization_id);

    if (category) query = query.eq('category', category);
    if (department) query = query.eq('department', department);

    const { data: catBudgets } = await query;

    if (catBudgets && catBudgets.length > 0) {
      for (const budget of catBudgets) {
        const type: BudgetCheckResult['type'] = category ? 'CATEGORY_BUDGET' : 'DEPARTMENT_BUDGET';
        results.push(checkSingleBudget(budget, transactionAmount, type, policy));
      }
    }
  }

  // ── 3. Check budget by direct ID if provided ──
  if (budget_id) {
    // BUG-009 FIX: Changed supabase.schema('finance').from('budgets') to
    // supabase.schema('finance').from('budgets').
    const budget = getData(
      await supabase
        .schema('finance')
        .from('budgets')
        .select('*')
        .eq('id', budget_id)
        .eq('organization_id', organization_id)
        .maybeSingle()
    );

    if (budget) {
      results.push(checkSingleBudget(budget, transactionAmount, 'DIRECT_BUDGET', policy));
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
