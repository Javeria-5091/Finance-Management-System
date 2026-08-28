import { z } from 'zod';
import { NextRequest, NextResponse } from 'next/server';
import { requirePermission, getAuthSupabase } from '@/lib/api-auth';
import { enforceMFA } from '@/lib/mfa-middleware';
 
// P0: Opening Balance Import API
// Accepts CSV rows and creates balanced opening journal entries
//
// BUG-001 FIX:
//   OLD: Called `post_journal_entry` (missing `finance.` schema prefix) with wrong params:
//     { p_reference, p_description, p_fiscal_period_id, p_journal_date, p_lines, p_source_type, p_source_id, p_organization_id }
//   NEW: Calls `finance.post_journal_entry` with CORRECT signature:
//     { p_description, p_transaction_date, p_period_id, p_lines, p_currency, p_exchange_rate, p_source_type, p_source_id, p_project_id, p_department_id }
//   Also: Lines now use debit_amount/credit_amount (matching DB columns), not debit/credit.
 
export async function POST(req: NextRequest) {
  const auth = await requirePermission('JOURNAL_CREATE');
  if (auth instanceof NextResponse) return auth;
 
  // BUG-025 FIX: Enforce MFA for opening balance import (P0 financial action)
  const mfaCheck = await enforceMFA(auth);
  if (mfaCheck) return mfaCheck;

  try {
    const body = await req.json();
    const rowSchema = z.object({ account_code: z.string().min(1), account_id: z.string().uuid().optional().nullable(), account_name: z.string().optional().nullable(), debit_amount: z.coerce.number().finite().min(0).optional(), credit_amount: z.coerce.number().finite().min(0).optional(), currency: z.string().length(3).optional(), exchange_rate: z.coerce.number().finite().positive().optional() });
    const bodySchema = z.object({ action: z.enum(['import','preview']), rows: z.array(rowSchema).min(1), fiscalYearId: z.string().uuid().optional().nullable() });
    const parsed = bodySchema.safeParse(body);
    if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message || 'Invalid opening balance data' }, { status: 400 });
    const { action, rows, fiscalYearId } = parsed.data;
    const { supabase } = await getAuthSupabase(req);
 
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
 
      if (Math.abs(totalDebit - totalCredit) > 0.01) {
        return NextResponse.json({ error: `Opening balances must balance. Total Debit: ${totalDebit.toFixed(2)}, Total Credit: ${totalCredit.toFixed(2)}, Difference: ${(totalDebit - totalCredit).toFixed(2)}` }, { status: 400 });
      }
 
      // Get open period for the fiscal year
      let periodId: string | null = null;
      if (fiscalYearId) {
        const period = (await supabase
          .schema('finance').from('accounting_periods')
          .select('id')
          .eq('fiscal_year_id', fiscalYearId)
          .eq('organization_id', auth.orgId)
          .order('start_date', { ascending: true })
          .limit(1)
          .single()).data;
        periodId = period?.id || null;
      }
 
      // Get next batch number
      const { data: numData } = await supabase.schema('finance').rpc('get_next_number', {
        p_type: 'OBI',
      });
      const batchId = numData || `OBI-${Date.now().toString().slice(-6)}`;
      const batchSourceId = crypto.randomUUID();
 
      // BUG-001 FIX: Build journal lines with CORRECT column names (debit_amount/credit_amount)
      const rpcLines = [];
      for (const row of rows) {
        const debit = Math.abs(Number(row.debit_amount) || 0);
        const credit = Math.abs(Number(row.credit_amount) || 0);
 
        if (debit > 0) {
          rpcLines.push({
            account_id: row.account_id || null,
            account_code: row.account_code,
            debit_amount: debit,
            credit_amount: 0,
            description: `Opening Balance - ${row.account_name || row.account_code}`,
          });
        }
        if (credit > 0) {
          rpcLines.push({
            account_id: row.account_id || null,
            account_code: row.account_code,
            debit_amount: 0,
            credit_amount: credit,
            description: `Opening Balance - ${row.account_name || row.account_code}`,
          });
        }
      }
 
      // BUG-001 FIX: Use `finance.post_journal_entry` (with schema prefix) and CORRECT parameter names
      const { data: journalId, error: postErr } = await supabase.schema('finance').rpc('post_journal_entry', {
        p_description: 'Opening Balance Import',
        p_transaction_date: new Date().toISOString().split('T')[0],
        p_period_id: periodId,
        p_lines: JSON.stringify(rpcLines),
        p_currency: 'PKR',
        p_exchange_rate: 1,
        p_source_type: 'OPENING_BALANCE',
        p_source_id: batchSourceId,
      });
 
      if (postErr) {
        return NextResponse.json({ error: 'Posting failed: ' + postErr.message }, { status: 500 });
      }
 
      // Track each import row
      for (const row of rows) {
        await supabase.schema('finance').from('opening_balance_imports').insert({
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
          journal_entry_id: journalId || null,
          imported_by: auth.userId,
        });
      }
 
      // BUG-027 FIX: Use proper audit RPC instead of raw insert
      await supabase.schema('audit').rpc('log_action', {
        p_user_id: auth.userId,
        p_action: 'OPENING_BALANCE_IMPORTED',
        p_entity_type: 'opening_balance',
        p_entity_id: batchId,
        p_description: `Opening balance imported: ${rows.length} accounts, balanced at PKR ${totalDebit.toLocaleString()}`,
        p_previous_status: null,
        p_new_status: 'IMPORTED',
        p_source_module: 'accounting',
        p_severity: 'high',
        p_new_values: { batch_id: batchId, rows: rows.length, total_debit: totalDebit, total_credit: totalCredit, journal_id: journalId },
      });
 
      return NextResponse.json({ success: true, batch_id: batchId, journal_id: journalId, message: `Opening balance imported: ${rows.length} accounts, balanced at PKR ${totalDebit.toLocaleString()}` });
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
      const balanced = Math.abs(totalDebit - totalCredit) < 0.01;
      return NextResponse.json({ rows: validated, total_debit: totalDebit, total_credit: totalCredit, balanced, difference: totalDebit - totalCredit });
    }
 
    return NextResponse.json({ error: 'Use action import or preview' }, { status: 400 });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}