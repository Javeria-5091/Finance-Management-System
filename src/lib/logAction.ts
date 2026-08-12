// src/lib/logAction.ts
// ✅ REVISED: Unified audit logging per Spec v1.3 Section 8, aligned with
// 01_audit_schema_v1_3_spec.sql (project/amount filters + AI field group).
import { supabase } from "./supabase";

// ✅ FIX: schema-qualified Postgres functions must be invoked through
// `.schema('audit').rpc('fn_name', ...)`. Passing 'audit.fn_name' as the
// rpc() name string (as the previous version did) does not resolve through
// PostgREST and every call was silently failing.
const AUDIT_SCHEMA = "audit";

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
  approvalLevel?: string;
  approvalComments?: string;
  delegatedAuthority?: string;
  limitDecision?: string;
  // ✅ FIX (Spec 8.3): project + amount are required audit filter
  // dimensions and were previously not captured at the point of action.
  projectId?: string | null;
  amount?: number | null;
  amountCurrency?: string | null;
  relatedJournalId?: string | null;
  relatedPaymentId?: string | null;
  attachmentIds?: string[] | null;
  // Auto-filled if not provided
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
  approvalComments,
  delegatedAuthority,
  limitDecision,
  projectId = null,
  amount = null,
  amountCurrency = null,
  relatedJournalId = null,
  relatedPaymentId = null,
  attachmentIds = null,
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

    const { error } = await supabase.schema(AUDIT_SCHEMA).rpc("log_action", {
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
      p_approval_comments: approvalComments || null,
      p_delegated_authority: delegatedAuthority || null,
      p_limit_decision: limitDecision || null,
      p_project_id: projectId || null,
      p_amount: amount ?? null,
      p_amount_currency: amountCurrency || null,
      p_related_journal_id: relatedJournalId || null,
      p_related_payment_id: relatedPaymentId || null,
      p_attachment_ids: attachmentIds || null,
    });

    if (error) {
      // Only log if it's a real error (not missing function during dev)
      const msg = error?.message || '';
      const code = (error as any)?.code || '';
      const isEmpty = !msg && !code; // Empty error object = RPC likely doesn't exist yet
      const isMissingFunction =
        isEmpty ||
        msg.includes('Could not find the function') ||
        msg.includes('function does not exist') ||
        code === '42883' || // undefined_function
        code === '42P01'; // undefined_table

      if (!isMissingFunction) {
        console.error('Audit RPC error:', msg || error);
      }

      // Fallback: direct insert into audit.audit_log (bypasses RPC if missing)
      try {
        const fallbackErr = (await supabase.schema('audit').from('audit_log').insert({
          user_id: finalUserId,
          user_email: finalUserEmail,
          user_name: finalUserName,
          action,
          entity_type: entityType || null,
          entity_id: entityId || null,
          description,
          old_values: oldValues,
          new_values: newValues,
          status,
          severity,
          reason: reason || null,
          source_module: sourceModule || null,
          request_id: requestId || null,
          previous_status: previousStatus || null,
          new_status: newStatus || null,
          approval_level: approvalLevel || null,
          approval_comments: approvalComments || null,
          delegated_authority: delegatedAuthority || null,
          limit_decision: limitDecision || null,
          project_id: projectId || null,
          amount: amount ?? null,
          amount_currency: amountCurrency || null,
          related_journal_id: relatedJournalId || null,
          related_payment_id: relatedPaymentId || null,
          attachment_ids: attachmentIds || null,
        })).error;

        if (fallbackErr && !isMissingFunction) {
          // Both RPC and direct insert failed — only log if RPC wasn't simply missing
          console.error('Audit fallback insert error:', fallbackErr.message);
        }
      } catch {
        // Last resort — silent fail for non-critical audit logging
      }
    }
  } catch (err) {
    // Top-level catch for unexpected errors (network, etc.)
    // Audit is non-critical — never throw
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

    // ✅ FIX: schema-qualified rpc call
    const { error: secErr } = await supabase.schema(AUDIT_SCHEMA).rpc("log_security_event", {
      p_user_id: finalUserId,
      p_user_email: finalUserEmail,
      p_event_type: params.eventType,
      p_success: params.success ?? true,
      p_details: params.details || null,
    });

    if (secErr) {
      const msg = secErr?.message || '';
      const isMissing = msg.includes('Could not find the function') || msg.includes('function does not exist');
      if (!isMissing) console.error('Security event RPC error:', msg);
    }
  } catch (err) {
    // Non-critical — never throw
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

    // ✅ FIX: schema-qualified rpc call
    const { error: expErr } = await supabase.schema(AUDIT_SCHEMA).rpc("log_export_event", {
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

    if (expErr) {
      const msg = expErr?.message || '';
      const isMissing = msg.includes('Could not find the function') || msg.includes('function does not exist');
      if (!isMissing) console.error('Export event RPC error:', msg);
    }
  } catch (err) {
    // Non-critical — never throw
  }
}

// ═══════════════════════════════════════════════════════════════
// ✅ NEW: AI event logging — fills the Spec 8.1 "AI" field group and
// Spec 8.2 "AI question, generated query/tool, result access, document
// extraction, recommendation acceptance/rejection, and detected policy
// violation" requirement, which had no writer anywhere in the frontend.
// The AI gateway (Section 9.3) should call this after every question,
// tool call, or Text-to-SQL execution — success, refusal, or error alike.
// ═══════════════════════════════════════════════════════════════
export async function logAIEvent(params: {
  action?:
    | "AI_QUERY"
    | "AI_TOOL_CALL"
    | "AI_EXTRACTION"
    | "AI_SUGGESTION_ACCEPTED"
    | "AI_SUGGESTION_REJECTED"
    | "AI_POLICY_VIOLATION_DETECTED";
  status?: "success" | "denied" | "error";
  severity?: "info" | "low" | "medium" | "high" | "critical";
  entityType?: string;
  entityId?: string;
  projectId?: string | null;
  question?: string;
  normalizedIntent?: string;
  selectedTool?: string;
  generatedSql?: string;
  templateId?: string;
  rowCount?: number;
  model?: string;
  latencyMs?: number;
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  refusalReason?: string;
  requestId?: string;
  userId?: string | null;
  userEmail?: string | null;
}): Promise<void> {
  try {
    let finalUserId = params.userId ?? null;
    let finalUserEmail = params.userEmail ?? null;
    let finalUserName: string | null = null;

    if (!finalUserId) {
      try {
        const { data: { user } } = await supabase.auth.getUser();
        if (user) {
          finalUserId = user.id;
          finalUserEmail = user.email ?? null;
        }
      } catch { /* continue */ }
    }

    if (finalUserId) {
      try {
        const { data: profile } = await supabase
          .from("profiles")
          .select("full_name")
          .eq("user_id", finalUserId)
          .single();
        finalUserName = profile?.full_name ?? null;
      } catch { /* non-critical */ }
    }

    const { error: aiErr } = await supabase.schema(AUDIT_SCHEMA).rpc("log_ai_event", {
      p_user_id: finalUserId,
      p_user_email: finalUserEmail,
      p_user_name: finalUserName,
      p_action: params.action || "AI_QUERY",
      p_status: params.status || "success",
      p_severity: params.severity || "info",
      p_entity_type: params.entityType || null,
      p_entity_id: params.entityId || null,
      p_project_id: params.projectId || null,
      p_ai_question: params.question || null,
      p_ai_normalized_intent: params.normalizedIntent || null,
      p_ai_selected_tool: params.selectedTool || null,
      p_ai_generated_sql: params.generatedSql || null,
      p_ai_template_id: params.templateId || null,
      p_ai_row_count: params.rowCount ?? null,
      p_ai_model: params.model || null,
      p_ai_latency_ms: params.latencyMs ?? null,
      p_ai_cost_usd: params.costUsd ?? null,
      p_ai_input_tokens: params.inputTokens ?? null,
      p_ai_output_tokens: params.outputTokens ?? null,
      p_ai_refusal_reason: params.refusalReason || null,
      p_request_id: params.requestId || null,
    });

    if (aiErr) {
      const msg = aiErr?.message || '';
      const isMissing = msg.includes('Could not find the function') || msg.includes('function does not exist');
      if (!isMissing) console.error('AI event RPC error:', msg);
    }
  } catch (err) {
    // Non-critical — never throw
  }
}

// ═══════════════════════════════════════════════════════════════
// Convenience functions — consistent object-parameter interface
// ═══════════════════════════════════════════════════════════════
export const logAudit = {
  create: (
    entityType: string,
    entityId: string,
    description: string,
    newValues?: any,
    opts?: { projectId?: string; amount?: number; amountCurrency?: string }
  ) =>
    logAction({
      action: "CREATE", entityType, entityId, description, newValues,
      projectId: opts?.projectId, amount: opts?.amount, amountCurrency: opts?.amountCurrency,
    }),

  update: (
    entityType: string,
    entityId: string,
    description: string,
    oldValues?: any,
    newValues?: any,
    reason?: string,
    opts?: { projectId?: string; amount?: number; amountCurrency?: string }
  ) =>
    logAction({
      action: "UPDATE", entityType, entityId, description, oldValues, newValues, reason,
      projectId: opts?.projectId, amount: opts?.amount, amountCurrency: opts?.amountCurrency,
    }),

  delete: (entityType: string, entityId: string, description: string, oldValues?: any) =>
    logAction({ action: "DELETE", entityType, entityId, description, oldValues, severity: "high" }),

  approve: (
    entityType: string,
    entityId: string,
    description: string,
    approvalLevel?: string,
    opts?: { amount?: number; amountCurrency?: string; approvalComments?: string }
  ) =>
    logAction({
      action: "APPROVE", entityType, entityId, description, approvalLevel, severity: "medium",
      amount: opts?.amount, amountCurrency: opts?.amountCurrency, approvalComments: opts?.approvalComments,
    }),

  reject: (entityType: string, entityId: string, description: string, reason?: string) =>
    logAction({ action: "REJECT", entityType, entityId, description: description + (reason ? ` - Reason: ${reason}` : ""), reason, severity: "medium" }),

  post: (
    entityType: string,
    entityId: string,
    description: string,
    opts?: { relatedJournalId?: string; amount?: number; amountCurrency?: string }
  ) =>
    logAction({
      action: "POST", entityType, entityId, description, severity: "high",
      relatedJournalId: opts?.relatedJournalId, amount: opts?.amount, amountCurrency: opts?.amountCurrency,
    }),

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

  // ✅ FIX: `amount` was previously only interpolated into the description
  // string and never reached the structured `amount` column — the 8.3
  // amount filter could never actually find these events. Now passed
  // through as p_amount so it lands in audit.audit_log.amount.
  workflowAction: (
    module: string,
    entityId: string,
    action: string,
    fromStatus: string,
    toStatus: string,
    amount?: number,
    reason?: string,
    opts?: { projectId?: string; amountCurrency?: string; approvalLevel?: string }
  ) =>
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
      amount,
      projectId: opts?.projectId,
      amountCurrency: opts?.amountCurrency,
      approvalLevel: opts?.approvalLevel,
    }),

  // ✅ NEW: convenience wrappers around logAIEvent for the common cases
  // called out in Spec 8.2.
  aiQuery: (question: string, selectedTool: string, opts?: { rowCount?: number; model?: string; latencyMs?: number }) =>
    logAIEvent({ action: "AI_QUERY", question, selectedTool, ...opts }),

  aiRefused: (question: string, refusalReason: string) =>
    logAIEvent({ action: "AI_QUERY", status: "denied", severity: "medium", question, refusalReason }),

  aiSuggestionAccepted: (entityType: string, entityId: string, selectedTool: string) =>
    logAIEvent({ action: "AI_SUGGESTION_ACCEPTED", entityType, entityId, selectedTool }),

  aiSuggestionRejected: (entityType: string, entityId: string, selectedTool: string) =>
    logAIEvent({ action: "AI_SUGGESTION_REJECTED", entityType, entityId, selectedTool }),
};