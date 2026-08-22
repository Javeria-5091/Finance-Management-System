import { NextRequest, NextResponse } from 'next/server';
import { sanitizeSearch } from '@/lib/validations';
import { getAuthSupabase } from '@/lib/api-auth';
import { getAuthUser, requirePermission } from '@/lib/api-auth';
import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
 
function getData<T = any>(res: any): T | null {
  return res?.data ?? null;
}

// ─── SECURITY FIX (PostgREST filter injection): sanitize any value that is
// interpolated into a `.or()`/`.ilike()` filter string. Supabase's PostgREST
// filter syntax uses `,` to separate conditions and `%`/`_` as ILIKE
// wildcards; an unescaped `,` in the search term lets an attacker inject
// additional filter clauses (e.g. `,role.eq.CEO`), and unescaped `%`/`_`
// change the match semantics. We strip characters that have special meaning
// in the PostgREST filter grammar and escape ILIKE wildcards.
function sanitizeIlikeTerm(raw: string): string {
  // BUG FIX (Audit M-13): delegate to the shared sanitizeSearch() helper
  // from @/lib/validations, which also escapes single quotes, dots, and
  // parentheses. The previous local implementation only stripped ,()
  // characters and escaped %_, leaving ' and . unescaped — a weaker
  // sanitization than the rest of the codebase.
  return sanitizeSearch(raw).slice(0, 100);
}
 
