import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getAuthSupabase, requirePermission } from '@/lib/api-auth';
import { enforceMFA } from '@/lib/mfa-middleware';

const schema = z.object({
  tax_computation_id:z.string().uuid().optional().nullable(), tax_return_id:z.string().uuid().optional().nullable(),
  fiscal_year_id:z.string().uuid().optional().nullable(), period_id:z.string().uuid().optional().nullable(),
  payment_type:z.enum(['PAYMENT','REFUND','ADVANCE_PAYMENT','ADJUSTMENT']), tax_authority:z.string().trim().max(100).default('FBR'),
  cpr_number:z.string().trim().max(100).optional().nullable(), prs_number:z.string().trim().max(100).optional().nullable(),
  amount:z.coerce.number().positive(), currency:z.string().regex(/^[A-Z]{3}$/).default('PKR'),
  penalty_amount:z.coerce.number().min(0).default(0), surcharge_amount:z.coerce.number().min(0).default(0),
  payment_reference:z.string().trim().max(200).optional().nullable(),
  payment_method:z.enum(['bank_transfer','cheque','online','adjustment']).default('bank_transfer'), payment_date:z.string().date(),
  financial_account_id:z.string().uuid().optional().nullable(),
  debit_account_id:z.string().uuid(), credit_account_id:z.string().uuid(),
  notes:z.string().trim().max(2000).optional().nullable(),
}).strict();

export async function GET(req:NextRequest){
  const auth=await requirePermission('TAX_READ'); if(auth instanceof NextResponse)return auth;
  const {supabase}=await getAuthSupabase(req);
  const {data,error}=await supabase.schema('finance').from('tax_payments_and_refunds').select('*').eq('organization_id',auth.orgId).order('payment_date',{ascending:false});
  if(error)return NextResponse.json({error:error.message},{status:500}); return NextResponse.json({data:data||[]});
}

export async function POST(req:NextRequest){
  const auth=await requirePermission('TAX_APPROVE'); if(auth instanceof NextResponse)return auth;
  const mfa=await enforceMFA(auth); if(mfa)return mfa;
  const parsed=schema.safeParse(await req.json()); if(!parsed.success)return NextResponse.json({error:parsed.error.issues[0]?.message},{status:400});
  const idempotencyKey = req.headers.get('Idempotency-Key')?.trim();
  if(!idempotencyKey) return NextResponse.json({error:'Idempotency-Key header is required for tax payment commands'},{status:400});
  if(idempotencyKey.length > 200) return NextResponse.json({error:'Idempotency-Key is too long'},{status:400});

  const body=parsed.data; const {supabase}=await getAuthSupabase(req);
  const { data, error } = await supabase.schema('finance').rpc('post_tax_payment_atomic', {
    p_tax_computation_id: body.tax_computation_id,
    p_tax_return_id: body.tax_return_id,
    p_fiscal_year_id: body.fiscal_year_id,
    p_period_id: body.period_id,
    p_payment_type: body.payment_type,
    p_tax_authority: body.tax_authority,
    p_cpr_number: body.cpr_number,
    p_prs_number: body.prs_number,
    p_amount: body.amount,
    p_currency: body.currency.toUpperCase(),
    p_penalty_amount: body.penalty_amount,
    p_surcharge_amount: body.surcharge_amount,
    p_payment_reference: body.payment_reference,
    p_payment_method: body.payment_method,
    p_payment_date: body.payment_date,
    p_financial_account_id: body.financial_account_id,
    p_debit_account_id: body.debit_account_id,
    p_credit_account_id: body.credit_account_id,
    p_notes: body.notes,
    p_idempotency_key: idempotencyKey,
  });
  if(error)return NextResponse.json({error:error.message},{status:400});
  return NextResponse.json({data},{status:data?.idempotent_replay ? 200 : 201});
}
