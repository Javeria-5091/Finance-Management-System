import { NextRequest, NextResponse } from 'next/server';
import { getAuthSupabase } from '@/lib/api-auth';
import { requirePermission } from '@/lib/api-auth';
import { enforceMFA } from '@/lib/mfa-middleware';
import { postIncomeSchema, validateBody } from '@/lib/validations';
 
function getData<T = any>(res: any): T | null {
  return res?.data ?? null;
}
 
export async function POST(req: NextRequest) {
  // ─── AUTH CHECK ───
  // FIXED: Use APPROVE permission, not CREATE — posting to GL requires approval-level access
  const auth = await requirePermission('APPROVE_INCOME');
  if (auth instanceof NextResponse) return auth;
  // H3 FIX: Enforce MFA for financial posting
  const mfaCheck = await enforceMFA(auth);
  if (mfaCheck) return mfaCheck;
  const { supabase } = await getAuthSupabase(req);
 
  try {
    const rawBody = await req.json();
    const validation = validateBody(postIncomeSchema, rawBody);
    if (!validation.success) return NextResponse.json({ error: validation.error }, { status: 400 });
    const { incomeId } = validation.data;
 
    // 1. Fetch income (with org isolation)
    const income = getData(await supabase
      .from("incomes")
      .select("*")
      .eq("id", incomeId)
      .eq("organization_id", auth.orgId)
      .single());
    if (!income) {
      return NextResponse.json({ error: 'Income not found' }, { status: 404 });
    }
    if (income.status !== 'APPROVED') {
      return NextResponse.json({ error: 'Only APPROVED incomes can be posted. Current: ' + income.status }, { status: 400 });
    }
 
    // 2. Already posted? (Idempotency check)
    const existingJournal = getData(await supabase
      .from('finance.journal_entries')
      .select('id, reference')
      .eq('source_type', 'INCOME')
      .eq('source_id', incomeId)
      .maybeSingle());
    if (existingJournal) {
      return NextResponse.json({
        error: 'Already posted to GL',
        journalId: existingJournal.id,
        reference: existingJournal.reference,
      }, { status: 400 });
    }
 
    // 3. Open period
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
 
    // 4. Revenue account
    const revenueAccount = getData(await supabase
      .from('finance.chart_of_accounts')
      .select('id, code, name')
      .eq('account_type', 'REVENUE')
      .eq('is_active', true)
      .limit(1)
      .single());
 
    // 5. Receivable / Asset account
    const receivableAccount = getData(await supabase
      .from('finance.chart_of_accounts')
      .select('id, code, name')
      .eq('account_type', 'ASSET')
      .eq('is_active', true)
      .like('code', '12%')
      .limit(1)
      .single());
 
    let fallbackAsset = null;
    if (!receivableAccount) {
      fallbackAsset = getData(await supabase
        .from('finance.chart_of_accounts')
        .select('id, code, name')
        .eq('account_type', 'ASSET')
        .eq('is_active', true)
        .limit(1)
        .single());
    }
 
    const debitAccountId = receivableAccount?.id || fallbackAsset?.id;
    const creditAccountId = revenueAccount?.id;
 
    if (!debitAccountId || !creditAccountId) {
      return NextResponse.json({
        error: 'Required accounts not found. Set up REVENUE and ASSET accounts in Chart of Accounts.'
      }, { status: 400 });
    }
 
    // 6-9. Post via GL engine (BUG-001 FIX: use RPC with CORRECT signature)
    const journalLines = [
      {
        account_id: debitAccountId,
        debit_amount: income.amount,
        credit_amount: 0,
        description: `Receivable for: ${income.title}`,
      },
      {
        account_id: creditAccountId,
        debit_amount: 0,
        credit_amount: income.amount,
        description: `Revenue from: ${income.title}`,
      },
    ];
 
    const { data: journalId, error: postErr } = await supabase.rpc('finance.post_journal_entry', {
      p_description: `Income: ${income.title}${income.project_id ? ' (Project)' : ''}`,
      p_transaction_date: income.income_date,
      p_period_id: period.id,
      p_lines: JSON.stringify(journalLines),
      p_currency: income.currency || 'PKR',
      p_exchange_rate: income.exchange_rate || 1,
      p_source_type: 'INCOME',
      p_source_id: incomeId,
      p_project_id: income.project_id || null,
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
    const reference = journal.reference || `JE-IN-${journalId}`;
 
    // 10. Update income status
    const { error: statusErr } = await supabase.from("incomes").update({
      status: 'POSTED',
      posted_at: new Date().toISOString(),
      journal_entry_id: journalId,
      posted_by: auth.userId,
    }).eq("id", incomeId);
 
    if (statusErr) {
      console.error('Income status update failed after GL post:', statusErr.message);
    }
 
        // 11. Audit log
    try {
      await supabase.schema('audit').rpc('log_action', {
        p_user_id: auth.userId,
        p_action: 'INCOME_POSTED',
        p_entity_type: 'income',
        p_entity_id: incomeId,
        p_description: `Posted income to GL: ${reference}`,
        p_previous_status: 'APPROVED',
        p_new_status: 'POSTED',
        p_source_module: 'income',
        p_severity: 'high',
        p_new_values: { reference, amount: income.amount, journal_id: journal.id },
        p_related_journal_id: journal.id,
      });
    } catch (auditErr: any) {
      console.error('Audit log failed for income post:', auditErr);
    }
 
    return NextResponse.json({
      success: true,
      journalId: journal.id,
      reference,
      message: `Posted ${reference}`,
    });
 
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

