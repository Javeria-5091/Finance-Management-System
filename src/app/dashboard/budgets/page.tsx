"use client";
import { useEffect, useState, useCallback } from "react";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/context/AuthContext";
import { Budget, BudgetFormData, Project, Expense } from "@/types";
import BudgetForm from "@/components/sections/BudgetForm";
import { Plus, Pencil, Trash2, AlertTriangle } from "lucide-react";

export default function BudgetsPage() {
  const { user, hasPermission, isAdmin } = useAuth();
  const [budgets, setBudgets] = useState<Budget[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [expenses, setExpenses] = useState<Expense[]>([]);
  
  const [loading, setLoading] = useState(true);
  const [formLoading, setFormLoading] = useState(false);
  
  const [showForm, setShowForm] = useState(false);
  const [editingData, setEditingData] = useState<Budget | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);

  const canModify = hasPermission("can_create_project") || isAdmin;

  const fetchData = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    
    const [budRes, projRes, expRes] = await Promise.all([
      supabase.from("budgets").select("*").order("created_at", { ascending: false }),
      supabase.from("projects").select("*"),
      supabase.from("expenses").select("*")
    ]);

    if (budRes.data) setBudgets(budRes.data);
    if (projRes.data) setProjects(projRes.data);
    if (expRes.data) setExpenses(expRes.data);
    setLoading(false);
  }, [user]);

  useEffect(() => { fetchData(); }, [fetchData]);

  function getBudgetStats(budgetId: string) {
    const linkedProjectIds = projects
      .filter(p => p.budget_id === budgetId)
      .map(p => p.id);

    const usedAmount = expenses
      .filter(e => linkedProjectIds.includes(e.project_id || ''))
      .reduce((sum, e) => sum + Number(e.amount), 0);

    const budget = budgets.find(b => b.id === budgetId);
    if (!budget) return { usedAmount: 0, remaining: 0, percent: 0 };
    
    const remaining = budget.total_amount - usedAmount;
    const percent = budget.total_amount > 0 ? (usedAmount / budget.total_amount) * 100 : 0;

    return { usedAmount, remaining, percent };
  }

  async function handleSubmit(data: BudgetFormData) {
    setFormLoading(true);
    if (editingData) {
      await supabase.from("budgets").update(data).eq("id", editingData.id);
    } else {
      await supabase.from("budgets").insert({ ...data, user_id: user?.id });
    }
    setFormLoading(false);
    setShowForm(false); 
    setEditingData(null); 
    fetchData();
  }

  async function handleDelete() {
    if (!deleteId) return;
    await supabase.from("budgets").delete().eq("id", deleteId);
    setDeleteId(null); 
    fetchData();
  }

  function getUtilizationColor(percent: number) {
    if (percent >= 100) return { text: "text-red-600 dark:text-red-400", bg: "bg-red-500" };
    if (percent >= 80) return { text: "text-yellow-600 dark:text-yellow-400", bg: "bg-yellow-500" };
    return { text: "text-green-600 dark:text-green-400", bg: "bg-green-500" };
  }

  function formatCurrency(amount: number) {
    return new Intl.NumberFormat("en-PK", { style: "currency", currency: "PKR", minimumFractionDigits: 0 }).format(amount);
  }

  return (
    <div>
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-6">
        <div>
          <h2 className="text-2xl font-bold text-gray-900 dark:text-white">Budget Management</h2>
          <p className="text-gray-500 dark:text-gray-400 text-sm">Track organizational and project budgets</p>
        </div>
        {canModify && (
          <button onClick={() => { setEditingData(null); setShowForm(true); }} className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-4 py-2.5 rounded-lg font-medium transition-colors w-fit shadow-sm">
            <Plus size={18} /> Create Budget
          </button>
        )}
      </div>

      {loading ? (
        <div className="text-gray-500 dark:text-gray-400 p-8 text-center bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 shadow-sm">Loading Budgets...</div>
      ) : (
        <div className="space-y-4">
          {budgets.length === 0 ? (
            <div className="bg-white dark:bg-gray-800 p-12 rounded-xl text-center text-gray-500 dark:text-gray-400 border border-gray-200 dark:border-gray-700 shadow-sm">No budgets created yet.</div>
          ) : (
            budgets.map(bud => {
              const stats = getBudgetStats(bud.id);
              const colors = getUtilizationColor(stats.percent);
              const linkedCount = projects.filter(p => p.budget_id === bud.id).length;
              
              return (
                <div key={bud.id} className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-5 hover:shadow-md dark:hover:border-gray-600 transition-all shadow-sm">
                  <div className="flex justify-between items-start mb-4">
                    <div>
                      <h3 className="text-lg font-bold text-gray-900 dark:text-white">{bud.name}</h3>
                      <p className="text-sm text-gray-500 dark:text-gray-400">{bud.category} • Ends: {new Date(bud.end_date).toLocaleDateString("en-PK")}</p>
                    </div>
                    {canModify && (
                      <div className="flex gap-2">
                        <button onClick={() => { setEditingData(bud); setShowForm(true); }} className="p-1.5 text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-500/10 rounded transition-colors"><Pencil size={16}/></button>
                        <button onClick={() => setDeleteId(bud.id)} className="p-1.5 text-gray-400 hover:text-red-600 dark:hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-500/10 rounded transition-colors"><Trash2 size={16}/></button>
                      </div>
                    )}
                  </div>

                  <div className="grid grid-cols-3 gap-4 mb-4 text-center p-3 bg-gray-50 dark:bg-gray-900/50 rounded-lg border border-gray-100 dark:border-gray-700/50">
                    <div>
                      <p className="text-xs text-gray-500 dark:text-gray-400">Total Allocated</p>
                      <p className="text-lg font-bold text-gray-900 dark:text-white">{formatCurrency(bud.total_amount)}</p>
                    </div>
                    <div>
                      <p className="text-xs text-gray-500 dark:text-gray-400">Used</p>
                      <p className="text-lg font-bold text-red-600 dark:text-red-400">{formatCurrency(stats.usedAmount)}</p>
                    </div>
                    <div>
                      <p className="text-xs text-gray-500 dark:text-gray-400">Remaining</p>
                      <p className={`text-lg font-bold ${stats.remaining < 0 ? 'text-red-600 dark:text-red-400' : 'text-green-600 dark:text-green-400'}`}>{formatCurrency(stats.remaining)}</p>
                    </div>
                  </div>

                  {/* Progress Bar */}
                  <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-2.5 mb-3">
                    <div className={`${colors.bg} h-2.5 rounded-full transition-all`} style={{ width: `${Math.min(stats.percent, 100)}%` }}></div>
                  </div>
                  
                  <div className="flex justify-between items-center text-sm">
                    <span className={`${colors.text} font-medium flex items-center gap-1`}>
                      {stats.percent >= 80 && <AlertTriangle size={14}/>} 
                      {stats.percent.toFixed(1)}% Utilized
                    </span>
                    <span className="text-gray-400 dark:text-gray-500">{linkedCount} Projects Linked</span>
                  </div>
                </div>
              );
            })
          )}
        </div>
      )}

      {showForm && (
        <BudgetForm 
          initialData={editingData} 
          onSubmit={handleSubmit} 
          onClose={() => { setShowForm(false); setEditingData(null); }} 
          loading={formLoading}
        />
      )}

      {deleteId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 dark:bg-black/70">
          <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-6 w-full max-w-sm text-center shadow-xl">
            <h3 className="text-lg font-bold text-gray-900 dark:text-white mb-2">Delete Budget?</h3>
            <p className="text-gray-500 dark:text-gray-400 text-sm mb-6">This will unlink it from projects but won't delete recorded expenses.</p>
            <div className="flex gap-3">
              <button onClick={() => setDeleteId(null)} className="flex-1 px-4 py-2.5 bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 dark:hover:bg-gray-600 text-gray-800 dark:text-white rounded-lg transition-colors">Cancel</button>
              <button onClick={handleDelete} className="flex-1 px-4 py-2.5 bg-red-600 hover:bg-red-700 text-white rounded-lg transition-colors">Delete</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}