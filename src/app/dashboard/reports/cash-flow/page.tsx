'use client';
import { useState } from 'react';
import { reportService } from '../../../../services/report.service';
import { ArrowDownCircle, ArrowUpCircle, RefreshCw } from 'lucide-react';
import type { CashFlowRow } from '@/types/accounting.types';

const fmtPKR = (n: number) => new Intl.NumberFormat('en-PK', { style: 'currency', currency: 'PKR', minimumFractionDigits: 0 }).format(n);

export default function CashFlowPage() {
  const [data, setData] = useState<CashFlowRow[]>([]);
  const [start, setStart] = useState('2024-07-01');
  const [end, setEnd] = useState('2025-06-30');
  const [loading, setLoading] = useState(false);

  const fetchReport = async () => {
    setLoading(true);
    try { setData(await reportService.getCashFlow(start, end)); } finally { setLoading(false); }
  };

  const totals = (section: string) => data.filter(d => d.section === section).reduce((a, b) => a + b.amount, 0);
  const netCashFlow = totals('OPERATING') + totals('INVESTING') + totals('FINANCING');
  
  // Mock starting cash for demonstration (in real app, fetch from previous period BS)
  const startingCash = 100000; 

  const renderBlock = (section: string, title: string, color: string) => {
    const rows = data.filter(d => d.section === section);
    const total = totals(section);
    return (
      <div className="bg-white dark:bg-slate-800 border dark:border-slate-700 rounded-xl shadow-sm overflow-hidden mb-6">
        <div className={`px-5 py-3 font-bold text-sm text-white ${color}`}>{title} ACTIVITIES</div>
        <div className="p-4 divide-y divide-slate-100 dark:divide-slate-700">
          {rows.map((row, i) => (
            <div key={i} className="flex justify-between py-2 text-sm">
              <span className="text-slate-600 dark:text-slate-400 pl-4">{row.account_name}</span>
              <span className={`font-mono font-medium ${row.amount >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                {row.amount >= 0 ? '+' : ''}{fmtPKR(row.amount)}
              </span>
            </div>
          ))}
        </div>
        <div className="bg-slate-50 dark:bg-slate-900/50 px-5 py-3 flex justify-between font-bold text-sm border-t dark:border-slate-700">
          <span>Net Cash from {title}</span>
          <span className={`font-mono ${total >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>{fmtPKR(total)}</span>
        </div>
      </div>
    );
  };

  return (
    <div className="p-8 max-w-4xl mx-auto space-y-6">
      <h1 className="text-3xl font-bold text-slate-900 dark:text-white">Cash Flow Statement</h1>
      
      <div className="flex gap-4 items-end bg-slate-50 dark:bg-slate-800/50 p-4 rounded-lg border dark:border-slate-700">
        <div className="w-48">
          <label className="block text-xs font-medium text-slate-500 mb-1">Start Date</label>
          <input type="date" value={start} onChange={e => setStart(e.target.value)} className="w-full border dark:border-slate-600 rounded-md p-2 text-sm dark:bg-slate-800 dark:text-white outline-none focus:ring-2 focus:ring-blue-500" />
        </div>
        <div className="w-48">
          <label className="block text-xs font-medium text-slate-500 mb-1">End Date</label>
          <input type="date" value={end} onChange={e => setEnd(e.target.value)} className="w-full border dark:border-slate-600 rounded-md p-2 text-sm dark:bg-slate-800 dark:text-white outline-none focus:ring-2 focus:ring-blue-500" />
        </div>
        <button onClick={fetchReport} disabled={loading} className="px-6 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-md text-sm font-medium disabled:opacity-50">
          {loading ? 'Loading...' : 'Generate'}
        </button>
      </div>

      {data.length > 0 && (
        <>
          {renderBlock('OPERATING', 'OPERATING', 'bg-blue-600')}
          {renderBlock('INVESTING', 'INVESTING', 'bg-purple-600')}
          {renderBlock('FINANCING', 'FINANCING', 'bg-slate-700')}

          {/* Reconciliation Section */}
          <div className="border-t-4 border-slate-900 dark:border-slate-500 pt-6 mt-8">
            <h3 className="font-bold text-slate-900 dark:text-white mb-4 flex items-center gap-2">
              <RefreshCw className="w-5 h-5" /> Cash Reconciliation
            </h3>
            <div className="bg-white dark:bg-slate-800 border dark:border-slate-700 rounded-xl p-5 space-y-3 text-sm">
              <div className="flex justify-between"><span className="text-slate-500">Cash & Bank, Beginning of Period</span><span className="font-mono">{fmtPKR(startingCash)}</span></div>
              <div className="flex justify-between"><span className="text-slate-500">Net Increase/(Decrease) in Cash</span><span className="font-mono font-bold">{fmtPKR(netCashFlow)}</span></div>
              <div className="flex justify-between pt-3 mt-3 border-t-2 border-slate-300 dark:border-slate-600 text-lg font-bold text-slate-900 dark:text-white">
                <span>Cash & Bank, End of Period</span>
                <span className="font-mono">{fmtPKR(startingCash + netCashFlow)}</span>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}