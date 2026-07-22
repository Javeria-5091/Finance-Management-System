"use client";
import { useEffect, useState, useCallback } from "react";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/context/AuthContext";
import { usePermissions } from "@/hooks/usePermissions"; 
import { Expense, ExpenseFormData, Project } from "@/types";
import ExpenseForm from "@/components/sections/ExpenseForm";
import StatusActions from "@/components/finance/StatusActions";
import ReasonModal from "@/components/finance/ReasonModal";
import { Plus, AlertTriangle } from "lucide-react";
import { logAction } from "@/lib/logAction";

const STATUS_STYLES: Record<string, string> = {
  DRAFT: "bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300",
  SUBMITTED: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400",
  APPROVED: "bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400",
  POSTED: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400",
  REJECTED: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400",
  REVERSED: "bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400",
};

export default function ExpensesPage() {
  const { user } = useAuth();
  const { hasPermission } = usePermissions(); 
  const canAdd = hasPermission("EXPENSE_CREATE"); 
  
  const [expenses, setExpenses] = useState<any[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  
  const [showForm, setShowForm] = useState(false);
  const [editingData, setEditingData] = useState<Expense | null>(null);
  const [selectedExp, setSelectedExp] = useState<any>(null);
  
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [showReasonModal, setShowReasonModal] = useState(false);
  const [pendingAction, setPendingAction] = useState<string>("");
  const [reason, setReason] = useState("");

  const fetchExpenses = useCallback(async () => {
    if (!user) return;
    const { data } = await supabase.from("expenses").select("*").order("expense_date", { ascending: false });
    if (data) setExpenses(data);
    setLoading(false);
  }, [user]);

  const fetchProjects = useCallback(async () => {
    if (!user) return;
    const { data } = await supabase.from("projects").select("*");
    if (data) setProjects(data);
  }, [user]);

  useEffect(() => { fetchExpenses(); fetchProjects(); }, [fetchExpenses, fetchProjects]);

  async function handleSubmit(data: ExpenseFormData) {
    if (editingData) {
      await supabase.from("expenses").update(data).eq("id", editingData.id);
    } else {
      await supabase.from("expenses").insert({ ...data, user_id: user?.id, status: "DRAFT" });
    }
    setShowForm(false); setEditingData(null); fetchExpenses();
  }

  async function handleAction(action: string, needsReason?: boolean) {
    if (!selectedExp) return;

    if (needsReason) {
      setPendingAction(action);
      setShowReasonModal(true);
      return;
    }

    if (action === "edit") {
      setEditingData(selectedExp);
      setShowForm(true);
      return;
    }

    if (action === "delete") {
      setShowDeleteModal(true);
      return;
    }

    if (action === "post") {
      await supabase.from("expenses").update({ status: 'POSTED', posted_at: new Date().toISOString() }).eq("id", selectedExp.id);
    } else {
      const updateData: any = { status: action.toUpperCase() === "REOPEN" ? "DRAFT" : action.toUpperCase() };
      await supabase.from("expenses").update(updateData).eq("id", selectedExp.id);
    }
    fetchExpenses();
  }

  async function confirmReason() {
    if (!selectedExp || !reason.trim()) return;
    await supabase.from("expenses").update({ 
      status: pendingAction === "REOPEN" ? "DRAFT" : pendingAction.toUpperCase(), 
      rejection_reason: reason 
    }).eq("id", selectedExp.id);
    setShowReasonModal(false); setReason(""); fetchExpenses();
  }

  async function confirmDelete() {
    if (!selectedExp) return;
    await supabase.from("expenses").delete().eq("id", selectedExp.id);
    setShowDeleteModal(false); fetchExpenses();
  }

  function formatCurrency(amount: number) {
    return new Intl.NumberFormat("en-PK", { style: "currency", currency: "PKR", minimumFractionDigits: 0 }).format(amount);
  }

  return (
    <div>
      <div className="flex justify-between mb-6">
        <div>
          <h2 className="text-2xl font-bold text-gray-900 dark:text-white">Expense Management</h2>
          <p className="text-gray-500 text-sm">Double-entry workflow enabled</p>
        </div>
        {/*  HOOK USED HERE: Sirf dikhao agar permission hai */}
        {canAdd && (
          <button onClick={() => { setEditingData(null); setShowForm(true); }} className="flex items-center gap-2 bg-blue-600 text-white px-4 py-2.5 rounded-lg font-medium w-fit">
            <Plus size={18} /> Add Expense
          </button>
        )}
      </div>

      <div className="bg-white dark:bg-gray-800 border dark:border-gray-700 rounded-xl overflow-hidden">
        <table className="w-full text-left">
          <thead className="bg-gray-100 dark:bg-gray-900/70 border-b dark:border-gray-700 text-xs text-gray-500 uppercase">
            <tr>
              <th className="px-4 py-3">Title</th>
              <th className="px-4 py-3 hidden md:table-cell">Project</th>
              <th className="px-4 py-3 text-right">Amount</th>
              <th className="px-4 py-3 text-center">Status</th>
              <th className="px-4 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y dark:divide-gray-700">
            {loading && <tr><td colSpan={5} className="p-8 text-center text-gray-400">Loading...</td></tr>}
            {expenses.map(exp => (
              <tr key={exp.id} className="hover:bg-gray-50 dark:hover:bg-gray-700/50">
                <td className="px-4 py-3">
                  <div className="font-medium text-gray-900 dark:text-white">{exp.title}</div>
                  <div className="text-xs text-gray-500">{new Date(exp.expense_date).toLocaleDateString("en-PK")}</div>
                </td>
                <td className="px-4 py-3 hidden md:table-cell text-blue-600 dark:text-blue-400">
                  {projects.find(p => p.id === exp.project_id)?.name || "-"}
                </td>
                <td className="px-4 py-3 text-right font-semibold text-red-600">{formatCurrency(exp.amount)}</td>
                <td className="px-4 py-3 text-center">
                  <span className={`px-2 py-0.5 rounded text-xs font-medium ${STATUS_STYLES[exp.status]}`}>{exp.status}</span>
                </td>
                <td className="px-4 py-3 text-right">
                  <div onClick={() => setSelectedExp(exp)}>
                    <StatusActions record={exp} module="expense" onAction={handleAction} />
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {showForm && <ExpenseForm initialData={editingData} onSubmit={handleSubmit} onClose={() => setShowForm(false)} loading={false} projects={projects} />}
      <ReasonModal open={showReasonModal} title={`Confirm ${pendingAction}`} onConfirm={confirmReason} onCancel={() => setShowReasonModal(false)} />
      
      {showDeleteModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60">
          <div className="bg-white dark:bg-gray-800 border dark:border-gray-700 rounded-xl p-6 w-full max-w-sm text-center">
            <AlertTriangle className="w-10 h-10 text-red-500 mx-auto mb-3" />
            <h3 className="text-lg font-bold text-gray-900 dark:text-white mb-2">Delete DRAFT Expense?</h3>
            <p className="text-gray-500 text-sm mb-6">This cannot be undone.</p>
            <div className="flex gap-3">
              <button onClick={() => setShowDeleteModal(false)} className="flex-1 px-4 py-2 bg-gray-100 dark:bg-gray-700 rounded-lg">Cancel</button>
              <button onClick={confirmDelete} className="flex-1 px-4 py-2 bg-red-600 text-white rounded-lg">Delete</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}