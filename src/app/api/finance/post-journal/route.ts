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

    // ── 8. BUG-009 FIX: Atomic journal replacement via single DB function ──
    // The previous implementation called finance.post_journal_entry to create
    // a new POSTED journal, then SEPARATELY (a) updated the source record's
    // journal_entry_id pointer, (b) deleted the old journal_lines, and (c)
    // deleted the old journal_entries row — three sequential client-side
    // operations outside any transaction. If (b) or (c) failed, the system
    // ended up with TWO journals for the same source: one POSTED and one
    // APPROVED that could be re-posted by retrying this route.
    //
    // FIX: a new finance.post_existing_journal_entry(p_journal_id, p_posted_by)
    // function (added in supabase/migrations/20260822000001_bug_fix_api_services.sql)
    // does the entire operation inside one Postgres transaction:
    //   1. Reads + locks the old APPROVED journal
    //   2. Verifies org-scoping via core.same_org()
    //   3. Builds lines JSON from the old journal_lines
    //   4. Calls finance.post_journal_entry to create the new POSTED journal
    //   5. Copies audit-trail metadata (submitted/verified/approved_by/at)
    //   6. Updates source record's journal_entry_id pointer to the new journal
    //   7. Deletes the old APPROVED draft (CASCADE removes the old lines)
    // Either all of it commits or none of it does.

    // Sanity-check the journal is still balanced before calling the atomic
    // function (the function itself also enforces this via the trigger on
    // journal_lines, but surfacing a clear error here is friendlier).
    if (Math.abs(totalDebit - totalCredit) > 0.01) {
      return NextResponse.json({
        error: `Journal entry is unbalanced. Debit: ${totalDebit}, Credit: ${totalCredit}`,
        total_debit: totalDebit,
        total_credit: totalCredit,
      }, { status: 400 });
    }

    const { data: newJournalId, error: postErr } = await supabase
      .schema('finance')
      .rpc('post_existing_journal_entry', {
        p_journal_id: journal_entry_id,
        p_posted_by: auth.userId,
      });

    if (postErr || !newJournalId) {
      return NextResponse.json({ error: 'GL posting failed: ' + (postErr?.message || 'Unknown error') }, { status: 500 });
    }

    // Copy approval metadata — handled inside the DB function, but kept here
    // as a no-op for backward source compatibility.

    // Fetch the new posted journal for reference number (used in audit log
    // + response). The actual posting + metadata copy + source-record pointer
    // update were already done atomically by finance.post_existing_journal_entry.
    const newJournal = getData(
      await supabase
        .from('finance.journal_entries')
        .select('id, reference, total_debit, total_credit')
        .eq('id', newJournalId)
        .single()
    );
    if (!newJournal) {
      // The journal exists (the RPC returned its ID) — we just failed to fetch
      // it back for the response. Don't fail the request; surface the warning.
      console.error('Post-journal: failed to fetch new journal metadata for ID:', newJournalId);
    }

    // ── 9. Audit log ──
    let auditLogFailed = false;
    try {
      await supabase.schema('audit').rpc('log_action', {
        p_user_id: auth.userId,
        p_action: 'JOURNAL_POSTED',
        p_entity_type: 'journal_entry',
        p_entity_id: newJournalId,
        p_description: `Journal posted to GL: ${newJournal?.reference || journal.reference} (DR: ${totalDebit.toFixed(2)}, CR: ${totalCredit.toFixed(2)}, Lines: ${journalLines.length}). Previous draft ID: ${journal_entry_id}`,
        p_previous_status: 'APPROVED',
        p_new_status: 'POSTED',
        p_source_module: 'journal',
        p_severity: 'high',
        p_new_values: {
          reference: newJournal?.reference || journal.reference,
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
      reference: newJournal?.reference || journal.reference,
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