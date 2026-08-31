import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getAuthSupabase, requirePermission } from '@/lib/api-auth';
import { enforceMFA } from '@/lib/mfa-middleware';

const createSchema = z.object({
  tax_type: z.enum(['corporate', 'sales', 'withholding', 'presumptive']).default('corporate'),
  tax_year: z.string().trim().min(4).max(20),
  period_start: z.string().date(),
  period_end: z.string().date(),
  fiscal_year_id: z.string().uuid().optional().nullable(),
  period_id: z.string().uuid().optional().nullable(),
  tax_rule_set_id: z.string().uuid().optional().nullable(),
  tax_reconciliation_id: z.string().uuid().optional().nullable(),
  due_date: z.string().date().optional().nullable(),
  declared_income: z.coerce.number().min(0).default(0),
  declared_taxable: z.coerce.number().min(0).default(0),
  declared_tax: z.coerce.number().min(0).default(0),
  declared_wht_credits: z.coerce.number().min(0).default(0),
  declared_net_payable: z.coerce.number().default(0),
  notes: z.string().trim().max(5000).optional().nullable(),
  attachment_ids: z.array(z.string().uuid()).max(100).optional().nullable(),
  filing_json: z.record(z.string(), z.unknown()).optional().nullable(),
}).strict();

const actionSchema = z.object({
  id: z.string().uuid(),
  action: z.enum(['prepare', 'approve', 'file', 'cancel']),
  filing_reference: z.string().trim().max(200).optional(),
  filing_date: z.string().date().optional(),
  filed_values: z.record(z.string(), z.unknown()).optional(),
  reason: z.string().trim().min(5).max(1000).optional(),
}).strict();

export async function GET(req: NextRequest) {
  const auth = await requirePermission('TAX_READ');
  if (auth instanceof NextResponse) return auth;
  const { supabase } = await getAuthSupabase(req);
  const status = req.nextUrl.searchParams.get('status');
  let query = supabase.schema('finance').from('tax_returns').select('*')
    .eq('organization_id', auth.orgId).order('created_at', { ascending: false });
  if (status) query = query.eq('status', status);
  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ data: data || [] });
}

export async function POST(req: NextRequest) {
  const auth = await requirePermission('TAX_MANAGE');
  if (auth instanceof NextResponse) return auth;
  const parsed = createSchema.safeParse(await req.json());
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message }, { status: 400 });
  const { supabase } = await getAuthSupabase(req);
  const body = parsed.data;
  if (body.period_end < body.period_start) {
    return NextResponse.json({ error: 'period_end cannot be before period_start' }, { status: 400 });
  }

  const { data, error } = await supabase.schema('finance').from('tax_returns').insert({
    ...body,
    organization_id: auth.orgId,
    status: 'DRAFT',
    prepared_by: auth.userId,
    prepared_at: new Date().toISOString(),
    created_by: auth.userId,
  }).select().single();
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ data }, { status: 201 });
}

export async function PATCH(req: NextRequest) {
  const auth = await requirePermission('TAX_APPROVE');
  if (auth instanceof NextResponse) return auth;
  const mfa = await enforceMFA(auth);
  if (mfa) return mfa;
  const parsed = actionSchema.safeParse(await req.json());
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message }, { status: 400 });
  const { supabase } = await getAuthSupabase(req);
  const body = parsed.data;

  const { data: row, error: rowError } = await supabase.schema('finance').from('tax_returns')
    .select('*').eq('id', body.id).eq('organization_id', auth.orgId).maybeSingle();
  if (rowError) return NextResponse.json({ error: rowError.message }, { status: 500 });
  if (!row) return NextResponse.json({ error: 'Tax return not found' }, { status: 404 });

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (body.action === 'prepare') {
    if (!['DRAFT', 'ADJUSTED'].includes(row.status)) return NextResponse.json({ error: 'Only DRAFT/ADJUSTED returns can be prepared' }, { status: 409 });
    patch.status = 'PREPARED'; patch.prepared_by = auth.userId; patch.prepared_at = new Date().toISOString();
  } else if (body.action === 'approve') {
    if (row.status !== 'PREPARED' && row.status !== 'UNDER_REVIEW') return NextResponse.json({ error: 'Return must be prepared before approval' }, { status: 409 });
    if (row.prepared_by === auth.userId) return NextResponse.json({ error: 'Maker-checker: preparer cannot approve the same return' }, { status: 403 });
    patch.status = 'APPROVED'; patch.approved_by = auth.userId; patch.approved_at = new Date().toISOString();
  } else if (body.action === 'file') {
    if (row.status !== 'APPROVED') return NextResponse.json({ error: 'Only approved returns can be filed' }, { status: 409 });
    if (!body.filing_reference || !body.filing_date) return NextResponse.json({ error: 'filing_reference and filing_date are required' }, { status: 400 });
    patch.status = 'FILED'; patch.filing_reference = body.filing_reference; patch.filing_date = body.filing_date;
    patch.filing_json = body.filed_values || row.filing_json || {};
  } else {
    if (['FILED', 'ACKNOWLEDGED', 'ASSESSED'].includes(row.status)) return NextResponse.json({ error: 'Filed/assessed returns cannot be cancelled' }, { status: 409 });
    if (!body.reason) return NextResponse.json({ error: 'Cancellation reason is required' }, { status: 400 });
    patch.status = 'CANCELLED'; patch.notes = [row.notes, `Cancelled: ${body.reason}`].filter(Boolean).join('\n');
  }

  const { data, error } = await supabase.schema('finance').from('tax_returns').update(patch)
    .eq('id', body.id).eq('organization_id', auth.orgId).select().single();
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ data });
}
