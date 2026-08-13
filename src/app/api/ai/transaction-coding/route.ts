// =============================================================================
// AI Transaction Categorization API — Spec 9.7 (P1)
// POST /api/ai/transaction-coding
//
// Suggests ledger account, project, vendor, tax code, and description
// for a transaction. Always includes confidence and reasons.
//
// Spec 9.7: "Low-confidence suggestions must remain blank or require full manual input."
// Spec 9.7: "Confidence shown; human approval required"
// =============================================================================

import { createGroq } from '@ai-sdk/groq';
import { generateText } from 'ai';
import { NextResponse } from 'next/server';
import { getAuthSupabase } from '@/lib/api-auth';
import { DATABASE_SCHEMA } from '@/lib/schema';
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

// ─── Request Schema ───
const TransactionCodingRequestSchema = z.object({
  /** Transaction amount */
  amount: z.number(),
  /** Transaction description or reference */
  description: z.string().min(1).max(1000),
  /** Transaction date (YYYY-MM-DD) */
  transaction_date: z.string().optional(),
  /** Existing vendor name (if known) */
  vendor_name: z.string().optional(),
  /** Transaction type for context */
  transaction_type: z.enum(['expense', 'income', 'journal', 'payment', 'receipt']).optional().default('expense'),
  /** Optional: existing project name for project-specific coding */
  project_name: z.string().optional(),
});

// ─── Suggestion Schema (written to ai_suggestions table) ───
interface TransactionSuggestion {
  suggested_account_id: string | null;
  suggested_account_name: string | null;
  suggested_account_code: string | null;
  suggested_project_id: string | null;
  suggested_project_name: string | null;
  suggested_vendor_id: string | null;
  suggested_vendor_name: string | null;
  suggested_tax_code: string | null;
  suggested_description: string | null;
  confidence: 'high' | 'medium' | 'low';
  reasons: string[];
  human_review_required: boolean;
}

// ─── Chart of Accounts for AI context (fetched from DB) ───
async function fetchChartOfAccounts(supabase: any, orgId: string): Promise<string> {
  const { data } = await supabase
    .from('chart_of_accounts')
    .select('id, code, name, account_type')
    .eq('is_active', true)
    .order('code');

  if (!data || data.length === 0) {
    return 'No chart of accounts configured.';
  }

  return data
    .map((a: any) => `  ${a.code} | ${a.name} | ${a.account_type} | ID: ${a.id}`)
    .join('\n');
}

// ─── Projects for AI context ───
async function fetchProjects(supabase: any, orgId: string): Promise<string> {
  const { data } = await supabase
    .from('projects')
    .select('id, name, client_name, status')
    .eq('organization_id', orgId)
    .eq('status', 'active')
    .limit(50);

  if (!data || data.length === 0) return 'No active projects.';

  return data.map((p: any) => `  ${p.name} (Client: ${p.client_name}) | ID: ${p.id}`).join('\n');
}

