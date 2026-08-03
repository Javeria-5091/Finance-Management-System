'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getProfitAndLoss, getBalanceSheet, getCashFlow } from '@/services/report.service';
import { FileText, ShieldCheck, AlertTriangle, Download, RefreshCw, TrendingUp, TrendingDown, BarChart3 } from 'lucide-react';
import type { PLData, BSData, CFData } from '@/types/reports.types';

const f = (n: number) => new Intl.NumberFormat('en-PK', { style: 'currency', currency: 'PKR', minimumFractionDigits: 0 }).format(n || 0);
const sumArr = (arr: { total: number }[]) => arr.reduce((s, a) => s + a.total, 0);

// ==========================================
// MINI CHARTS
// ==========================================
function BarChart({ data, maxVal }: { data: { label: string; value: number; color: string }[]; maxVal?: number }) {
  const max = maxVal || Math.max(...data.map(d => Math.abs(d.value)), 1);
  return (
    <div className="space-y-1.5">
      {data.map((d, i) => (
        <div key={i} className="flex items-center gap-2">
          <span className="text-[10px] text-gray-500 w-24 text-right truncate flex-shrink-0">{d.label}</span>
          <div className="flex-1 bg-gray-100 dark:bg-gray-700 rounded-full h-3 overflow-hidden">
            <div className="h-full rounded-full transition-all" style={{ width: `${(Math.abs(d.value) / max) * 100}%`, backgroundColor: d.color }} />
          </div>
          <span className="text-[10px] font-mono text-gray-700 dark:text-gray-300 w-20 text-right flex-shrink-0">{f(d.value)}</span>
        </div>
      ))}
    </div>
  );
}

