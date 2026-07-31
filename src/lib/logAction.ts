// src/lib/logAction.ts
import { supabase } from "./supabase";

interface LogActionParams {
  action: string;
  entityType: string;
  entityId?: string;
  description: string;
  oldValues?: Record<string, any> | null;
  newValues?: Record<string, any> | null;
  status?: "success" | "denied" | "error";
  errorMessage?: string | null;
  userId?: string | null;
  userEmail?: string | null;
  userName?: string | null;
}

export async function logAction({
  action,
  entityType,
  entityId,
  description,
  oldValues = null,
  newValues = null,
  status = "success",
  errorMessage = null,
  userId,
  userEmail,
  userName,
}: LogActionParams): Promise<void> {
  try {
    let finalUserId: string | null = userId ?? null;
    let finalUserEmail: string | null = userEmail ?? null;
    let finalUserName: string | null = userName ?? null;

    if (!finalUserId || !finalUserEmail) {
      const { data: { user } } = await supabase.auth.getUser();
      if (user) {
        finalUserId = user.id;
        finalUserEmail = user.email ?? null;
      }
    }

    if (!finalUserName && finalUserId) {
      const { data: profile } = await supabase
        .from("profiles")
        .select("full_name")
        .eq("id", finalUserId)
        .single();
      finalUserName = profile?.full_name ?? null;
    }

    let ipAddress: string | null = null;
    let userAgent: string | null = null;
    if (typeof window !== "undefined") {
      userAgent = navigator.userAgent ?? null;
    }

    const insertData: Record<string, unknown> = {
      user_id: finalUserId,
      user_email: finalUserEmail,
      user_name: finalUserName,
      action,
      entity_type: entityType,
      description,
      old_values: oldValues,
      new_values: newValues,
      ip_address: ipAddress,
      user_agent: userAgent,
      status,
      error_message: errorMessage,
    };

    if (entityId) {
      insertData.entity_id = entityId;
    }

    // ✅ FIX: Use audit schema table via the public view
    // The view v_audit_log maps to audit.audit_log
    const { error } = await supabase
      .from("v_audit_log")
      .insert(insertData);

    if (error) {
      console.error("Failed to log action:", error);
    }
  } catch (err) {
    console.error("Log action error:", err);
  }
}

// Convenience functions
export const logAudit = {
  create: (entityType: string, entityId: string, description: string, newValues?: any) =>
    logAction({ action: "CREATE", entityType, entityId, description, newValues }),

  update: (entityType: string, entityId: string, description: string, oldValues?: any, newValues?: any) =>
    logAction({ action: "UPDATE", entityType, entityId, description, oldValues, newValues }),

  delete: (entityType: string, entityId: string, description: string, oldValues?: any) =>
    logAction({ action: "DELETE", entityType, entityId, description, oldValues }),

  approve: (entityType: string, entityId: string, description: string) =>
    logAction({ action: "APPROVE", entityType, entityId, description }),

  reject: (entityType: string, entityId: string, description: string, reason?: string) =>
    logAction({ 
      action: "REJECT", 
      entityType, 
      entityId, 
      description: description + (reason ? ` - Reason: ${reason}` : "") 
    }),

  login: () =>
    logAction({ action: "LOGIN", entityType: "session", description: "User logged in" }),

  logout: () =>
    logAction({ action: "LOGOUT", entityType: "session", description: "User logged out" }),

  view: (entityType: string, entityId: string, description: string) =>
    logAction({ action: "VIEW", entityType, entityId, description }),

  export: (entityType: string, description: string) =>
    logAction({ action: "EXPORT", entityType, description }),

  accessDenied: (entityType: string, description: string) =>
    logAction({ 
      action: "ACCESS_DENIED", 
      entityType, 
      description, 
      status: "denied", 
      errorMessage: "Permission denied" 
    }),

  error: (entityType: string, description: string, errorMessage: string) =>
    logAction({ action: "ERROR", entityType, description, status: "error", errorMessage }),
};