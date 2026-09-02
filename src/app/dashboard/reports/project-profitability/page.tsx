'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell, Legend, ScatterChart, Scatter, ZAxis } from 'recharts';
import { getProjectProfitability } from '@/services/report.service';
import ReportHeader from '@/components/reports/ReportHeader';
import ReportFilterBar from '@/components/reports/ReportFilterBar';
import ExportManager from '@/components/reports/ExportManager';
import KPICard from '@/components/reports/KPICard';
import EmptyReportState from '@/components/reports/EmptyReportState';
import { BarChart3, TrendingUp, Target, CheckCircle2, XCircle } from 'lucide-react';
import type { ProjectProfitRow, ReportFilters } from '@/types/reports.types';

const f = (n: number) => new Intl.NumberFormat('en-PK', { style: 'currency', currency: 'PKR', minimumFractionDigits: 0 }).format(n || 0);
const pct = (a: number, b: number) => (b === 0 ? 0 : ((a / b) * 100));

export default function ProjectProfitabilityPage() {
  const [filters, setFilters] = useState<ReportFilters>({});
  const [sortBy, setSortBy] = useState<'profit' | 'revenue' | 'margin'>('profit');
  const [dataAsOf] = useState(new Date().toISOString());

  const { data: projects, isLoading, refetch } = useQuery({
    queryKey: ['proj-profit', filters],
    queryFn: () => getProjectProfitability(filters.startDate, filters.endDate),
  });

  const sorted = [...(projects || [])].sort((a, b) => {
    if (sortBy === 'revenue') return b.revenue - a.revenue;
    if (sortBy === 'margin') return (b.gross_profit / (b.revenue || 1)) - (a.gross_profit / (a.revenue || 1));
    return b.gross_profit - a.gross_profit;
  });

  const totalRev = sorted.reduce((s, p) => s + p.revenue, 0);
  const totalCosts = sorted.reduce((s, p) => s + p.total_costs, 0);
  const totalGrossProfit = sorted.reduce((s, p) => s + p.gross_profit, 0);
  const totalNetProfit = sorted.reduce((s, p) => s + p.net_profit, 0);
  const totalPlatformFees = sorted.reduce((s, p) => s + p.platform_fees, 0);
  const totalDirectCosts = sorted.reduce((s, p) => s + p.direct_costs, 0);
  const totalOverhead = sorted.reduce((s, p) => s + p.allocated_overhead, 0);
  const avgMargin = sorted.length ? sorted.reduce((s, p) => s + pct(p.gross_profit, p.revenue), 0) / sorted.length : 0;
  const profitableCount = sorted.filter(p => p.gross_profit > 0).length;
  const lossCount = sorted.filter(p => p.gross_profit <= 0).length;

  const costStructureData = [
    { name: 'Direct Costs', value: totalDirectCosts, fill: '#ef4444' },
    { name: 'Platform Fees', value: totalPlatformFees, fill: '#f97316' },
    { name: 'Overhead', value: totalOverhead, fill: '#6b7280' },
    { name: 'Gross Profit', value: Math.max(totalGrossProfit, 0), fill: '#22c55e' },
  ];

  const marginScatter = sorted.map(p => ({
    name: p.project_name.length > 12 ? p.project_name.slice(0, 12) + '...' : p.project_name,
    revenue: p.revenue,
    margin: pct(p.gross_profit, p.revenue),
    profit: p.gross_profit,
  }));

  const getCsv = () => {
    let csv = 'Project,Client,Status,Revenue,Direct Costs,Platform Fees,Overhead,Total Costs,Gross Profit,Net Profit,Gross Margin\n';
    sorted.forEach(p => {
      csv += `"${p.project_name}","${p.client_name}",${p.status},${p.revenue},${p.direct_costs},${p.platform_fees},${p.allocated_overhead},${p.total_costs},${p.gross_profit},${p.net_profit},${pct(p.gross_profit, p.revenue).toFixed(1)}%\n`;
    });
    return csv;
  };

  return (
    <div className="p-6 max-w-[1600px] mx-auto space-y-5">
      <ReportHeader
        title="Project Profitability"
        subtitle="Revenue, costs, margins, and budget variance per project  Projects"
        period={filters.startDate && filters.endDate ? `${filters.startDate} to ${filters.endDate}` : 'All Periods'}
        dataAsOf={dataAsOf}
        reconciled={true}
        actions={
          <ExportManager reportId="project-profitability" reportName="Project_Profitability" getCsvData={getCsv} activeFilters={filters as Record<string, string>} />
        }
      />

      <div className="flex gap-3 items-end">
        <ReportFilterBar
          showDateRange
          showEntityFilter
          entityLabel="Project"
          onApply={(f) => { setFilters(f); refetch(); }}
          isLoading={isLoading}
        />
      </div>

      {isLoading && <div className="flex justify-center py-20"><div className="w-8 h-8 border-4 border-blue-600 border-t-transparent rounded-full animate-spin" /></div>}

      {sorted.length > 0 && !isLoading && (
        <>
          {/* KPI Cards */}
          <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-3">
            <KPICard label="Total Revenue" value={f(totalRev)} color="green" icon={<TrendingUp className="w-4 h-4 text-green-600" />} />
            <KPICard label="Direct Costs" value={f(totalDirectCosts)} color="red" />
            <KPICard label="Platform Fees" value={f(totalPlatformFees)} color="amber" />
            <KPICard label="Allocated Overhead" value={f(totalOverhead)} color="gray" />
            <KPICard label="Gross Profit" value={f(totalGrossProfit)} color={totalGrossProfit >= 0 ? 'green' : 'red'} change={pct(totalGrossProfit, totalRev)} changeLabel="margin" />
            <KPICard label="Net Profit" value={f(totalNetProfit)} color={totalNetProfit >= 0 ? 'green' : 'red'} />
            <KPICard label="Avg Margin" value={`${avgMargin.toFixed(1)}%`} color={avgMargin >= 30 ? 'green' : avgMargin >= 15 ? 'amber' : 'red'} />
          </div>

          {/* Charts Row */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
            {/* Cost Structure */}
            <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-5">
              <h4 className="text-xs font-bold uppercase text-gray-500 mb-4">Cost Structure </h4>
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={costStructureData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                  <XAxis dataKey="name" fontSize={10} />
                  <YAxis tickFormatter={(v) => `${(v / 1000).toFixed(0)}K`} fontSize={10} />
                  <Tooltip formatter={(v) => f(Number(v))} />
                  <Bar dataKey="value" radius={[6, 6, 0, 0]}>
                    {costStructureData.map((entry, i) => <Cell key={i} fill={entry.fill} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>

            {/* Revenue vs Margin Scatter */}
            <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-5">
              <h4 className="text-xs font-bold uppercase text-gray-500 mb-4">Revenue vs Margin %</h4>
              <ResponsiveContainer width="100%" height={220}>
                <ScatterChart>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                  <XAxis dataKey="revenue" tickFormatter={(v) => `${(v / 1000).toFixed(0)}K`} fontSize={10} name="Revenue" />
                  <YAxis dataKey="margin" tickFormatter={(v) => `${v.toFixed(0)}%`} fontSize={10} name="Margin %" />
                  <ZAxis range={[60, 400]} />
                  <Tooltip formatter={(v, name) => name === 'Revenue' ? f(Number(v)) : `${Number(v).toFixed(1)}%`} cursor={{ strokeDasharray: '3 3' }} />
                  <Scatter data={marginScatter} fill="#3b82f6">
                    {marginScatter.map((entry, i) => (
                      <Cell key={i} fill={entry.margin >= 50 ? '#22c55e' : entry.margin >= 30 ? '#f59e0b' : '#ef4444'} />
                    ))}
                  </Scatter>
                </ScatterChart>
              </ResponsiveContainer>
            </div>

            {/* Profitability Summary */}
            <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-5">
              <h4 className="text-xs font-bold uppercase text-gray-500 mb-4">Profitability Summary</h4>
              <div className="space-y-4">
                <div className="flex justify-between items-center"><span className="text-xs text-gray-500">Total Projects</span><span className="font-bold text-lg text-gray-900 dark:text-white">{sorted.length}</span></div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="bg-green-50 dark:bg-green-900/20 rounded-xl p-4 text-center">
                    <CheckCircle2 className="w-5 h-5 text-green-600 mx-auto mb-1" />
                    <p className="text-[10px] text-green-600">Profitable</p>
                    <p className="text-2xl font-bold text-green-700">{profitableCount}</p>
                  </div>
                  <div className="bg-red-50 dark:bg-red-900/20 rounded-xl p-4 text-center">
                    <XCircle className="w-5 h-5 text-red-600 mx-auto mb-1" />
                    <p className="text-[10px] text-red-600">Loss Making</p>
                    <p className="text-2xl font-bold text-red-700">{lossCount}</p>
                  </div>
                </div>
                <div className="space-y-2">
                  <div className="flex justify-between text-xs"><span className="text-gray-500">Gross Margin</span><span className="font-mono font-bold">{pct(totalGrossProfit, totalRev).toFixed(1)}%</span></div>
                  <div className="flex justify-between text-xs"><span className="text-gray-500">Net Margin</span><span className="font-mono font-bold">{pct(totalNetProfit, totalRev).toFixed(1)}%</span></div>
                  <div className="flex justify-between text-xs"><span className="text-gray-500">Cost-to-Revenue</span><span className="font-mono font-bold">{totalRev > 0 ? (totalCosts / totalRev * 100).toFixed(1) : '0.0'}%</span></div>
                </div>
              </div>
            </div>
          </div>

          {/* Main Table */}
          <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl overflow-hidden">
            <div className="flex items-center justify-between px-5 py-3 bg-gray-50 dark:bg-gray-900/40">
              <h4 className="text-xs font-bold uppercase text-gray-500">All Projects — : Direct costs and allocated overhead labeled separately</h4>
              <div className="flex gap-1">
                {(['profit', 'revenue', 'margin'] as const).map(s => (
                  <button key={s} onClick={() => setSortBy(s)}
                    className={`px-3 py-1 rounded text-[10px] font-bold uppercase tracking-wider ${sortBy === s ? 'bg-blue-600 text-white' : 'text-gray-500 hover:bg-gray-200 dark:hover:bg-gray-700'}`}>
                    {s === 'profit' ? 'By Profit' : s === 'revenue' ? 'By Revenue' : 'By Margin'}
                  </button>
                ))}
              </div>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 dark:bg-gray-900/60 text-[10px] uppercase text-gray-500">
                  <tr>
                    <th className="text-left p-3">Project</th>
                    <th className="text-left p-3 hidden md:table-cell">Client</th>
                    <th className="text-left p-3 hidden lg:table-cell">Status</th>
                    <th className="text-right p-3">Revenue</th>
                    <th className="text-right p-3 hidden lg:table-cell">Direct Costs</th>
                    <th className="text-right p-3 hidden lg:table-cell">Platform Fees</th>
                    <th className="text-right p-3 hidden lg:table-cell">Overhead</th>
                    <th className="text-right p-3">Total Costs</th>
                    <th className="text-right p-3">Gross Profit</th>
                    <th className="text-right p-3 hidden md:table-cell">Gross Margin</th>
                    <th className="text-right p-3 hidden lg:table-cell">Net Profit</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                  {sorted.map((p) => {
                    const gMargin = pct(p.gross_profit, p.revenue);
                    return (
                      <tr key={p.project_id} className="hover:bg-gray-50 dark:hover:bg-gray-700/30">
                        <td className="p-3 font-medium text-gray-900 dark:text-white">{p.project_name}</td>
                        <td className="p-3 text-gray-500 hidden md:table-cell">{p.client_name}</td>
                        <td className="p-3 hidden lg:table-cell"><StatusBadge status={p.status} /></td>
                        <td className="p-3 text-right font-mono text-green-600">{f(p.revenue)}</td>
                        <td className="p-3 text-right font-mono text-red-500 hidden lg:table-cell">{f(p.direct_costs)}</td>
                        <td className="p-3 text-right font-mono text-orange-500 hidden lg:table-cell">{f(p.platform_fees)}</td>
                        <td className="p-3 text-right font-mono text-gray-500 hidden lg:table-cell">{f(p.allocated_overhead)}</td>
                        <td className="p-3 text-right font-mono text-red-600">{f(p.total_costs)}</td>
                        <td className={`p-3 text-right font-mono font-bold ${p.gross_profit >= 0 ? 'text-green-600' : 'text-red-600'}`}>{f(p.gross_profit)}</td>
                        <td className="p-3 text-right hidden md:table-cell">
                          <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${gMargin >= 50 ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400' : gMargin >= 30 ? 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400' : 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400'}`}>{gMargin.toFixed(1)}%</span>
                        </td>
                        <td className={`p-3 text-right font-mono hidden lg:table-cell ${p.net_profit >= 0 ? 'text-green-600' : 'text-red-500'}`}>{f(p.net_profit)}</td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot className="bg-gray-50 dark:bg-gray-900/50 font-bold text-xs border-t-2 border-gray-300 dark:border-gray-600">
                  <tr>
                    <td colSpan={3} className="p-3">TOTAL</td>
                    <td className="p-3 text-right text-green-600">{f(totalRev)}</td>
                    <td className="p-3 text-right text-red-500 hidden lg:table-cell">{f(totalDirectCosts)}</td>
                    <td className="p-3 text-right text-orange-500 hidden lg:table-cell">{f(totalPlatformFees)}</td>
                    <td className="p-3 text-right text-gray-500 hidden lg:table-cell">{f(totalOverhead)}</td>
                    <td className="p-3 text-right text-red-600">{f(totalCosts)}</td>
                    <td className={`p-3 text-right ${totalGrossProfit >= 0 ? 'text-green-600' : 'text-red-600'}`}>{f(totalGrossProfit)}</td>
                    <td className="p-3 text-right hidden md:table-cell">{pct(totalGrossProfit, totalRev).toFixed(1)}%</td>
                    <td className={`p-3 text-right hidden lg:table-cell ${totalNetProfit >= 0 ? 'text-green-600' : 'text-red-500'}`}>{f(totalNetProfit)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>
        </>
      )}

      {!isLoading && sorted.length === 0 && (
        <EmptyReportState icon="chart" title="No Project Data" message="No projects with posted journal entries found" hint="Post income/expense entries assigned to projects to see profitability analysis" />
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const config: Record<string, { label: string; color: string }> = {
    ACTIVE: { label: 'Active', color: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400' },
    COMPLETED: { label: 'Completed', color: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400' },
    ON_HOLD: { label: 'On Hold', color: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400' },
    CANCELLED: { label: 'Cancelled', color: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400' },
  };
  const c = config[status] || config.ACTIVE;
  return <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${c.color}`}>{c.label}</span>;
}