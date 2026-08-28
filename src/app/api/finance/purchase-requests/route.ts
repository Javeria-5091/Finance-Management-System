import { NextRequest, NextResponse } from 'next/server';
import { getAuthSupabase, requirePermission } from '@/lib/api-auth';
import { z } from 'zod';
const schema=z.object({description:z.string().min(3).max(500),amount:z.coerce.number().positive(),currency:z.string().regex(/^[A-Z]{3}$/),category:z.string().max(100).optional().nullable(),vendor_id:z.string().uuid().optional().nullable(),project_id:z.string().uuid().optional().nullable(),required_date:z.string().optional().nullable(),justification:z.string().max(2000).optional().nullable()}).strict();
export async function GET(req:NextRequest)
{
    const a=await requirePermission('PURCHASE_REQUEST_READ');
    if(a instanceof NextResponse)
        return a;
    const {supabase}=await getAuthSupabase(req);
    const status=req.nextUrl.searchParams.get('status');
    let q=supabase.schema('finance').from('purchase_requests').select('*').eq('organization_id',a.orgId).order('created_at',{ascending:false});
    if(status)q=q.eq('status',status);
    const {data,error}=await q;
    return error?NextResponse.json({error:error.message},{status:500}):NextResponse.json({data:data||[]});
}
export async function POST(req:NextRequest)
{
    const a=await requirePermission('PURCHASE_REQUEST_CREATE');
    if(a instanceof NextResponse)
        return a;
    const p=schema.safeParse(await req.json());
    if(!p.success)
        return NextResponse.json({error:p.error.issues[0]?.message},{status:400});
    const {supabase}=await getAuthSupabase(req);
    const {data:n}=await supabase.schema('finance').rpc('get_next_number',{p_type:'PURCHASE_REQUEST'});
    const number=n||`PR-${Date.now()}`;
    const {data,error}=await supabase.schema('finance').from('purchase_requests').insert({...p.data,request_number:number,requested_by:a.userId,organization_id:a.orgId,status:'DRAFT'}).select().single();
    return error?NextResponse.json({error:error.message},{status:400}):NextResponse.json({data},{status:201});
}