function DonutChart({ segments, size = 80 }: { segments: { label: string; value: number; color: string }[]; size?: number }) {
  const total = segments.reduce((s, d) => s + Math.abs(d.value), 0) || 1;
  let cum = 0;
  return (
    <div className="flex items-center gap-4">
      <div className="relative flex-shrink-0" style={{ width: size, height: size }}>
        <svg viewBox="0 0 42 42" className="w-full h-full -rotate-90">
          {segments.map((s, i) => {
            const pct = (Math.abs(s.value) / total) * 100;
            const start = cum; cum += pct;
            return <circle key={i} cx="21" cy="21" r="15.915" fill="none" stroke={s.color} strokeWidth="5" strokeDasharray={`${pct * 1.006} ${100 - pct * 1.006}`} strokeDashoffset={-start * 1.006} />;
          })}
        </svg>
        <div className="absolute inset-0 flex items-center justify-center">
          <span className="text-[10px] font-bold text-gray-700 dark:text-gray-300">{f(total)}</span>
        </div>
      </div>
      <div className="space-y-1">
        {segments.map((s, i) => (
          <div key={i} className="flex items-center gap-2">
            <div className="w-2 h-2 rounded-sm" style={{ backgroundColor: s.color }} />
            <span className="text-[10px] text-gray-600 dark:text-gray-400">{s.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ==========================================
// P&L COMPONENT
// ==========================================
function PLSection({ title, accounts, color, isExpense }: { title: string; accounts: { account_name: string; total: number }[]; color: string; isExpense: boolean }) {
  if (!accounts.length) return null;
  const total = sumArr(accounts);
  return (
    <div className="mb-4">
      <h4 className="text-[10px] font-bold uppercase text-gray-500 mb-2">{title}</h4>
      <div className="space-y-1">
        {accounts.map((a, i) => (
          <div key={i} className="flex justify-between text-xs">
            <span className="text-gray-600 dark:text-gray-400 pl-3">{a.account_name}</span>
            <span className={`font-mono ${isExpense ? 'text-red-600' : 'text-green-600'}`}>
              {isExpense ? '-' : '+'}{f(a.total)}
            </span>
          </div>
        ))}
      </div>
      <div className="flex justify-between text-xs font-bold pt-2 mt-2 border-t border-gray-200 dark:border-gray-700">
        <span>Total {title}</span>
        <span className={isExpense ? 'text-red-600' : 'text-green-600'}>{f(total)}</span>
      </div>
    </div>
  );
}

// ==========================================
// BALANCE SHEET COMPONENT
// ==========================================
function BSSection({ title, accounts, accent }: { title: string; accounts: { code: string; account_name: string; total: number }[]; accent: string }) {
  if (!accounts.length) return null;
  const total = sumArr(accounts);
  return (
    <div>
      <h4 className="text-[10px] font-bold uppercase text-gray-500 mb-2">{title}</h4>
      {accounts.map((a, i) => (
        <div key={i} className={`flex justify-between text-xs py-1 ${a.code.endsWith('00') ? 'font-semibold pl-2' : 'pl-5 text-gray-600 dark:text-gray-400'}`}>
          <span>{a.code} - {a.account_name}</span>
          <span className="font-mono">{f(a.total)}</span>
        </div>
      ))}
      <div className={`flex justify-between text-xs font-bold pt-2 mt-2 border-t-2 ${accent}`}>
        <span>Total {title}</span>
        <span className="font-mono">{f(total)}</span>
      </div>
    </div>
  );
}

// ==========================================
// MAIN PAGE
// ==========================================
export default function ReportsPage() {
  const [tab, setTab] = useState<'pl' | 'bs' | 'cf'>('pl');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');

  const pl = useQuery({ queryKey: ['pl', start, end], queryFn: () => getProfitAndLoss(start || undefined, end || undefined), enabled: tab === 'pl' });
  const bs = useQuery({ queryKey: ['bs'], queryFn: getBalanceSheet, enabled: tab === 'bs' });
  const cf = useQuery({ queryKey: ['cf', start, end], queryFn: () => getCashFlow(start || undefined, end || undefined), enabled: tab === 'cf' });

  const isLoading = tab === 'pl' ? pl.isLoading : tab === 'bs' ? bs.isLoading : cf.isLoading;

  const tabs = [
    { id: 'pl' as const, label: 'Profit & Loss', icon: BarChart3 },
    { id: 'bs' as const, label: 'Balance Sheet', icon: FileText },
    { id: 'cf' as const, label: 'Cash Flow', icon: RefreshCw },
  ];

  // CSV Download
  function downloadCSV() {
    let csv = '';
    if (tab === 'pl' && pl.data) {
      csv = 'Section,Account,Amount\n';
      const d = pl.data;
      d.revenue.forEach(a => csv += `Revenue,${a.account_name},${a.total}\n`);
      d.cost_of_sales.forEach(a => csv += `COGS,${a.account_name},${-a.total}\n`);
      d.operating_expenses.forEach(a => csv += `OpEx,${a.account_name},${-a.total}\n`);
    }
    if (csv) {
      const blob = new Blob([csv], { type: 'text/csv' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = url; a.download = `${tab}_report.csv`; a.click();
    }
  }

  return (
    <div className="p-6 max-w-[1400px] mx-auto space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-gray-900 dark:text-white">Financial Reports</h2>
          <p className="text-sm text-gray-500">Generated from General Ledger — Source of Truth</p>
        </div>
        <button onClick={downloadCSV} className="flex items-center gap-2 px-4 py-2 bg-gray-100 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg text-sm hover:bg-gray-200 dark:hover:bg-gray-700">
          <Download className="w-4 h-4" /> CSV
        </button>
      </div>

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

      {/* Date Filters (only for P&L and Cash Flow) */}
      {tab !== 'bs' && (
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
          <button onClick={() => { if (tab === 'pl') pl.refetch(); else cf.refetch(); }}
            className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700">
            Generate
          </button>
        </div>
      )}

      {/* Loading */}
      {isLoading && (
        <div className="flex items-center justify-center py-16">
          <RefreshCw className="w-8 h-8 text-blue-500 animate-spin" />
        </div>
      )}

      {/* ==================== P&L TAB ==================== */}
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

        return (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
            {/* P&L Table */}
            <div className="lg:col-span-2 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-5">
              <PLSection title="Revenue" accounts={d.revenue} color="#22c55e" isExpense={false} />
              <PLSection title="Cost of Sales" accounts={d.cost_of_sales} color="#ef4444" isExpense={true} />
              <div className="flex justify-between text-sm font-bold py-2 border-t-2 border-gray-300 dark:border-gray-600 my-3">
                <span>Gross Profit</span>
                <span className={grossProfit >= 0 ? 'text-green-600' : 'text-red-600'}>{f(grossProfit)}</span>
              </div>
              <PLSection title="Operating Expenses" accounts={d.operating_expenses} color="#ef4444" isExpense={true} />
              {d.other_income.length > 0 && <PLSection title="Other Income" accounts={d.other_income} color="#22c55e" isExpense={false} />}
              {d.other_expenses.length > 0 && <PLSection title="Other Expenses" accounts={d.other_expenses} color="#ef4444" isExpense={true} />}
              <div className={`flex justify-between text-lg font-bold py-3 mt-3 border-t-4 ${isProfit ? 'border-green-500' : 'border-red-500'}`}>
                <span>Net Profit</span>
                <span className={isProfit ? 'text-green-600' : 'text-red-600'}>{f(netProfit)}</span>
              </div>
              {isProfit ? (
                <div className="mt-3 bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800/30 rounded-lg p-3 flex items-center gap-2 text-green-700 dark:text-green-400 text-sm">
                  <ShieldCheck className="w-4 h-4" /> Company is profitable in this period
                </div>
              ) : (
                <div className="mt-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800/30 rounded-lg p-3 flex items-center gap-2 text-red-700 dark:text-red-400 text-sm">
                  <AlertTriangle className="w-4 h-4" /> Net loss in this period
                </div>
              )}
            </div>

            {/* P&L Charts */}
            <div className="space-y-5">
              <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-5">
                <h4 className="text-xs font-bold uppercase text-gray-500 mb-4">Revenue Breakdown</h4>
                <DonutChart segments={d.revenue.map(a => ({ label: a.account_name, value: a.total, color: '#22c55e' }))} />
              </div>
              <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-5">
                <h4 className="text-xs font-bold uppercase text-gray-500 mb-4">Top Expenses</h4>
                <BarChart data={[
                  ...d.cost_of_sales.slice(0, 3).map(a => ({ label: a.account_name, value: a.total, color: '#ef4444' })),
                  ...d.operating_expenses.slice(0, 3).map(a => ({ label: a.account_name, value: a.total, color: '#f97316' })),
                ]} maxVal={Math.max(...[...d.cost_of_sales, ...d.operating_expenses].map(a => a.total), 1)} />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="bg-green-50 dark:bg-green-900/20 rounded-xl p-4 text-center">
                  <TrendingUp className="w-5 h-5 text-green-600 mx-auto mb-1" />
                  <p className="text-[10px] text-green-600">Revenue</p>
                  <p className="text-lg font-bold text-green-700">{f(totalRev)}</p>
                </div>
                <div className={`rounded-xl p-4 text-center ${isProfit ? 'bg-green-50 dark:bg-green-900/20' : 'bg-red-50 dark:bg-red-900/20'}`}>
                  {isProfit ? <TrendingUp className="w-5 h-5 text-green-600 mx-auto mb-1" /> : <TrendingDown className="w-5 h-5 text-red-600 mx-auto mb-1" />}
                  <p className={`text-[10px] ${isProfit ? 'text-green-600' : 'text-red-600'}`}>Net Profit</p>
                  <p className={`text-lg font-bold ${isProfit ? 'text-green-700' : 'text-red-700'}`}>{f(netProfit)}</p>
                </div>
              </div>
            </div>
          </div>
        );
      })()}

      {/* ==================== BALANCE SHEET TAB ==================== */}
      {tab === 'bs' && bs.data && !bs.isLoading && (() => {
        const d = bs.data;
        const totalAssets = sumArr(d.assets);
        const totalLiab = sumArr(d.liabilities);
        const totalEquity = sumArr(d.equity);
        const isBalanced = Math.abs(totalAssets - (totalLiab + totalEquity)) < 1;

        return (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
            <div className="lg:col-span-2 grid grid-cols-1 md:grid-cols-2 gap-5">
              <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-5">
                <BSSection title="ASSETS" accounts={d.assets} accent="border-blue-500" />
              </div>
              <div className="space-y-5">
                <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-5">
                  <BSSection title="LIABILITIES" accounts={d.liabilities} accent="border-red-500" />
                </div>
                <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-5">
                  <BSSection title="EQUITY" accounts={d.equity} accent="border-purple-500" />
                </div>
                <div className="bg-gray-50 dark:bg-gray-900 rounded-xl p-4">
                  <div className="flex justify-between text-sm font-bold">
                    <span>Total L + E</span>
                    <span className="font-mono">{f(totalLiab + totalEquity)}</span>
                  </div>
                </div>
              </div>
            </div>
            <div className="space-y-5">
              <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-5">
                <h4 className="text-xs font-bold uppercase text-gray-500 mb-4">Asset Breakdown</h4>
                <DonutChart segments={d.assets.map(a => ({
                  label: a.account_name, value: a.total,
                  color: a.code.startsWith('11') ? '#22c55e' : a.code.startsWith('12') ? '#3b82f6' : a.code.startsWith('15') ? '#8b5cf6' : '#6b7280'
                }))} />
              </div>
              {isBalanced ? (
                <div className="bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-200 dark:border-emerald-800/30 rounded-xl p-4 flex items-center gap-3 text-emerald-700 dark:text-emerald-400 font-semibold text-sm">
                  <ShieldCheck className="w-5 h-5" /> Balanced: Assets = L + E
                </div>
              ) : (
                <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800/30 rounded-xl p-4 flex items-center gap-3 text-red-700 dark:text-red-400 font-semibold text-sm">
                  <AlertTriangle className="w-5 h-5" /> Imbalanced by {f(Math.abs(totalAssets - (totalLiab + totalEquity)))}
                </div>
              )}
            </div>
          </div>
        );
      })()}

      {/* ==================== CASH FLOW TAB ==================== */}
      {tab === 'cf' && cf.data && !cf.isLoading && (() => {
        const d = cf.data;
        const opTotal = d.operating.reduce((s, a) => s + a.total, 0);
        const invTotal = d.investing.reduce((s, a) => s + a.total, 0);
        const finTotal = d.financing.reduce((s, a) => s + a.total, 0);
        const netCash = opTotal + invTotal + finTotal;

        return (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
            <div className="lg:col-span-2 space-y-5">
              {[
                { title: 'Operating', items: d.operating, color: 'bg-blue-600', barColor: '#3b82f6', total: opTotal },
                { title: 'Investing', items: d.investing, color: 'bg-purple-600', barColor: '#8b5cf6', total: invTotal },
                { title: 'Financing', items: d.financing, color: 'bg-gray-700', barColor: '#6b7280', total: finTotal },
              ].map(section => (
                <div key={section.title} className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl overflow-hidden">
                  <div className={`${section.color} px-5 py-3 text-white font-bold text-sm`}>{section.title} Activities</div>
                  <div className="p-4 divide-y divide-gray-100 dark:divide-gray-700">
                    {section.items.map((item, i) => (
                      <div key={i} className="flex justify-between py-2 text-xs">
                        <span className="text-gray-600 dark:text-gray-400 pl-4">{item.account_name}</span>
                        <span className={`font-mono font-medium ${item.total >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                          {item.total >= 0 ? '+' : ''}{f(item.total)}
                        </span>
                      </div>
                    ))}
                  </div>
                  <div className="bg-gray-50 dark:bg-gray-900/50 px-5 py-3 flex justify-between font-bold text-sm border-t border-gray-200 dark:border-gray-700">
                    <span>Net {section.title}</span>
                    <span className={`font-mono ${section.total >= 0 ? 'text-green-600' : 'text-red-600'}`}>{f(section.total)}</span>
                  </div>
                </div>
              ))}
              <div className="border-t-4 border-gray-900 dark:border-gray-500 pt-5">
                <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-5 space-y-3">
                  <div className="flex justify-between text-sm"><span className="text-gray-500">Beginning Cash</span><span className="font-mono">{f(d.cash_balance - netCash)}</span></div>
                  <div className="flex justify-between text-sm font-bold"><span>Net Cash Flow</span><span className={`font-mono ${netCash >= 0 ? 'text-green-600' : 'text-red-600'}`}>{f(netCash)}</span></div>
                  <div className="flex justify-between text-lg font-bold pt-3 border-t-2 border-gray-300 dark:border-gray-600">
                    <span>Ending Cash</span><span className="font-mono">{f(d.cash_balance)}</span>
                  </div>
                </div>
              </div>
            </div>
            <div className="space-y-5">
              <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-5">
                <h4 className="text-xs font-bold uppercase text-gray-500 mb-4">Cash Flow Summary</h4>
                <BarChart data={[
                  { label: 'Operating', value: opTotal, color: '#3b82f6' },
                  { label: 'Investing', value: invTotal, color: '#8b5cf6' },
                  { label: 'Financing', value: finTotal, color: '#6b7280' },
                ]} maxVal={Math.max(Math.abs(opTotal), Math.abs(invTotal), Math.abs(finTotal), 1)} />
              </div>
              <div className={`rounded-xl p-5 text-center ${netCash >= 0 ? 'bg-green-50 dark:bg-green-900/20' : 'bg-red-50 dark:bg-red-900/20'}`}>
                {netCash >= 0 ? <TrendingUp className="w-6 h-6 text-green-600 mx-auto mb-1" /> : <TrendingDown className="w-6 h-6 text-red-600 mx-auto mb-1" />}
                <p className="text-[10px] text-gray-500">Net Cash Flow</p>
                <p className={`text-2xl font-bold ${netCash >= 0 ? 'text-green-700' : 'text-red-700'}`}>{f(netCash)}</p>
              </div>
              <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-5 text-center">
                <p className="text-[10px] text-gray-500">Current Cash Balance</p>
                <p className="text-2xl font-bold text-gray-900 dark:text-white">{f(d.cash_balance)}</p>
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}