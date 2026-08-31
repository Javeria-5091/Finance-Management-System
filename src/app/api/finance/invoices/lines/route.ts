import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getAuthSupabase, requirePermission } from '@/lib/api-auth';
import { enforceMFA } from '@/lib/mfa-middleware';
import { validateExchangeRate } from '@/lib/validations';

const invoiceLineSchema = z.object({
  description: z.string().trim().min(1).max(1000).default('Item'),
  quantity: z.coerce.number().finite().positive().default(1),
  unit_price: z.coerce.number().finite().min(0).default(0),
  discount_amount: z.coerce.number().finite().min(0).default(0),
  tax_code_id: z.string().uuid().nullable().optional(),
  tax_rate: z.coerce.number().finite().min(0).max(100).default(0),
  account_id: z.string().uuid().nullable().optional(),
  project_id: z.string().uuid().nullable().optional(),
}).strict();

const createLinesSchema = z.object({
  invoice_id: z.string().uuid(),
  lines: z.array(invoiceLineSchema).min(1).max(500),
}).strict();

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

  const parsed = createLinesSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message || 'Invalid invoice line data' },
      { status: 400 },
    );
  }

  const { invoice_id, lines: inputLines } = parsed.data;

  const { data: inv, error: ie } = await supabase
    .from('invoices')
    .select('id,currency,exchange_rate,status,organization_id')
    .eq('id', invoice_id)
    .eq('organization_id', auth.orgId)
    .single();

  if (ie || !inv) {
    return NextResponse.json({ error: 'Invoice not found' }, { status: 404 });
  }

  if (!['DRAFT', 'SUBMITTED'].includes(inv.status)) {
    return NextResponse.json(
      { error: 'Invoice lines can only be changed before approval' },
      { status: 409 },
    );
  }

  const rateError = validateExchangeRate(inv.currency, inv.exchange_rate);
  if (rateError) {
    return NextResponse.json({ error: rateError }, { status: 400 });
  }

  const accountIds = [...new Set(inputLines.map((l) => l.account_id).filter(Boolean))] as string[];
  const projectIds = [...new Set(inputLines.map((l) => l.project_id).filter(Boolean))] as string[];
  const taxCodeIds = [...new Set(inputLines.map((l) => l.tax_code_id).filter(Boolean))] as string[];

  if (accountIds.length) {
    const { data, error } = await supabase
      .schema('finance')
      .from('chart_of_accounts')
      .select('id')
      .eq('organization_id', auth.orgId)
      .in('id', accountIds);
    if (error || (data?.length ?? 0) !== accountIds.length) {
      return NextResponse.json({ error: 'One or more account_id values are invalid or outside your organization' }, { status: 400 });
    }
  }

  if (projectIds.length) {
    const { data, error } = await supabase
      .from('projects')
      .select('id')
      .eq('organization_id', auth.orgId)
      .in('id', projectIds);
    if (error || (data?.length ?? 0) !== projectIds.length) {
      return NextResponse.json({ error: 'One or more project_id values are invalid or outside your organization' }, { status: 400 });
    }
  }

  if (taxCodeIds.length) {
    const { data, error } = await supabase
      .schema('finance')
      .from('tax_codes')
      .select('id')
      .eq('organization_id', auth.orgId)
      .in('id', taxCodeIds);
    if (error || (data?.length ?? 0) !== taxCodeIds.length) {
      return NextResponse.json({ error: 'One or more tax_code_id values are invalid or outside your organization' }, { status: 400 });
    }
  }

  let subtotal = 0;
  let discount = 0;
  let tax = 0;
  const exchangeRate = Number(inv.exchange_rate || 1);

  const lines = inputLines.map((l, i) => {
    const sub = l.quantity * l.unit_price;
    const disc = Math.min(l.discount_amount, sub);
    const taxAmt = (sub - disc) * l.tax_rate / 100;
    const total = sub - disc + taxAmt;

    subtotal += sub;
    discount += disc;
    tax += taxAmt;

    return {
      invoice_id: inv.id,
      organization_id: auth.orgId,
      line_number: i + 1,
      description: l.description,
      quantity: l.quantity,
      unit_price: l.unit_price,
      line_subtotal: sub,
      discount_amount: disc,
      tax_code_id: l.tax_code_id ?? null,
      tax_rate: l.tax_rate,
      tax_amount: taxAmt,
      line_total: total,
      base_line_subtotal: sub * exchangeRate,
      base_tax_amount: taxAmt * exchangeRate,
      base_line_total: total * exchangeRate,
      account_id: l.account_id ?? null,
      project_id: l.project_id ?? null,
      created_by: auth.userId,
    };
  });

  const total = subtotal - discount + tax;

  const { error: de } = await supabase
    .schema('finance')
    .from('invoice_lines')
    .delete()
    .eq('invoice_id', inv.id)
    .eq('organization_id', auth.orgId);

  if (de) {
    return NextResponse.json({ error: de.message }, { status: 400 });
  }

  const { data: insertedLines, error: insertError } = await supabase
    .schema('finance')
    .from('invoice_lines')
    .insert(lines)
    .select();

  if (insertError) {
    return NextResponse.json({ error: insertError.message }, { status: 400 });
  }

  const { data: updated, error: ue } = await supabase
    .from('invoices')
    .update({
      amount: total,
      subtotal,
      tax_amount: tax,
      discount_amount: discount,
      total_amount: total,
      outstanding_amount: total,
      base_subtotal: subtotal * exchangeRate,
      base_tax_amount: tax * exchangeRate,
      base_discount_amount: discount * exchangeRate,
      base_total_amount: total * exchangeRate,
      base_outstanding_amount: total * exchangeRate,
    })
    .eq('id', inv.id)
    .eq('organization_id', auth.orgId)
    .select()
    .single();

  if (ue) {
    return NextResponse.json({ error: ue.message }, { status: 400 });
  }

  return NextResponse.json(
    {
      data: updated,
      lines: insertedLines,
      totals: { subtotal, discount, tax, total },
    },
    { status: 201 },
  );
}
