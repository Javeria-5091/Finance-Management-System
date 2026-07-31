// src/context/PermissionContext.tsx
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
  | "APPROVE_VENDOR_BILL" | "APPROVE_PAYMENT" | "APPROVE_JOURNAL";

// Valid permission codes for validation
const VALID_PERM_CODES: string[] = [
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
];

// Fallback permissions
const FALLBACK_PERMISSIONS: Record<string, PermCode[]> = {
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
  isFinanceUser :boolean,
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

      // ✅ METHOD 1: Try RPC function (most secure - uses JWT)
      try {
        const { data: rpcData, error: rpcError } = await supabase.rpc("get_my_user_roles");
        
        if (!rpcError && rpcData && rpcData.length > 0) {
          // Get the active, effective role
          const activeRole = rpcData
            .filter((r: any) => r.is_active && r.effective_from <= today && (!r.effective_to || r.effective_to >= today))
            .sort((a: any, b: any) => b.effective_from?.localeCompare(a.effective_from))[0];
          
          if (activeRole) {
            assignedRole = activeRole.role;
            roleId = activeRole.role_id;
          }
        }
      } catch (e) {
        console.warn("RPC get_my_user_roles failed, trying view:", e);
      }

      // ✅ METHOD 2: Fallback to view with client-side filter
      if (!assignedRole) {
        const { data: viewData, error: viewError } = await supabase
          .from("v_user_roles")
          .select("role, role_id, is_active, effective_from, effective_to")
          .eq("user_id", user.id)
          .eq("is_active", true)
          .lte("effective_from", today)
          .or(`effective_to.is.null,effective_to.gte.${today}`)
          .order("effective_from", { ascending: false })
          .limit(1)
          .maybeSingle();

        if (!viewError && viewData) {
          assignedRole = viewData.role;
          roleId = viewData.role_id;
        }
      }

      // ✅ METHOD 3: Fallback to profiles.role
      if (!assignedRole) {
        const { data: profileData } = await supabase
          .from("profiles")
          .select("role")
          .eq("id", user.id)
          .maybeSingle();

        if (profileData?.role) {
          assignedRole = profileData.role;
          const { data: roleMatch } = await supabase
            .from("v_roles")
            .select("id")
            .eq("name", assignedRole)
            .maybeSingle();
          roleId = roleMatch?.id ?? null;
        }
      }

      // Default to VIEWER
      if (!assignedRole) {
        assignedRole = "VIEWER";
      }

      // ✅ CEO uniqueness check
      if (assignedRole === "CEO") {
        try {
          const { count } = await supabase
            .from("v_user_roles")
            .select("*", { count: "exact", head: true })
            .eq("role", "CEO")
            .eq("is_active", true)
            .neq("user_id", user.id);

          if (count && count > 0) {
            console.warn("Another CEO exists. Using FINANCE_HEAD.");
            assignedRole = "FINANCE_HEAD";
            const { data: fhRole } = await supabase
              .from("v_roles")
              .select("id")
              .eq("name", "FINANCE_HEAD")
              .maybeSingle();
            roleId = fhRole?.id ?? null;
          }
        } catch (e) {
          console.warn("CEO check failed:", e);
        }
      }

      // ✅ Fetch permissions
      let dbPermissions: PermCode[] = [];

      // Try RPC first
      if (roleId) {
        try {
          const { data: rpcPerms, error: rpcPermError } = await supabase.rpc("get_my_permissions");
          
          if (!rpcPermError && rpcPerms && rpcPerms.length > 0) {
            dbPermissions = rpcPerms
              .map((p: any) => p.permission_code)
              .filter((code: any): code is PermCode => code && VALID_PERM_CODES.includes(code));
          }
        } catch (e) {
          console.warn("RPC get_my_permissions failed:", e);
        }
      }

      // Fallback to view query
      if (dbPermissions.length === 0 && roleId) {
        try {
          const { data: permData } = await supabase
            .from("v_role_permissions")
            .select("permission_code")
            .eq("role_id", roleId)
            .lte("effective_from", today)
            .or(`effective_to.is.null,effective_to.gte.${today}`);

          if (permData && permData.length > 0) {
            dbPermissions = permData
              .map(p => p.permission_code)
              .filter((code): code is PermCode => code && VALID_PERM_CODES.includes(code));
          }
        } catch (e) {
          console.warn("v_role_permissions query failed:", e);
        }
      }

      // Use DB or fallback
      const finalPermissions = dbPermissions.length > 0
        ? dbPermissions
        : (FALLBACK_PERMISSIONS[assignedRole] || FALLBACK_PERMISSIONS.VIEWER);

      setRole(assignedRole);
      setPermissions(new Set(finalPermissions));

    } catch (err) {
      console.error("Permission fetch error:", err);
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
  const isFinanceUser = permissions.has('JOURNAL_CREATE') ||  permissions.has('INCOME_CREATE');
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