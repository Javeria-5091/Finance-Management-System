// =============================================================================
// Delegations API — spec 5.1 / 7.1 (core.delegations)
//
// FIX (Module 1 audit finding): table + RLS + audit triggers existed, but
// there was no UI or endpoint to create/revoke a time-limited delegation of
// specific permissions from one user to another.
// =============================================================================

import { NextRequest, NextResponse } from 'next/server';
import { getAuthSupabase, requirePermission } from '@/lib/api-auth';

export async function GET(req: NextRequest) {
  const auth = await requirePermission('ADMIN_USERS');
  if (auth instanceof NextResponse) return auth;
  const { supabase } = await getAuthSupabase(req);

  try {
    const { data, error } = await supabase
      .schema('core')
      .from('delegations')
      .select('id, from_user_id, to_user_id, permission_ids, reason, effective_from, effective_to, status, revoked_at, revoke_reason, created_at')
      .eq('organization_id', auth.orgId)
      .order('created_at', { ascending: false });

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    const { data: permissions } = await supabase.schema('core').from('permissions').select('id, code, name, module').order('module');

    return NextResponse.json({ data: data || [], permissions: permissions || [] });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const auth = await requirePermission('ADMIN_USERS');
  if (auth instanceof NextResponse) return auth;
  const { supabase } = await getAuthSupabase(req);

  try {
    const body = await req.json();
    const { from_user_id, to_user_id, permission_ids, reason, effective_from, effective_to } = body;

    if (!from_user_id || !to_user_id) {
      return NextResponse.json({ error: 'from_user_id and to_user_id are required' }, { status: 400 });
    }
    if (from_user_id === to_user_id) {
      return NextResponse.json({ error: 'Cannot delegate to the same user' }, { status: 400 });
    }
    if (!Array.isArray(permission_ids) || permission_ids.length === 0) {
      return NextResponse.json({ error: 'At least one permission must be selected' }, { status: 400 });
    }
    if (!reason || !reason.trim()) {
      return NextResponse.json({ error: 'A reason is required' }, { status: 400 });
    }
    if (!effective_to) {
      return NextResponse.json({ error: 'An end date is required — delegations must be time-limited' }, { status: 400 });
    }

    const { data, error } = await supabase
      .schema('core')
      .from('delegations')
      .insert({
        from_user_id,
        to_user_id,
        permission_ids,
        reason: reason.trim(),
        effective_from: effective_from || new Date().toISOString().slice(0, 10),
        effective_to,
        status: 'ACTIVE',
        organization_id: auth.orgId,
        created_by: auth.userId,
      })
      .select()
      .single();

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    try {
      await supabase.schema('audit').rpc('log_action', {
        p_user_id: auth.userId,
        p_action: 'DELEGATION_CREATED',
        p_entity_type: 'core.delegations',
        p_entity_id: data.id,
        p_description: `Delegation created from ${from_user_id} to ${to_user_id}`,
        p_reason: reason.trim(),
        p_source_module: 'settings.delegations',
        p_severity: 'medium',
        p_new_values: { from_user_id, to_user_id, permission_ids, effective_to },
      });
    } catch { /* audit logging is best-effort */ }

    return NextResponse.json({ data }, { status: 201 });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

// ─── PATCH: revoke an active delegation ───
export async function PATCH(req: NextRequest) {
  const auth = await requirePermission('ADMIN_USERS');
  if (auth instanceof NextResponse) return auth;
  const { supabase } = await getAuthSupabase(req);

  try {
    const body = await req.json();
    const { id, revoke_reason } = body;
    if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 });

    const { data, error } = await supabase
      .schema('core')
      .from('delegations')
      .update({
        status: 'REVOKED',
        revoked_by: auth.userId,
        revoked_at: new Date().toISOString(),
        revoke_reason: revoke_reason || null,
      })
      .eq('id', id)
      .eq('organization_id', auth.orgId)
      .eq('status', 'ACTIVE')
      .select()
      .single();

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    if (!data) return NextResponse.json({ error: 'Delegation not found or already inactive' }, { status: 404 });

    try {
      await supabase.schema('audit').rpc('log_action', {
        p_user_id: auth.userId,
        p_action: 'DELEGATION_REVOKED',
        p_entity_type: 'core.delegations',
        p_entity_id: id,
        p_description: 'Delegation revoked',
        p_reason: revoke_reason || null,
        p_source_module: 'settings.delegations',
        p_severity: 'medium',
      });
    } catch { /* audit logging is best-effort */ }

    return NextResponse.json({ data });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
