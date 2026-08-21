import { supabase } from '@/lib/supabase';

// ─── Project Service ───
// Provides CRUD and profitability operations for project records
// Spec: Maintain project code, client, manager, platform, contract value, currency, start/end date,
//        status, budget, and profitability dimensions
// Used by: /api/projects/route.ts, /api/projects/[id]/route.ts

export const projectService = {
  async fetchProjects(filters?: {
    is_active?: boolean;
    search?: string;
    status?: string;
    client_id?: string;
    manager_id?: string;
    page?: number;
    pageSize?: number;
  }) {
    let query = supabase
      .from('projects')
      .select('*, client:clients(id, name, client_code), manager:profiles!manager_id(id, full_name)', { count: 'exact' });

    if (filters?.is_active !== undefined) query = query.eq('is_active', filters.is_active);
    if (filters?.status) query = query.eq('status', filters.status);
    if (filters?.client_id) query = query.eq('client_id', filters.client_id);
    if (filters?.manager_id) query = query.eq('manager_id', filters.manager_id);
    if (filters?.search) {
      const escaped = filters.search.replace(/[%_]/g, '\\$&');
      query = query.or(`name.ilike.%${escaped}%,project_code.ilike.%${escaped}%,description.ilike.%${escaped}%`);
    }

    const page = filters?.page || 1;
    const pageSize = filters?.pageSize || 20;
    const from = (page - 1) * pageSize;
    const to = from + pageSize - 1;

    const { data, error, count } = await query
      .order('created_at', { ascending: false })
      .range(from, to);

    if (error) throw error;
    return { data, total: count || 0, page, pageSize };
  },

  async fetchProjectById(id: string) {
    const { data, error } = await supabase
      .from('projects')
      .select('*, client:clients(id, name, client_code), manager:profiles!manager_id(id, full_name, email)')
      .eq('id', id)
      .single();
    if (error) throw error;
    return data;
  },

  async fetchProjectProfitability(projectId: string) {
    const { data, error } = await supabase
      .from('reporting.v_project_profitability')
      .select('*')
      .eq('project_id', projectId)
      .maybeSingle();
    if (error) throw error;
    return data || null;
  },

  async createProject(project: {
    name: string;
    client_id?: string;
    manager_id?: string;
    platform?: string;
    contract_value?: number;
    currency?: string;
    start_date?: string;
    end_date?: string;
    description?: string;
    budget_amount?: number;
    department?: string;
    cost_center?: string;
    is_confidential?: boolean;
    organization_id: string;
    created_by: string;
  }) {
    // FIX: Use finance schema for get_next_number (function lives in finance schema, not public)
    const { data: numData } = await supabase.schema('finance').rpc('get_next_number', { p_type: 'PRJ' });
    const projectCode = numData || `PRJ-${Date.now().toString().slice(-6)}`;

    const { data, error } = await supabase
      .from('projects')
      .insert({
        project_code: projectCode,
        status: 'ACTIVE',
        is_active: true,
        ...project,
      })
      .select()
      .single();

    if (error) throw error;
    return data;
  },

  async updateProject(id: string, updates: Record<string, any>) {
    const { data, error } = await supabase
      .from('projects')
      .update(updates)
      .eq('id', id)
      .select()
      .single();
    if (error) throw error;
    return data;
  },

  async closeProject(id: string, reason: string, closedBy: string) {
    const { data, error } = await supabase
      .from('projects')
      .update({
        is_active: false,
        status: 'CLOSED',
        closure_reason: reason,
        closed_by: closedBy,
        closed_at: new Date().toISOString(),
      })
      .eq('id', id)
      .select()
      .single();
    if (error) throw error;
    return data;
  },

  async getProjectStats(orgId?: string) {
    const { count: activeCount } = await supabase
      .from('projects')
      .select('id', { count: 'exact', head: true })
      .eq('is_active', true);
    const { count: closedCount } = await supabase
      .from('projects')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'CLOSED');

    return { active: activeCount || 0, closed: closedCount || 0 };
  },

  async getProjectRelatedInvoices(projectId: string) {
    const { data, error } = await supabase
      .from('invoices')
      .select('id, invoice_number, status, total_amount, currency, due_date')
      .eq('project_id', projectId)
      .order('created_at', { ascending: false });
    if (error) throw error;
    return data || [];
  },

  async getProjectRelatedExpenses(projectId: string) {
    const { data, error } = await supabase
      .from('expenses')
      .select('id, title, amount, currency, status, expense_date')
      .eq('project_id', projectId)
      .order('created_at', { ascending: false })
      .limit(20);
    if (error) throw error;
    return data || [];
  },
};