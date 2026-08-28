import { NextRequest, NextResponse } from 'next/server';
import { getAuthSupabase, requirePermission } from '@/lib/api-auth';

export async function GET(req: NextRequest) {
  const auth = await requirePermission('EXPENSE_CREATE'); if (auth instanceof NextResponse) return auth;
  const { supabase } = await getAuthSupabase(req);
  const expenseId = new URL(req.url).searchParams.get('expense_id');
  if (!expenseId) return NextResponse.json({ error: 'expense_id is required' }, { status: 400 });
  const { data, error } = await supabase.schema('finance').from('expense_allocations').select('*').eq('organization_id', auth.orgId).eq('expense_id', expenseId).order('line_number');
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ data });
}

export async function POST(req: NextRequest) {
  const auth = await requirePermission('EXPENSE_CREATE'); if (auth instanceof NextResponse) return auth;
  const { supabase } = await getAuthSupabase(req);
  const body = await req.json();
  if (!body.expense_id || !Array.isArray(body.lines) || body.lines.length === 0) return NextResponse.json({ error: 'expense_id and lines are required' }, { status: 400 });
  const { data: expense, error: expenseError } = await supabase.from('expenses').select('id,amount,currency,exchange_rate,organization_id,status').eq('id', body.expense_id).eq('organization_id', auth.orgId).single();
  if (expenseError || !expense) return NextResponse.json({ error: 'Expense not found' }, { status: 404 });
  if (!['DRAFT','SUBMITTED','VERIFIED'].includes(expense.status)) return NextResponse.json({ error: 'Allocations can only be changed before approval' }, { status: 409 });
  const lines = body.lines.map((l: any, i: number) => ({ expense_id: expense.id, organization_id: auth.orgId, line_number: i + 1, account_id: l.account_id, project_id: l.project_id || null, cost_center_id: l.cost_center_id || null, amount: Number(l.amount), currency: expense.currency || 'PKR', base_amount: Number(l.amount) * Number(expense.exchange_rate || 1), description: l.description || null, created_by: auth.userId }));
  const total = lines.reduce((s: number, l: any) => s + l.amount, 0);
  if (Math.abs(total - Number(expense.amount)) > 0.01 || lines.some((l: any) => !l.account_id || l.amount <= 0)) return NextResponse.json({ error: 'Allocation lines must have valid accounts and total exactly equal the expense amount' }, { status: 400 });
  const { error: delError } = await supabase.schema('finance').from('expense_allocations').delete().eq('expense_id', expense.id).eq('organization_id', auth.orgId);
  if (delError) return NextResponse.json({ error: delError.message }, { status: 400 });
  const { data, error } = await supabase.schema('finance').from('expense_allocations').insert(lines).select();
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ data }, { status: 201 });
}
