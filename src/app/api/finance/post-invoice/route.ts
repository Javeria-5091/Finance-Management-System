import { NextRequest, NextResponse } from 'next/server';
import { getAuthSupabase } from '@/lib/api-auth';
import { requirePermission } from '@/lib/api-auth';
import { enforceMFA } from '@/lib/mfa-middleware';
import { postInvoiceSchema, validateBody, validateExchangeRate } from '@/lib/validations';
import { checkBudgetForTransaction, createBudgetAlertNotifications } from '@/services/budget-check.service';

function getData<T = any>(res: any): T | null {
  return res?.data ?? null;
}

// ─── POST: Post approved invoice to General Ledger ───
// Spec: When invoice is ISSUED → DR Accounts Receivable, CR Revenue
// Spec 5.4: Budget check before posting — for revenue/invoice context this is informational
//           (invoices generate revenue, not expense, so budget BLOCK does not apply to revenue budgets
//            but project budget tracking is still validated for context)
export async function POST(req: NextRequest) {
  const auth = await requirePermission('APPROVE_INVOICE');
  if (auth instanceof NextResponse) return auth;
  // H3 FIX: Enforce MFA for financial posting
  const mfaCheck = await enforceMFA(auth);
  if (mfaCheck) return mfaCheck;
  const { supabase } = await getAuthSupabase(req);

  const orgId = auth.orgId;
  if (!orgId) {
    return NextResponse.json({ error: 'Organization ID not found' }, { status: 400 });
  }

  try {
    const rawBody = await req.json();
    const validation = validateBody(postInvoiceSchema, rawBody);
    if (!validation.success) return NextResponse.json({ error: validation.error }, { status: 400 });
    const { invoiceId } = validation.data;

    // 1. Fetch invoice with line items (org isolated)
    const invoice = getData(await supabase
      .from('invoices')
      .select('*, invoice_lines(*)')
      .eq('id', invoiceId)
      .eq('organization_id', orgId)
      .single());

    if (!invoice) {
      return NextResponse.json({ error: 'Invoice not found' }, { status: 404 });
    }

    if (invoice.status !== 'ISSUED' && invoice.status !== 'APPROVED') {
      return NextResponse.json({
        error: `Only ISSUED or APPROVED invoices can be posted. Current: ${invoice.status}`,
      }, { status: 400 });
    }

    // BUG-008 FIX: validate exchange rate for non-PKR currencies
    const rateError = validateExchangeRate(invoice.currency, invoice.exchange_rate);
    if (rateError) {
      return NextResponse.json({ error: rateError }, { status: 400 });
    }

    // 2. Idempotency check
    const existingJournal = getData(await supabase
      .schema('finance').from('journal_entries')
      .select('id, reference')
      .eq('source_type', 'INVOICE')
      .eq('source_id', invoiceId)
      .maybeSingle());

    if (existingJournal) {
      return NextResponse.json({
        error: 'Already posted to GL',
        journalId: existingJournal.id,
        reference: existingJournal.reference,
      }, { status: 400 });
    }

    // ─── BUDGET CHECK (Spec 5.4: Informational budget context for invoices) ───
    // For invoices, budget check is informational only — invoices generate revenue and do NOT
    // consume expense budgets. However, we still check project budgets to provide visibility
    // and create threshold notifications if relevant. Budget is never BLOCKED for invoices.
    // AP-04 FIX: budgets are PKR-only but invoice.total_amount is in the
    // invoice's own currency. Convert to base currency using
    // invoice.exchange_rate (validated above) before comparing, same as
    // post-expense/post-vendor-bill.
    let budgetCheckResult: any = null;
    if (invoice.project_id) {
      const totalInvoiceAmountPKR = (Number(invoice.total_amount) || 0) * (Number(invoice.exchange_rate) || 1);
      const budgetCheck = await checkBudgetForTransaction({
        project_id: invoice.project_id,
        amount: totalInvoiceAmountPKR,
        currency: 'PKR',
        organization_id: orgId,
        // BUG-007 FIX: pass server-side authenticated supabase client.
        supabaseClient: supabase,
      });

      // Create notifications if budget thresholds are relevant
      if (budgetCheck.notifications && budgetCheck.notifications.length > 0) {
        await createBudgetAlertNotifications(
          budgetCheck.notifications,
          orgId,
          auth.userId,
          invoiceId,
          supabase,
        );
      }

      budgetCheckResult = {
        informational: true,
        warning: budgetCheck.warning,
        checks: budgetCheck.checks,
        note: 'Budget check is informational for invoices (revenue). Expense budget enforcement applies to post-expense and post-vendor-bill only.',
      };
    }

    // 3. Get open period
    const period = getData(await supabase
      .schema('finance').from('accounting_periods')
      .select('id, start_date, end_date')
      .eq('status', 'OPEN')
      .eq('organization_id', orgId)
      .order('start_date', { ascending: false })
      .limit(1)
      .single());

    if (!period) {
      return NextResponse.json({ error: 'No OPEN accounting period found' }, { status: 400 });
    }

    // 4. Find accounts
    // BUG-014 FIX: the three lookups below previously used
    // `.like('code', '12%').limit(1).single()` (no ORDER BY -> could
    // non-deterministically resolve to the 1200 PARENT/SUMMARY "Accounts
    // Receivable" account instead of the real 1210 "Client Receivables"
    // control account -- spec 5.2 explicitly requires summary accounts be
    // unpostable), an unfiltered `.eq('account_type','REVENUE').limit(1)`
    // with NO name/code condition at all (could post every invoice's
    // revenue to an arbitrary revenue account), and `.ilike('name','%tax%')`
    // (could match either 2210 or 2220). All three now resolve by exact,
    // seeded control-account code instead of fuzzy/unfiltered matching.
    const receivableAccount = getData(await supabase
      .schema('finance').from('chart_of_accounts')
      .select('id, code, name')
      .eq('account_type', 'ASSET')
      .eq('is_active', true)
      .eq('organization_id', auth.orgId)
      .eq('code', '1210')
      .maybeSingle());

    const revenueAccount = getData(await supabase
      .schema('finance').from('chart_of_accounts')
      .select('id, code, name')
      .eq('account_type', 'REVENUE')
      .eq('is_active', true)
      .eq('organization_id', auth.orgId)
      .eq('code', '4110')
      .maybeSingle());

    const taxAccount = getData(await supabase
      .schema('finance').from('chart_of_accounts')
      .select('id, code, name')
      .eq('account_type', 'LIABILITY')
      .eq('is_active', true)
      .eq('organization_id', auth.orgId)
      .eq('code', '2220')
      .maybeSingle());

    if (!receivableAccount || !revenueAccount) {
      return NextResponse.json({
        error: 'Required Accounts Receivable (code 1210, "Client Receivables") and/or Revenue (code 4110, "Project Revenue") control accounts not found or inactive. Set them up in Chart of Accounts.',
      }, { status: 400 });
    }

    // 5-9. Post via GL engine (BUG-001 FIX: use RPC with CORRECT signature)
    const totalAmount = Number(invoice.total_amount) || 0;
    const totalTax = Number(invoice.tax_amount) || 0;
    const subtotal = totalAmount - totalTax;

    // Build journal lines for RPC (no journal_entry_id or line_number needed — RPC handles these)
    const rpcLines: any[] = [
      {
        account_id: receivableAccount.id,
        debit_amount: totalAmount,
        credit_amount: 0,
        description: `Receivable: Invoice ${invoice.invoice_number || invoiceId} - ${invoice.client_id ? 'Client' : 'General'}`,
      },
      {
        account_id: revenueAccount.id,
        debit_amount: 0,
        credit_amount: subtotal,
        description: `Revenue: Invoice ${invoice.invoice_number || invoiceId}`,
      },
    ];

    // CR: Tax Payable (if tax exists)
    if (totalTax > 0 && taxAccount) {
      rpcLines.push({
        account_id: taxAccount.id,
        debit_amount: 0,
        credit_amount: totalTax,
        description: `Tax: Invoice ${invoice.invoice_number || invoiceId}`,
      });
    }

    // FND-FIN-001 FIX (Spec §11.3): previously post_journal_entry created the
    // journal and a SEPARATE .update() below linked journal_entry_id/period_id
    // on the invoice — two independent PostgREST calls with no transactional
    // link. A failure between them left a committed journal with the invoice
    // never linked to it. Both steps now happen inside a single SECURITY
    // DEFINER RPC (finance.post_invoice_atomic, see
    // supabase/migrations/P2/P2_005_atomic_gl_posting_and_profit_distribution_lockdown.sql),
    // so a failure partway through rolls back the journal insert too.
    // NOTE: public.invoices' status CHECK constraint does not include a
    // 'POSTED' value (its lifecycle is DRAFT/.../ISSUED/PARTIALLY_PAID/PAID/...)
    // and the table has no posted_by/posted_at columns (confirmed against
    // schema.sql) -- so, matching pre-existing (correct) behavior,
    // post_invoice_atomic does NOT set status; GL-posted state for invoices
    // is tracked via journal_entry_id being non-null while status remains
    // ISSUED/APPROVED.
    const { data: postResult, error: postErr } = await supabase.schema('finance').rpc('post_invoice_atomic', {
      p_invoice_id: invoiceId,
      p_period_id: period.id,
      p_transaction_date: invoice.issue_date || new Date().toISOString().split('T')[0],
      p_description: `Invoice: ${invoice.invoice_number || 'N/A'} - ${invoice.description || 'Sales Invoice'}`,
      p_lines: rpcLines,
      p_currency: invoice.currency || 'PKR',
      p_exchange_rate: invoice.exchange_rate || 1,
      p_project_id: invoice.project_id || null,
    });

    if (postErr || !postResult?.journal_id) {
      return NextResponse.json({ error: 'GL posting failed: ' + (postErr?.message || 'Unknown error') }, { status: 500 });
    }

    const journal = { id: postResult.journal_id, reference: postResult.reference };
    const reference = journal.reference || `JE-INV-${journal.id}`;
    // The GL engine's own balance trigger (trg_check_journal_balance)
    // guarantees debits === credits === totalAmount for what we submitted.
    const totalDebit = totalAmount;
    const totalCredit = totalAmount;

    // 11. Audit log
    let auditLogFailed = false;
    try {
      await supabase.schema('audit').rpc('log_action', {
        p_user_id: auth.userId,
        p_action: 'INVOICE_POSTED',
        p_entity_type: 'invoice',
        p_entity_id: invoiceId,
        p_description: `Posted invoice ${invoice.invoice_number || invoiceId} to GL: ${reference} (DR ${receivableAccount.code} ${totalAmount}, CR ${revenueAccount.code} ${subtotal}${totalTax > 0 ? `, CR ${taxAccount.code} ${totalTax}` : ''})`,
        p_previous_status: invoice.status,
        p_new_status: 'POSTED',
        p_source_module: 'invoice',
        p_severity: 'high',
        p_new_values: {
          reference,
          total_amount: totalAmount,
          subtotal,
          tax: totalTax,
          journal_id: journal.id,
          currency: invoice.currency || 'PKR',
          budget_context: budgetCheckResult,
        },
        p_related_journal_id: journal.id,
      });
    } catch (auditErr: any) {
      // BUG-023 FIX: do not silently swallow an audit-write failure for a
      // P0 financial posting (Spec 8.1: "every action... must be
      // attributable"). The GL posting itself is not rolled back -- it is
      // already correctly posted and reverting it because a *logging* call
      // failed would be worse (posted entries are immutable). Instead the
      // failure is surfaced to the caller via `audit_log_warning`.
      console.error('Audit log failed for invoice post:', auditErr);
      auditLogFailed = true;
    }

    return NextResponse.json({
      success: true,
      journalId: journal.id,
      reference,
      totalDebit,
      totalCredit,
      message: `Invoice posted to GL: ${reference}`,
      budget_check: budgetCheckResult,
      audit_log_warning: auditLogFailed ? 'Posting succeeded but the audit log entry failed to write. Please notify an administrator.' : undefined,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}