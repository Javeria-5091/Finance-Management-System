import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { requirePermission } from '@/lib/api-auth';

function getData<T = any>(res: any): T | null {
  return res?.data ?? null;
}

export async function POST(req: NextRequest) {
  // ─── AUTH CHECK ───
  const auth = await requirePermission('INCOME_CREATE');
  if (auth instanceof NextResponse) return auth;

  try {
    const { incomeId } = await req.json();
    if (!incomeId) {
      return NextResponse.json({ error: 'incomeId required' }, { status: 400 });
    }

    // 1. Fetch income
    const income = getData(await supabase.from("incomes").select("*").eq("id", incomeId).single());
    if (!income) {
      return NextResponse.json({ error: 'Income not found' }, { status: 404 });
    }
    if (income.status !== 'APPROVED') {
      return NextResponse.json({ error: 'Only APPROVED incomes can be posted' }, { status: 400 });
    }

    // 2. Already posted?
    const existingJournal = getData(await supabase
      .from('finance.journal_entries')
      .select('id')
      .eq('source_type', 'INCOME')
      .eq('source_id', incomeId)
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

    // 4. Revenue account
    const revenueAccount = getData(await supabase
      .from('finance.chart_of_accounts')
      .select('id, code, name')
      .eq('account_type', 'REVENUE')
      .eq('is_active', true)
      .limit(1)
      .single());

    // 5. Receivable / Asset account
    const receivableAccount = getData(await supabase
      .from('finance.chart_of_accounts')
      .select('id, code, name')
      .eq('account_type', 'ASSET')
      .eq('is_active', true)
      .like('code', '12%')
      .limit(1)
      .single());

    let fallbackAsset = null;
    if (!receivableAccount) {
      fallbackAsset = getData(await supabase
        .from('finance.chart_of_accounts')
        .select('id, code, name')
        .eq('account_type', 'ASSET')
        .eq('is_active', true)
        .limit(1)
        .single());
    }

    const debitAccountId = receivableAccount?.id || fallbackAsset?.id;
    const creditAccountId = revenueAccount?.id;

    if (!debitAccountId || !creditAccountId) {
      return NextResponse.json({
        error: 'Required accounts not found. Set up REVENUE and ASSET accounts in Chart of Accounts.'
      }, { status: 400 });
    }

    // 6. Reference number
    const lastJournal = getData(await supabase
      .from('finance.journal_entries')
      .select('reference')
      .like('reference', 'JE-IN-%')
      .order('reference', { ascending: false })
      .limit(1)
      .single());
    const nextNum = lastJournal ? parseInt(lastJournal.reference.replace('JE-IN-', '')) + 1 : 1;
    const reference = `JE-IN-${String(nextNum).padStart(5, '0')}`;

    // 7. Create journal header
    const journal = getData(await supabase
      .from('finance.journal_entries')
      .insert({
        reference,
        description: `Income: ${income.title}${income.project_id ? ' (Project)' : ''}`,
        status: 'POSTED',
        entry_date: income.income_date,
        period_id: period.id,
        project_id: income.project_id,
        source_type: 'INCOME',
        source_id: incomeId,
        total_debit: income.amount,
        total_credit: income.amount,
        created_by: auth.userId,
      })
      .select()
      .single());
    if (!journal) {
      return NextResponse.json({ error: 'Failed to create journal entry' }, { status: 500 });
    }

    // 8. Create journal lines (double entry)
    const linesError = (await supabase.from('finance.journal_lines').insert([
      {
        journal_entry_id: journal.id,
        account_id: debitAccountId,
        debit_amount: income.amount,
        credit_amount: 0,
        description: `Receivable for: ${income.title}`,
      },
      {
        journal_entry_id: journal.id,
        account_id: creditAccountId,
        debit_amount: 0,
        credit_amount: income.amount,
        description: `Revenue from: ${income.title}`,
      },
    ])).error;

    if (linesError) {
      await supabase.from('finance.journal_entries').delete().eq('id', journal.id);
      return NextResponse.json({ error: 'Failed to create journal lines' }, { status: 500 });
    }

    // 9. Update income status
    await supabase.from("incomes").update({
      status: 'POSTED',
      posted_at: new Date().toISOString(),
      journal_entry_id: journal.id,
      posted_by: auth.userId,
    }).eq("id", incomeId);

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