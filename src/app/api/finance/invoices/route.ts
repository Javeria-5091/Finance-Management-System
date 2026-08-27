import { NextRequest, NextResponse } from 'next/server';
import { getAuthSupabase, requirePermission } from '@/lib/api-auth';
import { invoiceCreateSchema } from '@/lib/validations';

/**
 * Server-side invoice creation. Invoice numbers are never trusted from the
 * browser and collisions are retried with a fresh server-generated value.
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

    // BUG-010 FIX: derive the organization from the authenticated session and
    // generate the invoice reference server-side. Never trust a client number.
    const base = {
      user_id: auth.userId,
      organization_id: auth.orgId,
      client_name: String(client_name).trim(),
      client_id: client_id || null,
      project_id: project_id || null,
      amount: Number(amount),
      subtotal: Number(subtotal ?? amount),
      tax_amount: Number(tax_amount || 0),
      discount_amount: Number(discount_amount || 0),
      total_amount: Number(total_amount ?? amount),
      currency: currency || 'PKR',
      exchange_rate: Number(exchange_rate || 1),
      issue_date: issue_date || new Date().toISOString().slice(0, 10),
      due_date,
      notes: notes || null,
      // Workflow status is always server-controlled. A client cannot create
      // an invoice directly as SUBMITTED/APPROVED/POSTED.
      status: 'DRAFT',
      outstanding_amount: Number(total_amount ?? amount),
      base_outstanding_amount: Number(total_amount ?? amount) * Number(exchange_rate || 1),
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
