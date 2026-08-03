import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { getAuthUser, requirePermission, enforceMakerChecker } from '@/lib/api-auth';

function getData<T = any>(res: any): T | null {
  return res?.data ?? null;
}

export async function POST(req: NextRequest) {
  // ─── AUTH CHECK ───
  const auth = await requirePermission('EXPENSE_CREATE');
  if (auth instanceof NextResponse) return auth;

  try {
    const { expenseId } = await req.json();
    if (!expenseId) {
      return NextResponse.json({ error: 'expenseId required' }, { status: 400 });
    }

    // 1. Fetch expense
    const expense = getData(await supabase.from("expenses").select("*").eq("id", expenseId).single());
    if (!expense) {
      return NextResponse.json({ error: 'Expense not found' }, { status: 404 });
    }
    if (expense.status !== 'APPROVED') {
      return NextResponse.json({ error: 'Only APPROVED expenses can be posted' }, { status: 400 });
    }

    // 2. Already posted?
    const existingJournal = getData(await supabase
      .from('finance.journal_entries')
      .select('id')
      .eq('source_type', 'EXPENSE')
      .eq('source_id', expenseId)
      .maybeSingle());
    if (existingJournal) {
      return NextResponse.json({ error: 'Already posted to GL' }, { status: 400 });
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

    // 4. Find expense account
    let expenseAccountId: string | null = null;
    if (expense.category) {
      const matched = getData(await supabase
        .from('finance.chart_of_accounts')
        .select('id, code, name')
        .eq('account_type', 'OPERATING_EXPENSE')
        .eq('is_active', true)
        .ilike('name', `%${expense.category}%`)
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

    // 6. Reference number
    const lastJournal = getData(await supabase
      .from('finance.journal_entries')
      .select('reference')
      .like('reference', 'JE-EX-%')
      .order('reference', { ascending: false })
      .limit(1)
      .single());
    const nextNum = lastJournal ? parseInt(lastJournal.reference.replace('JE-EX-', '')) + 1 : 1;
    const reference = `JE-EX-${String(nextNum).padStart(5, '0')}`;

    // 7. Create journal header
    const journal = getData(await supabase
      .from('finance.journal_entries')
      .insert({
        reference,
        description: `Expense: ${expense.title}${expense.category ? ` [${expense.category}]` : ''}`,
        status: 'POSTED',
        entry_date: expense.expense_date,
        period_id: period.id,
        project_id: expense.project_id,
        source_type: 'EXPENSE',
        source_id: expenseId,
        total_debit: expense.amount,
        total_credit: expense.amount,
        created_by: auth.userId,
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
      await supabase.from('finance.journal_entries').delete().eq('id', journal.id);
      return NextResponse.json({ error: 'Failed to create journal lines' }, { status: 500 });
    }

    // 9. Update expense status
    await supabase.from("expenses").update({
      status: 'POSTED',
      posted_at: new Date().toISOString(),
      journal_entry_id: journal.id,
      posted_by: auth.userId,
    }).eq("id", expenseId);

    return NextResponse.json({
      success: true,
      journalId: journal.id,
      reference,
      message: `Posted ${reference}`,
    });

  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}