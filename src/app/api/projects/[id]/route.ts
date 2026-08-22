import { NextRequest, NextResponse } from 'next/server';
import { getAuthSupabase } from '@/lib/api-auth';
import { requirePermission } from '@/lib/api-auth';
 
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
 
  try {
    const { id } = params;
 
    const { data: project, error } = await supabase
      .from('projects')
      .select('*, client:clients(id, name, client_code), manager:profiles!manager_id(id, full_name, email)')
      .eq('id', id)
      .eq('organization_id', auth.orgId)
      .single();
 
    if (error || !project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 });
    }
 
    // Get profitability data
    const { data: profitability } = await supabase
      .from('reporting.v_project_profitability')
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
      .from('finance.budgets')
      .select('*')
      .eq('project_id', id)
      .eq('status', 'APPROVED')
      .maybeSingle();
 
    return NextResponse.json({
      project,
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
    const body = await req.json();
 
    const existing = getData(await supabase
      .from('projects')
      .select('id, name, status, is_active')
      .eq('id', id)
      .eq('organization_id', auth.orgId)
      .single());
 
    if (!existing) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 });
    }
 
    // If closing project, check for unresolved items
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
 
      if ((outstandingInvoices || 0) > 0 || (pendingExpenses || 0) > 0) {
        return NextResponse.json({
          error: 'Cannot close project with unresolved receivables or pending expenses. Provide an override reason.',
          outstandingInvoices,
          pendingExpenses,
        }, { status: 400 });
      }
    }
 
    const { project_code, organization_id, created_by, created_at, id: _id, ...updates } = body;
 
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
      project: updated,
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
        p_previous_status: project.status,
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

