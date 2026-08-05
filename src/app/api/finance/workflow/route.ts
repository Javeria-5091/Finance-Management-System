import { NextRequest, NextResponse } from 'next/server';
import { getAuthUser, checkApprovalLimit } from '@/lib/api-auth';
import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';

// ═════════════════════════════════════════════════════════════════════
//  UNIFIED WORKFLOW API — Server-side auth + maker-checker + limits
//  All status transitions: submit/verify/approve/post/reject/reverse/issue
//  ═════════════════════════════════════════════════════════════════════

function db() {
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { cookies: { getAll: async () => (await cookies()).getAll(), setAll: () => {} } }
  );
}

const MODULES: Record<string, {
  table: string; permPrefix: string; amountField: string; creatorField: string;
  transitions: Record<string, { from: string[]; perm: string }>;
}> = {
  expense: {
    table: 'expenses', permPrefix: 'EXPENSE', amountField: 'amount', creatorField: 'created_by',
    transitions: {
      submit:  { from: ['DRAFT'], perm: 'EXPENSE_UPDATE' },
      verify:  { from: ['SUBMITTED'], perm: 'APPROVE_EXPENSE' },
      approve: { from: ['SUBMITTED', 'VERIFIED'], perm: 'APPROVE_EXPENSE' },
      reject:  { from: ['SUBMITTED', 'VERIFIED'], perm: 'EXPENSE_UPDATE' },
      reverse: { from: ['POSTED'], perm: 'EXPENSE_UPDATE' },
      reopen:  { from: ['REJECTED'], perm: 'EXPENSE_UPDATE' },
    },
  },
  income: {
    table: 'incomes', permPrefix: 'INCOME', amountField: 'amount', creatorField: 'created_by',
    transitions: {
      submit:  { from: ['DRAFT'], perm: 'INCOME_UPDATE' },
      verify:  { from: ['SUBMITTED'], perm: 'APPROVE_INCOME' },
      approve: { from: ['SUBMITTED', 'VERIFIED'], perm: 'APPROVE_INCOME' },
      reject:  { from: ['SUBMITTED', 'VERIFIED'], perm: 'INCOME_UPDATE' },
      reverse: { from: ['POSTED'], perm: 'INCOME_UPDATE' },
      reopen:  { from: ['REJECTED'], perm: 'INCOME_UPDATE' },
    },
  },
  invoice: {
    table: 'invoices', permPrefix: 'INVOICE', amountField: 'total_amount', creatorField: 'created_by',
    transitions: {
      submit:  { from: ['DRAFT'], perm: 'INVOICE_UPDATE' },
      approve: { from: ['SUBMITTED'], perm: 'APPROVE_INVOICE' },
      issue:   { from: ['APPROVED'], perm: 'INVOICE_UPDATE' },
      reject:  { from: ['SUBMITTED'], perm: 'INVOICE_UPDATE' },
      reopen:  { from: ['REJECTED'], perm: 'INVOICE_UPDATE' },
    },
  },
  vendor_bill: {
    table: 'vendor_bills', permPrefix: 'EXPENSE', amountField: 'total_amount', creatorField: 'created_by',
    transitions: {
      submit:  { from: ['DRAFT'], perm: 'EXPENSE_UPDATE' },
      verify:  { from: ['SUBMITTED'], perm: 'APPROVE_EXPENSE' },
      approve: { from: ['SUBMITTED', 'VERIFIED'], perm: 'APPROVE_EXPENSE' },
      reject:  { from: ['SUBMITTED', 'VERIFIED'], perm: 'EXPENSE_UPDATE' },
      reverse: { from: ['POSTED'], perm: 'EXPENSE_UPDATE' },
      cancel:  { from: ['DRAFT', 'SUBMITTED', 'VERIFIED', 'APPROVED'], perm: 'EXPENSE_UPDATE' },
    },
  },
  journal_entry: {
    table: 'finance.journal_entries', permPrefix: 'JOURNAL', amountField: 'total_debit', creatorField: 'created_by',
    transitions: {
      submit:  { from: ['DRAFT'], perm: 'JOURNAL_UPDATE' },
      verify:  { from: ['SUBMITTED'], perm: 'APPROVE_JOURNAL' },
      approve: { from: ['VERIFIED', 'SUBMITTED'], perm: 'APPROVE_JOURNAL' },
      reject:  { from: ['SUBMITTED'], perm: 'JOURNAL_UPDATE' },
      reverse: { from: ['POSTED'], perm: 'JOURNAL_UPDATE' },
      reopen:  { from: ['REJECTED'], perm: 'JOURNAL_UPDATE' },
    },
  },
};

