import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getAuthSupabase, requirePermission } from '@/lib/api-auth';

const createSchema = z.object({
  tax_computation_id: z.string().uuid().optional().nullable(),
  fiscal_year_id: z.string().uuid().optional().nullable(),
  period_id: z.string().uuid().optional().nullable(),
  credit_type: z.enum(['WHT_DEDUCTED','WHT_COLLECTED','TAX_CREDIT','CARRY_FORWARD','ADJUSTMENT','PREVIOUS_YEAR_CREDIT']),
  counterparty_name: z.string().trim().max(300).optional().nullable(),
  counterparty_cnic: z.string().trim().max(50).optional().nullable(),
  counterparty_ntn: z.string().trim().max(50).optional().nullable(),
  source_type: z.string().trim().max(80).optional().nullable(),
  source_id: z.string().uuid().optional().nullable(),
  gross_amount: z.coerce.number().min(0).default(0),
  wht_rate: z.coerce.number().min(0).max(100).default(0),
  credit_amount: z.coerce.number().positive(),
  currency: z.string().regex(/^[A-Z]{3}$/).default('PKR'),
  tax_return_id: z.string().uuid().optional().nullable(),
  notes: z.string().trim().max(2000).optional().nullable(),
}).strict();

export async function GET(req: NextRequest) {
  const auth = await requirePermission('TAX_READ'); if (auth instanceof NextResponse) return auth;
  const { supabase } = await getAuthSupabase(req);
  const { data, error } = await supabase.schema('finance').from('tax_credits_and_withholding').select('*')
    .eq('organization_id', auth.orgId).order('created_at', { ascending:false });
  if (error) return NextResponse.json({ error:error.message }, { status:500 });
  return NextResponse.json({ data:data||[] });
}

export async function POST(req: NextRequest) {
  const auth = await requirePermission('TAX_MANAGE'); if (auth instanceof NextResponse) return auth;
  const parsed = createSchema.safeParse(await req.json()); if (!parsed.success) return NextResponse.json({error:parsed.error.issues[0]?.message},{status:400});
  const { supabase } = await getAuthSupabase(req);
  const { data, error } = await supabase.schema('finance').from('tax_credits_and_withholding').insert({
    ...parsed.data, currency:parsed.data.currency.toUpperCase(), organization_id:auth.orgId, created_by:auth.userId, status:'PENDING'
  }).select().single();
  if (error) return NextResponse.json({error:error.message},{status:400});
  return NextResponse.json({data},{status:201});
}

export async function PATCH(req: NextRequest) {
  const auth = await requirePermission('TAX_APPROVE'); if (auth instanceof NextResponse) return auth;
  const body = z.object({id:z.string().uuid(), status:z.enum(['CLAIMED','REJECTED','ADJUSTED']), notes:z.string().trim().max(2000).optional()}).strict().safeParse(await req.json());
  if(!body.success)return NextResponse.json({error:body.error.issues[0]?.message},{status:400});
  const {supabase}=await getAuthSupabase(req);
  const {data,error}=await supabase.schema('finance').from('tax_credits_and_withholding').update({status:body.data.status,notes:body.data.notes||null,updated_at:new Date().toISOString()}).eq('id',body.data.id).eq('organization_id',auth.orgId).eq('status','PENDING').select().single();
  if(error)return NextResponse.json({error:error.message},{status:400}); return NextResponse.json({data});
}
