"use client";
import { useEffect, useState, useCallback } from "react";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/context/AuthContext";
import { Income, IncomeFormData, Project } from "@/types";
import IncomeForm from "@/components/sections/IncomeForm";
import { Plus, Pencil, Trash2 } from "lucide-react";
import { logAction } from "@/lib/logAction";

export default function IncomePage() {
  const { user, hasPermission } = useAuth();
  
  const [incomes, setIncomes] = useState<Income[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [formLoading, setFormLoading] = useState(false);
  
  const [showForm, setShowForm] = useState(false);
  const [editingData, setEditingData] = useState<Income | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);

  const canAdd = hasPermission("can_add_income");
  const canEdit = hasPermission("can_edit_income");
  const canDelete = hasPermission("can_delete_income");
  const showActions = canEdit || canDelete; 

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
    const { data } = await supabase
      .from("projects")
      .select("*")
      .order("start_date", { ascending: false });
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
    return new Intl.NumberFormat("en-PK", { style: "currency", currency: "PKR" }).format(amount);
  }
const projectMap = new Map(projects.map(p => [p.id, p.name]));
  function getProjectName(projectId: string | null) {
    if (!projectId) return <span className="text-gray-500">-</span>;
    const name = projectMap.get(projectId);
    return name ? <span className="text-blue-400">{name}</span> : <span className="text-gray-500">Deleted</span>;
  }

  return (
    <div>
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-6">
        <div>
          <h2 className="text-2xl font-bold text-white">Income Management</h2>
          <p className="text-gray-400 text-sm">Track and manage your earnings</p>
        </div>
        
        {canAdd && (
          <button onClick={openAddModal} className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-4 py-2.5 rounded-lg font-medium transition-colors w-fit">
            <Plus size={18} /> Add Income
          </button>
        )}
      </div>

      <div className="bg-gray-800 border border-gray-700 rounded-xl overflow-hidden">
        <table className="w-full text-left">
          <thead className="border-b border-gray-700 bg-gray-900/50">
            <tr>
              <th className="px-4 py-3 text-xs font-medium text-gray-400 uppercase">Title</th>
              <th className="px-4 py-3 text-xs font-medium text-gray-400 uppercase hidden sm:table-cell">Project</th>
              <th className="px-4 py-3 text-xs font-medium text-gray-400 uppercase text-right">Amount</th>
              <th className="px-4 py-3 text-xs font-medium text-gray-400 uppercase text-right hidden md:table-cell">Date</th>
              {showActions && (
                <th className="px-4 py-3 text-xs font-medium text-gray-400 uppercase text-right">Actions</th>
              )}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-700">
            {loading && <tr><td colSpan={showActions ? 5 : 4} className="px-4 py-8 text-center text-gray-400">Loading...</td></tr>}
            {!loading && incomes.length === 0 && (
              <tr><td colSpan={showActions ? 5 : 4} className="px-4 py-12 text-center text-gray-400">No income entries yet.</td></tr>
            )}

            {incomes.map(inc => (
              <tr key={inc.id} className="hover:bg-gray-700/50 transition-colors">
                <td className="px-4 py-3">
                  <div className="font-medium text-white">{inc.title}</div>
                  {inc.description && <div className="text-xs text-gray-500 truncate max-w-[200px] cursor-help mt-0.5" title={inc.description}>{inc.description}</div>}
                </td>
                <td className="px-4 py-3 hidden sm:table-cell">{getProjectName(inc.project_id)}</td>
                <td className="px-4 py-3 text-right font-semibold text-green-400">{formatCurrency(inc.amount)}</td>
                <td className="px-4 py-3 text-right text-gray-400 hidden md:table-cell">{new Date(inc.income_date).toLocaleDateString("en-PK")}</td>
                
                {showActions && (
                  <td className="px-4 py-3 text-right">
                    <div className="flex items-center justify-end gap-2">
                      {canEdit && (
                        <button onClick={() => openEditModal(inc)} className="p-1.5 text-gray-400 hover:text-blue-400 hover:bg-blue-500/10 rounded transition-colors"><Pencil size={16} /></button>
                      )}
                      {canDelete && (
                        <button onClick={() => setDeleteId(inc.id)} className="p-1.5 text-gray-400 hover:text-red-400 hover:bg-red-500/10 rounded transition-colors"><Trash2 size={16} /></button>
                      )}
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
          <div className="bg-gray-800 border border-gray-700 rounded-xl p-6 w-full max-w-sm text-center">
            <h3 className="text-lg font-bold text-white mb-2">Delete Income?</h3>
            <p className="text-gray-400 text-sm mb-6">This action cannot be undone.</p>
            <div className="flex gap-3">
              <button onClick={() => setDeleteId(null)} className="flex-1 px-4 py-2.5 bg-gray-700 hover:bg-gray-600 text-white rounded-lg transition-colors">Cancel</button>
              <button onClick={handleDelete} className="flex-1 px-4 py-2.5 bg-red-600 hover:bg-red-700 text-white rounded-lg transition-colors">Delete</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}