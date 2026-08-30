import { NextRequest, NextResponse } from 'next/server';
import { getAuthSupabase, requirePermission } from '@/lib/api-auth';

export async function PATCH(req:NextRequest,{params}:{params:Promise<{id:string}>})
{
    const auth=await requirePermission('INVOICE_UPDATE'); 
    if(auth instanceof NextResponse)
        return auth;
    const {supabase}=await getAuthSupabase(req); 
    const {id}=await params; 
    const b=await req.json();
    const {data:r,error:re}=await supabase.schema('finance').from('invoice_refunds').select('*').eq('id',id).eq('organization_id',auth.orgId).single();
    if(re||!r)
        return NextResponse.json({error:'Refund not found'},{status:404});
    const action=String(b.action||'').toUpperCase();
    if(action==='SUBMIT' && r.status==='DRAFT')
        {
            const {data,error}=await supabase.schema('finance').from('invoice_refunds').update({status:'PENDING_APPROVAL'}).eq('id',id).eq('organization_id',auth.orgId).select().single(); if(error)return NextResponse.json({error:error.message},{status:400}); return NextResponse.json({data});
        }
    if(action==='APPROVE' && r.status==='PENDING_APPROVAL')
        {
            if(r.created_by===auth.userId)
                return NextResponse.json({error:'Maker-checker: creator cannot approve own refund'},{status:403});
            const {data,error}=await supabase.schema('finance').from('invoice_refunds').update({status:'APPROVED',approved_by:auth.userId,approved_at:new Date().toISOString()}).eq('id',id).eq('organization_id',auth.orgId).select().single(); if(error)return NextResponse.json({error:error.message},{status:400}); return NextResponse.json({data});
        }
    if(action==='POST' && r.status==='APPROVED')
        {
            const {data:period}=await supabase.schema('finance').from('accounting_periods').select('id').eq('organization_id',auth.orgId).eq('status','OPEN').order('start_date',{ascending:false}).limit(1).maybeSingle();
    if(!period)
        return NextResponse.json({error:'No open accounting period'}, {status:400});
    if(!r.financial_account_id)
        return NextResponse.json({error:'financial_account_id is required before posting'}, {status:400});
    const {data:fa}=await supabase.schema('finance').from('financial_accounts').select('linked_ledger_account_id').eq('id',r.financial_account_id).eq('organization_id',auth.orgId).single();
    if(!fa?.linked_ledger_account_id)
        return NextResponse.json({error:'Financial account has no linked ledger account'}, {status:400});
    const {data:rev}=await supabase.schema('finance').from('chart_of_accounts').select('id').eq('organization_id',auth.orgId).eq('code','4110').eq('is_active',true).single();
    if(!rev)
        return NextResponse.json({error:'Revenue account 4110 not configured'}, {status:400});
    const base=Number(r.amount)*Number(r.exchange_rate||1);
    const lines=[{account_id:rev.id,debit_amount:base,credit_amount:0,description:`Refund ${r.refund_number}`},{account_id:fa.linked_ledger_account_id,debit_amount:0,credit_amount:base,description:`Cash refund ${r.refund_number}`}];
    const {data:journal,error:je}=await supabase.schema('finance').rpc('post_journal_entry',{p_description:`Invoice refund ${r.refund_number}`,p_transaction_date:new Date().toISOString().slice(0,10),p_period_id:period.id,p_lines:lines,p_currency:'PKR',p_exchange_rate:1,p_source_type:'INVOICE_REFUND',p_source_id:id});
    if(je)
        return NextResponse.json({error:je.message},{status:400});
    const {data,error}=await supabase.schema('finance').from('invoice_refunds').update({status:'POSTED',journal_entry_id:journal,posted_at:new Date().toISOString()}).eq('id',id).eq('organization_id',auth.orgId).select().single();
    if(error)
        return NextResponse.json({error:error.message},{status:400});

  // BUG-020 FIX: "Even the dead refund code never relieves the invoice
  // (no amount_paid/status update)". A refund reduces both what the
  // client is deemed to owe (total_amount) and what they've paid
  // (amount_paid) by the same amount, so outstanding_amount is
  // unaffected by the refund itself (the earlier `amount > amount_paid`
  // guard above already ensures we never refund more than was actually
  // collected). If the invoice is fully unwound this way it moves to the
  // terminal REFUNDED status (spec 5.6's "refund states").
    const {data:invRow}=await supabase.from('invoices').select('total_amount,amount_paid,outstanding_amount,status').eq('id',r.invoice_id).eq('organization_id',auth.orgId).maybeSingle();
    if(invRow){
    const newTotal=Math.max(0,Number(invRow.total_amount||0)-Number(r.amount));
    const newPaid=Math.max(0,Number(invRow.amount_paid||0)-Number(r.amount));
    const newOutstanding=Math.max(0,newTotal-newPaid);
    let newStatus=invRow.status;
    if(newTotal<=0.01)newStatus='REFUNDED';
    else if(newOutstanding<=0.01)newStatus='PAID';
    else if(newPaid>0)newStatus='PARTIALLY_PAID';
    const {error:invUpdErr}=await supabase.from('invoices').update({total_amount:newTotal,amount_paid:newPaid,outstanding_amount:newOutstanding,status:newStatus}).eq('id',r.invoice_id).eq('organization_id',auth.orgId);
    if(invUpdErr)console.error('Failed to relieve invoice after refund posting:',invUpdErr,{invoice_id:r.invoice_id,refund_id:id});
    } else {
    console.error('Refund posted but invoice row was not found to relieve:',{invoice_id:r.invoice_id,refund_id:id});
    }

    return NextResponse.json({data});
 }
    if(action==='PAY' && r.status==='POSTED'){const {data,error}=await supabase.schema('finance').from('invoice_refunds').update({status:'PAID',paid_at:new Date().toISOString()}).eq('id',id).eq('organization_id',auth.orgId).select().single();if(error)return NextResponse.json({error:error.message},{status:400});return NextResponse.json({data});}
        return NextResponse.json({error:`Invalid transition ${r.status} -> ${action}`},{status:409});
}