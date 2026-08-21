import { NextRequest, NextResponse } from 'next/server';
import { getAuthSupabase } from '@/lib/api-auth';
import { requirePermission } from '@/lib/api-auth';
import { enforceMFA } from '@/lib/mfa-middleware';
import { paymentReceiptSchema, validateBody, sanitizeSearch } from '@/lib/validations';

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
      .from('payment_receipts')
      .select('*, client:clients(id, name, client_code), allocations:payment_allocations(id, invoice_id, amount)', { count: 'exact' })
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
      .order('received_date', { ascending: false })
      .range(from, to);

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ data, total: count || 0, page, pageSize });
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
      .from('finance.financial_accounts')
      .select('id, name, account_type, currency')
      .eq('id', financial_account_id)
      .eq('organization_id', auth.orgId)
      .single());

    if (!finAccount) {
      return NextResponse.json({ error: 'Financial account not found' }, { status: 404 });
    }

    // Generate receipt number
    const { data: numData } = await supabase.rpc('get_next_number', { p_type: 'PMT-RC' });
    const receiptNumber = numData || `PMT-RC-${Date.now().toString().slice(-6)}`;

    // BUG-020 FIX: Get open period with org filter
    const period = getData(await supabase
      .from('finance.accounting_periods')
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
      .from('finance.chart_of_accounts')
      .select('id, code, name')
      .eq('account_type', 'ASSET')
      .eq('is_active', true)
      .eq('code', '1210')
      .maybeSingle());

    // Get bank/cash account from COA mapped to this financial account.
    // This primary lookup was already deterministic (FK by
    // finAccount.coa_account_id) -- left unchanged.
    const bankCoaAccount = getData(await supabase
      .from('finance.chart_of_accounts')
      .select('id, code, name')
      .eq('account_type', 'ASSET')
      .eq('is_active', true)
      .eq('id', finAccount.coa_account_id || '')
      .maybeSingle());

    // BUG-014 FIX: this fallback (used only when the financial account has
    // no coa_account_id configured) previously did an unordered fuzzy
    // ILIKE match, which could resolve to a different bank/cash sub-account
    // than intended and would silently pick a different one on a re-run if
    // row order ever changed. If no FK mapping exists, fall back to the
    // deterministic default cash/bank control account (code 1110, "Bank
    // Account - PKR") rather than guessing from the financial account's
    // display name; .order('code') on the name-based attempt keeps it
    // deterministic if that path is ever reached first.
    const fallbackBankAccount = getData(await supabase
      .from('finance.chart_of_accounts')
      .select('id, code, name')
      .eq('account_type', 'ASSET')
      .eq('is_active', true)
      .eq('code', '1110')
      .maybeSingle());

    const debitAccountId = bankCoaAccount?.id || fallbackBankAccount?.id;

    if (!receivableAccount || !debitAccountId) {
      return NextResponse.json({
        error: 'Required COA accounts not found. Need Accounts Receivable (code 1210) and a Bank/Cash account (either mapped via financial_accounts.coa_account_id, or the default code 1110 "Bank Account - PKR").',
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

    if (totalAllocated > paymentAmount) {
      return NextResponse.json({
        error: `Total allocations (${totalAllocated}) exceed payment amount (${paymentAmount})`,
      }, { status: 400 });
    }

    // BUG-001 FIX: Build journal lines for RPC (no manual header/line inserts)
    // Payment Receipt: DR Bank/Cash, CR Receivable
    const rpcLines = [
      {
        account_id: debitAccountId,
        debit_amount: paymentAmount,
        credit_amount: 0,
        description: `Cash/Bank: Payment from ${client.name} - ${receiptNumber}`,
      },
      {
        account_id: receivableAccount.id,
        debit_amount: 0,
        credit_amount: paymentAmount,
        description: `Receivable reduced: Payment from ${client.name} - ${receiptNumber}`,
      },
    ];

    // BUG-001 FIX: Single atomic RPC call with CORRECT signature
    const { data: journalId, error: postErr } = await supabase.schema('finance').rpc('post_journal_entry', {
      p_description: `Payment Receipt: ${receiptNumber} from ${client.name}`,
      p_transaction_date: received_date || new Date().toISOString().split('T')[0],
      p_period_id: period.id,
      p_lines: JSON.stringify(rpcLines),
      p_currency: currency || 'PKR',
      p_exchange_rate: exchange_rate || 1,
      p_source_type: 'PAYMENT_RECEIPT',
      p_source_id: receiptNumber,
    });

    if (postErr || !journalId) {
      return NextResponse.json({ error: 'GL posting failed: ' + (postErr?.message || 'Unknown error') }, { status: 500 });
    }

    // Fetch the created journal to get reference
    const journal = getData(await supabase
      .from('finance.journal_entries')
      .select('id, reference')
      .eq('id', journalId)
      .single());
    // C6 FIX: Null guard
    if (!journal) {
      return NextResponse.json({ error: 'Journal created but fetch failed. Check journal ID: ' + journalId }, { status: 500 });
    }
    const glReference = journal.reference || `JE-PMTR-${journalId}`;

    // Create payment receipt record
    const { data: receipt, error: receiptErr } = await supabase
      .from('payment_receipts')
      .insert({
        receipt_number: receiptNumber,
        client_id,
        amount: paymentAmount,
        currency: currency || 'PKR',
        exchange_rate: exchange_rate || 1,
        received_date: received_date || new Date().toISOString().split('T')[0],
        payment_method: payment_method || 'BANK_TRANSFER',
        reference: reference || null,
        financial_account_id,
        notes: notes || null,
        amount_allocated: totalAllocated,
        unallocated_amount: paymentAmount - totalAllocated,
        status: totalAllocated >= paymentAmount ? 'FULLY_ALLOCATED' : 'PARTIALLY_ALLOCATED',
        journal_entry_id: journalId,
        organization_id: auth.orgId,
        created_by: auth.userId,
      })
      .select()
      .single();

    if (receiptErr) {
      console.error('Payment receipt creation failed:', receiptErr.message);
    }

    // Create allocation records and update invoice amounts
    if (allocationRecords.length > 0 && receipt) {
      for (const alloc of allocationRecords) {
        // Insert allocation
        await supabase.from('payment_allocations').insert({
          payment_receipt_id: receipt.id,
          invoice_id: alloc.invoice_id,
          amount: alloc.amount,
          allocated_by: auth.userId,
          organization_id: auth.orgId,
        });

        // Update invoice amount_paid
        const invoice = getData(await supabase
          .from('invoices')
          .select('id, total_amount, amount_paid')
          .eq('id', alloc.invoice_id)
          .single());

        if (invoice) {
          const newPaid = Number(invoice.amount_paid || 0) + alloc.amount;
          const total = Number(invoice.total_amount);
          const newStatus = newPaid >= total ? 'PAID' : 'PARTIALLY_PAID';

          await supabase.from('invoices').update({
            amount_paid: newPaid,
            status: newStatus,
            payment_date: newPaid >= total ? new Date().toISOString() : null,
          }).eq('id', alloc.invoice_id);
        }
      }
    }

    // BUG-023 FIX: surface a failed audit write instead of only
    // console-logging it (Spec 8.1).
    let auditLogFailed = false;
    try {
      await supabase.schema('audit').rpc('log_action', {
        p_user_id: auth.userId,
        p_action: 'PAYMENT_RECEIVED',
        p_entity_type: 'payment_receipt',
        p_entity_id: receipt?.id || receiptNumber,
        p_description: `Payment received: ${receiptNumber} from ${client.name} - ${currency || 'PKR'} ${paymentAmount}`,
        p_previous_status: null,
        p_new_status: receipt?.status || 'RECEIVED',
        p_source_module: 'invoice',
        p_severity: 'high',
        p_new_values: {
          receipt_number: receiptNumber,
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

    return NextResponse.json({
      success: true,
      receipt,
      journalId: journal.id,
      glReference,
      allocations: allocationRecords.length,
      message: `Payment receipt ${receiptNumber} recorded and posted to GL`,
      audit_log_warning: auditLogFailed ? 'Payment recorded but the audit log entry failed to write. Please notify an administrator.' : undefined,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}