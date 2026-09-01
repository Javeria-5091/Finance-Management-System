'use client';

import { useState } from 'react';
import {
  Search, Filter, ChevronLeft, ChevronRight, X,
  TrendingUp, TrendingDown, ArrowRightLeft, FileText,
  CheckCircle2, Circle, ArrowLeft, ExternalLink
} from 'lucide-react';
import Link from 'next/link';
import {
  useTransactionSummary, useTransactionList, useTransactionDetail
} from '@/hooks/useTransactions';
import type { TransactionRow, SettlementLine, JournalLine, StatusStep } from '@/types/transaction.types';

// ==========================================
// FORMATTING
// ==========================================
const f = (n: number) => new Intl.NumberFormat('en-PK', {
  style: 'currency', currency: 'PKR', minimumFractionDigits: 0, maximumFractionDigits: 0
}).format(n || 0);

const statusConfig: Record<string, { label: string; color: string; bg: string }> = {
  DRAFT: { label: 'Draft', color: 'text-gray-600 dark:text-gray-400', bg: 'bg-gray-100 dark:bg-gray-700' },
  SUBMITTED: { label: 'Submitted', color: 'text-blue-600 dark:text-blue-400', bg: 'bg-blue-100 dark:bg-blue-900/30' },
  VERIFIED: { label: 'Verified', color: 'text-amber-600 dark:text-amber-400', bg: 'bg-amber-100 dark:bg-amber-900/30' },
  APPROVED: { label: 'Approved', color: 'text-purple-600 dark:text-purple-400', bg: 'bg-purple-100 dark:bg-purple-900/30' },
  POSTED: { label: 'Posted', color: 'text-green-600 dark:text-green-400', bg: 'bg-green-100 dark:bg-green-900/30' },
  RECONCILED: { label: 'Reconciled', color: 'text-emerald-600 dark:text-emerald-400', bg: 'bg-emerald-100 dark:bg-emerald-900/30' },
};

