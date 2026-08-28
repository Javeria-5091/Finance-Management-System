"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Plus, Play, Loader2 } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { usePermissions } from "@/context/PermissionContext";
import toast from "react-hot-toast";

type Template = any;

export default function RecurringVendorBillsPage() {
  const { hasPermission } = usePermissions();
  const [rows, setRows] = useState<Template[]>([]);
  const [vendors, setVendors] = useState<any[]>([]);
  const [accounts, setAccounts] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({ template_name:"", vendor_id:"", frequency:"MONTHLY", next_run_date:new Date().toISOString().slice(0,10), due_days:"30", account_id:"", description:"", unit_price:"" });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [r, v, a] = await Promise.all([
        fetch("/api/finance/vendor-bills/recurring"),
        supabase.schema("finance").from("vendors").select("id,name").eq("is_active",true).order("name"),
        supabase.schema("finance").from("chart_of_accounts").select("id,code,name").eq("is_active",true).eq("posting_allowed",true).in("account_type",["OPERATING_EXPENSE","COST_OF_SALES","OTHER_EXPENSE"]).order("code"),
      ]);
      const json = await r.json();
      if (!r.ok) throw new Error(json.error || "Failed to load templates");
      setRows(json.data || []); setVendors(v.data || []); setAccounts(a.data || []);
    } catch(e:any) { toast.error(e.message); } finally { setLoading(false); }
  }, []);
  useEffect(()=>{load();},[load]);

  async function createTemplate(e: React.FormEvent) {
    e.preventDefault();
    if (!hasPermission("VENDOR_BILL_CREATE")) return toast.error("Permission denied");
    if (!form.vendor_id || !form.account_id || !form.unit_price) return toast.error("Vendor, expense account and amount are required");
    setSaving(true);
    try {
      const res = await fetch("/api/finance/vendor-bills/recurring", { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({
        template_name:form.template_name, vendor_id:form.vendor_id, frequency:form.frequency, next_run_date:form.next_run_date,
        due_days:Number(form.due_days), description:form.description || null, currency:"PKR", exchange_rate:1,
        template_lines:[{account_id:form.account_id, description:form.description || form.template_name, quantity:1, unit_price:Number(form.unit_price), tax_rate:0, withholding_rate:0}]
      })});
      const json=await res.json(); if(!res.ok) throw new Error(json.error || "Failed");
      toast.success("Recurring vendor bill template created");
      setForm({...form, template_name:"", unit_price:"", description:""}); await load();
    } catch(e:any){toast.error(e.message);} finally{setSaving(false);}
  }

  async function generate(id:string){
    try{const r=await fetch("/api/finance/vendor-bills/recurring/generate",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({id})});const j=await r.json();if(!r.ok)throw new Error(j.error||"Generation failed");toast.success(`Draft ${j.bill.bill_number} generated`);load();}catch(e:any){toast.error(e.message);}}

  return <div className="p-6 space-y-6">
    <Link href="/dashboard/vendor-bills" className="inline-flex items-center gap-2 text-sm text-blue-600"><ArrowLeft size={16}/> Back to Vendor Bills</Link>
    <div><h1 className="text-2xl font-bold">Recurring Vendor Bills</h1><p className="text-sm text-gray-500">Create controlled recurring bill templates. Generation creates DRAFT bills only; normal verification/approval/posting still applies.</p></div>
    {hasPermission("VENDOR_BILL_CREATE") && <form onSubmit={createTemplate} className="grid md:grid-cols-3 gap-4 bg-white dark:bg-gray-800 p-5 rounded-xl border dark:border-gray-700">
      <input required placeholder="Template name" className="input" value={form.template_name} onChange={e=>setForm({...form,template_name:e.target.value})}/>
      <select required className="input" value={form.vendor_id} onChange={e=>setForm({...form,vendor_id:e.target.value})}><option value="">Vendor</option>{vendors.map(v=><option key={v.id} value={v.id}>{v.name}</option>)}</select>
      <select required className="input" value={form.account_id} onChange={e=>setForm({...form,account_id:e.target.value})}><option value="">Expense account</option>{accounts.map(a=><option key={a.id} value={a.id}>{a.code} — {a.name}</option>)}</select>
      <select className="input" value={form.frequency} onChange={e=>setForm({...form,frequency:e.target.value})}><option>MONTHLY</option><option>QUARTERLY</option><option>YEARLY</option></select>
      <input type="date" required className="input" value={form.next_run_date} onChange={e=>setForm({...form,next_run_date:e.target.value})}/>
      <input type="number" min="0" step="0.01" required placeholder="Amount" className="input" value={form.unit_price} onChange={e=>setForm({...form,unit_price:e.target.value})}/>
      <input type="number" min="0" max="3650" placeholder="Due days" className="input" value={form.due_days} onChange={e=>setForm({...form,due_days:e.target.value})}/>
      <input placeholder="Description" className="input md:col-span-2" value={form.description} onChange={e=>setForm({...form,description:e.target.value})}/>
      <button disabled={saving} className="md:col-span-3 inline-flex justify-center items-center gap-2 bg-blue-600 text-white rounded-lg px-4 py-2.5">{saving?<Loader2 className="animate-spin" size={16}/>:<Plus size={16}/>} Create Template</button>
    </form>}
    <div className="bg-white dark:bg-gray-800 rounded-xl border dark:border-gray-700 overflow-hidden"><table className="w-full text-sm"><thead className="bg-gray-50 dark:bg-gray-900"><tr><th className="p-3 text-left">Template</th><th className="p-3 text-left">Vendor</th><th className="p-3">Frequency</th><th className="p-3">Next Run</th><th className="p-3">Status</th><th className="p-3"></th></tr></thead><tbody className="divide-y dark:divide-gray-700">{loading?<tr><td colSpan={6} className="p-8 text-center"><Loader2 className="animate-spin mx-auto"/></td></tr>:rows.map(r=><tr key={r.id}><td className="p-3 font-medium">{r.template_name}</td><td className="p-3">{r.vendors?.name || r.vendor_id}</td><td className="p-3 text-center">{r.frequency}</td><td className="p-3 text-center">{r.next_run_date}</td><td className="p-3 text-center">{r.is_active?'ACTIVE':'INACTIVE'}</td><td className="p-3 text-right"><button onClick={()=>generate(r.id)} className="inline-flex items-center gap-1 text-blue-600"><Play size={14}/> Generate Draft</button></td></tr>)}</tbody></table></div>
    <style jsx>{`.input{width:100%;padding:.65rem .8rem;border:1px solid #d1d5db;border-radius:.5rem;background:transparent}.dark .input{border-color:#4b5563}`}</style>
  </div>
}
