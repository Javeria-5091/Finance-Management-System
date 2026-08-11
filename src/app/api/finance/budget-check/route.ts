import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { requirePermission } from '@/lib/api-auth';

function getData<T = any>(res: any): T | null {
  return res?.data ?? null;
}

// ─── POST: Check budget before posting a transaction ───
// Spec: "Warn or block transactions that exceed budget based on configurable policy."
export async function POST(req: NextRequest) {
  const auth = await requirePermission('EXPENSE_READ');
  if (auth instanceof NextResponse) return auth;

  try {
    const { budget_id, project_id, department, category, amount, currency } = await req.json();

    if (!amount) {
      return NextResponse.json({ error: 'amount is required' }, { status: 400 });
    }

    const transactionAmount = Number(amount);
    if (transactionAmount <= 0) {
      return NextResponse.json({ error: 'Amount must be greater than 0' }, { status: 400 });
    }

    const results: any[] = [];

    // Check project budget if project_id provided
    if (project_id) {
      const budget = getData(await supabase
        .from('finance.budgets')
        .select('*')
        .eq('project_id', project_id)
        .eq('status', 'APPROVED')
        .maybeSingle());

      if (budget) {
        const totalBudget = Number(budget.total_amount) || 0;
        const committed = Number(budget.committed_amount) || 0;
        const actual = Number(budget.actual_amount) || 0;
        const available = totalBudget - committed - actual;

        const exceedsBudget = transactionAmount > available;
        const utilizationPercent = totalBudget > 0 ? ((actual + transactionAmount) / totalBudget) * 100 : 0;

        results.push({
          type: 'PROJECT_BUDGET',
          budget_id: budget.id,
          total_budget: totalBudget,
          committed: committed,
          actual: actual,
          available: available,
          transaction_amount: transactionAmount,
          exceeds_budget: exceedsBudget,
          utilization_after_transaction: utilizationPercent.toFixed(1) + '%',
          warning_level: utilizationPercent >= 100 ? 'BLOCKED' : utilizationPercent >= 90 ? 'WARNING' : utilizationPercent >= 75 ? 'CAUTION' : 'OK',
        });
      }
    }

    // Check category/department budget
    if (category || department) {
      let catQuery = supabase
        .from('finance.budgets')
        .select('*')
        .eq('status', 'APPROVED')
        .eq('organization_id', auth.orgId);

      if (category) catQuery = catQuery.eq('category', category);
      if (department) catQuery = catQuery.eq('department', department);

      const { data: catBudgets } = await catQuery;

      if (catBudgets && catBudgets.length > 0) {
        for (const budget of catBudgets) {
          const totalBudget = Number(budget.total_amount) || 0;
          const committed = Number(budget.committed_amount) || 0;
          const actual = Number(budget.actual_amount) || 0;
          const available = totalBudget - committed - actual;

          const exceedsBudget = transactionAmount > available;
          const utilizationPercent = totalBudget > 0 ? ((actual + transactionAmount) / totalBudget) * 100 : 0;

          results.push({
            type: 'CATEGORY_BUDGET',
            budget_id: budget.id,
            category: budget.category,
            department: budget.department,
            total_budget: totalBudget,
            committed,
            actual,
            available,
            transaction_amount: transactionAmount,
            exceeds_budget: exceedsBudget,
            utilization_after_transaction: utilizationPercent.toFixed(1) + '%',
            warning_level: utilizationPercent >= 100 ? 'BLOCKED' : utilizationPercent >= 90 ? 'WARNING' : utilizationPercent >= 75 ? 'CAUTION' : 'OK',
          });
        }
      }
    }

    // Check budget by ID if provided directly
    if (budget_id) {
      const budget = getData(await supabase
        .from('finance.budgets')
        .select('*')
        .eq('id', budget_id)
        .eq('organization_id', auth.orgId)
        .maybeSingle());

      if (budget) {
        const totalBudget = Number(budget.total_amount) || 0;
        const committed = Number(budget.committed_amount) || 0;
        const actual = Number(budget.actual_amount) || 0;
        const available = totalBudget - committed - actual;

        const exceedsBudget = transactionAmount > available;
        const utilizationPercent = totalBudget > 0 ? ((actual + transactionAmount) / totalBudget) * 100 : 0;

        results.push({
          type: 'DIRECT_BUDGET',
          budget_id: budget.id,
          total_budget: totalBudget,
          committed,
          actual,
          available,
          transaction_amount: transactionAmount,
          exceeds_budget: exceedsBudget,
          utilization_after_transaction: utilizationPercent.toFixed(1) + '%',
          warning_level: utilizationPercent >= 100 ? 'BLOCKED' : utilizationPercent >= 90 ? 'WARNING' : utilizationPercent >= 75 ? 'CAUTION' : 'OK',
        });
      }
    }

    // Determine overall result
    const hasBlocked = results.some(r => r.warning_level === 'BLOCKED');
    const hasWarning = results.some(r => r.warning_level === 'WARNING');

    return NextResponse.json({
      allowed: !hasBlocked,
      blocked: hasBlocked,
      warning: hasWarning,
      checks: results,
      message: hasBlocked
        ? 'Transaction BLOCKED: exceeds one or more budget limits'
        : hasWarning
          ? 'WARNING: Transaction approaches budget limit'
          : 'OK: Within all budget limits',
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}