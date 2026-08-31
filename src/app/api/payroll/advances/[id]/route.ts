import { NextRequest, NextResponse } from 'next/server';
import { getAuthSupabase, requirePermission } from '@/lib/api-auth';
import { z } from 'zod';

const schema = z.object({ action: z.enum(['approve', 'reject']) }).strict();

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requirePermission('PAYROLL_ADVANCE_APPROVE');
  if (auth instanceof NextResponse) return auth;
  const { supabase } = await getAuthSupabase(req);
  const parsed = schema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message }, { status: 400 });

  const { data: advance, error: fetchError } = await supabase
    .from('payroll_advances')
    .select('*')
    .eq('id', params.id)
    .eq('organization_id', auth.orgId)
    .single();
  if (fetchError || !advance) return NextResponse.json({ error: 'Payroll advance not found' }, { status: 404 });
  if (advance.approval_status !== 'PENDING') {
    return NextResponse.json({ error: 'Only PENDING payroll advances can be approved or rejected' }, { status: 409 });
  }
  if (advance.created_by && advance.created_by === auth.userId) {
    return NextResponse.json({ error: 'Maker-checker: requester cannot approve their own payroll advance' }, { status: 403 });
  }

  const nextStatus = parsed.data.action === 'approve' ? 'APPROVED' : 'REJECTED';
  const { data, error } = await supabase
    .from('payroll_advances')
    .update({ approval_status: nextStatus, approved_by: auth.userId, approved_at: new Date().toISOString() })
    .eq('id', params.id)
    .eq('organization_id', auth.orgId)
    .eq('approval_status', 'PENDING')
    .select('*')
    .single();
  if (error || !data) return NextResponse.json({ error: error?.message || 'Concurrent modification; refresh and retry' }, { status: error ? 500 : 409 });

  return NextResponse.json({ data, message: parsed.data.action === 'approve' ? 'Payroll advance approved' : 'Payroll advance rejected' });
}
