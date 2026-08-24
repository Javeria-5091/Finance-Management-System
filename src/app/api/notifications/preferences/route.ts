import { NextRequest, NextResponse } from 'next/server';
import { getAuthSupabase, getAuthUser } from '@/lib/api-auth';
import { unstable_noStore as noStore } from 'next/cache';

const CHANNELS = new Set(['IN_APP', 'EMAIL', 'SMS']);

function normalizeChannel(value: unknown): string | null {
  const v = String(value || '').trim().toUpperCase();
  return CHANNELS.has(v) ? v : null;
}

// BUG-023 FIX: notification preference writes have an explicit allow-list for
// delivery channels before they reach the database.
export async function POST(req: NextRequest) {
  noStore();
  const auth = await getAuthUser();
  if (auth instanceof NextResponse) return auth;
  const { supabase } = await getAuthSupabase(req);

  try {
    const body = await req.json();
    const items = Array.isArray(body?.preferences) ? body.preferences : [body];
    if (!items.length || items.length > 100) return NextResponse.json({ error: 'Invalid preferences payload' }, { status: 400 });

    const rows = items.map((item: any) => {
      const channel = normalizeChannel(item.channel);
      const category = String(item.category || '').trim();
      if (!channel || !category || category.length > 100) return null;
      return { user_id: auth.userId, category, channel, enabled: Boolean(item.enabled) };
    });
    if (rows.some((row: any) => !row)) return NextResponse.json({ error: 'Invalid channel. Allowed values: IN_APP, EMAIL, SMS.' }, { status: 400 });

    const { data, error } = await supabase
      .from('notification_preferences')
      .upsert(rows, { onConflict: 'user_id,category,channel' })
      .select();
    if (error) return NextResponse.json({ error: error.message }, { status: 400 });
    return NextResponse.json({ success: true, preferences: data || [] });
  } catch (error: any) {
    return NextResponse.json({ error: error?.message || 'Failed to save preferences' }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  noStore();
  const auth = await getAuthUser();
  if (auth instanceof NextResponse) return auth;
  const { supabase } = await getAuthSupabase(req);
  const { data, error } = await supabase.from('notification_preferences').select('id, category, channel, enabled').eq('user_id', auth.userId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ preferences: data || [] });
}
