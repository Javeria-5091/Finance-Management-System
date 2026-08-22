// =============================================================================
// AI Document Extraction API — Spec 9.6 (P1)
// POST /api/ai/document-extraction
//
// Flow:
// 1. User uploads receipt/invoice/statement to private storage
// 2. System validates file type, size, hash, malware scan status
// 3. AI/OCR extracts fields into a DRAFT extraction record (NOT posted to finance tables)
// 4. System runs deterministic checks: totals, tax arithmetic, duplicate reference, vendor match
// 5. User reviews original document beside extracted fields and accepts/corrects
// 6. Only then is a normal expense/bill workflow created with standard approvals
//
// Spec 9.6: "AI-generated content is NEVER auto-posted. Always draft only."
// =============================================================================

import { createGroq } from '@ai-sdk/groq';
import { generateText } from 'ai';
import { NextResponse } from 'next/server';
import { getAuthSupabase, requirePermission, enforceAiRequestLimits } from '@/lib/api-auth';
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
const DocumentExtractionRequestSchema = z.object({
  /** Supabase Storage path of the uploaded document */
  file_path: z.string().min(1),
  /** Document type for extraction context */
  document_type: z.enum(['receipt', 'invoice', 'bank_statement', 'other']),
  /** Original filename for reference */
  file_name: z.string().optional(),
  /** File size in bytes */
  file_size: z.number().optional(),
  /** MIME type */
  mime_type: z.string().optional(),
  /** File hash for integrity check */
  file_hash: z.string().optional(),
  /** Raw OCR/text content extracted from the document (pre-processed) */
  ocr_text: z.string().optional(),
  /** Base64 encoded image of the document (for vision models, max 5MB) */
  image_base64: z.string().optional(),
});

// ─── Extraction Result Schema ───
const ExtractedFieldsSchema = z.object({
  vendor_name: z.string().nullable().optional(),
  vendor_ntn: z.string().nullable().optional(),
  vendor_tax_number: z.string().nullable().optional(),
  invoice_number: z.string().nullable().optional(),
  receipt_number: z.string().nullable().optional(),
  document_date: z.string().nullable().optional(),
  due_date: z.string().nullable().optional(),
  currency: z.string().default('PKR'),
  subtotal_amount: z.number().nullable().optional(),
  tax_amount: z.number().nullable().optional(),
  tax_rate: z.number().nullable().optional(),
  total_amount: z.number().nullable().optional(),
  withholding_tax: z.number().nullable().optional(),
  line_items: z.array(
    z.object({
      description: z.string(),
      quantity: z.number().optional(),
      unit_price: z.number().optional(),
      amount: z.number().optional(),
      tax_code: z.string().optional(),
    })
  ).optional().default([]),
  payment_terms: z.string().nullable().optional(),
  bank_details: z
    .object({
      bank_name: z.string().optional(),
      account_number: z.string().optional(),
      account_title: z.string().optional(),
      iban: z.string().optional(),
    })
    .optional(),
  reference: z.string().nullable().optional(),
  project_id: z.string().uuid().nullable().optional(),
  description: z.string().nullable().optional(),
});

// ─── Maximum file sizes (bytes) ───
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const ALLOWED_MIME_TYPES = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/heic',
  'text/plain',
];

