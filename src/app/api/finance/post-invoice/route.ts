import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { requirePermission } from '@/lib/api-auth';

function getData<T = any>(res: any): T | null {
  return res?.data ?? null;
}

// ─── POST: Post approved invoice to General Ledger ───
// Spec: When invoice is ISSUED → DR Accounts Receivable, CR Revenue
// For each line item: DR/CR based on account type
export async function POST(req: NextRequest) {
  const auth = await requirePermission('APPROVE_INVOICE');
  if (auth instanceof NextResponse) return auth;

  try {
    const { invoiceId } = await req.json();
    if (!invoiceId) {
      return NextResponse.json({ error: 'invoiceId is required' }, { status: 400 });
    }

    // 1. Fetch invoice with line items (org isolated)
    const invoice = getData(await supabase
      .from('invoices')
      .select('*, invoice_lines(*)')
      .eq('id', invoiceId)
      .eq('organization_id', auth.orgId)
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

    // 5. Generate reference number
    const { data: numData } = await supabase.rpc('get_next_number', { p_type: 'JE-INV' });
    const reference = numData || `JE-INV-${Date.now()}`;

    // 6. Build journal lines
    const totalAmount = Number(invoice.total_amount) || 0;
    const totalTax = Number(invoice.tax_amount) || 0;
    const subtotal = totalAmount - totalTax;

    const journalLines: any[] = [];

    // DR: Accounts Receivable (full amount including tax)
    journalLines.push({
      journal_entry_id: null, // Will be set after header creation
      account_id: receivableAccount.id,
      debit_amount: totalAmount,
      credit_amount: 0,
      description: `Receivable: Invoice ${invoice.invoice_number || invoiceId} - ${invoice.client_id ? `Client` : 'General'}`,
      line_number: 1,
    });

    // CR: Revenue (subtotal excluding tax)
    journalLines.push({
      journal_entry_id: null,
      account_id: revenueAccount.id,
      debit_amount: 0,
      credit_amount: subtotal,
      description: `Revenue: Invoice ${invoice.invoice_number || invoiceId}`,
      line_number: 2,
    });

    // CR: Tax Payable (if tax exists)
    if (totalTax > 0 && taxAccount) {
      journalLines.push({
        journal_entry_id: null,
        account_id: taxAccount.id,
        debit_amount: 0,
        credit_amount: totalTax,
        description: `Tax: Invoice ${invoice.invoice_number || invoiceId}`,
        line_number: 3,
      });
    }

    // Validate balanced entry
    const totalDebit = journalLines.reduce((sum, l) => sum + Number(l.debit_amount), 0);
    const totalCredit = journalLines.reduce((sum, l) => sum + Number(l.credit_amount), 0);
    if (Math.abs(totalDebit - totalCredit) > 0.02) {
      return NextResponse.json({
        error: `Journal entry does not balance. Debit: ${totalDebit}, Credit: ${totalCredit}`,
      }, { status: 400 });
    }

    // 7. Create journal header
    const journal = getData(await supabase
      .from('finance.journal_entries')
      .insert({
        reference,
        description: `Invoice: ${invoice.invoice_number || 'N/A'} - ${invoice.description || 'Sales Invoice'}`,
        status: 'APPROVED',
        entry_date: invoice.invoice_date || new Date().toISOString().split('T')[0],
        period_id: period.id,
        project_id: invoice.project_id || null,
        source_type: 'INVOICE',
        source_id: invoiceId,
        total_debit: totalDebit,
        total_credit: totalCredit,
        currency: invoice.currency || 'PKR',
        exchange_rate: invoice.exchange_rate || 1,
        created_by: auth.userId,
        approved_by: auth.userId,
        approved_at: new Date().toISOString(),
        organization_id: auth.orgId,
      })
      .select()
      .single());

    if (!journal) {
      return NextResponse.json({ error: 'Failed to create journal entry' }, { status: 500 });
    }

    // 8. Insert lines with journal_entry_id
    const linesWithId = journalLines.map(line => ({
      ...line,
      journal_entry_id: journal.id,
    }));

    const linesError = (await supabase.from('finance.journal_lines').insert(linesWithId)).error;

    if (linesError) {
      await supabase.from('finance.journal_entries').delete().eq('id', journal.id);
      return NextResponse.json({ error: 'Failed to create journal lines: ' + linesError.message }, { status: 500 });
    }

    // 9. Post via GL engine
    const { error: postErr } = await supabase.rpc('finance.post_journal_entry', {
      p_journal_id: journal.id,
      p_posted_by: auth.userId,
    });

    if (postErr) {
      await supabase.from('finance.journal_lines').delete().eq('journal_entry_id', journal.id);
      await supabase.from('finance.journal_entries').delete().eq('id', journal.id);
      return NextResponse.json({ error: 'GL posting failed: ' + postErr.message }, { status: 500 });
    }

    // 10. Update invoice status
    const { error: statusErr } = await supabase.from('invoices').update({
      status: 'POSTED',
      posted_at: new Date().toISOString(),
      journal_entry_id: journal.id,
      posted_by: auth.userId,
    }).eq('id', invoiceId);

    if (statusErr) {
      console.error('Invoice status update failed:', statusErr.message);
    }

    // 11. Audit log
    try {
      await supabase.rpc('audit.log_action', {
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
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}