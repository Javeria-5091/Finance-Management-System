// =============================================================================
// AI Policy/Document Q&A API — Spec 9.4 (P1)
// POST /api/ai/policy-qa
//
// Permission-aware RAG over finance policies, contracts, and procedures.
// Spec 9.4: "Permission-aware retrieval and source references"
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

const PolicyQaRequestSchema = z.object({
  question: z.string().min(5).max(2000),
  context: z.string().optional(), // Optional additional context
  document_ids: z.array(z.string().uuid()).optional(), // Optional specific document IDs
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
    const parsed = PolicyQaRequestSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: 'Invalid request', details: parsed.error.issues }, { status: 400 });
    }

    const { question, context, document_ids } = parsed.data;

    // 3. Retrieve relevant policy documents (permission-aware)
    // NOTE: This is a placeholder for a proper RAG/vector search implementation.
    // For production, integrate with Supabase Vector or pgvector for semantic search.
    // Currently uses a keyword-based search on policy documents table.

    const searchTerms = question
      .toLowerCase()
      .replace(/[?!.,;:'"]/g, '')
      .split(/\s+/)
      .filter((w) => w.length > 3)
      .slice(0, 10);

    let policyContext = 'No specific policy documents found.';

    // Try to search for relevant documents (future: use vector embeddings)
    if (searchTerms.length > 0) {
      const searchQuery = searchTerms.map((term) => `content ILIKE '%${term}%'`).join(' OR ');

      const { data: documents } = await supabase.rpc('execute_ai_readonly_query', {
        query_string: `SELECT COALESCE(jsonb_agg(t), '[]'::jsonb) FROM (
          SELECT id, title, SUBSTRING(content, 1, 2000) as content_excerpt, document_type, updated_at
          FROM public.policy_documents
          WHERE organization_id = '${orgId}'
          AND (${searchQuery})
          LIMIT 5
        ) t`,
      });

      if (documents && Array.isArray(documents) && documents.length > 0) {
        policyContext = documents
          .map((d: any) => `--- Document: ${d.title} (${d.document_type}, ${new Date(d.updated_at).toLocaleDateString()}) ---\n${d.content_excerpt}`)
          .join('\n\n');
      }
    }

    // 4. Generate answer with source references (Spec 9.4)
    const systemPrompt = `You are a finance policy assistant for OSYSTIC Finance Management System.
Answer questions based on the provided policy documents and context.

CRITICAL RULES:
1. Answer ONLY from the provided policy documents or explicit organizational knowledge.
2. If the documents don't contain the answer, say "This information is not available in the current policy documents."
3. Cite specific source documents for every factual claim.
4. Do not invent policies or procedures.
5. If the question requires legal/tax advice, recommend consulting the appropriate professional.
6. Keep answers concise and actionable.`;

    const userPrompt = `Question: ${question}

${context ? `Additional Context: ${context}` : ''}

RELEVANT POLICY DOCUMENTS:
${policyContext}

Provide a clear answer with source document citations.`;

    const aiResult = await generateText({
      model: groq('llama-3.3-70b-versatile'),
      system: systemPrompt,
      prompt: userPrompt,
    });

    // 5. Build response
    const sourcesCited = extractSources(aiResult.text);
    const totalLatency = Date.now() - startTime;

    const responsePayload = {
      answer: aiResult.text,
      sources: sourcesCited,
      confidence: policyContext !== 'No specific policy documents found.' ? 'medium' : 'low',
      compliance_note: 'AI-generated policy interpretation. For authoritative decisions, consult the approved policy document or legal counsel.',
      data_as_of: new Date().toISOString(),
    };

    // 6. Token tracking & audit
    const inputTokens = estimateTokens(systemPrompt + userPrompt + policyContext);
    const outputTokens = estimateTokens(aiResult.text);
    const estimatedCost = calculateCost(inputTokens, outputTokens);

    await updateAiCostTracking(supabase, user.id, orgId, {
      inputTokens, outputTokens, totalTokens: inputTokens + outputTokens,
      estimatedCostUsd: estimatedCost, model: 'llama-3.3-70b-versatile', latencyMs: totalLatency,
    });

    await logAiAuditEvent(supabase, {
      userId: user.id, userEmail: user.email, action: 'AI_POLICY_QA',
      status: 'success', severity: 'info',
      question, normalizedIntent: 'policy_qa', selectedTool: 'search_finance_policies',
      rowCount: sourcesCited.length, model: 'llama-3.3-70b-versatile',
      latencyMs: totalLatency, costUsd: estimatedCost, inputTokens, outputTokens,
      requestId, ipAddress: requestMetadata.ipAddress, userAgent: requestMetadata.userAgent,
    });

    return NextResponse.json(responsePayload);
  } catch (error: any) {
    console.error('Policy Q&A API error:', error.message);
    return NextResponse.json({ error: 'Failed to answer policy question.' }, { status: 500 });
  }
}

// =============================================================================
// HELPER: Extract source citations from AI response
// =============================================================================

function extractSources(text: string): string[] {
  const sources: string[] = [];
  // Look for patterns like "Source: Document Name" or "According to..."
  const patterns = text.match(/(?:Source|According to|Referenc(?:e|ing)|See|Per|Under|As per)[:\s]+([^\n,.]+)/gi);
  if (patterns) {
    for (const p of patterns) {
      const source = p.replace(/^(?:Source|According to|Referenc(?:e|ing)|See|Per|Under|As per)[:\s]+/i, '').trim();
      if (source.length > 3) sources.push(source);
    }
  }
  return [...new Set(sources)].slice(0, 5);
}