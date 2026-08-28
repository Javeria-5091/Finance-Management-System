import { NextRequest, NextResponse } from 'next/server';
import { getAuthSupabase, requirePermission } from '@/lib/api-auth';

export async function POST(req:NextRequest){
 const auth=await requirePermission('INVOICE_UPDATE'); if(auth instanceof NextResponse)return auth; const {supabase}=await getAuthSupabase(req); const b=await req.json();
 const amount=Number(b.amount); if(!b.invoice_id||!b.reason||!(amount>0))return NextResponse.json({error:'invoice_id, positive amount and reason are required'},{status:400});
 const {data:inv,error:ie}=await supabase.from('invoices').select('id,total_amount,amount_paid,outstanding_amount,currency,organization_id').eq('id',b.invoice_id).eq('organization_id',auth.orgId).single(); if(ie||!inv)return NextResponse.json({error:'Invoice not found'},{status:404});
 if(amount>Number(inv.amount_paid||0))return NextResponse.json({error:'Refund cannot exceed amount already paid'},{status:422});
 const ref=`REF-${Date.now()}`;
 const {data,error}=await supabase.schema('finance').from('invoice_refunds').insert({invoice_id:inv.id,organization_id:auth.orgId,refund_number:ref,amount,currency:inv.currency||'PKR',exchange_rate:Number(b.exchange_rate||1),reason:String(b.reason),status:'DRAFT',financial_account_id:b.financial_account_id||null,created_by:auth.userId}).select().single();
 if(error)return NextResponse.json({error:error.message},{status:400}); return NextResponse.json({data},{status:201});
}
export async function GET(req:NextRequest){const auth=await requirePermission('INVOICE_READ');if(auth instanceof NextResponse)return auth;const {supabase}=await getAuthSupabase(req);const invoiceId=new URL(req.url).searchParams.get('invoice_id');let q=supabase.schema('finance').from('invoice_refunds').select('*').eq('organization_id',auth.orgId);if(invoiceId)q=q.eq('invoice_id',invoiceId);const {data,error}=await q.order('created_at',{ascending:false});if(error)return NextResponse.json({error:error.message},{status:400});return NextResponse.json({data});}
