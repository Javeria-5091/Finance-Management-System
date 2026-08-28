import {NextRequest,NextResponse} from 'next/server';
import {getAuthSupabase,requirePermission} from '@/lib/api-auth';
import {z} from 'zod';
const s=z.object({action:z.enum(['generate','acknowledge','draft_bill']),subscription_id:z.string().uuid().optional(),renewal_date:z.string().date().optional(),reminder_days:z.number().int().min(0).max(365).default(30),event_id:z.string().uuid().optional()});
export async function POST(req:NextRequest)
{
    const a=await requirePermission('SUBSCRIPTION_UPDATE');
    if(a instanceof NextResponse)
        return a;
    const {supabase}=await getAuthSupabase(req);
    const p=s.safeParse(await req.json());
    if(!p.success)
        return NextResponse.json({error:p.error.issues[0]?.message},{status:400});
    const b=p.data;
    try{
        if(b.action==='generate'){const {data,error}=await supabase.from('subscriptions').select('*').eq('organization_id',a.orgId).eq('status','ACTIVE').not('renewal_date','is',null).lte('renewal_date',new Date(Date.now()+b.reminder_days*86400000).toISOString().slice(0,10));
        if(error)
            throw error;
        let created=0;for(const sub of data||[]){const {error:e}=await supabase.from('subscription_renewal_events').upsert({subscription_id:sub.id,organization_id:a.orgId,renewal_date:sub.renewal_date,reminder_days:b.reminder_days,created_by:a.userId},{onConflict:'subscription_id,renewal_date'});
        if(!e)created++;}return NextResponse.json({created});
    }
if(!b.event_id)throw new Error('event_id is required');
const {data:event,error}=await supabase.from('subscription_renewal_events').select('*,subscriptions(*)').eq('id',b.event_id).eq('organization_id',a.orgId).single();
if(error||!event)
    throw new Error('Renewal event not found');
if(b.action==='acknowledge'){const {data,error}=await supabase.from('subscription_renewal_events').update({status:'ACKNOWLEDGED',acknowledged_by:a.userId,acknowledged_at:new Date().toISOString()}).eq('id',event.id).eq('organization_id',a.orgId).select().single();
if(error)
    throw error;
return NextResponse.json({data});
}
if(b.action==='draft_bill'){const sub=(event as any).subscriptions;
    if(!sub?.vendor)throw new Error('Subscription vendor is required');
    const {data:vendors,error:ve}=await supabase.schema('finance').from('vendors').select('id').eq('organization_id',a.orgId).ilike('name',sub.vendor).limit(1);
    if(ve)throw ve;
    if(!vendors?.[0])
        throw new Error('Matching vendor not found; create vendor first');
    const {data:bill,error:be}=await supabase.schema('finance').from('vendor_bills').insert({vendor_id:vendors[0].id,bill_date:event.renewal_date,due_date:event.renewal_date,currency:sub.currency,total_amount:sub.amount,base_total_amount:sub.amount,subtotal:sub.amount,base_subtotal:sub.amount,status:'DRAFT',description:`Subscription renewal: ${sub.name}`,created_by:a.userId,organization_id:a.orgId}).select().single();
    if(be)throw be;
    await supabase.from('subscription_renewal_events').update({status:'DRAFT_BILL_CREATED',draft_vendor_bill_id:bill.id}).eq('id',event.id).eq('organization_id',a.orgId);
    return NextResponse.json({data:bill});}}
catch(e:any){
    return NextResponse.json({error:e.message||'Renewal operation failed'},{status:400})}}
