import { NextRequest, NextResponse } from 'next/server';
import { getAuthSupabase } from '@/lib/api-auth';
import { requirePermission } from '@/lib/api-auth';
import { paymentAllocationSchema, validateBody } from '@/lib/validations';
import { enforceMFA } from '@/lib/mfa-middleware';
 
function getData<T = any>(res: any): T | null {
  return res?.data ?? null;
}
 
// ─── POST: Allocate a payment receipt across multiple invoices ───
export async function POST(req: NextRequest) {
  const auth = await requirePermission('PAYMENT_RECEIPT_UPDATE');
  if (auth instanceof NextResponse) return auth;

  const mfaCheck = await enforceMFA(auth);
  if (mfaCheck) return mfaCheck;

  if (!auth.orgId) {
    return NextResponse.json({ error: 'Organization context is required' }, { status: 400 });
  }

  const { supabase } = await getAuthSupabase(req);

  try {
    const rawBody = await req.json();
    const validation = validateBody(paymentAllocationSchema, rawBody);
    if (!validation.success) {
      return NextResponse.json({ error: validation.error }, { status: 400 });
    }

    const { payment_receipt_id, allocations } = validation.data;

    // The allocation is a financial mutation. Keep all validation, inserts,
    // invoice paid-status updates and receipt locking inside one DB
    // transaction so a mid-request failure cannot leave partial state.
    const { data, error } = await supabase.schema('finance').rpc('allocate_payment_atomic', {
      p_payment_receipt_id: payment_receipt_id,
      p_allocations: allocations,
      p_user_id: auth.userId,
      p_organization_id: auth.orgId,
    });

    if (error) {
      const status = /not found/i.test(error.message) ? 404 : 400;
      return NextResponse.json({ error: error.message }, { status });
    }

    const result = data as any;

    try {
      await supabase.schema('audit').rpc('log_action', {
        p_user_id: auth.userId,
        p_action: 'PAYMENT_ALLOCATED',
        p_entity_type: 'payment_receipt',
        p_entity_id: payment_receipt_id,
        p_description: `Allocated ${result?.total_allocated ?? 0} across ${(result?.allocations || []).length} invoices`,
        p_source_module: 'invoice',
        p_severity: 'medium',
        p_new_values: result,
      });
    } catch (auditErr: any) {
      console.error('Audit log failed:', auditErr);
    }

    return NextResponse.json(result);
  } catch (err: any) {
    return NextResponse.json(
      { error: err?.message || 'Payment allocation failed' },
      { status: 500 }
    );
  }
}
