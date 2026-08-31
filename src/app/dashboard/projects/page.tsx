"use client";
import { useEffect, useState, useCallback } from "react";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/context/AuthContext";
import { usePermissions } from "@/context/PermissionContext";
import { Project, ProjectFormData, Budget, Expense } from "@/types";
import ProjectForm from "@/components/sections/ProjectForm";
import { Plus, Pencil, Trash2, AlertTriangle } from "lucide-react";
import { logAction } from "@/lib/logAction";
import toast from "react-hot-toast";

export default function ProjectsPage() {
  const { user } = useAuth();
  const { hasPermission } = usePermissions();
  const [projects, setProjects] = useState<Project[]>([]);
  const [budgets, setBudgets] = useState<Budget[]>([]);
  const [clients, setClients] = useState<{ id: string; name: string }[]>([]);
  const [managers, setManagers] = useState<{ user_id: string; full_name: string }[]>([]);
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [loading, setLoading] = useState(true);
  const [formLoading, setFormLoading] = useState(false);
  
  const [showForm, setShowForm] = useState(false);
  const [editingData, setEditingData] = useState<Project | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);

  const canRead = hasPermission("PROJECT_READ");
  const canCreate = hasPermission("PROJECT_CREATE");
  const canUpdate = hasPermission("PROJECT_UPDATE");
  const canDelete = hasPermission("PROJECT_DELETE");
  const canViewRates = hasPermission("PROJECT_RATE_VIEW");
  const canModify = canCreate || canUpdate || canDelete;

  const fetchProjects = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    
    try {
      const [projRes, budRes, expRes, clientsRes, managersRes] = await Promise.all([
        fetch("/api/projects?page=1&pageSize=100"),
        fetch("/api/finance/budgets").then(async r => { const j = await r.json(); if (!r.ok) throw new Error(j.error || "Failed to load budgets"); return { data: j.data || [] }; }),
        supabase.from("expenses").select("*").eq("status", "POSTED"),
        supabase.from("clients").select("id,name").eq("status", "ACTIVE").order("name"),
        supabase.from("profiles").select("user_id,full_name").order("full_name")
      ]);
      const projectJson = await projRes.json();
      if (!projRes.ok) throw new Error(projectJson.error || "Failed to load projects");
      setProjects((projectJson.data || []) as Project[]);
      if (budRes.data) setBudgets(budRes.data);
      if (expRes.data) setExpenses(expRes.data);
      if (clientsRes.data) setClients(clientsRes.data);
      if (managersRes.data) setManagers(managersRes.data);
    } catch (err: any) {
      toast.error("Failed to load projects: " + (err.message || "Unknown error"));
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => { fetchProjects(); }, [fetchProjects]);

  function getProjectBudgetStats(project: Project) {
    if (!project.budget_id) return null;
    const budget = budgets.find(b => b.id === project.budget_id);
    if (!budget) return null;

    const projectExpenses = expenses.filter(e => e.project_id === project.id);
    const usedAmount = projectExpenses.reduce((sum, e) => sum + Number(e.amount), 0);
    const remaining = budget.total_amount - usedAmount;
    const percentage = budget.total_amount > 0 ? (usedAmount / budget.total_amount) * 100 : 0;

    let status: "Within Budget" | "Near Limit" | "Over Budget" = "Within Budget";
    let statusColor = "text-green-600 dark:text-green-400";
    
    if (percentage >= 100) { status = "Over Budget"; statusColor = "text-red-600 dark:text-red-400"; }
    else if (percentage >= 80) { status = "Near Limit"; statusColor = "text-yellow-600 dark:text-yellow-400"; }

    return { budget, usedAmount, remaining, percentage, status, statusColor };
  }

    async function handleSubmit(data: ProjectFormData) {
    if (editingData && !canUpdate) {
      toast.error("You do not have permission to update projects.");
      return;
    }
    if (!editingData && !canCreate) {
      toast.error("You do not have permission to create projects.");
      return;
    }
    setFormLoading(true);
    try {
      const safeData = { ...data, end_date: data.end_date === "" ? null : data.end_date };
      const response = await fetch(editingData ? `/api/projects/${editingData.id}` : "/api/projects", {
        method: editingData ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(safeData),
      });
      const json = await response.json();
      if (!response.ok) throw new Error(json.error || "Project save failed");
      toast.success(editingData ? "Project updated successfully" : "Project created successfully");
      setShowForm(false);
      setEditingData(null);
      await fetchProjects();
    } catch (err: any) {
      toast.error(`Project save failed: ${err.message || "Unknown error"}`);
    } finally {
      setFormLoading(false);
    }
  }

  async function handleDelete() {
    if (!deleteId) return;
    if (!canDelete) {
      toast.error("You do not have permission to delete projects.");
      return;
    }
    const project = projects.find(p => p.id === deleteId);
    try {
      const response = await fetch(`/api/projects/${deleteId}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: "Project deactivated from Projects module" }),
      });
      const json = await response.json();
      if (!response.ok) throw new Error(json.error || "Project deletion failed");
      if (project) await logAction({ action: "DELETE", entityType: "Project", entityId: deleteId, description: `Deactivated project: ${project.name}`, severity: "high", sourceModule: "projects" });
      setDeleteId(null);
      await fetchProjects();
    } catch (err: any) {
      console.error("Project delete error:", err);
      toast.error(`Failed to deactivate project: ${err.message}`);
    }
  }
  
  function getStatusColor(status: string) {
    if (status === "Active" || status === "ACTIVE") return "bg-green-100 text-green-700 dark:bg-green-500/20 dark:text-green-400";
    if (status === "Completed" || status === "CLOSED") return "bg-blue-100 text-blue-700 dark:bg-blue-500/20 dark:text-blue-400";
    if (status === "CANCELLED") return "bg-red-100 text-red-700 dark:bg-red-500/20 dark:text-red-400";
    return "bg-yellow-100 text-yellow-700 dark:bg-yellow-500/20 dark:text-yellow-400";
  }

  function formatCurrency(amount: number) {
    return new Intl.NumberFormat("en-PK", { style: "currency", currency: "PKR", minimumFractionDigits: 0 }).format(amount);
  }

  if (!canRead) {
    return (
      <div className="p-8 text-center">
        <h2 className="text-xl font-semibold text-gray-900 dark:text-white">Access denied</h2>
        <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">You do not have permission to view projects.</p>
      </div>
    );
  }

  return (
    <div>
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-6">
        <div>
          <h2 className="text-2xl font-bold text-gray-900 dark:text-white">Projects</h2>
          <p className="text-gray-500 dark:text-gray-400 text-sm">Manage projects and track budget utilization</p>
        </div>
        {canCreate && (
          <button onClick={() => { setEditingData(null); setShowForm(true); }} className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-4 py-2.5 rounded-lg font-medium transition-colors w-fit shadow-sm hover:shadow-md">
            <Plus size={18} /> Add Project
          </button>
        )}
      </div>

      <div className="grid gap-4">
        {loading && <div className="text-gray-500 dark:text-gray-400 p-8 text-center bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 shadow-sm">Loading Projects...</div>}
        
        {!loading && projects.length === 0 && <div className="text-gray-500 dark:text-gray-400 p-12 text-center bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 shadow-sm">No projects yet.</div>}

        {!loading && projects.map(p => {
          const budgetStats = getProjectBudgetStats(p);
          return (
            <div key={p.id} className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-5 hover:border-gray-300 dark:hover:border-gray-600 transition-all shadow-sm dark:shadow-none">
              <div className="flex justify-between items-start mb-3">
                <div className="flex-1">
                  <div className="flex items-center gap-3">
                    <h3 className="text-lg font-bold text-gray-900 dark:text-white">{p.name}</h3>
                    <span className={`text-xs px-2 py-1 rounded font-medium ${getStatusColor(p.status)}`}>{p.status}</span>
                  </div>
                  <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">Client: {p.client_name || p.client?.name || "—"}</p>
                  {canViewRates && <p className="text-xs text-gray-400 mt-1">Contract: {p.currency || "PKR"} {Number(p.contract_value || 0).toLocaleString()}</p>}
                </div>
                {(canUpdate || canDelete) ? (
                  <div className="flex gap-2 ml-4">
                    {canUpdate && <button onClick={() => { setEditingData(p); setShowForm(true); }} className="p-1.5 text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-500/10 rounded"><Pencil size={16} /></button>}
                    {canDelete && <button onClick={() => setDeleteId(p.id)} className="p-1.5 text-gray-400 hover:text-red-600 dark:hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-500/10 rounded"><Trash2 size={16} /></button>}
                  </div>
                ) : null}
              </div>

              {/* BUDGET STATS SECTION */}
              {budgetStats ? (
                <div className="mt-4 bg-gray-50 dark:bg-gray-900/50 rounded-lg p-4 border border-gray-200 dark:border-gray-700/50">
                  <div className="flex justify-between items-center mb-2">
                    <span className="text-sm font-medium text-gray-600 dark:text-gray-300">Budget: {budgetStats.budget.name}</span>
                    <span className={`text-sm font-bold flex items-center gap-1 ${budgetStats.statusColor}`}>
                      {budgetStats.status === "Over Budget" && <AlertTriangle size={14}/>}
                      {budgetStats.status}
                    </span>
                  </div>
                  
                  <div className="grid grid-cols-3 gap-4 mb-3 text-center">
                    <div><p className="text-xs text-gray-500 dark:text-gray-400">Allocated</p><p className="text-sm font-bold text-gray-900 dark:text-white">{formatCurrency(budgetStats.budget.total_amount)}</p></div>
                    <div><p className="text-xs text-gray-500 dark:text-gray-400">Spent</p><p className="text-sm font-bold text-red-600 dark:text-red-400">{formatCurrency(budgetStats.usedAmount)}</p></div>
                    <div><p className="text-xs text-gray-500 dark:text-gray-400">Remaining</p><p className={`text-sm font-bold ${budgetStats.remaining < 0 ? 'text-red-600 dark:text-red-400' : 'text-green-600 dark:text-green-400'}`}>{formatCurrency(budgetStats.remaining)}</p></div>
                  </div>

                  <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-2">
                    <div className={`h-2 rounded-full transition-all ${budgetStats.percentage >= 100 ? 'bg-red-500' : budgetStats.percentage >= 80 ? 'bg-yellow-500' : 'bg-green-500'}`} style={{ width: `${Math.min(budgetStats.percentage, 100)}%` }}></div>
                  </div>
                  <p className="text-xs text-gray-500 dark:text-gray-400 text-right mt-1">{budgetStats.percentage.toFixed(1)}% Used</p>
                </div>
              ) : (
                <p className="text-xs text-gray-400 dark:text-gray-500 mt-3 italic">No budget allocated to this project.</p>
              )}
            </div>
          );
        })}
      </div>

      {showForm && <ProjectForm initialData={editingData} onSubmit={handleSubmit} onClose={() => { setShowForm(false); setEditingData(null); }} loading={formLoading} budgets={budgets} clients={clients} managers={managers} canViewRates={canViewRates} />}

      {deleteId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60">
          <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-6 w-full max-w-sm text-center shadow-xl">
            <h3 className="text-lg font-bold text-gray-900 dark:text-white mb-2">Delete Project?</h3>
            <p className="text-gray-500 dark:text-gray-400 text-sm mb-6 text-red-500">This will deactivate the project. Related financial records will be preserved.</p>
            <div className="flex gap-3">
              <button onClick={() => setDeleteId(null)} className="flex-1 px-4 py-2.5 bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 text-gray-800 dark:text-white rounded-lg transition-colors font-medium">Cancel</button>
              <button onClick={handleDelete} className="flex-1 px-4 py-2.5 bg-red-600 hover:bg-red-700 text-white rounded-lg transition-colors font-medium">Delete</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}