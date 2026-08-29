import { NextRequest, NextResponse } from 'next/server';
import { getAuthUser, getAuthSupabase, checkApprovalLimitAsync } from '@/lib/api-auth';
import { workflowActionSchema, validateBody } from '@/lib/validations';
 
const MODULES: Record<string, {
  table: string; permPrefix: string; amountField: string; creatorField: string;
  periodIdField?: string; periodDateField?: string;
  transitions: Record<string, { from: string[]; perm: string }>;
}> = {
  expense: {
    table: 'expenses', permPrefix: 'EXPENSE', amountField: 'amount', creatorField: 'created_by',
    periodIdField: 'period_id', periodDateField: 'expense_date',
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
    periodIdField: 'period_id', periodDateField: 'income_date',
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
    periodIdField: 'period_id', periodDateField: 'issue_date',
    transitions: {
      submit:  { from: ['DRAFT'], perm: 'INVOICE_UPDATE' },
      approve: { from: ['SUBMITTED'], perm: 'APPROVE_INVOICE' },
      issue:   { from: ['APPROVED'], perm: 'INVOICE_UPDATE' },
      reject:  { from: ['SUBMITTED'], perm: 'INVOICE_UPDATE' },
      reopen:  { from: ['REJECTED'], perm: 'INVOICE_UPDATE' },
    },
  },
  vendor_bill: {
    table: 'vendor_bills', permPrefix: 'VENDOR_BILL', amountField: 'total_amount', creatorField: 'created_by',
    periodDateField: 'bill_date',
    transitions: {
      submit:  { from: ['DRAFT'], perm: 'VENDOR_BILL_UPDATE' },
      verify:  { from: ['SUBMITTED'], perm: 'APPROVE_VENDOR_BILL' },
      approve: { from: ['SUBMITTED', 'VERIFIED'], perm: 'APPROVE_VENDOR_BILL' },
      reject:  { from: ['SUBMITTED', 'VERIFIED'], perm: 'VENDOR_BILL_UPDATE' },
      reverse: { from: ['POSTED'], perm: 'VENDOR_BILL_UPDATE' },
      cancel:  { from: ['DRAFT', 'SUBMITTED', 'VERIFIED', 'APPROVED'], perm: 'VENDOR_BILL_UPDATE' },
    },
  },
  journal_entry: {
    table: 'journal_entries', permPrefix: 'JOURNAL', amountField: 'total_debit', creatorField: 'created_by',
    periodIdField: 'period_id', periodDateField: 'transaction_date',
    transitions: {
      submit:  { from: ['DRAFT'], perm: 'JOURNAL_UPDATE' },
      verify:  { from: ['SUBMITTED'], perm: 'APPROVE_JOURNAL' },
      approve: { from: ['VERIFIED', 'SUBMITTED'], perm: 'APPROVE_JOURNAL' },
      reject:  { from: ['SUBMITTED'], perm: 'JOURNAL_UPDATE' },
      reverse: { from: ['POSTED'], perm: 'JOURNAL_UPDATE' },
      reopen:  { from: ['REJECTED'], perm: 'JOURNAL_UPDATE' },
    },
  },
  budget: {
    table: 'budgets', permPrefix: 'BUDGET', amountField: 'total_amount', creatorField: 'submitted_by',
    transitions: {
      submit:  { from: ['DRAFT'], perm: 'BUDGET_UPDATE' },
      approve: { from: ['SUBMITTED'], perm: 'BUDGET_APPROVE' },
      reject:  { from: ['SUBMITTED'], perm: 'BUDGET_UPDATE' },
      reopen:  { from: ['REJECTED'], perm: 'BUDGET_UPDATE' },
    },
  },
};

async function assertPeriodOpenForTransition(
  supabase: any,
  config: (typeof MODULES)[string],
  record: Record<string, any>,
  orgId: string | null,
  action: string
): Promise<{ error: string } | null> {
  if (action !== 'approve' && action !== 'reverse') return null;
  if (!config.periodDateField && !config.periodIdField) return null;
  if (!orgId) return { error: 'Organization ID not found' };

  let period: { id: string; status: string } | null = null;

  if (config.periodIdField && record[config.periodIdField]) {
    const { data } = await supabase
      .schema('finance').from('accounting_periods')
      .select('id, status')
      .eq('id', record[config.periodIdField])
      .eq('organization_id', orgId)
      .maybeSingle();
    period = data ?? null;
  } else if (config.periodDateField && record[config.periodDateField]) {
    const { data } = await supabase
      .schema('finance').from('accounting_periods')
      .select('id, status')
      .eq('organization_id', orgId)
      .lte('start_date', record[config.periodDateField])
      .gte('end_date', record[config.periodDateField])
      .maybeSingle();
    period = data ?? null;
  }

  if (!period) {
    return { error: 'No accounting period found for this transaction date. Cannot approve/reverse.' };
  }
  if (period.status !== 'OPEN') {
    return {
      error: `Accounting period is ${period.status}. Closed periods cannot receive new or changed postings.`,
    };
  }
  return null;
}
 
