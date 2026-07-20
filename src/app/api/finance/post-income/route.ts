import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { getPeriodByDate } from '@/types/services/fiscal-year.service'; 

export async function POST(req: Request) {
  try {
    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY! // Use service role for backend logic
    );

    const { incomeId, action } = await req.json();
    const user = await supabase.auth.getUser();
    if (!user.data.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    // 1. Fetch Income
    const { data: income, error: fetchError } = await supabase
      .from('incomes')
      .select('*, projects(name)')
      .eq('id', incomeId)
      .single();

    if (fetchError || !income) throw new Error('Income not found');

    // 2. Handle Status Transitions
    if (action === 'SUBMIT') {
      const { error } = await supabase.from('incomes').update({
        status: 'SUBMITTED', submitted_by: user.data.user.id, submitted_at: new Date().toISOString()
      }).eq('id', incomeId);
      if (error) throw error;
      return NextResponse.json({ success: true, status: 'SUBMITTED' });
    }

    if (action === 'APPROVE') {
      const { error } = await supabase.from('incomes').update({
        status: 'APPROVED', approved_by: user.data.user.id, approved_at: new Date().toISOString()
      }).eq('id', incomeId);
      if (error) throw error;
      return NextResponse.json({ success: true, status: 'APPROVED' });
    }

    // 3. POST ACTION (The Double-Entry Magic)
    if (action === 'POST') {
      // Get Period from date
      const { data: periodData } = await supabase.rpc('get_period_by_date', { p_date: income.income_date });
      if (!periodData || periodData.length === 0) throw new Error('No open period found for this date');
      const period = periodData[0];

      // Default Accounts (In production, these come from income.account_id or config)
      const bankAccountId = '1110-uuid-here'; // Replace with actual logic to find Bank Account UUID
      const revenueAccountId = income.account_id || '4110-uuid-here'; 

      // Call Posting Engine
      const { data: journalId, error: postError } = await supabase.rpc('post_journal_entry', {
        p_description: `Income: ${income.title}`,
        p_transaction_date: income.income_date,
        p_period_id: period.id,
        p_currency: income.currency || 'PKR',
        p_exchange_rate: income.exchange_rate || 1,
        p_source_type: 'INCOME',
        p_source_id: incomeId,
        p_project_id: income.project_id,
        p_lines: [
          { account_id: bankAccountId, debit_amount: income.amount, credit_amount: 0, description: 'Cash/Bank Received' },
          { account_id: revenueAccountId, debit_amount: 0, credit_amount: income.amount, description: income.title }
        ]
      });

      if (postError) throw postError;

      // Update Income with Journal Link
      await supabase.from('incomes').update({
        status: 'POSTED',
        journal_entry_id: journalId,
        period_id: period.id,
        posted_at: new Date().toISOString(),
        posted_by: user.data.user.id
      }).eq('id', incomeId);

      return NextResponse.json({ success: true, status: 'POSTED', journal_id: journalId });
    }

    return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}