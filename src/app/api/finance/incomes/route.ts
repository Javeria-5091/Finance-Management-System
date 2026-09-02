import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getAuthSupabase, requirePermission } from '@/lib/api-auth';

const createIncomeSchema = z.object({
  title: z.string().trim().min(1).max(255),
  amount: z.number().finite().min(0).max(9999999999999999.99),
  category: z.string().trim().min(1).max(100),
  description: z.string().nullable().optional(),
  income_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  project_id: z.string().uuid().nullable().optional(),
  account_id: z.string().uuid().nullable().optional(),
  invoice_id: z.string().uuid().nullable().optional(),
  // The current incomes table does not persist these UI tax fields. Accept and
  // validate them so existing IncomeForm payloads remain compatible, but do not
  // pass them to PostgREST as columns.
  tax_rate: z.number().finite().min(0).max(100).optional(),
  tax_amount: z.number().finite().min(0).optional(),
}).strict();

/**
 * Server-side income creation.
 * P2-004 FIX: the browser no longer inserts income rows directly. Amount is
 * validated here and the authenticated user/org/status are server-controlled.
 * The database CHECK remains the final defense for every write path.
 */
export async function POST(req: NextRequest) {
  const auth = await requirePermission('INCOME_CREATE');
  if (auth instanceof NextResponse) return auth;
  const { supabase } = await getAuthSupabase(req);

  try {
    const parsed = createIncomeSchema.safeParse(await req.json());
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message || 'Invalid income data' },
        { status: 400 },
      );
    }

    const { title, amount, category, description, income_date, project_id, account_id, invoice_id } = parsed.data;

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
      if (!account) return NextResponse.json({ error: 'Income account not found or inactive' }, { status: 404 });
    }

    if (invoice_id) {
      const { data: invoice, error } = await supabase
        .from('invoices')
        .select('id')
        .eq('id', invoice_id)
        .eq('organization_id', auth.orgId)
        .maybeSingle();
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      if (!invoice) return NextResponse.json({ error: 'Invoice not found' }, { status: 404 });
    }

    const { data, error } = await supabase
      .from('incomes')
      .insert({
        user_id: auth.userId,
        organization_id: auth.orgId,
        title,
        amount,
        category,
        description: description || null,
        income_date: income_date || new Date().toISOString().slice(0, 10),
        project_id: project_id || null,
        account_id: account_id || null,
        invoice_id: invoice_id || null,
        status: 'DRAFT',
      })
      .select()
      .single();

    if (error) return NextResponse.json({ error: error.message }, { status: 400 });
    return NextResponse.json({ data }, { status: 201 });
  } catch (error: any) {
    return NextResponse.json({ error: error?.message || 'Failed to create income' }, { status: 500 });
  }
}
