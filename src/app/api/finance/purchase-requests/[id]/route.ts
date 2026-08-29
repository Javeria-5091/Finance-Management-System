import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getAuthSupabase, requirePermission } from '@/lib/api-auth';
import { enforceMakerChecker } from '@/lib/api-auth';

const actionSchema = z.object({ action: z.enum(['submit','approve','reject','cancel']), reason: z.string().trim().min(5).max(1000).optional() }).strict();

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requirePermission('PURCHASE_REQUEST_UPDATE'); if (auth instanceof NextResponse) return auth;
  const { id } = await params; const parsed = actionSchema.safeParse(await req.json()); if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message }, { status: 400 });
  const { supabase } = await getAuthSupabase(req); const { data: row } = await supabase.schema('finance').from('purchase_requests').select('*').eq('id', id).eq('organization_id', auth.orgId).maybeSingle();
  if (!row) return NextResponse.json({ error: 'Purchase request not found' }, { status: 404 });
  const { action, reason } = parsed.data; const patch:any = { updated_at:new Date().toISOString() };
  if (action==='submit') { if(row.status!=='DRAFT') return NextResponse.json({error:'Only DRAFT requests can be submitted'},{status:409}); patch.status='SUBMITTED'; patch.submitted_by=auth.userId; patch.submitted_at=new Date().toISOString(); }
  else if(action==='approve') { const approval=await requirePermission('PURCHASE_REQUEST_APPROVE'); if(approval instanceof NextResponse)return approval; if(row.status!=='SUBMITTED')return NextResponse.json({error:'Only SUBMITTED requests can be approved'},{status:409}); if(!enforceMakerChecker(row.requested_by,auth.userId))return NextResponse.json({error:'Maker-checker: requester cannot approve own request'},{status:403}); patch.status='APPROVED'; patch.approved_by=auth.userId; patch.approved_at=new Date().toISOString(); }
  else if(action==='reject') { const approval=await requirePermission('PURCHASE_REQUEST_APPROVE'); if(approval instanceof NextResponse)return approval; if(row.status!=='SUBMITTED')return NextResponse.json({error:'Only SUBMITTED requests can be rejected'},{status:409}); if(!reason)return NextResponse.json({error:'Rejection reason is required'},{status:400}); patch.status='REJECTED'; patch.rejection_reason=reason; }
  else { if(['APPROVED'].includes(row.status))return NextResponse.json({error:'Approved requests cannot be cancelled'},{status:409}); if(row.status==='CANCELLED')return NextResponse.json({error:'Already cancelled'},{status:409}); patch.status='CANCELLED'; patch.rejection_reason=reason||null; }
  const {data,error}=await supabase.schema('finance').from('purchase_requests').update(patch).eq('id',id).eq('organization_id',auth.orgId).select().single();
  if(error)return NextResponse.json({error:error.message},{status:400}); return NextResponse.json({data});
}
