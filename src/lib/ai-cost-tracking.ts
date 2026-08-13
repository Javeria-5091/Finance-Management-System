// =============================================================================
// AI Cost Tracking — Spec 9.11
// Tracks input/output tokens, estimated cost per request,
// and updates ai_user_cost_tracking table with daily aggregates.
// Also calls audit.log_ai_event for comprehensive audit trail.
// =============================================================================

import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';

// ─── Cost constants (Groq Llama pricing as baseline) ───
// Adjust these values based on your actual provider pricing
const COST_PER_INPUT_TOKEN = 0.00000059; // ~$0.59 per 1M input tokens
const COST_PER_OUTPUT_TOKEN = 0.00000079; // ~$0.79 per 1M output tokens

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
  model: string;
  latencyMs: number;
}

export interface AiAuditEventParams {
  userId: string;
  userEmail?: string | null;
  userName?: string | null;
  action?: string;
  status: 'success' | 'error' | 'blocked' | 'refused';
  severity?: 'info' | 'warning' | 'critical';
  entityType?: string;
  entityId?: string | null;
  projectId?: string | null;
  question?: string;
  normalizedIntent?: string;
  selectedTool?: string;
  generatedSql?: string;
  templateId?: string;
  rowCount?: number;
  model?: string;
  latencyMs?: number;
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  refusalReason?: string;
  requestId?: string;
  ipAddress?: string | null;
  userAgent?: string | null;
}

// =============================================================================
// ESTIMATE TOKEN USAGE
// Approximate token counting based on string length.
// For exact counting, use the provider's tokenization API.
// =============================================================================

export function estimateTokens(text: string): number {
  // Rough estimate: ~4 characters per token for English, ~2 for CJK
  return Math.ceil(text.length / 3.5);
}

export function calculateCost(
  inputTokens: number,
  outputTokens: number
): number {
  return (
    inputTokens * COST_PER_INPUT_TOKEN +
    outputTokens * COST_PER_OUTPUT_TOKEN
  );
}

// =============================================================================
// UPDATE USER COST TRACKING (Spec 9.9 — ai_user_cost_tracking)
// Atomically increments request_count and estimated_cost for the day.
// =============================================================================

export async function updateAiCostTracking(
  supabase: any,
  userId: string,
  orgId: string,
  tokenUsage: TokenUsage
): Promise<void> {
  try {
    const today = new Date().toISOString().split('T')[0];

    // Try to increment existing record
    const { data: existing } = await supabase
      .schema('ai')
      .from('ai_user_cost_tracking')
      .select('id, request_count, estimated_cost')
      .eq('user_id', userId)
      .eq('organization_id', orgId)
      .eq('period_date', today)
      .maybeSingle();

    if (existing) {
      await supabase
        .schema('ai')
        .from('ai_user_cost_tracking')
        .update({
          request_count: (existing.request_count || 0) + 1,
          estimated_cost: String(
            parseFloat(existing.estimated_cost || '0') + tokenUsage.estimatedCostUsd
          ),
          last_request_at: new Date().toISOString(),
        })
        .eq('id', existing.id);
    } else {
      // Insert new daily record
      await supabase.schema('ai').from('ai_user_cost_tracking').insert({
        user_id: userId,
        organization_id: orgId,
        period_date: today,
        request_count: 1,
        estimated_cost: String(tokenUsage.estimatedCostUsd),
        last_request_at: new Date().toISOString(),
      });
    }
  } catch (error: any) {
    console.error('updateAiCostTracking error:', error.message);
  }
}

// =============================================================================
// COMPREHENSIVE AUDIT LOGGING (Spec 9.9/9.11)
// Uses audit.log_ai_event RPC for every AI request.
// This provides a single unified audit trail across all AI activity.
// =============================================================================

export async function logAiAuditEvent(
  supabase: any,
  params: AiAuditEventParams
): Promise<string | null> {
  try {
    const { data, error } = await supabase.rpc('log_ai_event', {
      p_user_id: params.userId,
      p_user_email: params.userEmail || null,
      p_user_name: params.userName || null,
      p_action: params.action || 'AI_QUERY',
      p_status: params.status,
      p_severity: params.severity || 'info',
      p_entity_type: params.entityType || null,
      p_entity_id: params.entityId || null,
      p_project_id: params.projectId || null,
      p_ai_question: params.question || null,
      p_ai_normalized_intent: params.normalizedIntent || null,
      p_ai_selected_tool: params.selectedTool || null,
      p_ai_generated_sql: params.generatedSql || null,
      p_ai_template_id: params.templateId || null,
      p_ai_row_count: params.rowCount || null,
      p_ai_model: params.model || null,
      p_ai_latency_ms: params.latencyMs || null,
      p_ai_cost_usd: params.costUsd || null,
      p_ai_input_tokens: params.inputTokens || null,
      p_ai_output_tokens: params.outputTokens || null,
      p_ai_refusal_reason: params.refusalReason || null,
      p_request_id: params.requestId || null,
      p_ip_address: params.ipAddress || null,
      p_user_agent: params.userAgent || null,
    });

    if (error) {
      console.error('log_ai_event RPC error:', error.message);
      return null;
    }
    return data;
  } catch (error: any) {
    console.error('logAiAuditEvent error:', error.message);
    return null;
  }
}

// =============================================================================
// HELPER: Extract IP and User Agent from request
// =============================================================================

export function extractRequestMetadata(req: Request): {
  ipAddress: string | null;
  userAgent: string | null;
} {
  return {
    ipAddress:
      (req.headers.get('x-forwarded-for')?.split(',')[0]?.trim()) || null,
    userAgent: req.headers.get('user-agent') || null,
  };
}

// =============================================================================
// HELPER: Generate a unique request ID for tracing
// =============================================================================

export function generateRequestId(): string {
  return `ai_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}