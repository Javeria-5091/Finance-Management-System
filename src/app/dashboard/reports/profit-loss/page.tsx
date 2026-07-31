'use client';
import { useState } from 'react';
import { reportService } from '../../../../services/report.service';
import { Download, FileText } from 'lucide-react';
import type { ProfitAndLossRow } from '@/types/accounting.types';

const fmtPKR = (n: number) => new Intl.NumberFormat('en-PK', { style: 'currency', currency: 'PKR', minimumFractionDigits: 0 }).format(n || 0);

export default function ProfitLossPage() {
  const [data, setData] = useState<ProfitAndLossRow[]>([]);
  const [start, setStart] = useState('2024-07-01');
  const [end, setEnd] = useState('2025-06-30');
  const [loading, setLoading] = useState(false);
  const [downloading, setDownloading] = useState<string | null>(null);

  const fetchReport = async () => {
    setLoading(true);
    try {
      const res = await reportService.getProfitAndLoss(start, end);
      setData(res);
    } finally {
      setLoading(false);
    }
  };

  const handleDownloadCSV = () => {
    if (!data.length) return;
    // Build CSV content
    const headers = ['Section', 'Code', 'Account', 'Debit', 'Credit', 'Net Amount'];
    const csvRows = [
      headers.join(','),
      ...data.map(row => [
        row.section.replace(/PROFIT_LOSS_/, '').replace(/_/g, ' '),
        row.code,
        row.account_name,
        row.debit_total?.toString() || '0',
        row.credit_total?.toString() || '0',
        row.net_amount?.toString() || '0',
      ]),
    ].join('\n');

    // Download as file
    const blob = new Blob([csvRows], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `P&L_${start}_to_${end}.csv`;
    link.click();
    setDownloading(null);
  };

  const totalRevenue = data.filter(d => d.section === 'PROFIT_LOSS_REVENUE').reduce((a, b) => a + b.net_amount, 0);
  const totalCos = data.filter(d => ['PROFIT_LOSS_COS', 'PROFIT_LOSS_OP_EXPENSE', 'PROFIT_LOSS_OTHER_EXPENSE'].includes(d.section)).reduce((a, b) => a + b.net_amount, 0);
  const grossProfit = totalRevenue - totalCos;
  const totalOpExp = data.filter(d => d.section === 'PROFIT_LOSS_OP_EXPENSE').reduce((a, b) => a + b.net_amount, 0);
  const netProfit = grossProfit - totalOpExp +
    data.filter(d => d.section === 'PROFIT_LOSS_OTHER_INCOME').reduce((a, b) => a + b.net_amount, 0);

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Profit & Loss Statement</h1>
      
      {/* Period Filter */}
      <div className="flex gap-4 items-end mb-6">
        <div>
          <label className="block text-sm text-gray-600 mb-1">Start Date</label>
          <input
            type="date"
            value={start}
            onChange={(e) => setStart(e.target.value)}
            className="border rounded p-2 dark:bg-gray-800 dark:border-gray-600"
          />
        </div>
        <div>
          <label className="block text-sm text-gray-600 mb-1">End Date</label>
          <input
            type="date"
            value={end}
            onChange={(e) => setEnd(e.target.value)}
            className="border rounded p-2 dark:bg-gray-800 dark:border-gray-600"
          />
        </div>
        <button
          onClick={fetchReport}
          disabled={loading}
          className="px-6 py-2.5 bg-blue-600 hover:bg-blue-700 text-white rounded-xl font-medium disabled:opacity-50 flex items-center gap-2"
        >
          {loading ? 'Loading...' : 'Generate P&L'}
        </button>
      </div>

      {data.length > 0 && (
        <>
          <div className="bg-white dark:bg-gray-800 border dark:border-gray-700 rounded-xl overflow-hidden shadow-sm">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 dark:bg-gray-900/50 border-b dark:border-gray-700 text-left text-xs uppercase text-gray-500">
                <tr>
                  <th className="px-3 py-2.5">Section</th>
                  <th className="px-3 py-2.5">Account</th>
                  <th className="px-3 py-2.5 text-right">Amount (PKR)</th>
                </tr>
              </thead>
              <tbody className="divide-y dark:divide-gray-700">
                {data.map((row, i) => (
                  <tr key={i} className="border-t border-gray-100 dark:border-gray-700">
                    <td className="px-3 py-2.5 text-gray-500 text-xs">
                      {row.section.replace(/PROFIT_LOSS_/g, '')}
                    </td>
                    <td className="px-3 py-2 font-medium text-gray-900 dark:text-white">
                      {row.code} - {row.account_name}
                    </td>
                    <td className={`px-3 py-2 text-right font-mono ${
                      row.net_amount >= 0
                        ? 'text-black dark:text-white'
                        : 'text-red-600 dark:text-red-400'
                    }`}>
                      {fmtPKR(row.net_amount)}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="bg-gray-50 dark:bg-gray-900 font-bold">
                <tr className="border-t-2 border-gray-300">
                  <td colSpan={2} className="p-3">Gross Profit</td>
                  <td className="p-3 text-right">{fmtPKR(grossProfit)}</td>
                </tr>
                <tr className="border-t border-gray-300">
                  <td colSpan={2} className="p-3">Net Profit</td>
                  <td className={`p-3 text-right ${netProfit >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                    {fmtPKR(netProfit)}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
          <div className="flex justify-end mt-4">
            <button
              onClick={handleDownloadCSV}
              disabled={!!downloading}
              className="px-6 py-2.5 bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 text-gray-800 dark:text-white rounded-xl text-sm font-medium disabled:opacity-50 flex items-center gap-2"
            >
              {downloading ? 'Downloading...' : 'Download CSV'}
            </button>
          </div>
        </>
      )}
    </div>
  );
}