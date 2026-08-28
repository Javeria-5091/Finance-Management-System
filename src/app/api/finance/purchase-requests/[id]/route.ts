import {NextRequest,NextResponse} from 'next/server';
import {getAuthSupabase,requirePermission} from '@/lib/api-auth';
const transitions:any={SUBMITTED:'DRAFT',CANCELLED:'DRAFT',REJECTED:'SUBMITTED',APPROVED:'SUBMITTED'};
export async function POST(req:NextRequest,{params}:{params:Promise<{id:string}>})
{
    const a=await requirePermission('PURCHASE_REQUEST_UPDATE');
    if(a instanceof NextResponse)
        return a;
    const {id}=await params;
    const body=await req.json();
    if(!transitions[body.status])
        return NextResponse.json({error:'Invalid transition'},{status:400});
    const {supabase}=await getAuthSupabase(req);
    const {data:row}=await supabase.schema('finance').from('purchase_requests').select('status,requested_by').eq('id',id).eq('organization_id',a.orgId).maybeSingle();
    if(!row||row.status!==transitions[body.status])
        return NextResponse.json({error:'Invalid current status'},{status:409});
    if(body.status==='APPROVED'&&row.requested_by===a.userId)
        return NextResponse.json({error:'Maker-checker: requester cannot approve own request'},{status:403});
    const patch:any={status:body.status,updated_at:new Date().toISOString()};
    if(body.status==='APPROVED')
        {patch.approved_by=a.userId;patch.approved_at=new Date().toISOString()}
    if(body.status==='REJECTED')patch.rejection_reason=String(body.reason||'Rejected').slice(0,1000);
    const {data,error}=await supabase.schema('finance').from('purchase_requests').update(patch).eq('id',id).eq('organization_id',a.orgId).select().single();
    return error?NextResponse.json({error:error.message},{status:400}):NextResponse.json({data});
}
