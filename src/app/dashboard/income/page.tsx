"use client";
import { useEffect, useState, useCallback } from "react";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/context/AuthContext";
import { Income, IncomeFormData, Project } from "@/types";
import IncomeForm from "@/components/sections/IncomeForm";
import { Plus, Pencil, Trash2 } from "lucide-react";
import { logAction } from "@/lib/logAction";

export default function IncomePage() {
  const { user, hasPermission, isAdmin } = useAuth();
  const [incomes, setIncomes] = useState<Income[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [formLoading, setFormLoading] = useState(false);
  
  const [showForm, setShowForm] = useState(false);
  const [editingData, setEditingData] = useState<Income | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);

  const canAdd = hasPermission("can_add_income") || isAdmin;

  const fetchIncomes = useCallback(async () => {
    if (!user) return;
    const { data, error } = await supabase
      .from("incomes")
      .select("*")
      .order("income_date", { ascending: false });
      
    if (data) setIncomes(data);
    if (error) console.error(error);
    setLoading(false);
  }, [user]);

  const fetchProjects = useCallback(async () => {
    if (!user) return;
    const { data } = await supabase.from("projects").select("*").order("start_date", { ascending: false });
    if (data) setProjects(data);
  }, [user]);

  useEffect(() => { 
    fetchIncomes();
    fetchProjects();
  }, [fetchIncomes, fetchProjects]);

  async function handleSubmit(data: IncomeFormData) {
    setFormLoading(true);
    if (editingData) {
      const { error } = await supabase.from("incomes").update(data).eq("id", editingData.id);
      if (error) alert(error.message);
      else if(user) await logAction(user.id, "Income Updated", "Income", `Updated income: ${data.title}`);
    } else {
      const { error } = await supabase.from("incomes").insert({ ...data, user_id: user?.id });
      if (error) alert(error.message);
      else if(user) await logAction(user.id, "Income Added", "Income", `Added income: ${data.title} of PKR ${data.amount}`);
    }
    setFormLoading(false);
    setShowForm(false);
    setEditingData(null);
    fetchIncomes();
  }

  async function handleDelete() {
    if (!deleteId) return;
    const { error } = await supabase.from("incomes").delete().eq("id", deleteId);
    if (error) alert(error.message);
    if(user) await logAction(user.id, "Income Deleted", "Income", `Deleted income entry`);
    setDeleteId(null);
    fetchIncomes();
  }

  function openAddModal() { setEditingData(null); setShowForm(true); }
  function openEditModal(inc: Income) { setEditingData(inc); setShowForm(true); }
  
  function formatCurrency(amount: number) {
    return new Intl.NumberFormat("en-PK", { style: "currency", currency: "PKR", minimumFractionDigits: 0 }).format(amount);
  }

  function getProjectName(projectId: string | null) {
    if (!projectId) return <span className="text-gray-400 dark:text-gray-500">-</span>;
    const project = projects.find(p => p.id === projectId);
    return project ? <span className="text-blue-600 dark:text-blue-400 font-medium">{project.name}</span> : <span className="text-gray-400 dark:text-gray-500">Deleted</span>;
  }

  return (
    <div>
      {/* HEADER */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-6">
        <div>
          <h2 className="text-2xl font-bold text-gray-900 dark:text-white">Income Management</h2>
          <p className="text-gray-500 dark:text-gray-400 text-sm">Track and manage your earnings</p>
        </div>
        {canAdd && (
          <button onClick={openAddModal} className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-4 py-2.5 rounded-lg font-medium transition-colors w-fit shadow-sm hover:shadow-md">
            <Plus size={18} /> Add Income
          </button>
        )}
      </div>

      {/* TABLE CONTAINER */}
      <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl overflow-hidden shadow-sm dark:shadow-none">
        <table className="w-full text-left">
          <thead className="bg-gray-100 dark:bg-gray-900/70 border-b border-gray-200 dark:border-gray-700">
            <tr>
              <th className="px-4 py-3 text-xs font-semibold text-gray-600 dark:text-gray-400 uppercase tracking-wider">Title</th>
              <th className="px-4 py-3 text-xs font-semibold text-gray-600 dark:text-gray-400 uppercase tracking-wider hidden sm:table-cell">Project</th>
              <th className="px-4 py-3 text-xs font-semibold text-gray-600 dark:text-gray-400 uppercase tracking-wider text-right">Amount</th>
              <th className="px-4 py-3 text-xs font-semibold text-gray-600 dark:text-gray-400 uppercase tracking-wider text-right hidden md:table-cell">Date</th>
              {canAdd && <th className="px-4 py-3 text-xs font-semibold text-gray-600 dark:text-gray-400 uppercase tracking-wider text-right">Actions</th>}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
            {loading && <tr><td colSpan={canAdd ? 5 : 4} className="px-4 py-8 text-center text-gray-500 dark:text-gray-400">Loading...</td></tr>}
            {!loading && incomes.length === 0 && (
              <tr><td colSpan={canAdd ? 5 : 4} className="px-4 py-12 text-center text-gray-500 dark:text-gray-400">No income entries yet. Click "Add Income" to start.</td></tr>
            )}

            {incomes.map(inc => (
              <tr key={inc.id} className="hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors">
                <td className="px-4 py-3">
                  <div className="font-medium text-gray-900 dark:text-white">{inc.title}</div>
                  {inc.description && <div className="text-xs text-gray-500 dark:text-gray-400 truncate max-w-[200px] cursor-help mt-0.5" title={inc.description}>{inc.description}</div>}
                </td>
                <td className="px-4 py-3 hidden sm:table-cell">{getProjectName(inc.project_id)}</td>
                <td className="px-4 py-3 text-right font-semibold text-green-600 dark:text-green-400">{formatCurrency(inc.amount)}</td>
                <td className="px-4 py-3 text-right text-gray-500 dark:text-gray-400 hidden md:table-cell">{new Date(inc.income_date).toLocaleDateString("en-PK")}</td>
                
                {canAdd && (
                  <td className="px-4 py-3 text-right">
                    <div className="flex items-center justify-end gap-2">
                      <button onClick={() => openEditModal(inc)} className="p-1.5 text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-500/10 rounded transition-colors"><Pencil size={16} /></button>
                      <button onClick={() => setDeleteId(inc.id)} className="p-1.5 text-gray-400 hover:text-red-600 dark:hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-500/10 rounded transition-colors"><Trash2 size={16} /></button>
                    </div>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {showForm && (
        <IncomeForm 
          initialData={editingData} 
          onSubmit={handleSubmit} 
          onClose={() => { setShowForm(false); setEditingData(null); }} 
          loading={formLoading}
          projects={projects} 
        />
      )}

      {deleteId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60">
          <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-6 w-full max-w-sm text-center shadow-xl">
            <h3 className="text-lg font-bold text-gray-900 dark:text-white mb-2">Delete Income?</h3>
            <p className="text-gray-500 dark:text-gray-400 text-sm mb-6">This action cannot be undone.</p>
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