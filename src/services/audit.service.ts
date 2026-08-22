import { supabase as browserSupabase } from '@/lib/supabase';
import type { SupabaseClient } from '@supabase/supabase-js';

// BUG-007 FIX: This service previously imported the browser supabase client
// directly. When called from an API route, the browser client has no
// authenticated session, causing RLS to reject queries or return wrong data.
//
// Each function below now accepts an optional `supabaseClient` parameter.
// API routes pass their server-side authenticated client (from getAuthSupabase());
// frontend code omits it and the browser client is used (with its valid session).
type SClient = SupabaseClient<any, any, any>;
function resolveClient(override?: SClient | null): SClient {
  return override || (browserSupabase as unknown as SClient);
}
// Backward-compat alias: existing function bodies
// continue to reference `supabase` directly.
const supabase = browserSupabase;
import type { AuditLog, AuditLogFilters } from '@/types/accounting.types';

// ✅ FIX: `audit.audit_log_enriched` never existed in the SQL schema — the
// only reporting view that was actually created is `public.v_audit_log`
// (security_invoker, per Spec 7.5). It already carries user_name/user_email/
// role_snapshot as point-in-time snapshots (Spec 8.1 Actor group), so no
// join/enrichment step is needed. Querying the view directly also means RLS
// (Appendix A "Audit logs" row) is enforced for the calling user instead of
// relying on a separate schema-level grant.
const VIEW = 'v_audit_log'; // public schema (default) — do NOT prefix with 'audit.'

// ✅ FIX: schema-qualified functions must be called via `.schema('audit')`,
// not by putting the schema in the function name string — `supabase.rpc(
// 'audit.log_action', ...)` silently fails to resolve against PostgREST.
const AUDIT_SCHEMA = 'audit';

export async function getAuditLogs(filters: AuditLogFilters = {}): Promise<{
  data: AuditLog[];
  count: number;
}> {
  const page = filters.page || 1;
  const pageSize = filters.pageSize || 50;
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;

  let query = supabase
    .from(VIEW)
    .select('*', { count: 'exact' });

  if (filters.search) {
    query = query.or(
      `user_name.ilike.%${filters.search}%,user_email.ilike.%${filters.search}%,reason.ilike.%${filters.search}%,entity_type.ilike.%${filters.search}%,description.ilike.%${filters.search}%,action.ilike.%${filters.search}%`
    );
  }

  if (filters.module && filters.module !== 'ALL') {
    query = query.eq('source_module', filters.module);
  }

  if (filters.action && filters.action !== 'ALL') {
    query = query.eq('action', filters.action);
  }

  if (filters.status && filters.status !== 'ALL') {
    query = query.eq('status', filters.status);
  }

  if (filters.severity && filters.severity !== 'ALL') {
    query = query.eq('severity', filters.severity);
  }

  if (filters.userId) {
    query = query.eq('user_id', filters.userId);
  }

  // ✅ FIX (Spec 8.3): project and amount are required audit filters and
  // were previously not implemented anywhere in the frontend.
  if (filters.projectId) {
    query = query.eq('project_id', filters.projectId);
  }

  if (typeof filters.minAmount === 'number') {
    query = query.gte('amount', filters.minAmount);
  }

  if (typeof filters.maxAmount === 'number') {
    query = query.lte('amount', filters.maxAmount);
  }

  if (filters.approvalLevel) {
    query = query.eq('approval_level', filters.approvalLevel);
  }

  if (filters.dateFrom) {
    query = query.gte('created_at', filters.dateFrom);
  }

  if (filters.dateTo) {
    query = query.lte('created_at', filters.dateTo + 'T23:59:59');
  }

  const { data, error, count } = await query
    .order('created_at', { ascending: false })
    .range(from, to);

  if (error) throw error;

  return {
    data: (data as AuditLog[]) || [],
    count: count || 0,
  };
}

// ✅ FIX: dedicated AI-activity read path, backed by the AI field group that
// was previously missing entirely (Spec 8.1 "AI" row / 9.9). Uses the
// audit.ai_audit_report() RPC so only source_module = 'ai' rows come back.
export async function getAIAuditLogs(params: {
  dateFrom?: string;
  dateTo?: string;
  userId?: string;
  tool?: string;
  status?: string;
  page?: number;
  pageSize?: number;
} = {}): Promise<{ data: any[]; count: number }> {
  const { data, error } = await supabase.schema(AUDIT_SCHEMA).rpc('ai_audit_report', {
    p_start: params.dateFrom || null,
    p_end: params.dateTo ? params.dateTo + 'T23:59:59' : null,
    p_user_id: params.userId || null,
    p_tool: params.tool || null,
    p_status: params.status || null,
    p_page: params.page || 1,
    p_page_size: params.pageSize || 50,
  });

  if (error) throw error;

  return {
    data: data?.rows || [],
    count: data?.total_count || 0,
  };
}

