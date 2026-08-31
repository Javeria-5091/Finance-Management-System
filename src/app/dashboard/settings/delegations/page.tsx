"use client";
import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/lib/supabase";
import { usePermissions } from "@/context/PermissionContext";
import { UserCog, Plus, Ban, X, Loader2 } from "lucide-react";
import toast from "react-hot-toast";

interface DelegationRow {
  id: string;
  from_user_id: string;
  to_user_id: string;
  permission_ids: string[];
  reason: string;
  effective_from: string;
  effective_to: string;
  status: "ACTIVE" | "EXPIRED" | "REVOKED";
  revoke_reason: string | null;
}

export default function DelegationsPage() {
  const { hasPermission } = usePermissions();
  const canManage = hasPermission("ADMIN_USERS");

  const [delegations, setDelegations] = useState<DelegationRow[]>([]);
  const [permissions, setPermissions] = useState<any[]>([]);
  const [users, setUsers] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [saving, setSaving] = useState(false);

  const [form, setForm] = useState({
    from_user_id: "",
    to_user_id: "",
    permission_ids: [] as string[],
    reason: "",
    effective_from: new Date().toISOString().slice(0, 10),
    effective_to: "",
  });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [res, usersRes] = await Promise.all([
        fetch("/api/admin/delegations", { cache: "no-store" }),
        supabase.rpc("get_all_system_users"),
      ]);
      const payload = await res.json();
      if (!res.ok) throw new Error(payload?.error || "Failed to load delegations");
      setDelegations(payload.data || []);
      setPermissions(payload.permissions || []);
      setUsers(usersRes.data || []);
    } catch (err: any) {
      toast.error(err.message || "Failed to load delegations");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  function openCreateModal() {
    setForm({ from_user_id: "", to_user_id: "", permission_ids: [], reason: "", effective_from: new Date().toISOString().slice(0, 10), effective_to: "" });
    setShowModal(true);
  }

  function togglePermission(id: string) {
    setForm((f) => ({
      ...f,
      permission_ids: f.permission_ids.includes(id) ? f.permission_ids.filter((p) => p !== id) : [...f.permission_ids, id],
    }));
  }

  async function handleSave() {
    if (!form.from_user_id || !form.to_user_id || form.permission_ids.length === 0 || !form.reason.trim() || !form.effective_to) {
      toast.error("All fields are required, including at least one permission and an end date");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch("/api/admin/delegations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const payload = await res.json();
      if (!res.ok) throw new Error(payload?.error || "Save failed");
      toast.success("Delegation created");
      setShowModal(false);
      load();
    } catch (err: any) {
      toast.error(err.message || "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  async function handleRevoke(id: string) {
    const reason = prompt("Reason for revoking this delegation (optional):") || "";
    try {
      const res = await fetch("/api/admin/delegations", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, revoke_reason: reason }),
      });
      const payload = await res.json();
      if (!res.ok) throw new Error(payload?.error || "Revoke failed");
      toast.success("Delegation revoked");
      load();
    } catch (err: any) {
      toast.error(err.message || "Failed to revoke");
    }
  }

  function userLabel(userId: string) {
    const u = users.find((x) => x.user_id === userId);
    return u ? (u.full_name || u.email) : userId;
  }

  function statusBadge(status: string) {
    const styles: Record<string, string> = {
      ACTIVE: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400",
      EXPIRED: "bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300",
      REVOKED: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400",
    };
    return <span className={`px-2 py-0.5 rounded-full text-xs font-semibold ${styles[status]}`}>{status}</span>;
  }

  return (
    <div>
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3 mb-4">
        <div>
          <h2 className="text-2xl font-bold text-gray-900 dark:text-white flex items-center gap-2">
            <UserCog size={22} className="text-indigo-500" /> Approval Delegations
          </h2>
        </div>
        {canManage && (
          <button onClick={openCreateModal} className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-4 py-2.5 rounded-lg text-sm font-medium">
            <Plus size={16} /> New Delegation
          </button>
        )}
      </div>

      <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl overflow-hidden">
        <table className="w-full text-left text-sm">
          <thead className="bg-gray-50 dark:bg-gray-900/50 border-b border-gray-200 dark:border-gray-700 text-xs text-gray-500 uppercase">
            <tr>
              <th className="px-4 py-3">From</th>
              <th className="px-4 py-3">To</th>
              <th className="px-4 py-3">Permissions</th>
              <th className="px-4 py-3">Effective</th>
              <th className="px-4 py-3">Status</th>
              {canManage && <th className="px-4 py-3 text-right">Actions</th>}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
            {loading && <tr><td colSpan={6} className="p-8 text-center text-gray-400"><Loader2 className="animate-spin inline mr-2" size={16} />Loading…</td></tr>}
            {!loading && delegations.length === 0 && (
              <tr><td colSpan={6} className="p-8 text-center text-gray-400">No delegations configured.</td></tr>
            )}
            {!loading && delegations.map((d) => (
              <tr key={d.id} className="hover:bg-gray-50 dark:hover:bg-gray-700/30">
                <td className="px-4 py-3 font-medium text-gray-900 dark:text-white">{userLabel(d.from_user_id)}</td>
                <td className="px-4 py-3">{userLabel(d.to_user_id)}</td>
                <td className="px-4 py-3 text-xs text-gray-500">{d.permission_ids.length} permission(s)</td>
                <td className="px-4 py-3 text-xs text-gray-500">{d.effective_from} → {d.effective_to}</td>
                <td className="px-4 py-3">{statusBadge(d.status)}</td>
                {canManage && (
                  <td className="px-4 py-3 text-right">
                    {d.status === "ACTIVE" && (
                      <button onClick={() => handleRevoke(d.id)} className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-500/10 rounded-lg" title="Revoke">
                        <Ban size={15} />
                      </button>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {showModal && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
          <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-2xl w-full max-w-lg shadow-2xl max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between p-5 border-b border-gray-200 dark:border-gray-700">
              <h3 className="text-lg font-bold text-gray-900 dark:text-white">New Delegation</h3>
              <button onClick={() => setShowModal(false)} className="p-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700">
                <X size={20} className="text-gray-500" />
              </button>
            </div>

            <div className="p-5 space-y-4">
              <select value={form.from_user_id} onChange={(e) => setForm({ ...form, from_user_id: e.target.value })} className="w-full px-4 py-2.5 border dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-sm">
                <option value="">-- Delegating from --</option>
                {users.map((u) => <option key={u.user_id} value={u.user_id}>{u.full_name || u.email}</option>)}
              </select>

              <select value={form.to_user_id} onChange={(e) => setForm({ ...form, to_user_id: e.target.value })} className="w-full px-4 py-2.5 border dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-sm">
                <option value="">-- Delegating to --</option>
                {users.map((u) => <option key={u.user_id} value={u.user_id}>{u.full_name || u.email}</option>)}
              </select>

              <div>
                <label className="block text-xs text-gray-500 mb-1">Permissions to delegate</label>
                <div className="max-h-40 overflow-y-auto border dark:border-gray-600 rounded-lg p-2 space-y-1">
                  {permissions.map((p) => (
                    <label key={p.id} className="flex items-center gap-2 text-sm px-2 py-1 rounded hover:bg-gray-50 dark:hover:bg-gray-700">
                      <input type="checkbox" checked={form.permission_ids.includes(p.id)} onChange={() => togglePermission(p.id)} />
                      {p.module} — {p.name}
                    </label>
                  ))}
                </div>
              </div>

              <textarea placeholder="Reason (required)" value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} rows={2} className="w-full px-4 py-2.5 border dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-sm resize-none" />

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Effective From</label>
                  <input type="date" value={form.effective_from} onChange={(e) => setForm({ ...form, effective_from: e.target.value })} className="w-full px-4 py-2.5 border dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-sm" />
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Effective To (required)</label>
                  <input type="date" value={form.effective_to} onChange={(e) => setForm({ ...form, effective_to: e.target.value })} className="w-full px-4 py-2.5 border dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-sm" />
                </div>
              </div>
            </div>

            <div className="flex justify-end gap-3 p-5 border-t border-gray-200 dark:border-gray-700">
              <button onClick={() => setShowModal(false)} className="px-5 py-2.5 bg-gray-200 dark:bg-gray-700 rounded-lg text-sm font-medium">Cancel</button>
              <button onClick={handleSave} disabled={saving} className="px-5 py-2.5 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-medium disabled:opacity-50 flex items-center gap-2">
                {saving && <Loader2 size={16} className="animate-spin" />} Save
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
