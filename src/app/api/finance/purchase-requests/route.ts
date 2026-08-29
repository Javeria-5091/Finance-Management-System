import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getAuthSupabase, requirePermission } from '@/lib/api-auth';

const schema = z.object({
  description: z.string().trim().min(3).max(500), amount: z.coerce.number().positive(),
  currency: z.string().regex(/^[A-Z]{3}$/), category: z.string().trim().max(100).optional().nullable(),
  vendor_id: z.string().uuid().optional().nullable(), project_id: z.string().uuid().optional().nullable(),
  required_date: z.string().date().optional().nullable(), justification: z.string().trim().max(2000).optional().nullable(),
}).strict();

export async function GET(req: NextRequest) {
  const auth = await requirePermission('PURCHASE_REQUEST_READ'); if (auth instanceof NextResponse) return auth;
  const { supabase } = await getAuthSupabase(req);
  let q = supabase.schema('finance').from('purchase_requests').select('*').eq('organization_id', auth.orgId).order('created_at', { ascending: false });
  const status = req.nextUrl.searchParams.get('status'); if (status) q = q.eq('status', status);
  const { data, error } = await q; if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ data: data || [] });
}

export async function POST(req: NextRequest) {
  const auth = await requirePermission('PURCHASE_REQUEST_CREATE'); if (auth instanceof NextResponse) return auth;
  const parsed = schema.safeParse(await req.json()); if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message }, { status: 400 });
  const { supabase } = await getAuthSupabase(req); const body = parsed.data;
  if (body.vendor_id) { const { data } = await supabase.schema('finance').from('vendors').select('id').eq('id', body.vendor_id).eq('organization_id', auth.orgId).maybeSingle(); if (!data) return NextResponse.json({ error: 'Vendor not found in your organization' }, { status: 404 }); }
  if (body.project_id) { const { data } = await supabase.from('projects').select('id').eq('id', body.project_id).eq('organization_id', auth.orgId).maybeSingle(); if (!data) return NextResponse.json({ error: 'Project not found in your organization' }, { status: 404 }); }
  const { data: next } = await supabase.schema('finance').rpc('get_next_number', { p_type: 'PURCHASE_REQUEST' });
  const { data, error } = await supabase.schema('finance').from('purchase_requests').insert({ ...body, currency: body.currency.toUpperCase(), request_number: next || `PR-${Date.now()}`, requested_by: auth.userId, organization_id: auth.orgId, status: 'DRAFT' }).select().single();
  if (error) return NextResponse.json({ error: error.message }, { status: 400 }); return NextResponse.json({ data }, { status: 201 });
}
