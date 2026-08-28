import { NextRequest, NextResponse } from 'next/server';
import { getAuthSupabase, requirePermission } from '@/lib/api-auth';

export async function POST(req:NextRequest){
 const auth=await requirePermission('INVOICE_UPDATE'); if(auth instanceof NextResponse)return auth;
 const {supabase}=await getAuthSupabase(req); const b=await req.json();
 if(!b.invoice_id||!Array.isArray(b.lines)||!b.lines.length)return NextResponse.json({error:'invoice_id and at least one line are required'},{status:400});
 const {data:inv,error:ie}=await supabase.from('invoices').select('id,currency,exchange_rate,status,organization_id').eq('id',b.invoice_id).eq('organization_id',auth.orgId).single();
 if(ie||!inv)return NextResponse.json({error:'Invoice not found'},{status:404});
 if(!['DRAFT','SUBMITTED'].includes(inv.status))return NextResponse.json({error:'Invoice lines can only be changed before approval'},{status:409});
 let subtotal=0,discount=0,tax=0;
 const lines=b.lines.map((l:any,i:number)=>{const qty=Number(l.quantity||1),price=Number(l.unit_price||0);const sub=qty*price;const disc=Math.min(Math.max(Number(l.discount_amount||0),0),sub);const rate=Math.max(Number(l.tax_rate||0),0);const taxAmt=(sub-disc)*rate/100;const total=sub-disc+taxAmt;subtotal+=sub;discount+=disc;tax+=taxAmt;return {invoice_id:inv.id,organization_id:auth.orgId,line_number:i+1,description:String(l.description||'Item'),quantity:qty,unit_price:price,line_subtotal:sub,discount_amount:disc,tax_code_id:l.tax_code_id||null,tax_rate:rate,tax_amount:taxAmt,line_total:total,base_line_subtotal:sub*Number(inv.exchange_rate||1),base_tax_amount:taxAmt*Number(inv.exchange_rate||1),base_line_total:total*Number(inv.exchange_rate||1),account_id:l.account_id||null,project_id:l.project_id||null,created_by:auth.userId};});
 if(lines.some((l:any)=>l.quantity<=0||l.unit_price<0||l.discount_amount<0||l.tax_rate<0))return NextResponse.json({error:'Invalid invoice line values'},{status:400});
 const total=subtotal-discount+tax; const {error:de}=await supabase.schema('finance').from('invoice_lines').delete().eq('invoice_id',inv.id).eq('organization_id',auth.orgId);if(de)return NextResponse.json({error:de.message},{status:400});
 const {data,error}=await supabase.schema('finance').from('invoice_lines').insert(lines).select();if(error)return NextResponse.json({error:error.message},{status:400});
 const {data:updated,error:ue}=await supabase.from('invoices').update({amount:total,subtotal,tax_amount:tax,discount_amount:discount,total_amount:total,outstanding_amount:total,base_subtotal:subtotal*Number(inv.exchange_rate||1),base_tax_amount:tax*Number(inv.exchange_rate||1),base_discount_amount:discount*Number(inv.exchange_rate||1),base_total_amount:total*Number(inv.exchange_rate||1),base_outstanding_amount:total*Number(inv.exchange_rate||1)}).eq('id',inv.id).eq('organization_id',auth.orgId).select().single();
 if(ue)return NextResponse.json({error:ue.message},{status:400}); return NextResponse.json({data:updated,lines,totals:{subtotal,discount,tax,total}},{status:201});
}
