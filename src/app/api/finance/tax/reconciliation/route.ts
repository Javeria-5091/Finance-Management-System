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
    // BUG-014 FIX: finance.tax_reconciliations has no period_start/period_end columns
    // (verified columns: tax_year, fiscal_year_id, tax_rule_set_id, accounting_profit_
    // before_tax, taxable_income, ...) — requiring/inserting them caused PGRST204 on
    // every POST. The real required columns are tax_year, fiscal_year_id, and
    // tax_rule_set_id; everything else (PBT, taxable income, gross tax, etc.) is
    // computed later by the 'calculate' action, and is intentionally NOT accepted
    // from the client here so a caller can't inject their own tax figures.
    if(!b.tax_year||!b.fiscal_year_id||!b.tax_rule_set_id) return NextResponse.json({error:'tax_year, fiscal_year_id and tax_rule_set_id are required'},{status:400});
    const {data,error}=await supabase.schema('finance').from('tax_reconciliations').insert({
      tax_year: b.tax_year,
      fiscal_year_id: b.fiscal_year_id,
      tax_rule_set_id: b.tax_rule_set_id,
      notes: b.notes ?? null,
      organization_id: auth.orgId,
      created_by: auth.userId,
      status: 'DRAFT',
    }).select().single();
    if(error)return NextResponse.json({error:error.message},{status:400}); return NextResponse.json({data},{status:201});
  }catch(e:any){return NextResponse.json({error:e?.message||'Failed'},{status:500});}
}

export async function PATCH(req: NextRequest) {
  const auth = await requirePermission('TAX_REPORT_EDIT'); if (auth instanceof NextResponse) return auth;
  const mfa=await enforceMFA(auth); if(mfa)return mfa;
  const {supabase}=await getAuthSupabase(req); const b=await req.json();
  if(!b.id||!b.action)return NextResponse.json({error:'id and action are required'},{status:400});
  const rpc=b.action==='calculate'?'compute_tax_liability':b.action==='approve'?'approve_tax_reconciliation':null;
  if(!rpc)return NextResponse.json({error:'Unsupported action'},{status:400});
  // BUG-014 FIX: this ownership check previously only ran for 'calculate', not
  // 'approve' — an approve call went straight to the RPC with no org-ownership
  // check in this route at all. Both actions now verify the reconciliation
  // belongs to the caller's organization before invoking anything. (The RPC
  // itself also re-checks organization_id server-side, per spec 7.5 defense in
  // depth — this route-level check is not the only guard.)
  const {data:row,error:re}=await supabase.schema('finance').from('tax_reconciliations').select('id').eq('id',b.id).eq('organization_id',auth.orgId).single();
  if(re||!row)return NextResponse.json({error:'Tax reconciliation not found'},{status:404});
  if(b.action==='calculate'){
    const {error}=await supabase.schema('finance').rpc(rpc,{p_tax_recon_id:b.id}); if(error)return NextResponse.json({error:error.message},{status:400});
    return NextResponse.json({ok:true});
  }
  if(b.action==='approve'){
  
    const {data,error}=await supabase.schema('finance').rpc(rpc,{p_recon_id:b.id,p_user_id:auth.userId,p_organization_id:auth.orgId}); if(error)return NextResponse.json({error:error.message},{status:400}); return NextResponse.json({data});
  }
  return NextResponse.json({error:'Unsupported action'},{status:400});
}