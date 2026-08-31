import { NextRequest, NextResponse } from 'next/server';
import { getAuthSupabase } from '@/lib/api-auth';
import { requirePermission } from '@/lib/api-auth';
 
function getData<T = any>(res: any): T | null {
  return res?.data ?? null;
}
 
// ─── GET: List exchange rates ───
export async function GET(req: NextRequest) {
  const auth = await requirePermission('SETTINGS_READ');
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
 
// ─── POST: Create or manage exchange rates ───
export async function POST(req: NextRequest) {
  const auth = await requirePermission('SETTINGS_UPDATE');
  if (auth instanceof NextResponse) return auth;
  const { supabase } = await getAuthSupabase(req);
 
  try {
    const body = await req.json();
    const { action, rates } = body;
 
    if (action === 'upsert') {
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
          p_description: `Exchange rates updated: ${rates.length} rates entered`,
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
 
    return NextResponse.json({ error: 'Invalid action. Use: upsert' }, { status: 400 });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}