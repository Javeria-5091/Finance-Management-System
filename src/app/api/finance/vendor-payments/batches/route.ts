import { NextRequest, NextResponse } from 'next/server';
import { getAuthSupabase, requirePermission } from '@/lib/api-auth';
import { z } from 'zod';

const createSchema = z.object({
  payment_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  financial_account_id: z.string().uuid(),
  bill_ids: z.array(z.string().uuid()).min(1).max(200),
}).strict();

export async function GET(req: NextRequest) {
  const auth = await requirePermission('VENDOR_PAYMENT_READ');
  if (auth instanceof NextResponse) return auth;
  const { supabase } = await getAuthSupabase(req);
  const { data, error } = await supabase.schema('finance').from('vendor_payment_batches')
    .select('*, vendor_payment_batch_lines(*, vendor_payment:vendor_payment_id(payment_number,amount,vendor_id,status))')
    .eq('organization_id', auth.orgId).order('created_at', { ascending: false });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ data: data || [] });
}

export async function POST(req: NextRequest) {
  const auth = await requirePermission('VENDOR_PAYMENT_CREATE');
  if (auth instanceof NextResponse) return auth;
  const { supabase } = await getAuthSupabase(req);
  const parsed = createSchema.safeParse(await req.json());
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message }, { status: 400 });
  const { payment_date, financial_account_id, bill_ids } = parsed.data;

  const { data: account } = await supabase.schema('finance').from('financial_accounts').select('id')
    .eq('id', financial_account_id).eq('organization_id', auth.orgId).eq('is_active', true).maybeSingle();
  if (!account) return NextResponse.json({ error: 'Financial account not found or inactive' }, { status: 404 });

  const { data: bills, error: billError } = await supabase.schema('finance').from('vendor_bills')
    .select('id,vendor_id,total_amount,amount_paid,outstanding_amount,currency')
    .eq('organization_id', auth.orgId).in('id', bill_ids)
    .in('status', ['POSTED','PARTIALLY_PAID']).gt('outstanding_amount', 0);
  if (billError) return NextResponse.json({ error: billError.message }, { status: 500 });
  if (!bills?.length || bills.length !== bill_ids.length) return NextResponse.json({ error: 'One or more bills are unavailable, already paid, or outside your organization' }, { status: 400 });

  const currencies = new Set(bills.map((b: any) => b.currency || 'PKR'));
  if (currencies.size !== 1) return NextResponse.json({ error: 'A payment batch must contain one currency' }, { status: 400 });

  const grouped = new Map<string, number>();
  for (const bill of bills as any[]) grouped.set(bill.vendor_id, (grouped.get(bill.vendor_id) || 0) + Number(bill.outstanding_amount));

  const { data: batchNo } = await supabase.schema('finance').rpc('get_next_number', { p_type: 'VENDOR_PAYMENT_BATCH' });
  const batchNumber = batchNo || `VPB-${Date.now()}`;
  const total = bills.reduce((s: number, b: any) => s + Number(b.outstanding_amount), 0);

  const { data: batch, error: batchError } = await supabase.schema('finance').from('vendor_payment_batches').insert({
    organization_id: auth.orgId, batch_number: batchNumber, payment_date, financial_account_id,
    status: 'DRAFT', total_amount: Number(total.toFixed(2)), payment_count: bills.length,
    risk_flags: bills.length > 25 ? ['LARGE_BATCH'] : [], created_by: auth.userId,
  }).select().single();
  if (batchError || !batch) return NextResponse.json({ error: batchError?.message || 'Failed to create batch' }, { status: 500 });

  const paymentRows = Array.from(grouped.entries()).map(([vendor_id, amount]) => ({
    payment_number: null, payment_date, amount: Number(amount.toFixed(2)), currency: [...currencies][0],
    exchange_rate: 1, base_amount: Number(amount.toFixed(2)), vendor_id, financial_account_id,
    payment_method: 'BANK_TRANSFER', description: `Payment batch ${batchNumber}`, status: 'DRAFT',
    is_batch: true, batch_id: batch.id, created_by: auth.userId, organization_id: auth.orgId,
  }));
  const { data: payments, error: paymentError } = await supabase.schema('finance').from('vendor_payments').insert(paymentRows).select('id,vendor_id,amount');
  if (paymentError || !payments) {
    await supabase.schema('finance').from('vendor_payment_batches').delete().eq('id', batch.id).eq('organization_id', auth.orgId);
    return NextResponse.json({ error: paymentError?.message || 'Failed to create payment proposals' }, { status: 500 });
  }

  const allocationRows: any[] = [];
  for (const payment of payments as any[]) {
    for (const bill of bills as any[]) {
      if (bill.vendor_id !== payment.vendor_id) continue;
      allocationRows.push({ vendor_payment_id: payment.id, vendor_bill_id: bill.id,
        allocated_amount: Number(bill.outstanding_amount), base_allocated_amount: Number(bill.outstanding_amount), allocated_by: auth.userId });
    }
  }
  const { error: allocError } = await supabase.schema('finance').from('vendor_payment_allocations').insert(allocationRows);
  if (allocError) {
    await supabase.schema('finance').from('vendor_payments').delete().eq('batch_id', batch.id).eq('organization_id', auth.orgId);
    await supabase.schema('finance').from('vendor_payment_batches').delete().eq('id', batch.id).eq('organization_id', auth.orgId);
    return NextResponse.json({ error: `Payment allocations failed: ${allocError.message}` }, { status: 500 });
  }

  const batchLines = (payments as any[]).map(p => ({ batch_id: batch.id, vendor_payment_id: p.id, organization_id: auth.orgId, amount: p.amount }));
  const { error: lineError } = await supabase.schema('finance').from('vendor_payment_batch_lines').insert(batchLines);
  if (lineError) {
    await supabase.schema('finance').from('vendor_payments').delete().eq('batch_id', batch.id).eq('organization_id', auth.orgId);
    await supabase.schema('finance').from('vendor_payment_batches').delete().eq('id', batch.id).eq('organization_id', auth.orgId);
    return NextResponse.json({ error: `Batch lines failed: ${lineError.message}` }, { status: 500 });
  }

  return NextResponse.json({ success: true, batch, payments }, { status: 201 });
}
