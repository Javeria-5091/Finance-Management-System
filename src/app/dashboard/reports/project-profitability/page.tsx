'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getProjectProfitability } from '@/services/report.service';
import { BarChart3, DollarSign, TrendingUp, TrendingDown, Target, AlertTriangle, CheckCircle2, Circle } from 'lucide-react';
import type { ProjectProfitRow } from '@/types/reports.types';

const f = (n: number) => new Intl.NumberFormat('en-PK', { style: 'currency', currency: 'PKR', minimumFractionDigits: 0 }).format(n || 0);
const pct = (a: number, b: number) => (b === 0 ? 0 : ((a / b) * 100));

// ==========================================
// CHARTS
// ==========================================
function HorizontalBar({ label, value, max, color }: { label: string; value: number; max: number; color: string }) {
  return (
    <div className="space-y-1">
      <div className="flex justify-between text-xs">
        <span className="text-gray-600 dark:text-gray-400">{label}</span>
        <span className="font-mono font-medium text-gray-900 dark:text-white">{f(value)}</span>
      </div>
      <div className="w-full bg-gray-100 dark:bg-gray-700 rounded-full h-3 overflow-hidden">
        <div className="h-full rounded-full transition-all" style={{ width: `${Math.max((Math.abs(value) / max) * 100, 2)}%`, backgroundColor: color }} />
      </div>
    </div>
  );
}

function ProfitBar({ revenue, costs, profit }: { revenue: number; costs: number; profit: number }) {
  const max = Math.max(revenue, 1);
  const costWidth = (costs / max) * 100;
  const profitWidth = Math.max((profit / max) * 100, 0);
  return (
    <div className="h-8 bg-gray-100 dark:bg-gray-700 rounded-lg overflow-hidden flex">
      <div className="h-full bg-red-500 transition-all" style={{ width: `${costWidth}%` }} />
      <div className={`h-full transition-all ${profit >= 0 ? 'bg-green-500' : 'bg-red-700'}`} style={{ width: `${profitWidth}%` }} />
    </div>
  );
}

function MarginGauge({ margin }: { margin: number }) {
  const color = margin >= 50 ? '#22c55e' : margin >= 30 ? '#f59e0b' : margin >= 0 ? '#ef4444' : '#dc2626';
  const rotation = -90 + (margin / 100) * 180;
  return (
    <div className="flex flex-col items-center">
      <svg width="100" height="60" viewBox="0 0 100 60">
        <path d="M 10 55 A 40 40 0 0 1 90 55" fill="none" stroke="#e5e7eb" strokeWidth="8" strokeLinecap="round" />
        <path d="M 10 55 A 40 40 0 0 1 90 55" fill="none" stroke={color} strokeWidth="8" strokeLinecap="round"
          strokeDasharray={`${margin * 2.51} 251`} transform={`rotate(${rotation}, 50, 50)`} />
        <text x="50" y="35" textAnchor="middle" className="fill-gray-900 dark:text-white" style={{ fontSize: '16px', fontWeight: 'bold' }}>{margin.toFixed(1)}%</text>
        <text x="50" y="50" textAnchor="middle" className="fill-gray-500" style={{ fontSize: '8px' }}>MARGIN</text>
      </svg>
    </div>
  );
}

// ==========================================
// STATUS BADGE
// ==========================================
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

