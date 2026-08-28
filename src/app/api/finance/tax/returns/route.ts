import { NextRequest, NextResponse } from 'next/server';
import { getAuthSupabase, requirePermission } from '@/lib/api-auth';
import { enforceMFA } from '@/lib/mfa-middleware';
export async function PATCH(req:NextRequest)
{
 const auth=await requirePermission('TAX_REPORT_EDIT'); 
 if(auth instanceof NextResponse)return auth; 
 const m=await enforceMFA(auth);
 if(m)
    return m;
 const {supabase}=await getAuthSupabase(req); 
 const b=await req.json(); if(!b.id||!b.action)
    return NextResponse.json({error:'id and action are required'},{status:400});
 const map:any={file: 'mark_tax_filed',pay:'record_tax_payment'}; 
 const fn=map[b.action]; 
 if(!fn)
    return NextResponse.json({error:'Unsupported action'},{status:400});
 const args:any={p_recon_id:b.id,p_user_id:auth.userId,p_organization_id:auth.orgId}; 
 if(b.action==='file'){args.p_reference=b.filing_reference;args.p_filing_date=b.filing_date;
    args.p_filed_values=b.filed_values||{};
}
else
    {
        args.p_reference=b.payment_reference;args.p_payment_date=b.payment_date;
    }
 const {data,error}=await supabase.schema('finance').rpc(fn,args); 
 if(error)return NextResponse.json({error:error.message},{status:400}); 
 return NextResponse.json({data});
}
