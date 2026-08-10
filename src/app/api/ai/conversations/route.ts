// =============================================================================
// AI Conversations API — Spec 9.9
// GET: List user's past conversations (for history panel)
// =============================================================================

import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

export async function GET() {
  try {
    // ─── 1. Auth check ───
    const cookieStore = await cookies();
    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        cookies: {
          getAll() { return cookieStore.getAll(); },
          setAll() {},
        },
      }
    );

    const { data: { session }, error: authError } = await supabase.auth.getSession();
    if (authError || !session?.user) {
      return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
    }

    // ─── 2. Fetch conversations (RLS ensures user only sees own) ───
    // ✅ FIX: schema-qualify as ai.ai_conversations (Spec 9.9). Previous `from('ai_conversations')`
    // relied on search_path including `ai` schema, which is not standard on Supabase — query
    // returned empty conversations list, breaking the chat history panel.
    const { data, error } = await supabase
      .from('ai.ai_conversations')
      .select('id, title, status, created_at, updated_at')
      .eq('user_id', session.user.id)
      .eq('status', 'active')
      .order('updated_at', { ascending: false })
      .limit(20);

    if (error) {
      console.error('AI Conversations fetch error:', error.message);
      return NextResponse.json({ error: 'Failed to fetch conversations' }, { status: 500 });
    }

    return NextResponse.json({
      conversations: (data || []).map((c: any) => ({
        id: c.id,
        title: c.title || 'Untitled',
        status: c.status,
        created_at: c.created_at,
        updated_at: c.updated_at,
      })),
    });
  } catch (error: any) {
    console.error('AI Conversations API error:', error.message);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}