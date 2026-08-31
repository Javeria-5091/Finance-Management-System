import { NextRequest, NextResponse } from 'next/server';
import { getAuthSupabase, requirePermission } from '@/lib/api-auth';
import { enforceMFA } from '@/lib/mfa-middleware';

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requirePermission('INVOICE_UPDATE');

  if (auth instanceof NextResponse) {
    return auth;
  }

  // FND-FIN-008:
  // This handler contains the POST action that posts refunds to the GL.
  // Use the existing central MFA/AAL2 enforcement middleware.
  const mfaCheck = await enforceMFA(auth);

  if (mfaCheck) {
    return mfaCheck;
  }

  const { supabase } = await getAuthSupabase(req);
  const { id } = await params;
  const b = await req.json();

  const { data: r, error: re } = await supabase
    .schema('finance')
    .from('invoice_refunds')
    .select('*')
    .eq('id', id)
    .eq('organization_id', auth.orgId)
    .single();

  if (re || !r) {
    return NextResponse.json(
      { error: 'Refund not found' },
      { status: 404 }
    );
  }

  const action = String(b.action || '').toUpperCase();

  // ------------------------------------------------------------
  // SUBMIT
  // ------------------------------------------------------------
  if (action === 'SUBMIT' && r.status === 'DRAFT') {
    const { data, error } = await supabase
      .schema('finance')
      .from('invoice_refunds')
      .update({
        status: 'PENDING_APPROVAL',
      })
      .eq('id', id)
      .eq('organization_id', auth.orgId)
      .select()
      .single();

    if (error) {
      return NextResponse.json(
        { error: error.message },
        { status: 400 }
      );
    }

    return NextResponse.json({ data });
  }

  // ------------------------------------------------------------
  // APPROVE
  // ------------------------------------------------------------
  if (
    action === 'APPROVE' &&
    r.status === 'PENDING_APPROVAL'
  ) {
    // Preserve existing maker-checker protection.
    if (r.created_by === auth.userId) {
      return NextResponse.json(
        {
          error:
            'Maker-checker: creator cannot approve own refund',
        },
        { status: 403 }
      );
    }

    const { data, error } = await supabase
      .schema('finance')
      .from('invoice_refunds')
      .update({
        status: 'APPROVED',
        approved_by: auth.userId,
        approved_at: new Date().toISOString(),
      })
      .eq('id', id)
      .eq('organization_id', auth.orgId)
      .select()
      .single();

    if (error) {
      return NextResponse.json(
        { error: error.message },
        { status: 400 }
      );
    }

    return NextResponse.json({ data });
  }

  // ------------------------------------------------------------
  // POST
  // ------------------------------------------------------------
  if (action === 'POST' && r.status === 'APPROVED') {
    /*
     * FND-FIN-006 + FND-FIN-007 FIX
     *
     * NEVER modify invoice.total_amount during refund posting.
     *
     * The original invoice amount is immutable.
     *
     * DO NOT:
     *
     *   1. post_journal_entry()
     *   2. update invoice_refunds
     *   3. update invoices
     *
     * as separate requests.
     *
     * The existing database RPC performs the complete operation
     * atomically:
     *
     *   - locks refund
     *   - validates organization
     *   - validates linked invoice
     *   - locks invoice
     *   - validates accounting period
     *   - validates financial account
     *   - validates revenue account
     *   - prevents duplicate posting
     *   - posts GL journal
     *   - reduces ONLY outstanding_amount
     *   - reduces base_outstanding_amount
     *   - marks refund POSTED
     *   - stores journal_entry_id
     *
     * If any operation fails, PostgreSQL rolls back the entire
     * transaction. This prevents orphan GL journals and partially
     * updated invoice/refund records.
     */

    const {
      data: postResult,
      error: postErr,
    } = await supabase
      .schema('finance')
      .rpc('post_invoice_refund_atomic', {
        p_refund_id: id,
      });

    if (postErr) {
      return NextResponse.json(
        {
          error:
            `Refund posting failed: ${postErr.message}`,
        },
        { status: 400 }
      );
    }

    if (!postResult?.journal_id) {
      return NextResponse.json(
        {
          error:
            'Refund posting failed: atomic RPC returned no journal id',
        },
        { status: 500 }
      );
    }

    return NextResponse.json({
      data: {
        ...r,
        status: 'POSTED',
        journal_entry_id: postResult.journal_id,
        posted_at: new Date().toISOString(),
      },
      journalId: postResult.journal_id,
      reference: postResult.reference,
      outstanding_amount: postResult.outstanding_amount,
    });
  }

  // ------------------------------------------------------------
  // PAY
  // ------------------------------------------------------------
  if (action === 'PAY' && r.status === 'POSTED') {
    const { data, error } = await supabase
      .schema('finance')
      .from('invoice_refunds')
      .update({
        status: 'PAID',
        paid_at: new Date().toISOString(),
      })
      .eq('id', id)
      .eq('organization_id', auth.orgId)
      .select()
      .single();

    if (error) {
      return NextResponse.json(
        { error: error.message },
        { status: 400 }
      );
    }

    return NextResponse.json({ data });
  }

  return NextResponse.json(
    {
      error: `Invalid transition ${r.status} -> ${action}`,
    },
    { status: 409 }
  );
}