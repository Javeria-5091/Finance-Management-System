import {NextRequest,NextResponse} from 'next/server';
import {getAuthSupabase,requirePermission} from '@/lib/api-auth';
import {enforceMFA} from '@/lib/mfa-middleware';
import {z} from 'zod';

const s=z.object({
  action:z.enum(['create','approve','post']),
  id:z.string().uuid().optional(),
  owner_id:z.string().uuid().optional(),
  transaction_type:z.enum(['CAPITAL_CONTRIBUTION','OWNER_LOAN_ADVANCE','OWNER_LOAN_REPAYMENT','DRAWING']).optional(),
  amount:z.number().positive().optional(),
  currency:z.string().regex(/^[A-Z]{3}$/).default('PKR'),
  transaction_date:z.string().date().optional(),
  description:z.string().max(500).optional(),
  financial_account_id:z.string().uuid().optional(),
  equity_account_id:z.string().uuid().optional(),
  period_id:z.string().uuid().optional(),
});

function getData<T = any>(res: any): T | null {
  return res?.data ?? null;
}

// Determines which side of the journal the bank/cash leg (financial account)
// and the equity/loan leg are posted to, from the company's books:
//   CAPITAL_CONTRIBUTION : owner puts cash in    -> DR cash,   CR equity
//   OWNER_LOAN_ADVANCE    : owner lends cash in    -> DR cash,   CR equity (loan payable)
//   OWNER_LOAN_REPAYMENT  : company repays owner    -> DR equity, CR cash
//   DRAWING                : owner withdraws cash   -> DR equity, CR cash
function resolveLegs(transactionType: string): 'CASH_DEBIT' | 'CASH_CREDIT' {
  if (transactionType === 'CAPITAL_CONTRIBUTION' || transactionType === 'OWNER_LOAN_ADVANCE') return 'CASH_DEBIT';
  return 'CASH_CREDIT';
}

