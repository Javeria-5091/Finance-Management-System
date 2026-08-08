// =============================================================================
// AI Conversation Messages API — Spec 9.9
// GET: Load all messages for a specific conversation
// =============================================================================

import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { NextRequest, NextResponse } from 'next/server';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
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

    const { id: conversationId } = await params;

    if (!conversationId) {
      return NextResponse.json({ error: 'Conversation ID is required' }, { status: 400 });
    }

    // ─── 2. Verify conversation belongs to this user (security) ───
    const { data: conv } = await supabase
      .from('ai_conversations')
      .select('id, user_id')
      .eq('id', conversationId)
      .eq('user_id', session.user.id)
      .maybeSingle();

    if (!conv) {
      return NextResponse.json({ error: 'Conversation not found' }, { status: 404 });
    }

    // ─── 3. Fetch messages (RLS also protects, but explicit check above is defense-in-depth) ───
    const { data: messages, error } = await supabase
      .from('ai_messages')
      .select('id, role, content, content_type, classification, metadata, created_at')
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: true });

    if (error) {
      console.error('AI Messages fetch error:', error.message);
      return NextResponse.json({ error: 'Failed to fetch messages' }, { status: 500 });
    }

    // ─── 4. Format for frontend ───
    const formattedMessages = (messages || []).map((m: any) => {
      const meta = m.metadata || {};
      return {
        id: m.id,
        role: m.role,
        content: m.content,
        tool: meta.tool || null,
        confidence: meta.confidence || null,
        period: null,
        currency: 'PKR',
        warnings: meta.warnings || [],
        source_rows_or_report: null,
        suggested_safe_actions: [],
        timestamp: m.created_at,
        feedbackGiven: null,
      };
    });

    return NextResponse.json({ messages: formattedMessages });
  } catch (error: any) {
    console.error('AI Messages API error:', error.message);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
