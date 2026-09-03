import { NextRequest, NextResponse } from 'next/server';
import { getAuthSupabase, requirePermission, checkApprovalLimitAsync } from '@/lib/api-auth';
import { z } from 'zod';

const schema = z.object({
  action: z.enum(['submit', 'approve', 'post']),
}).strict();

export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message || 'Invalid request' },
      { status: 400 }
    );
  }

  const { action } = parsed.data;

  // Permissions are checked per transition rather than granting the whole
  // batch lifecycle to any caller who can merely read batches.
  const permission =
    action === 'approve'
      ? 'VENDOR_PAYMENT_APPROVE'
      : action === 'post'
        ? 'VENDOR_PAYMENT_POST'
        : 'VENDOR_PAYMENT_UPDATE';

  const auth = await requirePermission(permission);
  if (auth instanceof NextResponse) return auth;
  const { supabase } = await getAuthSupabase(req);

  const { data: batch, error: batchError } = await supabase
    .schema('finance')
    .from('vendor_payment_batches')
    .select('*')
    .eq('id', params.id)
    .eq('organization_id', auth.orgId)
    .maybeSingle();

  if (batchError) {
    return NextResponse.json({ error: batchError.message }, { status: 500 });
  }
  if (!batch) return NextResponse.json({ error: 'Batch not found' }, { status: 404 });

  if (action === 'submit') {
    if (batch.status !== 'DRAFT') {
      return NextResponse.json({ error: 'Only DRAFT batches can be submitted' }, { status: 409 });
    }

    const { data, error } = await supabase.schema('finance').rpc(
      'transition_vendor_payment_batch_atomic',
      {
        p_batch_id: params.id,
        p_action: 'submit',
        p_user_id: auth.userId,
      }
    );

    if (error) return NextResponse.json({ error: error.message }, { status: 400 });
    return NextResponse.json({ success: true, batch: data });
  }

  if (action === 'approve') {
    if (batch.status !== 'SUBMITTED') {
      return NextResponse.json({ error: 'Only SUBMITTED batches can be approved' }, { status: 409 });
    }

    // Maker-checker: the batch creator cannot approve their own batch.
    if (batch.created_by && batch.created_by === auth.userId) {
      return NextResponse.json(
        { error: 'Maker-checker violation: you cannot approve a batch you created' },
        { status: 403 }
      );
    }

    // AL-01 FIX: finance.vendor_payment_batches has no currency column of
    // its own -- transition_vendor_payment_batch_atomic (P1_096) already
    // enforces that every payment grouped into a batch shares one currency,
    // so read it off any linked payment instead of implicitly defaulting to
    // PKR. This ensures e.g. a USD batch total is checked against a
    // USD-configured limit rather than a PKR one.
    const { data: batchPayment } = await supabase
      .schema('finance')
      .from('vendor_payments')
      .select('currency')
      .eq('batch_id', params.id)
      .limit(1)
      .maybeSingle();

    const limitCheck = await checkApprovalLimitAsync(
      supabase,
      auth.orgId,
      auth.userId,
      auth.role,
      'VENDOR_PAYMENT',
      Number(batch.total_amount) || 0,
      batchPayment?.currency || 'PKR',
      'VENDOR_PAYMENT_APPROVE'
    );
    if (!limitCheck.allowed) {
      return NextResponse.json({ error: limitCheck.reason }, { status: 403 });
    }

    const { data, error } = await supabase.schema('finance').rpc(
      'transition_vendor_payment_batch_atomic',
      {
        p_batch_id: params.id,
        p_action: 'approve',
        p_user_id: auth.userId,
      }
    );

    if (error) return NextResponse.json({ error: error.message }, { status: 400 });
    return NextResponse.json({ success: true, batch: data });
  }

  if (batch.status !== 'APPROVED') {
    return NextResponse.json({ error: 'Only APPROVED batches can be posted' }, { status: 409 });
  }

  const { data, error } = await supabase.schema('finance').rpc(
    'post_vendor_payment_batch_atomic',
    { p_batch_id: params.id }
  );

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }

  return NextResponse.json({ success: true, batch: data });
}