import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { requirePermission } from '@/lib/api-auth';

function getData<T = any>(res: any): T | null {
  return res?.data ?? null;
}

// ─── GET: List all platform fee rules ───
export async function GET(req: NextRequest) {
  const auth = await requirePermission('SETTINGS_READ');
  if (auth instanceof NextResponse) return auth;

  try {
    const { searchParams } = new URL(req.url);
    const platform = searchParams.get('platform') || '';
    const isActive = searchParams.get('is_active');

    let query = supabase
      .from('core.platform_fee_directory')
      .select('*')
      .eq('organization_id', auth.orgId);

    if (platform) query = query.eq('platform', platform);
    if (isActive !== null && isActive !== undefined) {
      query = query.eq('is_active', isActive === 'true');
    }

    const { data, error } = await query.order('platform', { ascending: true });

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
  const auth = await requirePermission('SETTINGS_UPDATE');
  if (auth instanceof NextResponse) return auth;

  try {
    const body = await req.json();
    const { action, id, platform, fee_type, fee_rate, fee_fixed_amount, description, currency, min_amount, max_amount } = body;

    if (action === 'create') {
      if (!platform || !fee_type) {
        return NextResponse.json({ error: 'platform and fee_type are required' }, { status: 400 });
      }

      const { data, error } = await supabase
        .from('core.platform_fee_directory')
        .insert({
          platform,
          fee_type: fee_type.toUpperCase(), // PERCENTAGE, FIXED, TIERED
          fee_rate: fee_rate || null,
          fee_fixed_amount: fee_fixed_amount || null,
          description: description || null,
          currency: currency || 'PKR',
          min_amount: min_amount || null,
          max_amount: max_amount || null,
          is_active: true,
          organization_id: auth.orgId,
          created_by: auth.userId,
        })
        .select()
        .single();

      if (error) {
        return NextResponse.json({ error: error.message }, { status: 500 });
      }

      try {
        await supabase.rpc('audit.log_action', {
          p_user_id: auth.userId,
          p_action: 'PLATFORM_FEE_CREATED',
          p_entity_type: 'platform_fee',
          p_entity_id: data.id,
          p_description: `Platform fee created: ${platform} - ${fee_type}`,
          p_source_module: 'settings',
          p_severity: 'medium',
          p_new_values: { platform, fee_type, fee_rate, fee_fixed_amount },
        });
      } catch {}

      return NextResponse.json({ success: true, fee: data });
    }

    if (action === 'update') {
      if (!id) {
        return NextResponse.json({ error: 'id is required for update' }, { status: 400 });
      }

      const updates: Record<string, any> = {};
      if (fee_rate !== undefined) updates.fee_rate = fee_rate;
      if (fee_fixed_amount !== undefined) updates.fee_fixed_amount = fee_fixed_amount;
      if (description !== undefined) updates.description = description;
      if (min_amount !== undefined) updates.min_amount = min_amount;
      if (max_amount !== undefined) updates.max_amount = max_amount;

      const { data, error } = await supabase
        .from('core.platform_fee_directory')
        .update(updates)
        .eq('id', id)
        .eq('organization_id', auth.orgId)
        .select()
        .single();

      if (error) {
        return NextResponse.json({ error: error.message }, { status: 500 });
      }

      try {
        await supabase.rpc('audit.log_action', {
          p_user_id: auth.userId,
          p_action: 'PLATFORM_FEE_UPDATED',
          p_entity_type: 'platform_fee',
          p_entity_id: id,
          p_description: `Platform fee updated: ${data.platform}`,
          p_source_module: 'settings',
          p_severity: 'medium',
          p_new_values: updates,
        });
      } catch {}

      return NextResponse.json({ success: true, fee: data });
    }

    if (action === 'toggle') {
      if (!id) {
        return NextResponse.json({ error: 'id is required' }, { status: 400 });
      }

      const existing = getData(await supabase
        .from('core.platform_fee_directory')
        .select('id, is_active, platform')
        .eq('id', id)
        .eq('organization_id', auth.orgId)
        .single());

      if (!existing) {
        return NextResponse.json({ error: 'Platform fee rule not found' }, { status: 404 });
      }

      const { data, error } = await supabase
        .from('core.platform_fee_directory')
        .update({ is_active: !existing.is_active })
        .eq('id', id)
        .select()
        .single();

      if (error) {
        return NextResponse.json({ error: error.message }, { status: 500 });
      }

      return NextResponse.json({
        success: true,
        fee: data,
        message: `Platform fee ${existing.platform} ${!existing.is_active ? 'activated' : 'deactivated'}`,
      });
    }

    return NextResponse.json({ error: 'Invalid action. Use: create, update, or toggle' }, { status: 400 });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}