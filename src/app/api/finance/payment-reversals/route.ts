import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { requirePermission } from '@/lib/api-auth';

function getData<T = any>(res: any): T | null {
  return res?.data ?? null;
}

// ─── POST: Reverse a posted payment (creates reversal journal entry) ───
// Spec: Payment Reversal → DR Receivable, CR Bank/Cash (exact opposite of receipt)
export async function POST(req: NextRequest) {
  const auth = await requirePermission('APPROVE_INVOICE');
  if (auth instanceof NextResponse) return auth;

  try {
    const { payment_receipt_id, reason } = await req.json();

    if (!payment_receipt_id) {
      return NextResponse.json({ error: 'payment_receipt_id is required' }, { status: 400 });
    }

    if (!reason) {
      return NextResponse.json({ error: 'Reason is required for payment reversal' }, { status: 400 });
    }

    // Fetch the original payment receipt
    const receipt = getData(await supabase
      .from('payment_receipts')
      .select('*, journal_entry:finance.journal_entries(id, reference, journal_lines(account_id, debit_amount, credit_amount))')
      .eq('id', payment_receipt_id)
      .eq('organization_id', auth.orgId)
      .single());

    if (!receipt) {
      return NextResponse.json({ error: 'Payment receipt not found' }, { status: 404 });
    }

    if (receipt.status === 'REVERSED') {
      return NextResponse.json({ error: 'Payment receipt is already reversed' }, { status: 400 });
    }

    // Get open period
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

    const totalAmount = Number(receipt.amount);

    // Generate reversal reference
    const { data: numData } = await supabase.rpc('get_next_number', { p_type: 'JE-PMTREV' });
    const reversalReference = numData || `JE-PMTREV-${Date.now()}`;

    // Create reversal journal: DR Receivable, CR Bank/Cash (opposite of receipt)
    const journal = getData(await supabase
      .from('finance.journal_entries')
      .insert({
        reference: reversalReference,
        description: `REVERSAL: Payment Receipt ${receipt.receipt_number} - ${reason}`,
        status: 'APPROVED',
        entry_date: new Date().toISOString().split('T')[0],
        period_id: period.id,
        source_type: 'PAYMENT_REVERSAL',
        source_id: payment_receipt_id,
        reversal_of_journal_id: receipt.journal_entry_id,
        total_debit: totalAmount,
        total_credit: totalAmount,
        currency: receipt.currency || 'PKR',
        exchange_rate: receipt.exchange_rate || 1,
        created_by: auth.userId,
        approved_by: auth.userId,
        approved_at: new Date().toISOString(),
        organization_id: auth.orgId,
      })
      .select()
      .single());

    if (!journal) {
      return NextResponse.json({ error: 'Failed to create reversal journal entry' }, { status: 500 });
    }

    // Get original journal lines to reverse
    const originalLines = getData(await supabase
      .from('finance.journal_lines')
      .select('account_id, debit_amount, credit_amount, description')
      .eq('journal_entry_id', receipt.journal_entry_id));

    if (!originalLines || originalLines.length === 0) {
      await supabase.from('finance.journal_entries').delete().eq('id', journal.id);
      return NextResponse.json({ error: 'Original journal lines not found' }, { status: 500 });
    }

    // Create reversal lines (swap debit/credit)
    const reversalLines = originalLines.map((line: any, idx: number) => ({
      journal_entry_id: journal.id,
      account_id: line.account_id,
      debit_amount: Number(line.credit_amount), // Swap
      credit_amount: Number(line.debit_amount), // Swap
      description: `REVERSAL: ${line.description}`,
      line_number: idx + 1,
    }));

    const linesError = (await supabase.from('finance.journal_lines').insert(reversalLines)).error;

    if (linesError) {
      await supabase.from('finance.journal_entries').delete().eq('id', journal.id);
      return NextResponse.json({ error: 'Failed to create reversal journal lines' }, { status: 500 });
    }

    // Post the reversal
    const { error: postErr } = await supabase.rpc('finance.post_journal_entry', {
      p_journal_id: journal.id,
      p_posted_by: auth.userId,
    });

    if (postErr) {
      await supabase.from('finance.journal_lines').delete().eq('journal_entry_id', journal.id);
      await supabase.from('finance.journal_entries').delete().eq('id', journal.id);
      return NextResponse.json({ error: 'GL posting failed: ' + postErr.message }, { status: 500 });
    }

    // Update receipt status
    await supabase.from('payment_receipts').update({
      status: 'REVERSED',
      reversed_at: new Date().toISOString(),
      reversed_by: auth.userId,
      reversal_reason: reason,
      reversal_journal_id: journal.id,
    }).eq('id', payment_receipt_id);

    // Reverse invoice payment statuses
    const allocations = getData(await supabase
      .from('payment_allocations')
      .select('id, invoice_id, amount')
      .eq('payment_receipt_id', payment_receipt_id));

    if (allocations) {
      for (const alloc of allocations) {
        // Reverse allocation
        await supabase.from('payment_allocations').update({
          status: 'REVERSED',
          reversed_at: new Date().toISOString(),
          reversed_by: auth.userId,
        }).eq('id', alloc.id);

        // Update invoice amount_paid (reduce)
        const invoice = getData(await supabase
          .from('invoices')
          .select('id, total_amount, amount_paid')
          .eq('id', alloc.invoice_id)
          .single());

        if (invoice) {
          const newPaid = Math.max(0, Number(invoice.amount_paid || 0) - Number(alloc.amount));
          const total = Number(invoice.total_amount);
          const newStatus = newPaid <= 0.01 ? 'ISSUED' : 'PARTIALLY_PAID';

          await supabase.from('invoices').update({
            amount_paid: newPaid,
            status: newStatus,
          }).eq('id', alloc.invoice_id);
        }
      }
    }

    try {
      await supabase.rpc('audit.log_action', {
        p_user_id: auth.userId,
        p_action: 'PAYMENT_REVERSED',
        p_entity_type: 'payment_receipt',
        p_entity_id: payment_receipt_id,
        p_description: `Payment reversal: ${receipt.receipt_number} - Reason: ${reason}`,
        p_previous_status: receipt.status,
        p_new_status: 'REVERSED',
        p_source_module: 'invoice',
        p_severity: 'high',
        p_reason: reason,
        p_new_values: {
          reversal_reference: reversalReference,
          amount: totalAmount,
          original_journal_id: receipt.journal_entry_id,
          reversal_journal_id: journal.id,
        },
        p_related_journal_id: journal.id,
      });
    } catch (auditErr: any) {
      console.error('Audit log failed:', auditErr);
    }

    return NextResponse.json({
      success: true,
      reversalJournalId: journal.id,
      reversalReference,
      message: `Payment ${receipt.receipt_number} reversed: ${reversalReference}`,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}