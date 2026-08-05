'use client';

import { useState, useEffect, ReactNode } from "react";
import { useQuery } from '@tanstack/react-query';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell, Legend, PieChart, Pie } from 'recharts';
import { getOwnershipEquity } from '@/services/report.service';
import ReportHeader from '@/components/reports/ReportHeader';
import ExportManager from '@/components/reports/ExportManager';
import KPICard from '@/components/reports/KPICard';
import EmptyReportState from '@/components/reports/EmptyReportState';
import { PiggyBank, TrendingUp, Users } from 'lucide-react';
import type { OwnershipRow } from '@/types/reports.types';

const f = (n: number) => new Intl.NumberFormat('en-PK', { style: 'currency', currency: 'PKR', minimumFractionDigits: 0 }).format(n || 0);

export default function OwnershipEquityPage() {
  const [dataAsOf] = useState(new Date().toISOString());
  const { data, isLoading } = useQuery({ queryKey: ['ownership-equity'], queryFn: getOwnershipEquity });

  const rows = (data || []) as OwnershipRow[];
  const totalCapital = rows.reduce((s, r) => s + r.capital, 0);
  const totalLoans = rows.reduce((s, r) => s + r.owner_loans, 0);
  const totalReserve = rows.reduce((s, r) => s + r.configurable_reserve, 0);
  const totalRetained = rows.reduce((s, r) => s + r.retained_earnings, 0);
  const totalDistributions = rows.reduce((s, r) => s + r.distributions_declared, 0);
  const totalPaid = rows.reduce((s, r) => s + r.distributions_paid, 0);
  const totalEquity = rows.reduce((s, r) => s + r.total, 0);

  const pieData = [
    { name: 'Capital', value: totalCapital, fill: '#3b82f6' },
    { name: 'Owner Loans', value: totalLoans, fill: '#f59e0b' },
    { name: 'Reserves', value: totalReserve, fill: '#22c55e' },
    { name: 'Retained', value: totalRetained, fill: '#8b5cf6' },
  ].filter(d => d.value > 0);

  const barData = rows.map(r => ({
    name: r.shareholder_name.length > 15 ? r.shareholder_name.slice(0, 15) + '...' : r.shareholder_name,
    Capital: r.capital,
    Loans: r.owner_loans,
    Reserves: r.configurable_reserve,
    Retained: r.retained_earnings,
  }));

  const getCsv = () => {
    let csv = 'Shareholder,Capital,Owner Loans,Reserve,Retained Earnings,Total,Distributions Declared,Distributions Paid,Payment Status\n';
    rows.forEach(r => csv += `"${r.shareholder_name}",${r.capital},${r.owner_loans},${r.configurable_reserve},${r.retained_earnings},${r.total},${r.distributions_declared},${r.distributions_paid},${r.payment_status}\n`);
    return csv;
  };

  return (
    <div className="p-6 max-w-[1600px] mx-auto space-y-5">
      <ReportHeader
        title="Ownership & Equity"
        subtitle="Capital, owner loans, reserves, retained earnings, distributions — Spec 13.2"
        dataAsOf={dataAsOf}
        reconciled={true}
        actions={<ExportManager reportId="ownership-equity" reportName="Ownership_Equity" getCsvData={getCsv} />}
      />

      {isLoading ? (
        <div className="flex justify-center py-20"><div className="w-8 h-8 border-4 border-blue-600 border-t-transparent rounded-full animate-spin" /></div>
      ) : rows.length > 0 ? (
        <div className="space-y-5">
          <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3">
            <KPICard label="Total Equity" value={f(totalEquity)} color="blue" icon={<PiggyBank className="w-4 h-4 text-blue-600" />} />
            <KPICard label="Capital" value={f(totalCapital)} color="blue" />
            <KPICard label="Owner Loans" value={f(totalLoans)} color="amber" />
            <KPICard label="Reserves" value={f(totalReserve)} color="green" />
            <KPICard label="Retained Earnings" value={f(totalRetained)} color="purple" />
            <KPICard label="Distributions Paid" value={f(totalPaid)} color="red" icon={<TrendingUp className="w-4 h-4 text-red-600" />} />
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
            <div className="lg:col-span-2 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 dark:bg-gray-900/60 text-[10px] uppercase text-gray-500">
                  <tr>
                    <th className="p-3 text-left">Shareholder</th>
                    <th className="p-3 text-right">Capital</th>
                    <th className="p-3 text-right">Loans</th>
                    <th className="p-3 text-right">Reserve</th>
                    <th className="p-3 text-right">Retained</th>
                    <th className="p-3 text-right">Total</th>
                    <th className="p-3 text-right">Declared</th>
                    <th className="p-3 text-right">Paid</th>
                    <th className="p-3 text-center">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                  {rows.map((r, i) => (
                    <tr key={i} className="hover:bg-gray-50 dark:hover:bg-gray-700/30">
                      <td className="p-3 font-medium text-gray-900 dark:text-white">{r.shareholder_name}</td>
                      <td className="p-3 text-right font-mono">{f(r.capital)}</td>
                      <td className="p-3 text-right font-mono text-amber-600">{f(r.owner_loans)}</td>
                      <td className="p-3 text-right font-mono text-green-600">{f(r.configurable_reserve)}</td>
                      <td className="p-3 text-right font-mono text-purple-600">{f(r.retained_earnings)}</td>
                      <td className="p-3 text-right font-mono font-bold">{f(r.total)}</td>
                      <td className="p-3 text-right font-mono text-orange-600">{f(r.distributions_declared)}</td>
                      <td className="p-3 text-right font-mono">{f(r.distributions_paid)}</td>
                      <td className="p-3 text-center">
                        <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${r.payment_status === 'paid' ? 'bg-green-100 text-green-700' : 'bg-amber-100 text-amber-700'}`}>{r.payment_status}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot className="bg-gray-50 dark:bg-gray-900/50 font-bold text-xs border-t-2 border-gray-300 dark:border-gray-600">
                  <tr>
                    <td className="p-3">TOTAL</td>
                    <td className="p-3 text-right font-mono">{f(totalCapital)}</td>
                    <td className="p-3 text-right font-mono">{f(totalLoans)}</td>
                    <td className="p-3 text-right font-mono">{f(totalReserve)}</td>
                    <td className="p-3 text-right font-mono">{f(totalRetained)}</td>
                    <td className="p-3 text-right font-mono">{f(totalEquity)}</td>
                    <td className="p-3 text-right font-mono">{f(totalDistributions)}</td>
                    <td className="p-3 text-right font-mono">{f(totalPaid)}</td>
                    <td />
                  </tr>
                </tfoot>
              </table>
            </div>

            <div className="space-y-5">
              <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-5">
                <h4 className="text-xs font-bold uppercase text-gray-500 mb-4">Equity Composition</h4>
                <ResponsiveContainer width="100%" height={200}>
                  <PieChart><Pie data={pieData} cx="50%" cy="50%" outerRadius={70} innerRadius={40} paddingAngle={2} dataKey="value" label={({ name, percent }) => `${name} ${((percent ?? 0) * 100).toFixed(0)}%`}>{pieData.map((d, i) => <Cell key={i} fill={d.fill} />)}</Pie><Tooltip formatter={(v) => f(Number(v))} /></PieChart>
                </ResponsiveContainer>
              </div>
              <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-5">
                <h4 className="text-xs font-bold uppercase text-gray-500 mb-4">Equity by Shareholder</h4>
                <ResponsiveContainer width="100%" height={220}>
                  <BarChart data={barData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                    <XAxis dataKey="name" fontSize={10} />
                    <YAxis tickFormatter={(v) => `${(v / 1000).toFixed(0)}K`} fontSize={10} />
                    <Tooltip formatter={(v) => f(Number(v))} />
                    <Legend wrapperStyle={{ fontSize: '10px' }} />
                    <Bar dataKey="Capital" stackId="a" fill="#3b82f6" />
                    <Bar dataKey="Loans" stackId="a" fill="#f59e0b" />
                    <Bar dataKey="Reserves" stackId="a" fill="#22c55e" />
                    <Bar dataKey="Retained" stackId="a" fill="#8b5cf6" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          </div>
        </div>
      ) : (
        <EmptyReportState icon="document" title="No Equity Data" message="No ownership or equity records found" hint="Configure ownership and reserves in Tax & Equity module" />
      )}
    </div>
  );
}
