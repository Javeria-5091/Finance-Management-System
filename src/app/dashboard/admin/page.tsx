"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/context/AuthContext";
import { X, Check, Search, Plus } from "lucide-react";
import type { UserProfile } from "@/types";

// ✅ 12 GRANULAR CRUD PERMISSIONS (Categorized)
const REAL_PERMISSIONS: { key: keyof UserProfile; label: string; category: string }[] = [
  { key: "can_create_project", label: "Create Project", category: "Projects" },
  { key: "can_edit_project", label: "Edit Project", category: "Projects" },
  { key: "can_delete_project", label: "Delete Project", category: "Projects" },
  
  { key: "can_add_income", label: "Add Income", category: "Income" },
  { key: "can_edit_income", label: "Edit Income", category: "Income" },
  { key: "can_delete_income", label: "Delete Income", category: "Income" },
  
  { key: "can_add_expense", label: "Add Expense", category: "Expenses" },
  { key: "can_edit_expense", label: "Edit Expense", category: "Expenses" },
  { key: "can_delete_expense", label: "Delete Expense", category: "Expenses" },
  
  { key: "can_create_invoice", label: "Create Invoice", category: "Invoices" },
  { key: "can_edit_invoice", label: "Edit Invoice", category: "Invoices" },
  { key: "can_delete_invoice", label: "Delete Invoice", category: "Invoices" },
];

const ROLES = ["Admin", "HOD", "Program Manager", "Project Manager", "User"];

function getRoleColor(role: string) {
  switch (role) {
    case "Admin": return "bg-purple-500/20 text-purple-400";
    case "HOD": return "bg-blue-500/20 text-blue-400";
    case "Program Manager": return "bg-green-500/20 text-green-400";
    case "Project Manager": return "bg-yellow-500/20 text-yellow-400";
    default: return "bg-gray-500/20 text-gray-400";
  }
}

