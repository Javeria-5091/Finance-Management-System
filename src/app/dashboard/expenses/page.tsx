"use client";
import { useEffect, useState, useCallback } from "react";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/context/AuthContext";
import { usePermissions } from "@/context/PermissionContext"; 
import { Expense, ExpenseFormData, Project } from "@/types";
import ExpenseForm from "@/components/sections/ExpenseForm";
import StatusActions from "@/components/finance/StatusActions";
import ReasonModal from "@/components/finance/ReasonModal";
import { Plus, AlertTriangle } from "lucide-react";
import { callWorkflow } from "@/lib/workflow";
import toast from "react-hot-toast";

const STATUS_STYLES: Record<string, string> = {
  DRAFT: "bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300",
  SUBMITTED: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400",
  APPROVED: "bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400",
  POSTED: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400",
  REJECTED: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400",
  REVERSED: "bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400",
};

// ─── APPROVAL LIMITS (PKR) by role ───

export default function ExpensesPage() {
  const { user, profile } = useAuth();
  const { hasPermission, role } = usePermissions(); 
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
  const [postingId, setPostingId] = useState<string | null>(null);

  const fetchExpenses = useCallback(async () => {
    if (!user) return;
    const { data, error } = await supabase.from("expenses").select("*").order("expense_date", { ascending: false });
    if (error) toast.error("Failed to load expenses: " + error.message);
    else setExpenses(data || []);
    setLoading(false);
  }, [user]);

  const fetchProjects = useCallback(async () => {
    if (!user) return;
    const { data, error } = await supabase.from("projects").select("*");
    if (error) toast.error("Failed to load projects: " + error.message);
    else setProjects(data || []);
  }, [user]);

  useEffect(() => { fetchExpenses(); fetchProjects(); }, [fetchExpenses, fetchProjects]);

  async function handleSubmit(data: ExpenseFormData) {
    try {
      let error;
      if (editingData) {
        // EXP-02 FIX: edits now go through the server API, which
        // re-verifies (server-side) that the expense is still DRAFT before
        // allowing the amount/other fields to change -- the browser can no
        // longer PATCH an APPROVED/SUBMITTED row's amount directly via
        // PostgREST.
        const res = await fetch(`/api/finance/expenses/${editingData.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          error = new Error(body.error || res.statusText || 'Failed to update expense');
        }
      } else {
        // P2-004 FIX: create through the server API so amount validation,
        // organization ownership and DRAFT status cannot be bypassed.
        const res = await fetch('/api/finance/expenses', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          error = new Error(body.error || res.statusText || 'Failed to create expense');
        }
      }
      if (error) {
        toast.error("Failed to save expense: " + error.message);
      } else {
        toast.success(editingData ? "Expense updated" : "Expense created");
        setShowForm(false); setEditingData(null); fetchExpenses();
      }
    } catch (err: any) {
      toast.error("Error: " + (err.message || "Unknown error"));
    }
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

    // ═══════════════════════════════════════════════════════
    // FIX 2: POST now calls the API route (creates journal)
    // ═══════════════════════════════════════════════════════
    if (action === "post") {
      setPostingId(selectedExp.id);
      try {
        const res = await fetch('/api/finance/post-expense', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ expenseId: selectedExp.id }),
        });
        const result = await res.json();
        if (res.ok) {
          toast.success(result.message || "Expense posted to General Ledger");
          fetchExpenses();
        } else {
          toast.error(result.error || "Posting failed");
        }
      } catch (err: any) {
        toast.error("Posting error: " + (err.message || "Network error"));
      } finally {
        setPostingId(null);
      }
      return;
    }

    // ═══════════════════════════════════════════════════════
    // FIX 4: MAKER-CHECKER — approve/reject enforce creator ≠ approver
    // ═══════════════════════════════════════════════════════
    // ALL actions go through SERVER-SIDE WORKFLOW API
    // Server enforces: auth, maker-checker, approval limits
    try {
      const result = await callWorkflow('expense', selectedExp.id, action as any);
      if (result.success) {
        toast.success(result.message || `Expense ${action.toUpperCase()} successfully`);
        fetchExpenses();
      } else {
        toast.error(result.error || 'Action failed');
      }
    } catch (err: any) {
      toast.error('Error: ' + (err.message || 'Unknown error'));
    }
  }

  async function confirmReason() {
    if (!selectedExp || !reason.trim()) return;
    const result = await callWorkflow('expense', selectedExp.id, pendingAction as any, reason);
    if (result.success) {
      toast.success(result.message || `Expense ${pendingAction.toUpperCase()} successfully`);
      setShowReasonModal(false); setReason(""); fetchExpenses();
    } else {
      toast.error(result.error || 'Action failed');
    }
  }

  async function confirmDelete() {
    if (!selectedExp) return;
    // Only DRAFT expenses can be deleted. This is still checked here for
    // a fast, friendly error message, but it is no longer the only guard --
    // EXP-02 FIX: the actual delete now goes through the server API, which
    // re-checks status server-side (and the DB itself rejects a non-DRAFT
    // delete via expenses_delete_org_scoped), so a direct PostgREST call
    // from the browser can no longer delete a SUBMITTED/APPROVED expense.
    if (selectedExp.status !== 'DRAFT') {
      toast.error("Only DRAFT expenses can be deleted.");
      setShowDeleteModal(false);
      return;
    }
    try {
      const res = await fetch(`/api/finance/expenses/${selectedExp.id}`, { method: 'DELETE' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        toast.error("Delete failed: " + (body.error || res.statusText));
        return;
      }
      toast.success("Expense deleted");
      setShowDeleteModal(false); fetchExpenses();
    } catch (err: any) {
      toast.error("Error: " + (err.message || "Unknown error"));
    }
  }

  function formatCurrency(amount: number) {
    return new Intl.NumberFormat("en-PK", { style: "currency", currency: "PKR", minimumFractionDigits: 0 }).format(amount);
  }

  return (
    <div>
      <div className="flex justify-between mb-6">
        <div>
          <h2 className="text-2xl font-bold text-gray-900 dark:text-white">Expense Management</h2>
          <p className="text-gray-500 text-sm">Double-entry workflow with maker-checker</p>
        </div>
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
            {!loading && expenses.length === 0 && <tr><td colSpan={5} className="p-8 text-center text-gray-400">No expense records found.</td></tr>}
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
                  <span className={`px-2 py-0.5 rounded text-xs font-medium ${STATUS_STYLES[exp.status] || STATUS_STYLES.DRAFT}`}>{exp.status}</span>
                </td>
                <td className="px-4 py-3 text-right">
                  <div onClick={() => setSelectedExp(exp)}>
                    <StatusActions 
                      record={exp} 
                      module="expense" 
                      onAction={handleAction}
                      isPosting={postingId === exp.id}
                    />
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
            <p className="text-gray-500 text-sm mb-6">Only DRAFT expenses can be deleted.</p>
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
