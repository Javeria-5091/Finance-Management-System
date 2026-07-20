"use client";
import { useEffect, useState, useCallback } from "react";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/context/AuthContext";
import { Expense, ExpenseFormData, Project } from "@/types";
import ExpenseForm from "@/components/sections/ExpenseForm";
import { Plus, Pencil, Trash2, Send, CheckCircle, RotateCcw, XCircle, AlertTriangle } from "lucide-react";
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
  const { user, hasPermission, isAdmin } = useAuth();
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  
  const [showForm, setShowForm] = useState(false);
  const [editingData, setEditingData] = useState<Expense | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [reasonModal, setReasonModal] = useState<{ id: string; type: 'REJECT' | 'REVERSE' } | null>(null);
  const [reason, setReason] = useState("");

  const canModify = hasPermission("can_add_expense") || isAdmin;

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
      if(user) await logAction(user.id, `Updated Expense: ${data.title}`);
    } else {
      await supabase.from("expenses").insert({ ...data, user_id: user?.id, status: "DRAFT" });
      if(user) await logAction(user.id, `Added DRAFT Expense: ${data.title}`);
    }
    setShowForm(false); setEditingData(null); fetchExpenses();
  }

  async function handleDelete() {
    if (!deleteId) return;
    await supabase.from("expenses").delete().eq("id", deleteId);
    if(user) await logAction(user.id, "Deleted DRAFT Expense");
    setDeleteId(null); fetchExpenses();
  }

  async function updateStatus(id: string, newStatus: string, reasonText?: string) {
    setActionLoading(id);
    const payload: any = { status: newStatus };
    if (newStatus === 'SUBMITTED') { payload.submitted_by = user?.id; payload.submitted_at = new Date().toISOString(); }
    if (newStatus === 'APPROVED') { payload.approved_by = user?.id; payload.approved_at = new Date().toISOString(); }
    if (newStatus === 'REJECTED' && reasonText) { payload.rejection_reason = reasonText; }
    
    await supabase.from("expenses").update(payload).eq("id", id);
    if(user) await logAction(user.id, `Expense status changed to ${newStatus}`);
    setActionLoading(null); setReasonModal(null); setReason(""); fetchExpenses();
  }

  async function handlePost(id: string) {
    setActionLoading(id);
    await supabase.from("expenses").update({ status: 'POSTED', posted_at: new Date().toISOString() }).eq("id", id);
    if(user) await logAction(user.id, "Expense Posted to Ledger");
    setActionLoading(null); fetchExpenses();
  }

  function formatCurrency(amount: number) {
    return new Intl.NumberFormat("en-PK", { style: "currency", currency: "PKR", minimumFractionDigits: 0 }).format(amount);
  }

  return (
    <div>
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-6">
        <div>
          <h2 className="text-2xl font-bold text-gray-900 dark:text-white">Expense Management</h2>
          <p className="text-gray-500 dark:text-gray-400 text-sm">Workflow: Draft → Submitted → Approved → Posted</p>
        </div>
        {canModify && (
          <button onClick={() => { setEditingData(null); setShowForm(true); }} className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-4 py-2.5 rounded-lg font-medium transition-colors w-fit">
            <Plus size={18} /> Add Expense
          </button>
        )}
      </div>

      <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl overflow-hidden shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full text-left">
            <thead className="bg-gray-100 dark:bg-gray-900/70 border-b border-gray-200 dark:border-gray-700">
              <tr>
                <th className="px-4 py-3 text-xs font-semibold text-gray-600 dark:text-gray-400 uppercase">Title / Date</th>
                <th className="px-4 py-3 text-xs font-semibold text-gray-600 dark:text-gray-400 uppercase text-right">Amount</th>
                <th className="px-4 py-3 text-xs font-semibold text-gray-600 dark:text-gray-400 uppercase text-center">Status</th>
                <th className="px-4 py-3 text-xs font-semibold text-gray-600 dark:text-gray-400 uppercase text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
              {loading ? (
                <tr><td colSpan={4} className="px-4 py-8 text-center text-gray-500">Loading...</td></tr>
              ) : expenses.length === 0 ? (
                <tr><td colSpan={4} className="px-4 py-12 text-center text-gray-500">No expenses yet.</td></tr>
              ) : (
                expenses.map((exp) => (
                  <tr key={exp.id} className="hover:bg-gray-50 dark:hover:bg-gray-700/50">
                    <td className="px-4 py-3">
                      <div className="font-medium text-gray-900 dark:text-white">{exp.title}</div>
                      <div className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{new Date(exp.expense_date).toLocaleDateString("en-PK")}</div>
                    </td>
                    <td className="px-4 py-3 text-right font-semibold text-red-600 dark:text-red-400">{formatCurrency(exp.amount)}</td>
                    <td className="px-4 py-3 text-center">
                      <span className={`px-2.5 py-1 rounded-full text-xs font-semibold ${STATUS_STYLES[exp.status] || ''}`}>
                        {exp.status}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex items-center justify-end gap-1">
                        {exp.status === 'DRAFT' && (
                          <>
                            <button onClick={() => { setEditingData(exp); setShowForm(true); }} className="p-1.5 text-gray-500 hover:text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-500/10 rounded"><Pencil size={15} /></button>
                            <button onClick={() => setDeleteId(exp.id)} className="p-1.5 text-gray-500 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-500/10 rounded"><Trash2 size={15} /></button>
                            <button onClick={() => updateStatus(exp.id, 'SUBMITTED')} disabled={actionLoading===exp.id} className="p-1.5 text-gray-500 hover:text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-500/10 rounded" title="Submit"><Send size={15} /></button>
                          </>
                        )}
                        {exp.status === 'SUBMITTED' && (
                          <>
                            <button onClick={() => updateStatus(exp.id, 'APPROVED')} disabled={actionLoading===exp.id} className="p-1.5 text-purple-500 hover:text-purple-700 hover:bg-purple-50 dark:hover:bg-purple-500/10 rounded" title="Approve"><CheckCircle size={15} /></button>
                            <button onClick={() => setReasonModal({ id: exp.id, type: 'REJECT' })} className="p-1.5 text-gray-500 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-500/10 rounded" title="Reject"><XCircle size={15} /></button>
                          </>
                        )}
                        {exp.status === 'APPROVED' && (
                          <button onClick={() => handlePost(exp.id)} disabled={actionLoading===exp.id} className="flex items-center gap-1 px-2 py-1 text-xs font-medium bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400 rounded-md" title="Post to Ledger">
                            <CheckCircle size={14} /> Post
                          </button>
                        )}
                        {exp.status === 'POSTED' && (
                          <button onClick={() => setReasonModal({ id: exp.id, type: 'REVERSE' })} className="p-1.5 text-orange-500 hover:text-orange-700 hover:bg-orange-50 dark:hover:bg-orange-500/10 rounded" title="Reverse"><RotateCcw size={15} /></button>
                        )}
                        {exp.status === 'REJECTED' && (
                          <button onClick={() => updateStatus(exp.id, 'DRAFT')} className="p-1.5 text-gray-500 hover:text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-500/10 rounded" title="Reopen"><RotateCcw size={15} /></button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* FORM MODAL */}
      {showForm && <ExpenseForm initialData={editingData} onSubmit={handleSubmit} onClose={() => { setShowForm(false); setEditingData(null); }} loading={false} projects={projects} />}

      {/* DELETE MODAL */}
      {deleteId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60">
          <div className="bg-white dark:bg-gray-800 border dark:border-gray-700 rounded-xl p-6 w-full max-w-sm text-center shadow-xl">
            <AlertTriangle className="w-10 h-10 text-red-500 mx-auto mb-3" />
            <h3 className="text-lg font-bold text-gray-900 dark:text-white mb-2">Delete DRAFT Expense?</h3>
            <p className="text-gray-500 dark:text-gray-400 text-sm mb-6">This action cannot be undone.</p>
            <div className="flex gap-3">
              <button onClick={() => setDeleteId(null)} className="flex-1 px-4 py-2.5 bg-gray-100 dark:bg-gray-700 text-gray-800 dark:text-white rounded-lg">Cancel</button>
              <button onClick={handleDelete} className="flex-1 px-4 py-2.5 bg-red-600 text-white rounded-lg">Delete</button>
            </div>
          </div>
        </div>
      )}

      {/* REJECT / REVERSE MODAL */}
      {reasonModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60">
          <div className="bg-white dark:bg-gray-800 border dark:border-gray-700 rounded-xl p-6 w-full max-w-md shadow-xl">
            <h3 className="text-lg font-bold text-gray-900 dark:text-white mb-4">
              {reasonModal.type === 'REJECT' ? 'Reject Expense' : 'Reverse Posted Expense'}
            </h3>
            <textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason is mandatory..." rows={3} className="w-full p-3 border dark:border-gray-600 rounded-lg bg-transparent dark:bg-gray-700 text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 mb-4" />
            <div className="flex justify-end gap-3">
              <button onClick={() => { setReasonModal(null); setReason(""); }} className="px-4 py-2 bg-gray-100 dark:bg-gray-700 rounded-lg">Cancel</button>
              <button onClick={() => reasonModal.type === 'REJECT' ? updateStatus(reasonModal.id, 'REJECTED', reason) : updateStatus(reasonModal.id, 'REVERSED', reason)} disabled={!reason.trim()} className="px-4 py-2 bg-red-600 text-white rounded-lg disabled:opacity-50">
                Confirm
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}