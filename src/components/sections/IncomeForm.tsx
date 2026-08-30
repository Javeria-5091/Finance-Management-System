"use client";
import { useState, useEffect } from "react";
import { supabase } from "@/lib/supabase";
import { IncomeFormData, Project } from "@/types";
import { X } from "lucide-react";
import { INCOME_CATEGORIES } from "@/types";
import { incomeTaxSchema } from "@/lib/validations";

interface IncomeFormProps {
  initialData: any;
  onSubmit: (data: IncomeFormData) => void;
  onClose: () => void;
  loading: boolean;
  projects: Project[];
}

export default function IncomeForm({ initialData, onSubmit, onClose, loading, projects }: IncomeFormProps) {
  const [accounts, setAccounts] = useState<any[]>([]);
  const [invoices, setInvoices] = useState<any[]>([]);

  const [form, setForm] = useState<IncomeFormData>({
    title: initialData?.title || "",
    amount: initialData?.amount || 0,
    category: initialData?.category || "Other",
    description: initialData?.description || "",
    income_date: initialData?.income_date || new Date().toISOString().split('T')[0],
    project_id: initialData?.project_id || null,
    account_id: initialData?.account_id || null,
    tax_rate: Number(initialData?.tax_rate || 0),
    tax_amount: Number(initialData?.tax_amount || 0),
    invoice_id: initialData?.invoice_id || null,
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
    // BUG-032 FIX: let the person creating this income explicitly link it
    // to the invoice it represents, so post-income can refuse to
    // double-count revenue that invoice already recognizes.
    async function fetchInvoices() {
      const { data } = await supabase
        .from("invoices")
        .select("id, invoice_number, client_name, total_amount")
        .in("status", ["ISSUED", "PARTIALLY_PAID", "PAID"])
        .order("issue_date", { ascending: false })
        .limit(200);
      if (data) setInvoices(data);
    }
    fetchAccounts();
    fetchInvoices();
  }, []);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const taxRate = Number(form.tax_rate || 0);
    const taxAmount = Number(form.amount || 0) * taxRate / 100;
    const taxValidation = incomeTaxSchema.safeParse({ tax_rate: taxRate, tax_amount: taxAmount });
    if (!taxValidation.success) return;
    onSubmit({ ...form, tax_rate: taxRate, tax_amount: taxAmount, invoice_id: form.invoice_id || null });
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

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Tax Rate (%)</label>
              <input required type="number" min="0" max="100" step="0.01" value={form.tax_rate || 0} onChange={e => setForm({ ...form, tax_rate: Number(e.target.value) })} className="w-full px-3 py-2.5 bg-gray-50 dark:bg-gray-900 border border-gray-300 dark:border-gray-700 rounded-lg text-gray-900 dark:text-white text-sm" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Calculated Tax</label>
              <input type="number" readOnly value={Number(form.amount || 0) * Number(form.tax_rate || 0) / 100} className="w-full px-3 py-2.5 bg-gray-100 dark:bg-gray-900 border border-gray-300 dark:border-gray-700 rounded-lg text-gray-500 text-sm" />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Description</label>
            <textarea value={form.description || ""} onChange={e => setForm({ ...form, description: e.target.value })} rows={3} className="w-full px-3 py-2.5 bg-gray-50 dark:bg-gray-900 border border-gray-300 dark:border-gray-700 rounded-lg text-gray-900 dark:text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none" />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              Link to Invoice (recommended for client revenue)
            </label>
            <select value={form.invoice_id || ""} onChange={e => setForm({ ...form, invoice_id: e.target.value || null })} className="w-full px-3 py-2.5 bg-gray-50 dark:bg-gray-900 border border-gray-300 dark:border-gray-700 rounded-lg text-gray-900 dark:text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
              <option value="">Not linked to an invoice</option>
              {invoices.map(inv => (
                <option key={inv.id} value={inv.id}>{inv.invoice_number} — {inv.client_name}</option>
              ))}
            </select>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
              If this income is revenue from a client that already has an invoice, link it here.
              Revenue for that invoice is already recognized when it's posted, so this income
              can be tracked (e.g. for cash-received records) but won't be posted to the ledger
              again to avoid double-counting.
            </p>
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