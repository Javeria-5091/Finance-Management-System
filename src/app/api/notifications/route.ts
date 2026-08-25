import { NextRequest, NextResponse } from 'next/server';
import { getAuthSupabase } from '@/lib/api-auth';
import { getAuthUser } from '@/lib/api-auth';
import { notificationCreateSchema, validateBody } from '@/lib/validations';
 
function getData<T = any>(res: any): T | null {
  return res?.data ?? null;
}
 
// ─── GET: List notifications for authenticated user ───
export async function GET(req: NextRequest) {
  const auth = await getAuthUser();
  if (auth instanceof NextResponse) return auth;
  const { supabase } = await getAuthSupabase(req);
 
  try {
    const { searchParams } = new URL(req.url);
    const page = parseInt(searchParams.get('page') || '1');
    const pageSize = parseInt(searchParams.get('pageSize') || '20');
    const type = searchParams.get('type') || '';
    const unreadOnly = searchParams.get('unread') === 'true';
 
    let query = supabase
      .schema('core').from('notifications')
      .select('*', { count: 'exact' })
      .eq('user_id', auth.userId);
 
    if (type) {
      query = query.eq('notification_type', type);
    }
    if (unreadOnly) {
      query = query.eq('is_read', false);
    }
 
    const from = (page - 1) * pageSize;
    const to = from + pageSize - 1;
 
    const { data, error, count } = await query
      .order('created_at', { ascending: false })
      .range(from, to);
 
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
 
    // Get unread count
    const { count: unreadCount } = await supabase
      .schema('core').from('notifications')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', auth.userId)
      .eq('is_read', false);
 
    return NextResponse.json({
      data: data || [],
      total: count || 0,
      page,
      pageSize,
      unreadCount: unreadCount || 0,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
 
// ─── POST: Create a new notification (system-generated) ───
export async function POST(req: NextRequest) {
  const auth = await getAuthUser();
  if (auth instanceof NextResponse) return auth;
  const { supabase } = await getAuthSupabase(req);
 
  try {
    const rawBody = await req.json();
    const validation = validateBody(notificationCreateSchema, rawBody);
    if (!validation.success) return NextResponse.json({ error: validation.error }, { status: 400 });
    const {
      user_id,
      title,
      message,
      notification_type,
      priority,
      action_url,
      entity_type,
      entity_id,
      expires_at,
    } = validation.data;
 
    // C4 FIX: Authorization check — only allow sending to self or admin can send to anyone
    const targetUserId = user_id || auth.userId;
    if (targetUserId !== auth.userId && auth.role !== 'CEO') {
      return NextResponse.json({ error: 'You can only create notifications for yourself' }, { status: 403 });
    }

    // BUG FIX (Audit Finding C-3, Critical): cross-tenant notification
    // injection. The previous check allowed CEO/Admin to create notifications
    // for ANY user_id — including users in OTHER organizations. A CEO of
    // Org A could write notifications into Org B users' inboxes (Spec 4.2
    // tenant isolation violation + Spec 7 information-leak vector).
    //
    // Fix: when targetUserId differs from the caller, verify the target
    // belongs to the caller's organization before inserting. We do this
    // by looking up the profile and checking organization_id matches.
    if (targetUserId !== auth.userId) {
      const { data: targetProfile } = await supabase
        .from('profiles')
        .select('organization_id')
        .eq('user_id', targetUserId)
        .maybeSingle();

      if (!targetProfile) {
        return NextResponse.json({ error: 'Target user not found' }, { status: 404 });
      }
      if (auth.orgId && targetProfile.organization_id !== auth.orgId) {
        // Fail closed — do NOT leak that the user exists in another org.
        return NextResponse.json({ error: 'Target user not found' }, { status: 404 });
      }
    }
 
    const { data, error } = await supabase
      .schema('core').from('notifications')
      .insert({
        user_id: targetUserId,
        title,
        message,
        notification_type: notification_type || 'INFO',
        priority: priority || 'medium',
        action_url: action_url || null,
        entity_type: entity_type || null,
        entity_id: entity_id || null,
        is_read: false,
        created_by: auth.userId,
        expires_at: expires_at || null,
        organization_id: auth.orgId,
      })
      .select()
      .single();
 
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
 
    return NextResponse.json({
      success: true,
      notification: data,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
 
// ─── PATCH: Mark notifications as read ───
export async function PATCH(req: NextRequest) {
  const auth = await getAuthUser();
  if (auth instanceof NextResponse) return auth;
  const { supabase } = await getAuthSupabase(req);
 
  try {
    const body = await req.json();
    const { notification_ids, mark_all_read } = body;
 
    if (mark_all_read) {
      const { error } = await supabase
        .schema('core').from('notifications')
        .update({ is_read: true, read_at: new Date().toISOString() })
        .eq('user_id', auth.userId)
        .eq('is_read', false);
 
      if (error) {
        return NextResponse.json({ error: error.message }, { status: 500 });
      }
 
      return NextResponse.json({ success: true, message: 'All notifications marked as read' });
    }
 
    if (notification_ids && Array.isArray(notification_ids)) {
      const { error } = await supabase
        .schema('core').from('notifications')
        .update({ is_read: true, read_at: new Date().toISOString() })
        .in('id', notification_ids)
        .eq('user_id', auth.userId);
 
      if (error) {
        return NextResponse.json({ error: error.message }, { status: 500 });
      }
 
      return NextResponse.json({ success: true, message: `${notification_ids.length} notification(s) marked as read` });
    }
 
    return NextResponse.json({ error: 'Provide notification_ids or mark_all_read' }, { status: 400 });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

