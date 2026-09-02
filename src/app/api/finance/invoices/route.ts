import { NextRequest, NextResponse } from 'next/server';
import { getAuthSupabase, requirePermission } from '@/lib/api-auth';
import { invoiceCreateSchema, uuidSchema } from '@/lib/validations';

/**
 * Shared amount computation. Every base_* (functional/reporting-currency)
 * column is derived here from exchange_rate — never trusted from, or left
 * for, the client to fill in — so a DRAFT invoice can never be created or
 * edited with base_total_amount / base_outstanding_amount stuck at 0 while
 * total_amount / outstanding_amount holds the real, original-currency
 * value (FND-AR-02).
 */
function computeAmounts(input: {
  amount: number;
  subtotal?: number;
  tax_amount?: number;
  discount_amount?: number;
  total_amount?: number;
  exchange_rate?: number;
}) {
  const exchangeRate = Number(input.exchange_rate || 1);
  const subtotal = Number(input.subtotal ?? input.amount);
  const taxAmount = Number(input.tax_amount || 0);
  const discountAmount = Number(input.discount_amount || 0);
  const totalAmount = Number(input.total_amount ?? input.amount);

  return {
    amount: Number(input.amount),
    subtotal,
    tax_amount: taxAmount,
    discount_amount: discountAmount,
    total_amount: totalAmount,
    exchange_rate: exchangeRate,
    base_subtotal: subtotal * exchangeRate,
    base_tax_amount: taxAmount * exchangeRate,
    base_discount_amount: discountAmount * exchangeRate,
    base_total_amount: totalAmount * exchangeRate,
    outstanding_amount: totalAmount,
    base_outstanding_amount: totalAmount * exchangeRate,
  };
}

function validateInvoiceAmounts(input: {
  amount: number;
  subtotal?: number;
  tax_amount?: number;
  discount_amount?: number;
  total_amount?: number;
}): string | null {
  const subtotal = Number(input.subtotal ?? input.amount);
  const tax = Number(input.tax_amount ?? 0);
  const discount = Number(input.discount_amount ?? 0);
  const total = Number(input.total_amount ?? input.amount);
  const expected = Number((subtotal + tax - discount).toFixed(2));

  if (discount > subtotal + 0.01) return 'Discount cannot exceed subtotal';
  if (Math.abs(expected - total) > 0.01) {
    return `Invoice total must equal subtotal + tax - discount (${expected.toFixed(2)})`;
  }
  return null;
}

/**
 * Server-side invoice creation. Invoice numbers, organization_id, and
 * workflow status are never trusted from the browser; collisions on the
 * generated invoice number are retried with a fresh value.
 */
export async function POST(req: NextRequest) {
  const auth = await requirePermission('INVOICE_CREATE');
  if (auth instanceof NextResponse) return auth;
  const { supabase } = await getAuthSupabase(req);

  try {
    const parsed = invoiceCreateSchema.safeParse(await req.json());
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues[0]?.message || 'Invalid invoice data' }, { status: 400 });
    }
    const {
      client_name, client_id, project_id, amount, subtotal, tax_amount,
      discount_amount, total_amount, currency, exchange_rate, issue_date,
      due_date, notes,
    } = parsed.data;

    const amountError = validateInvoiceAmounts({ amount, subtotal, tax_amount, discount_amount, total_amount });
    if (amountError) return NextResponse.json({ error: amountError }, { status: 400 });

    // BUG-010 FIX: derive the organization from the authenticated session and
    // generate the invoice reference server-side. Never trust a client number.
    // FND-AR-02 FIX: base_subtotal/base_tax_amount/base_discount_amount/
    // base_total_amount were previously never set on create, so they sat at
    // their table DEFAULT 0 even though the original-currency amounts were
    // populated. computeAmounts() derives all of them from exchange_rate.
    const base = {
      user_id: auth.userId,
      organization_id: auth.orgId,
      client_name: String(client_name).trim(),
      client_id: client_id || null,
      project_id: project_id || null,
      currency: currency || 'PKR',
      issue_date: issue_date || new Date().toISOString().slice(0, 10),
      due_date,
      notes: notes || null,
      // Workflow status is always server-controlled. A client cannot create
      // an invoice directly as SUBMITTED/APPROVED/POSTED.
      status: 'DRAFT',
      ...computeAmounts({ amount, subtotal, tax_amount, discount_amount, total_amount, exchange_rate }),
    };

    for (let attempt = 0; attempt < 3; attempt++) {
      const { data: numberData, error: numberError } = await supabase.schema('finance').rpc('get_next_number', {
        p_type: 'INVOICE',
        p_organization_id: auth.orgId,
      });
      const invoiceNumber = numberError
        ? `INV-${Date.now()}-${attempt + 1}`
        : (numberData || `INV-${Date.now()}-${attempt + 1}`);
      // Defense-in-depth: verify the generated number is unused inside this org
      // before attempting the insert. The database constraint, when present,
      // remains the final concurrency guard and the 23505 path retries.
      const { data: existing } = await supabase
        .from('invoices')
        .select('id')
        .eq('organization_id', auth.orgId)
        .eq('invoice_number', invoiceNumber)
        .maybeSingle();
      if (existing) continue;

      const { data, error } = await supabase.from('invoices').insert({
        ...base,
        invoice_number: invoiceNumber,
      }).select().single();

      if (!error) return NextResponse.json({ data }, { status: 201 });

      // Retry only on a uniqueness conflict. Other errors must be surfaced.
      if (error.code !== '23505') {
        return NextResponse.json({ error: error.message }, { status: 400 });
      }
    }

    return NextResponse.json({ error: 'Could not allocate a unique invoice number after retries.' }, { status: 409 });
  } catch (error: any) {
    return NextResponse.json({ error: error?.message || 'Failed to create invoice' }, { status: 500 });
  }
}

