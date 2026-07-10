"use client";
import { useState, useEffect } from "react";
import { supabase } from "@/lib/supabase";
import { ExpenseFormData, Project, Budget } from "@/types";
import { AlertTriangle, X } from "lucide-react";
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

  // BUDGET VALIDATION STATES
  const [remainingBudget, setRemainingBudget] = useState<number | null>(null);
  const [budgetWarning, setBudgetWarning] = useState<string | null>(null);

  // FETCH BUDGET WHEN PROJECT CHANGES
  useEffect(() => {
    async function checkBudget() {
      if (!form.project_id) {
        setRemainingBudget(null);
        setBudgetWarning(null);
        return;
      }

      // 1. Get Project's Budget ID
      const { data: project } = await supabase.from("projects").select("budget_id").eq("id", form.project_id).single();
      if (!project?.budget_id) {
        setRemainingBudget(null);
        setBudgetWarning(null);
        return;
      }

      // 2. Get Budget Total
      const { data: budget } = await supabase.from("budgets").select("total_amount").eq("id", project.budget_id).single();
      
      // 3. Get Total Spent on this project
      const { data: expenses } = await supabase.from("expenses").select("amount").eq("project_id", form.project_id);
      const totalSpent = expenses?.reduce((sum, e) => sum + Number(e.amount), 0) || 0;

      if (budget) {
        const remaining = budget.total_amount - totalSpent;
        setRemainingBudget(remaining);

        // 4. Check if new expense exceeds budget
        if (form.amount > remaining) {
          setBudgetWarning(`Warning: This expense exceeds the remaining project budget by PKR ${(form.amount - remaining).toLocaleString()}. Submission blocked.`);
        } else if (form.amount > remaining * 0.8) {
          setBudgetWarning(`Caution: This expense will use over 80% of the remaining project budget.`);
        } else {
          setBudgetWarning(null);
        }
      }
    }
    checkBudget();
  }, [form.project_id, form.amount]);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    // PREVENT SUBMISSION IF OVER BUDGET
    if (budgetWarning && budgetWarning.includes("Submission blocked")) {
      alert("Cannot submit: Expense exceeds project budget!");
      return;
    }
    onSubmit(form);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60">
      <div className="relative w-full max-w-md bg-gray-800 border border-gray-700 rounded-xl p-6 max-h-[90vh] overflow-y-auto">
        <button onClick={onClose} className="absolute top-4 right-4 text-gray-400 hover:text-white"><X size={20}/></button>
        
        <h2 className="text-lg font-bold text-white mb-4">{initialData ? "Edit" : "Add"} Expense</h2>
        
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm text-gray-400 mb-1">Title</label>
            <input required type="text" value={form.title} onChange={e => setForm({...form, title: e.target.value})} className="w-full px-3 py-2 bg-gray-900 border border-gray-700 rounded-lg text-white" />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm text-gray-400 mb-1">Amount (PKR)</label>
              <input required type="number" step="1" min = "0" value={form.amount} onChange={e => setForm({...form, amount: Number(e.target.value)})} className="w-full px-3 py-2 bg-gray-900 border border-gray-700 rounded-lg text-white" />
            </div>
            <div>
              <label className="block text-sm text-gray-400 mb-1">Category</label>
              <select value={form.category} onChange={e => setForm({...form, category: e.target.value})} className="w-full px-3 py-2 bg-gray-900 border border-gray-700 rounded-lg text-white">
                {EXPENSE_CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm text-gray-400 mb-1">Date</label>
              <input required type="date" value={form.expense_date} onChange={e => setForm({...form, expense_date: e.target.value})} className="w-full px-3 py-2 bg-gray-900 border border-gray-700 rounded-lg text-white" />
            </div>
            <div>
              <label className="block text-sm text-gray-400 mb-1">Project (Optional)</label>
              <select value={form.project_id || ""} onChange={e => setForm({...form, project_id: e.target.value || null})} className="w-full px-3 py-2 bg-gray-900 border border-gray-700 rounded-lg text-white">
                <option value="">None</option>
                {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </div>
          </div>

          {/* BUDGET IMPACT UI */}
          {remainingBudget !== null && (
            <div className="bg-gray-900 p-3 rounded-lg border border-gray-700">
              <p className="text-xs text-gray-400">Remaining Project Budget</p>
              <p className="text-lg font-bold text-green-400">PKR {remainingBudget.toLocaleString()}</p>
            </div>
          )}

          {/* WARNING MESSAGE */}
          {budgetWarning && (
            <div className={`flex items-start gap-2 p-3 rounded-lg border ${budgetWarning.includes("blocked") ? "bg-red-500/10 border-red-500/50 text-red-400" : "bg-yellow-500/10 border-yellow-500/50 text-yellow-400"}`}>
              <AlertTriangle size={18} className="mt-0.5 flex-shrink-0" />
              <p className="text-sm">{budgetWarning}</p>
            </div>
          )}

          <div>
            <label className="block text-sm text-gray-400 mb-1">Notes</label>
            <textarea value={form.notes || ""} onChange={e => setForm({...form, notes: e.target.value})} rows={3} className="w-full px-3 py-2 bg-gray-900 border border-gray-700 rounded-lg text-white" />
          </div>

          <div className="flex gap-3 pt-2">
            <button type="button" onClick={onClose} className="flex-1 px-4 py-2.5 bg-gray-700 hover:bg-gray-600 text-white rounded-lg">Cancel</button>
            <button 
              type="submit" 
              disabled={loading || !!budgetWarning?.includes("blocked")} 
              className="flex-1 px-4 py-2.5 bg-blue-600 hover:bg-blue-700 text-white rounded-lg disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {loading ? "Saving..." : "Save Expense"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}