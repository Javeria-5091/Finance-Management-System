import { NextRequest, NextResponse } from 'next/server';
import { getAuthSupabase, requirePermission } from '@/lib/api-auth';
import { z } from 'zod';

// FND-VP-001 FIX: this file was mistakenly created under
// vendor-payments/batches/ instead of vendor-payments/. The main
// vendor-payments page (src/app/dashboard/vendor-payments/page.tsx) calls
// GET/POST /api/finance/vendor-payments directly, which had no route.ts at
// all -- every request 404'd and Next returned an HTML error page, which
// broke on .json() parsing ("Unexpected token '<'"). This is the same
// server-enforced-permission, server-computed-allocation logic already in
// use (and unchanged) at vendor-payments/batches/route.ts.

const createSchema = z.object({
  vendor_id: z.string().uuid(),
  payment_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  payment_method: z.enum(['BANK_TRANSFER', 'CHEQUE', 'CASH', 'JAZZCASH', 'EASYPAISA', 'PLATFORM', 'OTHER']),
  financial_account_id: z.string().uuid().optional(),
  reference: z.string().trim().max(100).optional(),
  description: z.string().trim().max(500).optional(),
  allocations: z.array(z.object({
    vendor_bill_id: z.string().uuid(),
    allocated_amount: z.number().positive(),
  })).min(1).max(100),
}).strict();

export async function GET(req: NextRequest) {
  const auth = await requirePermission('VENDOR_PAYMENT_READ');
  if (auth instanceof NextResponse) return auth;
  const { supabase } = await getAuthSupabase(req);

  const { data, error } = await supabase
    .schema('finance')
    .from('vendor_payments')
    .select('*, vendor_payment_allocations(id, vendor_bill_id, allocated_amount)')
    .eq('organization_id', auth.orgId)
    .eq('is_batch', false)
    .order('payment_date', { ascending: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ data: data || [] });
}

