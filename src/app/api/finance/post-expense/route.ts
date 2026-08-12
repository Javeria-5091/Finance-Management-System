import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { requirePermission } from '@/lib/api-auth';
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
      if (force_budget_override && ['CEO', 'FINANCE_HEAD', 'Admin'].includes(auth.role)) {
        // Allow with override — log the override in audit
        try {
          supabase.schema('audit').rpc('log_action', {
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

    // 3. Open period
    const period = getData(await supabase
      .from('finance.accounting_periods')
      .select('id')
      .eq('status', 'OPEN')
      .order('start_date', { ascending: false })
      .limit(1)
      .single());
    if (!period) {
      return NextResponse.json({ error: 'No OPEN accounting period found' }, { status: 400 });
    }

    // 4. Find expense account (FIXED: escape LIKE wildcards)
    let expenseAccountId: string | null = null;
    if (expense.category) {
      const escapedCategory = expense.category.replace(/[%_]/g, '\\$&');
      const matched = getData(await supabase
        .from('finance.chart_of_accounts')
        .select('id, code, name')
        .eq('account_type', 'OPERATING_EXPENSE')
        .eq('is_active', true)
        .ilike('name', `%${escapedCategory}%`)
        .limit(1)
        .single());
      expenseAccountId = matched?.id || null;
    }

    if (!expenseAccountId) {
      const opex = getData(await supabase
        .from('finance.chart_of_accounts')
        .select('id, code, name')
        .eq('account_type', 'OPERATING_EXPENSE')
        .eq('is_active', true)
        .limit(1)
        .single());
      expenseAccountId = opex?.id || null;
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

    // 6. Reference number (FIXED: use DB sequence instead of client-side increment)
    const { data: numData } = await supabase.rpc('get_next_number', { p_type: 'JE-EX' });
    const reference = numData || `JE-EX-${Date.now()}`;

    // 7. Create journal header (FIXED: create as APPROVED, then post via engine)
    const journal = getData(await supabase
      .from('finance.journal_entries')
      .insert({
        reference,
        description: `Expense: ${expense.title}${expense.category ? ` [${expense.category}]` : ''}`,
        status: 'APPROVED', // Not POSTED yet — use posting engine
        entry_date: expense.expense_date,
        period_id: period.id,
        project_id: expense.project_id,
        source_type: 'EXPENSE',
        source_id: expenseId,
        total_debit: expense.amount,
        total_credit: expense.amount,
        created_by: auth.userId,
        approved_by: auth.userId,
        approved_at: new Date().toISOString(),
      })
      .select()
      .single());
    if (!journal) {
      return NextResponse.json({ error: 'Failed to create journal entry' }, { status: 500 });
    }

    // 8. Create journal lines
    const linesError = (await supabase.from('finance.journal_lines').insert([
      {
        journal_entry_id: journal.id,
        account_id: expenseAccountId,
        debit_amount: expense.amount,
        credit_amount: 0,
        description: `Expense: ${expense.title}`,
      },
      {
        journal_entry_id: journal.id,
        account_id: creditAccountId,
        debit_amount: 0,
        credit_amount: expense.amount,
        description: `Payable for: ${expense.title}`,
      },
    ])).error;

    if (linesError) {
      // Cleanup on failure
      await supabase.from('finance.journal_entries').delete().eq('id', journal.id);
      return NextResponse.json({ error: 'Failed to create journal lines' }, { status: 500 });
    }

    // 9. Post via GL engine (FIXED: use posting engine, not direct status update)
    const { error: postErr } = await supabase.rpc('finance.post_journal_entry', {
      p_journal_id: journal.id,
      p_posted_by: auth.userId,
    });

    if (postErr) {
      // Rollback: delete lines and header
      await supabase.from('finance.journal_lines').delete().eq('journal_entry_id', journal.id);
      await supabase.from('finance.journal_entries').delete().eq('id', journal.id);
      return NextResponse.json({ error: 'GL posting failed: ' + postErr.message }, { status: 500 });
    }

    // 10. Update expense status
    const { error: statusErr } = await supabase.from("expenses").update({
      status: 'POSTED',
      posted_at: new Date().toISOString(),
      journal_entry_id: journal.id,
      posted_by: auth.userId,
    }).eq("id", expenseId);

    if (statusErr) {
      console.error('Expense status update failed after GL post:', statusErr.message);
      // GL entry exists but expense status not updated — manual reconciliation needed
    }

        //  FIX: Use RPC for correct audit columns
    try {
      supabase.schema('audit').rpc('log_action', {
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
      console.error('Audit log failed for expense post:', auditErr);
    }

    return NextResponse.json({
      success: true,
      journalId: journal.id,
      reference,
      message: `Posted ${reference}`,
      budget_check: budgetCheck.blocked ? { overridden: true } : { warning: budgetCheck.warning, checks: budgetCheck.checks.length },
    });

  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}