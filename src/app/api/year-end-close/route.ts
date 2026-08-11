import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { requirePermission } from '@/lib/api-auth';

function getData<T = any>(res: any): T | null {
  return res?.data ?? null;
}

// ─── POST: Year-End Close — Close fiscal year & transfer P&L to Retained Earnings ───
// Spec 12.10: Fiscal-year close and next-year opening
// Spec 4.2 FIX: organization_id filter added to ALL record fetches
// Spec 4.1 FIX: Retained Earnings is CREDITED for profit (not DEBITED)

export async function POST(req: NextRequest) {
  const auth = await requirePermission('YEAR_END_CLOSE');
  if (auth instanceof NextResponse) return auth;

  const orgId = auth.orgId;
  if (!orgId) {
    return NextResponse.json({ error: 'Organization ID not found' }, { status: 400 });
  }

  try {
    const { fiscal_year_id, description } = await req.json();

    if (!fiscal_year_id) {
      return NextResponse.json({ error: 'fiscal_year_id is required' }, { status: 400 });
    }

    // ── 1. Fetch fiscal year (WITH org_id filter — Spec 4.2 FIX) ──
    const fiscalYear = getData(
      await supabase
        .from('finance.fiscal_years')
        .select('*')
        .eq('id', fiscal_year_id)
        .eq('organization_id', orgId)   // ← SECURITY FIX: was missing
        .single()
    );

    if (!fiscalYear) {
      return NextResponse.json({ error: 'Fiscal year not found or access denied' }, { status: 404 });
    }

    if (fiscalYear.status === 'CLOSED') {
      return NextResponse.json({ error: 'Fiscal year is already closed' }, { status: 400 });
    }

    // ── 2. Verify all periods belong to this fiscal year ──
    const periods = getData(
      await supabase
        .from('finance.accounting_periods')
        .select('id, status, start_date, end_date')
        .eq('fiscal_year_id', fiscal_year_id)
        .eq('organization_id', orgId)   // ← SECURITY FIX
        .order('start_date', { ascending: true })
    );

    if (!periods || periods.length === 0) {
      return NextResponse.json({ error: 'No accounting periods found for this fiscal year' }, { status: 400 });
    }

    const unclosedPeriods = periods.filter((p:any)=> p.status !== 'HARD_CLOSED');
    if (unclosedPeriods.length > 0) {
      return NextResponse.json({
        error: `All periods must be hard-closed before year-end close. ${unclosedPeriods.length} periods still open.`,
        unclosed_periods: unclosedPeriods.map((p:any) => ({ id: p.id, status: p.status })),
      }, { status: 400 });
    }

    // ── 3. Get P&L accounts for the fiscal year ──
    // Revenue accounts (normal balance: CREDIT) and Expense accounts (normal balance: DEBIT)
    const { data: revenueAccounts, error: revErr } = await supabase.rpc('finance.get_pnl_accounts', {
      p_fiscal_year_id: fiscal_year_id,
      p_organization_id: orgId,
      p_account_type: 'REVENUE',
    });

    if (revErr) {
      return NextResponse.json({ error: 'Failed to fetch revenue accounts: ' + revErr.message }, { status: 500 });
    }

    const { data: expenseAccounts, error: expErr } = await supabase.rpc('finance.get_pnl_accounts', {
      p_fiscal_year_id: fiscal_year_id,
      p_organization_id: orgId,
      p_account_type: 'EXPENSE',
    });

    if (expErr) {
      return NextResponse.json({ error: 'Failed to fetch expense accounts: ' + expErr.message }, { status: 500 });
    }

    const revenueLines: any[] = revenueAccounts || [];
    const expenseLines: any[] = expenseAccounts || [];

    // ── 4. Calculate totals ──
    const totalRevenue = revenueLines.reduce((sum: number, a: any) => sum + Math.abs(Number(a.balance) || 0), 0);
    const totalExpenses = expenseLines.reduce((sum: number, a: any) => sum + Math.abs(Number(a.balance) || 0), 0);
    const netIncome = totalRevenue - totalExpenses; // positive = profit, negative = loss

    // If zero profit/loss, nothing to close
    if (Math.abs(netIncome) < 0.02) {
      return NextResponse.json({
        success: true,
        message: 'Net income is zero. No closing entry required.',
        total_revenue: totalRevenue,
        total_expenses: totalExpenses,
        net_income: 0,
      });
    }

    // ── 5. Get Retained Earnings account ──
    const retainedEarningsAccount = getData(
      await supabase
        .from('finance.chart_of_accounts')
        .select('id, code, name')
        .eq('account_type', 'EQUITY')
        .eq('code', '3000') // Retained Earnings — adjust code as per your CoA
        .eq('organization_id', orgId)   // ← SECURITY FIX
        .single()
    );

    if (!retainedEarningsAccount) {
      return NextResponse.json({ error: 'Retained Earnings account (3000) not found' }, { status: 400 });
    }

    // ── 6. Build closing journal lines ──
    // CORRECT double-entry accounting:
    //   Profit:  DR all Revenue accounts (zero them out)
    //            CR all Expense accounts (zero them out)
    //            CR Retained Earnings (netIncome) ← was incorrectly DEBITED before
    //   Loss:    DR all Revenue accounts (zero them out)
    //            CR all Expense accounts (zero them out)
    //            DR Retained Earnings (|netIncome|)  ← for loss, RE is debited
    const journalLines: any[] = [];
    let lineNum = 1;

    // DR Revenue accounts to zero them out
    for (const acct of revenueLines) {
      const balance = Math.abs(Number(acct.balance) || 0);
      if (balance > 0.01) {
        journalLines.push({
          line_number: lineNum++,
          account_id: acct.account_id,
          debit: balance,
          credit: 0,
          description: `Year-End Close: Zero revenue account ${acct.account_code || acct.code}`,
        });
      }
    }

    // CR Expense accounts to zero them out
    for (const acct of expenseLines) {
      const balance = Math.abs(Number(acct.balance) || 0);
      if (balance > 0.01) {
        journalLines.push({
          line_number: lineNum++,
          account_id: acct.account_id,
          debit: 0,
          credit: balance,
          description: `Year-End Close: Zero expense account ${acct.account_code || acct.code}`,
        });
      }
    }

    // ── CRITICAL FIX (Spec 4.1): Retained Earnings on CORRECT side ──
    if (netIncome > 0) {
      // PROFIT: CREDIT Retained Earnings (was incorrectly DEBITED before)
      journalLines.push({
        line_number: lineNum++,
        account_id: retainedEarningsAccount.id,
        debit: 0,
        credit: netIncome,
        description: `Year-End Close: Transfer net profit to Retained Earnings`,
      });
    } else {
      // LOSS: DEBIT Retained Earnings
      journalLines.push({
        line_number: lineNum++,
        account_id: retainedEarningsAccount.id,
        debit: Math.abs(netIncome),
        credit: 0,
        description: `Year-End Close: Transfer net loss to Retained Earnings`,
      });
    }

    // Verify balance
    const totalDebit = journalLines.reduce((s: number, l: any) => s + l.debit, 0);
    const totalCredit = journalLines.reduce((s: number, l: any) => s + l.credit, 0);
    if (Math.abs(totalDebit - totalCredit) > 0.02) {
      return NextResponse.json({
        error: `Closing entry is unbalanced! Debit: ${totalDebit}, Credit: ${totalCredit}`,
        total_debit: totalDebit,
        total_credit: totalCredit,
      }, { status: 500 });
    }

    // ── 7. Get reference number ──
    const { data: refData } = await supabase.rpc('get_next_number', {
      p_type: 'YEAR_END_CLOSE',
    });
    const reference = refData || `YEC-${fiscal_year_id.slice(0, 8)}`;

    // ── 8. Create journal header ──
    const journal = getData(
      await supabase
        .from('finance.journal_entries')
        .insert({
          reference,
          description: description || `Year-End Close: FY ${fiscalYear.name || fiscal_year_id}`,
          journal_date: new Date().toISOString().split('T')[0],
          fiscal_year_id: fiscal_year_id,
          organization_id: orgId,
          total_debit: totalDebit,
          total_credit: totalCredit,
          status: 'APPROVED', // Year-end close is auto-approved
          source_type: 'YEAR_END_CLOSE',
          source_id: fiscal_year_id,
          created_by: auth.userId,
        })
        .select()
        .single()
    );

    if (!journal) {
      return NextResponse.json({ error: 'Failed to create journal entry' }, { status: 500 });
    }

    // ── 9. Insert journal lines ──
    const linesWithId = journalLines.map(line => ({
      ...line,
      journal_entry_id: journal.id,
      organization_id: orgId,
    }));

    const linesError = (await supabase.from('finance.journal_lines').insert(linesWithId)).error;

    if (linesError) {
      await supabase.from('finance.journal_entries').delete().eq('id', journal.id);
      return NextResponse.json({ error: 'Failed to create journal lines: ' + linesError.message }, { status: 500 });
    }

    // ── 10. Post via GL engine ──
    const { error: postErr } = await supabase.rpc('finance.post_journal_entry', {
      p_journal_id: journal.id,
      p_posted_by: auth.userId,
    });

    if (postErr) {
      await supabase.from('finance.journal_lines').delete().eq('journal_entry_id', journal.id);
      await supabase.from('finance.journal_entries').delete().eq('id', journal.id);
      return NextResponse.json({ error: 'GL posting failed: ' + postErr.message }, { status: 500 });
    }

    // ── 11. Close the fiscal year ──
    const { error: fyErr } = await supabase
      .from('finance.fiscal_years')
      .update({
        status: 'CLOSED',
        closed_at: new Date().toISOString(),
        closed_by: auth.userId,
        journal_entry_id: journal.id,
        net_income: netIncome,
      })
      .eq('id', fiscal_year_id)
      .eq('organization_id', orgId);   // ← SECURITY FIX

    if (fyErr) {
      console.error('Fiscal year status update failed:', fyErr.message);
    }

    // ── 12. Audit log ──
    try {
      await supabase.rpc('audit.log_action', {
        p_user_id: auth.userId,
        p_action: 'YEAR_END_CLOSED',
        p_entity_type: 'fiscal_year',
        p_entity_id: fiscal_year_id,
        p_description: `Year-end close: FY ${fiscalYear.name || fiscal_year_id}. Revenue: ${totalRevenue.toFixed(2)}, Expenses: ${totalExpenses.toFixed(2)}, Net: ${netIncome.toFixed(2)} (${netIncome >= 0 ? 'Profit' : 'Loss'}). Journal: ${reference}`,
        p_previous_status: fiscalYear.status,
        p_new_status: 'CLOSED',
        p_source_module: 'year_end_close',
        p_severity: 'high',
        p_new_values: {
          reference,
          total_revenue: totalRevenue,
          total_expenses: totalExpenses,
          net_income: netIncome,
          journal_id: journal.id,
          retained_earnings_account_id: retainedEarningsAccount.id,
        },
        p_related_journal_id: journal.id,
      });
    } catch (auditErr: any) {
      console.error('Audit log failed:', auditErr);
    }

    return NextResponse.json({
      success: true,
      journalId: journal.id,
      reference,
      total_revenue: totalRevenue,
      total_expenses: totalExpenses,
      net_income: netIncome,
      retained_earnings_side: netIncome >= 0 ? 'CREDIT' : 'DEBIT',
      total_debit: totalDebit,
      total_credit: totalCredit,
      balanced: Math.abs(totalDebit - totalCredit) < 0.02,
      message: `Year-end close completed: ${netIncome >= 0 ? 'Profit' : 'Loss'} of PKR ${Math.abs(netIncome).toLocaleString()} transferred to Retained Earnings`,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

// ─── GET: Year-End Close Preview ────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  const auth = await requirePermission('YEAR_END_CLOSE_READ');
  if (auth instanceof NextResponse) return auth;

  const orgId = auth.orgId;
  if (!orgId) {
    return NextResponse.json({ error: 'Organization ID not found' }, { status: 400 });
  }

  try {
    const { searchParams } = new URL(req.url);
    const fiscalYearId = searchParams.get('fiscal_year_id');

    if (!fiscalYearId) {
      return NextResponse.json({ error: 'fiscal_year_id query parameter is required' }, { status: 400 });
    }

    const fiscalYear = getData(
      await supabase
        .from('finance.fiscal_years')
        .select('*')
        .eq('id', fiscalYearId)
        .eq('organization_id', orgId)
        .maybeSingle()
    );

    if (!fiscalYear) {
      return NextResponse.json({ error: 'Fiscal year not found' }, { status: 404 });
    }

    const periods = getData(
      await supabase
        .from('finance.accounting_periods')
        .select('id, status, start_date, end_date')
        .eq('fiscal_year_id', fiscalYearId)
        .eq('organization_id', orgId)
        .order('start_date', { ascending: true })
    );

    const unclosed = (periods || []).filter((p:any) => p.status !== 'HARD_CLOSED');

    return NextResponse.json({
      fiscal_year: {
        id: fiscalYear.id,
        name: fiscalYear.name,
        status: fiscalYear.status,
        start_date: fiscalYear.start_date,
        end_date: fiscalYear.end_date,
      },
      total_periods: periods?.length || 0,
      unclosed_periods: unclosed.length,
      unclosed_details: unclosed,
      ready_to_close: unclosed.length === 0 && fiscalYear.status !== 'CLOSED',
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}