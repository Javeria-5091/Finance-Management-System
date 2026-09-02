import { NextRequest, NextResponse } from 'next/server';
import { getAuthSupabase, requirePermission } from '@/lib/api-auth';
import { z } from 'zod';

const allocationSchema = z.object({
  vendor_bill_id: z.string().uuid(),
  allocated_amount: z.number().positive(),
}).strict();

const paymentGroupSchema = z.object({
  vendor_id: z.string().uuid(),
  allocations: z.array(allocationSchema).min(1).max(100),
}).strict();

const createSchema = z.object({
  payment_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  financial_account_id: z.string().uuid(),
  payment_method: z.enum(['BANK_TRANSFER', 'CHEQUE', 'CASH', 'PLATFORM', 'OTHER']),
  reference: z.string().trim().max(100).optional(),
  description: z.string().trim().max(500).optional(),
  payments: z.array(paymentGroupSchema).min(1).max(100),
}).strict();

export async function GET(req: NextRequest) {
  const auth = await requirePermission('VENDOR_PAYMENT_READ');
  if (auth instanceof NextResponse) return auth;
  const { supabase } = await getAuthSupabase(req);

  const { data: batches, error } = await supabase
    .schema('finance')
    .from('vendor_payment_batches')
    .select('*')
    .eq('organization_id', auth.orgId)
    .order('payment_date', { ascending: false })
    .order('created_at', { ascending: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Keep the list response compatible with the existing page while deriving
  // counts/totals from the authoritative batch header rather than columns on
  // vendor_payments (which never had batch_number/payment_count/total_amount).
  return NextResponse.json({ data: batches || [] });
}

export async function POST(req: NextRequest) {
  const auth = await requirePermission('VENDOR_PAYMENT_CREATE');
  if (auth instanceof NextResponse) return auth;
  const { supabase } = await getAuthSupabase(req);

  const parsed = createSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message || 'Invalid request' },
      { status: 400 }
    );
  }

  const { data, error } = await supabase.schema('finance').rpc(
    'create_vendor_payment_batch_atomic',
    {
      p_organization_id: auth.orgId,
      p_user_id: auth.userId,
      p_payment_date: parsed.data.payment_date || new Date().toISOString().split('T')[0],
      p_financial_account_id: parsed.data.financial_account_id,
      p_payment_method: parsed.data.payment_method,
      p_reference: parsed.data.reference || null,
      p_description: parsed.data.description || null,
      p_payments: parsed.data.payments,
    }
  );

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }

  return NextResponse.json({ success: true, batch: data }, { status: 201 });
}
