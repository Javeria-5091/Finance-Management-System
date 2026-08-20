import { NextRequest, NextResponse } from 'next/server';
import { getAuthSupabase } from '@/lib/api-auth';
import { requirePermission } from '@/lib/api-auth';
import { enforceMFA } from '@/lib/mfa-middleware';
import { postJournalSchema, validateBody } from '@/lib/validations';

function getData<T = any>(res: any): T | null {
  return res?.data ?? null;
}

// ─── POST: Post approved manual journal entry to General Ledger ───
// Spec 4.2 FIX: organization_id filter added to journal fetch
// Posts a DRAFT/SUBMITTED/VERIFIED journal entry that has been through workflow approval
//
// BUG-001 FIX:
//   The finance.post_journal_entry RPC signature is:
//     (p_description, p_transaction_date, p_period_id, p_lines, p_currency, p_exchange_rate, p_source_type, p_source_id, p_project_id, p_department_id)
//   This RPC is designed to CREATE + POST a new journal entry atomically.
//
//   However, this route's purpose is to POST AN EXISTING journal entry that was
//   already created through the approval workflow (DRAFT → SUBMITTED → VERIFIED → APPROVED).
//   The existing journal already has a reference, approvals, and source record links.
//
//   FIX STRATEGY: Read the existing journal's lines, pass them to the RPC to create
//   a new POSTED journal (which updates GL atomically), then delete the old unposted
//   journal and update any source records that referenced the old ID.
//
//   NOTE: A cleaner long-term fix would be to create a separate DB function:
//     finance.post_existing_journal(p_journal_id UUID, p_posted_by UUID)
//   that only handles the GL posting step for an already-created journal.
//
//   BUG-006 VERIFICATION: re-checked this pass — the RPC call (step 8) runs and
//   is checked for success BEFORE the old draft journal/lines are deleted (further
//   down). This is already the safe create-then-delete order, not delete-then-create.
//   No change made here.

