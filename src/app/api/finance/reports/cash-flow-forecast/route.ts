import { NextRequest, NextResponse } from 'next/server';
import { getAuthSupabase, requirePermission } from '@/lib/api-auth';

export async function POST(req:NextRequest){
 const auth=await requirePermission('REPORT_READ');
 if(auth instanceof NextResponse)return auth;
 const {supabase}=await getAuthSupabase(req);
 const b=await req.json();
 const horizon=Number(b.horizon_days||30);
 if(![30,60,90].includes(horizon))return NextResponse.json({error:'horizon_days must be 30, 60 or 90'},{status:400});
 const start=new Date();
 const end=new Date(start); end.setDate(end.getDate()+horizon);
 const iso=(d:Date)=>d.toISOString().slice(0,10);
 const {data:cashFlow,error:cfError}=await supabase.rpc('cash_flow',{p_start:iso(new Date(start.getTime()-90*86400000)),p_end:iso(start)});
 if(cfError)return NextResponse.json({error:cfError.message},{status:400});
 const openingCash=Number((cashFlow as any)?.cash_balance||0);
 const {data:rec,error:recError}=await supabase.schema('finance').from('payment_receipts').select('amount,payment_date').eq('organization_id',auth.orgId).eq('status','POSTED').gte('payment_date',iso(start)).lte('payment_date',iso(end));
 if(recError)return NextResponse.json({error:recError.message},{status:400});
 const {data:pay,error:payError}=await supabase.schema('finance').from('vendor_payments').select('amount,payment_date').eq('organization_id',auth.orgId).eq('status','POSTED').gte('payment_date',iso(start)).lte('payment_date',iso(end));
 if(payError)return NextResponse.json({error:payError.message},{status:400});
 const inflow=(rec||[]).reduce((s:number,x:any)=>s+Number(x.amount||0),0);
 const outflow=(pay||[]).reduce((s:number,x:any)=>s+Number(x.amount||0),0);
 const scenarios=[['BASE',1,1],['CONSERVATIVE',0.85,1.10],['OPTIMISTIC',1.10,0.95]] as const;
 const rows=scenarios.map(([scenario,inMult,outMult])=>({organization_id:auth.orgId,forecast_date:iso(start),horizon_days:horizon,scenario,opening_cash:openingCash,expected_inflows:inflow*inMult,expected_outflows:outflow*outMult,ending_cash:openingCash+inflow*inMult-outflow*outMult,assumptions:{source:'posted finance receipts/vendor payments and cash_flow RPC',horizon_days:horizon,scenario},confidence:scenario==='BASE'?0.70:0.55,calculated_at:new Date().toISOString(),calculated_by:auth.userId}));
 const {data,error}=await supabase.schema('reporting').from('cash_flow_forecasts').upsert(rows,{onConflict:'organization_id,forecast_date,horizon_days,scenario'}).select();
 if(error)return NextResponse.json({error:error.message},{status:400});
 return NextResponse.json({data});
}
