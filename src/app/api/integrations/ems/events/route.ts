import { NextRequest, NextResponse } from 'next/server';
import { createHmac } from 'crypto';
import { createEMSServiceClient, hashPayload, processEMSEvent } from '@/services/ems-integration.service';
export async function POST(req:NextRequest)
{
 const secret=process.env.EMS_INTEGRATION_SECRET; 
 if(!secret) 
    return NextResponse.json({error:'EMS integration is not configured'},{status:503});
 const body=await req.json(); 
 const signature=req.headers.get('x-ems-signature')||'';
 const expected=createHmac('sha256',secret).update(JSON.stringify(body)).digest('hex'); 
 if(signature!==expected) 
    return NextResponse.json({error:'Invalid integration signature'},{status:401});
 const db=createEMSServiceClient();
 const {data:existing}=await db.schema('core').from('integration_events').select('id,processing_status').eq('organization_id',body.organization_id).eq('idempotency_key',body.idempotency_key).maybeSingle();
 if(existing?.processing_status==='PROCESSED') 
    return NextResponse.json({id:existing.id,status:'PROCESSED'});
 const {data:event,error}=await db.schema('core').from('integration_events').insert({schema_version:1,source_module:'EMS',event_type:body.event_type,organization_id:body.organization_id,idempotency_key:body.idempotency_key,occurred_at:body.occurred_at||new Date().toISOString(),effective_business_date:body.effective_business_date||null,payload:body.payload,payload_hash:hashPayload(body.payload),processing_status:'PENDING'}).select().single();
 if(error) 
    return NextResponse.json({error:error.message},{status:409});
 try{ await processEMSEvent(db,event.id); 
    return NextResponse.json({id:event.id,status:'PROCESSED'}); 
} 
catch(e:any){ await db.schema('core').from('integration_events').update({processing_status:'FAILED'}).eq('id',event.id); 
await db.schema('core').from('integration_failures').insert({integration_event_id:event.id,retry_count:0,last_error:e?.message||'EMS processing failed',next_retry_at:new Date(Date.now()+300000).toISOString(),dead_letter:false}); 
return NextResponse.json({error:e?.message||'EMS processing failed',id:event.id},{status:500}); 
}
}
