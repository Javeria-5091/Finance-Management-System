import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { requirePermission } from '@/lib/api-auth';

function getData<T = any>(res: any): T | null {
  return res?.data ?? null;
}

// ─── POST: Allocate a payment receipt across multiple invoices ───
export async function POST(req: NextRequest) {
  const auth = await requirePermission('APPROVE_INVOICE');
  if (auth instanceof NextResponse) return auth;

  try {
    const { payment_receipt_id, allocations } = await req.json();

    if (!payment_receipt_id || !allocations || !Array.isArray(allocations) || allocations.length === 0) {
      return NextResponse.json({
        error: 'payment_receipt_id and allocations array are required',
      }, { status: 400 });
    }

    // Validate the payment receipt exists
    const receipt = getData(await supabase
      .from('payment_receipts')
      .select('id, receipt_number, amount, amount_allocated, currency, client_id, status, organization_id')
      .eq('id', payment_receipt_id)
      .eq('organization_id', auth.orgId)
      .single());

    if (!receipt) {
      return NextResponse.json({ error: 'Payment receipt not found' }, { status: 404 });
    }

    const unallocatedAmount = Number(receipt.amount) - Number(receipt.amount_allocated);
    let totalNewAllocation = 0;

    // Validate each allocation
    for (const alloc of allocations) {
      if (!alloc.invoice_id || !alloc.amount) {
        return NextResponse.json({ error: 'Each allocation needs invoice_id and amount' }, { status: 400 });
      }

      const allocAmount = Number(alloc.amount);
      if (allocAmount <= 0) {
        return NextResponse.json({ error: 'Allocation amount must be greater than 0' }, { status: 400 });
      }

      // Check for duplicate allocation
      const existingAlloc = getData(await supabase
        .from('payment_allocations')
        .select('id')
        .eq('payment_receipt_id', payment_receipt_id)
        .eq('invoice_id', alloc.invoice_id)
        .maybeSingle());

      if (existingAlloc) {
        return NextResponse.json({
          error: `Invoice ${alloc.invoice_id} is already allocated to this receipt`,
        }, { status: 400 });
      }

      // Check invoice outstanding
      const invoice = getData(await supabase
        .from('invoices')
        .select('id, invoice_number, total_amount, amount_paid, status')
        .eq('id', alloc.invoice_id)
        .eq('organization_id', auth.orgId)
        .single());

      if (!invoice) {
        return NextResponse.json({ error: `Invoice ${alloc.invoice_id} not found` }, { status: 404 });
      }

      const outstanding = Number(invoice.total_amount) - Number(invoice.amount_paid || 0);
      if (allocAmount > outstanding) {
        return NextResponse.json({
          error: `Allocation ${allocAmount} exceeds outstanding ${outstanding} for invoice ${invoice.invoice_number}`,
        }, { status: 400 });
      }

      totalNewAllocation += allocAmount;
    }

    if (totalNewAllocation > unallocatedAmount) {
      return NextResponse.json({
        error: `Total new allocation (${totalNewAllocation}) exceeds unallocated amount (${unallocatedAmount})`,
      }, { status: 400 });
    }

    // Create allocation records
    const createdAllocations: any[] = [];
    for (const alloc of allocations) {
      const { data: newAlloc, error } = await supabase
        .from('payment_allocations')
        .insert({
          payment_receipt_id,
          invoice_id: alloc.invoice_id,
          amount: Number(alloc.amount),
          allocated_by: auth.userId,
          organization_id: auth.orgId,
        })
        .select()
        .single();

      if (!error && newAlloc) {
        createdAllocations.push(newAlloc);

        // Update invoice amount_paid
        const invoice = getData(await supabase
          .from('invoices')
          .select('id, total_amount, amount_paid')
          .eq('id', alloc.invoice_id)
          .single());

        if (invoice) {
          const newPaid = Number(invoice.amount_paid || 0) + Number(alloc.amount);
          const total = Number(invoice.total_amount);
          const newStatus = newPaid >= total ? 'PAID' : 'PARTIALLY_PAID';

          await supabase.from('invoices').update({
            amount_paid: newPaid,
            status: newStatus,
          }).eq('id', alloc.invoice_id);
        }
      }
    }

    // Update receipt
    const newAmountAllocated = Number(receipt.amount_allocated) + totalNewAllocation;
    const newUnallocated = Number(receipt.amount) - newAmountAllocated;
    const newStatus = newUnallocated <= 0.01 ? 'FULLY_ALLOCATED' : 'PARTIALLY_ALLOCATED';

    await supabase.from('payment_receipts').update({
      amount_allocated: newAmountAllocated,
      unallocated_amount: newUnallocated,
      status: newStatus,
    }).eq('id', payment_receipt_id);

    // Audit log
    try {
      await supabase.rpc('audit.log_action', {
        p_user_id: auth.userId,
        p_action: 'PAYMENT_ALLOCATED',
        p_entity_type: 'payment_receipt',
        p_entity_id: payment_receipt_id,
        p_description: `Allocated ${totalNewAllocation} across ${createdAllocations.length} invoices from receipt ${receipt.receipt_number}`,
        p_previous_status: receipt.status,
        p_new_status: newStatus,
        p_source_module: 'invoice',
        p_severity: 'medium',
        p_new_values: {
          allocations_created: createdAllocations.length,
          total_allocated: totalNewAllocation,
          remaining_unallocated: newUnallocated,
        },
      });
    } catch (auditErr: any) {
      console.error('Audit log failed:', auditErr);
    }

    return NextResponse.json({
      success: true,
      allocations: createdAllocations,
      totalAllocated: totalNewAllocation,
      remainingUnallocated: newUnallocated,
      receiptStatus: newStatus,
      message: `Payment allocated across ${createdAllocations.length} invoices`,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}