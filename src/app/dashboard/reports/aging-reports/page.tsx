'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getAgingReport } from '@/services/report.service';
import { AlertTriangle, TrendingUp, TrendingDown, ArrowRightLeft } from 'lucide-react';
import type { AgingItem } from '@/types/reports.types';

const f = (n: number) => new Intl.NumberFormat('en-PK', { style: 'currency', currency: 'PKR', minimumFractionDigits: 0 }).format(n || 0);

function AgingTable({ title, items, type }: { title: string; items: AgingItem[]; type: 'receivable' | 'payable' }) {
  const totals = items.reduce((acc, r) => ({
    total: acc.total + r.total, current: acc.current + r.current_amount,
    d1: acc.d1 + r.overdue_1_30, d2: acc.d2 + r.overdue_31_60,
    d3: acc.d3 + r.overdue_61_90, d4: acc.d4 + r.overdue_over_90,
  }), { total: 0, current: 0, d1: 0, d2: 0, d3: 0, d4: 0 });

  const buckets = [
    { label: 'Current', value: totals.current, color: '#22c55e', bg: 'bg-green-50 dark:bg-green-900/10' },
    { label: '1-30 Days', value: totals.d1, color: '#f59e0b', bg: 'bg-yellow-50 dark:bg-yellow-900/10' },
    { label: '31-60 Days', value: totals.d2, color: '#f97316', bg: 'bg-orange-50 dark:bg-orange-900/10' },
    { label: '61-90 Days', value: totals.d3, color: '#ef4444', bg: 'bg-red-50 dark:bg-red-900/10' },
    { label: '90+ Days', value: totals.d4, color: '#dc2626', bg: 'bg-red-100 dark:bg-red-900/20' },
  ];

  const maxBucket = Math.max(...buckets.map(b => b.value), 1);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="font-bold text-gray-900 dark:text-white">{title}</h3>
        <span className="text-sm font-bold text-gray-900 dark:text-white">{f(totals.total)}</span>
      </div>

      {/* Bucket Chart */}
      <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-5">
        <div className="flex h-8 rounded-lg overflow-hidden">
          {buckets.map((b, i) => (
            <div key={i} className="transition-all flex items-center justify-center text-[10px] font-bold text-white"
              style={{ width: `${(b.value / maxBucket) * 100}%`, backgroundColor: b.color, minWidth: b.value > 0 ? '2px' : '0' }}>
              {b.value > 0 && f(b.value)}
            </div>
          ))}
        </div>
        <div className="flex gap-4 mt-3">
          {buckets.map((b, i) => (
            <div key={i} className="flex items-center gap-1.5">
              <div className="w-2.5 h-2.5 rounded-sm" style={{ backgroundColor: b.color }} />
              <span className="text-[10px] text-gray-500">{b.label}: {f(b.value)}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Table */}
      <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 dark:bg-gray-900/50 text-[10px] uppercase text-gray-500">
            <tr>
              <th className="p-3 text-left">{type === 'receivable' ? 'Client / Invoice' : 'Vendor / Bill'}</th>
              <th className="p-3 text-right">Due Date</th>
              <th className="p-3 text-right">Total</th>
              <th className={`p-3 text-right ${buckets[0].bg}`}>Current</th>
              <th className={`p-3 text-right ${buckets[1].bg}`}>1-30</th>
              <th className={`p-3 text-right ${buckets[2].bg}`}>31-60</th>
              <th className={`p-3 text-right ${buckets[3].bg}`}>61-90</th>
              <th className={`p-3 text-right ${buckets[4].bg}`}>90+</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
            {items.length === 0 ? (
              <tr><td colSpan={8} className="p-10 text-center text-gray-400">No outstanding items</td></tr>
            ) : items.map((r, i) => {
              const name = type === 'receivable' ? r.client_name : r.vendor_name;
              const ref = type === 'receivable' ? r.invoice_number : r.bill_number;
              return (
                <tr key={i} className="hover:bg-gray-50 dark:hover:bg-gray-700/30">
                  <td className="p-3">
                    <div className="font-medium text-gray-900 dark:text-white">{name}</div>
                    <div className="text-[10px] text-gray-500">{ref || '-'}</div>
                  </td>
                  <td className="p-3 text-right text-gray-500 text-xs">{r.due_date ? new Date(r.due_date).toLocaleDateString('en-PK') : '-'}</td>
                  <td className="p-3 text-right font-semibold">{f(r.total)}</td>
                  <td className={`p-3 text-right text-xs ${r.current_amount > 0 ? 'text-green-600' : 'text-gray-300'}`}>{r.current_amount > 0 ? f(r.current_amount) : '-'}</td>
                  <td className={`p-3 text-right text-xs ${r.overdue_1_30 > 0 ? 'text-yellow-600' : 'text-gray-300'}`}>{r.overdue_1_30 > 0 ? f(r.overdue_1_30) : '-'}</td>
                  <td className={`p-3 text-right text-xs ${r.overdue_31_60 > 0 ? 'text-orange-600' : 'text-gray-300'}`}>{r.overdue_31_60 > 0 ? f(r.overdue_31_60) : '-'}</td>
                  <td className={`p-3 text-right text-xs ${r.overdue_61_90 > 0 ? 'text-red-600' : 'text-gray-300'}`}>{r.overdue_61_90 > 0 ? f(r.overdue_61_90) : '-'}</td>
                  <td className={`p-3 text-right text-xs font-bold ${r.overdue_over_90 > 0 ? 'text-red-700' : 'text-gray-300'}`}>{r.overdue_over_90 > 0 ? f(r.overdue_over_90) : '-'}</td>
                </tr>
              );
            })}
            {items.length > 0 && (
              <tr className="bg-gray-50 dark:bg-gray-900/50 font-bold text-xs">
                <td className="p-3">TOTAL</td>
                <td className="p-3"></td>
                <td className="p-3 text-right">{f(totals.total)}</td>
                <td className="p-3 text-right">{f(totals.current)}</td>
                <td className="p-3 text-right">{f(totals.d1)}</td>
                <td className="p-3 text-right">{f(totals.d2)}</td>
                <td className="p-3 text-right">{f(totals.d3)}</td>
                <td className="p-3 text-right">{f(totals.d4)}</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default function AgingReportPage() {
  const { data, isLoading } = useQuery({ queryKey: ['aging'], queryFn: getAgingReport });

  const totalRecv = data?.receivable.reduce((s, r) => s + r.total, 0) || 0;
  const totalPay = data?.payable.reduce((s, r) => s + r.total, 0) || 0;
  const highRiskRecv = data?.receivable.filter(r => r.overdue_over_90 > 0).length || 0;
  const highRiskPay = data?.payable.filter(r => r.overdue_over_90 > 0).length || 0;

  return (
    <div className="p-6 max-w-[1400px] mx-auto space-y-5">
      <div>
        <h2 className="text-2xl font-bold text-gray-900 dark:text-white">Aging & Collection Reports</h2>
        <p className="text-sm text-gray-500">Outstanding receivables and payables by age bucket</p>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-4">
          <p className="text-[10px] uppercase text-gray-500 mb-1">Total Receivables</p>
          <p className="text-xl font-bold text-amber-600">{f(totalRecv)}</p>
        </div>
        <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-4">
          <p className="text-[10px] uppercase text-gray-500 mb-1">Total Payables</p>
          <p className="text-xl font-bold text-red-600">{f(totalPay)}</p>
        </div>
        <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-4">
          <p className="text-[10px] uppercase text-gray-500 mb-1">High Risk Receivables</p>
          <p className="text-xl font-bold text-red-600">{highRiskRecv}</p>
        </div>
        <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-4">
          <p className="text-[10px] uppercase text-gray-500 mb-1">High Risk Payables</p>
          <p className="text-xl font-bold text-red-600">{highRiskPay}</p>
        </div>
      </div>

      {/* Risk Alert */}
      {(highRiskRecv > 0 || highRiskPay > 0) && (
        <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800/30 rounded-xl p-4 flex items-center gap-3 text-sm text-red-700 dark:text-red-400">
          <AlertTriangle className="w-5 h-5 flex-shrink-0" />
          <span><strong>{highRiskRecv + highRiskPay}</strong> items are 90+ days overdue and require immediate attention</span>
        </div>
      )}

      {isLoading ? (
        <div className="flex justify-center py-16"><div className="w-8 h-8 border-4 border-blue-600 border-t-transparent rounded-full animate-spin" /></div>
      ) : data ? (
        <div className="space-y-8">
          <AgingTable title="Accounts Receivable" items={data.receivable} type="receivable" />
          <AgingTable title="Accounts Payable" items={data.payable} type="payable" />
        </div>
      ) : null}
    </div>
  );
}