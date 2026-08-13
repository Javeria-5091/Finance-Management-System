import { NextRequest, NextResponse } from 'next/server';
import { getAuthSupabase } from '@/lib/api-auth';
import { requirePermission } from '@/lib/api-auth';
import { enforceMFA } from '@/lib/mfa-middleware';
import { creditNotePostSchema, validateBody } from '@/lib/validations';
 
function getData<T = any>(res: any): T | null {
  return res?.data ?? null;
}
 
// ─── GET: Fetch single credit note by ID ───
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
 
// ─── PATCH: Update credit note details ───
export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const auth = await requirePermission('INVOICE_UPDATE');
  if (auth instanceof NextResponse) return auth;
  const { supabase } = await getAuthSupabase(req);
 
  try {
    const { id } = params;
    const body = await req.json();
 
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
      .select()
      .single();
 
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
 
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
      console.error('Audit log failed:', auditErr);
    }
 
    return NextResponse.json({ success: true, creditNote: updated });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
 
// ─── POST (sub-action): Post credit note to GL ───
// Spec: Credit Note → DR Revenue, CR Receivable (reverse of invoice)
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
    const receivableAccount = getData(await supabase
      .from('finance.chart_of_accounts')
      .select('id, code, name')
      .eq('account_type', 'ASSET')
      .eq('is_active', true)
      .like('code', '12%')
      .limit(1)
      .single());
 
    const revenueAccount = getData(await supabase
      .from('finance.chart_of_accounts')
      .select('id, code, name')
      .eq('account_type', 'REVENUE')
      .eq('is_active', true)
      .limit(1)
      .single());
 
    if (!receivableAccount || !revenueAccount) {
      return NextResponse.json({ error: 'Required accounts not found. Set up ASSET (Receivable) and REVENUE accounts.' }, { status: 400 });
    }
 
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
    const { data: journalId, error: postErr } = await supabase.rpc('finance.post_journal_entry', {
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
 
    // Update credit note status
    await supabase.from('credit_notes').update({
      status: 'POSTED',
      posted_at: new Date().toISOString(),
      journal_entry_id: journalId,
      posted_by: auth.userId,
    }).eq('id', id);
 
    try {
await       supabase.schema('audit').rpc('log_action', {
        p_user_id: auth.userId,
        p_action: 'CREDIT_NOTE_POSTED',
        p_entity_type: 'credit_note',
        p_entity_id: id,
        p_description: `Credit note posted to GL: ${creditNote.credit_note_number} → ${reference}`,
        p_previous_status: 'APPROVED',
        p_new_status: 'POSTED',
        p_source_module: 'invoice',
        p_severity: 'high',
        p_new_values: { reference, amount: totalAmount, journal_id: journal.id },
        p_related_journal_id: journal.id,
      });
    } catch (auditErr: any) {
      console.error('Audit log failed:', auditErr);
    }
 
    return NextResponse.json({
      success: true,
      journalId: journal.id,
      reference,
      message: `Credit note posted to GL: ${reference}`,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

