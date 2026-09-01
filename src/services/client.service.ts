import { supabase as browserSupabase } from '@/lib/supabase';
import type { SupabaseClient } from '@supabase/supabase-js';

type SClient = SupabaseClient<any, any, any>;
function resolveClient(override?: SClient | null): SClient {
  return override || (browserSupabase as unknown as SClient);
}
// Backward-compat alias: existing function bodies
// continue to reference `supabase` directly.
const supabase = browserSupabase;
export const clientService = {
  async fetchClients(filters?: {
    is_active?: boolean;
    search?: string;
    page?: number;
    pageSize?: number;
  }) {
    let query = supabase
      .from('clients')
      .select('*, projects(id, name, status)', { count: 'exact' });

    if (filters?.is_active !== undefined) {
      query = query.eq('is_active', filters.is_active);
    }
    if (filters?.search) {
      const escaped = filters.search.replace(/[%_]/g, '\\$&');
      query = query.or(`name.ilike.%${escaped}%,client_code.ilike.%${escaped}%,email.ilike.%${escaped}%`);
    }

    const page = filters?.page || 1;
    const pageSize = filters?.pageSize || 20;
    const from = (page - 1) * pageSize;
    const to = from + pageSize - 1;

    const { data, error, count } = await query
      .order('name', { ascending: true })
      .range(from, to);

    if (error) throw error;
    return { data, total: count || 0, page, pageSize };
  },

  async fetchClientById(id: string) {
    const { data, error } = await supabase
      .from('clients')
      .select('*, invoices(id, invoice_number, status, total_amount, currency)')
      .eq('id', id)
      .single();
    if (error) throw error;
    return data;
  },

  async createClient(client: {
    name: string;
    contact_person?: string;
    email?: string;
    phone?: string;
    address?: string;
    city?: string;
    country?: string;
    tax_registration?: string;
    tax_type?: string;
    payment_terms?: string;
    default_currency?: string;
    notes?: string;
    website?: string;
    organization_id: string;
    created_by: string;
  }) {
    // FIX: Use finance schema for get_next_number (function lives in finance schema, not public)
    const { data: numData } = await supabase.schema('finance').rpc('get_next_number', { p_type: 'CLT' });
    const clientCode = numData || `CLT-${Date.now().toString().slice(-6)}`;

    const { data, error } = await supabase
      .from('clients')
      .insert({
        client_code: clientCode,
        is_active: true,
        ...client,
      })
      .select()
      .single();

    if (error) throw error;
    return data;
  },

  async updateClient(id: string, updates: Record<string, any>) {
    const { data, error } = await supabase
      .from('clients')
      .update(updates)
      .eq('id', id)
      .select()
      .single();
    if (error) throw error;
    return data;
  },

  async toggleClientStatus(id: string, isActive: boolean) {
    const { data, error } = await supabase
      .from('clients')
      .update({ is_active: isActive })
      .eq('id', id)
      .select()
      .single();
    if (error) throw error;
    return data;
  },

  async getClientStats(orgId?: string) {
    // BUG-057 FIX: Add organization_id filter to both count queries
    let activeQuery = supabase
      .from('clients')
      .select('id', { count: 'exact', head: true })
      .eq('is_active', true);
    if (orgId) activeQuery = activeQuery.eq('organization_id', orgId);

    let inactiveQuery = supabase
      .from('clients')
      .select('id', { count: 'exact', head: true })
      .eq('is_active', false);
    if (orgId) inactiveQuery = inactiveQuery.eq('organization_id', orgId);

    const { count: activeCount } = await activeQuery;
    const { count: inactiveCount } = await inactiveQuery;

    return { active: activeCount || 0, inactive: inactiveCount || 0 };
  },

  async getClientARSummary(clientId: string) {
    const { data, error } = await supabase
      .schema('reporting')
      .from('receivable_aging')
      .select('*')
      .eq('client_id', clientId);
    if (error) throw error;
    return data || [];
  },
};