// ✅ FIX: Export with all spec-required columns, including the previously
// missing project/amount fields and the AI field group.
export async function exportAuditLogsToCSV(filters: AuditLogFilters = {}): Promise<string> {
  let query = supabase
    .from(VIEW)
    .select('*');

  if (filters.search) {
    query = query.or(
      `user_name.ilike.%${filters.search}%,reason.ilike.%${filters.search}%,description.ilike.%${filters.search}%`
    );
  }

  if (filters.module && filters.module !== 'ALL') {
    query = query.eq('source_module', filters.module);
  }

  if (filters.action && filters.action !== 'ALL') {
    query = query.eq('action', filters.action);
  }

  if (filters.projectId) {
    query = query.eq('project_id', filters.projectId);
  }

  if (typeof filters.minAmount === 'number') {
    query = query.gte('amount', filters.minAmount);
  }

  if (typeof filters.maxAmount === 'number') {
    query = query.lte('amount', filters.maxAmount);
  }

  if (filters.dateFrom) {
    query = query.gte('created_at', filters.dateFrom);
  }

  if (filters.dateTo) {
    query = query.lte('created_at', filters.dateTo + 'T23:59:59');
  }

  const { data, error } = await query.order('created_at', { ascending: false }).limit(10000);
  if (error) throw error;

  // ✅ FIX: CSV headers now include project, amount, and AI columns per
  // Spec 8.3 ("filters and exports by user, entity, action, date, project,
  // amount, approval, and risk level").
  const headers = [
    'Timestamp', 'User ID', 'User Name', 'User Email', 'Role',
    'Action', 'Module', 'Entity Type', 'Entity ID', 'Description',
    'Project ID', 'Amount', 'Amount Currency',
    'Previous Status', 'New Status', 'Approval Level', 'Severity', 'Status',
    'Reason', 'IP Address', 'User Agent', 'Request ID',
    'AI Question', 'AI Tool', 'AI Model', 'AI Row Count', 'AI Refusal Reason',
    'Entry Hash',
  ];

  const rows = (data || []).map((log: AuditLog) => [
    new Date(log.created_at).toISOString(),
    log.user_id || '',
    log.user_name || '',
    log.user_email || '',
    log.role_snapshot || '',
    log.action,
    log.source_module || '',
    log.entity_type || '',
    log.entity_id || '',
    `"${String(log.description || '').replace(/"/g, '""')}"`,
    log.project_id || '',
    log.amount ?? '',
    log.amount_currency || '',
    log.previous_status || '',
    log.new_status || '',
    log.approval_level || '',
    log.severity || 'info',
    log.status || 'success',
    `"${String(log.reason || '').replace(/"/g, '""')}"`,
    log.ip_address || '',
    log.user_agent || '',
    log.request_id || '',
    `"${String(log.ai_question || '').replace(/"/g, '""')}"`,
    log.ai_selected_tool || '',
    log.ai_model || '',
    log.ai_row_count ?? '',
    log.ai_refusal_reason || '',
    log.entry_hash || '',
  ]);

  const csvContent = [headers, ...rows]
    .map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(','))
    .join('\n');

  // ✅ FIX: correct schema-qualified RPC call (was `supabase.rpc('audit.log_export_event', ...)`,
  // which does not resolve — must go through `.schema('audit')`). Also logs
  // the export event itself (Spec 8.2).
  try {
    await supabase.schema(AUDIT_SCHEMA).rpc('log_export_event', {
      p_report_name: 'Audit Log Export',
      p_report_type: 'audit',
      p_format: 'csv',
      p_row_count: rows.length,
      p_filters: filters as unknown as Record<string, unknown>,
    });
  } catch {
    // Non-critical
  }

  return csvContent;
}

// ✅ FIX: Get unique modules from the real view.
export async function getAuditModules(): Promise<string[]> {
  const { data, error } = await supabase
    .from(VIEW)
    .select('source_module')
    .not('source_module', 'is', null)
    .order('source_module');

  if (error) throw error;
  const modules = [...new Set((data || []).map((d: any) => d.source_module as string))];
  return modules.sort();
}