/**
 * Server-side invoice edit (FND-AR-02). The dashboard UI previously called
 * supabase.from('invoices').update({ ...formData }) directly, which let a
 * modified client send organization_id / status / any column it wanted,
 * and re-derived base_outstanding_amount from the *original-currency*
 * total instead of the converted one. This endpoint:
 *   - re-validates the payload with the same schema used on create,
 *   - only allows edits while the invoice is still DRAFT,
 *   - only allows the invoice's own creator or an org admin to edit it,
 *   - re-derives every base_* / outstanding_amount column server-side,
 *   - never accepts organization_id or status from the request body.
 */
export async function PATCH(req: NextRequest) {
  const auth = await requirePermission('INVOICE_UPDATE');
  if (auth instanceof NextResponse) return auth;
  const { supabase } = await getAuthSupabase(req);

  try {
    const body = await req.json();
    const idResult = uuidSchema.safeParse(body?.id);
    if (!idResult.success) {
      return NextResponse.json({ error: 'A valid invoice id is required' }, { status: 400 });
    }
    const { id, ...rest } = body;
    const parsed = invoiceCreateSchema.safeParse(rest);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues[0]?.message || 'Invalid invoice data' }, { status: 400 });
    }
    const {
      client_name, client_id, project_id, amount, subtotal, tax_amount,
      discount_amount, total_amount, currency, exchange_rate, issue_date,
      due_date, notes,
    } = parsed.data;

    const amountError = validateInvoiceAmounts({ amount, subtotal, tax_amount, discount_amount, total_amount });
    if (amountError) return NextResponse.json({ error: amountError }, { status: 400 });

    const { data: existing, error: fetchErr } = await supabase
      .from('invoices')
      .select('id, status, user_id, organization_id')
      .eq('id', idResult.data)
      .eq('organization_id', auth.orgId)
      .maybeSingle();

    if (fetchErr) return NextResponse.json({ error: fetchErr.message }, { status: 500 });
    if (!existing) return NextResponse.json({ error: 'Invoice not found' }, { status: 404 });

    if (existing.status !== 'DRAFT') {
      return NextResponse.json({ error: 'Only DRAFT invoices can be edited.' }, { status: 400 });
    }

    if (existing.user_id !== auth.userId && auth.role !== 'CEO' && auth.role !== 'FINANCE_HEAD') {
      return NextResponse.json({ error: 'You can only edit your own DRAFT invoices.' }, { status: 403 });
    }

    const patch = {
      client_name: String(client_name).trim(),
      client_id: client_id || null,
      project_id: project_id || null,
      currency: currency || 'PKR',
      issue_date: issue_date || new Date().toISOString().slice(0, 10),
      due_date,
      notes: notes || null,
      // organization_id and status are deliberately absent: they are never
      // accepted from the client on an edit.
      ...computeAmounts({ amount, subtotal, tax_amount, discount_amount, total_amount, exchange_rate }),
    };

    const { data, error } = await supabase
      .from('invoices')
      .update(patch)
      .eq('id', idResult.data)
      .eq('organization_id', auth.orgId)
      .eq('status', 'DRAFT') // TOCTOU guard: re-check status at write time too
      .select()
      .single();

    if (error) return NextResponse.json({ error: error.message }, { status: 400 });
    return NextResponse.json({ data });
  } catch (error: any) {
    return NextResponse.json({ error: error?.message || 'Failed to update invoice' }, { status: 500 });
  }
}