// ==========================================
// MAIN PAGE
// ==========================================
export default function ProjectProfitabilityPage() {
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [sortBy, setSortBy] = useState<'profit' | 'revenue' | 'margin'>('profit');

  const { data: projects, isLoading, refetch } = useQuery({
    queryKey: ['proj-profit', start, end],
    queryFn: () => getProjectProfitability(start || undefined, end || undefined),
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

  return (
    <div className="p-6 max-w-[1500px] mx-auto space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-gray-900 dark:text-white flex items-center gap-3">
            <BarChart3 className="w-7 h-7 text-purple-600" /> Project Profitability
          </h2>
          <p className="text-sm text-gray-500">Revenue, costs, and margins by project — Document Section 6.3</p>
        </div>
      </div>

      {/* Filters */}
      <div className="flex gap-3 items-end bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-4">
        <div>
          <label className="block text-[10px] uppercase text-gray-500 mb-1">From</label>
          <input type="date" value={start} onChange={e => setStart(e.target.value)}
            className="border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 text-sm dark:bg-gray-900 dark:text-white" />
        </div>
        <div>
          <label className="block text-[10px] uppercase text-gray-500 mb-1">To</label>
          <input type="date" value={end} onChange={e => setEnd(e.target.value)}
            className="border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 text-sm dark:bg-gray-900 dark:text-white" />
        </div>
        <div>
          <label className="block text-[10px] uppercase text-gray-500 mb-1">Sort By</label>
          <select value={sortBy} onChange={e => setSortBy(e.target.value as any)}
            className="border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 text-sm dark:bg-gray-900 dark:text-white">
            <option value="profit">Highest Profit</option>
            <option value="revenue">Highest Revenue</option>
            <option value="margin">Best Margin</option>
          </select>
        </div>
        <button onClick={() => refetch()} disabled={isLoading}
          className="px-5 py-2 bg-purple-600 text-white rounded-lg text-sm font-medium hover:bg-purple-700 disabled:opacity-50">
          {isLoading ? 'Loading...' : 'Generate'}
        </button>
      </div>

      {isLoading && <div className="flex justify-center py-20"><div className="w-8 h-8 border-4 border-purple-600 border-t-transparent rounded-full animate-spin" /></div>}

      {sorted.length > 0 && !isLoading && (
        <>
          {/* KPI Cards */}
          <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-3">
            <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-4">
              <p className="text-[10px] uppercase text-gray-500 mb-1">Total Revenue</p>
              <p className="text-lg font-bold text-green-600">{f(totalRev)}</p>
            </div>
            <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-4">
              <p className="text-[10px] uppercase text-gray-500 mb-1">Direct Costs</p>
              <p className="text-lg font-bold text-red-600">{f(totalDirectCosts)}</p>
            </div>
            <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-4">
              <p className="text-[10px] uppercase text-gray-500 mb-1">Platform Fees</p>
              <p className="text-lg font-bold text-orange-600">{f(totalPlatformFees)}</p>
            </div>
            <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-4">
              <p className="text-[10px] uppercase text-gray-500 mb-1">Overhead</p>
              <p className="text-lg font-bold text-gray-600">{f(totalOverhead)}</p>
            </div>
            <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-4">
              <p className="text-[10px] uppercase text-gray-500 mb-1">Gross Profit</p>
              <p className={`text-lg font-bold ${totalGrossProfit >= 0 ? 'text-green-600' : 'text-red-600'}`}>{f(totalGrossProfit)}</p>
            </div>
            <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-4">
              <p className="text-[10px] uppercase text-gray-500 mb-1">Net Profit</p>
              <p className={`text-lg font-bold ${totalNetProfit >= 0 ? 'text-green-600' : 'text-red-600'}`}>{f(totalNetProfit)}</p>
            </div>
            <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-4">
              <p className="text-[10px] uppercase text-gray-500 mb-1">Avg Margin</p>
              <p className="text-lg font-bold text-blue-600">{avgMargin.toFixed(1)}%</p>
            </div>
          </div>

          {/* Profit/Loss Summary */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
            <div className="lg:col-span-2 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-5">
              <h4 className="text-xs font-bold uppercase text-gray-500 mb-4">Cost Structure (Document Section 6.3 Formula)</h4>
              <div className="space-y-3">
                <div>
                  <div className="flex justify-between text-xs mb-1"><span className="text-gray-500">Revenue</span><span className="font-mono font-bold text-green-600">{f(totalRev)}</span></div>
                  <ProfitBar revenue={totalRev} costs={totalCosts} profit={totalGrossProfit} />
                </div>
                <div className="grid grid-cols-2 gap-4 mt-2">
                  <div className="space-y-2">
                    <p className="text-[10px] uppercase text-gray-500 font-bold">Cost Breakdown</p>
                    <HorizontalBar label="Direct Costs" value={totalDirectCosts} max={totalRev} color="#ef4444" />
                    <HorizontalBar label="Platform Fees" value={totalPlatformFees} max={totalRev} color="#f97316" />
                    <HorizontalBar label="Allocated Overhead" value={totalOverhead} max={totalRev} color="#6b7280" />
                  </div>
                  <div className="space-y-2">
                    <p className="text-[10px] uppercase text-gray-500 font-bold">Profit Metrics</p>
                    <div className="flex justify-between text-xs"><span className="text-gray-600">Gross Margin</span><span className="font-mono font-bold">{pct(totalGrossProfit, totalRev).toFixed(1)}%</span></div>
                    <div className="flex justify-between text-xs"><span className="text-gray-600">Net Margin</span><span className="font-mono font-bold">{pct(totalNetProfit, totalRev).toFixed(1)}%</span></div>
                    <div className="flex justify-between text-xs"><span className="text-gray-600">Profitable Projects</span><span className="font-mono font-bold text-green-600">{profitableCount}/{sorted.length}</span></div>
                  </div>
                </div>
              </div>
            </div>

            <div className="space-y-5">
              <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-5 flex flex-col items-center">
                <p className="text-[10px] uppercase text-gray-500 font-bold mb-3">Overall Margin</p>
                <MarginGauge margin={avgMargin} />
                <div className="grid grid-cols-2 gap-4 mt-3 w-full text-center">
                  <div className="p-2 bg-green-50 dark:bg-green-900/20 rounded-lg">
                    <p className="text-[10px] text-green-600">Profitable</p>
                    <p className="text-lg font-bold text-green-700">{profitableCount}</p>
                  </div>
                  <div className="p-2 bg-red-50 dark:bg-red-900/20 rounded-lg">
                    <p className="text-[10px] text-red-600">Loss Making</p>
                    <p className="text-lg font-bold text-red-700">{lossCount}</p>
                  </div>
                </div>
              </div>

              {/* Top 5 Projects by Profit */}
              <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-5">
                <p className="text-[10px] uppercase text-gray-500 font-bold mb-3">Top 5 by Profit</p>
                <div className="space-y-2">
                  {sorted.slice(0, 5).map((p, i) => (
                    <div key={i} className="flex items-center justify-between">
                      <span className="text-[11px] text-gray-700 dark:text-gray-300 truncate max-w-[140px]">{p.project_name}</span>
                      <span className={`text-[11px] font-mono font-bold ${p.gross_profit >= 0 ? 'text-green-600' : 'text-red-600'}`}>{f(p.gross_profit)}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>

          {/* Main Table — Document: "clearly label direct cost, allocated overhead, gross margin, contribution margin" */}
          <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 dark:bg-gray-900/50 text-[10px] uppercase text-gray-500">
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
                {sorted.map((p, i) => {
                  const gMargin = pct(p.gross_profit, p.revenue);
                  const nMargin = pct(p.net_profit, p.revenue);
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
                        <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${
                          gMargin >= 50 ? 'bg-green-100 text-green-700' : gMargin >= 30 ? 'bg-yellow-100 text-yellow-700' : 'bg-red-100 text-red-700'
                        }`}>{gMargin.toFixed(1)}%</span>
                      </td>
                      <td className={`p-3 text-right font-mono hidden lg:table-cell ${p.net_profit >= 0 ? 'text-green-600' : 'text-red-500'}`}>{f(p.net_profit)}</td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot className="bg-gray-50 dark:bg-gray-900/50 font-bold text-xs">
                <tr className="border-t-2 border-gray-300 dark:border-gray-600">
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

          {/* Document Note */}
          <div className="bg-blue-50 dark:bg-blue-900/10 border border-blue-200 dark:border-blue-800/30 rounded-xl p-4 text-xs text-blue-700 dark:text-blue-400">
            <p className="font-bold mb-1">📋 Per Document Section 6.3:</p>
            <p><strong>Gross Profit</strong> = Revenue − Direct Costs − Platform/Service Fees (not including allocated overhead)</p>
            <p><strong>Contribution/Net Profit</strong> = Gross Profit − Allocated Overhead</p>
            <p className="mt-1 text-blue-500">Management should not be misled by allocation assumptions — direct costs and allocated overhead are labeled separately.</p>
          </div>
        </>
      )}

      {!isLoading && sorted.length === 0 && (
        <div className="text-center py-20">
          <BarChart3 className="w-12 h-12 text-gray-300 mx-auto mb-3" />
          <p className="text-gray-500">No project data with posted journal entries</p>
          <p className="text-xs text-gray-400 mt-1">Post income/expense entries assigned to projects to see profitability analysis</p>
        </div>
      )}
    </div>
  );
}