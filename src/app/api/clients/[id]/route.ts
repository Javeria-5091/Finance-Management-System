import { NextRequest, NextResponse } from 'next/server';
import { getAuthSupabase } from '@/lib/api-auth';
import { requirePermission } from '@/lib/api-auth';
import { clientUpdateSchema } from '@/lib/validations';
 
function getData<T = any>(res: any): T | null {
  return res?.data ?? null;
}
 
// ─── GET: Fetch a single client by ID ───
export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const auth = await requirePermission('CLIENT_READ');
  if (auth instanceof NextResponse) return auth;
  const { supabase } = await getAuthSupabase(req);
 
  try {
    const { id } = params;
 
    const { data: client, error } = await supabase
      .from('clients')
      .select('*, invoices(id, invoice_number, status, total_amount, currency), projects(id, name, status, contract_value)')
      .eq('id', id)
      .eq('organization_id', auth.orgId)
      .single();
 
    if (error || !client) {
      return NextResponse.json({ error: 'Client not found' }, { status: 404 });
    }
 
    // Get client AR summary
    const { data: arSummary } = await supabase
      .schema('reporting').from('v_ar_aging')
      .select('*')
      .eq('client_id', id);
 
    return NextResponse.json({
      client,
      arSummary: arSummary || [],
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
 
// ─── PATCH: Update client details ───
export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const auth = await requirePermission('CLIENT_UPDATE');
  if (auth instanceof NextResponse) return auth;
  const { supabase } = await getAuthSupabase(req);
 
  try {
    const { id } = params;
    const parsed = clientUpdateSchema.safeParse(await req.json());
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues[0]?.message || 'Invalid client update' }, { status: 400 });
    }
    const body = parsed.data;
 
    // Check client exists and belongs to org.
    // FND-BUD-03 FIX: public.clients has no is_active column -- selecting it
    // errored on every single request, so `existing` was always null and
    // every PATCH returned 404 regardless of whether the client existed.
    // The real status column is `status`.
    const existing = getData(await supabase
      .from('clients')
      .select('id, name, status')
      .eq('id', id)
      .eq('organization_id', auth.orgId)
      .single());
 
    if (!existing) {
      return NextResponse.json({ error: 'Client not found' }, { status: 404 });
    }
 
    // Protected fields are excluded from clientUpdateSchema, so they cannot
    // reach the database update even if a caller sends them.
    const updates = body;
 
    const { data: updated, error } = await supabase
      .from('clients')
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
        p_action: 'CLIENT_UPDATED',
        p_entity_type: 'client',
        p_entity_id: id,
        p_description: `Client updated: ${existing.name}`,
        p_previous_status: existing.status,
        p_new_status: updated.status,
        p_source_module: 'client',
        p_severity: 'info',
        p_new_values: updates,
      });
    } catch (auditErr: any) {
      console.error('Audit log failed:', auditErr);
    }
 
    return NextResponse.json({
      success: true,
      client: updated,
      message: 'Client updated successfully',
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
 
// ─── DELETE: Soft-delete (deactivate) a client ───
export async function DELETE(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const auth = await requirePermission('CLIENT_DELETE');
  if (auth instanceof NextResponse) return auth;
  const { supabase } = await getAuthSupabase(req);
 
  try {
    const { id } = params;
 
    // Check if client has active invoices or projects
    // BUG FIX (Audit M-2): add .eq('organization_id', auth.orgId) to both
    // count queries. The previous code filtered only by client_id, so the
    // counts could leak how many active invoices/projects exist for a given
    // client_id in OTHER organizations (cross-tenant count leak).
    const { count: activeInvoices } = await supabase
      .from('invoices')
      .select('id', { count: 'exact', head: true })
      .eq('client_id', id)
      .eq('organization_id', auth.orgId)
      .in('status', ['DRAFT', 'SUBMITTED', 'APPROVED', 'ISSUED', 'PARTIALLY_PAID']);

    const { count: activeProjects } = await supabase
      .from('projects')
      .select('id', { count: 'exact', head: true })
      .eq('client_id', id)
      .eq('organization_id', auth.orgId)
      .eq('is_active', true);
 
    if ((activeInvoices || 0) > 0 || (activeProjects || 0) > 0) {
      return NextResponse.json({
        error: 'Cannot deactivate client with active invoices or projects. Resolve all outstanding items first.',
        activeInvoices,
        activeProjects,
      }, { status: 400 });
    }
 
    // FND-BUD-03 FIX: public.clients has no is_active column, so this
    // update always failed (client stayed active, nothing was recorded).
    // Soft-delete it the way this table is actually built for: flip status
    // to INACTIVE and stamp deleted_at/deleted_by (both previously never
    // written by this route at all).
    const { data: client, error } = await supabase
      .from('clients')
      .update({
        status: 'INACTIVE',
        deleted_at: new Date().toISOString(),
        deleted_by: auth.userId,
      })
      .eq('id', id)
      .eq('organization_id', auth.orgId)
      .select()
      .single();
 
    if (error || !client) {
      return NextResponse.json({ error: 'Client not found or update failed' }, { status: 404 });
    }
 
    try {
      await supabase.schema('audit').rpc('log_action', {
        p_user_id: auth.userId,
        p_action: 'CLIENT_DEACTIVATED',
        p_entity_type: 'client',
        p_entity_id: id,
        p_description: `Client deactivated: ${client.name}`,
        p_previous_status: 'ACTIVE',
        p_new_status: 'INACTIVE',
        p_source_module: 'client',
        p_severity: 'medium',
        p_new_values: { name: client.name },
      });
    } catch (auditErr: any) {
      console.error('Audit log failed:', auditErr);
    }
 
    return NextResponse.json({
      success: true,
      message: `Client ${client.name} deactivated successfully`,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}