"use client";
import { useEffect, useState, useCallback } from "react";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/context/AuthContext";
import { Project, ProjectFormData, Budget, Expense } from "@/types";
import ProjectForm from "@/components/sections/ProjectForm";
import { Plus, Pencil, Trash2, AlertTriangle } from "lucide-react";
import { logAction } from "@/lib/logAction";

export default function ProjectsPage() {
  const { user, hasPermission, isAdmin } = useAuth();
  const [projects, setProjects] = useState<Project[]>([]);
  const [budgets, setBudgets] = useState<Budget[]>([]);
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [loading, setLoading] = useState(true);
  const [formLoading, setFormLoading] = useState(false);
  
  const [showForm, setShowForm] = useState(false);
  const [editingData, setEditingData] = useState<Project | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);

  const canModify = hasPermission("can_create_project") || isAdmin;

  const fetchProjects = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    
    const [projRes, budRes, expRes] = await Promise.all([
      supabase.from("projects").select("*").order("created_at", { ascending: false }),
      supabase.from("budgets").select("*"),
      supabase.from("expenses").select("*")
    ]);

    if (projRes.data) setProjects(projRes.data);
    if (budRes.data) setBudgets(budRes.data);
    if (expRes.data) setExpenses(expRes.data);
    setLoading(false);
  }, [user]);

  useEffect(() => { fetchProjects(); }, [fetchProjects]);

  // BUDGET CALCULATION HELPER
  function getProjectBudgetStats(project: Project) {
    if (!project.budget_id) return null;
    
    const budget = budgets.find(b => b.id === project.budget_id);
    if (!budget) return null;

    const projectExpenses = expenses.filter(e => e.project_id === project.id);
    const usedAmount = projectExpenses.reduce((sum, e) => sum + Number(e.amount), 0);
    const remaining = budget.total_amount - usedAmount;
    const percentage = budget.total_amount > 0 ? (usedAmount / budget.total_amount) * 100 : 0;

    let status: "Within Budget" | "Near Limit" | "Over Budget" = "Within Budget";
    let statusColor = "text-green-400";
    
    if (percentage >= 100) { status = "Over Budget"; statusColor = "text-red-400"; }
    else if (percentage >= 80) { status = "Near Limit"; statusColor = "text-yellow-400"; }

    return { budget, usedAmount, remaining, percentage, status, statusColor };
  }

  async function handleSubmit(data: ProjectFormData) {
    setFormLoading(true);
    const safeData = { ...data, end_date: data.end_date === "" ? null : data.end_date };
    let error = null;

    if (editingData) {
      const res = await supabase.from("projects").update(safeData).eq("id", editingData.id);
      error = res.error;
      if(!error && user) await logAction(user.id, "Project Updated", "Project", `Updated project: ${safeData.name}`);
    } else {
      const res = await supabase.from("projects").insert({ ...safeData, user_id: user?.id });
      error = res.error;
      if(!error && user) await logAction(user.id, "Project Created", "Project", `Created project: ${safeData.name}`);
    }

    if (error) alert("Database Error: " + error.message);
    else { setShowForm(false); setEditingData(null); fetchProjects(); }
    setFormLoading(false);
  }

  async function handleDelete() {
    if (!deleteId) return;
    const project = projects.find(p => p.id === deleteId);
    await supabase.from("projects").delete().eq("id", deleteId);
    if(user && project) await logAction(user.id, "Project Deleted", "Project", `Deleted project: ${project.name}`);
    setDeleteId(null); fetchProjects();
  }

  function getStatusColor(status: string) {
    if (status === "Active") return "bg-green-500/20 text-green-400";
    if (status === "Completed") return "bg-blue-500/20 text-blue-400";
    return "bg-yellow-500/20 text-yellow-400";
  }

  function formatCurrency(amount: number) {
    return new Intl.NumberFormat("en-PK", { style: "currency", currency: "PKR", minimumFractionDigits: 0 }).format(amount);
  }

  return (
    <div>
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-6">
        <div>
          <h2 className="text-2xl font-bold text-white">Projects</h2>
          <p className="text-gray-400 text-sm">Manage projects and track budget utilization</p>
        </div>
        {canModify && (
          <button onClick={() => { setEditingData(null); setShowForm(true); }} className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-4 py-2.5 rounded-lg font-medium transition-colors w-fit">
            <Plus size={18} /> Add Project
          </button>
        )}
      </div>

      <div className="grid gap-4">
        {loading && <div className="text-gray-400 p-8 text-center bg-gray-800 rounded-xl border border-gray-700">Loading Projects...</div>}
        
        {!loading && projects.length === 0 && <div className="text-gray-500 p-12 text-center bg-gray-800 rounded-xl border border-gray-700">No projects yet.</div>}

        {!loading && projects.map(p => {
          const budgetStats = getProjectBudgetStats(p);
          return (
            <div key={p.id} className="bg-gray-800 border border-gray-700 rounded-xl p-5 hover:border-gray-600 transition-colors">
              <div className="flex justify-between items-start mb-3">
                <div className="flex-1">
                  <div className="flex items-center gap-3">
                    <h3 className="text-lg font-bold text-white">{p.name}</h3>
                    <span className={`text-xs px-2 py-1 rounded ${getStatusColor(p.status)}`}>{p.status}</span>
                  </div>
                  <p className="text-sm text-gray-400 mt-1">Client: {p.client_name}</p>
                </div>
                {canModify && (
                  <div className="flex gap-2">
                    <button onClick={() => { setEditingData(p); setShowForm(true); }} className="p-1.5 text-gray-400 hover:text-blue-400 hover:bg-blue-500/10 rounded"><Pencil size={16} /></button>
                    <button onClick={() => setDeleteId(p.id)} className="p-1.5 text-gray-400 hover:text-red-400 hover:bg-red-500/10 rounded"><Trash2 size={16} /></button>
                  </div>
                )}
              </div>

              {/* BUDGET STATS SECTION */}
              {budgetStats ? (
                <div className="mt-4 bg-gray-900/50 rounded-lg p-4 border border-gray-700/50">
                  <div className="flex justify-between items-center mb-2">
                    <span className="text-sm text-gray-400">Budget: {budgetStats.budget.name}</span>
                    <span className={`text-sm font-bold flex items-center gap-1 ${budgetStats.statusColor}`}>
                      {budgetStats.status === "Over Budget" && <AlertTriangle size={14}/>}
                      {budgetStats.status}
                    </span>
                  </div>
                  
                  <div className="grid grid-cols-3 gap-4 mb-3 text-center">
                    <div><p className="text-xs text-gray-500">Allocated</p><p className="text-sm font-bold text-white">{formatCurrency(budgetStats.budget.total_amount)}</p></div>
                    <div><p className="text-xs text-gray-500">Spent</p><p className="text-sm font-bold text-red-400">{formatCurrency(budgetStats.usedAmount)}</p></div>
                    <div><p className="text-xs text-gray-500">Remaining</p><p className={`text-sm font-bold ${budgetStats.remaining < 0 ? 'text-red-400' : 'text-green-400'}`}>{formatCurrency(budgetStats.remaining)}</p></div>
                  </div>

                  <div className="w-full bg-gray-700 rounded-full h-2">
                    <div className={`h-2 rounded-full transition-all ${budgetStats.percentage >= 100 ? 'bg-red-500' : budgetStats.percentage >= 80 ? 'bg-yellow-500' : 'bg-green-500'}`} style={{ width: `${Math.min(budgetStats.percentage, 100)}%` }}></div>
                  </div>
                  <p className="text-xs text-gray-500 text-right mt-1">{budgetStats.percentage.toFixed(1)}% Used</p>
                </div>
              ) : (
                <p className="text-xs text-gray-600 mt-3 italic">No budget allocated to this project.</p>
              )}
            </div>
          );
        })}
      </div>

      {showForm && <ProjectForm initialData={editingData} onSubmit={handleSubmit} onClose={() => { setShowForm(false); setEditingData(null); }} loading={formLoading} budgets={budgets} />}

      {deleteId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60">
          <div className="bg-gray-800 border border-gray-700 rounded-xl p-6 w-full max-w-sm text-center">
            <h3 className="text-lg font-bold text-white mb-2">Delete Project?</h3>
            <p className="text-gray-400 text-sm mb-6 text-red-300">Warning: This will permanently delete all related incomes and expenses.</p>
            <div className="flex gap-3">
              <button onClick={() => setDeleteId(null)} className="flex-1 px-4 py-2.5 bg-gray-700 hover:bg-gray-600 text-white rounded-lg">Cancel</button>
              <button onClick={handleDelete} className="flex-1 px-4 py-2.5 bg-red-600 hover:bg-red-700 text-white rounded-lg">Delete</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}