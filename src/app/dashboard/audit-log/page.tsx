"use client";
import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/context/AuthContext";
import { AuditLog } from "@/types";
import { Search, Filter } from "lucide-react";

export default function AuditLogPage() {
  const { user } = useAuth();
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [limit, setLimit] = useState(20);
  
  // Search & Filter States
  const [search, setSearch] = useState("");
  const [moduleFilter, setModuleFilter] = useState("All");

  // FIXED: Dono useEffects ko separate kiya aur brackets ki nesting theek ki
  useEffect(() => {
    // Agar user null hai to yahin se block kar do
    if (!user || !user.id) return;

    // FIXED: TypeScript user protection ke liye id ko locally scope kiya
    const userId = user.id;

    async function fetchLogs() {
      const { data } = await supabase
        .from("audit_logs")
        .select("*")
        .eq("user_id", userId) // Fixed safely
        .order("created_at", { ascending: false })
        .limit(limit); 

      if (data) {
        if (limit === 20) setLogs(data); 
        else setLogs(prev => [...prev, ...data]); // Baad mein append karo
      }
      setLoading(false);
    }

    fetchLogs();
  }, [user, limit]); // Fixed dependencies and cleanly closed hook

  // Unique modules dynamically nikalo
  const modules = ["All", ...Array.from(new Set(logs.map(l => l.module)))];

  // Filter Logic
  const filteredLogs = logs.filter(log => {
    const matchesSearch = 
      log.action.toLowerCase().includes(search.toLowerCase()) ||
      (log.details && log.details.toLowerCase().includes(search.toLowerCase())) || // Fixed optional chaining safely
      log.module.toLowerCase().includes(search.toLowerCase());
      
    const matchesModule = moduleFilter === "All" || log.module === moduleFilter;
    
    return matchesSearch && matchesModule;
  });

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

      {/* SEARCH & FILTER BAR */}
      <div className="bg-gray-800 border border-gray-700 rounded-xl p-4 mb-6">
        <div className="flex flex-col sm:flex-row gap-4">
          {/* Search */}
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
            <input
              type="text"
              placeholder="Search actions, details..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="w-full pl-9 pr-4 py-2.5 bg-gray-900 border border-gray-700 rounded-lg text-white text-sm placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          
          {/* Module Filter */}
          <div className="relative sm:w-48">
            <Filter className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
            <select 
              value={moduleFilter} 
              onChange={e => setModuleFilter(e.target.value)}
              className="w-full pl-9 pr-4 py-2.5 bg-gray-900 border border-gray-700 rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 appearance-none"
            >
              {modules.map(m => <option key={m} value={m}>{m === "All" ? "All Modules" : m}</option>)}
            </select>
          </div>
        </div>
      </div>

      {/* TABLE */}
      <div className="bg-gray-800 border border-gray-700 rounded-xl overflow-hidden">
        <table className="w-full text-left">
          <thead className="border-b border-gray-700 bg-gray-900/50">
            <tr>
              <th className="px-4 py-3 text-xs font-medium text-gray-400 uppercase">User</th>
              <th className="px-4 py-3 text-xs font-medium text-gray-400 uppercase">Action</th>
              <th className="px-4 py-3 text-xs font-medium text-gray-400 uppercase">Module</th>
              <th className="px-4 py-3 text-xs font-medium text-gray-400 uppercase hidden lg:table-cell">Details</th>
              <th className="px-4 py-3 text-xs font-medium text-gray-400 uppercase text-right">Timestamp</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-700">
            {loading && <tr><td colSpan={5} className="px-4 py-8 text-center text-gray-400">Loading...</td></tr>}
            {!loading && filteredLogs.length === 0 && <tr><td colSpan={5} className="px-4 py-12 text-center text-gray-400">No activities found.</td></tr>}
            
            {!loading && filteredLogs.map(log => (
              <tr key={log.id} className="hover:bg-gray-700/50 transition-colors">
                {/* USER EMAIL */}
                <td className="px-4 py-3">
                  <div className="text-sm text-white font-medium">{user?.email || "Unknown"}</div>
                </td>
                
                {/* ACTION */}
                <td className="px-4 py-3">
                  <div className="text-sm text-white">{log.action}</div>
                </td>
                
                {/* MODULE */}
                <td className="px-4 py-3">
                  <span className={`text-xs px-2 py-1 rounded whitespace-nowrap ${getModuleColor(log.module)}`}>
                    {log.module}
                  </span>
                </td>
                
                {/* DETAILS */}
                <td className="px-4 py-3 text-gray-400 text-sm hidden lg:table-cell max-w-[300px] truncate cursor-help" title={log.details || ""}>
                  {log.details || "-"}
                </td>
                
                {/* TIMESTAMP */}
                <td className="px-4 py-3 text-gray-500 text-sm text-right whitespace-nowrap">
                  {new Date(log.created_at).toLocaleString("en-PK", {
                    day: "2-digit",
                    month: "short",
                    year: "numeric",
                    hour: "2-digit",
                    minute: "2-digit",
                    second: "2-digit"
                  })}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        
        {/* YEH LOAD MORE BUTTON ADD KIYA */}
        {logs.length >= limit && (
          <div className="p-4 text-center border-t border-gray-700">
            <button 
              onClick={() => setLimit(prev => prev + 20)} 
              className="text-sm text-blue-400 hover:text-blue-300 font-medium"
            >
              Load More Logs
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
