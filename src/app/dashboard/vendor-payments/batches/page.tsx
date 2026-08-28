"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Layers3, Loader2, Send, CheckCircle } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { usePermissions } from "@/context/PermissionContext";
import toast from "react-hot-toast";

export default function VendorPaymentBatchesPage(){
  const {hasPermission}=usePermissions();
  const [batches,setBatches]=useState<any[]>([]); 
  const [bills,setBills]=useState<any[]>([]); 
  const [accounts,setAccounts]=useState<any[]>([]); 
  const [selected,setSelected]=useState<string[]>([]); 
  const [account,setAccount]=useState(""); 
  const [loading,setLoading]=useState(true);
  const load=useCallback(async()=>{setLoading(true);
    try{const [br,billRes,accRes]=await Promise.all([fetch('/api/finance/vendor-payments/batches'),supabase.schema('finance').from('vendor_bills').select('id,bill_number,vendor_id,outstanding_amount,currency,due_date,vendors:vendor_id(name)').in('status',['POSTED','PARTIALLY_PAID']).gt('outstanding_amount',0).order('due_date'),supabase.schema('finance').from('financial_accounts').select('id,account_name,currency').eq('is_active',true).order('account_name')]);
        const bj=await br.json();
        if(!br.ok)throw new Error(bj.error);
        setBatches(bj.data||[]);
        setBills(billRes.data||[]);setAccounts(accRes.data||[]);}
        catch(e:any){toast.error(e.message)}finally{setLoading(false)}},[]);
        useEffect(()=>{load()},[load]);
  async function create()
  {
    if(!selected.length||!account)
        return toast.error('Select bills and a payment account');
    const r=await fetch('/api/finance/vendor-payments/batches',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({payment_date:new Date().toISOString().slice(0,10),financial_account_id:account,bill_ids:selected})});const j=await r.json();if(!r.ok)return toast.error(j.error);toast.success(`Batch ${j.batch.batch_number} created`);setSelected([]);load()}
  async function action(id:string,action:'submit'|'approve')
  {
    const r=await fetch(`/api/finance/vendor-payments/batches/${id}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({action})});
    const j=await r.json();
    if(!r.ok)return toast.error(j.error);
    toast.success(`Batch ${action} successful`);
    load()
  }
  return <div className="p-6 space-y-6">
    <Link href="/dashboard/vendor-payments" className="inline-flex gap-2 items-center text-sm text-blue-600">
    <ArrowLeft size={16}/> Back to Vendor Payments</Link>
    <div>
        <h1 className="text-2xl font-bold flex gap-2 items-center"><Layers3/> Payment Batches</h1>
        <p className="text-sm text-gray-500">Build one approval-controlled proposal from multiple outstanding vendor bills.</p>
    </div>
  {hasPermission('VENDOR_PAYMENT_CREATE')&&<div className="bg-white dark:bg-gray-800 rounded-xl border dark:border-gray-700 p-5 space-y-4">
    <div className="grid md:grid-cols-2 gap-3">
        <select className="input" value={account} onChange={e=>setAccount(e.target.value)}>
            <option value="">Payment account</option>{accounts.map(a=><option key={a.id} value={a.id}>{a.account_name} ({a.currency})</option>)}</select>
            <button onClick={create} className="bg-blue-600 text-white rounded-lg px-4 py-2">Create Payment Proposal ({selected.length})</button>
            </div>
            <div className="max-h-72 overflow-auto border rounded-lg">
                <table className="w-full text-sm">
                    <thead>
                        <tr className="bg-gray-50"><th className="p-2"></th>
                        <th className="p-2 text-left">Bill</th><th className="p-2 text-left">Vendor</th>
                        <th className="p-2 text-right">Outstanding</th>
                        <th className="p-2">Due</th>
                        </tr></thead><tbody>{bills.map(b=><tr key={b.id} className="border-t"><td className="p-2 text-center">
                            <input type="checkbox" checked={selected.includes(b.id)} onChange={e=>setSelected(s=>e.target.checked?[...s,b.id]:s.filter(x=>x!==b.id))}/></td>
                        <td className="p-2">{b.bill_number}</td>
                        <td className="p-2">{b.vendors?.name}</td>
                        <td className="p-2 text-right">{Number(b.outstanding_amount).toLocaleString()}</td>
                        <td className="p-2 text-center">{b.due_date||'-'}</td>
                        </tr>
                    )
                    }
                    </tbody>
                    </table>
                    </div>
                    </div>}
  <div className="bg-white dark:bg-gray-800 rounded-xl border dark:border-gray-700 overflow-hidden">
    <table className="w-full text-sm">
        <thead className="bg-gray-50 dark:bg-gray-900"><tr>
            <th className="p-3 text-left">Batch</th>
            <th className="p-3">Payments</th>
            <th className="p-3 text-right">Total</th>
            <th className="p-3">Status</th>
            <th className="p-3"></th>
            </tr></thead><tbody>{loading?<tr>
                <td colSpan={5} className="p-8 text-center"><Loader2 className="animate-spin mx-auto"/></td>
                </tr>:batches.map(b=><tr key={b.id} className="border-t">
                    <td className="p-3 font-mono">{b.batch_number}</td>
                <td className="p-3 text-center">{b.payment_count}</td>
                <td className="p-3 text-right">{Number(b.total_amount).toLocaleString()}</td>
                <td className="p-3 text-center">{b.status}</td>
                <td className="p-3 text-right space-x-3">{b.status==='DRAFT'&&<button onClick={()=>action(b.id,'submit')} className="text-blue-600 inline-flex gap-1"><Send size={14}/> Submit</button>}{b.status==='SUBMITTED'&&hasPermission('APPROVE_PAYMENT')&&
                <button onClick={()=>action(b.id,'approve')} className="text-green-600 inline-flex gap-1"><CheckCircle size={14}/> Approve</button>}</td>
                </tr>
                )}
                </tbody>
                </table>
                </div>
                <style jsx>{`.input{width:100%;padding:.65rem .8rem;border:1px solid #d1d5db;border-radius:.5rem;background:transparent}`}</style></div>
}
