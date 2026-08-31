import { NextRequest, NextResponse } from 'next/server';
import { getAuthSupabase, requirePermission } from '@/lib/api-auth';
import { enforceMFA } from '@/lib/mfa-middleware';
import { z } from 'zod';

const actionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('capitalize'), asset_id: z.string().uuid() }),
  z.object({
    action: z.literal('dispose'), asset_id: z.string().uuid(), disposal_date: z.string().date(),
    disposal_value: z.number().finite().nonnegative(), disposal_currency: z.string().trim().min(3).max(10),
    disposal_method: z.string().trim().min(1).max(100),
  }),
  z.object({
    action: z.literal('impair'), asset_id: z.string().uuid(), adjustment_date: z.string().date(),
    amount: z.number().finite().positive(), reason: z.string().trim().min(1).max(1000),
  }),
  z.object({
    action: z.literal('transfer'), asset_id: z.string().uuid(), transfer_date: z.string().date(),
    location: z.string().trim().max(200).nullable().optional(), assigned_user_id: z.string().uuid().nullable().optional(),
    project_id: z.string().uuid().nullable().optional(), department_id: z.string().uuid().nullable().optional(),
    cost_center_id: z.string().uuid().nullable().optional(), reason: z.string().trim().min(1).max(1000),
  }),
  z.object({ action: z.literal('generate_depreciation'), period_id: z.string().uuid() }),
  z.object({ action: z.literal('post_depreciation'), period_id: z.string().uuid() }),
]);

const permissions: Record<string, string> = {
  capitalize: 'FIXED_ASSET_CAPITALIZE',
  dispose: 'FIXED_ASSET_DISPOSE',
  impair: 'FIXED_ASSET_UPDATE',
  transfer: 'FIXED_ASSET_UPDATE',
  generate_depreciation: 'FIXED_ASSET_DEPR_GENERATE',
  post_depreciation: 'FIXED_ASSET_DEPR_POST',
};

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const parsed = actionSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message || 'Invalid request' }, { status: 400 });

  const auth = await requirePermission(permissions[parsed.data.action] as any);
  if (auth instanceof NextResponse) return auth;
  const mfa = await enforceMFA(auth);
  if (mfa) return mfa;
  const { supabase } = await getAuthSupabase(req);

  try {
    const b = parsed.data;
    let data: unknown;
    if (b.action === 'capitalize') {
      const r = await supabase.schema('finance').rpc('post_asset_capitalization', { p_asset_id: b.asset_id, p_posted_by: auth.userId });
      if (r.error) throw r.error; data = r.data;
    } else if (b.action === 'dispose') {
      const r = await supabase.schema('finance').rpc('post_asset_disposal', {
        p_asset_id: b.asset_id, p_disposal_date: b.disposal_date, p_disposal_value: b.disposal_value,
        p_disposal_currency: b.disposal_currency.toUpperCase(), p_disposal_method: b.disposal_method,
      });
      if (r.error) throw r.error; data = r.data;
    } else if (b.action === 'impair') {
      const r = await supabase.schema('finance').rpc('post_asset_impairment', {
        p_asset_id: b.asset_id, p_adjustment_date: b.adjustment_date, p_amount: b.amount,
        p_reason: b.reason, p_posted_by: auth.userId,
      });
      if (r.error) throw r.error; data = r.data;
    } else if (b.action === 'transfer') {
      const r = await supabase.schema('finance').rpc('post_asset_transfer', {
        p_asset_id: b.asset_id, p_transfer_date: b.transfer_date, p_location: b.location ?? null,
        p_assigned_user_id: b.assigned_user_id ?? null, p_project_id: b.project_id ?? null,
        p_department_id: b.department_id ?? null, p_cost_center_id: b.cost_center_id ?? null,
        p_reason: b.reason, p_posted_by: auth.userId,
      });
      if (r.error) throw r.error; data = r.data;
    } else if (b.action === 'generate_depreciation') {
      const r = await supabase.schema('finance').rpc('fn_generate_depreciation_for_period', { p_period_id: b.period_id, p_created_by: auth.userId });
      if (r.error) throw r.error;
      const rows = (r.data ?? []) as Array<{ depreciation_amount: number }>;
      data = { generated: rows.length, total_amount: rows.reduce((s, x) => s + Number(x.depreciation_amount || 0), 0), details: rows };
    } else {
      const r = await supabase.schema('finance').rpc('post_depreciation_for_period', { p_period_id: b.period_id, p_created_by: auth.userId });
      if (r.error) throw r.error;
      data = { posted: Number(r.data || 0), total_amount: 0 };
    }
    return NextResponse.json({ data });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'Fixed asset operation failed' }, { status: 400 });
  }
}
