"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/context/AuthContext";
import { X, Check } from "lucide-react";
import type { UserProfile } from "@/types";

const REAL_PERMISSIONS: { key: keyof UserProfile; label: string }[] = [
  { key: "can_create_project", label: "Project Creation" },
  { key: "can_delete_project", label: "Delete Projects" },
  { key: "can_add_income", label: "Add Income" },
  { key: "can_add_expense", label: "Add Expense" },
  { key: "can_create_invoice", label: "Create Invoice" },
  { key: "can_delete_invoice", label: "Delete Invoice" },
];

function getRoleColor(role: string) {
  switch (role) {
    case "Admin":
      return "bg-purple-100 text-purple-700 dark:bg-purple-500/20 dark:text-purple-400";
    case "HOD":
      return "bg-blue-100 text-blue-700 dark:bg-blue-500/20 dark:text-blue-400";
    case "Program Manager":
      return "bg-green-100 text-green-700 dark:bg-green-500/20 dark:text-green-400";
    case "Project Manager":
      return "bg-yellow-100 text-yellow-700 dark:bg-yellow-500/20 dark:text-yellow-400";
    default:
      return "bg-gray-100 text-gray-600 dark:bg-gray-500/20 dark:text-gray-400";
  }
}

export default function AdminPage() {
  const { role, loading: authLoading } = useAuth();
  const [users, setUsers] = useState<UserProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [selectedUser, setSelectedUser] = useState<UserProfile | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (role !== "Admin") return;
    fetchUsers();
  }, [role]);

  async function fetchUsers() {
    setLoading(true);
    const { data, error } = await supabase
      .from("profiles")
      .select("*")
      .order("created_at", { ascending: false });

    if (data) setUsers(data as UserProfile[]);
    if (error) console.error("Error fetching users:", error.message);
    setLoading(false);
  }

  function openModal(user: UserProfile) {
    setSelectedUser({ ...user });
    setShowModal(true);
  }

  function togglePermission(column: keyof UserProfile) {
    if (!selectedUser) return;
    setSelectedUser((prev) =>
      prev ? { ...prev, [column]: !prev[column] } : prev
    );
  }

  async function savePermissions() {
    if (!selectedUser) return;
    setSaving(true);

    const {
      role,
      can_create_project,
      can_delete_project,
      can_add_income,
      can_add_expense,
      can_create_invoice,
      can_delete_invoice,
    } = selectedUser;

    const { error } = await supabase
      .from("profiles")
      .update({
        role,
        can_create_project,
        can_delete_project,
        can_add_income,
        can_add_expense,
        can_create_invoice,
        can_delete_invoice,
      })
      .eq("id", selectedUser.id);

    if (error) {
      alert("Error: " + error.message);
    } else {
      setUsers((prev) =>
        prev.map((u) => (u.id === selectedUser.id ? { ...selectedUser } : u))
      );
      setShowModal(false);
    }
    setSaving(false);
  }

  // Loading state
  if (authLoading) {
    return (
      <div className="min-h-[60vh] flex items-center justify-center px-4">
        <div className="text-center">
          <div className="w-10 h-10 border-4 border-gray-300 dark:border-gray-600 border-t-blue-500 rounded-full animate-spin mx-auto mb-4" />
          <p className="text-gray-500 dark:text-gray-400">Loading...</p>
        </div>
      </div>
    );
  }

  // Access denied
  if (role !== "Admin") {
    return (
      <div className="min-h-[60vh] flex items-center justify-center px-4">
        <div className="text-center">
          <div className="w-20 h-20 bg-red-100 dark:bg-red-500/20 rounded-full flex items-center justify-center mx-auto mb-4">
            <X className="w-10 h-10 text-red-600 dark:text-red-400" />
          </div>
          <h2 className="text-2xl font-bold text-gray-900 dark:text-white mb-2">Access Denied</h2>
          <p className="text-gray-500 dark:text-gray-400">Only admins can view this page.</p>
        </div>
      </div>
    );
  }

  return (
    <div>
      {/* HEADER */}
      <div className="mb-6">
        <h2 className="text-2xl font-bold text-gray-900 dark:text-white">User Management</h2>
        <p className="text-gray-500 dark:text-gray-400 text-sm">
          Assign roles and granular permissions to users
        </p>
      </div>

      {/* TABLE CONTAINER */}
      <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl overflow-hidden shadow-sm dark:shadow-none">
        
        {/* TABLE HEADER BAR */}
        <div className="p-4 border-b border-gray-200 dark:border-gray-700">
          <h3 className="text-gray-900 dark:text-white font-medium">System Users ({users.length})</h3>
        </div>

        <table className="w-full text-left">
          {/* TABLE HEAD */}
          <thead className="bg-gray-100 dark:bg-gray-900/70 border-b border-gray-200 dark:border-gray-700 text-xs text-gray-600 dark:text-gray-400 uppercase">
            <tr>
              <th className="px-4 py-3 text-left font-semibold">User Email</th>
              <th className="px-4 py-3 text-left font-semibold">Role</th>
              <th className="px-4 py-3 text-left font-semibold">Permissions</th>
              <th className="px-4 py-3 text-right font-semibold">Action</th>
            </tr>
          </thead>
          
          {/* TABLE BODY */}
          <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
            {loading && (
              <tr>
                <td colSpan={4} className="px-4 py-8 text-center text-gray-500 dark:text-gray-400">
                  Loading...
                </td>
              </tr>
            )}
            {!loading && users.length === 0 && (
              <tr>
                <td colSpan={4} className="px-4 py-12 text-center text-gray-500 dark:text-gray-400">
                  No users found.
                </td>
              </tr>
            )}
            
            {users.map((u) => (
              <tr key={u.id} className="hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors">
                <td className="px-4 py-3 text-sm text-gray-900 dark:text-white truncate max-w-[200px]">
                  {u.email || "Unknown"}
                </td>
                <td className="px-4 py-3">
                  <span className={`text-xs px-2 py-1 rounded font-medium ${getRoleColor(u.role)}`}>
                    {u.role}
                  </span>
                </td>
                <td className="px-4 py-3">
                  <div className="flex flex-wrap gap-1">
                    {REAL_PERMISSIONS.map((p) => {
                      const isEnabled = Boolean(u[p.key]);
                      return (
                        <span
                          key={p.key}
                          className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${
                            isEnabled
                              ? "bg-blue-100 text-blue-700 dark:bg-blue-500/20 dark:text-blue-400"
                              : "bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-500"
                          }`}
                        >
                          {p.label}
                        </span>
                      );
                    })}
                  </div>
                </td>
                <td className="px-4 py-3 text-right">
                  <button
                    onClick={() => openModal(u)}
                    className="text-xs text-blue-600 dark:text-blue-400 hover:text-blue-700 dark:hover:text-blue-300 font-medium transition-colors"
                  >
                    Manage
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* DIALOG BOX (MODAL) */}
      {showModal && selectedUser && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60">
          <div className="relative w-full max-w-md bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-6 shadow-xl animate-slide-up">
            <button
              onClick={() => setShowModal(false)}
              className="absolute top-4 right-4 p-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-white transition-colors"
            >
              <X size={20} />
            </button>

            <div className="mb-6">
              <h2 className="text-lg font-semibold text-gray-900 dark:text-white">Manage Permissions</h2>
              <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">Set permissions for:</p>
              <span className="text-blue-600 dark:text-blue-400 font-medium block mt-1">
                {selectedUser.email}
              </span>
            </div>

            {/* CHECKBOXES (THEME AWARE) */}
            <div className="space-y-2">
              {REAL_PERMISSIONS.map((p) => {
                const isEnabled = Boolean(selectedUser[p.key]);
                return (
                  <label
                    key={p.key}
                    className="flex items-center justify-between p-3 bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-lg cursor-pointer hover:border-gray-300 dark:hover:border-gray-600 transition-colors"
                  >
                    <p className="text-sm text-gray-900 dark:text-white font-medium">{p.label}</p>
                    <button
                      type="button"
                      onClick={() => togglePermission(p.key)}
                      className={`w-5 h-5 rounded border-2 transition-colors flex items-center justify-center ${
                        isEnabled
                          ? "bg-blue-600 border-blue-600 text-white"
                          : "border-gray-300 dark:border-gray-600 text-gray-400 hover:border-gray-400 hover:text-gray-500 dark:hover:border-gray-500 dark:hover:text-gray-300"
                      }`}
                    >
                      {isEnabled ? (
                        <Check className="w-4 h-4 text-white" />
                      ) : (
                        <div className="w-3 h-3 border-2 border-gray-300 dark:border-gray-600 rounded-sm" />
                      )}
                    </button>
                  </label>
                );
              })}
            </div>

            {/* SAVE BUTTONS */}
            <div className="flex items-center gap-3 pt-4">
              <button
                onClick={() => setShowModal(false)}
                className="flex-1 px-4 py-2.5 bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 text-gray-800 dark:text-white rounded-lg text-sm font-medium transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={savePermissions}
                disabled={saving}
                className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-medium transition-colors disabled:opacity-50"
              >
                {saving ? "Saving..." : "Save Permissions"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}