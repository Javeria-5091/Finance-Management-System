// =============================================================================
// AI Conversations API — Spec 9.9
// GET: List user's past conversations (for history panel)
//
// ✅ FIX (Gap 5 — auth inconsistency): this route previously built its own
// createServerClient + getSession() call, which only reads the cookie
// session. app/api/ai/chat/route.ts uses getAuthSupabase(), which also
// accepts a Bearer token — so a client authenticated via Bearer could chat
// but would get 401s loading its own conversation history. Switched to the
// same getAuthSupabase() helper used everywhere else in the AI gateway.
// =============================================================================

import { NextResponse } from 'next/server';
import { getAuthSupabase } from '@/lib/api-auth';

export async function GET(req: Request) {
  try {
    // ─── 1. Auth check (cookie session OR Bearer token) ───
    const { supabase, user, authError } = await getAuthSupabase(req);
    if (authError || !user) {
      return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
    }

    // ─── 2. Fetch conversations (RLS ensures user only sees own, or org-wide
    //         for CEO/FINANCE_HEAD/AUDITOR/Admin per P1_008 migration) ───
    const { data, error } = await supabase
      .schema('ai')
      .from('ai_conversations')
      .select('id, title, status, created_at, updated_at')
      .eq('user_id', user.id)
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