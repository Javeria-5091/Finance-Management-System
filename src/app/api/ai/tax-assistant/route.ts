// =============================================================================
// AI Tax Planning & Return-Support Assistant API — Spec 9.1 (P1)
// POST /api/ai/tax-assistant
//
// Spec 9.1: "Explain Profit Before Tax to taxable-income adjustments,
// identify missing evidence, summarize tax credits/payments,
// compare estimates, and prepare a review checklist/narrative."
//
// Spec 9.8.1: "AI must not invent tax slabs, decide that an expense is
// legally deductible, select a taxpayer type, alter tax rules, approve
// a tax computation, submit a return, initiate a tax payment, or
// represent its explanation as professional tax advice."
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

// SECURITY FIX (BUG-004, CRITICAL — SQL injection): tax_year is a
// client-supplied string. It must never be interpolated into a SQL string
// without being validated against a strict allowlist pattern first. Real
// tax-year labels used elsewhere in this system look like "2025-2026" or
// "2026" (see finance.tax_reconciliations.tax_year) — this pattern is
// deliberately narrow (digits/hyphen only) so no SQL metacharacter (quote,
// semicolon, comment, etc.) can ever reach the query string below.
const TAX_YEAR_PATTERN = /^[0-9]{4}(-[0-9]{4})?$/;

