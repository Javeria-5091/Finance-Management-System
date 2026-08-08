"use client";

import { createContext, useContext, useEffect, useState, ReactNode, useCallback } from "react";
import { useAuth } from "./AuthContext";
import { supabase } from "@/lib/supabase";

// =============================================================================
// FIX: Added PAYROLL_* permission codes to PermCode union type
// File: src/context/PermissionContext.tsx
// =============================================================================

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
  | "TAX_CREATE"
  | "APPROVE_BUDGET"
  | "ADMIN_MFA"
  // Fixed Assets module
  | "FIXED_ASSET_READ" | "FIXED_ASSET_CREATE" | "FIXED_ASSET_UPDATE" | "FIXED_ASSET_DELETE"
  | "FIXED_ASSET_CAPITALIZE" | "FIXED_ASSET_DISPOSE"
  | "FIXED_ASSET_DEPR_READ" | "FIXED_ASSET_DEPR_GENERATE" | "FIXED_ASSET_DEPR_POST"
  | "FIXED_ASSET_VERIFY_READ" | "FIXED_ASSET_VERIFY_CREATE" | "FIXED_ASSET_VERIFY_UPDATE"
  | "FIXED_ASSET_CATEGORY_READ" | "FIXED_ASSET_CATEGORY_CREATE" | "FIXED_ASSET_CATEGORY_UPDATE"
  // ★★★ FIX #2: Added Payroll module permissions ★★★
  | "PAYROLL_READ" | "PAYROLL_CREATE" | "PAYROLL_UPDATE" | "PAYROLL_DELETE"
  | "PAYROLL_APPROVE" | "PAYROLL_POST"
  | "PAYROLL_ADVANCE_READ" | "PAYROLL_ADVANCE_CREATE" | "PAYROLL_ADVANCE_APPROVE"
  | "PAYROLL_COMMISSION_READ" | "PAYROLL_COMMISSION_CREATE" | "PAYROLL_COMMISSION_APPROVE"
  | "PAYROLL_REIMBURSEMENT_READ" | "PAYROLL_REIMBURSEMENT_CREATE" | "PAYROLL_REIMBURSEMENT_APPROVE"
  | "SUBSCRIPTION_READ" | "SUBSCRIPTION_CREATE" | "SUBSCRIPTION_UPDATE" | "SUBSCRIPTION_DELETE"
  | "CONTRACTOR_READ" | "CONTRACTOR_CREATE" | "CONTRACTOR_UPDATE" | "CONTRACTOR_DELETE"
  | "COMMISSION_READ" | "COMMISSION_CREATE" | "COMMISSION_UPDATE" | "COMMISSION_DELETE" | "COMMISSION_APPROVE";

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
  "APPROVE_BUDGET",
  "ADMIN_MFA",
  // Fixed Assets
  "FIXED_ASSET_READ", "FIXED_ASSET_CREATE", "FIXED_ASSET_UPDATE", "FIXED_ASSET_DELETE",
  "FIXED_ASSET_CAPITALIZE", "FIXED_ASSET_DISPOSE",
  "FIXED_ASSET_DEPR_READ", "FIXED_ASSET_DEPR_GENERATE", "FIXED_ASSET_DEPR_POST",
  "FIXED_ASSET_VERIFY_READ", "FIXED_ASSET_VERIFY_CREATE", "FIXED_ASSET_VERIFY_UPDATE",
  "FIXED_ASSET_CATEGORY_READ", "FIXED_ASSET_CATEGORY_CREATE", "FIXED_ASSET_CATEGORY_UPDATE",
  // ★★★ FIX #2: Payroll permissions in VALID_PERM_CODES ★★★
  "PAYROLL_READ", "PAYROLL_CREATE", "PAYROLL_UPDATE", "PAYROLL_DELETE",
  "PAYROLL_APPROVE", "PAYROLL_POST",
  "PAYROLL_ADVANCE_READ", "PAYROLL_ADVANCE_CREATE", "PAYROLL_ADVANCE_APPROVE",
  "PAYROLL_COMMISSION_READ", "PAYROLL_COMMISSION_CREATE", "PAYROLL_COMMISSION_APPROVE",
  "PAYROLL_REIMBURSEMENT_READ", "PAYROLL_REIMBURSEMENT_CREATE", "PAYROLL_REIMBURSEMENT_APPROVE",
  "SUBSCRIPTION_READ", "SUBSCRIPTION_CREATE", "SUBSCRIPTION_UPDATE", "SUBSCRIPTION_DELETE",
  'CONTRACTOR_READ', 'CONTRACTOR_CREATE', 'CONTRACTOR_UPDATE', 'CONTRACTOR_DELETE',
  'COMMISSION_READ', 'COMMISSION_CREATE', 'COMMISSION_UPDATE', 'COMMISSION_DELETE', 'COMMISSION_APPROVE',
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
    "APPROVE_BUDGET",
    // Fixed Assets
    "FIXED_ASSET_READ", "FIXED_ASSET_CREATE", "FIXED_ASSET_UPDATE", "FIXED_ASSET_DELETE",
    "FIXED_ASSET_CAPITALIZE", "FIXED_ASSET_DISPOSE",
    "FIXED_ASSET_DEPR_READ", "FIXED_ASSET_DEPR_GENERATE", "FIXED_ASSET_DEPR_POST",
    "FIXED_ASSET_VERIFY_READ", "FIXED_ASSET_VERIFY_CREATE", "FIXED_ASSET_VERIFY_UPDATE",
    "FIXED_ASSET_CATEGORY_READ", "FIXED_ASSET_CATEGORY_CREATE", "FIXED_ASSET_CATEGORY_UPDATE",
    // ★★★ FIX #2: Payroll permissions for CEO (all) ★★★
    "PAYROLL_READ", "PAYROLL_CREATE", "PAYROLL_UPDATE", "PAYROLL_DELETE",
    "PAYROLL_APPROVE", "PAYROLL_POST",
    "PAYROLL_ADVANCE_READ", "PAYROLL_ADVANCE_CREATE", "PAYROLL_ADVANCE_APPROVE",
    "PAYROLL_COMMISSION_READ", "PAYROLL_COMMISSION_CREATE", "PAYROLL_COMMISSION_APPROVE",
    "PAYROLL_REIMBURSEMENT_READ", "PAYROLL_REIMBURSEMENT_CREATE", "PAYROLL_REIMBURSEMENT_APPROVE",
    "SUBSCRIPTION_READ", "SUBSCRIPTION_CREATE", "SUBSCRIPTION_UPDATE", "SUBSCRIPTION_DELETE",
     'CONTRACTOR_READ', 'CONTRACTOR_CREATE', 'CONTRACTOR_UPDATE', 'CONTRACTOR_DELETE',
       'COMMISSION_READ', 'COMMISSION_CREATE', 'COMMISSION_UPDATE', 'COMMISSION_DELETE', 'COMMISSION_APPROVE',
  ],
  CFO: [
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
    "APPROVE_BUDGET",
    // Fixed Assets
    "FIXED_ASSET_READ", "FIXED_ASSET_CREATE", "FIXED_ASSET_UPDATE",
    "FIXED_ASSET_CAPITALIZE", "FIXED_ASSET_DISPOSE",
    "FIXED_ASSET_DEPR_READ", "FIXED_ASSET_DEPR_GENERATE", "FIXED_ASSET_DEPR_POST",
    "FIXED_ASSET_VERIFY_READ", "FIXED_ASSET_VERIFY_CREATE", "FIXED_ASSET_VERIFY_UPDATE",
    "FIXED_ASSET_CATEGORY_READ", "FIXED_ASSET_CATEGORY_CREATE", "FIXED_ASSET_CATEGORY_UPDATE",
    // ★★★ FIX #2: Payroll permissions for CFO ★★★
    "PAYROLL_READ", "PAYROLL_CREATE", "PAYROLL_UPDATE",
    "PAYROLL_APPROVE", "PAYROLL_POST",
    "PAYROLL_ADVANCE_READ", "PAYROLL_ADVANCE_CREATE", "PAYROLL_ADVANCE_APPROVE",
    "PAYROLL_COMMISSION_READ", "PAYROLL_COMMISSION_CREATE", "PAYROLL_COMMISSION_APPROVE",
    "PAYROLL_REIMBURSEMENT_READ", "PAYROLL_REIMBURSEMENT_CREATE", "PAYROLL_REIMBURSEMENT_APPROVE",
    "SUBSCRIPTION_READ", "SUBSCRIPTION_CREATE", "SUBSCRIPTION_UPDATE",
     'CONTRACTOR_READ', 'CONTRACTOR_CREATE', 'CONTRACTOR_UPDATE', 
       'COMMISSION_READ', 'COMMISSION_CREATE', 'COMMISSION_UPDATE', 'COMMISSION_APPROVE',
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
    "APPROVE_BUDGET",
    "FIXED_ASSET_READ", "FIXED_ASSET_CREATE", "FIXED_ASSET_UPDATE",
    "FIXED_ASSET_CAPITALIZE", "FIXED_ASSET_DISPOSE",
    "FIXED_ASSET_DEPR_READ", "FIXED_ASSET_DEPR_GENERATE", "FIXED_ASSET_DEPR_POST",
    "FIXED_ASSET_VERIFY_READ", "FIXED_ASSET_VERIFY_CREATE", "FIXED_ASSET_VERIFY_UPDATE",
    "FIXED_ASSET_CATEGORY_READ", "FIXED_ASSET_CATEGORY_CREATE", "FIXED_ASSET_CATEGORY_UPDATE",
    // ★★★ FIX #2: Payroll permissions for FINANCE_HEAD ★★★
    "PAYROLL_READ", "PAYROLL_CREATE", "PAYROLL_UPDATE",
    "PAYROLL_APPROVE", "PAYROLL_POST",
    "PAYROLL_ADVANCE_READ", "PAYROLL_ADVANCE_CREATE", "PAYROLL_ADVANCE_APPROVE",
    "PAYROLL_COMMISSION_READ", "PAYROLL_COMMISSION_CREATE", "PAYROLL_COMMISSION_APPROVE",
    "PAYROLL_REIMBURSEMENT_READ", "PAYROLL_REIMBURSEMENT_CREATE", "PAYROLL_REIMBURSEMENT_APPROVE",
    "SUBSCRIPTION_READ", "SUBSCRIPTION_CREATE", "SUBSCRIPTION_UPDATE",
    'CONTRACTOR_READ', 'CONTRACTOR_CREATE', 'CONTRACTOR_UPDATE', 
    'COMMISSION_READ', 'COMMISSION_CREATE', 'COMMISSION_UPDATE', 'COMMISSION_APPROVE',
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
    // Fixed Assets
    "FIXED_ASSET_READ", "FIXED_ASSET_CREATE", "FIXED_ASSET_UPDATE",
    "FIXED_ASSET_DEPR_READ", "FIXED_ASSET_DEPR_GENERATE",
    "FIXED_ASSET_VERIFY_READ", "FIXED_ASSET_CATEGORY_READ",
    // ★★★ FIX #2: Payroll permissions for ACCOUNTANT ★★★
    "PAYROLL_READ", "PAYROLL_CREATE", "PAYROLL_UPDATE",
    "PAYROLL_ADVANCE_READ", "PAYROLL_ADVANCE_CREATE",
    "PAYROLL_COMMISSION_READ", "PAYROLL_COMMISSION_CREATE",
    "PAYROLL_REIMBURSEMENT_READ", "PAYROLL_REIMBURSEMENT_CREATE",
    "SUBSCRIPTION_READ", "SUBSCRIPTION_CREATE", "SUBSCRIPTION_UPDATE",
    'CONTRACTOR_READ', 'CONTRACTOR_CREATE', 'CONTRACTOR_UPDATE', 
    'COMMISSION_READ', 'COMMISSION_CREATE', 'COMMISSION_UPDATE', 
  ],
  PROJECT_MANAGER: [
    "INCOME_READ",
    "EXPENSE_READ", "EXPENSE_CREATE",
    "INVOICE_READ",
    "PROJECT_READ", "PROJECT_UPDATE",
    "REPORT_READ",
    "SUBSCRIPTION_READ",
    'CONTRACTOR_READ', 
    'COMMISSION_READ',
  ],
  TECHNICAL_ADMIN: [
    "SETTINGS_READ",
    "ADMIN_AUDIT",
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
            assignedRole = activeRole.role || activeRole.role_name || null;
            roleId = activeRole.role_id || null;
          }
        }
      } catch (e) {
        console.warn("[PermCtx] RPC get_my_user_roles exception:", e);
      }

      // ========== METHOD 2: View v_user_roles ==========
      if (!assignedRole) {
        try {
          const { data: viewData, error: viewError } = await supabase
            .schema("core")
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
            assignedRole = (viewData as any).role || (viewData as any).role_name || null;
            roleId = viewData.role_id;
          }
        } catch (e) {
          console.warn("[PermCtx] v_user_roles query exception:", e);
        }
      }

      // ========== METHOD 3: profiles.role fallback ==========
      if (!assignedRole) {
        try {
          let { data: pData } = await supabase
            .from("profiles")
            .select("role")
            .eq("user_id", user.id)
            .maybeSingle();

          if (!pData) {
            const result = await supabase
              .from("profiles")
              .select("role")
              .eq("id", user.id)
              .maybeSingle();
            pData = result.data;
          }

          let profileRole = pData?.role;
          if (profileRole === "Admin") profileRole = "CEO";
          else if (profileRole === "Program Manager") profileRole = "ACCOUNTANT";

          if (profileRole) {
            assignedRole = profileRole;
          const { data: roleMatch } = await supabase
              .schema("core")
              .from("v_roles")
              .select("id")
              .eq("name", assignedRole)
              .maybeSingle();
            roleId = roleMatch?.id ?? null;
          }
        } catch (e) {
          console.warn("[PermCtx] Profile fallback exception:", e);
        }
      }

      if (!assignedRole) {
        assignedRole = "VIEWER";
      }

      // ========== CEO uniqueness check ==========
      if (assignedRole === "CEO") {
        try {
          const { count, error: ceoErr } = await supabase
            .schema("core")
            .from("v_user_roles")
            .select("*", { count: "exact", head: true })
            .eq("is_active", true)
            .neq("user_id", user.id);

          if (!ceoErr && count && count > 0) {
            const { data: otherCEOs } = await supabase
              .schema("core")
              .from("v_user_roles")
              .select("role, role_name, user_id")
              .eq("is_active", true)
              .neq("user_id", user.id);

            const isReallyCEO = (otherCEOs || []).some(
              (r: any) => r.role === "CEO" || r.role_name === "CEO"
            );

            if (isReallyCEO) {
              assignedRole = "FINANCE_HEAD";
              const { data: fhRole } = await supabase
                .schema("core")
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

      if (roleId) {
        try {
          const { data: rpcPerms, error: rpcPermError } = await supabase.rpc("get_my_permissions");
          if (!rpcPermError && rpcPerms) {
            if (!Array.isArray(rpcPerms) && typeof rpcPerms === 'object') {
              dbPermissions = Object.keys(rpcPerms)
                .filter((key: string) =>
                  VALID_PERM_CODES.includes(key as PermCode) && rpcPerms[key] === true
                ) as PermCode[];
            } else if (Array.isArray(rpcPerms) && rpcPerms.length > 0) {
              dbPermissions = rpcPerms
                .map((p: any) => p.permission_code || p.perm_code || p.code)
                .filter((code: any): code is PermCode =>
                  code && VALID_PERM_CODES.includes(code)
                );
            }
          }
        } catch (e) {
          console.warn("[PermCtx] RPC get_my_permissions exception:", e);
        }
      }

      if (dbPermissions.length === 0 && roleId) {
        try {
          const { data: permData, error: permError } = await supabase
            .schema("core")
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

      // FIXED: Store resolved role (not raw) so downstream sees correct role
      setRole(resolvedRole);
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
