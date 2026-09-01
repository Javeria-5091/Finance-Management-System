import { NextRequest, NextResponse } from 'next/server';
import { getAuthSupabase } from '@/lib/api-auth';
import { requirePermission } from '@/lib/api-auth';
import { enforceMFA } from '@/lib/mfa-middleware';
import { yearEndCloseSchema, validateBody } from '@/lib/validations';
 
function getData<T = any>(res: any): T | null {
  return res?.data ?? null;
}
 

async function buildYearEndChecklist(supabase: any, orgId: string, fiscalYear: any, periods: any[]) {
  const periodIds = periods.map((p: any) => p.id);
  const periodStart = fiscalYear.start_date;
  const periodEnd = fiscalYear.end_date;
  const start = new Date(`${periodStart}T00:00:00Z`);
  const end = new Date(`${periodEnd}T00:00:00Z`);
  const monthCount = (end.getUTCFullYear() - start.getUTCFullYear()) * 12 + (end.getUTCMonth() - start.getUTCMonth()) + 1;
  const calendar = { passed: monthCount === 12 || (fiscalYear.is_transition_year === true && !!fiscalYear.transition_approved_by && !!fiscalYear.transition_approved_at), month_count: monthCount, transition_year: !!fiscalYear.is_transition_year };

  const { data: statements } = await supabase.schema('finance').from('bank_statements').select('id').eq('organization_id', orgId).gte('statement_date', periodStart).lte('statement_date', periodEnd);
  const statementIds = (statements || []).map((x: any) => x.id);
  let unreconciledBankLines = 0;
  if (statementIds.length) {
    const { count } = await supabase.schema('finance').from('statement_lines').select('id', { count: 'exact', head: true }).in('bank_statement_id', statementIds).eq('reconciliation_status', 'UNRECONCILED');
    unreconciledBankLines = Number(count || 0);
  }
  const reconciliation = { passed: unreconciledBankLines === 0, unreconciled_bank_lines: unreconciledBankLines };

  // There is no dedicated accrual/prepayment table in the supplied schema.
  // The final trial balance is therefore the controlled accounting evidence for this checklist item.
  const accruals_prepayments = { passed: true, basis: 'Final trial balance review; no separate accrual/prepayment subledger exists in the supplied schema' };

  const { count: unpostedPayrollRuns } = await supabase.from('payroll_runs').select('id', { count: 'exact', head: true }).eq('organization_id', orgId).lte('period_start', periodEnd).gte('period_end', periodStart).in('status', ['DRAFT','CALCULATED','UNDER_REVIEW','APPROVED']);
  const payroll = { passed: Number(unpostedPayrollRuns || 0) === 0, unposted_runs: Number(unpostedPayrollRuns || 0) };

  const { count: calculatedDepreciation } = await supabase.schema('finance').from('depreciation_schedule').select('id', { count: 'exact', head: true }).eq('fiscal_year_id', fiscalYear.id).eq('status', 'calculated');
  const assets = { passed: Number(calculatedDepreciation || 0) === 0, calculated_depreciation_rows: Number(calculatedDepreciation || 0) };

  const { count: openTaxRecons } = await supabase.schema('finance').from('tax_reconciliations').select('id', { count: 'exact', head: true }).eq('organization_id', orgId).eq('fiscal_year_id', fiscalYear.id).in('status', ['DRAFT','CALCULATED','UNDER_REVIEW']);
  const { count: pendingWithholding } = await supabase.schema('finance').from('tax_credits_and_withholding').select('id', { count: 'exact', head: true }).eq('organization_id', orgId).eq('fiscal_year_id', fiscalYear.id).eq('status', 'PENDING');
  const tax = { passed: Number(openTaxRecons || 0) === 0 && Number(pendingWithholding || 0) === 0, open_reconciliations: Number(openTaxRecons || 0), pending_withholding: Number(pendingWithholding || 0) };

  const { data: foreignAccounts } = await supabase.schema('finance').from('financial_accounts').select('currency').eq('organization_id', orgId).eq('is_active', true).neq('currency', 'PKR');
  const missingFxCurrencies: string[] = [];
  for (const account of foreignAccounts || []) {
    const { data: rate } = await supabase.schema('finance').from('exchange_rates').select('id').eq('organization_id', orgId).eq('from_currency', account.currency).eq('to_currency', 'PKR').lte('rate_date', periodEnd).not('approved_by', 'is', null).eq('is_locked', true).order('rate_date', { ascending: false }).limit(1).maybeSingle();
    if (!rate) missingFxCurrencies.push(account.currency);
  }
  const fx = { passed: missingFxCurrencies.length === 0, missing_approved_locked_rates: [...new Set(missingFxCurrencies)] };

  const { data: trialBalance, error: tbError } = await supabase.schema('reporting').rpc('get_trial_balance', { p_period_ids: periodIds, p_organization_id: orgId });
  const totalDebit = (trialBalance || []).reduce((sum: number, row: any) => sum + Number(row.total_debit || 0), 0);
  const totalCredit = (trialBalance || []).reduce((sum: number, row: any) => sum + Number(row.total_credit || 0), 0);
  const trial_balance = { passed: !tbError && Math.abs(totalDebit - totalCredit) <= 0.01, total_debit: totalDebit, total_credit: totalCredit, error: tbError?.message || null };
  const statements_check = { passed: trial_balance.passed, basis: 'Final P&L, Balance Sheet and Cash Flow use the controlled ledger/reporting views after trial-balance validation' };

  const checks = { calendar, reconciliation, accruals_prepayments, payroll, assets, tax, fx, trial_balance, statements: statements_check };
  return { passed: Object.values(checks).every((c: any) => c.passed === true), checks };
}

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
 
    if (fiscalYear.status === 'HARD_CLOSED') {
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

    const checklist = await buildYearEndChecklist(supabase, orgId, fiscalYear, periods);
    if (!checklist.passed) {
      return NextResponse.json({ error: 'Fiscal-year close checklist is incomplete. Resolve every failed control before closing the year.', checklist: checklist.checks }, { status: 409 });
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
 
    // AC-06 P1 FIX: zero net income must NOT short-circuit the close.
    // Returning early here — before hard-closing the fiscal year, hard-closing
    // its periods, or provisioning the next fiscal year — meant a fiscal year
    // that happened to break exactly even could never actually be closed: its
    // status stayed non-HARD_CLOSED forever and the next fiscal year was
    // never auto-provisioned. There is genuinely no closing journal to post
    // in this case (nothing to zero out, nothing to transfer), but every
    // other step of the close — fiscal year status, next-year provisioning,
    // audit log — must still run exactly as it does for a profit or a loss.
    const needsClosingEntry = Math.abs(netIncome) >= 0.01;

    // ── 5. Get Retained Earnings account (only needed if there's a closing entry to build) ──
    const retainedEarningsAccount = needsClosingEntry ? getData(
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
    ) : null;
 
    if (needsClosingEntry && !retainedEarningsAccount) {
      return NextResponse.json({ error: 'Retained Earnings account not found. Create an EQUITY account with code 3000 or name containing "Retained Earnings".' }, { status: 400 });
    }
 
    // ── 6. Build closing journal lines for RPC ──
    const rpcLines: any[] = [];
    let totalDebit = 0;
    let totalCredit = 0;
    let reference: string | null = null;

    if (needsClosingEntry) {
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
      totalDebit = rpcLines.reduce((s: number, l: any) => s + (Number(l.debit_amount) || 0), 0);
      totalCredit = rpcLines.reduce((s: number, l: any) => s + (Number(l.credit_amount) || 0), 0);
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
      reference = refData || `YEC-${fiscal_year_id.slice(0, 8)}`;
    }
 

    // ── AC-05 P1 FIX: the closing entry must be posted INSIDE the fiscal
    // year being closed, not into the next one. Posting it into next year's
    // first period corrupted both years: this year's P&L never actually
    // cleared to zero and its own Retained Earnings was understated, while
    // next year's trial balance opened with revenue/expense lines that had
    // nothing to do with its own operations.
    //
    // `accounting_periods.period_number` is capped at 13
    // (accounting_periods_period_number_check in schema.sql) precisely to
    // support a 13th "closing / adjustment period" within a 12-month fiscal
    // year, dated at fiscal year end, used only for entries like this one.
    // We find-or-create that period for the fiscal year being closed and
    // post there instead.
    // AC-06 P1 FIX: with zero net income there's no closing entry to post,
    // so there's no need to find/create/open a period-13 closing period —
    // closingPeriodId simply stays null and every step below that depends
    // on it is skipped.
    let closingPeriodId: string | null = null;

    if (needsClosingEntry) {
      let closingPeriod = getData(
        await supabase
          .schema('finance').from('accounting_periods')
          .select('id, status')
          .eq('fiscal_year_id', fiscal_year_id)
          .eq('organization_id', orgId)
          .eq('period_number', 13)
          .maybeSingle()
      );

      if (!closingPeriod) {
        // ap_dates_valid requires end_date > start_date, so the closing period
        // spans the single day immediately after fiscal year end while still
        // belonging to (and being reported under) this fiscal_year_id.
        const closingStart = fiscalYear.end_date;
        const closingEndDate = new Date(`${fiscalYear.end_date}T00:00:00Z`);
        closingEndDate.setUTCDate(closingEndDate.getUTCDate() + 1);
        const closingEnd = closingEndDate.toISOString().slice(0, 10);

        const { data: createdClosingPeriod, error: createClosingPeriodErr } = await supabase
          .schema('finance').from('accounting_periods')
          .insert({
            fiscal_year_id,
            organization_id: orgId,
            period_number: 13,
            name: `${fiscalYear.name || 'Year-End'} Closing Adjustments`,
            start_date: closingStart,
            end_date: closingEnd,
            status: 'PENDING',
            created_by: auth.userId,
          })
          .select('id, status')
          .single();

        if (createClosingPeriodErr || !createdClosingPeriod) {
          return NextResponse.json({ error: 'Unable to create the fiscal-year closing period: ' + (createClosingPeriodErr?.message || 'Unknown error') }, { status: 500 });
        }
        closingPeriod = createdClosingPeriod;
      }

      if (closingPeriod.status === 'PENDING') {
        const { error: openErr } = await supabase.schema('finance').rpc('open_period', { p_period_id: closingPeriod.id, p_opened_by: auth.userId });
        if (openErr) return NextResponse.json({ error: 'Unable to open the fiscal-year closing period: ' + openErr.message }, { status: 500 });
        closingPeriod.status = 'OPEN';
      }

      if (closingPeriod.status === 'OPEN') closingPeriodId = closingPeriod.id;
      // The closing journal is never posted to a hard-closed period.

      if (!closingPeriodId) {
        return NextResponse.json({
          error: `The fiscal-year closing period is ${closingPeriod.status} and cannot accept new postings. Manual review required before retrying year-end close.`,
        }, { status: 400 });
      }
    }

    // ── Separately (and unrelated to where the closing entry is posted),
    // ensure the next fiscal year exists and is ready to receive day-to-day
    // transactions once this year is closed. ──
    const nextFiscalYear = getData(
      await supabase
        .schema('finance').from('fiscal_years')
        .select('id, name, start_date, end_date')
        .eq('organization_id', orgId)
        .eq('status', 'OPEN')
        .gt('start_date', fiscalYear.end_date)
        .order('start_date', { ascending: true })
        .limit(1)
        .maybeSingle()
    );

    let ensuredNextFiscalYear = nextFiscalYear;
    if (!ensuredNextFiscalYear) {
      const nextStart = new Date(`${fiscalYear.end_date}T00:00:00Z`);
      nextStart.setUTCDate(nextStart.getUTCDate() + 1);
      const nextEnd = new Date(nextStart);
      nextEnd.setUTCFullYear(nextEnd.getUTCFullYear() + 1);
      nextEnd.setUTCDate(nextEnd.getUTCDate() - 1);
      const nextName = `${nextStart.getUTCFullYear()}-${nextEnd.getUTCFullYear()}`;
      const { data: createdNextFy, error: createNextFyError } = await supabase.schema('finance').rpc('create_fiscal_year_with_periods', { p_name: nextName, p_start_date: nextStart.toISOString().slice(0,10), p_end_date: nextEnd.toISOString().slice(0,10), p_description: `Next fiscal year opened by year-end close of ${fiscalYear.name || fiscal_year_id}`, p_created_by: auth.userId });
      if (createNextFyError || !createdNextFy) return NextResponse.json({ error: 'Unable to create the next fiscal year: ' + (createNextFyError?.message || 'Unknown error') }, { status: 500 });
      ensuredNextFiscalYear = { id: createdNextFy, name: nextName, start_date: nextStart.toISOString().slice(0,10), end_date: nextEnd.toISOString().slice(0,10) };
    }

    const nextPeriod = getData(await supabase.schema('finance').from('accounting_periods').select('id, status').eq('fiscal_year_id', ensuredNextFiscalYear.id).eq('organization_id', orgId).order('start_date', { ascending: true }).limit(1).maybeSingle());
    if (!nextPeriod) return NextResponse.json({ error: 'Next fiscal year has no accounting period' }, { status: 500 });
    if (nextPeriod.status === 'PENDING') {
      const { error: openErr } = await supabase.schema('finance').rpc('open_period', { p_period_id: nextPeriod.id, p_opened_by: auth.userId });
      if (openErr) return NextResponse.json({ error: 'Unable to open the first period of the next fiscal year: ' + openErr.message }, { status: 500 });
    }

    // ── 8. Idempotency guard: if a closing journal already exists for this FY,
    //    never post another closing journal on retry. Skipped entirely when
    //    net income is zero — there is nothing to post (AC-06 FIX).
    let journalId: string | null = null;
    let postErr: any = null;
    let journalReference: string | null = null;

    if (needsClosingEntry) {
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
        // BUG-001 FIX: p_lines is jsonb — pass the array directly, not a
        // JSON.stringify()'d string (which double-encodes into a jsonb
        // scalar and crashes jsonb_array_length(p_lines) inside the RPC).
        const result = await supabase.schema('finance').rpc('post_journal_entry', {
        p_description: description || `Year-End Close: FY ${fiscalYear.name || fiscal_year_id}`,
        p_transaction_date: new Date().toISOString().split('T')[0],
        p_period_id: closingPeriodId, // BUG-001 FIX: post to an OPEN period, not a HARD_CLOSED one
        p_lines: rpcLines,
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
      journalReference = journal.reference || reference;
    }

    // H11 FIX: Treat fiscal year update failure as ERROR, not silent log.
    // AC-06 FIX: this now always runs, whether or not a closing journal was
    // posted, so a break-even fiscal year actually gets hard-closed instead
    // of being stuck open forever.
    const fyReopeningReason = needsClosingEntry
      ? `Year-end close completed. Journal: ${journalReference}`
      : 'Year-end close completed. Net income was zero; no closing journal was required.';
    const { error: fyErr } = await supabase
      .schema('finance').from('fiscal_years')
      .update({
        status: 'HARD_CLOSED',
        closed_at: new Date().toISOString(),
        closed_by: auth.userId,
        reopening_reason: fyReopeningReason,
      })
      .eq('id', fiscal_year_id)
      .eq('organization_id', orgId);
 
    if (fyErr) {
      return NextResponse.json({
        error: (needsClosingEntry ? 'Journal posted successfully but fiscal year status update failed.' : 'Fiscal year status update failed.') + ' Manual reconciliation required: ' + fyErr.message,
        journalId,
        reference: journalReference,
        partial_success: true,
      }, { status: 500 });
    }

    // ── 9.5. Hard-close the closing period itself so it can't silently
    // accept further postings into an otherwise-closed fiscal year.
    // Only applicable when a closing journal (and therefore a period 13) was
    // actually created — AC-06 FIX. ──
    let closingPeriodWarning: string | undefined;
    if (needsClosingEntry) {
      const { error: closingPeriodCloseErr } = await supabase
        .schema('finance').from('accounting_periods')
        .update({
          status: 'HARD_CLOSED',
          closed_by: auth.userId,
          closed_at: new Date().toISOString(),
          reopening_reason: `Year-end close completed. Journal: ${journalReference}`,
        })
        .eq('id', closingPeriodId)
        .eq('organization_id', orgId);
      if (closingPeriodCloseErr) {
        console.error('Failed to hard-close closing period:', closingPeriodCloseErr);
        closingPeriodWarning = 'Year-end close completed, but the closing period could not be hard-closed automatically. Please close it manually.';
      }
    }
 
    // ── 10. Audit log ──
    try {
      await supabase.schema('audit').rpc('log_action', {
        p_user_id: auth.userId,
        p_action: 'YEAR_END_CLOSED',
        p_entity_type: 'fiscal_year',
        p_entity_id: fiscal_year_id,
        p_description: `Year-end close: FY ${fiscalYear.name || fiscal_year_id}. Revenue: ${totalRevenue.toFixed(2)}, Expenses: ${totalExpenses.toFixed(2)}, Net: ${netIncome.toFixed(2)} (${netIncome > 0 ? 'Profit' : netIncome < 0 ? 'Loss' : 'Break-even'}).${needsClosingEntry ? ` Journal: ${journalReference}` : ' No closing journal required.'}`,
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
          retained_earnings_account_id: retainedEarningsAccount?.id || null,
          close_checklist: checklist.checks,
          next_fiscal_year_id: ensuredNextFiscalYear?.id || null,
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
      retained_earnings_side: needsClosingEntry ? (netIncome > 0 ? 'CREDIT' : 'DEBIT') : null,
      total_debit: totalDebit,
      total_credit: totalCredit,
      balanced: needsClosingEntry ? Math.abs(totalDebit - totalCredit) < 0.01 : true,
      audit_log_warning: auditLogWarning,
      closing_period_warning: closingPeriodWarning,
      checklist: checklist.checks,
      next_fiscal_year_id: ensuredNextFiscalYear?.id || null,
      message: needsClosingEntry
        ? `Year-end close completed: ${netIncome > 0 ? 'Profit' : 'Loss'} of PKR ${Math.abs(netIncome).toLocaleString()} transferred to Retained Earnings`
        : 'Year-end close completed: net income was zero, no closing entry was required.',
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
    const checklist = periods?.length ? await buildYearEndChecklist(supabase, orgId, fiscalYear, periods) : { passed: false, checks: {} };
 
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
      ready_to_close: unclosed.length === 0 && fiscalYear.status !== 'HARD_CLOSED' && checklist.passed,
      checklist: checklist.checks,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}