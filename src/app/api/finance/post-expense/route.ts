import { NextRequest, NextResponse } from 'next/server';
import { getAuthSupabase } from '@/lib/api-auth';
import { requirePermission } from '@/lib/api-auth';
import { enforceMFA } from '@/lib/mfa-middleware';
import { checkBudgetForTransaction, createBudgetAlertNotifications } from '@/services/budget-check.service';
import { postExpenseSchema, validateBody } from '@/lib/validations';
 
function getData<T = any>(res: any): T | null {
  return res?.data ?? null;
}
 
export async function POST(req: NextRequest) {
  // ─── AUTH CHECK ───
  // FIXED: Use APPROVE permission, not CREATE — posting to GL requires approval-level access
  const auth = await requirePermission('APPROVE_EXPENSE');
  if (auth instanceof NextResponse) return auth;
  // H3 FIX: Enforce MFA for financial posting
  const mfaCheck = await enforceMFA(auth);
  if (mfaCheck) return mfaCheck;
  const { supabase } = await getAuthSupabase(req);
 
  const orgId = auth.orgId;
  if (!orgId) {
    return NextResponse.json({ error: 'Organization ID not found' }, { status: 400 });
  }
 
  try {
    // P0 FIX: Zod input validation
    const rawBody = await req.json();
    const validation = validateBody(postExpenseSchema, rawBody);
    if (!validation.success) {
      return NextResponse.json({ error: validation.error }, { status: 400 });
    }
    const { expenseId, force_budget_override } = validation.data;
 
    // 1. Fetch expense (with org isolation)
    const expense = getData(await supabase
      .from("expenses")
      .select("*")
      .eq("id", expenseId)
      .eq("organization_id", orgId)
      .single());
    if (!expense) {
      return NextResponse.json({ error: 'Expense not found' }, { status: 404 });
    }
    if (expense.status !== 'APPROVED') {
      return NextResponse.json({ error: 'Only APPROVED expenses can be posted. Current: ' + expense.status }, { status: 400 });
    }
 
    // 2. Already posted? (Idempotency check)
    const existingJournal = getData(await supabase
      .from('finance.journal_entries')
      .select('id, reference')
      .eq('source_type', 'EXPENSE')
      .eq('source_id', expenseId)
      .maybeSingle());
    if (existingJournal) {
      return NextResponse.json({
        error: 'Already posted to GL',
        journalId: existingJournal.id,
        reference: existingJournal.reference,
      }, { status: 400 });
    }
 
    // ─── BUDGET CHECK (Spec 5.4: Warn or block transactions exceeding budget) ───
    // Check budget before posting to GL. If HARD_BLOCK policy is active and budget
    // is exceeded, the transaction is rejected unless force_budget_override is provided
    // by a CEO or FINANCE_HEAD.
    const budgetCheck = await checkBudgetForTransaction({
      project_id: expense.project_id || undefined,
      department: expense.department || undefined,
      category: expense.category || undefined,
      amount: expense.amount,
      currency: expense.currency || 'PKR',
      organization_id: orgId,
    });
 
    // Create budget threshold alert notifications (Spec 13.4)
    if (budgetCheck.notifications && budgetCheck.notifications.length > 0) {
      await createBudgetAlertNotifications(
        budgetCheck.notifications,
        orgId,
        auth.userId,
        expenseId
      );
    }
 
    // Enforce budget block (unless overridden by authorized role)
    if (budgetCheck.blocked) {
      // BUG-026 FIX: Removed 'Admin' from override roles — per spec Appendix A,
      // Technical Admin has NO finance data access.
      if (force_budget_override && ['CEO', 'FINANCE_HEAD'].includes(auth.role)) {
        // Allow with override — log the override in audit
        try {
          await supabase.schema('audit').rpc('log_action', {
            p_user_id: auth.userId,
            p_action: 'BUDGET_OVERRIDE',
            p_entity_type: 'expense',
            p_entity_id: expenseId,
            p_description: `Budget override on expense posting by ${auth.role}. Budget was exceeded but posting allowed.`,
            p_previous_status: 'APPROVED',
            p_new_status: 'APPROVED',
            p_source_module: 'budget',
            p_severity: 'high',
            p_new_values: {
              budget_checks: budgetCheck.checks.map(c => ({
                budget_id: c.budget_id,
                warning_level: c.warning_level,
                utilization_after: c.utilization_after,
              })),
              override_by: auth.userId,
              override_role: auth.role,
              expense_amount: expense.amount,
            },
          });
        } catch (overrideAuditErr: any) {
          console.error('Budget override audit log failed:', overrideAuditErr);
        }
      } else {
        // BLOCKED — return budget check results with 422 status
        return NextResponse.json({
          error: 'Transaction blocked: exceeds budget limit',
          allowed: false,
          blocked: true,
          warning: budgetCheck.warning,
          enforcement_mode: budgetCheck.enforcement_mode,
          budget_checks: budgetCheck.checks,
          message: budgetCheck.message,
          hint: 'CEO or FINANCE_HEAD can override by passing force_budget_override: true',
        }, { status: 422 });
      }
    }
 
    // BUG-020 FIX: Open period with org filter
    // 3. Open period
    let auditLogFailed = false;
    const period = getData(await supabase
      .from('finance.accounting_periods')
      .select('id')
      .eq('status', 'OPEN')
      .eq('organization_id', orgId)
      .order('start_date', { ascending: false })
      .limit(1)
      .single());
    if (!period) {
      return NextResponse.json({ error: 'No OPEN accounting period found' }, { status: 400 });
    }
 
    // 4. Find expense account (BUG-013 FIX, High: deterministic account
    // resolution). Root cause: `expense.category` is free text (no FK to
    // chart_of_accounts — Spec 10.5 calls for "Foreign keys, not free text"
    // but the current schema has no category→account mapping table, so a
    // full FK-based fix would need a schema change + expense-form change
    // out of scope for this minimal remediation). Within that constraint,
    // the previous implementation had two real problems this fixes:
    //   1. `.ilike('name', '%category%').limit(1).single()` — a broad
    //      substring match with NO ORDER BY. If two accounts both contain
    //      the substring (e.g. "Travel" matches "Travel Expenses" AND
    //      "Travel & Entertainment"), Postgres may return either one in
    //      arbitrary/index order, so which GL account a given expense
    //      category posts to could vary nondeterministically between
    //      requests — a real financial-correctness risk.
    //   2. On no match, it silently fell back to "any active
    //      OPERATING_EXPENSE account", which could mispost an expense to a
    //      completely unrelated account with no signal to the user.
    // Fix: try an exact (case-insensitive) name match first — deterministic
    // for the common case of a well-maintained COA. If that's ambiguous or
    // absent, fall back to substring match ordered by `code` (deterministic,
    // not query-plan-dependent) and surface a warning in the response so the
    // caller can see the category wasn't a clean match rather than silently
    // guessing.
    let expenseAccountId: string | null = null;
    let accountResolutionWarning: string | null = null;
    if (expense.category) {
      const escapedCategory = expense.category.replace(/[%_]/g, '\\$&');

      const exactMatches = (await supabase
        .from('finance.chart_of_accounts')
        .select('id, code, name')
        .eq('account_type', 'OPERATING_EXPENSE')
        .eq('is_active', true)
        .ilike('name', escapedCategory) // exact match, case-insensitive, no wildcards
        .order('code', { ascending: true })).data ?? [];

      if (exactMatches.length === 1) {
        expenseAccountId = exactMatches[0].id;
      } else if (exactMatches.length > 1) {
        expenseAccountId = exactMatches[0].id;
        accountResolutionWarning = `Category "${expense.category}" exactly matched ${exactMatches.length} active expense accounts (${exactMatches.map((a: any) => a.code).join(', ')}); posted to ${exactMatches[0].code} deterministically (lowest code). Consider renaming duplicate accounts.`;
      } else {
        const substringMatches = (await supabase
          .from('finance.chart_of_accounts')
          .select('id, code, name')
          .eq('account_type', 'OPERATING_EXPENSE')
          .eq('is_active', true)
          .ilike('name', `%${escapedCategory}%`)
          .order('code', { ascending: true })).data ?? [];

        if (substringMatches.length >= 1) {
          expenseAccountId = substringMatches[0].id;
          if (substringMatches.length > 1) {
            accountResolutionWarning = `Category "${expense.category}" did not exactly match any account name; partially matched ${substringMatches.length} accounts (${substringMatches.map((a: any) => a.code).join(', ')}), posted to ${substringMatches[0].code} deterministically (lowest code). Consider adding an exact-named account for this category.`;
          } else {
            accountResolutionWarning = `Category "${expense.category}" did not exactly match any account name; posted to closest partial match ${substringMatches[0].code} (${substringMatches[0].name}).`;
          }
        }
      }
    }
 
    if (!expenseAccountId) {
      const opex = getData(await supabase
        .from('finance.chart_of_accounts')
        .select('id, code, name')
        .eq('account_type', 'OPERATING_EXPENSE')
        .eq('is_active', true)
        .order('code', { ascending: true })
        .limit(1)
        .maybeSingle());
      expenseAccountId = opex?.id || null;
      if (opex) {
        accountResolutionWarning = `No expense account matched category "${expense.category || '(none)'}"; posted to default expense account ${opex.code} (${opex.name}). Please verify or correct the category.`;
      }
    }
 
    // 5. Payable / Liability account
    const payableAccount = getData(await supabase
      .from('finance.chart_of_accounts')
      .select('id, code, name')
      .eq('account_type', 'LIABILITY')
      .eq('is_active', true)
      .like('code', '21%')
      .limit(1)
      .single());
 
    let fallbackLiability = null;
    if (!payableAccount) {
      fallbackLiability = getData(await supabase
        .from('finance.chart_of_accounts')
        .select('id, code, name')
        .eq('account_type', 'LIABILITY')
        .eq('is_active', true)
        .limit(1)
        .single());
    }
 
    const creditAccountId = payableAccount?.id || fallbackLiability?.id;
 
    if (!expenseAccountId || !creditAccountId) {
      return NextResponse.json({
        error: 'Required accounts not found. Set up OPERATING_EXPENSE and LIABILITY accounts.'
      }, { status: 400 });
    }
 
    // 6-9. Post via GL engine (BUG-001 FIX: use RPC with CORRECT signature)
    // The RPC creates header + lines + sets POSTED status atomically.
    // Previous code manually inserted header+lines then called RPC with wrong params.
    const journalLines = [
      {
        account_id: expenseAccountId,
        debit_amount: expense.amount,
        credit_amount: 0,
        description: `Expense: ${expense.title}`,
      },
      {
        account_id: creditAccountId,
        debit_amount: 0,
        credit_amount: expense.amount,
        description: `Payable for: ${expense.title}`,
      },
    ];
 
    const { data: journalId, error: postErr } = await supabase.rpc('finance.post_journal_entry', {
      p_description: `Expense: ${expense.title}${expense.category ? ` [${expense.category}]` : ''}`,
      p_transaction_date: expense.expense_date,
      p_period_id: period.id,
      p_lines: JSON.stringify(journalLines),
      p_currency: expense.currency || 'PKR',
      p_exchange_rate: expense.exchange_rate || 1,
      p_source_type: 'EXPENSE',
      p_source_id: expenseId,
      p_project_id: expense.project_id || null,
      p_department_id: expense.department || null,
    });
 
    if (postErr || !journalId) {
      return NextResponse.json({ error: 'GL posting failed: ' + (postErr?.message || 'Unknown error') }, { status: 500 });
    }
 
    // Fetch the created journal to get reference number
    const journal = getData(await supabase
      .from('finance.journal_entries')
      .select('id, reference')
      .eq('id', journalId)
      .single());
    // C6 FIX: Null guard — journal may not exist if RPC returned bad ID
    if (!journal) {
      return NextResponse.json({ error: 'Journal created but fetch failed. Check journal ID: ' + journalId }, { status: 500 });
    }
    const reference = journal.reference || `JE-EX-${journalId}`;
 
    // 10. Update expense status
    const { error: statusErr } = await supabase.from("expenses").update({
      status: 'POSTED',
      posted_at: new Date().toISOString(),
      journal_entry_id: journalId,
      posted_by: auth.userId,
    }).eq("id", expenseId);
 
    if (statusErr) {
      console.error('Expense status update failed after GL post:', statusErr.message);
      // GL entry exists but expense status not updated — manual reconciliation needed
    }
 
    // FIX: Use RPC for correct audit columns
    try {
      await supabase.schema('audit').rpc('log_action', {
        p_user_id: auth.userId,
        p_action: 'EXPENSE_POSTED',
        p_entity_type: 'expense',
        p_entity_id: expenseId,
        p_description: `Posted expense to GL: ${reference}`,
        p_previous_status: 'APPROVED',
        p_new_status: 'POSTED',
        p_source_module: 'expense',
        p_severity: 'high',
        p_new_values: {
          reference,
          amount: expense.amount,
          journal_id: journal.id,
          budget_warning: budgetCheck.warning,
          budget_overridden: !!force_budget_override,
        },
        p_related_journal_id: journal.id,
      });
    } catch (auditErr: any) {
      // BUG-023 FIX (partial — audit-failure visibility): a failed audit
      // write for a P0 financial posting must not just vanish into a
      // server log that nobody watches (Spec 8.1: "every action... must be
      // attributable"). We deliberately do NOT fail/roll back the posting
      // here — the GL entry is already correctly posted and reverting a
      // successful financial posting because a *logging* call failed would
      // be worse (Spec: posted entries are immutable; a synthetic rollback
      // here would itself need a reversal entry). Instead the failure is
      // surfaced to the caller via `audit_log_warning` below so it is at
      // least visible to the user/ops rather than silently swallowed.
      console.error('Audit log failed for expense post:', auditErr);
      auditLogFailed = true;
    }
 
    return NextResponse.json({
      success: true,
      journalId: journal.id,
      reference,
      message: `Posted ${reference}`,
      budget_check: budgetCheck.blocked ? { overridden: true } : { warning: budgetCheck.warning, checks: budgetCheck.checks.length },
      account_resolution_warning: accountResolutionWarning,
      audit_log_warning: auditLogFailed ? 'Posting succeeded but the audit log entry failed to write. Please notify an administrator.' : undefined,
    });
 
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}