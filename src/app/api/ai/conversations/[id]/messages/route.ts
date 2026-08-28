// =============================================================================
// AI Conversation Messages API — Spec 9.9 (ai.ai_messages)
//
// FIX (Module 1 follow-up audit): this file previously contained an entire
// unrelated client React component ("CreditNotesPage") instead of a Next.js
// route handler. A `.ts` file cannot contain JSX, and a route file must
// export GET/POST/etc handlers rather than a default React component — that
// broke `next build` and meant this endpoint (fetching/adding messages for
// one AI conversation) never actually existed at runtime. Restored below.
//
// GET  /api/ai/conversations/:id/messages  -> list messages for one conversation
// POST /api/ai/conversations/:id/messages  -> append a message (used by the
//                                              AI chat UI to persist history)
// =============================================================================

import { NextResponse } from 'next/server';
import { getAuthSupabase } from '@/lib/api-auth';

function isValidUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

// ─── GET: list messages for a conversation the caller owns ───
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id: conversationId } = await params;
    if (!isValidUuid(conversationId)) {
      return NextResponse.json({ error: 'Invalid conversation id' }, { status: 400 });
    }

    const { supabase, user, authError } = await getAuthSupabase(req);
    if (authError || !user) {
      return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
    }

    // Ownership check first so we return a clean 404 instead of leaking
    // whether a conversation ID belonging to someone else exists.
    const { data: conversation, error: convError } = await supabase
      .schema('ai')
      .from('ai_conversations')
      .select('id, user_id, status')
      .eq('id', conversationId)
      .maybeSingle();

    if (convError) {
      console.error('AI Messages conversation lookup error:', convError.message);
      return NextResponse.json({ error: 'Failed to load conversation' }, { status: 500 });
    }
    if (!conversation || conversation.user_id !== user.id) {
      return NextResponse.json({ error: 'Conversation not found' }, { status: 404 });
    }

    const { data, error } = await supabase
      .schema('ai')
      .from('ai_messages')
      .select('id, role, content, content_type, classification, metadata, created_at')
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: true })
      .limit(500);

    if (error) {
      console.error('AI Messages fetch error:', error.message);
      return NextResponse.json({ error: 'Failed to fetch messages' }, { status: 500 });
    }

    return NextResponse.json({ messages: data || [] });
  } catch (error: any) {
    console.error('AI Messages GET error:', error.message);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// ─── POST: append a message to a conversation the caller owns ───
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id: conversationId } = await params;
    if (!isValidUuid(conversationId)) {
      return NextResponse.json({ error: 'Invalid conversation id' }, { status: 400 });
    }

    const { supabase, user, authError } = await getAuthSupabase(req);
    if (authError || !user) {
      return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
    }

    const body = await req.json().catch(() => null);
    const role = body?.role;
    const content = body?.content;
    const contentType = body?.content_type || 'text';
    const classification = body?.classification ?? null;
    const metadata = body?.metadata ?? {};

    if (!['user', 'assistant', 'system'].includes(role)) {
      return NextResponse.json({ error: 'role must be one of user, assistant, system' }, { status: 400 });
    }
    if (typeof content !== 'string' || !content.trim()) {
      return NextResponse.json({ error: 'content is required' }, { status: 400 });
    }
    if (!['text', 'json', 'error'].includes(contentType)) {
      return NextResponse.json({ error: 'content_type must be one of text, json, error' }, { status: 400 });
    }

    const { data: conversation, error: convError } = await supabase
      .schema('ai')
      .from('ai_conversations')
      .select('id, user_id')
      .eq('id', conversationId)
      .maybeSingle();

    if (convError) {
      console.error('AI Messages conversation lookup error:', convError.message);
      return NextResponse.json({ error: 'Failed to load conversation' }, { status: 500 });
    }
    if (!conversation || conversation.user_id !== user.id) {
      return NextResponse.json({ error: 'Conversation not found' }, { status: 404 });
    }

    const { data, error } = await supabase
      .schema('ai')
      .from('ai_messages')
      .insert({
        conversation_id: conversationId,
        role,
        content,
        content_type: contentType,
        classification,
        metadata,
      })
      .select('id, role, content, content_type, classification, metadata, created_at')
      .single();

    if (error) {
      console.error('AI Messages insert error:', error.message);
      return NextResponse.json({ error: 'Failed to save message' }, { status: 500 });
    }

    // Keep the conversation's updated_at fresh so it sorts correctly in the
    // history panel (ai/conversations GET orders by updated_at desc).
    await supabase
      .schema('ai')
      .from('ai_conversations')
      .update({ updated_at: new Date().toISOString() })
      .eq('id', conversationId);

    return NextResponse.json({ message: data }, { status: 201 });
  } catch (error: any) {
    console.error('AI Messages POST error:', error.message);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
