import { createHash } from 'crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

export type EMSEventType = 'EMPLOYEE_UPSERT'|'EMPLOYEE_TERMINATE';
export function createEMSServiceClient(){ return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!,process.env.SUPABASE_SERVICE_ROLE_KEY!,{auth:{autoRefreshToken:false,persistSession:false}}); }
export function hashPayload(payload: unknown){ return createHash('sha256').update(JSON.stringify(payload)).digest('hex'); }
export async function publishEMSEvent(db: SupabaseClient, input:{organizationId:string,eventType:EMSEventType,payload:Record<string,unknown>,idempotencyKey:string,actorUserId?:string|null}){
 const {data,error}=await db.schema('core').from('integration_events').insert({schema_version:1,source_module:'FINANCE',event_type:input.eventType,organization_id:input.organizationId,idempotency_key:input.idempotencyKey,occurred_at:new Date().toISOString(),actor_user_id:input.actorUserId||null,payload:input.payload,payload_hash:hashPayload(input.payload),processing_status:'PENDING'}).select().single();
 return {data,error};
}
export async function processEMSEvent(db:SupabaseClient,eventId:string){
 const {data:event,error}=await db.schema('core').from('integration_events').select('*').eq('id',eventId).single();
 if(error||!event) throw error||new Error('Integration event not found');
 if(event.processing_status==='PROCESSED') return event;
 if(!event.organization_id) throw new Error('Integration event organization is required');
 const p=event.payload as Record<string,any>;
 if(!p.external_employee_id) throw new Error('external_employee_id is required');
 const externalId=String(p.external_employee_id);
 const displayName=String(p.name||p.full_name||externalId);
 const status=event.event_type==='EMPLOYEE_TERMINATE'?'TERMINATED':'ACTIVE';
 // Idempotent logical key: organization + EMS external employee ID.
 const {data:existing,error:findError}=await db.schema('core').from('shared_people').select('id').eq('organization_id',event.organization_id).eq('external_reference',externalId).limit(1).maybeSingle();
 if(findError) throw findError;
 let personId=existing?.id as string|undefined;
 if(personId){
   const {error:e}=await db.schema('core').from('shared_people').update({display_name:displayName,status,updated_at:new Date().toISOString()}).eq('id',personId).eq('organization_id',event.organization_id);
   if(e) throw e;
 } else {
   const {data:person,error:e}=await db.schema('core').from('shared_people').insert({organization_id:event.organization_id,person_type:'EMPLOYEE',display_name:displayName,status,external_reference:externalId}).select('id').single();
   if(e||!person) throw e||new Error('Unable to create shared employee');
   personId=person.id;
 }
 const {data:link,error:linkFindError}=await db.schema('core').from('employee_links').select('id').eq('shared_person_id',personId).eq('source_module','EMS').limit(1).maybeSingle();
 if(linkFindError) throw linkFindError;
 if(link){
   const {error:e}=await db.schema('core').from('employee_links').update({external_employee_id:externalId,schema_version:1,updated_at:new Date().toISOString()}).eq('id',link.id);
   if(e) throw e;
 } else {
   const {error:e}=await db.schema('core').from('employee_links').insert({shared_person_id:personId,source_module:'EMS',external_employee_id:externalId,schema_version:1});
   if(e) throw e;
 }
 const {error:markError}=await db.schema('core').from('integration_events').update({processing_status:'PROCESSED',processed_at:new Date().toISOString()}).eq('id',event.id).neq('processing_status','PROCESSED');
 if(markError) throw markError;
 return event;
}
