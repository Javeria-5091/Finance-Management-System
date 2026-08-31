import { NextRequest, NextResponse } from 'next/server';
import { getAuthSupabase, requirePermission } from '@/lib/api-auth';
import { z } from 'zod';

const schema = z.object({
  revised_amount: z.number().finite().min(0),
  reason: z.string().trim().min(5).max(1000),
}).strict();


export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requirePermission('BUDGET_READ');
  if (auth instanceof NextResponse) return auth;
  const { supabase } = await getAuthSupabase(req);
  const { data: budget } = await supabase.from('budgets').select('id').eq('id', params.id).eq('organization_id', auth.orgId).maybeSingle();
  if (!budget) return NextResponse.json({ error: 'Budget not found' }, { status: 404 });
  const { data, error } = await supabase.schema('finance').from('budget_revisions').select('*').eq('budget_id', params.id).eq('organization_id', auth.orgId).order('revision_number', { ascending:false });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ data: data || [] });
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requirePermission('BUDGET_UPDATE');
  if (auth instanceof NextResponse) return auth;
  const { supabase } = await getAuthSupabase(req);
  const parsed = schema.safeParse(await req.json());
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message }, { status: 400 });

  const { data: budget } = await supabase.from('budgets').select('id,total_amount,organization_id').eq('id', params.id).eq('organization_id', auth.orgId).maybeSingle();
  if (!budget) return NextResponse.json({ error: 'Budget not found' }, { status: 404 });

  const { data: pending } = await supabase.schema('finance').from('budget_revisions').select('id').eq('budget_id', params.id).eq('organization_id', auth.orgId).eq('status','PENDING').limit(1);
  if (pending?.length) return NextResponse.json({ error: 'A pending revision already exists for this budget' }, { status: 409 });

  const { data: lastRevision } = await supabase.schema('finance').from('budget_revisions').select('revision_number').eq('budget_id', params.id).eq('organization_id', auth.orgId).order('revision_number', { ascending:false }).limit(1).maybeSingle();
  const revisionNumber = (lastRevision?.revision_number || 0) + 1;
  const { data: revision, error } = await supabase.schema('finance').from('budget_revisions').insert({
    budget_id: params.id, organization_id: auth.orgId, revision_number: revisionNumber, previous_amount: budget.total_amount,
    revised_amount: parsed.data.revised_amount, reason: parsed.data.reason, requested_by: auth.userId, status: 'PENDING'
  }).select().single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ success: true, revision }, { status: 201 });
}

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requirePermission('BUDGET_APPROVE');
  if (auth instanceof NextResponse) return auth;
  const { supabase } = await getAuthSupabase(req);
  const body = z.object({ revision_id: z.string().uuid(), action: z.enum(['approve','reject']), reason: z.string().trim().min(5).max(1000).optional() }).strict().safeParse(await req.json());
  if (!body.success) return NextResponse.json({ error: body.error.issues[0]?.message }, { status: 400 });

  const { data: revision } = await supabase.schema('finance').from('budget_revisions').select('*').eq('id', body.data.revision_id).eq('budget_id', params.id).eq('organization_id', auth.orgId).maybeSingle();
  if (!revision || revision.status !== 'PENDING') return NextResponse.json({ error: 'Pending budget revision not found' }, { status: 404 });
  if (revision.requested_by === auth.userId) return NextResponse.json({ error: 'Maker-checker rule: the requester cannot approve their own revision' }, { status: 403 });

  if (body.data.action === 'reject') {
    const { data, error } = await supabase.schema('finance').from('budget_revisions').update({ status:'REJECTED', approved_by:auth.userId, approved_at:new Date().toISOString() }).eq('id',revision.id).select().single();
    if(error) return NextResponse.json({error:error.message},{status:500});
    return NextResponse.json({success:true,revision:data});
  }

  const { data: atomicResult, error: atomicError } = await supabase
    .schema('finance')
    .rpc('approve_budget_revision_atomic', {
      p_budget_id: params.id,
      p_revision_id: revision.id,
    });
  if (atomicError) return NextResponse.json({ error: atomicError.message }, { status: 500 });

  const { data, error } = await supabase
    .from('budget_revisions')
    .select('*')
    .eq('id', revision.id)
    .eq('organization_id', auth.orgId)
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ success: true, revision: data, result: atomicResult });
}
