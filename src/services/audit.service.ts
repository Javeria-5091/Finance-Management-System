import { supabase } from '@/lib/supabase';
import type { AuditLogFilters } from '@/types/accounting.types';

const SCHEMA = 'audit';

// ✅ FIX: Use audit_log_enriched view which NOW EXISTS after migration fix
// Returns enriched audit logs with user info joined
export async function getAuditLogs(filters: AuditLogFilters = {}): Promise<{
  data: any[];
  count: number;
}> {
  const page = filters.page || 1;
  const pageSize = filters.pageSize || 50;
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;

  let query = supabase
    .schema(SCHEMA)
    .from('audit_log_enriched')
    .select('*', { count: 'exact' });

  if (filters.search) {
    query = query.or(
      `changed_by_name.ilike.%${filters.search}%,reason.ilike.%${filters.search}%,table_name.ilike.%${filters.search}%,entity_id.ilike.%${filters.search}%,description.ilike.%${filters.search}%,action.ilike.%${filters.search}%`
    );
  }

  if (filters.module && filters.module !== 'ALL') {
    query = query.eq('source_module', filters.module);
  }

  if (filters.action && filters.action !== 'ALL') {
    query = query.eq('action', filters.action);
  }

  if (filters.userId) {
    query = query.eq('changed_by', filters.userId);
  }

  if (filters.dateFrom) {
    query = query.gte('changed_at', filters.dateFrom);
  }

  if (filters.dateTo) {
    query = query.lte('changed_at', filters.dateTo + 'T23:59:59');
  }

  const { data, error, count } = await query
    .order('changed_at', { ascending: false })
    .range(from, to);

  if (error) throw error;

  return {
    data: data || [],
    count: count || 0,
  };
}

// ✅ FIX: Export with all spec-required columns
export async function exportAuditLogsToCSV(filters: AuditLogFilters = {}): Promise<string> {
  let query = supabase
    .schema(SCHEMA)
    .from('audit_log_enriched')
    .select('*');

  if (filters.search) {
    query = query.or(
      `changed_by_name.ilike.%${filters.search}%,reason.ilike.%${filters.search}%,description.ilike.%${filters.search}%`
    );
  }

  if (filters.module && filters.module !== 'ALL') {
    query = query.eq('source_module', filters.module);
  }

  if (filters.action && filters.action !== 'ALL') {
    query = query.eq('action', filters.action);
  }

  if (filters.dateFrom) {
    query = query.gte('changed_at', filters.dateFrom);
  }

  if (filters.dateTo) {
    query = query.lte('changed_at', filters.dateTo + 'T23:59:59');
  }

  const { data, error } = await query.order('changed_at', { ascending: false }).limit(10000);
  if (error) throw error;

  // ✅ FIX: CSV headers match Spec 8.1 required fields
  const headers = [
    'Timestamp', 'User ID', 'User Name', 'User Email', 'Role',
    'Action', 'Module', 'Entity Type', 'Entity ID', 'Description',
    'Previous Status', 'New Status', 'Severity', 'Status',
    'Reason', 'IP Address', 'User Agent', 'Request ID', 'Entry Hash'
  ];

  const rows = (data || []).map((log: any) => [
    new Date(log.changed_at).toISOString(),
    log.user_id || '',
    log.changed_by_name || '',
    log.changed_by_email || '',
    log.changed_by_role || '',
    log.action,
    log.source_module || '',
    log.entity_type || log.table_name || '',
    log.entity_id || '',
    `"${String(log.description || '').replace(/"/g, '""')}"`,
    log.previous_status || '',
    log.new_status || '',
    log.severity || 'info',
    log.status || 'success',
    `"${String(log.reason || '').replace(/"/g, '""')}"`,
    log.ip_address || '',
    log.user_agent || '',
    log.request_id || '',
    log.entry_hash || '',
  ]);

  const csvContent = [headers, ...rows]
    .map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(','))
    .join('\n');

  // ✅ FIX: Log the export event itself (Spec 8.2)
  try {
    await supabase.rpc('audit.log_export_event', {
      p_report_name: 'Audit Log Export',
      p_report_type: 'audit',
      p_format: 'csv',
      p_row_count: rows.length,
    });
  } catch {
    // Non-critical
  }

  return csvContent;
}

// ✅ FIX: Get unique modules from enriched view
export async function getAuditModules(): Promise<string[]> {
  const { data, error } = await supabase
    .schema(SCHEMA)
    .from('audit_log_enriched')
    .select('source_module')
    .not('source_module', 'is', null)
    .order('source_module');

  if (error) throw error;
  const modules = [...new Set(data.map((d: any) => d.source_module as string))];
  return modules.sort();
}