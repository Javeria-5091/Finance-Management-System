import { NextRequest, NextResponse } from 'next/server';
import { getAuthSupabase, requirePermission } from '@/lib/api-auth';
import { z } from 'zod';

const createSchema=z.object({period_start:z.string().date(),period_end:z.string().date(),payroll_period:z.string().trim().min(4).max(20)});
const actionSchema=z.object({runId:z.string().uuid(),action:z.enum(['approve','post','cancel'])});

export async function POST(req:NextRequest){
  const auth=await requirePermission('PAYROLL_CREATE'); if(auth instanceof NextResponse)return auth;
  const {supabase}=await getAuthSupabase(req); const b=createSchema.safeParse(await req.json());
  if(!b.success)return NextResponse.json({error:b.error.issues[0]?.message},{status:400});
  if(b.data.period_end<b.data.period_start)return NextResponse.json({error:'period_end must be on or after period_start'},{status:400});
  const {data:existing}=await supabase.from('payroll_runs').select('id').eq('organization_id',auth.orgId).eq('payroll_period',b.data.payroll_period).maybeSingle();
  if(existing)return NextResponse.json({error:'A payroll run already exists for this period'},{status:409});
  const {data,error}=await supabase.from('payroll_runs').insert({...b.data,status:'DRAFT',created_by:auth.userId,organization_id:auth.orgId}).select('*').single();
  if(error)return NextResponse.json({error:error.message},{status:400});
  return NextResponse.json({data,message:'Payroll run created'},{status:201});
}

export async function GET(req:NextRequest){
  const auth=await requirePermission('PAYROLL_READ'); if(auth instanceof NextResponse)return auth;
  const {supabase}=await getAuthSupabase(req); const {data,error}=await supabase.from('payroll_runs').select('*').eq('organization_id',auth.orgId).order('period_end',{ascending:false});
  if(error)return NextResponse.json({error:error.message},{status:400}); return NextResponse.json({data:data??[]});
}

export async function PUT(req:NextRequest){
  const body=await req.json().catch(()=>({})); const parsed=actionSchema.safeParse(body); if(!parsed.success)return NextResponse.json({error:'Invalid payroll action'},{status:400});
  const perm=parsed.data.action==='approve'?'PAYROLL_APPROVE':parsed.data.action==='post'?'PAYROLL_POST':'PAYROLL_UPDATE';
  const auth=await requirePermission(perm); if(auth instanceof NextResponse)return auth;
  const {supabase}=await getAuthSupabase(req); const {data:run,error}=await supabase.from('payroll_runs').select('*').eq('id',parsed.data.runId).eq('organization_id',auth.orgId).single();
  if(error||!run)return NextResponse.json({error:'Payroll run not found'},{status:404});
  if(parsed.data.action==='approve'){
    // BUG-011 FIX: align with src/app/api/finance/payroll/route.ts, the
    // canonical posting-capable payroll endpoint — a run must go through
    // CALCULATED -> UNDER_REVIEW (submit) before it can be approved here.
    // The old check also accepted 'CALCULATED' directly, which let a run
    // skip the review step depending on which of the two endpoints was
    // called.
    if(run.status!=='UNDER_REVIEW')return NextResponse.json({error:'Only UNDER_REVIEW payroll runs can be approved. Submit the calculated run for review first.'},{status:400});
    if(run.created_by===auth.userId)return NextResponse.json({error:'Maker-checker: requester cannot approve own payroll run'},{status:400});
    const {data,error:e}=await supabase.from('payroll_runs').update({status:'APPROVED',approved_by:auth.userId,approved_at:new Date().toISOString()}).eq('id',run.id).eq('organization_id',auth.orgId).select().single();
    if(e)return NextResponse.json({error:e.message},{status:400}); return NextResponse.json({data:e?null:data,message:'Payroll approved'});
  }
  if(parsed.data.action==='cancel'){
    if(!['DRAFT','CALCULATED','UNDER_REVIEW'].includes(run.status))return NextResponse.json({error:'Only unposted payroll runs can be cancelled'},{status:400});
    const {data,error:e}=await supabase.from('payroll_runs').update({status:'CANCELLED'}).eq('id',run.id).eq('organization_id',auth.orgId).select().single(); if(e)return NextResponse.json({error:e.message},{status:400}); return NextResponse.json({data});
  }
  return NextResponse.json({error:'Use /api/finance/payroll for posting because posting requires accounting period and account configuration.'},{status:400});
}