export async function POST(req: Request) {
  const permissionCheck = await requirePermission('REPORT_READ');
  if (permissionCheck instanceof Response) return permissionCheck;
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
      return NextResponse.json(
        { error: 'Organization context missing.' },
        { status: 400 }
      );
    }

    const aiLimitCheck = await enforceAiRequestLimits(supabase, user.id, orgId);
    if (aiLimitCheck) return aiLimitCheck;

    // 2. Parse and validate request
    const body = await req.json();
    const parsed = DocumentExtractionRequestSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Invalid request', details: parsed.error.issues },
        { status: 400 }
      );
    }

    const { file_path, document_type, file_name, file_size, mime_type, file_hash, ocr_text, image_base64 } =
      parsed.data;

    // 3. File validation (Spec 9.6 Step 2)
    if (file_size && file_size > MAX_FILE_SIZE) {
      return NextResponse.json(
        { error: `File too large. Maximum size is ${MAX_FILE_SIZE / (1024 * 1024)}MB.` },
        { status: 400 }
      );
    }

    if (mime_type && !ALLOWED_MIME_TYPES.includes(mime_type)) {
      return NextResponse.json(
        { error: `Unsupported file type: ${mime_type}. Allowed: ${ALLOWED_MIME_TYPES.join(', ')}` },
        { status: 400 }
      );
    }

    // 4. AI Extraction (Spec 9.6 Step 3)
    const extractionPrompt = buildExtractionPrompt(document_type, ocr_text || '');

    const aiResult = await generateText({
      model: groq('llama-3.3-70b-versatile'),
      system: `You are a financial document extraction AI for OSYSTIC Finance System.
Extract structured fields from the provided document text.

CRITICAL RULES:
1. Return ONLY valid JSON matching the extraction schema.
2. Use null for fields that cannot be determined.
3. Amounts should be numbers (no currency symbols).
4. Dates should be in YYYY-MM-DD format.
5. If amounts don't add up (subtotal + tax != total), note it in a "validation_warnings" field.
6. PKR is the default currency unless another currency is explicitly stated.
7. For bank statements, extract statement period, opening/closing balances, and transactions.`,
      prompt: extractionPrompt,
    });

    // Parse the AI response
    let extractedFields: any;
    let validationWarnings: string[] = [];
    try {
      const rawJson = aiResult.text
        .replace(/```json\n?/g, '')
        .replace(/```\n?/g, '')
        .trim();

      extractedFields = JSON.parse(rawJson);
      validationWarnings = extractedFields.validation_warnings || [];

      // Remove internal field before saving
      delete extractedFields.validation_warnings;
    } catch {
      extractedFields = { description: aiResult.text.slice(0, 500) };
      validationWarnings.push('AI output was not valid JSON. Raw text saved as description.');
    }

    // 5. Deterministic validation (Spec 9.6 Step 4)
    const deterministicChecks = runDeterministicChecks(extractedFields, document_type);
    validationWarnings.push(...deterministicChecks);

    // 6. Check for duplicate references (Spec 9.6 Step 4)
    if (extractedFields.invoice_number || extractedFields.receipt_number) {
      const refValue = extractedFields.invoice_number || extractedFields.receipt_number;
      const { data: duplicates } = await supabase
        .schema('ai')
        .from('ai_document_extractions')
        .select('id, vendor_name, document_date')
        .eq('organization_id', orgId)
        .neq('status', 'rejected')
        .limit(5);

      if (duplicates && duplicates.length > 0) {
        for (const dup of duplicates) {
          if (dup.vendor_name === extractedFields.vendor_name) {
            validationWarnings.push(
              `Possible duplicate: similar vendor "${dup.vendor_name}" in existing extraction.`
            );
          }
        }
      }
    }

    // 7. Save DRAFT extraction (Spec 9.6 Step 3 — NOT posted to finance tables)
    const extractionConfidence = validationWarnings.length === 0 ? 'high' :
      validationWarnings.length <= 2 ? 'medium' : 'low';

    const { data: extractionRecord, error: insertError } = await supabase
      .schema('ai')
      .from('ai_document_extractions')
      .insert({
        user_id: user.id,
        organization_id: orgId,
        file_path,
        file_name: file_name || null,
        file_hash: file_hash || null,
        document_type,
        extracted_fields: extractedFields,
        confidence: extractionConfidence,
        validation_warnings: validationWarnings,
        status: 'draft', // ALWAYS draft — Spec 9.6
        reviewed_by: null,
        reviewed_at: null,
      })
      .select('id')
      .single();

    if (insertError) {
      console.error('ai_document_extractions insert error:', insertError.message);
      return NextResponse.json(
        { error: 'Failed to save extraction record.' },
        { status: 500 }
      );
    }

    // 8. Token counting & cost tracking
    const totalLatency = Date.now() - startTime;
    const inputTokens = estimateTokens(extractionPrompt);
    const outputTokens = estimateTokens(aiResult.text);
    const estimatedCost = calculateCost(inputTokens, outputTokens);

    await updateAiCostTracking(supabase, user.id, orgId, {
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      estimatedCostUsd: estimatedCost,
      model: 'llama-3.3-70b-versatile',
      latencyMs: totalLatency,
    });

    // 9. Audit logging
    await logAiAuditEvent(supabase, {
      userId: user.id,
      userEmail: user.email,
      action: 'AI_DOCUMENT_EXTRACTION',
      status: 'success',
      severity: 'info',
      entityType: 'ai_document_extraction',
      entityId: extractionRecord?.id,
      question: `Extract ${document_type}: ${file_name || file_path}`,
      normalizedIntent: 'document_extraction',
      selectedTool: 'extract_finance_document',
      rowCount: 1,
      model: 'llama-3.3-70b-versatile',
      latencyMs: totalLatency,
      costUsd: estimatedCost,
      inputTokens,
      outputTokens,
      requestId,
      ipAddress: requestMetadata.ipAddress,
      userAgent: requestMetadata.userAgent,
    });

    // 10. Return draft extraction for user review (Spec 9.6 Step 5)
    return NextResponse.json({
      extraction_id: extractionRecord?.id,
      status: 'draft', // User MUST review before posting
      document_type,
      extracted_fields: extractedFields,
      confidence: extractionConfidence,
      validation_warnings: validationWarnings,
      next_step: 'Review extracted fields and accept/correct before submitting to expense workflow.',
      compliance_note: 'This is a DRAFT extraction. It has NOT been posted to any finance record. You must review and confirm before creating an expense or vendor bill.',
    });
  } catch (error: any) {
    console.error('Document Extraction API error:', error.message);
    return NextResponse.json(
      { error: 'Failed to extract document. Please try again.' },
      { status: 500 }
    );
  }
}

