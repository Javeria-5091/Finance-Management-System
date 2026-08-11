import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { requirePermission } from '@/lib/api-auth';

function getData<T = any>(res: any): T | null {
  return res?.data ?? null;
}

// ─── GET: List exchange rates ───
export async function GET(req: NextRequest) {
  const auth = await requirePermission('SETTINGS_READ');
  if (auth instanceof NextResponse) return auth;

  try {
    const { searchParams } = new URL(req.url);
    const fromCurrency = searchParams.get('from_currency') || '';
    const toCurrency = searchParams.get('to_currency') || '';
    const effectiveDate = searchParams.get('effective_date') || '';
    const page = parseInt(searchParams.get('page') || '1');
    const pageSize = parseInt(searchParams.get('pageSize') || '50');

    let query = supabase
      .from('core.exchange_rates')
      .select('*', { count: 'exact' })
      .eq('organization_id', auth.orgId);

    if (fromCurrency) query = query.eq('from_currency', fromCurrency);
    if (toCurrency) query = query.eq('to_currency', toCurrency);
    if (effectiveDate) query = query.lte('effective_date', effectiveDate).gte('valid_until', effectiveDate);

    const from = (page - 1) * pageSize;
    const to = from + pageSize - 1;

    const { data, error, count } = await query
      .order('effective_date', { ascending: false })
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

  try {
    const body = await req.json();
    const { action, rates } = body;

    if (action === 'upsert') {
      if (!rates || !Array.isArray(rates) || rates.length === 0) {
        return NextResponse.json({ error: 'rates array is required' }, { status: 400 });
      }

      const results: any[] = [];

      for (const rate of rates) {
        const {
          from_currency, to_currency, rate, effective_date,
          source, valid_until, notes,
        } = rate;

        if (!from_currency || !to_currency || !rate || !effective_date) {
          results.push({ error: 'from_currency, to_currency, rate, and effective_date are required', rate });
          continue;
        }

        // Spec: Exchange rates are entered manually by authorized user
        // Deactivate previous rates for same currency pair
        await supabase
          .from('core.exchange_rates')
          .update({ is_active: false, valid_until: effective_date })
          .eq('from_currency', from_currency)
          .eq('to_currency', to_currency)
          .eq('is_active', true)
          .eq('organization_id', auth.orgId);

        const { data, error } = await supabase
          .from('core.exchange_rates')
          .insert({
            from_currency,
            to_currency,
            rate: Number(rate),
            effective_date,
            source: source || 'MANUAL',
            valid_until: valid_until || null,
            notes: notes || null,
            is_active: true,
            organization_id: auth.orgId,
            entered_by: auth.userId,
          })
          .select()
          .single();

        results.push(data || { error: error?.message });
      }

      try {
        await supabase.rpc('audit.log_action', {
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
