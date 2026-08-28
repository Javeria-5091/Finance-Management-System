import { NextRequest, NextResponse } from 'next/server';
import { getAuthSupabase, requirePermission } from '@/lib/api-auth';

export async function GET(req: NextRequest) {
 const auth=await requirePermission('INVOICE_READ'); if(auth instanceof NextResponse)return auth; const {supabase}=await getAuthSupabase(req);
 const invoiceId=new URL(req.url).searchParams.get('invoice_id'); if(!invoiceId)return NextResponse.json({error:'invoice_id is required'},{status:400});
 const {data,error}=await supabase.schema('finance').from('invoice_milestones').select('*').eq('organization_id',auth.orgId).eq('invoice_id',invoiceId).order('milestone_date');
 if(error)return NextResponse.json({error:error.message},{status:400}); return NextResponse.json({data});
}
export async function POST(req:NextRequest){
 const auth=await requirePermission('INVOICE_UPDATE'); if(auth instanceof NextResponse)return auth; const {supabase}=await getAuthSupabase(req); const b=await req.json();
 if(!b.invoice_id||!b.milestone_ref||!b.description||Number(b.amount)<=0||!b.milestone_date)return NextResponse.json({error:'invoice_id, milestone_ref, description, amount and milestone_date are required'},{status:400});
 const {data:inv}=await supabase.from('invoices').select('id').eq('id',b.invoice_id).eq('organization_id',auth.orgId).maybeSingle(); if(!inv)return NextResponse.json({error:'Invoice not found'},{status:404});
 const {data,error}=await supabase.schema('finance').from('invoice_milestones').insert({invoice_id:b.invoice_id,organization_id:auth.orgId,milestone_ref:String(b.milestone_ref),description:String(b.description),milestone_date:b.milestone_date,amount:Number(b.amount),percentage:b.percentage==null?null:Number(b.percentage),evidence_ref:b.evidence_ref||null,created_by:auth.userId}).select().single();
 if(error)return NextResponse.json({error:error.message},{status:400}); return NextResponse.json({data},{status:201});
}
