import {NextRequest,NextResponse} from 'next/server';
import{getAuthSupabase,requirePermission}from '@/lib/api-auth';
import{z}from'zod';
const S=z.object({action:z.enum(['create','update','deactivate']),id:z.string().uuid().optional(),code:z.string().trim().min(1).max(50).optional(),name:z.string().trim().min(1).max(200).optional(),manager_user_id:z.string().uuid().nullable().optional(),is_active:z.boolean().optional()});
export async function GET(req:NextRequest){
    const a=await requirePermission('SETTINGS_READ');
    if(a instanceof NextResponse)return a;
    const{supabase}=await getAuthSupabase(req);
    const{data,error}=await supabase.schema('finance').from('dimensions').select('*').eq('organization_id',a.orgId).eq('type','DEPARTMENT').order('name');
    if(error)return NextResponse.json({error:error.message},{status:400});
    return NextResponse.json({data:data??[]})}
export async function POST(req:NextRequest){
    const a=await requirePermission('SETTINGS_UPDATE');
    if(a instanceof NextResponse)
        return a;const{supabase}=await getAuthSupabase(req);
    const p=S.safeParse(await req.json());
    if(!p.success)
        return NextResponse.json({error:p.error.issues[0]?.message},{status:400});
    const b=p.data;
    try{if(b.action==='create'){if(!b.code||!b.name)
        throw new Error('code and name are required');
        const{data,error}=await supabase.schema('finance').from('dimensions').insert({type:'DEPARTMENT',code:b.code,name:b.name,manager_user_id:b.manager_user_id??null,organization_id:a.orgId,created_by:a.userId}).select().single();
        if(error)throw error;
        return NextResponse.json({data},{status:201})}if(!b.id)throw new Error('id is required');const{data,error}=await supabase.schema('finance').from('dimensions').update({...(b.code!==undefined?{code:b.code}:{}),...(b.name!==undefined?{name:b.name}:{}),...(b.manager_user_id!==undefined?{manager_user_id:b.manager_user_id}:{}),...(b.is_active!==undefined?{is_active:b.is_active}:{}),updated_at:new Date().toISOString()}).eq('id',b.id).eq('organization_id',a.orgId).eq('type','DEPARTMENT').select().single();
        if(error)throw error;
        return NextResponse.json({data})}catch(e:any){return NextResponse.json({error:e.message||'Department operation failed'},{status:400})}}
