import { NextRequest, NextResponse } from 'next/server';
import { getAuthUser } from '@/lib/api-auth';
import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';

function db() {
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { cookies: { getAll: async () => (await cookies()).getAll(), setAll: () => {} } }
  );
}

// ═════════════════════════════════════════════════════════════════════
//  YEAR-END CLOSE — Close fiscal year, transfer P&L to Retained Earnings
//  CEO/FINANCE_HEAD only. Creates closing journal entries.
// ═════════════════════════════════════════════════════════════════════

export async function POST(req: NextRequest) {
  const supabase = db();

  // ─── 1. AUTHENTICATE — CEO/FINANCE_HEAD only ───
  const auth = await getAuthUser();
  if (auth instanceof NextResponse) return auth;

  if (!['CEO', 'FINANCE_HEAD'].includes(auth.role)) {
    return NextResponse.json({ error: 'Only CEO or FINANCE_HEAD can close a fiscal year' }, { status: 403 });
  }

  try {
    const { fiscalYearId, confirm } = await req.json();
    if (!fiscalYearId || confirm !== true) {
      return NextResponse.json({ error: 'fiscalYearId and confirm=true required' }, { status: 400 });
    }

    // ─── 2. FETCH FISCAL YEAR ───
    const { data: rawFy, error: fyErr } = await supabase
      .from('finance.fiscal_years')
      .select('*, accounting_periods:finance.accounting_periods(id, status, start_date, end_date)')
      .eq('id', fiscalYearId)
      .single();

    if (fyErr || !rawFy) {
      return NextResponse.json({ error: 'Fiscal year not found' }, { status: 404 });
    }

    // Cast to any to bypass Supabase nested-relation ParserError on generated types
    const fy = rawFy as any;

    if (fy.status === 'HARD_CLOSED') {
      return NextResponse.json({ error: 'Fiscal year is already HARD_CLOSED' }, { status: 400 });
    }

    // ─── 3. VERIFY ALL PERIODS ARE SOFT_CLOSED ───
    const periods = fy.accounting_periods || [];
    const openPeriods = periods.filter((p: any) => p.status === 'OPEN');
    if (openPeriods.length > 0) {
      return NextResponse.json({ error: `Cannot close: ${openPeriods.length} period(s) still OPEN. Close all periods first.` }, { status: 400 });
    }

    // ─── 4. CALCULATE P&L FROM JOURNAL LINES ───
    // Get all posted journal lines for this fiscal year
    const periodIds = periods.map((p: any) => p.id);
    
    const { data: pnlLines, error: pnlErr } = await supabase
      .from('finance.journal_lines')
      .select(`
        debit_amount,
        credit_amount,
        chart_of_accounts!inner(id, code, name, account_type)
      `)
      .in('journal_entry_id', (await supabase
        .from('finance.journal_entries')
        .select('id')
        .in('period_id', periodIds)
        .eq('status', 'POSTED')
      ).data?.map((j: any) => j.id) || []);

    if (pnlErr) {
      return NextResponse.json({ error: 'Failed to calculate P&L: ' + pnlErr.message }, { status: 500 });
    }

    // Aggregate by account type
    const revenueAccounts = ['INCOME', 'OTHER_INCOME'];
    const expenseAccounts = ['OPERATING_EXPENSE', 'COST_OF_SALES', 'OTHER_EXPENSE', 'TAX_EXPENSE'];
    
    let totalRevenue = 0;
    let totalExpenses = 0;

    (pnlLines || []).forEach((line: any) => {
      const acct = line.chart_of_accounts;
      if (!acct) return;
      const net = Number(line.credit_amount || 0) - Number(line.debit_amount || 0);
      if (revenueAccounts.includes(acct.account_type)) {
        totalRevenue += net;
      } else if (expenseAccounts.includes(acct.account_type)) {
        totalExpenses += Math.abs(net);
      }
    });

    const netIncome = totalRevenue - totalExpenses;

    // ─── 5. FIND RETAINED EARNINGS ACCOUNT ───
    const { data: reAccount } = await supabase
      .from('finance.chart_of_accounts')
      .select('id, code, name')
      .eq('account_type', 'EQUITY')
      .ilike('name', '%retained%earning%')
      .eq('is_active', true)
      .limit(1)
      .single();

    // Fallback: any EQUITY account
    let reAccountId = reAccount?.id;
    if (!reAccountId) {
      const { data: fallbackEquity } = await supabase
        .from('finance.chart_of_accounts')
        .select('id')
        .eq('account_type', 'EQUITY')
        .eq('is_active', true)
        .limit(1)
        .single();
      reAccountId = fallbackEquity?.id;
    }

    if (!reAccountId) {
      return NextResponse.json({ error: 'No Retained Earnings (EQUITY) account found in Chart of Accounts' }, { status: 400 });
    }

    // ─── 6. CREATE CLOSING JOURNAL ENTRY ───
    const { data: numData } = await supabase.rpc('get_next_number', { p_type: 'CLOSING_ENTRY' });
    const reference = numData || `JE-CLOSE-${Date.now()}`;

    const { data: journal, error: jErr } = await supabase
      .from('finance.journal_entries')
      .insert({
        reference,
        description: `Year-End Close: ${fy.name} — P&L to Retained Earnings`,
        status: 'POSTED',
        entry_date: fy.end_date || periods[periods.length - 1]?.end_date || new Date().toISOString().split('T')[0],
        period_id: periodIds[periodIds.length - 1],
        total_debit: Math.abs(netIncome),
        total_credit: Math.abs(netIncome),
        source_type: 'YEAR_END_CLOSE',
        created_by: auth.userId,
        posted_by: auth.userId,
        posted_at: new Date().toISOString(),
      })
      .select()
      .single();

    if (jErr || !journal) {
      return NextResponse.json({ error: 'Failed to create closing journal: ' + (jErr?.message || 'unknown') }, { status: 500 });
    }

    // Create journal lines
    const lines: any[] = [];

    if (netIncome >= 0) {
      // Net income: DR Revenue accounts (close), CR Expense accounts (close), DR/CR RE
      // Simpler approach: single entry to RE
      lines.push({
        journal_entry_id: journal.id, line_number: 1, account_id: reAccountId,
        debit_amount: netIncome, credit_amount: 0,
        description: `Net Income for ${fy.name} transferred to Retained Earnings`,
      });
    } else {
      lines.push({
        journal_entry_id: journal.id, line_number: 1, account_id: reAccountId,
        debit_amount: 0, credit_amount: Math.abs(netIncome),
        description: `Net Loss for ${fy.name} transferred to Retained Earnings`,
      });
    }

    const { error: lErr } = await supabase.from('finance.journal_lines').insert(lines);
    if (lErr) {
      await supabase.from('finance.journal_entries').delete().eq('id', journal.id);
      return NextResponse.json({ error: 'Failed to create closing lines: ' + lErr.message }, { status: 500 });
    }

    // ─── 7. HARD CLOSE FISCAL YEAR ───
    const { error: closeErr } = await supabase
      .from('finance.fiscal_years')
      .update({ 
        status: 'HARD_CLOSED', 
        closed_by: auth.userId, 
        closed_at: new Date().toISOString(),
        closing_journal_id: journal.id,
        net_income: netIncome,
      })
      .eq('id', fiscalYearId);

    if (closeErr) {
      return NextResponse.json({ error: 'Fiscal year close failed: ' + closeErr.message }, { status: 500 });
    }

    // Close all periods to HARD_CLOSED
    await supabase.from('finance.accounting_periods').update({ status: 'HARD_CLOSED' }).in('id', periodIds);

    // ─── 8. AUDIT LOG ───
    try {
      await supabase.from('audit.audit_log').insert({
        user_id: auth.userId, action: 'YEAR_END_CLOSE', module: 'FISCAL_YEAR', record_id: fiscalYearId,
        details: JSON.stringify({ reference, net_income: netIncome, total_revenue: totalRevenue, total_expenses: totalExpenses }),
      });
    } catch {}

    return NextResponse.json({
      success: true,
      message: `Fiscal year closed. Net ${netIncome >= 0 ? 'Income' : 'Loss'}: PKR ${Math.abs(netIncome).toLocaleString()}`,
      reference,
      netIncome,
      totalRevenue,
      totalExpenses,
      closingJournalId: journal.id,
    });

  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'Internal server error' }, { status: 500 });
  }
}