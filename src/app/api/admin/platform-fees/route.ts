import { NextRequest, NextResponse } from 'next/server';
import { getAuthSupabase } from '@/lib/api-auth';
import { requirePermission } from '@/lib/api-auth';
import { platformFeePostSchema } from '@/lib/validations';

function getData<T = any>(res: any): T | null {
  return res?.data ?? null;
}

// FND-ADMIN-PLATFEE-001 FIX: there is no core.platform_fee_directory table.
// A fee rule actually lives across two normalized tables:
//   finance.platforms   — the payment channel (code/name/type)
//   finance.fee_rules   — one row per fee rule, FK'd to platforms.id, with
//                         its own NOT NULL "name" and UNIQUE(platform_id, name)
//   finance.fee_tiers   — optional graduated breakpoints for a TIERED/SLAB rule
// This route now manages fee_rules (+ their tiers), resolving the caller's
// `platform` (a finance.platforms.code or .name) to a platform_id. See
// src/lib/validations.ts (BUG-019 FIX comment) for the field mapping this
// was already written against, and src/app/api/finance/platform-fees/route.ts
// for the already-correct sibling implementation this mirrors.

async function resolvePlatformId(supabase: any, orgId: string | null, platform: string): Promise<{ id: string; name: string } | null> {
  const { data } = await supabase
    .schema('finance').from('platforms')
    .select('id, name, code')
    .eq('organization_id', orgId)
    .is('deleted_at', null)
    .or(`code.eq.${platform},name.eq.${platform}`)
    .maybeSingle();
  return data ? { id: data.id, name: data.name } : null;
}

// ─── GET: List all platform fee rules ───
export async function GET(req: NextRequest) {
  const auth = await requirePermission('SETTINGS_READ');
  if (auth instanceof NextResponse) return auth;
  const { supabase } = await getAuthSupabase(req);

  try {
    const { searchParams } = new URL(req.url);
    const platform = searchParams.get('platform') || '';
    const isActive = searchParams.get('is_active');

    let platformId: string | null = null;
    if (platform) {
      const resolved = await resolvePlatformId(supabase, auth.orgId, platform);
      if (!resolved) {
        return NextResponse.json({ error: `Platform '${platform}' not found` }, { status: 404 });
      }
      platformId = resolved.id;
    }

    let query = supabase
      .schema('finance').from('fee_rules')
      .select('*, platform:platforms(id, name, code, platform_type)')
      .eq('organization_id', auth.orgId);

    if (platformId) query = query.eq('platform_id', platformId);
    if (isActive !== null && isActive !== undefined) {
      query = query.eq('is_active', isActive === 'true');
    }

    const { data, error } = await query.order('priority', { ascending: false });

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ data: data || [] });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

