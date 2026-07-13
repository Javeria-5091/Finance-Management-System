"use client";
import { useState } from "react";
import { InvoiceFormData, Project } from "@/types";
import { X } from "lucide-react";
import { INVOICE_STATUSES } from "@/types";

interface InvoiceFormProps {
  initialData: any;
  onSubmit: (data: InvoiceFormData) => void;
  onClose: () => void;
  loading: boolean;
  projects: Project[];
}

export default function InvoiceForm({ initialData, onSubmit, onClose, loading, projects }: InvoiceFormProps) {
  const [form, setForm] = useState<InvoiceFormData>({
    invoice_number: initialData?.invoice_number || `INV-${Date.now().toString().slice(-6)}`,
    client_name: initialData?.client_name || "",
    amount: initialData?.amount || 0,
    status: initialData?.status || "Draft",
    issue_date: initialData?.issue_date || new Date().toISOString().split('T')[0],
    due_date: initialData?.due_date || "",
    project_id: initialData?.project_id || null,
    notes: initialData?.notes || "",
  });

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const submitData = {
      ...form,
      due_date: form.due_date === "" ? null : form.due_date,
      project_id: form.project_id === "" ? null : form.project_id,
    };
    onSubmit(submitData as InvoiceFormData);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60">
      <div className="relative w-full max-w-md bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-6 max-h-[90vh] overflow-y-auto shadow-xl">
        <button 
          onClick={onClose} 
          className="absolute top-4 right-4 p-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-white transition-colors"
        >
          <X size={20} />
        </button>

        <h2 className="text-lg font-bold text-gray-900 dark:text-white mb-4">
          {initialData ? "Edit" : "Create"} Invoice
        </h2>
        
        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Invoice Number (Read-only) */}
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Invoice Number</label>
            <input
              type="text"
              value={form.invoice_number}
              readOnly
              className="w-full px-3 py-2.5 bg-gray-100 dark:bg-gray-900 border border-gray-300 dark:border-gray-700 rounded-lg text-gray-500 dark:text-gray-400 text-sm cursor-not-allowed"
            />
            <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">Auto-generated. Cannot be changed manually.</p>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Client Name</label>
            <input
              required
              type="text"
              placeholder="e.g. John Doe"
              value={form.client_name}
              onChange={e => setForm({ ...form, client_name: e.target.value })}
              className="w-full px-3 py-2.5 bg-gray-50 dark:bg-gray-900 border border-gray-300 dark:border-gray-700 rounded-lg text-gray-900 dark:text-white text-sm placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Amount (PKR)</label>
              <input
                required
                type="number"
                placeholder="0.00"
                value={form.amount}
                onChange={e => setForm({ ...form, amount: Number(e.target.value) })}
                className="w-full px-3 py-2.5 bg-gray-50 dark:bg-gray-900 border border-gray-300 dark:border-gray-700 rounded-lg text-gray-900 dark:text-white text-sm placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Status</label>
              <select
                value={form.status}
                onChange={e => setForm({ ...form, status: e.target.value as any })}
                className="w-full px-3 py-2.5 bg-gray-50 dark:bg-gray-900 border border-gray-300 dark:border-gray-700 rounded-lg text-gray-900 dark:text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                {INVOICE_STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Issue Date</label>
              <input
                required
                type="date"
                value={form.issue_date}
                onChange={e => setForm({ ...form, issue_date: e.target.value })}
                className="w-full px-3 py-2.5 bg-gray-50 dark:bg-gray-900 border border-gray-300 dark:border-gray-700 rounded-lg text-gray-900 dark:text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Due Date</label>
              <input
                required
                type="date"
                value={form.due_date}
                onChange={e => setForm({ ...form, due_date: e.target.value })}
                className="w-full px-3 py-2.5 bg-gray-50 dark:bg-gray-900 border border-gray-300 dark:border-gray-700 rounded-lg text-gray-900 dark:text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Link to Project (Optional)</label>
            <select
              value={form.project_id || ""}
              onChange={e => setForm({ ...form, project_id: e.target.value || null })}
              className="w-full px-3 py-2.5 bg-gray-50 dark:bg-gray-900 border border-gray-300 dark:border-gray-700 rounded-lg text-gray-900 dark:text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="">No Project Linked</option>
              {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Notes</label>
            <textarea
              value={form.notes || ""}
              onChange={e => setForm({ ...form, notes: e.target.value })}
              rows={4}
              placeholder="Bank details, terms & conditions..."
              className="w-full px-3 py-2.5 bg-gray-50 dark:bg-gray-900 border border-gray-300 dark:border-gray-700 rounded-lg text-gray-900 dark:text-white text-sm placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
            />
          </div>

          <div className="flex gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 px-4 py-2.5 bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 text-gray-800 dark:text-white rounded-lg text-sm font-medium transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading || !form.client_name}
              className="flex-1 px-4 py-2.5 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-medium transition-colors disabled:opacity-50"
            >
              {loading ? "Saving..." : "Create Invoice"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}