"use client";

import { createContext, useContext, useEffect, useState, ReactNode, useCallback } from "react";
import { useAuth } from "./AuthContext";
import { supabase } from "@/lib/supabase";

export type PermCode =
  | "INCOME_READ" | "INCOME_CREATE" | "INCOME_UPDATE" | "INCOME_DELETE"
  | "EXPENSE_READ" | "EXPENSE_CREATE" | "EXPENSE_UPDATE" | "EXPENSE_DELETE"
  | "INVOICE_READ" | "INVOICE_CREATE" | "INVOICE_UPDATE" | "INVOICE_DELETE"
  | "PAYMENT_RECEIPT_READ" | "PAYMENT_RECEIPT_CREATE" | "PAYMENT_RECEIPT_UPDATE"
  | "CREDIT_NOTE_READ" | "CREDIT_NOTE_CREATE" | "CREDIT_NOTE_UPDATE"
  | "VENDOR_READ" | "VENDOR_CREATE" | "VENDOR_UPDATE" | "VENDOR_DELETE"
  | "VENDOR_BILL_READ" | "VENDOR_BILL_CREATE" | "VENDOR_BILL_UPDATE" | "VENDOR_BILL_DELETE"
  | "VENDOR_PAYMENT_READ" | "VENDOR_PAYMENT_CREATE" | "VENDOR_PAYMENT_UPDATE"
  | "BANK_READ" | "BANK_CREATE" | "BANK_UPDATE" | "BANK_RECONCILE" | "BANK_TRANSFER"
  | "COA_READ" | "COA_CREATE" | "COA_UPDATE" | "COA_DELETE"
  | "JOURNAL_READ" | "JOURNAL_CREATE" | "JOURNAL_UPDATE" | "JOURNAL_DELETE"
  | "PERIOD_READ" | "PERIOD_MANAGE"
  | "TAX_READ" | "TAX_MANAGE"
  | "EQUITY_READ" | "EQUITY_MANAGE"
  | "BUDGET_READ" | "BUDGET_CREATE" | "BUDGET_UPDATE"
  | "PROJECT_READ" | "PROJECT_CREATE" | "PROJECT_UPDATE" | "PROJECT_DELETE"
  | "REPORT_READ" | "REPORT_CREATE"
  | "SETTINGS_READ" | "SETTINGS_MANAGE"
  | "ADMIN_USERS" | "ADMIN_AUDIT" | "ADMIN_MIGRATION"
  | "APPROVE_INCOME" | "APPROVE_EXPENSE" | "APPROVE_INVOICE"
  | "APPROVE_VENDOR_BILL" | "APPROVE_PAYMENT" | "APPROVE_JOURNAL"
  | "CLIENT_READ" | "CLIENT_CREATE" | "CLIENT_UPDATE" | "CLIENT_DELETE"
  | "GL_READ"
  | "TAX_CREATE";

// Valid permission codes for validation
const VALID_PERM_CODES: PermCode[] = [
  "INCOME_READ", "INCOME_CREATE", "INCOME_UPDATE", "INCOME_DELETE",
  "EXPENSE_READ", "EXPENSE_CREATE", "EXPENSE_UPDATE", "EXPENSE_DELETE",
  "INVOICE_READ", "INVOICE_CREATE", "INVOICE_UPDATE", "INVOICE_DELETE",
  "PAYMENT_RECEIPT_READ", "PAYMENT_RECEIPT_CREATE", "PAYMENT_RECEIPT_UPDATE",
  "CREDIT_NOTE_READ", "CREDIT_NOTE_CREATE", "CREDIT_NOTE_UPDATE",
  "VENDOR_READ", "VENDOR_CREATE", "VENDOR_UPDATE", "VENDOR_DELETE",
  "VENDOR_BILL_READ", "VENDOR_BILL_CREATE", "VENDOR_BILL_UPDATE", "VENDOR_BILL_DELETE",
  "VENDOR_PAYMENT_READ", "VENDOR_PAYMENT_CREATE", "VENDOR_PAYMENT_UPDATE",
  "BANK_READ", "BANK_CREATE", "BANK_UPDATE", "BANK_RECONCILE", "BANK_TRANSFER",
  "COA_READ", "COA_CREATE", "COA_UPDATE", "COA_DELETE",
  "JOURNAL_READ", "JOURNAL_CREATE", "JOURNAL_UPDATE", "JOURNAL_DELETE",
  "PERIOD_READ", "PERIOD_MANAGE",
  "TAX_READ", "TAX_MANAGE",
  "EQUITY_READ", "EQUITY_MANAGE",
  "BUDGET_READ", "BUDGET_CREATE", "BUDGET_UPDATE",
  "PROJECT_READ", "PROJECT_CREATE", "PROJECT_UPDATE", "PROJECT_DELETE",
  "REPORT_READ", "REPORT_CREATE",
  "SETTINGS_READ", "SETTINGS_MANAGE",
  "ADMIN_USERS", "ADMIN_AUDIT", "ADMIN_MIGRATION",
  "APPROVE_INCOME", "APPROVE_EXPENSE", "APPROVE_INVOICE",
  "APPROVE_VENDOR_BILL", "APPROVE_PAYMENT", "APPROVE_JOURNAL",
  "CLIENT_READ", "CLIENT_CREATE", "CLIENT_UPDATE", "CLIENT_DELETE",
  "GL_READ",
  "TAX_CREATE",
];

