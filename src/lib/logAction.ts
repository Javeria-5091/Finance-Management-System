// src/lib/logAction.ts
// ✅ COMPLETE REWRITE: Unified audit logging per Spec v1.3 Section 8
import { supabase } from "./supabase";

// ═══════════════════════════════════════════════════════════════
// Types matching Spec 8.1 required fields
// ═══════════════════════════════════════════════════════════════
export interface LogActionParams {
  action: string;
  entityType?: string;
  entityId?: string;
  description?: string;
  oldValues?: Record<string, any> | null;
  newValues?: Record<string, any> | null;
  status?: "success" | "denied" | "error";
  severity?: "info" | "low" | "medium" | "high" | "critical";
  errorMessage?: string | null;
  reason?: string;
  sourceModule?: string;
  requestId?: string;
  previousStatus?: string;
  newStatus?: string;
  // Auto-filled if not provided
  approvalLevel?: string;
  userId?: string | null;
  userEmail?: string | null;
  userName?: string | null;
}

export async function logAction({
  action,
  entityType,
  entityId,
  description = "",
  oldValues = null,
  newValues = null,
  status = "success",
  severity = "info",
  errorMessage = null,
  reason,
  sourceModule,
  requestId,
  previousStatus,
  newStatus,
  approvalLevel,
  userId,
  userEmail,
  userName,
}: LogActionParams): Promise<void> {
  try {
    let finalUserId: string | null = userId ?? null;
    let finalUserEmail: string | null = userEmail ?? null;
    let finalUserName: string | null = userName ?? null;

    // Auto-detect user if not provided
    if (!finalUserId || !finalUserEmail) {
      try {
        const { data: { user } } = await supabase.auth.getUser();
        if (user) {
          finalUserId = user.id;
          finalUserEmail = user.email ?? null;
        }
      } catch {
        // Server-side or no auth context — continue without user
      }
    }

    if (!finalUserName && finalUserId) {
      try {
        const { data: profile } = await supabase
          .from("profiles")
          .select("full_name")
          .eq("user_id", finalUserId)
          .single();
        finalUserName = profile?.full_name ?? null;
      } catch {
        // Non-critical — continue
      }
    }

    // ✅ Use RPC for server-side execution (gets real IP, role snapshot, hash)
    const { error } = await supabase.rpc("audit.log_action", {
      p_user_id: finalUserId,
      p_user_email: finalUserEmail,
      p_user_name: finalUserName,
      p_action: action,
      p_entity_type: entityType || null,
      p_entity_id: entityId || null,
      p_description: description,
      p_old_values: oldValues,
      p_new_values: newValues,
      p_status: status,
      p_error_message: errorMessage,
      p_severity: severity,
      p_reason: reason || null,
      p_source_module: sourceModule || null,
      p_request_id: requestId || null,
      p_previous_status: previousStatus || null,
      p_new_status: newStatus || null,
      p_approval_level: approvalLevel || null,
    });

    if (error) {
      console.error("Failed to log action via RPC, falling back to direct insert:", error);
      // Fallback: direct insert to v_audit_log
      await supabase.from("v_audit_log").insert({
        user_id: finalUserId,
        user_email: finalUserEmail,
        user_name: finalUserName,
        action,
        entity_type: entityType,
        entity_id: entityId,
        description,
        old_values: oldValues,
        new_values: newValues,
        status,
        severity,
        reason,
        source_module: sourceModule,
        request_id: requestId,
        previous_status: previousStatus,
        new_status: newStatus,
      });
    }
  } catch (err) {
    console.error("Log action error:", err);
  }
}

// ═══════════════════════════════════════════════════════════════
// Security event logging (Spec 8.2)
// ═══════════════════════════════════════════════════════════════
export async function logSecurityEvent(params: {
  eventType: string;
  success?: boolean;
  details?: Record<string, any>;
  userId?: string | null;
  userEmail?: string | null;
}): Promise<void> {
  try {
    let finalUserId = params.userId ?? null;
    let finalUserEmail = params.userEmail ?? null;

    if (!finalUserId) {
      try {
        const { data: { user } } = await supabase.auth.getUser();
        if (user) {
          finalUserId = user.id;
          finalUserEmail = user.email ?? null;
        }
      } catch { /* continue */ }
    }

    await supabase.rpc("audit.log_security_event", {
      p_user_id: finalUserId,
      p_user_email: finalUserEmail,
      p_event_type: params.eventType,
      p_success: params.success ?? true,
      p_details: params.details || null,
    });
  } catch (err) {
    console.error("Security event log error:", err);
  }
}

