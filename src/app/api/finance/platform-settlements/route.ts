import { NextRequest, NextResponse } from 'next/server';
import { getAuthSupabase, requirePermission } from '@/lib/api-auth';
import { z } from 'zod';

const schema = z.object({
  platform_id: z.string().uuid(),
  financial_account_id: z.string().uuid().optional().nullable(),
  settlement_reference: z.string().trim().min(1).max(120),
  settlement_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  currency: z.string().regex(/^[A-Z]{3}$/),
  gross_amount: z.coerce.number().positive(),
  actual_fee_amount: z.coerce.number().min(0),
  withholding_amount: z.coerce.number().min(0),
  withdrawal_fee_amount: z.coerce.number().min(0),
  exchange_rate: z.coerce.number().positive().optional().nullable(),
  fee_override_reason: z.string().max(1000).optional().nullable(),
  fee_override_evidence_reference: z.string().max(500).optional().nullable(),
  notes: z.string().max(2000).optional().nullable(),
}).strict();

export async function GET() {
  const a = await requirePermission('SETTLEMENT_READ');
  if (a instanceof NextResponse) return a;
  const { supabase } = await getAuthSupabase();
  const { data, error } = await supabase.schema('finance').from('settlement_batches')
    .select('*, settlement_lines(*)').eq('organization_id', a.orgId).order('settlement_date', { ascending: false });
  return error ? NextResponse.json({ error: error.message }, { status: 500 }) : NextResponse.json({ data: data || [] });
}

export async function POST(req: NextRequest) {
  const a = await requirePermission('SETTLEMENT_CREATE');
  if (a instanceof NextResponse) return a;
  const parsed = schema.safeParse(await req.json());
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message || 'Invalid request' }, { status: 400 });
  const { supabase } = await getAuthSupabase(req);
  const x = parsed.data;
  const net = x.gross_amount - x.actual_fee_amount - x.withholding_amount - x.withdrawal_fee_amount;
  if (net < 0) return NextResponse.json({ error: 'Deductions cannot exceed gross amount' }, { status: 400 });

  const { data: expected, error: feeError } = await supabase.schema('finance').rpc('compute_platform_fee_contextual', {
    p_platform_id: x.platform_id, p_amount: x.gross_amount, p_source_type: 'SETTLEMENT',
    p_financial_account_id: x.financial_account_id || null, p_currency: x.currency, p_as_of_date: x.settlement_date,
  });
  if (feeError) return NextResponse.json({ error: `Unable to determine expected fee: ${feeError.message}` }, { status: 400 });
  const expectedFee = Number(expected) || 0;
  const feeVariance = Number((x.actual_fee_amount - expectedFee).toFixed(2));
  if (Math.abs(feeVariance) > 0.01 && (!x.fee_override_reason?.trim() || !x.fee_override_evidence_reference?.trim())) {
    return NextResponse.json({ error: 'Actual fee differs from expected fee. Override reason and evidence are required.' }, { status: 400 });
  }

  const { data, error } = await supabase.schema('finance').rpc('create_platform_settlement_atomic', {
    p_platform_id: x.platform_id, p_financial_account_id: x.financial_account_id || null,
    p_settlement_reference: x.settlement_reference, p_settlement_date: x.settlement_date,
    p_currency: x.currency, p_gross_amount: x.gross_amount, p_expected_fee_amount: expectedFee,
    p_actual_fee_amount: x.actual_fee_amount, p_withholding_amount: x.withholding_amount,
    p_withdrawal_fee_amount: x.withdrawal_fee_amount, p_exchange_rate: x.exchange_rate || null,
    p_notes: x.notes || null, p_fee_variance: feeVariance,
    p_fee_override_reason: x.fee_override_reason || null,
    p_fee_override_evidence_reference: x.fee_override_evidence_reference || null,
    p_lines: null,
  });
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  if (Math.abs(feeVariance) > 0.01) {
    try { await supabase.schema('audit').rpc('log_action', {
      p_user_id: a.userId, p_action: 'SETTLEMENT_FEE_OVERRIDE', p_entity_type: 'settlement_batch', p_entity_id: data,
      p_description: `Settlement fee override: expected ${expectedFee}, actual ${x.actual_fee_amount}`, p_source_module: 'platform_settlements', p_severity: 'medium',
      p_new_values: { expected_fee: expectedFee, actual_fee: x.actual_fee_amount, variance: feeVariance, reason: x.fee_override_reason, evidence: x.fee_override_evidence_reference }
    }); } catch {}
  }
  return NextResponse.json({ data: { id: data, fee_variance: feeVariance, expected_fee_amount: expectedFee } }, { status: 201 });
}
