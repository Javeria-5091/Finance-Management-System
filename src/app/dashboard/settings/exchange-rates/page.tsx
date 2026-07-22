"use client";
import { useState, useEffect } from "react";
import { ArrowUpDown, Plus, RefreshCw, CheckCircle } from "lucide-react";
import { supabase } from "@/lib/supabase";

export default function ExchangeRatesPage() {
  const [rates, setRates] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    from_currency: "USD",
    to_currency: "PKR",
    rate: "",
    rate_date: new Date().toISOString().split("T")[0],
    rate_type: "MANUAL",
    source_platform: ""
  });

  const fetchRates = async () => {
    setLoading(true);
    const { data } = await supabase
      .from("exchange_rates")
      .select("*")
      .order("rate_date", { ascending: false })
      .limit(50);
    if (data) setRates(data);
    setLoading(false);
  };

  useEffect(() => { fetchRates(); }, []);

  const handleAddRate = async () => {
  if (!form.rate || !form.rate_date) return alert("Fill required fields");
  setSaving(true);
  
  // Pehle user ki ID nikalte hain
  const userId = (await supabase.auth.getUser()).data.user?.id;

  const { error } = await supabase.from("exchange_rates").insert({
    ...form,
    rate: parseFloat(form.rate),
    entered_by: userId,
    //created_by: userId // Yeh line humne naye column ke liye add ki hai
  });

  if (!error) {
    setShowModal(false);
    setForm({ from_currency: "USD", to_currency: "PKR", rate: "", rate_date: new Date().toISOString().split("T")[0], rate_type: "MANUAL", source_platform: "" });
    fetchRates();
  } else {
    alert(error.message);
  }
  setSaving(false);
};


  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <ArrowUpDown className="w-6 h-6 text-gray-500 dark:text-gray-400" />
          <div>
            <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Exchange Rates</h1>
            <p className="text-sm text-gray-500 dark:text-gray-400">Manage multi-currency conversion rates</p>
          </div>
        </div>
        <div className="flex gap-2">
          <button onClick={fetchRates} className="p-2.5 border dark:border-gray-600 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-700 text-gray-600 dark:text-gray-300"><RefreshCw size={16} /></button>
          <button onClick={() => setShowModal(true)} className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg text-sm font-medium">
            <Plus size={16} /> Add Rate
          </button>
        </div>
      </div>

      <div className="bg-white dark:bg-gray-800 border dark:border-gray-700 rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 dark:bg-gray-900/50 border-b dark:border-gray-700">
            <tr>
              <th className="text-left p-3 text-gray-500 uppercase text-xs">Date</th>
              <th className="text-left p-3 text-gray-500 uppercase text-xs">From</th>
              <th className="text-left p-3 text-gray-500 uppercase text-xs">To</th>
              <th className="text-right p-3 text-gray-500 uppercase text-xs">Rate</th>
              <th className="text-left p-3 text-gray-500 uppercase text-xs">Source</th>
              <th className="text-center p-3 text-gray-500 uppercase text-xs">Status</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={6} className="text-center py-10 text-gray-400">Loading rates...</td></tr>
            ) : (
              rates.map(r => (
                <tr key={r.id} className="border-b dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-700/30">
                  <td className="p-3 text-gray-600 dark:text-gray-300">{new Date(r.rate_date).toLocaleDateString()}</td>
                  <td className="p-3 font-medium">{r.from_currency}</td>
                  <td className="p-3 font-medium">{r.to_currency}</td>
                  <td className="p-3 text-right font-mono font-semibold text-gray-900 dark:text-white">{parseFloat(r.rate).toFixed(2)}</td>
                  <td className="p-3 text-gray-500">{r.source_platform || r.rate_type}</td>
                  <td className="p-3 text-center">{r.is_locked ? <CheckCircle size={16} className="text-green-500 mx-auto" /> : null}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {showModal && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
          <div className="bg-white dark:bg-gray-800 border dark:border-gray-700 rounded-xl p-6 w-full max-w-md shadow-xl">
            <h3 className="text-lg font-bold text-gray-900 dark:text-white mb-4">Add Manual Exchange Rate</h3>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">From Currency</label>
                <select value={form.from_currency} onChange={(e) => setForm({...form, from_currency: e.target.value})} className="w-full p-2 border dark:border-gray-600 rounded-md bg-transparent dark:bg-gray-700 text-gray-900 dark:text-white text-sm">
                  <option>USD</option><option>EUR</option><option>GBP</option>
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">To Currency</label>
                <select value={form.to_currency} onChange={(e) => setForm({...form, to_currency: e.target.value})} className="w-full p-2 border dark:border-gray-600 rounded-md bg-transparent dark:bg-gray-700 text-gray-900 dark:text-white text-sm">
                  <option>PKR</option>
                </select>
              </div>
              <div className="col-span-2">
                <label className="block text-xs font-medium text-gray-500 mb-1">Rate (e.g., 278.50)</label>
                <input type="number" step="0.01" value={form.rate} onChange={(e) => setForm({...form, rate: e.target.value})} className="w-full p-2 border dark:border-gray-600 rounded-md bg-transparent dark:bg-gray-700 text-gray-900 dark:text-white text-sm" placeholder="1.00 for PKR to PKR" />
              </div>
              <div className="col-span-2">
                <label className="block text-xs font-medium text-gray-500 mb-1">Effective Date</label>
                <input type="date" value={form.rate_date} onChange={(e) => setForm({...form, rate_date: e.target.value})} className="w-full p-2 border dark:border-gray-600 rounded-md bg-transparent dark:bg-gray-700 text-gray-900 dark:text-white text-sm" />
              </div>
            </div>
            <div className="flex justify-end gap-3 mt-6 pt-4 border-t dark:border-gray-700">
              <button onClick={() => setShowModal(false)} className="px-4 py-2 bg-gray-200 dark:bg-gray-700 rounded-lg text-sm">Cancel</button>
              <button onClick={handleAddRate} disabled={saving} className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm disabled:opacity-50">
                {saving ? 'Saving...' : 'Save Rate'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}