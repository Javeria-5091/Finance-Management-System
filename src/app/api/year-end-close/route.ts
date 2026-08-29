import { NextRequest, NextResponse } from 'next/server';
import { getAuthSupabase } from '@/lib/api-auth';
import { requirePermission } from '@/lib/api-auth';
import { enforceMFA } from '@/lib/mfa-middleware';
import { yearEndCloseSchema, validateBody } from '@/lib/validations';
 
function getData<T = any>(res: any): T | null {
  return res?.data ?? null;
}
 
// ─── POST: Year-End Close — Close fiscal year & transfer P&L to Retained Earnings ───
// Spec 12.10: Fiscal-year close and next-year opening
// Spec 4.2 FIX: organization_id filter added to ALL record fetches
// Spec 4.1 FIX: Retained Earnings is CREDITED for profit (not DEBITED)
// BUG-001 FIX: Replaced manual header+lines insert + wrong RPC({ p_journal_id, p_posted_by })
//   with single atomic RPC call using correct signature.
//
// PERMISSION FIX (BUG-010): 'YEAR_END_CLOSE' / 'YEAR_END_CLOSE_READ' were never
// seeded in core.permissions, so requirePermission() always denied non-CEO
// roles here. Spec §7.3 groups "Period reopen" under Finance Head + CEO and
// the seeded catalog has PERIOD_CLOSE / PERIOD_READ — used here instead.
//
// KNOWN REMAINING ISSUE (BUG-026, not fixed in this pass): the closing entry
// below is posted to `periods[periods.length - 1].id` (the last period of the
// fiscal year), but this route requires every period to already be
// HARD_CLOSED before it will proceed. Posting to an already-hard-closed
// period will be rejected by the period-lock trigger. This needs a proper
// "closing period" concept (e.g. a dedicated adjustment period, or a
// closing-entry exception to the period-lock trigger) rather than a one-line
// fix, so it is intentionally left for a follow-up pass.
 
