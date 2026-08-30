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

    // BUG-019 FIX: settlements never computed an expected fee, so the
    // expected-vs-actual variance required by spec 5.12/6.1 never existed
    // — expected_fee_amount just sat at its column default of 0 forever.
    // Call the (now-fixed) fee engine here so it's populated the moment
    // the batch is created, before anyone even reconciles it.
    let expectedFee = 0;
    const {data:expectedFeeData,error:feeError}=await supabase.schema('finance').rpc('compute_platform_fee',{
        p_platform_id:x.platform_id,
        p_amount:x.gross_amount,
        p_source_type:'SETTLEMENT',
    });
    if(feeError){
        // Don't block settlement creation on a fee-engine hiccup (e.g. no
        // rule configured yet for this platform) — just leave expected
        // fee at 0 and surface the reason so it isn't silently wrong.
        console.error('compute_platform_fee failed for settlement batch:',feeError);
    } else {
        expectedFee = Number(expectedFeeData) || 0;
    }

    const {data,error}=await supabase.schema('finance').from('settlement_batches').insert({...x,net_amount:net,expected_fee_amount:expectedFee,organization_id:a.orgId,created_by:a.userId,status:'DRAFT'}).select().single();
    if(error)
        return NextResponse.json({error:error.message},{status:400});

    const feeVariance = Number((x.actual_fee_amount - expectedFee).toFixed(2));
    return NextResponse.json({
        data,
        fee_variance: feeVariance,
        fee_variance_warning: feeError
            ? 'Expected fee could not be computed (no active fee rule configured for this platform yet) — variance not available.'
            : (Math.abs(feeVariance) > 0.01 ? `Actual fee differs from expected fee by ${feeVariance > 0 ? '+' : ''}${feeVariance}` : undefined),
    },{status:201});
}