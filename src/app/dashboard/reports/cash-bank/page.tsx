'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell, PieChart, Pie, Legend } from 'recharts';
import { getAccountBalances, getBankTransfers } from '@/services/report.service';
import ReportHeader from '@/components/reports/ReportHeader';
import ReportFilterBar from '@/components/reports/ReportFilterBar';
import ExportManager from '@/components/reports/ExportManager';
import KPICard from '@/components/reports/KPICard';
import EmptyReportState from '@/components/reports/EmptyReportState';
import { Landmark, CheckCircle2, Clock, AlertTriangle } from 'lucide-react';
import type { AccountBalanceRow, BankTransferRow, ReportFilters } from '@/types/reports.types';

const f = (n: number) => new Intl.NumberFormat('en-PK', { style: 'currency', currency: 'PKR', minimumFractionDigits: 0 }).format(n || 0);

export default function CashBankReportsPage() {
  const [tab, setTab] = useState<'balances' | 'transfers'>('balances');
  const [filters, setFilters] = useState<ReportFilters>({});
  const [dataAsOf] = useState(new Date().toISOString());

  const balances = useQuery({ queryKey: ['account-balances'], queryFn: () => getAccountBalances(), enabled: tab === 'balances' });
  const transfers = useQuery({ queryKey: ['bank-transfers', filters.startDate, filters.endDate], queryFn: () => getBankTransfers(filters.startDate, filters.endDate), enabled: tab === 'transfers' });

  const isLoading = tab === 'balances' ? balances.isLoading : transfers.isLoading;
  const balanceData = (balances.data || []) as AccountBalanceRow[];
  const transferData = (transfers.data || []) as BankTransferRow[];

  const totalBalance = balanceData.reduce((s, a) => s + (a.pkr_equivalent ?? 0), 0);
  const reconciledCount = balanceData.filter(a => a.reconciliation_status === 'reconciled').length;
  const pendingCount = balanceData.filter(a => a.reconciliation_status === 'pending').length;
  const unreconciledCount = balanceData.filter(a => a.reconciliation_status === 'unreconciled').length;

  const currencyPieData = balanceData.reduce((acc, a) => {
    const existing = acc.find(e => e.name === a.currency);
    if (a.pkr_equivalent == null) return acc;
    if (existing) existing.value += a.pkr_equivalent;
    else acc.push({ name: a.currency, value: a.pkr_equivalent });
    return acc;
  }, [] as { name: string; value: number }[]);

  const statusData = [
    { name: 'Reconciled', value: reconciledCount, fill: '#22c55e' },
    { name: 'Pending', value: pendingCount, fill: '#f59e0b' },
    { name: 'Unreconciled', value: unreconciledCount, fill: '#ef4444' },
  ];

  const getCsv = () => {
 if (tab === 'balances') {
 let csv = 'Account,Type,Currency,Balance,PKR Equivalent,Status\n';
 balanceData.forEach(a => csv += `"${a.account_name}",${a.account_type},${a.currency},${a.balance},${a.pkr_equivalent ?? ""},${a.reconciliation_status}\n`);
 return csv;
 }
 let csv = 'Date,From,To,Amount,Currency,Fee,Net,Status\n';
 transferData.forEach(t => csv += `${t.date},"${t.from_account}","${t.to_account}",${t.amount},${t.currency},${t.platform_fee},${t.net_amount},${t.status}\n`);
 return csv;
 };

  return (
    <div className="p-6 max-w-[1600px] mx-auto space-y-5">
      <ReportHeader
        title="Cash & Bank Reports"
        subtitle="Account balances, reconciliation, transfers, fees"
        dataAsOf={dataAsOf}
        period={filters.startDate && filters.endDate ? `${filters.startDate} to ${filters.endDate}` : 'Current'}
        currency="PKR (Consolidated)"
        reconciled={true}
        actions={<ExportManager reportId={`cash-bank-${tab}`} reportName={`Cash_Bank_${tab}`} getCsvData={getCsv} activeFilters={filters as Record<string, string>} />}
      />

      {tab === 'transfers' && <ReportFilterBar showDateRange onApply={(f) => setFilters(f)} isLoading={isLoading} />}

      <div className="flex gap-1 bg-gray-100 dark:bg-gray-800 p-1 rounded-xl w-fit">
        {[{ id: 'balances' as const, label: 'Account Balances' }, { id: 'transfers' as const, label: 'Transfers & Fees' }].map(t => (
          <button key={t.id} onClick={() => setTab(t.id)}
            className={`px-4 py-2.5 rounded-lg text-sm font-medium transition-all ${tab === t.id ? 'bg-white dark:bg-gray-700 text-gray-900 dark:text-white shadow-sm' : 'text-gray-500'}`}>
            {t.label}
          </button>
        ))}
      </div>

      {isLoading ? (
        <div className="flex justify-center py-20"><div className="w-8 h-8 border-4 border-blue-600 border-t-transparent rounded-full animate-spin" /></div>
      ) : tab === 'balances' && balanceData.length > 0 ? (
        <div className="space-y-5">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <KPICard label="Total (PKR)" value={f(totalBalance)} color="green" icon={<Landmark className="w-4 h-4 text-green-600" />} />
            <KPICard label="Reconciled" value={reconciledCount.toString()} color="green" icon={<CheckCircle2 className="w-4 h-4 text-green-600" />} />
            <KPICard label="Pending" value={pendingCount.toString()} color="amber" icon={<Clock className="w-4 h-4 text-amber-600" />} />
            <KPICard label="Unreconciled" value={unreconciledCount.toString()} color="red" icon={<AlertTriangle className="w-4 h-4 text-red-600" />} />
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
            <div className="lg:col-span-2 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 dark:bg-gray-900/60 text-[10px] uppercase text-gray-500">
                  <tr>
                    <th className="p-3 text-left">Account</th>
                    <th className="p-3 text-left hidden md:table-cell">Type</th>
                    <th className="p-3 text-right">Balance</th>
                    <th className="p-3 text-right">PKR Equiv</th>
                    <th className="p-3 text-center">Recon Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                  {balanceData.map((a, i) => (
                    <tr key={i} className="hover:bg-gray-50 dark:hover:bg-gray-700/30">
                      <td className="p-3 font-medium text-gray-900 dark:text-white">{a.account_name}</td>
                      <td className="p-3 text-gray-500 hidden md:table-cell text-xs">{a.account_type}</td>
                      <td className="p-3 text-right font-mono">{f(a.balance)} <span className="text-[10px] text-gray-400">{a.currency}</span></td>
                      <td className="p-3 text-right font-mono font-medium">{a.pkr_equivalent == null ? <span className="text-amber-600">Rate unavailable</span> : f(a.pkr_equivalent)}</td>
                      <td className="p-3 text-center">
                        <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${a.reconciliation_status === 'reconciled' ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400' : a.reconciliation_status === 'pending' ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400' : 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400'}`}>{a.reconciliation_status}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot className="bg-gray-50 dark:bg-gray-900/50 font-bold text-xs border-t-2 border-gray-300 dark:border-gray-600">
                  <tr><td colSpan={3} className="p-3">Total</td><td className="p-3 text-right font-mono">{f(totalBalance)}</td><td /></tr>
                </tfoot>
              </table>
            </div>
            <div className="space-y-5">
              {currencyPieData.length > 0 && (
                <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-5">
                  <h4 className="text-xs font-bold uppercase text-gray-500 mb-4">Balance by Currency</h4>
                  <ResponsiveContainer width="100%" height={200}>
                    <PieChart><Pie data={currencyPieData} cx="50%" cy="50%" outerRadius={70} innerRadius={40} paddingAngle={2} dataKey="value" label={({ name, percent }) => `${name} ${((percent ?? 0) * 100).toFixed(0)}%`}>{currencyPieData.map((_, i) => <Cell key={i} fill={['#3b82f6', '#22c55e', '#f59e0b', '#ef4444', '#8b5cf6'][i % 5]} />)}</Pie><Tooltip formatter={(v) => f(Number(v))} /></PieChart>
                  </ResponsiveContainer>
                </div>
              )}
              <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-5">
                <h4 className="text-xs font-bold uppercase text-gray-500 mb-4">Reconciliation Status</h4>
                <ResponsiveContainer width="100%" height={150}>
                  <BarChart data={statusData}><CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" /><XAxis dataKey="name" fontSize={10} /><YAxis fontSize={10} allowDecimals={false} /><Tooltip /><Bar dataKey="value" radius={[6, 6, 0, 0]}>{statusData.map((e, i) => <Cell key={i} fill={e.fill} />)}</Bar></BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          </div>
        </div>
      ) : tab === 'transfers' && transferData.length > 0 ? (
        <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 dark:bg-gray-900/60 text-[10px] uppercase text-gray-500">
              <tr><th className="p-3 text-left">Date</th><th className="p-3 text-left">From</th><th className="p-3 text-left">To</th><th className="p-3 text-right">Amount</th><th className="p-3 text-right">Fee</th><th className="p-3 text-right">Net</th><th className="p-3 text-center">Status</th></tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
              {transferData.map((t, i) => (
                <tr key={i} className="hover:bg-gray-50 dark:hover:bg-gray-700/30">
                  <td className="p-3 text-gray-500 text-xs">{new Date(t.date).toLocaleDateString('en-PK')}</td>
                  <td className="p-3 text-gray-900 dark:text-white">{t.from_account}</td>
                  <td className="p-3 text-gray-900 dark:text-white">{t.to_account}</td>
                  <td className="p-3 text-right font-mono">{f(t.amount)} <span className="text-[10px] text-gray-400">{t.currency}</span></td>
                  <td className="p-3 text-right font-mono text-red-500">{f(t.platform_fee)}</td>
                  <td className="p-3 text-right font-mono font-medium">{f(t.net_amount)}</td>
                  <td className="p-3 text-center"><span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400">{t.status}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <EmptyReportState icon="chart" title="No Cash/Bank Data" message="No account balances or transfers found" hint="Set up financial accounts and record transactions" />
      )}
    </div>
  );
}
