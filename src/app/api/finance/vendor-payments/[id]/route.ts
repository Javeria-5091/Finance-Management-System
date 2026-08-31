import { NextRequest, NextResponse } from 'next/server';
import { getAuthSupabase, requirePermission, checkApprovalLimitAsync } from '@/lib/api-auth';
import { z } from 'zod';

// FND-VP-001 FIX: this file was mistakenly created under
// vendor-payments/batches/[id]/ instead of vendor-payments/[id]/. The main
// vendor-payments page calls PATCH /api/finance/vendor-payments/{id} for
// approve/post/cancel, which had no [id]/route.ts at all -- every request
// 404'd and broke .json() parsing on the client. Identical, unchanged
// maker-checker + approval-limit + GL-posting logic to
// vendor-payments/batches/[id]/route.ts.

const schema = z.object({
  action: z.enum(['approve', 'post', 'cancel']),
  reason: z.string().trim().min(5).max(500).optional(),
}).strict();

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requirePermission('VENDOR_PAYMENT_UPDATE');
  if (auth instanceof NextResponse) return auth;
  const { supabase } = await getAuthSupabase(req);

  const parsed = schema.safeParse(await req.json());
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message }, { status: 400 });
  const { action, reason } = parsed.data;

  const { data: payment } = await supabase
    .schema('finance').from('vendor_payments')
    .select('*')
    .eq('id', params.id).eq('organization_id', auth.orgId).eq('is_batch', false)
    .maybeSingle();
  if (!payment) return NextResponse.json({ error: 'Payment not found' }, { status: 404 });

  // ---- APPROVE ----
  if (action === 'approve') {
    const approval = await requirePermission('VENDOR_PAYMENT_APPROVE');
    if (approval instanceof NextResponse) return approval;

    if (payment.status !== 'DRAFT') {
      return NextResponse.json({ error: 'Only DRAFT payments can be approved' }, { status: 409 });
    }
    // Maker-checker: creator cannot approve their own payment.
    if (payment.created_by && payment.created_by === auth.userId) {
      return NextResponse.json({ error: 'Maker-checker violation: you cannot approve a payment you created' }, { status: 403 });
    }
    // Approval-limit / dual-approval-for-high-value check (spec 7.3/12.3).
    const limitCheck = await checkApprovalLimitAsync(
      supabase, auth.orgId, auth.userId, auth.role, 'VENDOR_PAYMENT', Number(payment.amount) || 0
    );
    if (!limitCheck.allowed) {
      return NextResponse.json({ error: limitCheck.reason }, { status: 403 });
    }

    const { data, error } = await supabase
      .schema('finance').from('vendor_payments')
      .update({ status: 'APPROVED', approved_by: auth.userId, approved_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq('id', params.id).eq('organization_id', auth.orgId).eq('status', 'DRAFT')
      .select().single();
    if (error || !data) return NextResponse.json({ error: error?.message || 'Concurrent modification — refresh and try again' }, { status: error ? 500 : 409 });

    try {
      await supabase.schema('audit').rpc('log_action', {
        p_user_id: auth.userId, p_action: 'VENDOR_PAYMENT_APPROVED', p_entity_type: 'vendor_payment',
        p_entity_id: params.id, p_description: `Approved vendor payment ${payment.payment_number || params.id}`,
        p_previous_status: 'DRAFT', p_new_status: 'APPROVED', p_source_module: 'vendor_payment', p_severity: 'medium',
        p_new_values: { amount: payment.amount },
      });
    } catch (e: any) { console.error('Audit log failed:', e); }

    return NextResponse.json({ success: true, payment: data });
  }

  // ---- POST TO GL ----
  if (action === 'post') {
    const posting = await requirePermission('VENDOR_PAYMENT_POST');
    if (posting instanceof NextResponse) return posting;

    if (payment.status !== 'APPROVED') {
      return NextResponse.json({ error: 'Only APPROVED payments can be posted' }, { status: 409 });
    }

    const { data: period } = await supabase
      .schema('finance').from('accounting_periods')
      .select('id').eq('status', 'OPEN').eq('organization_id', auth.orgId)
      .lte('start_date', payment.payment_date).gte('end_date', payment.payment_date)
      .maybeSingle();
    if (!period) {
      return NextResponse.json({ error: 'No OPEN accounting period found for this payment date' }, { status: 400 });
    }

    const { data: journalId, error: postError } = await supabase
      .schema('finance').rpc('post_vendor_payment', {
        p_payment_id: payment.id,
        p_period_id: period.id,
        p_transaction_date: payment.payment_date,
      });
    if (postError || !journalId) {
      return NextResponse.json({ error: `GL posting failed: ${postError?.message || 'Unknown error'}` }, { status: 400 });
    }

    const { data, error } = await supabase
      .schema('finance').from('vendor_payments')
      .update({ status: 'POSTED', journal_entry_id: journalId, period_id: period.id, posted_by: auth.userId, posted_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq('id', params.id).eq('organization_id', auth.orgId).eq('status', 'APPROVED')
      .select().single();
    if (error || !data) return NextResponse.json({ error: error?.message || 'Concurrent modification — refresh and try again' }, { status: error ? 500 : 409 });

    try {
      await supabase.schema('audit').rpc('log_action', {
        p_user_id: auth.userId, p_action: 'VENDOR_PAYMENT_POSTED', p_entity_type: 'vendor_payment',
        p_entity_id: params.id, p_description: `Posted vendor payment ${payment.payment_number || params.id} to GL`,
        p_previous_status: 'APPROVED', p_new_status: 'POSTED', p_source_module: 'vendor_payment', p_severity: 'high',
        p_new_values: { amount: payment.amount, journal_id: journalId },
        p_related_journal_id: journalId,
      });
    } catch (e: any) { console.error('Audit log failed:', e); }

    return NextResponse.json({ success: true, payment: data, journalId });
  }

  // ---- CANCEL (DRAFT/APPROVED only — vendor_payments has no CANCELLED
  // status, only REVERSED, matching the DB CHECK constraint) ----
  if (payment.status === 'POSTED' || payment.status === 'REVERSED') {
    return NextResponse.json({ error: 'Posted or already-reversed payments cannot be cancelled here — use a reversal.' }, { status: 409 });
  }
  if (!reason) return NextResponse.json({ error: 'Cancellation reason is required' }, { status: 400 });

  // Release any allocations first so finance.auto_update_bill_status()
  // restores the bills' outstanding_amount/status.
  const { error: allocDeleteError } = await supabase
    .schema('finance').from('vendor_payment_allocations')
    .delete().eq('vendor_payment_id', params.id);
  if (allocDeleteError) return NextResponse.json({ error: allocDeleteError.message }, { status: 500 });

  const { data, error } = await supabase
    .schema('finance').from('vendor_payments')
    .update({ status: 'REVERSED', updated_at: new Date().toISOString() })
    .eq('id', params.id).eq('organization_id', auth.orgId)
    .select().single();
  if (error || !data) return NextResponse.json({ error: error?.message || 'Cancel failed' }, { status: 500 });

  try {
    await supabase.schema('audit').rpc('log_action', {
      p_user_id: auth.userId, p_action: 'VENDOR_PAYMENT_CANCELLED', p_entity_type: 'vendor_payment',
      p_entity_id: params.id, p_description: `Cancelled vendor payment ${payment.payment_number || params.id}: ${reason}`,
      p_previous_status: payment.status, p_new_status: 'REVERSED', p_reason: reason, p_source_module: 'vendor_payment', p_severity: 'medium',
    });
  } catch (e: any) { console.error('Audit log failed:', e); }

  return NextResponse.json({ success: true, payment: data });
}