'use client';

import { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell, Legend, ComposedChart, Line, Area,
} from 'recharts';
import { getProfitAndLoss, getBalanceSheet, getCashFlow, getStatementOfChangesInEquity } from '@/services/report.service';
import ReportHeader from '@/components/reports/ReportHeader';
import ReportFilterBar from '@/components/reports/ReportFilterBar';
import ExportManager from '@/components/reports/ExportManager';
import KPICard from '@/components/reports/KPICard';
import EmptyReportState from '@/components/reports/EmptyReportState';
import { FileText, RefreshCw, TrendingUp, TrendingDown, BarChart3, DollarSign, ArrowUpRight, ArrowDownRight } from 'lucide-react';
import type { PLData, BSData, CFData, SOCEData, ReportFilters } from '@/types/reports.types';

const f = (n: number) => new Intl.NumberFormat('en-PK', { style: 'currency', currency: 'PKR', minimumFractionDigits: 0 }).format(n || 0);
const sumArr = (arr: { total: number }[]) => arr.reduce((s, a) => s + a.total, 0);

const COLORS = ['#22c55e', '#3b82f6', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#14b8a6', '#f97316'];

type TabId = 'pl' | 'bs' | 'cf' | 'soce';

export default function FinancialStatementsPage() {
  const [tab, setTab] = useState<TabId>('pl');
  const [filters, setFilters] = useState<ReportFilters>({});
  const [dataAsOf] = useState(new Date().toISOString());

  const pl = useQuery({ queryKey: ['pl', filters.startDate, filters.endDate], queryFn: () => getProfitAndLoss(filters.startDate, filters.endDate), enabled: tab === 'pl' });
  const bs = useQuery({ queryKey: ['bs'], queryFn: getBalanceSheet, enabled: tab === 'bs' });
  const cf = useQuery({ queryKey: ['cf', filters.startDate, filters.endDate], queryFn: () => getCashFlow(filters.startDate, filters.endDate), enabled: tab === 'cf' });
  const soce = useQuery({ queryKey: ['soce', filters.startDate, filters.endDate], queryFn: () => getStatementOfChangesInEquity(filters.startDate, filters.endDate), enabled: tab === 'soce' });

  const isLoading = tab === 'pl' ? pl.isLoading : tab === 'bs' ? bs.isLoading : tab === 'cf' ? cf.isLoading : soce.isLoading;

  const periodLabel = useMemo(() => {
    if (filters.startDate && filters.endDate) {
      return `${new Date(filters.startDate).toLocaleDateString('en-PK', { month: 'short', year: 'numeric' })} - ${new Date(filters.endDate).toLocaleDateString('en-PK', { month: 'short', year: 'numeric' })}`;
    }
    return 'All Periods';
  }, [filters]);

  const tabs: { id: TabId; label: string; icon: any }[] = [
    { id: 'pl', label: 'Profit & Loss', icon: BarChart3 },
    { id: 'bs', label: 'Balance Sheet', icon: FileText },
    { id: 'cf', label: 'Cash Flow', icon: RefreshCw },
    { id: 'soce', label: 'Changes in Equity', icon: DollarSign },
  ];

  const activeFilters = useMemo(() => {
    const af: { label: string; value: string }[] = [];
    if (filters.startDate) af.push({ label: 'From', value: filters.startDate });
    if (filters.endDate) af.push({ label: 'To', value: filters.endDate });
    if (filters.currency && filters.currency !== 'PKR') af.push({ label: 'Currency', value: filters.currency || 'PKR' });
    if (filters.comparison) af.push({ label: 'Compare', value: filters.comparison });
    return af;
  }, [filters]);

  const getCsv = (): string => {
    if (tab === 'pl' && pl.data) {
      let csv = 'Section,Account,Amount\n';
      pl.data.revenue.forEach(a => csv += `Revenue,${a.account_name},${a.total}\n`);
      pl.data.cost_of_sales.forEach(a => csv += `COGS,${a.account_name},${-a.total}\n`);
      pl.data.operating_expenses.forEach(a => csv += `OpEx,${a.account_name},${-a.total}\n`);
      return csv;
    }
    return '';
  };

  return (
    <div className="p-6 max-w-[1600px] mx-auto space-y-5">
      <ReportHeader
        title="Financial Statements"
        subtitle="Source: General Ledger — Source of Truth"
        period={periodLabel}
        currency={filters.currency || 'PKR'}
        dataAsOf={dataAsOf}
        filters={activeFilters}
        reconciled={true}
        basis="Accrual Basis"
        actions={
          <ExportManager
            reportId={`financial-statements-${tab}`}
            reportName={`${tab.toUpperCase()} Report`}
            getCsvData={getCsv}
            activeFilters={filters as Record<string, string>}
          />
        }
      />

      <ReportFilterBar
        showDateRange
        showCurrency
        showComparison
        onApply={(f) => setFilters(f)}
        isLoading={isLoading}
      />

      {/* Tabs */}
      <div className="flex gap-1 bg-gray-100 dark:bg-gray-800 p-1 rounded-xl w-fit">
        {tabs.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)}
            className={`flex items-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium transition-all ${
              tab === t.id ? 'bg-white dark:bg-gray-700 text-gray-900 dark:text-white shadow-sm' : 'text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'
            }`}>
            <t.icon className="w-4 h-4" /> {t.label}
          </button>
        ))}
      </div>

      {isLoading && (
        <div className="flex items-center justify-center py-20">
          <RefreshCw className="w-8 h-8 text-blue-500 animate-spin" />
        </div>
      )}

      {/* ═══════════ P&L TAB ═══════════ */}
      {tab === 'pl' && pl.data && !pl.isLoading && (() => {
        const d = pl.data;
        const totalRev = sumArr(d.revenue);
        const totalCos = sumArr(d.cost_of_sales);
        const totalOpex = sumArr(d.operating_expenses);
        const totalOtherInc = sumArr(d.other_income);
        const totalOtherExp = sumArr(d.other_expenses);
        const grossProfit = totalRev - totalCos;
        const netProfit = grossProfit - totalOpex + totalOtherInc - totalOtherExp;
        const isProfit = netProfit >= 0;
        const grossMargin = totalRev > 0 ? (grossProfit / totalRev * 100) : 0;
        const netMargin = totalRev > 0 ? (netProfit / totalRev * 100) : 0;

        const revenueChartData = d.revenue.map(a => ({ name: a.account_name.length > 18 ? a.account_name.slice(0, 18) + '...' : a.account_name, value: a.total }));
        const expenseChartData = [
          ...d.cost_of_sales.slice(0, 5).map(a => ({ name: a.account_name.length > 18 ? a.account_name.slice(0, 18) + '...' : a.account_name, value: a.total, type: 'COGS' })),
          ...d.operating_expenses.slice(0, 5).map(a => ({ name: a.account_name.length > 18 ? a.account_name.slice(0, 18) + '...' : a.account_name, value: a.total, type: 'OpEx' })),
        ];
        const plWaterfallData = [
          { name: 'Revenue', value: totalRev, fill: '#22c55e' },
          { name: 'COGS', value: -totalCos, fill: '#ef4444' },
          { name: 'Gross Profit', value: grossProfit, fill: '#3b82f6' },
          { name: 'OpEx', value: -totalOpex, fill: '#ef4444' },
          { name: 'Net Profit', value: netProfit, fill: isProfit ? '#22c55e' : '#ef4444' },
        ];

        return (
          <div className="space-y-5">
            {/* KPI Cards */}
            <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3">
              <KPICard label="Revenue" value={f(totalRev)} color="green" icon={<ArrowUpRight className="w-4 h-4 text-green-600" />} />
              <KPICard label="Cost of Sales" value={f(totalCos)} color="red" icon={<ArrowDownRight className="w-4 h-4 text-red-600" />} />
              <KPICard label="Gross Profit" value={f(grossProfit)} color={grossProfit >= 0 ? 'green' : 'red'} change={grossMargin} changeLabel="margin" />
              <KPICard label="Operating Exp." value={f(totalOpex)} color="red" />
              <KPICard label="Net Profit" value={f(netProfit)} color={isProfit ? 'green' : 'red'} change={netMargin} changeLabel="margin" />
              <KPICard label="Other Income" value={f(totalOtherInc)} color="blue" />
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
              {/* P&L Table */}
              <div className="lg:col-span-2 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl overflow-hidden">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 dark:bg-gray-900/60">
                    <tr className="text-[10px] uppercase tracking-wider text-gray-500">
                      <th className="p-3 text-left">Account</th>
                      <th className="p-3 text-right">Amount (PKR)</th>
                      <th className="p-3 text-right w-24">% of Rev</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100 dark:divide-gray-700/50">
                    <PLTableSection title="Revenue" accounts={d.revenue} totalRev={totalRev} isExpense={false} />
                    <PLTableSection title="Cost of Sales" accounts={d.cost_of_sales} totalRev={totalRev} isExpense={true} />
                    <tr className="border-t-2 border-gray-300 dark:border-gray-600">
                      <td className="p-3 font-bold text-gray-900 dark:text-white">Gross Profit</td>
                      <td className={`p-3 text-right font-bold font-mono ${grossProfit >= 0 ? 'text-green-600' : 'text-red-600'}`}>{f(grossProfit)}</td>
                      <td className="p-3 text-right font-mono text-gray-500">{totalRev > 0 ? (grossProfit / totalRev * 100).toFixed(1) : '0.0'}%</td>
                    </tr>
                    <PLTableSection title="Operating Expenses" accounts={d.operating_expenses} totalRev={totalRev} isExpense={true} />
                    {d.other_income.length > 0 && <PLTableSection title="Other Income" accounts={d.other_income} totalRev={totalRev} isExpense={false} />}
                    {d.other_expenses.length > 0 && <PLTableSection title="Other Expenses" accounts={d.other_expenses} totalRev={totalRev} isExpense={true} />}
                    <tr className={`border-t-4 ${isProfit ? 'border-green-500' : 'border-red-500'}`}>
                      <td className="p-4 text-lg font-bold text-gray-900 dark:text-white">Net Profit</td>
                      <td className={`p-4 text-right text-lg font-bold font-mono ${isProfit ? 'text-green-600' : 'text-red-600'}`}>{f(netProfit)}</td>
                      <td className={`p-4 text-right text-sm font-bold font-mono ${isProfit ? 'text-green-600' : 'text-red-600'}`}>{totalRev > 0 ? (netProfit / totalRev * 100).toFixed(1) : '0.0'}%</td>
                    </tr>
                  </tbody>
                </table>
              </div>

              {/* Charts */}
              <div className="space-y-5">
                {/* Revenue Pie */}
                {revenueChartData.length > 0 && (
                  <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-5">
                    <h4 className="text-xs font-bold uppercase text-gray-500 mb-4">Revenue Breakdown</h4>
                    <ResponsiveContainer width="100%" height={200}>
                      <PieChart>
                        <Pie data={revenueChartData} cx="50%" cy="50%" outerRadius={70} innerRadius={40} paddingAngle={2} dataKey="value" label={({ name, percent }) => `${name} ${((percent ?? 0) * 100).toFixed(0)}%`} labelLine={false}>
                          {revenueChartData.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
                        </Pie>
                        <Tooltip formatter={(v) => f(Number(v))} />
                      </PieChart>
                    </ResponsiveContainer>
                  </div>
                )}

                {/* Expense Bar */}
                {expenseChartData.length > 0 && (
                  <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-5">
                    <h4 className="text-xs font-bold uppercase text-gray-500 mb-4">Top Expenses</h4>
                    <ResponsiveContainer width="100%" height={220}>
                      <BarChart data={expenseChartData} layout="vertical" margin={{ left: 0, right: 10 }}>
                        <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="#e5e7eb" />
                        <XAxis type="number" tickFormatter={(v) => `${(v / 1000).toFixed(0)}K`} fontSize={10} />
                        <YAxis type="category" dataKey="name" width={120} fontSize={10} />
                        <Tooltip formatter={(v) => f(Number(v))} />
                        <Bar dataKey="value" radius={[0, 4, 4, 0]}>
                          {expenseChartData.map((entry, i) => <Cell key={i} fill={entry.type === 'COGS' ? '#ef4444' : '#f97316'} />)}
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                )}
              </div>
            </div>
          </div>
        );
      })()}

      {/* ═══════════ BALANCE SHEET TAB ═══════════ */}
      {tab === 'bs' && bs.data && !bs.isLoading && (() => {
        const d = bs.data;
        const totalAssets = sumArr(d.assets);
        const totalLiab = sumArr(d.liabilities);
        const totalEquity = sumArr(d.equity);
        const isBalanced = Math.abs(totalAssets - (totalLiab + totalEquity)) < 1;

        const assetPieData = d.assets.map(a => ({ name: a.account_name.length > 20 ? a.account_name.slice(0, 20) + '...' : a.account_name, value: Math.abs(a.total) }));
        const bsBarData = [
          { name: 'Assets', value: totalAssets, fill: '#22c55e' },
          { name: 'Liabilities', value: totalLiab, fill: '#ef4444' },
          { name: 'Equity', value: totalEquity, fill: '#3b82f6' },
        ];

        return (
          <div className="space-y-5">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <KPICard label="Total Assets" value={f(totalAssets)} color="green" />
              <KPICard label="Total Liabilities" value={f(totalLiab)} color="red" />
              <KPICard label="Total Equity" value={f(totalEquity)} color="blue" />
              <KPICard label={isBalanced ? 'Balanced' : 'Imbalance'} value={f(Math.abs(totalAssets - (totalLiab + totalEquity)))} color={isBalanced ? 'green' : 'red'} />
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
              <div className="lg:col-span-2 grid grid-cols-1 md:grid-cols-2 gap-5">
                <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl overflow-hidden">
                  <div className="bg-emerald-600 px-5 py-2.5 text-white font-bold text-xs uppercase tracking-wider">Assets</div>
                  <BSSection accounts={d.assets} />
                  <div className="px-5 py-3 bg-gray-50 dark:bg-gray-900/50 border-t-2 border-emerald-500 font-bold text-sm flex justify-between">
                    <span>Total Assets</span><span className="font-mono">{f(totalAssets)}</span>
                  </div>
                </div>
                <div className="space-y-5">
                  <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl overflow-hidden">
                    <div className="bg-red-600 px-5 py-2.5 text-white font-bold text-xs uppercase tracking-wider">Liabilities</div>
                    <BSSection accounts={d.liabilities} />
                    <div className="px-5 py-3 bg-gray-50 dark:bg-gray-900/50 border-t-2 border-red-500 font-bold text-sm flex justify-between">
                      <span>Total Liabilities</span><span className="font-mono">{f(totalLiab)}</span>
                    </div>
                  </div>
                  <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl overflow-hidden">
                    <div className="bg-blue-600 px-5 py-2.5 text-white font-bold text-xs uppercase tracking-wider">Equity</div>
                    <BSSection accounts={d.equity} />
                    <div className="px-5 py-3 bg-gray-50 dark:bg-gray-900/50 border-t-2 border-blue-500 font-bold text-sm flex justify-between">
                      <span>Total Equity</span><span className="font-mono">{f(totalEquity)}</span>
                    </div>
                  </div>
                  <div className="bg-gray-50 dark:bg-gray-900 rounded-xl p-4 flex justify-between font-bold text-sm">
                    <span>Total L + E</span><span className="font-mono">{f(totalLiab + totalEquity)}</span>
                  </div>
                </div>
              </div>
              <div className="space-y-5">
                {assetPieData.length > 0 && (
                  <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-5">
                    <h4 className="text-xs font-bold uppercase text-gray-500 mb-4">Asset Composition</h4>
                    <ResponsiveContainer width="100%" height={220}>
                      <PieChart>
                        <Pie data={assetPieData} cx="50%" cy="50%" outerRadius={80} innerRadius={45} paddingAngle={2} dataKey="value">
                          {assetPieData.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
                        </Pie>
                        <Tooltip formatter={(v) => f(Number(v))} />
                        <Legend wrapperStyle={{ fontSize: '10px' }} />
                      </PieChart>
                    </ResponsiveContainer>
                  </div>
                )}
                <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-5">
                  <h4 className="text-xs font-bold uppercase text-gray-500 mb-4">Assets vs L + E</h4>
                  <ResponsiveContainer width="100%" height={180}>
                    <BarChart data={bsBarData}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                      <XAxis dataKey="name" fontSize={11} />
                      <YAxis tickFormatter={(v) => `${(v / 1000).toFixed(0)}K`} fontSize={10} />
                      <Tooltip formatter={(v) => f(Number(v))} />
                      <Bar dataKey="value" radius={[6, 6, 0, 0]}>
                        {bsBarData.map((entry, i) => <Cell key={i} fill={entry.fill} />)}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>
            </div>
          </div>
        );
      })()}

      {/* ═══════════ CASH FLOW TAB ═══════════ */}
      {tab === 'cf' && cf.data && !cf.isLoading && (() => {
        const d = cf.data;
        const opTotal = d.operating.reduce((s, a) => s + a.total, 0);
        const invTotal = d.investing.reduce((s, a) => s + a.total, 0);
        const finTotal = d.financing.reduce((s, a) => s + a.total, 0);
        const netCash = opTotal + invTotal + finTotal;

        const cfBarData = [
          { name: 'Operating', value: opTotal, fill: '#3b82f6' },
          { name: 'Investing', value: invTotal, fill: '#8b5cf6' },
          { name: 'Financing', value: finTotal, fill: '#6b7280' },
        ];

        return (
          <div className="space-y-5">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <KPICard label="Operating" value={f(opTotal)} color={opTotal >= 0 ? 'green' : 'red'} />
              <KPICard label="Investing" value={f(invTotal)} color={invTotal >= 0 ? 'green' : 'red'} />
              <KPICard label="Financing" value={f(finTotal)} color={finTotal >= 0 ? 'green' : 'red'} />
              <KPICard label="Net Cash Flow" value={f(netCash)} color={netCash >= 0 ? 'green' : 'red'} />
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
              <div className="lg:col-span-2 space-y-5">
                {([
                  { title: 'Operating Activities', items: d.operating, color: 'bg-blue-600', total: opTotal },
                  { title: 'Investing Activities', items: d.investing, color: 'bg-purple-600', total: invTotal },
                  { title: 'Financing Activities', items: d.financing, color: 'bg-gray-700', total: finTotal },
                ] as const).map(section => (
                  <div key={section.title} className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl overflow-hidden">
                    <div className={`${section.color} px-5 py-3 text-white font-bold text-sm`}>{section.title}</div>
                    <div className="p-4 divide-y divide-gray-100 dark:divide-gray-700">
                      {section.items.map((item, i) => (
                        <div key={i} className="flex justify-between py-2.5 text-sm">
                          <span className="text-gray-600 dark:text-gray-400 pl-4">{item.account_name}</span>
                          <span className={`font-mono font-medium ${item.total >= 0 ? 'text-green-600' : 'text-red-600'}`}>{f(item.total)}</span>
                        </div>
                      ))}
                    </div>
                    <div className="bg-gray-50 dark:bg-gray-900/50 px-5 py-3 flex justify-between font-bold text-sm border-t border-gray-200 dark:border-gray-700">
                      <span>Net {section.title.split(' ')[0]}</span>
                      <span className={`font-mono ${section.total >= 0 ? 'text-green-600' : 'text-red-600'}`}>{f(section.total)}</span>
                    </div>
                  </div>
                ))}
                <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-5 space-y-3">
                  <div className="flex justify-between text-sm"><span className="text-gray-500">Beginning Cash</span><span className="font-mono">{f(d.cash_balance - netCash)}</span></div>
                  <div className="flex justify-between text-sm font-bold"><span>Net Cash Flow</span><span className={`font-mono ${netCash >= 0 ? 'text-green-600' : 'text-red-600'}`}>{f(netCash)}</span></div>
                  <div className="flex justify-between text-lg font-bold pt-3 border-t-2 border-gray-300 dark:border-gray-600">
                    <span>Ending Cash</span><span className="font-mono">{f(d.cash_balance)}</span>
                  </div>
                </div>
              </div>
              <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-5">
                <h4 className="text-xs font-bold uppercase text-gray-500 mb-4">Cash Flow by Activity</h4>
                <ResponsiveContainer width="100%" height={250}>
                  <BarChart data={cfBarData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                    <XAxis dataKey="name" fontSize={11} />
                    <YAxis tickFormatter={(v) => `${(v / 1000).toFixed(0)}K`} fontSize={10} />
                    <Tooltip formatter={(v) => f(Number(v))} />
                    <Bar dataKey="value" radius={[6, 6, 0, 0]}>
                      {cfBarData.map((entry, i) => <Cell key={i} fill={entry.fill} />)}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          </div>
        );
      })()}

      {/* ═══════════ SOCE TAB ═══════════ */}
      {tab === 'soce' && soce.data && !soce.isLoading && (() => {
        const d = soce.data;
        const soceBarData = d.items?.map(i => ({ name: i.account_name.length > 20 ? i.account_name.slice(0, 20) + '...' : i.account_name, opening: i.opening_balance, closing: i.closing_balance })) || [];
        return (
          <div className="space-y-5">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <KPICard label="Opening Equity" value={f(d.total_opening)} color="blue" />
              <KPICard label="Additions" value={f(d.total_additions)} color="green" />
              <KPICard label="Deductions" value={f(d.total_deductions)} color="red" />
              <KPICard label="Closing Equity" value={f(d.total_closing)} color={d.total_closing >= d.total_opening ? 'green' : 'red'} />
            </div>
            {d.items?.length > 0 ? (
              <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl overflow-hidden">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 dark:bg-gray-900/60">
                    <tr className="text-[10px] uppercase tracking-wider text-gray-500">
                      <th className="p-3 text-left">Equity Component</th>
                      <th className="p-3 text-right">Opening</th>
                      <th className="p-3 text-right">Additions</th>
                      <th className="p-3 text-right">Deductions</th>
                      <th className="p-3 text-right">Closing</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100 dark:divide-gray-700/50">
                    {d.items.map((item, i) => (
                      <tr key={i} className="hover:bg-gray-50 dark:hover:bg-gray-700/30">
                        <td className="p-3 font-medium text-gray-900 dark:text-white">{item.account_name}</td>
                        <td className="p-3 text-right font-mono">{f(item.opening_balance)}</td>
                        <td className="p-3 text-right font-mono text-green-600">{f(item.additions)}</td>
                        <td className="p-3 text-right font-mono text-red-600">{f(item.deductions)}</td>
                        <td className="p-3 text-right font-mono font-bold">{f(item.closing_balance)}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot className="bg-gray-50 dark:bg-gray-900/50 font-bold text-xs border-t-2 border-gray-300 dark:border-gray-600">
                    <tr>
                      <td className="p-3">TOTAL</td>
                      <td className="p-3 text-right font-mono">{f(d.total_opening)}</td>
                      <td className="p-3 text-right font-mono text-green-600">{f(d.total_additions)}</td>
                      <td className="p-3 text-right font-mono text-red-600">{f(d.total_deductions)}</td>
                      <td className="p-3 text-right font-mono">{f(d.total_closing)}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            ) : (
              <EmptyReportState message="No equity data available for this period" hint="Ensure journal entries are posted to equity accounts" />
            )}
            {soceBarData.length > 0 && (
              <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-5">
                <h4 className="text-xs font-bold uppercase text-gray-500 mb-4">Opening vs Closing Equity</h4>
                <ResponsiveContainer width="100%" height={250}>
                  <BarChart data={soceBarData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                    <XAxis dataKey="name" fontSize={10} />
                    <YAxis tickFormatter={(v) => `${(v / 1000).toFixed(0)}K`} fontSize={10} />
                    <Tooltip formatter={(v) => f(Number(v))} />
                    <Legend />
                    <Bar dataKey="opening" name="Opening" fill="#93c5fd" radius={[4, 4, 0, 0]} />
                    <Bar dataKey="closing" name="Closing" fill="#3b82f6" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
          </div>
        );
      })()}
    </div>
  );
}

/* ═══════════ SUB-COMPONENTS ═══════════ */

function PLTableSection({ title, accounts, totalRev, isExpense }: { title: string; accounts: { account_name: string; total: number }[]; totalRev: number; isExpense: boolean }) {
  if (!accounts.length) return null;
  const total = sumArr(accounts);
  return (
    <>
      <tr className="bg-gray-50 dark:bg-gray-900/30">
        <td colSpan={3} className="p-2.5 text-[10px] font-bold uppercase tracking-wider text-gray-500">{title}</td>
      </tr>
      {accounts.map((a, i) => (
        <tr key={i} className="hover:bg-gray-50/50 dark:hover:bg-gray-700/20">
          <td className="p-2.5 pl-6 text-gray-600 dark:text-gray-400 text-sm">{a.account_name}</td>
          <td className={`p-2.5 text-right font-mono text-sm ${isExpense ? 'text-red-600' : 'text-green-600'}`}>{isExpense ? '-' : ''}{f(a.total)}</td>
          <td className="p-2.5 text-right font-mono text-xs text-gray-400">{totalRev > 0 ? (Math.abs(a.total) / totalRev * 100).toFixed(1) : '0.0'}%</td>
        </tr>
      ))}
      <tr className="border-t border-gray-200 dark:border-gray-700">
        <td className="p-2.5 pl-6 font-semibold text-sm text-gray-900 dark:text-white">Total {title}</td>
        <td className={`p-2.5 text-right font-mono font-semibold text-sm ${isExpense ? 'text-red-600' : 'text-green-600'}`}>{f(total)}</td>
        <td className="p-2.5 text-right font-mono text-xs text-gray-500">{totalRev > 0 ? (Math.abs(total) / totalRev * 100).toFixed(1) : '0.0'}%</td>
      </tr>
    </>
  );
}

function BSSection({ accounts }: { accounts: { code: string; account_name: string; total: number }[] }) {
  return (
    <div className="p-4 divide-y divide-gray-100 dark:divide-gray-700">
      {accounts.map((a, i) => (
        <div key={i} className={`flex justify-between py-2 text-sm ${a.code.endsWith('00') ? 'font-semibold' : 'pl-4 text-gray-600 dark:text-gray-400'}`}>
          <span>{a.code} - {a.account_name}</span>
          <span className="font-mono">{f(a.total)}</span>
        </div>
      ))}
    </div>
  );
}
