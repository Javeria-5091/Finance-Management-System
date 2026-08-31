import { NextRequest, NextResponse } from 'next/server';
import { getAuthSupabase, requirePermission } from '@/lib/api-auth';
import { z } from 'zod';

const lineSchema = z.object({
  line_number: z.number().int().positive(),
  account_id: z.string().uuid(),
  description: z.string().trim().min(1).max(500),
  quantity: z.number().finite().positive(),
  unit_price: z.number().finite().nonnegative(),
  tax_code_id: z.string().uuid().nullable().optional(),
  tax_rate: z.number().finite().min(0).max(100),
  tax_amount: z.number().finite().nonnegative(),
  withholding_rate: z.number().finite().min(0).max(100),
  withholding_amount: z.number().finite().nonnegative(),
  line_total: z.number().finite().nonnegative(),
  project_id: z.string().uuid().nullable().optional(),
}).strict();

const billSchema = z.object({
  vendor_id: z.string().uuid(),
  project_id: z.string().uuid().nullable().optional(),
  bill_date: z.string().date(),
  due_date: z.string().date().nullable().optional(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  exchange_rate: z.number().finite().positive(),
  description: z.string().max(2000).nullable().optional(),
  subtotal: z.number().finite().nonnegative(),
  tax_amount: z.number().finite().nonnegative(),
  withholding_amount: z.number().finite().nonnegative(),
  discount_amount: z.number().finite().nonnegative(),
  total_amount: z.number().finite().nonnegative(),
  base_subtotal: z.number().finite().nonnegative(),
  base_tax_amount: z.number().finite().nonnegative(),
  base_withholding_amount: z.number().finite().nonnegative(),
  base_discount_amount: z.number().finite().nonnegative(),
  base_total_amount: z.number().finite().nonnegative(),
  amount_paid: z.number().finite().nonnegative().default(0),
  outstanding_amount: z.number().finite().nonnegative(),
  status: z.literal('DRAFT'),
}).strict();

const requestSchema = z.object({
  id: z.string().uuid().nullable().optional(),
  bill: billSchema,
  lines: z.array(lineSchema).min(1).max(200),
}).strict();

export async function POST(req: NextRequest) {
  const auth = await requirePermission('VENDOR_BILL_CREATE');
  if (auth instanceof NextResponse) return auth;
  const { supabase } = await getAuthSupabase(req);
  const parsed = requestSchema.safeParse(await req.json());
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message || 'Invalid vendor bill' }, { status: 400 });

  const { id, bill, lines } = parsed.data;
  try {
    const { data, error } = await supabase.schema('finance').rpc('save_vendor_bill_atomic', {
      p_bill_id: id || null,
      p_payload: bill,
      p_lines: lines,
      p_user_id: auth.userId,
      p_organization_id: auth.orgId,
    });
    if (error) return NextResponse.json({ error: error.message }, { status: 400 });
    return NextResponse.json({ success: true, data }, { status: id ? 200 : 201 });
  } catch (error: any) {
    return NextResponse.json({ error: error?.message || 'Failed to save vendor bill' }, { status: 500 });
  }
}
