import { supabase } from '@/lib/supabase';
import type { AuditLogEnriched, AuditLogFilters } from '@/types/accounting.types';

// ⭐ Audit tables 'audit' schema mein hain
const SCHEMA = 'audit';

export async function getAuditLogs(filters: AuditLogFilters = {}): Promise<{
  data: AuditLogEnriched[];
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
      `changed_by_name.ilike.%${filters.search}%,reason.ilike.%${filters.search}%,table_name.ilike.%${filters.search}%,record_id.ilike.%${filters.search}%`
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
    data: (data as AuditLogEnriched[]) || [],
    count: count || 0,
  };
}

export async function exportAuditLogsToCSV(filters: AuditLogFilters = {}): Promise<string> {
  let query = supabase
    .schema(SCHEMA)
    .from('audit_log_enriched')
    .select('*');

  if (filters.search) {
    query = query.or(
      `changed_by_name.ilike.%${filters.search}%,reason.ilike.%${filters.search}%`
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

  const headers = [
    'Timestamp', 'User', 'Email', 'Role', 'Action', 'Module', 'Table', 'Record ID', 'Changed Columns', 'Reason', 'IP Address',
  ];

  const rows = (data as AuditLogEnriched[]).map((log) => [
    new Date(log.changed_at).toLocaleString(),
    log.changed_by_name || 'Unknown',
    log.changed_by_email || '',
    log.changed_by_role || '',
    log.action,
    log.source_module || '',
    `${log.table_schema}.${log.table_name}`,
    log.record_id,
    log.changed_columns?.join(', ') || '',
    log.reason || '',
    log.ip_address || '',
  ]);

  const csvContent = [headers, ...rows]
    .map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(','))
    .join('\n');

  return csvContent;
}

export async function getAuditModules(): Promise<string[]> {
  const { data, error } = await supabase
    .schema(SCHEMA)
    .from('audit_log')
    .select('source_module')
    .not('source_module', 'is', null)
    .order('source_module');

  if (error) throw error;
  const modules = [...new Set(data.map((d) => d.source_module as string))];
  return modules.sort();
}