export async function POST(req: NextRequest) {
  const auth = await requirePermission('VENDOR_PAYMENT_CREATE');
  if (auth instanceof NextResponse) return auth;
  const { supabase } = await getAuthSupabase(req);

  const parsed = createSchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message || 'Invalid request' }, { status: 400 });
  }
  const { vendor_id, payment_method, financial_account_id, reference, description, allocations } = parsed.data;
  const payment_date = parsed.data.payment_date || new Date().toISOString().split('T')[0];

  // 1. Vendor must exist and belong to this org.
  const { data: vendor } = await supabase
    .schema('finance').from('vendors')
    .select('id').eq('id', vendor_id).eq('organization_id', auth.orgId).eq('is_active', true).maybeSingle();
  if (!vendor) return NextResponse.json({ error: 'Vendor not found or inactive' }, { status: 404 });

  // Optional financial account validation (mirrors batch route).
  if (financial_account_id) {
    const { data: account } = await supabase
      .schema('finance').from('financial_accounts')
      .select('id').eq('id', financial_account_id).eq('organization_id', auth.orgId).eq('is_active', true).maybeSingle();
    if (!account) return NextResponse.json({ error: 'Financial account not found or inactive' }, { status: 404 });
  }

  // 2. De-duplicate bill ids from the client and fetch them server-side —
  // NEVER trust a client-sent "outstanding_amount". Only bills that are
  // actually unpaid/partially paid for THIS vendor and THIS org are usable.
  const billIds = [...new Set(allocations.map(a => a.vendor_bill_id))];
  const { data: bills, error: billError } = await supabase
    .schema('finance').from('vendor_bills')
    .select('id, vendor_id, outstanding_amount, status, currency')
    .eq('organization_id', auth.orgId)
    .eq('vendor_id', vendor_id)
    .in('id', billIds)
    .in('status', ['POSTED', 'PARTIALLY_PAID'])
    .gt('outstanding_amount', 0);

  if (billError) return NextResponse.json({ error: billError.message }, { status: 500 });
  if (!bills?.length || bills.length !== billIds.length) {
    return NextResponse.json({
      error: 'One or more selected bills are unavailable, already paid, belong to a different vendor, or outside your organization',
    }, { status: 400 });
  }

  const currencies = new Set(bills.map((b: any) => b.currency || 'PKR'));
  if (currencies.size !== 1) {
    return NextResponse.json({ error: 'All allocated bills must share the same currency' }, { status: 400 });
  }
  const currency = [...currencies][0] as string;

  // 3. Validate each requested allocation against the SERVER's outstanding
  // figure (not whatever the browser sent), and sum a server-computed total.
  const billMap = new Map(bills.map((b: any) => [b.id, b]));
  let total = 0;
  for (const alloc of allocations) {
    const bill = billMap.get(alloc.vendor_bill_id);
    if (!bill) return NextResponse.json({ error: 'Invalid bill in allocation list' }, { status: 400 });
    if (alloc.allocated_amount > Number(bill.outstanding_amount) + 0.01) {
      return NextResponse.json({
        error: `Allocation of ${alloc.allocated_amount} exceeds outstanding balance (${bill.outstanding_amount}) for bill ${bill.id}`,
      }, { status: 400 });
    }
    total += alloc.allocated_amount;
  }
  total = Number(total.toFixed(2));
  if (total <= 0) return NextResponse.json({ error: 'Payment amount must be greater than zero' }, { status: 400 });

  // 4. Payment number + insert (DRAFT — nothing here posts to the GL).
  const { data: numData } = await supabase.schema('finance').rpc('get_next_number', { p_type: 'VENDOR_PAYMENT' });
  const paymentNumber = numData || `VP-${Date.now()}`;

  const { data: payment, error: paymentError } = await supabase
    .schema('finance').from('vendor_payments')
    .insert({
      payment_number: paymentNumber,
      payment_date,
      amount: total,
      currency,
      exchange_rate: 1,
      base_amount: total,
      vendor_id,
      financial_account_id: financial_account_id || null,
      payment_method,
      reference: reference || null,
      description: description || null,
      status: 'DRAFT',
      is_batch: false,
      created_by: auth.userId,
      organization_id: auth.orgId,
    })
    .select()
    .single();

  if (paymentError || !payment) {
    return NextResponse.json({ error: paymentError?.message || 'Failed to create payment' }, { status: 500 });
  }

  // 5. Allocations. The DB trigger finance.auto_update_bill_status() (on
  // vendor_payment_allocations) recalculates the bill's outstanding_amount
  // and status automatically — the app must NOT set bill status directly
  // (that was the root cause of BUG-010's blanket "PAID" bug).
  const allocRows = allocations.map(a => ({
    vendor_payment_id: payment.id,
    vendor_bill_id: a.vendor_bill_id,
    allocated_amount: a.allocated_amount,
    base_allocated_amount: a.allocated_amount,
    allocated_by: auth.userId,
  }));
  const { error: allocError } = await supabase.schema('finance').from('vendor_payment_allocations').insert(allocRows);
  if (allocError) {
    // Roll back the orphaned DRAFT payment.
    await supabase.schema('finance').from('vendor_payments').delete().eq('id', payment.id).eq('organization_id', auth.orgId);
    return NextResponse.json({ error: `Allocation failed: ${allocError.message}` }, { status: 500 });
  }

  try {
    await supabase.schema('audit').rpc('log_action', {
      p_user_id: auth.userId, p_action: 'VENDOR_PAYMENT_CREATED', p_entity_type: 'vendor_payment',
      p_entity_id: payment.id,
      p_description: `Created vendor payment ${paymentNumber} (${currency} ${total}) for vendor ${vendor_id}`,
      p_previous_status: null, p_new_status: 'DRAFT', p_source_module: 'vendor_payment',
      p_severity: 'medium',
      p_new_values: { amount: total, currency, vendor_id, bill_count: bills.length },
    });
  } catch (auditErr: any) {
    console.error('Audit log failed for vendor payment create:', auditErr);
  }

  return NextResponse.json({ success: true, payment }, { status: 201 });
}