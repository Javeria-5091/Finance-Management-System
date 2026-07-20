"use client";
import { useState, useEffect } from "react";
import { supabase } from "@/lib/supabase";
import { IncomeFormData, Project } from "@/types";
import { X } from "lucide-react";
import { INCOME_CATEGORIES } from "@/types";

interface IncomeFormProps {
  initialData: any;
  onSubmit: (data: IncomeFormData) => void;
  onClose: () => void;
  loading: boolean;
  projects: Project[];
}

export default function IncomeForm({ initialData, onSubmit, onClose, loading, projects }: IncomeFormProps) {
  const [accounts, setAccounts] = useState<any[]>([]);
  
  const [form, setForm] = useState<IncomeFormData>({
    title: initialData?.title || "",
    amount: initialData?.amount || 0,
    category: initialData?.category || "Other",
    description: initialData?.description || "",
    income_date: initialData?.income_date || new Date().toISOString().split('T')[0],
    project_id: initialData?.project_id || null,
    account_id: initialData?.account_id || null,
  });

  useEffect(() => {
    async function fetchAccounts() {
      const { data } = await supabase
        .from("postable_accounts")
        .select("*")
        .in("account_type", ["REVENUE", "OTHER_INCOME"])
        .order("code");
      if (data) setAccounts(data);
    }
    fetchAccounts();
  }, []);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    onSubmit(form);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60">
      <div className="relative w-full max-w-md bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-6 max-h-[90vh] overflow-y-auto shadow-xl">
        <button onClick={onClose} className="absolute top-4 right-4 p-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-500 dark:text-gray-400">
          <X size={20} />
        </button>

        <h2 className="text-lg font-bold text-gray-900 dark:text-white mb-4">
          {initialData ? "Edit" : "Add"} Income
        </h2>
        
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Title <span className="text-red-500">*</span></label>
            <input required type="text" value={form.title} onChange={e => setForm({ ...form, title: e.target.value })} className="w-full px-3 py-2.5 bg-gray-50 dark:bg-gray-900 border border-gray-300 dark:border-gray-700 rounded-lg text-gray-900 dark:text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Amount (PKR) <span className="text-red-500">*</span></label>
              <input required type="number" min="0" value={form.amount || ""} onChange={e => setForm({ ...form, amount: Number(e.target.value) })} className="w-full px-3 py-2.5 bg-gray-50 dark:bg-gray-900 border border-gray-300 dark:border-gray-700 rounded-lg text-gray-900 dark:text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Category</label>
              <select value={form.category} onChange={e => setForm({ ...form, category: e.target.value })} className="w-full px-3 py-2.5 bg-gray-50 dark:bg-gray-900 border border-gray-300 dark:border-gray-700 rounded-lg text-gray-900 dark:text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
                {INCOME_CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Revenue Account <span className="text-red-500">*</span></label>
            <select required value={form.account_id || ""} onChange={e => setForm({ ...form, account_id: e.target.value || null })} className="w-full px-3 py-2.5 bg-gray-50 dark:bg-gray-900 border border-gray-300 dark:border-gray-700 rounded-lg text-gray-900 dark:text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
              <option value="">Select Account...</option>
              {accounts.map(acc => (
                <option key={acc.id} value={acc.id}>{acc.code} - {acc.name}</option>
              ))}
            </select>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Date <span className="text-red-500">*</span></label>
              <input required type="date" value={form.income_date} onChange={e => setForm({ ...form, income_date: e.target.value })} className="w-full px-3 py-2.5 bg-gray-50 dark:bg-gray-900 border border-gray-300 dark:border-gray-700 rounded-lg text-gray-900 dark:text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Project (Optional)</label>
              <select value={form.project_id || ""} onChange={e => setForm({ ...form, project_id: e.target.value || null })} className="w-full px-3 py-2.5 bg-gray-50 dark:bg-gray-900 border border-gray-300 dark:border-gray-700 rounded-lg text-gray-900 dark:text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
                <option value="">None</option>
                {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Description</label>
            <textarea value={form.description || ""} onChange={e => setForm({ ...form, description: e.target.value })} rows={3} className="w-full px-3 py-2.5 bg-gray-50 dark:bg-gray-900 border border-gray-300 dark:border-gray-700 rounded-lg text-gray-900 dark:text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none" />
          </div>

          <div className="flex gap-3 pt-2">
            <button type="button" onClick={onClose} className="flex-1 px-4 py-2.5 bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 text-gray-800 dark:text-white rounded-lg text-sm font-medium transition-colors">Cancel</button>
            <button type="submit" disabled={loading || !form.title || !form.account_id} className="flex-1 px-4 py-2.5 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-medium transition-colors disabled:opacity-50">
              {loading ? "Saving..." : "Save as Draft"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}