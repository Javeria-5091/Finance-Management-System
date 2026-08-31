"use client";
import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/lib/supabase";
import { usePermissions } from "@/context/PermissionContext";
import { KeyRound, Plus, Trash2, X, Loader2, AlertTriangle } from "lucide-react";
import toast from "react-hot-toast";

interface OverrideRow {
  id: string;
  user_id: string;
  override_type: "ALLOW" | "DENY";
  reason: string;
  data_scope: string | null;
  effective_from: string;
  effective_to: string | null;
  permissions: { code: string; name: string; module: string } | null;
}

export default function PermissionOverridesPage() {
  const { hasPermission } = usePermissions();
  const canManage = hasPermission("ADMIN_USERS");

  const [overrides, setOverrides] = useState<OverrideRow[]>([]);
  const [permissions, setPermissions] = useState<any[]>([]);
  const [users, setUsers] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [saving, setSaving] = useState(false);

  const [form, setForm] = useState({
    user_id: "",
    permission_id: "",
    override_type: "ALLOW" as "ALLOW" | "DENY",
    reason: "",
    effective_from: new Date().toISOString().slice(0, 10),
    effective_to: "",
  });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [res, usersRes] = await Promise.all([
        fetch("/api/admin/permission-overrides", { cache: "no-store" }),
        supabase.rpc("get_all_system_users"),
      ]);
      const payload = await res.json();
      if (!res.ok) throw new Error(payload?.error || "Failed to load overrides");
      setOverrides(payload.data || []);
      setPermissions(payload.permissions || []);
      setUsers(usersRes.data || []);
    } catch (err: any) {
      toast.error(err.message || "Failed to load permission overrides");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  function openCreateModal() {
    setForm({
      user_id: "", permission_id: permissions[0]?.id || "", override_type: "ALLOW",
      reason: "", effective_from: new Date().toISOString().slice(0, 10), effective_to: "",
    });
    setShowModal(true);
  }

  async function handleSave() {
    if (!form.user_id || !form.permission_id || !form.reason.trim()) {
      toast.error("User, permission, and a reason are all required");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch("/api/admin/permission-overrides", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          user_id: form.user_id,
          permission_id: form.permission_id,
          override_type: form.override_type,
          reason: form.reason.trim(),
          effective_from: form.effective_from,
          effective_to: form.effective_to || null,
        }),
      });
      const payload = await res.json();
      if (!res.ok) throw new Error(payload?.error || "Save failed");
      toast.success(`${form.override_type} override created`);
      setShowModal(false);
      load();
    } catch (err: any) {
      toast.error(err.message || "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  async function handleRevoke(id: string) {
    if (!confirm("Revoke this permission override?")) return;
    try {
      const res = await fetch(`/api/admin/permission-overrides?id=${id}`, { method: "DELETE" });
      const payload = await res.json();
      if (!res.ok) throw new Error(payload?.error || "Revoke failed");
      toast.success("Override revoked");
      load();
    } catch (err: any) {
      toast.error(err.message || "Failed to revoke");
    }
  }

  function userLabel(userId: string) {
    const u = users.find((x) => x.user_id === userId);
    return u ? (u.full_name || u.email) : userId;
  }

  return (
    <div>
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3 mb-4">
        <div>
          <h2 className="text-2xl font-bold text-gray-900 dark:text-white flex items-center gap-2">
            <KeyRound size={22} className="text-purple-500" /> Permission Overrides
          </h2>
        </div>
        {canManage && (
          <button onClick={openCreateModal} className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-4 py-2.5 rounded-lg text-sm font-medium">
            <Plus size={16} /> New Override
          </button>
        )}
      </div>

      <div className="mb-4 flex items-start gap-2 p-3 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-lg text-xs text-amber-700 dark:text-amber-300">
        <AlertTriangle size={14} className="flex-shrink-0 mt-0.5" />
        <span>Use sparingly. Prefer changing the user's role or the role's permission matrix wherever the change should apply to everyone in that role.</span>
      </div>

      <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl overflow-hidden">
        <table className="w-full text-left text-sm">
          <thead className="bg-gray-50 dark:bg-gray-900/50 border-b border-gray-200 dark:border-gray-700 text-xs text-gray-500 uppercase">
            <tr>
              <th className="px-4 py-3">User</th>
              <th className="px-4 py-3">Permission</th>
              <th className="px-4 py-3">Type</th>
              <th className="px-4 py-3">Reason</th>
              <th className="px-4 py-3">Effective</th>
              {canManage && <th className="px-4 py-3 text-right">Actions</th>}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
            {loading && <tr><td colSpan={6} className="p-8 text-center text-gray-400"><Loader2 className="animate-spin inline mr-2" size={16} />Loading…</td></tr>}
            {!loading && overrides.length === 0 && (
              <tr><td colSpan={6} className="p-8 text-center text-gray-400">No permission overrides configured.</td></tr>
            )}
            {!loading && overrides.map((o) => (
              <tr key={o.id} className="hover:bg-gray-50 dark:hover:bg-gray-700/30">
                <td className="px-4 py-3 font-medium text-gray-900 dark:text-white">{userLabel(o.user_id)}</td>
                <td className="px-4 py-3">{o.permissions?.name || o.permissions?.code}</td>
                <td className="px-4 py-3">
                  <span className={`px-2 py-0.5 rounded-full text-xs font-semibold ${o.override_type === "ALLOW" ? "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400" : "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400"}`}>
                    {o.override_type}
                  </span>
                </td>
                <td className="px-4 py-3 text-gray-500 max-w-xs truncate" title={o.reason}>{o.reason}</td>
                <td className="px-4 py-3 text-xs text-gray-500">{o.effective_from} → {o.effective_to || "open"}</td>
                {canManage && (
                  <td className="px-4 py-3 text-right">
                    <button onClick={() => handleRevoke(o.id)} className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-500/10 rounded-lg">
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
              <h3 className="text-lg font-bold text-gray-900 dark:text-white">New Permission Override</h3>
              <button onClick={() => setShowModal(false)} className="p-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700">
                <X size={20} className="text-gray-500" />
              </button>
            </div>

            <div className="p-5 space-y-4">
              <select value={form.user_id} onChange={(e) => setForm({ ...form, user_id: e.target.value })} className="w-full px-4 py-2.5 border dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-sm">
                <option value="">-- Select user --</option>
                {users.map((u) => <option key={u.user_id} value={u.user_id}>{u.full_name || u.email}</option>)}
              </select>

              <select value={form.permission_id} onChange={(e) => setForm({ ...form, permission_id: e.target.value })} className="w-full px-4 py-2.5 border dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-sm">
                {permissions.map((p) => <option key={p.id} value={p.id}>{p.module} — {p.name}</option>)}
              </select>

              <div className="flex gap-4">
                <label className="flex items-center gap-2 text-sm">
                  <input type="radio" checked={form.override_type === "ALLOW"} onChange={() => setForm({ ...form, override_type: "ALLOW" })} />
                  ALLOW (grant)
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <input type="radio" checked={form.override_type === "DENY"} onChange={() => setForm({ ...form, override_type: "DENY" })} />
                  DENY (revoke)
                </label>
              </div>

              <textarea
                placeholder="Reason (required — this is audited)" value={form.reason}
                onChange={(e) => setForm({ ...form, reason: e.target.value })}
                rows={2} className="w-full px-4 py-2.5 border dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-sm resize-none"
              />

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
