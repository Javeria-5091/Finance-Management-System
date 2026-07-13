"use client";
import { useEffect, useState, useCallback } from "react";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/context/AuthContext";
import { Budget, BudgetFormData, Project, Expense } from "@/types";
import { Plus, Pencil, Trash2, AlertTriangle, X} from "lucide-react";

export default function BudgetsPage() {
  const { user, hasPermission, isAdmin } = useAuth();
  const [budgets, setBudgets] = useState<(Budget & { used_amount: number })[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editingData, setEditingData] = useState<Budget | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);

  const canModify = hasPermission("can_create_project") || isAdmin;

  const fetchData = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    
    const [budRes, projRes] = await Promise.all([
      supabase.from("budgets").select("*").order("created_at", { ascending: false }),
      supabase.from("projects").select("*"),
      supabase.from("expenses").select("*")
    ]);

    if (budRes.data) {
      const budgetsWithUsage = await Promise.all(budRes.data.map(async (bud) => {
        const linkedProjects = projRes.data?.filter(p => p.budget_id === bud.id) || [];
        const linkedProjectIds = linkedProjects.map(p => p.id);
        
        let usedAmount = 0;
        if (linkedProjectIds.length > 0) {
          const { data: relatedExpenses } = await supabase
            .from("expenses")
            .select("amount")
            .in("project_id", linkedProjectIds);
          
          usedAmount = relatedExpenses?.reduce((sum, e) => sum + Number(e.amount), 0) || 0;
        }
        
        return { ...bud, used_amount: usedAmount };
      }));
      setBudgets(budgetsWithUsage);
    }
    
    if (projRes.data) setProjects(projRes.data);
    setLoading(false);
  }, [user]);

  useEffect(() => { fetchData(); }, [fetchData]);

  async function handleSubmit(data: BudgetFormData) {
    if (editingData) {
      await supabase.from("budgets").update(data).eq("id", editingData.id);
    } else {
      await supabase.from("budgets").insert({ ...data, user_id: user?.id });
    }
    setShowForm(false); setEditingData(null); fetchData();
  }

  async function handleDelete() {
    if (!deleteId) return;
    await supabase.from("budgets").delete().eq("id", deleteId);
    setDeleteId(null); fetchData();
  }

  function getUtilization(total: number, used: number) {
    if (total === 0) return { percent: 0, color: "text-gray-500 dark:text-gray-400", bg: "bg-gray-300 dark:bg-gray-600" };
    const percent = (used / total) * 100;
    if (percent >= 100) return { percent: percent.toFixed(1), color: "text-red-600 dark:text-red-400", bg: "bg-red-500" };
    if (percent >= 80) return { percent: percent.toFixed(1), color: "text-yellow-600 dark:text-yellow-400", bg: "bg-yellow-500" };
    return { percent: percent.toFixed(1), color: "text-green-600 dark:text-green-400", bg: "bg-green-500" };
  }

  function formatCurrency(amount: number) {
    return new Intl.NumberFormat("en-PK", { style: "currency", currency: "PKR", minimumFractionDigits: 0 }).format(amount);
  }

  return (
    <div>
      {/* HEADER */}
      <div className="flex justify-between items-center mb-6">
        <div>
          <h2 className="text-2xl font-bold text-gray-900 dark:text-white">Budget Management</h2>
          <p className="text-gray-500 dark:text-gray-400 text-sm">Track organizational and project budgets</p>
        </div>
        {canModify && (
          <button onClick={() => { setEditingData(null); setShowForm(true); }} className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-4 py-2.5 rounded-lg font-medium transition-colors w-fit shadow-sm hover:shadow-md">
            <Plus size={18} /> Create Budget
          </button>
        )}
      </div>

      {/* BUDGET CARDS LIST */}
      <div className="space-y-4">
        {loading ? ( 
          <div className="text-gray-500 dark:text-gray-400 p-8 text-center bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 shadow-sm">Loading Budgets...</div> 
        ) : (
          budgets.length === 0 ? (
            <div className="text-gray-500 dark:text-gray-400 p-12 text-center bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 shadow-sm">No budgets created yet.</div>
          ) : (
           budgets.map(bud => {
              const remaining = bud.total_amount - bud.used_amount;
              const util = getUtilization(bud.total_amount, bud.used_amount);
              const linkedProjects = projects.filter(p => p.budget_id === bud.id);
              
              return (
                <div key={bud.id} className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-5 hover:border-gray-300 dark:hover:border-gray-600 transition-all shadow-sm dark:shadow-none">
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

                  {/* STATS GRID */}
                  <div className="grid grid-cols-3 gap-4 mb-4 text-center">
                    <div>
                      <p className="text-xs text-gray-500 dark:text-gray-400">Total Allocated</p>
                      <p className="text-lg font-bold text-gray-900 dark:text-white">{formatCurrency(bud.total_amount)}</p>
                    </div>
                    <div>
                      <p className="text-xs text-gray-500 dark:text-gray-400">Used</p>
                      <p className="text-lg font-bold text-red-600 dark:text-red-400">{formatCurrency(bud.used_amount)}</p>
                    </div>
                    <div>
                      <p className="text-xs text-gray-500 dark:text-gray-400">Remaining</p>
                      <p className={`text-lg font-bold ${Number(util.percent) >= 100 ? 'text-red-600 dark:text-red-400' : 'text-green-600 dark:text-green-400'}`}>{formatCurrency(remaining)}</p>
                    </div>
                  </div>

                  {/* PROGRESS BAR */}
                  <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-2.5 mb-3">
                    <div className={`${util.bg} h-2.5 rounded-full transition-all`} style={{ width: `${Math.min(Number(util.percent), 100)}%` }}></div>
                  </div>
                  
                  {/* BOTTOM INFO */}
                  <div className="flex justify-between items-center text-sm">
                    <span className={`${util.color} font-medium flex items-center gap-1`}>
                      {Number(util.percent) >= 80 && <AlertTriangle size={14}/>}
                      {util.percent}% Utilized
                    </span>
                    <span className="text-gray-400 dark:text-gray-500">{linkedProjects.length} Projects Linked</span>
                  </div>
                </div>
              );
            })
          )
        )}
      </div>

      {/* FORM MODAL */}
      {showForm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60">
          <div className="relative w-full max-w-md bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-6 max-h-[90vh] overflow-y-auto shadow-xl animate-slide-up">
            <button
              onClick={() => setShowForm(false)}
              className="absolute top-4 right-4 p-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-white transition-colors"
            >
              <X size={20} />
            </button>

            <h2 className="text-xl font-bold text-gray-900 dark:text-white mb-4">{editingData ? "Edit" : "Create"} Budget</h2>
            
              <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Budget Name</label>
                <input 
                  type="text" 
                  value={editingData?.name || ""} 
                  onChange={(e) => setEditingData(prev => prev ? { ...prev, name: e.target.value } : null)} 
                  className="w-full px-3 py-2 bg-gray-50 dark:bg-gray-900 border border-gray-300 dark:border-gray-700 rounded-lg text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500" 
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Category</label>
                <select 
                  value={editingData?.category || "Operational"} 
                  onChange={(e) => setEditingData(prev => prev ? { ...prev, category: e.target.value } : null)} 
                  className="w-full px-3 py-2 bg-gray-50 dark:bg-gray-900 border border-gray-300 dark:border-gray-700 rounded-lg text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  {["Operational", "Project Specific", "Marketing", "Salary", "IT & Infrastructure"].map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Total Amount (PKR)</label>
                <input 
                  type="number" 
                  value={editingData?.total_amount || 0} 
                  onChange={(e) => setEditingData(prev => prev ? { ...prev, total_amount: Number(e.target.value) } : null)} 
                  className="w-full px-3 py-2 bg-gray-50 dark:bg-gray-900 border border-gray-300 dark:border-gray-700 rounded-lg text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500" 
                />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Start Date</label>
                  <input 
                    type="date" 
                    value={editingData?.start_date || new Date().toISOString().split('T')[0]} 
                    onChange={(e) => setEditingData(prev => prev ? { ...prev, start_date: e.target.value } : null)} 
                    className="w-full px-3 py-2 bg-gray-50 dark:bg-gray-900 border border-gray-300 dark:border-gray-700 rounded-lg text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500" 
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">End Date</label>
                  <input 
                    type="date" 
                    value={editingData?.end_date || ""} 
                    onChange={(e) => setEditingData(prev => prev ? { ...prev, end_date: e.target.value } : null)} 
                    className="w-full px-3 py-2 bg-gray-50 dark:bg-gray-900 border border-gray-300 dark:border-gray-700 rounded-lg text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500" 
                  />
                </div>
              </div>
            </div>
            <div className="flex gap-3 mt-6">
              <button onClick={() => setShowForm(false)} className="flex-1 px-4 py-2.5 bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 text-gray-800 dark:text-white rounded-lg text-sm font-medium transition-colors">Cancel</button>
              <button onClick={() => editingData && handleSubmit(editingData)} disabled={!editingData?.name || !editingData?.end_date} className="flex-1 px-4 py-2.5 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-medium transition-colors disabled:opacity-50">Save</button>
            </div>
          </div>
        </div>
      )}

      {/* DELETE MODAL */}
      {deleteId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60">
          <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-6 w-full max-w-sm text-center shadow-xl">
            <h3 className="text-lg font-bold text-gray-900 dark:text-white mb-2">Delete Budget?</h3>
            <p className="text-gray-500 dark:text-gray-400 text-sm mb-6">This will unlink it from projects but won't delete expenses.</p>
            <div className="flex gap-3">
              <button onClick={() => setDeleteId(null)} className="flex-1 px-4 py-2.5 bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 text-gray-800 dark:text-white rounded-lg transition-colors">Cancel</button>
              <button onClick={handleDelete} className="flex-1 px-4 py-2.5 bg-red-600 hover:bg-red-700 text-white rounded-lg transition-colors">Delete</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}