import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getAuthSupabase, requirePermission } from '@/lib/api-auth';

const updateExpenseSchema = z.object({
  title: z.string().trim().min(1).max(255).optional(),
  amount: z.number().finite().min(0).max(9999999999999999.99).optional(),
  category: z.string().trim().min(1).max(100).optional(),
  expense_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  notes: z.string().nullable().optional(),
  project_id: z.string().uuid().nullable().optional(),
  account_id: z.string().uuid().nullable().optional(),
}).strict();

// =============================================================================
// EXP-02 FIX: server-side expense edit/delete.
//
// Previously the browser mutated `expenses` rows directly --
//   supabase.from('expenses').update(data).eq('id', editingData.id)
//   supabase.from('expenses').delete().eq('id', selectedExp.id)
// -- gated only by a client-side `status === 'DRAFT'` check, which is just
// UI and does nothing to stop a direct PostgREST call. RLS didn't help
// either: expenses_update_org_scoped / expenses_delete_org_scoped only
// required `journal_entry_id IS NULL`, which stays true all the way through
// SUBMITTED and APPROVED (it's only set once actually posted) -- so an
// owner could inflate an already-approved amount and then post it, and the
// approver would never see the real figure.
//
// This route is now the only supported write path from the browser for
// edit/delete, and it re-checks status server-side (TOCTOU-safe, via the
// same `.eq('status', 'DRAFT')` conditional-write pattern used by
// /api/finance/workflow) before allowing anything through. The DB itself is
// still the final defense: P2_034_expense_status_guard.sql adds a
// `status = 'DRAFT'` predicate to the DELETE policy and a trigger that
// blocks amount/other financial-field changes on any UPDATE once a row has
// left DRAFT, regardless of write path.
// =============================================================================

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requirePermission('EXPENSE_UPDATE');
  if (auth instanceof NextResponse) return auth;
  const { supabase } = await getAuthSupabase(req);

  try {
    const parsed = updateExpenseSchema.safeParse(await req.json());
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message || 'Invalid expense data' },
        { status: 400 },
      );
    }
    const updates = parsed.data;
    if (Object.keys(updates).length === 0) {
      return NextResponse.json({ error: 'No fields to update' }, { status: 400 });
    }

    const { data: existing, error: fetchErr } = await supabase
      .from('expenses')
      .select('id, status')
      .eq('id', params.id)
      .eq('organization_id', auth.orgId)
      .maybeSingle();
    if (fetchErr) return NextResponse.json({ error: fetchErr.message }, { status: 500 });
    if (!existing) return NextResponse.json({ error: 'Expense not found' }, { status: 404 });
    if (existing.status !== 'DRAFT') {
      return NextResponse.json(
        { error: `Only DRAFT expenses can be edited (current status: ${existing.status}). Reopen a rejected expense first, or contact your approver.` },
        { status: 400 },
      );
    }

    if (updates.project_id) {
      const { data: project, error } = await supabase
        .from('projects')
        .select('id')
        .eq('id', updates.project_id)
        .eq('organization_id', auth.orgId)
        .maybeSingle();
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 });
    }

    if (updates.account_id) {
      const { data: account, error } = await supabase
        .schema('finance')
        .from('chart_of_accounts')
        .select('id')
        .eq('id', updates.account_id)
        .eq('organization_id', auth.orgId)
        .eq('is_active', true)
        .maybeSingle();
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      if (!account) return NextResponse.json({ error: 'Expense account not found or inactive' }, { status: 404 });
    }

    // TOCTOU-safe: only succeeds if the row is STILL DRAFT at write time
    // (mirrors the .eq('status', currentStatus) pattern in
    // /api/finance/workflow). RLS (owner or admin) and the P2_034 trigger
    // both still apply on top of this as final defenses.
    const { data, error } = await supabase
      .from('expenses')
      .update(updates)
      .eq('id', params.id)
      .eq('organization_id', auth.orgId)
      .eq('status', 'DRAFT')
      .select()
      .maybeSingle();

    if (error) return NextResponse.json({ error: error.message }, { status: 400 });
    if (!data) {
      return NextResponse.json(
        { error: 'Expense could not be updated -- it may have changed status, or you may not have permission to edit it. Refresh and try again.' },
        { status: 409 },
      );
    }

    return NextResponse.json({ data });
  } catch (error: any) {
    return NextResponse.json({ error: error?.message || 'Failed to update expense' }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requirePermission('EXPENSE_DELETE');
  if (auth instanceof NextResponse) return auth;
  const { supabase } = await getAuthSupabase(req);

  try {
    const { data: existing, error: fetchErr } = await supabase
      .from('expenses')
      .select('id, status')
      .eq('id', params.id)
      .eq('organization_id', auth.orgId)
      .maybeSingle();
    if (fetchErr) return NextResponse.json({ error: fetchErr.message }, { status: 500 });
    if (!existing) return NextResponse.json({ error: 'Expense not found' }, { status: 404 });
    if (existing.status !== 'DRAFT') {
      return NextResponse.json(
        { error: `Only DRAFT expenses can be deleted (current status: ${existing.status}).` },
        { status: 400 },
      );
    }

    // TOCTOU-safe delete, same reasoning as PATCH above.
    const { data, error } = await supabase
      .from('expenses')
      .delete()
      .eq('id', params.id)
      .eq('organization_id', auth.orgId)
      .eq('status', 'DRAFT')
      .select('id')
      .maybeSingle();

    if (error) return NextResponse.json({ error: error.message }, { status: 400 });
    if (!data) {
      return NextResponse.json(
        { error: 'Expense could not be deleted -- it may have changed status, or you may not have permission to delete it. Refresh and try again.' },
        { status: 409 },
      );
    }

    return NextResponse.json({ success: true });
  } catch (error: any) {
    return NextResponse.json({ error: error?.message || 'Failed to delete expense' }, { status: 500 });
  }
}