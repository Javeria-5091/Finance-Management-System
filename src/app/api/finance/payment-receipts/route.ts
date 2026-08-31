import { NextRequest, NextResponse } from 'next/server';
import { getAuthSupabase } from '@/lib/api-auth';
import { requirePermission } from '@/lib/api-auth';
import { enforceMFA } from '@/lib/mfa-middleware';
import { paymentReceiptSchema, validateBody, sanitizeSearch, validateExchangeRate } from '@/lib/validations';

function getData<T = any>(res: any): T | null {
  return res?.data ?? null;
}

// ─── GET: List payment receipts ───
export async function GET(req: NextRequest) {
  const auth = await requirePermission('INVOICE_READ');
  if (auth instanceof NextResponse) return auth;
  const { supabase } = await getAuthSupabase(req);

  try {
    const { searchParams } = new URL(req.url);
    const page = parseInt(searchParams.get('page') || '1');
    const pageSize = parseInt(searchParams.get('pageSize') || '20');
    const search = searchParams.get('search') || '';
    const clientId = searchParams.get('client_id') || '';
    const status = searchParams.get('status') || '';

    let query = supabase
      .schema('finance').from('payment_receipts')
      .select('*, allocations:payment_allocations(id, invoice_id, allocated_amount)', { count: 'exact' })
      .eq('organization_id', auth.orgId);

    if (search) {
      const safeSearch = sanitizeSearch(search);
      query = query.or(`receipt_number.ilike.%${safeSearch}%,reference.ilike.%${safeSearch}%`);
    }
    if (clientId) {
      query = query.eq('client_id', clientId);
    }
    if (status) {
      query = query.eq('status', status);
    }

    const from = (page - 1) * pageSize;
    const to = from + pageSize - 1;

    const { data, error, count } = await query
      .order('payment_date', { ascending: false })
      .range(from, to);

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    // payment_receipts.client_id references the legacy/public clients table
    // only logically; there is no FK relationship in the authoritative schema.
    // Do the client lookup explicitly instead of asking PostgREST to infer a
    // relationship that does not exist in its schema cache.
    const receiptRows = (data || []) as any[];
    const clientIds = [...new Set(receiptRows.map((r) => r.client_id).filter(Boolean))];
    let clientsById = new Map<string, any>();
    if (clientIds.length) {
      const { data: clients, error: clientsError } = await supabase
        .from('clients')
        .select('id, name, client_code')
        .in('id', clientIds)
        .eq('organization_id', auth.orgId);
      if (clientsError) {
        return NextResponse.json({ error: clientsError.message }, { status: 500 });
      }
      clientsById = new Map((clients || []).map((c: any) => [c.id, c]));
    }
    const enrichedData = receiptRows.map((r) => ({
      ...r,
      client: clientsById.get(r.client_id) || null,
    }));

    return NextResponse.json({ data: enrichedData, total: count || 0, page, pageSize });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

// ─── POST: Record a payment receipt and auto-post to GL ───
// Spec: Payment received → DR Bank/Cash/Wallet, CR Accounts Receivable
// BUG-001 FIX: Replaced manual header+lines insert + wrong RPC({ p_journal_id, p_posted_by })
//   with single atomic RPC call using correct signature.
export async function POST(req: NextRequest) {
  const auth = await requirePermission('APPROVE_INVOICE');
  if (auth instanceof NextResponse) return auth;
  // H3 FIX: Enforce MFA for financial posting
  const mfaCheck = await enforceMFA(auth);
  if (mfaCheck) return mfaCheck;
  const { supabase } = await getAuthSupabase(req);

  try {
    const rawBody = await req.json();
    const validation = validateBody(paymentReceiptSchema, rawBody);
    if (!validation.success) return NextResponse.json({ error: validation.error }, { status: 400 });
    const {
      client_id, amount, currency, exchange_rate,
      received_date, payment_method, reference,
      financial_account_id, notes, allocations,
    } = validation.data;

    const paymentAmount = Number(amount);

    // BUG-008 FIX: validate exchange rate for non-PKR currencies
    const rateError = validateExchangeRate(currency, exchange_rate);
    if (rateError) {
      return NextResponse.json({ error: rateError }, { status: 400 });
    }

    // FC-04 FIX: the UI previously hardcoded currency=PKR, exchange_rate=1,
    // so multi-currency AR silently posted wrong GL amounts for any non-PKR
    // invoice payment. Now that the UI can submit a real currency/rate, the
    // API must not just trust an arbitrary client-supplied rate — confirm an
    // approved rate exists in finance.exchange_rates for this currency pair
    // on or before the payment date before allowing the receipt to post.
    const receiptCurrency = (currency || 'PKR').toUpperCase();
    if (receiptCurrency !== 'PKR') {
      const approvedRate = getData(await supabase
        .schema('finance').from('exchange_rates')
        .select('id, rate, rate_date')
        .eq('organization_id', auth.orgId)
        .eq('from_currency', receiptCurrency)
        .eq('to_currency', 'PKR')
        .not('approved_by', 'is', null)
        .lte('rate_date', received_date || new Date().toISOString().split('T')[0])
        .order('rate_date', { ascending: false })
        .limit(1)
        .maybeSingle());

      if (!approvedRate) {
        return NextResponse.json({
          error: `No approved exchange rate found for ${receiptCurrency} -> PKR on or before ${received_date || 'today'}. Enter and approve a rate in Settings > Exchange Rates before recording this payment.`,
        }, { status: 400 });
      }
    }

    // Validate client exists
    const client = getData(await supabase
      .from('clients')
      .select('id, name')
      .eq('id', client_id)
      .eq('organization_id', auth.orgId)
      .single());

    if (!client) {
      return NextResponse.json({ error: 'Client not found' }, { status: 404 });
    }

    // BUG-021 FIX: Validate financial account exists with org isolation
    const finAccount = getData(await supabase
      .schema('finance').from('financial_accounts')
      .select('id, account_name, account_type, currency, linked_ledger_account_id')
      .eq('id', financial_account_id)
      .eq('organization_id', auth.orgId)
      .single());

    if (!finAccount) {
      return NextResponse.json({ error: 'Financial account not found' }, { status: 404 });
    }

    // Generate receipt number
    const { data: numData, error: numberError } = await supabase
      .schema('finance')
      .rpc('get_next_number', {
        p_type: 'PMT-RC',
        p_organization_id: auth.orgId,
      });
    if (numberError || !numData) {
      return NextResponse.json({
        error: 'Payment receipt numbering sequence is not configured for this organization.',
        details: numberError?.message || 'No PMT-RC sequence found',
      }, { status: 500 });
    }
    const receiptNumber = numData;

    // BUG-020 FIX: Get open period with org filter
    const period = getData(await supabase
      .schema('finance').from('accounting_periods')
      .select('id')
      .eq('status', 'OPEN')
      .eq('organization_id', auth.orgId)
      .order('start_date', { ascending: false })
      .limit(1)
      .single());

    if (!period) {
      return NextResponse.json({ error: 'No OPEN accounting period found' }, { status: 400 });
    }

    // Get receivable account
    // BUG-014 FIX: `.like('code', '12%').limit(1).single()` with no
    // ORDER BY could non-deterministically resolve to the 1200
    // PARENT/SUMMARY account instead of the real 1210 "Client Receivables"
    // control account. Resolve by exact seeded code instead.
    const receivableAccount = getData(await supabase
      .schema('finance').from('chart_of_accounts')
      .select('id, code, name')
      .eq('account_type', 'ASSET')
      .eq('is_active', true)
      .eq('code', '1210')
      .maybeSingle());

    const fallbackBankAccount = getData(await supabase
      .schema('finance').from('chart_of_accounts')
      .select('id, code, name')
      .eq('account_type', 'ASSET')
      .eq('is_active', true)
      .eq('code', '1110')
      .maybeSingle());

    const debitAccountId = finAccount.linked_ledger_account_id || fallbackBankAccount?.id;

    if (!receivableAccount || !debitAccountId) {
      return NextResponse.json({
        error: 'Required COA accounts not found. Need Accounts Receivable (code 1210) and a Bank/Cash account (mapped via financial_accounts.linked_ledger_account_id, or the default code 1110 "Bank Account - PKR").',
      }, { status: 400 });
    }

    // Process allocations if provided
    let totalAllocated = 0;
    const allocationRecords: any[] = [];
    if (allocations && Array.isArray(allocations) && allocations.length > 0) {
      for (const alloc of allocations) {
        const invoice = getData(await supabase
          .from('invoices')
          .select('id, invoice_number, total_amount, amount_paid, currency, status')
          .eq('id', alloc.invoice_id)
          .eq('organization_id', auth.orgId)
          .single());

        if (!invoice) {
          return NextResponse.json({ error: `Invoice ${alloc.invoice_id} not found` }, { status: 404 });
        }

        const allocAmount = Number(alloc.amount);
        const outstanding = Number(invoice.total_amount) - Number(invoice.amount_paid || 0);
        if (allocAmount <= 0 || allocAmount > outstanding) {
          return NextResponse.json({
            error: `Allocation amount ${allocAmount} exceeds outstanding balance ${outstanding} for invoice ${invoice.invoice_number}`,
          }, { status: 400 });
        }

        totalAllocated += allocAmount;
        allocationRecords.push({
          invoice_id: alloc.invoice_id,
          amount: allocAmount,
        });
      }
    }

    if (Math.abs(totalAllocated - paymentAmount) > 0.01) {
      return NextResponse.json({
        error: `Total allocations (${totalAllocated}) must equal payment amount (${paymentAmount})`,
      }, { status: 400 });
    }

    // Atomic DB transaction: receipt + allocations + invoice balances + GL posting.
    const { data: atomicResult, error: atomicError } = await supabase.schema('finance').rpc('post_payment_receipt_atomic', {
      p_client_id: client_id,
      p_amount: paymentAmount,
      p_currency: currency || 'PKR',
      p_exchange_rate: exchange_rate || 1,
      p_payment_date: received_date || new Date().toISOString().split('T')[0],
      p_payment_method: payment_method === 'ONLINE' ? 'PLATFORM' : (payment_method || 'BANK_TRANSFER'),
      p_reference: reference || null,
      p_financial_account_id: financial_account_id,
      p_notes: notes || null,
      p_allocations: allocationRecords,
    });

    if (atomicError || !atomicResult) {
      return NextResponse.json({ error: 'Payment receipt transaction failed: ' + (atomicError?.message || 'Unknown error') }, { status: 500 });
    }

    const receiptId = atomicResult.receipt_id;
    const journalId = atomicResult.journal_id;
    const postedReceiptNumber = atomicResult.receipt_number;
    const journal = getData(await supabase
      .schema('finance').from('journal_entries')
      .select('id, reference')
      .eq('id', journalId)
      .eq('organization_id', auth.orgId)
      .single());
    if (!journal) return NextResponse.json({ error: 'Payment posted but journal could not be read back.' }, { status: 500 });

    const { data: receipt, error: receiptErr } = await supabase
      .schema('finance').from('payment_receipts')
      .select('*')
      .eq('id', receiptId)
      .eq('organization_id', auth.orgId)
      .single();
    if (receiptErr || !receipt) return NextResponse.json({ error: 'Payment posted but receipt could not be read back.' }, { status: 500 });

    // BUG-023 FIX: surface a failed audit write instead of only
    // console-logging it (Spec 8.1).
    let auditLogFailed = false;
    try {
      await supabase.schema('audit').rpc('log_action', {
        p_user_id: auth.userId,
        p_action: 'PAYMENT_RECEIVED',
        p_entity_type: 'payment_receipt',
        p_entity_id: receipt?.id || postedReceiptNumber,
        p_description: `Payment received: ${postedReceiptNumber} from ${client.name} - ${currency || 'PKR'} ${paymentAmount}`,
        p_previous_status: null,
        p_new_status: receipt?.status || 'RECEIVED',
        p_source_module: 'invoice',
        p_severity: 'high',
        p_new_values: {
          receipt_number: postedReceiptNumber,
          amount: paymentAmount,
          client_id,
          allocated: totalAllocated,
          journal_id: journal.id,
          currency: currency || 'PKR',
        },
        p_related_journal_id: journal.id,
      });
    } catch (auditErr: any) {
      console.error('Audit log failed for payment receipt:', auditErr);
      auditLogFailed = true;
    }

    const glReference = journal.reference;

    return NextResponse.json({
      success: true,
      receipt,
      journalId: journal.id,
      glReference,
      allocations: allocationRecords.length,
      message: `Payment receipt ${postedReceiptNumber} recorded and posted to GL`,
      audit_log_warning: auditLogFailed ? 'Payment recorded but the audit log entry failed to write. Please notify an administrator.' : undefined,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}