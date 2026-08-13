// =============================================================================
// AI Feedback API — Spec 9.9 (ai_feedback)
// Records user thumbs-up/down on AI responses for quality evaluation (Spec 9.11)
//
// ✅ FIX (Gap 5 — auth inconsistency): switched from a local
// createServerClient + getSession() (cookie-only) to getAuthSupabase()
// (cookie OR Bearer token), matching chat/route.ts.
// =============================================================================

import { NextRequest, NextResponse } from 'next/server';
import { getAuthSupabase } from '@/lib/api-auth';

export async function POST(req: NextRequest) {
  try {
    // ─── 1. Auth check (cookie session OR Bearer token) ───
    const { supabase, user, authError } = await getAuthSupabase(req);
    if (authError || !user) {
      return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
    }

    const userId = user.id;

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
    // 'profiles' is in the PUBLIC schema (confirmed) — query unqualified.
    const { data: profile } = await supabase
      .from('profiles')
      .select('organization_id')
      .eq('user_id', userId)
      .maybeSingle();

    const orgId = profile?.organization_id || '';

    // ─── 4. Insert feedback (Spec 9.9 — with conversation_id) ───
    // ai_feedback lives in the 'ai' schema — must use .schema('ai').from('ai_feedback'),
    // NOT .from('ai.ai_feedback'). The dotted string is not valid schema-qualification
    // syntax in supabase-js.
    const { data, error } = await supabase
      .schema('ai')
      .from('ai_feedback')
      .insert({
        user_id: userId,
        organization_id: orgId,
        message_id: message_id || null,
        conversation_id: conversation_id || null,  // Spec 9.9: FK reference
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