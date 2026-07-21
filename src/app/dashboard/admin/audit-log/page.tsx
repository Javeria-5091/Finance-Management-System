"use client";
import { useState, useEffect } from "react";
import { supabase } from "@/lib/supabase";
import { Search, Download, ChevronDown, ChevronRight } from "lucide-react";

export default function AuditLogPage() {
  const [logs, setLogs] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  useEffect(() => {
    const fetchLogs = async () => {
      const { data } = await supabase
        .from("audit_log_enriched")
        .select("*")
        .order("changed_at", { ascending: false })
        .limit(50);
      if (data) setLogs(data);
      setLoading(false);
    };
    fetchLogs();
  }, []);

  const ACTION_COLORS: Record<string, string> = {
    INSERT: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400",
    UPDATE: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400",
    DELETE: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400",
    STATUS_CHANGE: "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400",
  };

  return (
    <div className="p-6">
      <h2 className="text-2xl font-bold text-gray-900 dark:text-white mb-6">Audit Log</h2>
      
      <div className="bg-white dark:bg-gray-800 border dark:border-gray-700 rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 dark:bg-gray-900/50 text-left text-xs text-gray-500 uppercase">
            <tr>
              <th className="p-3"></th>
              <th className="p-3">Timestamp</th>
              <th className="p-3">User</th>
              <th className="p-3">Action</th>
              <th className="p-3">Table</th>
            </tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan={5} className="p-8 text-center text-gray-400">Loading...</td></tr>}
            {logs.map((log) => (
              <>
                <tr key={log.id} onClick={() => setExpandedId(expandedId === log.id ? null : log.id)} className="border-t dark:border-gray-700 cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-700/30">
                  <td className="p-3">{expandedId === log.id ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</td>
                  <td className="p-3 text-gray-600 dark:text-gray-300">{new Date(log.changed_at).toLocaleString()}</td>
                  <td className="p-3 font-medium text-gray-900 dark:text-white">{log.changed_by_name || 'System'}</td>
                  <td className="p-3"><span className={`px-2 py-0.5 rounded text-xs font-medium ${ACTION_COLORS[log.action] || 'bg-gray-100'}`}>{log.action}</span></td>
                  <td className="p-3 text-gray-500">{log.table_name}</td>
                </tr>
                {expandedId === log.id && (
                  <tr className="border-t dark:border-gray-700 bg-gray-50 dark:bg-gray-900/30">
                    <td colSpan={5} className="p-4 grid grid-cols-2 gap-4 text-xs">
                      <div>
                        <span className="font-semibold text-gray-500">OLD VALUES:</span>
                        <pre className="mt-1 p-2 bg-white dark:bg-gray-800 rounded border dark:border-gray-700 overflow-auto max-h-32">{JSON.stringify(log.old_values, null, 2) || 'null'}</pre>
                      </div>
                      <div>
                        <span className="font-semibold text-gray-500">NEW VALUES:</span>
                        <pre className="mt-1 p-2 bg-white dark:bg-gray-800 rounded border dark:border-gray-700 overflow-auto max-h-32">{JSON.stringify(log.new_values, null, 2) || 'null'}</pre>
                      </div>
                    </td>
                  </tr>
                )}
              </>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}