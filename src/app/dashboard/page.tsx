"use client";
import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/context/AuthContext";
import { useTheme } from "@/context/ThemeContext"; // ✅ IMPORT
import { Project, Income, Expense, Budget } from "@/types"; 
import {
  Chart as ChartJS, CategoryScale, LinearScale, BarElement, LineElement,
  PointElement, ArcElement, Filler,
} from 'chart.js';
import { Bar, Line, Doughnut } from 'react-chartjs-2';

ChartJS.register(CategoryScale, LinearScale, BarElement, LineElement, PointElement, ArcElement, Filler);

import { TrendingUp, TrendingDown, DollarSign, FolderKanban, CheckCircle, Clock, Wallet, PieChart as PieIcon, AlertTriangle } from "lucide-react";
import { LucideIcon } from "lucide-react";

export default function DashboardPage() {
  const { user } = useAuth(); 
  const { isDark } = useTheme(); // ✅ THEME HOOK
  const [projects, setProjects] = useState<Project[]>([]);
  const [incomes, setIncomes] = useState<Income[]>([]);
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [budgets, setBudgets] = useState<Budget[]>([]); 
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user) return;
    async function fetchData() {
      const [projRes, incRes, expRes, budRes] = await Promise.all([
        supabase.from("projects").select("*"), supabase.from("incomes").select("*"),
        supabase.from("expenses").select("*"), supabase.from("budgets").select("*"),
      ]);
      if (projRes.data) setProjects(projRes.data);
      if (incRes.data) setIncomes(incRes.data);
      if (expRes.data) setExpenses(expRes.data);
      if (budRes.data) setBudgets(budRes.data);
      setLoading(false);
    }
    fetchData();
  }, [user]);

  // MATH & DATA PREP (Same as before)
  const totalIncome = incomes.reduce((sum, inc) => sum + inc.amount, 0);
  const totalExpenses = expenses.reduce((sum, exp) => sum + exp.amount, 0);
  const netProfit = totalIncome - totalExpenses;
  const activeProjects = projects.filter(p => p.status === "Active").length;
  const completedProjects = projects.filter(p => p.status === "Completed").length;
  const now = new Date();
  const currentMonth = now.getMonth();
  const currentYear = now.getFullYear();
  const monthlyIncome = incomes.filter(i => { const d = new Date(i.income_date); return d.getMonth() === currentMonth && d.getFullYear() === currentYear; }).reduce((sum, i) => sum + i.amount, 0);
  const monthlyExpenses = expenses.filter(e => { const d = new Date(e.expense_date); return d.getMonth() === currentMonth && d.getFullYear() === currentYear; }).reduce((sum, e) => sum + e.amount, 0);
  const totalBudget = budgets.reduce((sum, b) => sum + b.total_amount, 0);
  let usedBudget = 0; let overBudgetCount = 0;
  budgets.forEach(bud => {
    const linkedProjects = projects.filter(p => p.budget_id === bud.id);
    let budUsed = 0;
    linkedProjects.forEach(proj => { budUsed += expenses.filter(e => e.project_id === proj.id).reduce((sum, e) => sum + e.amount, 0); });
    usedBudget += budUsed;
    if (budUsed > bud.total_amount) overBudgetCount += linkedProjects.length; 
  });
  const remainingBudget = totalBudget - usedBudget;

  const barChartData = []; const expenseTrendData = [];
  for (let i = 5; i >= 0; i--) {
    const date = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const m = date.getMonth(); const y = date.getFullYear();
    const mI = incomes.filter(inc => { const d = new Date(inc.income_date); return d.getMonth() === m && d.getFullYear() === y; }).reduce((s, i) => s + i.amount, 0);
    const mE = expenses.filter(exp => { const d = new Date(exp.expense_date); return d.getMonth() === m && d.getFullYear() === y; }).reduce((s, e) => s + e.amount, 0);
    barChartData.push({ name: date.toLocaleString('default', { month: 'short' }), Income: mI, Expenses: mE });
    expenseTrendData.push({ name: date.toLocaleString('default', { month: 'short' }), Expenses: mE });
  }
  const expenseCategoryMap: Record<string, number> = {};
  expenses.forEach(e => { expenseCategoryMap[e.category] = (expenseCategoryMap[e.category] || 0) + e.amount; });
  const pieChartData = Object.entries(expenseCategoryMap).map(([name, value]) => ({ name, value }));
  const budgetVsActualData = budgets.map(bud => { const lp = projects.filter(p => p.budget_id === bud.id); let a = 0; lp.forEach(p => { a += expenses.filter(e => e.project_id === p.id).reduce((s, e) => s + e.amount, 0); }); return { name: bud.name.length > 12 ? bud.name.substring(0, 12)+'...' : bud.name, Allocated: bud.total_amount, Spent: a }; });
  const projectBudgetData = projects.filter(p => p.budget_id).map(proj => { const b = budgets.find(b => b.id === proj.budget_id); const s = expenses.filter(e => e.project_id === proj.id).reduce((sum, e) => sum + e.amount, 0); return { name: proj.name.length > 10 ? proj.name.substring(0, 10)+'...' : proj.name, Budget: b?.total_amount || 0, Spent: s }; });

  function formatCurrency(amount: number) { return new Intl.NumberFormat("en-PK", { style: "currency", currency: "PKR", minimumFractionDigits: 0 }).format(amount); }

  if (loading) return <div className="flex items-center justify-center h-64 text-gray-500">Loading Analytics...</div>;

  // ✅ DYNAMIC CHART COLORS (LIGHT/DARK AUTO DETECT)
  const textColor = isDark ? '#94a3b8' : '#64748b';
  const gridColor = isDark ? '#1e293b' : '#f1f5f9';
  const tooltipBg = isDark ? '#0f172a' : '#ffffff';
  const tooltipText = isDark ? '#e2e8f0' : '#1e293b';
  const centerTextColor = isDark ? '#ffffff' : '#111827';
  const centerSubTextColor = isDark ? '#94a3b8' : '#6b7280';

  const centerTextPlugin = {
    id: 'centerText',
    afterDraw(chart: any) {
      const { ctx, chartArea: { width, height, top, left } } = chart;
      ctx.save();
      const total = chart.data.datasets[0].data.reduce((a: number, b: number) => a + b, 0);
      ctx.font = 'bold 24px sans-serif'; ctx.fillStyle = centerTextColor; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('PKR ' + total.toLocaleString(), left + width / 2, top + height / 2 - 10);
      ctx.font = '12px sans-serif'; ctx.fillStyle = centerSubTextColor;
      ctx.fillText('Total Expenses', left + width / 2, top + height / 2 + 15);
      ctx.restore();
    }
  };

  const baseOptions = {
    responsive: true, maintainAspectRatio: false, layout: { padding: { bottom: 5 } },
    plugins: { legend: { display: false }, tooltip: { enabled: false } },
    scales: {
      x: { grid: { display: false }, ticks: { color: textColor, font: { size: 11 }, maxRotation: 0, autoSkip: true, maxTicksLimit: 6 }, border: { display: false } },
      y: { grid: { color: gridColor, drawBorder: false }, ticks: { color: textColor, font: { size: 11 }, callback: (value: any) => 'PKR ' + value.toLocaleString() }, border: { display: false } }
    }
  };

  // CHART DATASETS (Same as before)
  const forecastData = {
    labels: barChartData.map(d => d.name),
    datasets: [
      { label: 'Income', data: barChartData.map(d => d.Income), borderColor: '#3b82f6', backgroundColor: (ctx: any) => { const {chartArea} = ctx.chart; if(!chartArea) return 'transparent'; const g = ctx.chart.ctx.createLinearGradient(0, chartArea.top, 0, chartArea.bottom); g.addColorStop(0, 'rgba(59, 130, 246, 0.3)'); g.addColorStop(1, 'rgba(59, 130, 246, 0.0)'); return g; }, fill: true, tension: 0.4, pointRadius: 4, pointBackgroundColor: isDark ? '#0f172a' : '#ffffff', pointBorderColor: '#3b82f6', pointBorderWidth: 2, borderWidth: 3 },
      { label: 'Expenses', data: barChartData.map(d => d.Expenses), borderColor: '#ef4444', backgroundColor: (ctx: any) => { const {chartArea} = ctx.chart; if(!chartArea) return 'transparent'; const g = ctx.chart.ctx.createLinearGradient(0, chartArea.top, 0, chartArea.bottom); g.addColorStop(0, 'rgba(239, 68, 68, 0.3)'); g.addColorStop(1, 'rgba(239, 68, 68, 0.0)'); return g; }, fill: true, tension: 0.4, pointRadius: 4, pointBackgroundColor: isDark ? '#0f172a' : '#ffffff', pointBorderColor: '#ef4444', pointBorderWidth: 2, borderWidth: 3 }
    ]
  };
  const doughnutData = { labels: pieChartData.map(d => d.name), datasets: [{ data: pieChartData.map(d => d.value), backgroundColor: ['#6366f1', '#ec4899', '#10b981', '#f59e0b', '#3b82f6'], borderColor: isDark ? '#1f2937' : '#ffffff', borderWidth: 5, hoverOffset: 10 }] };
  const budgetVsActualChart = { labels: budgetVsActualData.map(d => d.name), datasets: [{ label: 'Allocated', data: budgetVsActualData.map(d => d.Allocated), backgroundColor: '#6366f1', borderRadius: 6, barPercentage: 0.6 }, { label: 'Spent', data: budgetVsActualData.map(d => d.Spent), backgroundColor: '#f97316', borderRadius: 6, barPercentage: 0.6 }] };
  const trendDataSet = { labels: expenseTrendData.map(d => d.name), datasets: [{ data: expenseTrendData.map(d => d.Expenses), borderColor: '#ef4444', backgroundColor: (ctx: any) => { const {chartArea} = ctx.chart; if(!chartArea) return '#ef4444'; const g = ctx.chart.ctx.createLinearGradient(0, chartArea.top, 0, chartArea.bottom); g.addColorStop(0, 'rgba(239, 68, 68, 0.4)'); g.addColorStop(1, 'rgba(239, 68, 68, 0.0)'); return g; }, fill: true, tension: 0.4, pointRadius: 4, pointBackgroundColor: '#ef4444', borderWidth: 3 }] };
  const projectCompChart = { labels: projectBudgetData.map(d => d.name), datasets: [{ label: 'Budget', data: projectBudgetData.map(d => d.Budget), backgroundColor: '#8b5cf6', borderRadius: 6, barPercentage: 0.6 }, { label: 'Spent', data: projectBudgetData.map(d => d.Spent), backgroundColor: '#f472b6', borderRadius: 6, barPercentage: 0.6 }] };

  return (
    // ✅ DYNAMIC MAIN WRAPPER
    <div className={`space-y-6 pb-8 overflow-x-hidden transition-colors duration-300 ${isDark ? 'dark' : 'bg-gray-50'}`}>
      
      {/* ✅ DYNAMIC HEADER */}
      <div className={`relative h-48 rounded-3xl overflow-hidden shadow-2xl flex items-center p-8 border transition-colors duration-300 ${isDark ? 'bg-gradient-to-br from-gray-900 via-slate-900 to-gray-900 border-gray-800' : 'bg-gradient-to-br from-blue-600 via-blue-500 to-indigo-600 border-blue-400'}`}>
        <div className={`absolute inset-0 bg-[radial-gradient(circle_at_80%_50%,rgba(255,255,255,0.15),transparent_50%)]`}></div>
        <div className="relative z-10">
          <div className="flex items-center gap-3 mb-2">
            <div className="w-3 h-3 rounded-full bg-emerald-500 animate-pulse"></div>
            <span className={`text-xs font-bold uppercase tracking-widest ${isDark ? 'text-gray-400' : 'text-blue-100'}`}>Live Analytics</span>
          </div>
          <h1 className={`text-3xl font-extrabold tracking-tight ${isDark ? 'text-white' : 'text-white'}`}>Financial Overview</h1>
          <p className={`${isDark ? 'text-gray-400' : 'text-blue-100'} mt-1 max-w-lg`}>Real-time insights into budgets, expenses, and project financials.</p>
        </div>
      </div>

      {/* ✅ DYNAMIC CARDS GRID */}
      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-4">
        <StatCard title="Total Income" value={formatCurrency(totalIncome)} color="text-emerald-600" bg="bg-emerald-100 dark:bg-emerald-500/10" icon={TrendingUp} isDark={isDark} />
        <StatCard title="Expenses" value={formatCurrency(totalExpenses)} color="text-red-600" bg="bg-red-100 dark:bg-rose-500/10" icon={TrendingDown} isDark={isDark} />
        <StatCard title="Net Profit" value={formatCurrency(netProfit)} color="text-blue-600" bg="bg-blue-100 dark:bg-sky-500/10" icon={DollarSign} isDark={isDark} />
        <StatCard title="Projects" value={projects.length.toString()} color="text-violet-600" bg="bg-violet-100 dark:bg-violet-500/10" icon={FolderKanban} isDark={isDark} />
        <StatCard title="Active" value={activeProjects.toString()} color="text-amber-600" bg="bg-amber-100 dark:bg-amber-500/10" icon={Clock} isDark={isDark} />
        <StatCard title="Completed" value={completedProjects.toString()} color="text-cyan-600" bg="bg-cyan-100 dark:bg-cyan-500/10" icon={CheckCircle} isDark={isDark} />
        <StatCard title="Monthly Rev" value={formatCurrency(monthlyIncome)} color="text-emerald-600" bg="bg-emerald-100 dark:bg-emerald-500/10" icon={TrendingUp} isDark={isDark} />
        <StatCard title="Monthly Exp" value={formatCurrency(monthlyExpenses)} color="text-red-600" bg="bg-red-100 dark:bg-rose-500/10" icon={TrendingDown} isDark={isDark} />
        <StatCard title="Org Budget" value={formatCurrency(totalBudget)} color="text-indigo-600" bg="bg-indigo-100 dark:bg-indigo-500/10" icon={Wallet} isDark={isDark} />
        <StatCard title="Used Budget" value={formatCurrency(usedBudget)} color="text-orange-600" bg="bg-orange-100 dark:bg-orange-500/10" icon={PieIcon} isDark={isDark} />
        <StatCard title="Remaining" value={formatCurrency(remainingBudget)} color="text-teal-600" bg="bg-teal-100 dark:bg-teal-500/10" icon={Wallet} isDark={isDark} />
        <StatCard title="Over Budget" value={overBudgetCount.toString()} color="text-rose-600" bg="bg-rose-100 dark:bg-rose-500/10" icon={AlertTriangle} isDark={isDark} />
      </div>

      {/* ✅ DYNAMIC CHARTS GRID */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        
        {/* CHART CONTAINER CLASS (Dynamic Border & BG) */}
        <div className={`rounded-2xl p-5 overflow-hidden border transition-colors duration-300 ${isDark ? 'bg-gray-900/60 border-gray-800' : 'bg-white border-gray-200 shadow-sm'}`}>
          <div className="flex justify-between items-center mb-4">
            <h3 className={`font-bold ${isDark ? 'text-white' : 'text-gray-800'}`}>Financial Forecast</h3>
            <div className="flex gap-4 text-xs font-semibold">
              <span className="flex items-center gap-1 text-blue-500"><span className="w-2 h-2 bg-blue-500 rounded-full"></span>Income</span>
              <span className="flex items-center gap-1 text-red-500"><span className="w-2 h-2 bg-red-500 rounded-full"></span>Expenses</span>
            </div>
          </div>
          <div className="h-[280px] w-full"><Line data={forecastData} options={baseOptions} /></div>
        </div>

        <div className={`rounded-2xl p-5 overflow-hidden border transition-colors duration-300 flex flex-col ${isDark ? 'bg-gray-900/60 border-gray-800' : 'bg-white border-gray-200 shadow-sm'}`}>
          <h3 className={`font-bold mb-4 ${isDark ? 'text-white' : 'text-gray-800'}`}>Expense Analysis</h3>
          <div className="h-[230px] w-full">
            <Doughnut data={doughnutData} options={{ responsive: true, maintainAspectRatio: false, cutout: '75%', plugins: { legend: { display: false }, tooltip: { enabled: false } } }} plugins={[centerTextPlugin]} />
          </div>
          <div className="w-full border-t border-gray-200 dark:border-gray-800 mt-auto pt-4">
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-2">
              {pieChartData.map((d, i) => (
                <div key={d.name} className="flex items-center gap-2">
                  <span className="w-3 h-3 rounded-full flex-shrink-0" style={{backgroundColor: ['#6366f1', '#ec4899', '#10b981', '#f59e0b', '#3b82f6'][i]}}></span>
                  <span className={`text-sm truncate ${isDark ? 'text-gray-300' : 'text-gray-600'}`}>{d.name}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className={`rounded-2xl p-5 overflow-hidden border transition-colors duration-300 ${isDark ? 'bg-gray-900/60 border-gray-800' : 'bg-white border-gray-200 shadow-sm'}`}>
          <div className="flex justify-between items-center mb-4">
            <h3 className={`font-bold ${isDark ? 'text-white' : 'text-gray-800'}`}>Budget Allocation</h3>
            <div className="flex gap-4 text-xs font-semibold">
              <span className="flex items-center gap-1 text-indigo-500"><span className="w-2 h-2 bg-indigo-500 rounded-full"></span>Allocated</span>
              <span className="flex items-center gap-1 text-orange-500"><span className="w-2 h-2 bg-orange-500 rounded-full"></span>Spent</span>
            </div>
          </div>
          <div className="h-[280px] w-full"><Bar data={budgetVsActualChart} options={baseOptions} /></div>
        </div>

        <div className={`rounded-2xl p-5 overflow-hidden border transition-colors duration-300 ${isDark ? 'bg-gray-900/60 border-gray-800' : 'bg-white border-gray-200 shadow-sm'}`}>
          <div className="flex justify-between items-center mb-4">
            <h3 className={`font-bold ${isDark ? 'text-white' : 'text-gray-800'}`}>Expense Trend</h3>
            <span className={`text-xs px-2 py-1 rounded-full ${isDark ? 'text-gray-500 bg-gray-800' : 'text-gray-500 bg-gray-100'}`}>Last 6 Months</span>
          </div>
          <div className="h-[280px] w-full"><Line data={trendDataSet} options={baseOptions} /></div>
        </div>
      </div>

      {projectBudgetData.length > 0 && (
        <div className={`rounded-2xl p-5 overflow-hidden border transition-colors duration-300 ${isDark ? 'bg-gray-900/60 border-gray-800' : 'bg-white border-gray-200 shadow-sm'}`}>
          <div className="flex justify-between items-center mb-4">
            <h3 className={`font-bold ${isDark ? 'text-white' : 'text-gray-800'}`}>Project Budget Comparison</h3>
            <div className="flex gap-4 text-xs font-semibold">
              <span className="flex items-center gap-1 text-violet-500"><span className="w-2 h-2 bg-violet-500 rounded-full"></span>Budget</span>
              <span className="flex items-center gap-1 text-pink-500"><span className="w-2 h-2 bg-pink-500 rounded-full"></span>Spent</span>
            </div>
          </div>
          <div className="h-[300px] w-full"><Bar data={projectCompChart} options={baseOptions} /></div>
        </div>
      )}
    </div>
  );
}

// ✅ DYNAMIC STAT CARD
function StatCard({ title, value, color, bg, icon: Icon, isDark }: { title: string; value: string; color: string; bg: string; icon: LucideIcon, isDark: boolean }) {
  return (
    <div className={`rounded-xl p-4 group transition-all border ${isDark ? 'bg-gray-900/60 border-gray-800 hover:border-gray-700' : 'bg-white border-gray-200 hover:border-gray-300 shadow-sm hover:shadow-md'}`}>
      <div className="flex items-center justify-between mb-2">
        <p className={`text-[10px] uppercase tracking-wider font-bold ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>{title}</p>
        <div className={`p-1.5 rounded-lg ${bg}`}><Icon className={`w-3.5 h-3.5 ${color}`} /></div>
      </div>
      <p className={`text-lg font-extrabold tracking-tight ${color}`}>{value}</p>
    </div>
  );
}