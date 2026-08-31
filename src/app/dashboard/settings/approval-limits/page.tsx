"use client";
import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/lib/supabase";
import { usePermissions } from "@/context/PermissionContext";
import { ShieldAlert, Plus, Trash2, X, Loader2, Info } from "lucide-react";
import toast from "react-hot-toast";

import { APPROVAL_TRANSACTION_TYPES, APPROVAL_SCOPES } from "@/lib/approval-limits";

const TRANSACTION_TYPES = APPROVAL_TRANSACTION_TYPES;
const SCOPES = APPROVAL_SCOPES;

interface LimitRow {
  id: string;
  role_id: string | null;
  user_id: string | null;
  transaction_type: string;
  currency: string;
  max_amount: number | null;
  scope: string;
  effective_from: string;
  effective_to: string | null;
  notes: string | null;
  roles: { name: string; display_name: string } | null;
}

export default function ApprovalLimitsPage() {
  const { hasPermission } = usePermissions();
  const canManage = hasPermission("ADMIN_USERS");

  const [limits, setLimits] = useState<LimitRow[]>([]);
  const [roles, setRoles] = useState<any[]>([]);
  const [users, setUsers] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [saving, setSaving] = useState(false);

  const [form, setForm] = useState({
    target_type: "role" as "role" | "user",
    role_id: "",
    user_id: "",
    transaction_type: "EXPENSE",
    currency: "PKR",
    max_amount: "",
    unlimited: false,
    scope: "ALL",
    effective_from: new Date().toISOString().slice(0, 10),
    effective_to: "",
    notes: "",
  });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [limitsRes, rolesRes, usersRes] = await Promise.all([
        fetch("/api/admin/approval-limits", { cache: "no-store" }),
        supabase.schema("core").from("roles").select("id, name, display_name").order("level", { ascending: false }),
        supabase.rpc("get_all_system_users"),
      ]);
      const limitsPayload = await limitsRes.json();
      if (!limitsRes.ok) throw new Error(limitsPayload?.error || "Failed to load approval limits");
      setLimits(limitsPayload.data || []);
      setRoles(rolesRes.data || []);
      setUsers(usersRes.data || []);
    } catch (err: any) {
      toast.error(err.message || "Failed to load approval limits");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  function openCreateModal() {
    setForm({
      target_type: "role", role_id: roles[0]?.id || "", user_id: "",
      transaction_type: "EXPENSE", currency: "PKR", max_amount: "", unlimited: false,
      scope: "ALL", effective_from: new Date().toISOString().slice(0, 10), effective_to: "", notes: "",
    });
    setShowModal(true);
  }

  async function handleSave() {
    setSaving(true);
    try {
      const res = await fetch("/api/admin/approval-limits", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          role_id: form.target_type === "role" ? form.role_id : null,
          user_id: form.target_type === "user" ? form.user_id : null,
          transaction_type: form.transaction_type,
          currency: form.currency,
          max_amount: form.unlimited ? null : Number(form.max_amount),
          scope: form.scope,
          effective_from: form.effective_from,
          effective_to: form.effective_to || null,
          notes: form.notes || null,
        }),
      });
      const payload = await res.json();
      if (!res.ok) throw new Error(payload?.error || "Save failed");
      toast.success("Approval limit saved");
      setShowModal(false);
      load();
    } catch (err: any) {
      toast.error(err.message || "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id: string) {
    if (!confirm("Delete this approval limit? This does not affect any transaction already approved under it.")) return;
    try {
      const res = await fetch(`/api/admin/approval-limits?id=${id}`, { method: "DELETE" });
      const payload = await res.json();
      if (!res.ok) throw new Error(payload?.error || "Delete failed");
      toast.success("Approval limit removed");
      load();
    } catch (err: any) {
      toast.error(err.message || "Failed to delete");
    }
  }

  return (
    <div>
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3 mb-4">
        <div>
          <h2 className="text-2xl font-bold text-gray-900 dark:text-white flex items-center gap-2">
            <ShieldAlert size={22} className="text-amber-500" /> Approval Limits
          </h2>
          <p className="text-gray-500 text-sm">
            Configurable monetary approval ceilings by role or individual user (spec 7.3). These are the
            values the system checks before falling back to a built-in default.
          </p>
        </div>
        {canManage && (
          <button onClick={openCreateModal} className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-4 py-2.5 rounded-lg text-sm font-medium">
            <Plus size={16} /> New Limit
          </button>
        )}
      </div>

      <div className="mb-4 flex items-start gap-2 p-3 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg text-xs text-blue-700 dark:text-blue-300">
        <Info size={14} className="flex-shrink-0 mt-0.5" />
        <span>
          A user-specific limit always overrides a role-level limit for the same transaction type. Leave
          "Amount" as unlimited only for roles that should never be blocked (e.g. CEO).
        </span>
      </div>

      <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl overflow-hidden">
        <table className="w-full text-left text-sm">
          <thead className="bg-gray-50 dark:bg-gray-900/50 border-b border-gray-200 dark:border-gray-700 text-xs text-gray-500 uppercase">
            <tr>
              <th className="px-4 py-3">Applies To</th>
              <th className="px-4 py-3">Transaction Type</th>
              <th className="px-4 py-3">Max Amount</th>
              <th className="px-4 py-3">Scope</th>
              <th className="px-4 py-3">Effective From</th>
              <th className="px-4 py-3">Effective To</th>
              {canManage && <th className="px-4 py-3 text-right">Actions</th>}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
            {loading && <tr><td colSpan={7} className="p-8 text-center text-gray-400"><Loader2 className="animate-spin inline mr-2" size={16} />Loading…</td></tr>}
            {!loading && limits.length === 0 && (
              <tr><td colSpan={7} className="p-8 text-center text-gray-400">No approval limits configured yet.</td></tr>
            )}
            {!loading && limits.map((l) => (
              <tr key={l.id} className="hover:bg-gray-50 dark:hover:bg-gray-700/30">
                <td className="px-4 py-3 font-medium text-gray-900 dark:text-white">
                  {l.role_id ? (l.roles?.display_name || l.roles?.name || "Role") : "Individual user"}
                </td>
                <td className="px-4 py-3">{l.transaction_type.replace(/_/g, " ")}</td>
                <td className="px-4 py-3 font-mono">
                  {l.max_amount === null ? <span className="text-green-600 dark:text-green-400 font-semibold">Unlimited</span> : `${l.currency} ${Number(l.max_amount).toLocaleString()}`}
                </td>
                <td className="px-4 py-3">{l.scope}</td>
                <td className="px-4 py-3">{l.effective_from}</td>
                <td className="px-4 py-3">{l.effective_to || "—"}</td>
                {canManage && (
                  <td className="px-4 py-3 text-right">
                    <button onClick={() => handleDelete(l.id)} className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-500/10 rounded-lg">
                      <Trash2 size={15} />
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {showModal && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
          <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-2xl w-full max-w-lg shadow-2xl">
            <div className="flex items-center justify-between p-5 border-b border-gray-200 dark:border-gray-700">
              <h3 className="text-lg font-bold text-gray-900 dark:text-white">New Approval Limit</h3>
              <button onClick={() => setShowModal(false)} className="p-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700">
                <X size={20} className="text-gray-500" />
              </button>
            </div>

            <div className="p-5 space-y-4">
              <div className="flex gap-4">
                <label className="flex items-center gap-2 text-sm">
                  <input type="radio" checked={form.target_type === "role"} onChange={() => setForm({ ...form, target_type: "role" })} />
                  Role
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <input type="radio" checked={form.target_type === "user"} onChange={() => setForm({ ...form, target_type: "user" })} />
                  Individual user (overrides role)
                </label>
              </div>

              {form.target_type === "role" ? (
                <select value={form.role_id} onChange={(e) => setForm({ ...form, role_id: e.target.value })} className="w-full px-4 py-2.5 border dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-sm">
                  {roles.map((r) => <option key={r.id} value={r.id}>{r.display_name}</option>)}
                </select>
              ) : (
                <select value={form.user_id} onChange={(e) => setForm({ ...form, user_id: e.target.value })} className="w-full px-4 py-2.5 border dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-sm">
                  <option value="">-- Select user --</option>
                  {users.map((u) => <option key={u.user_id} value={u.user_id}>{u.full_name || u.email}</option>)}
                </select>
              )}

              <select value={form.transaction_type} onChange={(e) => setForm({ ...form, transaction_type: e.target.value })} className="w-full px-4 py-2.5 border dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-sm">
                {TRANSACTION_TYPES.map((t) => <option key={t} value={t}>{t.replace(/_/g, " ")}</option>)}
              </select>

              <div className="flex items-center gap-3">
                <input
                  type="number" min="0" step="0.01" placeholder="Max amount (PKR)"
                  value={form.max_amount} disabled={form.unlimited}
                  onChange={(e) => setForm({ ...form, max_amount: e.target.value })}
                  className="flex-1 px-4 py-2.5 border dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-sm disabled:opacity-50"
                />
                <label className="flex items-center gap-2 text-sm whitespace-nowrap">
                  <input type="checkbox" checked={form.unlimited} onChange={(e) => setForm({ ...form, unlimited: e.target.checked })} />
                  Unlimited
                </label>
              </div>

              <select value={form.scope} onChange={(e) => setForm({ ...form, scope: e.target.value })} className="w-full px-4 py-2.5 border dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-sm">
                {SCOPES.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Effective From</label>
                  <input type="date" value={form.effective_from} onChange={(e) => setForm({ ...form, effective_from: e.target.value })} className="w-full px-4 py-2.5 border dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-sm" />
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Effective To (optional)</label>
                  <input type="date" value={form.effective_to} onChange={(e) => setForm({ ...form, effective_to: e.target.value })} className="w-full px-4 py-2.5 border dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-sm" />
                </div>
              </div>

              <textarea placeholder="Notes / reason (optional)" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} rows={2} className="w-full px-4 py-2.5 border dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-sm resize-none" />
            </div>

            <div className="flex justify-end gap-3 p-5 border-t border-gray-200 dark:border-gray-700">
              <button onClick={() => setShowModal(false)} className="px-5 py-2.5 bg-gray-200 dark:bg-gray-700 rounded-lg text-sm font-medium">Cancel</button>
              <button
                onClick={handleSave}
                disabled={saving || (form.target_type === "role" ? !form.role_id : !form.user_id) || (!form.unlimited && !form.max_amount)}
                className="px-5 py-2.5 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-medium disabled:opacity-50 flex items-center gap-2"
              >
                {saving && <Loader2 size={16} className="animate-spin" />} Save
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
