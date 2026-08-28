import { NextRequest, NextResponse } from 'next/server';
import { getAuthSupabase, requirePermission } from '@/lib/api-auth';
export async function POST(req:NextRequest)
{
 const auth=await requirePermission('TAX_REPORT_EDIT');
 if(auth instanceof NextResponse)
    return auth;
const {supabase}=await getAuthSupabase(req);
try{const b=await req.json();
 if(!b.tax_reconciliation_id||!b.credit_type||!b.credit_amount)
    return NextResponse.json({error:'tax_reconciliation_id, credit_type and credit_amount are required'},{status:400});
 const {data,error}=await supabase.schema('finance').from('tax_credits_and_withholding').insert({...b,organization_id:auth.orgId,created_by:auth.userId,status:'PENDING'}).select().single();
 if(error)return NextResponse.json({error:error.message},{status:400});
 return NextResponse.json({data},{status:201});
 }
 catch(e:any)
 {
    return NextResponse.json({error:e?.message||'Failed'},{status:500});
 }
}
