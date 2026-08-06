'use client';
import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { useTheme } from "@/context/ThemeContext";
import { StatCard } from "../shared/StatCard";
import { FileText, CheckCircle, Clock, AlertCircle } from "lucide-react";

export function AccountantDashboard() {
  const { isDark } = useTheme();
  const [stats, setStats] = useState({ draft: 0, submitted: 0, verified: 0, posted: 0 });
  const [recentJournals, setRecentJournals] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchData = async () => {
      try {
        // ✅ FIXED: Use finance.journal_entries (schema.table), not journal_entries
        const [countRes, listRes] = await Promise.all([
          supabase.from('journal_entries').select('status'),
          supabase.from('journal_entries').select('reference, description, status, transaction_date, total_debit').order('created_at', { ascending: false }).limit(5)
        ]);

        if (countRes.data) {
          const d = countRes.data;
          setStats({
            draft: d.filter((j: any) => j.status === 'DRAFT').length,
            submitted: d.filter((j: any) => j.status === 'SUBMITTED').length,
            verified: d.filter((j: any) => j.status === 'VERIFIED').length,
            posted: d.filter((j: any) => j.status === 'POSTED').length,
          });
        }
        if (listRes.data) setRecentJournals(listRes.data);
      } catch (err) {
        console.error('AccountantDashboard fetch error:', err);
      } finally {
        setLoading(false);
      }
    };
    fetchData();
  }, []);

  const fmtPKR = (n: number) => new Intl.NumberFormat("en-PK", { style: "currency", currency: "PKR", minimumFractionDigits: 0 }).format(n);

  if (loading) return <div className={`flex h-screen items-center justify-center ${isDark ? 'bg-gray-950' : 'bg-gray-50'} text-gray-500`}>Loading Accounting Data...</div>;

  return (
    <div className={`space-y-6 p-6 pb-8 transition-colors duration-300 ${isDark ? 'bg-gray-950' : 'bg-gray-50'}`}>
      <div className={`relative h-36 rounded-3xl overflow-hidden shadow-2xl flex items-center p-8 border ${isDark ? 'bg-gradient-to-r from-gray-900 to-slate-900 border-gray-800' : 'bg-gradient-to-r from-teal-500 to-cyan-600 border-teal-400'}`}>
        <div className="relative z-10">
          <span className="text-xs font-bold uppercase tracking-widest text-teal-100">Accounting Module</span>
          <h1 className="text-3xl font-extrabold text-white mt-1">Journal & Ledger Queue</h1>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard title="Drafts" value={stats.draft.toString()} color="text-gray-600" bg="bg-gray-100 dark:bg-gray-500/10" icon={FileText} isDark={isDark} />
        <StatCard title="Pending Verify" value={stats.submitted.toString()} color="text-orange-600" bg="bg-orange-100 dark:bg-orange-500/10" icon={Clock} isDark={isDark} />
        <StatCard title="Pending Approval" value={stats.verified.toString()} color="text-blue-600" bg="bg-blue-100 dark:bg-sky-500/10" icon={AlertCircle} isDark={isDark} />
        <StatCard title="Posted (GL)" value={stats.posted.toString()} color="text-emerald-600" bg="bg-emerald-100 dark:bg-emerald-500/10" icon={CheckCircle} isDark={isDark} />
      </div>

      <div className={`rounded-2xl p-5 border ${isDark ? 'bg-gray-900/60 border-gray-800' : 'bg-white border-gray-200 shadow-sm'}`}>
        <h3 className={`font-bold mb-4 ${isDark ? 'text-white' : 'text-gray-800'}`}>Recent Journal Entries</h3>
        <table className="w-full text-sm text-left">
          <thead className="text-xs text-gray-500 uppercase border-b dark:border-gray-700">
            <tr><th className="p-2">Ref</th><th className="p-2">Description</th><th className="p-2">Date</th><th className="p-2 text-right">Amount</th><th className="p-2">Status</th></tr>
          </thead>
          <tbody className="divide-y dark:divide-gray-700">
            {recentJournals.length === 0 ? <tr><td colSpan={5} className="p-4 text-center text-gray-400">No journals found</td></tr> :
            recentJournals.map(j => (
              <tr key={j.id} className="hover:bg-gray-50 dark:hover:bg-gray-800/50">
                <td className="p-2 font-mono text-blue-500">{j.reference}</td>
                <td className="p-2 text-gray-800 dark:text-white">j.description</td>
                <td className="p-2 text-gray-500">{j.transaction_date}</td>
                <td className="p-2 text-right font-mono">{fmtPKR(j.total_debit)}</td>
                <td className="p-2"><span className={`text-xs px-2 py-1 rounded-full ${
                  j.status === 'POSTED' ? 'bg-emerald-100 text-emerald-700' :
                  j.status === 'DRAFT' ? 'bg-gray-100 text-gray-700' : 'bg-amber-100 text-amber-700'
                }`}>{j.status}</span></td>
              </tr>
            ))
            }
          </tbody>
        </table>
      </div>
    </div>
  );
}