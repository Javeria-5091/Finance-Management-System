import {NextRequest,NextResponse} from 'next/server';
import {getAuthSupabase,requirePermission} from '@/lib/api-auth';
import {enforceMFA} from '@/lib/mfa-middleware';
import {z} from 'zod';

const s=z.object({action:z.enum(['create','approve','post']),id:z.string().uuid().optional(),owner_id:z.string().uuid().optional(),transaction_type:z.enum(['CAPITAL_CONTRIBUTION','OWNER_LOAN_ADVANCE','OWNER_LOAN_REPAYMENT','DRAWING']).optional(),amount:z.number().positive().optional(),currency:z.string().regex(/^[A-Z]{3}$/).default('PKR'),transaction_date:z.string().date().optional(),description:z.string().max(500).optional(),financial_account_id:z.string().uuid().optional(),debit_account_id:z.string().uuid().optional(),credit_account_id:z.string().uuid().optional(),period_id:z.string().uuid().optional()});
export async function POST(req:NextRequest)
{
    const a=await requirePermission('EQUITY_MANAGE');
    if(a instanceof NextResponse)
        return a;
    const {supabase}=await getAuthSupabase(req);
    const p=s.safeParse(await req.json());
    if(!p.success)
        return NextResponse.json({error:p.error.issues[0]?.message},{status:400});
    const b=p.data;
    try{
        if(b.action==='post'){const m=await enforceMFA(a);
            if(m)
                return m;
            if(!b.id||!b.period_id)
                throw new Error('id and period_id required');
            const {data,error}=await supabase.schema('finance').rpc('post_capital_transaction',{p_id:b.id,p_org:a.orgId,p_actor:a.userId,p_period:b.period_id});
            if(error)
                throw error;
            return NextResponse.json({journal_id:data});}
if(b.action==='create'){
    if(!b.owner_id||!b.transaction_type||!b.amount||!b.transaction_date||!b.debit_account_id||!b.credit_account_id)
        throw new Error('owner, type, amount, date and debit/credit accounts are required');
    const {data,error}=await supabase.schema('finance').from('capital_transactions').insert({owner_id:b.owner_id,transaction_type:b.transaction_type,amount:b.amount,base_amount:b.amount,currency:b.currency,transaction_date:b.transaction_date,description:b.description,financial_account_id:b.financial_account_id,debit_account_id:b.debit_account_id,credit_account_id:b.credit_account_id,status:'DRAFT',created_by:a.userId,organization_id:a.orgId}).select().single();
    if(error)throw error;return NextResponse.json({data});}
if(!b.id)
    throw new Error('id required');
const {data:row,error:re}=await supabase.schema('finance').from('capital_transactions').select('*').eq('id',b.id).eq('organization_id',a.orgId).single();
if(re||!row)
    throw new Error('Capital transaction not found');
if(b.action==='approve'){
    if(row.status!=='DRAFT')
        throw new Error('Only DRAFT transactions can be approved');
    if(row.created_by===a.userId)
        throw new Error('Maker-checker: creator cannot approve own transaction');
    const {data,error}=await supabase.schema('finance').from('capital_transactions').update({status:'APPROVED',approved_by:a.userId,approved_at:new Date().toISOString()}).eq('id',b.id).eq('organization_id',a.orgId).select().single();
    if(error)throw error;return NextResponse.json({data});}}
catch(e:any){
    return NextResponse.json({error:e.message||'Capital transaction failed'},{status:400})}}
