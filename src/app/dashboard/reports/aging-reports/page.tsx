'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell, Legend } from 'recharts';
import { getAgingReport } from '@/services/report.service';
import ReportHeader from '@/components/reports/ReportHeader';
import ExportManager from '@/components/reports/ExportManager';
import KPICard from '@/components/reports/KPICard';
import EmptyReportState from '@/components/reports/EmptyReportState';
import { AlertTriangle, Clock, ArrowRightLeft } from 'lucide-react';
import type { AgingItem } from '@/types/reports.types';

const f = (n: number) => new Intl.NumberFormat('en-PK', { style: 'currency', currency: 'PKR', minimumFractionDigits: 0 }).format(n || 0);

const BUCKET_COLORS = ['#22c55e', '#f59e0b', '#f97316', '#ef4444', '#dc2626'];
const BUCKET_LABELS = ['Current', '1-30 Days', '31-60 Days', '61-90 Days', '90+ Days'];
const BUCKET_KEYS = ['current_amount', 'overdue_1_30', 'overdue_31_60', 'overdue_61_90', 'overdue_over_90'] as const;

export default function AgingReportPage() {
  const [dataAsOf] = useState(new Date().toISOString());
  const { data, isLoading } = useQuery({ queryKey: ['aging'], queryFn: getAgingReport });

  const totalRecv = data?.receivable.reduce((s, r) => s + r.total, 0) || 0;
  const totalPay = data?.payable.reduce((s, r) => s + r.total, 0) || 0;
  const highRiskRecv = data?.receivable.filter(r => r.overdue_over_90 > 0).length || 0;
  const highRiskPay = data?.payable.filter(r => r.overdue_over_90 > 0).length || 0;

  const getCsv = () => {
    let csv = 'Type,Name,Ref,Due Date,Total,Current,1-30,31-60,61-90,90+\n';
    data?.receivable.forEach(r => { csv += `AR,"${r.client_name}",${r.invoice_number},${r.due_date},${r.total},${r.current_amount},${r.overdue_1_30},${r.overdue_31_60},${r.overdue_61_90},${r.overdue_over_90}\n`; });
    data?.payable.forEach(r => { csv += `AP,"${r.vendor_name}",${r.bill_number},${r.due_date},${r.total},${r.current_amount},${r.overdue_1_30},${r.overdue_31_60},${r.overdue_61_90},${r.overdue_over_90}\n`; });
    return csv;
  };

  return (
    <div className="p-6 max-w-[1600px] mx-auto space-y-5">
      <ReportHeader
        title="Receivables & Payables Aging"
        subtitle="Outstanding amounts by age bucket — Spec 13.2 AR/AP Reports"
        dataAsOf={dataAsOf}
        reconciled={true}
        actions={<ExportManager reportId="aging-reports" reportName="Aging_Report" getCsvData={getCsv} />}
      />

      {/* KPI Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <KPICard label="Total Receivables" value={f(totalRecv)} color="amber" icon={<ArrowRightLeft className="w-4 h-4 text-amber-600" />} />
        <KPICard label="Total Payables" value={f(totalPay)} color="red" icon={<ArrowRightLeft className="w-4 h-4 text-red-600" />} />
        <KPICard label="High Risk AR" value={highRiskRecv.toString()} color="red" icon={<AlertTriangle className="w-4 h-4 text-red-600" />} />
        <KPICard label="High Risk AP" value={highRiskPay.toString()} color="red" icon={<AlertTriangle className="w-4 h-4 text-red-600" />} />
      </div>

      {/* Risk Alert */}
      {(highRiskRecv > 0 || highRiskPay > 0) && (
        <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800/30 rounded-xl p-4 flex items-center gap-3 text-sm text-red-700 dark:text-red-400">
          <AlertTriangle className="w-5 h-5 flex-shrink-0" />
          <span><strong>{highRiskRecv + highRiskPay}</strong> items are 90+ days overdue — per Spec 13.2, overdue items require management attention</span>
        </div>
      )}

      {isLoading ? (
        <div className="flex justify-center py-20"><div className="w-8 h-8 border-4 border-blue-600 border-t-transparent rounded-full animate-spin" /></div>
      ) : data ? (
        <div className="space-y-8">
          <AgingSection title="Accounts Receivable" items={data.receivable} type="receivable" />
          <AgingSection title="Accounts Payable" items={data.payable} type="payable" />
        </div>
      ) : (
        <EmptyReportState icon="chart" title="No Aging Data" message="No outstanding receivables or payables found" hint="Post invoices and vendor bills to see aging analysis" />
      )}
    </div>
  );
}

