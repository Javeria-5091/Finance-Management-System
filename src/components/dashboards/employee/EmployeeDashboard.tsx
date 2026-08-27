'use client';
import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/context/AuthContext";
import { useTheme } from "@/context/ThemeContext";
import { Wallet, FileText, Clock, CheckCircle, AlertCircle } from "lucide-react";
import { StatCard } from "../shared/StatCard";

export function EmployeeDashboard() {
  const { user } = useAuth();
  const { isDark } = useTheme();
  const [myExpenses, setMyExpenses] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user) return;
    const fetchData = async () => {
      try {
        const { data, error } = await supabase
          .from('expenses')
          .select('*')
          .eq('created_by', user.id)
          .order('created_at', { ascending: false });
        if (data) setMyExpenses(data);
      } catch (err) {
        console.error('EmployeeDashboard fetch error:', err);
      } finally {
        setLoading(false);
      }
    };
    fetchData();
  }, [user]);

  const pending = myExpenses.filter(e => e.status === 'DRAFT' || e.status === 'SUBMITTED').length;
  const approved = myExpenses.filter(e => e.status === 'APPROVED' || e.status === 'POSTED').length;
  const totalAmount = myExpenses.reduce((sum, e) => sum + (e.amount || 0), 0);
  const pendingAmount = myExpenses
    .filter(e => e.status === 'DRAFT' || e.status === 'SUBMITTED')
    .reduce((sum, e) => sum + (e.amount || 0), 0);
  const fmtPKR = (n: number) => new Intl.NumberFormat("en-PK", { style: "currency", currency: "PKR", minimumFractionDigits: 0 }).format(n);

  if (loading) return <div className={`flex h-screen items-center justify-center ${isDark ? 'bg-gray-950' : 'bg-gray-50'} text-gray-500`}>Loading Dashboard...</div>;

  return (
    <div className={`space-y-6 p-6 pb-8 min-h-screen transition-colors duration-300 ${isDark ? 'bg-gray-950' : 'bg-gray-50'}`}>
      {/* Header */}
      <div className={`relative h-36 rounded-3xl overflow-hidden shadow-2xl flex items-center p-8 border ${isDark ? 'bg-gradient-to-r from-gray-900 to-slate-900 border-gray-800' : 'bg-gradient-to-r from-indigo-500 to-blue-600 border-indigo-400'}`}>
        <div className="relative z-10">
          <span className="text-xs font-bold uppercase tracking-widest text-indigo-100">Employee Portal</span>
          <h1 className="text-3xl font-extrabold text-white mt-1">My Dashboard</h1>
        </div>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard title="Pending Approvals" value={pending.toString()} color="text-orange-600" bg="bg-orange-100 dark:bg-orange-500/10" icon={Clock} isDark={isDark} />
        <StatCard title="Approved" value={approved.toString()} color="text-emerald-600" bg="bg-emerald-100 dark:bg-emerald-500/10" icon={CheckCircle} isDark={isDark} />
        <StatCard title="Total Expenses" value={fmtPKR(totalAmount)} color="text-blue-600" bg="bg-blue-100 dark:bg-blue-500/10" icon={Wallet} isDark={isDark} />
        <StatCard title="Pending Amount" value={fmtPKR(pendingAmount)} color="text-red-600" bg="bg-red-100 dark:bg-red-500/10" icon={AlertCircle} isDark={isDark} />
      </div>

      {/* Recent Expenses Table */}
      <div className={`rounded-2xl p-5 border ${isDark ? 'bg-gray-900/60 border-gray-800' : 'bg-white border-gray-200 shadow-sm'}`}>
        <h3 className={`font-bold mb-4 ${isDark ? 'text-white' : 'text-gray-800'}`}>My Recent Expenses</h3>
        <table className="w-full text-sm text-left">
          <thead className="text-xs text-gray-500 uppercase border-b dark:border-gray-700">
            <tr><th className="p-2">Purpose</th><th className="p-2">Date</th><th className="p-2 text-right">Amount</th><th className="p-2">Status</th></tr>
          </thead>
          <tbody className="divide-y dark:divide-gray-700">
            {myExpenses.length === 0 ? (
              <tr><td colSpan={4} className="p-4 text-center text-gray-400">No expenses submitted yet</td></tr>
            ) : myExpenses.slice(0, 10).map((e: any) => (
              <tr key={e.id} className="hover:bg-gray-50 dark:hover:bg-gray-800/50">
                <td className="p-2 text-gray-800 dark:text-white">{e.notes || e.description || '-'}</td>
                <td className="p-2 text-gray-500">{e.expense_date || e.created_at?.split('T')[0]}</td>
                <td className="p-2 text-right font-mono">{fmtPKR(e.amount)}</td>
                <td className="p-2"><span className={`text-xs px-2 py-1 rounded-full ${
                  e.status === 'POSTED' ? 'bg-emerald-100 text-emerald-700' :
                  e.status === 'APPROVED' ? 'bg-blue-100 text-blue-700' :
                  e.status === 'SUBMITTED' ? 'bg-amber-100 text-amber-700' :
                  'bg-gray-100 text-gray-700'
                }`}>{e.status}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}