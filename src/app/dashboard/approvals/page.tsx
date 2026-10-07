"use client";
// DEF-02 FIX: this page did not exist, so /dashboard/approvals returned 404.
// It lists submitted expenses waiting for the current user (HOD: own
// department, Finance Head / CEO: whole organization) and lets them approve or
// reject through the SAME server-side workflow API used everywhere else, so
// maker-checker, approval limits, period locks and audit logging all still
// apply. Rows above the caller's limit are shown as "escalated" with no
// approve button (spec 7.3).

import { useCallback, useEffect, useState } from "react";
import { reportingDB } from "@/lib/supabase";
import { usePermissions } from "@/context/PermissionContext";
import ReasonModal from "@/components/finance/ReasonModal";
import { callWorkflow } from "@/lib/workflow";
import { CheckCircle, XCircle, Loader2, ArrowUpRight } from "lucide-react";
import toast from "react-hot-toast";

interface PendingRow {
  id: string;
  module_type: string;
  title: string;
  amount: number;
  currency: string;
  status: string;
  expense_date: string;
  submitted_at: string | null;
  requester_name: string;
  is_own: boolean;
  can_approve: boolean;
}

function money(amount: number, currency: string) {
  return new Intl.NumberFormat("en-PK", {
    style: "currency",
    currency: currency || "PKR",
    minimumFractionDigits: 0,
  }).format(amount);
}

export default function ApprovalsPage() {
  const { hasPermission } = usePermissions();
  const canSee = hasPermission("EXPENSE_APPROVE");

  const [rows, setRows] = useState<PendingRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rejectRow, setRejectRow] = useState<PendingRow | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const { data, error } = await reportingDB.rpc("my_pending_approvals");
    if (error) {
      toast.error("Failed to load approvals: " + error.message);
      setRows([]);
    } else {
      setRows((data as PendingRow[]) || []);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function act(row: PendingRow, action: "approve" | "reject", reason?: string) {
    setBusyId(row.id);
    const result = await callWorkflow("expense", row.id, action, reason);
    if (result.success) {
      toast.success(result.message || `Expense ${action}d`);
    } else {
      toast.error(result.error || "Action failed");
    }
    setBusyId(null);
    load();
  }

  if (!canSee) {
    return (
      <div className="p-8 text-center text-gray-500">
        You do not have permission to view approvals.
      </div>
    );
  }

  return (
    <div>
      <div className="mb-6">
        <h2 className="text-2xl font-bold text-gray-900 dark:text-white">Pending Approvals</h2>
        <p className="text-gray-500 text-sm">
          Submitted expenses waiting for your decision. Requests above your approval limit are
          escalated to the next approver.
        </p>
      </div>

      {loading ? (
        <div className="flex justify-center py-16">
          <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
        </div>
      ) : rows.length === 0 ? (
        <div className="rounded-lg border border-dashed border-gray-300 dark:border-gray-700 p-10 text-center text-gray-500">
          No pending approvals.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-700">
          <table className="min-w-full text-sm">
            <thead className="bg-gray-50 dark:bg-gray-800 text-left text-gray-600 dark:text-gray-300">
              <tr>
                <th className="px-4 py-3">Type</th>
                <th className="px-4 py-3">Title</th>
                <th className="px-4 py-3">Requested by</th>
                <th className="px-4 py-3">Date</th>
                <th className="px-4 py-3 text-right">Amount</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3 text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
              {rows.map((r) => (
                <tr key={r.id} className="bg-white dark:bg-gray-900">
                  <td className="px-4 py-3">{r.module_type}</td>
                  <td className="px-4 py-3 font-medium text-gray-900 dark:text-white">{r.title}</td>
                  <td className="px-4 py-3">{r.requester_name}</td>
                  <td className="px-4 py-3">{r.expense_date}</td>
                  <td className="px-4 py-3 text-right">{money(r.amount, r.currency)}</td>
                  <td className="px-4 py-3">
                    <span className="px-2 py-0.5 rounded text-xs font-semibold bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400">
                      {r.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right">
                    {r.can_approve ? (
                      <div className="flex justify-end gap-2">
                        <button
                          disabled={busyId === r.id}
                          onClick={() => act(r, "approve")}
                          className="inline-flex items-center gap-1 rounded bg-emerald-600 px-3 py-1.5 text-white hover:bg-emerald-700 disabled:opacity-50"
                        >
                          <CheckCircle className="w-4 h-4" /> Approve
                        </button>
                        <button
                          disabled={busyId === r.id}
                          onClick={() => setRejectRow(r)}
                          className="inline-flex items-center gap-1 rounded bg-red-600 px-3 py-1.5 text-white hover:bg-red-700 disabled:opacity-50"
                        >
                          <XCircle className="w-4 h-4" /> Reject
                        </button>
                      </div>
                    ) : r.is_own ? (
                      <span className="text-xs text-gray-500">Your own request</span>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-xs text-amber-600">
                        <ArrowUpRight className="w-4 h-4" /> Above your limit: escalated
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <ReasonModal
        open={!!rejectRow}
        actionType="REJECT"
        moduleName="Expense"
        reference={rejectRow?.title}
        onCancel={() => setRejectRow(null)}
        onConfirm={(reason) => {
          const row = rejectRow;
          setRejectRow(null);
          if (row) act(row, "reject", reason);
        }}
      />
    </div>
  );
}