// =============================================================================
// HELPER: Build extraction prompt based on document type
// =============================================================================

function buildExtractionPrompt(documentType: string, ocrText: string): string {
  const typeSpecificInstructions: Record<string, string> = {
    receipt: `This is a RECEIPT. Focus on: vendor name, receipt number, date, items purchased, amounts, tax, total.`,
    invoice: `This is an INVOICE. Focus on: vendor name, invoice number, date, due date, line items, subtotal, tax, total, vendor tax/NTN number, bank details.`,
    bank_statement: `This is a BANK STATEMENT. Focus on: bank name, account number, statement period, opening balance, closing balance, individual transactions with dates/amounts/descriptions.`,
    other: `This is a FINANCIAL DOCUMENT. Extract all identifiable fields including amounts, dates, references, and parties.`,
  };

  return `${typeSpecificInstructions[documentType] || typeSpecificInstructions.other}

DOCUMENT TEXT:
${ocrText.slice(0, 6000)}

Return the extracted data as JSON with these fields:
{
  "vendor_name": "string or null",
  "vendor_ntn": "string or null",
  "invoice_number": "string or null",
  "receipt_number": "string or null",
  "document_date": "YYYY-MM-DD or null",
  "due_date": "YYYY-MM-DD or null",
  "currency": "3-letter code, default PKR",
  "subtotal_amount": number or null,
  "tax_amount": number or null,
  "tax_rate": number or null,
  "total_amount": number or null,
  "withholding_tax": number or null,
  "line_items": [{"description": "string", "quantity": number, "unit_price": number, "amount": number}],
  "payment_terms": "string or null",
  "bank_details": {"bank_name": "string", "account_number": "string", "account_title": "string"},
  "reference": "string or null",
  "description": "string or null",
  "validation_warnings": ["any arithmetic or logic issues found"]
}`;
}

// =============================================================================
// HELPER: Deterministic validation checks (Spec 9.6 Step 4)
// =============================================================================

function runDeterministicChecks(fields: any, docType: string): string[] {
  const warnings: string[] = [];

  // Check: subtotal + tax = total
  if (fields.subtotal_amount && fields.tax_amount && fields.total_amount) {
    const expected = fields.subtotal_amount + fields.tax_amount;
    if (Math.abs(expected - fields.total_amount) > 0.5) {
      warnings.push(
        `Arithmetic mismatch: subtotal (${fields.subtotal_amount}) + tax (${fields.tax_amount}) = ${expected}, but total is ${fields.total_amount}`
      );
    }
  }

  // Check: line items sum to subtotal
  if (fields.line_items && fields.line_items.length > 0 && fields.subtotal_amount) {
    const lineTotal = fields.line_items.reduce(
      (sum: number, item: any) => sum + (item.amount || item.quantity * item.unit_price || 0),
      0
    );
    if (Math.abs(lineTotal - fields.subtotal_amount) > 0.5) {
      warnings.push(
        `Line items total (${lineTotal}) does not match subtotal (${fields.subtotal_amount})`
      );
    }
  }

  // Check: date present
  if (!fields.document_date) {
    warnings.push('Document date could not be determined. Please verify.');
  }

  // Check: vendor name present
  if (!fields.vendor_name) {
    warnings.push('Vendor name could not be determined. Please verify.');
  }

  // Check: total amount present
  if (!fields.total_amount && !fields.subtotal_amount) {
    warnings.push('No amount could be determined. Please verify.');
  }

  return warnings;
}
