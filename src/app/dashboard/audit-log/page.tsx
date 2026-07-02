"use client";
import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/context/AuthContext";
import { AuditLog } from "@/types";

export default function AuditLogPage() {
  const { user } = useAuth();
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user) return;
    async function fetchLogs() {
      const { data } = await supabase
        .from("audit_logs")
        .select("*")
        .eq("user_id", user.id)
        .order("created_at", { ascending: false })
        .limit(100); // Last 100 records

      if (data) setLogs(data);
      setLoading(false);
    }
    fetchLogs();
  }, [user]);

  function getModuleColor(module: string) {
    if (module === "Auth") return "bg-purple-500/20 text-purple-400";
    if (module === "Project") return "bg-blue-500/20 text-blue-400";
    if (module === "Income") return "bg-green-500/20 text-green-400";
    if (module === "Expense") return "bg-red-500/20 text-red-400";
    if (module === "Invoice") return "bg-yellow-500/20 text-yellow-400";
    return "bg-gray-500/20 text-gray-400";
  }

  return (
    <div>
      <div className="mb-6">
        <h2 className="text-2xl font-bold text-white">Audit Log</h2>
        <p className="text-gray-400 text-sm">Track all activities and changes</p>
      </div>

      <div className="bg-gray-800 border border-gray-700 rounded-xl overflow-hidden">
        <table className="w-full text-left">
          <thead className="border-b border-gray-700 bg-gray-900/50">
            <tr>
              <th className="px-4 py-3 text-xs font-medium text-gray-400 uppercase">Action</th>
              <th className="px-4 py-3 text-xs font-medium text-gray-400 uppercase">Module</th>
              <th className="px-4 py-3 text-xs font-medium text-gray-400 uppercase hidden md:table-cell">Details</th>
              <th className="px-4 py-3 text-xs font-medium text-gray-400 uppercase text-right">Timestamp</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-700">
            {loading && <tr><td colSpan={4} className="px-4 py-8 text-center text-gray-400">Loading...</td></tr>}
            {!loading && logs.length === 0 && <tr><td colSpan={4} className="px-4 py-12 text-center text-gray-400">No activities recorded yet.</td></tr>}
            
            {logs.map(log => (
              <tr key={log.id} className="hover:bg-gray-700/50 transition-colors">
                <td className="px-4 py-3 font-medium text-white">{log.action}</td>
                <td className="px-4 py-3">
                  <span className={`text-xs px-2 py-1 rounded ${getModuleColor(log.module)}`}>
                    {log.module}
                  </span>
                </td>
                <td className="px-4 py-3 text-gray-400 text-sm hidden md:table-cell max-w-[300px] truncate cursor-help" title={log.details || ""}>
                  {log.details || "-"}
                </td>
                <td className="px-4 py-3 text-gray-500 text-right text-sm whitespace-nowrap">
                  {new Date(log.created_at).toLocaleString("en-PK", {
                    day: "2-digit",
                    month: "short",
                    year: "numeric",
                    hour: "2-digit",
                    minute: "2-digit"
                  })}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}