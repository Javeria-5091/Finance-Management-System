import { NextRequest, NextResponse } from 'next/server';
import { getAuthSupabase, requirePermission } from '@/lib/api-auth';
import { z } from 'zod';

const schema = z.object({ action: z.enum(['submit','approve','post','cancel']), reason: z.string().trim().min(5).max(500).optional() }).strict();

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requirePermission('VENDOR_PAYMENT_UPDATE');
  if (auth instanceof NextResponse) return auth;
  const { supabase } = await getAuthSupabase(req);
  const parsed = schema.safeParse(await req.json());
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message }, { status: 400 });

  const { data: batch } = await supabase.schema('finance').from('vendor_payment_batches').select('*')
    .eq('id', params.id).eq('organization_id', auth.orgId).maybeSingle();
  if (!batch) return NextResponse.json({ error: 'Batch not found' }, { status: 404 });

  const { action, reason } = parsed.data;
  if (action === 'submit') {
    if (batch.status !== 'DRAFT') return NextResponse.json({ error: 'Only DRAFT batches can be submitted' }, { status: 409 });
    const { data, error } = await supabase.schema('finance').from('vendor_payment_batches').update({ status:'SUBMITTED', submitted_by:auth.userId, submitted_at:new Date().toISOString() }).eq('id', params.id).select().single();
    if (error) return NextResponse.json({ error:error.message }, { status:500 });
    return NextResponse.json({ success:true, batch:data });
  }
  if (action === 'approve') {
    const approval = await requirePermission('VENDOR_PAYMENT_APPROVE');
    if (approval instanceof NextResponse) return approval;
    if (batch.status !== 'SUBMITTED') return NextResponse.json({ error: 'Only SUBMITTED batches can be approved' }, { status: 409 });
    const { data, error } = await supabase.schema('finance').from('vendor_payment_batches').update({ status:'APPROVED', approved_by:auth.userId, approved_at:new Date().toISOString() }).eq('id', params.id).eq('organization_id',auth.orgId).select().single();
    if (error) return NextResponse.json({ error:error.message }, { status:500 });
    return NextResponse.json({ success:true, batch:data });
  }
  if (action === 'post') {
    const posting = await requirePermission('VENDOR_PAYMENT_POST');
    if (posting instanceof NextResponse) return posting;
    if (batch.status !== 'APPROVED') return NextResponse.json({ error:'Only APPROVED batches can be posted' }, { status:409 });
    const { data: lines, error: lineError } = await supabase.schema('finance').from('vendor_payment_batch_lines').select('vendor_payment_id').eq('batch_id',params.id).eq('organization_id',auth.orgId);
    if (lineError) return NextResponse.json({error:lineError.message},{status:500});
    if (!lines?.length) return NextResponse.json({error:'Batch has no payment proposals'},{status:409});
    for (const line of lines) {
      const { data: payment } = await supabase.schema('finance').from('vendor_payments').select('id,status,period_id,payment_date').eq('id',line.vendor_payment_id).eq('organization_id',auth.orgId).maybeSingle();
      if (!payment) return NextResponse.json({error:'Batch contains an invalid payment'},{status:409});
      if (payment.status === 'POSTED') continue;
      if (payment.status !== 'DRAFT' && payment.status !== 'APPROVED') return NextResponse.json({error:`Payment ${payment.id} is not ready for posting`},{status:409});
      if (!payment.period_id) return NextResponse.json({error:`Payment ${payment.id} has no accounting period`},{status:409});
      const { data: journalId, error: postError } = await supabase.schema('finance').rpc('post_vendor_payment',{p_payment_id:payment.id,p_period_id:payment.period_id,p_transaction_date:payment.payment_date});
      if (postError) return NextResponse.json({error:`Payment posting failed: ${postError.message}`},{status:400});
      const { error: paymentUpdateError } = await supabase.schema('finance').from('vendor_payments').update({status:'POSTED',journal_entry_id:journalId,posted_by:auth.userId,posted_at:new Date().toISOString(),updated_at:new Date().toISOString()}).eq('id',payment.id).eq('organization_id',auth.orgId);
      if (paymentUpdateError) return NextResponse.json({error:paymentUpdateError.message},{status:500});
    }
    const {data,error}=await supabase.schema('finance').from('vendor_payment_batches').update({status:'POSTED',posted_by:auth.userId,posted_at:new Date().toISOString(),updated_at:new Date().toISOString()}).eq('id',params.id).eq('organization_id',auth.orgId).select().single();
    if(error)return NextResponse.json({error:error.message},{status:500}); return NextResponse.json({success:true,batch:data});
  }
  if (batch.status === 'POSTED') return NextResponse.json({ error:'Posted batches cannot be cancelled' }, { status:409 });
  if (!reason) return NextResponse.json({ error:'Cancellation reason is required' }, { status:400 });
  const { data, error } = await supabase.schema('finance').from('vendor_payment_batches').update({ status:'CANCELLED', cancellation_reason:reason }).eq('id', params.id).select().single();
  if (error) return NextResponse.json({ error:error.message }, { status:500 });
  return NextResponse.json({ success:true, batch:data });
}
