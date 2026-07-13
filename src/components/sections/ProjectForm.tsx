"use client";
import { useState } from "react";
import { ProjectFormData, Budget } from "@/types";
import { X } from "lucide-react";
import { PROJECT_STATUSES } from "@/types";

interface ProjectFormProps {
  initialData: any;
  onSubmit: (data: ProjectFormData) => void;
  onClose: () => void;
  loading: boolean;
  budgets?: Budget[];
}

export default function ProjectForm({ initialData, onSubmit, onClose, loading, budgets = [] }: ProjectFormProps) {
  const [form, setForm] = useState<ProjectFormData>({
    name: initialData?.name || "",
    client_name: initialData?.client_name || "",
    description: initialData?.description || "",
    status: initialData?.status || "Active",
    start_date: initialData?.start_date || new Date().toISOString().split('T')[0],
    end_date: initialData?.end_date || "",
    budget_id: initialData?.budget_id || "",
  });

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const submitData = {
      ...form,
      budget_id: form.budget_id === "" ? null : form.budget_id,
      end_date: form.end_date === "" ? null : form.end_date
    };
    onSubmit(submitData as ProjectFormData);
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

        <h2 className="text-lg font-bold text-gray-900 dark:text-white mb-4">{initialData ? "Edit" : "Add"} Project</h2>
        
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Project Name</label>
            <input
              required
              type="text"
              value={form.name}
              onChange={e => setForm({ ...form, name: e.target.value })}
              className="w-full px-3 py-2.5 bg-gray-50 dark:bg-gray-900 border border-gray-300 dark:border-gray-700 rounded-lg text-gray-900 dark:text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Client Name</label>
            <input
              required
              type="text"
              value={form.client_name}
              onChange={e => setForm({ ...form, client_name: e.target.value })}
              className="w-full px-3 py-2.5 bg-gray-50 dark:bg-gray-900 border border-gray-300 dark:border-gray-700 rounded-lg text-gray-900 dark:text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Link to Budget (Optional)</label>
            <select
              value={form.budget_id || ""}
              onChange={e => setForm({ ...form, budget_id: e.target.value })}
              className="w-full px-3 py-2.5 bg-gray-50 dark:bg-gray-900 border border-gray-300 dark:border-gray-700 rounded-lg text-gray-900 dark:text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="">No Budget Assigned</option>
              {budgets.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name} (PKR {b.total_amount.toLocaleString()})
                </option>
              ))}
            </select>
            <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">Assign a budget to track project expenses against it.</p>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Status</label>
            <select
              value={form.status}
              onChange={e => setForm({ ...form, status: e.target.value as any })}
              className="w-full px-3 py-2.5 bg-gray-50 dark:bg-gray-900 border border-gray-300 dark:border-gray-700 rounded-lg text-gray-900 dark:text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              {PROJECT_STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Start Date</label>
              <input
                required
                type="date"
                value={form.start_date}
                onChange={e => setForm({ ...form, start_date: e.target.value })}
                className="w-full px-3 py-2.5 bg-gray-50 dark:bg-gray-900 border border-gray-300 dark:border-gray-700 rounded-lg text-gray-900 dark:text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">End Date</label>
              <input
                type="date"
                value={form.end_date || ""}
                onChange={e => setForm({ ...form, end_date: e.target.value })}
                className="w-full px-3 py-2.5 bg-gray-50 dark:bg-gray-900 border border-gray-300 dark:border-gray-700 rounded-lg text-gray-900 dark:text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Description</label>
            <textarea
              value={form.description || ""}
              onChange={e => setForm({ ...form, description: e.target.value })}
              rows={3}
              className="w-full px-3 py-2.5 bg-gray-50 dark:bg-gray-900 border border-gray-300 dark:border-gray-700 rounded-lg text-gray-900 dark:text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
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
              disabled={loading || !form.name}
              className="flex-1 px-4 py-2.5 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-medium transition-colors disabled:opacity-50"
            >
              {loading ? "Saving..." : "Save Project"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}