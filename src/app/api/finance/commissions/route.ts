import { NextRequest, NextResponse } from 'next/server';
import { getAuthSupabase, requirePermission } from '@/lib/api-auth';
import { z } from 'zod';
import { calculateCommission } from '@/services/commission.service';

const createSchema = z.object({
  contractor_id: z.string().uuid().nullable().optional(), person_name: z.string().trim().min(1).max(200),
  person_type: z.enum(['CONTRACTOR','EMPLOYEE']).default('CONTRACTOR'),
  commission_type: z.enum(['PERCENTAGE','FIXED_AMOUNT','TIERED','FLAT_BONUS','REFERRAL']).default('PERCENTAGE'),
  calculation_basis: z.enum(['PROJECT_REVENUE','INVOICE_AMOUNT','MILESTONE_VALUE','CLIENT_PAYMENT','SALES_TARGET','FIXED_AMOUNT']).default('PROJECT_REVENUE'),
  rate_or_amount: z.coerce.number().nonnegative(), project_id: z.string().uuid().nullable().optional(), client_id: z.string().uuid().nullable().optional(),
  invoice_ref: z.string().trim().max(100).nullable().optional(), milestone_ref: z.string().trim().max(100).nullable().optional(),
  period_start: z.string().date().nullable().optional(), period_end: z.string().date().nullable().optional(),
  base_amount: z.coerce.number().nonnegative(), commission_amount: z.coerce.number().nonnegative().optional(),
  currency: z.string().trim().length(3).default('PKR'), tax_withheld: z.coerce.number().nonnegative().default(0), notes: z.string().max(5000).nullable().optional()
});

export async function GET(req: NextRequest) {
  const auth = await requirePermission('COMMISSION_READ'); if (auth instanceof NextResponse) return auth;
  const { supabase } = await getAuthSupabase(req);
  const url = new URL(req.url);
  const summary = url.searchParams.get('summary');
  if (summary) {
    const view = ({person:'v_commission_by_person',project:'v_commission_by_project',type:'v_commission_by_type',status:'v_commission_status_summary'} as Record<string,string>)[summary];
    if (!view) return NextResponse.json({error:'Invalid summary type'},{status:400});
    const {data,error}=await supabase.from(view).select('*').eq('organization_id',auth.orgId);
    if(error)return NextResponse.json({error:error.message},{status:400});
    return NextResponse.json({data:data??[]});
  }
  if (url.searchParams.get('stats') === '1') {
    const {data,error}=await supabase.from('commissions').select('id,commission_amount,tax_withheld,net_amount,status,currency').eq('organization_id',auth.orgId);
    if(error)return NextResponse.json({error:error.message},{status:400});
    const rows=data??[]; const freq:Record<string,number>={}; rows.forEach((r:any)=>freq[r.currency||'PKR']=(freq[r.currency||'PKR']||0)+1); const topCurrency=Object.entries(freq).sort((a,b)=>b[1]-a[1])[0]?.[0]||'PKR';
    const out:any={totalRecords:rows.length,pendingCount:0,pendingAmount:0,approvedCount:0,approvedAmount:0,paidCount:0,paidAmount:0,totalCommission:0,totalTaxWithheld:0,totalNetPaid:0,topCurrency};
    rows.filter((r:any)=>(r.currency||'PKR')===topCurrency).forEach((r:any)=>{const ca=Number(r.commission_amount)||0;const tw=Number(r.tax_withheld)||0;const na=Number(r.net_amount)||0;out.totalCommission+=ca;out.totalTaxWithheld+=tw;if(r.status==='PENDING'){out.pendingCount++;out.pendingAmount+=ca;}else if(r.status==='APPROVED'){out.approvedCount++;out.approvedAmount+=ca;}else if(r.status==='PAID'){out.paidCount++;out.paidAmount+=ca;out.totalNetPaid+=na;}});
    Object.keys(out).forEach(k=>{if(k.endsWith('Amount')||k.startsWith('total'))out[k]=Math.round(Number(out[k])*100)/100}); return NextResponse.json({data:out});
  }
  let q = supabase.from('commissions').select('*').eq('organization_id', auth.orgId).order('created_at',{ascending:false});
  const search = url.searchParams.get('search'); const status = url.searchParams.get('status');
  const type = url.searchParams.get('commission_type'); const personType = url.searchParams.get('person_type'); const project = url.searchParams.get('project_id');
  if (search?.trim()) { const s = search.trim().replace(/[%,()]/g,''); if (s) q=q.or(`person_name.ilike.%${s}%,invoice_ref.ilike.%${s}%,milestone_ref.ilike.%${s}%,payment_ref.ilike.%${s}%`); }
  if (status) q=q.eq('status',status); if(type)q=q.eq('commission_type',type); if(personType)q=q.eq('person_type',personType); if(project)q=q.eq('project_id',project);
  const {data,error}=await q; if(error)return NextResponse.json({error:error.message},{status:400});
  return NextResponse.json({data:data??[]});
}

export async function POST(req: NextRequest) {
  const auth = await requirePermission('COMMISSION_CREATE'); if (auth instanceof NextResponse) return auth;
  const { supabase } = await getAuthSupabase(req); const parsed=createSchema.safeParse(await req.json());
  if(!parsed.success)return NextResponse.json({error:parsed.error.issues[0]?.message||'Invalid request'},{status:400});
  const b=parsed.data;
  if(b.period_start && b.period_end && b.period_end < b.period_start)return NextResponse.json({error:'period_end must be on or after period_start'},{status:400});
  if(b.contractor_id){const {data:c,error}=await supabase.from('contractors').select('id').eq('id',b.contractor_id).eq('organization_id',auth.orgId).maybeSingle();if(error||!c)return NextResponse.json({error:'Contractor not found in organization'},{status:400});}
  if(b.project_id){const {data:p,error}=await supabase.from('projects').select('id').eq('id',b.project_id).eq('organization_id',auth.orgId).maybeSingle();if(error||!p)return NextResponse.json({error:'Project not found in organization'},{status:400});}
  const amount=b.commission_amount ?? calculateCommission(b.commission_type,b.rate_or_amount,b.base_amount);
  const {data,error}=await supabase.from('commissions').insert({...b,commission_amount:amount,status:'PENDING',created_by:auth.userId,organization_id:auth.orgId}).select('*').single();
  if(error)return NextResponse.json({error:error.message},{status:400}); return NextResponse.json({data},{status:201});
}
