import { NextRequest, NextResponse } from 'next/server';
import { getAuthSupabase, requirePermission } from '@/lib/api-auth';

export async function GET(req: NextRequest) {
  const auth = await requirePermission('REPORT_READ');
  if (auth instanceof NextResponse) return auth;
  const { supabase } = await getAuthSupabase(req);
  const { data, error } = await supabase.schema('finance').from('opening_balance_imports')
    .select('id,import_batch_id,debit_amount,credit_amount,journal_entry_id,status,created_at')
    .eq('organization_id', auth.orgId).order('created_at', { ascending: false });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  const rows = data || [];
  const grouped = new Map<string, any>();
  for (const r of rows) {
    const key = r.import_batch_id;
    const b = grouped.get(key) || { import_batch_id: key, row_count: 0, total_debit: 0, total_credit: 0, journal_ids: [] as string[] };
    b.row_count += 1; b.total_debit += Number(r.debit_amount || 0); b.total_credit += Number(r.credit_amount || 0);
    if (r.journal_entry_id && !b.journal_ids.includes(r.journal_entry_id)) b.journal_ids.push(r.journal_entry_id);
    grouped.set(key, b);
  }
  const batches = Array.from(grouped.values());
  const rowCount = rows.length;
  const debit = rows.reduce((n, r) => n + Number(r.debit_amount || 0), 0);
  const credit = rows.reduce((n, r) => n + Number(r.credit_amount || 0), 0);
  return NextResponse.json({ reconciliation: { row_count: rowCount, total_debit: debit, total_credit: credit, difference: debit - credit, balanced: Math.abs(debit - credit) < 0.01 }, batches });
}
