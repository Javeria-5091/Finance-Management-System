// =============================================================================
// AI Reconciliation Suggestions API — Spec 9.4 (P1)
// POST /api/ai/reconciliation-suggestions
//
// Suggests bank-statement to ledger candidate matches for unreconciled lines.
// Spec 9.4: "User confirms match; no silent reconcile"
// =============================================================================

import { NextResponse } from 'next/server';
import { getAuthSupabase } from '@/lib/api-auth';
import {
  logAiAuditEvent,
  extractRequestMetadata,
  generateRequestId,
  updateAiCostTracking,
  calculateCost,
  TokenUsage,
  estimateTokens,
} from '@/lib/ai-cost-tracking';
import { z } from 'zod';

const ReconciliationSuggestionRequestSchema = z.object({
  /** Financial account ID to find matches for */
  financial_account_id: z.string().uuid(),
  /** Statement date to match against */
  statement_date: z.string().optional(),
  /** Max number of suggestions to return */
  limit: z.number().min(1).max(50).default(20),
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
    if (!orgId) return NextResponse.json({ error: 'Organization context missing.' }, { status: 400 });

    // 2. Parse request
    const body = await req.json();
    const parsed = ReconciliationSuggestionRequestSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: 'Invalid request', details: parsed.error.issues }, { status: 400 });
    }

    const { financial_account_id, statement_date, limit } = parsed.data;

    // 3. Fetch unreconciled bank statement lines (Spec 9.4)
    const { data: unreconciledLines, error: linesError } = await supabase.rpc('execute_ai_readonly_query', {
      query_string: `SELECT COALESCE(jsonb_agg(t), '[]'::jsonb) FROM (
        SELECT * FROM reporting.unreconciled_lines
        WHERE financial_account_id = '${financial_account_id}'
        AND is_reconciled = false
        ${statement_date ? `AND statement_date = '${statement_date}'` : ''}
        ORDER BY amount DESC
        LIMIT ${limit}
      ) t`,
    });

    if (linesError) {
      console.error('Unreconciled lines fetch error:', linesError.message);
      return NextResponse.json({ error: 'Failed to fetch unreconciled lines.' }, { status: 500 });
    }

    // 4. Fetch recent un-reconciled journal lines for matching
    const { data: journalLines, error: journalError } = await supabase.rpc('execute_ai_readonly_query', {
      query_string: `SELECT COALESCE(jsonb_agg(t), '[]'::jsonb) FROM (
        SELECT line_id, journal_description, debit_amount, credit_amount, posting_date, account_name
        FROM reporting.general_ledger
        WHERE account_id IN (
          SELECT linked_ledger_account_id FROM finance.financial_accounts WHERE id = '${financial_account_id}'
        )
        AND posting_date >= NOW() - INTERVAL '30 days'
        ORDER BY posting_date DESC
        LIMIT 100
      ) t`,
    });

    // 5. Deterministic matching algorithm (Spec 9.4: "Suggest matches — user confirms")
    const suggestions: any[] = [];
    const lines = unreconciledLines || [];

    for (const line of lines) {
      const matches: any[] = [];

      if (journalLines && Array.isArray(journalLines)) {
        for (const jl of journalLines) {
          const journalAmount = jl.debit_amount || jl.credit_amount || 0;
          // Exact amount match
          if (Math.abs(journalAmount - Math.abs(line.amount)) < 1) {
            matches.push({
              journal_line_id: jl.line_id,
              journal_description: jl.journal_description,
              journal_amount: journalAmount,
              posting_date: jl.posting_date,
              account_name: jl.account_name,
              match_type: 'exact_amount',
              match_confidence: 0.95,
            });
          }
          // Close amount match (within 5%)
          else if (Math.abs(journalAmount - Math.abs(line.amount)) / Math.abs(line.amount) < 0.05) {
            matches.push({
              journal_line_id: jl.line_id,
              journal_description: jl.journal_description,
              journal_amount: journalAmount,
              posting_date: jl.posting_date,
              account_name: jl.account_name,
              match_type: 'close_amount_5pct',
              match_confidence: 0.70,
            });
          }
          // Description similarity (substring match)
          if (line.description && jl.journal_description) {
            const lineDesc = line.description.toLowerCase();
            const journalDesc = jl.journal_description.toLowerCase();
            if (lineDesc.includes(journalDesc.slice(0, 15)) || journalDesc.includes(lineDesc.slice(0, 15))) {
              // Don't add if already in exact match
              if (!matches.find((m) => m.journal_line_id === jl.line_id)) {
                matches.push({
                  journal_line_id: jl.line_id,
                  journal_description: jl.journal_description,
                  journal_amount: journalAmount,
                  posting_date: jl.posting_date,
                  account_name: jl.account_name,
                  match_type: 'description_similarity',
                  match_confidence: 0.60,
                });
              }
            }
          }
        }
      }

      // Sort matches by confidence descending
      matches.sort((a, b) => b.match_confidence - a.match_confidence);

      if (matches.length > 0) {
        suggestions.push({
          statement_line_id: line.id,
          statement_description: line.description,
          statement_amount: line.amount,
          statement_date: line.statement_date,
          statement_reference: line.reference,
          best_match: matches[0],
          all_matches: matches.slice(0, 5),
          match_confidence: matches[0].match_confidence,
        });
      }
    }

    // Sort suggestions by match confidence
    suggestions.sort((a, b) => b.match_confidence - a.match_confidence);

    // 6. Save to ai_suggestions
    if (suggestions.length > 0) {
      await supabase.schema('ai').from('ai_suggestions').insert({
        user_id: user.id,
        organization_id: orgId,
        entity_type: 'reconciliation',
        suggestion_type: 'reconciliation_match',
        confidence: suggestions[0]?.match_confidence > 0.9 ? 'high' : 'medium',
        suggestion_data: { financial_account_id, statement_date, suggestions_count: suggestions.length },
        status: 'pending',
      });
    }

    // 7. Token tracking & audit
    const totalLatency = Date.now() - startTime;
    const inputTokens = estimateTokens(`Reconciliation: ${financial_account_id}`);
    const estimatedCost = calculateCost(inputTokens, 0);

    await updateAiCostTracking(supabase, user.id, orgId, {
      inputTokens, outputTokens: 0, totalTokens: inputTokens,
      estimatedCostUsd: estimatedCost, model: 'deterministic', latencyMs: totalLatency,
    });

    await logAiAuditEvent(supabase, {
      userId: user.id, userEmail: user.email, action: 'AI_RECONCILIATION_SUGGESTION',
      status: 'success', severity: 'info',
      question: `Reconciliation suggestions for account ${financial_account_id}`,
      normalizedIntent: 'reconciliation_suggestion', selectedTool: 'suggest_reconciliation_matches',
      rowCount: suggestions.length, model: 'deterministic',
      latencyMs: totalLatency, requestId,
      ipAddress: requestMetadata.ipAddress, userAgent: requestMetadata.userAgent,
    });

    return NextResponse.json({
      financial_account_id,
      unreconciled_count: lines.length,
      suggestions,
      suggestions_count: suggestions.length,
      compliance_note: 'These are suggestions only. User must confirm each match before reconciliation is recorded.',
    });
  } catch (error: any) {
    console.error('Reconciliation Suggestions API error:', error.message);
    return NextResponse.json({ error: 'Failed to generate reconciliation suggestions.' }, { status: 500 });
  }
}