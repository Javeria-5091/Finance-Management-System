import { NextRequest, NextResponse } from 'next/server';
import { getAuthSupabase } from '@/lib/api-auth';
import { requirePermission } from '@/lib/api-auth';
import { enforceMFA } from '@/lib/mfa-middleware';
import { postInvoiceSchema, validateBody } from '@/lib/validations';
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
 
    // 2. Idempotency check
    const existingJournal = getData(await supabase
      .from('finance.journal_entries')
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
    let budgetCheckResult: any = null;
    if (invoice.project_id) {
      const budgetCheck = await checkBudgetForTransaction({
        project_id: invoice.project_id,
        amount: Number(invoice.total_amount) || 0,
        currency: invoice.currency || 'PKR',
        organization_id: orgId,
      });
 
      // Create notifications if budget thresholds are relevant
      if (budgetCheck.notifications && budgetCheck.notifications.length > 0) {
        await createBudgetAlertNotifications(
          budgetCheck.notifications,
          orgId,
          auth.userId,
          invoiceId
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
      .from('finance.accounting_periods')
      .select('id, start_date, end_date')
      .eq('status', 'OPEN')
      .order('start_date', { ascending: false })
      .limit(1)
      .single());
 
    if (!period) {
      return NextResponse.json({ error: 'No OPEN accounting period found' }, { status: 400 });
    }
 
    // 4. Find accounts
    const receivableAccount = getData(await supabase
      .from('finance.chart_of_accounts')
      .select('id, code, name')
      .eq('account_type', 'ASSET')
      .eq('is_active', true)
      .like('code', '12%')
      .limit(1)
      .single());
 
    const revenueAccount = getData(await supabase
      .from('finance.chart_of_accounts')
      .select('id, code, name')
      .eq('account_type', 'REVENUE')
      .eq('is_active', true)
      .limit(1)
      .single());
 
    const taxAccount = getData(await supabase
      .from('finance.chart_of_accounts')
      .select('id, code, name')
      .eq('account_type', 'LIABILITY')
      .eq('is_active', true)
      .ilike('name', '%tax%')
      .limit(1)
      .single());
 
    if (!receivableAccount || !revenueAccount) {
      return NextResponse.json({
        error: 'Required accounts not found. Set up ASSET (Receivable) and REVENUE accounts in Chart of Accounts.',
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
 
    const { data: journalId, error: postErr } = await supabase.rpc('finance.post_journal_entry', {
      p_description: `Invoice: ${invoice.invoice_number || 'N/A'} - ${invoice.description || 'Sales Invoice'}`,
      p_transaction_date: invoice.invoice_date || new Date().toISOString().split('T')[0],
      p_period_id: period.id,
      p_lines: JSON.stringify(rpcLines),
      p_currency: invoice.currency || 'PKR',
      p_exchange_rate: invoice.exchange_rate || 1,
      p_source_type: 'INVOICE',
      p_source_id: invoiceId,
      p_project_id: invoice.project_id || null,
    });
 
    if (postErr || !journalId) {
      return NextResponse.json({ error: 'GL posting failed: ' + (postErr?.message || 'Unknown error') }, { status: 500 });
    }
 
    // Fetch the created journal to get reference and totals
    const journal = getData(await supabase
      .from('finance.journal_entries')
      .select('id, reference, total_debit, total_credit')
      .eq('id', journalId)
      .single());
    // C6 FIX: Null guard
    if (!journal) {
      return NextResponse.json({ error: 'Journal created but fetch failed. Check journal ID: ' + journalId }, { status: 500 });
    }
    const reference = journal.reference || `JE-INV-${journalId}`;
    const totalDebit = journal.total_debit || totalAmount;
    const totalCredit = journal.total_credit || totalAmount;
 
    // 10. Update invoice status
    const { error: statusErr } = await supabase.from('invoices').update({
      status: 'POSTED',
      posted_at: new Date().toISOString(),
      journal_entry_id: journalId,
      posted_by: auth.userId,
    }).eq('id', invoiceId);
 
    if (statusErr) {
      console.error('Invoice status update failed:', statusErr.message);
    }
 
    // 11. Audit log
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
      console.error('Audit log failed:', auditErr);
    }
 
    return NextResponse.json({
      success: true,
      journalId: journal.id,
      reference,
      totalDebit,
      totalCredit,
      message: `Invoice posted to GL: ${reference}`,
      budget_check: budgetCheckResult,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
