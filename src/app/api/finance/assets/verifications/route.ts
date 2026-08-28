import{NextRequest,NextResponse}from'next/server';
import{getAuthSupabase,requirePermission}from'@/lib/api-auth';
import{enforceMFA}from'@/lib/mfa-middleware';

export async function POST(req:NextRequest)
{
    const a=await requirePermission('FIXED_ASSET_VERIFY_UPDATE');
    if(a instanceof NextResponse)return a;
    const{supabase}=await getAuthSupabase(req);
    const b=await req.json();
    try{if(b.action==='create'){const m=await enforceMFA(a);
        if(m)return m;
        const code=`VER-${Date.now()}-${crypto.randomUUID().slice(0,6).toUpperCase()}`;
        const{data:v,error}=await supabase.schema('finance').from('asset_verifications').insert({verification_code:code,verification_date:new Date().toISOString().slice(0,10),verified_by:a.userId,created_by:a.userId,organization_id:a.orgId,status:'in_progress'}).select().single();
        if(error)throw error;
        const{data:assets,error:ae}=await supabase.schema('finance').from('fixed_assets').select('id,location').eq('organization_id',a.orgId).not('status','in',['disposed','sold']);
        if(ae)throw ae;
        if((assets??[]).length){const{error:le}=await supabase.schema('finance').from('asset_verification_lines').insert((assets??[]).map(x=>({verification_id:v.id,asset_id:x.id,physical_location:x.location,is_verified:false})));
        if(le)throw le}return NextResponse.json({data:v},{status:201})}if(b.action==='update_line'){if(!b.line_id)throw new Error('line_id is required');
            const{data:l,error:le}=await supabase.schema('finance').from('asset_verification_lines').select('verification_id').eq('id',b.line_id).single();
            if(le||!l)throw new Error('Line not found');
            const{data:v,error:ve}=await supabase.schema('finance').from('asset_verifications').select('status').eq('id',l.verification_id).eq('organization_id',a.orgId).single();
            if(ve||!v)throw new Error('Verification not found');
            if(v.status!=='in_progress')throw new Error('Verification is finalized');
            const{data,error}=await supabase.schema('finance').from('asset_verification_lines').update({physical_location:b.physical_location??null,physical_condition:b.physical_condition??null,is_verified:!!b.is_verified,discrepancy_notes:b.discrepancy_notes??null,updated_at:new Date().toISOString()}).eq('id',b.line_id).select().single();
            if(error)throw error;return NextResponse.json({data})}if(b.action==='complete'){const m=await enforceMFA(a);if(m)return m;
                if(!b.verification_id)throw new Error('verification_id is required');
                const{data:v,error:ve}=await supabase.schema('finance').from('asset_verifications').select('*').eq('id',b.verification_id).eq('organization_id',a.orgId).single();
                if(ve||!v)throw new Error('Verification not found');
                const{data:lines,error:le}=await supabase.schema('finance').from('asset_verification_lines').select('is_verified,discrepancy_notes').eq('verification_id',v.id);
                if(le)throw le;
                if(!(lines??[]).length)throw new Error('No assets in verification');
                const bad=(lines??[]).filter(x=>!x.is_verified);
                const{data,error}=await supabase.schema('finance').from('asset_verifications').update({status:bad.length?'discrepancy_found':'completed',notes:b.notes??v.notes,updated_at:new Date().toISOString()}).eq('id',v.id).eq('organization_id',a.orgId).select().single();
                if(error)throw error;
                return NextResponse.json({data,unverified_count:bad.length})}throw new Error('Unsupported action')}catch(e:any){return NextResponse.json({error:e.message||'Verification failed'},{status:400})}}
