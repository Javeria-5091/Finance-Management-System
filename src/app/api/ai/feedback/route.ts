// =============================================================================
// AI Feedback API — Spec §9.9
// Records human feedback against an AI message or tool call.
//
// The ai.ai_feedback table contains message_id and tool_call_id references;
// it does NOT contain conversation_id. Conversation ownership is already
// represented by ai_messages -> ai_conversations and enforced through the
// message relationship/RLS. Therefore conversation_id is intentionally not
// written here.
// =============================================================================

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getAuthSupabase } from '@/lib/api-auth';

const feedbackSchema = z.object({
  message_id: z.string().uuid().nullable().optional(),
  tool_call_id: z.string().uuid().nullable().optional(),
  feedback_type: z.enum(['message_rating', 'suggestion_rating', 'correction', 'general']),
  rating: z.number().int().min(1).max(5).nullable().optional(),
  correction: z.string().max(10000).nullable().optional(),
  reason: z.string().max(5000).nullable().optional(),
}).strict();

export async function POST(req: NextRequest) {
  try {
    const { supabase, user, authError } = await getAuthSupabase(req);
    if (authError || !user) {
      return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
    }

    const parsed = feedbackSchema.safeParse(await req.json());
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Invalid feedback payload', details: parsed.error.flatten() },
        { status: 400 },
      );
    }

    const input = parsed.data;

    if (!input.message_id && !input.tool_call_id) {
      return NextResponse.json(
        { error: 'message_id or tool_call_id is required' },
        { status: 400 },
      );
    }

    // Resolve the organization from the authenticated profile. Do not accept
    // organization_id from the client because feedback must always be scoped
    // to the authenticated user's organization.
    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('organization_id')
      .eq('user_id', user.id)
      .maybeSingle();

    if (profileError) {
      console.error('AI Feedback profile lookup error:', profileError.message);
      return NextResponse.json({ error: 'Unable to determine organization' }, { status: 500 });
    }

    const organizationId = profile?.organization_id;
    if (!organizationId) {
      return NextResponse.json({ error: 'User organization is not configured' }, { status: 403 });
    }

    // ai.ai_feedback has message_id and tool_call_id columns only. There is
    // deliberately no conversation_id field here (see schema.sql).
    const { data, error } = await supabase
      .schema('ai')
      .from('ai_feedback')
      .insert({
        user_id: user.id,
        organization_id: organizationId,
        message_id: input.message_id ?? null,
        tool_call_id: input.tool_call_id ?? null,
        feedback_type: input.feedback_type,
        rating: input.rating ?? null,
        correction: input.correction ?? null,
        reason: input.reason ?? null,
      })
      .select('id')
      .single();

    if (error) {
      console.error('AI Feedback insert error:', error.message);
      return NextResponse.json({ error: 'Failed to save feedback' }, { status: 500 });
    }

    return NextResponse.json({ success: true, id: data.id });
  } catch (error: unknown) {
    console.error('AI Feedback API error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
