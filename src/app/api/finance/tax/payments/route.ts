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
  debit_account_id:z.string().uuid().optional().nullable(), credit_account_id:z.string().uuid().optional().nullable(),
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
  const body=parsed.data; const {supabase}=await getAuthSupabase(req);
  if(body.financial_account_id){
    const {data}=await supabase.schema('finance').from('financial_accounts').select('id,linked_ledger_account_id').eq('id',body.financial_account_id).eq('organization_id',auth.orgId).eq('is_active',true).maybeSingle();
    if(!data)return NextResponse.json({error:'Financial account not found or inactive'},{status:404});
  }
  if(body.debit_account_id||body.credit_account_id){
    if(!body.debit_account_id||!body.credit_account_id)return NextResponse.json({error:'Both debit_account_id and credit_account_id are required for ledger posting'},{status:400});
    const {data:accounts}=await supabase.schema('finance').from('chart_of_accounts').select('id').eq('organization_id',auth.orgId).in('id',[body.debit_account_id,body.credit_account_id]);
    if(!accounts||accounts.length!==2)return NextResponse.json({error:'Ledger accounts must belong to your organization'},{status:400});
  }
  let journal_entry_id:string|null=null;
  if(body.debit_account_id&&body.credit_account_id){
    if(!body.period_id)return NextResponse.json({error:'period_id is required when posting to the ledger'},{status:400});
    const lines=[
      {account_id:body.debit_account_id,debit_amount:Number((body.amount+body.penalty_amount+body.surcharge_amount).toFixed(2)),credit_amount:0,description:`Tax ${body.payment_type}`},
      {account_id:body.credit_account_id,debit_amount:0,credit_amount:Number((body.amount+body.penalty_amount+body.surcharge_amount).toFixed(2)),description:`Tax ${body.payment_type}`},
    ];
    const {data:jid,error:jerr}=await supabase.schema('finance').rpc('post_journal_entry',{p_description:`Tax ${body.payment_type}`,p_transaction_date:body.payment_date,p_period_id:body.period_id,p_lines:lines,p_currency:body.currency,p_exchange_rate:1,p_source_type:'TAX_PAYMENT'});
    if(jerr)return NextResponse.json({error:jerr.message},{status:400}); journal_entry_id=jid;
  }
  const {data,error}=await supabase.schema('finance').from('tax_payments_and_refunds').insert({
    ...body, currency:body.currency.toUpperCase(), organization_id:auth.orgId, created_by:auth.userId, journal_entry_id, status:journal_entry_id?'COMPLETED':'PENDING'
  }).select().single();
  if(error)return NextResponse.json({error:error.message},{status:400}); return NextResponse.json({data},{status:201});
}