// ═══════════════════════════════════════════════════════════════
// Export event logging (Spec 8.2)
// ═══════════════════════════════════════════════════════════════
export async function logExportEvent(params: {
  reportName: string;
  reportType?: string;
  format?: string;
  filters?: Record<string, any>;
  rowCount?: number;
  fileSizeBytes?: number;
}): Promise<void> {
  try {
    let finalUserId: string | null = null;
    let finalUserEmail: string | null = null;
    let finalUserName: string | null = null;

    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (user) {
        finalUserId = user.id;
        finalUserEmail = user.email ?? null;
      }
    } catch { /* continue */ }

    if (finalUserId) {
      const { data: profile } = await supabase
        .from("profiles")
        .select("full_name")
        .eq("user_id", finalUserId)
        .single();
      finalUserName = profile?.full_name ?? null;
    }

    await supabase.rpc("audit.log_export_event", {
      p_user_id: finalUserId,
      p_user_email: finalUserEmail,
      p_user_name: finalUserName,
      p_report_name: params.reportName,
      p_report_type: params.reportType || null,
      p_format: params.format || "csv",
      p_filters: params.filters || null,
      p_row_count: params.rowCount || null,
      p_file_size_bytes: params.fileSizeBytes || null,
    });
  } catch (err) {
    console.error("Export event log error:", err);
  }
}

// ═══════════════════════════════════════════════════════════════
// Convenience functions — consistent object-parameter interface
// ═══════════════════════════════════════════════════════════════
export const logAudit = {
  create: (entityType: string, entityId: string, description: string, newValues?: any) =>
    logAction({ action: "CREATE", entityType, entityId, description, newValues }),

  update: (entityType: string, entityId: string, description: string, oldValues?: any, newValues?: any, reason?: string) =>
    logAction({ action: "UPDATE", entityType, entityId, description, oldValues, newValues, reason }),

  delete: (entityType: string, entityId: string, description: string, oldValues?: any) =>
    logAction({ action: "DELETE", entityType, entityId, description, oldValues, severity: "high" }),

  approve: (entityType: string, entityId: string, description: string, approvalLevel?: string) =>
    logAction({ action: "APPROVE", entityType, entityId, description, approvalLevel, severity: "medium" }),

  reject: (entityType: string, entityId: string, description: string, reason?: string) =>
    logAction({ action: "REJECT", entityType, entityId, description: description + (reason ? ` - Reason: ${reason}` : ""), reason, severity: "medium" }),

  post: (entityType: string, entityId: string, description: string) =>
    logAction({ action: "POST", entityType, entityId, description, severity: "high" }),

  reverse: (entityType: string, entityId: string, description: string, reason?: string) =>
    logAction({ action: "REVERSE", entityType, entityId, description, reason, severity: "critical" }),

  login: () => {
    logSecurityEvent({ eventType: "LOGIN_SUCCESS" });
    logAction({ action: "LOGIN", entityType: "session", description: "User logged in", sourceModule: "auth" });
  },

  logout: () => {
    logSecurityEvent({ eventType: "SESSION_TERMINATED" });
    logAction({ action: "LOGOUT", entityType: "session", description: "User logged out", sourceModule: "auth" });
  },

  loginFailed: (email?: string) =>
    logSecurityEvent({ eventType: "LOGIN_FAILURE", success: false, details: { attempted_email: email } }),

  view: (entityType: string, entityId: string, description: string) =>
    logAction({ action: "VIEW", entityType, entityId, description, severity: "info" }),

  export: (entityType: string, description: string, reportName?: string, rowCount?: number) =>
    logExportEvent({ reportName: reportName || entityType, reportType: entityType, rowCount }),

  accessDenied: (entityType: string, description: string) =>
    logAction({
      action: "ACCESS_DENIED", entityType, description,
      status: "denied", severity: "medium", errorMessage: "Permission denied"
    }),

  error: (entityType: string, description: string, errorMessage: string) =>
    logAction({ action: "ERROR", entityType, description, status: "error", severity: "high", errorMessage }),

  periodClose: (periodId: string, reason: string) =>
    logAction({ action: "PERIOD_CLOSE", entityType: "accounting_period", entityId: periodId, description: `Period closed: ${reason}`, reason, severity: "high", sourceModule: "finance" }),

  periodReopen: (periodId: string, reason: string) =>
    logAction({ action: "PERIOD_REOPEN", entityType: "accounting_period", entityId: periodId, description: `Period reopened: ${reason}`, reason, severity: "critical", sourceModule: "finance" }),

  configChange: (entityType: string, entityId: string, description: string, oldValues?: any, newValues?: any) =>
    logAction({ action: "CONFIG_CHANGE", entityType, entityId, description, oldValues, newValues, severity: "medium", sourceModule: "admin" }),

  workflowAction: (module: string, entityId: string, action: string, fromStatus: string, toStatus: string, amount?: number, reason?: string) =>
    logAction({
      action: `WORKFLOW_${action.toUpperCase()}`,
      entityType: module,
      entityId,
      description: `${module} ${action}: ${fromStatus} → ${toStatus}${amount ? ` (Amount: ${amount})` : ""}`,
      previousStatus: fromStatus,
      newStatus: toStatus,
      reason,
      sourceModule: module,
      severity: action === "approve" ? "medium" : "info",
    }),
};