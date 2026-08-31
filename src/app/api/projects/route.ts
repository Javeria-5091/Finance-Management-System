import { NextRequest, NextResponse } from 'next/server';
import { getAuthSupabase } from '@/lib/api-auth';
import { requirePermission } from '@/lib/api-auth';
import { sanitizeSearch, projectCreateSchema } from '@/lib/validations';
 
function getData<T = any>(res: any): T | null {
  return res?.data ?? null;
}
 
// ─── GET: List all projects with profitability data ───
export async function GET(req: NextRequest) {
  const auth = await requirePermission('PROJECT_READ');
  if (auth instanceof NextResponse) return auth;
  const { supabase } = await getAuthSupabase(req);
  const ratePermission = await requirePermission('PROJECT_RATE_VIEW');
  const canViewRates = !(ratePermission instanceof NextResponse);
 
  try {
    const { searchParams } = new URL(req.url);
    const page = parseInt(searchParams.get('page') || '1');
    const pageSize = parseInt(searchParams.get('pageSize') || '20');
    const search = searchParams.get('search') || '';
    const status = searchParams.get('status') || '';
    const clientId = searchParams.get('client_id') || '';
    const managerId = searchParams.get('manager_id') || '';
 
    // Fetch the base project rows only. Nested PostgREST relation selects are
    // not accepted by the generated Supabase select parser in this project,
    // so clients/managers are resolved separately below.
    let query = supabase
      .from('projects')
      .select('*', { count: 'exact' })
      .eq('organization_id', auth.orgId);
 
    if (search) {
      // BUG-010 FIX (High): sanitize search term to prevent PostgREST filter injection.
      const s = sanitizeSearch(search);
      query = query.or(`name.ilike.%${s}%,project_code.ilike.%${s}%,description.ilike.%${s}%`);
    }
    if (status) {
      query = query.eq('status', status);
    }
    if (clientId) {
      query = query.eq('client_id', clientId);
    }
    if (managerId) {
      query = query.eq('manager_id', managerId);
    }
 
    const from = (page - 1) * pageSize;
    const to = from + pageSize - 1;
 
    const { data, error, count } = await query
      .order('created_at', { ascending: false })
      .range(from, to);
 
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
 
    // Resolve relations separately. The canonical clients table has no
    // client_code column and the typed nested select parser rejects the
    // relation syntax used by the old query.
    const projects = data || [];
    const clientIds = [...new Set(projects.map((p: any) => p.client_id).filter(Boolean))];
    const managerIds = [...new Set(projects.map((p: any) => p.manager_id).filter(Boolean))];

    const [{ data: clients }, { data: managers }] = await Promise.all([
      clientIds.length
        ? supabase.from('clients').select('id, name').in('id', clientIds)
        : Promise.resolve({ data: [] as any[] }),
      managerIds.length
        ? supabase.from('profiles').select('user_id, full_name').in('user_id', managerIds)
        : Promise.resolve({ data: [] as any[] }),
    ]);

    const clientMap = new Map((clients || []).map((c: any) => [c.id, c]));
    const managerMap = new Map((managers || []).map((m: any) => [m.user_id, m]));

    const enrichedData = await Promise.all(
      projects.map(async (project: any) => {
        const { data: profitability } = await supabase
          .schema('reporting')
          .from('v_project_profitability')
          .select('*')
          .eq('project_id', project.id)
          .maybeSingle();

        const client = project.client_id ? clientMap.get(project.client_id) : null;
        const manager = project.manager_id ? managerMap.get(project.manager_id) : null;
        const safeProject = canViewRates
          ? project
          : Object.fromEntries(
              Object.entries(project).filter(
                ([key]) => !['contract_value', 'budget_amount', 'is_confidential'].includes(key)
              )
            );

        return {
          ...safeProject,
          client,
          manager,
          client_name: client?.name ?? project.client_name ?? null,
          profitability: profitability || null,
        };
      })
    );
    return NextResponse.json({
      data: enrichedData,
      total: count || 0,
      page,
      pageSize,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
 
// ─── POST: Create a new project ───
export async function POST(req: NextRequest) {
  const auth = await requirePermission('PROJECT_CREATE');
  if (auth instanceof NextResponse) return auth;
  const { supabase } = await getAuthSupabase(req);
  const ratePermission = await requirePermission('PROJECT_RATE_VIEW');
  const canViewRates = !(ratePermission instanceof NextResponse);
 
  try {
    const parsed = projectCreateSchema.safeParse(await req.json());
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues[0]?.message || 'Invalid project data' }, { status: 400 });
    }
    const {
      name, client_id, manager_id, platform, contract_value,
      currency, start_date, end_date, description, budget_amount,
      department, cost_center, is_confidential,
    } = parsed.data;

    if (!canViewRates && (contract_value !== undefined || budget_amount !== undefined || is_confidential !== undefined)) {
      return NextResponse.json({ error: 'Confidential project rate fields require PROJECT_RATE_VIEW permission' }, { status: 403 });
    }
 
    let clientName: string | null = null;
    if (client_id) {
      const { data: client, error: clientError } = await supabase
        .from('clients')
        .select('id, name')
        .eq('id', client_id)
        .eq('organization_id', auth.orgId)
        .maybeSingle();
      if (clientError) return NextResponse.json({ error: clientError.message }, { status: 500 });
      if (!client) return NextResponse.json({ error: 'Selected client was not found in your organization' }, { status: 400 });
      clientName = client.name;
    }

    // Generate project code
    const { data: numData } = await supabase.schema('finance').rpc('get_next_number', { p_type: 'PRJ' });
    const projectCode = numData || `PRJ-${Date.now().toString().slice(-6)}`;
 
    const { data: project, error } = await supabase
      .from('projects')
      .insert({
        project_code: projectCode,
        name,
        client_name: clientName,
        client_id: client_id || null,
        manager_id: manager_id || auth.userId,
        platform: platform || null,
        contract_value: contract_value ?? 0,
        currency: currency || 'PKR',
        start_date: start_date || null,
        end_date: end_date || null,
        description: description || null,
        budget_amount: budget_amount ?? 0,
        department: department || null,
        cost_center: cost_center || null,
        is_confidential: is_confidential ?? false,
        status: 'ACTIVE',
        is_active: true,
        organization_id: auth.orgId,
        created_by: auth.userId,
      })
      .select()
      .single();
 
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
 
    try {
      await supabase.schema('audit').rpc('log_action', {
        p_user_id: auth.userId,
        p_action: 'PROJECT_CREATED',
        p_entity_type: 'project',
        p_entity_id: project.id,
        p_description: `Project created: ${name} (${projectCode})`,
        p_previous_status: null,
        p_new_status: 'ACTIVE',
        p_source_module: 'project',
        p_severity: 'info',
        p_new_values: { name, project_code: projectCode, contract_value, currency: currency || 'PKR', client_id },
      });
    } catch (auditErr: any) {
      console.error('Audit log failed:', auditErr);
    }
 
    return NextResponse.json({
      success: true,
      project,
      message: `Project ${name} created with code ${projectCode}`,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
