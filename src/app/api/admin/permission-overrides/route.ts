// =============================================================================
// Permission Overrides API — spec 7.2 (core.user_permission_overrides)
//
// FIX (Module 1 audit finding): this table existed with full RLS and audit
// triggers, and core.has_permission()/core.can_approve_amount() (used by RLS)
// already honored it, but there was no UI anywhere to create one, and
// public.get_my_permissions() (what the API layer/frontend actually read)
// silently ignored it — see migration P1_070 for the get_my_permissions fix.
// This route provides the missing admin surface.
// =============================================================================

import { NextRequest, NextResponse } from 'next/server';
import { getAuthSupabase, requirePermission } from '@/lib/api-auth';
import { enforceMFA } from '@/lib/mfa-middleware';

export async function GET(req: NextRequest) {
  const auth = await requirePermission('ADMIN_USERS');
  if (auth instanceof NextResponse) return auth;
  const { supabase } = await getAuthSupabase(req);

  try {
    // FND-PO-001 FIX: core.user_permission_overrides has no organization_id
    // column (org-scoping is enforced at the RLS layer instead, via a join
    // from user_id -> public.profiles.organization_id -- see policies
    // upo_select_own_org_scoped / upo_manage_org_scoped). Filtering on
    // organization_id here threw "column ... does not exist" on every
    // request. RLS already guarantees only same-org rows come back.
    const { data, error } = await supabase
      .schema('core')
      .from('user_permission_overrides')
      .select(`
        id, user_id, permission_id, override_type, reason, data_scope,
        effective_from, effective_to, created_at,
        permissions:permission_id ( code, name, module )
      `)
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
  // P1-01 FIX (Spec §7.4): granting/denying a permission override is
  // exactly the kind of approval-rights configuration change MFA must gate.
  const mfaCheck = await enforceMFA(auth);
  if (mfaCheck) return mfaCheck;
  const { supabase } = await getAuthSupabase(req);

  try {
    const body = await req.json();
    const { user_id, permission_id, override_type, reason, data_scope, effective_from, effective_to } = body;

    if (!user_id || !permission_id) {
      return NextResponse.json({ error: 'user_id and permission_id are required' }, { status: 400 });
    }
    if (!['ALLOW', 'DENY'].includes(override_type)) {
      return NextResponse.json({ error: 'override_type must be ALLOW or DENY' }, { status: 400 });
    }
    if (!reason || !reason.trim()) {
      return NextResponse.json({ error: 'A reason is required for every permission override' }, { status: 400 });
    }
    if (user_id === auth.userId) {
      return NextResponse.json({ error: 'You cannot set a permission override on your own account' }, { status: 400 });
    }

    // Confirm target user belongs to the same organization before writing —
    // RLS would also block a cross-org write, but a clear error here is
    // better than a raw RLS violation surfacing to the admin.
    const { data: targetProfile } = await supabase
      .schema('public')
      .from('profiles')
      .select('user_id, organization_id')
      .eq('user_id', user_id)
      .maybeSingle();

    if (!targetProfile || targetProfile.organization_id !== auth.orgId) {
      return NextResponse.json({ error: 'Target user is not a member of your organization' }, { status: 400 });
    }

    const { data, error } = await supabase
      .schema('core')
      .from('user_permission_overrides')
      .insert({
        user_id,
        permission_id,
        override_type,
        reason: reason.trim(),
        data_scope: data_scope || null,
        effective_from: effective_from || new Date().toISOString().slice(0, 10),
        effective_to: effective_to || null,
        created_by: auth.userId,
      })
      .select()
      .single();

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    try {
      await supabase.schema('audit').rpc('log_action', {
        p_user_id: auth.userId,
        p_action: `PERMISSION_OVERRIDE_${override_type}_CREATED`,
        p_entity_type: 'core.user_permission_overrides',
        p_entity_id: data.id,
        p_description: `${override_type} override created for user ${user_id}`,
        p_reason: reason.trim(),
        p_source_module: 'settings.permission_overrides',
        p_severity: override_type === 'DENY' ? 'high' : 'medium',
        p_new_values: { user_id, permission_id, override_type },
      });
    } catch { /* audit logging is best-effort */ }

    return NextResponse.json({ data }, { status: 201 });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  const auth = await requirePermission('ADMIN_USERS');
  if (auth instanceof NextResponse) return auth;
  // P1-01 FIX (Spec §7.4): revoking a permission override also changes
  // access configuration and must be MFA-gated.
  const mfaCheck = await enforceMFA(auth);
  if (mfaCheck) return mfaCheck;
  const { supabase } = await getAuthSupabase(req);

  try {
    const { searchParams } = new URL(req.url);
    const id = searchParams.get('id');
    if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 });

    const { data: deleted, error } = await supabase
      .schema('core')
      .from('user_permission_overrides')
      .delete()
      .eq('id', id)
      .select()
      .maybeSingle();

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    if (!deleted) return NextResponse.json({ error: 'Override not found or not in your organization' }, { status: 404 });

    try {
      await supabase.schema('audit').rpc('log_action', {
        p_user_id: auth.userId,
        p_action: 'PERMISSION_OVERRIDE_REVOKED',
        p_entity_type: 'core.user_permission_overrides',
        p_entity_id: id,
        p_description: 'Permission override revoked',
        p_source_module: 'settings.permission_overrides',
        p_severity: 'medium',
      });
    } catch { /* audit logging is best-effort */ }

    return NextResponse.json({ success: true });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}