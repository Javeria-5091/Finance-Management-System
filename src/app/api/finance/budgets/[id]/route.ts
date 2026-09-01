import { NextRequest, NextResponse } from 'next/server';
import { getAuthSupabase, requirePermission } from '@/lib/api-auth';
import { z } from 'zod';

const updateSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  category: z.string().trim().min(1).max(100).optional(),
  total_amount: z.number().finite().min(0).optional(),
  start_date: z.string().date().optional(),
  end_date: z.string().date().optional(),
  description: z.string().trim().max(2000).nullable().optional(),
  control_account_id: z.string().uuid().nullable().optional(),
  variance_alert_threshold: z.number().finite().min(0).max(100).optional(),
  project_id: z.string().uuid().nullable().optional(),
  department: z.string().trim().max(100).nullable().optional(),
}).strict();

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requirePermission('BUDGET_UPDATE');
  if (auth instanceof NextResponse) return auth;
  const { supabase } = await getAuthSupabase(req);
  const parsed = updateSchema.safeParse(await req.json());
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message || 'Invalid update' }, { status: 400 });
  const { data: existing } = await supabase.from('budgets').select('*').eq('id', params.id).eq('organization_id', auth.orgId).maybeSingle();
  if (!existing) return NextResponse.json({ error: 'Budget not found' }, { status: 404 });
  if (existing.status === 'APPROVED') return NextResponse.json({ error: 'Approved budgets must be changed through the revision workflow' }, { status: 409 });
  const updates = parsed.data;
  const start = updates.start_date ?? existing.start_date;
  const end = updates.end_date ?? existing.end_date;
  if (end < start) return NextResponse.json({ error: 'End date must be on or after start date' }, { status: 400 });
  const { data, error } = await supabase.from('budgets').update({ ...updates, updated_at: new Date().toISOString() }).eq('id', params.id).eq('organization_id', auth.orgId).select().single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ success: true, budget: data });
}


export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const { action, reason } = await req.json().catch(() => ({}));
  if (!['submit', 'approve', 'reject'].includes(action)) {
    return NextResponse.json({ error: 'Action must be submit, approve, or reject' }, { status: 400 });
  }

  const permission = action === 'approve' ? 'BUDGET_APPROVE' : 'BUDGET_UPDATE';
  const auth = await requirePermission(permission);
  if (auth instanceof NextResponse) return auth;
  const { supabase } = await getAuthSupabase(req);

  const { data: budget } = await supabase
    .from('budgets')
    .select('*')
    .eq('id', params.id)
    .eq('organization_id', auth.orgId)
    .maybeSingle();
  if (!budget) return NextResponse.json({ error: 'Budget not found' }, { status: 404 });

  if (action === 'submit') {
    if (budget.status !== 'DRAFT') return NextResponse.json({ error: 'Only DRAFT budgets can be submitted' }, { status: 409 });
    const { data, error } = await supabase.from('budgets').update({
      status: 'SUBMITTED', submitted_by: auth.userId, submitted_at: new Date().toISOString(), updated_at: new Date().toISOString()
    }).eq('id', params.id).eq('organization_id', auth.orgId).select().single();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ success: true, budget: data });
  }

  if (budget.status !== 'SUBMITTED') {
    return NextResponse.json({ error: 'Only SUBMITTED budgets can be approved or rejected' }, { status: 409 });
  }
  if (budget.submitted_by === auth.userId) {
    return NextResponse.json({ error: 'Maker-checker rule: the requester cannot approve their own budget' }, { status: 403 });
  }

  if (action === 'reject') {
    const cleanReason = typeof reason === 'string' ? reason.trim() : '';
    if (cleanReason.length < 5) return NextResponse.json({ error: 'A rejection reason of at least 5 characters is required' }, { status: 400 });
    const { data, error } = await supabase.from('budgets').update({
      status: 'REJECTED', rejection_reason: cleanReason, approved_by: auth.userId, approved_at: new Date().toISOString(), updated_at: new Date().toISOString()
    }).eq('id', params.id).eq('organization_id', auth.orgId).select().single();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ success: true, budget: data });
  }

  const { data, error } = await supabase.from('budgets').update({
    status: 'APPROVED', approved_by: auth.userId, approved_at: new Date().toISOString(), rejection_reason: null, updated_at: new Date().toISOString()
  }).eq('id', params.id).eq('organization_id', auth.orgId).eq('status', 'SUBMITTED').select().single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // AP-03 FIX: approving a budget previously never created the
  // finance.budget_lines row that reporting.budget_gl_actual (Actual) and
  // finance.budget_commitments (Committed, via the
  // trg_sync_budget_line_committed_amount trigger) both depend on — so
  // every budget's Committed/Actual stayed 0 forever, no matter how much
  // GL activity or purchase-request encumbrance happened against it. This
  // RPC upserts that budget line, keyed to the budget's control account.
  // A budget with no control_account_id configured yet is left as-is
  // (approval still succeeds) and surfaced as a warning instead of a hard
  // failure, since that's an existing-setup gap, not a reason to block
  // approval.
  let budgetLineWarning: string | undefined;
  const { data: budgetLineId, error: lineError } = await supabase
    .schema('finance')
    .rpc('ensure_budget_line', { p_budget_id: params.id });
  if (lineError) {
    console.error('Failed to create/update budget line on approval:', lineError);
    budgetLineWarning = 'Budget approved, but the GL-tracking budget line could not be created. Committed/Actual figures may not update for this budget.';
  } else if (!budgetLineId) {
    budgetLineWarning = 'Budget approved, but it has no control account configured, so Committed/Actual cannot be tracked for it. Set a control account and re-save to enable tracking.';
  }

  return NextResponse.json({ success: true, budget: data, budget_line_warning: budgetLineWarning });
}

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requirePermission('BUDGET_DELETE');
  if (auth instanceof NextResponse) return auth;
  const { supabase } = await getAuthSupabase(req);
  const { data: existing } = await supabase.from('budgets').select('id,status').eq('id', params.id).eq('organization_id', auth.orgId).maybeSingle();
  if (!existing) return NextResponse.json({ error: 'Budget not found' }, { status: 404 });
  if (existing.status === 'APPROVED') return NextResponse.json({ error: 'Approved budgets cannot be deleted' }, { status: 409 });
  const { error } = await supabase.from('budgets').delete().eq('id', params.id).eq('organization_id', auth.orgId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ success: true });
}