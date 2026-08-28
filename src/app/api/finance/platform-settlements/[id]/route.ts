import {NextRequest,NextResponse} from 'next/server';
import {getAuthSupabase,requirePermission} from '@/lib/api-auth';
export async function POST(req:NextRequest,{params}:{params:Promise<{id:string}>})
{
    const a=await requirePermission('SETTLEMENT_RECONCILE');
    if(a instanceof NextResponse)
        return a;
    const {id}=await params;
    const {supabase}=await getAuthSupabase(req);
    const {data,error}=await supabase.schema('finance').rpc('finalize_platform_settlement',{p_batch_id:id,p_user_id:a.userId,p_organization_id:a.orgId});
    return error?NextResponse.json({error:error.message},{status:400}):NextResponse.json({data});
}
