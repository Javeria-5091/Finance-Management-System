import { NextRequest, NextResponse } from 'next/server';
import { getAuthSupabase } from '@/lib/api-auth';
import { requirePermission } from '@/lib/api-auth';
import { creditNoteCreateSchema, validateBody, sanitizeSearch } from '@/lib/validations';

function getData<T = any>(res: any): T | null {
  return res?.data ?? null;
}

// ─── GET: List credit notes ───
export async function GET(req: NextRequest) {
  const auth = await requirePermission('INVOICE_READ');
  if (auth instanceof NextResponse) return auth;
  const { supabase } = await getAuthSupabase(req);

  try {
    const { searchParams } = new URL(req.url);
    const page = parseInt(searchParams.get('page') || '1');
    const pageSize = parseInt(searchParams.get('pageSize') || '20');
    const search = searchParams.get('search') || '';
    const status = searchParams.get('status') || '';
    const invoiceId = searchParams.get('invoice_id') || '';

    let query = supabase
      .from('credit_notes')
      .select('*, invoice:invoices(id, invoice_number, client_id)', { count: 'exact' })
      .eq('organization_id', auth.orgId);

    if (search) {
      const safeSearch = sanitizeSearch(search);
      query = query.or(`credit_note_number.ilike.%${safeSearch}%,reason.ilike.%${safeSearch}%`);
    }
    if (status) {
      query = query.eq('status', status);
    }
    if (invoiceId) {
      query = query.eq('invoice_id', invoiceId);
    }

    const from = (page - 1) * pageSize;
    const to = from + pageSize - 1;

    const { data, error, count } = await query
      .order('created_at', { ascending: false })
      .range(from, to);

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ data, total: count || 0, page, pageSize });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

// ─── POST: Create a new credit note ───
export async function POST(req: NextRequest) {
  const auth = await requirePermission('INVOICE_CREATE');
  if (auth instanceof NextResponse) return auth;
  const { supabase } = await getAuthSupabase(req);

  try {
    const rawBody = await req.json();
    const validation = validateBody(creditNoteCreateSchema, rawBody);
    if (!validation.success) return NextResponse.json({ error: validation.error }, { status: 400 });
    const {
      invoice_id, reason, line_items,
      total_amount, tax_amount, currency,
      exchange_rate, notes,
    } = validation.data;

    // Validate the referenced invoice exists and belongs to org
    const invoice = getData(await supabase
      .from('invoices')
      .select('id, invoice_number, client_id, total_amount, status, currency')
      .eq('id', invoice_id)
      .eq('organization_id', auth.orgId)
      .single());

    if (!invoice) {
      return NextResponse.json({ error: 'Referenced invoice not found' }, { status: 404 });
    }

    // Generate credit note number
    const { data: numData } = await supabase.rpc('get_next_number', { p_type: 'CN' });
    const creditNoteNumber = numData || `CN-${Date.now().toString().slice(-6)}`;

    const { data: creditNote, error } = await supabase
      .from('credit_notes')
      .insert({
        credit_note_number: creditNoteNumber,
        invoice_id,
        client_id: invoice.client_id,
        reason: reason || 'Credit Note',
        line_items: line_items || [],
        total_amount,
        tax_amount: tax_amount || 0,
        currency: currency || invoice.currency || 'PKR',
        exchange_rate: exchange_rate || 1,
        notes: notes || null,
        status: 'DRAFT',
        organization_id: auth.orgId,
        created_by: auth.userId,
      })
      .select()
      .single();

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    // BUG-023 FIX: surface a failed audit write instead of only
    // console-logging it (Spec 8.1).
    let auditLogFailed = false;
    try {
      await supabase.schema('audit').rpc('log_action', {
        p_user_id: auth.userId,
        p_action: 'CREDIT_NOTE_CREATED',
        p_entity_type: 'credit_note',
        p_entity_id: creditNote.id,
        p_description: `Credit note created: ${creditNoteNumber} for invoice ${invoice.invoice_number}`,
        p_previous_status: null,
        p_new_status: 'DRAFT',
        p_source_module: 'invoice',
        p_severity: 'medium',
        p_new_values: { credit_note_number: creditNoteNumber, total_amount, invoice_id },
      });
    } catch (auditErr: any) {
      console.error('Audit log failed for credit note create:', auditErr);
      auditLogFailed = true;
    }

    return NextResponse.json({
      success: true,
      creditNote,
      message: `Credit note ${creditNoteNumber} created`,
      audit_log_warning: auditLogFailed ? 'Credit note created but the audit log entry failed to write. Please notify an administrator.' : undefined,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}