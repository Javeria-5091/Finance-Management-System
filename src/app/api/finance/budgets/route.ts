import { NextRequest, NextResponse } from 'next/server';
import { getAuthSupabase, requirePermission } from '@/lib/api-auth';
import { z } from 'zod';

const budgetSchema = z.object({
  name: z.string().trim().min(1).max(200),
  category: z.string().trim().min(1).max(100),
  total_amount: z.number().finite().min(0),
  start_date: z.string().date(),
  end_date: z.string().date(),
  description: z.string().trim().max(2000).nullable().optional(),
  control_account_id: z.string().uuid().nullable().optional(),
  variance_alert_threshold: z.number().finite().min(0).max(100).optional(),
  project_id: z.string().uuid().nullable().optional(),
  department: z.string().trim().max(100).nullable().optional(),
}).strict().superRefine((v, ctx) => {
  if (v.end_date < v.start_date) ctx.addIssue({ code: 'custom', path: ['end_date'], message: 'End date must be on or after start date' });
});

export async function GET(req: NextRequest) {
  const auth = await requirePermission('BUDGET_READ');
  if (auth instanceof NextResponse) return auth;
  const { supabase } = await getAuthSupabase(req);
  const { searchParams } = new URL(req.url);
  const status = searchParams.get('status');
  const projectId = searchParams.get('project_id');
  let q = supabase.from('budgets').select('*').eq('organization_id', auth.orgId).order('created_at', { ascending: false });
  if (status) q = q.eq('status', status);
  if (projectId) q = q.eq('project_id', projectId);
  const { data, error } = await q;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ data: data || [] });
}

export async function POST(req: NextRequest) {
  const auth = await requirePermission('BUDGET_CREATE');
  if (auth instanceof NextResponse) return auth;
  const { supabase } = await getAuthSupabase(req);
  const parsed = budgetSchema.safeParse(await req.json());
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message || 'Invalid budget' }, { status: 400 });
  const body = parsed.data;
  const { data, error } = await supabase.from('budgets').insert({
    ...body, user_id: auth.userId, organization_id: auth.orgId, status: 'DRAFT'
  }).select().single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ success: true, budget: data }, { status: 201 });
}
