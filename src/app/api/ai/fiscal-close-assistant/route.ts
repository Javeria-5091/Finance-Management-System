// =============================================================================
// AI Fiscal-Close Assistant API — Spec 9.1 (P1)
// POST /api/ai/fiscal-close-assistant
//
// Spec 9.1: "Summarize close checklist, unreconciled accounts, missing postings,
// and comparative movements. Read-only; accountant completes and closes."
// =============================================================================

import { createGroq } from '@ai-sdk/groq';
import { generateText } from 'ai';
import { NextResponse } from 'next/server';
import { getAuthSupabase } from '@/lib/api-auth';
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

const groq = createGroq({ apiKey: process.env.GROQ_API_KEY });

const FiscalCloseRequestSchema = z.object({
  fiscal_year_id: z.string().uuid(),
  action: z.enum(['checklist', 'status', 'missing_postings', 'comparative_analysis']).default('checklist'),
});

export async function POST(req: Request) {
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
      .maybeSingle();

    if (!fiscalYear) {
      return NextResponse.json({ error: 'Fiscal year not found.' }, { status: 404 });
    }

    // 4. Gather data based on action type
    let contextData = '';

    // Check unreconciled accounts
    const { data: reconStatus } = await supabase.rpc('execute_ai_readonly_query', {
      query_string: `SELECT COALESCE(jsonb_agg(t), '[]'::jsonb) FROM (
        SELECT account_name, institution_name, reconciliation_status, last_reconciled_at
        FROM reporting.reconciliation_summary
        WHERE reconciliation_status != 'reconciled'
      ) t`,
    });

    // Check open periods
    const { data: openPeriods } = await supabase.rpc('execute_ai_readonly_query', {
      query_string: `SELECT COALESCE(jsonb_agg(t), '[]'::jsonb) FROM (
        SELECT period_number, name, start_date, end_date, status
        FROM finance.accounting_periods
        WHERE fiscal_year_id = '${fiscal_year_id}'
        AND status != 'HARD_CLOSED'
        ORDER BY period_number
      ) t`,
    });

    // Check pending journal entries
    const { data: pendingJournals } = await supabase.rpc('execute_ai_readonly_query', {
      query_string: `SELECT COALESCE(jsonb_agg(t), '[]'::jsonb) FROM (
        SELECT reference, description, transaction_date, status, source_type
        FROM finance.journal_entries
        WHERE fiscal_year_id = '${fiscal_year_id}'
        AND status = 'DRAFT'
        LIMIT 50
      ) t`,
    });

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

    const aiResult = await generateText({
      model: groq('llama-3.3-70b-versatile'),
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
      estimatedCostUsd: estimatedCost, model: 'llama-3.3-70b-versatile', latencyMs: totalLatency,
    });

    await logAiAuditEvent(supabase, {
      userId: user.id, userEmail: user.email, action: 'AI_FISCAL_CLOSE_ASSISTANT',
      status: 'success', severity: 'info',
      entityType: 'fiscal_year', entityId: fiscal_year_id,
      question: `Fiscal close ${action} for ${fiscalYear.name}`,
      normalizedIntent: 'fiscal_close_assistant', selectedTool: 'fiscal_close_assistant',
      model: 'llama-3.3-70b-versatile', latencyMs: totalLatency,
      costUsd: estimatedCost, inputTokens, outputTokens,
      requestId, ipAddress: requestMetadata.ipAddress, userAgent: requestMetadata.userAgent,
    });

    return NextResponse.json(responsePayload);
  } catch (error: any) {
    console.error('Fiscal Close Assistant API error:', error.message);
    return NextResponse.json({ error: 'Failed to generate fiscal close analysis.' }, { status: 500 });
  }
}