export async function POST(req: NextRequest) {
  const supabase = db();

  // ─── 1. AUTHENTICATE ───
  const auth = await getAuthUser();
  if (auth instanceof NextResponse) return auth;

  try {
    const { module, recordId, action, reason } = await req.json();
    if (!module || !recordId || !action) {
      return NextResponse.json({ error: 'module, recordId, and action are required' }, { status: 400 });
    }

    const config = MODULES[module];
    if (!config) return NextResponse.json({ error: `Unknown module: ${module}` }, { status: 400 });

    const transition = config.transitions[action];
    if (!transition) return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });

    // ─── 2. PERMISSION CHECK (CEO bypasses all) ───
    if (auth.role !== 'CEO' && auth.role !== 'Admin') {
      const { data: perms } = await supabase.rpc('get_my_permissions');
      let hasPerm = false;
      if (perms) {
        if (!Array.isArray(perms) && typeof perms === 'object' && perms[transition.perm] === true) hasPerm = true;
        if (Array.isArray(perms) && perms.some((p: any) => (p.permission_code || p.code) === transition.perm)) hasPerm = true;
      }
      if (!hasPerm) {
        return NextResponse.json({ error: `Permission denied: ${transition.perm} required` }, { status: 403 });
      }
    }

    // ─── 3. FETCH RECORD ───
    const { data: record, error: fetchErr } = await supabase.from(config.table).select('*').eq('id', recordId).single();
    if (fetchErr || !record) {
      return NextResponse.json({ error: 'Record not found' }, { status: 404 });
    }

    // ─── 4. VALIDATE STATUS TRANSITION ───
    const currentStatus = (record.status || '').toUpperCase();
    if (!transition.from.includes(currentStatus)) {
      return NextResponse.json({ error: `Invalid: ${module} is ${currentStatus}, cannot ${action}. Needs: ${transition.from.join(' or ')}` }, { status: 400 });
    }

    // ─── 5. MAKER-CHECKER ───
    if (action === 'approve' || action === 'verify') {
      const creatorId = record[config.creatorField] || record.user_id;
      if (creatorId === auth.userId) {
        return NextResponse.json({ error: `Maker-checker violation: You cannot ${action} your own ${module.replace('_', ' ')}.` }, { status: 403 });
      }
    }

    // ─── 6. APPROVAL AMOUNT LIMIT ───
    if (action === 'approve') {
      const amount = Number(record[config.amountField]) || 0;
      const limitCheck = checkApprovalLimit(auth.role, amount);
      if (!limitCheck.allowed) {
        return NextResponse.json({ error: limitCheck.reason }, { status: 403 });
      }
    }

    // ─── 7. BUILD UPDATE ───
    const updateData: Record<string, any> = {};
    const now = new Date().toISOString();

    if (action === 'reopen') {
      updateData.status = 'DRAFT';
      updateData.rejection_reason = null;
    } else if (action === 'reject') {
      updateData.status = 'REJECTED';
      updateData.rejection_reason = reason || 'No reason provided';
    } else if (action === 'reverse') {
      updateData.status = 'REVERSED';
      updateData.reversal_reason = reason || 'No reason provided';
      updateData.reversed_by = auth.userId;
      updateData.reversed_at = now;
    } else if (action === 'cancel') {
      updateData.status = 'CANCELLED';
      updateData.rejection_reason = reason || 'Cancelled';
    } else {
      const statusMap: Record<string, string> = { submit: 'SUBMITTED', verify: 'VERIFIED', approve: 'APPROVED', issue: 'ISSUED' };
      updateData.status = statusMap[action] || action.toUpperCase();
      if (action === 'submit')  { updateData.submitted_by = auth.userId; updateData.submitted_at = now; }
      if (action === 'verify')  { updateData.verified_by = auth.userId; updateData.verified_at = now; }
      if (action === 'approve') { updateData.approved_by = auth.userId; updateData.approved_at = now; }
      if (action === 'issue')   { updateData.issued_by = auth.userId; updateData.issued_at = now; updateData.issue_date = now.split('T')[0]; }
    }

    // ─── 8. EXECUTE ───
    const { error: updateErr } = await supabase.from(config.table).update(updateData).eq('id', recordId);
    if (updateErr) {
      return NextResponse.json({ error: 'Update failed: ' + updateErr.message }, { status: 500 });
    }

    // ─── 9. AUDIT LOG ───
    try {
      await supabase.from('audit.audit_log').insert({
        user_id: auth.userId,
        action: `WORKFLOW_${action.toUpperCase()}`,
        module: module.toUpperCase(),
        record_id: recordId,
        details: JSON.stringify({ from_status: currentStatus, to_status: updateData.status, amount: record[config.amountField], reason: reason || null }),
      });
    } catch {}

    return NextResponse.json({ success: true, status: updateData.status, message: `${module.replace('_', ' ')} ${action.toUpperCase()} successfully` });

  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'Internal server error' }, { status: 500 });
  }
}