// Fallback permissions
const FALLBACK_PERMISSIONS: Record<string, PermCode[]> = {
  Admin: null as any,
  CEO: [
    "INCOME_READ", "INCOME_CREATE", "INCOME_UPDATE", "INCOME_DELETE",
    "EXPENSE_READ", "EXPENSE_CREATE", "EXPENSE_UPDATE", "EXPENSE_DELETE",
    "INVOICE_READ", "INVOICE_CREATE", "INVOICE_UPDATE", "INVOICE_DELETE",
    "PAYMENT_RECEIPT_READ", "PAYMENT_RECEIPT_CREATE", "PAYMENT_RECEIPT_UPDATE",
    "CREDIT_NOTE_READ", "CREDIT_NOTE_CREATE", "CREDIT_NOTE_UPDATE",
    "VENDOR_READ", "VENDOR_CREATE", "VENDOR_UPDATE", "VENDOR_DELETE",
    "VENDOR_BILL_READ", "VENDOR_BILL_CREATE", "VENDOR_BILL_UPDATE", "VENDOR_BILL_DELETE",
    "VENDOR_PAYMENT_READ", "VENDOR_PAYMENT_CREATE", "VENDOR_PAYMENT_UPDATE",
    "BANK_READ", "BANK_CREATE", "BANK_UPDATE", "BANK_RECONCILE", "BANK_TRANSFER",
    "COA_READ", "COA_CREATE", "COA_UPDATE", "COA_DELETE",
    "JOURNAL_READ", "JOURNAL_CREATE", "JOURNAL_UPDATE", "JOURNAL_DELETE",
    "PERIOD_READ", "PERIOD_MANAGE",
    "TAX_READ", "TAX_MANAGE",
    "EQUITY_READ", "EQUITY_MANAGE",
    "BUDGET_READ", "BUDGET_CREATE", "BUDGET_UPDATE",
    "PROJECT_READ", "PROJECT_CREATE", "PROJECT_UPDATE", "PROJECT_DELETE",
    "REPORT_READ", "REPORT_CREATE",
    "SETTINGS_READ", "SETTINGS_MANAGE",
    "ADMIN_USERS", "ADMIN_AUDIT", "ADMIN_MIGRATION",
    "APPROVE_INCOME", "APPROVE_EXPENSE", "APPROVE_INVOICE",
    "APPROVE_VENDOR_BILL", "APPROVE_PAYMENT", "APPROVE_JOURNAL",
    "CLIENT_READ", "CLIENT_CREATE", "CLIENT_UPDATE", "CLIENT_DELETE",
    "GL_READ",
    "TAX_CREATE",
  ],
  FINANCE_HEAD: [
    "INCOME_READ", "INCOME_CREATE", "INCOME_UPDATE", "INCOME_DELETE",
    "EXPENSE_READ", "EXPENSE_CREATE", "EXPENSE_UPDATE", "EXPENSE_DELETE",
    "INVOICE_READ", "INVOICE_CREATE", "INVOICE_UPDATE", "INVOICE_DELETE",
    "PAYMENT_RECEIPT_READ", "PAYMENT_RECEIPT_CREATE", "PAYMENT_RECEIPT_UPDATE",
    "CREDIT_NOTE_READ", "CREDIT_NOTE_CREATE", "CREDIT_NOTE_UPDATE",
    "VENDOR_READ", "VENDOR_CREATE", "VENDOR_UPDATE", "VENDOR_DELETE",
    "VENDOR_BILL_READ", "VENDOR_BILL_CREATE", "VENDOR_BILL_UPDATE", "VENDOR_BILL_DELETE",
    "VENDOR_PAYMENT_READ", "VENDOR_PAYMENT_CREATE", "VENDOR_PAYMENT_UPDATE",
    "BANK_READ", "BANK_CREATE", "BANK_UPDATE", "BANK_RECONCILE", "BANK_TRANSFER",
    "COA_READ", "COA_CREATE", "COA_UPDATE", "COA_DELETE",
    "JOURNAL_READ", "JOURNAL_CREATE", "JOURNAL_UPDATE", "JOURNAL_DELETE",
    "PERIOD_READ", "PERIOD_MANAGE",
    "TAX_READ", "TAX_MANAGE",
    "EQUITY_READ", "EQUITY_MANAGE",
    "BUDGET_READ", "BUDGET_CREATE", "BUDGET_UPDATE",
    "PROJECT_READ", "PROJECT_CREATE", "PROJECT_UPDATE",
    "REPORT_READ", "REPORT_CREATE",
    "SETTINGS_READ", "SETTINGS_MANAGE",
    "APPROVE_INCOME", "APPROVE_EXPENSE", "APPROVE_INVOICE",
    "APPROVE_VENDOR_BILL", "APPROVE_PAYMENT", "APPROVE_JOURNAL",
  ],
  ACCOUNTANT: [
    "INCOME_READ", "INCOME_CREATE", "INCOME_UPDATE",
    "EXPENSE_READ", "EXPENSE_CREATE", "EXPENSE_UPDATE",
    "INVOICE_READ", "INVOICE_CREATE", "INVOICE_UPDATE",
    "PAYMENT_RECEIPT_READ", "PAYMENT_RECEIPT_CREATE",
    "CREDIT_NOTE_READ", "CREDIT_NOTE_CREATE",
    "VENDOR_READ", "VENDOR_CREATE",
    "VENDOR_BILL_READ", "VENDOR_BILL_CREATE", "VENDOR_BILL_UPDATE",
    "VENDOR_PAYMENT_READ", "VENDOR_PAYMENT_CREATE",
    "BANK_READ", "BANK_RECONCILE", "BANK_TRANSFER",
    "COA_READ",
    "JOURNAL_READ", "JOURNAL_CREATE",
    "PERIOD_READ",
    "TAX_READ",
    "BUDGET_READ",
    "PROJECT_READ",
    "REPORT_READ",
  ],
  PROJECT_MANAGER: [
    "INCOME_READ",
    "EXPENSE_READ", "EXPENSE_CREATE",
    "INVOICE_READ",
    "PROJECT_READ", "PROJECT_UPDATE",
    "REPORT_READ",
  ],
  EMPLOYEE: [
    "EXPENSE_READ", "EXPENSE_CREATE",
  ],
  VIEWER: [
    "REPORT_READ",
  ],
};

