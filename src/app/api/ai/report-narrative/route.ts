// =============================================================================
// AI Report Narrative API — Spec 9.1 (P0)
// POST /api/ai/report-narrative
//
// Generates AI narrative explanations for dashboard data, reports, and metrics.
// Numbers come from deterministic reports; AI only explains trends, variances,
// overdue items, and risks. Shows filters and source.
//
// Spec 9.1: "Report narrative P0 — deterministic reports; show filters and source"
// Spec 9.8: "AI dashboards may generate plain-language explanations for charts,
// but the chart series, totals, fiscal-year filters, currency conversion,
// and comparisons must come from deterministic reporting views."
// =============================================================================

import { generateText } from 'ai';
import { NextResponse } from 'next/server';
import { getAuthSupabase, enforceAiRequestLimits } from '@/lib/api-auth';
import { requirePermission } from '@/lib/api-auth';
import {
  logAiAuditEvent,
  extractRequestMetadata,
  generateRequestId,
  estimateTokens,
  calculateCost,
  updateAiCostTracking,
  TokenUsage,
} from '@/lib/ai-cost-tracking';
import { z } from 'zod';
import { buildAiResponse, type AiResponseContract } from '@/lib/ai-response';
import { getActiveModel, resolveModel } from '@/lib/ai-registry';

// ─── Request Schema ───
const ReportNarrativeRequestSchema = z.object({
  report_type: z.enum([
    'cash_position',
    'project_profitability',
    'tax_summary',
    'general_ledger',
    'budget_vs_actual',
    'payable_aging',
    'receivable_aging',
    'reconciliation',
    'asset_register',
    'depreciation',
    'financial_statements',
    'trial_balance',
  ]),
  data: z.any(), // Pre-fetched data from deterministic reporting views
  filters: z.array(z.object({ field: z.string(), value: z.string() })).optional().default([]),
  period: z.object({ from: z.string(), to: z.string() }).optional(),
  currency: z.string().default('PKR'),
  context: z.string().optional(), // Additional context like "compare with last quarter"
});

// ─── Response Schema (Spec 9.10 contract) ───
const NarrativeResponseSchema = z.object({
  narrative: z.string(),
  key_findings: z.array(z.string()).default([]),
  risks_or_warnings: z.array(z.string()).default([]),
  recommendations: z.array(z.string()).default([]),
  data_source: z.string(),
  period: z.object({ from: z.string(), to: z.string() }).nullable().optional(),
  currency: z.string(),
  confidence: z.enum(['high', 'medium', 'low']).default('medium'),
  compliance_note: z.string(),
});

