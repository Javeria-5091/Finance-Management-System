'use client';

import { useState, useEffect, useCallback } from 'react';
import {
  Search,
  Download,
  ChevronDown,
  ChevronRight,
  Filter,
} from 'lucide-react';
import { getAuditLogs, exportAuditLogsToCSV, getAuditModules } from '@/types/services/audit.service';
import type { AuditLogEnriched, AuditAction, AuditLogFilters } from '@/types/accounting.types';

// ==========================================
// CONSTANTS (Dark Mode Ready)
// ==========================================
const ACTION_COLORS: Record<string, string> = {
  INSERT: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400',
  UPDATE: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
  DELETE: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
  STATUS_CHANGE: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400',
  APPROVE: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400',
  REJECT: 'bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-400',
  REVERSE: 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400',
  PERIOD_CLOSE: 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400',
  PERIOD_REOPEN: 'bg-cyan-100 text-cyan-700 dark:bg-cyan-900/30 dark:text-cyan-400',
  EXPORT: 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300',
  POST: 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-400',
};

// ==========================================
// MAIN COMPONENT
// ==========================================
export default function AuditLogPage() {
  const [logs, setLogs] = useState<AuditLogEnriched[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set());
  const [modules, setModules] = useState<string[]>([]);

  // Filters
  const [filters, setFilters] = useState<AuditLogFilters>({
    search: '',
    module: 'ALL',
    action: 'ALL',
    dateFrom: '',
    dateTo: '',
    page: 1,
    pageSize: 50,
  });

  const [exporting, setExporting] = useState(false);

  // ==========================================
  // DATA FETCHING
  // ==========================================
  const loadLogs = useCallback(async () => {
    try {
      setLoading(true);
      const result = await getAuditLogs(filters);
      setLogs(result.data);
      setTotal(result.count);
    } catch (error) {
      console.error('Failed to load audit logs:', error);
    } finally {
      setLoading(false);
    }
  }, [filters]);

  useEffect(() => {
    loadLogs();
  }, [loadLogs]);

  useEffect(() => {
    getAuditModules().then(setModules).catch(console.error);
  }, []);

  // ==========================================
  // HANDLERS
  // ==========================================
  const toggleRow = (id: string) => {
    setExpandedRows((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleExport = async () => {
    try {
      setExporting(true);
      const csv = await exportAuditLogsToCSV(filters);
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `audit-log-${new Date().toISOString().split('T')[0]}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      console.error('Export failed:', error);
    } finally {
      setExporting(false);
    }
  };

  const updateFilter = (key: string, value: string) => {
    setFilters((prev) => ({ ...prev, [key]: value, page: 1 }));
  };

  // ==========================================
  // PAGINATION (Fixed JS bug here)
  // ==========================================
  const currentPage = filters.page || 1;
  const totalPages = Math.ceil(total / (filters.pageSize || 50));
  const pageStart = (currentPage - 1) * (filters.pageSize || 50) + 1;
  const pageEnd = Math.min(currentPage * (filters.pageSize || 50), total);

  // ==========================================
  // RENDER (FULL DARK MODE)
  // ==========================================
  return (
    <div className="p-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Audit Log</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">Track all changes in the system</p>
        </div>
        <button
          onClick={handleExport}
          disabled={exporting}
          className="flex items-center gap-2 px-4 py-2 bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-600 disabled:opacity-50 transition-colors"
        >
          <Download className="w-4 h-4" />
          {exporting ? 'Exporting...' : 'Export CSV'}
        </button>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3 mb-4 p-4 bg-gray-50 dark:bg-gray-900/50 rounded-lg border border-gray-200 dark:border-gray-700/50">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 dark:text-gray-500" />
          <input
            type="text"
            placeholder="Search user, reason, record..."
            value={filters.search || ''}
            onChange={(e) => updateFilter('search', e.target.value)}
            className="w-full pl-10 pr-4 py-2 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded-lg text-sm text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500 dark:focus:ring-blue-600 transition-colors"
          />
        </div>

        <div className="flex items-center gap-2">
          <Filter className="w-4 h-4 text-gray-400 dark:text-gray-500" />
          <select
            value={filters.module || 'ALL'}
            onChange={(e) => updateFilter('module', e.target.value)}
            className="px-3 py-2 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded-lg text-sm text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500 dark:focus:ring-blue-600"
          >
            <option value="ALL">All Modules</option>
            {modules.map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>

          <select
            value={filters.action || 'ALL'}
            onChange={(e) => updateFilter('action', e.target.value)}
            className="px-3 py-2 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded-lg text-sm text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500 dark:focus:ring-blue-600"
          >
            <option value="ALL">All Actions</option>
            {Object.keys(ACTION_COLORS).map((a) => (
              <option key={a} value={a}>{a}</option>
            ))}
          </select>

          <input
            type="date"
            value={filters.dateFrom || ''}
            onChange={(e) => updateFilter('dateFrom', e.target.value)}
            className="px-3 py-2 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded-lg text-sm text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500 dark:focus:ring-blue-600"
          />
          <input
            type="date"
            value={filters.dateTo || ''}
            onChange={(e) => updateFilter('dateTo', e.target.value)}
            className="px-3 py-2 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded-lg text-sm text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500 dark:focus:ring-blue-600"
          />
        </div>
      </div>

      {/* Table */}
      <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden">
        <table className="w-full">
          <thead>
            <tr className="bg-gray-50 dark:bg-gray-900/50 text-xs text-gray-500 dark:text-gray-400 uppercase">
              <th className="text-left px-4 py-2.5 w-8" />
              <th className="text-left px-4 py-2.5 w-40">Timestamp</th>
              <th className="text-left px-4 py-2.5 w-32">User</th>
              <th className="text-left px-4 py-2.5 w-28">Action</th>
              <th className="text-left px-4 py-2.5">Table</th>
              <th className="text-left px-4 py-2.5 w-24">Module</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={6} className="text-center py-20 text-gray-400 dark:text-gray-500 bg-white dark:bg-gray-800">
                  Loading audit logs...
                </td>
              </tr>
            ) : logs.length === 0 ? (
              <tr>
                <td colSpan={6} className="text-center py-20 text-gray-400 dark:text-gray-500 bg-white dark:bg-gray-800">
                  No audit logs found
                </td>
              </tr>
            ) : (
              logs.map((log) => {
                const isExpanded = expandedRows.has(log.id);
                return (
                  <>
                    <tr
                      key={log.id}
                      className="border-t border-gray-100 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-700/30 cursor-pointer bg-white dark:bg-gray-800 transition-colors"
                      onClick={() => toggleRow(log.id)}
                    >
                      <td className="px-4 py-2.5">
                        {isExpanded ? (
                          <ChevronDown className="w-4 h-4 text-gray-400 dark:text-gray-500" />
                        ) : (
                          <ChevronRight className="w-4 h-4 text-gray-400 dark:text-gray-500" />
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-sm text-gray-600 dark:text-gray-400">
                        {new Date(log.changed_at).toLocaleString('en-PK')}
                      </td>
                      <td className="px-4 py-2.5">
                        <div className="text-sm font-medium text-gray-900 dark:text-white">
                          {log.changed_by_name || 'Unknown'}
                        </div>
                        <div className="text-xs text-gray-400 dark:text-gray-500">{log.changed_by_email}</div>
                      </td>
                      <td className="px-4 py-2.5">
                        <span
                          className={`px-2 py-0.5 rounded text-xs font-medium ${
                            ACTION_COLORS[log.action] || 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300'
                          }`}
                        >
                          {log.action}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 text-sm text-gray-600 dark:text-gray-300">
                        {log.table_schema}.{log.table_name}
                      </td>
                      <td className="px-4 py-2.5 text-sm text-gray-500 dark:text-gray-400">
                        {log.source_module || '-'}
                      </td>
                    </tr>

                    {/* Expanded Detail */}
                    {isExpanded && (
                      <tr key={`${log.id}-detail`} className="border-t border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900/30">
                        <td colSpan={6} className="px-4 py-4">
                          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                            {/* Old Values */}
                            <div>
                              <h4 className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase mb-2">
                                Old Values
                              </h4>
                              <pre className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg p-3 text-xs text-gray-700 dark:text-gray-300 overflow-auto max-h-48">
                                {log.old_values ? JSON.stringify(log.old_values, null, 2) : '(none)'}
                              </pre>
                            </div>

                            {/* New Values */}
                            <div>
                              <h4 className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase mb-2">
                                New Values
                              </h4>
                              <pre className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg p-3 text-xs text-gray-700 dark:text-gray-300 overflow-auto max-h-48">
                                {log.new_values ? JSON.stringify(log.new_values, null, 2) : '(none)'}
                              </pre>
                            </div>
                          </div>

                          {/* Meta Info */}
                          <div className="mt-4 grid grid-cols-1 md:grid-cols-3 gap-4 text-xs">
                            <div>
                              <span className="text-gray-500 dark:text-gray-400">Changed Columns:</span>{' '}
                              <span className="text-gray-700 dark:text-gray-300">
                                {log.changed_columns?.join(', ') || 'N/A'}
                              </span>
                            </div>
                            <div>
                              <span className="text-gray-500 dark:text-gray-400">Reason:</span>{' '}
                              <span className="text-gray-700 dark:text-gray-300">{log.reason || 'N/A'}</span>
                            </div>
                            <div>
                              <span className="text-gray-500 dark:text-gray-400">IP:</span>{' '}
                              <span className="text-gray-700 dark:text-gray-300 font-mono">{log.ip_address || 'N/A'}</span>
                            </div>
                            <div>
                              <span className="text-gray-500 dark:text-gray-400">Record ID:</span>{' '}
                              <span className="text-gray-700 dark:text-gray-300 font-mono">{log.record_id}</span>
                            </div>
                            <div className="md:col-span-2">
                              <span className="text-gray-500 dark:text-gray-400">User Agent:</span>{' '}
                              <span className="text-gray-700 dark:text-gray-300 break-all">{log.user_agent || 'N/A'}</span>
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </>
                );
              })
            )}
          </tbody>
        </table>

        {/* Pagination */}
        <div className="flex items-center justify-between px-4 py-3 border-t border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900/30">
          <div className="text-sm text-gray-500 dark:text-gray-400">
            Showing {pageStart}-{pageEnd} of {total}
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={() => setFilters((p) => ({ ...p, page: currentPage - 1 }))}
              disabled={currentPage <= 1}
              className="px-3 py-1.5 text-sm border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 rounded hover:bg-white dark:hover:bg-gray-700 disabled:opacity-50 transition-colors"
            >
              Prev
            </button>
            
            {Array.from({ length: Math.min(totalPages, 5) }, (_, i) => {
              const pageNum = i + 1;
              return (
                <button
                  key={pageNum}
                  onClick={() => setFilters((p) => ({ ...p, page: pageNum }))}
                  className={`px-3 py-1.5 text-sm rounded transition-colors ${
                    currentPage === pageNum
                      ? 'bg-blue-600 text-white'
                      : 'border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 hover:bg-white dark:hover:bg-gray-700'
                  }`}
                >
                  {pageNum}
                </button>
              );
            })}

            <button
              onClick={() => setFilters((p) => ({ ...p, page: currentPage + 1 }))}
              disabled={currentPage >= totalPages}
              className="px-3 py-1.5 text-sm border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 rounded hover:bg-white dark:hover:bg-gray-700 disabled:opacity-50 transition-colors"
            >
              Next
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}