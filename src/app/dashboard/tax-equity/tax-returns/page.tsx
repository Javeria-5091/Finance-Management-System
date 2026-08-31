"use client";
import { useEffect, useState, useCallback } from "react";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/context/AuthContext";
import { usePermissions } from "@/context/PermissionContext";
import { FileCheck, Plus, Search, Eye, X, CalendarDays } from "lucide-react";
import toast from "react-hot-toast";

interface TaxReturn {
  id: string;
  tax_type: string;
  period_from: string;
  period_to: string;
  filing_date: string;
  status: string;
  declared_tax: number;
  declared_income: number;
  declared_taxable: number;
  remarks: string;
  created_at: string;
}

const TAX_TYPES = ["corporate", "sales", "withholding", "presumptive"];
const STATUS_STYLES: Record<string, string> = {
  DRAFT: "bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300",
  FILED: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400",
  ACCEPTED: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400",
  REJECTED: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400",
  PENDING: "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400",
};

export default function TaxReturnsPage() {
  const { user } = useAuth();
  const { hasPermission } = usePermissions();
  const canCreate = hasPermission("TAX_MANAGE");

  const [returns, setReturns] = useState<TaxReturn[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ tax_type: "corporate", period_from: "", period_to: "", filing_date: "", total_tax: 0, total_income: 0, total_deductions: 0, remarks: "" });
  const [saving, setSaving] = useState(false);
  const [viewItem, setViewItem] = useState<TaxReturn | null>(null);

  const fetchReturns = useCallback(async () => {
    if (!user) return;
    const { data, error } = await supabase.schema("finance").from("tax_returns").select("*").eq("organization_id", (await supabase.from("profiles").select("organization_id").eq("user_id", user.id).single()).data?.organization_id || "").order("created_at", { ascending: false });
    if (error) toast.error("Failed to load tax returns: " + error.message);
    else setReturns(data || []);
    setLoading(false);
  }, [user]);

  useEffect(() => { fetchReturns(); }, [fetchReturns]);

  const filtered = returns.filter((r) =>
    r.tax_type.toLowerCase().includes(search.toLowerCase()) ||
    r.status.toLowerCase().includes(search.toLowerCase())
  );

  function formatCurrency(amount: number) {
    return new Intl.NumberFormat("en-PK", { style: "currency", currency: "PKR", minimumFractionDigits: 0 }).format(amount);
  }

  async function handleSave() {
    if (!form.period_from || !form.period_to) { toast.error("Period dates are required"); return; }
    setSaving(true);
    const { data: profile } = await supabase.from("profiles").select("organization_id").eq("user_id", user?.id || "").single();
    if (!profile?.organization_id) { toast.error("Organization context missing"); setSaving(false); return; }
    const { error } = await supabase.schema("finance").from("tax_returns").insert({
      organization_id: profile.organization_id,
      tax_type: form.tax_type,
      tax_year: form.period_from.slice(0, 4),
      period_start: form.period_from,
      period_end: form.period_to,
      declared_income: Number(form.total_income),
      declared_taxable: Math.max(Number(form.total_income) - Number(form.total_deductions), 0),
      declared_tax: Number(form.total_tax),
      status: "DRAFT",
      created_by: user?.id,
      prepared_by: user?.id,
      prepared_at: new Date().toISOString(),
      notes: form.remarks || null,
    });
    if (error) toast.error("Save failed: " + error.message);
    else { toast.success("Tax return created"); setShowForm(false); fetchReturns(); }
    setSaving(false);
  }

  return (
    <div>
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3 mb-6">
        <div>
          <h2 className="text-2xl font-bold text-gray-900 dark:text-white">Tax Returns</h2>
          <p className="text-gray-500 text-sm">File and manage tax returns for various tax authorities</p>
        </div>
        {canCreate && (
          <button onClick={() => setShowForm(true)} className="flex items-center gap-2 bg-blue-600 text-white px-4 py-2.5 rounded-lg font-medium">
            <Plus size={18} /> New Tax Return
          </button>
        )}
      </div>

      <div className="relative mb-4">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={18} />
        <input type="text" placeholder="Search by tax type or status..." value={search} onChange={(e) => setSearch(e.target.value)}
          className="w-full pl-10 pr-4 py-2.5 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg text-sm text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500" />
      </div>

      <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl overflow-hidden">
        <table className="w-full text-left text-sm">
          <thead className="bg-gray-100 dark:bg-gray-900/70 border-b border-gray-200 dark:border-gray-700 text-xs text-gray-500 uppercase">
            <tr>
              <th className="px-4 py-3">Tax Type</th>
              <th className="px-4 py-3 hidden md:table-cell">Period</th>
              <th className="px-4 py-3 text-right">Tax Amount</th>
              <th className="px-4 py-3 text-center">Status</th>
              <th className="px-4 py-3 hidden sm:table-cell">Filing Date</th>
              <th className="px-4 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
            {loading && <tr><td colSpan={6} className="p-8 text-center text-gray-400">Loading...</td></tr>}
            {!loading && filtered.length === 0 && <tr><td colSpan={6} className="p-8 text-center text-gray-400">No tax returns found.</td></tr>}
            {filtered.map((r) => (
              <tr key={r.id} className="hover:bg-gray-50 dark:hover:bg-gray-700/50">
                <td className="px-4 py-3">
                  <div className="flex items-center gap-2">
                    <FileCheck size={16} className="text-blue-500" />
                    <span className="font-medium text-gray-900 dark:text-white">{r.tax_type}</span>
                  </div>
                </td>
                <td className="px-4 py-3 hidden md:table-cell text-gray-600 dark:text-gray-400 text-xs">
                  {r.period_from} to {r.period_to}
                </td>
                <td className="px-4 py-3 text-right font-semibold text-gray-900 dark:text-white">{formatCurrency(r.declared_tax)}</td>
                <td className="px-4 py-3 text-center">
                  <span className={`px-2 py-0.5 rounded text-xs font-medium ${STATUS_STYLES[r.status] || STATUS_STYLES.DRAFT}`}>{r.status}</span>
                </td>
                <td className="px-4 py-3 hidden sm:table-cell text-gray-500 text-xs">{r.filing_date || "-"}</td>
                <td className="px-4 py-3 text-right">
                  <button onClick={() => setViewItem(r)} className="p-1.5 rounded hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-500"><Eye size={15} /></button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* New Form */}
      {showForm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60">
          <div className="bg-white dark:bg-gray-800 border dark:border-gray-700 rounded-xl p-6 w-full max-w-lg">
            <div className="flex justify-between items-center mb-5">
              <h3 className="text-lg font-bold text-gray-900 dark:text-white">New Tax Return</h3>
              <button onClick={() => setShowForm(false)} className="p-1 rounded hover:bg-gray-100 dark:hover:bg-gray-700"><X size={20} /></button>
            </div>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Tax Type</label>
                <select value={form.tax_type} onChange={(e) => setForm({ ...form, tax_type: e.target.value })} className="w-full px-3 py-2 bg-gray-50 dark:bg-gray-900 border border-gray-300 dark:border-gray-700 rounded-lg text-sm text-gray-900 dark:text-white">
                  {TAX_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div><label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Period From *</label>
                  <input type="date" value={form.period_from} onChange={(e) => setForm({ ...form, period_from: e.target.value })} className="w-full px-3 py-2 bg-gray-50 dark:bg-gray-900 border border-gray-300 dark:border-gray-700 rounded-lg text-sm text-gray-900 dark:text-white" />
                </div>
                <div><label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Period To *</label>
                  <input type="date" value={form.period_to} onChange={(e) => setForm({ ...form, period_to: e.target.value })} className="w-full px-3 py-2 bg-gray-50 dark:bg-gray-900 border border-gray-300 dark:border-gray-700 rounded-lg text-sm text-gray-900 dark:text-white" />
                </div>
              </div>
              <div className="grid grid-cols-3 gap-4">
                <div><label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Total Income</label>
                  <input type="number" value={form.total_income} onChange={(e) => setForm({ ...form, total_income: Number(e.target.value) })} className="w-full px-3 py-2 bg-gray-50 dark:bg-gray-900 border border-gray-300 dark:border-gray-700 rounded-lg text-sm text-gray-900 dark:text-white" />
                </div>
                <div><label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Deductions</label>
                  <input type="number" value={form.total_deductions} onChange={(e) => setForm({ ...form, total_deductions: Number(e.target.value) })} className="w-full px-3 py-2 bg-gray-50 dark:bg-gray-900 border border-gray-300 dark:border-gray-700 rounded-lg text-sm text-gray-900 dark:text-white" />
                </div>
                <div><label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Tax Amount</label>
                  <input type="number" value={form.total_tax} onChange={(e) => setForm({ ...form, total_tax: Number(e.target.value) })} className="w-full px-3 py-2 bg-gray-50 dark:bg-gray-900 border border-gray-300 dark:border-gray-700 rounded-lg text-sm text-gray-900 dark:text-white" />
                </div>
              </div>
              <div><label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Remarks</label>
                <textarea value={form.remarks} onChange={(e) => setForm({ ...form, remarks: e.target.value })} rows={2} className="w-full px-3 py-2 bg-gray-50 dark:bg-gray-900 border border-gray-300 dark:border-gray-700 rounded-lg text-sm text-gray-900 dark:text-white" />
              </div>
            </div>
            <div className="flex gap-3 mt-6">
              <button onClick={() => setShowForm(false)} className="flex-1 px-4 py-2.5 bg-gray-100 dark:bg-gray-700 rounded-lg text-sm font-medium">Cancel</button>
              <button onClick={handleSave} disabled={saving} className="flex-1 px-4 py-2.5 bg-blue-600 text-white rounded-lg text-sm font-medium disabled:opacity-50">{saving ? "Saving..." : "Create"}</button>
            </div>
          </div>
        </div>
      )}

      {/* View Modal */}
      {viewItem && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60">
          <div className="bg-white dark:bg-gray-800 border dark:border-gray-700 rounded-xl p-6 w-full max-w-md">
            <div className="flex justify-between items-center mb-4">
              <h3 className="text-lg font-bold text-gray-900 dark:text-white">Tax Return Details</h3>
              <button onClick={() => setViewItem(null)} className="p-1 rounded hover:bg-gray-100 dark:hover:bg-gray-700"><X size={20} /></button>
            </div>
            <div className="space-y-3 text-sm">
              <div className="flex justify-between"><span className="text-gray-500">Tax Type</span><span className="font-medium text-gray-900 dark:text-white">{viewItem.tax_type}</span></div>
              <div className="flex justify-between"><span className="text-gray-500">Period</span><span className="text-gray-900 dark:text-white">{viewItem.period_from} to {viewItem.period_to}</span></div>
              <div className="flex justify-between"><span className="text-gray-500">Total Income</span><span className="text-green-600 font-semibold">{formatCurrency(viewItem.declared_income)}</span></div>
              <div className="flex justify-between"><span className="text-gray-500">Deductions</span><span className="text-red-600 font-semibold">{formatCurrency(viewItem.declared_income - viewItem.declared_taxable)}</span></div>
              <div className="flex justify-between"><span className="text-gray-500">Tax Amount</span><span className="text-blue-600 font-bold">{formatCurrency(viewItem.declared_tax)}</span></div>
              <div className="flex justify-between"><span className="text-gray-500">Status</span><span className={`px-2 py-0.5 rounded text-xs font-medium ${STATUS_STYLES[viewItem.status]}`}>{viewItem.status}</span></div>
              {viewItem.remarks && <div><span className="text-gray-500">Remarks</span><p className="text-gray-900 dark:text-white mt-1">{viewItem.remarks}</p></div>}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