export default function AdminPage() {
  const { role, loading: authLoading } = useAuth();
  const [allUsers, setAllUsers] = useState<UserProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [selectedUser, setSelectedUser] = useState<UserProfile | null>(null);
  const [saving, setSaving] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");

  // ADD USER STATES
  const [showAddModal, setShowAddModal] = useState(false);
  const [newUser, setNewUser] = useState({ email: "", password: "", role: "User", full_name: "" });
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (role !== "Admin") return;
    fetchUsers();
  }, [role]);

  async function fetchUsers() {
    setLoading(true);
    const { data, error } = await supabase.from("profiles").select("*").order("created_at", { ascending: false });
    if (data) setAllUsers(data as UserProfile[]);
    if (error) console.error("Error fetching users:", error.message);
    setLoading(false);
  }

  const filteredUsers = allUsers.filter((user) => {
    if (!searchQuery) return true;
    return user.email?.toLowerCase().includes(searchQuery.toLowerCase());
  });

  function openModal(user: UserProfile) {
    setSelectedUser({ ...user });
    setShowModal(true);
  }

  function togglePermission(column: keyof UserProfile) {
    if (!selectedUser) return;
    setSelectedUser((prev) => prev ? { ...prev, [column]: !prev[column] } : prev);
  }

  function handleRoleChange(newRole: string) {
    if (!selectedUser) return;
    setSelectedUser((prev) => prev ? { ...prev, role: newRole } : prev);
  }

  async function savePermissions() {
    if (!selectedUser) return;
    setSaving(true);

    // ✅ SAB 12 PERMISSIONS EXTRACT KARO
    const {
      role,
      can_create_project, can_edit_project, can_delete_project,
      can_add_income, can_edit_income, can_delete_income,
      can_add_expense, can_edit_expense, can_delete_expense,
      can_create_invoice, can_edit_invoice, can_delete_invoice,
    } = selectedUser;

    // ✅ DATABASE KO BHEJO
    const { error } = await supabase
      .from("profiles")
      .update({
        role,
        can_create_project, can_edit_project, can_delete_project,
        can_add_income, can_edit_income, can_delete_income,
        can_add_expense, can_edit_expense, can_delete_expense,
        can_create_invoice, can_edit_invoice, can_delete_invoice,
      })
      .eq("id", selectedUser.id);

    if (error) {
      alert("Error: " + error.message);
    } else {
      setAllUsers((prev) => prev.map((u) => (u.id === selectedUser.id ? { ...selectedUser } : u)));
      setShowModal(false);
    }
    setSaving(false);
  }

  async function handleCreateUser() {
    if (!newUser.email || !newUser.password) return alert("Email and Password are required!");
    if (newUser.password.length < 6) return alert("Password must be at least 6 characters!");

    setCreating(true);
    try {
      const { data, error } = await supabase.rpc("create_user_by_admin", {
        p_email: newUser.email, p_password: newUser.password, p_role: newUser.role, p_full_name: newUser.full_name,
      });
      if (error) throw new Error(error.message);
      if (data?.error) throw new Error(data.error);
      if (data?.success) {
        alert("User created successfully!");
        setNewUser({ email: "", password: "", role: "User", full_name: "" });
        setShowAddModal(false);
        fetchUsers();
      }
    } catch (err: any) {
      alert("Error: " + err.message);
    } finally {
      setCreating(false);
    }
  }

  if (authLoading) return (<div className="min-h-[60vh] flex items-center justify-center"><div className="w-10 h-10 border-4 border-gray-600 border-t-blue-500 rounded-full animate-spin"></div></div>);
  if (role !== "Admin") return (<div className="min-h-[60vh] flex items-center justify-center text-center"><div className="w-20 h-20 bg-red-500/20 rounded-full flex items-center justify-center mx-auto mb-4"><X className="w-10 h-10 text-red-400" /></div><h2 className="text-2xl font-bold text-white mb-2">Access Denied</h2></div>);

  return (
    <div>
      <div className="mb-6 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h2 className="text-2xl font-bold text-white">User Management</h2>
          <p className="text-gray-400 text-sm">Assign roles and granular CRUD permissions</p>
        </div>
        <button onClick={() => setShowAddModal(true)} className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-4 py-2.5 rounded-lg text-sm font-medium transition-colors w-fit">
          <Plus size={18} /> Add New User
        </button>
      </div>

      <div className="bg-gray-800 border border-gray-700 rounded-xl overflow-hidden">
        <div className="p-4 border-b border-gray-700 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
          <h3 className="text-white font-medium">System Users ({filteredUsers.length})</h3>
          <div className="relative w-full sm:w-72">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
            <input type="text" placeholder="Search by email..." value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} className="w-full pl-9 pr-4 py-2 bg-gray-900 border border-gray-700 rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
          </div>
        </div>

        <table className="w-full text-left">
          <thead className="bg-gray-900/50 text-xs text-gray-400 uppercase">
            <tr>
              <th className="px-4 py-3 text-left">User Email</th>
              <th className="px-4 py-3 text-left">Role</th>
              <th className="px-4 py-3 text-left">Active Permissions</th>
              <th className="px-4 py-3 text-right">Action</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-700">
            {loading && <tr><td colSpan={4} className="px-4 py-8 text-center text-gray-400">Loading...</td></tr>}
            {!loading && filteredUsers.length === 0 && <tr><td colSpan={4} className="px-4 py-12 text-center text-gray-400">No users found.</td></tr>}
            {filteredUsers.map((u) => (
              <tr key={u.id} className="hover:bg-gray-700/50 transition-colors">
                <td className="px-4 py-3 text-sm text-white truncate max-w-[200px]">{u.email || "Unknown"}</td>
                <td className="px-4 py-3"><span className={`text-xs px-2 py-1 rounded font-medium ${getRoleColor(u.role)}`}>{u.role}</span></td>
                <td className="px-4 py-3">
                  <div className="flex flex-wrap gap-1">
                    {REAL_PERMISSIONS.filter(p => Boolean(u[p.key])).map((p) => (
                      <span key={p.key} className="text-[10px] px-1.5 py-0.5 rounded font-medium bg-blue-500/20 text-blue-400">{p.label}</span>
                    ))}
                  </div>
                </td>
                <td className="px-4 py-3 text-right">
                  <button onClick={() => openModal(u)} className="text-xs text-blue-400 hover:text-blue-300 font-medium">Manage</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* MANAGE USER MODAL */}
      {showModal && selectedUser && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60">
          <div className="relative w-full max-w-md bg-gray-800 border border-gray-700 rounded-xl p-6 max-h-[90vh] overflow-y-auto">
            <button onClick={() => setShowModal(false)} className="absolute top-4 right-4 p-1.5 rounded-lg hover:bg-gray-700 text-gray-400 hover:text-white"><X size={20} /></button>
            
            <div className="mb-6">
              <h2 className="text-lg font-semibold text-white">Manage User</h2>
              <p className="text-sm text-blue-400 font-medium mt-1">{selectedUser.email}</p>
            </div>

            <div className="mb-6">
              <label className="block text-sm font-medium text-gray-300 mb-2">Assign Role</label>
              <select value={selectedUser.role} onChange={(e) => handleRoleChange(e.target.value)} className="w-full px-3 py-2.5 bg-gray-900 border border-gray-700 rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
                {ROLES.map((r) => (<option key={r} value={r}>{r}</option>))}
              </select>
            </div>

            {/* ✅ CATEGORIZED PERMISSIONS UI */}
            <div className="mb-6">
              <label className="block text-sm font-medium text-gray-300 mb-3">Module Permissions</label>
              <div className="space-y-4">
                {["Projects", "Income", "Expenses", "Invoices"].map((cat) => (
                  <div key={cat}>
                    <h4 className="text-xs font-bold text-gray-500 uppercase mb-2 border-b border-gray-700 pb-1">{cat}</h4>
                    <div className="space-y-2 pl-2">
                      {REAL_PERMISSIONS.filter(p => p.category === cat).map((p) => {
                        const isEnabled = Boolean(selectedUser[p.key]);
                        return (
                          <label key={p.key} className="flex items-center justify-between p-2.5 bg-gray-900/50 border border-gray-700 rounded-lg cursor-pointer hover:border-gray-600">
                            <p className="text-sm text-white">{p.label}</p>
                            <button type="button" onClick={() => togglePermission(p.key)} className={`w-5 h-5 rounded border-2 transition-colors flex items-center justify-center ${isEnabled ? "bg-blue-600 border-blue-600" : "border-gray-600"}`}>
                              {isEnabled && <Check className="w-3 h-3 text-white" />}
                            </button>
                          </label>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="flex items-center gap-3 pt-2">
              <button onClick={() => setShowModal(false)} className="flex-1 px-4 py-2.5 bg-gray-700 hover:bg-gray-600 text-white rounded-lg text-sm font-medium">Cancel</button>
              <button onClick={savePermissions} disabled={saving} className="flex-1 px-4 py-2.5 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-medium disabled:opacity-50">
                {saving ? "Saving..." : "Save Changes"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ADD USER MODAL */}
      {showAddModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60">
          <div className="relative w-full max-w-md bg-gray-800 border border-gray-700 rounded-xl p-6">
            <button onClick={() => setShowAddModal(false)} className="absolute top-4 right-4 p-1.5 rounded-lg hover:bg-gray-700 text-gray-400 hover:text-white"><X size={20} /></button>
            <div className="mb-6">
              <h2 className="text-lg font-semibold text-white">Create New User</h2>
              <p className="text-sm text-gray-400 mt-1">Setup login credentials</p>
            </div>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-1">Full Name</label>
                <input type="text" placeholder="e.g. Ahmed" value={newUser.full_name} onChange={(e) => setNewUser({ ...newUser, full_name: e.target.value })} className="w-full px-3 py-2.5 bg-gray-900 border border-gray-700 rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-1">Email Address</label>
                <input type="email" placeholder="pm@company.com" value={newUser.email} onChange={(e) => setNewUser({ ...newUser, email: e.target.value })} className="w-full px-3 py-2.5 bg-gray-900 border border-gray-700 rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-1">Temporary Password</label>
                <input type="password" placeholder="Min 6 characters" value={newUser.password} onChange={(e) => setNewUser({ ...newUser, password: e.target.value })} className="w-full px-3 py-2.5 bg-gray-900 border border-gray-700 rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-1">Assign Role</label>
                <select value={newUser.role} onChange={(e) => setNewUser({ ...newUser, role: e.target.value })} className="w-full px-3 py-2.5 bg-gray-900 border border-gray-700 rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
                  {ROLES.map((r) => (<option key={r} value={r}>{r}</option>))}
                </select>
              </div>
            </div>
            <div className="flex items-center gap-3 pt-6">
              <button onClick={() => setShowAddModal(false)} className="flex-1 px-4 py-2.5 bg-gray-700 hover:bg-gray-600 text-white rounded-lg text-sm font-medium">Cancel</button>
              <button onClick={handleCreateUser} disabled={creating} className="flex-1 px-4 py-2.5 bg-green-600 hover:bg-green-700 text-white rounded-lg text-sm font-medium disabled:opacity-50">
                {creating ? "Creating..." : "Create Account"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}