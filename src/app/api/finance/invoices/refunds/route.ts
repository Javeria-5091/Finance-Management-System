import { NextRequest, NextResponse } from 'next/server';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { getAuthSupabase, requirePermission } from '@/lib/api-auth';
import { enforceMFA } from '@/lib/mfa-middleware';
import { validateExchangeRate } from '@/lib/validations';

const createRefundSchema = z.object({
  invoice_id: z.string().uuid(),
  amount: z.coerce.number().finite().positive().max(9999999999999999.99),
  exchange_rate: z.coerce.number().finite().positive().optional(),
  reason: z.string().trim().min(5).max(2000),
  financial_account_id: z.string().uuid().nullable().optional(),
}).strict();

function makeRefundNumber(): string {
  return `REF-${Date.now()}-${randomBytes(4).toString('hex').toUpperCase()}`;
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

  const parsed = createRefundSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message || 'Invalid refund data' },
      { status: 400 },
    );
  }

  const b = parsed.data;

  const { data: inv, error: ie } = await supabase
    .from('invoices')
    .select('id,total_amount,amount_paid,outstanding_amount,currency,exchange_rate,status,organization_id')
    .eq('id', b.invoice_id)
    .eq('organization_id', auth.orgId)
    .single();

  if (ie || !inv) {
    return NextResponse.json({ error: 'Invoice not found' }, { status: 404 });
  }

  if (!['ISSUED', 'PARTIALLY_PAID', 'PAID', 'OVERDUE', 'REFUNDED'].includes(inv.status)) {
    return NextResponse.json(
      { error: 'Refunds can only be created for an issued/paid invoice' },
      { status: 409 },
    );
  }

  const { data: priorRefunds, error: priorRefundError } = await supabase
    .schema('finance')
    .from('invoice_refunds')
    .select('amount,status')
    .eq('invoice_id', inv.id)
    .eq('organization_id', auth.orgId)
    .in('status', ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'POSTED', 'PAID']);

  if (priorRefundError) {
    return NextResponse.json({ error: priorRefundError.message }, { status: 400 });
  }

  const alreadyRefunded = (priorRefunds ?? []).reduce(
    (sum, refund) => sum + Number(refund.amount || 0),
    0,
  );
  const amountPaid = Number(inv.amount_paid || 0);

  if (alreadyRefunded + b.amount > amountPaid + 0.01) {
    return NextResponse.json(
      { error: 'Cumulative refunds cannot exceed the amount already paid' },
      { status: 422 },
    );
  }

  const invoiceRateError = validateExchangeRate(inv.currency, inv.exchange_rate);
  if (invoiceRateError) {
    return NextResponse.json({ error: invoiceRateError }, { status: 400 });
  }

  const invoiceRate = Number(inv.exchange_rate || 1);
  const requestedRate = b.exchange_rate ?? invoiceRate;

  // Refunds belong to the original invoice's currency valuation. Do not allow
  // callers to inject a different/arbitrary FX rate into the financial table.
  const requestedRateError = validateExchangeRate(inv.currency, requestedRate);
  if (requestedRateError) {
    return NextResponse.json({ error: requestedRateError }, { status: 400 });
  }

  if (requestedRate !== invoiceRate) {
    return NextResponse.json(
      { error: 'Refund exchange_rate must match the invoice exchange_rate' },
      { status: 400 },
    );
  }

  if (b.financial_account_id) {
    const { data: financialAccount } = await supabase
      .schema('finance')
      .from('financial_accounts')
      .select('id')
      .eq('id', b.financial_account_id)
      .eq('organization_id', auth.orgId)
      .eq('is_active', true)
      .maybeSingle();

    if (!financialAccount) {
      return NextResponse.json(
        { error: 'Financial account not found, inactive, or outside your organization' },
        { status: 400 },
      );
    }
  }

  // The DB has a UNIQUE (organization_id, refund_number) constraint. The
  // random suffix makes same-millisecond concurrent requests practically
  // collision-free while retaining the existing REF-* numbering format.
  const refundNumber = makeRefundNumber();

  const { data, error } = await supabase
    .schema('finance')
    .from('invoice_refunds')
    .insert({
      invoice_id: inv.id,
      organization_id: auth.orgId,
      refund_number: refundNumber,
      amount: b.amount,
      currency: (inv.currency || 'PKR').toUpperCase(),
      exchange_rate: invoiceRate,
      reason: b.reason,
      status: 'DRAFT',
      financial_account_id: b.financial_account_id ?? null,
      created_by: auth.userId,
    })
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }

  return NextResponse.json({ data }, { status: 201 });
}

export async function GET(req: NextRequest) {
  const auth = await requirePermission('INVOICE_READ');
  if (auth instanceof NextResponse) return auth;

  const { supabase } = await getAuthSupabase(req);
  const invoiceId = new URL(req.url).searchParams.get('invoice_id');

  if (invoiceId && !z.string().uuid().safeParse(invoiceId).success) {
    return NextResponse.json({ error: 'Invalid invoice_id' }, { status: 400 });
  }

  let q = supabase
    .schema('finance')
    .from('invoice_refunds')
    .select('*')
    .eq('organization_id', auth.orgId);

  if (invoiceId) q = q.eq('invoice_id', invoiceId);

  const { data, error } = await q.order('created_at', { ascending: false });
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  return NextResponse.json({ data: data ?? [] });
}
