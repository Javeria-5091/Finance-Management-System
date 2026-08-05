'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell, Legend, ReferenceLine } from 'recharts';
import { getBudgetVariance } from '@/services/report.service';
import ReportHeader from '@/components/reports/ReportHeader';
import ReportFilterBar from '@/components/reports/ReportFilterBar';
import ExportManager from '@/components/reports/ExportManager';
import KPICard from '@/components/reports/KPICard';
import EmptyReportState from '@/components/reports/EmptyReportState';
import { PieChart, TrendingUp, TrendingDown, AlertTriangle } from 'lucide-react';
import type { BudgetVarianceRow, ReportFilters } from '@/types/reports.types';

const f = (n: number) => new Intl.NumberFormat('en-PK', { style: 'currency', currency: 'PKR', minimumFractionDigits: 0 }).format(n || 0);

export default function BudgetVariancePage() {
  const [filters, setFilters] = useState<ReportFilters>({});
  const [dataAsOf] = useState(new Date().toISOString());

  const { data, isLoading, refetch } = useQuery({
    queryKey: ['budget-variance', filters.fiscalYear],
    queryFn: () => getBudgetVariance(filters.fiscalYear),
  });

  const rows = (data || []) as BudgetVarianceRow[];
  const totalOriginal = rows.reduce((s, r) => s + r.original_budget, 0);
  const totalActual = rows.reduce((s, r) => s + r.actual, 0);
  const totalCommitted = rows.reduce((s, r) => s + r.committed, 0);
  const totalForecast = rows.reduce((s, r) => s + r.forecast, 0);
  const totalVariance = rows.reduce((s, r) => s + r.variance, 0);
  const overBudgetCount = rows.filter(r => r.variance > 0).length;
  const underBudgetCount = rows.filter(r => r.variance < 0).length;

  const chartData = rows.slice(0, 10).map(r => ({
    name: r.category_name.length > 18 ? r.category_name.slice(0, 18) + '...' : r.category_name,
    Budget: r.revised_budget,
    Actual: r.actual,
    Forecast: r.forecast,
    Variance: r.variance,
  }));

  const getCsv = () => {
    let csv = 'Category,Original Budget,Revised Budget,Committed,Actual,Forecast,Variance,Var %\n';
    rows.forEach(r => csv += `"${r.category_name}",${r.original_budget},${r.revised_budget},${r.committed},${r.actual},${r.forecast},${r.variance},${r.variance_pct.toFixed(1)}%\n`);
    return csv;
  };

  return (
    <div className="p-6 max-w-[1600px] mx-auto space-y-5">
      <ReportHeader
        title="Budget Variance Report"
        subtitle="Original/revised/committed/actual/forecast/variance — Spec 13.2"
        dataAsOf={dataAsOf}
        reconciled={false}
        actions={<ExportManager reportId="budget-variance" reportName="Budget_Variance" getCsvData={getCsv} activeFilters={filters as Record<string, string>} />}
      />

      <ReportFilterBar showFiscalYear onApply={(f) => { setFilters(f); refetch(); }} isLoading={isLoading} />

      {isLoading ? (
        <div className="flex justify-center py-20"><div className="w-8 h-8 border-4 border-blue-600 border-t-transparent rounded-full animate-spin" /></div>
      ) : rows.length > 0 ? (
        <div className="space-y-5">
          <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3">
            <KPICard label="Original Budget" value={f(totalOriginal)} color="blue" icon={<PieChart className="w-4 h-4 text-blue-600" />} />
            <KPICard label="Actual" value={f(totalActual)} color={totalActual <= totalOriginal ? 'green' : 'red'} />
            <KPICard label="Committed" value={f(totalCommitted)} color="amber" />
            <KPICard label="Forecast" value={f(totalForecast)} color="purple" />
            <KPICard label="Variance" value={f(Math.abs(totalVariance))} color={totalVariance <= 0 ? 'green' : 'red'} icon={totalVariance > 0 ? <TrendingUp className="w-4 h-4 text-red-600" /> : <TrendingDown className="w-4 h-4 text-green-600" />} />
            <KPICard label="Over Budget" value={`${overBudgetCount} / ${rows.length}`} color={overBudgetCount > rows.length / 2 ? 'red' : 'green'} icon={<AlertTriangle className="w-4 h-4" />} />
          </div>

          {/* Budget vs Actual Chart */}
          <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-5">
            <h4 className="text-xs font-bold uppercase text-gray-500 mb-4">Budget vs Actual vs Forecast</h4>
            <ResponsiveContainer width="100%" height={350}>
              <BarChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                <XAxis dataKey="name" fontSize={10} />
                <YAxis tickFormatter={(v) => `${(v / 1000).toFixed(0)}K`} fontSize={10} />
                <Tooltip formatter={(v) => f(Number(v))} />
                <Legend wrapperStyle={{ fontSize: '10px' }} />
                <ReferenceLine y={0} stroke="#6b7280" />
                <Bar dataKey="Budget" name="Revised Budget" fill="#93c5fd" radius={[4, 4, 0, 0]} />
                <Bar dataKey="Actual" name="Actual" fill="#3b82f6" radius={[4, 4, 0, 0]} />
                <Bar dataKey="Forecast" name="Forecast" fill="#f59e0b" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>

          {/* Variance Table */}
          <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 dark:bg-gray-900/60 text-[10px] uppercase text-gray-500">
                <tr>
                  <th className="p-3 text-left">Category</th>
                  <th className="p-3 text-right">Original</th>
                  <th className="p-3 text-right">Revised</th>
                  <th className="p-3 text-right">Committed</th>
                  <th className="p-3 text-right">Actual</th>
                  <th className="p-3 text-right">Forecast</th>
                  <th className="p-3 text-right">Variance</th>
                  <th className="p-3 text-right">Var %</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                {rows.map((r, i) => (
                  <tr key={i} className="hover:bg-gray-50 dark:hover:bg-gray-700/30">
                    <td className="p-3 font-medium text-gray-900 dark:text-white">{r.category_name}</td>
                    <td className="p-3 text-right font-mono text-gray-500">{f(r.original_budget)}</td>
                    <td className="p-3 text-right font-mono">{f(r.revised_budget)}</td>
                    <td className="p-3 text-right font-mono text-amber-600">{f(r.committed)}</td>
                    <td className="p-3 text-right font-mono font-medium">{f(r.actual)}</td>
                    <td className="p-3 text-right font-mono text-purple-600">{f(r.forecast)}</td>
                    <td className={`p-3 text-right font-mono font-bold ${r.variance > 0 ? 'text-red-600' : 'text-green-600'}`}>
                      {r.variance > 0 ? '+' : ''}{f(r.variance)}
                    </td>
                    <td className="p-3 text-right">
                      <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${Math.abs(r.variance_pct) > 20 ? 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400' : Math.abs(r.variance_pct) > 10 ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400' : 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'}`}>
                        {r.variance_pct.toFixed(1)}%
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="bg-gray-50 dark:bg-gray-900/50 font-bold text-xs border-t-2 border-gray-300 dark:border-gray-600">
                <tr>
                  <td className="p-3">TOTAL</td>
                  <td className="p-3 text-right font-mono">{f(totalOriginal)}</td>
                  <td className="p-3 text-right font-mono">{f(rows.reduce((s, r) => s + r.revised_budget, 0))}</td>
                  <td className="p-3 text-right font-mono">{f(totalCommitted)}</td>
                  <td className="p-3 text-right font-mono">{f(totalActual)}</td>
                  <td className="p-3 text-right font-mono">{f(totalForecast)}</td>
                  <td className={`p-3 text-right font-mono ${totalVariance > 0 ? 'text-red-600' : 'text-green-600'}`}>{f(totalVariance)}</td>
                  <td />
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      ) : (
        <EmptyReportState icon="chart" title="No Budget Data" message="No budget categories found" hint="Create budgets in the Budgets module to see variance analysis" />
      )}
    </div>
  );
}
