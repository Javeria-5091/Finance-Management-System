import { NextRequest, NextResponse } from 'next/server';
import { createHmac, timingSafeEqual } from 'crypto';
import { z } from 'zod';
import { createEMSServiceClient, hashPayload, processEMSEvent } from '@/services/ems-integration.service';
export async function POST(req:NextRequest)
{
 const secret=process.env.EMS_INTEGRATION_SECRET; 
 if(!secret) 
    return NextResponse.json({error:'EMS integration is not configured'},{status:503});
 const body=await req.json();
 const bodySchema=z.object({organization_id:z.string().uuid(),idempotency_key:z.string().trim().min(1).max(200),event_type:z.enum(['EMPLOYEE_UPSERT','EMPLOYEE_TERMINATE']),occurred_at:z.string().optional(),effective_business_date:z.string().optional().nullable(),payload:z.record(z.string(),z.unknown())}).strict();
 const parsed=bodySchema.safeParse(body);
 if(!parsed.success) return NextResponse.json({error:parsed.error.issues[0]?.message||'Invalid EMS event'},{status:400});
 const safeBody=parsed.data;
 const signature=req.headers.get('x-ems-signature')||'';
 const expected=createHmac('sha256',secret).update(JSON.stringify(body)).digest('hex');
 const sigBuf=Buffer.from(signature,'utf8'), expBuf=Buffer.from(expected,'utf8');
 if(sigBuf.length!==expBuf.length || !timingSafeEqual(sigBuf,expBuf)) 
    return NextResponse.json({error:'Invalid integration signature'},{status:401});
 const db=createEMSServiceClient();
 const {data:existing}=await db.schema('core').from('integration_events').select('id,processing_status').eq('organization_id',safeBody.organization_id).eq('idempotency_key',safeBody.idempotency_key).maybeSingle();
 if(existing?.processing_status==='PROCESSED') return NextResponse.json({id:existing.id,status:'PROCESSED'});
 if(existing?.id){
   try { await processEMSEvent(db, existing.id); return NextResponse.json({id:existing.id,status:'PROCESSED'}); }
   catch(e:any){ return NextResponse.json({error:e?.message||'EMS retry failed',id:existing.id},{status:500}); }
 }
 const {data:event,error}=await db.schema('core').from('integration_events').insert({schema_version:1,source_module:'EMS',event_type:safeBody.event_type,organization_id:safeBody.organization_id,idempotency_key:safeBody.idempotency_key,occurred_at:safeBody.occurred_at||new Date().toISOString(),effective_business_date:safeBody.effective_business_date||null,payload:safeBody.payload,payload_hash:hashPayload(safeBody.payload),processing_status:'PENDING'}).select().single();
 if(error){
   if(error.code==='23505'){
     const {data:raced}=await db.schema('core').from('integration_events').select('id,processing_status').eq('organization_id',safeBody.organization_id).eq('idempotency_key',safeBody.idempotency_key).maybeSingle();
     if(raced?.id){ try{ await processEMSEvent(db,raced.id); return NextResponse.json({id:raced.id,status:'PROCESSED'}); }catch(e:any){ return NextResponse.json({error:e?.message||'EMS processing failed',id:raced.id},{status:500}); } }
   }
   return NextResponse.json({error:error.message},{status:409});
 }
 try{ await processEMSEvent(db,event.id); 
    return NextResponse.json({id:event.id,status:'PROCESSED'}); 
} 
catch(e:any){ await db.schema('core').from('integration_events').update({processing_status:'FAILED'}).eq('id',event.id); 
await db.schema('core').from('integration_failures').insert({integration_event_id:event.id,retry_count:0,last_error:e?.message||'EMS processing failed',next_retry_at:new Date(Date.now()+300000).toISOString(),dead_letter:false}); 
return NextResponse.json({error:e?.message||'EMS processing failed',id:event.id},{status:500}); 
}
}
