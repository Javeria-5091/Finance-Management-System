'use client';
import { useState } from 'react';
import { reportService } from '../../../../services/report.service';
import { TrendingUp, BarChart3, DollarSign, Target } from 'lucide-react';
import type { ProjectProfitabilityRow } from '@/types/accounting.types';

const fmtPKR = (n: number) => new Intl.NumberFormat('en-PK', { style: 'currency', currency: 'PKR', minimumFractionDigits: 0 }).format(n || 0);

export default function ProjectProfitabilityPage() {
  const [data, setData] = useState<ProjectProfitabilityRow[]>([]);
  const [start, setStart] = useState('2024-07-01');
  const [end, setEnd] = useState('2025-06-30');
  const [loading, setLoading] = useState(false);

  const fetchReport = async () => {
    setLoading(true);
    try { setData(await reportService.getProjectProfitability(start, end) || []); } finally { setLoading(false); }
  };

  const sorted = [...data].sort((a, b) => b.gross_profit - a.gross_profit);
  
  // Aggregates
  const totalRev = sorted.reduce((a, b) => a + b.total_revenue, 0);
  const totalCost = sorted.reduce((a, b) => a + b.total_costs, 0);
  const avgMargin = sorted.length ? Math.round(sorted.reduce((a, b) => a + b.margin_pct, 0) / sorted.length) : 0;

  return (
    <div className="p-8 max-w-6xl mx-auto space-y-8">
      <div className="flex justify-between items-end border-b dark:border-slate-700 pb-6">
        <div>
          <h1 className="text-3xl font-bold text-slate-900 dark:text-white flex items-center gap-3">
            <BarChart3 className="w-8 h-8 text-purple-600" /> Project Profitability
          </h1>
          <p className="text-slate-500 mt-1">Analysis of revenue, costs, and margins by project.</p>
        </div>
      </div>

      {/* Filters */}
      <div className="flex gap-4 items-end bg-slate-50 dark:bg-slate-800/50 p-4 rounded-lg border dark:border-slate-700">
        <div className="w-48">
          <label className="block text-xs font-medium text-slate-500 mb-1">Start Date</label>
          <input type="date" value={start} onChange={e => setStart(e.target.value)} className="w-full border dark:border-slate-600 rounded-md p-2 text-sm dark:bg-slate-800 dark:text-white outline-none focus:ring-2 focus:ring-blue-500" />
        </div>
        <div className="w-48">
          <label className="block text-xs font-medium text-slate-500 mb-1">End Date</label>
          <input type="date" value={end} onChange={e => setEnd(e.target.value)} className="w-full border dark:border-slate-600 rounded-md p-2 text-sm dark:bg-slate-800 dark:text-white outline-none focus:ring-2 focus:ring-blue-500" />
        </div>
        <button onClick={fetchReport} disabled={loading} className="px-6 py-2 bg-purple-600 hover:bg-purple-700 text-white rounded-md text-sm font-medium disabled:opacity-50">
          {loading ? 'Analyzing...' : 'Generate Report'}
        </button>
      </div>

      {sorted.length > 0 && (
        <>
          {/* KPI Summary Row */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            <div className="bg-white dark:bg-slate-800 p-5 rounded-xl border dark:border-slate-700 shadow-sm flex items-center gap-4">
              <div className="p-3 bg-emerald-100 dark:bg-emerald-900/30 rounded-lg"><DollarSign className="w-6 h-6 text-emerald-600" /></div>
              <div>
                <p className="text-xs font-medium text-slate-500 uppercase">Total Revenue</p>
                <p className="text-2xl font-bold text-slate-900 dark:text-white">{fmtPKR(totalRev)}</p>
              </div>
            </div>
            <div className="bg-white dark:bg-slate-800 p-5 rounded-xl border dark:border-slate-700 shadow-sm flex items-center gap-4">
              <div className="p-3 bg-red-100 dark:bg-red-900/30 rounded-lg"><TrendingUp className="w-6 h-6 text-red-600 rotate-180" /></div>
              <div>
                <p className="text-xs font-medium text-slate-500 uppercase">Total Costs</p>
                <p className="text-2xl font-bold text-slate-900 dark:text-white">{fmtPKR(totalCost)}</p>
              </div>
            </div>
            <div className="bg-white dark:bg-slate-800 p-5 rounded-xl border dark:border-slate-700 shadow-sm flex items-center gap-4">
              <div className="p-3 bg-blue-100 dark:bg-blue-900/30 rounded-lg"><Target className="w-6 h-6 text-blue-600" /></div>
              <div>
                <p className="text-xs font-medium text-slate-500 uppercase">Avg. Margin</p>
                <p className="text-2xl font-bold text-slate-900 dark:text-white">{avgMargin}%</p>
              </div>
            </div>
          </div>

          {/* Data Table */}
          <div className="bg-white dark:bg-slate-800 border dark:border-slate-700 rounded-xl shadow-sm overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 dark:bg-slate-900/80 text-slate-500 text-xs uppercase tracking-wider">
                <tr>
                  <th className="text-left p-4">Project Name</th>
                  <th className="text-right p-4">Revenue</th>
                  <th className="text-right p-4">Costs</th>
                  <th className="text-right p-4 w-[150px]">Profit</th>
                  <th className="p-4 w-[200px]">Margin</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-700">
                {sorted.map((p, i) => (
                  <tr key={p.project_id || i} className="hover:bg-slate-50 dark:hover:bg-slate-800/50 transition-colors">
                    <td className="p-4 font-medium text-slate-900 dark:text-white">{p.project_name}</td>
                    <td className="p-4 text-right font-mono text-slate-700 dark:text-slate-300">{fmtPKR(p.total_revenue)}</td>
                    <td className="p-4 text-right font-mono text-red-500">{fmtPKR(p.total_costs)}</td>
                    <td className={`p-4 text-right font-mono font-bold ${p.gross_profit >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                      {fmtPKR(p.gross_profit)}
                    </td>
                    <td className="p-4">
                      <div className="flex items-center gap-3">
                        <div className="flex-1 bg-slate-200 dark:bg-slate-700 rounded-full h-2.5 overflow-hidden">
                          <div 
                            className={`h-full rounded-full ${p.margin_pct >= 30 ? 'bg-emerald-500' : p.margin_pct >= 0 ? 'bg-amber-500' : 'bg-red-500'}`}
                            style={{ width: `${Math.min(Math.max(p.margin_pct, 0), 100)}%` }}
                          ></div>
                        </div>
                        <span className="text-xs font-bold w-10 text-right text-slate-600 dark:text-slate-400">{p.margin_pct}%</span>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}