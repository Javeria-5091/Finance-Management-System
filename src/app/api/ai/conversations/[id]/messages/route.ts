// =============================================================================
// AI Conversation Messages API — Spec 9.9
// GET /api/ai/conversations/[id]/messages
// Loads all messages for a given conversation (for "load past conversation")
//
// ✅ FIX (Gap 5 — auth inconsistency): switched from a local
// createServerClient + getSession() (cookie-only) to getAuthSupabase()
// (cookie OR Bearer token), matching chat/route.ts and conversations/route.ts.
// =============================================================================

import { NextResponse } from 'next/server';
import { getAuthSupabase } from '@/lib/api-auth';

export async function GET(
  req: Request,
  { params }: { params: { id: string } }
) {
  try {
    const conversationId = params.id;

    // ─── 1. Auth check (cookie session OR Bearer token) ───
    const { supabase, user, authError } = await getAuthSupabase(req);
    if (authError || !user) {
      return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
    }

    // ─── 2. Verify the conversation is visible to this user (defense in
    //         depth — RLS also enforces owner-or-privileged-role access) ───
    const { data: conv, error: convError } = await supabase
      .schema('ai')
      .from('ai_conversations')
      .select('id, user_id')
      .eq('id', conversationId)
      .maybeSingle();

    if (convError) {
      console.error('ai_conversations lookup error:', convError.message);
      return NextResponse.json({ error: 'Failed to load conversation' }, { status: 500 });
    }
    if (!conv) {
      // RLS already filtered out conversations this user can't see (not
      // owner and not a privileged role) — a missing row means "not found
      // or not permitted", which we deliberately don't distinguish.
      return NextResponse.json({ error: 'Conversation not found' }, { status: 404 });
    }

    // ─── 3. Fetch messages, oldest first ───
    const { data, error } = await supabase
      .schema('ai')
      .from('ai_messages')
      .select('id, role, content, classification, metadata, created_at')
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: true });

    if (error) {
      console.error('ai_messages fetch error:', error.message);
      return NextResponse.json({ error: 'Failed to fetch messages' }, { status: 500 });
    }

    // ─── 4. Map DB rows back into the shape AiChat.tsx expects (AIMessage) ───
    const messages = (data || []).map((m: any) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      tool: m.metadata?.tool ?? null,
      confidence: m.metadata?.confidence ?? null,
      period: m.metadata?.period ?? null,
      currency: m.metadata?.currency ?? null,
      filters: m.metadata?.filters ?? null,
      data_as_of: m.metadata?.data_as_of ?? null,
      warnings: m.metadata?.warnings ?? null,
      source_rows_or_report: m.metadata?.source_rows_or_report ?? null,
      suggested_safe_actions: m.metadata?.suggested_safe_actions ?? null,
      timestamp: m.created_at,
      feedbackGiven: null,
    }));

    return NextResponse.json({ messages });
  } catch (error: any) {
    console.error('AI Conversation Messages API error:', error.message);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}