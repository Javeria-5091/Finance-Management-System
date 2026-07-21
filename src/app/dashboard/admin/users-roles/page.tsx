"use client";
import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/context/AuthContext";
import { usePermissions } from "@/hooks/usePermissions";
import { 
  ShieldCheck, Users, Key, Save, X, Plus, Trash2, 
  Loader2, AlertCircle, CheckCircle2, AlertTriangle, 
  Info, Crown, ArrowRightLeft, UserPlus
} from "lucide-react";

const SCOPE_OPTIONS = ['ALL', 'DEPARTMENT', 'PROJECT', 'OWN'];

// ==========================================
// TOAST COMPONENT
// ==========================================
type ToastType = "success" | "error" | "info" | "warning";

interface Toast {
  id: string;
  type: ToastType;
  message: string;
}

function ToastContainer({ toasts, onRemove }: { toasts: Toast[]; onRemove: (id: string) => void }) {
  return (
    <div className="fixed top-4 right-4 z-[100] flex flex-col gap-2 max-w-sm w-full">
      {toasts.map(toast => {
        const styles: Record<ToastType, string> = {
          success: "bg-green-50/95 border-green-200 text-green-800 dark:bg-green-900/90 dark:border-green-700 dark:text-green-200",
          error: "bg-red-50/95 border-red-200 text-red-800 dark:bg-red-900/90 dark:border-red-700 dark:text-red-200",
          info: "bg-blue-50/95 border-blue-200 text-blue-800 dark:bg-blue-900/90 dark:border-blue-700 dark:text-blue-200",
          warning: "bg-amber-50/95 border-amber-200 text-amber-800 dark:bg-amber-900/90 dark:border-amber-700 dark:text-amber-200"
        };
        const icons: Record<ToastType, React.ReactNode> = {
          success: <CheckCircle2 size={18} className="flex-shrink-0" />,
          error: <AlertCircle size={18} className="flex-shrink-0" />,
          info: <Info size={18} className="flex-shrink-0" />,
          warning: <AlertTriangle size={18} className="flex-shrink-0" />
        };
        return (
          <div key={toast.id} className={`flex items-center gap-3 px-4 py-3 rounded-xl shadow-lg border backdrop-blur-sm animate-slide-in ${styles[toast.type]}`}>
            {icons[toast.type]}
            <p className="text-sm font-medium flex-1">{toast.message}</p>
            <button onClick={() => onRemove(toast.id)} className="p-0.5 rounded hover:bg-black/10 dark:hover:bg-white/10 transition-colors flex-shrink-0">
              <X size={14} />
            </button>
          </div>
        );
      })}
    </div>
  );
}

// ==========================================
// CONFIRM DIALOG COMPONENT
// ==========================================
interface ConfirmDialog {
  id: string;
  title: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  variant?: "danger" | "warning" | "default";
  onConfirm: () => void;
}

function ConfirmDialogComponent({ dialog, onClose }: { dialog: ConfirmDialog; onClose: () => void }) {
  const [loading, setLoading] = useState(false);
  const handleConfirm = async () => {
    setLoading(true);
    try { await dialog.onConfirm(); } finally { setLoading(false); onClose(); }
  };
  const isDanger = dialog.variant === "danger";
  const isWarning = dialog.variant === "warning";
  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={!loading ? onClose : undefined} />
      <div className="relative bg-white dark:bg-gray-800 border dark:border-gray-700 rounded-2xl w-full max-w-md shadow-2xl animate-scale-in">
        <div className="flex justify-center pt-6">
          <div className={`w-14 h-14 rounded-full flex items-center justify-center ${isDanger ? "bg-red-100 dark:bg-red-900/30" : isWarning ? "bg-amber-100 dark:bg-amber-900/30" : "bg-blue-100 dark:bg-blue-900/30"}`}>
            {isDanger ? <Trash2 size={24} className="text-red-600 dark:text-red-400" /> : isWarning ? <AlertTriangle size={24} className="text-amber-600 dark:text-amber-400" /> : <Info size={24} className="text-blue-600 dark:text-blue-400" />}
          </div>
        </div>
        <div className="p-6 text-center">
          <h3 className="text-lg font-bold text-gray-900 dark:text-white mb-2">{dialog.title}</h3>
          <p className="text-sm text-gray-500 dark:text-gray-400 leading-relaxed whitespace-pre-line">{dialog.message}</p>
        </div>
        <div className="flex gap-3 px-6 pb-6">
          <button onClick={onClose} disabled={loading} className="flex-1 px-4 py-2.5 bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 text-gray-700 dark:text-gray-300 rounded-xl text-sm font-medium transition-colors disabled:opacity-50">
            {dialog.cancelText || "Cancel"}
          </button>
          <button onClick={handleConfirm} disabled={loading} className={`flex-1 px-4 py-2.5 rounded-xl text-sm font-medium transition-colors disabled:opacity-50 flex items-center justify-center gap-2 ${isDanger ? "bg-red-600 hover:bg-red-700 text-white" : isWarning ? "bg-amber-600 hover:bg-amber-700 text-white" : "bg-blue-600 hover:bg-blue-700 text-white"}`}>
            {loading ? <Loader2 size={16} className="animate-spin" /> : null}
            {dialog.confirmText || (isDanger ? "Delete" : "Confirm")}
          </button>
        </div>
      </div>
    </div>
  );
}

// ==========================================
// ✅ NEW: Helper - Check if permission needs amount limit
// ==========================================
function needsAmountLimit(permissionName: string): boolean {
  const viewKeywords = ['VIEW', 'LIST', 'READ', 'EXPORT', 'DOWNLOAD', 'PRINT', 'REPORT'];
  const upperName = permissionName.toUpperCase();
  // If it starts with any view keyword, it doesn't need amount limit
  return !viewKeywords.some(keyword => upperName.startsWith(keyword));
}

