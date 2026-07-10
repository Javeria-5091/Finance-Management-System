"use client";
import { useEffect, useState, useCallback } from "react";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/context/AuthContext";
import { Budget, BudgetFormData, Project, Expense } from "@/types";
import { Plus, Pencil, Trash2, AlertTriangle } from "lucide-react";

export default function BudgetsPage() {
  const { user, hasPermission, isAdmin } = useAuth();
  const [budgets, setBudgets] = useState<(Budget & { used_amount: number })[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editingData, setEditingData] = useState<Budget | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);

  const canModify = hasPermission("can_create_project") || isAdmin; // Using project permission for budget

  const fetchData = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    
    const [budRes, projRes, expRes] = await Promise.all([
      supabase.from("budgets").select("*").order("created_at", { ascending: false }),
      supabase.from("projects").select("*, expenses(*)"), // Get projects with their expenses
      supabase.from("expenses").select("*")
    ]);

    if (budRes.data) {
      // Calculate used amount for each budget
      const budgetsWithUsage = await Promise.all(budRes.data.map(async (bud) => {
        // Find projects linked to this budget
        const linkedProjects = projRes.data?.filter(p => p.budget_id === bud.id) || [];
        const linkedProjectIds = linkedProjects.map(p => p.id);
        
        // Sum expenses for those projects
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
    if (total === 0) return { percent: 0, color: "text-gray-400", bg: "bg-gray-500" };
    const percent = (used / total) * 100;
    if (percent >= 100) return { percent: percent.toFixed(1), color: "text-red-400", bg: "bg-red-500" };
    if (percent >= 80) return { percent: percent.toFixed(1), color: "text-yellow-400", bg: "bg-yellow-500" };
    return { percent: percent.toFixed(1), color: "text-green-400", bg: "bg-green-500" };
  }

  function formatCurrency(amount: number) {
    return new Intl.NumberFormat("en-PK", { style: "currency", currency: "PKR", minimumFractionDigits: 0 }).format(amount);
  }

  return (
    <div>
      <div className="flex justify-between items-center mb-6">
        <div>
          <h2 className="text-2xl font-bold text-white">Budget Management</h2>
          <p className="text-gray-400 text-sm">Track organizational and project budgets</p>
        </div>
        {canModify && (
          <button onClick={() => { setEditingData(null); setShowForm(true); }} className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-4 py-2.5 rounded-lg font-medium">
            <Plus size={18} /> Create Budget
          </button>
        )}
      </div>

      {loading ? <div className="text-gray-400 p-8 text-center">Loading Budgets...</div> : (
        <div className="space-y-4">
          {budgets.length === 0 ? <div className="bg-gray-800 p-12 rounded-xl text-center text-gray-500 border border-gray-700">No budgets created yet.</div> : 
           budgets.map(bud => {
              const remaining = bud.total_amount - bud.used_amount;
              const util = getUtilization(bud.total_amount, bud.used_amount);
              const linkedProjects = projects.filter(p => p.budget_id === bud.id);
              
              return (
                <div key={bud.id} className="bg-gray-800 border border-gray-700 rounded-xl p-5">
                  <div className="flex justify-between items-start mb-4">
                    <div>
                      <h3 className="text-lg font-bold text-white">{bud.name}</h3>
                      <p className="text-sm text-gray-400">{bud.category} • Ends: {new Date(bud.end_date).toLocaleDateString("en-PK")}</p>
                    </div>
                    {canModify && (
                      <div className="flex gap-2">
                        <button onClick={() => { setEditingData(bud); setShowForm(true); }} className="p-1.5 text-gray-400 hover:text-blue-400"><Pencil size={16}/></button>
                        <button onClick={() => setDeleteId(bud.id)} className="p-1.5 text-gray-400 hover:text-red-400"><Trash2 size={16}/></button>
                      </div>
                    )}
                  </div>

                  <div className="grid grid-cols-3 gap-4 mb-4 text-center">
                    <div><p className="text-xs text-gray-500">Total Allocated</p><p className="text-lg font-bold text-white">{formatCurrency(bud.total_amount)}</p></div>
                    <div><p className="text-xs text-gray-500">Used</p><p className="text-lg font-bold text-red-400">{formatCurrency(bud.used_amount)}</p></div>
                    <div><p className="text-xs text-gray-500">Remaining</p><p className={`text-lg font-bold ${Number(util.percent) >= 100 ? 'text-red-400' : 'text-green-400'}`}>{formatCurrency(remaining)}</p></div>
                  </div>

                  {/* Progress Bar */}
                  <div className="w-full bg-gray-700 rounded-full h-2.5 mb-3">
                    <div className={`${util.bg} h-2.5 rounded-full transition-all`} style={{ width: `${Math.min(Number(util.percent), 100)}%` }}></div>
                  </div>
                  
                  <div className="flex justify-between items-center text-sm">
                    <span className={`${util.color} font-medium flex items-center gap-1`}>
                      {Number(util.percent) >= 80 && <AlertTriangle size={14}/>} {util.percent}% Utilized
                    </span>
                    <span className="text-gray-500">{linkedProjects.length} Projects Linked</span>
                  </div>
                </div>
              );
            })
          }
        </div>
      )}

      {/* SIMPLE INLINE FORM MODAL */}
      {showForm && (
        <BudgetFormModal initialData={editingData} onSubmit={handleSubmit} onClose={() => { setShowForm(false); setEditingData(null); }} />
      )}

      {deleteId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60">
          <div className="bg-gray-800 border border-gray-700 rounded-xl p-6 w-full max-w-sm text-center">
            <h3 className="text-lg font-bold text-white mb-2">Delete Budget?</h3>
            <p className="text-gray-400 text-sm mb-6">This will unlink it from projects but won't delete expenses.</p>
            <div className="flex gap-3">
              <button onClick={() => setDeleteId(null)} className="flex-1 px-4 py-2.5 bg-gray-700 text-white rounded-lg">Cancel</button>
              <button onClick={handleDelete} className="flex-1 px-4 py-2.5 bg-red-600 text-white rounded-lg">Delete</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// Simple Form Component
function BudgetFormModal({ initialData, onSubmit, onClose }: { initialData: Budget | null, onSubmit: (d: BudgetFormData) => void, onClose: () => void }) {
  const [form, setForm] = useState<BudgetFormData>({
    name: initialData?.name || "",
    category: initialData?.category || "Operational",
    total_amount: initialData?.total_amount || 0,
    start_date: initialData?.start_date || new Date().toISOString().split('T')[0],
    end_date: initialData?.end_date || "",
    description: initialData?.description || "",
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60">
      <div className="bg-gray-800 border border-gray-700 rounded-xl p-6 w-full max-w-md">
        <h2 className="text-xl font-bold text-white mb-4">{initialData ? "Edit" : "Create"} Budget</h2>
        <div className="space-y-4">
          <div>
            <label className="block text-sm text-gray-400 mb-1">Budget Name</label>
            <input type="text" value={form.name} onChange={e => setForm({...form, name: e.target.value})} className="w-full px-3 py-2 bg-gray-900 border border-gray-700 rounded-lg text-white" />
          </div>
          <div>
            <label className="block text-sm text-gray-400 mb-1">Category</label>
            <select value={form.category} onChange={e => setForm({...form, category: e.target.value})} className="w-full px-3 py-2 bg-gray-900 border border-gray-700 rounded-lg text-white">
              {["Operational", "Project Specific", "Marketing", "Salary", "IT & Infrastructure"].map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-sm text-gray-400 mb-1">Total Amount (PKR)</label>
            <input type="number" value={form.total_amount} onChange={e => setForm({...form, total_amount: Number(e.target.value)})} className="w-full px-3 py-2 bg-gray-900 border border-gray-700 rounded-lg text-white" />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm text-gray-400 mb-1">Start Date</label>
              <input type="date" value={form.start_date} onChange={e => setForm({...form, start_date: e.target.value})} className="w-full px-3 py-2 bg-gray-900 border border-gray-700 rounded-lg text-white" />
            </div>
            <div>
              <label className="block text-sm text-gray-400 mb-1">End Date</label>
              <input type="date" value={form.end_date} onChange={e => setForm({...form, end_date: e.target.value})} className="w-full px-3 py-2 bg-gray-900 border border-gray-700 rounded-lg text-white" />
            </div>
          </div>
        </div>
        <div className="flex gap-3 mt-6">
          <button onClick={onClose} className="flex-1 px-4 py-2.5 bg-gray-700 text-white rounded-lg">Cancel</button>
          <button onClick={() => onSubmit(form)} disabled={!form.name || !form.end_date} className="flex-1 px-4 py-2.5 bg-blue-600 text-white rounded-lg disabled:opacity-50">Save</button>
        </div>
      </div>
    </div>
  );
}