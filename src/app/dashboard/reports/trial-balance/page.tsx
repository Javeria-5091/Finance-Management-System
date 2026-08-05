'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getTrialBalance } from '@/services/report.service';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell, Legend } from 'recharts';
import ReportHeader from '@/components/reports/ReportHeader';
import ReportFilterBar from '@/components/reports/ReportFilterBar';
import ExportManager from '@/components/reports/ExportManager';
import EmptyReportState from '@/components/reports/EmptyReportState';
import KPICard from '@/components/reports/KPICard';
import { Scale, CheckCircle2, AlertTriangle } from 'lucide-react';
import type { TBEntry, ReportFilters } from '@/types/reports.types';

const f = (n: number) => new Intl.NumberFormat('en-PK', { style: 'currency', currency: 'PKR', minimumFractionDigits: 0 }).format(n || 0);

export default function TrialBalancePage() {
  const [filters, setFilters] = useState<ReportFilters>({ includePrior: 'true' });
  const [dataAsOf] = useState(new Date().toISOString());

  const { data, isLoading, refetch } = useQuery({
    queryKey: ['tb', filters],
    queryFn: () => getTrialBalance({
      fiscalYearId: filters.fiscalYear,
      periodStart: filters.startDate,
      periodEnd: filters.endDate,
      includePrior: filters.comparison === 'prior_period' || filters.comparison === 'prior_year',
    }),
  });

  const entries = (data || []) as TBEntry[];
  const totalDebit = entries.reduce((s, e) => s + e.debit, 0);
  const totalCredit = entries.reduce((s, e) => s + e.credit, 0);
  const isBalanced = Math.abs(totalDebit - totalCredit) < 1;
  const showPrior = filters.comparison === 'prior_period' || filters.comparison === 'prior_year';

  const topAccounts = [...entries].sort((a, b) => Math.abs(b.net) - Math.abs(a.net)).slice(0, 8);
  const chartData = topAccounts.map(e => ({
    name: e.account_name.length > 16 ? e.account_name.slice(0, 16) + '...' : e.account_name,
    debit: e.debit,
    credit: e.credit,
  }));

  const getCsv = () => {
    let csv = 'Code,Account,Debit,Credit,Net\n';
    if (showPrior) csv = 'Code,Account,Debit,Credit,Net,Prior Debit,Prior Credit,Prior Net\n';
    entries.forEach(e => {
      if (showPrior) {
        csv += `${e.code},"${e.account_name}",${e.debit},${e.credit},${e.net},${e.prior_debit || 0},${e.prior_credit || 0},${e.prior_net || 0}\n`;
      } else {
        csv += `${e.code},"${e.account_name}",${e.debit},${e.credit},${e.net}\n`;
      }
    });
    return csv;
  };

  return (
    <div className="p-6 max-w-[1600px] mx-auto space-y-5">
      <ReportHeader
        title="Trial Balance"
        subtitle="Account-wise debit/credit totals and net balances"
        period={filters.startDate && filters.endDate ? `${filters.startDate} to ${filters.endDate}` : 'All Periods'}
        dataAsOf={dataAsOf}
        filters={[
          ...(filters.fiscalYear ? [{ label: 'Fiscal Year', value: filters.fiscalYear }] : []),
          ...(filters.comparison ? [{ label: 'Compare', value: filters.comparison }] : []),
        ]}
        reconciled={true}
        actions={<ExportManager reportId="trial-balance" reportName="Trial_Balance" getCsvData={getCsv} activeFilters={filters as Record<string, string>} />}
      />

      <ReportFilterBar
        showDateRange
        showFiscalYear
        showComparison
        onApply={(f) => { setFilters(f); refetch(); }}
        isLoading={isLoading}
      />

      {isLoading ? (
        <div className="flex justify-center py-20"><div className="w-8 h-8 border-4 border-blue-600 border-t-transparent rounded-full animate-spin" /></div>
      ) : entries.length > 0 ? (
        <div className="space-y-5">
          {/* KPI Cards */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <KPICard label="Total Debit" value={f(totalDebit)} color="blue" icon={<Scale className="w-4 h-4 text-blue-600" />} />
            <KPICard label="Total Credit" value={f(totalCredit)} color="blue" icon={<Scale className="w-4 h-4 text-blue-600" />} />
            <KPICard label={isBalanced ? 'Balanced' : 'Imbalance'} value={f(Math.abs(totalDebit - totalCredit))} color={isBalanced ? 'green' : 'red'} />
            <KPICard label="Accounts" value={entries.length.toString()} color="gray" />
          </div>

          {/* Balance Status */}
          {isBalanced ? (
            <div className="bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-200 dark:border-emerald-800/30 rounded-xl p-4 flex items-center gap-3 text-sm text-emerald-700 dark:text-emerald-400 font-semibold">
              <CheckCircle2 className="w-5 h-5" /> Trial Balance is balanced: Total Debit = Total Credit
            </div>
          ) : (
            <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800/30 rounded-xl p-4 flex items-center gap-3 text-sm text-red-700 dark:text-red-400 font-semibold">
              <AlertTriangle className="w-5 h-5" /> Trial Balance is imbalanced by {f(Math.abs(totalDebit - totalCredit))} — investigate immediately
            </div>
          )}

          <div className="grid grid-cols-1 lg:grid-cols-4 gap-5">
            {/* Table */}
            <div className="lg:col-span-3 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 dark:bg-gray-900/60 sticky top-0 z-10">
                  <tr className="text-[10px] uppercase tracking-wider text-gray-500">
                    <th className="p-3 text-left">Code</th>
                    <th className="p-3 text-left">Account Name</th>
                    <th className="p-3 text-right">Debit</th>
                    <th className="p-3 text-right">Credit</th>
                    <th className="p-3 text-right">Net Balance</th>
                    {showPrior && <th className="p-3 text-right">Prior Net</th>}
                    {showPrior && <th className="p-3 text-right">Change</th>}
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 dark:divide-gray-700/50">
                  {entries.map((e, i) => {
                    const change = showPrior && e.prior_net !== undefined ? e.net - (e.prior_net || 0) : null;
                    return (
                      <tr key={i} className="hover:bg-gray-50 dark:hover:bg-gray-700/30">
                        <td className="p-3 font-mono text-xs text-gray-500">{e.code}</td>
                        <td className="p-3 font-medium text-gray-900 dark:text-white">{e.account_name}</td>
                        <td className="p-3 text-right font-mono text-sm">{e.debit > 0 ? f(e.debit) : '-'}</td>
                        <td className="p-3 text-right font-mono text-sm">{e.credit > 0 ? f(e.credit) : '-'}</td>
                        <td className={`p-3 text-right font-mono text-sm font-medium ${e.net >= 0 ? 'text-gray-900 dark:text-white' : 'text-red-600'}`}>{f(e.net)}</td>
                        {showPrior && <td className="p-3 text-right font-mono text-xs text-gray-500">{e.prior_net !== undefined ? f(e.prior_net) : '-'}</td>}
                        {showPrior && <td className={`p-3 text-right text-xs font-mono font-medium ${change !== null ? (change >= 0 ? 'text-green-600' : 'text-red-600') : ''}`}>{change !== null ? `${change >= 0 ? '+' : ''}${f(change)}` : '-'}</td>}
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot className="bg-gray-50 dark:bg-gray-900/50 font-bold text-xs border-t-2 border-gray-300 dark:border-gray-600">
                  <tr>
                    <td colSpan={2} className="p-3">TOTAL</td>
                    <td className="p-3 text-right font-mono">{f(totalDebit)}</td>
                    <td className="p-3 text-right font-mono">{f(totalCredit)}</td>
                    <td className="p-3 text-right font-mono">{f(totalDebit - totalCredit)}</td>
                    {showPrior && <td colSpan={2} />}
                  </tr>
                </tfoot>
              </table>
            </div>

            {/* Chart */}
            <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-5">
              <h4 className="text-xs font-bold uppercase text-gray-500 mb-4">Top Accounts by Net</h4>
              <ResponsiveContainer width="100%" height={400}>
                <BarChart data={chartData} layout="vertical" margin={{ left: 0, right: 10 }}>
                  <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="#e5e7eb" />
                  <XAxis type="number" tickFormatter={(v) => `${(v / 1000).toFixed(0)}K`} fontSize={10} />
                  <YAxis type="category" dataKey="name" width={110} fontSize={9} tickLine={false} />
                  <Tooltip formatter={(v) => f(Number(v))} />
                  <Legend wrapperStyle={{ fontSize: '10px' }} />
                  <Bar dataKey="debit" name="Debit" fill="#3b82f6" radius={[0, 4, 4, 0]} />
                  <Bar dataKey="credit" name="Credit" fill="#f59e0b" radius={[0, 4, 4, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
        </div>
      ) : (
        <EmptyReportState icon="document" title="No Trial Balance Data" message="No account balances found for the selected period" hint="Ensure journal entries are posted and fiscal periods are configured" />
      )}
    </div>
  );
}
