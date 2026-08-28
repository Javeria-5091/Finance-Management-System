import { NextRequest, NextResponse } from 'next/server';
import { getAuthSupabase, requirePermission } from '@/lib/api-auth';
import { enforceMFA } from '@/lib/mfa-middleware';

export async function GET(req: NextRequest) {
  const auth = await requirePermission('TAX_REPORT_VIEW'); if (auth instanceof NextResponse) return auth;
  const { supabase } = await getAuthSupabase(req);
  const { searchParams } = new URL(req.url);
  let q = supabase.schema('finance').from('tax_reconciliations').select('*').eq('organization_id',auth.orgId).order('tax_year',{ascending:false});
  const taxYear=searchParams.get('tax_year'); if(taxYear) q=q.eq('tax_year',taxYear);
  const {data,error}=await q; if(error)return NextResponse.json({error:error.message},{status:500}); return NextResponse.json({data});
}

export async function POST(req: NextRequest) {
  const auth = await requirePermission('TAX_REPORT_CREATE'); if (auth instanceof NextResponse) return auth;
  const { supabase } = await getAuthSupabase(req);
  try {
    const b=await req.json();
    if(!b.tax_year||!b.fiscal_year_id||!b.tax_rule_set_id||!b.period_start||!b.period_end) return NextResponse.json({error:'tax_year, fiscal_year_id, tax_rule_set_id, period_start and period_end are required'},{status:400});
    const {data,error}=await supabase.schema('finance').from('tax_reconciliations').insert({...b,organization_id:auth.orgId,created_by:auth.userId,status:'DRAFT'}).select().single();
    if(error)return NextResponse.json({error:error.message},{status:400}); return NextResponse.json({data},{status:201});
  }catch(e:any){return NextResponse.json({error:e?.message||'Failed'},{status:500});}
}

export async function PATCH(req: NextRequest) {
  const auth = await requirePermission('TAX_REPORT_EDIT'); if (auth instanceof NextResponse) return auth;
  const mfa=await enforceMFA(auth); if(mfa)return mfa;
  const {supabase}=await getAuthSupabase(req); const b=await req.json();
  if(!b.id||!b.action)return NextResponse.json({error:'id and action are required'},{status:400});
  const rpc=b.action==='calculate'?'compute_tax_liability':b.action==='approve'?'approve_tax_reconciliation':null;
  if(b.action==='calculate'){
    const {data:row,error:re}=await supabase.schema('finance').from('tax_reconciliations').select('id').eq('id',b.id).eq('organization_id',auth.orgId).single();
    if(re||!row)return NextResponse.json({error:'Tax reconciliation not found'},{status:404});
    const {error}=await supabase.schema('finance').rpc(rpc!,{p_tax_recon_id:b.id}); if(error)return NextResponse.json({error:error.message},{status:400});
    return NextResponse.json({ok:true});
  }
  if(b.action==='approve'){
    const {data,error}=await supabase.schema('finance').rpc(rpc!,{p_recon_id:b.id,p_user_id:auth.userId,p_organization_id:auth.orgId}); if(error)return NextResponse.json({error:error.message},{status:400}); return NextResponse.json({data});
  }
  return NextResponse.json({error:'Unsupported action'},{status:400});
}
