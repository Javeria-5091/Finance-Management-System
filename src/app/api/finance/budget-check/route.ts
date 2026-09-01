import { NextRequest, NextResponse } from 'next/server';
import { unstable_noStore as noStore } from 'next/cache';
import { requirePermission, getAuthSupabase } from '@/lib/api-auth';
import { validateExchangeRate } from '@/lib/validations';
import {
  checkBudgetForTransaction,
  createBudgetAlertNotifications,
  getBudgetPolicy,
  type BudgetPolicyConfig,
} from '@/services/budget-check.service';
 
export async function POST(req: NextRequest) {
  // BUG-014 FIX: budget checks must always be live; never allow route-level caching across fiscal periods.
  noStore();
  const auth = await requirePermission('BUDGET_READ');
  if (auth instanceof NextResponse) return auth;
  // BUG-007 FIX: pass the server-side authenticated supabase client.
  const { supabase } = await getAuthSupabase(req);
 
  const orgId = auth.orgId;
  if (!orgId) {
    return NextResponse.json({ error: 'Organization ID not found' }, { status: 400 });
  }
 
  try {
    const { budget_id, project_id, department, category, amount, currency, exchange_rate, force_allow } = await req.json();
 
    if (!amount) {
      return NextResponse.json({ error: 'amount is required' }, { status: 400 });
    }
 
    const transactionAmount = Number(amount);
    if (transactionAmount <= 0) {
      return NextResponse.json({ error: 'Amount must be greater than 0' }, { status: 400 });
    }

    // AP-04 FIX: this ad-hoc endpoint used to forward whatever `currency`
    // the caller sent straight into checkBudgetForTransaction, which then
    // silently ignored it and compared the raw amount against the (PKR)
    // budget ceiling as if it were already PKR. Budgets are PKR-only, so a
    // non-PKR request must supply an exchange_rate to convert with — same
    // requirement validateExchangeRate already enforces for expenses/bills/
    // invoices before they're posted.
    const rateError = validateExchangeRate(currency, exchange_rate);
    if (rateError) {
      return NextResponse.json({ error: rateError }, { status: 400 });
    }
    const amountPKR = transactionAmount * Number(exchange_rate || 1);
 
    // Run the budget check using the centralized service
    const result = await checkBudgetForTransaction({
      budget_id,
      project_id,
      department,
      category,
      amount: amountPKR,
      currency: 'PKR',
      organization_id: orgId,
      // BUG-007 FIX: pass server-side authenticated supabase client.
      supabaseClient: supabase,
    });
 
    // Handle CEO/Finance Head override with force_allow
    let finalAllowed = result.allowed;
    let overrideMessage: string | null = null;
 
    if (force_allow && result.blocked) {
      // BUG-026 FIX: Removed 'Admin' from override roles — per spec Appendix A,
      // Technical Admin has NO finance data access.
      const overrideRoles = ['CEO', 'FINANCE_HEAD'];
      if (overrideRoles.includes(auth.role)) {
        finalAllowed = true;
        overrideMessage = `Budget override applied by ${auth.role}. Original result was BLOCKED.`;
      } else {
        return NextResponse.json({
          error: 'force_allow requires CEO or FINANCE_HEAD role',
          allowed: false,
          blocked: true,
          checks: result.checks,
        }, { status: 403 });
      }
    }
 
    // Create threshold alert notifications in DB (Spec 13.4)
    if (result.notifications && result.notifications.length > 0) {
      await createBudgetAlertNotifications(
        result.notifications,
        orgId,
        auth.userId,
        `budget-check-${Date.now()}`,
        supabase,
      );
    }
 
    // Build response
    const response: any = {
      allowed: finalAllowed,
      blocked: result.blocked && !finalAllowed,
      warning: result.warning,
      enforcement_mode: result.enforcement_mode,
      policy: result.policy,
      checks: result.checks,
      message: overrideMessage || result.message,
      notification_count: result.notifications?.length || 0,
    };
 
    if (overrideMessage) {
      response.override = {
        applied: true,
        overridden_by: auth.userId,
        overridden_role: auth.role,
        original_blocked: result.blocked,
      };
    }
 
    return NextResponse.json(response);
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
 
// ─── GET: Fetch current organization budget policy configuration ───
// Returns the configurable policy (enforcement_mode, thresholds)
 
export async function GET(req: NextRequest) {
  // BUG-014 FIX: policy reads are request-scoped and must not be cached.
  noStore();
  const auth = await requirePermission('BUDGET_READ');
  if (auth instanceof NextResponse) return auth;
  const { supabase } = await getAuthSupabase(req);
  const orgId = auth.orgId;
  if (!orgId) {
    return NextResponse.json({ error: 'Organization ID not found in auth context' }, { status: 400 });
  }
 
  try {
    const policy: BudgetPolicyConfig = await getBudgetPolicy(orgId, supabase);
 
    return NextResponse.json({
      policy,
      explanation: {
        enforcement_mode: "'WARN_ONLY' = transactions allowed with warnings only. 'HARD_BLOCK' = transactions exceeding budget are blocked unless overridden by CEO/Finance Head.",
        caution_threshold: 'Utilization % at which CAUTION alert triggers (advisory)',
        warning_threshold: 'Utilization % at which WARNING alert triggers (escalation to HOD)',
        block_threshold: 'Utilization % at which BLOCKED triggers (transaction rejected in HARD_BLOCK mode)',
      },
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}