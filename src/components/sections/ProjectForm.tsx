"use client";
import { useState, useEffect } from "react";
import { ProjectFormData, Budget } from "@/types";
import { X } from "lucide-react";
import { PROJECT_STATUSES } from "@/types";

interface ProjectFormProps {
  initialData: ProjectFormData | null;
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
    budget_id: initialData?.budget_id || null,
  });

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    // Agar end_date empty hai toh null bhejo
    onSubmit({ ...form, end_date: form.end_date === "" ? null : form.end_date });
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60">
      <div className="relative w-full max-w-md bg-gray-800 border border-gray-700 rounded-xl p-6 max-h-[90vh] overflow-y-auto">
        <button onClick={onClose} className="absolute top-4 right-4 p-1.5 rounded-lg hover:bg-gray-700 text-gray-400 hover:text-white transition-colors">
          <X size={20} />
        </button>

        <h2 className="text-lg font-bold text-white mb-4">
          {initialData ? "Edit Project" : "Add New Project"}
        </h2>

        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Project Name */}
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-1">Project Name</label>
            <input
              type="text"
              required
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              className="w-full px-3 py-2.5 bg-gray-900 border border-gray-700 rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="e.g., E-Commerce Website"
            />
          </div>

          {/* Client Name */}
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-1">Client Name</label>
            <input
              type="text"
              required
              value={form.client_name}
              onChange={(e) => setForm({ ...form, client_name: e.target.value })}
              className="w-full px-3 py-2.5 bg-gray-900 border border-gray-700 rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="e.g., abc"
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            {/* Status */}
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-1">Status</label>
              <select
                value={form.status}
                onChange={(e) => setForm({ ...form, status: e.target.value as any })}
                className="w-full px-3 py-2.5 bg-gray-900 border border-gray-700 rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                {PROJECT_STATUSES.map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
            </div>

            {/* Start Date */}
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-1">Start Date</label>
              <input
                type="date"
                required
                value={form.start_date}
                onChange={(e) => setForm({ ...form, start_date: e.target.value })}
                className="w-full px-3 py-2.5 bg-gray-900 border border-gray-700 rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
          </div>

          {/* End Date */}
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-1">End Date (Optional)</label>
            <input
              type="date"
              value={form.end_date || ""}
              onChange={(e) => setForm({ ...form, end_date: e.target.value })}
              className="w-full px-3 py-2.5 bg-gray-900 border border-gray-700 rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          {/* BUDGET ALLOCATION DROPDOWN */}
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-1">Allocate to Budget (Optional)</label>
            <select
              value={form.budget_id || ""}
              onChange={(e) => setForm({ ...form, budget_id: e.target.value || null })}
              className="w-full px-3 py-2.5 bg-gray-900 border border-gray-700 rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="">-- No Budget Assigned --</option>
              {budgets.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name} (PKR {b.total_amount.toLocaleString()})
                </option>
              ))}
            </select>
          </div>

          {/* Description */}
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-1">Description (Optional)</label>
            <textarea
              value={form.description || ""}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
              rows={3}
              className="w-full px-3 py-2.5 bg-gray-900 border border-gray-700 rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
              placeholder="Brief project details..."
            />
          </div>

          {/* Buttons */}
          <div className="flex items-center gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 px-4 py-2.5 bg-gray-700 hover:bg-gray-600 text-white rounded-lg text-sm font-medium transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading}
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