import { NextRequest, NextResponse } from 'next/server';
import { getAuthSupabase, requirePermission } from '@/lib/api-auth';
import { z } from 'zod';

const schema = z.object({ action: z.enum(['submit','approve','cancel']), reason: z.string().trim().min(5).max(500).optional() }).strict();

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
    const approval = await requirePermission('APPROVE_PAYMENT');
    if (approval instanceof NextResponse) return approval;
    if (batch.status !== 'SUBMITTED') return NextResponse.json({ error: 'Only SUBMITTED batches can be approved' }, { status: 409 });
    const { data, error } = await supabase.schema('finance').from('vendor_payment_batches').update({ status:'APPROVED', approved_by:auth.userId, approved_at:new Date().toISOString() }).eq('id', params.id).select().single();
    if (error) return NextResponse.json({ error:error.message }, { status:500 });
    return NextResponse.json({ success:true, batch:data });
  }
  if (batch.status === 'POSTED') return NextResponse.json({ error:'Posted batches cannot be cancelled' }, { status:409 });
  if (!reason) return NextResponse.json({ error:'Cancellation reason is required' }, { status:400 });
  const { data, error } = await supabase.schema('finance').from('vendor_payment_batches').update({ status:'CANCELLED', cancellation_reason:reason }).eq('id', params.id).select().single();
  if (error) return NextResponse.json({ error:error.message }, { status:500 });
  return NextResponse.json({ success:true, batch:data });
}
