import { NextRequest, NextResponse } from 'next/server';
import { getAuthSupabase } from '@/lib/api-auth';
import { requirePermission } from '@/lib/api-auth';
import { enforceMFA } from '@/lib/mfa-middleware';
import { paymentReversalSchema, validateBody } from '@/lib/validations';
 
function getData<T = any>(res: any): T | null {
  return res?.data ?? null;
}
 
// ─── POST: Reverse a posted payment (creates reversal journal entry) ───
// Spec: Payment Reversal → DR Receivable, CR Bank/Cash (exact opposite of receipt)
// BUG-001 FIX: Replaced manual header+lines insert + wrong RPC({ p_journal_id, p_posted_by })
//   with single atomic RPC call using correct signature.
export async function POST(req: NextRequest) {
  const auth = await requirePermission('APPROVE_INVOICE');
  if (auth instanceof NextResponse) return auth;
  // H3 FIX: Enforce MFA for financial posting
  const mfaCheck = await enforceMFA(auth);
  if (mfaCheck) return mfaCheck;
  const { supabase } = await getAuthSupabase(req);
 
  try {
    const rawBody = await req.json();
    const validation = validateBody(paymentReversalSchema, rawBody);
    if (!validation.success) return NextResponse.json({ error: validation.error }, { status: 400 });
    const payment_receipt_id = validation.data.paymentId;
    const { reason } = validation.data;
 
    // Fetch the original payment receipt
    const receipt = getData(await supabase
      .from('payment_receipts')
      .select('*, journal_entry:finance.journal_entries(id, reference, journal_lines(account_id, debit_amount, credit_amount, description))')
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
 
    // Get original journal lines to reverse
    const originalLines = getData(await supabase
      .from('finance.journal_lines')
      .select('account_id, debit_amount, credit_amount, description')
      .eq('journal_entry_id', receipt.journal_entry_id));
 
    if (!originalLines || originalLines.length === 0) {
      return NextResponse.json({ error: 'Original journal lines not found for reversal' }, { status: 500 });
    }
 
    // BUG-001 FIX: Build reversal lines for RPC (swap debit/credit, no journal_entry_id needed)
    const rpcLines = originalLines.map((line: any) => ({
      account_id: line.account_id,
      debit_amount: Number(line.credit_amount),  // Swap: original credit → reversal debit
      credit_amount: Number(line.debit_amount),   // Swap: original debit → reversal credit
      description: `REVERSAL: ${line.description}`,
    }));
 
    // BUG-001 FIX: Single atomic RPC call with CORRECT signature
    const { data: journalId, error: postErr } = await supabase.rpc('finance.post_journal_entry', {
      p_description: `REVERSAL: Payment Receipt ${receipt.receipt_number} - ${reason}`,
      p_transaction_date: new Date().toISOString().split('T')[0],
      p_period_id: period.id,
      p_lines: JSON.stringify(rpcLines),
      p_currency: receipt.currency || 'PKR',
      p_exchange_rate: receipt.exchange_rate || 1,
      p_source_type: 'PAYMENT_REVERSAL',
      p_source_id: payment_receipt_id,
    });
 
    if (postErr || !journalId) {
      return NextResponse.json({ error: 'GL posting failed: ' + (postErr?.message || 'Unknown error') }, { status: 500 });
    }
 
    // Fetch the created journal to get reference
    const journal = getData(await supabase
      .from('finance.journal_entries')
      .select('id, reference')
      .eq('id', journalId)
      .single());
    // C6 FIX: Null guard
    if (!journal) {
      return NextResponse.json({ error: 'Journal created but fetch failed. Check journal ID: ' + journalId }, { status: 500 });
    }
    const reversalReference = journal.reference || `JE-PMTREV-${journalId}`;
 
    // Update receipt status
    await supabase.from('payment_receipts').update({
      status: 'REVERSED',
      reversed_at: new Date().toISOString(),
      reversed_by: auth.userId,
      reversal_reason: reason,
      reversal_journal_id: journalId,
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
      await supabase.schema('audit').rpc('log_action', {
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
 