export async function POST(req: NextRequest) {
  const auth = await requirePermission('PERIOD_CLOSE');
  if (auth instanceof NextResponse) return auth;
  // H3 FIX: Enforce MFA for financial posting
  const mfaCheck = await enforceMFA(auth);
  if (mfaCheck) return mfaCheck;
  const { supabase } = await getAuthSupabase(req);
 
  let auditLogWarning: string | undefined;
  const orgId = auth.orgId;
  if (!orgId) {
    return NextResponse.json({ error: 'Organization ID not found' }, { status: 400 });
  }
 
  try {
    // P0 FIX: Zod input validation (was manual/inconsistent before)
    const rawBody = await req.json();
    const validation = validateBody(yearEndCloseSchema, rawBody);
    if (!validation.success) {
      return NextResponse.json({ error: validation.error }, { status: 400 });
    }
    const { fiscal_year_id, description } = validation.data;
 
    // ── 1. Fetch fiscal year (WITH org_id filter — Spec 4.2 FIX) ──
    const fiscalYear = getData(
      await supabase
        .schema('finance').from('fiscal_years')
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
        .schema('finance').from('accounting_periods')
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
    const { data: revenueAccounts, error: revErr } = await supabase.schema('finance').rpc('get_pnl_accounts', {
      p_fiscal_year_id: fiscal_year_id,
      p_organization_id: orgId,
      p_account_type: 'REVENUE',
    });
 
    if (revErr) {
      return NextResponse.json({ error: 'Failed to fetch revenue accounts: ' + revErr.message }, { status: 500 });
    }
 
    const { data: expenseAccounts, error: expErr } = await supabase.schema('finance').rpc('get_pnl_accounts', {
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
    if (Math.abs(netIncome) < 0.01) {
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
        .schema('finance').from('chart_of_accounts')
        .select('id, code, name')
        .eq('account_type', 'EQUITY')
        .eq('organization_id', orgId)
        .or('code.eq.3000,name.ilike.%retained%earnings%')
        .eq('is_active', true)
        .order('code', { ascending: true })
        .order('name', { ascending: true })
        .limit(1)
        .maybeSingle()
    );
 
    if (!retainedEarningsAccount) {
      return NextResponse.json({ error: 'Retained Earnings account not found. Create an EQUITY account with code 3000 or name containing "Retained Earnings".' }, { status: 400 });
    }
 
    // ── 6. Build closing journal lines for RPC ──
    const rpcLines: any[] = [];
 
    // DR Revenue accounts to zero them out
    for (const acct of revenueLines) {
      const balance = Math.abs(Number(acct.balance) || 0);
      if (balance > 0.01) {
        rpcLines.push({
          account_id: acct.account_id,
          debit_amount: balance,
          credit_amount: 0,
          description: `Year-End Close: Zero revenue account ${acct.account_code || acct.code}`,
        });
      }
    }
 
    // CR Expense accounts to zero them out
    for (const acct of expenseLines) {
      const balance = Math.abs(Number(acct.balance) || 0);
      if (balance > 0.01) {
        rpcLines.push({
          account_id: acct.account_id,
          debit_amount: 0,
          credit_amount: balance,
          description: `Year-End Close: Zero expense account ${acct.account_code || acct.code}`,
        });
      }
    }
 
    // CRITICAL FIX (Spec 4.1): Retained Earnings on CORRECT side
    if (netIncome > 0) {
      // PROFIT: CREDIT Retained Earnings
      rpcLines.push({
        account_id: retainedEarningsAccount.id,
        debit_amount: 0,
        credit_amount: netIncome,
        description: `Year-End Close: Transfer net profit to Retained Earnings`,
      });
    } else {
      // LOSS: DEBIT Retained Earnings
      rpcLines.push({
        account_id: retainedEarningsAccount.id,
        debit_amount: Math.abs(netIncome),
        credit_amount: 0,
        description: `Year-End Close: Transfer net loss to Retained Earnings`,
      });
    }
 
    // Balance check
    const totalDebit = rpcLines.reduce((s: number, l: any) => s + (Number(l.debit_amount) || 0), 0);
    const totalCredit = rpcLines.reduce((s: number, l: any) => s + (Number(l.credit_amount) || 0), 0);
    if (Math.abs(totalDebit - totalCredit) > 0.01) {
      return NextResponse.json({
        error: `Closing entry is unbalanced! Debit: ${totalDebit}, Credit: ${totalCredit}`,
        total_debit: totalDebit,
        total_credit: totalCredit,
      }, { status: 500 });
    }
 
    // ── 7. Get reference number ──
    const { data: refData } = await supabase.schema('finance').rpc('get_next_number', {
      p_type: 'PERIOD_CLOSE',
    });
    const reference = refData || `YEC-${fiscal_year_id.slice(0, 8)}`;
 
    // ── 7.5. BUG-001 FIX (Critical): Resolve OPEN period for the closing entry ──
    // Original code posted the closing entry to `periods[periods.length - 1].id`
    // (the last period of the closing fiscal year), but this route already
    // requires every period of the closing year to be HARD_CLOSED before it
    // will proceed. Posting to a HARD_CLOSED period is rejected by the
    // trg_prevent_closed_period_posting trigger, so the entire close
    // workflow was broken.
    //
    // Spec 12.10 step 6: "Transfer current-year result to retained earnings
    // according to the approved chart of accounts and open the next fiscal
    // year/periods." The closing entry should therefore post to an OPEN
    // period — ideally the first period of the NEXT fiscal year (so the
    // close entry doesn't reopen a closed period). If no next-year period
    // exists yet, fall back to the first OPEN period of the closing year
    // (rare case: closing mid-period before year-end). If neither exists,
    // fail closed with a clear error.
    let closingPeriodId: string | null = null;

    // 7.5.1. Try next fiscal year's first OPEN period.
    const nextFiscalYear = getData(
      await supabase
        .schema('finance').from('fiscal_years')
        .select('id, name, start_date, end_date')
        .eq('organization_id', orgId)
        .gt('start_date', fiscalYear.end_date)
        .order('start_date', { ascending: true })
        .limit(1)
        .maybeSingle()
    );

    if (nextFiscalYear) {
      const nextPeriod = getData(
        await supabase
          .schema('finance').from('accounting_periods')
          .select('id, status')
          .eq('fiscal_year_id', nextFiscalYear.id)
          .eq('organization_id', orgId)
          .eq('status', 'OPEN')
          .order('start_date', { ascending: true })
          .limit(1)
          .maybeSingle()
      );
      if (nextPeriod) {
        closingPeriodId = nextPeriod.id;
      }
    }

    // 7.5.2. Fallback: first OPEN period of the closing fiscal year (rare).
    if (!closingPeriodId) {
      const openPeriod = getData(
        await supabase
          .schema('finance').from('accounting_periods')
          .select('id, status')
          .eq('fiscal_year_id', fiscal_year_id)
          .eq('organization_id', orgId)
          .eq('status', 'OPEN')
          .order('start_date', { ascending: true })
          .limit(1)
          .maybeSingle()
      );
      if (openPeriod) {
        closingPeriodId = openPeriod.id;
      }
    }

    if (!closingPeriodId) {
      return NextResponse.json({
        error: 'No OPEN accounting period found for the closing entry. Open the next fiscal year (or an adjustment period) before retrying year-end close.',
      }, { status: 400 });
    }

    // ── 8. Idempotency guard: if a closing journal already exists for this FY,
    //    never post another closing journal on retry.
    let journalId: string | null = null;
    let postErr: any = null;
    const existingClosingJournal = getData(
      await supabase
        .schema('finance')
        .from('journal_entries')
        .select('id, reference')
        .eq('source_type', 'PERIOD_CLOSE')
        .eq('source_id', fiscal_year_id)
        .eq('organization_id', orgId)
        .limit(1)
        .maybeSingle()
    );

    if (existingClosingJournal) {
      journalId = existingClosingJournal.id;
    } else {
      // Single atomic GL posting using the existing guarded RPC.
      const result = await supabase.schema('finance').rpc('post_journal_entry', {
      p_description: description || `Year-End Close: FY ${fiscalYear.name || fiscal_year_id}`,
      p_transaction_date: new Date().toISOString().split('T')[0],
      p_period_id: closingPeriodId, // BUG-001 FIX: post to an OPEN period, not a HARD_CLOSED one
      p_lines: JSON.stringify(rpcLines),
      p_currency: 'PKR',
      p_exchange_rate: 1,
        p_source_type: 'PERIOD_CLOSE',
        p_source_id: fiscal_year_id,
      });
      journalId = result.data;
      postErr = result.error;
    }
 
    if (postErr || !journalId) {
      return NextResponse.json({ error: 'GL posting failed: ' + (postErr?.message || 'Unknown error') }, { status: 500 });
    }
 
    // Fetch the created journal for reference
    const journal = getData(
      await supabase
        .schema('finance').from('journal_entries')
        .select('id, reference')
        .eq('id', journalId)
        .single()
    );
    // C6 FIX: Null guard
    if (!journal) {
      return NextResponse.json({ error: 'Journal created but fetch failed. Check journal ID: ' + journalId }, { status: 500 });
    }
    const journalReference = journal.reference || reference;
 
    // H11 FIX: Treat fiscal year update failure as ERROR, not silent log
    const { error: fyErr } = await supabase
      .schema('finance').from('fiscal_years')
      .update({
        status: 'HARD_CLOSED',
        closed_at: new Date().toISOString(),
        closed_by: auth.userId,
        reopening_reason: `Year-end close completed. Journal: ${journalReference}`,
      })
      .eq('id', fiscal_year_id)
      .eq('organization_id', orgId);
 
    if (fyErr) {
      return NextResponse.json({
        error: 'Journal posted successfully but fiscal year status update failed. Manual reconciliation required: ' + fyErr.message,
        journalId,
        reference: journalReference,
        partial_success: true,
      }, { status: 500 });
    }
 
    // ── 10. Audit log ──
    try {
      await supabase.schema('audit').rpc('log_action', {
        p_user_id: auth.userId,
        p_action: 'YEAR_END_CLOSED',
        p_entity_type: 'fiscal_year',
        p_entity_id: fiscal_year_id,
        p_description: `Year-end close: FY ${fiscalYear.name || fiscal_year_id}. Revenue: ${totalRevenue.toFixed(2)}, Expenses: ${totalExpenses.toFixed(2)}, Net: ${netIncome.toFixed(2)} (${netIncome >= 0 ? 'Profit' : 'Loss'}). Journal: ${journalReference}`,
        p_previous_status: fiscalYear.status,
        p_new_status: 'CLOSED',
        p_source_module: 'year_end_close',
        p_severity: 'high',
        p_new_values: {
          reference: journalReference,
          total_revenue: totalRevenue,
          total_expenses: totalExpenses,
          net_income: netIncome,
          journal_id: journalId,
          retained_earnings_account_id: retainedEarningsAccount.id,
        },
        p_related_journal_id: journalId,
      });
    } catch (auditErr: any) {
      console.error('Audit log failed:', auditErr);
      auditLogWarning = 'Year-end close completed, but the audit log entry failed to write. Please notify an administrator.';
    }
 
    return NextResponse.json({
      success: true,
      journalId,
      reference: journalReference,
      total_revenue: totalRevenue,
      total_expenses: totalExpenses,
      net_income: netIncome,
      retained_earnings_side: netIncome >= 0 ? 'CREDIT' : 'DEBIT',
      total_debit: totalDebit,
      total_credit: totalCredit,
      balanced: Math.abs(totalDebit - totalCredit) < 0.01,
      audit_log_warning: auditLogWarning,
      message: `Year-end close completed: ${netIncome >= 0 ? 'Profit' : 'Loss'} of PKR ${Math.abs(netIncome).toLocaleString()} transferred to Retained Earnings`,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
 
// ─── GET: Year-End Close Preview ────────────────────────────────────────────────
 
export async function GET(req: NextRequest) {
  const auth = await requirePermission('PERIOD_READ');
  if (auth instanceof NextResponse) return auth;
  const { supabase } = await getAuthSupabase(req);
 
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
        .schema('finance').from('fiscal_years')
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
        .schema('finance').from('accounting_periods')
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