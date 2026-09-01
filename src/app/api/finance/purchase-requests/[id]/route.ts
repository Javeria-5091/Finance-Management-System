import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getAuthSupabase, requirePermission } from '@/lib/api-auth';
import { enforceMakerChecker } from '@/lib/api-auth';
import { resolveApplicableBudgetId } from '@/services/budget-check.service';

const actionSchema = z.object({ action: z.enum(['submit','approve','reject','cancel']), reason: z.string().trim().min(5).max(1000).optional() }).strict();

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requirePermission('PURCHASE_REQUEST_UPDATE'); if (auth instanceof NextResponse) return auth;
  const { id } = await params; const parsed = actionSchema.safeParse(await req.json()); if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message }, { status: 400 });
  const { supabase } = await getAuthSupabase(req); const { data: row } = await supabase.schema('finance').from('purchase_requests').select('*').eq('id', id).eq('organization_id', auth.orgId).maybeSingle();
  if (!row) return NextResponse.json({ error: 'Purchase request not found' }, { status: 404 });
  const { action, reason } = parsed.data; const patch:any = { updated_at:new Date().toISOString() };
  if (action==='submit') { if(row.status!=='DRAFT') return NextResponse.json({error:'Only DRAFT requests can be submitted'},{status:409}); patch.status='SUBMITTED'; patch.submitted_by=auth.userId; patch.submitted_at=new Date().toISOString(); }
  else if(action==='approve') { const approval=await requirePermission('PURCHASE_REQUEST_APPROVE'); if(approval instanceof NextResponse)return approval; if(row.status!=='SUBMITTED')return NextResponse.json({error:'Only SUBMITTED requests can be approved'},{status:409}); if(!enforceMakerChecker(row.requested_by,auth.userId))return NextResponse.json({error:'Maker-checker: requester cannot approve own request'},{status:403}); patch.status='APPROVED'; patch.approved_by=auth.userId; patch.approved_at=new Date().toISOString(); }
  else if(action==='reject') { const approval=await requirePermission('PURCHASE_REQUEST_APPROVE'); if(approval instanceof NextResponse)return approval; if(row.status!=='SUBMITTED')return NextResponse.json({error:'Only SUBMITTED requests can be rejected'},{status:409}); if(!reason)return NextResponse.json({error:'Rejection reason is required'},{status:400}); patch.status='REJECTED'; patch.rejection_reason=reason; }
  else { if(['APPROVED'].includes(row.status))return NextResponse.json({error:'Approved requests cannot be cancelled'},{status:409}); if(row.status==='CANCELLED')return NextResponse.json({error:'Already cancelled'},{status:409}); patch.status='CANCELLED'; patch.rejection_reason=reason||null; }
  const {data,error}=await supabase.schema('finance').from('purchase_requests').update(patch).eq('id',id).eq('organization_id',auth.orgId).select().single();
  if(error)return NextResponse.json({error:error.message},{status:400});

  // AP-03 FIX: nothing previously wrote finance.budget_commitments, so the
  // "Committed" figure never moved for an approved-but-unbilled purchase
  // request. Open an encumbrance on approval and release it if the request
  // is later rejected/cancelled, so Committed reflects reality instead of
  // always reading 0.
  let budgetCommitmentWarning: string | undefined;
  if (action === 'approve') {
    // AP-04 FIX: finance.purchase_requests has a `currency` column but no
    // exchange_rate/base_amount column at all, so there is no reliable way
    // to convert a non-PKR request's amount to the base currency budgets
    // are tracked in. Rather than silently encumbering the budget with a
    // foreign-currency figure treated as PKR (the exact AP-04 bug), skip
    // creating the commitment for non-PKR requests and say so — the
    // request still gets approved.
    const prCurrency = (row.currency || 'PKR').toUpperCase();
    if (prCurrency !== 'PKR') {
      budgetCommitmentWarning = `Purchase request approved, but budget commitment tracking was skipped: it is in ${prCurrency} and purchase requests have no exchange rate to convert to PKR (the budget's base currency).`;
    } else try {
      const budgetId = await resolveApplicableBudgetId(supabase, {
        organization_id: auth.orgId,
        project_id: row.project_id,
        category: row.category,
      });
      if (budgetId) {
        const { error: commitError } = await supabase.schema('finance').rpc('create_budget_commitment', {
          p_budget_id: budgetId,
          p_source_type: 'PURCHASE_REQUEST',
          p_source_reference: id,
          p_amount: data.amount,
          p_description: `Purchase request ${data.request_number || id}: ${data.description || ''}`.trim(),
        });
        if (commitError) {
          console.error('Failed to create budget commitment for purchase request:', commitError);
          budgetCommitmentWarning = `Purchase request approved, but the budget commitment could not be recorded: ${commitError.message}`;
        }
      }
    } catch (err: any) {
      console.error('Budget commitment resolution failed for purchase request:', err);
      budgetCommitmentWarning = 'Purchase request approved, but the budget commitment could not be recorded due to a budget lookup error.';
    }
  } else if (action === 'reject' || action === 'cancel') {
    const { error: releaseError } = await supabase.schema('finance').rpc('release_budget_commitments_by_source', {
      p_source_type: 'PURCHASE_REQUEST',
      p_source_reference: id,
      p_release_reason: action === 'reject' ? `Purchase request rejected: ${reason}` : `Purchase request cancelled${reason ? `: ${reason}` : ''}`,
    });
    if (releaseError) {
      console.error('Failed to release budget commitment for purchase request:', releaseError);
      budgetCommitmentWarning = `Purchase request ${action}ed, but its budget commitment could not be released: ${releaseError.message}`;
    }
  }

  return NextResponse.json({ data, budget_commitment_warning: budgetCommitmentWarning });
}