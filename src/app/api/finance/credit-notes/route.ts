import { NextRequest, NextResponse } from 'next/server';
import { getAuthSupabase } from '@/lib/api-auth';
import { requirePermission } from '@/lib/api-auth';
import { creditNoteCreateSchema, validateBody, sanitizeSearch, validateExchangeRate } from '@/lib/validations';
import { enforceMFA } from '@/lib/mfa-middleware';

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
  const mfaCheck = await enforceMFA(auth);
  if (mfaCheck) return mfaCheck;
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

  // BUG-008 FIX: validate exchange rate for non-PKR currencies
  const rateError = validateExchangeRate(currency, exchange_rate);
  if (rateError) {
    return NextResponse.json({ error: rateError }, { status: 400 });
  }

    // Validate the referenced invoice exists and belongs to org
    const invoice = getData(await supabase
      .from('invoices')
      .select('id, invoice_number, client_id, total_amount, amount_paid, status, currency, exchange_rate')
      .eq('id', invoice_id)
      .eq('organization_id', auth.orgId)
      .single());

    if (!invoice) {
      return NextResponse.json({ error: 'Referenced invoice not found' }, { status: 404 });
    }

    // AR-01 FIX: a credit note is a reduction against a specific invoice and
    // must be valued at that invoice's own (immutable, rate-snapshotted) FX
    // rate -- never a rate supplied by the client or a hardcoded 1. The old
    // code accepted whatever `exchange_rate` the UI sent (which always sent
    // 1, regardless of invoice currency) and stored it as-is, so
    // base_amount = amount * 1 while finance.recompute_invoice_ar_balance
    // relieves the receivable using SUM(cn.amount * invoice.exchange_rate).
    // For a foreign-currency invoice those two no longer match and AR goes
    // out of reconciliation with the subledger by the FX factor. Same fix
    // already applied to refunds (see invoices/refunds/route.ts) -- the
    // invoice's rate is authoritative; a caller-supplied rate is only
    // accepted if it matches.
    const invoiceRateError = validateExchangeRate(invoice.currency, invoice.exchange_rate);
    if (invoiceRateError) {
      return NextResponse.json({ error: invoiceRateError }, { status: 400 });
    }
    const invoiceRate = Number(invoice.exchange_rate || 1);
    const requestedRate = exchange_rate ?? invoiceRate;

    const requestedRateError = validateExchangeRate(currency || invoice.currency, requestedRate);
    if (requestedRateError) {
      return NextResponse.json({ error: requestedRateError }, { status: 400 });
    }

    if (requestedRate !== invoiceRate) {
      return NextResponse.json(
        { error: 'Credit note exchange_rate must match the invoice exchange_rate' },
        { status: 400 },
      );
    }

    const { data: existingCreditNotes, error: creditNoteLookupError } = await supabase
      .from('credit_notes')
      .select('total_amount, status')
      .eq('invoice_id', invoice_id)
      .eq('organization_id', auth.orgId)
      .neq('status', 'REVERSED');

    if (creditNoteLookupError) {
      return NextResponse.json({ error: 'Unable to validate existing credit notes: ' + creditNoteLookupError.message }, { status: 500 });
    }

    const invoiceTotal = Number(invoice.total_amount) || 0;
    const amountPaid = Number(invoice.amount_paid) || 0;
    const previouslyCredited = (existingCreditNotes || []).reduce((sum: number, cn: any) => sum + (Number(cn.total_amount) || 0), 0);
    const remainingCreditable = Math.max(0, invoiceTotal - amountPaid - previouslyCredited);

    if (Number(total_amount) > remainingCreditable + 0.01) {
      return NextResponse.json({
        error: `Credit note amount ${Number(total_amount).toFixed(2)} exceeds the remaining invoice balance available for credit (${remainingCreditable.toFixed(2)}).`,
      }, { status: 400 });
    }

    // Generate credit note number
    const { data: numData } = await supabase.schema('finance').rpc('get_next_number', { p_type: 'CN' });
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
        // AR-01 FIX: was `exchange_rate || 1` (the raw, unenforced client
        // value / hardcoded UI default). Always store the invoice's own
        // rate, already validated above to match whatever the caller sent.
        exchange_rate: invoiceRate,
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