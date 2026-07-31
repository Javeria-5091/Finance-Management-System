'use client';
import { useState } from 'react';
import { reportService } from '../../../../services/report.service';
import { ShieldCheck, AlertTriangle } from 'lucide-react';
import type { BalanceSheetRow } from '@/types/accounting.types';

const fmtPKR = (n: number) => new Intl.NumberFormat('en-PK', { style: 'currency', currency: 'PKR', minimumFractionDigits: 0 }).format(n);

export default function BalanceSheetPage() {
  const [data, setData] = useState<BalanceSheetRow[]>([]);
  const [date, setDate] = useState(new Date().toISOString().split('T')[0]);
  const [loading, setLoading] = useState(false);

  const fetchReport = async () => {
    setLoading(true);
    try { setData(await reportService.getBalanceSheet(date)); } finally { setLoading(false); }
  };

  const totalAssets = data.filter(d => d.section_order === 1).reduce((a, b) => a + b.net_amount, 0);
  const totalLiabilities = data.filter(d => d.section_order === 2).reduce((a, b) => a + b.net_amount, 0);
  const totalEquity = data.filter(d => d.section_order === 3).reduce((a, b) => a + b.net_amount, 0);
  const isBalanced = Math.abs(totalAssets - (totalLiabilities + totalEquity)) < 1;

  const renderSection = (order: number, title: string) => {
    const rows = data.filter(d => d.section_order === order);
    if (!rows.length) return null;
    const total = rows.reduce((a, b) => a + b.net_amount, 0);
    const isHeader = (code: string) => code.endsWith('00') && !code.endsWith('000');

    return (
      <div className="mb-6">
        <h3 className="text-sm font-bold text-slate-800 dark:text-slate-200 uppercase tracking-wider border-b dark:border-slate-700 pb-2 mb-2">{title}</h3>
        {rows.map((row, i) => (
          <div key={i} className={`flex justify-between py-1.5 ${isHeader(row.code) ? 'font-semibold pl-2' : 'pl-6 text-slate-600 dark:text-slate-400'}`}>
            <span className="text-sm">{row.code} - {row.account_name}</span>
            <span className="text-sm font-mono">{fmtPKR(row.net_amount)}</span>
          </div>
        ))}
        <div className="flex justify-between pt-2 mt-2 border-t dark:border-slate-700 font-bold text-slate-900 dark:text-white">
          <span>Total {title}</span>
          <span className="font-mono">{fmtPKR(total)}</span>
        </div>
      </div>
    );
  };

  return (
    <div className="p-8 max-w-4xl mx-auto space-y-6">
      <div className="flex justify-between items-start">
        <div>
          <h1 className="text-3xl font-bold text-slate-900 dark:text-white">Balance Sheet</h1>
          <p className="text-slate-500 mt-1">As of {date}</p>
        </div>
        <div className="bg-slate-50 dark:bg-slate-800 p-4 rounded-lg border dark:border-slate-700 w-64">
          <label className="block text-xs font-medium text-slate-500 mb-1">As Of Date</label>
          <input type="date" value={date} onChange={e => setDate(e.target.value)} className="w-full border dark:border-slate-600 rounded-md p-2 text-sm dark:bg-slate-900 dark:text-white" />
          <button onClick={fetchReport} disabled={loading} className="w-full mt-2 px-4 py-2 bg-slate-900 dark:bg-blue-600 text-white rounded-md text-sm font-medium disabled:opacity-50">
            {loading ? 'Loading...' : 'Generate'}
          </button>
        </div>
      </div>

      {data.length > 0 && (
        <>
          {!isBalanced && (
            <div className="bg-red-50 border-l-4 border-red-500 text-red-700 p-4 rounded-r-lg flex items-center gap-3 text-sm font-semibold">
              <AlertTriangle className="w-5 h-5" /> BALANCE SHEET ERROR: Assets do not equal Liabilities + Equity. Difference: {fmtPKR(totalAssets - (totalLiabilities + totalEquity))}
            </div>
          )}

          <div className="grid grid-cols-2 gap-8">
            {/* Assets Side */}
            <div className="bg-white dark:bg-slate-800 border dark:border-slate-700 rounded-xl p-6 shadow-sm">
              {renderSection(1, 'ASSETS')}
            </div>
            
            {/* Liabilities & Equity Side */}
            <div className="space-y-6">
              <div className="bg-white dark:bg-slate-800 border dark:border-slate-700 rounded-xl p-6 shadow-sm">
                {renderSection(2, 'LIABILITIES')}
              </div>
              <div className="bg-white dark:bg-slate-800 border dark:border-slate-700 rounded-xl p-6 shadow-sm">
                {renderSection(3, "OWNER'S EQUITY")}
              </div>
              <div className="bg-slate-100 dark:bg-slate-900 border dark:border-slate-700 rounded-xl p-4 shadow-sm">
                <div className="flex justify-between font-bold text-slate-900 dark:text-white">
                  <span>Total L & E</span>
                  <span className="font-mono">{fmtPKR(totalLiabilities + totalEquity)}</span>
                </div>
              </div>
            </div>
          </div>

          {isBalanced && (
            <div className="bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-200 dark:border-emerald-800 text-emerald-700 dark:text-emerald-400 p-4 rounded-xl flex items-center gap-3 font-semibold">
              <ShieldCheck className="w-6 h-6" /> Statement is balanced and mathematically accurate.
            </div>
          )}
        </>
      )}
    </div>
  );
}