// =============================================================================
// MF-01 · Expense Duplicate Detection — Spec §5.5
// POST /api/finance/expenses/duplicate-check
//
// Spec §5.5: "Detect potential duplicates using reference, amount, date,
// vendor, receipt hash, and AI similarity scoring."
//
// This route is the single entry point for that requirement:
//   1. Deterministic checks (reference, amount, date, vendor, receipt hash)
//      — src/services/expense.service.ts detectExpenseDuplicates().
//   2. AI similarity scoring — wired directly (in-process) to the existing
//      /api/ai/duplicate-detection gateway (Spec 9.7's generic
//      deterministic+AI anomaly engine) rather than re-implementing a
//      second AI call here.
//
// Meant to be called by the expense form BEFORE the expense is saved (or on
// edit, passing exclude_expense_id) so the user sees potential duplicates
// as a review signal — never as an automatic block (Spec 9.7: "AI flags
// never automatically block or accuse a user; policy rules may block,
// while AI provides a review signal.").
// =============================================================================

import { NextRequest, NextResponse } from 'next/server';
import { getAuthSupabase, requirePermission } from '@/lib/api-auth';
import { z } from 'zod';
import { detectExpenseDuplicates } from '@/services/expense.service';
import { POST as aiDuplicateDetectionPOST } from '@/app/api/ai/duplicate-detection/route';

const duplicateCheckSchema = z.object({
  amount: z.number().positive(),
  expense_date: z.string().min(1),
  vendor_id: z.string().uuid().optional().nullable(),
  // Free-text reference (invoice #, receipt #, PO #). No dedicated column
  // exists on expenses — see expense.service.ts for how this is matched.
  reference: z.string().trim().max(200).optional(),
  title: z.string().trim().max(255).optional(),
  receipt_hash: z.string().trim().max(128).optional().nullable(),
  // Pass the expense's own id when checking an in-progress edit, so it
  // never matches against itself.
  exclude_expense_id: z.string().uuid().optional(),
});

export async function POST(req: NextRequest) {
  const auth = await requirePermission('EXPENSE_CREATE');
  if (auth instanceof NextResponse) return auth;
  const { supabase } = await getAuthSupabase(req);

  const orgId = auth.orgId;
  if (!orgId) {
    return NextResponse.json({ error: 'Organization ID not found' }, { status: 400 });
  }

  const rawBody = await req.json().catch(() => ({}));
  const parsed = duplicateCheckSchema.safeParse(rawBody);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message || 'Invalid request' },
      { status: 400 }
    );
  }
  const input = parsed.data;

  try {
    // ── 1. Deterministic checks (Spec 5.5: reference, amount, date, vendor,
    //    receipt hash). Always run and always trusted — this never depends
    //    on the AI call below succeeding. ──
    const deterministic = await detectExpenseDuplicates(
      {
        organizationId: orgId,
        amount: input.amount,
        expense_date: input.expense_date,
        vendor_id: input.vendor_id,
        reference: input.reference,
        title: input.title,
        receipt_hash: input.receipt_hash,
        exclude_expense_id: input.exclude_expense_id,
      },
      supabase
    );

    // ── 2. AI similarity scoring (Spec 5.5 "...and AI similarity
    //    scoring."). Called in-process (no network hop, no
    //    NEXT_PUBLIC_BASE_URL dependency) by invoking the existing route's
    //    exported POST handler directly, forwarding only the headers it
    //    needs (cookies for the session, Authorization for the bearer-token
    //    fallback — see getAuthSupabase()) so it authenticates as the same
    //    user. That route requires REPORT_READ; a caller who only has
    //    EXPENSE_CREATE will get a 403 from it, which is treated below as
    //    "AI layer unavailable" rather than failing the whole request —
    //    the deterministic checks above are never gated on this succeeding
    //    (Spec 9.7: AI is a supplementary review signal, not a blocker). ──
    let aiResult: any = null;
    let aiWarning: string | null = null;
    try {
      const forwardedHeaders = new Headers();
      const cookie = req.headers.get('cookie');
      if (cookie) forwardedHeaders.set('cookie', cookie);
      const authHeader = req.headers.get('authorization');
      if (authHeader) forwardedHeaders.set('authorization', authHeader);
      forwardedHeaders.set('content-type', 'application/json');

      const aiRequest = new Request(new URL('/api/ai/duplicate-detection', req.url), {
        method: 'POST',
        headers: forwardedHeaders,
        body: JSON.stringify({
          amount: input.amount,
          description: input.title || input.reference,
          transaction_date: input.expense_date,
          vendor_name: deterministic.vendor_name || undefined,
          reference: input.reference,
          transaction_type: 'expense',
        }),
      });

      const aiRes = await aiDuplicateDetectionPOST(aiRequest);
      if (aiRes.ok) {
        aiResult = await aiRes.json();
      } else {
        const errBody = await aiRes.json().catch(() => ({}));
        aiWarning = errBody.error || `AI similarity check returned ${aiRes.status}`;
      }
    } catch (aiErr: any) {
      aiWarning = aiErr?.message || 'AI similarity check unavailable';
    }

    const overallRiskLevel: 'high' | 'medium' | 'low' =
      deterministic.risk_level === 'high' || aiResult?.risk_level === 'high' ? 'high' :
      deterministic.risk_level === 'medium' || aiResult?.risk_level === 'medium' ? 'medium' :
      'low';

    return NextResponse.json({
      is_duplicate_likely: deterministic.matches.length > 0 || Boolean(aiResult?.duplicates?.length),
      risk_level: overallRiskLevel,
      deterministic: {
        risk_level: deterministic.risk_level,
        matches: deterministic.matches,
      },
      ai: aiResult ? {
        risk_level: aiResult.risk_level,
        duplicates: aiResult.duplicates,
        anomalies: aiResult.anomalies,
        suggestion_id: aiResult.suggestion_id,
      } : null,
      ai_warning: aiWarning,
      compliance_note: 'AI/duplicate flag only. No automatic blocking — an authorized user decides whether to proceed (Spec §9.7).',
    });
  } catch (err: any) {
    console.error('Expense duplicate-check error:', err);
    return NextResponse.json({ error: err.message || 'Duplicate check failed' }, { status: 500 });
  }
}