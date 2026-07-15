"use client";
import { useState, useEffect } from "react";
import { supabase } from "@/lib/supabase";
import { ExpenseFormData, Project, Budget } from "@/types";
import { X, AlertTriangle } from "lucide-react";
import { EXPENSE_CATEGORIES } from "@/types";

interface ExpenseFormProps {
  initialData: any;
  onSubmit: (data: ExpenseFormData) => void;
  onClose: () => void;
  loading: boolean;
  projects: Project[];
}

export default function ExpenseForm({ initialData, onSubmit, onClose, loading, projects }: ExpenseFormProps) {
  const [form, setForm] = useState<ExpenseFormData>({
    title: initialData?.title || "",
    amount: initialData?.amount || 0,
    category: initialData?.category || "Other",
    expense_date: initialData?.expense_date || new Date().toISOString().split('T')[0],
    project_id: initialData?.project_id || null,
    notes: initialData?.notes || "",
  });

  // ✅ BUDGET VALIDATION STATES
  const [remainingBudget, setRemainingBudget] = useState<number | null>(null);
  const [budgetWarning, setBudgetWarning] = useState<string | null>(null);

  useEffect(() => {
    async function checkBudget() {
      if (!form.project_id) {
        setRemainingBudget(null);
        setBudgetWarning(null);
        return;
      }

      const { data: project } = await supabase.from("projects").select("budget_id").eq("id", form.project_id).single();
      if (!project?.budget_id) {
        setRemainingBudget(null);
        setBudgetWarning(null);
        return;
      }

      const { data: budget } = await supabase.from("budgets").select("total_amount").eq("id", project.budget_id).single();
      const { data: expenses } = await supabase.from("expenses").select("amount").eq("project_id", form.project_id);
      
      const totalSpent = expenses?.reduce((sum, e) => sum + Number(e.amount), 0) || 0;
      const remaining = (budget?.total_amount || 0) - totalSpent;
      setRemainingBudget(remaining);

      if (form.amount > remaining) {
        setBudgetWarning(`Warning: This expense exceeds the remaining project budget by PKR ${(form.amount - remaining).toLocaleString()}. Submission blocked.`);
      } else if (form.amount > remaining * 0.8) {
        setBudgetWarning(`Caution: This expense will use over 80% of the remaining project budget.`);
      } else {
        setBudgetWarning(null);
      }
    }
    checkBudget();
  }, [form.project_id, form.amount]);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    // ✅ PREVENT SUBMISSION IF OVER BUDGET
    if (budgetWarning && budgetWarning.includes("blocked")) {
      alert("Cannot submit: Expense exceeds project budget!");
      return;
    }
    onSubmit(form);
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

        <h2 className="text-lg font-bold text-gray-900 dark:text-white mb-4">{initialData ? "Edit" : "Add"} Expense</h2>
        
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Title</label>
            <input
              required
              type="text"
              value={form.title}
              onChange={e => setForm({ ...form, title: e.target.value })}
              className="w-full px-3 py-2.5 bg-gray-50 dark:bg-gray-900 border border-gray-300 dark:border-gray-700 rounded-lg text-gray-900 dark:text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Amount (PKR)</label>
              <input
                required
                type="number"
                min="0"
                step="1"
                value={form.amount}
                onChange={e => setForm({ ...form, amount: Number(e.target.value) })}
                className="w-full px-3 py-2.5 bg-gray-50 dark:bg-gray-900 border border-gray-300 dark:border-gray-700 rounded-lg text-gray-900 dark:text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Category</label>
              <select
                value={form.category}
                onChange={e => setForm({ ...form, category: e.target.value })}
                className="w-full px-3 py-2.5 bg-gray-50 dark:bg-gray-900 border border-gray-300 dark:border-gray-700 rounded-lg text-gray-900 dark:text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                {EXPENSE_CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Date</label>
              <input
                required
                type="date"
                value={form.expense_date}
                onChange={e => setForm({ ...form, expense_date: e.target.value })}
                className="w-full px-3 py-2.5 bg-gray-50 dark:bg-gray-900 border border-gray-300 dark:border-gray-700 rounded-lg text-gray-900 dark:text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Project (Optional)</label>
              <select
                value={form.project_id || ""}
                onChange={e => setForm({ ...form, project_id: e.target.value || null })}
                className="w-full px-3 py-2.5 bg-gray-50 dark:bg-gray-900 border border-gray-300 dark:border-gray-700 rounded-lg text-gray-900 dark:text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <option value="">None</option>
                {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </div>
          </div>

          {/* ✅ BUDGET IMPACT UI */}
          {remainingBudget !== null && (
            <div className="bg-gray-50 dark:bg-gray-900 p-3 rounded-lg border border-gray-200 dark:border-gray-700">
              <p className="text-xs text-gray-500 dark:text-gray-400 font-medium">Remaining Project Budget</p>
              <p className="text-lg font-bold text-green-600 dark:text-green-400">PKR {remainingBudget.toLocaleString()}</p>
            </div>
          )}

          {/* ✅ WARNING MESSAGE */}
          {budgetWarning && (
            <div className={`flex items-start gap-2 p-3 rounded-lg border ${
              budgetWarning.includes("blocked") 
                ? "bg-red-50 dark:bg-red-500/10 border-red-200 dark:border-red-500/50 text-red-600 dark:text-red-400" 
                : "bg-yellow-50 dark:bg-yellow-500/10 border-yellow-200 dark:border-yellow-500/50 text-yellow-600 dark:text-yellow-400"
            }`}>
              <AlertTriangle size={18} className="mt-0.5 flex-shrink-0" />
              <p className="text-sm">{budgetWarning}</p>
            </div>
          )}

          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Notes</label>
            <textarea
              value={form.notes || ""}
              onChange={e => setForm({ ...form, notes: e.target.value })}
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
              disabled={loading || !!budgetWarning?.includes("blocked")}
              className="flex-1 px-4 py-2.5 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-medium transition-colors disabled:opacity-50"
            >
              {loading ? "Saving..." : "Save Expense"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}