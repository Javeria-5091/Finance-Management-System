import { NextRequest, NextResponse } from 'next/server';
import { getAuthSupabase } from '@/lib/api-auth';
import { requirePermission } from '@/lib/api-auth';
 
function getData<T = any>(res: any): T | null {
  return res?.data ?? null;
}
 
// ─── GET: List exchange rates ───
export async function GET(req: NextRequest) {
  // FND-ADMIN-PERM-001 FIX: 'SETTINGS_READ' was seeded, but the route's
  // sibling POST action required 'SETTINGS_UPDATE', which was never seeded
  // anywhere (see migration P1_076, BUG-017 FIX §4) — only the CEO bypass in
  // requirePermission() could ever reach it. P1_076 seeded dedicated
  // FX_RATE_READ/FX_RATE_CREATE/FX_RATE_APPROVE permissions for exactly this
  // route (and mapped them to CEO/FINANCE_HEAD/ACCOUNTANT/VIEWER as
  // appropriate); switch to those instead of the generic SETTINGS_* codes.
  const auth = await requirePermission('FX_RATE_READ');
  if (auth instanceof NextResponse) return auth;
  const { supabase } = await getAuthSupabase(req);
 
  try {
    const { searchParams } = new URL(req.url);
    const fromCurrency = searchParams.get('from_currency') || '';
    const toCurrency = searchParams.get('to_currency') || '';
    const rateType = searchParams.get('rate_type') || '';
    // FND-ADMIN-FX-001 FIX: there is no core.exchange_rates table, and the
    // real table (finance.exchange_rates) has no effective_date/valid_until
    // columns — it just stores one dated row per (currency pair, rate_date,
    // rate_type, source_platform). "As of this date" now means "the latest
    // rate_date on or before the requested date", so we keep the query
    // param name for API-compatibility but filter/order on rate_date.
    const effectiveDate = searchParams.get('effective_date') || '';
    const page = parseInt(searchParams.get('page') || '1');
    const pageSize = parseInt(searchParams.get('pageSize') || '50');
 
    let query = supabase
      .schema('finance').from('exchange_rates')
      .select('*', { count: 'exact' })
      .eq('organization_id', auth.orgId);
 
    if (fromCurrency) query = query.eq('from_currency', fromCurrency);
    if (toCurrency) query = query.eq('to_currency', toCurrency);
    if (rateType) query = query.eq('rate_type', rateType);
    if (effectiveDate) query = query.lte('rate_date', effectiveDate);
 
    const from = (page - 1) * pageSize;
    const to = from + pageSize - 1;
 
    const { data, error, count } = await query
      .order('rate_date', { ascending: false })
      .range(from, to);
 
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
 
    return NextResponse.json({ data: data || [], total: count || 0, page, pageSize });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
 
// ─── POST: Propose ("upsert") or approve exchange rates ───
//
// FND-ADMIN-PERM-001 / FND-ADMIN-FX-002 FIX: this endpoint now enforces the
// maker-checker workflow spec §5.12 requires, instead of auto-approving
// every rate on insert with no way to ever approve one:
//   - action 'upsert' proposes a rate (entered_by = caller, approved_by =
//     null, is_locked = false) and requires FX_RATE_CREATE.
//   - action 'approve' is a NEW action that locks a proposed rate
//     (approved_by/approved_at set, is_locked = true) and requires
//     FX_RATE_APPROVE. finance.trg_maker_checker (migration P1_076) rejects
//     the update at the database level if the approver is the same user who
//     entered the rate, and the fx_approve RLS policy restricts the update
//     to Finance Head/CEO regardless of what the application layer allows —
//     this route's checks are a first line of defense, not the only one.
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { action } = body;

    if (action === 'approve') {
      const auth = await requirePermission('FX_RATE_APPROVE');
      if (auth instanceof NextResponse) return auth;
      const { supabase } = await getAuthSupabase(req);

      const { id } = body;
      if (!id) {
        return NextResponse.json({ error: 'id is required' }, { status: 400 });
      }

      const existing = getData(await supabase
        .schema('finance').from('exchange_rates')
        .select('id, entered_by, is_locked, from_currency, to_currency, rate_date')
        .eq('id', id)
        .eq('organization_id', auth.orgId)
        .single());

      if (!existing) {
        return NextResponse.json({ error: 'Exchange rate not found' }, { status: 404 });
      }
      if (existing.is_locked) {
        return NextResponse.json({ error: 'This rate is already approved and locked' }, { status: 409 });
      }
      if (existing.entered_by === auth.userId) {
        return NextResponse.json({ error: 'You entered this rate and cannot approve it yourself (maker-checker rule)' }, { status: 409 });
      }

      const { data, error } = await supabase
        .schema('finance').from('exchange_rates')
        .update({ approved_by: auth.userId, approved_at: new Date().toISOString(), is_locked: true })
        .eq('id', id)
        .eq('organization_id', auth.orgId)
        .select()
        .single();

      if (error) {
        const isMakerChecker = error.message?.includes('MAKER_CHECKER_VIOLATION');
        return NextResponse.json({
          error: isMakerChecker
            ? 'You entered this rate and cannot approve it yourself (maker-checker rule)'
            : error.message,
        }, { status: isMakerChecker ? 409 : 500 });
      }

      try {
        await supabase.schema('audit').rpc('log_action', {
          p_user_id: auth.userId,
          p_action: 'EXCHANGE_RATE_APPROVED',
          p_entity_type: 'exchange_rate',
          p_entity_id: id,
          p_description: `Exchange rate approved: ${existing.from_currency}/${existing.to_currency} (${existing.rate_date})`,
          p_source_module: 'settings',
          p_severity: 'medium',
          p_new_values: { id },
        });
      } catch {}

      return NextResponse.json({ success: true, rate: data });
    }

    if (action === 'upsert') {
      const auth = await requirePermission('FX_RATE_CREATE');
      if (auth instanceof NextResponse) return auth;
      const { supabase } = await getAuthSupabase(req);

      const { rates } = body;
      if (!rates || !Array.isArray(rates) || rates.length === 0) {
        return NextResponse.json({ error: 'rates array is required' }, { status: 400 });
      }
 
      // FND-ADMIN-FX-001 FIX: finance.exchange_rates has no
      // effective_date/source/valid_until/notes/is_active columns and no
      // "deactivate the previous row" concept — every manual entry is its
      // own dated, typed row (unique on from/to/rate_date/rate_type/
      // source_platform). rate_type and evidence_reference are NOT NULL
      // (evidence_reference also has a non-blank CHECK) on the real table.
      const ALLOWED_RATE_TYPES = ['PLATFORM', 'BANK', 'MANUAL', 'PAYMENT_CHANNEL'];
      const results: any[] = [];
 
      for (const rate of rates) {
        // BUG FIX (Audit Finding C-2, Critical): the previous destructure
        // was `const { ..., rate:any, ... } = rate;` — JS destructuring
        // interprets `rate:any` as "rename the `rate` property to a local
        // variable called `any`", so the `rate` variable was NEVER defined
        // in this scope. The subsequent `if (!rate)` test was checking the
        // loop variable (always truthy), and `Number(rate)` at the insert
        // evaluated `Number(<object>)` → NaN. Exchange rates were silently
        // stored as NaN, breaking every downstream currency conversion.
        //
        // Fix: rename the destructured property to `rateValue` and use that
        // consistently for both the truthiness check and the insert.
        const {
          from_currency, to_currency, rate: rateValue, rate_date,
          rate_type, source_platform, evidence_reference,
        } = rate;

        if (!from_currency || !to_currency || rateValue === undefined || rateValue === null || !rate_date) {
          results.push({ error: 'from_currency, to_currency, rate, and rate_date are required', rate });
          continue;
        }

        if (!rate_type || !ALLOWED_RATE_TYPES.includes(rate_type)) {
          results.push({ error: `rate_type is required and must be one of: ${ALLOWED_RATE_TYPES.join(', ')}`, rate });
          continue;
        }

        if (!evidence_reference || !String(evidence_reference).trim()) {
          results.push({ error: 'evidence_reference is required (e.g. bank/platform screenshot reference, source URL, or invoice number)', rate });
          continue;
        }

        const numericRate = Number(rateValue);
        if (isNaN(numericRate) || numericRate <= 0) {
          results.push({ error: 'rate must be a positive number', rate });
          continue;
        }

        // FND-ADMIN-FX-002 FIX: a newly proposed rate is never auto-approved
        // — approved_by/approved_at/is_locked are only ever set via the
        // 'approve' action above, by someone other than entered_by.
        const { data, error } = await supabase
          .schema('finance').from('exchange_rates')
          .insert({
            from_currency,
            to_currency,
            rate: numericRate,
            rate_date,
            rate_type,
            source_platform: source_platform || null,
            evidence_reference: String(evidence_reference).trim(),
            is_locked: false,
            approved_by: null,
            approved_at: null,
            organization_id: auth.orgId,
            entered_by: auth.userId,
          })
          .select()
          .single();

        results.push(data || { error: error?.message });
      }
 
      try {
        await supabase.schema('audit').rpc('log_action', {
          p_user_id: auth.userId,
          p_action: 'EXCHANGE_RATES_UPDATED',
          p_entity_type: 'exchange_rate',
          p_entity_id: null,
          p_description: `Exchange rates proposed: ${rates.length} rates entered, pending approval`,
          p_source_module: 'settings',
          p_severity: 'medium',
          p_new_values: { count: rates.length, currencies: rates.map((r: any) => `${r.from_currency}/${r.to_currency}`) },
        });
      } catch {}
 
      return NextResponse.json({
        success: true,
        results,
        message: `${rates.length} exchange rate(s) processed`,
      });
    }
 
    return NextResponse.json({ error: 'Invalid action. Use: upsert or approve' }, { status: 400 });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}