interface PermissionContextType {
  role: string;
  permissions: Set<PermCode>;
  can: (perm: PermCode) => boolean;
  hasPermission: (perm: string) => boolean;
  isFinanceUser: boolean;
  isLoading: boolean;
  error: string | null;
  refreshPermissions: () => Promise<void>;
}

const PermissionContext = createContext<PermissionContextType>({
  role: "VIEWER",
  permissions: new Set(),
  can: () => false,
  hasPermission: () => false,
  isFinanceUser: false,
  isLoading: true,
  error: null,
  refreshPermissions: async () => {},
});

export function PermissionProvider({ children }: { children: ReactNode }) {
  const auth = useAuth();
  const user = (auth as any).user ?? null;
  const authLoading = (auth as any).isLoading ?? (auth as any).loading ?? false;

  const [role, setRole] = useState<string>("VIEWER");
  const [permissions, setPermissions] = useState<Set<PermCode>>(new Set());
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchUserRole = useCallback(async () => {
    if (authLoading) return;

    if (!user) {
      setRole("VIEWER");
      setPermissions(new Set(FALLBACK_PERMISSIONS.VIEWER));
      setIsLoading(false);
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      const today = new Date().toISOString().split("T")[0];
      let assignedRole: string | null = null;
      let roleId: string | null = null;

      // ========== METHOD 1: RPC get_my_user_roles ==========
      try {
        const { data: rpcData, error: rpcError } = await supabase.rpc("get_my_user_roles");

        // RPC can return array or single object
        const rpcArray = Array.isArray(rpcData) ? rpcData : (rpcData ? [rpcData] : []);

        if (!rpcError && rpcArray.length > 0) {
          const activeRole = rpcArray
            .filter((r: any) =>
              r.is_active !== false &&
              r.effective_from <= today &&
              (!r.effective_to || r.effective_to >= today)
            )
            .sort((a: any, b: any) =>
              (b.effective_from || '').localeCompare(a.effective_from || '')
            )[0];

          if (activeRole) {
            // Support both 'role' and 'role_name' column names
            assignedRole = activeRole.role || activeRole.role_name || null;
            roleId = activeRole.role_id || null;
            console.log("[PermCtx] METHOD 1 (RPC) role:", assignedRole, "roleId:", roleId);
          }
        } else if (rpcError) {
          console.warn("[PermCtx] RPC get_my_user_roles error:", rpcError.message);
        }
      } catch (e) {
        console.warn("[PermCtx] RPC get_my_user_roles exception:", e);
      }

      // ========== METHOD 2: View v_user_roles ==========
      if (!assignedRole) {
        try {
          const { data: viewData, error: viewError } = await supabase
            .from("v_user_roles")
            .select("role, role_name, role_id, is_active, effective_from, effective_to")
            .eq("user_id", user.id)
            .eq("is_active", true)
            .lte("effective_from", today)
            .or(`effective_to.is.null,effective_to.gte.${today}`)
            .order("effective_from", { ascending: false })
            .limit(1)
            .maybeSingle();

          if (!viewError && viewData) {
            // Support both 'role' and 'role_name' column names
            assignedRole = (viewData as any).role || (viewData as any).role_name || null;
            roleId = viewData.role_id;
            console.log("[PermCtx] METHOD 2 (View) role:", assignedRole, "roleId:", roleId);
          } else if (viewError) {
            console.warn("[PermCtx] v_user_roles query error:", viewError.message);
          }
        } catch (e) {
          console.warn("[PermCtx] v_user_roles query exception:", e);
        }
      }

      // ========== METHOD 3: profiles.role fallback ==========
      if (!assignedRole) {
        try {
          // Try user_id first (correct FK column)
          let { data: pData } = await supabase
            .from("profiles")
            .select("role")
            .eq("user_id", user.id)
            .maybeSingle();

          // Fallback to id column
          if (!pData) {
            const result = await supabase
              .from("profiles")
              .select("role")
              .eq("id", user.id)
              .maybeSingle();
            pData = result.data;
          }

          let profileRole = pData?.role;

          // Map legacy role names
          if (profileRole === "Admin") {
            console.warn("[PermCtx] Legacy 'Admin' role found in profile. Mapping to CEO.");
            profileRole = "CEO";
          } else if (profileRole === "Program Manager") {
            profileRole = "ACCOUNTANT";
          }

          if (profileRole) {
            assignedRole = profileRole;
            const { data: roleMatch } = await supabase
              .from("v_roles")
              .select("id")
              .eq("name", assignedRole)
              .maybeSingle();
            roleId = roleMatch?.id ?? null;
            console.log("[PermCtx] METHOD 3 (Profile) role:", assignedRole, "roleId:", roleId);
          }
        } catch (e) {
          console.warn("[PermCtx] Profile fallback exception:", e);
        }
      }

      // Default to VIEWER
      if (!assignedRole) {
        assignedRole = "VIEWER";
      }

      // ========== CEO uniqueness check (skip if view column mismatch) ==========
      if (assignedRole === "CEO") {
        try {
          const { count, error: ceoErr } = await supabase
            .from("v_user_roles")
            .select("*", { count: "exact", head: true })
            .eq("is_active", true)
            .neq("user_id", user.id);

          if (!ceoErr && count && count > 0) {
            // Check if any of those are actually CEO role
            const { data: otherCEOs } = await supabase
              .from("v_user_roles")
              .select("role, role_name, user_id")
              .eq("is_active", true)
              .neq("user_id", user.id);

            const isReallyCEO = (otherCEOs || []).some(
              (r: any) => r.role === "CEO" || r.role_name === "CEO"
            );

            if (isReallyCEO) {
              console.warn("[PermCtx] Another CEO exists. Downgrading to FINANCE_HEAD.");
              assignedRole = "FINANCE_HEAD";
              const { data: fhRole } = await supabase
                .from("v_roles")
                .select("id")
                .eq("name", "FINANCE_HEAD")
                .maybeSingle();
              roleId = fhRole?.id ?? null;
            }
          }
        } catch (e) {
          console.warn("[PermCtx] CEO check exception:", e);
        }
      }

      // ========== FETCH PERMISSIONS ==========
      let dbPermissions: PermCode[] = [];

      // --- Permission METHOD 1: RPC get_my_permissions ---
      // Handles both JSON object return and table return
      if (roleId) {
        try {
          const { data: rpcPerms, error: rpcPermError } = await supabase.rpc("get_my_permissions");

          if (!rpcPermError && rpcPerms) {
            // Case A: RPC returns JSON object {role: 'CEO', ADMIN_USERS: true, ...}
            if (!Array.isArray(rpcPerms) && typeof rpcPerms === 'object') {
              dbPermissions = Object.keys(rpcPerms)
                .filter((key: string) =>
                  VALID_PERM_CODES.includes(key as PermCode) && rpcPerms[key] === true
                ) as PermCode[];
              console.log("[PermCtx] Perm RPC-JSON:", dbPermissions.length, "permissions");
            }
            // Case B: RPC returns table [{permission_code: '...'}, ...]
            else if (Array.isArray(rpcPerms) && rpcPerms.length > 0) {
              dbPermissions = rpcPerms
                .map((p: any) => p.permission_code || p.perm_code || p.code)
                .filter((code: any): code is PermCode =>
                  code && VALID_PERM_CODES.includes(code)
                );
              console.log("[PermCtx] Perm RPC-Table:", dbPermissions.length, "permissions");
            }
          } else if (rpcPermError) {
            console.warn("[PermCtx] RPC get_my_permissions error:", rpcPermError.message);
          }
        } catch (e) {
          console.warn("[PermCtx] RPC get_my_permissions exception:", e);
        }
      }

      // --- Permission METHOD 2: View v_role_permissions ---
      // Handles both 'permission_code' and 'perm_code' column names
      if (dbPermissions.length === 0 && roleId) {
        try {
          const { data: permData, error: permError } = await supabase
            .from("v_role_permissions")
            .select("permission_code, perm_code")
            .eq("role_id", roleId)
            .lte("effective_from", today)
            .or(`effective_to.is.null,effective_to.gte.${today}`);

          if (!permError && permData && permData.length > 0) {
            dbPermissions = permData
              .map((p: any) => p.permission_code || p.perm_code)
              .filter((code): code is PermCode =>
                code && VALID_PERM_CODES.includes(code)
              );
            console.log("[PermCtx] Perm View:", dbPermissions.length, "permissions");
          } else if (permError) {
            console.warn("[PermCtx] v_role_permissions error:", permError.message);
          }
        } catch (e) {
          console.warn("[PermCtx] v_role_permissions exception:", e);
        }
      }

      // ========== FINAL RESOLVE ==========
      const resolvedRole = assignedRole === "Admin" ? "CEO"
        : assignedRole === "Program Manager" ? "ACCOUNTANT"
        : assignedRole;

      const finalPermissions = dbPermissions.length > 0
        ? dbPermissions
        : (FALLBACK_PERMISSIONS[resolvedRole] || FALLBACK_PERMISSIONS.VIEWER);

      console.log("[PermCtx] FINAL role:", assignedRole, "permissions:", finalPermissions.length,
        "source:", dbPermissions.length > 0 ? "database" : "fallback");

      setRole(assignedRole);
      setPermissions(new Set(finalPermissions));

    } catch (err) {
      console.error("[PermCtx] Permission fetch error:", err);
      setError(err instanceof Error ? err.message : "Failed to load permissions");
      setRole("VIEWER");
      setPermissions(new Set(FALLBACK_PERMISSIONS.VIEWER));
    } finally {
      setIsLoading(false);
    }
  }, [user, authLoading]);

  useEffect(() => {
    fetchUserRole();
  }, [fetchUserRole]);

  const can = (perm: PermCode): boolean => {
    return permissions.has(perm);
  };

  const hasPermission = (perm: string): boolean => {
    return permissions.has(perm as PermCode);
  };
  const isFinanceUser = permissions.has('JOURNAL_CREATE') || permissions.has('INCOME_CREATE');

  return (
    <PermissionContext.Provider value={{
      role,
      permissions,
      can,
      hasPermission,
      isLoading,
      isFinanceUser,
      error,
      refreshPermissions: fetchUserRole
    }}>
      {children}
    </PermissionContext.Provider>
  );
}

export function usePermissions() {
  const context = useContext(PermissionContext);
  if (!context) {
    throw new Error("usePermissions must be used within a PermissionProvider");
  }
  return context;
}

export default PermissionContext;