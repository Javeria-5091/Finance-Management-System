import { NextRequest, NextResponse } from 'next/server';
import { getAuthUser, getAuthSupabase, checkApprovalLimitAsync } from '@/lib/api-auth';
import { enforceMFA } from '@/lib/mfa-middleware';
import { workflowActionSchema, validateBody } from '@/lib/validations';
import type { ApprovalTransactionType } from '@/lib/approval-limits';
 
const MODULES: Record<string, {
  table: string; permPrefix: string; transactionType: ApprovalTransactionType; amountField: string; creatorField: string;
  periodIdField?: string; periodDateField?: string;
  transitions: Record<string, { from: string[]; perm: string }>;
}> = {
  expense: {
    table: 'expenses', permPrefix: 'EXPENSE', transactionType: 'EXPENSE', amountField: 'amount', creatorField: 'user_id',
    periodIdField: 'period_id', periodDateField: 'expense_date',
    transitions: {
      submit:  { from: ['DRAFT'], perm: 'EXPENSE_UPDATE' },
      verify:  { from: ['SUBMITTED'], perm: 'EXPENSE_APPROVE' },
      approve: { from: ['SUBMITTED', 'VERIFIED'], perm: 'EXPENSE_APPROVE' },
      reject:  { from: ['SUBMITTED', 'VERIFIED'], perm: 'EXPENSE_UPDATE' },
      reverse: { from: ['POSTED'], perm: 'EXPENSE_UPDATE' },
      reopen:  { from: ['REJECTED'], perm: 'EXPENSE_UPDATE' },
    },
  },
  income: {
    table: 'incomes', permPrefix: 'INCOME', transactionType: 'INCOME', amountField: 'amount', creatorField: 'created_by',
    periodIdField: 'period_id', periodDateField: 'income_date',
    transitions: {
      submit:  { from: ['DRAFT'], perm: 'INCOME_UPDATE' },
      verify:  { from: ['SUBMITTED'], perm: 'INCOME_APPROVE' },
      approve: { from: ['SUBMITTED', 'VERIFIED'], perm: 'INCOME_APPROVE' },
      reject:  { from: ['SUBMITTED', 'VERIFIED'], perm: 'INCOME_UPDATE' },
      reverse: { from: ['POSTED'], perm: 'INCOME_UPDATE' },
      reopen:  { from: ['REJECTED'], perm: 'INCOME_UPDATE' },
    },
  },
  invoice: {
    table: 'invoices', permPrefix: 'INVOICE', transactionType: 'INVOICE', amountField: 'total_amount', creatorField: 'created_by',
    periodIdField: 'period_id', periodDateField: 'issue_date',
    transitions: {
      submit:  { from: ['DRAFT'], perm: 'INVOICE_UPDATE' },
      approve: { from: ['SUBMITTED'], perm: 'INVOICE_APPROVE' },
      issue:   { from: ['APPROVED'], perm: 'INVOICE_UPDATE' },
      reject:  { from: ['SUBMITTED'], perm: 'INVOICE_UPDATE' },
      reopen:  { from: ['REJECTED'], perm: 'INVOICE_UPDATE' },
      // FND-AR-02 FIX: previously the invoices dashboard page voided an
      // invoice with a direct, unaudited supabase.from('invoices').update()
      // call from the browser (no permission re-check server-side, no
      // maker-checker, no audit log). Routing VOID through this table gives
      // it the same permission check, org scoping, TOCTOU-safe conditional
      // update, and audit.log_action() entry as every other transition.
      void:    { from: ['DRAFT', 'SUBMITTED', 'APPROVED'], perm: 'INVOICE_UPDATE' },
    },
  },
  vendor_bill: {
    table: 'vendor_bills', permPrefix: 'VENDOR_BILL', transactionType: 'VENDOR_BILL', amountField: 'total_amount', creatorField: 'created_by',
    periodDateField: 'bill_date',
    transitions: {
      submit:  { from: ['DRAFT'], perm: 'VENDOR_BILL_UPDATE' },
      // FND-AP-03 FIX: 'APPROVE_VENDOR_BILL' (singular) is not a seeded
      // permission code at all — the catalogue only has 'VENDOR_BILL_APPROVE'
      // (seed_data.sql:1038) and the newer 'APPROVE_VENDOR_BILLS' (plural,
      // seed_data.sql:1885). Every non-CEO caller (CEO bypasses permission
      // checks entirely — see requirePermission) 403'd on verify/approve
      // because the code they were actually granted never matched what was
      // checked. Use the dedicated, already role-granted vendor_bill-prefixed
      // codes (VENDOR_BILL_VERIFY / VENDOR_BILL_APPROVE — see
      // seed_data.sql:1105-1120 role_permissions for ACCOUNTANT/FINANCE_HEAD)
      // instead of the unseeded ad-hoc name.
      verify:  { from: ['SUBMITTED'], perm: 'VENDOR_BILL_VERIFY' },
      approve: { from: ['SUBMITTED', 'VERIFIED'], perm: 'VENDOR_BILL_APPROVE' },
      reject:  { from: ['SUBMITTED', 'VERIFIED'], perm: 'VENDOR_BILL_UPDATE' },
      reverse: { from: ['POSTED'], perm: 'VENDOR_BILL_UPDATE' },
      cancel:  { from: ['DRAFT', 'SUBMITTED', 'VERIFIED', 'APPROVED'], perm: 'VENDOR_BILL_UPDATE' },
      // NOTE: 'post' is intentionally NOT a transition here. Posting a
      // vendor bill isn't a plain status flip (this route's generic handler
      // below just sets `status` and returns) — it requires resolving GL
      // accounts, coding split lines, handling WHT, and running the budget
      // check inside finance.post_vendor_bill_atomic, all of which already
      // lives in /api/finance/post-vendor-bill. The UI now calls that route
      // directly for the Post action instead of routing 'post' through here.
    },
  },
  journal_entry: {
    table: 'journal_entries', permPrefix: 'JOURNAL', transactionType: 'JOURNAL_ENTRY', amountField: 'total_debit', creatorField: 'created_by',
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
    table: 'budgets', permPrefix: 'BUDGET', transactionType: 'BUDGET_REVISION', amountField: 'total_amount', creatorField: 'submitted_by',
    transitions: {
      submit:  { from: ['DRAFT'], perm: 'BUDGET_UPDATE' },
      approve: { from: ['SUBMITTED'], perm: 'BUDGET_APPROVE' },
      reject:  { from: ['SUBMITTED'], perm: 'BUDGET_UPDATE' },
      reopen:  { from: ['REJECTED'], perm: 'BUDGET_UPDATE' },
    },
  },
  // BUG-021 FIX: credit_note had no entry here at all, so a credit note
  // could never leave DRAFT — and credit-notes/[id]/route.ts's POST
  // (post-to-GL) action requires status APPROVED. finance.credit_notes'
  // status CHECK only has DRAFT/APPROVED/POSTED/REVERSED/REJECTED (no
  // SUBMITTED/VERIFIED step), so the lifecycle here is simpler than the
  // other modules: DRAFT -> APPROVED (or REJECTED) directly.
  credit_note: {
    table: 'credit_notes', permPrefix: 'INVOICE_CREDIT_NOTE', transactionType: 'INVOICE_CREDIT_NOTE', amountField: 'amount', creatorField: 'created_by',
    periodDateField: 'credit_note_date',
    transitions: {
      approve: { from: ['DRAFT'], perm: 'APPROVE_INVOICE' },
      reject:  { from: ['DRAFT'], perm: 'INVOICE_UPDATE' },
      reverse: { from: ['POSTED'], perm: 'INVOICE_UPDATE' },
      reopen:  { from: ['REJECTED'], perm: 'INVOICE_UPDATE' },
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
  // P1-01 FIX (Spec §7.4: "Mandatory multi-factor authentication for CEO,
  // finance roles, technical administrators, and any user with approval or
  // export rights"): this route drives every workflow transition — submit,
  // verify, approve, reject, reverse, reopen — across all financial and
  // admin-adjacent modules (expense/income/invoice/vendor_bill/journal_entry/
  // budget/credit_note). It previously never called enforceMFA at all, so an
  // AAL1-only session for a CEO/Finance Head/Accountant/etc. could approve or
  // reverse financial transactions without ever completing an MFA challenge.
  const mfaCheck = await enforceMFA(auth);
  if (mfaCheck) return mfaCheck;

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

    // Vendor-bill posting is a GL operation, not a status-only transition.
    // Keep the generic workflow for submit/verify/approve, but route Post to
    // the hardened posting endpoint so WHT, budget checks and atomic GL
    // posting are actually executed from the UI.
    if (module === 'vendor_bill' && action === 'post') {
      if (auth.role !== 'CEO') {
        const { data: perms } = await supabase.rpc('get_my_permissions');
        const hasPerm = Array.isArray(perms)
          ? perms.some((p: any) => (p.permission_code || p.code) === 'VENDOR_BILL_POST' || (p.permission_code || p.code) === 'POST_VENDOR_BILLS')
          : !!(perms && typeof perms === 'object' && (perms.VENDOR_BILL_POST || perms.POST_VENDOR_BILLS));
        if (!hasPerm) return NextResponse.json({ error: 'Permission denied: VENDOR_BILL_POST required' }, { status: 403 });
      }
      const { data: bill } = await supabase.schema('finance').from('vendor_bills').select('id,status').eq('id', recordId).eq('organization_id', auth.orgId).maybeSingle();
      if (!bill) return NextResponse.json({ error: 'Vendor bill not found' }, { status: 404 });
      if (bill.status !== 'APPROVED') return NextResponse.json({ error: 'Only APPROVED vendor bills can be posted' }, { status: 409 });
      const res = await fetch(new URL('/api/finance/post-vendor-bill', req.url), {
        method: 'POST', headers: { 'Content-Type': 'application/json', cookie: req.headers.get('cookie') || '' },
        body: JSON.stringify({ vendorBillId: recordId }),
      });
      const data = await res.json().catch(() => ({}));
      return NextResponse.json(data, { status: res.status });
    }

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
    // BUG-021 FIX: finance.credit_notes lives in the finance schema too.
    const recordQuery = ['journal_entry', 'vendor_bill', 'credit_note'].includes(module)
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
        supabase, auth.orgId, auth.userId, auth.role, config.transactionType, amount
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
      const reversalDate = new Date().toISOString().split('T')[0];
      const reversalReason = reason || `Reversal of ${module} ${recordId} by ${auth.userId}`;
      const reversalRpc = module === 'expense'
        ? 'reverse_expense_atomic'
        : module === 'income'
          ? 'reverse_income_atomic'
          : module === 'vendor_bill'
            ? 'reverse_vendor_bill_atomic'
            : module === 'credit_note'
              ? 'reverse_credit_note_atomic'
              : null;

      // Journal entries already have their own canonical reversal RPC.
      if (module === 'journal_entry') {
        const { data: revId, error: revErr } = await supabase.schema('finance').rpc('reverse_journal_entry', {
          p_journal_id: recordId,
          p_reversal_date: reversalDate,
          p_reason: reversalReason,
        });
        if (revErr || !revId) {
          return NextResponse.json({ error: `Reversal failed: ${revErr?.message || 'Unknown error'}.` }, { status: 500 });
        }
        reversalJournalId = revId;
      } else {
        if (!reversalRpc) {
          return NextResponse.json({ error: `Reversal is not supported for ${module}` }, { status: 400 });
        }
        const rpcArgs = module === 'expense'
          ? { p_expense_id: recordId, p_reversal_date: reversalDate, p_reason: reversalReason }
          : module === 'income'
            ? { p_income_id: recordId, p_reversal_date: reversalDate, p_reason: reversalReason }
            : module === 'vendor_bill'
              ? { p_vendor_bill_id: recordId, p_reversal_date: reversalDate, p_reason: reversalReason }
              : { p_credit_note_id: recordId, p_reversal_date: reversalDate, p_reason: reversalReason };
        const { data: revId, error: revErr } = await supabase.schema('finance').rpc(reversalRpc, rpcArgs);
        if (revErr || !revId) {
          return NextResponse.json({ error: `Reversal failed: ${revErr?.message || 'Unknown error'}. The GL and source record were rolled back together.` }, { status: 500 });
        }
        reversalJournalId = revId;
      }
    }

    const updateData: Record<string, any> = {};
    const now = new Date().toISOString();
    if (action === 'reopen') { updateData.status = 'DRAFT'; updateData.rejection_reason = null; }
    else if (action === 'reject') { updateData.status = 'REJECTED'; updateData.rejection_reason = reason || 'No reason provided'; }
    else if (action === 'reverse') {
      // Expense/income reversal was already committed atomically by the RPC.
      updateData.status = 'REVERSED';
      if (reversalJournalId) updateData.journal_entry_id = reversalJournalId;
    }
    else if (action === 'cancel') { updateData.status = 'CANCELLED'; updateData.rejection_reason = reason; }
    else if (action === 'void') { updateData.status = 'VOID'; updateData.void_reason = reason || 'Voided'; updateData.voided_by = auth.userId; updateData.voided_at = now; }
    else {
      const statusMap: Record<string, string> = { submit: 'SUBMITTED', verify: 'VERIFIED', approve: 'APPROVED', issue: 'ISSUED' };
      updateData.status = statusMap[action] || action.toUpperCase();
      if (action === 'submit')  { updateData.submitted_by = auth.userId; updateData.submitted_at = now; }
      if (action === 'verify')  { updateData.verified_by = auth.userId; updateData.verified_at = now; }
      if (action === 'approve') { updateData.approved_by = auth.userId; updateData.approved_at = now; }
      if (action === 'issue')   { updateData.issued_by = auth.userId; updateData.issued_at = now; }
    }
 
    // FIXED: Add WHERE clause on current status to prevent TOCTOU race condition
        const updateQuery = ['journal_entry', 'vendor_bill', 'credit_note'].includes(module)
      ? supabase.schema('finance').from(config.table)
      : supabase.from(config.table);
    const isAtomicBusinessReversal = action === 'reverse' && ['expense', 'income', 'vendor_bill', 'journal_entry', 'credit_note'].includes(module);
    let count = 1;
    if (!isAtomicBusinessReversal) {
      const { count: updatedCount, error: updateErr } = await updateQuery
        .update(updateData)
        .eq('id', recordId)
        .eq('status', currentStatus)
        .eq('organization_id', auth.orgId); // Only update if status hasn't changed

      if (updateErr) return NextResponse.json({ error: 'Update failed: ' + updateErr.message }, { status: 500 });
      count = updatedCount ?? 0;
      if (count === 0) {
        return NextResponse.json({ error: 'Concurrent modification detected. Record was modified by another user. Please refresh and try again.' }, { status: 409 });
      }
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