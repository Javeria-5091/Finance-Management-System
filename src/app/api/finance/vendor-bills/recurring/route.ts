import { NextRequest, NextResponse } from 'next/server';
import { getAuthSupabase, requirePermission } from '@/lib/api-auth';
import { z } from 'zod';

const lineSchema = z.object({
  account_id: z.string().uuid(),
  description: z.string().trim().min(1).max(500),
  quantity: z.number().finite().positive().default(1),
  unit_price: z.number().finite().nonnegative(),
  tax_rate: z.number().finite().min(0).max(100).default(0),
  withholding_rate: z.number().finite().min(0).max(100).default(0),
  project_id: z.string().uuid().nullable().optional(),
}).strict();

const createSchema = z.object({
  template_name: z.string().trim().min(1).max(200),
  vendor_id: z.string().uuid(),
  frequency: z.enum(['MONTHLY','QUARTERLY','YEARLY']),
  next_run_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  currency: z.string().trim().length(3).transform(v => v.toUpperCase()).default('PKR'),
  exchange_rate: z.number().finite().positive().default(1),
  due_days: z.number().int().min(0).max(3650).default(30),
  project_id: z.string().uuid().nullable().optional(),
  description: z.string().max(2000).nullable().optional(),
  template_lines: z.array(lineSchema).min(1).max(100),
}).strict();

export async function GET(req: NextRequest) {
  const auth = await requirePermission('VENDOR_BILL_READ');
  if (auth instanceof NextResponse) return auth;
  const { supabase } = await getAuthSupabase(req);
  const { data, error } = await supabase.schema('finance').from('recurring_vendor_bills')
    .select('*, vendors:vendor_id(id,name)')
    .eq('organization_id', auth.orgId)
    .order('next_run_date', { ascending: true });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ data: data || [] });
}

export async function POST(req: NextRequest) {
  const auth = await requirePermission('VENDOR_BILL_CREATE');
  if (auth instanceof NextResponse) return auth;
  const { supabase } = await getAuthSupabase(req);
  const parsed = createSchema.safeParse(await req.json());
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message }, { status: 400 });
  const body = parsed.data;

  const { data: vendor } = await supabase.schema('finance').from('vendors').select('id')
    .eq('id', body.vendor_id).eq('organization_id', auth.orgId).maybeSingle();
  if (!vendor) return NextResponse.json({ error: 'Vendor not found in your organization' }, { status: 404 });

  const { data, error } = await supabase.schema('finance').from('recurring_vendor_bills').insert({
    ...body,
    organization_id: auth.orgId,
    created_by: auth.userId,
  }).select().single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ success: true, data }, { status: 201 });
}
