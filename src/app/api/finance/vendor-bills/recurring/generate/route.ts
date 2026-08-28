import { NextRequest, NextResponse } from 'next/server';
import { getAuthSupabase, requirePermission } from '@/lib/api-auth';
import { z } from 'zod';

const schema = z.object({ id: z.string().uuid(), run_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() });

function addPeriod(date: string, frequency: string) {
  const d = new Date(`${date}T00:00:00Z`);
  if (frequency === 'MONTHLY') d.setUTCMonth(d.getUTCMonth() + 1);
  else if (frequency === 'QUARTERLY') d.setUTCMonth(d.getUTCMonth() + 3);
  else d.setUTCFullYear(d.getUTCFullYear() + 1);
  return d.toISOString().slice(0, 10);
}

export async function POST(req: NextRequest) {
  const auth = await requirePermission('VENDOR_BILL_CREATE');
  if (auth instanceof NextResponse) return auth;
  const { supabase } = await getAuthSupabase(req);
  const parsed = schema.safeParse(await req.json());
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message }, { status: 400 });
  const { id } = parsed.data;
  const runDate = parsed.data.run_date || new Date().toISOString().slice(0,10);

  const { data: template, error: templateError } = await supabase.schema('finance').from('recurring_vendor_bills')
    .select('*').eq('id', id).eq('organization_id', auth.orgId).maybeSingle();
  if (templateError) return NextResponse.json({ error: templateError.message }, { status: 500 });
  if (!template) return NextResponse.json({ error: 'Recurring bill template not found' }, { status: 404 });
  if (!template.is_active) return NextResponse.json({ error: 'Recurring bill template is inactive' }, { status: 400 });
  if (template.end_date && runDate > template.end_date) return NextResponse.json({ error: 'Template has passed its end date' }, { status: 400 });
  if (runDate < template.next_run_date) return NextResponse.json({ error: `Next run is ${template.next_run_date}` }, { status: 409 });

  const lines = Array.isArray(template.template_lines) ? template.template_lines : [];
  if (!lines.length) return NextResponse.json({ error: 'Recurring template has no lines' }, { status: 400 });

  const calculated = lines.map((l: any, i: number) => {
    const qty = Number(l.quantity || 1);
    const unit = Number(l.unit_price || 0);
    const base = qty * unit;
    const tax = Number((base * Number(l.tax_rate || 0) / 100).toFixed(2));
    const wht = Number((base * Number(l.withholding_rate || 0) / 100).toFixed(2));
    return {
      line_number: i + 1,
      account_id: l.account_id,
      description: l.description,
      quantity: qty,
      unit_price: unit,
      tax_rate: Number(l.tax_rate || 0),
      tax_amount: tax,
      withholding_rate: Number(l.withholding_rate || 0),
      withholding_amount: wht,
      line_total: Number((base + tax - wht).toFixed(2)),
      project_id: l.project_id || template.project_id || null,
    };
  });

  const subtotal = Number(calculated.reduce((s: number, l: any) => s + l.quantity * l.unit_price, 0).toFixed(2));
  const taxAmount = Number(calculated.reduce((s: number, l: any) => s + l.tax_amount, 0).toFixed(2));
  const withholdingAmount = Number(calculated.reduce((s: number, l: any) => s + l.withholding_amount, 0).toFixed(2));
  const total = Number((subtotal + taxAmount - withholdingAmount).toFixed(2));
  if (total <= 0) return NextResponse.json({ error: 'Recurring bill total must be greater than zero' }, { status: 400 });

  const { data: numberData } = await supabase.schema('finance').rpc('get_next_number', { p_type: 'VENDOR_BILL' });
  const billNumber = numberData || `VB-${Date.now()}`;
  const dueDate = new Date(`${runDate}T00:00:00Z`);
  dueDate.setUTCDate(dueDate.getUTCDate() + Number(template.due_days || 0));

  const { data: bill, error: billError } = await supabase.schema('finance').from('vendor_bills').insert({
    bill_number: billNumber,
    vendor_id: template.vendor_id,
    project_id: template.project_id,
    bill_date: runDate,
    due_date: dueDate.toISOString().slice(0,10),
    currency: template.currency,
    exchange_rate: template.exchange_rate,
    subtotal,
    tax_amount: taxAmount,
    withholding_amount: withholdingAmount,
    discount_amount: 0,
    total_amount: total,
    base_subtotal: Number((subtotal * template.exchange_rate).toFixed(2)),
    base_tax_amount: Number((taxAmount * template.exchange_rate).toFixed(2)),
    base_withholding_amount: Number((withholdingAmount * template.exchange_rate).toFixed(2)),
    base_discount_amount: 0,
    base_total_amount: Number((total * template.exchange_rate).toFixed(2)),
    amount_paid: 0,
    outstanding_amount: total,
    status: 'DRAFT',
    description: template.description || `Recurring bill: ${template.template_name}`,
    created_by: auth.userId,
    organization_id: auth.orgId,
  }).select().single();
  if (billError || !bill) return NextResponse.json({ error: billError?.message || 'Failed to create bill' }, { status: 500 });

  const { error: lineError } = await supabase.schema('finance').from('vendor_bill_lines').insert(
    calculated.map((l: any) => ({ ...l, vendor_bill_id: bill.id }))
  );
  if (lineError) {
    await supabase.schema('finance').from('vendor_bills').delete().eq('id', bill.id).eq('organization_id', auth.orgId);
    return NextResponse.json({ error: `Bill lines failed: ${lineError.message}` }, { status: 500 });
  }

  const nextRun = addPeriod(template.next_run_date, template.frequency);
  await supabase.schema('finance').from('recurring_vendor_bills').update({
    last_generated_date: runDate,
    next_run_date: nextRun,
    updated_at: new Date().toISOString(),
    is_active: template.end_date ? nextRun <= template.end_date : true,
  }).eq('id', id).eq('organization_id', auth.orgId);

  return NextResponse.json({ success: true, bill, next_run_date: nextRun });
}
