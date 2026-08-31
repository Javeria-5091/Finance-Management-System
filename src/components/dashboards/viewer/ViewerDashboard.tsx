'use client';
import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/context/AuthContext";
import { useTheme } from "@/context/ThemeContext";
import { StatCard } from "../shared/StatCard";
import { TrendingUp, TrendingDown, Clock, CheckCircle, XCircle } from "lucide-react";

export function ViewerDashboard() {
  const { user } = useAuth();
  const { isDark } = useTheme();
  const [myExpenses, setMyExpenses] = useState<any[]>([]);
  const [myIncomes, setMyIncomes] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user) return;
    const fetchData = async () => {
      const [expRes, incRes] = await Promise.all([
        supabase.from("expenses").select("*").eq("user_id", user.id).order("expense_date", { ascending: false }).limit(10),
        supabase.from("incomes").select("*").eq("created_by", user.id).order("income_date", { ascending: false }).limit(10)
      ]);
      if (expRes.data) setMyExpenses(expRes.data);
      if (incRes.data) setMyIncomes(incRes.data);
      setLoading(false);
    };
    fetchData();
  }, [user]);

  const fmtPKR = (n: number) => new Intl.NumberFormat("en-PK", { style: "currency", currency: "PKR", minimumFractionDigits: 0 }).format(n);
  
  const totalExp = myExpenses.reduce((s, e) => s + e.amount, 0);
  const totalInc = myIncomes.reduce((s, i) => s + i.amount, 0);
  const pendingCount = myExpenses.filter(e => e.status === 'DRAFT' || e.status === 'SUBMITTED').length;

  if (loading) return <div className="flex h-screen items-center justify-center bg-gray-50 dark:bg-gray-950 text-gray-500">Loading your data...</div>;

  return (
    <div className={`space-y-6 p-6 pb-8 transition-colors duration-300 ${isDark ? 'bg-gray-950' : 'bg-gray-50'}`}>
      <div className={`relative h-36 rounded-3xl overflow-hidden shadow-2xl flex items-center p-8 border ${isDark ? 'bg-gradient-to-r from-gray-900 to-slate-900 border-gray-800' : 'bg-gradient-to-r from-gray-500 to-gray-600 border-gray-400'}`}>
        <div className="relative z-10">
          <span className="text-xs font-bold uppercase tracking-widest text-gray-200">Welcome Back</span>
          <h1 className="text-3xl font-extrabold text-white mt-1">My Dashboard</h1>
          <p className="text-gray-200 mt-1 text-sm">View your submitted requests and recent activity.</p>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <StatCard title="Pending Approvals" value={pendingCount.toString()} color="text-amber-600" bg="bg-amber-100 dark:bg-amber-500/10" icon={Clock} isDark={isDark} />
        <StatCard title="My Expenses (Recent)" value={fmtPKR(totalExp)} color="text-red-600" bg="bg-red-100 dark:bg-rose-500/10" icon={TrendingDown} isDark={isDark} />
        <StatCard title="My Income (Recent)" value={fmtPKR(totalInc)} color="text-emerald-600" bg="bg-emerald-100 dark:bg-emerald-500/10" icon={TrendingUp} isDark={isDark} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Recent Expenses Table */}
        <div className={`rounded-2xl p-5 border ${isDark ? 'bg-gray-900/60 border-gray-800' : 'bg-white border-gray-200 shadow-sm'}`}>
          <h3 className={`font-bold mb-4 ${isDark ? 'text-white' : 'text-gray-800'}`}>My Recent Expenses</h3>
          <div className="space-y-3">
            {myExpenses.length === 0 ? <p className="text-sm text-gray-400 text-center py-4">No expenses submitted</p> : 
            myExpenses.map(e => (
              <div key={e.id} className={`flex items-center justify-between p-3 rounded-lg border ${isDark ? 'border-gray-800 bg-gray-800/30' : 'border-gray-100'}`}>
                <div>
                  <p className="font-medium text-sm text-gray-800 dark:text-white">{e.title}</p>
                  <p className="text-xs text-gray-500">{e.expense_date} • {e.category}</p>
                </div>
                <div className="text-right flex items-center gap-3">
                  <span className="font-mono text-sm font-bold text-red-600">{fmtPKR(e.amount)}</span>
                  <StatusBadge status={e.status} />
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Recent Incomes Table */}
        <div className={`rounded-2xl p-5 border ${isDark ? 'bg-gray-900/60 border-gray-800' : 'bg-white border-gray-200 shadow-sm'}`}>
          <h3 className={`font-bold mb-4 ${isDark ? 'text-white' : 'text-gray-800'}`}>My Recent Incomes</h3>
          <div className="space-y-3">
            {myIncomes.length === 0 ? <p className="text-sm text-gray-400 text-center py-4">No income records</p> : 
            myIncomes.map(i => (
              <div key={i.id} className={`flex items-center justify-between p-3 rounded-lg border ${isDark ? 'border-gray-800 bg-gray-800/30' : 'border-gray-100'}`}>
                <div>
                  <p className="font-medium text-sm text-gray-800 dark:text-white">{i.title}</p>
                  <p className="text-xs text-gray-500">{i.income_date} • {i.category}</p>
                </div>
                <div className="text-right flex items-center gap-3">
                  <span className="font-mono text-sm font-bold text-emerald-600">{fmtPKR(i.amount)}</span>
                  <StatusBadge status={i.status} />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// Helper Component for Status Badges
function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    'POSTED': 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400',
    'APPROVED': 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
    'PAID': 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400',
    'SUBMITTED': 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
    'DRAFT': 'bg-gray-100 text-gray-700 dark:bg-gray-800 text-gray-400',
    'REJECTED': 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400'
  };
  
  const icons: Record<string, any> = {
    'POSTED': CheckCircle, 'APPROVED': CheckCircle, 'PAID': CheckCircle,
    'SUBMITTED': Clock, 'DRAFT': Clock, 'REJECTED': XCircle
  };

  const Icon = icons[status] || Clock;
  
  return (
    <span className={`text-xs px-2 py-1 rounded-full flex items-center gap-1 font-medium ${styles[status] || 'bg-gray-100 text-gray-700'}`}>
      <Icon className="w-3 h-3" />
      {status}
    </span>
  );
}