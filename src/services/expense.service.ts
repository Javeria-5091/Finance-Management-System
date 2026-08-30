// ═════════════════════════════════════════════════════════════════════
//  EXPENSE SERVICE
//
//  MF-01 (Spec §5.5): "Detect potential duplicates using reference,
//  amount, date, vendor, receipt hash, and AI similarity scoring."
//
//  This file owns the DETERMINISTIC half of that requirement (reference,
//  amount, date, vendor, receipt hash). The AI-similarity-scoring half is
//  already implemented, generically, by /api/ai/duplicate-detection — see
//  src/app/api/finance/expenses/duplicate-check/route.ts, which calls
//  detectExpenseDuplicates() below AND that route in-process, then merges
//  the two signals into one response. Neither layer ever blocks on its
//  own (Spec §9.7: "AI flags never automatically block or accuse a user;
//  policy rules may block, while AI provides a review signal.") — this
//  service only surfaces matches for a human to review.
//
//  Same optional-client pattern as the other services in this folder
//  (see fiscal-year.service.ts / distribution-wht.service.ts): API routes
//  pass their server-side authenticated client; frontend code omits it
//  and the browser client (with its own session) is used instead.
// ═════════════════════════════════════════════════════════════════════

import { supabase as browserSupabase } from '@/lib/supabase';
import type { SupabaseClient } from '@supabase/supabase-js';
import { sanitizeSearch } from '@/lib/validations';

type SClient = SupabaseClient<any, any, any>;
function resolveClient(override?: SClient | null): SClient {
  return override || (browserSupabase as unknown as SClient);
}

// Expenses in these statuses never represent real, counted spend, so a
// match against one of them isn't a meaningful "you might be double
// paying" signal — exclude them from every duplicate check below.
const NON_DUPLICATE_STATUSES = ['CANCELLED', 'REJECTED'] as const;

// Same vendor + same amount within this many days is treated as a
// possible duplicate. Kept tight on purpose: a genuine monthly
// subscription is also "same vendor, same amount", just ~30 days apart —
// a wide window would flag every recurring expense as a duplicate.
const DUPLICATE_DATE_WINDOW_DAYS = 3;

export interface DuplicateCheckInput {
  organizationId: string;
  amount: number;
  expense_date: string; // 'YYYY-MM-DD'
  vendor_id?: string | null;
  /** Free-text reference (invoice #, receipt #, PO #, etc). The expenses
   *  table (schema.sql) has no dedicated `reference` column, so this is
   *  matched against the existing `title` and `notes` free-text columns —
   *  wherever a user would plausibly have typed a reference number. */
  reference?: string | null;
  title?: string | null;
  /** SHA-256 hash of the receipt file, if one is attached — see
   *  computeFileHash() in src/app/api/finance/attachment/route.ts. */
  receipt_hash?: string | null;
  /** Exclude this expense's own id — pass the expense being edited so it
   *  never matches against itself. */
  exclude_expense_id?: string | null;
}

export type DuplicateMatchType =
  | 'RECEIPT_HASH'
  | 'AMOUNT_VENDOR_SAME_DAY'
  | 'AMOUNT_VENDOR_WINDOW'
  | 'REFERENCE_TEXT';

export interface DuplicateMatch {
  expense_id: string;
  match_type: DuplicateMatchType;
  confidence: 'high' | 'medium';
  title: string;
  amount: number;
  expense_date: string;
  status: string;
  vendor_id: string | null;
  detail: string;
}

export interface DuplicateCheckResult {
  matches: DuplicateMatch[];
  risk_level: 'high' | 'medium' | 'low';
  /** Resolved vendor name, if vendor_id was given — handed back so the
   *  caller can pass it straight to /api/ai/duplicate-detection without a
   *  second lookup. */
  vendor_name: string | null;
}

function daysBetween(a: string, b: string): number {
  const da = new Date(a).getTime();
  const db = new Date(b).getTime();
  return Math.abs(da - db) / (1000 * 60 * 60 * 24);
}

/**
 * Spec §5.5 deterministic duplicate checks: reference, amount, date,
 * vendor, and receipt hash. Every query is scoped to organizationId (never
 * trust a caller-supplied org filter alone — see api-auth.ts's
 * requirePermission()/getAuthSupabase() for how the org id itself is
 * derived from the authenticated session before this function ever runs).
 */
