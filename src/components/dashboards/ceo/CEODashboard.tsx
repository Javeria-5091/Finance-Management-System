'use client';

import { useState } from 'react';
import {
  RefreshCw, TrendingUp, TrendingDown, Wallet, ArrowDownLeft, ArrowUpRight,
  AlertTriangle, Sparkles, Building2, Landmark, ArrowRight, Clock,
  Calendar
} from 'lucide-react';
import Link from 'next/link';
import {
  useCEOKPIs, useMonthlyRevExp, useCategories, useAging, useCashAccounts,
  useBudgetActual, useEquityTax, useAudit, useFiscal, useApprovals,
  useUnreconciled, useProjectProfit
} from '@/hooks/useDashboard';
import type {
  MonthlyRevenue, CategoriesData, AgingBoth, CashAccount, BudgetData,
  ShareholderData, TaxData, AuditEntry, FiscalPeriod, ProjectProfit
} from '@/types/dashboard.types';

// ==========================================
// FORMATTING
// ==========================================
const f = (n: number) =>
  new Intl.NumberFormat('en-PK', {
    style: 'currency', currency: 'PKR',
    minimumFractionDigits: 0, maximumFractionDigits: 0
  }).format(n || 0);

const pct = (a: number, b: number) => (b === 0 ? 0 : ((a - b) / b) * 100);

const instIcon = (t: string) =>
  t === 'BANK' ? <Building2 className="w-4 h-4 text-blue-500" /> :
  t === 'WALLET' ? <Wallet className="w-4 h-4 text-green-500" /> :
  <Landmark className="w-4 h-4 text-orange-500" />;

// ==========================================
// MINI CHART COMPONENTS
// ==========================================

