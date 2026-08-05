'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell, Legend, ScatterChart, Scatter, ZAxis } from 'recharts';
import { getPlatformSettlements } from '@/services/report.service';
import ReportHeader from '@/components/reports/ReportHeader';
import ReportFilterBar from '@/components/reports/ReportFilterBar';
import ExportManager from '@/components/reports/ExportManager';
import KPICard from '@/components/reports/KPICard';
import EmptyReportState from '@/components/reports/EmptyReportState';
import { CreditCard, AlertTriangle, TrendingUp } from 'lucide-react';
import type { PlatformSettlementRow, ReportFilters } from '@/types/reports.types';

const f = (n: number) => new Intl.NumberFormat('en-PK', { style: 'currency', currency: 'PKR', minimumFractionDigits: 0 }).format(n || 0);

export default function PlatformSettlementsPage() {
  const [filters, setFilters] = useState<ReportFilters>({});
  const [dataAsOf] = useState(new Date().toISOString());

  const { data, isLoading, refetch } = useQuery({
    queryKey: ['platform-settlements', filters.startDate, filters.endDate],
    queryFn: () => getPlatformSettlements(filters.startDate, filters.endDate),
  });

  const rows = (data || []) as PlatformSettlementRow[];
  const totalGross = rows.reduce((s, r) => s + r.gross_settlement, 0);
  const totalExpectedFee = rows.reduce((s, r) => s + r.expected_fee, 0);
  const totalActualFee = rows.reduce((s, r) => s + r.actual_fee, 0);
  const totalFeeVariance = rows.reduce((s, r) => s + r.fee_variance, 0);
  const totalNetPayout = rows.reduce((s, r) => s + r.net_payout, 0);
  const totalDeductions = rows.reduce((s, r) => s + r.deductions, 0);
  const highVarianceCount = rows.filter(r => Math.abs(r.fee_variance) > 100).length;

  const platformData = rows.reduce((acc, r) => {
    const existing = acc.find(e => e.name === r.platform_name);
    if (existing) { existing.gross += r.gross_settlement; existing.fee += r.actual_fee; existing.net += r.net_payout; existing.variance += r.fee_variance; }
    else acc.push({ name: r.platform_name, gross: r.gross_settlement, fee: r.actual_fee, net: r.net_payout, variance: r.fee_variance });
    return acc;
  }, [] as { name: string; gross: number; fee: number; net: number; variance: number }[]);

  const scatterData = rows.map(r => ({ name: r.platform_name.slice(0, 10), expectedRate: r.expected_fee / (r.gross_settlement || 1) * 100, actualRate: r.actual_fee / (r.gross_settlement || 1) * 100, variance: r.fee_variance }));

  const getCsv = () => {
    let csv = 'Platform,Account,Client,Project,Currency,Gross,Expected Fee,Actual Fee,Effective Rate,Fee Variance,Deductions,Net Payout,Recon Status\n';
    rows.forEach(r => csv += `"${r.platform_name}","${r.account_name}","${r.client_name}","${r.project_name || ''}",${r.currency},${r.gross_settlement},${r.expected_fee},${r.actual_fee},${r.effective_rate.toFixed(2)}%,${r.fee_variance},${r.deductions},${r.net_payout},${r.reconciliation_status}\n`);
    return csv;
  };

  return (
    <div className="p-6 max-w-[1600px] mx-auto space-y-5">
      <ReportHeader
        title="Platform Settlements"
        subtitle="Gross settlements, fees, effective rate, variance, net payout — Spec 13.2"
        period={filters.startDate && filters.endDate ? `${filters.startDate} to ${filters.endDate}` : 'All Periods'}
        dataAsOf={dataAsOf}
        reconciled={true}
        actions={<ExportManager reportId="platform-settlements" reportName="Platform_Settlements" getCsvData={getCsv} activeFilters={filters as Record<string, string>} />}
      />

      <ReportFilterBar showDateRange onApply={(f) => { setFilters(f); refetch(); }} isLoading={isLoading} />

      {isLoading ? (
        <div className="flex justify-center py-20"><div className="w-8 h-8 border-4 border-blue-600 border-t-transparent rounded-full animate-spin" /></div>
      ) : rows.length > 0 ? (
        <div className="space-y-5">
          <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3">
            <KPICard label="Gross Settlements" value={f(totalGross)} color="green" icon={<CreditCard className="w-4 h-4 text-green-600" />} />
            <KPICard label="Expected Fees" value={f(totalExpectedFee)} color="amber" />
            <KPICard label="Actual Fees" value={f(totalActualFee)} color="red" />
            <KPICard label="Fee Variance" value={f(Math.abs(totalFeeVariance))} color={Math.abs(totalFeeVariance) > 500 ? 'red' : 'green'} />
            <KPICard label="Deductions" value={f(totalDeductions)} color="amber" />
            <KPICard label="Net Payout" value={f(totalNetPayout)} color="blue" />
          </div>

          {highVarianceCount > 0 && (
            <div className="bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800/30 rounded-xl p-4 flex items-center gap-3 text-sm text-amber-700 dark:text-amber-400">
              <AlertTriangle className="w-5 h-5 flex-shrink-0" />
              <span><strong>{highVarianceCount}</strong> settlements have fee variance exceeding PKR 100 — review required</span>
            </div>
          )}

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
            {/* Table */}
            <div className="lg:col-span-2 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 dark:bg-gray-900/60 text-[10px] uppercase text-gray-500">
                    <tr>
                      <th className="p-3 text-left">Platform</th>
                      <th className="p-3 text-left hidden md:table-cell">Client</th>
                      <th className="p-3 text-right">Gross</th>
                      <th className="p-3 text-right">Actual Fee</th>
                      <th className="p-3 text-right">Net Payout</th>
                      <th className="p-3 text-right hidden md:table-cell">Variance</th>
                      <th className="p-3 text-center">Recon</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                    {rows.map((r, i) => (
                      <tr key={i} className="hover:bg-gray-50 dark:hover:bg-gray-700/30">
                        <td className="p-3 font-medium text-gray-900 dark:text-white">{r.platform_name}</td>
                        <td className="p-3 text-gray-500 hidden md:table-cell">{r.client_name}</td>
                        <td className="p-3 text-right font-mono text-green-600">{f(r.gross_settlement)}</td>
                        <td className="p-3 text-right font-mono text-red-500">{f(r.actual_fee)}</td>
                        <td className="p-3 text-right font-mono font-medium">{f(r.net_payout)}</td>
                        <td className={`p-3 text-right font-mono hidden md:table-cell ${Math.abs(r.fee_variance) > 100 ? 'text-red-600 font-bold' : 'text-gray-500'}`}>{f(r.fee_variance)}</td>
                        <td className="p-3 text-center">
                          <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${r.reconciliation_status === 'reconciled' ? 'bg-green-100 text-green-700' : 'bg-amber-100 text-amber-700'}`}>{r.reconciliation_status}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot className="bg-gray-50 dark:bg-gray-900/50 font-bold text-xs border-t-2 border-gray-300 dark:border-gray-600">
                    <tr><td colSpan={2} className="p-3">TOTAL</td><td className="p-3 text-right font-mono">{f(totalGross)}</td><td className="p-3 text-right font-mono">{f(totalActualFee)}</td><td className="p-3 text-right font-mono">{f(totalNetPayout)}</td><td className="p-3 text-right font-mono">{f(totalFeeVariance)}</td><td /></tr>
                  </tfoot>
                </table>
              </div>
            </div>

            <div className="space-y-5">
              <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-5">
                <h4 className="text-xs font-bold uppercase text-gray-500 mb-4">Gross-to-Net Waterfall</h4>
                <ResponsiveContainer width="100%" height={200}>
                  <BarChart data={platformData.slice(0, 6)}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                    <XAxis dataKey="name" fontSize={10} />
                    <YAxis tickFormatter={(v) => `${(v / 1000).toFixed(0)}K`} fontSize={10} />
                    <Tooltip formatter={(v) => f(Number(v))} />
                    <Legend wrapperStyle={{ fontSize: '10px' }} />
                    <Bar dataKey="gross" name="Gross" fill="#22c55e" radius={[4, 4, 0, 0]} />
                    <Bar dataKey="fee" name="Fees" fill="#ef4444" radius={[4, 4, 0, 0]} />
                    <Bar dataKey="net" name="Net" fill="#3b82f6" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
              <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-5">
                <h4 className="text-xs font-bold uppercase text-gray-500 mb-4">Effective Rate Trend</h4>
                <ResponsiveContainer width="100%" height={180}>
                  <ScatterChart>
                    <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                    <XAxis dataKey="expectedRate" name="Expected Rate" tickFormatter={(v) => `${v.toFixed(1)}%`} fontSize={10} />
                    <YAxis dataKey="actualRate" name="Actual Rate" tickFormatter={(v) => `${v.toFixed(1)}%`} fontSize={10} domain={['auto', 'auto']} />
                    <ZAxis range={[40, 300]} />
                    <Tooltip cursor={{ strokeDasharray: '3 3' }} />
                    <Scatter data={scatterData} fill="#8b5cf6" />
                  </ScatterChart>
                </ResponsiveContainer>
              </div>
            </div>
          </div>
        </div>
      ) : (
        <EmptyReportState icon="chart" title="No Settlement Data" message="No platform settlement records found" hint="Process invoices and payments through platform accounts" />
      )}
    </div>
  );
}