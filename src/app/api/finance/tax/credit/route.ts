import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getAuthSupabase, requirePermission } from '@/lib/api-auth';
import { enforceMFA } from '@/lib/mfa-middleware';

const createSchema = z.object({
  tax_computation_id: z.string().uuid().optional().nullable(),
  fiscal_year_id: z.string().uuid().optional().nullable(),
  period_id: z.string().uuid().optional().nullable(),
  credit_type: z.enum(['WHT_DEDUCTED','WHT_COLLECTED','TAX_CREDIT','CARRY_FORWARD','ADJUSTMENT','PREVIOUS_YEAR_CREDIT']),
  counterparty_name: z.string().trim().max(300).optional().nullable(),
  counterparty_cnic: z.string().trim().max(50).optional().nullable(),
  counterparty_ntn: z.string().trim().max(50).optional().nullable(),
  source_type: z.string().trim().max(80).optional().nullable(),
  source_id: z.string().uuid().optional().nullable(),
  gross_amount: z.coerce.number().min(0).default(0),
  wht_rate: z.coerce.number().min(0).max(100).default(0),
  credit_amount: z.coerce.number().positive(),
  currency: z.string().regex(/^[A-Z]{3}$/).default('PKR'),
  tax_return_id: z.string().uuid().optional().nullable(),
  notes: z.string().trim().max(2000).optional().nullable(),
}).strict();

async function assertParentOrg(supabase: any, table: string, id: string | null | undefined, orgId: string, label: string) {
  if (!id) return true;
  const { data, error } = await supabase.schema('finance').from(table).select('id').eq('id', id).eq('organization_id', orgId).maybeSingle();
  if (error || !data) throw new Error(`${label} not found or access denied`);
  return true;
}

export async function POST(req: NextRequest) {
  const auth = await requirePermission('TAX_MANAGE');
  if (auth instanceof NextResponse) return auth;
  const mfa = await enforceMFA(auth);
  if (mfa) return mfa;

  const parsed = createSchema.safeParse(await req.json());
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message }, { status: 400 });
  const { supabase } = await getAuthSupabase(req);

  try {
    const b = parsed.data;
    // Defense in depth: every supplied parent must belong to the caller's org.
    await assertParentOrg(supabase, 'tax_computations', b.tax_computation_id, auth.orgId, 'Tax computation');
    await assertParentOrg(supabase, 'fiscal_years', b.fiscal_year_id, auth.orgId, 'Fiscal year');
    await assertParentOrg(supabase, 'accounting_periods', b.period_id, auth.orgId, 'Accounting period');
    await assertParentOrg(supabase, 'tax_returns', b.tax_return_id, auth.orgId, 'Tax return');

    const { data, error } = await supabase.schema('finance').from('tax_credits_and_withholding').insert({
      ...b,
      currency: b.currency.toUpperCase(),
      organization_id: auth.orgId,
      created_by: auth.userId,
      status: 'PENDING'
    }).select().single();
    if (error) return NextResponse.json({ error: error.message }, { status: 400 });
    return NextResponse.json({ data }, { status: 201 });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'Failed' }, { status: 403 });
  }
}