const TaxAssistantRequestSchema = z.object({
  action: z.enum([
    'explain_adjustments',
    'missing_evidence',
    'tax_credits_summary',
    'estimate_comparison',
    'return_checklist',
    'general_question',
  ]).default('general_question'),
  tax_year: z.string().optional(),
  question: z.string().optional().default(''),
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
    const parsed = TaxAssistantRequestSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: 'Invalid request', details: parsed.error.issues }, { status: 400 });
    }

    const { action, tax_year, question } = parsed.data;

    // SECURITY FIX (BUG-004, CRITICAL): reject any tax_year that doesn't
    // match the strict allowlist pattern before it can be used anywhere,
    // including inside a SQL string.
    if (tax_year && !TAX_YEAR_PATTERN.test(tax_year)) {
      return NextResponse.json({ error: 'Invalid tax_year format.' }, { status: 400 });
    }

    // 3. Fetch tax computation data (read-only)
    let taxData = '';

    if (tax_year) {
      // SECURITY FIX (BUG-004, CRITICAL — SQL injection):
      // The previous version built the ENTIRE wrapped/scoped query
      // (including `organization_id = '${orgId}'`) as a single hand-built
      // string and passed only `{ query_string }` to
      // execute_ai_readonly_query() — an overload that no longer exists
      // (P1_006b_ai_function.sql dropped the single-argument version), and
      // which additionally interpolated the client-supplied `tax_year`
      // directly into SQL with no escaping, a SQL injection vector.
      //
      // The correct, already-established pattern in this codebase (see
      // src/app/api/chat/route.ts) is to pass ONLY the inner SELECT as
      // `query_string`, and let the database function itself apply the
      // organization scope via a typed `uuid` parameter (`p_org_id`) using
      // `format(...,%L)` — which cannot be bypassed by string content. We
      // now follow that same pattern here. `tax_year` is embedded in the
      // inner SELECT, but only after being validated against
      // TAX_YEAR_PATTERN above, so no SQL metacharacter can reach it.
      // `p_enforce_user_scope: false` because
      // reporting.v_tax_computation_summary is an organization-level view
      // with no user_id column (per-user filtering would fail closed with
      // an "undefined_column" error from the DB function otherwise).
      const innerQuery = `SELECT * FROM reporting.v_tax_computation_summary WHERE tax_year = '${tax_year}'`;

      const { data: taxSummary, error: taxErr } = await supabase.rpc('execute_ai_readonly_query', {
        query_string: innerQuery,
        p_org_id: orgId,
        p_user_id: user.id,
        p_enforce_user_scope: false,
      });

      if (taxErr) {
        console.error('Tax Assistant: tax summary query failed:', taxErr.message);
      } else if (taxSummary && Array.isArray(taxSummary) && taxSummary.length > 0) {
        taxData = JSON.stringify(taxSummary, null, 2);
      }
    }

    // 4. Generate AI response based on action (Spec 9.8.1 safety constraints)
    const systemPrompt = `You are a tax planning assistant for OSYSTIC Finance System.

ABSOLUTE SAFETY RULES (Spec 9.8.1 — NON-NEGOTIABLE):
1. You must NOT invent tax slabs, rates, or thresholds.
2. You must NOT decide that an expense is legally deductible.
3. You must NOT select or change taxpayer type.
4. You must NOT alter, override, or modify tax rules.
5. You must NOT approve a tax computation.
6. You must NOT submit a tax return or initiate a tax payment.
7. You must NOT represent your explanation as professional tax advice.
8. Every response MUST identify: organization, tax year/period, computation status, data-as-of time.
9. If amounts are estimated vs filed, you MUST state which.
10. You EXPLAIN only — the accountant decides deductibility, rule selection, approval, filing, payment.

Authoritative figures come from the deterministic tax computation service. You explain what they mean.

Amounts are in PKR unless otherwise stated.`;

    const actionPrompts: Record<string, string> = {
      explain_adjustments: `Explain the Profit Before Tax (PBT) to taxable-income adjustments for tax year ${tax_year || 'current'}.
For each adjustment, explain: what it is, why it exists, and reference the underlying data.
Do NOT suggest adding or removing adjustments — only explain the existing ones.\n\n${taxData}`,
      missing_evidence: `Identify potentially missing evidence or supporting documents for the tax computation of year ${tax_year || 'current'}.
Check for: withholding certificates, tax credit proofs, expense documentation, and filing evidence.\n\n${taxData}`,
      tax_credits_summary: `Summarize all tax credits, withholding tax, and advance tax for year ${tax_year || 'current'}.
List each credit type, amount, and whether evidence is on file.\n\n${taxData}`,
      estimate_comparison: `Compare estimated tax vs actual/provision for year ${tax_year || 'current'}.
Highlight variances and potential reasons.\n\n${taxData}`,
      return_checklist: `Prepare a tax return review checklist for year ${tax_year || 'current'}.
Include: computation verification, evidence completeness, credit verification, filing readiness.
This is a DRAFT checklist for accountant review — NOT a substitute for professional filing.\n\n${taxData}`,
      general_question: `${question}\n\nTax computation data:\n${taxData || 'No specific tax year data provided.'}`,
    };

    const aiResult = await generateText({
      model: groq('llama-3.3-70b-versatile'),
      system: systemPrompt,
      prompt: actionPrompts[action],
    });

    // 5. Build response
    const totalLatency = Date.now() - startTime;
    const responsePayload = {
      action,
      tax_year: tax_year || null,
      analysis: aiResult.text,
      computation_status: taxData ? 'data_available' : 'no_data',
      data_as_of: new Date().toISOString(),
      confidence: taxData ? 'medium' : 'low',
      compliance_note: 'AI explanation only. NOT professional tax advice. Accountant decides all tax actions: deductibility, rule selection, approval, filing, payment, and amendments.',
      safety_reminder: 'This AI cannot approve tax computations, submit returns, or initiate payments. All tax decisions require authorized accountant approval.',
    };

    // 6. Token tracking & audit
    const inputTokens = estimateTokens(systemPrompt + actionPrompts[action] + taxData);
    const outputTokens = estimateTokens(aiResult.text);
    const estimatedCost = calculateCost(inputTokens, outputTokens);

    await updateAiCostTracking(supabase, user.id, orgId, {
      inputTokens, outputTokens, totalTokens: inputTokens + outputTokens,
      estimatedCostUsd: estimatedCost, model: 'llama-3.3-70b-versatile', latencyMs: totalLatency,
    });

    await logAiAuditEvent(supabase, {
      userId: user.id, userEmail: user.email, action: 'AI_TAX_ASSISTANT',
      status: 'success', severity: 'info',
      question: question || `Tax ${action} for year ${tax_year || 'current'}`,
      normalizedIntent: 'tax_assistant', selectedTool: action === 'return_checklist' ? 'prepare_tax_return_checklist' : 'explain_tax_reconciliation',
      model: 'llama-3.3-70b-versatile', latencyMs: totalLatency,
      costUsd: estimatedCost, inputTokens, outputTokens,
      requestId, ipAddress: requestMetadata.ipAddress, userAgent: requestMetadata.userAgent,
    });

    return NextResponse.json(responsePayload);
  } catch (error: any) {
    console.error('Tax Assistant API error:', error.message);
    return NextResponse.json({ error: 'Failed to generate tax analysis.' }, { status: 500 });
  }
}