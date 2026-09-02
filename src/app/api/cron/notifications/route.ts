import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export async function POST(req: NextRequest) {
  const secret=process.env.CRON_SECRET;
  if(!secret || req.headers.get('authorization')!==`Bearer ${secret}`) return NextResponse.json({error:'Unauthorized'},{status:401});
  const db=createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!,process.env.SUPABASE_SERVICE_ROLE_KEY!,{auth:{autoRefreshToken:false,persistSession:false}});
  const {data: rows,error}=await db.from('notification_deliveries').select('id,notification_id,channel,status').eq('status','PENDING').eq('channel','EMAIL').order('created_at').limit(50);
  if(error) return NextResponse.json({error:error.message},{status:500});
  const webhook=process.env.NOTIFICATION_EMAIL_WEBHOOK_URL;
  if(!webhook) return NextResponse.json({processed:0,reason:'NOTIFICATION_EMAIL_WEBHOOK_URL is not configured'});
  let delivered=0;
  for(const row of rows||[]){
    const {data:n}=await db.from('notifications').select('id,user_id,title,message,action_url,organization_id').eq('id',row.notification_id).single();
    if(!n) { await db.from('notification_deliveries').update({status:'FAILED',error_message:'Notification not found',delivered_at:new Date().toISOString()}).eq('id',row.id); continue; }
    const {data:u}=await db.auth.admin.getUserById(n.user_id);
    const email=u?.user?.email;
    if(!email){ await db.from('notification_deliveries').update({status:'FAILED',error_message:'Recipient email unavailable',delivered_at:new Date().toISOString()}).eq('id',row.id); continue; }
    try {
      const resp=await fetch(webhook,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({to:email,subject:n.title,text:n.message,action_url:n.action_url,notification_id:n.id,organization_id:n.organization_id}),cache:'no-store'});
      if(!resp.ok) throw new Error(`Email provider returned ${resp.status}`);
      await db.from('notification_deliveries').update({status:'DELIVERED',delivered_at:new Date().toISOString(),error_message:null}).eq('id',row.id); delivered++;
    } catch(e:any){ await db.from('notification_deliveries').update({status:'FAILED',error_message:e?.message||'Email delivery failed',delivered_at:new Date().toISOString()}).eq('id',row.id); }
  }
  return NextResponse.json({processed:rows?.length||0,delivered});
}
