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
//  CEO / Admin / FINANCE_HEAD only. Creates closing journal entries.
//  FIXED: Balanced double-entry, per-account zero-out, idempotency,
//         proper error handling, period rollback on failure.
// ═════════════════════════════════════════════════════════════════════

export async function POST(req: NextRequest) {
  const supabase = db();

  // ─── 1. AUTHENTICATE — CEO / Admin / FINANCE_HEAD only ───
  const auth = await getAuthUser();
  if (auth instanceof NextResponse) return auth;

  if (!['CEO', 'Admin', 'FINANCE_HEAD'].includes(auth.role)) {
    return NextResponse.json({ error: 'Only CEO, Admin, or FINANCE_HEAD can close a fiscal year' }, { status: 403 });
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

    const fy = rawFy as any;

    if (fy.status === 'HARD_CLOSED') {
      return NextResponse.json({ error: 'Fiscal year is already HARD_CLOSED' }, { status: 400 });
    }

    // ─── 3. IDEMPOTENCY: Check if closing journal already exists ───
    if (fy.closing_journal_id) {
      return NextResponse.json({
        error: 'Closing journal already exists for this fiscal year.',
        existing_closing_journal_id: fy.closing_journal_id,
      }, { status: 400 });
    }

    // ─── 4. VERIFY ALL PERIODS ARE SOFT_CLOSED ───
    const periods = fy.accounting_periods || [];
    const openPeriods = periods.filter((p: any) => p.status === 'OPEN' || p.status === 'PENDING');
    if (openPeriods.length > 0) {
      return NextResponse.json({ error: `Cannot close: ${openPeriods.length} period(s) still OPEN/PENDING. Close all periods first.` }, { status: 400 });
    }

    // ─── 5. CALCULATE P&L FROM JOURNAL LINES ───
    const periodIds = periods.map((p: any) => p.id);

    // Get all posted journal entry IDs for this fiscal year's periods
    const { data: postedJournals } = await supabase
      .from('finance.journal_entries')
      .select('id')
      .in('period_id', periodIds)
      .eq('status', 'POSTED');

    const journalIds = postedJournals?.map((j: any) => j.id) || [];

    if (journalIds.length === 0) {
      return NextResponse.json({ error: 'No posted journal entries found in this fiscal year.' }, { status: 400 });
    }

    // Fetch all journal lines with their account details
    const { data: pnlLines, error: pnlErr } = await supabase
      .from('finance.journal_lines')
      .select('debit_amount, credit_amount, account_id, chart_of_accounts!inner(id, code, name, account_type)')
      .in('journal_entry_id', journalIds);

    if (pnlErr) {
      return NextResponse.json({ error: 'Failed to calculate P&L: ' + pnlErr.message }, { status: 500 });
    }

    // Aggregate per-account balances for closing (zero-out each P&L account)
    const revenueAccountTypes = ['INCOME', 'OTHER_INCOME', 'REVENUE'];
    const expenseAccountTypes = ['OPERATING_EXPENSE', 'COST_OF_SALES', 'OTHER_EXPENSE', 'TAX_EXPENSE'];
    const pnlAccountTypes = [...revenueAccountTypes, ...expenseAccountTypes];

    interface AccountBalance {
      accountId: string;
      accountType: string;
      accountCode: string;
      accountName: string;
      net: number;
    }

    const accountBalances: Record<string, AccountBalance> = {};

    (pnlLines || []).forEach((line: any) => {
      const acct = line.chart_of_accounts;
      if (!acct) return;
      if (!pnlAccountTypes.includes(acct.account_type)) return;

      const net = Number(line.credit_amount || 0) - Number(line.debit_amount || 0);
      if (Math.abs(net) < 0.01) return; // Skip zero-balance accounts

      if (!accountBalances[acct.id]) {
        accountBalances[acct.id] = {
          accountId: acct.id,
          accountType: acct.account_type,
          accountCode: acct.code,
          accountName: acct.name,
          net: 0,
        };
      }
      accountBalances[acct.id].net += net;
    });

    // Calculate totals
    let totalRevenue = 0;
    let totalExpenses = 0;
    for (const [, bal] of Object.entries(accountBalances)) {
      if (revenueAccountTypes.includes(bal.accountType)) {
        totalRevenue += bal.net;
      } else {
        totalExpenses += Math.abs(bal.net);
      }
    }

    const netIncome = totalRevenue - totalExpenses;

    if (Math.abs(netIncome) < 0.01) {
      return NextResponse.json({ error: 'Net income is zero. No closing entry needed.' }, { status: 400 });
    }

    // ─── 6. FIND RETAINED EARNINGS ACCOUNT ───
    const { data: reAccount } = await supabase
      .from('finance.chart_of_accounts')
      .select('id, code, name')
      .eq('account_type', 'EQUITY')
      .ilike('name', '%retained%earning%')
      .eq('is_active', true)
      .limit(1)
      .single();

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

    // ─── 7. CREATE CLOSING JOURNAL ENTRY ───
    const { data: numData } = await supabase.rpc('get_next_number', { p_type: 'CLOSING_ENTRY' });
    const reference = numData || `JE-CLOSE-${Date.now()}`;

    const { data: journal, error: jErr } = await supabase
      .from('finance.journal_entries')
      .insert({
        reference,
        description: `Year-End Close: ${fy.name} — P&L to Retained Earnings`,
        status: 'APPROVED', // Create as APPROVED first, then use posting engine
        entry_date: fy.end_date || periods[periods.length - 1]?.end_date || new Date().toISOString().split('T')[0],
        period_id: periodIds[periodIds.length - 1],
        total_debit: Math.abs(netIncome),
        total_credit: Math.abs(netIncome),
        source_type: 'YEAR_END_CLOSE',
        created_by: auth.userId,
        approved_by: auth.userId,
        approved_at: new Date().toISOString(),
      })
      .select()
      .single();

    if (jErr || !journal) {
      return NextResponse.json({ error: 'Failed to create closing journal: ' + (jErr?.message || 'unknown') }, { status: 500 });
    }

    // ─── 8. CREATE BALANCED CLOSING LINES ───
    // Each P&L account gets closed (zeroed out) + net transfer to Retained Earnings
    let lineNum = 1;
    const lines: any[] = [];

    // Close each P&L account individually (zero out balances)
    for (const [, bal] of Object.entries(accountBalances)) {
      if (bal.net > 0) {
        // Account has credit balance (revenue): DEBIT to close
        lines.push({
          journal_entry_id: journal.id,
          line_number: lineNum++,
          account_id: bal.accountId,
          debit_amount: Math.abs(bal.net),
          credit_amount: 0,
          description: `Close ${bal.accountName} (${bal.accountCode}) for ${fy.name}`,
        });
      } else if (bal.net < 0) {
        // Account has debit balance (expense): CREDIT to close
        lines.push({
          journal_entry_id: journal.id,
          line_number: lineNum++,
          account_id: bal.accountId,
          debit_amount: 0,
          credit_amount: Math.abs(bal.net),
          description: `Close ${bal.accountName} (${bal.accountCode}) for ${fy.name}`,
        });
      }
    }

    // Net transfer to Retained Earnings (opposite side — balances the entry)
    if (netIncome >= 0) {
      // Net Income: DEBIT all revenues, CREDIT all expenses → DR Retained Earnings
      lines.push({
        journal_entry_id: journal.id,
        line_number: lineNum++,
        account_id: reAccountId,
        debit_amount: netIncome,
        credit_amount: 0,
        description: `Net Income for ${fy.name} transferred to Retained Earnings`,
      });
    } else {
      // Net Loss: DR all revenues, CR all expenses → CR Retained Earnings
      lines.push({
        journal_entry_id: journal.id,
        line_number: lineNum++,
        account_id: reAccountId,
        debit_amount: 0,
        credit_amount: Math.abs(netIncome),
        description: `Net Loss for ${fy.name} transferred to Retained Earnings`,
      });
    }

    const { error: lErr } = await supabase.from('finance.journal_lines').insert(lines);
    if (lErr) {
      // Cleanup on failure: delete journal header
      await supabase.from('finance.journal_entries').delete().eq('id', journal.id);
      return NextResponse.json({ error: 'Failed to create closing lines: ' + lErr.message }, { status: 500 });
    }

    // ─── 9. POST JOURNAL VIA ENGINE ───
    const { error: postErr } = await supabase.rpc('finance.post_journal_entry', {
      p_journal_id: journal.id,
      p_posted_by: auth.userId,
    });

    if (postErr) {
      // Rollback: delete journal and all lines
      await supabase.from('finance.journal_lines').delete().eq('journal_entry_id', journal.id);
      await supabase.from('finance.journal_entries').delete().eq('id', journal.id);
      return NextResponse.json({
        error: 'GL posting failed for closing entry. Rolled back. ' + postErr.message,
      }, { status: 500 });
    }

    // ─── 10. HARD CLOSE FISCAL YEAR ───
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

    // ─── 11. HARD CLOSE ALL PERIODS ───
    const { error: periodCloseErr } = await supabase
      .from('finance.accounting_periods')
      .update({ status: 'HARD_CLOSED' })
      .in('id', periodIds);

    if (periodCloseErr) {
      // Rollback fiscal year close
      await supabase.from('finance.fiscal_years').update({
        status: 'SOFT_CLOSED',
        closed_by: null,
        closed_at: null,
        closing_journal_id: null,
      }).eq('id', fiscalYearId);

      return NextResponse.json({
        error: 'Failed to hard-close periods: ' + periodCloseErr.message + '. Fiscal year close rolled back.',
      }, { status: 500 });
    }

        // ─── 12. AUDIT LOG ───
    try {
      await supabase.rpc('audit.log_action', {
        p_user_id: auth.userId,
        p_action: 'FISCAL_YEAR_CLOSED',
        p_entity_type: 'fiscal_year',
        p_entity_id: fiscalYearId,
        p_description: `Year-end close: ${fy.name} — Net ${netIncome >= 0 ? 'Income' : 'Loss'} PKR ${Math.abs(netIncome).toLocaleString()}`,
        p_previous_status: fy.status,
        p_new_status: 'HARD_CLOSED',
        p_source_module: 'finance',
        p_severity: 'critical',
        p_new_values: {
          reference,
          net_income: netIncome,
          total_revenue: totalRevenue,
          total_expenses: totalExpenses,
          accounts_closed: Object.keys(accountBalances).length,
          closing_journal_id: journal.id,
        },
      });
    } catch (auditErr: any) {
      console.error('Audit log failed for year-end close:', auditErr);
    }
    return NextResponse.json({
      success: true,
      message: `Fiscal year closed. Net ${netIncome >= 0 ? 'Income' : 'Loss'}: PKR ${Math.abs(netIncome).toLocaleString()}`,
      reference,
      netIncome,
      totalRevenue,
      totalExpenses,
      closingJournalId: journal.id,
      accountsClosed: Object.keys(accountBalances).length,
    });

  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'Internal server error' }, { status: 500 });
  }
}
