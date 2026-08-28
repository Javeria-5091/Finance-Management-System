import {NextRequest,NextResponse} from 'next/server';
import {getAuthSupabase,requirePermission} from '@/lib/api-auth';
import {z} from 'zod';

const s=z.object({platform_id:z.string().uuid(),financial_account_id:z.string().uuid().optional().nullable(),settlement_reference:z.string().min(1).max(120),settlement_date:z.string(),currency:z.string().regex(/^[A-Z]{3}$/),gross_amount:z.coerce.number().positive(),actual_fee_amount:z.coerce.number().min(0),withholding_amount:z.coerce.number().min(0),withdrawal_fee_amount:z.coerce.number().min(0),exchange_rate:z.coerce.number().positive().optional().nullable(),notes:z.string().max(2000).optional().nullable()}).strict();
export async function GET(req:NextRequest)
{
    const a=await requirePermission('SETTLEMENT_READ');
    if(a instanceof NextResponse)return a;
    const {supabase}=await getAuthSupabase(req);
    const {data,error}=await supabase.schema('finance').from('settlement_batches').select('*,settlement_lines(*)').eq('organization_id',a.orgId).order('settlement_date',{ascending:false});
    return error?NextResponse.json({error:error.message},{status:500}):NextResponse.json({data:data||[]});
}

export async function POST(req:NextRequest)
{const a=await requirePermission('SETTLEMENT_CREATE');
    if(a instanceof NextResponse)
        return a;
    const p=s.safeParse(await req.json());
    if(!p.success)return NextResponse.json({error:p.error.issues[0]?.message},{status:400});
    const {supabase}=await getAuthSupabase(req);
    const x=p.data;
    const net=x.gross_amount-x.actual_fee_amount-x.withholding_amount-x.withdrawal_fee_amount;
    if(net<0)
        return NextResponse.json({error:'Deductions cannot exceed gross amount'},{status:400});
    const {data,error}=await supabase.schema('finance').from('settlement_batches').insert({...x,net_amount:net,organization_id:a.orgId,created_by:a.userId,status:'DRAFT'}).select().single();
    return error?NextResponse.json({error:error.message},{status:400}):NextResponse.json({data},{status:201});
}
