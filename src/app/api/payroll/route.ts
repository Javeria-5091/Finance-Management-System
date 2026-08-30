import { NextRequest, NextResponse } from 'next/server';
import { getAuthSupabase, requirePermission } from '@/lib/api-auth';
import { enforceMFA } from '@/lib/mfa-middleware';
import { z } from 'zod';
const schema=z.object({action:z.enum(['submit','approve','post','mark_paid']),run_id:z.string().uuid(),attendance_snapshot_id:z.string().uuid().optional(),payment_account_id:z.string().uuid().optional(),period_id:z.string().uuid().optional(),salary_expense_account_id:z.string().uuid().optional(),payroll_payable_account_id:z.string().uuid().optional(),payment_reference:z.string().trim().max(100).optional()});
export async function POST(req:NextRequest){
    const preview=await req.clone().json().catch(()=>({}));
    const requiredPermission = preview.action==='approve' ? 'PAYROLL_APPROVE' : preview.action==='post' ? 'PAYROLL_POST' : 'PAYROLL_UPDATE';
    const auth=await requirePermission(requiredPermission);
    if(auth instanceof NextResponse) return auth;
    const {supabase}=await getAuthSupabase(req);
    const body=schema.safeParse(await req.json());
    if(!body.success)
        return NextResponse.json({error:body.error.issues[0]?.message},{status:400});const b=body.data;if(b.action==='post'||b.action==='mark_paid'){const m=await enforceMFA(auth);
    if(m)return m;
}
const {data:r,error}=await supabase.from('payroll_runs').select('*').eq('id',b.run_id).eq('organization_id',auth.orgId).single();if(error||!r)
    return NextResponse.json({error:'Payroll run not found'},{status:404});
try
{
    if(b.action==='submit'){
        if(r.status!=='CALCULATED')
            throw new Error('Only CALCULATED runs can be submitted');
        const {data,error}=await supabase.from('payroll_runs').update({status:'UNDER_REVIEW'}).eq('id',r.id).eq('organization_id',auth.orgId).select().single();if(error)throw error;
        return NextResponse.json({data});}
if(b.action==='approve'){if(r.status!=='UNDER_REVIEW')
    throw new Error('Only UNDER_REVIEW runs can be approved');
if(r.created_by===auth.userId)throw new Error('Maker-checker: requester cannot approve own payroll run');
const {data,error}=await supabase.from('payroll_runs').update({status:'APPROVED',approved_by:auth.userId,approved_at:new Date().toISOString()}).eq('id',r.id).eq('organization_id',auth.orgId).select().single();
if(error)
    throw error;return NextResponse.json({data});}
if(b.action==='post'){
    if(r.status!=='APPROVED')
        throw new Error('Only APPROVED payroll runs can be posted');
    if(!b.period_id||!b.salary_expense_account_id||!b.payroll_payable_account_id)
        throw new Error('period_id and payroll accounts are required');
    // Idempotency guard: a retry must reuse the existing payroll journal,
    // never create a second GL posting for the same payroll run.
    const { data: existingJournal, error: existingJournalError } = await supabase
        .schema('finance')
        .from('journal_entries')
        .select('id, reference')
        .eq('source_type', 'PAYROLL_RUN')
        .eq('source_id', r.id)
        .eq('organization_id', auth.orgId)
        .limit(1)
        .maybeSingle();
    if (existingJournalError) throw existingJournalError;

    let jid: string;
    if (existingJournal?.id) {
        jid = existingJournal.id;
    } else {
        const {data:createdJournalId,error:jerr}=await supabase.schema('finance').rpc('post_journal_entry',{
            p_description:`Payroll ${r.payroll_period}`,
            p_transaction_date:r.period_end,
            p_period_id:b.period_id,
            p_lines:[
                {account_id:b.salary_expense_account_id,debit_amount:r.total_gross_pay,credit_amount:0,description:'Payroll gross expense'},
                {account_id:b.payroll_payable_account_id,debit_amount:0,credit_amount:r.total_gross_pay,description:'Payroll payable'}
            ],
            p_currency:'PKR',p_exchange_rate:1,
            p_source_type:'PAYROLL_RUN',p_source_id:r.id
        });
        if(jerr || !createdJournalId) throw jerr || new Error('Payroll journal was not created');
        jid = createdJournalId;
    }

    const {data,error}=await supabase.from('payroll_runs').update({
        status:'POSTED',
        posted_by:auth.userId,
        posted_at:new Date().toISOString()
    }).eq('id',r.id).eq('organization_id',auth.orgId).select().single();
    if(error)
        throw error;
    return NextResponse.json({data,journal_id:jid});
}
if(b.action==='mark_paid'){
    if(r.status!=='POSTED')
        throw new Error('Only POSTED payroll runs can be paid');
    const {data,error}=await supabase.from('payroll_runs').update({paid_by:auth.userId,paid_at:new Date().toISOString(),notes:`Paid${b.payment_reference?` - ${b.payment_reference}`:''}`}).eq('id',r.id).eq('organization_id',auth.orgId).select().single();
    if(error)throw error;return NextResponse.json({data});}
}catch(e:any){
    return NextResponse.json({error:e.message||'Payroll operation failed'},{status:400})}}