function AgingSection({ title, items, type }: { title: string; items: AgingItem[]; type: 'receivable' | 'payable' }) {
  const totals = items.reduce((acc, r) => ({
    total: acc.total + r.total,
    buckets: acc.buckets.map((b, i) => b + r[BUCKET_KEYS[i]]),
  }), { total: 0, buckets: [0, 0, 0, 0, 0] });

  const stackData = BUCKET_LABELS.map((label, i) => ({
    name: label,
    value: totals.buckets[i],
    fill: BUCKET_COLORS[i],
  }));

  const barData = items.slice(0, 10).map(r => ({
    name: ((type === 'receivable' ? r.client_name : r.vendor_name) || 'Unknown').slice(0, 15),
    current: r.current_amount,
    '1-30': r.overdue_1_30,
    '31-60': r.overdue_31_60,
    '61-90': r.overdue_61_90,
    '90+': r.overdue_over_90,
  }));

  if (!items.length) {
    return <EmptyReportState icon="chart" title={`No ${title}`} message={`No outstanding ${type} items found`} />;
  }

  return (
    <section className="space-y-5">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-bold text-gray-900 dark:text-white">{title}</h3>
        <span className="text-sm font-bold text-gray-900 dark:text-white font-mono">{f(totals.total)}</span>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        {/* Stacked Bar Chart */}
        <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-5">
          <h4 className="text-xs font-bold uppercase text-gray-500 mb-4">Aging Distribution</h4>
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={stackData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
              <XAxis dataKey="name" fontSize={10} />
              <YAxis tickFormatter={(v) => `${(v / 1000).toFixed(0)}K`} fontSize={10} />
              <Tooltip formatter={(v) => f(Number(v))} />
              <Bar dataKey="value" radius={[6, 6, 0, 0]}>
                {stackData.map((entry, i) => <Cell key={i} fill={entry.fill} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
          <div className="flex flex-wrap gap-3 mt-3">
            {BUCKET_LABELS.map((l, i) => (
              <div key={i} className="flex items-center gap-1.5">
                <div className="w-2.5 h-2.5 rounded-sm" style={{ backgroundColor: BUCKET_COLORS[i] }} />
                <span className="text-[10px] text-gray-500">{l}: {f(totals.buckets[i])}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Top 10 Stacked Horizontal */}
        <div className="lg:col-span-2 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-5">
          <h4 className="text-xs font-bold uppercase text-gray-500 mb-4">Top {type === 'receivable' ? 'Clients' : 'Vendors'} by Aging</h4>
          <ResponsiveContainer width="100%" height={250}>
            <BarChart data={barData} layout="vertical" margin={{ left: 0, right: 10 }}>
              <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="#e5e7eb" />
              <XAxis type="number" tickFormatter={(v) => `${(v / 1000).toFixed(0)}K`} fontSize={10} />
              <YAxis type="category" dataKey="name" width={120} fontSize={9} tickLine={false} />
              <Tooltip formatter={(v) => f(Number(v))} />
              <Legend wrapperStyle={{ fontSize: '10px' }} />
              <Bar dataKey="current" name="Current" stackId="a" fill="#22c55e" />
              <Bar dataKey="1-30" name="1-30 Days" stackId="a" fill="#f59e0b" />
              <Bar dataKey="31-60" name="31-60 Days" stackId="a" fill="#f97316" />
              <Bar dataKey="61-90" name="61-90 Days" stackId="a" fill="#ef4444" />
              <Bar dataKey="90+" name="90+ Days" stackId="a" fill="#dc2626" radius={[0, 4, 4, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Full Table */}
      <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 dark:bg-gray-900/60 text-[10px] uppercase text-gray-500">
            <tr>
              <th className="p-3 text-left">{type === 'receivable' ? 'Client / Invoice' : 'Vendor / Bill'}</th>
              <th className="p-3 text-right">Due Date</th>
              <th className="p-3 text-right">Total</th>
              {BUCKET_LABELS.map((l, i) => (
                <th key={i} className="p-3 text-right" style={{ backgroundColor: `${BUCKET_COLORS[i]}15` }}>{l}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
            {items.map((r, i) => {
              const name = type === 'receivable' ? r.client_name : r.vendor_name;
              const ref = type === 'receivable' ? r.invoice_number : r.bill_number;
              return (
                <tr key={i} className="hover:bg-gray-50 dark:hover:bg-gray-700/30">
                  <td className="p-3">
                    <div className="font-medium text-gray-900 dark:text-white">{name}</div>
                    <div className="text-[10px] text-gray-500">{ref || '-'}</div>
                  </td>
                  <td className="p-3 text-right text-gray-500 text-xs">{r.due_date ? new Date(r.due_date).toLocaleDateString('en-PK') : '-'}</td>
                  <td className="p-3 text-right font-semibold font-mono">{f(r.total)}</td>
                  {BUCKET_KEYS.map((k, j) => {
                    const val = r[k];
                    return (
                      <td key={j} className={`p-3 text-right text-xs font-mono ${val > 0 ? (j < 2 ? 'text-green-600' : j < 4 ? 'text-orange-600' : 'text-red-700 font-bold') : 'text-gray-300'}`}>
                        {val > 0 ? f(val) : '-'}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
          <tfoot className="bg-gray-50 dark:bg-gray-900/50 font-bold text-xs border-t-2 border-gray-300 dark:border-gray-600">
            <tr>
              <td className="p-3">TOTAL</td>
              <td className="p-3" />
              <td className="p-3 text-right font-mono">{f(totals.total)}</td>
              {totals.buckets.map((b, i) => (
                <td key={i} className="p-3 text-right font-mono">{f(b)}</td>
              ))}
            </tr>
          </tfoot>
        </table>
      </div>
    </section>
  );
}