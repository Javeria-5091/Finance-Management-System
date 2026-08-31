// =============================================================================
// Approval Limits API — spec 7.3 (core.approval_limits)
//
// FIX (Module 1 audit finding): this table had zero UI, so the app always
// fell through to the hardcoded PKR limits in checkApprovalLimit()
// (src/lib/api-auth.ts) — contradicting the spec's explicit "not hardcoded
// system rules" requirement. This route lets an ADMIN_USERS holder view and
// edit real, effective-dated, per-role or per-user approval ceilings.
// =============================================================================

import { NextRequest, NextResponse } from 'next/server';
import { getAuthSupabase, requirePermission } from '@/lib/api-auth';
import { enforceMFA } from '@/lib/mfa-middleware';
import { APPROVAL_TRANSACTION_TYPES, APPROVAL_SCOPES } from '@/lib/approval-limits';

const TRANSACTION_TYPES = APPROVAL_TRANSACTION_TYPES;
const SCOPES = APPROVAL_SCOPES;

// ─── GET: list approval limits for the org ───
export async function GET(req: NextRequest) {
  const auth = await requirePermission('ADMIN_USERS');
  if (auth instanceof NextResponse) return auth;
  const { supabase } = await getAuthSupabase(req);

  try {
    const { data, error } = await supabase
      .schema('core')
      .from('approval_limits')
      .select(`
        id, role_id, user_id, transaction_type, currency, max_amount, scope,
        effective_from, effective_to, notes, created_at,
        roles:role_id ( name, display_name )
      `)
      .eq('organization_id', auth.orgId)
      .order('transaction_type', { ascending: true })
      .order('effective_from', { ascending: false });

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    return NextResponse.json({ data: data || [], transactionTypes: TRANSACTION_TYPES, scopes: SCOPES });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

// ─── POST: create a new limit row (role-based or user-based) ───
export async function POST(req: NextRequest) {
  const auth = await requirePermission('ADMIN_USERS');
  if (auth instanceof NextResponse) return auth;
  // P1-01 FIX (Spec §7.4): setting an approval ceiling is exactly the kind
  // of approval-rights configuration MFA must gate.
  const mfaCheck = await enforceMFA(auth);
  if (mfaCheck) return mfaCheck;
  const { supabase } = await getAuthSupabase(req);

  try {
    const body = await req.json();
    const {
      role_id, user_id, transaction_type, currency = 'PKR',
      max_amount, scope = 'ALL', effective_from, effective_to, notes,
    } = body;

    if (!role_id && !user_id) {
      return NextResponse.json({ error: 'Either role_id or user_id is required' }, { status: 400 });
    }
    if (role_id && user_id) {
      return NextResponse.json({ error: 'Provide role_id or user_id, not both' }, { status: 400 });
    }
    if (!TRANSACTION_TYPES.includes(transaction_type)) {
      return NextResponse.json({ error: `transaction_type must be one of ${TRANSACTION_TYPES.join(', ')}` }, { status: 400 });
    }
    if (!SCOPES.includes(scope)) {
      return NextResponse.json({ error: `scope must be one of ${SCOPES.join(', ')}` }, { status: 400 });
    }
    if (max_amount !== null && max_amount !== undefined && Number(max_amount) < 0) {
      return NextResponse.json({ error: 'max_amount cannot be negative' }, { status: 400 });
    }

    const { data, error } = await supabase
      .schema('core')
      .from('approval_limits')
      .insert({
        role_id: role_id || null,
        user_id: user_id || null,
        transaction_type,
        currency,
        max_amount: max_amount === '' || max_amount === undefined ? null : max_amount,
        scope,
        effective_from: effective_from || new Date().toISOString().slice(0, 10),
        effective_to: effective_to || null,
        notes: notes || null,
        organization_id: auth.orgId,
        created_by: auth.userId,
      })
      .select()
      .single();

    if (error) {
      // Most likely a duplicate (org, role/user, transaction_type, currency,
      // effective_from) — the unique indexes added in P1_070.
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    try {
      await supabase.schema('audit').rpc('log_action', {
        p_user_id: auth.userId,
        p_action: 'APPROVAL_LIMIT_CREATED',
        p_entity_type: 'core.approval_limits',
        p_entity_id: data.id,
        p_description: `Approval limit set for ${transaction_type}: ${max_amount ?? 'unlimited'} ${currency}`,
        p_source_module: 'settings.approval_limits',
        p_severity: 'medium',
        p_new_values: { role_id, user_id, transaction_type, max_amount, currency, scope },
      });
    } catch { /* audit logging is best-effort */ }

    return NextResponse.json({ data }, { status: 201 });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

// ─── PATCH: end-date (soft delete) an existing limit ───
export async function PATCH(req: NextRequest) {
  const auth = await requirePermission('ADMIN_USERS');
  if (auth instanceof NextResponse) return auth;
  // P1-01 FIX (Spec §7.4): editing an approval ceiling must be MFA-gated.
  const mfaCheck = await enforceMFA(auth);
  if (mfaCheck) return mfaCheck;
  const { supabase } = await getAuthSupabase(req);

  try {
    const body = await req.json();
    const { id, effective_to, max_amount, notes } = body;
    if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 });

    const updates: Record<string, any> = {};
    if (effective_to !== undefined) updates.effective_to = effective_to;
    if (max_amount !== undefined) updates.max_amount = max_amount === '' ? null : max_amount;
    if (notes !== undefined) updates.notes = notes;

    const { data, error } = await supabase
      .schema('core')
      .from('approval_limits')
      .update(updates)
      .eq('id', id)
      .eq('organization_id', auth.orgId)
      .select()
      .single();

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    try {
      await supabase.schema('audit').rpc('log_action', {
        p_user_id: auth.userId,
        p_action: 'APPROVAL_LIMIT_UPDATED',
        p_entity_type: 'core.approval_limits',
        p_entity_id: id,
        p_description: 'Approval limit updated',
        p_source_module: 'settings.approval_limits',
        p_severity: 'medium',
        p_new_values: updates,
      });
    } catch { /* audit logging is best-effort */ }

    return NextResponse.json({ data });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

// ─── DELETE: remove a limit row (only ever the row itself — never touches posted transactions) ───
export async function DELETE(req: NextRequest) {
  const auth = await requirePermission('ADMIN_USERS');
  if (auth instanceof NextResponse) return auth;
  // P1-01 FIX (Spec §7.4): removing an approval ceiling must be MFA-gated.
  const mfaCheck = await enforceMFA(auth);
  if (mfaCheck) return mfaCheck;
  const { supabase } = await getAuthSupabase(req);

  try {
    const { searchParams } = new URL(req.url);
    const id = searchParams.get('id');
    if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 });

    const { error } = await supabase
      .schema('core')
      .from('approval_limits')
      .delete()
      .eq('id', id)
      .eq('organization_id', auth.orgId);

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    try {
      await supabase.schema('audit').rpc('log_action', {
        p_user_id: auth.userId,
        p_action: 'APPROVAL_LIMIT_DELETED',
        p_entity_type: 'core.approval_limits',
        p_entity_id: id,
        p_description: 'Approval limit deleted',
        p_source_module: 'settings.approval_limits',
        p_severity: 'medium',
      });
    } catch { /* audit logging is best-effort */ }

    return NextResponse.json({ success: true });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
