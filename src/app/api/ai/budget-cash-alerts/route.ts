// =============================================================================
// AI Budget & Cash Alerts API — Spec 9.1 (P0/P1)
// POST /api/ai/budget-cash-alerts
//
// Spec 9.1: "Budget and cash alerts P1 — Explain forecast overruns,
// upcoming obligations, cash runway, and collection risk.
// Deterministic inputs and assumptions displayed."
//
// P0/P1 hybrid: Manual FX and settlement assistant reads platform evidence,
// suggests extracted rate/fees, explains expected-vs-actual PKR variance.
// =============================================================================

import { createGroq } from '@ai-sdk/groq';
import { generateText } from 'ai';
import { NextResponse } from 'next/server';
import { getAuthSupabase, requirePermission, enforceAiRequestLimits, isSqlSafe } from '@/lib/api-auth';
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

const BudgetCashAlertRequestSchema = z.object({
  alert_type: z.enum([
    'budget_overrun',
    'cash_runway',
    'upcoming_obligations',
    'collection_risk',
    'fx_variance',
    'all_alerts',
  ]).default('all_alerts'),
  project_id: z.string().uuid().optional(),
  budget_id: z.string().uuid().optional(),
  days_ahead: z.number().min(7).max(365).default(30),
});

export async function POST(req: Request) {
  const permission = await requirePermission('REPORT_READ');
  if (permission instanceof NextResponse) return permission;
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
    if (!orgId) return NextResponse.json({ error: 'Organization context missing.' }, { status: 400 });

    const aiLimitCheck = await enforceAiRequestLimits(supabase, user.id, orgId);
    if (aiLimitCheck) return aiLimitCheck;

    // 2. Parse request
    const body = await req.json();
    const parsed = BudgetCashAlertRequestSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: 'Invalid request', details: parsed.error.issues }, { status: 400 });
    }

    const { alert_type, project_id, budget_id, days_ahead } = parsed.data;

    // 3. Gather deterministic data for alerts
    const alertData: Record<string, any> = {};

    // Cash position
    const cashQuery = `SELECT COALESCE(jsonb_agg(t), '[]'::jsonb) FROM (
        SELECT * FROM reporting.v_cash_position WHERE organization_id = '${orgId}' LIMIT 50
      ) t`;
    const cashSafety = await isSqlSafe(cashQuery);
    if (!cashSafety.safe) {
      return NextResponse.json({ error: 'Query safety check failed', reason: cashSafety.reason }, { status: 500 });
    }
    const { data: cashPosition } = await supabase.rpc('execute_ai_readonly_query', {
      query_string: cashQuery,
    });
    alertData.cash_position = cashPosition || [];

    // Budget vs actual
    const budgetQuery = `SELECT COALESCE(jsonb_agg(t), '[]'::jsonb) FROM (
        SELECT * FROM reporting.budget_vs_actual
        WHERE organization_id = '${orgId}'
        AND utilization_pct > 80
        ${budget_id ? `AND budget_id = '${budget_id}'` : ''}
        ${project_id ? `AND project_id = '${project_id}'` : ''}
        LIMIT 50
      ) t`;
    const budgetSafety = await isSqlSafe(budgetQuery);
    if (!budgetSafety.safe) {
      return NextResponse.json({ error: 'Query safety check failed', reason: budgetSafety.reason }, { status: 500 });
    }
    const { data: budgetVsActual } = await supabase.rpc('execute_ai_readonly_query', {
      query_string: budgetQuery,
    });
    alertData.budget_overruns = budgetVsActual || [];

    // Payable aging (upcoming obligations)
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() + days_ahead);

    const payableQuery = `SELECT COALESCE(jsonb_agg(t), '[]'::jsonb) FROM (
        SELECT * FROM reporting.payable_aging
        WHERE organization_id = '${orgId}'
        AND due_date <= '${cutoffDate.toISOString().split('T')[0]}'
        AND outstanding_amount > 0
        ORDER BY due_date ASC
        LIMIT 50
      ) t`;
    const payableSafety = await isSqlSafe(payableQuery);
    if (!payableSafety.safe) {
      return NextResponse.json({ error: 'Query safety check failed', reason: payableSafety.reason }, { status: 500 });
    }
    const { data: upcomingPayables } = await supabase.rpc('execute_ai_readonly_query', {
      query_string: payableQuery,
    });
    alertData.upcoming_obligations = upcomingPayables || [];

    // Receivable aging (collection risk)
    const receivableQuery = `SELECT COALESCE(jsonb_agg(t), '[]'::jsonb) FROM (
        SELECT * FROM reporting.receivable_aging
        WHERE organization_id = '${orgId}'
        AND (overdue_1_30_days > 0 OR overdue_31_60_days > 0 OR overdue_61_90_days > 0 OR overdue_over_90_days > 0)
        ORDER BY overdue_over_90_days DESC
        LIMIT 50
      ) t`;
    const receivableSafety = await isSqlSafe(receivableQuery);
    if (!receivableSafety.safe) {
      return NextResponse.json({ error: 'Query safety check failed', reason: receivableSafety.reason }, { status: 500 });
    }
    const { data: collectionRisk } = await supabase.rpc('execute_ai_readonly_query', {
      query_string: receivableQuery,
    });
    alertData.collection_risk = collectionRisk || [];

    // 4. Generate AI alert analysis
    const systemPrompt = `You are a financial alerts analyst for OSYSTIC Finance System.
Analyze the provided data and generate actionable alerts.

CRITICAL RULES:
1. All amounts in PKR.
2. Each alert must include: severity (critical/warning/info), description, amount, and recommended action.
3. Only use the provided data — never invent numbers.
4. For budget overruns: explain percentage used, remaining, and projected overrun date.
5. For cash runway: calculate based on current burn rate from the data.
6. For obligations: list top upcoming payments by date and amount.
7. For collection risk: prioritize by overdue days and amount.
8. Be concise and actionable.`;

    const alertTypeFilter = alert_type === 'all_alerts'
      ? 'Generate alerts for ALL categories: budget overruns, cash runway, upcoming obligations, and collection risk.'
      : `Generate alerts ONLY for: ${alert_type}.`;

    const userPrompt = `${alertTypeFilter}

CASH POSITION:
${JSON.stringify(alertData.cash_position).slice(0, 3000)}

BUDGET vs ACTUAL (utilization > 80%):
${JSON.stringify(alertData.budget_overruns).slice(0, 3000)}

UPCOMING OBLIGATIONS (next ${days_ahead} days):
${JSON.stringify(alertData.upcoming_obligations).slice(0, 3000)}

COLLECTION RISK (overdue receivables):
${JSON.stringify(alertData.collection_risk).slice(0, 3000)}

Return JSON:
{
  "alerts": [{"severity": "critical|warning|info", "type": "budget_overrun|cash_runway|obligation|collection_risk", "description": "...", "amount": number, "entity": "...", "recommended_action": "...", "deadline": "YYYY-MM-DD or null"}],
  "summary": "Overall financial health summary (2-3 sentences)"
}`;

    const aiResult = await generateText({
      model: groq('llama-3.3-70b-versatile'),
      system: systemPrompt,
      prompt: userPrompt,
    });

    // Parse response
    let alerts: any[] = [];
    let summary = 'Unable to generate alert summary.';
    try {
      const rawJson = aiResult.text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      const parsed = JSON.parse(rawJson);
      alerts = parsed.alerts || [];
      summary = parsed.summary || summary;
    } catch {
      summary = aiResult.text.slice(0, 500);
    }

    // 5. Build response
    const totalLatency = Date.now() - startTime;
    const responsePayload = {
      alert_type,
      days_ahead,
      alerts,
      summary,
      data_sources: {
        cash_accounts: Array.isArray(alertData.cash_position) ? alertData.cash_position.length : 0,
        budget_overruns: Array.isArray(alertData.budget_overruns) ? alertData.budget_overruns.length : 0,
        upcoming_obligations: Array.isArray(alertData.upcoming_obligations) ? alertData.upcoming_obligations.length : 0,
        at_risk_receivables: Array.isArray(alertData.collection_risk) ? alertData.collection_risk.length : 0,
      },
      assumptions: 'Based on current posted data. Forecast amounts are projections from deterministic inputs only.',
      data_as_of: new Date().toISOString(),
      compliance_note: 'Alerts are based on deterministic report data. Verify with official reports before making financial decisions.',
    };

    // 6. Token tracking & audit
    const inputTokens = estimateTokens(systemPrompt + userPrompt);
    const outputTokens = estimateTokens(aiResult.text);
    const estimatedCost = calculateCost(inputTokens, outputTokens);

    await updateAiCostTracking(supabase, user.id, orgId, {
      inputTokens, outputTokens, totalTokens: inputTokens + outputTokens,
      estimatedCostUsd: estimatedCost, model: 'llama-3.3-70b-versatile', latencyMs: totalLatency,
    });

    await logAiAuditEvent(supabase, {
      userId: user.id, userEmail: user.email, action: 'AI_BUDGET_CASH_ALERTS',
      status: 'success', severity: 'info',
      question: `${alert_type} alerts for next ${days_ahead} days`,
      normalizedIntent: 'budget_cash_alerts', selectedTool: 'budget_cash_alerts',
      rowCount: alerts.length, model: 'llama-3.3-70b-versatile',
      latencyMs: totalLatency, costUsd: estimatedCost, inputTokens, outputTokens,
      requestId, ipAddress: requestMetadata.ipAddress, userAgent: requestMetadata.userAgent,
    });

    return NextResponse.json(responsePayload);
  } catch (error: any) {
    console.error('Budget Cash Alerts API error:', error.message);
    return NextResponse.json({ error: 'Failed to generate budget/cash alerts.' }, { status: 500 });
  }
}