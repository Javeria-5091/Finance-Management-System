import { NextRequest, NextResponse } from 'next/server';
import { getAuthSupabase, requirePermission } from '@/lib/api-auth';
import { enforceMFA } from '@/lib/mfa-middleware';

export async function POST(req: NextRequest) {
  const auth = await requirePermission('BANK_RECONCILE');
  if (auth instanceof NextResponse) return auth;
  const mfa = await enforceMFA(auth); if (mfa) return mfa;
  const { supabase } = await getAuthSupabase(req);
  try {
    const body = await req.json();
    if (!body?.statement_id) return NextResponse.json({error:'statement_id is required'},{status:400});
    const { data, error } = await supabase.schema('finance').rpc('finalize_bank_reconciliation', {
      p_statement_id: body.statement_id, p_user_id: auth.userId, p_organization_id: auth.orgId
    });
    if (error) return NextResponse.json({error:error.message},{status:400});
    return NextResponse.json({data});
  } catch(e:any) { return NextResponse.json({error:e?.message||'Failed'},{status:500}); }
}
