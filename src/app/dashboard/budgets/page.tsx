"use client";
import { useEffect, useState, useCallback } from "react";
import { supabase, reportingDB } from "@/lib/supabase";
import { useAuth } from "@/context/AuthContext";
import { usePermissions } from "@/context/PermissionContext";
import { Budget, BudgetFormData, Project, Expense } from "@/types";
import BudgetForm from "@/components/sections/BudgetForm";
import { Plus, Pencil, Trash2, AlertTriangle, Link2 } from "lucide-react";
import Link from "next/link";
import toast from "react-hot-toast";

interface BudgetGLActual {
  budget_line_id: string;
  budget_id: string;
  budget_name: string;
  account_id: string | null;
  account_code: string | null;
  account_name: string | null;
  allocated_amount: number;
  actual_spent: number;
  remaining: number;
}

export default function BudgetsPage() {
  const { user, hasPermission, isAdmin } = useAuth();
  const [budgets, setBudgets] = useState<Budget[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [budgetGLActual, setBudgetGLActual] = useState<BudgetGLActual[]>([]);
  
  const [loading, setLoading] = useState(true);
  const [formLoading, setFormLoading] = useState(false);
  
  const [showForm, setShowForm] = useState(false);
  const [editingData, setEditingData] = useState<Budget | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);

  const canModify = hasPermission ? hasPermission("BUDGET_CREATE") : isAdmin;

  const fetchData = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    
    try {
      const [budRes, projRes, expRes, glActualRes] = await Promise.all([
        supabase.from("budgets").select("*").order("created_at", { ascending: false }),
        supabase.from("projects").select("*"),
        supabase.from("expenses").select("*").eq("status", "POSTED"),
        // Fetch GL-linked budget actuals from reporting view
        reportingDB.from("budget_gl_actual").select("*").order("account_code"),
      ]);

      if (budRes.error) toast.error("Failed to load budgets: " + budRes.error.message);
      else setBudgets(budRes.data || []);
      
      if (projRes.error) toast.error("Failed to load projects: " + projRes.error.message);
      else setProjects(projRes.data || []);
      
      if (expRes.error) toast.error("Failed to load expenses: " + expRes.error.message);
      else setExpenses(expRes.data || []);

      if (glActualRes.data) setBudgetGLActual(glActualRes.data as BudgetGLActual[]);
    } catch (err: any) {
      toast.error("Error loading budget data: " + (err.message || "Unknown error"));
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => { fetchData(); }, [fetchData]);

  function getBudgetStats(budgetId: string) {
    const linkedProjectIds = projects
      .filter(p => p.budget_id === budgetId)
      .map(p => p.id);

    // Only count POSTED expenses (from General Ledger)
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
    try {
      let error;
      if (editingData) {
        const res = await supabase.from("budgets").update(data).eq("id", editingData.id);
        error = res.error;
      } else {
        const res = await supabase.from("budgets").insert({ ...data, user_id: user?.id });
        error = res.error;
      }
      
      if (error) {
        toast.error("Failed to save budget: " + error.message);
      } else {
        toast.success(editingData ? "Budget updated successfully" : "Budget created successfully");
        setShowForm(false); 
        setEditingData(null); 
        fetchData();
      }
    } catch (err: any) {
      toast.error("Error saving budget: " + (err.message || "Unknown error"));
    } finally {
      setFormLoading(false);
    }
  }

  async function handleDelete() {
    if (!deleteId) return;
    try {
      const { error } = await supabase.from("budgets").delete().eq("id", deleteId);
      if (error) {
        toast.error("Failed to delete budget: " + error.message);
      } else {
        toast.success("Budget deleted successfully");
        setDeleteId(null); 
        fetchData();
      }
    } catch (err: any) {
      toast.error("Error deleting budget: " + (err.message || "Unknown error"));
    }
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
          <p className="text-gray-500 dark:text-gray-400 text-sm">Track organizational and project budgets (GL-linked)</p>
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
                      <p className="text-xs text-gray-500 dark:text-gray-400">Used (GL Posted)</p>
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

                  {/* GL Budget Lines Detail (if available) */}
                  {(() => {
                    const lines = budgetGLActual.filter(l => l.budget_id === bud.id);
                    if (lines.length === 0) return null;
                    return (
                      <div className="mt-3 border-t border-gray-100 dark:border-gray-700/50 pt-3">
                        <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-2 flex items-center gap-1"><Link2 size={10} /> GL Account Breakdown</p>
                        <div className="space-y-1">
                          {lines.map(l => (
                            <div key={l.budget_line_id} className="flex items-center justify-between text-xs bg-gray-50 dark:bg-gray-900/30 rounded px-2 py-1.5">
                              <span className="text-gray-600 dark:text-gray-400 font-mono">{l.account_code || "-"} {l.account_name || ""}</span>
                              <div className="flex items-center gap-3">
                                <span className="text-gray-500">Alloc: {formatCurrency(l.allocated_amount)}</span>
                                <span className={l.remaining < 0 ? "text-red-600 font-medium" : "text-green-600"}>Actual: {formatCurrency(l.actual_spent)}</span>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    );
                  })()}

                  <div className="flex justify-between items-center text-sm mt-3">
                    <span className={`${colors.text} font-medium flex items-center gap-1`}>
                      {stats.percent >= 80 && <AlertTriangle size={14}/>} 
                      {stats.percent.toFixed(1)}% Utilized (GL)
                    </span>
                    <div className="flex items-center gap-3">
                      <Link href="/dashboard/accounting/general-ledger" className="text-xs text-blue-600 dark:text-blue-400 hover:underline flex items-center gap-1"><Link2 size={10} /> View GL</Link>
                      <span className="text-gray-400 dark:text-gray-500">{linkedCount} Projects</span>
                    </div>
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