import { NextRequest, NextResponse } from 'next/server';
import { requirePermission } from '@/lib/api-auth';
import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';

function db() {
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { cookies: { getAll: async () => (await cookies()).getAll(), setAll: () => {} } }
  );
}

// P0: Opening Balance Import API
// Accepts CSV rows and creates balanced opening journal entries

export async function POST(req: NextRequest) {
  const auth = await requirePermission('JOURNAL_CREATE');
  if (auth instanceof NextResponse) return auth;

  try {
    const { action, rows, fiscalYearId } = await req.json();
    const supabase = db();

    if (action === 'import') {
      if (!rows || !Array.isArray(rows) || rows.length === 0) {
        return NextResponse.json({ error: 'rows array is required' }, { status: 400 });
      }

      // Validate rows
      for (const row of rows) {
        if (!row.account_code || (!row.debit_amount && !row.credit_amount)) {
          return NextResponse.json({ error: `Each row needs account_code and at least one of debit_amount/credit_amount` }, { status: 400 });
        }
      }

      // Check total debit = total credit
      let totalDebit = 0;
      let totalCredit = 0;
      for (const row of rows) {
        totalDebit += Math.abs(Number(row.debit_amount) || 0);
        totalCredit += Math.abs(Number(row.credit_amount) || 0);
      }

      if (Math.abs(totalDebit - totalCredit) > 0.02) {
        return NextResponse.json({ error: `Opening balances must balance. Total Debit: ${totalDebit.toFixed(2)}, Total Credit: ${totalCredit.toFixed(2)}, Difference: ${(totalDebit - totalCredit).toFixed(2)}` }, { status: 400 });
      }

      // Get next batch number
      const { data: numData } = await supabase.rpc('get_next_number', {
        p_sequence_code: 'OBI',
        p_fiscal_year_id: fiscalYearId || null,
      });
      const batchId = numData || 'OBI-00001';

      // Build journal lines
      const journalLines = [];
      let lineNum = 1;
      for (const row of rows) {
        const debit = Number(row.debit_amount) || 0;
        const credit = Number(row.credit_amount) || 0;

        if (debit > 0) {
          journalLines.push({ line_number: lineNum++, account_code: row.account_code, debit: debit, credit: 0, description: `Opening Balance - ${row.account_name || row.account_code}` });
        }
        if (credit > 0) {
          journalLines.push({ line_number: lineNum++, account_code: row.account_code, debit: 0, credit: credit, description: `Opening Balance - ${row.account_name || row.account_code}` });
        }
      }

      // Post via the posting engine
      const { data: journalData, error: postErr } = await supabase.rpc('post_journal_entry', {
        p_reference: batchId,
        p_description: 'Opening Balance Import',
        p_fiscal_period_id: fiscalYearId || null,
        p_journal_date: new Date().toISOString().split('T')[0],
        p_lines: journalLines,
        p_source_type: 'OPENING_BALANCE',
        p_source_id: batchId,
        p_organization_id: auth.orgId,
      });

      if (postErr) {
        return NextResponse.json({ error: 'Posting failed: ' + postErr.message }, { status: 500 });
      }

      // Track each import row
      for (const row of rows) {
        await supabase.from('finance.opening_balance_imports').insert({
          organization_id: auth.orgId,
          import_batch_id: batchId,
          account_id: row.account_id || null,
          account_code: row.account_code,
          account_name: row.account_name || '',
          debit_amount: Number(row.debit_amount) || 0,
          credit_amount: Number(row.credit_amount) || 0,
          currency: row.currency || 'PKR',
          exchange_rate: Number(row.exchange_rate) || 1,
          base_amount: (Number(row.debit_amount) || Number(row.credit_amount) || 0) * (Number(row.exchange_rate) || 1),
          fiscal_year_id: fiscalYearId || null,
          status: 'IMPORTED',
          journal_entry_id: journalData?.journal_id || null,
          imported_by: auth.userId,
        });
      }

      // Audit
      try {
        await supabase.from('audit.audit_log').insert({
          user_id: auth.userId, action: 'OPENING_BALANCE_IMPORTED', module: 'ACCOUNTING',
          details: JSON.stringify({ batch_id: batchId, rows: rows.length, total_debit: totalDebit, total_credit: totalCredit, journal_id: journalData?.journal_id }),
        });
      } catch {}

      return NextResponse.json({ success: true, batch_id: batchId, journal_id: journalData?.journal_id, message: `Opening balance imported: ${rows.length} accounts, balanced at PKR ${totalDebit.toLocaleString()}` });
    }

    if (action === 'preview') {
      // Return validation without posting
      let totalDebit = 0;
      let totalCredit = 0;
      const validated = [];
      for (const row of rows) {
        const d = Math.abs(Number(row.debit_amount) || 0);
        const c = Math.abs(Number(row.credit_amount) || 0);
        totalDebit += d;
        totalCredit += c;
        validated.push({ ...row, valid: !!(row.account_code && (d > 0 || c > 0)) });
      }
      const balanced = Math.abs(totalDebit - totalCredit) < 0.02;
      return NextResponse.json({ rows: validated, total_debit: totalDebit, total_credit: totalCredit, balanced, difference: totalDebit - totalCredit });
    }

    return NextResponse.json({ error: 'Use action import or preview' }, { status: 400 });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
