import { NextRequest, NextResponse } from 'next/server';
import { createEMSServiceClient, processEMSEvent } from '@/services/ems-integration.service';
export async function POST(req:NextRequest)
{
    const secret=process.env.CRON_SECRET;
    if(!secret || req.headers.get('authorization')!==`Bearer ${secret}`) 
        return NextResponse.json({error:'Unauthorized'},{status:401});
    const db=createEMSServiceClient();
    const {data:failed}=await db.schema('core').from('integration_failures').select('id,integration_event_id,retry_count').eq('dead_letter',false).lte('next_retry_at',new Date().toISOString()).order('next_retry_at').limit(50);
    let processed=0,dead=0;
    for(const f of failed||[])
    { 
        try
        { 
            await processEMSEvent(db,f.integration_event_id); 
            await db.schema('core').from('integration_failures').update({updated_at:new Date().toISOString()}).eq('id',f.id); 
            processed++; 
        } 
        catch(e:any)
        { 
            const retry=(f.retry_count||0)+1; 
            await db.schema('core').from('integration_failures').update({retry_count:retry,last_error:e?.message||'retry failed',next_retry_at:new Date(Date.now()+Math.min(86400000,300000*Math.pow(2,retry-1))).toISOString(),dead_letter:retry>=5,updated_at:new Date().toISOString()}).eq('id',f.id); 
            if(retry>=5) 
                { 
                    await db.schema('core').from('integration_events').update({processing_status:'DEAD_LETTER'}).eq('id',f.integration_event_id); 
                    dead++; 
                } 
        } 
    }
    return NextResponse.json({processed,dead_lettered:dead});
}