export async function POST(req: Request) {
  const requestId = generateRequestId();
  const requestMetadata = extractRequestMetadata(req);
  const startTime = Date.now();

  try {
    // 1. Auth & Context
    const { supabase, user, authError } = await getAuthSupabase(req);
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { data: profile } = await supabase
      .from('profiles')
      .select('organization_id, role')
      .eq('user_id', user.id)
      .maybeSingle();

    const orgId = profile?.organization_id;
    const userRole = profile?.role || 'EMPLOYEE';

    if (!orgId) {
      return NextResponse.json(
        { error: 'Organization context missing.' },
        { status: 400 }
      );
    }

    const aiLimitCheck = await enforceAiRequestLimits(supabase, user.id, orgId);
    if (aiLimitCheck) return aiLimitCheck;

    // 2. Parse and validate request
    const body = await req.json();
    const parsed = ReportNarrativeRequestSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Invalid request', details: parsed.error.issues },
        { status: 400 }
      );
    }

    const { report_type, data, filters, period, currency, context } = parsed.data;

    // 3. Permission check — server-side only. Never trust the client role/tool registry.
    const permissionCheck = await requirePermission('REPORT_READ');

    if (permissionCheck instanceof NextResponse) {
      await logAiAuditEvent(supabase, {
        userId: user.id,
        userEmail: user.email,
        status: 'refused',
        severity: 'warning',
        question: `Report narrative request: ${report_type}`,
        normalizedIntent: 'report_narrative',
        selectedTool: 'run_saved_report',
        requestId,
        ipAddress: requestMetadata.ipAddress,
        userAgent: requestMetadata.userAgent,
        refusalReason: 'Insufficient permissions',
      });

      return NextResponse.json(
        { error: 'Insufficient permissions for report access.' },
        { status: 403 }
      );
    }

    // 4. Generate AI Narrative (Spec 9.1: deterministic data + AI explanation)
    const systemPrompt = `You are a senior financial analyst at OSYSTIC Finance Management System.
You generate PROFESSIONAL, concise financial narratives based on the provided DATA.

CRITICAL RULES:
1. Numbers come ONLY from the provided data. Never invent figures.
2. Present amounts in ${currency}.
3. If period is provided, analyze trends within that period.
4. Highlight key findings, risks, and actionable recommendations.
5. Keep the narrative concise (3-5 paragraphs max).
6. Use professional financial language suitable for ${userRole}.
7. If data is empty, state "No data available for the selected period."
8. Add specific numbers and percentages from the data to support every finding.
9. Identify top 3 risks or concerns from the data.
10. Suggest 2-3 actionable next steps.`;

    const userPrompt = `Generate a financial narrative for: ${report_type}

DATA: ${JSON.stringify(data).slice(0, 4000)}

FILTERS: ${JSON.stringify(filters)}
PERIOD: ${period ? JSON.stringify(period) : 'Not specified'}
CURRENCY: ${currency}
${context ? `ADDITIONAL CONTEXT: ${context}` : ''}`;

    const aiModel = await getActiveModel(supabase, 'report_narrative');

    const intentStart = Date.now();
    const result = await generateText({
      model: resolveModel(aiModel),
      system: systemPrompt,
      prompt: userPrompt,
    });

    const narrative = result.text;

    // Extract key findings, risks, and recommendations from the narrative
    const keyFindings = extractKeyPoints(narrative, 'finding');
    const risks = extractKeyPoints(narrative, 'risk|concern|warning');
    const recommendations = extractKeyPoints(narrative, 'recommend|suggest|action');

    // 5. Build response (Spec 9.10 contract)
    const complianceNote =
      'AI narrative is based on deterministic report data. Cross-check with official reports before making decisions.';
    const totalLatency = Date.now() - startTime;

    const confidence: AiResponseContract['confidence'] =
      data && Object.keys(data).length > 0 ? 'medium' : 'low';

    const responsePayload = {
      narrative,
      key_findings: keyFindings,
      risks_or_warnings: risks,
      recommendations,
      data_source: `reporting.${report_type}`,
      period: period || null,
      currency,
      confidence,
      compliance_note: complianceNote,
    };

    NarrativeResponseSchema.parse(responsePayload);

    // 6. Token counting & cost tracking
    const inputTokens = estimateTokens(systemPrompt + userPrompt);
    const outputTokens = estimateTokens(narrative);
    const estimatedCost = calculateCost(inputTokens, outputTokens);
    const tokenUsage: TokenUsage = {
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      estimatedCostUsd: estimatedCost,
      model: aiModel.modelId,
      latencyMs: totalLatency,
    };

    await updateAiCostTracking(supabase, user.id, orgId, tokenUsage);

    // 7. Comprehensive audit logging
    await logAiAuditEvent(supabase, {
      userId: user.id,
      userEmail: user.email,
      action: 'AI_REPORT_NARRATIVE',
      status: 'success',
      severity: 'info',
      question: `Report narrative: ${report_type}`,
      normalizedIntent: 'report_narrative',
      selectedTool: 'run_saved_report',
      rowCount: Array.isArray(data) ? data.length : 1,
      model: aiModel.modelId,
      latencyMs: totalLatency,
      costUsd: estimatedCost,
      inputTokens,
      outputTokens,
      requestId,
      ipAddress: requestMetadata.ipAddress,
      userAgent: requestMetadata.userAgent,
    });

    return NextResponse.json(buildAiResponse(responsePayload, {
      answer: responsePayload.narrative,
      metric_or_report: report_type,
      period: period || null,
      currency,
      filters,
      data_as_of: new Date().toISOString(),
      confidence: responsePayload.confidence,
      warnings: responsePayload.risks_or_warnings,
      source_rows_or_report: responsePayload.data_source,
      suggested_safe_actions: responsePayload.recommendations,
    }));
  } catch (error: any) {
    console.error('Report Narrative API error:', error.message);

    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: 'Response validation failed', details: error.issues },
        { status: 500 }
      );
    }

    return NextResponse.json(
      { error: 'Failed to generate report narrative. Please try again.' },
      { status: 500 }
    );
  }
}

// =============================================================================
// HELPER: Extract key points from AI narrative text
// =============================================================================

function extractKeyPoints(text: string, pattern: string): string[] {
  const sentences = text.split(/[.!]\s+/);
  return sentences
    .filter((s) => new RegExp(pattern, 'i').test(s))
    .slice(0, 5)
    .map((s) => s.trim());
}