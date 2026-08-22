// src/lib/logAction.ts
// ✅ REVISED: Unified audit logging per Spec v1.3 Section 8, aligned with
// 01_audit_schema_v1_3_spec.sql (project/amount filters + AI field group).
//
// BUG-005 FIX (CRITICAL): logAction previously imported the BROWSER supabase
// client from @/lib/supabase and called supabase.auth.getUser() to auto-detect
// the user. When called from an API route, the browser client has no session,
// getUser() returns null, and EVERY audit log row written from the API layer
// has user_id = null — losing actor identity for the entire API surface
// (Spec 8.1: "every action must be attributable to a user").
//
// FIX: every function now accepts an optional `supabaseClient` parameter.
//   - API routes pass their server-side authenticated supabase client
//     (returned from getAuthSupabase()), so the same request-scoped auth
//     context that performed the business action also writes the audit row.
//   - Frontend code (where browser supabase has a real session) continues
//     to call logAction() with no supabaseClient — backward compatible.
//   - When supabaseClient is provided, userId/userEmail/userName passed
//     explicitly by the caller ALWAYS take precedence over auto-detection
//     (caller is the authoritative source of identity in server context).
//
// Schema-qualified RPC calls (`audit.log_action` etc.) are invoked via
// `.schema('audit').rpc('fn_name', ...)` — passing 'audit.fn_name' as the
// rpc() name string does not resolve through PostgREST and silently fails.
import { supabase as browserSupabase } from "./supabase";
import type { SupabaseClient } from '@supabase/supabase-js';

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
  // ✅ BUG-005 FIX: server-side authenticated supabase client.
  // When passed by an API route, audit logging uses the request-scoped
  // auth context (correct user identity, correct RLS). When omitted, the
  // browser supabase client is used (correct for frontend callers).
  supabaseClient?: SupabaseClient<any, any, any> | null;
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
  supabaseClient = null,
}: LogActionParams): Promise<void> {
  // Use the server-side client when provided (API-route caller); otherwise
  // fall back to the browser client (frontend caller). This is the BUG-005
  // fix: the browser client has no authenticated session in server context,
  // so every audit row written from an API route previously had a NULL
  // user_id, breaking Spec 8.1 actor attribution.
  const supabase = supabaseClient || browserSupabase;

  try {
    let finalUserId: string | null = userId ?? null;
    let finalUserEmail: string | null = userEmail ?? null;
    let finalUserName: string | null = userName ?? null;

    // Auto-detect user if not provided. When the caller passes an explicit
    // userId (which every API route does — they already have it from
    // getAuthUser()), we skip this lookup entirely.
    if (!finalUserId || !finalUserEmail) {
      try {
        const { data: { user } } = await supabase.auth.getUser();
        if (user) {
          if (!finalUserId) finalUserId = user.id;
          if (!finalUserEmail) finalUserEmail = user.email ?? null;
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
  supabaseClient?: SupabaseClient<any, any, any> | null;
}): Promise<void> {
  const supabase = params.supabaseClient || browserSupabase;
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
  userId?: string | null;
  userEmail?: string | null;
  supabaseClient?: SupabaseClient<any, any, any> | null;
}): Promise<void> {
  const supabase = params.supabaseClient || browserSupabase;
  try {
    let finalUserId: string | null = params.userId ?? null;
    let finalUserEmail: string | null = params.userEmail ?? null;
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
// AI event logging — fills the Spec 8.1 "AI" field group and Spec 8.2
// "AI question, generated query/tool, result access, document extraction,
// recommendation acceptance/rejection, and detected policy violation"
// requirement, which had no writer anywhere in the frontend.
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
  supabaseClient?: SupabaseClient<any, any, any> | null;
}): Promise<void> {
  const supabase = params.supabaseClient || browserSupabase;
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
// Convenience functions — consistent object-parameter interface.
// Each accepts an optional `supabaseClient` so API routes can pass
// their server-side authenticated client through to the audit layer.
// ═══════════════════════════════════════════════════════════════
export const logAudit = {
  create: (
    entityType: string,
    entityId: string,
    description: string,
    newValues?: any,
    opts?: { projectId?: string; amount?: number; amountCurrency?: string; userId?: string | null; supabaseClient?: SupabaseClient<any, any, any> | null }
  ) =>
    logAction({
      action: "CREATE", entityType, entityId, description, newValues,
      projectId: opts?.projectId, amount: opts?.amount, amountCurrency: opts?.amountCurrency,
      userId: opts?.userId, supabaseClient: opts?.supabaseClient,
    }),

  update: (
    entityType: string,
    entityId: string,
    description: string,
    oldValues?: any,
    newValues?: any,
    reason?: string,
    opts?: { projectId?: string; amount?: number; amountCurrency?: string; userId?: string | null; supabaseClient?: SupabaseClient<any, any, any> | null }
  ) =>
    logAction({
      action: "UPDATE", entityType, entityId, description, oldValues, newValues, reason,
      projectId: opts?.projectId, amount: opts?.amount, amountCurrency: opts?.amountCurrency,
      userId: opts?.userId, supabaseClient: opts?.supabaseClient,
    }),

  delete: (entityType: string, entityId: string, description: string, oldValues?: any, opts?: { userId?: string | null; supabaseClient?: SupabaseClient<any, any, any> | null }) =>
    logAction({ action: "DELETE", entityType, entityId, description, oldValues, severity: "high", userId: opts?.userId, supabaseClient: opts?.supabaseClient }),

  approve: (
    entityType: string,
    entityId: string,
    description: string,
    approvalLevel?: string,
    opts?: { amount?: number; amountCurrency?: string; approvalComments?: string; userId?: string | null; supabaseClient?: SupabaseClient<any, any, any> | null }
  ) =>
    logAction({
      action: "APPROVE", entityType, entityId, description, approvalLevel, severity: "medium",
      amount: opts?.amount, amountCurrency: opts?.amountCurrency, approvalComments: opts?.approvalComments,
      userId: opts?.userId, supabaseClient: opts?.supabaseClient,
    }),

  reject: (entityType: string, entityId: string, description: string, reason?: string, opts?: { userId?: string | null; supabaseClient?: SupabaseClient<any, any, any> | null }) =>
    logAction({ action: "REJECT", entityType, entityId, description: description + (reason ? ` - Reason: ${reason}` : ""), reason, severity: "medium", userId: opts?.userId, supabaseClient: opts?.supabaseClient }),

  post: (
    entityType: string,
    entityId: string,
    description: string,
    opts?: { relatedJournalId?: string; amount?: number; amountCurrency?: string; userId?: string | null; supabaseClient?: SupabaseClient<any, any, any> | null }
  ) =>
    logAction({
      action: "POST", entityType, entityId, description, severity: "high",
      relatedJournalId: opts?.relatedJournalId, amount: opts?.amount, amountCurrency: opts?.amountCurrency,
      userId: opts?.userId, supabaseClient: opts?.supabaseClient,
    }),

  reverse: (entityType: string, entityId: string, description: string, reason?: string, opts?: { userId?: string | null; supabaseClient?: SupabaseClient<any, any, any> | null }) =>
    logAction({ action: "REVERSE", entityType, entityId, description, reason, severity: "critical", userId: opts?.userId, supabaseClient: opts?.supabaseClient }),

  login: (opts?: { supabaseClient?: SupabaseClient<any, any, any> | null }) => {
    logSecurityEvent({ eventType: "LOGIN_SUCCESS", supabaseClient: opts?.supabaseClient });
    logAction({ action: "LOGIN", entityType: "session", description: "User logged in", sourceModule: "auth", supabaseClient: opts?.supabaseClient });
  },

  logout: (opts?: { supabaseClient?: SupabaseClient<any, any, any> | null }) => {
    logSecurityEvent({ eventType: "SESSION_TERMINATED", supabaseClient: opts?.supabaseClient });
    logAction({ action: "LOGOUT", entityType: "session", description: "User logged out", sourceModule: "auth", supabaseClient: opts?.supabaseClient });
  },

  loginFailed: (email?: string, opts?: { supabaseClient?: SupabaseClient<any, any, any> | null }) =>
    logSecurityEvent({ eventType: "LOGIN_FAILURE", success: false, details: { attempted_email: email }, supabaseClient: opts?.supabaseClient }),

  view: (entityType: string, entityId: string, description: string, opts?: { userId?: string | null; supabaseClient?: SupabaseClient<any, any, any> | null }) =>
    logAction({ action: "VIEW", entityType, entityId, description, severity: "info", userId: opts?.userId, supabaseClient: opts?.supabaseClient }),

  export: (entityType: string, description: string, reportName?: string, rowCount?: number, opts?: { supabaseClient?: SupabaseClient<any, any, any> | null }) =>
    logExportEvent({ reportName: reportName || entityType, reportType: entityType, rowCount, supabaseClient: opts?.supabaseClient }),

  accessDenied: (entityType: string, description: string, opts?: { userId?: string | null; supabaseClient?: SupabaseClient<any, any, any> | null }) =>
    logAction({
      action: "ACCESS_DENIED", entityType, description,
      status: "denied", severity: "medium", errorMessage: "Permission denied",
      userId: opts?.userId, supabaseClient: opts?.supabaseClient,
    }),

  error: (entityType: string, description: string, errorMessage: string, opts?: { userId?: string | null; supabaseClient?: SupabaseClient<any, any, any> | null }) =>
    logAction({ action: "ERROR", entityType, description, status: "error", severity: "high", errorMessage, userId: opts?.userId, supabaseClient: opts?.supabaseClient }),

  periodClose: (periodId: string, reason: string, opts?: { userId?: string | null; supabaseClient?: SupabaseClient<any, any, any> | null }) =>
    logAction({ action: "PERIOD_CLOSE", entityType: "accounting_period", entityId: periodId, description: `Period closed: ${reason}`, reason, severity: "high", sourceModule: "finance", userId: opts?.userId, supabaseClient: opts?.supabaseClient }),

  periodReopen: (periodId: string, reason: string, opts?: { userId?: string | null; supabaseClient?: SupabaseClient<any, any, any> | null }) =>
    logAction({ action: "PERIOD_REOPEN", entityType: "accounting_period", entityId: periodId, description: `Period reopened: ${reason}`, reason, severity: "critical", sourceModule: "finance", userId: opts?.userId, supabaseClient: opts?.supabaseClient }),

  configChange: (entityType: string, entityId: string, description: string, oldValues?: any, newValues?: any, opts?: { userId?: string | null; supabaseClient?: SupabaseClient<any, any, any> | null }) =>
    logAction({ action: "CONFIG_CHANGE", entityType, entityId, description, oldValues, newValues, severity: "medium", sourceModule: "admin", userId: opts?.userId, supabaseClient: opts?.supabaseClient }),

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
    opts?: { projectId?: string; amountCurrency?: string; approvalLevel?: string; userId?: string | null; supabaseClient?: SupabaseClient<any, any, any> | null }
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
      userId: opts?.userId,
      supabaseClient: opts?.supabaseClient,
    }),

  // ✅ NEW: convenience wrappers around logAIEvent for the common cases
  // called out in Spec 8.2.
  aiQuery: (question: string, selectedTool: string, opts?: { rowCount?: number; model?: string; latencyMs?: number; userId?: string | null; supabaseClient?: SupabaseClient<any, any, any> | null }) =>
    logAIEvent({ action: "AI_QUERY", question, selectedTool, ...opts }),

  aiRefused: (question: string, refusalReason: string, opts?: { userId?: string | null; supabaseClient?: SupabaseClient<any, any, any> | null }) =>
    logAIEvent({ action: "AI_QUERY", status: "denied", severity: "medium", question, refusalReason, ...opts }),

  aiSuggestionAccepted: (entityType: string, entityId: string, selectedTool: string, opts?: { userId?: string | null; supabaseClient?: SupabaseClient<any, any, any> | null }) =>
    logAIEvent({ action: "AI_SUGGESTION_ACCEPTED", entityType, entityId, selectedTool, ...opts }),

  aiSuggestionRejected: (entityType: string, entityId: string, selectedTool: string, opts?: { userId?: string | null; supabaseClient?: SupabaseClient<any, any, any> | null }) =>
    logAIEvent({ action: "AI_SUGGESTION_REJECTED", entityType, entityId, selectedTool, ...opts }),
};
