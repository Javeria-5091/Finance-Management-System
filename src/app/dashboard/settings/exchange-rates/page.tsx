"use client";
import { useState, useEffect, useCallback } from "react";
import { ArrowUpDown, Plus, RefreshCw, CheckCircle } from "lucide-react";
import toast from "react-hot-toast";

const today = () => new Date().toISOString().slice(0, 10);
const initialForm = () => ({ from_currency: "USD", to_currency: "PKR", rate: "", rate_date: today(), rate_type: "MANUAL", source_platform: "", evidence_reference: "" });

export default function ExchangeRatesPage() {
  const [rates, setRates] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState(initialForm());

  const fetchRates = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch('/api/admin/exchange-rates?pageSize=100');
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'Failed to load rates');
      setRates(j.data || []);
    } catch (e: any) { toast.error(e.message); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { fetchRates(); }, [fetchRates]);

  const handleAddRate = async () => {
    if (!form.rate || Number(form.rate) <= 0 || !form.rate_date) return toast.error('Enter a positive rate and date');
    if (!form.evidence_reference.trim()) return toast.error('Evidence reference is required');
    setSaving(true);
    try {
      const r = await fetch('/api/admin/exchange-rates', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'upsert', rates: [{ ...form, rate: Number(form.rate), source_platform: form.source_platform || null, evidence_reference: form.evidence_reference.trim() }] }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || j.results?.[0]?.error || 'Failed to save rate');
      const failed = (j.results || []).find((x: any) => x?.error);
      if (failed) throw new Error(failed.error);
      toast.success('Rate proposed and is pending second-person approval');
      setShowModal(false); setForm(initialForm()); await fetchRates();
    } catch (e: any) { toast.error(e.message); }
    finally { setSaving(false); }
  };

  const approve = async (id: string) => {
    try {
      const r = await fetch('/api/admin/exchange-rates', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'approve', id }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'Approval failed');
      toast.success('Exchange rate approved and locked'); await fetchRates();
    } catch (e: any) { toast.error(e.message); }
  };

  return <div className="p-6">
    <div className="flex items-center justify-between mb-6">
      <div className="flex items-center gap-3"><ArrowUpDown className="w-6 h-6 text-gray-500 dark:text-gray-400" /><div><h1 className="text-2xl font-bold">Exchange Rates</h1><p className="text-sm text-gray-500 dark:text-gray-400">Manual, evidenced, maker-checker approved FX rates</p></div></div>
      <div className="flex gap-2"><button onClick={fetchRates} className="p-2.5 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white"><RefreshCw size={16}/></button><button onClick={() => setShowModal(true)} className="flex items-center gap-2 bg-blue-600 text-white px-4 py-2 rounded-lg"><Plus size={16}/> Add Rate</button></div>
    </div>
    <div className="bg-white dark:bg-gray-800 border dark:border-gray-700 rounded-xl overflow-hidden">
      <table className="w-full text-sm"><thead className="bg-gray-50 dark:bg-gray-900/50"><tr><th className="text-left p-3">Date</th><th className="text-left p-3">From</th><th className="text-left p-3">To</th><th className="text-right p-3">Rate</th><th className="text-left p-3">Source</th><th className="text-center p-3">Status</th><th className="text-right p-3">Action</th></tr></thead>
      <tbody>{loading ? <tr><td colSpan={7} className="text-center py-10 text-gray-400 dark:text-gray-500">Loading rates...</td></tr> : rates.map(r => <tr key={r.id} className="border-t border-gray-200 dark:border-gray-700"><td className="p-3">{r.rate_date}</td><td className="p-3 font-medium">{r.from_currency}</td><td className="p-3 font-medium">{r.to_currency}</td><td className="p-3 text-right font-mono">{Number(r.rate).toFixed(4)}</td><td className="p-3 text-gray-500 dark:text-gray-400">{r.source_platform || r.rate_type}</td><td className="p-3 text-center">{r.is_locked ? <span className="inline-flex items-center gap-1 text-green-600"><CheckCircle size={15}/> Approved</span> : <span className="text-amber-600">Pending</span>}</td><td className="p-3 text-right">{!r.is_locked && <button onClick={() => approve(r.id)} className="text-sm text-blue-600 hover:underline">Approve</button>}</td></tr>)}</tbody></table>
    </div>
    {showModal && <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4"><div className="bg-white dark:bg-gray-800 rounded-xl p-6 w-full max-w-md"><h3 className="text-lg font-bold mb-4">Propose Exchange Rate</h3><div className="grid grid-cols-2 gap-4"><select value={form.from_currency} onChange={e=>setForm({...form,from_currency:e.target.value})} className="p-2 border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-700 text-gray-900 dark:text-white"><option>USD</option><option>EUR</option><option>GBP</option><option>AED</option><option>AUD</option><option>CAD</option></select><select value={form.to_currency} onChange={e=>setForm({...form,to_currency:e.target.value})} className="p-2 border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-700 text-gray-900 dark:text-white"><option>PKR</option></select><input type="number" step="0.000001" placeholder="Rate" value={form.rate} onChange={e=>setForm({...form,rate:e.target.value})} className="col-span-2 p-2 border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-700 text-gray-900 dark:text-white placeholder:text-gray-400 dark:placeholder:text-gray-500"/><input type="date" value={form.rate_date} onChange={e=>setForm({...form,rate_date:e.target.value})} className="col-span-2 p-2 border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-700 text-gray-900 dark:text-white placeholder:text-gray-400 dark:placeholder:text-gray-500"/><input placeholder="Source platform/bank" value={form.source_platform} onChange={e=>setForm({...form,source_platform:e.target.value})} className="col-span-2 p-2 border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-700 text-gray-900 dark:text-white placeholder:text-gray-400 dark:placeholder:text-gray-500"/><input placeholder="Evidence reference *" value={form.evidence_reference} onChange={e=>setForm({...form,evidence_reference:e.target.value})} className="col-span-2 p-2 border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-700 text-gray-900 dark:text-white placeholder:text-gray-400 dark:placeholder:text-gray-500"/></div><div className="flex justify-end gap-2 mt-5"><button onClick={()=>setShowModal(false)} className="px-4 py-2 rounded bg-gray-200 dark:bg-gray-700">Cancel</button><button onClick={handleAddRate} disabled={saving} className="px-4 py-2 rounded bg-blue-600 text-white">{saving?'Saving...':'Propose Rate'}</button></div></div></div>}
  </div>;
}