// ==========================================
// MAIN PAGE COMPONENT
// ==========================================
export default function UsersRolesPage() {
  const { user } = useAuth();
  const { hasPermission, isLoading: permLoading } = usePermissions();
  
  const [activeTab, setActiveTab] = useState("roles");
  const [roles, setRoles] = useState<any[]>([]);
  const [permissions, setPermissions] = useState<any[]>([]);
  const [userRoles, setUserRoles] = useState<any[]>([]);
  const [allUsers, setAllUsers] = useState<any[]>([]); // ✅ NEW: All users for assignment
  
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  
  const [editingRoleId, setEditingRoleId] = useState<string | null>(null);
  const [editingRoleName, setEditingRoleName] = useState("");
  const [matrix, setMatrix] = useState<Record<string, { scope: string; limit: string }>>({});
  
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [newRole, setNewRole] = useState({ display_name: "", description: "", level: 50 });

  const [toasts, setToasts] = useState<Toast[]>([]);
  const [confirmDialog, setConfirmDialog] = useState<ConfirmDialog | null>(null);

  const [showCEOTransfer, setShowCEOTransfer] = useState(false);
  const [transferTargetUserId, setTransferTargetUserId] = useState<string>("");
  const [transferMyNewRole, setTransferMyNewRole] = useState<string>("");
  const [transferring, setTransferring] = useState(false);

  // ==========================================
  // HELPERS
  // ==========================================
  const addToast = useCallback((type: ToastType, message: string) => {
    const id = Date.now().toString() + Math.random().toString(36).slice(2);
    setToasts(prev => [...prev, { id, type, message }]);
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 4000);
  }, []);

  const removeToast = useCallback((id: string) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  }, []);

  const showConfirm = useCallback((config: Omit<ConfirmDialog, 'id'>) => {
    setConfirmDialog({ ...config, id: Date.now().toString() });
  }, []);

  const getCEORole = useCallback(() => {
    return roles.find(r => r.name === "CEO_FOUNDER" || r.name === "CEO" || r.display_name?.toLowerCase().includes("ceo") || r.level === 100);
  }, [roles]);

  const getCurrentCEO = useCallback(() => {
    const ceoRole = getCEORole();
    if (!ceoRole) return null;
    return userRoles.find(ur => ur.role_id === ceoRole.id) || null;
  }, [userRoles, getCEORole]);

  const isCurrentUserCEO = useCallback(() => {
    const currentCEO = getCurrentCEO();
    return currentCEO?.user_id === user?.id;
  }, [getCurrentCEO, user?.id]);

  const getOtherUsers = useCallback(() => {
    const ceoRole = getCEORole();
    if (!ceoRole) return userRoles;
    return userRoles.filter(ur => ur.role_id !== ceoRole.id);
  }, [userRoles, getCEORole]);

  const getNonCEORoles = useCallback(() => {
    const ceoRole = getCEORole();
    if (!ceoRole) return roles;
    return roles.filter(r => r.id !== ceoRole.id);
  }, [roles, getCEORole]);

  const validateAmountLimit = (value: string, fallback: string = ''): string => {
    if (value === '' || value === undefined || value === null) return '';
    const num = parseFloat(value);
    if (isNaN(num) || num <= 0) return fallback;
    return String(num);
  };

  // ==========================================
  // ✅ FIXED: DATA FETCHING - Fetch ALL users
  // ==========================================
  const fetchInitialData = async () => {
    setIsLoading(true);
    setError(null);
    
    try {
      const { data: rolesData, error: rolesErr } = await supabase.from("roles").select("*").order("level", { ascending: false });
      if (rolesErr) throw new Error(`Failed to fetch roles: ${rolesErr.message}`);

      const { data: permsData, error: permsErr } = await supabase.from("permissions").select("*").order("module", { ascending: true });
      if (permsErr) throw new Error(`Failed to fetch permissions: ${permsErr.message}`);

      const { data: urData, error: urErr } = await supabase
        .from("user_roles")
        .select(`id, user_id, effective_from, is_active, role_id, roles(display_name)`)
        .order("created_at", { ascending: false });
      if (urErr) throw new Error(`Failed to fetch user roles: ${urErr.message}`);

      // ✅ NEW: Fetch ALL profiles (not just those with roles)
      const { data: allProfiles, error: profilesErr } = await supabase
        .from("profiles")
        .select("user_id, full_name, email, role")
        .order("full_name", { ascending: true });

      if (profilesErr) throw new Error(`Failed to fetch profiles: ${profilesErr.message}`);

      // Build user roles map
      const userRolesMap: Record<string, any> = {};
      if (urData) {
        urData.forEach(ur => {
          userRolesMap[ur.user_id] = ur;
        });
      }

      // ✅ NEW: Merge ALL profiles with their role (if any)
      const mergedUsers = (allProfiles || []).map(profile => {
        const roleAssignment = userRolesMap[profile.user_id];
        return {
          user_id: profile.user_id,
          full_name: profile.full_name,
          email: profile.email,
          profiles: { full_name: profile.full_name, email: profile.email },
          id: roleAssignment?.id || null,
          role_id: roleAssignment?.role_id || null,
          roles: roleAssignment?.roles || null,
          effective_from: roleAssignment?.effective_from || null,
          is_active: roleAssignment?.is_active ?? false,
          hasRole: !!roleAssignment // ✅ Flag to know if role is assigned
        };
      });

      if (rolesData) setRoles(rolesData);
      if (permsData) setPermissions(permsData);
      setUserRoles(urData || []);
      setAllUsers(mergedUsers); // ✅ NEW: Store all users

    } catch (err: any) {
      console.error("🚨 Fetch Error:", err);
      setError(err.message);
      addToast("error", err.message);
    } finally { setIsLoading(false); }
  };

  useEffect(() => {
    if (!permLoading) {
      if (hasPermission('ADMIN_USERS')) fetchInitialData();
      else setIsLoading(false);
    }
  }, [permLoading]);

  // ==========================================
  // GROUP PERMISSIONS BY MODULE
  // ==========================================
  const groupedPerms = permissions.reduce((acc: Record<string, any[]>, p: any) => {
    if (!acc[p.module]) acc[p.module] = [];
    acc[p.module].push(p);
    return acc;
  }, {});

  // ==========================================
  // ROLE CRUD
  // ==========================================
  const handleCreateRole = async () => {
    if (!newRole.display_name.trim()) { addToast("error", "Role name is required"); return; }
    setSaving(true);
    try {
      const { error } = await supabase.from("roles").insert({
        display_name: newRole.display_name,
        name: newRole.display_name.toUpperCase().replace(/\s+/g, '_'),
        description: newRole.description || null,
        level: newRole.level,
        is_system: false,
        created_by: user?.id
      });
      if (error) throw error;
      setShowCreateModal(false);
      setNewRole({ display_name: "", description: "", level: 50 });
      addToast("success", `Role "${newRole.display_name}" created`);
      fetchInitialData();
    } catch (err: any) { addToast("error", `Failed: ${err.message}`); }
    finally { setSaving(false); }
  };

  const handleDeleteRole = (roleId: string, roleName: string) => {
    const role = roles.find(r => r.id === roleId);
    if (role?.is_system) { addToast("error", "Cannot delete system roles"); return; }
    const ceoRole = getCEORole();
    if (ceoRole && roleId === ceoRole.id && getCurrentCEO()) {
      addToast("warning", "Cannot delete CEO role while assigned. Transfer CEO first.");
      return;
    }
    showConfirm({
      title: "Delete Role",
      message: `Are you sure you want to delete "${roleName}"?\n\nThis cannot be undone.`,
      confirmText: "Yes, Delete",
      cancelText: "No, Keep It",
      variant: "danger",
      onConfirm: async () => {
        try {
          const { error } = await supabase.from("roles").delete().eq("id", roleId);
          if (error) throw error;
          addToast("success", `Role "${roleName}" deleted`);
          fetchInitialData();
        } catch (err: any) { addToast("error", `Failed: ${err.message}`); }
      }
    });
  };

  // ==========================================
  // PERMISSION MATRIX LOGIC
  // ==========================================
  const openRoleEditor = async (roleId: string) => {
    setEditingRoleId(roleId);
    setEditingRoleName(roles.find(r => r.id === roleId)?.display_name || "");
    
    const { data } = await supabase.from("role_permissions").select("*").eq("role_id", roleId);
    const initMatrix: Record<string, { scope: string; limit: string }> = {};
    
    if (data) {
      data.forEach((rp: any) => {
        initMatrix[rp.permission_id] = { 
          scope: rp.data_scope || 'NONE',
          limit: rp.amount_limit && rp.amount_limit > 0 ? String(rp.amount_limit) : ''
        };
      });
    }
    setMatrix(initMatrix);
    setActiveTab("matrix");
  };

  const handleMatrixChange = (permId: string, field: string, value: string) => {
    setMatrix(prev => {
      const current = prev[permId] || { scope: 'NONE', limit: '' };
      let newScope = current.scope;
      let newLimit = current.limit;

      if (field === 'checked') {
        if (value === 'true') {
          newScope = 'ALL';
          newLimit = '';
        } else {
          newScope = 'NONE';
          newLimit = '';
        }
      } else if (field === 'scope') {
        newScope = value;
      } else if (field === 'limit') {
        newLimit = validateAmountLimit(value, current.limit);
      }

      return { ...prev, [permId]: { scope: newScope, limit: newLimit } };
    });
  };

  const saveRolePermissions = async () => {
    if (!editingRoleId) return;
    setSaving(true);
    try {
      await supabase.from("role_permissions").delete().eq("role_id", editingRoleId);
      
      const inserts = Object.entries(matrix)
        .filter(([_, config]) => config.scope !== 'NONE')
        .map(([permId, config]) => {
          let amountLimit: number | null = null;
          if (config.limit && config.limit !== '') {
            const num = parseFloat(config.limit);
            if (!isNaN(num) && num > 0) amountLimit = num;
          }
          return {
            role_id: editingRoleId,
            permission_id: permId,
            data_scope: config.scope,
            amount_limit: amountLimit,
            created_by: user?.id
          };
        });

      if (inserts.length > 0) await supabase.from("role_permissions").insert(inserts);
      addToast("success", `Permissions saved for "${editingRoleName}"`);
      setEditingRoleId(null);
    } catch (err: any) { addToast("error", `Failed to save: ${err.message}`); }
    finally { setSaving(false); }
  };

  // ==========================================
  // CEO TRANSFER LOGIC
  // ==========================================
  const openCEOTransfer = () => {
    setTransferTargetUserId("");
    setTransferMyNewRole("");
    setShowCEOTransfer(true);
  };

  const executeCEOTransfer = async () => {
    const ceoRole = getCEORole();
    if (!ceoRole) { addToast("error", "CEO role not found"); return; }
    if (!transferTargetUserId) { addToast("error", "Please select new CEO"); return; }
    if (!transferMyNewRole) { addToast("error", "Please select your new role"); return; }
    if (transferTargetUserId === user?.id) { addToast("error", "Cannot transfer CEO to yourself"); return; }

    setTransferring(true);
    try {
      await supabase.from("user_roles").delete().eq("user_id", user?.id);
      await supabase.from("user_roles").insert({ user_id: transferTargetUserId, role_id: ceoRole.id, created_by: user?.id });
      await supabase.from("user_roles").insert({ user_id: user?.id, role_id: transferMyNewRole, created_by: user?.id });
      await supabase.from("profiles").update({ role: roles.find(r => r.id === transferMyNewRole)?.name || 'EMPLOYEE' }).eq("user_id", user?.id);
      await supabase.from("profiles").update({ role: ceoRole.name }).eq("user_id", transferTargetUserId);

      const targetUser = allUsers.find(u => u.user_id === transferTargetUserId);
      addToast("success", `CEO transferred to "${targetUser?.full_name}". You are now "${roles.find(r => r.id === transferMyNewRole)?.display_name}".`);
      setShowCEOTransfer(false);
      fetchInitialData();
    } catch (err: any) { addToast("error", `Transfer failed: ${err.message}`); }
    finally { setTransferring(false); }
  };

  // ==========================================
  // ✅ FIXED: USER ROLE CHANGE (works for new + existing)
  // ==========================================
  const handleRoleChange = (userId: string, newRoleId: string, userName: string, hasExistingRole: boolean) => {
    const ceoRole = getCEORole();
    if (ceoRole && newRoleId === ceoRole.id) {
      const currentCEO = getCurrentCEO();
      if (currentCEO) {
        if (currentCEO.user_id === user?.id) {
          addToast("warning", "You are the CEO. Use 'Transfer CEO' button.");
        } else {
          addToast("error", `CEO is "${currentCEO.profiles?.full_name}". Only CEO can transfer.`);
        }
        return;
      }
    }

    const newRoleName = roles.find(r => r.id === newRoleId)?.display_name || "Unknown";
    const actionText = hasExistingRole ? "Change" : "Assign";
    
    showConfirm({
      title: `${actionText} User Role`,
      message: `${actionText === 'Assign' ? 'Assign' : 'Change role for'} "${userName}" to "${newRoleName}"?`,
      confirmText: `Yes, ${actionText}`,
      cancelText: "Cancel",
      variant: "warning",
      onConfirm: async () => {
        try {
          // If user already has a role, remove it first
          if (hasExistingRole) {
            await supabase.from("user_roles").delete().eq("user_id", userId);
          }
          
          // Insert new role assignment
          await supabase.from("user_roles").insert({ 
            user_id: userId, 
            role_id: newRoleId, 
            created_by: user?.id 
          });

          // Update profile
          const roleName = roles.find(r => r.id === newRoleId)?.name || 'EMPLOYEE';
          await supabase.from("profiles").update({ role: roleName }).eq("user_id", userId);

          addToast("success", `Role ${actionText.toLowerCase()}d for "${userName}"`);
          fetchInitialData();
        } catch (err: any) { addToast("error", `Failed: ${err.message}`); }
      }
    });
  };

  // ==========================================
  // ACCESS GUARD
  // ==========================================
  if (!permLoading && !hasPermission('ADMIN_USERS')) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] text-center p-6">
        <ShieldCheck className="w-16 h-16 text-red-400 mb-4" />
        <h2 className="text-2xl font-bold text-gray-900 dark:text-white mb-2">Access Denied</h2>
        <p className="text-gray-500">You do not have ADMIN_USERS permission.</p>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] gap-3">
        <Loader2 className="w-10 h-10 animate-spin text-blue-600" />
        <p className="text-sm text-gray-500">Loading RBAC Data...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] text-center p-6 max-w-lg">
        <AlertCircle className="w-16 h-16 text-red-500 mb-4" />
        <h2 className="text-2xl font-bold text-gray-900 dark:text-white mb-2">Failed to Load Data</h2>
        <p className="text-sm text-red-500 bg-red-50 dark:bg-red-500/10 p-3 rounded-lg font-mono break-all">{error}</p>
        <button onClick={fetchInitialData} className="mt-4 bg-blue-600 text-white px-4 py-2 rounded-lg text-sm">Try Again</button>
      </div>
    );
  }

  const currentCEO = getCurrentCEO();
  const currentUserIsCEO = isCurrentUserCEO();
  const ceoRole = getCEORole();
  const otherUsers = getOtherUsers();
  const nonCEORoles = getNonCEORoles();

  // ==========================================
  // MAIN UI
  // ==========================================
  return (
    <div className="p-6 max-w-7xl mx-auto">
      <ToastContainer toasts={toasts} onRemove={removeToast} />
      {confirmDialog && <ConfirmDialogComponent dialog={confirmDialog} onClose={() => setConfirmDialog(null)} />}

      {/* CEO Transfer Modal */}
      {showCEOTransfer && (
        <div className="fixed inset-0 z-[95] flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={!transferring ? () => setShowCEOTransfer(false) : undefined} />
          <div className="relative bg-white dark:bg-gray-800 border dark:border-gray-700 rounded-2xl w-full max-w-lg shadow-2xl animate-scale-in">
            <div className="p-6 border-b dark:border-gray-700 text-center">
              <div className="w-16 h-16 bg-amber-100 dark:bg-amber-900/30 rounded-full flex items-center justify-center mx-auto mb-4">
                <Crown size={32} className="text-amber-600 dark:text-amber-400" />
              </div>
              <h3 className="text-xl font-bold text-gray-900 dark:text-white">Transfer CEO Role</h3>
              <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">This will transfer full CEO authority to another person.</p>
            </div>
            <div className="p-6 space-y-5">
              <div>
                <label className="flex items-center gap-2 text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2">
                  <span className="w-6 h-6 bg-blue-100 dark:bg-blue-900/50 text-blue-700 dark:text-blue-400 rounded-full flex items-center justify-center text-xs font-bold">1</span>
                  Who will be the new CEO?
                </label>
                <select value={transferTargetUserId} onChange={(e) => setTransferTargetUserId(e.target.value)} className="w-full px-4 py-2.5 border dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm focus:ring-2 focus:ring-amber-500">
                  <option value="">-- Select New CEO --</option>
                  {otherUsers.map(u => (<option key={u.user_id} value={u.user_id}>{u.profiles?.full_name || "Unknown"} ({u.profiles?.email || "N/A"})</option>))}
                </select>
              </div>
              <div>
                <label className="flex items-center gap-2 text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2">
                  <span className="w-6 h-6 bg-blue-100 dark:bg-blue-900/50 text-blue-700 dark:text-blue-400 rounded-full flex items-center justify-center text-xs font-bold">2</span>
                  What will be YOUR new role?
                </label>
                <select value={transferMyNewRole} onChange={(e) => setTransferMyNewRole(e.target.value)} className="w-full px-4 py-2.5 border dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm focus:ring-2 focus:ring-amber-500">
                  <option value="">-- Select Your New Role --</option>
                  {nonCEORoles.map(r => (<option key={r.id} value={r.id}>{r.display_name} (Level {r.level})</option>))}
                </select>
              </div>
              <div className="bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-700/50 rounded-lg p-3">
                <p className="text-xs text-amber-700 dark:text-amber-400 flex items-start gap-2">
                  <AlertTriangle size={14} className="flex-shrink-0 mt-0.5" />
                  <span>After transfer, you will lose all CEO-level permissions.</span>
                </p>
              </div>
            </div>
            <div className="flex gap-3 p-6 border-t dark:border-gray-700 bg-gray-50/50 dark:bg-gray-900/30 rounded-b-2xl">
              <button onClick={() => setShowCEOTransfer(false)} disabled={transferring} className="flex-1 px-4 py-2.5 bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 dark:hover:bg-gray-600 text-gray-700 dark:text-gray-300 rounded-xl text-sm font-medium transition-colors disabled:opacity-50">Cancel</button>
              <button onClick={executeCEOTransfer} disabled={transferring || !transferTargetUserId || !transferMyNewRole} className="flex-1 px-4 py-2.5 bg-amber-600 hover:bg-amber-700 text-white rounded-xl text-sm font-medium transition-colors disabled:opacity-50 flex items-center justify-center gap-2">
                {transferring ? <Loader2 size={16} className="animate-spin" /> : <ArrowRightLeft size={16} />} Transfer CEO
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Users & Roles Management</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">Configure RBAC, assign roles, and set amount limits.</p>
        </div>
        <div className="flex gap-2">
          {currentUserIsCEO && (
            <button onClick={openCEOTransfer} className="flex items-center gap-2 bg-amber-500 hover:bg-amber-600 text-white px-4 py-2.5 rounded-lg text-sm font-medium shadow-sm transition-colors">
              <Crown size={16} /> Transfer CEO
            </button>
          )}
          <button onClick={() => setShowCreateModal(true)} className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-4 py-2.5 rounded-lg text-sm font-medium shadow-sm transition-colors">
            <Plus size={16} /> Create New Role
          </button>
        </div>
      </div>

      {/* CEO Banner */}
      {currentUserIsCEO && (
        <div className="mb-6 bg-gradient-to-r from-amber-50 to-yellow-50 dark:from-amber-900/20 dark:to-yellow-900/20 border border-amber-200 dark:border-amber-700/50 rounded-xl p-4 flex items-center gap-3">
          <div className="w-10 h-10 bg-amber-100 dark:bg-amber-900/40 rounded-full flex items-center justify-center flex-shrink-0">
            <Crown size={20} className="text-amber-600 dark:text-amber-400" />
          </div>
          <div className="flex-1">
            <p className="text-sm font-semibold text-amber-800 dark:text-amber-300">You are the current CEO / Founder</p>
            <p className="text-xs text-amber-600 dark:text-amber-400 mt-0.5">Full system access. Use "Transfer CEO" when handing over.</p>
          </div>
        </div>
      )}

      {/* Tabs */}
      <div className="flex gap-1 mb-6 bg-gray-100 dark:bg-gray-800 p-1 rounded-lg w-fit">
        {[
          { id: "roles", label: "System Roles", icon: ShieldCheck },
          { id: "matrix", label: "Permission Matrix", icon: Key },
          { id: "users", label: "User Assignments", icon: Users }
        ].map(tab => (
          <button key={tab.id} onClick={() => setActiveTab(tab.id)} className={`flex items-center gap-2 px-4 py-2 rounded-md transition-all text-sm font-medium ${activeTab === tab.id ? 'bg-white dark:bg-gray-700 text-blue-600 dark:text-blue-400 shadow-sm' : 'text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white'}`}>
            <tab.icon size={16} /> {tab.label}
          </button>
        ))}
      </div>

      {/* ==================== TAB 1: ROLES ==================== */}
      {activeTab === "roles" && (
        <div className="bg-white dark:bg-gray-800 border dark:border-gray-700 rounded-xl overflow-hidden shadow-sm">
          {roles.length === 0 ? (
            <div className="text-center py-16 text-gray-400">
              <ShieldCheck className="w-12 h-12 mx-auto mb-3 opacity-50" />
              <p className="font-medium">No roles found</p>
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-gray-50 dark:bg-gray-900/50 text-left text-xs uppercase text-gray-500 dark:text-gray-400 border-b dark:border-gray-700">
                <tr>
                  <th className="p-4">Role Name</th>
                  <th className="p-4 hidden md:table-cell">Description</th>
                  <th className="p-4 text-center">Authority</th>
                  <th className="p-4 text-center">Type</th>
                  <th className="p-4 text-center hidden sm:table-cell">Assigned To</th>
                  <th className="p-4 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y dark:divide-gray-700">
                {roles.map(r => {
                  const assignedUser = allUsers.find(u => u.role_id === r.id);
                  const isCEO = ceoRole?.id === r.id;
                  return (
                    <tr key={r.id} className={`hover:bg-gray-50 dark:hover:bg-gray-700/30 transition-colors ${isCEO ? 'bg-amber-50/50 dark:bg-amber-900/10' : ''}`}>
                      <td className="p-4">
                        <div className="flex items-center gap-2">
                          {isCEO && <Crown size={14} className="text-amber-500" />}
                          <span className="font-semibold text-gray-900 dark:text-white">{r.display_name}</span>
                        </div>
                        <div className="text-xs text-gray-400 font-mono mt-0.5">{r.name}</div>
                      </td>
                      <td className="p-4 text-gray-500 dark:text-gray-400 hidden md:table-cell">{r.description || '-'}</td>
                      <td className="p-4 text-center">
                        <span className={`px-2.5 py-0.5 rounded-md text-xs font-bold ${isCEO ? 'bg-amber-200 dark:bg-amber-800/50 text-amber-800 dark:text-amber-300' : 'bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300'}`}>LVL {r.level}</span>
                      </td>
                      <td className="p-4 text-center">
                        {r.is_system ? <span className="bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400 px-2 py-0.5 rounded text-xs font-medium">System</span> : <span className="bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-400 px-2 py-0.5 rounded text-xs">Custom</span>}
                      </td>
                      <td className="p-4 text-center hidden sm:table-cell">
                        {assignedUser ? <span className="text-xs text-gray-600 dark:text-gray-400">{assignedUser.full_name}</span> : <span className="text-xs text-gray-300 dark:text-gray-600">—</span>}
                      </td>
                      <td className="p-4 text-right">
                        <div className="flex items-center justify-end gap-2">
                          <button onClick={() => openRoleEditor(r.id)} title="Edit Permissions" className="p-1.5 text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-500/10 rounded-lg transition-colors"><Key size={16} /></button>
                          {!r.is_system && <button onClick={() => handleDeleteRole(r.id, r.display_name)} title="Delete Role" className="p-1.5 text-red-500 hover:bg-red-50 dark:hover:bg-red-500/10 rounded-lg transition-colors"><Trash2 size={16} /></button>}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* ==================== TAB 2: MATRIX (FIXED - No limit on VIEW) ==================== */}
      {activeTab === "matrix" && editingRoleId && (
        <div className="bg-white dark:bg-gray-800 border dark:border-gray-700 rounded-xl shadow-sm">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 p-5 border-b dark:border-gray-700 bg-gray-50/50 dark:bg-gray-900/30">
            <div>
              <h2 className="text-lg font-bold text-gray-900 dark:text-white flex items-center gap-2">
                <Key size={20} className="text-blue-600" /> {editingRoleName}
              </h2>
              <p className="text-xs text-gray-500 mt-1">Check to assign. Amount limit only for action permissions.</p>
            </div>
            <div className="flex gap-2 flex-shrink-0">
              <button onClick={saveRolePermissions} disabled={saving} className="bg-blue-600 hover:bg-blue-700 text-white px-5 py-2 rounded-lg flex items-center gap-2 text-sm font-medium disabled:opacity-50 transition-colors">
                {saving ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />} Save Matrix
              </button>
              <button onClick={() => setEditingRoleId(null)} className="bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 dark:hover:bg-gray-600 text-gray-800 dark:text-white px-4 py-2 rounded-lg flex items-center gap-2 text-sm font-medium transition-colors">
                <X size={16} /> Close
              </button>
            </div>
          </div>
          <div className="p-5 space-y-6 max-h-[65vh] overflow-y-auto">
            {Object.entries(groupedPerms).map(([module, perms]) => {
              // ✅ Check if ANY permission in this module needs amount limit
              const moduleHasActionPerm = perms.some(p => needsAmountLimit(p.name));
              
              return (
                <div key={module} className="border dark:border-gray-700 rounded-lg overflow-hidden">
                  <div className="bg-gray-100 dark:bg-gray-900/50 px-4 py-2.5 font-bold text-xs uppercase tracking-wider text-gray-600 dark:text-gray-300 border-b dark:border-gray-700 flex items-center gap-2">
                    {module}
                    {moduleHasActionPerm && (
                      <span className="text-[10px] font-normal bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400 px-1.5 py-0.5 rounded">
                        Has financial actions
                      </span>
                    )}
                  </div>
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-xs text-gray-500 border-b dark:border-gray-700/50 bg-white dark:bg-gray-800">
                        <th className="text-left p-3 w-2/5">Permission</th>
                        <th className={`text-center p-3 ${moduleHasActionPerm ? 'w-1/5' : 'w-3/5'}`}>Scope</th>
                        {/* ✅ FIX: Only show Amount Limit header if module has action permissions */}
                        {moduleHasActionPerm && <th className="text-left p-3 w-2/5">Amount Limit</th>}
                      </tr>
                    </thead>
                    <tbody className="divide-y dark:divide-gray-700/30">
                      {perms.map(p => {
                        const state = matrix[p.id] || { scope: 'NONE', limit: '' };
                        const isAssigned = state.scope !== 'NONE';
                        const limitValue = state.limit ?? '';
                        const showLimit = needsAmountLimit(p.name); // ✅ Per-permission check
                        
                        return (
                          <tr key={p.id} className={`${!isAssigned ? 'opacity-40' : 'hover:bg-gray-50 dark:hover:bg-gray-700/20'} transition-opacity`}>
                            <td className="p-3">
                              <label className="flex items-center gap-3 cursor-pointer">
                                <input type="checkbox" checked={isAssigned} onChange={(e) => handleMatrixChange(p.id, 'checked', e.target.checked ? 'true' : 'false')} className="w-4 h-4 text-blue-600 rounded focus:ring-blue-500 border-gray-300 dark:border-gray-600 dark:bg-gray-700" />
                                <span className="text-gray-900 dark:text-white text-sm">{p.name}</span>
                              </label>
                            </td>
                            <td className={`text-center p-3 ${showLimit ? '' : moduleHasActionPerm ? '' : ''}`}>
                              {isAssigned ? (
                                <select value={state.scope} onChange={(e) => handleMatrixChange(p.id, 'scope', e.target.value)} className="border dark:border-gray-600 rounded-md bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-xs p-1.5 focus:ring-2 focus:ring-blue-500 w-full max-w-[120px]">
                                  {SCOPE_OPTIONS.map(s => <option key={s} value={s}>{s}</option>)}
                                </select>
                              ) : <span className="text-xs text-gray-400">—</span>}
                            </td>
                            {/* ✅ FIX: Only show Amount Limit INPUT for action permissions */}
                            {moduleHasActionPerm && (
                              <td className="p-3">
                                {isAssigned && showLimit ? (
                                  <div className="relative">
                                    <input 
                                      type="number" 
                                      min="1"
                                      step="any"
                                      value={limitValue}
                                      onChange={(e) => handleMatrixChange(p.id, 'limit', e.target.value)}
                                      onBlur={(e) => {
                                        const val = e.target.value;
                                        if (val !== '') {
                                          const num = parseFloat(val);
                                          if (isNaN(num) || num <= 0) handleMatrixChange(p.id, 'limit', '');
                                        }
                                      }}
                                      placeholder="Unlimited"
                                      className="w-full border dark:border-gray-600 rounded-md bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-xs p-1.5 focus:ring-2 focus:ring-blue-500 pr-8"
                                    />
                                    {limitValue && <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-gray-400 pointer-events-none">PKR</span>}
                                  </div>
                                ) : isAssigned && !showLimit ? (
                                  <span className="text-[10px] text-gray-400 italic">N/A (View only)</span>
                                ) : (
                                  <span className="text-xs text-gray-400">—</span>
                                )}
                              </td>
                            )}
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {activeTab === "matrix" && !editingRoleId && (
        <div className="text-center py-20 text-gray-400 bg-white dark:bg-gray-800 rounded-xl border dark:border-gray-700">
          <Key className="w-16 h-16 mx-auto mb-4 opacity-30" />
          <p className="font-medium text-lg">No Role Selected</p>
          <p className="text-sm mt-1">Go to "System Roles" tab and click the <Key size={12} className="inline mx-1" /> icon.</p>
        </div>
      )}

      {/* ==================== TAB 3: USERS (FIXED - All users + Assign) ==================== */}
      {activeTab === "users" && (
        <div className="bg-white dark:bg-gray-800 border dark:border-gray-700 rounded-xl overflow-hidden shadow-sm">
          {/* Stats bar */}
          <div className="px-4 py-3 bg-gray-50 dark:bg-gray-900/30 border-b dark:border-gray-700 flex items-center gap-4 text-xs">
            <span className="text-gray-500 dark:text-gray-400">
              Total Users: <strong className="text-gray-700 dark:text-gray-300">{allUsers.length}</strong>
            </span>
            <span className="text-gray-300 dark:text-gray-600">|</span>
            <span className="text-green-600 dark:text-green-400">
              Assigned: <strong>{allUsers.filter(u => u.hasRole).length}</strong>
            </span>
            <span className="text-gray-300 dark:text-gray-600">|</span>
            <span className="text-amber-600 dark:text-amber-400">
              Unassigned: <strong>{allUsers.filter(u => !u.hasRole).length}</strong>
            </span>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 dark:bg-gray-900/50 text-left text-xs uppercase text-gray-500 dark:text-gray-400 border-b dark:border-gray-700">
                <tr>
                  <th className="p-4">User</th>
                  <th className="p-4">Current Role</th>
                  <th className="p-4 hidden sm:table-cell">Status</th>
                  <th className="p-4 text-right">{/* Action */}</th>
                </tr>
              </thead>
              <tbody className="divide-y dark:divide-gray-700">
                {allUsers.length === 0 ? (
                  <tr><td colSpan={4} className="p-12 text-center text-gray-400">No users found in the system.</td></tr>
                ) : (
                  allUsers.map(u => {
                    const isCEOUser = ceoRole?.id === u.role_id;
                    const isMe = u.user_id === user?.id;
                    
                    return (
                      <tr key={u.user_id} className={`${!u.hasRole ? 'bg-amber-50/30 dark:bg-amber-900/5' : ''} ${isCEOUser ? 'bg-amber-50/50 dark:bg-amber-900/10' : ''} hover:bg-gray-50 dark:hover:bg-gray-700/30 transition-colors`}>
                        <td className="p-4">
                          <div className="flex items-center gap-2">
                            <div className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold ${isCEOUser ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400' : !u.hasRole ? 'bg-gray-200 text-gray-500 dark:bg-gray-700 dark:text-gray-500' : 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-400'}`}>
                              {(u.full_name || "U").charAt(0).toUpperCase()}
                            </div>
                            <div>
                              <div className="font-medium text-gray-900 dark:text-white flex items-center gap-1.5">
                                {u.full_name || 'Unknown'}
                                {isMe && <span className="text-[10px] bg-blue-100 dark:bg-blue-900/40 text-blue-600 dark:text-blue-400 px-1.5 py-0.5 rounded font-medium">(You)</span>}
                                {!u.hasRole && <span className="text-[10px] bg-amber-100 dark:bg-amber-900/40 text-amber-600 dark:text-amber-400 px-1.5 py-0.5 rounded font-medium">No Role</span>}
                              </div>
                              <div className="text-xs text-gray-500 dark:text-gray-400">{u.email || 'N/A'}</div>
                            </div>
                          </div>
                        </td>
                        <td className="p-4">
                          {u.hasRole ? (
                            <span className={`px-2.5 py-1 rounded-md text-xs font-semibold flex items-center gap-1.5 w-fit ${isCEOUser ? 'bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400' : 'bg-blue-100 dark:bg-blue-500/20 text-blue-700 dark:text-blue-400'}`}>
                              {isCEOUser && <Crown size={12} />}
                              {u.roles?.display_name || 'Assigned'}
                            </span>
                          ) : (
                            <span className="text-xs text-gray-400 italic">Not assigned yet</span>
                          )}
                        </td>
                        <td className="p-4 hidden sm:table-cell">
                          {u.hasRole ? (
                            <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-semibold bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400">
                              <span className="w-1.5 h-1.5 rounded-full bg-green-500"></span>
                              Active
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-semibold bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-400">
                              <span className="w-1.5 h-1.5 rounded-full bg-gray-400"></span>
                              Pending
                            </span>
                          )}
                        </td>
                        <td className="p-4 text-right">
                          {isCEOUser && isMe ? (
                            <span className="text-xs text-amber-600 dark:text-amber-400 font-medium flex items-center justify-end gap-1">
                              <Crown size={12} /> Use Transfer
                            </span>
                          ) : isCEOUser && !isMe ? (
                            <span className="text-xs text-gray-400 flex items-center justify-end gap-1">
                              <ShieldCheck size={12} /> Protected
                            </span>
                          ) : (
                            <select
                              defaultValue={u.role_id || ''}
                              onChange={(e) => {
                                if (e.target.value) {
                                  handleRoleChange(u.user_id, e.target.value, u.full_name || 'User', u.hasRole);
                                }
                              }}
                              className="border dark:border-gray-600 rounded-md bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-xs p-2 w-full max-w-[200px] focus:ring-2 focus:ring-blue-500"
                            >
                              <option value="" disabled>
                                {u.hasRole ? 'Change Role...' : '➕ Assign Role...'}
                              </option>
                              {roles.filter(r => r.id !== ceoRole?.id).map(r => (
                                <option key={r.id} value={r.id} disabled={u.role_id === r.id}>
                                  {r.display_name} {u.role_id === r.id ? '✓ Current' : ''}
                                </option>
                              ))}
                            </select>
                          )}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ==================== CREATE ROLE MODAL ==================== */}
      {showCreateModal && (
        <div className="fixed inset-0 z-[80] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
          <div className="bg-white dark:bg-gray-800 border dark:border-gray-700 rounded-2xl w-full max-w-md shadow-2xl">
            <div className="flex items-center justify-between p-5 border-b dark:border-gray-700">
              <h3 className="text-lg font-bold text-gray-900 dark:text-white">Create New Role</h3>
              <button onClick={() => setShowCreateModal(false)} className="p-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"><X size={20} className="text-gray-500" /></button>
            </div>
            <div className="p-5 space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">Role Display Name *</label>
                <input type="text" value={newRole.display_name} onChange={(e) => setNewRole({...newRole, display_name: e.target.value})} placeholder="e.g., Team Lead" className="w-full px-4 py-2.5 border dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 text-sm" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">Description</label>
                <textarea value={newRole.description} onChange={(e) => setNewRole({...newRole, description: e.target.value})} placeholder="What is the purpose of this role?" rows={3} className="w-full px-4 py-2.5 border dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 text-sm resize-none" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">Authority Level (1-100)</label>
                <input type="number" min={1} max={100} value={newRole.level} onChange={(e) => setNewRole({...newRole, level: parseInt(e.target.value) || 50})} className="w-full px-4 py-2.5 border dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 text-sm" />
                <p className="text-xs text-gray-400 mt-1">Higher = more authority (CEO = 100)</p>
              </div>
            </div>
            <div className="flex justify-end gap-3 p-5 border-t dark:border-gray-700 bg-gray-50/50 dark:bg-gray-900/30">
              <button onClick={() => setShowCreateModal(false)} className="px-5 py-2.5 bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 dark:hover:bg-gray-600 text-gray-800 dark:text-white rounded-lg text-sm font-medium transition-colors">Cancel</button>
              <button onClick={handleCreateRole} disabled={saving || !newRole.display_name.trim()} className="px-5 py-2.5 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-medium flex items-center gap-2 disabled:opacity-50 transition-colors">
                {saving ? <Loader2 size={16} className="animate-spin" /> : <CheckCircle2 size={16} />} Create Role
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}