'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell ,Legend } from 'recharts';
import { getFiscalCloseStatus } from '@/services/report.service';
import ReportHeader from '@/components/reports/ReportHeader';
import ExportManager from '@/components/reports/ExportManager';
import KPICard from '@/components/reports/KPICard';
import EmptyReportState from '@/components/reports/EmptyReportState';
import { CalendarDays, CheckCircle2, Lock, Wrench } from 'lucide-react';
import type { FiscalPeriodRow, ReportFilters } from '@/types/reports.types';


const f = (n: number) => new Intl.NumberFormat('en-PK', { style: 'currency', currency: 'PKR', minimumFractionDigits: 0 }).format(n || 0);

const STATUS_CONFIG: Record<string, { label: string; color: string }> = {
  open: { label: 'Open', color: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400' },
  closed: { label: 'Closed', color: 'bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-400' },
  adjusting: { label: 'Adjusting', color: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400' },
  future: { label: 'Future', color: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400' },
};

export default function FiscalClosePage() {
  const [filters, setFilters] = useState<ReportFilters>({});
  const [dataAsOf] = useState(new Date().toISOString());

  const { data, isLoading, refetch } = useQuery({
    queryKey: ['fiscal-close', filters.fiscalYear],
    queryFn: () => getFiscalCloseStatus(filters.fiscalYear),
  });

  const rows = (data || []) as FiscalPeriodRow[];
  const openCount = rows.filter(r => r.status === 'open').length;
  const closedCount = rows.filter(r => r.status === 'closed').length;
  const adjustingCount = rows.filter(r => r.status === 'adjusting').length;
  const totalDebit = rows.reduce((s, r) => s + r.debit_total, 0);
  const totalCredit = rows.reduce((s, r) => s + r.credit_total, 0);
  const totalJournals = rows.reduce((s, r) => s + r.journal_count, 0);
  const totalAdjustments = rows.reduce((s, r) => s + r.adjustment_count, 0);
  const isBalanced = Math.abs(totalDebit - totalCredit) < 1;

  const statusChartData = [
    { name: 'Open', value: openCount, fill: '#22c55e' },
    { name: 'Closed', value: closedCount, fill: '#6b7280' },
    { name: 'Adjusting', value: adjustingCount, fill: '#f59e0b' },
  ];

  const periodBarData = rows.map(r => ({
    name: r.period_name.length > 12 ? r.period_name.slice(0, 12) : r.period_name,
    Debit: r.debit_total,
    Credit: r.credit_total,
    fill: r.status === 'closed' ? '#6b7280' : r.status === 'adjusting' ? '#f59e0b' : '#22c55e',
  }));

  const getCsv = () => {
    let csv = 'Period,Start,End,Status,Journals,Debit,Credit,Adjustments,Checklist\n';
    rows.forEach(r => csv += `"${r.period_name}",${r.period_start},${r.period_end},${r.status},${r.journal_count},${r.debit_total},${r.credit_total},${r.adjustment_count},${r.close_checklist_complete ? 'Complete' : 'Incomplete'}\n`);
    return csv;
  };

  return (
    <div className="p-6 max-w-[1600px] mx-auto space-y-5">
      <ReportHeader
        title="Fiscal Calendar & Close"
        subtitle="Period status, close checklist, adjustments, year-end statements "
        dataAsOf={dataAsOf}
        reconciled={isBalanced}
        actions={<ExportManager reportId="fiscal-close" reportName="Fiscal_Close" getCsvData={getCsv} activeFilters={filters as Record<string, string>} />}
      />

      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3">
        <KPICard label="Total Periods" value={rows.length.toString()} color="blue" icon={<CalendarDays className="w-4 h-4 text-blue-600" />} />
        <KPICard label="Open" value={openCount.toString()} color="green" icon={<Wrench className="w-4 h-4 text-green-600" />} />
        <KPICard label="Closed" value={closedCount.toString()} color="gray" icon={<Lock className="w-4 h-4 text-gray-600" />} />
        <KPICard label="Adjusting" value={adjustingCount.toString()} color="amber" />
        <KPICard label="Total Journals" value={totalJournals.toString()} color="blue" />
        <KPICard label={isBalanced ? 'Balanced' : 'Imbalance'} value={f(Math.abs(totalDebit - totalCredit))} color={isBalanced ? 'green' : 'red'} />
      </div>

      {isLoading ? (
        <div className="flex justify-center py-20"><div className="w-8 h-8 border-4 border-blue-600 border-t-transparent rounded-full animate-spin" /></div>
      ) : rows.length > 0 ? (
        <div className="space-y-5">
          <div className="grid grid-cols-1 lg:grid-cols-4 gap-5">
            {/* Status chart */}
            <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-5">
              <h4 className="text-xs font-bold uppercase text-gray-500 mb-4">Period Status</h4>
              <ResponsiveContainer width="100%" height={200}>
                <BarChart data={statusChartData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                  <XAxis dataKey="name" fontSize={11} />
                  <YAxis fontSize={10} allowDecimals={false} />
                  <Tooltip />
                  <Bar dataKey="value" radius={[6, 6, 0, 0]}>
                    {statusChartData.map((e, i) => <Cell key={i} fill={e.fill} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>

            {/* Period Table */}
            <div className="lg:col-span-3 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 dark:bg-gray-900/60 text-[10px] uppercase text-gray-500">
                  <tr>
                    <th className="p-3 text-left">Period</th>
                    <th className="p-3 text-left hidden md:table-cell">Start</th>
                    <th className="p-3 text-left hidden md:table-cell">End</th>
                    <th className="p-3 text-center">Status</th>
                    <th className="p-3 text-right">Journals</th>
                    <th className="p-3 text-right">Debit</th>
                    <th className="p-3 text-right">Credit</th>
                    <th className="p-3 text-right hidden md:table-cell">Adj.</th>
                    <th className="p-3 text-center hidden lg:table-cell">Checklist</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                  {rows.map((r, i) => {
                    const cfg = STATUS_CONFIG[r.status] || STATUS_CONFIG.open;
                    return (
                      <tr key={i} className="hover:bg-gray-50 dark:hover:bg-gray-700/30">
                        <td className="p-3 font-medium text-gray-900 dark:text-white">{r.period_name}</td>
                        <td className="p-3 text-gray-500 text-xs hidden md:table-cell">{new Date(r.period_start).toLocaleDateString('en-PK', { month: 'short', day: 'numeric' })}</td>
                        <td className="p-3 text-gray-500 text-xs hidden md:table-cell">{new Date(r.period_end).toLocaleDateString('en-PK', { month: 'short', day: 'numeric' })}</td>
                        <td className="p-3 text-center"><span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${cfg.color}`}>{cfg.label}</span></td>
                        <td className="p-3 text-right font-mono">{r.journal_count}</td>
                        <td className="p-3 text-right font-mono">{f(r.debit_total)}</td>
                        <td className="p-3 text-right font-mono">{f(r.credit_total)}</td>
                        <td className="p-3 text-right font-mono text-amber-600 hidden md:table-cell">{r.adjustment_count}</td>
                        <td className="p-3 text-center hidden lg:table-cell">
                          {r.close_checklist_complete ? <CheckCircle2 className="w-4 h-4 text-green-600 mx-auto" /> : <Wrench className="w-4 h-4 text-amber-600 mx-auto" />}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot className="bg-gray-50 dark:bg-gray-900/50 font-bold text-xs border-t-2 border-gray-300 dark:border-gray-600">
                  <tr>
                    <td className="p-3">TOTAL</td>
                    <td colSpan={3} />
                    <td className="p-3 text-right font-mono">{totalJournals}</td>
                    <td className="p-3 text-right font-mono">{f(totalDebit)}</td>
                    <td className="p-3 text-right font-mono">{f(totalCredit)}</td>
                    <td className="p-3 text-right font-mono text-amber-600">{totalAdjustments}</td>
                    <td />
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>

          {/* Period Activity Chart */}
          <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-5">
            <h4 className="text-xs font-bold uppercase text-gray-500 mb-4">Debit/Credit Activity by Period</h4>
            <ResponsiveContainer width="100%" height={250}>
              <BarChart data={periodBarData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                <XAxis dataKey="name" fontSize={10} />
                <YAxis tickFormatter={(v) => `${(v / 1000).toFixed(0)}K`} fontSize={10} />
                <Tooltip formatter={(v) => f(Number(v))} />
                <Legend wrapperStyle={{ fontSize: '10px' }} />
                <Bar dataKey="Debit" fill="#3b82f6" radius={[4, 4, 0, 0]} />
                <Bar dataKey="Credit" fill="#22c55e" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      ) : (
        <EmptyReportState icon="document" title="No Fiscal Data" message="No fiscal periods found" hint="Configure fiscal years and periods in Accounting module" />
      )}
    </div>
  );
}