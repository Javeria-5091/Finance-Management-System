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
 
      // FND-FIN-012 FIX: journal creation and every opening_balance_imports
      // row are now committed by one SECURITY DEFINER transaction.
      const { data: importResult, error: importErr } = await supabase.schema('finance').rpc('import_opening_balance_atomic', {
        p_rows: rows.map((row) => ({
          ...row,
          debit_amount: Math.abs(Number(row.debit_amount) || 0),
          credit_amount: Math.abs(Number(row.credit_amount) || 0),
        })),
        p_fiscal_year_id: fiscalYearId || null,
        p_import_batch_id: `OBI-${Date.now().toString().slice(-10)}`,
        p_transaction_date: new Date().toISOString().slice(0, 10),
      });

      if (importErr || !importResult) {
        return NextResponse.json({ error: 'Atomic opening-balance import failed: ' + (importErr?.message || 'Unknown error') }, { status: 500 });
      }

      const batchId = importResult.batch_id;
      const journalId = importResult.journal_id;

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