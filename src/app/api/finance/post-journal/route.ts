import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { requirePermission } from '@/lib/api-auth';

function getData<T = any>(res: any): T | null {
  return res?.data ?? null;
}

// ─── POST: Post approved manual journal entry to General Ledger ───
// Spec 4.2 FIX: organization_id filter added to journal fetch
// Posts a DRAFT/SUBMITTED/VERIFIED journal entry that has been through workflow approval

export async function POST(req: NextRequest) {
  const auth = await requirePermission('APPROVE_JOURNAL');
  if (auth instanceof NextResponse) return auth;

  const orgId = auth.orgId;
  if (!orgId) {
    return NextResponse.json({ error: 'Organization ID not found' }, { status: 400 });
  }

  try {
    const { journal_entry_id } = await req.json();

    if (!journal_entry_id) {
      return NextResponse.json({ error: 'journal_entry_id is required' }, { status: 400 });
    }

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

    if (Math.abs(totalDebit - totalCredit) > 0.02) {
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

    // ── 8. Post via GL engine ──
    const { error: postErr } = await supabase.rpc('finance.post_journal_entry', {
      p_journal_id: journal.id,
      p_posted_by: auth.userId,
    });

    if (postErr) {
      return NextResponse.json({ error: 'GL posting failed: ' + postErr.message }, { status: 500 });
    }

    // ── 9. Update journal status to POSTED ──
    const { error: statusErr } = await supabase
      .from('finance.journal_entries')
      .update({
        status: 'POSTED',
        posted_at: new Date().toISOString(),
        posted_by: auth.userId,
      })
      .eq('id', journal_entry_id)
      .eq('organization_id', orgId);   // ← SECURITY FIX

    if (statusErr) {
      console.error('Journal status update failed:', statusErr.message);
    }

    // ── 10. Audit log ──
    try {
      supabase.schema('audit').rpc('log_action', {
        p_user_id: auth.userId,
        p_action: 'JOURNAL_POSTED',
        p_entity_type: 'journal_entry',
        p_entity_id: journal_entry_id,
        p_description: `Journal posted to GL: ${journal.reference} (DR: ${totalDebit.toFixed(2)}, CR: ${totalCredit.toFixed(2)}, Lines: ${journalLines.length})`,
        p_previous_status: 'APPROVED',
        p_new_status: 'POSTED',
        p_source_module: 'journal',
        p_severity: 'high',
        p_new_values: {
          reference: journal.reference,
          total_debit: totalDebit,
          total_credit: totalCredit,
          line_count: journalLines.length,
          journal_date: journal.journal_date,
        },
        p_related_journal_id: journal.id,
      });
    } catch (auditErr: any) {
      console.error('Audit log failed:', auditErr);
    }

    return NextResponse.json({
      success: true,
      journalId: journal.id,
      reference: journal.reference,
      total_debit: totalDebit,
      total_credit: totalCredit,
      line_count: journalLines.length,
      posted_at: new Date().toISOString(),
      posted_by: auth.userId,
      message: `Journal entry ${journal.reference} posted to General Ledger`,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}