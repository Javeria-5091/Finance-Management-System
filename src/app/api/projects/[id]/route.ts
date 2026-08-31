import { NextRequest, NextResponse } from 'next/server';
import { getAuthSupabase } from '@/lib/api-auth';
import { requirePermission } from '@/lib/api-auth';
import { projectUpdateSchema } from '@/lib/validations';
 
function getData<T = any>(res: any): T | null {
  return res?.data ?? null;
}
 
// ─── GET: Fetch a single project with full details ───
export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const auth = await requirePermission('PROJECT_READ');
  if (auth instanceof NextResponse) return auth;
  const { supabase } = await getAuthSupabase(req);
  const ratePermission = await requirePermission('PROJECT_RATE_VIEW');
  const canViewRates = !(ratePermission instanceof NextResponse);
 
  try {
    const { id } = params;
    // Fetch the base row directly. Relations are resolved separately because
    // the generated Supabase select parser rejects the nested relation string.
    const { data: project, error } = await supabase
      .from('projects')
      .select('*')
      .eq('id', id)
      .eq('organization_id', auth.orgId)
      .single();
 
    if (error || !project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 });
    }
 
    // Get profitability data
    const { data: profitability } = await supabase
      .schema('reporting').from('v_project_profitability')
      .select('*')
      .eq('project_id', id)
      .maybeSingle();
 
    // Get related invoices
    const { data: invoices } = await supabase
      .from('invoices')
      .select('id, invoice_number, status, total_amount, currency, due_date')
      .eq('project_id', id)
      .order('created_at', { ascending: false });
 
    // Get related expenses
    const { data: expenses } = await supabase
      .from('expenses')
      .select('id, title, amount, currency, status, expense_date')
      .eq('project_id', id)
      .order('created_at', { ascending: false })
      .limit(20);
 
    // Get budget data
    const { data: budget } = await supabase
      .schema('finance').from('budgets')
      .select('*')
      .eq('project_id', id)
      .eq('status', 'APPROVED')
      .maybeSingle();
 
    let client: { id: string; name: string } | null = null;
    if (project.client_id) {
      const { data: clientData } = await supabase
        .from('clients')
        .select('id, name')
        .eq('id', project.client_id)
        .maybeSingle();
      client = clientData;
    }

    const safeProject = canViewRates
      ? project
      : Object.fromEntries(
          Object.entries(project).filter(
            ([key]) => !['contract_value', 'budget_amount', 'is_confidential'].includes(key)
          )
        );

    return NextResponse.json({
      project: { ...safeProject, client, client_name: client?.name ?? project.client_name ?? null },
      profitability: profitability || null,
      invoices: invoices || [],
      expenses: expenses || [],
      budget: budget || null,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
 
// ─── PATCH: Update project details ───
export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const auth = await requirePermission('PROJECT_UPDATE');
  if (auth instanceof NextResponse) return auth;
  const { supabase } = await getAuthSupabase(req);
 
  try {
    const { id } = params;
    const parsed = projectUpdateSchema.safeParse(await req.json());
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues[0]?.message || 'Invalid project update' }, { status: 400 });
    }
    const body = parsed.data;
    const ratePermission = await requirePermission('PROJECT_RATE_VIEW');
    const canViewRates = !(ratePermission instanceof NextResponse);
    if (!canViewRates && (body.contract_value !== undefined || body.budget_amount !== undefined || body.is_confidential !== undefined)) {
      return NextResponse.json({ error: 'Confidential project rate fields require PROJECT_RATE_VIEW permission' }, { status: 403 });
    }
 
    const existing = getData(await supabase
      .from('projects')
      .select('id, name, status, is_active')
      .eq('id', id)
      .eq('organization_id', auth.orgId)
      .single());
 
    if (!existing) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 });
    }
 
    // If closing project, check for unresolved items. A FINANCE_HEAD/CEO may
    // explicitly override the guard, but the reason must be recorded.
    if (body.status === 'CLOSED' && existing.status !== 'CLOSED') {
      const { count: outstandingInvoices } = await supabase
        .from('invoices')
        .select('id', { count: 'exact', head: true })
        .eq('project_id', id)
        .in('status', ['ISSUED', 'PARTIALLY_PAID']);
 
      const { count: pendingExpenses } = await supabase
        .from('expenses')
        .select('id', { count: 'exact', head: true })
        .eq('project_id', id)
        .in('status', ['DRAFT', 'SUBMITTED', 'VERIFIED', 'APPROVED']);
 
      const hasUnresolvedItems = (outstandingInvoices || 0) > 0 || (pendingExpenses || 0) > 0;
      const overrideReason = body.override_reason?.trim();
      const canOverrideClosure = auth.role === 'CEO' || auth.role === 'FINANCE_HEAD';

      if (hasUnresolvedItems && (!overrideReason || !canOverrideClosure)) {
        return NextResponse.json({
          error: canOverrideClosure
            ? 'Cannot close project with unresolved receivables or pending expenses without an override reason.'
            : 'Cannot override unresolved project items. Only CEO or FINANCE_HEAD can approve a closure override.',
          outstandingInvoices,
          pendingExpenses,
          override_required: true,
        }, { status: 400 });
      }
    }

    // Keep closure metadata consistent whenever status becomes CLOSED.
    const updates = {
      ...body,
      ...(body.status === 'CLOSED'
        ? {
            is_active: false,
            closure_reason: body.override_reason?.trim() || body.closure_reason || 'Project closed',
            closed_by: auth.userId,
            closed_at: new Date().toISOString(),
          }
        : {}),
    };
    delete (updates as any).override_reason;

    // The schema already whitelists mutable project fields. Protected fields
    // such as project_code, organization_id, created_by and id cannot enter
    // the update payload at all.
        const { data: updated, error } = await supabase
      .from('projects')
      .update(updates)
      .eq('id', id)
      .eq('organization_id', auth.orgId)
      .select()
      .single();
 
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
 
    try {
      await supabase.schema('audit').rpc('log_action', {
        p_user_id: auth.userId,
        p_action: 'PROJECT_UPDATED',
        p_entity_type: 'project',
        p_entity_id: id,
        p_description: `Project updated: ${existing.name} - ${JSON.stringify(Object.keys(updates))}`,
        p_previous_status: existing.status,
        p_new_status: updated.status,
        p_source_module: 'project',
        p_severity: body.status === 'CLOSED' ? 'high' : 'info',
        p_new_values: updates,
      });
    } catch (auditErr: any) {
      console.error('Audit log failed:', auditErr);
    }
 
    return NextResponse.json({
      success: true,
      project: canViewRates
        ? updated
        : Object.fromEntries(Object.entries(updated).filter(([key]) => !['contract_value', 'budget_amount', 'is_confidential'].includes(key))),
      message: 'Project updated successfully',
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
 
// ─── DELETE: Soft-delete (deactivate) a project ───
export async function DELETE(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const auth = await requirePermission('PROJECT_DELETE');
  if (auth instanceof NextResponse) return auth;
  const { supabase } = await getAuthSupabase(req);
 
  try {
    const { id } = params;
    const { reason } = await req.json();
 
    if (!reason) {
      return NextResponse.json({ error: 'Reason is required for project deactivation' }, { status: 400 });
    }
 
    const { data: existing } = await supabase
      .from('projects')
      .select('id, name, status, project_code')
      .eq('id', id)
      .eq('organization_id', auth.orgId)
      .maybeSingle();

    if (!existing) return NextResponse.json({ error: 'Project not found' }, { status: 404 });

    const { data: project, error } = await supabase
      .from('projects')
      .update({
        is_active: false,
        status: 'CLOSED',
        closure_reason: reason,
        closed_by: auth.userId,
        closed_at: new Date().toISOString(),
      })
      .eq('id', id)
      .eq('organization_id', auth.orgId)
      .select()
      .single();
 
    if (error || !project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 });
    }
 
    try {
await       supabase.schema('audit').rpc('log_action', {
        p_user_id: auth.userId,
        p_action: 'PROJECT_DEACTIVATED',
        p_entity_type: 'project',
        p_entity_id: id,
        p_description: `Project deactivated: ${project.name}. Reason: ${reason}`,
        p_previous_status: existing.status,
        p_new_status: 'CLOSED',
        p_source_module: 'project',
        p_severity: 'high',
        p_reason: reason,
        p_new_values: { name: project.name, project_code: project.project_code },
      });
    } catch (auditErr: any) {
      console.error('Audit log failed:', auditErr);
    }
 
    return NextResponse.json({
      success: true,
      message: `Project ${project.name} deactivated successfully`,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}