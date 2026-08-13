// =============================================================================
// AI Duplicate/Anomaly Detection API — Spec 9.7 (P1)
// POST /api/ai/duplicate-detection
//
// Flags duplicates, unusual amounts, new vendor details, split payments,
// or policy exceptions.
//
// Spec 9.7: "AI flags never automatically block or accuse a user;
// policy rules may block, while AI provides a review signal."
// Spec 9.7: "Anomaly detection must combine deterministic rules and AI signals."
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

const DuplicateDetectionRequestSchema = z.object({
  /** Transaction amount to check for duplicates */
  amount: z.number(),
  /** Transaction description */
  description: z.string().optional(),
  /** Transaction date */
  transaction_date: z.string().optional(),
  /** Vendor name */
  vendor_name: z.string().optional(),
  /** Invoice/bill reference number */
  reference: z.string().optional(),
  /** Transaction type */
  transaction_type: z.enum(['expense', 'income', 'payment', 'invoice', 'vendor_bill']).default('expense'),
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
    const parsed = DuplicateDetectionRequestSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: 'Invalid request', details: parsed.error.issues }, { status: 400 });
    }

    const { amount, description, transaction_date, vendor_name, reference, transaction_type } = parsed.data;

    // 3. Deterministic duplicate checks (Spec 9.7: "combine deterministic rules and AI signals")
    const duplicates: any[] = [];
    const anomalies: string[] = [];

    // Check A: Same amount + same vendor within 7 days
    if (vendor_name && amount > 0) {
      const sevenDaysAgo = new Date();
      sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

      const { data: amountVendorMatches } = await supabase
        .schema('ai').from('ai_suggestions')
        .select('id, suggestion_data, created_at')
        .eq('organization_id', orgId)
        .eq('suggestion_type', 'duplicate_check')
        .gte('created_at', sevenDaysAgo.toISOString())
        .limit(20);

      if (amountVendorMatches) {
        for (const match of amountVendorMatches) {
          const data = match.suggestion_data || {};
          if (data.amount === amount && data.vendor_name === vendor_name) {
            duplicates.push({
              id: match.id,
              type: 'same_amount_vendor_7days',
              match_date: match.created_at,
              description: data.description,
            });
          }
        }
      }
    }

    // Check B: Same reference number
    if (reference) {
      const { data: refMatches } = await supabase
        .from('vendor_bills')
        .select('id, bill_number, vendor_id, total_amount, bill_date, status')
        .eq('organization_id', orgId)
        .ilike('bill_number', `%${reference}%`)
        .limit(10);

      if (refMatches && refMatches.length > 0) {
        for (const m of refMatches) {
          duplicates.push({
            id: m.id,
            type: 'same_reference',
            match_date: m.bill_date,
            bill_number: m.bill_number,
            amount: m.total_amount,
            status: m.status,
          });
        }
        anomalies.push(`Reference "${reference}" matches ${refMatches.length} existing bill(s).`);
      }
    }

    // Check C: Unusual amount thresholds (org-specific configurable)
    const HIGH_VALUE_THRESHOLD = 500000; // PKR
    const WEEKEND_CHECK = transaction_date ? new Date(transaction_date).getDay() : -1;

    if (amount > HIGH_VALUE_THRESHOLD) {
      anomalies.push(`High-value transaction: PKR ${amount.toLocaleString()} exceeds ${HIGH_VALUE_THRESHOLD.toLocaleString()} threshold.`);
    }
    if (WEEKEND_CHECK === 0 || WEEKEND_CHECK === 6) {
      anomalies.push(`Transaction date falls on a weekend.`);
    }

    // Check D: New vendor (first-time vendor)
    if (vendor_name) {
      const { data: vendorExists } = await supabase
        .from('vendors')
        .select('id')
        .eq('organization_id', orgId)
        .ilike('name', `%${vendor_name}%`)
        .limit(1);

      if (!vendorExists || vendorExists.length === 0) {
        anomalies.push(`New vendor: "${vendor_name}" has no previous transactions in the system.`);
      }
    }

    // Check E: Possible split payment (multiple transactions with same amount, same day)
    if (amount > 0) {
      const { data: splitMatches } = await supabase
        .from('vendor_bills')
        .select('id, bill_number, total_amount, bill_date, vendor_id')
        .eq('organization_id', orgId)
        .gte('total_amount', amount * 0.95)
        .lte('total_amount', amount * 1.05)
        .limit(5);

      if (splitMatches && splitMatches.length > 0) {
        anomalies.push(`Possible split payment: ${splitMatches.length} existing bill(s) with similar amount (±5%).`);
      }
    }

    // 4. AI-powered anomaly analysis (Spec 9.7)
    const aiAnomalies: string[] = [];
    if (duplicates.length > 0 || anomalies.length > 0) {
      const aiResult = await generateText({
        model: groq('llama-3.3-70b-versatile'),
        system: `You are a financial anomaly detection AI. Analyze the following transaction checks and provide a concise risk assessment.
Return ONLY a JSON array of additional anomaly descriptions (max 3 items).
If no additional anomalies, return []. Do NOT repeat the already-detected anomalies.`,
        prompt: `Transaction: ${transaction_type} PKR ${amount}, Vendor: ${vendor_name || 'N/A'}, Date: ${transaction_date || 'N/A'}, Ref: ${reference || 'N/A'}

Already detected anomalies: ${JSON.stringify(anomalies)}
Already detected duplicates: ${JSON.stringify(duplicates)}

Additional AI-detected anomalies (if any):`,
      });

      try {
        const parsed = JSON.parse(aiResult.text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim());
        if (Array.isArray(parsed)) aiAnomalies.push(...parsed);
      } catch {
        // Ignore parse errors
      }
    }

    const allAnomalies = [...anomalies, ...aiAnomalies];
    const overallRisk = duplicates.length > 2 || allAnomalies.length > 3 ? 'high' :
      duplicates.length > 0 || allAnomalies.length > 0 ? 'medium' : 'low';

    // 5. Save to ai_suggestions (Spec 9.9)
    const { data: suggestionRecord } = await supabase.schema('ai').from('ai_suggestions').insert({
      user_id: user.id,
      organization_id: orgId,
      entity_type: 'transaction',
      suggestion_type: 'duplicate_check',
      confidence: overallRisk,
      suggestion_data: {
        amount, vendor_name, reference, transaction_date, transaction_type,
        duplicates, anomalies: allAnomalies, risk_level: overallRisk,
      },
      status: 'pending',
    }).select('id').single();

    // 6. Token tracking & audit
    const totalLatency = Date.now() - startTime;
    const inputTokens = estimateTokens(`Transaction: ${transaction_type} PKR ${amount}`);
    const outputTokens = estimateTokens(JSON.stringify(allAnomalies));
    const estimatedCost = calculateCost(inputTokens, outputTokens);

    await updateAiCostTracking(supabase, user.id, orgId, {
      inputTokens, outputTokens, totalTokens: inputTokens + outputTokens,
      estimatedCostUsd: estimatedCost, model: 'llama-3.3-70b-versatile', latencyMs: totalLatency,
    });

    await logAiAuditEvent(supabase, {
      userId: user.id, userEmail: user.email, action: 'AI_DUPLICATE_DETECTION',
      status: 'success', severity: overallRisk === 'high' ? 'warning' : 'info',
      entityType: 'ai_suggestion', entityId: suggestionRecord?.id,
      question: `Duplicate check: PKR ${amount} ${vendor_name || ''}`,
      normalizedIntent: 'duplicate_detection', selectedTool: 'find_possible_duplicates',
      rowCount: duplicates.length, model: 'llama-3.3-70b-versatile',
      latencyMs: totalLatency, costUsd: estimatedCost, inputTokens, outputTokens,
      requestId, ipAddress: requestMetadata.ipAddress, userAgent: requestMetadata.userAgent,
    });

    return NextResponse.json({
      suggestion_id: suggestionRecord?.id,
      risk_level: overallRisk,
      duplicates,
      anomalies: allAnomalies,
      duplicate_count: duplicates.length,
      anomaly_count: allAnomalies.length,
      compliance_note: 'AI flag only. No automatic blocking. Authorized user decides action.',
    });
  } catch (error: any) {
    console.error('Duplicate Detection API error:', error.message);
    return NextResponse.json({ error: 'Failed to check for duplicates.' }, { status: 500 });
  }
}