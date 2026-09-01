import { NextRequest, NextResponse } from 'next/server';
import { validateExchangeRate } from '@/lib/validations';
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

    // FND-AR-04 FIX: this used to select organization_id from the
    // public.payment_receipts view (which didn't expose it -- 42703 on
    // every call) and embed finance.journal_entries via journal_entry_id
    // (which had no FK, so PostgREST couldn't resolve it -- PGRST200).
    // The embedded journal_entry/journal_lines data was never actually
    // used below (the real reversal journal is looked up separately,
    // after the atomic RPC, by the returned journalId) so it's dropped
    // rather than fixed in place.
    const receipt = getData(await supabase
      .from('payment_receipts')
      .select('*')
      .eq('id', payment_receipt_id)
      .eq('organization_id', auth.orgId)
      .single());

    if (!receipt) {
      return NextResponse.json({ error: 'Payment receipt not found' }, { status: 404 });
    }

    if (receipt.status === 'REVERSED') {
      return NextResponse.json({ error: 'Payment receipt is already reversed' }, { status: 400 });
    }

    // BUG-008 FIX (M-11): validate exchange rate for non-PKR currencies.
    // Even though the rate comes from the stored receipt (not user input),
    // a previously-stored bad rate (e.g. from the unfixed payment-receipts
    // route before H-4) would propagate into the reversal journal here.
    // Fail closed rather than silently posting wrong PKR amounts.
    const rateError = validateExchangeRate(receipt.currency, receipt.exchange_rate);
    if (rateError) {
      return NextResponse.json({ error: rateError }, { status: 400 });
    }

    // BUG-020 FIX: Get open period with org filter
    const period = getData(await supabase
      .schema('finance').from('accounting_periods')
      .select('id')
      .eq('status', 'OPEN')
      .eq('organization_id', auth.orgId)
      .order('start_date', { ascending: false })
      .limit(1)
      .single());

    if (!period) {
      return NextResponse.json({ error: 'No OPEN accounting period found' }, { status: 400 });
    }

    // Confirmed fix: GL reversal, receipt status, allocation reversal, and invoice
    // balances are now performed by one SECURITY DEFINER database transaction.
    const { data: journalId, error: atomicErr } = await supabase.schema('finance').rpc('reverse_payment_receipt_atomic', {
      p_receipt_id: payment_receipt_id,
      p_period_id: period.id,
      p_reversal_date: new Date().toISOString().split('T')[0],
      p_reason: reason,
      p_reversed_by: auth.userId,
    });

    if (atomicErr || !journalId) {
      return NextResponse.json({ error: 'Atomic payment reversal failed: ' + (atomicErr?.message || 'Unknown error') }, { status: 500 });
    }

    const journal = getData(await supabase
      .schema('finance')
      .from('journal_entries')
      .select('id, reference')
      .eq('id', journalId)
      .eq('organization_id', auth.orgId)
      .single());
    if (!journal) {
      return NextResponse.json({ error: 'Payment reversal committed but journal metadata could not be read.' }, { status: 500 });
    }
    const reversalReference = journal.reference || `JE-PMTREV-${journalId}`;

    // BUG-023 FIX: surface a failed audit write instead of only
    // console-logging it (Spec 8.1). Especially important for a reversal,
    // which is itself a corrective/exception action worth being able to
    // trace with certainty.
    let auditLogFailed = false;
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
          amount: Number(receipt.amount),
          original_journal_id: receipt.journal_entry_id,
          reversal_journal_id: journal.id,
        },
        p_related_journal_id: journal.id,
      });
    } catch (auditErr: any) {
      console.error('Audit log failed for payment reversal:', auditErr);
      auditLogFailed = true;
    }

    return NextResponse.json({
      success: true,
      reversalJournalId: journal.id,
      reversalReference,
      message: `Payment ${receipt.receipt_number} reversed: ${reversalReference}`,
      audit_log_warning: auditLogFailed ? 'Reversal succeeded but the audit log entry failed to write. Please notify an administrator.' : undefined,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}