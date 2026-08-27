import { NextRequest, NextResponse } from 'next/server';
import { getAuthSupabase, requirePermission } from '@/lib/api-auth';

// BUG-011 FIX: audit-log reads are explicitly scoped to the authenticated
// organization at the API layer as well as by the database view/RLS.
export async function GET(req: NextRequest) {
  const auth = await requirePermission('ADMIN_AUDIT');
  if (auth instanceof NextResponse) return auth;
  const { supabase } = await getAuthSupabase(req);
  const { searchParams } = new URL(req.url);

  const page = Math.max(1, Number(searchParams.get('page') || 1));
  const pageSize = Math.min(100, Math.max(1, Number(searchParams.get('pageSize') || 50)));
  let query = supabase.schema('public').from('v_audit_log').select('*', { count: 'exact' }).eq('organization_id', auth.orgId);

  const action = searchParams.get('action');
  const resource = searchParams.get('resource');
  const dateFrom = searchParams.get('dateFrom');
  const dateTo = searchParams.get('dateTo');
  if (action) query = query.eq('action', action);
  if (resource) query = query.eq('entity_type', resource);
  if (dateFrom) query = query.gte('created_at', dateFrom);
  if (dateTo) query = query.lte('created_at', dateTo + 'T23:59:59');

  const { data, error, count } = await query
    .order('created_at', { ascending: false })
    .range((page - 1) * pageSize, page * pageSize - 1);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ data: data || [], total: count || 0, page, pageSize });
}
