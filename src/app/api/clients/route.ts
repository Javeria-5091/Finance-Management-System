import { NextRequest, NextResponse } from 'next/server';
import { getAuthSupabase } from '@/lib/api-auth';
import { getAuthUser, requirePermission } from '@/lib/api-auth';
import { sanitizeSearch } from '@/lib/validations';
import { z } from 'zod';
 
function getData<T = any>(res: any): T | null {
  return res?.data ?? null;
}
 
// ─── GET: List all clients with search, pagination, and filters ───
export async function GET(req: NextRequest) {
  const auth = await requirePermission('CLIENT_READ');
  if (auth instanceof NextResponse) return auth;
  const { supabase } = await getAuthSupabase(req);
 
  try {
    const { searchParams } = new URL(req.url);
    const page = parseInt(searchParams.get('page') || '1');
    const pageSize = parseInt(searchParams.get('pageSize') || '20');
    const search = searchParams.get('search') || '';
    const isActive = searchParams.get('is_active');
    const projectFilter = searchParams.get('project_id') || '';
 
    let query = supabase
      .from('clients')
      .select('*, projects(id, name, status)', { count: 'exact' })
      .eq('organization_id', auth.orgId);
 
    if (search) {
      // BUG-010 FIX (High): sanitize search term to prevent PostgREST filter
      // injection. Without sanitization, a search term containing ',', '.', '(',
      // or ')' could be parsed as additional filter clauses, leaking data or
      // breaking the query.
      const s = sanitizeSearch(search);
      query = query.or(`name.ilike.%${s}%,client_code.ilike.%${s}%,email.ilike.%${s}%,phone.ilike.%${s}%,tax_registration.ilike.%${s}%`);
    }
    if (isActive !== null && isActive !== undefined) {
      query = query.eq('is_active', isActive === 'true');
    }
 
    const from = (page - 1) * pageSize;
    const to = from + pageSize - 1;
 
    const { data, error, count } = await query
      .order('name', { ascending: true })
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
 
const clientCreateSchema = z.object({
  name: z.string().trim().min(1).max(200), contact_person: z.string().max(200).optional().nullable(), email: z.string().email().optional().nullable(), phone: z.string().max(50).optional().nullable(),
  address: z.string().max(500).optional().nullable(), city: z.string().max(100).optional().nullable(), country: z.string().max(100).optional().nullable(),
  tax_registration: z.string().max(100).optional().nullable(), tax_type: z.string().max(100).optional().nullable(), payment_terms: z.string().max(50).optional(), default_currency: z.string().length(3).optional(), notes: z.string().max(2000).optional().nullable(), website: z.string().url().optional().nullable()
});

// ─── POST: Create a new client ───
export async function POST(req: NextRequest) {
  const auth = await requirePermission('CLIENT_CREATE');
  if (auth instanceof NextResponse) return auth;
  const { supabase } = await getAuthSupabase(req);
 
  try {
    const parsed = clientCreateSchema.safeParse(await req.json());
    if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message || 'Invalid client data' }, { status: 400 });
    const {
      name, contact_person, email, phone, address, city, country,
      tax_registration, tax_type, payment_terms, default_currency,
      notes, website,
    } = parsed.data;
 
    if (!name) {
      return NextResponse.json({ error: 'Client name is required' }, { status: 400 });
    }
 
    // Generate client code using DB sequence
    const { data: numData } = await supabase.schema('finance').rpc('get_next_number', { p_type: 'CLT' });
    const clientCode = numData || `CLT-${Date.now().toString().slice(-6)}`;
 
    const { data: client, error } = await supabase
      .from('clients')
      .insert({
        client_code: clientCode,
        name,
        contact_person: contact_person || null,
        email: email || null,
        phone: phone || null,
        address: address || null,
        city: city || null,
        country: country || null,
        tax_registration: tax_registration || null,
        tax_type: tax_type || null,
        payment_terms: payment_terms || 'NET_30',
        default_currency: default_currency || 'PKR',
        notes: notes || null,
        website: website || null,
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
        p_action: 'CLIENT_CREATED',
        p_entity_type: 'client',
        p_entity_id: client.id,
        p_description: `Client created: ${name} (${clientCode})`,
        p_previous_status: null,
        p_new_status: 'ACTIVE',
        p_source_module: 'client',
        p_severity: 'info',
        p_new_values: { name, client_code: clientCode, email, currency: default_currency || 'PKR' },
      });
    } catch (auditErr: any) {
      console.error('Audit log failed:', auditErr);
    }
 
    return NextResponse.json({
      success: true,
      client,
      message: `Client ${name} created with code ${clientCode}`,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
 
