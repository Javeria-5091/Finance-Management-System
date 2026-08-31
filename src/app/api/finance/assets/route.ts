import { NextRequest, NextResponse } from 'next/server';
import { getAuthSupabase, requirePermission } from '@/lib/api-auth';
import { enforceMFA } from '@/lib/mfa-middleware';
import { z } from 'zod';

const createSchema = z.object({
  name: z.string().trim().min(1).max(300), category_id: z.string().uuid(), description: z.string().max(5000).optional(),
  vendor_id: z.string().uuid().optional().or(z.literal('')), purchase_date: z.string().date(),
  purchase_cost: z.coerce.number().finite().nonnegative(), currency: z.string().trim().length(3).transform((v: string) => v.toUpperCase()),
  base_cost: z.coerce.number().finite().nonnegative(), serial_number: z.string().max(200).optional(),
  warranty_start: z.string().date().optional().or(z.literal('')), warranty_end: z.string().date().optional().or(z.literal('')),
  location: z.string().max(200).optional(), assigned_user_id: z.string().uuid().optional().or(z.literal('')),
  useful_life_months: z.coerce.number().int().positive().optional(), residual_value_pct: z.coerce.number().min(0).max(100).optional(),
  depreciation_method: z.enum(['straight_line','declining_balance','units_of_production']).optional(), residual_value_amount: z.coerce.number().nonnegative().optional(),
  project_id: z.string().uuid().optional().or(z.literal('')), department_id: z.string().uuid().optional().or(z.literal('')), cost_center_id: z.string().uuid().optional().or(z.literal('')),
  linked_asset_account_id: z.string().uuid().optional().or(z.literal('')), linked_depreciation_account_id: z.string().uuid().optional().or(z.literal('')), linked_expense_account_id: z.string().uuid().optional().or(z.literal('')),
  financial_account_id: z.string().uuid().optional().or(z.literal('')),
});

export async function POST(req: NextRequest) {
  const auth = await requirePermission('FIXED_ASSET_CREATE');
  if (auth instanceof NextResponse) return auth;
  const mfa = await enforceMFA(auth); if (mfa) return mfa;
  const parsed = createSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message || 'Invalid asset data' }, { status: 400 });
  const { supabase } = await getAuthSupabase(req);
  const { data, error } = await supabase.schema('finance').rpc('create_fixed_asset', { p_input: parsed.data, p_created_by: auth.userId });
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ data }, { status: 201 });
}