export async function POST(req: NextRequest) {
  const { supabase } = await getAuthSupabase(req);
  const auth = await getAuthUser();
  if (auth instanceof NextResponse) return auth;
 
  try {
    // P0 FIX: Zod input validation
    const rawBody = await req.json();
    const validation = validateBody(workflowActionSchema, rawBody);
    if (!validation.success) {
      return NextResponse.json({ error: validation.error }, { status: 400 });
    }
    const { module, recordId, action, reason } = validation.data;
 
    const config = MODULES[module];
    if (!config) return NextResponse.json({ error: `Unknown module: ${module}` }, { status: 400 });
    const transition = config.transitions[action];
    if (!transition) return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
 
    // SECURITY FIX (BUG-002, CRITICAL): only CEO bypasses the permission
    // check. Technical Admin ("Admin") previously bypassed it too, which
    // contradicts Spec Appendix A (Technical Admin = "None" for finance
    // data) and let a technical administrator submit/verify/approve/post
    // financial transactions with no configured permission.
    if (auth.role !== 'CEO') {
      const { data: perms } = await supabase.rpc('get_my_permissions');
      let hasPerm = false;
      if (perms) {
        if (!Array.isArray(perms) && typeof perms === 'object' && perms[transition.perm] === true) hasPerm = true;
        if (Array.isArray(perms) && perms.some((p: any) => (p.permission_code || p.code) === transition.perm)) hasPerm = true;
      }
      if (!hasPerm) return NextResponse.json({ error: `Permission denied: ${transition.perm} required` }, { status: 403 });
    }
 
    // H1 FIX: Add organization_id filter to record fetch
    const recordQuery = ['journal_entry', 'vendor_bill'].includes(module)
      ? supabase.schema('finance').from(config.table)
      : supabase.from(config.table);
    const { data: record, error: fetchErr } = await recordQuery.select('*').eq('id', recordId).eq('organization_id', auth.orgId).single();
    if (fetchErr || !record) return NextResponse.json({ error: 'Record not found' }, { status: 404 });
 
    const currentStatus = (record.status || '').toUpperCase();
    if (!transition.from.includes(currentStatus))
      return NextResponse.json({ error: `Invalid: ${module} is ${currentStatus}, cannot ${action}` }, { status: 400 });
 
    // Maker-checker
    if (action === 'approve' || action === 'verify') {
      const creatorId = record[config.creatorField] || record.user_id;
      if (creatorId === auth.userId)
        return NextResponse.json({ error: `Maker-checker violation: You cannot ${action} your own ${module.replace('_', ' ')}.` }, { status: 403 });
    }
 
    if (action === 'approve') {
      const amount = Number(record[config.amountField]) || 0;
      const limitCheck = await checkApprovalLimitAsync(
        supabase, auth.orgId, auth.userId, auth.role, config.permPrefix, amount
      );
      if (!limitCheck.allowed) return NextResponse.json({ error: limitCheck.reason }, { status: 403 });
    }

    // BUG-008 FIX: period-lock check for approve/reverse (see
    // assertPeriodOpenForTransition doc comment above).
    const periodCheck = await assertPeriodOpenForTransition(supabase, config, record, auth.orgId, action);
    if (periodCheck) return NextResponse.json({ error: periodCheck.error }, { status: 400 });

    // BUG-004 FIX (Critical): When reversing a POSTED record, the linked
    // journal entry MUST be reversed via finance.reverse_journal_entry()
    // (swapped DR/CR) — otherwise the GL continues to reflect the original
    // posting, breaking double-entry integrity. The audit's BUG-004 finding
    // was that this route previously changed the record's status to
    // 'REVERSED' with no journal entry reversal.
    //
    // This block runs BEFORE the status update below, because if the
    // reversal journal entry fails to create, we must NOT change the
    // source record's status (otherwise the source would say REVERSED
    // while the GL still shows the original posting).
    let reversalJournalId: string | null = null;
    if (action === 'reverse' && currentStatus === 'POSTED') {
      const sourceJournalId = record.journal_entry_id;
      if (!sourceJournalId) {
        // POSTED record has no linked journal entry — data integrity issue,
        // but not safe to silently proceed. Fail loudly.
        return NextResponse.json({
          error: `Cannot reverse: ${module} is POSTED but has no linked journal entry. Manual reconciliation required.`,
        }, { status: 500 });
      }

      const reversalDate = new Date().toISOString().split('T')[0];
      const reversalReason = reason || `Reversal of ${module} ${recordId} by ${auth.userId}`;
      const { data: revId, error: revErr } = await supabase
        .schema('finance')
        .rpc('reverse_journal_entry', {
          p_journal_id: sourceJournalId,
          p_reversal_date: reversalDate,
          p_reason: reversalReason,
        });

      if (revErr || !revId) {
        return NextResponse.json({
          error: `Reversal journal entry creation failed: ${revErr?.message || 'Unknown error'}. The record's status was NOT changed.`,
        }, { status: 500 });
      }
      reversalJournalId = revId;
    }
 
    const updateData: Record<string, any> = {};
    const now = new Date().toISOString();
    if (action === 'reopen') { updateData.status = 'DRAFT'; updateData.rejection_reason = null; }
    else if (action === 'reject') { updateData.status = 'REJECTED'; updateData.rejection_reason = reason || 'No reason provided'; }
    else if (action === 'reverse') {
      updateData.status = 'REVERSED';
      updateData.reversal_reason = reason;
      updateData.reversed_by = auth.userId;
      updateData.reversed_at = now;
      // BUG-004 FIX: link the source record to its reversal journal entry.
      // The original posted journal is now REVERSED (handled by the RPC
      // above); setting journal_entry_id to the new reversal journal's ID
      // keeps the source-record→journal linkage intact for audit drill-down.
      if (reversalJournalId) {
        updateData.journal_entry_id = reversalJournalId;
      }
    }
    else if (action === 'cancel') { updateData.status = 'CANCELLED'; updateData.rejection_reason = reason; }
    else {
      const statusMap: Record<string, string> = { submit: 'SUBMITTED', verify: 'VERIFIED', approve: 'APPROVED', issue: 'ISSUED' };
      updateData.status = statusMap[action] || action.toUpperCase();
      if (action === 'submit')  { updateData.submitted_by = auth.userId; updateData.submitted_at = now; }
      if (action === 'verify')  { updateData.verified_by = auth.userId; updateData.verified_at = now; }
      if (action === 'approve') { updateData.approved_by = auth.userId; updateData.approved_at = now; }
      if (action === 'issue')   { updateData.issued_by = auth.userId; updateData.issued_at = now; }
    }
 
    // FIXED: Add WHERE clause on current status to prevent TOCTOU race condition
        const updateQuery = ['journal_entry', 'vendor_bill'].includes(module)
      ? supabase.schema('finance').from(config.table)
      : supabase.from(config.table);
    const { count, error: updateErr } = await updateQuery
      .update(updateData)
      .eq('id', recordId)
      .eq('status', currentStatus)
      .eq('organization_id', auth.orgId); // Only update if status hasn't changed
 
    if (updateErr) return NextResponse.json({ error: 'Update failed: ' + updateErr.message }, { status: 500 });
    if (count === 0) {
      return NextResponse.json({ error: 'Concurrent modification detected. Record was modified by another user. Please refresh and try again.' }, { status: 409 });
    }
 
    // FIX: Use RPC for audit log (correct columns, server-side IP, role snapshot, hash)
    try {
      await supabase.schema('audit').rpc('log_action', {
        p_user_id: auth.userId,
        p_action: `WORKFLOW_${action.toUpperCase()}`,
        p_entity_type: module.toUpperCase(),
        p_entity_id: recordId,
        p_description: `${module} ${action}: ${currentStatus} → ${updateData.status}${record[config.amountField] ? ` (Amount: ${record[config.amountField]})` : ''}`,
        p_previous_status: currentStatus,
        p_new_status: updateData.status,
        p_reason: reason || null,
        p_source_module: module.toLowerCase(),
        p_severity: action === 'approve' ? 'medium' : 'info',
        p_new_values: { amount: record[config.amountField], to_status: updateData.status },
      });
    } catch (auditErr: any) {
      console.error('Audit log failed for workflow action:', auditErr);
    }
 
    return NextResponse.json({ success: true, status: updateData.status, message: `${module.replace('_', ' ')} ${action.toUpperCase()} successfully` });
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'Internal server error' }, { status: 500 });
  }
}