// ─── POST: Create, update, or toggle platform fee rules ───
export async function POST(req: NextRequest) {
  const auth = await requirePermission('SETTINGS_MANAGE');
  if (auth instanceof NextResponse) return auth;
  const { supabase } = await getAuthSupabase(req);

  try {
    const body = await req.json();
    const parsed = platformFeePostSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({
        error: 'Invalid request body',
        details: parsed.error.flatten(),
      }, { status: 400 });
    }

    const action = parsed.data.action;

    if (action === 'create') {
      const { platform, name, fee_type, fee_rate, fee_fixed_amount, applies_to, priority, min_amount, max_amount, tiers } = parsed.data;
      if (!platform || !fee_type) {
        return NextResponse.json({ error: 'platform and fee_type are required' }, { status: 400 });
      }

      const resolvedPlatform = await resolvePlatformId(supabase, auth.orgId, platform);
      if (!resolvedPlatform) {
        return NextResponse.json({ error: `Platform '${platform}' not found. Create the platform first.` }, { status: 404 });
      }

      // fee_rules.fee_value is one column shared by PERCENTAGE (a %) and
      // FIXED (a flat amount) — see finance.compute_platform_fee(). TIERED/
      // SLAB rules ignore fee_value and use finance.fee_tiers instead.
      const feeValue = fee_type === 'FIXED' ? (fee_fixed_amount ?? 0) : (fee_rate ?? 0);
      const ruleName = name?.trim() || `${resolvedPlatform.name} - ${fee_type} fee`;

      const { data, error } = await supabase
        .schema('finance').from('fee_rules')
        .insert({
          platform_id: resolvedPlatform.id,
          name: ruleName,
          fee_type,
          fee_value: feeValue,
          min_fee: min_amount ?? 0,
          max_fee: max_amount ?? 0,
          applies_to: applies_to || 'ALL',
          priority: priority ?? 0,
          is_active: true,
          organization_id: auth.orgId,
          created_by: auth.userId,
        })
        .select()
        .single();

      if (error) {
        return NextResponse.json({ error: error.message }, { status: 500 });
      }

      if ((fee_type === 'TIERED' || fee_type === 'SLAB') && tiers?.length) {
        const { error: tiersError } = await supabase
          .schema('finance').from('fee_tiers')
          .insert(tiers.map(t => ({
            fee_rule_id: data.id,
            tier_from: t.tier_from,
            tier_to: t.tier_to,
            fee_percent: t.fee_percent,
            fee_fixed: t.fee_fixed,
          })));
        if (tiersError) {
          return NextResponse.json({ error: `Fee rule created but tiers failed: ${tiersError.message}`, fee: data }, { status: 500 });
        }
      }

      try {
        await supabase.schema('audit').rpc('log_action', {
          p_user_id: auth.userId,
          p_action: 'PLATFORM_FEE_CREATED',
          p_entity_type: 'platform_fee',
          p_entity_id: data.id,
          p_description: `Platform fee created: ${resolvedPlatform.name} - ${fee_type}`,
          p_source_module: 'settings',
          p_severity: 'medium',
          p_new_values: { platform, fee_type, fee_rate, fee_fixed_amount },
        });
      } catch {}

      return NextResponse.json({ success: true, fee: data });
    }

    if (action === 'update') {
      const { id, name, fee_rate, fee_fixed_amount, min_amount, max_amount, priority } = parsed.data;
      if (!id) {
        return NextResponse.json({ error: 'id is required for update' }, { status: 400 });
      }

      const existing = getData(await supabase
        .schema('finance').from('fee_rules')
        .select('id, fee_type, platform_id')
        .eq('id', id)
        .eq('organization_id', auth.orgId)
        .single());

      if (!existing) {
        return NextResponse.json({ error: 'Platform fee rule not found' }, { status: 404 });
      }

      const updates: Record<string, any> = {};
      if (name !== undefined) updates.name = name;
      // Whichever of fee_rate/fee_fixed_amount was sent maps onto the
      // single fee_value column (see create, above).
      if (fee_rate !== undefined) updates.fee_value = fee_rate;
      else if (fee_fixed_amount !== undefined) updates.fee_value = fee_fixed_amount;
      if (min_amount !== undefined) updates.min_fee = min_amount;
      if (max_amount !== undefined) updates.max_fee = max_amount;
      if (priority !== undefined) updates.priority = priority;

      const { data, error } = await supabase
        .schema('finance').from('fee_rules')
        .update(updates)
        .eq('id', id)
        .eq('organization_id', auth.orgId)
        .select('*, platform:platforms(id, name, code)')
        .single();

      if (error) {
        return NextResponse.json({ error: error.message }, { status: 500 });
      }

      try {
        await supabase.schema('audit').rpc('log_action', {
          p_user_id: auth.userId,
          p_action: 'PLATFORM_FEE_UPDATED',
          p_entity_type: 'platform_fee',
          p_entity_id: id,
          p_description: `Platform fee updated: ${data.name}`,
          p_source_module: 'settings',
          p_severity: 'medium',
          p_new_values: updates,
        });
      } catch {}

      return NextResponse.json({ success: true, fee: data });
    }

    if (action === 'toggle') {
      const { id } = parsed.data;
      if (!id) {
        return NextResponse.json({ error: 'id is required' }, { status: 400 });
      }

      const existing = getData(await supabase
        .schema('finance').from('fee_rules')
        .select('id, is_active, name')
        .eq('id', id)
        .eq('organization_id', auth.orgId)
        .single());

      if (!existing) {
        return NextResponse.json({ error: 'Platform fee rule not found' }, { status: 404 });
      }

      const { data, error } = await supabase
        .schema('finance').from('fee_rules')
        .update({ is_active: !existing.is_active })
        .eq('id', id)
        .eq('organization_id', auth.orgId)
        .select()
        .single();

      if (error) {
        return NextResponse.json({ error: error.message }, { status: 500 });
      }

      return NextResponse.json({
        success: true,
        fee: data,
        message: `Platform fee rule ${existing.name} ${!existing.is_active ? 'activated' : 'deactivated'}`,
      });
    }

    return NextResponse.json({ error: 'Invalid action. Use: create, update, or toggle' }, { status: 400 });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}