// ─── GET: List all users with roles and permissions ───
export async function GET(req: NextRequest) {
  const auth = await requirePermission('ADMIN_USERS');
  if (auth instanceof NextResponse) return auth;
  const { supabase } = await getAuthSupabase(req);
 
  try {
    // SECURITY FIX (BUG-003, CRITICAL): admin/users must scope every request
    // to the requesting admin's own organization. Without this, an admin of
    // Organization A could list users belonging to any other organization.
    if (!auth.orgId) {
      return NextResponse.json({ error: 'Organization context missing.' }, { status: 400 });
    }

    const { searchParams } = new URL(req.url);
    const page = parseInt(searchParams.get('page') || '1');
    const pageSize = parseInt(searchParams.get('pageSize') || '20');
    const search = searchParams.get('search') || '';
    const roleFilter = searchParams.get('role') || '';
    const isActive = searchParams.get('is_active');
 
    let query = supabase
      .from('profiles')
      .select('*, user_roles(role, is_active, effective_from, effective_to)', { count: 'exact' })
      .eq('organization_id', auth.orgId);
 
    if (search) {
      // SECURITY FIX: sanitize before interpolating into the PostgREST filter.
      const safeSearch = sanitizeIlikeTerm(search);
      if (safeSearch) {
        query = query.or(`email.ilike.%${safeSearch}%,full_name.ilike.%${safeSearch}%`);
      }
    }
    if (roleFilter) {
      query = query.eq('role', roleFilter);
    }
    if (isActive !== null && isActive !== undefined) {
      query = query.eq('is_active', isActive === 'true');
    }
 
    const from = (page - 1) * pageSize;
    const to = from + pageSize - 1;
 
    const { data, error, count } = await query
      .order('created_at', { ascending: false })
      .range(from, to);
 
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
 
    return NextResponse.json({
      data,
      total: count || 0,
      page,
      pageSize,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
 
// ─── POST: Create a new user or update user role ───
export async function POST(req: NextRequest) {
  const auth = await requirePermission('ADMIN_USERS');
  if (auth instanceof NextResponse) return auth;
  const { supabase } = await getAuthSupabase(req);
 
  try {
    if (!auth.orgId) {
      return NextResponse.json({ error: 'Organization context missing.' }, { status: 400 });
    }

    const body = await req.json();
    const { action, userId, email, fullName, role, effectiveFrom, effectiveTo } = body;
    // SECURITY FIX: organizationId is intentionally NOT read from the request
    // body for user creation/role assignment. An admin (even CEO) must only
    // ever create users and roles within their own organization — accepting
    // a client-supplied organizationId let a caller place a new user into an
    // arbitrary organization. New users are always created in auth.orgId.
    const organizationId = auth.orgId;
 
    // ─── Action: Invite/Create User ───
    if (action === 'invite') {
      if (!email) {
        return NextResponse.json({ error: 'email is required' }, { status: 400 });
      }
 
      // Check if user already exists (scoped to this organization — SECURITY FIX:
      // previously matched by email alone across all organizations, which could
      // leak whether an email is registered in a different org and would block
      // a legitimate invite in this org for a user who already exists elsewhere).
      const existing = getData(await supabase
        .from('profiles')
        .select('id, email')
        .eq('email', email)
        .eq('organization_id', organizationId)
        .maybeSingle());
 
      if (existing) {
        return NextResponse.json({
          error: 'User already exists',
          userId: existing.id,
        }, { status: 400 });
      }
 
      // Create profile entry
      const { data: profile, error: profileErr } = await supabase
        .from('profiles')
        .insert({
          email,
          full_name: fullName || null,
          role: role || 'EMPLOYEE',
          organization_id: organizationId,
          is_active: true,
          created_by: auth.userId,
        })
        .select()
        .single();
 
      if (profileErr) {
        return NextResponse.json({ error: profileErr.message }, { status: 500 });
      }
 
      // Assign role via user_roles table
      if (role) {
        const { error: roleErr } = await supabase
          .from('core.user_roles')
          .insert({
            user_id: profile.id,
            role,
            is_active: true,
            effective_from: effectiveFrom || new Date().toISOString().split('T')[0],
            effective_to: effectiveTo || null,
            assigned_by: auth.userId,
            organization_id: auth.orgId,
          });
        if (roleErr) {
          console.error('Role assignment failed:', roleErr.message);
        }
      }
 
      // Audit log
      try {
        await supabase.schema('audit').rpc('log_action', {
          p_user_id: auth.userId,
          p_action: 'USER_CREATED',
          p_entity_type: 'user',
          p_entity_id: profile.id,
          p_description: `Admin created user: ${email} with role ${role || 'EMPLOYEE'}`,
          p_previous_status: null,
          p_new_status: 'ACTIVE',
          p_source_module: 'admin',
          p_severity: 'high',
          p_new_values: { email, role, organization_id: organizationId || auth.orgId },
        });
      } catch (auditErr: any) {
        console.error('Audit log failed:', auditErr);
      }
 
      return NextResponse.json({
        success: true,
        user: profile,
        message: `User ${email} created successfully`,
      });
    }
 
    // ─── Action: Assign/Update Role ───
    if (action === 'assign_role') {
      if (!userId || !role) {
        return NextResponse.json({ error: 'userId and role are required' }, { status: 400 });
      }

      // SECURITY FIX: verify the target user belongs to the admin's own
      // organization before modifying their role. Without this check an
      // admin from Organization A could assign roles to a user in
      // Organization B by guessing/enumerating a userId.
      const targetProfile = getData(await supabase
        .from('profiles')
        .select('id, organization_id')
        .eq('id', userId)
        .maybeSingle());
      if (!targetProfile || targetProfile.organization_id !== organizationId) {
        return NextResponse.json({ error: 'User not found in your organization' }, { status: 404 });
      }
 
      // Deactivate existing active roles
      const { error: deactivateErr } = await supabase
        .from('core.user_roles')
        .update({ is_active: false, effective_to: new Date().toISOString().split('T')[0] })
        .eq('user_id', userId)
        .eq('is_active', true);
 
      if (deactivateErr) {
        console.error('Deactivation of old roles failed:', deactivateErr.message);
      }
 
      // Insert new role assignment
      const { data: newRole, error: roleErr } = await supabase
        .from('core.user_roles')
        .insert({
          user_id: userId,
          role,
          is_active: true,
          effective_from: effectiveFrom || new Date().toISOString().split('T')[0],
          effective_to: effectiveTo || null,
          assigned_by: auth.userId,
          organization_id: auth.orgId,
        })
        .select()
        .single();
 
      if (roleErr) {
        return NextResponse.json({ error: roleErr.message }, { status: 500 });
      }
 
      // Update profile role
      await supabase
        .from('profiles')
        .update({ role })
        .eq('id', userId);
 
      try {
  await       supabase.schema('audit').rpc('log_action', {
          p_user_id: auth.userId,
          p_action: 'ROLE_ASSIGNED',
          p_entity_type: 'user',
          p_entity_id: userId,
          p_description: `Role ${role} assigned to user ${userId}`,
          p_previous_status: null,
          p_new_status: role,
          p_source_module: 'admin',
          p_severity: 'high',
          p_new_values: { role, effective_from: effectiveFrom },
        });
      } catch (auditErr: any) {
        console.error('Audit log failed:', auditErr);
      }
 
      return NextResponse.json({
        success: true,
        roleAssignment: newRole,
        message: `Role ${role} assigned successfully`,
      });
    }
 
    // ─── Action: Reset Password (admin-initiated) ───
    if (action === 'reset_password') {
      if (!userId || !email) {
        return NextResponse.json({ error: 'userId and email are required' }, { status: 400 });
      }

      // SECURITY FIX: same cross-org check as assign_role — an admin must
      // not be able to trigger a password reset for a user outside their
      // own organization.
      const targetProfile = getData(await supabase
        .from('profiles')
        .select('id, organization_id')
        .eq('id', userId)
        .maybeSingle());
      if (!targetProfile || targetProfile.organization_id !== organizationId) {
        return NextResponse.json({ error: 'User not found in your organization' }, { status: 404 });
      }
 
      // Log the password reset request
      try {
       await supabase.schema('audit').rpc('log_action', {
          p_user_id: auth.userId,
          p_action: 'PASSWORD_RESET_REQUESTED',
          p_entity_type: 'user',
          p_entity_id: userId,
          p_description: `Admin requested password reset for user ${email}`,
          p_previous_status: null,
          p_new_status: 'RESET_PENDING',
          p_source_module: 'admin',
          p_severity: 'high',
          p_new_values: { target_user_id: userId },
        });
      } catch (auditErr: any) {
        console.error('Audit log failed:', auditErr);
      }
 
      return NextResponse.json({
        success: true,
        message: 'Password reset email sent to user',
      });
    }
 
    return NextResponse.json({ error: 'Invalid action. Use: invite, assign_role, or reset_password' }, { status: 400 });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
 
// ─── PATCH: Update user profile or toggle active status ───
export async function PATCH(req: NextRequest) {
  const auth = await requirePermission('ADMIN_USERS');
  if (auth instanceof NextResponse) return auth;
  const { supabase } = await getAuthSupabase(req);
 
  try {
    if (!auth.orgId) {
      return NextResponse.json({ error: 'Organization context missing.' }, { status: 400 });
    }

    const body = await req.json();
    const { userId, fullName, isActive } = body;
    // SECURITY FIX (BUG-011, HIGH): organizationId is no longer accepted from
    // the request body. Allowing a client-supplied organizationId let a
    // caller move a user into a different organization entirely, and
    // combined with the missing ownership check below, let an admin from
    // Organization A modify a user belonging to Organization B.
 
    if (!userId) {
      return NextResponse.json({ error: 'userId is required' }, { status: 400 });
    }

    // SECURITY FIX (BUG-011): verify the target user belongs to the
    // requesting admin's organization before allowing any update.
    const targetProfile = getData(await supabase
      .from('profiles')
      .select('id, organization_id')
      .eq('id', userId)
      .maybeSingle());
    if (!targetProfile || targetProfile.organization_id !== auth.orgId) {
      return NextResponse.json({ error: 'User not found in your organization' }, { status: 404 });
    }
 
    const updates: Record<string, any> = {};
    if (fullName !== undefined) updates.full_name = fullName;
    if (isActive !== undefined) updates.is_active = isActive;
 
    const { data: updated, error } = await supabase
      .from('profiles')
      .update(updates)
      .eq('id', userId)
      .eq('organization_id', auth.orgId)
      .select()
      .single();
 
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    } 
 
    try {
     await supabase.schema('audit').rpc('log_action', {
        p_user_id: auth.userId,
        p_action: isActive === false ? 'USER_DEACTIVATED' : 'USER_UPDATED',
        p_entity_type: 'user',
        p_entity_id: userId,
        p_description: `Admin updated user ${userId}: ${JSON.stringify(updates)}`,
        p_previous_status: null,
        p_new_status: isActive === false ? 'INACTIVE' : 'ACTIVE',
        p_source_module: 'admin',
        p_severity: 'medium',
        p_new_values: updates,
      });
    } catch (auditErr: any) {
      console.error('Audit log failed:', auditErr);
    }
 
    return NextResponse.json({
      success: true,
      user: updated,
      message: 'User updated successfully',
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}