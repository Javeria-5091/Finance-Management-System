import { NextRequest, NextResponse } from 'next/server';
import { getAuthSupabase } from '@/lib/api-auth';
import { requirePermission } from '@/lib/api-auth';
import { platformFeePostSchema } from '@/lib/validations';

// BUG-019 FIX: this route used to manage core.platform_fee_directory — a
// second, parallel fee-configuration table that finance.compute_platform_fee()
// (the actual fee engine, used by settlement finalization) never reads
// from. Every fee an admin configured here was invisible to the engine,
// and vice versa ("fee engine orphaned"). This route now manages
// finance.fee_rules (+ finance.fee_tiers for TIERED/SLAB rules) — the
// table compute_platform_fee() actually queries.

function getData<T = any>(res: any): T | null {
  return res?.data ?? null;
}

// Resolve a platform by code or name, scoped to the caller's org.
async function resolvePlatform(supabase: any, orgId: string, platformInput: string) {
  const { data } = await supabase
    .schema('finance').from('platforms')
    .select('id, code, name')
    .eq('organization_id', orgId)
    .or(`code.eq.${platformInput.toUpperCase()},name.eq.${platformInput}`)
    .limit(1)
    .maybeSingle();
  return data;
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

    let query = supabase
      .schema('finance').from('fee_rules')
      .select('*, platform:platforms(id, code, name), fee_tiers(*)')
      .eq('organization_id', auth.orgId);

    if (isActive !== null && isActive !== undefined) {
      query = query.eq('is_active', isActive === 'true');
    }

    const { data, error } = await query.order('priority', { ascending: false });

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    // Platform filter applied post-query since it's a joined column and
    // the caller may pass either the platform's code or name.
    const filtered = platform
      ? (data || []).filter((r: any) =>
          r.platform?.code?.toLowerCase() === platform.toLowerCase() ||
          r.platform?.name?.toLowerCase() === platform.toLowerCase())
      : (data || []);

    return NextResponse.json({ data: filtered });
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
      const { platform, fee_type, fee_rate, fee_fixed_amount, description, min_amount, max_amount, applies_to, priority, tiers } = parsed.data;
      if (!platform || !fee_type) {
        return NextResponse.json({ error: 'platform and fee_type are required' }, { status: 400 });
      }

      const platformRow = await resolvePlatform(supabase, auth.orgId, platform);
      if (!platformRow) {
        return NextResponse.json({ error: `Platform "${platform}" not found for this organization. Create it in finance.platforms first.` }, { status: 404 });
      }

      if ((fee_type === 'TIERED' || fee_type === 'SLAB') && (!tiers || tiers.length === 0)) {
        return NextResponse.json({ error: `fee_type=${fee_type} requires at least one entry in "tiers"` }, { status: 400 });
      }
      if ((fee_type === 'PERCENTAGE' || fee_type === 'FIXED') && (tiers?.length)) {
        return NextResponse.json({ error: `"tiers" is only used with TIERED/SLAB fee_type` }, { status: 400 });
      }

      // fee_value carries the percentage (PERCENTAGE) or flat amount
      // (FIXED); it's unused (defaults to 0) for TIERED/SLAB, which
      // instead read from fee_tiers.
      const fee_value = fee_type === 'PERCENTAGE' ? (fee_rate ?? 0)
        : fee_type === 'FIXED' ? (fee_fixed_amount ?? 0)
        : 0;

      const { data: rule, error } = await supabase
        .schema('finance').from('fee_rules')
        .insert({
          platform_id: platformRow.id,
          name: description || `${platformRow.name} ${fee_type} fee`,
          fee_type,
          fee_value,
          min_fee: min_amount || 0,
          max_fee: max_amount || 0,
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

      if (tiers && tiers.length > 0) {
        const { error: tierError } = await supabase
          .schema('finance').from('fee_tiers')
          .insert(tiers.map(t => ({ ...t, fee_rule_id: rule.id })));
        if (tierError) {
          // Roll back the orphaned rule rather than leave a TIERED/SLAB
          // rule with no tiers (compute_platform_fee would silently
          // compute 0 for it).
          await supabase.schema('finance').from('fee_rules').delete().eq('id', rule.id);
          return NextResponse.json({ error: `Failed to save fee tiers: ${tierError.message}` }, { status: 500 });
        }
      }

      try {
        await supabase.schema('audit').rpc('log_action', {
          p_user_id: auth.userId,
          p_action: 'PLATFORM_FEE_CREATED',
          p_entity_type: 'fee_rule',
          p_entity_id: rule.id,
          p_description: `Platform fee rule created: ${platformRow.name} - ${fee_type}`,
          p_source_module: 'settings',
          p_severity: 'medium',
          p_new_values: { platform: platformRow.code, fee_type, fee_rate, fee_fixed_amount, applies_to: applies_to || 'ALL' },
        });
      } catch {}

      return NextResponse.json({ success: true, fee: rule });
    }

    if (action === 'update') {
      const { id, fee_rate, fee_fixed_amount, description, min_amount, max_amount, priority } = parsed.data;
      if (!id) {
        return NextResponse.json({ error: 'id is required for update' }, { status: 400 });
      }

      const existing = getData(await supabase
        .schema('finance').from('fee_rules')
        .select('id, fee_type')
        .eq('id', id)
        .eq('organization_id', auth.orgId)
        .maybeSingle());
      if (!existing) {
        return NextResponse.json({ error: 'Fee rule not found' }, { status: 404 });
      }

      const updates: Record<string, any> = {};
      if (description !== undefined) updates.name = description;
      if (min_amount !== undefined) updates.min_fee = min_amount;
      if (max_amount !== undefined) updates.max_fee = max_amount;
      if (priority !== undefined) updates.priority = priority;
      // Only the field matching the rule's own fee_type can meaningfully
      // update fee_value — updating fee_rate on a FIXED rule (or vice
      // versa) would silently change the wrong thing.
      if (existing.fee_type === 'PERCENTAGE' && fee_rate !== undefined) updates.fee_value = fee_rate;
      if (existing.fee_type === 'FIXED' && fee_fixed_amount !== undefined) updates.fee_value = fee_fixed_amount;
      updates.updated_at = new Date().toISOString();

      const { data, error } = await supabase
        .schema('finance').from('fee_rules')
        .update(updates)
        .eq('id', id)
        .eq('organization_id', auth.orgId)
        .select()
        .single();

      if (error) {
        return NextResponse.json({ error: error.message }, { status: 500 });
      }

      try {
        await supabase.schema('audit').rpc('log_action', {
          p_user_id: auth.userId,
          p_action: 'PLATFORM_FEE_UPDATED',
          p_entity_type: 'fee_rule',
          p_entity_id: id,
          p_description: `Platform fee rule updated: ${data.name}`,
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
        .maybeSingle());

      if (!existing) {
        return NextResponse.json({ error: 'Fee rule not found' }, { status: 404 });
      }

      const { data, error } = await supabase
        .schema('finance').from('fee_rules')
        .update({ is_active: !existing.is_active, updated_at: new Date().toISOString() })
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
        message: `Platform fee rule "${existing.name}" ${!existing.is_active ? 'activated' : 'deactivated'}`,
      });
    }

    return NextResponse.json({ error: 'Invalid action. Use: create, update, or toggle' }, { status: 400 });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}