const sourceConfig: Record<string, { label: string; color: string }> = {
  INVOICE: { label: 'Invoice', color: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400' },
  VENDOR_BILL: { label: 'Bill', color: 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400' },
  EXPENSE: { label: 'Expense', color: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400' },
  SETTLEMENT: { label: 'Settlement', color: 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400' },
  JOURNAL: { label: 'Journal', color: 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300' },
  PAYMENT: { label: 'Payment', color: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400' },
};

// ==========================================
// WATERFALL CHART (like reference image)
// ==========================================
function WaterfallChart({ lines, grossAmount }: { lines: SettlementLine[]; grossAmount: number }) {
  if (!lines.length) return null;
  const gross = Math.abs(grossAmount) || 1;
  const netLine = lines.find(l => l.type === 'NET');
  const netPct = netLine ? ((Math.abs(netLine.amount) / gross) * 100).toFixed(1) : '0';

  return (
    <div className="space-y-2">
      {lines.map((line, i) => {
        const widthPct = (Math.abs(line.amount) / gross) * 100;
        const isNet = line.type === 'NET';
        return (
          <div key={i}>
            <div className="flex items-center justify-between mb-1">
              <div className="flex items-center gap-2">
                <div className="w-2.5 h-2.5 rounded-sm" style={{ backgroundColor: line.color }} />
                <span className={`text-xs ${isNet ? 'font-bold text-gray-900 dark:text-white' : 'text-gray-600 dark:text-gray-400'}`}>
                  {line.label}
                </span>
                {line.original_amount !== null && line.original_currency && (
                  <span className="text-[10px] text-gray-400">
                    ({new Intl.NumberFormat('en', { style: 'currency', currency: line.original_currency, minimumFractionDigits: 0 }).format(line.original_amount)})
                  </span>
                )}
              </div>
              <span className={`text-xs font-mono ${isNet ? 'font-bold text-gray-900 dark:text-white' : 'text-gray-600 dark:text-gray-400'}`}>
                {line.type === 'DEDUCTION' || line.type === 'ADJUSTMENT' ? '-' : ''}{f(line.amount)}
              </span>
            </div>
            <div className="w-full bg-gray-100 dark:bg-gray-700 rounded-md h-6 overflow-hidden relative">
              <div
                className={`h-full rounded-md transition-all ${isNet ? 'opacity-90' : 'opacity-70'}`}
                style={{ width: `${widthPct}%`, backgroundColor: line.color }}
              />
              {isNet && (
                <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[9px] font-bold text-white drop-shadow">
                  {netPct}% of Gross
                </span>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ==========================================
// STATUS TIMELINE
// ==========================================
const ALL_STATUSES = ['DRAFT', 'SUBMITTED', 'VERIFIED', 'APPROVED', 'POSTED', 'RECONCILED'];

function StatusTimeline({ currentStatus }: { currentStatus: string }) {
  const currentIdx = ALL_STATUSES.indexOf(currentStatus);

  return (
    <div className="flex items-center gap-0">
      {ALL_STATUSES.map((s, i) => {
        const cfg = statusConfig[s] || statusConfig.DRAFT;
        const isCompleted = i < currentIdx;
        const isCurrent = i === currentIdx;
        const isFuture = i > currentIdx;

        return (
          <div key={s} className="flex items-center">
            <div className="flex flex-col items-center gap-1">
              <div className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold transition-all ${
                isCompleted ? 'bg-green-500 text-white' :
                isCurrent ? 'bg-blue-500 text-white ring-4 ring-blue-500/20' :
                'bg-gray-200 dark:bg-gray-700 text-gray-400'
              }`}>
                {isCompleted ? <CheckCircle2 className="w-4 h-4" /> : <Circle className="w-3 h-3" />}
              </div>
              <span className={`text-[9px] whitespace-nowrap ${
                isCurrent ? 'font-bold text-blue-600 dark:text-blue-400' :
                isCompleted ? 'text-green-600 dark:text-green-400' :
                'text-gray-400'
              }`}>{cfg.label}</span>
            </div>
            {i < ALL_STATUSES.length - 1 && (
              <div className={`w-6 h-0.5 mx-0.5 mt-[-14px] ${
                i < currentIdx ? 'bg-green-400' : 'bg-gray-200 dark:bg-gray-700'
              }`} />
            )}
          </div>
        );
      })}
    </div>
  );
}

// ==========================================
// JOURNAL PREVIEW
// ==========================================
function JournalPreview({ lines, totalDebit, totalCredit }: { lines: JournalLine[]; totalDebit: number; totalCredit: number }) {
  const isBalanced = Math.abs(totalDebit - totalCredit) < 0.01;

  return (
    <div>
      <table className="w-full text-xs">
        <thead>
          <tr className="text-[9px] uppercase text-gray-500 dark:text-gray-400 border-b border-gray-200 dark:border-gray-700">
            <th className="text-left py-2 pr-2">Account</th>
            <th className="text-right py-2 px-2">Debit</th>
            <th className="text-right py-2 pl-2">Credit</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100 dark:divide-gray-700/50">
          {lines.map((l, i) => (
            <tr key={i} className="hover:bg-gray-50 dark:hover:bg-gray-700/30">
              <td className="py-2 pr-2">
                <span className="text-gray-400 font-mono mr-1.5">{l.account_code}</span>
                <span className="text-gray-700 dark:text-gray-300">{l.account_name}</span>
              </td>
              <td className="py-2 px-2 text-right font-mono text-gray-700 dark:text-gray-300">
                {l.debit_amount > 0 ? f(l.debit_amount) : '-'}
              </td>
              <td className="py-2 pl-2 text-right font-mono text-gray-700 dark:text-gray-300">
                {l.credit_amount > 0 ? f(l.credit_amount) : '-'}
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="border-t-2 border-gray-300 dark:border-gray-600">
            <td className="py-2 pr-2 font-bold text-gray-900 dark:text-white">Total</td>
            <td className="py-2 px-2 text-right font-bold font-mono text-gray-900 dark:text-white">{f(totalDebit)}</td>
            <td className="py-2 pl-2 text-right font-bold font-mono text-gray-900 dark:text-white">{f(totalCredit)}</td>
          </tr>
        </tfoot>
      </table>
      <div className={`mt-3 flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-medium ${
        isBalanced ? 'bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-400' :
        'bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-400'
      }`}>
        {isBalanced ? <CheckCircle2 className="w-4 h-4" /> : <X className="w-4 h-4" />}
        {isBalanced ? 'Balanced — Debits equal Credits' : `Imbalanced — Difference: ${f(Math.abs(totalDebit - totalCredit))}`}
      </div>
    </div>
  );
}

// ==========================================
// DETAIL DRAWER
// ==========================================
function DetailDrawer({ txnId, onClose }: { txnId: string | null; onClose: () => void }) {
  const { data: detail, isLoading, error } = useTransactionDetail(txnId);

  if (!txnId) return null;

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative w-full max-w-[600px] bg-white dark:bg-gray-900 shadow-2xl overflow-y-auto">
        {/* Header */}
        <div className="sticky top-0 z-10 bg-white dark:bg-gray-900 border-b border-gray-200 dark:border-gray-700 px-6 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <button onClick={onClose} className="p-1.5 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg">
                <ArrowLeft className="w-5 h-5 text-gray-500" />
              </button>
              {isLoading ? (
                <div className="h-6 w-40 bg-gray-200 dark:bg-gray-700 rounded animate-pulse" />
              ) : (
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-bold text-gray-900 dark:text-white">{detail?.reference || detail?.id?.slice(0, 8)}</span>
                    {detail?.status && (
                      <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${statusConfig[detail.status]?.bg || ''} ${statusConfig[detail.status]?.color || ''}`}>
                        {statusConfig[detail.status]?.label || detail.status}
                      </span>
                    )}
                  </div>
                  {detail?.source_reference && (
                    <p className="text-xs text-gray-500 mt-0.5">
                      Source: <span className="font-medium text-blue-600 dark:text-blue-400">{detail.source_reference}</span>
                    </p>
                  )}
                </div>
              )}
            </div>
            {detail?.source_type && (
              <span className={`text-[10px] font-bold px-2 py-1 rounded ${sourceConfig[detail.source_type]?.color || sourceConfig.JOURNAL.color}`}>
                {sourceConfig[detail.source_type]?.label || detail.source_type}
              </span>
            )}
          </div>
        </div>

        <div className="p-6 space-y-6">
          {isLoading && (
            <div className="space-y-4">
              {[1,2,3,4].map(i => <div key={i} className="h-20 bg-gray-100 dark:bg-gray-800 rounded-xl animate-pulse" />)}
            </div>
          )}

          {error && (
            <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800/30 rounded-xl p-4">
              <p className="text-sm text-red-600 dark:text-red-400">{error.message}</p>
            </div>
          )}

          {detail && !isLoading && !error && (
            <>
              {/* Info Grid */}
              <div className="grid grid-cols-2 gap-3 text-xs">
                <div className="bg-gray-50 dark:bg-gray-800 rounded-lg p-3">
                  <p className="text-gray-500 mb-1">Date</p>
                  <p className="font-medium text-gray-900 dark:text-white">{detail.entry_date ? new Date(detail.entry_date).toLocaleDateString('en-PK', { day: '2-digit', month: 'short', year: 'numeric' }) : '-'}</p>
                </div>
                <div className="bg-gray-50 dark:bg-gray-800 rounded-lg p-3">
                  <p className="text-gray-500 mb-1">Period</p>
                  <p className="font-medium text-gray-900 dark:text-white">{detail.period_name || '-'}</p>
                </div>
                <div className="bg-gray-50 dark:bg-gray-800 rounded-lg p-3">
                  <p className="text-gray-500 mb-1">Project</p>
                  <p className="font-medium text-gray-900 dark:text-white">{detail.project_name || '-'}</p>
                </div>
                <div className="bg-gray-50 dark:bg-gray-800 rounded-lg p-3">
                  <p className="text-gray-500 mb-1">Created By</p>
                  <p className="font-medium text-gray-900 dark:text-white">{detail.created_by_name || '-'}</p>
                </div>
              </div>

              {/* Description */}
              <div className="bg-gray-50 dark:bg-gray-800 rounded-lg p-3">
                <p className="text-[10px] uppercase text-gray-500 mb-1">Description</p>
                <p className="text-sm text-gray-900 dark:text-white">{detail.description || 'No description'}</p>
              </div>

              {/* Status Timeline */}
              <div>
                <h4 className="text-xs font-bold text-gray-500 uppercase mb-3">Status Progress</h4>
                <div className="bg-gray-50 dark:bg-gray-800 rounded-xl p-4 overflow-x-auto">
                  <StatusTimeline currentStatus={detail.status} />
                </div>
              </div>

              {/* Gross to Net Waterfall */}
              {detail.settlement_lines && detail.settlement_lines.length > 0 && (
                <div>
                  <h4 className="text-xs font-bold text-gray-500 uppercase mb-3">Gross to Net Breakdown</h4>
                  <div className="bg-gray-50 dark:bg-gray-800 rounded-xl p-4">
                    <WaterfallChart
                      lines={detail.settlement_lines}
                      grossAmount={detail.settlement_lines.find(l => l.type === 'GROSS')?.amount || detail.total_credit || 0}
                    />
                  </div>
                </div>
              )}

              {/* Journal Preview */}
              <div>
                <div className="flex items-center justify-between mb-3">
                  <h4 className="text-xs font-bold text-gray-500 uppercase">Journal Entry Preview</h4>
                  <span className="text-[10px] text-gray-400">{detail.journal_lines?.length || 0} lines</span>
                </div>
                <div className="bg-gray-50 dark:bg-gray-800 rounded-xl p-4">
                  <JournalPreview
                    lines={detail.journal_lines || []}
                    totalDebit={detail.total_debit || 0}
                    totalCredit={detail.total_credit || 0}
                  />
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ==========================================
// MAIN PAGE
// ==========================================
export default function TransactionsPage() {
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState('ALL');
  const [statusFilter, setStatusFilter] = useState('ALL');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [page, setPage] = useState(1);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const limit = 25;

  const summary = useTransactionSummary();
  const { data: rows, isLoading, error, refetch } = useTransactionList({
    search, type: typeFilter, status: statusFilter,
    date_from: dateFrom || null, date_to: dateTo || null,
    limit, offset: (page - 1) * limit,
  });

  const s = summary.data;
  const netFlow = (s?.total_inflow || 0) - (s?.total_outflow || 0);

  function resetFilters() {
    setSearch(''); setTypeFilter('ALL'); setStatusFilter('ALL');
    setDateFrom(''); setDateTo(''); setPage(1);
  }

  function applyFilter(key: string, value: string) {
    if (key === 'type') setTypeFilter(value);
    if (key === 'status') setStatusFilter(value);
    setPage(1);
  }

  const hasActiveFilters = search || typeFilter !== 'ALL' || statusFilter !== 'ALL' || dateFrom || dateTo;

  return (
    <div className="p-6 max-w-[1400px] mx-auto space-y-5">

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-gray-900 dark:text-white">Transaction Ledger</h2>
          <p className="text-sm text-gray-500 dark:text-gray-400">General Ledger — Source of Truth for all financial entries</p>
        </div>
        <Link href="/dashboard/accounting/journal-entries" className="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 transition-colors">
          + New Entry
        </Link>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-4">
          <div className="flex items-center gap-2 mb-2">
            <div className="p-1.5 rounded-lg bg-green-50 dark:bg-green-900/20"><TrendingUp className="w-4 h-4 text-green-600" /></div>
            <span className="text-[10px] uppercase text-gray-500">Total Inflow</span>
          </div>
          <p className="text-xl font-bold text-green-600">{f(s?.total_inflow || 0)}</p>
        </div>
        <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-4">
          <div className="flex items-center gap-2 mb-2">
            <div className="p-1.5 rounded-lg bg-red-50 dark:bg-red-900/20"><TrendingDown className="w-4 h-4 text-red-600" /></div>
            <span className="text-[10px] uppercase text-gray-500">Total Outflow</span>
          </div>
          <p className="text-xl font-bold text-red-600">{f(s?.total_outflow || 0)}</p>
        </div>
        <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-4">
          <div className="flex items-center gap-2 mb-2">
            <div className="p-1.5 rounded-lg bg-blue-50 dark:bg-blue-900/20"><ArrowRightLeft className="w-4 h-4 text-blue-600" /></div>
            <span className="text-[10px] uppercase text-gray-500">Net Flow</span>
          </div>
          <p className={`text-xl font-bold ${netFlow >= 0 ? 'text-green-600' : 'text-red-600'}`}>{f(netFlow)}</p>
        </div>
        <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-4">
          <div className="flex items-center gap-2 mb-2">
            <div className="p-1.5 rounded-lg bg-emerald-50 dark:bg-emerald-900/20"><CheckCircle2 className="w-4 h-4 text-emerald-600" /></div>
            <span className="text-[10px] uppercase text-gray-500">Posted</span>
          </div>
          <p className="text-xl font-bold text-gray-900 dark:text-white">{s?.posted_count || 0}</p>
        </div>
        <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-4">
          <div className="flex items-center gap-2 mb-2">
            <div className="p-1.5 rounded-lg bg-amber-50 dark:bg-amber-900/20"><FileText className="w-4 h-4 text-amber-600" /></div>
            <span className="text-[10px] uppercase text-gray-500">Pending</span>
          </div>
          <p className="text-xl font-bold text-amber-600">{s?.pending_count || 0}</p>
        </div>
      </div>

      {/* Filters */}
      <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-4">
        <div className="flex flex-col lg:flex-row gap-3">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
            <input
              type="text" placeholder="Search by reference or description..."
              value={search} onChange={e => { setSearch(e.target.value); setPage(1); }}
              className="w-full pl-9 pr-4 py-2.5 bg-gray-50 dark:bg-gray-900 border border-gray-300 dark:border-gray-700 rounded-lg text-sm text-gray-900 dark:text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          <div className="flex flex-wrap gap-2">
            <select value={typeFilter} onChange={e => applyFilter('type', e.target.value)}
              className="px-3 py-2.5 bg-gray-50 dark:bg-gray-900 border border-gray-300 dark:border-gray-700 rounded-lg text-sm text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500">
              <option value="ALL">All Types</option>
              <option value="INFLOW">Inflow Only</option>
              <option value="OUTFLOW">Outflow Only</option>
            </select>

            <select value={statusFilter} onChange={e => applyFilter('status', e.target.value)}
              className="px-3 py-2.5 bg-gray-50 dark:bg-gray-900 border border-gray-300 dark:border-gray-700 rounded-lg text-sm text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500">
              <option value="ALL">All Statuses</option>
              <option value="DRAFT">Draft</option>
              <option value="SUBMITTED">Submitted</option>
              <option value="VERIFIED">Verified</option>
              <option value="APPROVED">Approved</option>
              <option value="POSTED">Posted</option>
            </select>

            <input type="date" value={dateFrom} onChange={e => { setDateFrom(e.target.value); setPage(1); }}
              className="px-3 py-2.5 bg-gray-50 dark:bg-gray-900 border border-gray-300 dark:border-gray-700 rounded-lg text-sm text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500" placeholder="From" />
            <input type="date" value={dateTo} onChange={e => { setDateTo(e.target.value); setPage(1); }}
              className="px-3 py-2.5 bg-gray-50 dark:bg-gray-900 border border-gray-300 dark:border-gray-700 rounded-lg text-sm text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500" placeholder="To" />

            {hasActiveFilters && (
              <button onClick={resetFilters}
                className="px-3 py-2.5 text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-lg text-sm font-medium transition-colors">
                Clear
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Table */}
      <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="bg-gray-50 dark:bg-gray-900/70 border-b border-gray-200 dark:border-gray-700">
              <tr className="text-[10px] uppercase text-gray-500 dark:text-gray-400">
                <th className="px-4 py-3">Date</th>
                <th className="px-4 py-3">Reference</th>
                <th className="px-4 py-3">Description</th>
                <th className="px-4 py-3 hidden lg:table-cell">Source</th>
                <th className="px-4 py-3 hidden xl:table-cell">Accounts</th>
                <th className="px-4 py-3 text-right">Debit</th>
                <th className="px-4 py-3 text-right">Credit</th>
                <th className="px-4 py-3 text-center">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-700/50">
              {isLoading && (
                <tr><td colSpan={8} className="px-4 py-12 text-center text-gray-400">Loading transactions...</td></tr>
              )}
              {!isLoading && error && (
                <tr><td colSpan={8} className="px-4 py-16 text-center">
                  <FileText className="w-10 h-10 text-red-300 dark:text-red-800 mx-auto mb-3" />
                  <p className="text-red-500 dark:text-red-400 font-medium">Couldn't load transactions</p>
                  <p className="text-xs text-gray-400 dark:text-gray-500 mt-1 max-w-md mx-auto">
                    {error instanceof Error ? error.message : 'Something went wrong while fetching the ledger.'}
                  </p>
                  <button onClick={() => refetch()}
                    className="mt-3 px-3 py-1.5 text-xs font-medium text-blue-600 dark:text-blue-400 border border-blue-200 dark:border-blue-800 rounded-lg hover:bg-blue-50 dark:hover:bg-blue-900/20 transition-colors">
                    Retry
                  </button>
                </td></tr>
              )}
              {!isLoading && !error && !rows?.length && (
                <tr><td colSpan={8} className="px-4 py-16 text-center">
                  <FileText className="w-10 h-10 text-gray-300 dark:text-gray-600 mx-auto mb-3" />
                  <p className="text-gray-500 dark:text-gray-400 font-medium">No transactions found</p>
                  <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">Journal entries will appear here once posted from Invoices, Bills, or manual Journals</p>
                </td></tr>
              )}
              {!error && rows?.map(t => {
                const sc = statusConfig[t.status] || statusConfig.DRAFT;
                const src = sourceConfig[t.source_type] || sourceConfig.JOURNAL;
                const isInflow = t.net_amount > 0;
                return (
                  <tr key={t.id}
                    onClick={() => setSelectedId(t.id)}
                    className="hover:bg-blue-50/50 dark:hover:bg-blue-900/10 cursor-pointer transition-colors group">
                    <td className="px-4 py-3 text-gray-500 dark:text-gray-400 whitespace-nowrap text-xs">
                      {t.entry_date ? new Date(t.entry_date).toLocaleDateString('en-PK', { day: '2-digit', month: 'short' }) : '-'}
                    </td>
                    <td className="px-4 py-3">
                      <span className="font-mono text-xs font-medium text-blue-600 dark:text-blue-400">{t.reference || t.id.slice(0, 8)}</span>
                    </td>
                    <td className="px-4 py-3 text-gray-900 dark:text-white font-medium max-w-[250px] truncate">{t.description}</td>
                    <td className="px-4 py-3 hidden lg:table-cell">
                      <span className={`text-[10px] font-bold px-2 py-0.5 rounded ${src.color}`}>{src.label}</span>
                      {t.source_reference && (
                        <span className="ml-1.5 text-[10px] text-gray-400">{t.source_reference}</span>
                      )}
                    </td>
                    <td className="px-4 py-3 hidden xl:table-cell">
                      <div className="flex flex-wrap gap-1">
                        {(t.account_names || []).slice(0, 2).map((a, i) => (
                          <span key={i} className="text-[10px] bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400 px-1.5 py-0.5 rounded">{a}</span>
                        ))}
                        {(t.account_names?.length || 0) > 2 && (
                          <span className="text-[10px] text-gray-400">+{t.account_names.length - 2}</span>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-xs">
                      {t.total_debit > 0 ? <span className="text-red-600 dark:text-red-400">{f(t.total_debit)}</span> : <span className="text-gray-300 dark:text-gray-600">-</span>}
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-xs">
                      {t.total_credit > 0 ? <span className="text-green-600 dark:text-green-400">{f(t.total_credit)}</span> : <span className="text-gray-300 dark:text-gray-600">-</span>}
                    </td>
                    <td className="px-4 py-3 text-center">
                      <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${sc.bg} ${sc.color}`}>{sc.label}</span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Pagination */}
      {rows && rows.length >= limit && (
        <div className="flex items-center justify-between">
          <p className="text-sm text-gray-500">Page {page}</p>
          <div className="flex items-center gap-2">
            <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1}
              className="p-2 rounded-lg bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 disabled:opacity-40 hover:bg-gray-50 dark:hover:bg-gray-700">
              <ChevronLeft size={16} />
            </button>
            <button onClick={() => setPage(p => p + 1)}
              className="p-2 rounded-lg bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-700">
              <ChevronRight size={16} />
            </button>
          </div>
        </div>
      )}

      {/* Detail Drawer */}
      <DetailDrawer txnId={selectedId} onClose={() => setSelectedId(null)} />
    </div>
  );
}