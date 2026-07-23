import { supabase } from '@/lib/supabase';

const db = supabase.schema('finance');

export const vendorService = {

  // ── Fetch all vendors (matches actual DB columns) ──
  async fetchVendors(filters?: {
    is_active?: boolean;
    search?: string;
    page?: number;
    pageSize?: number;
  }) {
    let query = db.from('vendors').select('*', { count: 'exact' });

    // ✅ is_active is boolean, not status enum
    if (filters?.is_active !== undefined) {
      query = query.eq('is_active', filters.is_active);
    }
    
    // ✅ Use actual DB columns for search
    if (filters?.search) {
      query = query.or(`name.ilike.%${filters.search}%,vendor_code.ilike.%${filters.search}%,tax_registration.ilike.%${filters.search}%,email.ilike.%${filters.search}%`);
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

  // ── Fetch single vendor by ID ──
  async fetchVendorById(id: string) {
    const { data, error } = await db
      .from('vendors')
      .select('*')
      .eq('id', id)
      .single();

    if (error) throw error;
    return data;
  },

  // ── Create vendor (matches actual DB columns) ──
  async createVendor(vendor: {
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
    bank_name?: string;
    bank_account?: string;
    notes?: string;
  }) {
    const code = `VND-${Date.now().toString().slice(-5)}`;

    const { data, error } = await db
      .from('vendors')
      .insert({
        vendor_code: code,
        is_active: true,
        ...vendor,
      })
      .select()
      .single();

    if (error) throw error;
    return data;
  },

  // ── Update vendor ──
  async updateVendor(id: string, updates: Record<string, any>) {
    const { data, error } = await db
      .from('vendors')
      .update(updates)
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;
    return data;
  },

  // ── Toggle active/inactive ──
  async toggleVendorStatus(id: string, isActive: boolean) {
    const { data, error } = await db
      .from('vendors')
      .update({ is_active: isActive })
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;
    return data;
  },

  // ── Vendor stats for dashboard ──
  async getVendorStats() {
    const { count: activeCount } = await db
      .from('vendors')
      .select('id', { count: 'exact', head: true })
      .eq('is_active', true);

    const { count: inactiveCount } = await db
      .from('vendors')
      .select('id', { count: 'exact', head: true })
      .eq('is_active', false);

    return {
      active: activeCount || 0,
      inactive: inactiveCount || 0,
    };
  },
};