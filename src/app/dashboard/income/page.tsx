"use client";
import { useEffect, useState, useCallback } from "react";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/context/AuthContext";
import { Income, IncomeFormData } from "@/types";
import IncomeForm from "@/components/sections/IncomeForm";
import { Plus, Pencil, Trash2 } from "lucide-react";

export default function IncomePage() {
  const { user } = useAuth();
  const [incomes, setIncomes] = useState<Income[]>([]);
  const [loading, setLoading] = useState(true);
  const [formLoading, setFormLoading] = useState(false);
  
  // Modal States
  const [showForm, setShowForm] = useState(false);
  const [editingData, setEditingData] = useState<Income | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);

  // Data Fetch
  const fetchIncomes = useCallback(async () => {
    if (!user) return;
    const { data, error } = await supabase
      .from("incomes")
      .select("*")
      .eq("user_id", user.id)
      .order("income_date", { ascending: false });
      
    if (data) setIncomes(data);
    if (error) console.error(error);
    setLoading(false);
  }, [user]);

  useEffect(() => { fetchIncomes(); }, [fetchIncomes]);

  // Add / Edit Handler
  async function handleSubmit(data: IncomeFormData) {
    setFormLoading(true);
    if (editingData) {
      // UPDATE
      const { error } = await supabase.from("incomes").update(data).eq("id", editingData.id);
      if (error) alert(error.message);
    } else {
      // INSERT
      const { error } = await supabase.from("incomes").insert({ ...data, user_id: user?.id });
      if (error) alert(error.message);
    }
    setFormLoading(false);
    setShowForm(false);
    setEditingData(null);
    fetchIncomes();
  }

  // Delete Handler
  async function handleDelete() {
    if (!deleteId) return;
    const { error } = await supabase.from("incomes").delete().eq("id", deleteId);
    if (error) alert(error.message);
    setDeleteId(null);
    fetchIncomes();
  }

  // Helpers
  function openAddModal() { setEditingData(null); setShowForm(true); }
  function openEditModal(inc: Income) { setEditingData(inc); setShowForm(true); }
  
  function formatCurrency(amount: number) {
    return new Intl.NumberFormat("en-PK", { style: "currency", currency: "PKR" }).format(amount);
  }

  return (
    <div>
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-6">
        <div>
          <h2 className="text-2xl font-bold text-white">Income Management</h2>
          <p className="text-gray-400 text-sm">Track and manage your earnings</p>
        </div>
        <button onClick={openAddModal} className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-4 py-2.5 rounded-lg font-medium transition-colors w-fit">
          <Plus size={18} /> Add Income
        </button>
      </div>

      {/* Table / List */}
      <div className="bg-gray-800 border border-gray-700 rounded-xl overflow-hidden">
        <table className="w-full text-left">
          <thead className="border-b border-gray-700 bg-gray-900/50">
            <tr>
              <th className="px-4 py-3 text-xs font-medium text-gray-400 uppercase">Title</th>
              <th className="px-4 py-3 text-xs font-medium text-gray-400 uppercase hidden sm:table-cell">Category</th>
              <th className="px-4 py-3 text-xs font-medium text-gray-400 uppercase text-right">Amount</th>
              <th className="px-4 py-3 text-xs font-medium text-gray-400 uppercase text-right hidden md:table-cell">Date</th>
              <th className="px-4 py-3 text-xs font-medium text-gray-400 uppercase text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-700">
            {loading && <tr><td colSpan={5} className="px-4 py-8 text-center text-gray-400">Loading...</td></tr>}
            
            {!loading && incomes.length === 0 && (
              <tr><td colSpan={5} className="px-4 py-12 text-center text-gray-400">No income entries yet. Click "Add Income" to start.</td></tr>
            )}

            {incomes.map(inc => (
              <tr key={inc.id} className="hover:bg-gray-700/50 transition-colors">
                <td className="px-4 py-3">
                  <div className="font-medium text-white">{inc.title}</div>
                  {inc.description && <div className="text-xs text-gray-400 truncate max-w-[200px]">{inc.description}</div>}
                </td>
                <td className="px-4 py-3 hidden sm:table-cell"><span className="bg-gray-700 text-gray-300 text-xs px-2 py-1 rounded">{inc.category}</span></td>
                <td className="px-4 py-3 text-right font-semibold text-green-400">{formatCurrency(inc.amount)}</td>
                <td className="px-4 py-3 text-right text-gray-400 hidden md:table-cell">{new Date(inc.income_date).toLocaleDateString("en-PK")}</td>
                <td className="px-4 py-3 text-right">
                  <div className="flex items-center justify-end gap-2">
                    <button onClick={() => openEditModal(inc)} className="p-1.5 text-gray-400 hover:text-blue-400 hover:bg-blue-500/10 rounded transition-colors"><Pencil size={16} /></button>
                    <button onClick={() => setDeleteId(inc.id)} className="p-1.5 text-gray-400 hover:text-red-400 hover:bg-red-500/10 rounded transition-colors"><Trash2 size={16} /></button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Add/Edit Modal */}
      {showForm && (
        <IncomeForm 
          initialData={editingData} 
          onSubmit={handleSubmit} 
          onClose={() => { setShowForm(false); setEditingData(null); }} 
          loading={formLoading} 
        />
      )}

      {/* Delete Confirmation Modal */}
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