// =============================================================================
// Admin User Profile API — spec 5.1 ("manager hierarchy... active/inactive
// status")
//
// FIX (Module 1 audit finding): public.profiles.department_id/manager_id
// existed in the schema, and profiles.employment_status was added in
// migration P1_070, but there was no admin UI or endpoint to manage any of
// them. This route wraps core.admin_update_user_profile(), which does the
// permission check, org-scope check, and audit logging server-side.
// =============================================================================

import { NextRequest, NextResponse } from 'next/server';
import { getAuthSupabase, requirePermission } from '@/lib/api-auth';
import { enforceMFA } from '@/lib/mfa-middleware';

export async function GET(req: NextRequest) {
  const auth = await requirePermission('ADMIN_USERS');
  if (auth instanceof NextResponse) return auth;
  const { supabase } = await getAuthSupabase(req);

  try {
    const [{ data: users, error: usersError }, { data: departments, error: deptError }] = await Promise.all([
      supabase.schema('core').rpc('admin_list_users'),
      supabase.schema('finance').from('dimensions').select('id, name, type').eq('type', 'DEPARTMENT').eq('is_active', true).order('name'),
    ]);

    if (usersError) return NextResponse.json({ error: usersError.message }, { status: 500 });
    if (deptError) return NextResponse.json({ error: deptError.message }, { status: 500 });

    return NextResponse.json({ users: users || [], departments: departments || [] });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest) {
  const auth = await requirePermission('ADMIN_USERS');
  if (auth instanceof NextResponse) return auth;
  const mfaCheck = await enforceMFA(auth);
  if (mfaCheck) return mfaCheck;
  const { supabase } = await getAuthSupabase(req);

  try {
    const body = await req.json();
    const { user_id, department_id, manager_id, employment_status, clear_department, clear_manager } = body;

    if (!user_id) return NextResponse.json({ error: 'user_id is required' }, { status: 400 });

    const { data, error } = await supabase.schema('core').rpc('admin_update_user_profile', {
      p_user_id: user_id,
      p_department_id: department_id || null,
      p_manager_id: manager_id || null,
      p_employment_status: employment_status || null,
      p_clear_department: !!clear_department,
      p_clear_manager: !!clear_manager,
    });

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    return NextResponse.json({ data });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
