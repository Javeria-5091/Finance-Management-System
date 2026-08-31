// =============================================================================
// AI Fiscal-Close Assistant API — Spec 9.1 (P1)
// POST /api/ai/fiscal-close-assistant
//
// Spec 9.1: "Summarize close checklist, unreconciled accounts, missing postings,
// and comparative movements. Read-only; accountant completes and closes."
// =============================================================================

import { generateText } from 'ai';
import { NextResponse } from 'next/server';
import { getAuthSupabase, isSqlSafe, requirePermission, enforceAiRequestLimits } from '@/lib/api-auth';
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
import { buildAiResponse } from '@/lib/ai-response';
import { getActiveModel, resolveModel } from '@/lib/ai-registry';

const FiscalCloseRequestSchema = z.object({
  fiscal_year_id: z.string().uuid(),
  action: z.enum(['checklist', 'status', 'missing_postings', 'comparative_analysis']).default('checklist'),
});

export async function POST(req: Request) {
  const permissionCheck = await requirePermission('REPORT_READ');
  if (permissionCheck instanceof Response) return permissionCheck;
  const requestId = generateRequestId();
  const requestMetadata = extractRequestMetadata(req);
  const startTime = Date.now();

  try {
    // 1. Auth
    const { supabase, user, authError } = await getAuthSupabase(req);
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { data: profile } = await supabase.from('profiles').select('organization_id, role').eq('user_id', user.id).maybeSingle();
    const orgId = profile?.organization_id;
    const userRole = profile?.role || 'EMPLOYEE';
    if (!orgId) return NextResponse.json({ error: 'Organization context missing.' }, { status: 400 });
    const aiLimitCheck = await enforceAiRequestLimits(supabase, user.id, orgId);
    if (aiLimitCheck) return aiLimitCheck;

    // 2. Parse request
    const body = await req.json();
    const parsed = FiscalCloseRequestSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: 'Invalid request', details: parsed.error.issues }, { status: 400 });
    }

    const { fiscal_year_id, action } = parsed.data;

    // 3. Fetch fiscal year data
    const { data: fiscalYear } = await supabase
      .from('fiscal_years')
      .select('id, name, start_date, end_date, status')
      .eq('id', fiscal_year_id)
      .eq('organization_id', orgId)
      .maybeSingle();

    if (!fiscalYear) {
      return NextResponse.json({ error: 'Fiscal year not found.' }, { status: 404 });
    }

    // 4. Gather data based on action type
    let contextData = '';

    // Check unreconciled accounts
    const reconQuery = `SELECT COALESCE(jsonb_agg(t), '[]'::jsonb) FROM (
        SELECT account_name, institution_name, reconciliation_status, last_reconciled_at
        FROM reporting.reconciliation_summary
        WHERE organization_id = '${orgId}'
        AND reconciliation_status != 'reconciled'
      ) t`;
    const reconSafety = await isSqlSafe(reconQuery);
    if (!reconSafety.safe) {
      return NextResponse.json({ error: 'Query safety check failed', reason: reconSafety.reason }, { status: 500 });
    }
    const { data: reconStatus } = await supabase.rpc('execute_ai_readonly_query', { query_string: reconQuery, p_org_id: orgId, p_user_id: user.id, p_enforce_user_scope: false });

    // Check open periods
    const periodsQuery = `SELECT COALESCE(jsonb_agg(t), '[]'::jsonb) FROM (
        SELECT DISTINCT period_id, period_number, period_name, start_date, end_date, period_status
        FROM reporting.ai_fiscal_close_context
        WHERE fiscal_year_id = '${fiscal_year_id}'
        AND organization_id = '${orgId}'
        AND period_status != 'HARD_CLOSED'
        ORDER BY period_number
      ) t`;
    const periodsSafety = await isSqlSafe(periodsQuery);
    if (!periodsSafety.safe) {
      return NextResponse.json({ error: 'Query safety check failed', reason: periodsSafety.reason }, { status: 500 });
    }
    const { data: openPeriods } = await supabase.rpc('execute_ai_readonly_query', { query_string: periodsQuery, p_org_id: orgId, p_user_id: user.id, p_enforce_user_scope: false });

    // Check pending journal entries
    const journalsQuery = `SELECT COALESCE(jsonb_agg(t), '[]'::jsonb) FROM (
        SELECT journal_entry_id, reference, description, transaction_date, journal_status AS status, source_type
        FROM reporting.ai_fiscal_close_context
        WHERE fiscal_year_id = '${fiscal_year_id}'
        AND organization_id = '${orgId}'
        AND journal_status = 'DRAFT'
        LIMIT 50
      ) t`;
    const journalsSafety = await isSqlSafe(journalsQuery);
    if (!journalsSafety.safe) {
      return NextResponse.json({ error: 'Query safety check failed', reason: journalsSafety.reason }, { status: 500 });
    }
    const { data: pendingJournals } = await supabase.rpc('execute_ai_readonly_query', { query_string: journalsQuery, p_org_id: orgId, p_user_id: user.id, p_enforce_user_scope: false });

    contextData = `
FISCAL YEAR: ${fiscalYear.name} (${fiscalYear.start_date} to ${fiscalYear.end_date})
STATUS: ${fiscalYear.status}

UNRECONCILED ACCOUNTS:
${JSON.stringify(reconStatus || [])}

OPEN PERIODS:
${JSON.stringify(openPeriods || [])}

PENDING DRAFT JOURNALS:
${JSON.stringify(pendingJournals || [])}`;

    // 5. Generate AI analysis based on action type
    const actionPrompts: Record<string, string> = {
      checklist: `Generate a comprehensive fiscal year close checklist for "${fiscalYear.name}".
Include items for: reconciliation, pending journals, accruals, depreciation, tax, FX adjustments, and final reporting.
Mark each item as DONE or PENDING based on the data. Flag any blocking items.`,
      status: `Provide a fiscal year close STATUS SUMMARY for "${fiscalYear.name}".
List what is complete and what remains. Highlight blockers and estimated effort.`,
      missing_postings: `Identify MISSING POSTINGS that may be required before closing "${fiscalYear.name}".
Check for: unreconciled accounts, draft journals, missing accruals, unrecorded depreciation, and pending tax adjustments.`,
      comparative_analysis: `Generate a COMPARATIVE ANALYSIS of year-over-year movements for "${fiscalYear.name}".
Highlight significant changes in revenue, expenses, assets, and liabilities.`,
    };

    const aiModel = await getActiveModel(supabase, 'fiscal_close_assistant');

    const aiResult = await generateText({
      model: resolveModel(aiModel),
      system: `You are a senior accountant AI assistant for OSYSTIC Finance System.
You provide read-only fiscal close analysis. You NEVER post, close, or modify any records.
All amounts are in PKR. Be specific and actionable. Format responses with clear sections.`,
      prompt: `${actionPrompts[action]}\n\n${contextData}`,
    });

    // 6. Build response
    const totalLatency = Date.now() - startTime;
    const responsePayload = {
      fiscal_year: fiscalYear.name,
      fiscal_year_status: fiscalYear.status,
      action,
      analysis: aiResult.text,
      unreconciled_count: Array.isArray(reconStatus) ? reconStatus.length : 0,
      open_periods_count: Array.isArray(openPeriods) ? openPeriods.length : 0,
      pending_journals_count: Array.isArray(pendingJournals) ? pendingJournals.length : 0,
      compliance_note: 'Read-only analysis. Accountant must complete and close using standard authorization workflow.',
      data_as_of: new Date().toISOString(),
    };

    // 7. Token tracking & audit
    const inputTokens = estimateTokens(actionPrompts[action] + contextData);
    const outputTokens = estimateTokens(aiResult.text);
    const estimatedCost = calculateCost(inputTokens, outputTokens);

    await updateAiCostTracking(supabase, user.id, orgId, {
      inputTokens, outputTokens, totalTokens: inputTokens + outputTokens,
      estimatedCostUsd: estimatedCost, model: aiModel.modelId, latencyMs: totalLatency,
    });

    await logAiAuditEvent(supabase, {
      userId: user.id, userEmail: user.email, action: 'AI_FISCAL_CLOSE_ASSISTANT',
      status: 'success', severity: 'info',
      entityType: 'fiscal_year', entityId: fiscal_year_id,
      question: `Fiscal close ${action} for ${fiscalYear.name}`,
      normalizedIntent: 'fiscal_close_assistant', selectedTool: 'fiscal_close_assistant',
      model: aiModel.modelId, latencyMs: totalLatency,
      costUsd: estimatedCost, inputTokens, outputTokens,
      requestId, ipAddress: requestMetadata.ipAddress, userAgent: requestMetadata.userAgent,
    });

    return NextResponse.json(buildAiResponse(responsePayload, {
      answer: responsePayload.analysis,
      metric_or_report: 'fiscal_close_assistant',
      period: { from: fiscalYear.start_date, to: fiscalYear.end_date },
      currency: 'PKR',
      filters: [{ field: 'fiscal_year_id', value: fiscal_year_id }],
      data_as_of: new Date().toISOString(),
      confidence: (responsePayload.unreconciled_count + responsePayload.open_periods_count + responsePayload.pending_journals_count) === 0 ? 'high' : 'medium',
      warnings: [
        ...(responsePayload.unreconciled_count > 0 ? [`${responsePayload.unreconciled_count} unreconciled account(s) remain.`] : []),
        ...(responsePayload.open_periods_count > 0 ? [`${responsePayload.open_periods_count} period(s) are not hard closed.`] : []),
        ...(responsePayload.pending_journals_count > 0 ? [`${responsePayload.pending_journals_count} draft journal(s) remain.`] : []),
      ],
      source_rows_or_report: 'reporting.ai_fiscal_close_context',
      suggested_safe_actions: ['Review blockers', 'Complete accountant close checklist manually'],
    }));
  } catch (error: any) {
    console.error('Fiscal Close Assistant API error:', error.message);
    return NextResponse.json({ error: 'Failed to generate fiscal close analysis.' }, { status: 500 });
  }
}