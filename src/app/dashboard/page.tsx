"use client";
import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/context/AuthContext";
import { Project, Income, Expense } from "@/types";
import { 
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, 
  ResponsiveContainer, PieChart, Pie, Cell 
} from "recharts";
import type { PieLabelRenderProps } from "recharts";

export default function DashboardPage() {
  const { user } = useAuth(); // 
  const [projects, setProjects] = useState<Project[]>([]);
  const [incomes, setIncomes] = useState<Income[]>([]);
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [loading, setLoading] = useState(true);

  // DATA FETCH
  useEffect(() => {
    if (!user) return;
    
    async function fetchData() {
     
      const [projRes, incRes, expRes] = await Promise.all([
        supabase.from("projects").select("*"),
        supabase.from("incomes").select("*").order("income_date", { ascending: false }),
        supabase.from("expenses").select("*").order("expense_date", { ascending: false }),
      ]);

      if (projRes.data) setProjects(projRes.data);
      if (incRes.data) setIncomes(incRes.data);
      if (expRes.data) setExpenses(expRes.data);
      setLoading(false);
    }
    fetchData();
  }, [user]);

  // MATH / CALCULATIONS
  const totalIncome = incomes.reduce((sum, inc) => sum + inc.amount, 0);
  const totalExpenses = expenses.reduce((sum, exp) => sum + exp.amount, 0);
  const netProfit = totalIncome - totalExpenses;
  
  const activeProjects = projects.filter(p => p.status === "Active").length;
  const completedProjects = projects.filter(p => p.status === "Completed").length;

  // Current Month Data
  const now = new Date();
  const currentMonth = now.getMonth();
  const currentYear = now.getFullYear();
  
  const monthlyIncome = incomes.filter(i => {
    const d = new Date(i.income_date);
    return d.getMonth() === currentMonth && d.getFullYear() === currentYear;
  }).reduce((sum, i) => sum + i.amount, 0);

  const monthlyExpenses = expenses.filter(e => {
    const d = new Date(e.expense_date);
    return d.getMonth() === currentMonth && d.getFullYear() === currentYear;
  }).reduce((sum, e) => sum + e.amount, 0);

  // CHARTS DATA PREPARATION
  const barChartData = [];
  for (let i = 5; i >= 0; i--) {
    const date = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const monthStr = date.toLocaleString('default', { month: 'short' });
    const m = date.getMonth();
    const y = date.getFullYear();
    
    const mIncome = incomes.filter(inc => { 
      const d = new Date(inc.income_date); 
      return d.getMonth() === m && d.getFullYear() === y; 
    }).reduce((s, i) => s + i.amount, 0);
    
    const mExpense = expenses.filter(exp => { 
      const d = new Date(exp.expense_date); 
      return d.getMonth() === m && d.getFullYear() === y; 
    }).reduce((s, e) => s + e.amount, 0);
    
    barChartData.push({ name: monthStr, Income: mIncome, Expenses: mExpense });
  }

  const expenseCategoryMap: Record<string, number> = {};
  expenses.forEach(e => {
    expenseCategoryMap[e.category] = (expenseCategoryMap[e.category] || 0) + e.amount;
  });
  const pieChartData = Object.entries(expenseCategoryMap).map(([name, value]) => ({ name, value }));
  const PIE_COLORS = ["#3b82f6", "#ef4444", "#10b981", "#f59e0b", "#8b5cf6", "#ec4899"];

  function formatCurrency(amount: number) {
    return new Intl.NumberFormat("en-PK", { 
      style: "currency", 
      currency: "PKR", 
      minimumFractionDigits: 0 
    }).format(amount);
  }

  const tooltipFormatter = (value: unknown): string => {
    return formatCurrency(Number(value));
  };

  const renderPieLabel = (props: PieLabelRenderProps): string => {
    const { name, percent } = props;
    const percentValue = typeof percent === 'number' ? percent : 0;
    return `${name || ''} (${(percentValue * 100).toFixed(0)}%)`;
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64 text-gray-400">
        Loading Analytics...
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <h2 className="text-2xl font-bold text-white">Finance Analytics</h2>

      {/* STAT CARDS */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard title="Total Income" value={formatCurrency(totalIncome)} color="text-green-400" bg="bg-green-500/10" />
        <StatCard title="Total Expenses" value={formatCurrency(totalExpenses)} color="text-red-400" bg="bg-red-500/10" />
        <StatCard
          title="Net Profit"
          value={formatCurrency(netProfit)}
          color={netProfit >= 0 ? "text-blue-400" : "text-red-400"}
          bg={netProfit >= 0 ? "bg-blue-500/10" : "bg-red-500/10"}
        />
        <StatCard title="Total Projects" value={projects.length.toString()} color="text-purple-400" bg="bg-purple-500/10" />
        <StatCard title="Active Projects" value={activeProjects.toString()} color="text-yellow-400" bg="bg-yellow-500/10" />
        <StatCard title="Completed Projects" value={completedProjects.toString()} color="text-cyan-400" bg="bg-cyan-500/10" />
        <StatCard title="Monthly Revenue" value={formatCurrency(monthlyIncome)} color="text-green-400" bg="bg-green-500/10" />
        <StatCard title="Monthly Expenses" value={formatCurrency(monthlyExpenses)} color="text-red-400" bg="bg-red-500/10" />
      </div>

      {/* CHARTS ROW */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* BAR CHART */}
        <div className="lg:col-span-2 bg-gray-800 border border-gray-700 rounded-xl p-4">
          <h3 className="text-lg font-semibold text-white mb-4">Income vs Expenses (Last 6 Months)</h3>
          {barChartData.some(d => d.Income > 0 || d.Expenses > 0) ? (
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={barChartData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
                <XAxis dataKey="name" stroke="#9ca3af" />
                <YAxis stroke="#9ca3af" />
                <Tooltip
                  contentStyle={{ backgroundColor: "#1f2937", border: "1px solid #374151", borderRadius: "8px", color: "#f9fafb" }}
                  formatter={tooltipFormatter}
                />
                <Bar dataKey="Income" fill="#10b981" radius={[4, 4, 0, 0]} />
                <Bar dataKey="Expenses" fill="#ef4444" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <div className="h-[300px] flex items-center justify-center text-gray-500">No data for charts yet</div>
          )}
        </div>

        {/* PIE CHART */}
        <div className="bg-gray-800 border border-gray-700 rounded-xl p-4">
          <h3 className="text-lg font-semibold text-white mb-4">Expenses by Category</h3>
          {pieChartData.length > 0 ? (
            <ResponsiveContainer width="100%" height={300}>
              <PieChart>
                <Pie data={pieChartData} cx="50%" cy="50%" outerRadius={100} dataKey="value" label={renderPieLabel}>
                  {pieChartData.map((_, index) => (
                    <Cell key={`cell-${index}`} fill={PIE_COLORS[index % PIE_COLORS.length]} />
                  ))}
                </Pie>
                <Tooltip
                  contentStyle={{ backgroundColor: "#1f2937", border: "1px solid #374151", borderRadius: "8px", color: "#f9fafb" }}
                  formatter={tooltipFormatter}
                />
              </PieChart>
            </ResponsiveContainer>
          ) : (
            <div className="h-[300px] flex items-center justify-center text-gray-500">No expenses yet</div>
          )}
        </div>
      </div>
    </div>
  );
}

function StatCard({ title, value, color, bg }: { title: string; value: string; color: string; bg: string }) {
  return (
    <div className="bg-gray-800 border border-gray-700 rounded-xl p-4">
      <p className="text-sm text-gray-400">{title}</p>
      <p className={`text-2xl font-bold mt-1 ${color}`}>{value}</p>
    </div>
  );
}