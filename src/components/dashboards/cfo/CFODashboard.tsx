'use client';
import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { useTheme } from "@/context/ThemeContext";
import { reportService } from "../../../services/report.service";
import { StatCard } from "../shared/StatCard";
import { CheckCircle, XCircle, AlertTriangle, FileText, Wallet } from "lucide-react";

export function CFODashboard() {
  const { isDark } = useTheme();
  const [metrics, setMetrics] = useState({ total_cash: 0, total_receivables: 0, total_payables: 0, current_month_pl: 0 });
  const [reconStatus, setReconStatus] = useState<any[]>([]);
  const [pendingJournals, setPendingJournals] = useState(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchData = async () => {
      const [mRes, rRes, jRes] = await Promise.all([
        reportService.getCEOMetrics(),
        supabase.from('reconciliation_summary').select('*').eq('is_active', true),
        supabase.from('journal_entries').select('id', { count: 'exact', head: true }).in('status', ['DRAFT', 'SUBMITTED', 'VERIFIED'])
      ]);
      if (mRes) setMetrics(mRes);
      if (rRes?.data) setReconStatus(rRes.data);
      if (jRes?.count) setPendingJournals(jRes.count);
      setLoading(false);
    };
    fetchData();
  }, []);

  const fmtPKR = (n: number) => new Intl.NumberFormat("en-PK", { style: "currency", currency: "PKR", minimumFractionDigits: 0 }).format(n);
  const reconOk = reconStatus.filter(r => r.reconciliation_pct === 100).length;
  const reconTotal = reconStatus.length;

  if (loading) return <div className="flex h-screen items-center justify-center bg-gray-50 dark:bg-gray-950 text-gray-500">Loading Finance Analytics...</div>;

  return (
    <div className={`space-y-6 p-6 pb-8 transition-colors duration-300 ${isDark ? 'bg-gray-950' : 'bg-gray-50'}`}>
      <div className={`relative h-36 rounded-3xl overflow-hidden shadow-2xl flex items-center p-8 border ${isDark ? 'bg-gradient-to-r from-slate-900 to-gray-900 border-gray-800' : 'bg-gradient-to-r from-purple-600 to-indigo-600 border-purple-400'}`}>
        <div className="relative z-10">
          <span className="text-xs font-bold uppercase tracking-widest text-purple-200">CFO Portal</span>
          <h1 className="text-3xl font-extrabold text-white mt-1">Finance Control Center</h1>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
        <StatCard title="Cash Position" value={fmtPKR(metrics.total_cash)} color="text-emerald-600" bg="bg-emerald-100 dark:bg-emerald-500/10" icon={Wallet} isDark={isDark} />
        <StatCard title="Receivables" value={fmtPKR(metrics.total_receivables)} color="text-orange-600" bg="bg-orange-100 dark:bg-orange-500/10" icon={AlertTriangle} isDark={isDark} />
        <StatCard title="Payables" value={fmtPKR(metrics.total_payables)} color="text-red-600" bg="bg-red-100 dark:bg-rose-500/10" icon={XCircle} isDark={isDark} />
        <StatCard title="Pending Journals" value={pendingJournals.toString()} color="text-blue-600" bg="bg-blue-100 dark:bg-sky-500/10" icon={FileText} isDark={isDark} />
        <StatCard title="Recon Status" value={`${reconOk}/${reconTotal} Done`} color="text-purple-600" bg="bg-purple-100 dark:bg-purple-500/10" icon={CheckCircle} isDark={isDark} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className={`rounded-2xl p-5 border ${isDark ? 'bg-gray-900/60 border-gray-800' : 'bg-white border-gray-200 shadow-sm'}`}>
          <h3 className={`font-bold mb-4 ${isDark ? 'text-white' : 'text-gray-800'}`}>Bank Reconciliation Status</h3>
          <div className="space-y-3">
            {reconStatus.length === 0 ? <p className="text-sm text-gray-400">No financial accounts configured</p> : reconStatus.map((acc: any) => (
              <div key={acc.id} className="flex items-center justify-between p-3 rounded-lg bg-gray-50 dark:bg-gray-800/50">
                <div>
                  <p className="font-medium text-sm text-gray-800 dark:text-white">{acc.account_name}</p>
                  <p className="text-xs text-gray-500">{acc.currency} - {acc.masked_identifier || 'N/A'}</p>
                </div>
                <div className="text-right">
                  <p className="font-mono text-sm font-bold">{fmtPKR(acc.ledger_balance)}</p>
                  <span className={`text-xs px-2 py-0.5 rounded-full ${acc.reconciliation_pct === 100 ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'}`}>
                    {acc.reconciliation_pct}% Matched
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className={`rounded-2xl p-5 border ${isDark ? 'bg-gray-900/60 border-gray-800' : 'bg-white border-gray-200 shadow-sm'}`}>
          <h3 className={`font-bold mb-4 ${isDark ? 'text-white' : 'text-gray-800'}`}>Current Month P&L</h3>
          <div className="flex flex-col items-center justify-center h-full">
            <p className="text-4xl font-extrabold text-blue-600">{fmtPKR(metrics.current_month_pl)}</p>
            <p className="text-sm text-gray-500 mt-2">Profit / (Loss) for this month based on GL</p>
          </div>
        </div>
      </div>
    </div>
  );
}