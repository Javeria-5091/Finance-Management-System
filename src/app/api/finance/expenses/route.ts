import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getAuthSupabase, requirePermission } from '@/lib/api-auth';

const createExpenseSchema = z.object({
  title: z.string().trim().min(1).max(255),
  amount: z.number().finite().min(0).max(9999999999999999.99),
  category: z.string().trim().min(1).max(100),
  expense_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  notes: z.string().nullable().optional(),
  project_id: z.string().uuid().nullable().optional(),
  account_id: z.string().uuid().nullable().optional(),
}).strict();

/**
 * Server-side expense creation.
 * P2-004 FIX: the browser no longer inserts expenses directly. Amount is
 * validated here and the authenticated user/org/status are server-controlled.
 * The database CHECK remains the final defense for every write path.
 */
export async function POST(req: NextRequest) {
  const auth = await requirePermission('EXPENSE_CREATE');
  if (auth instanceof NextResponse) return auth;
  const { supabase } = await getAuthSupabase(req);

  try {
    const parsed = createExpenseSchema.safeParse(await req.json());
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message || 'Invalid expense data' },
        { status: 400 },
      );
    }

    const { title, amount, category, expense_date, notes, project_id, account_id } = parsed.data;

    if (project_id) {
      const { data: project, error } = await supabase
        .from('projects')
        .select('id')
        .eq('id', project_id)
        .eq('organization_id', auth.orgId)
        .maybeSingle();
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 });
    }

    if (account_id) {
      const { data: account, error } = await supabase
        .schema('finance')
        .from('chart_of_accounts')
        .select('id')
        .eq('id', account_id)
        .eq('organization_id', auth.orgId)
        .eq('is_active', true)
        .maybeSingle();
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      if (!account) return NextResponse.json({ error: 'Expense account not found or inactive' }, { status: 404 });
    }

    const { data, error } = await supabase
      .from('expenses')
      .insert({
        user_id: auth.userId,
        organization_id: auth.orgId,
        title,
        amount,
        category,
        expense_date: expense_date || new Date().toISOString().slice(0, 10),
        notes: notes || null,
        project_id: project_id || null,
        account_id: account_id || null,
        status: 'DRAFT',
      })
      .select()
      .single();

    if (error) return NextResponse.json({ error: error.message }, { status: 400 });
    return NextResponse.json({ data }, { status: 201 });
  } catch (error: any) {
    return NextResponse.json({ error: error?.message || 'Failed to create expense' }, { status: 500 });
  }
}
