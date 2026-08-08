// =============================================================================
// AI Feedback API — Spec 9.9 ai_feedback
// Records user thumbs-up/down on AI responses for quality evaluation
// =============================================================================

import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { NextRequest, NextResponse } from 'next/server';

export async function POST(req: NextRequest) {
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

    const userId = session.user.id;

    // ─── 2. Parse body ───
    const body = await req.json();
    const { message_id, conversation_id, feedback_type, rating, correction, reason } = body;

    // Validate required fields
    if (!feedback_type) {
      return NextResponse.json({ error: 'feedback_type is required' }, { status: 400 });
    }

    const validFeedbackTypes = ['message_rating', 'suggestion_rating', 'correction', 'general'];
    if (!validFeedbackTypes.includes(feedback_type)) {
      return NextResponse.json({ error: `feedback_type must be one of: ${validFeedbackTypes.join(', ')}` }, { status: 400 });
    }

    if (rating !== undefined && (rating < 1 || rating > 5)) {
      return NextResponse.json({ error: 'rating must be between 1 and 5' }, { status: 400 });
    }

    // ─── 3. Get org_id from profile ───
    const { data: profile } = await supabase
      .from('profiles')
      .select('organization_id')
      .eq('user_id', userId)
      .maybeSingle();

    const orgId = profile?.organization_id || '';

    // ─── 4. Insert feedback ───
    const { data, error } = await supabase
      .from('ai_feedback')
      .insert({
        user_id: userId,
        organization_id: orgId,
        message_id: message_id || null,
        conversation_id: conversation_id || null,
        feedback_type,
        rating: rating || null,
        correction: correction || null,
        reason: reason || null,
      })
      .select('id')
      .single();

    if (error) {
      console.error('AI Feedback insert error:', error.message);
      return NextResponse.json({ error: 'Failed to save feedback' }, { status: 500 });
    }

    return NextResponse.json({ success: true, id: data?.id });
  } catch (error: any) {
    console.error('AI Feedback API error:', error.message);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
