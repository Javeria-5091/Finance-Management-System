'use client';

import { useState, useEffect } from 'react';
import { Download, FileText } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import type { TrialBalanceRow, AccountingPeriod, FiscalYearSummary } from '@/types/accounting.types';

export default function TrialBalancePage() {
  const [data, setData] = useState<TrialBalanceRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [fiscalYears, setFiscalYears] = useState<FiscalYearSummary[]>([]);
  const [periods, setPeriods] = useState<AccountingPeriod[]>([]);
  
  // Proper UI state for selection
  const [selectedFY, setSelectedFY] = useState<string>('');
  const [periodFrom, setPeriodFrom] = useState<string>('');
  const [periodTo, setPeriodTo] = useState<string>('');

  // 1. Load Fiscal Years on mount
  useEffect(() => {
    const loadFYs = async () => {
      const { data } = await supabase
        .from('fiscal_year_summary')
        .select('*')
        .eq('fy_status', 'OPEN')
        .order('fy_start_date', { ascending: false });
        
      if (data) {
        setFiscalYears(data);
        if (data.length > 0) handleFYChange(data[0].fiscal_year_id);
      }
    };
    loadFYs();
  }, []);

  // 2. When Fiscal Year changes, load its periods
  const handleFYChange = async (fyId: string) => {
    setSelectedFY(fyId);
    setPeriodFrom('');
    setPeriodTo('');
    setData([]); // Reset report data

    const { data } = await supabase
      .from('accounting_periods')
      .select('*')
      .eq('fiscal_year_id', fyId)
      .order('period_number');
      
    if (data) setPeriods(data);
  };

  // 3. Generate Report Logic
  const generateReport = async () => {
    if (!periodFrom || !periodTo) {
      return alert("Please select 'From' and 'To' periods");
    }

    // Get all period IDs between From and To
    const fromIndex = periods.findIndex(p => p.id === periodFrom);
    const toIndex = periods.findIndex(p => p.id === periodTo);

    if (fromIndex === -1 || toIndex === -1 || fromIndex > toIndex) {
      return alert("Invalid period selection range");
    }

    const selectedPeriodIds = periods.slice(fromIndex, toIndex + 1).map(p => p.id);

    setLoading(true);
    const { data: res, error } = await supabase.rpc('get_trial_balance', {
      p_period_ids: selectedPeriodIds
    });

    if (error) {
      console.error(error);
      alert("Failed to generate report: " + error.message);
    } else if (res) {
      setData(res);
    }
    setLoading(false);
  };

  const totalDr = data.reduce((s, r) => s + Number(r.total_debit), 0);
  const totalCr = data.reduce((s, r) => s + Number(r.total_credit), 0);

  return (
    <div className="p-4 md:p-6 space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Trial Balance</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">Check Debit/Credit equality for selected periods</p>
        </div>
        {data.length > 0 && (
          <button className="flex items-center gap-2 px-4 py-2 bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-200 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors text-sm">
            <Download className="w-4 h-4" />
            Export CSV
          </button>
        )}
      </div>

      {/* Filters Card - Proper UI */}
      <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-5 shadow-sm">
        <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-4">Select Reporting Period</h3>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 items-end">
          {/* Fiscal Year Dropdown */}
          <div>
            <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1.5">Fiscal Year</label>
            <select
              value={selectedFY}
              onChange={(e) => handleFYChange(e.target.value)}
              className="w-full px-3 py-2.5 bg-gray-50 dark:bg-gray-900 border border-gray-300 dark:border-gray-600 rounded-lg text-sm text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none"
            >
              <option value="">Select Year...</option>
              {fiscalYears.map(fy => (
                <option key={fy.id} value={fy.id}>
                  {fy.name} ({new Date(fy.start_date).getFullYear()} - {new Date(fy.end_date).getFullYear()})
                </option>
              ))}
            </select>
          </div>

          {/* Period From Dropdown */}
          <div>
            <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1.5">From Period</label>
            <select
              value={periodFrom}
              onChange={(e) => setPeriodFrom(e.target.value)}
              disabled={!selectedFY}
              className="w-full px-3 py-2.5 bg-gray-50 dark:bg-gray-900 border border-gray-300 dark:border-gray-600 rounded-lg text-sm text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <option value="">Select Start...</option>
              {periods.map(p => (
                <option key={p.id} value={p.id}>
                  {p.name} ({new Date(p.start_date).toLocaleDateString('en-PK', { day: '2-digit', month: 'short' })})
                </option>
              ))}
            </select>
          </div>

          {/* Period To Dropdown */}
          <div>
            <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1.5">To Period</label>
            <div className="flex gap-2">
              <select
                value={periodTo}
                onChange={(e) => setPeriodTo(e.target.value)}
                disabled={!selectedFY}
                className="flex-1 px-3 py-2.5 bg-gray-50 dark:bg-gray-900 border border-gray-300 dark:border-gray-600 rounded-lg text-sm text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <option value="">Select End...</option>
                {periods.map(p => (
                  <option key={p.id} value={p.id}>
                    {p.name} ({new Date(p.end_date).toLocaleDateString('en-PK', { day: '2-digit', month: 'short' })})
                  </option>
                ))}
              </select>
              <button
                onClick={generateReport}
                disabled={!periodFrom || !periodTo || loading}
                className="px-5 py-2.5 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors whitespace-nowrap"
              >
                {loading ? 'Generating...' : 'Generate'}
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Data Table */}
      {data.length > 0 && (
        <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl overflow-hidden shadow-sm">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 dark:bg-gray-900/50 text-left text-gray-500 dark:text-gray-400 uppercase text-xs">
              <tr>
                <th className="p-4 font-medium">Code</th>
                <th className="p-4 font-medium">Account Name</th>
                <th className="p-4 font-medium text-right">Debit (PKR)</th>
                <th className="p-4 font-medium text-right">Credit (PKR)</th>
                <th className="p-4 font-medium text-right">Net Balance</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-700/50">
              {data.map(row => (
                <tr key={row.account_id} className="hover:bg-gray-50 dark:hover:bg-gray-700/30 transition-colors">
                  <td className="p-4 font-mono text-xs text-gray-500 dark:text-gray-400">{row.code}</td>
                  <td className="p-4 font-medium text-gray-900 dark:text-white">{row.name}</td>
                  <td className="p-4 text-right text-gray-700 dark:text-gray-300">
                    {Number(row.total_debit) > 0 ? Number(row.total_debit).toLocaleString('en-PK', { minimumFractionDigits: 2 }) : '-'}
                  </td>
                  <td className="p-4 text-right text-gray-700 dark:text-gray-300">
                    {Number(row.total_credit) > 0 ? Number(row.total_credit).toLocaleString('en-PK', { minimumFractionDigits: 2 }) : '-'}
                  </td>
                  <td className="p-4 text-right font-semibold text-gray-900 dark:text-white">
                    {Number(row.net_balance).toLocaleString('en-PK', { minimumFractionDigits: 2 })}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot className="bg-gray-50 dark:bg-gray-900/50 font-bold border-t-2 border-gray-200 dark:border-gray-600">
              <tr>
                <td colSpan={2} className="p-4 text-gray-900 dark:text-white">TOTALS</td>
                <td className="p-4 text-right text-gray-900 dark:text-white">
                  {totalDr.toLocaleString('en-PK', { minimumFractionDigits: 2 })}
                </td>
                <td className="p-4 text-right text-gray-900 dark:text-white">
                  {totalCr.toLocaleString('en-PK', { minimumFractionDigits: 2 })}
                </td>
                <td className="p-4 text-right text-gray-900 dark:text-white">
                  {(totalDr - totalCr).toLocaleString('en-PK', { minimumFractionDigits: 2 })}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      {/* Empty State */}
      {data.length === 0 && !loading && selectedFY && (
        <div className="flex flex-col items-center justify-center py-16 text-gray-400 dark:text-gray-500">
          <FileText className="w-12 h-12 mb-3 opacity-50" />
          <p className="font-medium">No Data to Display</p>
          <p className="text-sm mt-1">Select periods and click "Generate" to view the Trial Balance.</p>
        </div>
      )}
    </div>
  );
}