export async function POST(req:NextRequest)
{
    const a=await requirePermission('EQUITY_MANAGE');
    if(a instanceof NextResponse)
        return a;
    const {supabase}=await getAuthSupabase(req);
    const p=s.safeParse(await req.json());
    if(!p.success)
        return NextResponse.json({error:p.error.issues[0]?.message},{status:400});
    const b=p.data;
    try{
        if(b.action==='post'){
            const m=await enforceMFA(a);
            if(m)
                return m;
            if(!b.id||!b.period_id)
                throw new Error('id and period_id required');

            const {data:row,error:rowErr}=await supabase.schema('finance').from('capital_transactions')
                .select('*').eq('id',b.id).eq('organization_id',a.orgId).single();
            if(rowErr||!row)
                throw new Error('Capital transaction not found');
            if(row.status!=='APPROVED')
                throw new Error(`Only APPROVED capital transactions can be posted. Current: ${row.status}`);

            const owner=getData(await supabase.schema('finance').from('owners')
                .select('id,organization_id,status').eq('id',row.owner_id).eq('organization_id',a.orgId).maybeSingle());
            if(!owner || owner.status !== 'ACTIVE')
                throw new Error('Owner not found, inactive, or outside your organization');
            if(!row.financial_account_id||!row.equity_account_id)
                throw new Error('Capital transaction is missing its bank/cash or equity account and cannot be posted.');

            // Idempotency: never post the same transaction twice.
            const existingJournal=getData(await supabase.schema('finance').from('journal_entries')
                .select('id,reference').eq('source_type','CAPITAL_TRANSACTION').eq('source_id',b.id).maybeSingle());
            if(existingJournal){
                return NextResponse.json({journal_id:existingJournal.id,reference:existingJournal.reference,already_posted:true});
            }

            const period=getData(await supabase.schema('finance').from('accounting_periods')
                .select('id,status,organization_id').eq('id',b.period_id).eq('organization_id',a.orgId).maybeSingle());
            if(!period)
                throw new Error('Accounting period not found or does not belong to your organization');
            if(period.status!=='OPEN')
                throw new Error(`Accounting period is ${period.status}, not OPEN`);

            // Re-validate both legs at posting time (defense-in-depth: an
            // account could have been deactivated after the transaction was
            // created/approved).
            const financialAccount=getData(await supabase.schema('finance').from('financial_accounts')
                .select('id,linked_ledger_account_id,is_active').eq('id',row.financial_account_id).eq('organization_id',a.orgId).maybeSingle());
            if(!financialAccount||!financialAccount.is_active)
                throw new Error('Bank/cash account is missing or inactive');
            if(!financialAccount.linked_ledger_account_id)
                throw new Error('Bank/cash account has no linked GL ledger account configured');

            const equityAccount=getData(await supabase.schema('finance').from('chart_of_accounts')
                .select('id,account_type,is_active,posting_allowed').eq('id',row.equity_account_id).eq('organization_id',a.orgId).maybeSingle());
            if(!equityAccount||!equityAccount.is_active||equityAccount.posting_allowed===false)
                throw new Error('Equity/loan account is missing, inactive, or not postable');
            if(!['EQUITY','LIABILITY'].includes(equityAccount.account_type))
                throw new Error('Equity/loan account must be an EQUITY or LIABILITY account');

            const amount = Number(row.amount);

            const {data:journalId,error:postErr}=await supabase.schema('finance').rpc('post_capital_transaction_atomic',{
                p_transaction_id:b.id,
                p_period_id:b.period_id,
            });
            if(postErr||!journalId)
                throw new Error('Atomic capital transaction posting failed: '+(postErr?.message||'Unknown error'));

            try{
                await supabase.schema('audit').rpc('log_action',{
                    p_user_id:a.userId,p_action:'CAPITAL_TRANSACTION_POSTED',p_entity_type:'capital_transaction',
                    p_entity_id:b.id,p_description:`Posted ${row.transaction_type} of ${amount} ${row.currency||'PKR'} to GL`,
                    p_source_module:'equity',p_severity:'high',
                    p_new_values:{journal_id:journalId,owner_id:row.owner_id,amount,transaction_type:row.transaction_type},
                    p_related_journal_id:journalId,
                });
            }catch(auditErr){console.error('Audit log failed for capital transaction post:',auditErr);}

            return NextResponse.json({journal_id:journalId});
        }

        if(b.action==='create'){
            if(!b.owner_id||!b.transaction_type||!b.amount||!b.transaction_date||!b.financial_account_id||!b.equity_account_id)
                throw new Error('owner, type, amount, date, financial account and equity account are required');

            const owner=getData(await supabase.schema('finance').from('owners')
                .select('id,organization_id,status').eq('id',b.owner_id).eq('organization_id',a.orgId).maybeSingle());
            if(!owner || owner.status !== 'ACTIVE')
                throw new Error('Owner not found, inactive, or outside your organization');

            const financialAccount=getData(await supabase.schema('finance').from('financial_accounts')
                .select('id,is_active').eq('id',b.financial_account_id).eq('organization_id',a.orgId).maybeSingle());
            if(!financialAccount||!financialAccount.is_active)
                throw new Error('Bank/cash account not found, inactive, or outside your organization');

            const equityAccount=getData(await supabase.schema('finance').from('chart_of_accounts')
                .select('id,account_type,is_active,posting_allowed').eq('id',b.equity_account_id).eq('organization_id',a.orgId).maybeSingle());
            if(!equityAccount||!equityAccount.is_active||equityAccount.posting_allowed===false)
                throw new Error('Equity/loan account not found, inactive, not postable, or outside your organization');
            if(!['EQUITY','LIABILITY'].includes(equityAccount.account_type))
                throw new Error('Equity/loan account must be an EQUITY or LIABILITY account');

            const {data,error}=await supabase.schema('finance').from('capital_transactions').insert({
                owner_id:b.owner_id,
                transaction_type:b.transaction_type,
                amount:b.amount,
                base_amount:b.amount,
                currency:b.currency,
                transaction_date:b.transaction_date,
                description:b.description,
                financial_account_id:b.financial_account_id,
                equity_account_id:b.equity_account_id,
                status:'DRAFT',
                declared_by:a.userId,
                declared_at:new Date().toISOString(),
                created_by:a.userId,
                organization_id:a.orgId,
            }).select().single();
            if(error)throw error;return NextResponse.json({data});
        }

        if(!b.id)
            throw new Error('id required');
        const {data:row,error:re}=await supabase.schema('finance').from('capital_transactions').select('*').eq('id',b.id).eq('organization_id',a.orgId).single();
        if(re||!row)
            throw new Error('Capital transaction not found');
        if(b.action==='approve'){
            if(row.status!=='DRAFT')
                throw new Error('Only DRAFT transactions can be approved');
            if(row.created_by===a.userId)
                throw new Error('Maker-checker: creator cannot approve own transaction');
            if(!row.financial_account_id||!row.equity_account_id)
                throw new Error('Capital transaction is missing its bank/cash or equity account and cannot be approved.');
            const {data,error}=await supabase.schema('finance').from('capital_transactions').update({status:'APPROVED',approved_by:a.userId,approved_at:new Date().toISOString()}).eq('id',b.id).eq('organization_id',a.orgId).select().single();
            if(error)throw error;return NextResponse.json({data});
        }
        throw new Error('Invalid action');
    }
    catch(e:any){
        return NextResponse.json({error:e.message||'Capital transaction failed'},{status:400})
    }
}