export async function POST(req: NextRequest) {
  const auth = await requirePermission('APPROVE_JOURNAL');
  if (auth instanceof NextResponse) return auth;
  // H3 FIX: Enforce MFA for financial posting
  const mfaCheck = await enforceMFA(auth);
  if (mfaCheck) return mfaCheck;
  const { supabase } = await getAuthSupabase(req);

  const orgId = auth.orgId;
  if (!orgId) {
    return NextResponse.json({ error: 'Organization ID not found' }, { status: 400 });
  }

  try {
    const rawBody = await req.json();
    const validation = validateBody(postJournalSchema, rawBody);
    if (!validation.success) return NextResponse.json({ error: validation.error }, { status: 400 });
    const journal_entry_id = validation.data.journalId;

    // ── 1. Fetch the journal entry (WITH org_id filter — Spec 4.2 FIX) ──
    const journal = getData(
      await supabase
        .from('finance.journal_entries')
        .select('*')
        .eq('id', journal_entry_id)
        .eq('organization_id', orgId)   // ← SECURITY FIX: was missing
        .single()
    );

    if (!journal) {
      return NextResponse.json({ error: 'Journal entry not found or access denied' }, { status: 404 });
    }

    // ── 2. Validate status — only APPROVED journals can be posted ──
    if (journal.status !== 'APPROVED') {
      return NextResponse.json({
        error: `Only APPROVED journal entries can be posted. Current status: ${journal.status}`,
      }, { status: 400 });
    }

    // ── 3. Idempotency check — already posted? ──
    if (journal.posted_at) {
      return NextResponse.json({
        error: 'Already posted to GL',
        journalId: journal.id,
        reference: journal.reference,
        posted_at: journal.posted_at,
      }, { status: 400 });
    }

    // ── 4. Fetch journal lines (WITH org_id filter) ──
    const journalLines = getData(
      await supabase
        .from('finance.journal_lines')
        .select('*')
        .eq('journal_entry_id', journal_entry_id)
        .eq('organization_id', orgId)   // ← SECURITY FIX
        .order('line_number', { ascending: true })
    );

    if (!journalLines || journalLines.length === 0) {
      return NextResponse.json({ error: 'No journal lines found' }, { status: 400 });
    }

    // ── 5. Verify balance ──
    const totalDebit = journalLines.reduce((sum: number, l: any) => sum + (Number(l.debit_amount) || 0), 0);
    const totalCredit = journalLines.reduce((sum: number, l: any) => sum + (Number(l.credit_amount) || 0), 0);

    if (Math.abs(totalDebit - totalCredit) > 0.01) {
      return NextResponse.json({
        error: `Journal entry is unbalanced. Debit: ${totalDebit}, Credit: ${totalCredit}`,
        total_debit: totalDebit,
        total_credit: totalCredit,
      }, { status: 400 });
    }

    // ── 6. Verify open period ──
    const period = getData(
      await supabase
        .from('finance.accounting_periods')
        .select('id, status, start_date, end_date')
        .eq('id', journal.fiscal_period_id || journal.accounting_period_id)
        .eq('organization_id', orgId)   // ← SECURITY FIX
        .maybeSingle()
    );

    if (!period) {
      return NextResponse.json({ error: 'Accounting period not found' }, { status: 404 });
    }

    if (period.status !== 'OPEN') {
      return NextResponse.json({
        error: `Period is not OPEN. Current status: ${period.status}. Cannot post to closed periods.`,
      }, { status: 400 });
    }

    // ── 7. Verify all accounts are active and allow posting ──
    const accountIds = [...new Set(journalLines.map((l: any) => l.account_id))];
    const accounts = getData(
      await supabase
        .from('finance.chart_of_accounts')
        .select('id, code, name, is_active, posting_allowed')
        .in('id', accountIds)
        .eq('organization_id', orgId)   // ← SECURITY FIX
    );

    if (!accounts || accounts.length !== accountIds.length) {
      const foundIds = new Set((accounts || []).map((a: any) => a.id));
      const missingIds = accountIds.filter(id => !foundIds.has(id));
      return NextResponse.json({
        error: `Some accounts not found or belong to a different organization`,
        missing_account_ids: missingIds,
      }, { status: 400 });
    }

    const inactiveAccounts = accounts.filter((a: any) => !a.is_active || !a.posting_allowed);
    if (inactiveAccounts.length > 0) {
      return NextResponse.json({
        error: `Some accounts are inactive or do not allow posting`,
        accounts: inactiveAccounts.map((a: any) => ({ id: a.id, code: a.code, name: a.name, is_active: a.is_active, posting_allowed: a.posting_allowed })),
      }, { status: 400 });
    }

    // ── 8. BUG-001 FIX: Post via GL engine with CORRECT RPC signature ──
    //    Since the RPC creates a NEW journal entry, we:
    //    a) Build lines from existing journal (strip journal_entry_id — RPC sets it)
    //    b) Call RPC to create+post a new journal (atomically updates GL)
    //    c) Delete the old unposted journal + lines
    //    d) Update source records to point to the new journal ID
    const rpcLines = journalLines.map((l: any) => ({
      account_id: l.account_id,
      debit_amount: l.debit_amount,
      credit_amount: l.credit_amount,
      description: l.description,
    }));

    const { data: newJournalId, error: postErr } = await supabase.schema('finance').rpc('post_journal_entry', {
      p_description: journal.description || journal.reference,
      p_transaction_date: journal.journal_date || journal.entry_date || new Date().toISOString().split('T')[0],
      p_period_id: period.id,
      p_lines: JSON.stringify(rpcLines),
      p_currency: journal.currency || 'PKR',
      p_exchange_rate: journal.exchange_rate || 1,
      p_source_type: journal.source_type || 'MANUAL_JOURNAL',
      p_source_id: journal.source_id || journal_entry_id,
      p_project_id: journal.project_id || null,
      p_department_id: journal.department_id || null,
    });

    if (postErr || !newJournalId) {
      return NextResponse.json({ error: 'GL posting failed: ' + (postErr?.message || 'Unknown error') }, { status: 500 });
    }

    // Fetch the new posted journal for reference
    const newJournal = getData(
      await supabase
        .from('finance.journal_entries')
        .select('id, reference, total_debit, total_credit')
        .eq('id', newJournalId)
        .single()
    );
    // C6 FIX: Null guard
    if (!newJournal) {
      return NextResponse.json({ error: 'Journal created but fetch failed. Check journal ID: ' + newJournalId }, { status: 500 });
    }

    // Copy approval metadata from old journal to new
    if (journal.approved_by || journal.approved_at) {
      await supabase
        .from('finance.journal_entries')
        .update({
          approved_by: journal.approved_by,
          approved_at: journal.approved_at,
        })
        .eq('id', newJournalId);
    }

    // H10 FIX: Proper source table name mapping
    const SOURCE_TABLE_MAP: Record<string, string> = {
      EXPENSE: 'expenses',
      INCOME: 'incomes',
      INVOICE: 'invoices',
      VENDOR_BILL: 'vendor_bills',
      CREDIT_NOTE: 'credit_notes',
      PAYMENT_RECEIPT: 'payment_receipts',
      PAYMENT_REVERSAL: 'payment_receipts',
      PROFIT_DISTRIBUTION: 'finance.profit_distributions',
      YEAR_END_CLOSE: 'finance.fiscal_years',
      MANUAL_JOURNAL: 'finance.journal_entries',
    };
    const sourceTable = SOURCE_TABLE_MAP[journal.source_type] || 'finance.journal_entries';
    await supabase
      .from(sourceTable)
      .update({ journal_entry_id: newJournalId })
      .eq('id', journal.source_id);

    // Delete old unposted journal lines + header
    await supabase.from('finance.journal_lines').delete().eq('journal_entry_id', journal_entry_id);
    await supabase.from('finance.journal_entries').delete().eq('id', journal_entry_id);

    // ── 9. Audit log ──
    let auditLogFailed = false;
    try {
      await supabase.schema('audit').rpc('log_action', {
        p_user_id: auth.userId,
        p_action: 'JOURNAL_POSTED',
        p_entity_type: 'journal_entry',
        p_entity_id: newJournalId,
        p_description: `Journal posted to GL: ${newJournal.reference || journal.reference} (DR: ${totalDebit.toFixed(2)}, CR: ${totalCredit.toFixed(2)}, Lines: ${journalLines.length}). Previous draft ID: ${journal_entry_id}`,
        p_previous_status: 'APPROVED',
        p_new_status: 'POSTED',
        p_source_module: 'journal',
        p_severity: 'high',
        p_new_values: {
          reference: newJournal.reference || journal.reference,
          total_debit: totalDebit,
          total_credit: totalCredit,
          line_count: journalLines.length,
          journal_date: journal.journal_date || journal.entry_date,
          previous_draft_id: journal_entry_id,
        },
        p_related_journal_id: newJournalId,
      });
    } catch (auditErr: any) {
      // BUG-023 FIX: surface a failed audit write instead of only logging
      // to console (Spec 8.1). The already-posted journal is not rolled
      // back for the same reason as the other posting routes: posted
      // entries are immutable and a logging failure is not itself grounds
      // to reverse a correctly balanced posting.
      console.error('Audit log failed for journal post:', auditErr);
      auditLogFailed = true;
    }

    return NextResponse.json({
      success: true,
      journalId: newJournalId,
      reference: newJournal.reference || journal.reference,
      total_debit: totalDebit,
      total_credit: totalCredit,
      line_count: journalLines.length,
      posted_at: new Date().toISOString(),
      posted_by: auth.userId,
      message: `Journal entry ${newJournal?.reference || journal.reference} posted to General Ledger`,
      audit_log_warning: auditLogFailed ? 'Posting succeeded but the audit log entry failed to write. Please notify an administrator.' : undefined,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}