function LineChart({ data, height = 120 }: { data: MonthlyRevenue[]; height?: number }) {
  if (!data?.length) return <p className="text-xs text-gray-400 text-center py-8">No data</p>;
  const max = Math.max(...data.flatMap(d => [d.revenue, d.expenses]), 1);
  const w = 100;
  const h = height - 24;

  const revenuePoints = data.map((d, i) => {
    const x = data.length === 1 ? w / 2 : (i / (data.length - 1)) * w;
    const y = h - (d.revenue / max) * (h - 4);
    return `${x},${y}`;
  }).join(' ');

  const expensePoints = data.map((d, i) => {
    const x = data.length === 1 ? w / 2 : (i / (data.length - 1)) * w;
    const y = h - (d.expenses / max) * (h - 4);
    return `${x},${y}`;
  }).join(' ');

  const months = data.map(d => d.month_short);

  return (
    <div style={{ width: '100%' }}>
      <div className="relative" style={{ width: '100%', height }}>
        <svg viewBox={`0 0 ${w} ${h}`} className="w-full" preserveAspectRatio="none">
          <line x1="0" y1={h - 2} x2={w} y2={h - 2} stroke="#e5e7eb" strokeWidth="0.5" />
          <polyline fill="none" stroke="#3b82f6" strokeWidth="2" points={revenuePoints} />
          <polyline fill="none" stroke="#ef4444" strokeWidth="2" strokeDasharray="4 3" points={expensePoints} />
          {months.map((m, i) => {
            const x = data.length === 1 ? w / 2 : (i / (months.length - 1)) * w;
            return (
              <text key={i} x={x} y={h - 2} textAnchor="middle" className="text-[9px] fill-gray-400">{m}</text>
            );
          })}
        </svg>
        <div className="flex items-center justify-center gap-4 mt-2">
          <div className="flex items-center gap-1">
            <div className="w-3 h-0.5 rounded" style={{ backgroundColor: '#3b82f6' }} />
            <span className="text-[10px] text-gray-500">Revenue</span>
          </div>
          <div className="flex items-center gap-1">
            <div className="w-3 h-0.5 rounded" style={{ backgroundColor: '#ef4444', borderTop: '1px dashed #ef4444' }} />
            <span className="text-[10px] text-gray-500">Expenses</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function DonutChart({ data, size = 80, centerValue, centerLabel }: {
  data: { category: string; total: number }[];
  size?: number;
  centerValue?: string;
  centerLabel?: string;
}) {
  if (!data?.length) return <p className="text-xs text-gray-400 text-center py-6">No data</p>;
  const total = data.reduce((s, d) => s + d.total, 0) || 1;
  const colors = ['#3b82f6', '#ef4444', '#f97316', '#22c55e', '#8b5cf6', '#06b6d4', '#f43f5e', '#a855f7'];
  let cumPct = 0;
  const segments = data.map(d => {
    const p = (d.total / total) * 100;
    const start = cumPct;
    cumPct += p;
    return { ...d, pct: p, start, end: cumPct };
  });

  return (
    <div className="flex items-center gap-4">
      <div className="relative flex-shrink-0" style={{ width: size, height: size }}>
        <svg viewBox="0 0 42 42" className="w-full h-full -rotate-90">
          {segments.map((s, i) => (
            <circle key={i} cx="21" cy="21" r="15.915" fill="none"
              stroke={colors[i % colors.length]}
              strokeWidth="5"
              strokeDasharray={`${s.pct * 1.006} ${100 - s.pct * 1.006}`}
              strokeDashoffset={-s.start * 1.006} />
          ))}
        </svg>
        {centerValue !== undefined && (
          <div className="absolute inset-0 flex items-center justify-center flex-col">
            <span className="text-[10px] font-bold text-gray-700 dark:text-gray-300">{centerValue}</span>
            {centerLabel && <span className="text-[8px] text-gray-500">{centerLabel}</span>}
          </div>
        )}
      </div>
      <div className="flex-1 space-y-1 min-w-0">
        {data.map((d, i) => (
          <div key={i} className="flex items-center gap-2">
            <div className="w-2.5 h-2.5 rounded-sm flex-shrink-0" style={{ backgroundColor: colors[i % colors.length] }} />
            <span className="text-[11px] text-gray-600 dark:text-gray-400 truncate">{d.category}</span>
            <span className="text-[11px] font-medium text-gray-900 dark:text-white ml-auto flex-shrink-0">{f(d.total)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function HorizontalBars({ data, maxVal, color = '#3b82f6' }: {
  data: { label: string; value: number }[];
  maxVal?: number;
  color?: string;
}) {
  const max = maxVal || Math.max(...data.map(d => d.value), 1);
  return (
    <div className="space-y-2">
      {data.map((d, i) => (
        <div key={i}>
          <div className="flex items-center justify-between mb-1">
            <span className="text-[11px] text-gray-600 dark:text-gray-400">{d.label}</span>
            <span className="text-[11px] font-medium text-gray-900 dark:text-white">{f(d.value)}</span>
          </div>
          <div className="w-full bg-gray-100 dark:bg-gray-700 rounded-full h-2">
            <div className="h-2 rounded-full transition-all" style={{ width: `${(d.value / max) * 100}%`, backgroundColor: color }} />
          </div>
        </div>
      ))}
    </div>
  );
}

function StackedBar({ data, maxVal, colors }: {
  data: { label: string; values: { label: string; value: number }[] }[];
  maxVal?: number;
  colors?: string[];
}) {
  const allValues = data.flatMap(d => d.values.map(v => v.value));
  const max = maxVal || Math.max(...allValues, 1);
  return (
    <div className="space-y-3">
      {data.map((d, i) => (
        <div key={i}>
          <span className="text-[11px] text-gray-600 dark:text-gray-400 mb-1 block">{d.label}</span>
          <div className="flex h-5 rounded overflow-hidden">
            {d.values.map((v, j) => (
              <div key={j} className="transition-all" style={{ width: `${(v.value / max) * 100}%`, backgroundColor: colors?.[j] || '#3b82f6' }} />
            ))}
          </div>
          <div className="flex flex-wrap gap-2 mt-1">
            {d.values.map((v, j) => (
              <div key={j} className="flex items-center gap-1">
                <div className="w-2 h-2 rounded-sm" style={{ backgroundColor: colors?.[j] || '#3b82f6' }} />
                <span className="text-[9px] text-gray-500">{v.label}: {f(v.value)}</span>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function WaterfallChart({ data }: { data: { label: string; value: number; color?: string; isTotal?: boolean }[] }) {
  const max = Math.max(...data.map(d => Math.abs(d.value)), 1);
  let cum = 0;
  const running: number[] = [];
  for (const d of data) {
    cum += d.value;
    running.push(cum);
  }

  return (
    <div className="space-y-1.5">
      {data.map((d, i) => {
        const isTotal = d.isTotal;
        const barWidth = (Math.abs(d.value) / max) * 100;
        const offset = i === 0 ? 0 : Math.max(running[i - 1], 0);
        return (
          <div key={i} className="flex items-center gap-2">
            <span className={`text-[10px] text-gray-500 w-28 text-right flex-shrink-0 ${isTotal ? 'font-semibold text-gray-700 dark:text-gray-300' : ''}`}>{d.label}</span>
            <div className="flex-1 h-5 bg-gray-100 dark:bg-gray-700 rounded overflow-hidden relative">
              {offset > 0 && <div className="absolute left-0 top-0 h-full bg-white dark:bg-gray-800" style={{ width: `${(offset / max) * 100}%` }} />}
              <div className="absolute top-0 h-full transition-all"
                style={{ left: `${(offset / max) * 100}%`, width: `${barWidth}%`, backgroundColor: d.color || '#3b82f6' }} />
            </div>
            <span className={`text-[10px] font-medium w-20 text-right flex-shrink-0 ${isTotal ? 'text-gray-900 dark:text-white font-bold' : 'text-gray-600 dark:text-gray-400'}`}>
              {isTotal ? f(d.value) : (d.value > 0 ? `+${f(d.value)}` : f(d.value))}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function ProgressTimeline({ data }: { data: FiscalPeriod[] }) {
  const totalMonths = data.reduce((s, p) => s + p.total_months, 0);
  let cumMonths = 0;
  return (
    <div className="space-y-2">
      {data.map((p) => {
        const startPct = totalMonths > 0 ? (cumMonths / totalMonths) * 100 : 0;
        const widthPct = totalMonths > 0 ? (p.total_months / totalMonths) * 100 : 0;
        cumMonths += p.total_months;
        const statusColor = p.status === 'OPEN' ? '#22c55e' : p.status === 'SOFT_CLOSED' ? '#f59e0b' : '#9ca3af';
        const statusLabel = p.status === 'OPEN' ? 'Open' : p.status === 'SOFT_CLOSED' ? 'Soft Closed' : 'Hard Closed';
        return (
          <div key={p.id} className="flex items-center gap-3">
            <div className="w-8 text-[10px] text-gray-500 text-right">{p.month_num}</div>
            <div className="flex-1 h-6 bg-gray-100 dark:bg-gray-700 rounded-full overflow-hidden relative">
              <div className="absolute top-0 left-0 h-full bg-gray-300 dark:bg-gray-600" style={{ width: `${startPct}%` }} />
              <div className="absolute top-0 h-full transition-all" style={{ left: `${startPct}%`, width: `${widthPct}%`, backgroundColor: statusColor }} />
            </div>
            <div className="w-24 text-[10px] text-right">
              <span style={{ color: p.status === 'OPEN' ? '#16a34a' : '#6b7280' }}>{statusLabel}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ==========================================
// SECTION COMPONENTS
// ==========================================

function KpiCard({ label, value, prevValue, icon: Icon, color, bg }: {
  label: string; value: number; prevValue?: number; icon: any; color: string; bg: string;
}) {
  const change = prevValue ? pct(value, prevValue) : null;
  const isPos = change !== null && change >= 0;
  return (
    <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-4 hover:shadow-md transition-shadow">
      <div className="flex items-start justify-between mb-3">
        <div className={`p-2.5 rounded-lg ${bg}`}><Icon className={`w-5 h-5 ${color}`} /></div>
        {change !== null && (
          <div className={`flex items-center gap-1 text-xs font-medium ${isPos ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
            {isPos ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
            {Math.abs(change).toFixed(1)}%
          </div>
        )}
      </div>
      <p className="text-2xl font-bold text-gray-900 dark:text-white">{f(value)}</p>
      <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">{label}</p>
    </div>
  );
}

function SectionCard({ title, children, className = '' }: { title: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={`bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl ${className}`}>
      <div className="flex items-center justify-between p-4 border-b border-gray-200 dark:border-gray-700">
        <h3 className="font-semibold text-gray-900 dark:text-white text-sm">{title}</h3>
      </div>
      <div className="p-4">{children}</div>
    </div>
  );
}

function RiskBadge({ count, label, icon: Icon, color }: { count: number; label: string; icon: any; color: string }) {
  if (count === 0) return null;
  return (
    <div className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium ${color}`}>
      <Icon className="w-3.5 h-3.5" />
      <span>{count} {label}</span>
    </div>
  );
}

// ==========================================
// MAIN CEO DASHBOARD (NAMED EXPORT)
// ==========================================

export function CEODashboard() {
  const [showAllApprovals, setShowAllApprovals] = useState(false);
  const [showAllAudit, setShowAllAudit] = useState(false);

  const kpis = useCEOKPIs();
  const monthly = useMonthlyRevExp();
  const categories = useCategories();
  const aging = useAging();
  const cash = useCashAccounts();
  const budget = useBudgetActual();
  const equityTax = useEquityTax();
  const audit = useAudit();
  const fiscal = useFiscal();
  const approvals = useApprovals();
  const unreconciled = useUnreconciled();
  const projects = useProjectProfit();

  const d = kpis.data;
  const tax = equityTax.data?.tax;
  const shareholders = equityTax.data?.shareholders;
  const agingData = aging.data;
  const catData = categories.data;
  //const isLoading = kpis.isLoading || monthly.isLoading;

  //if (isLoading) {
    //return (
     // <div className="flex items-center justify-center min-h-[60vh]">
        //<RefreshCw className="w-8 h-8 text-blue-500 animate-spin mx-auto" />
      //</div>
    //);
  //}

  const totalExpensesMTD = (d?.cogs_mtd || 0) + (d?.opex_mtd || 0) + (d?.other_expense_mtd || 0);
  const hasRisks = d && ((d.risk_overdue_receivables ?? 0) > 0 || (d.risk_overdue_payables ?? 0) > 0 || (d.risk_unreconciled ?? 0) > 0 || (d.risk_pending_period_close ?? 0) > 0);

  const assetBarData = {
    label: 'Assets',
    values: (catData?.assets || []).map(a => ({ label: a.category, value: Math.abs(a.total) }))
  };
  const liabilityBarData = {
    label: 'Liabilities',
    values: (catData?.liabilities || []).map(l => ({ label: l.category, value: Math.abs(l.total) }))
  };
  const barColors = ['#6366f1', '#f97316', '#22c55e', '#06b6d4', '#f43f5e', '#8b5cf6'];

  const fyStart = fiscal.data?.[0]?.start_date?.slice(0, 4) || '2025';
  const fyEnd = fiscal.data?.[fiscal.data?.length - 1]?.end_date?.slice(0, 4) || '2026';

  return (
    <div className="p-6 max-w-[1700px] mx-auto space-y-5">

      {/* ====== ROW 0: RISK ALERTS ====== */}
      {hasRisks && d && (
        <div className="flex flex-wrap gap-2 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800/30 rounded-xl">
          <RiskBadge count={d.risk_overdue_receivables ?? 0} label="Overdue Receivables" icon={AlertTriangle} color="bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400" />
          <RiskBadge count={d.risk_overdue_payables ?? 0} label="Overdue Payables" icon={AlertTriangle} color="bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400" />
          <RiskBadge count={d.risk_unreconciled ?? 0} label="Unreconciled Accounts" icon={AlertTriangle} color="bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400" />
          <RiskBadge count={d.risk_pending_period_close ?? 0} label="Pending Close" icon={Clock} color="bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400" />
          <Link href="/dashboard/admin/audit-log" className="ml-auto text-xs text-red-600 hover:underline flex items-center gap-1">
            View All <ArrowRight className="w-3 h-3" />
          </Link>
        </div>
      )}

      {/* ====== ROW 1: KPI CARDS ====== */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        <KpiCard label="Revenue (MTD)" value={d?.revenue_mtd || 0} prevValue={d?.revenue_prev || 0} icon={TrendingUp} color="text-blue-600 dark:text-blue-400" bg="bg-blue-50 dark:bg-blue-900/20" />
        <KpiCard label="Expenses (MTD)" value={totalExpensesMTD} icon={ArrowUpRight} color="text-red-600 dark:text-red-400" bg="bg-red-50 dark:bg-red-900/20" />
        <KpiCard label="Net Profit (MTD)" value={d?.net_profit_mtd || 0} prevValue={d?.net_profit_prev || 0} icon={TrendingUp} color="text-green-600 dark:text-green-400" bg="bg-green-50 dark:bg-green-900/20" />
        <KpiCard label="Total Cash" value={d?.total_cash || 0} icon={Wallet} color="text-emerald-600 dark:text-emerald-400" bg="bg-emerald-50 dark:bg-emerald-900/20" />
        <KpiCard label="Receivables" value={d?.accounts_receivable || 0} icon={ArrowDownLeft} color="text-amber-600 dark:text-amber-400" bg="bg-amber-50 dark:bg-amber-900/20" />
        <KpiCard label="Payables" value={d?.accounts_payable || 0} icon={ArrowUpRight} color="text-rose-600 dark:text-rose-400" bg="bg-rose-50 dark:bg-rose-900/20" />
      </div>

      {/* ====== ROW 2: CHARTS ROW ====== */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        <SectionCard title="Revenue vs Expenses Trend (6 Months)" className="lg:col-span-2">
          <LineChart data={monthly.data || []} height={160} />
        </SectionCard>
        <SectionCard title="Expense Breakdown (MTD)">
          <DonutChart data={catData?.expenses || []} size={90} centerValue={f(totalExpensesMTD)} centerLabel="Total" />
        </SectionCard>
      </div>

      {/* ====== ROW 3: ASSETS/LIABILITIES + AGING + APPROVALS ====== */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        <SectionCard title="Assets vs Liabilities">
          <div className="grid grid-cols-2 gap-4 mb-3">
            <div>
              <p className="text-[10px] uppercase text-gray-500 mb-1">Total Assets</p>
              <p className="text-lg font-bold text-gray-900 dark:text-white">{f(d?.total_assets || 0)}</p>
            </div>
            <div>
              <p className="text-[10px] uppercase text-gray-500 mb-1">Total Liabilities</p>
              <p className="text-lg font-bold text-red-600">{f(d?.total_liabilities || 0)}</p>
            </div>
          </div>
          <StackedBar data={[assetBarData, liabilityBarData]} colors={barColors} />
          <p className="text-[10px] text-gray-500 mt-2">
            Net Worth: <span className="font-medium text-gray-700 dark:text-gray-300">{f((d?.total_assets || 0) - (d?.total_liabilities || 0))}</span>
          </p>
        </SectionCard>

        <SectionCard title="Receivable Aging">
          <p className="text-xs text-gray-500 mb-3">
            Outstanding: <span className="font-medium text-gray-700 dark:text-gray-300">{f(agingData?.receivable?.total || 0)}</span>
          </p>
          <HorizontalBars
            data={[
              { label: 'Current', value: agingData?.receivable?.current || 0 },
              { label: '1-30 days', value: agingData?.receivable?.overdue_1_30 || 0 },
              { label: '31-60 days', value: agingData?.receivable?.overdue_31_60 || 0 },
              { label: '61-90 days', value: agingData?.receivable?.overdue_61_90 || 0 },
              { label: '90+ days', value: agingData?.receivable?.overdue_over_90 || 0 },
            ]}
            maxVal={agingData?.receivable?.total || 1}
            color="#f59e0b"
          />
        </SectionCard>

        <SectionCard title="Pending Approvals">
          <div className="flex flex-wrap gap-2 mb-3">
            <div className="px-3 py-2 bg-blue-50 dark:bg-blue-900/20 rounded-lg text-center">
              <p className="text-2xl font-bold text-blue-700 dark:text-blue-400">{d?.pending_approvals || 0}</p>
              <p className="text-[10px] text-blue-600 dark:text-blue-400">Total Pending</p>
            </div>
          </div>
          <div className="space-y-2 max-h-48 overflow-y-auto">
            {(showAllApprovals ? approvals.data || [] : (approvals.data || []).slice(0, 5)).map(item => (
              <div key={item.id} className="flex items-center justify-between p-2 hover:bg-gray-50 dark:hover:bg-gray-700/30 rounded-lg">
                <div className="flex items-center gap-2 flex-1 min-w-0">
                  <span className={`text-[10px] px-1.5 py-0.5 rounded flex-shrink-0 ${
                    item.module_type === 'INVOICE' ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400' :
                    item.module_type === 'VENDOR_BILL' ? 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400' :
                    'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300'
                  }`}>
                    {item.module_type}
                  </span>
                  <span className="text-xs text-gray-700 dark:text-gray-300 truncate">{item.description}</span>
                </div>
                <span className="text-sm font-semibold text-gray-900 dark:text-white flex-shrink-0 ml-2">{f(item.amount)}</span>
              </div>
            ))}
            {(!approvals.data?.length) && <p className="text-xs text-gray-400 text-center py-4">No pending approvals</p>}
          </div>
          {(approvals.data?.length || 0) > 5 && (
            <button onClick={() => setShowAllApprovals(!showAllApprovals)} className="w-full text-xs text-blue-600 dark:text-blue-400 hover:underline text-center pt-2">
              {showAllApprovals ? 'Show Less' : `Show ${(approvals.data?.length || 0) - 5} More`}
            </button>
          )}
        </SectionCard>
      </div>

      {/* ====== ROW 4: PROJECTS + SHAREHOLDERS ====== */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        <SectionCard title="Project Profitability" className="lg:col-span-2">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 dark:bg-gray-900/50 text-[10px] uppercase text-gray-500 dark:text-gray-400">
                  <th className="text-left px-3 py-2">Project</th>
                  <th className="text-left px-3 py-2">Client</th>
                  <th className="text-right px-3 py-2">Revenue</th>
                  <th className="text-right px-3 py-2">Costs</th>
                  <th className="text-right px-3 py-2">Profit</th>
                  <th className="text-center px-3 py-2">Margin</th>
                </tr>
              </thead>
              <tbody>
                {(projects.data || []).map(p => {
                  const margin = p.revenue > 0 ? (p.gross_profit / p.revenue * 100) : 0;
                  return (
                    <tr key={p.id} className="border-t border-gray-100 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-700/30">
                      <td className="px-3 py-2 text-gray-900 dark:text-white font-medium truncate max-w-[150px]">{p.project_name}</td>
                      <td className="px-3 py-2 text-gray-500 truncate max-w-[120px]">{p.client_name}</td>
                      <td className="px-3 py-2 text-right">{f(p.revenue)}</td>
                      <td className="px-3 py-2 text-right text-red-600">{f(p.costs)}</td>
                      <td className="px-3 py-2 text-right font-semibold text-green-600">{f(p.gross_profit)}</td>
                      <td className="px-3 py-2 text-center">
                        <span className={`px-2 py-0.5 rounded-full text-[10px] font-medium ${
                          margin >= 50 ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400' :
                          margin >= 30 ? 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400' :
                          'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400'
                        }`}>{margin.toFixed(1)}%</span>
                      </td>
                    </tr>
                  );
                })}
                {(!projects.data?.length) && (
                  <tr><td colSpan={6} className="text-sm text-gray-400 text-center py-6">No project data</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </SectionCard>

        <SectionCard title="Shareholder & Equity">
          <WaterfallChart data={[
            { label: 'Owner Capital', value: d?.owner_capital || 0, color: '#6366f1' },
            { label: 'Retained Earn.', value: d?.retained_earnings || 0, color: '#8b5cf6' },
            { label: 'Reserves', value: d?.reserve_balance || 0, color: '#06b6d4' },
            { label: 'Drawings', value: -(d?.owner_drawings || 0), color: '#f43f5e' },
            { label: 'Net Equity', value: (d?.owner_capital || 0) + (d?.retained_earnings || 0) + (d?.reserve_balance || 0) - (d?.owner_drawings || 0), color: '#22c55e', isTotal: true },
          ]} />
        </SectionCard>
      </div>

      {/* ====== ROW 5: TAX + PAYABLE AGING ====== */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <SectionCard title="Tax Reconciliation (MTD)">
          <WaterfallChart data={[
            { label: 'Profit Before Tax', value: tax?.profit_before_tax || 0, color: '#3b82f6' },
            { label: 'Estimated Tax', value: -(tax?.estimated_tax || 0), color: '#8b5cf6' },
            { label: 'WHT Credits', value: tax?.withholding_credits || 0, color: '#22c55e' },
            { label: 'Tax Payable', value: tax?.tax_payable || 0, color: '#ef4444', isTotal: true },
          ]} />
          <div className="grid grid-cols-2 gap-3 mt-4">
            <div className="p-2 bg-purple-50 dark:bg-purple-900/20 rounded-lg text-center">
              <p className="text-[10px] text-purple-600 dark:text-purple-400">Tax Payable</p>
              <p className="text-lg font-bold text-purple-700 dark:text-purple-400">{f(tax?.tax_payable || 0)}</p>
            </div>
            <div className="p-2 bg-green-50 dark:bg-green-900/20 rounded-lg text-center">
              <p className="text-[10px] text-green-600 dark:text-green-400">Profit After Tax</p>
              <p className="text-lg font-bold text-green-700 dark:text-green-400">{f(tax?.profit_after_tax || 0)}</p>
            </div>
          </div>
        </SectionCard>

        <SectionCard title="Payable Aging">
          <p className="text-xs text-gray-500 mb-3">
            Outstanding: <span className="font-medium text-gray-700 dark:text-gray-300">{f(agingData?.payable?.total || 0)}</span>
          </p>
          <HorizontalBars
            data={[
              { label: 'Current', value: agingData?.payable?.current || 0 },
              { label: '1-30 days', value: agingData?.payable?.overdue_1_30 || 0 },
              { label: '31-60 days', value: agingData?.payable?.overdue_31_60 || 0 },
              { label: '61-90 days', value: agingData?.payable?.overdue_61_90 || 0 },
              { label: '90+ days', value: agingData?.payable?.overdue_over_90 || 0 },
            ]}
            maxVal={agingData?.payable?.total || 1}
            color="#ef4444"
          />
        </SectionCard>
      </div>

      {/* ====== ROW 6: CASH + RUNWAY + STATS ====== */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        <SectionCard title="Cash by Account" className="lg:col-span-2">
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            {(cash.data || []).slice(0, 6).map(acc => (
              <div key={acc.id} className="p-3 bg-gray-50 dark:bg-gray-900/30 rounded-lg border border-gray-200 dark:border-gray-700">
                <div className="flex items-center gap-2 mb-2">
                  {instIcon(acc.institution_type)}
                  <span className="text-xs text-gray-700 dark:text-gray-300 truncate">{acc.account_name}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-xs text-gray-500">{acc.masked_identifier || acc.currency}</span>
                  <span className="text-sm font-bold text-gray-900 dark:text-white">{f(acc.balance)}</span>
                </div>
                <div className="w-full bg-gray-200 dark:bg-gray-600 rounded-full h-1.5 mt-2">
                  <div className="h-1.5 bg-emerald-500 rounded-full" style={{ width: `${Math.min((Math.abs(acc.balance) / Math.max(d?.total_cash || 1, 1)) * 100, 100)}%` }} />
                </div>
              </div>
            ))}
            {(!cash.data?.length) && <p className="text-xs text-gray-400 col-span-3 text-center py-4">No cash accounts</p>}
          </div>
          <p className="text-xs text-gray-500 mt-3 text-center">
            Total Cash: <span className="font-medium text-gray-700 dark:text-gray-300">{f(d?.total_cash || 0)}</span> PKR
          </p>
        </SectionCard>

        <div className="space-y-5">
          <SectionCard title="Cash Runway">
            <div className="flex items-center gap-4">
              <div className="p-3 bg-emerald-50 dark:bg-emerald-900/20 rounded-lg">
                <p className="text-3xl font-bold text-emerald-700 dark:text-emerald-400">{d?.cash_runway_months || 0}</p>
                <p className="text-[10px] text-emerald-600 dark:text-emerald-400">months</p>
              </div>
              <div className="text-xs text-gray-500">Based on avg. monthly expense of {f(totalExpensesMTD)}</div>
            </div>
          </SectionCard>

          <SectionCard title="Quick Stats">
            <div className="space-y-2 text-xs">
              <div className="flex justify-between"><span className="text-gray-500">Current Assets</span><span className="font-medium text-gray-900 dark:text-white">{f(d?.current_assets || 0)}</span></div>
              <div className="flex justify-between"><span className="text-gray-500">Current Liabilities</span><span className="font-medium text-red-600">{f(d?.current_liabilities || 0)}</span></div>
              <div className="flex justify-between"><span className="text-gray-500">Fixed Assets (Net)</span><span className="font-medium text-gray-900 dark:text-white">{f(d?.fixed_assets_net || 0)}</span></div>
              <div className="flex justify-between"><span className="text-gray-500">Unreconciled Lines</span><span className="font-medium text-orange-600">{d?.unreconciled_lines || 0}</span></div>
            </div>
          </SectionCard>
        </div>
      </div>

      {/* ====== ROW 7: BUDGET + FISCAL ====== */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <SectionCard title="Budget vs Actual (MTD)">
          <StackedBar
            data={(budget.data || []).map(b => ({
              label: b.category,
              values: [
                { label: 'Budget', value: b.budget },
                { label: 'Actual', value: b.actual },
              ],
            }))}
            maxVal={Math.max(...(budget.data || []).map(b => Math.max(b.budget, b.actual)), 1)}
            colors={['#6366f1', '#3b82f6']}
          />
          <div className="flex gap-4 mt-3">
            {budget.data?.some(b => b.variance < 0) && <span className="text-xs text-green-600">● Under budget</span>}
            {budget.data?.some(b => b.variance > 0) && <span className="text-xs text-red-600">● Over budget</span>}
            {(!budget.data?.length) && <span className="text-xs text-gray-400">No budget data</span>}
          </div>
        </SectionCard>

        <SectionCard title="Fiscal Year Progress">
          <div className="mb-3">
            <div className="flex items-center gap-2">
              <Calendar className="w-4 h-4 text-blue-500" />
              <p className="text-sm font-medium text-gray-900 dark:text-white">FY {fyStart}-{fyEnd}</p>
            </div>
          </div>
          <ProgressTimeline data={fiscal.data || []} />
          <div className="flex gap-3 mt-3 text-[10px]">
            <span className="flex items-center gap-1"><div className="w-2 h-2 rounded-full" style={{ backgroundColor: '#22c55e' }} /> Open</span>
            <span className="flex items-center gap-1"><div className="w-2 h-2 rounded-full" style={{ backgroundColor: '#f59e0b' }} /> Soft Closed</span>
            <span className="flex items-center gap-1"><div className="w-2 h-2 rounded-full" style={{ backgroundColor: '#9ca3af' }} /> Hard Closed</span>
          </div>
        </SectionCard>
      </div>

      {/* ====== ROW 8: AUDIT + CURRENCY ====== */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        <SectionCard title="Recent Audit Trail" className="lg:col-span-2">
          <div className="overflow-x-auto max-h-64">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-gray-50 dark:bg-gray-900/50 text-[9px] uppercase text-gray-500 dark:text-gray-400">
                  <th className="text-left px-3 py-2">When</th>
                  <th className="text-left px-3 py-2">Who</th>
                  <th className="text-left px-3 py-2">Action</th>
                  <th className="text-left px-3 py-2">Module</th>
                  <th className="text-left px-3 py-2">Details</th>
                </tr>
              </thead>
              <tbody>
                {(showAllAudit ? audit.data || [] : (audit.data || []).slice(0, 8)).map(a => (
                  <tr key={a.id} className="border-t border-gray-100 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-700/30">
                    <td className="px-3 py-2 text-gray-500 whitespace-nowrap">
                      {new Date(a.created_at).toLocaleDateString('en-PK', { day: '2-digit', month: 'short', year: 'numeric' })}
                    </td>
                    <td className="px-3 py-2 text-gray-700 dark:text-gray-300">{a.user_name || 'System'}</td>
                    <td className="px-3 py-2">
                      <span className={`px-1.5 py-0.5 rounded text-[9px] ${
                        a.action.includes('DELETE') ? 'bg-red-100 text-red-700' :
                        a.action.includes('UPDATE') ? 'bg-amber-100 text-amber-700' :
                        'bg-blue-50 text-blue-700 dark:bg-blue-900/20 dark:text-blue-400'
                      }`}>{a.action}</span>
                    </td>
                    <td className="px-3 py-2 text-gray-500 truncate max-w-[120px]">{a.module}</td>
                    <td className="px-3 py-2 text-gray-400 truncate max-w-[200px]">{a.details?.slice(0, 80)}</td>
                  </tr>
                ))}
                {(!audit.data?.length) && (
                  <tr><td colSpan={5} className="text-sm text-gray-400 text-center py-6">No audit entries</td></tr>
                )}
              </tbody>
            </table>
          </div>
          {(audit.data?.length || 0) > 8 && (
            <button onClick={() => setShowAllAudit(!showAllAudit)} className="w-full text-xs text-blue-600 dark:text-blue-400 hover:underline text-center pt-2">
              {showAllAudit ? 'Show Less' : `View All ${audit.data?.length || 0} entries`}
            </button>
          )}
        </SectionCard>

        <SectionCard title="Multi-Currency Summary">
          <div className="space-y-3">
            {(cash.data || []).filter(a => a.currency !== 'PKR').slice(0, 4).map(acc => (
              <div key={acc.id} className="p-3 bg-gray-50 dark:bg-gray-900/30 rounded-lg border border-gray-200 dark:border-gray-700">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    {instIcon(acc.institution_type)}
                    <span className="text-xs text-gray-700 dark:text-gray-300 truncate">{acc.account_name}</span>
                  </div>
                  <span className="text-sm font-medium text-gray-900 dark:text-white">{f(acc.balance)}</span>
                </div>
                <p className="text-[10px] text-gray-500 mt-1">{acc.currency} → PKR (consolidated on statements)</p>
              </div>
            ))}
            {!(cash.data || []).some(a => a.currency !== 'PKR') && (
              <p className="text-xs text-gray-400 text-center py-6">No foreign currency accounts</p>
            )}
          </div>
        </SectionCard>
      </div>

      {/* ====== ROW 9: RESERVE + DISTRIBUTABLE ====== */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
        <SectionCard title="Reserve Balance" className="border-2 border-cyan-200 dark:border-cyan-800/30">
          <div className="text-center py-4">
            <p className="text-3xl font-bold text-cyan-700 dark:text-cyan-400">{f(d?.reserve_balance || 0)}</p>
            <p className="text-xs text-cyan-600 dark:text-cyan-400 mt-1">Reserve Balance</p>
          </div>
        </SectionCard>

        <SectionCard title="Distributable Profit" className="border-2 border-emerald-200 dark:border-emerald-800/30 bg-emerald-50/30 dark:bg-emerald-900/10">
          <div className="text-center py-4">
            <p className="text-xs text-emerald-600 dark:text-emerald-400 mb-1">Available for Distribution</p>
            <p className="text-3xl font-bold text-emerald-700 dark:text-emerald-400">{f(d?.distributable_profit || 0)}</p>
            <div className="flex items-center justify-center gap-3 mt-2 text-[10px] text-emerald-600 dark:text-emerald-400">
              <span>Profit: {f(d?.net_profit_mtd || 0)}</span>
              <span>- Tax: {f(tax?.estimated_tax || 0)}</span>
              <span>- Reserve: {f(d?.reserve_balance || 0)}</span>
            </div>
          </div>
        </SectionCard>
      </div>

      {/* ====== AI ASSISTANT HINT ====== */}
      <div className="bg-gradient-to-r from-blue-50 to-purple-50 dark:from-blue-900/20 dark:to-purple-900/20 border border-blue-200 dark:border-blue-800/30 rounded-xl p-5">
        <div className="flex items-start gap-4">
          <div className="p-2.5 bg-blue-100 dark:bg-blue-900/30 rounded-xl flex-shrink-0">
            <Sparkles className="w-6 h-6 text-blue-600 dark:text-blue-400" />
          </div>
          <div className="flex-1">
            <h3 className="font-semibold text-gray-900 dark:text-white mb-1">AI Financial Assistant</h3>
            <p className="text-sm text-gray-600 dark:text-gray-400">
              {(d?.risk_overdue_receivables ?? 0) > 0 && <><strong>{d?.risk_overdue_receivables}</strong> overdue receivable{(d?.risk_overdue_receivables ?? 0) === 1 ? '' : 's'}. </>}
              {(d?.risk_overdue_payables ?? 0) > 0 && <><strong>{d?.risk_overdue_payables}</strong> overdue payable{(d?.risk_overdue_payables ?? 0) === 1 ? '' : 's'}. </>}
              {(d?.risk_unreconciled ?? 0) > 0 && <><strong>{d?.risk_unreconciled}</strong> unreconciled account{(d?.risk_unreconciled ?? 0) === 1 ? '' : 's'}. </>}
              {(d?.cash_runway_months ?? 0) > 0 && (d?.cash_runway_months ?? 0) < 3 && <><strong>Only {d?.cash_runway_months} month{(d?.cash_runway_months ?? 0) === 1 ? '' : 's'}</strong> cash runway remaining. </>}
              {!hasRisks && <>Everything looks good! No immediate risks detected.</>}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}