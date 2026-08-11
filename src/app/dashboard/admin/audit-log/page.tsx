// src/app/dashboard/admin/audit-log/page.tsx
"use client";

import { useState, useEffect } from "react";
import { useAuth } from "@/context/AuthContext";
import { usePermissions } from "@/context/PermissionContext";
import { supabase } from "@/lib/supabase";
import type { AuditLog } from "@/types/accounting.types";
import {
  Shield,
  Search,
  Download,
  ChevronLeft,
  ChevronRight,
  Eye,
  Clock,
  User,
  FileText,
  AlertTriangle,
  CheckCircle,
  XCircle,
  Loader2,
  Sparkles,
} from "lucide-react";

// ✅ FIX: reuse the single shared AuditLog type (mirrors public.v_audit_log)
// instead of a local, incomplete interface — otherwise this page silently
// drops project_id / amount / AI fields that the view now returns.
type AuditLogEntry = AuditLog;

export default function AuditLogPage() {
  const { user } = useAuth();
  const { hasPermission, isLoading: permLoading } = usePermissions();
  const [logs, setLogs] = useState<AuditLogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedLog, setSelectedLog] = useState<AuditLogEntry | null>(null);

  const [searchTerm, setSearchTerm] = useState("");
  const [actionFilter, setActionFilter] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  // ✅ NEW: Spec 8.3 required filters that had no UI anywhere before.
  const [projectIdFilter, setProjectIdFilter] = useState("");
  const [minAmount, setMinAmount] = useState("");
  const [maxAmount, setMaxAmount] = useState("");

  const [page, setPage] = useState(1);
  const [totalCount, setTotalCount] = useState(0);
  const pageSize = 20;

  const hasAccess = hasPermission("ADMIN_AUDIT");

  useEffect(() => {
    if (!permLoading && !hasAccess) {
      setError("Access denied. You don't have permission to view audit logs.");
      setLoading(false);
      return;
    }

    if (!permLoading && hasAccess) {
      fetchLogs();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [permLoading, hasAccess, page, searchTerm, actionFilter, statusFilter, dateFrom, dateTo, projectIdFilter, minAmount, maxAmount]);

  const buildBaseQuery = () => {
    // v_audit_log lives in the public schema (default) and is
    // security_invoker, so RLS from Appendix A applies automatically.
    let query = supabase
      .from("v_audit_log")
      .select("*", { count: "exact" });

    if (searchTerm) {
      query = query.or(
        `description.ilike.%${searchTerm}%,user_email.ilike.%${searchTerm}%,user_name.ilike.%${searchTerm}%,entity_type.ilike.%${searchTerm}%`
      );
    }

    if (actionFilter !== "all") {
      query = query.eq("action", actionFilter);
    }

    if (statusFilter !== "all") {
      query = query.eq("status", statusFilter);
    }

    if (dateFrom) {
      query = query.gte("created_at", dateFrom);
    }

    if (dateTo) {
      query = query.lte("created_at", dateTo + "T23:59:59");
    }

    // ✅ NEW: project + amount filters (Spec 8.3)
    if (projectIdFilter) {
      query = query.eq("project_id", projectIdFilter);
    }

    if (minAmount) {
      query = query.gte("amount", Number(minAmount));
    }

    if (maxAmount) {
      query = query.lte("amount", Number(maxAmount));
    }

    return query;
  };

  const fetchLogs = async () => {
    setLoading(true);
    setError(null);

    try {
      const query = buildBaseQuery()
        .order("created_at", { ascending: false })
        .range((page - 1) * pageSize, page * pageSize - 1);

      const { data, error: fetchError, count } = await query;

      if (fetchError) {
        if (fetchError.code === "42501") {
          setError("Permission denied: RLS policy blocks access. Run the audit schema migration SQL.");
        } else {
          throw fetchError;
        }
      } else {
        setLogs((data as AuditLogEntry[]) || []);
        setTotalCount(count || 0);
      }
    } catch (err) {
      console.error("Fetch audit logs error:", err);
      setError(err instanceof Error ? err.message : "Failed to fetch audit logs");
    } finally {
      setLoading(false);
    }
  };

  const exportLogs = async () => {
    try {
      const { data } = await buildBaseQuery()
        .order("created_at", { ascending: false })
        .limit(10000);

      if (data) {
        // ✅ FIX: export columns now include project/amount/AI fields
        // (Spec 8.3 required filter/export set + Spec 8.1 AI field group).
        const csv = [
          [
            "Timestamp", "User", "User Email", "Role", "Action", "Entity", "Entity ID",
            "Project ID", "Amount", "Amount Currency",
            "Description", "Previous Status", "New Status", "Approval Level",
            "Severity", "Status", "Reason", "IP Address",
            "AI Question", "AI Tool", "AI Model",
          ].join(","),
          ...data.map((log: any) =>
            [
              new Date(log.created_at).toISOString(),
              log.user_name || "",
              log.user_email || "",
              log.role_snapshot || "",
              log.action,
              log.entity_type,
              log.entity_id || "",
              log.project_id || "",
              log.amount ?? "",
              log.amount_currency || "",
              `"${(log.description || "").replace(/"/g, '""')}"`,
              log.previous_status || "",
              log.new_status || "",
              log.approval_level || "",
              log.severity || "info",
              log.status,
              `"${(log.reason || "").replace(/"/g, '""')}"`,
              log.ip_address || "",
              `"${(log.ai_question || "").replace(/"/g, '""')}"`,
              log.ai_selected_tool || "",
              log.ai_model || "",
            ].join(",")
          ),
        ].join("\n");

        const blob = new Blob([csv], { type: "text/csv" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `audit-log-${new Date().toISOString().split("T")[0]}.csv`;
        a.click();
        URL.revokeObjectURL(url);

        // ✅ FIX: correct schema-qualified rpc call — logs the export event
        // itself per Spec 8.2 ("...export, print, download...").
        try {
          await supabase.schema("audit").rpc("log_export_event", {
            p_report_name: "Audit Log Export",
            p_report_type: "audit",
            p_format: "csv",
            p_row_count: data.length,
          });
        } catch {
          // Non-critical
        }
      }
    } catch (err) {
      console.error("Export error:", err);
      setError("Failed to export logs");
    }
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case "success":
        return <CheckCircle className="w-4 h-4 text-green-500" />;
      case "denied":
        return <XCircle className="w-4 h-4 text-red-500" />;
      case "error":
        return <AlertTriangle className="w-4 h-4 text-yellow-500" />;
      default:
        return null;
    }
  };

  const getStatusBadge = (status: string) => {
    const styles: Record<string, string> = {
      success: "bg-green-50 text-green-700 dark:bg-green-900/20 dark:text-green-400",
      denied: "bg-red-50 text-red-700 dark:bg-red-900/20 dark:text-red-400",
      error: "bg-yellow-50 text-yellow-700 dark:bg-yellow-900/20 dark:text-yellow-400",
    };
    return (
      <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${styles[status] || "bg-gray-50 text-gray-700"}`}>
        {getStatusIcon(status)}
        {status}
      </span>
    );
  };

  const totalPages = Math.ceil(totalCount / pageSize);

  if (permLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
      </div>
    );
  }

  if (!hasAccess) {
    return (
      <div className="flex flex-col items-center justify-center h-64 text-center">
        <Shield className="w-12 h-12 text-red-400 mb-4" />
        <h2 className="text-xl font-semibold text-gray-900 dark:text-white mb-2">Access Denied</h2>
        <p className="text-gray-500 dark:text-gray-400">
          You don&apos;t have permission to view audit logs. Contact your administrator.
        </p>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Audit Log</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
            Complete history of all system actions ({totalCount} entries)
          </p>
        </div>
        <button
          onClick={exportLogs}
          className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
        >
          <Download className="w-4 h-4" />
          Export CSV
        </button>
      </div>

      {/* Filters */}
      <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-4 space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-5 gap-4">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
            <input
              type="text"
              placeholder="Search logs..."
              value={searchTerm}
              onChange={(e) => { setSearchTerm(e.target.value); setPage(1); }}
              className="w-full pl-10 pr-4 py-2 border border-gray-200 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm"
            />
          </div>

          <select
            value={actionFilter}
            onChange={(e) => { setActionFilter(e.target.value); setPage(1); }}
            className="px-3 py-2 border border-gray-200 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm"
          >
            <option value="all">All Actions</option>
            <option value="CREATE">Create</option>
            <option value="UPDATE">Update</option>
            <option value="DELETE">Delete</option>
            <option value="APPROVE">Approve</option>
            <option value="REJECT">Reject</option>
            <option value="POST">Post</option>
            <option value="REVERSE">Reverse</option>
            <option value="LOGIN">Login</option>
            <option value="LOGOUT">Logout</option>
            <option value="VIEW">View</option>
            <option value="EXPORT">Export</option>
            <option value="AI_QUERY">AI Query</option>
            <option value="AI_TOOL_CALL">AI Tool Call</option>
          </select>

          <select
            value={statusFilter}
            onChange={(e) => { setStatusFilter(e.target.value); setPage(1); }}
            className="px-3 py-2 border border-gray-200 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm"
          >
            <option value="all">All Status</option>
            <option value="success">Success</option>
            <option value="denied">Denied</option>
            <option value="error">Error</option>
          </select>

          <input
            type="date"
            value={dateFrom}
            onChange={(e) => { setDateFrom(e.target.value); setPage(1); }}
            className="px-3 py-2 border border-gray-200 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm"
          />

          <input
            type="date"
            value={dateTo}
            onChange={(e) => { setDateTo(e.target.value); setPage(1); }}
            className="px-3 py-2 border border-gray-200 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm"
          />
        </div>

        {/* ✅ NEW: Project + Amount filters — Spec 8.3 required these and
            they previously had no UI anywhere. */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 pt-2 border-t border-gray-100 dark:border-gray-700">
          <input
            type="text"
            placeholder="Project ID"
            value={projectIdFilter}
            onChange={(e) => { setProjectIdFilter(e.target.value); setPage(1); }}
            className="px-3 py-2 border border-gray-200 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm"
          />
          <input
            type="number"
            placeholder="Min amount"
            value={minAmount}
            onChange={(e) => { setMinAmount(e.target.value); setPage(1); }}
            className="px-3 py-2 border border-gray-200 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm"
          />
          <input
            type="number"
            placeholder="Max amount"
            value={maxAmount}
            onChange={(e) => { setMaxAmount(e.target.value); setPage(1); }}
            className="px-3 py-2 border border-gray-200 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm"
          />
        </div>
      </div>

      {/* Error Display */}
      {error && (
        <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-4 flex items-start gap-3">
          <AlertTriangle className="w-5 h-5 text-red-500 flex-shrink-0 mt-0.5" />
          <div>
            <p className="text-sm font-medium text-red-800 dark:text-red-400">Error</p>
            <p className="text-sm text-red-600 dark:text-red-300 mt-1">{error}</p>
          </div>
        </div>
      )}

      {/* Log Table */}
      <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center h-64">
            <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
          </div>
        ) : logs.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-64 text-center">
            <FileText className="w-12 h-12 text-gray-300 dark:text-gray-600 mb-4" />
            <p className="text-gray-500 dark:text-gray-400">No audit logs found</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900/50">
                  <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">Timestamp</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">User</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">Action</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">Entity</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">Amount</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">Description</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">Status</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">Details</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                {logs.map((log) => (
                  <tr key={log.id} className="hover:bg-gray-50 dark:hover:bg-gray-700/50">
                    <td className="px-4 py-3 text-sm text-gray-600 dark:text-gray-300 whitespace-nowrap">
                      <div className="flex items-center gap-1.5">
                        <Clock className="w-3.5 h-3.5 text-gray-400" />
                        {new Date(log.created_at).toLocaleString()}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <div className="w-7 h-7 bg-gray-200 dark:bg-gray-600 rounded-full flex items-center justify-center">
                          <User className="w-3.5 h-3.5 text-gray-500" />
                        </div>
                        <div>
                          <p className="text-sm font-medium text-gray-900 dark:text-white truncate max-w-[150px]">
                            {log.user_name || "Unknown"}
                          </p>
                          <p className="text-xs text-gray-500 truncate max-w-[150px]">{log.user_email || ""}</p>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-400">
                        {log.action.startsWith("AI_") && <Sparkles className="w-3 h-3" />}
                        {log.action}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-600 dark:text-gray-300">
                      {log.entity_type}
                      {log.entity_id && (
                        <span className="text-xs text-gray-400 ml-1">#{log.entity_id.slice(0, 8)}</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-600 dark:text-gray-300 whitespace-nowrap">
                      {log.amount != null
                        ? `${log.amount.toLocaleString()} ${log.amount_currency || ""}`
                        : "—"}
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-600 dark:text-gray-300 max-w-[300px] truncate">
                      {log.description || log.ai_question || ""}
                    </td>
                    <td className="px-4 py-3">{getStatusBadge(log.status)}</td>
                    <td className="px-4 py-3">
                      <button
                        onClick={() => setSelectedLog(log)}
                        className="p-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-600 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
                      >
                        <Eye className="w-4 h-4" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Pagination */}
        {!loading && logs.length > 0 && (
          <div className="flex items-center justify-between px-4 py-3 border-t border-gray-200 dark:border-gray-700">
            <p className="text-sm text-gray-500 dark:text-gray-400">
              Showing {(page - 1) * pageSize + 1} to {Math.min(page * pageSize, totalCount)} of {totalCount}
            </p>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setPage(p => Math.max(1, p - 1))}
                disabled={page === 1}
                className="p-2 rounded-lg border border-gray-200 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <ChevronLeft className="w-4 h-4" />
              </button>
              <span className="text-sm text-gray-600 dark:text-gray-300">
                Page {page} of {totalPages}
              </span>
              <button
                onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                disabled={page === totalPages}
                className="p-2 rounded-lg border border-gray-200 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Detail Modal */}
      {selectedLog && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" onClick={() => setSelectedLog(null)}>
          <div className="bg-white dark:bg-gray-800 rounded-xl max-w-2xl w-full max-h-[80vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
            <div className="p-6 border-b border-gray-200 dark:border-gray-700 flex items-center justify-between">
              <h2 className="text-lg font-semibold text-gray-900 dark:text-white">Audit Log Details</h2>
              <button onClick={() => setSelectedLog(null)} className="p-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700">
                <XCircle className="w-5 h-5 text-gray-400" />
              </button>
            </div>
            <div className="p-6 space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <p className="text-xs text-gray-500 dark:text-gray-400 uppercase">Timestamp</p>
                  <p className="text-sm text-gray-900 dark:text-white mt-1">{new Date(selectedLog.created_at).toLocaleString()}</p>
                </div>
                <div>
                  <p className="text-xs text-gray-500 dark:text-gray-400 uppercase">Status</p>
                  <div className="mt-1">{getStatusBadge(selectedLog.status)}</div>
                </div>
                <div>
                  <p className="text-xs text-gray-500 dark:text-gray-400 uppercase">User</p>
                  <p className="text-sm text-gray-900 dark:text-white mt-1">{selectedLog.user_name || "Unknown"}</p>
                  <p className="text-xs text-gray-500">{selectedLog.user_email || ""}</p>
                  <p className="text-xs text-gray-500">{selectedLog.role_snapshot || ""}</p>
                </div>
                <div>
                  <p className="text-xs text-gray-500 dark:text-gray-400 uppercase">Action</p>
                  <p className="text-sm text-gray-900 dark:text-white mt-1">{selectedLog.action}</p>
                </div>
                <div>
                  <p className="text-xs text-gray-500 dark:text-gray-400 uppercase">Entity Type</p>
                  <p className="text-sm text-gray-900 dark:text-white mt-1">{selectedLog.entity_type}</p>
                </div>
                <div>
                  <p className="text-xs text-gray-500 dark:text-gray-400 uppercase">Entity ID</p>
                  <p className="text-sm text-gray-900 dark:text-white mt-1 font-mono">{selectedLog.entity_id || "N/A"}</p>
                </div>
                {/* ✅ NEW: project + amount (Spec 8.3) */}
                <div>
                  <p className="text-xs text-gray-500 dark:text-gray-400 uppercase">Project ID</p>
                  <p className="text-sm text-gray-900 dark:text-white mt-1 font-mono">{selectedLog.project_id || "N/A"}</p>
                </div>
                <div>
                  <p className="text-xs text-gray-500 dark:text-gray-400 uppercase">Amount</p>
                  <p className="text-sm text-gray-900 dark:text-white mt-1">
                    {selectedLog.amount != null
                      ? `${selectedLog.amount.toLocaleString()} ${selectedLog.amount_currency || ""}`
                      : "N/A"}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-gray-500 dark:text-gray-400 uppercase">Approval Level</p>
                  <p className="text-sm text-gray-900 dark:text-white mt-1">{selectedLog.approval_level || "N/A"}</p>
                </div>
                <div>
                  <p className="text-xs text-gray-500 dark:text-gray-400 uppercase">IP Address</p>
                  <p className="text-sm text-gray-900 dark:text-white mt-1">{selectedLog.ip_address || "N/A"}</p>
                </div>
                <div>
                  <p className="text-xs text-gray-500 dark:text-gray-400 uppercase">User Agent</p>
                  <p className="text-sm text-gray-900 dark:text-white mt-1 truncate max-w-[200px]">{selectedLog.user_agent || "N/A"}</p>
                </div>
              </div>

              <div>
                <p className="text-xs text-gray-500 dark:text-gray-400 uppercase">Description</p>
                <p className="text-sm text-gray-900 dark:text-white mt-1 bg-gray-50 dark:bg-gray-700 p-3 rounded-lg">
                  {selectedLog.description || "No description"}
                </p>
              </div>

              {selectedLog.error_message && (
                <div>
                  <p className="text-xs text-gray-500 dark:text-gray-400 uppercase">Error Message</p>
                  <p className="text-sm text-red-600 dark:text-red-400 mt-1 bg-red-50 dark:bg-red-900/20 p-3 rounded-lg">
                    {selectedLog.error_message}
                  </p>
                </div>
              )}

              {/* ✅ NEW: AI field group — Spec 8.1 "AI" row. Only rendered
                  when the row actually carries AI data (source_module='ai'). */}
              {(selectedLog.ai_question || selectedLog.ai_selected_tool) && (
                <div className="border border-purple-200 dark:border-purple-800 rounded-lg p-3 bg-purple-50 dark:bg-purple-900/10">
                  <p className="text-xs text-purple-700 dark:text-purple-400 uppercase font-medium mb-2 flex items-center gap-1">
                    <Sparkles className="w-3.5 h-3.5" /> AI Activity
                  </p>
                  <div className="grid grid-cols-2 gap-3 text-sm">
                    {selectedLog.ai_question && (
                      <div className="col-span-2">
                        <p className="text-xs text-gray-500 dark:text-gray-400">Question</p>
                        <p className="text-gray-900 dark:text-white">{selectedLog.ai_question}</p>
                      </div>
                    )}
                    {selectedLog.ai_selected_tool && (
                      <div>
                        <p className="text-xs text-gray-500 dark:text-gray-400">Tool</p>
                        <p className="text-gray-900 dark:text-white">{selectedLog.ai_selected_tool}</p>
                      </div>
                    )}
                    {selectedLog.ai_model && (
                      <div>
                        <p className="text-xs text-gray-500 dark:text-gray-400">Model</p>
                        <p className="text-gray-900 dark:text-white">{selectedLog.ai_model}</p>
                      </div>
                    )}
                    {selectedLog.ai_row_count != null && (
                      <div>
                        <p className="text-xs text-gray-500 dark:text-gray-400">Rows Returned</p>
                        <p className="text-gray-900 dark:text-white">{selectedLog.ai_row_count}</p>
                      </div>
                    )}
                    {selectedLog.ai_latency_ms != null && (
                      <div>
                        <p className="text-xs text-gray-500 dark:text-gray-400">Latency</p>
                        <p className="text-gray-900 dark:text-white">{selectedLog.ai_latency_ms} ms</p>
                      </div>
                    )}
                    {selectedLog.ai_refusal_reason && (
                      <div className="col-span-2">
                        <p className="text-xs text-red-500">Refusal Reason</p>
                        <p className="text-red-600 dark:text-red-400">{selectedLog.ai_refusal_reason}</p>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {selectedLog.old_values && (
                <div>
                  <p className="text-xs text-gray-500 dark:text-gray-400 uppercase">Old Values</p>
                  <pre className="text-xs text-gray-900 dark:text-white mt-1 bg-gray-50 dark:bg-gray-700 p-3 rounded-lg overflow-x-auto">
                    {JSON.stringify(selectedLog.old_values, null, 2)}
                  </pre>
                </div>
              )}

              {selectedLog.new_values && (
                <div>
                  <p className="text-xs text-gray-500 dark:text-gray-400 uppercase">New Values</p>
                  <pre className="text-xs text-gray-900 dark:text-white mt-1 bg-gray-50 dark:bg-gray-700 p-3 rounded-lg overflow-x-auto">
                    {JSON.stringify(selectedLog.new_values, null, 2)}
                  </pre>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
