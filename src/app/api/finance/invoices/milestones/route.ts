import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getAuthSupabase, requirePermission } from '@/lib/api-auth';
import { enforceMFA } from '@/lib/mfa-middleware';

const milestoneSchema = z.object({
  invoice_id: z.string().uuid(),
  milestone_ref: z.string().trim().min(1).max(100),
  description: z.string().trim().min(1).max(1000),
  milestone_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'milestone_date must be YYYY-MM-DD'),
  amount: z.coerce.number().finite().positive().max(9999999999999999.99),
  percentage: z.coerce.number().finite().positive().max(100).nullable().optional(),
  evidence_ref: z.string().trim().max(500).nullable().optional(),
}).strict();

export async function GET(req: NextRequest) {
  const auth = await requirePermission('INVOICE_READ');
  if (auth instanceof NextResponse) return auth;

  const { supabase } = await getAuthSupabase(req);
  const invoiceId = new URL(req.url).searchParams.get('invoice_id');

  if (!invoiceId || !z.string().uuid().safeParse(invoiceId).success) {
    return NextResponse.json({ error: 'Valid invoice_id is required' }, { status: 400 });
  }

  const { data: invoice } = await supabase
    .from('invoices')
    .select('id')
    .eq('id', invoiceId)
    .eq('organization_id', auth.orgId)
    .maybeSingle();

  if (!invoice) return NextResponse.json({ error: 'Invoice not found' }, { status: 404 });

  const { data, error } = await supabase
    .schema('finance')
    .from('invoice_milestones')
    .select('*')
    .eq('organization_id', auth.orgId)
    .eq('invoice_id', invoiceId)
    .order('milestone_date');

  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ data: data ?? [] });
}

export async function POST(req: NextRequest) {
  const auth = await requirePermission('INVOICE_UPDATE');
  if (auth instanceof NextResponse) return auth;

  const mfaCheck = await enforceMFA(auth);
  if (mfaCheck) return mfaCheck;

  const { supabase } = await getAuthSupabase(req);

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const parsed = milestoneSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message || 'Invalid milestone data' },
      { status: 400 },
    );
  }

  const b = parsed.data;

  const { data: inv, error: invoiceError } = await supabase
    .from('invoices')
    .select('id,status,organization_id')
    .eq('id', b.invoice_id)
    .eq('organization_id', auth.orgId)
    .maybeSingle();

  if (invoiceError || !inv) {
    return NextResponse.json({ error: 'Invoice not found' }, { status: 404 });
  }

  if (!['DRAFT', 'SUBMITTED'].includes(inv.status)) {
    return NextResponse.json(
      { error: 'Invoice milestones can only be changed before approval' },
      { status: 409 },
    );
  }

  const { data, error } = await supabase
    .schema('finance')
    .from('invoice_milestones')
    .insert({
      invoice_id: b.invoice_id,
      organization_id: auth.orgId,
      milestone_ref: b.milestone_ref,
      description: b.description,
      milestone_date: b.milestone_date,
      amount: b.amount,
      percentage: b.percentage ?? null,
      evidence_ref: b.evidence_ref ?? null,
      created_by: auth.userId,
    })
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ data }, { status: 201 });
}
