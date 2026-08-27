import { NextRequest, NextResponse } from 'next/server';
import { validateExchangeRate } from '@/lib/validations';
import { getAuthSupabase } from '@/lib/api-auth';
import { requirePermission } from '@/lib/api-auth';
import { enforceMFA } from '@/lib/mfa-middleware';
import { creditNoteCreateSchema, creditNotePostSchema, validateBody } from '@/lib/validations';

function getData<T = any>(res: any): T | null {
  return res?.data ?? null;
}

// --- GET: Fetch single credit note by ID ---
export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const auth = await requirePermission('INVOICE_READ');
  if (auth instanceof NextResponse) return auth;
  const { supabase } = await getAuthSupabase(req);

  try {
    const { id } = params;

    const { data: creditNote, error } = await supabase
      .from('credit_notes')
      .select('*, invoice:invoices(id, invoice_number, client_id, total_amount)')
      .eq('id', id)
      .eq('organization_id', auth.orgId)
      .single();

    if (error || !creditNote) {
      return NextResponse.json({ error: 'Credit note not found' }, { status: 404 });
    }

    return NextResponse.json({ creditNote });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

// --- PATCH: Update credit note details ---
export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const auth = await requirePermission('INVOICE_UPDATE');
  if (auth instanceof NextResponse) return auth;
  const { supabase } = await getAuthSupabase(req);

  try {
    const { id } = params;
    const bodyValidation = validateBody(creditNoteCreateSchema.partial(), await req.json());
    if (!bodyValidation.success) return NextResponse.json({ error: bodyValidation.error }, { status: 400 });
    const body = bodyValidation.data as any;

    const existing = getData(await supabase
      .from('credit_notes')
      .select('id, status, credit_note_number')
      .eq('id', id)
      .eq('organization_id', auth.orgId)
      .single());

    if (!existing) {
      return NextResponse.json({ error: 'Credit note not found' }, { status: 404 });
    }

    if (existing.status !== 'DRAFT') {
      return NextResponse.json({ error: `Only DRAFT credit notes can be edited. Current: ${existing.status}` }, { status: 400 });
    }

    const { credit_note_number, organization_id, created_by, created_at, id: _id, ...updates } = body;

    const { data: updated, error } = await supabase
      .from('credit_notes')
      .update(updates)
      .eq('id', id)
      .eq('organization_id', auth.orgId)
      .select()
      .single();

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    // BUG-023 FIX: surface a failed audit write instead of only
    // console-logging it (Spec 8.1).
    let auditLogFailed = false;
    try {
      await supabase.schema('audit').rpc('log_action', {
        p_user_id: auth.userId,
        p_action: 'CREDIT_NOTE_UPDATED',
        p_entity_type: 'credit_note',
        p_entity_id: id,
        p_description: `Credit note updated: ${existing.credit_note_number}`,
        p_previous_status: 'DRAFT',
        p_new_status: 'DRAFT',
        p_source_module: 'invoice',
        p_severity: 'info',
        p_new_values: updates,
      });
    } catch (auditErr: any) {
      console.error('Audit log failed for credit note update:', auditErr);
      auditLogFailed = true;
    }

    return NextResponse.json({
      success: true,
      creditNote: updated,
      audit_log_warning: auditLogFailed ? 'Update succeeded but the audit log entry failed to write. Please notify an administrator.' : undefined,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

// --- POST (sub-action): Post credit note to GL ---
// Spec: Credit Note -> DR Revenue, CR Receivable (reverse of invoice)
// BUG-001 FIX: Replaced manual header+lines insert + wrong RPC({ p_journal_id, p_posted_by })
//   with single atomic RPC call using correct signature:
//   finance.post_journal_entry(p_description, p_transaction_date, p_period_id, p_lines, p_currency, p_exchange_rate, p_source_type, p_source_id, p_project_id, p_department_id)
export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const auth = await requirePermission('APPROVE_INVOICE');
  if (auth instanceof NextResponse) return auth;
  // H3 FIX: Enforce MFA for financial posting
  const mfaCheck = await enforceMFA(auth);
  if (mfaCheck) return mfaCheck;
  const { supabase } = await getAuthSupabase(req);

  try {
    const { id } = params;
    const rawBody = await req.json();
    const validation = validateBody(creditNotePostSchema, rawBody);
    if (!validation.success) return NextResponse.json({ error: validation.error }, { status: 400 });

    const creditNote = getData(await supabase
      .from('credit_notes')
      .select('*')
      .eq('id', id)
      .eq('organization_id', auth.orgId)
      .single());

    if (!creditNote) {
      return NextResponse.json({ error: 'Credit note not found' }, { status: 404 });
    }
    // BUG-008 FIX: validate exchange rate for non-PKR currencies before posting
    const rateError = validateExchangeRate(creditNote.currency, creditNote.exchange_rate);
    if (rateError) {
      return NextResponse.json({ error: rateError }, { status: 400 });
    }

    if (creditNote.status !== 'APPROVED') {
      return NextResponse.json({
        error: `Only APPROVED credit notes can be posted. Current: ${creditNote.status}`,
      }, { status: 400 });
    }

    // Idempotency check
    const existingJournal = getData(await supabase
      .from('finance.journal_entries')
      .select('id, reference')
      .eq('source_type', 'CREDIT_NOTE')
      .eq('source_id', id)
      .maybeSingle());

    if (existingJournal) {
      return NextResponse.json({
        error: 'Already posted to GL',
        journalId: existingJournal.id,
        reference: existingJournal.reference,
      }, { status: 400 });
    }

    // Get accounts
    // BUG-014 FIX: same fragility as the other posting routes -- `.like`
    // with no ORDER BY (could hit the 1200 parent/summary account) and an
    // unfiltered revenue lookup. Resolved by exact seeded control-account
    // code instead.
    const receivableAccount = getData(await supabase
      .from('finance.chart_of_accounts')
      .select('id, code, name')
      .eq('account_type', 'ASSET')
      .eq('is_active', true)
      .eq('organization_id', auth.orgId)
      .eq('code', '1210')
      .maybeSingle());

    const revenueAccount = getData(await supabase
      .from('finance.chart_of_accounts')
      .select('id, code, name')
      .eq('account_type', 'REVENUE')
      .eq('is_active', true)
      .eq('organization_id', auth.orgId)
      .eq('code', '4110')
      .maybeSingle());

    if (!receivableAccount || !revenueAccount) {
      return NextResponse.json({ error: 'Required Accounts Receivable (code 1210, "Client Receivables") and/or Revenue (code 4110, "Project Revenue") control accounts not found or inactive.' }, { status: 400 });
    }

    // Get open period
    // BUG-020 FIX: Add organization_id filter to period lookup
    const period = getData(await supabase
      .from('finance.accounting_periods')
      .select('id')
      .eq('organization_id', auth.orgId)
      .eq('status', 'OPEN')
      .order('start_date', { ascending: false })
      .limit(1)
      .single());

    if (!period) {
      return NextResponse.json({ error: 'No OPEN accounting period found' }, { status: 400 });
    }

    const totalAmount = Number(creditNote.total_amount) || 0;

    // BUG-001 FIX: Build journal lines for RPC (no journal_entry_id needed — RPC handles it)
    // Credit Note: DR Revenue (reverse), CR Receivable (reverse)
    const rpcLines = [
      {
        account_id: revenueAccount.id,
        debit_amount: totalAmount,
        credit_amount: 0,
        description: `Revenue reversal: Credit Note ${creditNote.credit_note_number}`,
      },
      {
        account_id: receivableAccount.id,
        debit_amount: 0,
        credit_amount: totalAmount,
        description: `Receivable reduction: Credit Note ${creditNote.credit_note_number}`,
      },
    ];

    // BUG-001 FIX: Use RPC with CORRECT signature — creates header + lines + posts atomically
    const { data: journalId, error: postErr } = await supabase.schema('finance').rpc('post_journal_entry', {
      p_description: `Credit Note: ${creditNote.credit_note_number} - ${creditNote.reason}`,
      p_transaction_date: creditNote.credit_note_date || new Date().toISOString().split('T')[0],
      p_period_id: period.id,
      p_lines: JSON.stringify(rpcLines),
      p_currency: creditNote.currency || 'PKR',
      p_exchange_rate: creditNote.exchange_rate || 1,
      p_source_type: 'CREDIT_NOTE',
      p_source_id: id,
    });

    if (postErr || !journalId) {
      return NextResponse.json({ error: 'GL posting failed: ' + (postErr?.message || 'Unknown error') }, { status: 500 });
    }

    // Fetch the created journal to get reference number
    const journal = getData(await supabase
      .from('finance.journal_entries')
      .select('id, reference')
      .eq('id', journalId)
      .single());
    // C6 FIX: Null guard
    if (!journal) {
      return NextResponse.json({ error: 'Journal created but fetch failed. Check journal ID: ' + journalId }, { status: 500 });
    }
    const reference = journal.reference || `JE-CN-${journalId}`;

    // ISS-013 FIX: Protect the APPROVED -> POSTED transition with both
    // organization and current-status predicates. This prevents a stale
    // approval from being posted after another request has already changed
    // the credit note. If the guarded update loses a race after GL posting,
    // immediately reverse the just-created journal so the source row and GL
    // cannot diverge.
    const { data: postedCreditNote, error: statusUpdateError } = await supabase
      .from('credit_notes')
      .update({
        status: 'POSTED',
        posted_at: new Date().toISOString(),
        journal_entry_id: journalId,
        posted_by: auth.userId,
      })
      .eq('id', id)
      .eq('organization_id', auth.orgId)
      .eq('status', 'APPROVED')
      .select('id, status')
      .maybeSingle();

    if (statusUpdateError || !postedCreditNote) {
      // Compensating action: the GL journal was created before the guarded
      // source-row update. Reverse that journal if the source row was already
      // changed by another request.
      const { data: reversalId, error: reversalError } = await supabase
        .schema('finance')
        .rpc('reverse_journal_entry', {
          p_journal_id: journalId,
          p_reversal_date: new Date().toISOString().split('T')[0],
          p_reason: 'Credit note posting aborted: source status changed concurrently.',
        });

      if (reversalError || !reversalId) {
        return NextResponse.json({
          error: 'Credit note status changed before posting completed and the compensating GL reversal also failed. Manual reconciliation is required.',
        }, { status: 500 });
      }

      return NextResponse.json({
        error: 'Credit note was modified before posting completed. The newly created GL entry was automatically reversed. Please refresh and try again.',
      }, { status: 409 });
    }

    // BUG-023 FIX: surface a failed audit write instead of only
    // console-logging it (Spec 8.1).
    let auditLogFailedPost = false;
    try {
      await supabase.schema('audit').rpc('log_action', {
        p_user_id: auth.userId,
        p_action: 'CREDIT_NOTE_POSTED',
        p_entity_type: 'credit_note',
        p_entity_id: id,
        p_description: `Credit note posted to GL: ${creditNote.credit_note_number} -> ${reference}`,
        p_previous_status: 'APPROVED',
        p_new_status: 'POSTED',
        p_source_module: 'invoice',
        p_severity: 'high',
        p_new_values: { reference, amount: totalAmount, journal_id: journal.id },
        p_related_journal_id: journal.id,
      });
    } catch (auditErr: any) {
      console.error('Audit log failed for credit note post:', auditErr);
      auditLogFailedPost = true;
    }

    return NextResponse.json({
      success: true,
      journalId: journal.id,
      reference,
      message: `Credit note posted to GL: ${reference}`,
      audit_log_warning: auditLogFailedPost ? 'Posting succeeded but the audit log entry failed to write. Please notify an administrator.' : undefined,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}