// ─── Vendors for AI context ───
async function fetchVendors(supabase: any, orgId: string): Promise<string> {
  const { data } = await supabase
    .from('vendors')
    .select('id, name, ntn, is_active')
    .eq('organization_id', orgId)
    .eq('is_active', true)
    .limit(100);

  if (!data || data.length === 0) return 'No vendors configured.';

  return data.map((v: any) => `  ${v.name} (NTN: ${v.ntn || 'N/A'}) | ID: ${v.id}`).join('\n');
}

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
    if (!orgId) {
      return NextResponse.json({ error: 'Organization context missing.' }, { status: 400 });
    }

    // 2. Parse request
    const body = await req.json();
    const parsed = TransactionCodingRequestSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: 'Invalid request', details: parsed.error.issues }, { status: 400 });
    }

    const { amount, description, transaction_date, vendor_name, transaction_type, project_name } = parsed.data;

    // 3. Fetch reference data for AI context
    const [chartOfAccounts, projects, vendors] = await Promise.all([
      fetchChartOfAccounts(supabase, orgId),
      fetchProjects(supabase, orgId),
      fetchVendors(supabase, orgId),
    ]);

    // 4. Generate AI Categorization (Spec 9.7)
    const systemPrompt = `You are a transaction categorization AI for OSYSTIC Finance System.
Suggest the best chart of accounts coding, project allocation, vendor matching, and tax code for the given transaction.

CRITICAL RULES:
1. Return ONLY valid JSON.
2. Match to existing accounts/projects/vendors from the provided lists. Use their exact IDs.
3. If no good match exists, use null — NEVER guess or invent.
4. Provide confidence: 'high' (exact match), 'medium' (likely match), 'low' (uncertain).
5. Low-confidence suggestions (confidence: 'low') should use null so the user must fill manually.
6. Include specific reasons for each suggestion.
7. For expenses, prefer operating expense accounts. For income, prefer revenue accounts.
8. PKR is the default currency.`;

    const userPrompt = `Transaction Details:
- Type: ${transaction_type}
- Amount: PKR ${amount.toLocaleString()}
- Description: ${description}
- Date: ${transaction_date || 'Not specified'}
- Vendor: ${vendor_name || 'Not specified'}
- Project: ${project_name || 'Not specified'}

AVAILABLE CHART OF ACCOUNTS:
${chartOfAccounts}

AVAILABLE PROJECTS:
${projects}

AVAILABLE VENDORS:
${vendors}

Return JSON:
{
  "suggested_account_id": "UUID or null",
  "suggested_account_name": "Account name or null",
  "suggested_account_code": "Account code or null",
  "suggested_project_id": "UUID or null",
  "suggested_project_name": "Project name or null",
  "suggested_vendor_id": "UUID or null",
  "suggested_vendor_name": "Vendor name or null",
  "suggested_tax_code": "tax code or null",
  "suggested_description": "Improved description or null",
  "confidence": "high|medium|low",
  "reasons": ["reason1", "reason2"],
  "human_review_required": true/false
}`;

    const aiResult = await generateText({
      model: groq('llama-3.3-70b-versatile'),
      system: systemPrompt,
      prompt: userPrompt,
    });

    // Parse AI response
    let suggestion: TransactionSuggestion;
    try {
      const rawJson = aiResult.text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      suggestion = JSON.parse(rawJson);
    } catch {
      suggestion = {
        suggested_account_id: null,
        suggested_account_name: null,
        suggested_account_code: null,
        suggested_project_id: null,
        suggested_project_name: null,
        suggested_vendor_id: null,
        suggested_vendor_name: null,
        suggested_tax_code: null,
        suggested_description: description,
        confidence: 'low',
        reasons: ['AI response could not be parsed. Manual review required.'],
        human_review_required: true,
      };
    }

    // 5. Enforce low-confidence = null (Spec 9.7)
    if (suggestion.confidence === 'low') {
      suggestion.suggested_account_id = null;
      suggestion.suggested_account_name = null;
      suggestion.suggested_account_code = null;
      suggestion.human_review_required = true;
    }

    // 6. Save to ai_suggestions (Spec 9.9)
    const { data: suggestionRecord } = await supabase.schema('ai').from('ai_suggestions').insert({
      user_id: user.id,
      organization_id: orgId,
      entity_type: 'transaction',
      suggestion_type: 'transaction_coding',
      confidence: suggestion.confidence,
      suggestion_data: suggestion,
      status: 'pending',
    }).select('id').single();

    // 7. Token tracking & audit
    const totalLatency = Date.now() - startTime;
    const inputTokens = estimateTokens(systemPrompt + userPrompt);
    const outputTokens = estimateTokens(aiResult.text);
    const estimatedCost = calculateCost(inputTokens, outputTokens);

    await updateAiCostTracking(supabase, user.id, orgId, {
      inputTokens, outputTokens, totalTokens: inputTokens + outputTokens,
      estimatedCostUsd: estimatedCost, model: 'llama-3.3-70b-versatile', latencyMs: totalLatency,
    });

    await logAiAuditEvent(supabase, {
      userId: user.id, userEmail: user.email, action: 'AI_TRANSACTION_CODING',
      status: 'success', severity: 'info',
      entityType: 'ai_suggestion', entityId: suggestionRecord?.id,
      question: `Code transaction: ${description} (PKR ${amount})`,
      normalizedIntent: 'transaction_coding', selectedTool: 'suggest_transaction_coding',
      model: 'llama-3.3-70b-versatile', latencyMs: totalLatency,
      costUsd: estimatedCost, inputTokens, outputTokens,
      requestId, ipAddress: requestMetadata.ipAddress, userAgent: requestMetadata.userAgent,
    });

    return NextResponse.json({
      suggestion_id: suggestionRecord?.id,
      ...suggestion,
      compliance_note: 'AI suggestion only. Human review and approval required before posting.',
    });
  } catch (error: any) {
    console.error('Transaction Coding API error:', error.message);
    return NextResponse.json({ error: 'Failed to categorize transaction.' }, { status: 500 });
  }
}
