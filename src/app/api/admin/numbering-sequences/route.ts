import { NextRequest, NextResponse } from 'next/server';
import { sanitizeSearch, numberingPostSchema } from '@/lib/validations';
import { getAuthSupabase } from '@/lib/api-auth';
import { requirePermission } from '@/lib/api-auth';
 
function getData<T = any>(res: any): T | null {
  return res?.data ?? null;
}
 
// ─── GET: List all numbering sequences ───
export async function GET(req: NextRequest) {
  const auth = await requirePermission('SETTINGS_READ');
  if (auth instanceof NextResponse) return auth;
  const { supabase } = await getAuthSupabase(req);
 
  try {
    const { searchParams } = new URL(req.url);
    const prefix = searchParams.get('prefix') || '';
 
    let query = supabase
      .schema('finance').from('numbering_sequences')
      .select('*')
      .eq('organization_id', auth.orgId)
      .order('sequence_type', { ascending: true });
 
    if (prefix) {
      query = query.ilike('sequence_type', `${sanitizeSearch(prefix)}%`);
    }
 
    const { data, error } = await query;
 
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
 
    return NextResponse.json({ data: data || [] });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
 
// ─── POST: Create or update numbering sequence ───
export async function POST(req: NextRequest) {
  const auth = await requirePermission('SETTINGS_MANAGE');
  if (auth instanceof NextResponse) return auth;
  const { supabase } = await getAuthSupabase(req);
 
  try {
    const body = await req.json();
    const parsed = numberingPostSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({
        error: 'Invalid request body',
        details: parsed.error.flatten(),
      }, { status: 400 });
    }

    const action = parsed.data.action;
 
    if (action === 'create') {
      const { sequence_code, prefix, description, current_number, padding, reset_period, format } = parsed.data;
      if (!sequence_code || !prefix) {
        return NextResponse.json({ error: 'sequence_code and prefix are required' }, { status: 400 });
      }
 
      // Check if sequence already exists
      const existing = getData(await supabase
        .schema('finance').from('numbering_sequences')
        .select('id')
        .eq('sequence_type', sequence_code)
        .eq('organization_id', auth.orgId)
        .maybeSingle());
 
      if (existing) {
        return NextResponse.json({ error: 'Sequence code already exists' }, { status: 400 });
      }
 
      const { data, error } = await supabase
        .schema('finance').from('numbering_sequences')
        .insert({
          sequence_type: sequence_code,
          prefix,
          current_number: current_number || 0,
          padding: padding || 5,
          reset_per_period: reset_period === 'PERIOD',
          format: format || '{PREFIX}{NUMBER}',
          organization_id: auth.orgId,
          created_by: auth.userId,
        })
        .select()
        .single();
 
      if (error) {
        return NextResponse.json({ error: error.message }, { status: 500 });
      }
 
      try {
        await supabase.schema('audit').rpc('log_action', {
          p_user_id: auth.userId,
          p_action: 'SEQUENCE_CREATED',
          p_entity_type: 'numbering_sequence',
          p_entity_id: data.id,
          p_description: `Numbering sequence created: ${sequence_code} with prefix ${prefix}`,
          p_source_module: 'settings',
          p_severity: 'medium',
          p_new_values: { sequence_code, prefix, padding },
        });
      } catch {}
 
      return NextResponse.json({ success: true, sequence: data });
    }
 
    if (action === 'update') {
      const { sequence_code, prefix, current_number, padding, reset_period, format } = parsed.data;
      if (!sequence_code) {
        return NextResponse.json({ error: 'sequence_code is required' }, { status: 400 });
      }
 
      const updates: Record<string, any> = {};
      if (prefix !== undefined) updates.prefix = prefix;
      if (current_number !== undefined) updates.current_number = current_number;
      if (padding !== undefined) updates.padding = padding;
      if (reset_period !== undefined) updates.reset_per_period = reset_period === 'PERIOD';
      if (format !== undefined) updates.format = format;
 
      const { data, error } = await supabase
        .schema('finance').from('numbering_sequences')
        .update(updates)
        .eq('sequence_type', sequence_code)
        .eq('organization_id', auth.orgId)
        .select()
        .single();
 
      if (error) {
        return NextResponse.json({ error: error.message }, { status: 500 });
      }
 
      try {
  await       supabase.schema('audit').rpc('log_action', {
          p_user_id: auth.userId,
          p_action: 'SEQUENCE_UPDATED',
          p_entity_type: 'numbering_sequence',
          p_entity_id: data.id,
          p_description: `Numbering sequence updated: ${sequence_code}`,
          p_source_module: 'settings',
          p_severity: 'medium',
          p_new_values: updates,
        });
      } catch {}
 
      return NextResponse.json({ success: true, sequence: data });
    }
 
    if (action === 'reset') {
      const { sequence_code } = parsed.data;
      if (!sequence_code) {
        return NextResponse.json({ error: 'sequence_code is required' }, { status: 400 });
      }
 
      const { data, error } = await supabase
        .schema('finance').from('numbering_sequences')
        .update({ current_number: 0 })
        .eq('sequence_type', sequence_code)
        .eq('organization_id', auth.orgId)
        .select()
        .single();
 
      if (error) {
        return NextResponse.json({ error: error.message }, { status: 500 });
      }
 
      try {
       await supabase.schema('audit').rpc('log_action', {
          p_user_id: auth.userId,
          p_action: 'SEQUENCE_RESET',
          p_entity_type: 'numbering_sequence',
          p_entity_id: data.id,
          p_description: `Numbering sequence reset to 0: ${sequence_code}`,
          p_source_module: 'settings',
          p_severity: 'high',
          p_new_values: { sequence_code, new_current_number: 0 },
        });
      } catch {}
 
      return NextResponse.json({ success: true, sequence: data, message: `Sequence ${sequence_code} reset to 0` });
    }
 
    return NextResponse.json({ error: 'Invalid action. Use: create, update, or reset' }, { status: 400 });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}