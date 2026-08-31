import { NextResponse } from 'next/server';
import { requirePermission, getAuthSupabase } from '@/lib/api-auth';

export async function GET() {
  const auth = await requirePermission('FIXED_ASSET_CREATE');
  if (auth instanceof NextResponse) return auth;
  const { supabase } = await getAuthSupabase();
  const { data, error } = await supabase.schema('finance').rpc('generate_next_asset_code');
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ data });
}
