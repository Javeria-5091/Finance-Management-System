import { NextRequest, NextResponse } from 'next/server';
import { getAuthSupabase, requirePermission } from '@/lib/api-auth';
import { z } from 'zod';

const createSchema = z.object({ fiscal_year_id: z.string().uuid() }).strict();

export async function POST(req: NextRequest) {
  const auth = await requirePermission('EQUITY_MANAGE');
  if (auth instanceof NextResponse) return auth;
  const { supabase } = await getAuthSupabase(req);
  const parsed = createSchema.safeParse(await req.json());
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message || 'Invalid request' }, { status: 400 });
  const { data, error } = await supabase.schema('finance').rpc('create_profit_distribution_from_posted_pnl', { p_fiscal_year_id: parsed.data.fiscal_year_id });
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ data }, { status: 201 });
}