export async function detectExpenseDuplicates(
  input: DuplicateCheckInput,
  supabaseClient?: SClient | null
): Promise<DuplicateCheckResult> {
  const supabase = resolveClient(supabaseClient);
  const db = supabase.from('expenses');
  const matches: DuplicateMatch[] = [];

  const excludeId = input.exclude_expense_id || null;

  function applyCommonFilters(query: any) {
    // NOTE: supabase-js's `.not(col, 'in', [...])` takes a plain array, not
    // a pre-formatted "(a,b)" string — see the same pattern in
    // src/app/api/finance/assets/verifications/route.ts.
    let q = query
      .eq('organization_id', input.organizationId)
      .not('status', 'in', [...NON_DUPLICATE_STATUSES]);
    if (excludeId) q = q.neq('id', excludeId);
    return q;
  }

  // ── Resolve vendor name up front (used in match detail text + handed
  //    back to the caller for the AI similarity-scoring call). ──
  let vendorName: string | null = null;
  if (input.vendor_id) {
    const { data: vendor } = await supabase
      .schema('finance').from('vendors')
      .select('name')
      .eq('id', input.vendor_id)
      .eq('organization_id', input.organizationId)
      .maybeSingle();
    vendorName = vendor?.name || null;
  }

  // ── Check A: same receipt file already used (Spec 5.5 "receipt hash").
  //    Highest-confidence signal — this is literally the same document. ──
  if (input.receipt_hash) {
    let q = applyCommonFilters(
      db.select('id, title, amount, expense_date, status, vendor_id')
        .eq('receipt_hash', input.receipt_hash)
    ).limit(5);
    const { data: hashMatches } = await q;
    for (const m of hashMatches || []) {
      matches.push({
        expense_id: m.id,
        match_type: 'RECEIPT_HASH',
        confidence: 'high',
        title: m.title,
        amount: Number(m.amount),
        expense_date: m.expense_date,
        status: m.status,
        vendor_id: m.vendor_id,
        detail: `Identical receipt file already recorded on expense "${m.title}" (${m.expense_date}).`,
      });
    }
  }

  // ── Check B: same vendor + same amount, close in time (Spec 5.5
  //    "amount, date, vendor"). Same-day = high confidence, within the
  //    window = medium (recurring subscriptions land far outside this
  //    window and are intentionally not flagged — see
  //    DUPLICATE_DATE_WINDOW_DAYS above). ──
  if (input.vendor_id && input.amount > 0) {
    let q = applyCommonFilters(
      db.select('id, title, amount, expense_date, status, vendor_id')
        .eq('vendor_id', input.vendor_id)
        .eq('amount', input.amount)
    ).limit(10);
    const { data: amountVendorMatches } = await q;
    for (const m of amountVendorMatches || []) {
      const gapDays = daysBetween(input.expense_date, m.expense_date);
      if (gapDays > DUPLICATE_DATE_WINDOW_DAYS) continue;
      const sameDay = gapDays === 0;
      matches.push({
        expense_id: m.id,
        match_type: sameDay ? 'AMOUNT_VENDOR_SAME_DAY' : 'AMOUNT_VENDOR_WINDOW',
        confidence: sameDay ? 'high' : 'medium',
        title: m.title,
        amount: Number(m.amount),
        expense_date: m.expense_date,
        status: m.status,
        vendor_id: m.vendor_id,
        detail: sameDay
          ? `Same vendor and amount (PKR ${Number(m.amount).toLocaleString()}) already recorded on the same date.`
          : `Same vendor and amount (PKR ${Number(m.amount).toLocaleString()}) recorded ${Math.round(gapDays)} day(s) apart, on "${m.title}".`,
      });
    }
  }

  // ── Check C: reference text match (Spec 5.5 "reference"). The expenses
  //    table has no dedicated reference column, so this searches the
  //    existing title/notes free-text fields for the supplied reference
  //    string (e.g. an invoice or receipt number the user typed in). ──
  const referenceText = (input.reference || '').trim();
  if (referenceText.length >= 3) {
    // sanitizeSearch (src/lib/validations.ts) escapes ILIKE wildcards and
    // PostgREST or()-filter special characters — required here since
    // referenceText is user-supplied and lands inside an .or(...) string.
    const escaped = sanitizeSearch(referenceText);
    let q = applyCommonFilters(
      db.select('id, title, amount, expense_date, status, vendor_id')
        .or(`title.ilike.%${escaped}%,notes.ilike.%${escaped}%`)
    ).limit(10);
    const { data: refMatches } = await q;
    for (const m of refMatches || []) {
      matches.push({
        expense_id: m.id,
        match_type: 'REFERENCE_TEXT',
        confidence: 'medium',
        title: m.title,
        amount: Number(m.amount),
        expense_date: m.expense_date,
        status: m.status,
        vendor_id: m.vendor_id,
        detail: `Reference "${referenceText}" also appears on expense "${m.title}" (${m.expense_date}).`,
      });
    }
  }

  // De-duplicate matches on the same expense (an expense can legitimately
  // match more than one check — keep the highest-confidence entry for it).
  const byExpenseId = new Map<string, DuplicateMatch>();
  for (const m of matches) {
    const existing = byExpenseId.get(m.expense_id);
    if (!existing || (existing.confidence === 'medium' && m.confidence === 'high')) {
      byExpenseId.set(m.expense_id, m);
    }
  }
  const dedupedMatches = Array.from(byExpenseId.values());

  const riskLevel: DuplicateCheckResult['risk_level'] =
    dedupedMatches.some(m => m.confidence === 'high') ? 'high' :
    dedupedMatches.length > 0 ? 'medium' : 'low';

  return { matches: dedupedMatches, risk_level: riskLevel, vendor_name: vendorName };
}