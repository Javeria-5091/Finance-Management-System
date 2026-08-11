import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { requirePermission } from '@/lib/api-auth';

function getData<T = any>(res: any): T | null {
  return res?.data ?? null;
}

// ─── GET: List payment receipts ───
export async function GET(req: NextRequest) {
  const auth = await requirePermission('INVOICE_READ');
  if (auth instanceof NextResponse) return auth;

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
      query = query.or(`receipt_number.ilike.%${search}%,reference.ilike.%${search}%`);
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
export async function POST(req: NextRequest) {
  const auth = await requirePermission('APPROVE_INVOICE');
  if (auth instanceof NextResponse) return auth;

  try {
    const body = await req.json();
    const {
      client_id, amount, currency, exchange_rate,
      received_date, payment_method, reference,
      financial_account_id, notes, allocations,
    } = body;

    if (!client_id || !amount || !financial_account_id) {
      return NextResponse.json({
        error: 'client_id, amount, and financial_account_id are required',
      }, { status: 400 });
    }

    const paymentAmount = Number(amount);
    if (paymentAmount <= 0) {
      return NextResponse.json({ error: 'Amount must be greater than 0' }, { status: 400 });
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

    // Validate financial account exists
    const finAccount = getData(await supabase
      .from('finance.financial_accounts')
      .select('id, name, account_type, currency')
      .eq('id', financial_account_id)
      .single());

    if (!finAccount) {
      return NextResponse.json({ error: 'Financial account not found' }, { status: 404 });
    }

    // Generate receipt number
    const { data: numData } = await supabase.rpc('get_next_number', { p_type: 'PMT-RC' });
    const receiptNumber = numData || `PMT-RC-${Date.now().toString().slice(-6)}`;

    // Get open period
    const period = getData(await supabase
      .from('finance.accounting_periods')
      .select('id')
      .eq('status', 'OPEN')
      .order('start_date', { ascending: false })
      .limit(1)
      .single());

    if (!period) {
      return NextResponse.json({ error: 'No OPEN accounting period found' }, { status: 400 });
    }

    // Get receivable account
    const receivableAccount = getData(await supabase
      .from('finance.chart_of_accounts')
      .select('id, code, name')
      .eq('account_type', 'ASSET')
      .eq('is_active', true)
      .like('code', '12%')
      .limit(1)
      .single());

    // Get bank/cash account from COA mapped to this financial account
    const bankCoaAccount = getData(await supabase
      .from('finance.chart_of_accounts')
      .select('id, code, name')
      .eq('account_type', 'ASSET')
      .eq('is_active', true)
      .eq('id', finAccount.coa_account_id || '')
      .maybeSingle());

    const debitAccountId = bankCoaAccount?.id || getData(await supabase
      .from('finance.chart_of_accounts')
      .select('id, code, name')
      .eq('account_type', 'ASSET')
      .eq('is_active', true)
      .ilike('name', `%${finAccount.name || 'bank'}%`)
      .limit(1)
      .maybeSingle())?.id;

    if (!receivableAccount || !debitAccountId) {
      return NextResponse.json({
        error: 'Required COA accounts not found. Need ASSET (Receivable) and ASSET (Bank/Cash) accounts.',
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

    // Generate GL reference
    const { data: glNumData } = await supabase.rpc('get_next_number', { p_type: 'JE-PMTR' });
    const glReference = glNumData || `JE-PMTR-${Date.now()}`;

    // Create journal entry: DR Bank/Cash, CR Receivable
    const journal = getData(await supabase
      .from('finance.journal_entries')
      .insert({
        reference: glReference,
        description: `Payment Receipt: ${receiptNumber} from ${client.name}`,
        status: 'APPROVED',
        entry_date: received_date || new Date().toISOString().split('T')[0],
        period_id: period.id,
        source_type: 'PAYMENT_RECEIPT',
        source_id: receiptNumber,
        total_debit: paymentAmount,
        total_credit: paymentAmount,
        currency: currency || 'PKR',
        exchange_rate: exchange_rate || 1,
        created_by: auth.userId,
        approved_by: auth.userId,
        approved_at: new Date().toISOString(),
        organization_id: auth.orgId,
      })
      .select()
      .single());

    if (!journal) {
      return NextResponse.json({ error: 'Failed to create journal entry' }, { status: 500 });
    }

    const linesError = (await supabase.from('finance.journal_lines').insert([
      {
        journal_entry_id: journal.id,
        account_id: debitAccountId,
        debit_amount: paymentAmount,
        credit_amount: 0,
        description: `Cash/Bank: Payment from ${client.name} - ${receiptNumber}`,
      },
      {
        journal_entry_id: journal.id,
        account_id: receivableAccount.id,
        debit_amount: 0,
        credit_amount: paymentAmount,
        description: `Receivable reduced: Payment from ${client.name} - ${receiptNumber}`,
      },
    ])).error;

    if (linesError) {
      await supabase.from('finance.journal_entries').delete().eq('id', journal.id);
      return NextResponse.json({ error: 'Failed to create journal lines' }, { status: 500 });
    }

    const { error: postErr } = await supabase.rpc('finance.post_journal_entry', {
      p_journal_id: journal.id,
      p_posted_by: auth.userId,
    });

    if (postErr) {
      await supabase.from('finance.journal_lines').delete().eq('journal_entry_id', journal.id);
      await supabase.from('finance.journal_entries').delete().eq('id', journal.id);
      return NextResponse.json({ error: 'GL posting failed: ' + postErr.message }, { status: 500 });
    }

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
        journal_entry_id: journal.id,
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

    try {
      await supabase.rpc('audit.log_action', {
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
      console.error('Audit log failed:', auditErr);
    }

    return NextResponse.json({
      success: true,
      receipt: receipt,
      journalId: journal.id,
      glReference,
      allocations: allocationRecords.length,
      message: `Payment receipt ${receiptNumber} recorded and posted to GL`,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
