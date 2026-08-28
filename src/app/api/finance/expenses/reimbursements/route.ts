import { NextRequest, NextResponse } from 'next/server';
import { getAuthSupabase, requirePermission } from '@/lib/api-auth';

export async function POST(req:NextRequest){
 const auth=await requirePermission('EXPENSE_CREATE'); 
 if(auth instanceof NextResponse)return auth; 
 const {supabase}=await getAuthSupabase(req); 
 const b=await req.json();
 const amount=Number(b.amount); 
 if(!b.title||!(amount>0))
    return NextResponse.json({error:'title and positive amount are required'},{status:400});
 const {data,error}=await supabase.from('expenses').insert({user_id:auth.userId,organization_id:auth.orgId,title:String(b.title),amount,category:String(b.category||'REIMBURSEMENT'),expense_date:b.expense_date||new Date().toISOString().slice(0,10),notes:b.notes||null,project_id:b.project_id||null,vendor_id:b.vendor_id||null,currency:b.currency||'PKR',exchange_rate:Number(b.exchange_rate||1),base_amount:amount*Number(b.exchange_rate||1),status:'DRAFT',has_receipt:Boolean(b.receipt_attachment_id),receipt_attachment_id:b.receipt_attachment_id||null,submitted_by:null}).select().single();
 if(error)return NextResponse.json({error:error.message},{status:400}); 
 return NextResponse.json({data,message:'Reimbursement claim created as DRAFT and must follow normal expense approval/posting.'},{status:201});
}
