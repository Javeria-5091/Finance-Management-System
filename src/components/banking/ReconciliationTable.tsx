'use client';
import { useState } from 'react';
import { Ban, Link2, Unlink, Sparkles, Copy } from 'lucide-react';
import { useExcludeLine, useUnmatchLine, useDetectDuplicates } from '@/hooks/useBanking';
import ReasonModal from '@/components/finance/ReasonModal';
import type { StatementLine } from '@/types/services/bank.service';

const STATUS_STYLES: Record<string, string> = {
  UNRECONCILED: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-400',
  MATCHED: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400',
  MANUAL_MATCH: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400',
  EXCLUDED: 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-400',
  DUPLICATE: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
};

const MATCH_METHOD_LABELS: Record<string, string> = {
  AUTO_AMOUNT_DATE: 'Auto: Amount+Date',
  AUTO_AMOUNT_REF: 'Auto: Amount+Ref',
  AUTO_AMOUNT_DESC: 'Auto: Amount±7d',
  AUTO_IDENTIFIER: 'Auto: Txn ID',
  MANUAL: 'Manual',
};

const formatCurrency = (amount: number) =>
  new Intl.NumberFormat('en-PK', {
    style: 'currency',
    currency: 'PKR',
    minimumFractionDigits: 0,
  }).format(amount || 0);

const formatStatus = (status: string) =>
  status?.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());

interface Props {
  lines: StatementLine[];
  statementId: string;
  currency?: string;
}

export default function ReconciliationTable({ lines, statementId, currency = 'PKR' }: Props) {
  const excludeMutation = useExcludeLine();
  const unmatchMutation = useUnmatchLine();
  const detectDupes = useDetectDuplicates();

  const [reasonState, setReasonState] = useState({
    open: false,
    title: '',
    action: '',
    id: '',
  });

  const [selectedLine, setSelectedLine] = useState<StatementLine | null>(null);

  // Summary counts
  const total = lines.length;
  const matched = lines.filter((l) => l.reconciliation_status === 'MATCHED' || l.reconciliation_status === 'MANUAL_MATCH').length;
  const unreconciled = lines.filter((l) => l.reconciliation_status === 'UNRECONCILED').length;
  const excluded = lines.filter((l) => l.reconciliation_status === 'EXCLUDED' || l.reconciliation_status === 'DUPLICATE').length;

  const matchedAmount = lines
    .filter((l) => l.reconciliation_status === 'MATCHED' || l.reconciliation_status === 'MANUAL_MATCH')
    .reduce((sum, l) => sum + l.amount, 0);
  const unreconciledAmount = lines
    .filter((l) => l.reconciliation_status === 'UNRECONCILED')
    .reduce((sum, l) => sum + l.amount, 0);

  const handleExclude = (lineId: string) => {
    setReasonState({
      open: true,
      title: 'Exclude Statement Line',
      action: 'exclude',
      id: lineId,
    });
  };

  const handleExcludeConfirm = (reason: string) => {
    excludeMutation.mutate(
      { lineId: reasonState.id, reason },
      {
        onSuccess: () => setReasonState({ open: false, title: '', action: '', id: '' }),
      }
    );
  };

  const handleUnmatch = (lineId: string) => {
    if (confirm('Unmatch this line? It will return to unreconciled status.')) {
      unmatchMutation.mutate(lineId);
    }
  };

  const handleDetectDupes = () => {
    detectDupes.mutate(statementId);
  };

  return (
    <div className="space-y-4">
      {/* Summary Bar */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
        <div className="bg-white dark:bg-gray-800 border dark:border-gray-700 rounded-lg p-3">
          <p className="text-[10px] uppercase text-gray-400 dark:text-gray-500">Total Lines</p>
          <p className="text-xl font-bold text-gray-900 dark:text-white">{total}</p>
        </div>
        <div className="bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800/30 rounded-lg p-3">
          <p className="text-[10px] uppercase text-green-600 dark:text-green-400">Matched</p>
          <p className="text-xl font-bold text-green-700 dark:text-green-400">{matched}</p>
          <p className="text-xs text-green-600 dark:text-green-400">{formatCurrency(matchedAmount)}</p>
        </div>
        <div className="bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800/30 rounded-lg p-3">
          <p className="text-[10px] uppercase text-yellow-600 dark:text-yellow-400">Unreconciled</p>
          <p className="text-xl font-bold text-yellow-700 dark:text-yellow-400">{unreconciled}</p>
          <p className="text-xs text-yellow-600 dark:text-yellow-400">{formatCurrency(unreconciledAmount)}</p>
        </div>
        <div className="bg-gray-50 dark:bg-gray-700/50 border dark:border-gray-600 rounded-lg p-3">
          <p className="text-[10px] uppercase text-gray-500 dark:text-gray-400">Excluded/Dupe</p>
          <p className="text-xl font-bold text-gray-600 dark:text-gray-300">{excluded}</p>
        </div>
        <div className="flex items-end">
          <button
            onClick={handleDetectDupes}
            disabled={detectDupes.isPending}
            className="w-full flex items-center justify-center gap-1.5 bg-orange-50 dark:bg-orange-900/20 border border-orange-200 dark:border-orange-800/30 text-orange-700 dark:text-orange-400 px-3 py-2.5 rounded-lg text-xs font-medium hover:bg-orange-100 dark:hover:bg-orange-900/30 disabled:opacity-50 transition-colors"
          >
            <Copy className="w-3.5 h-3.5" />
            Detect Duplicates
          </button>
        </div>
      </div>

      {/* Table */}
      <div className="bg-white dark:bg-gray-800 border dark:border-gray-700 rounded-xl overflow-hidden">
        <div className="overflow-x-auto max-h-[calc(100vh-420px)] overflow-y-auto">
          <table className="w-full text-sm text-left">
            <thead className="text-xs uppercase bg-gray-50 dark:bg-gray-900/50 text-gray-500 dark:text-gray-400 sticky top-0 z-10">
              <tr>
                <th className="px-3 py-3 w-8">#</th>
                <th className="px-3 py-3">Date</th>
                <th className="px-3 py-3">Description</th>
                <th className="px-3 py-3 hidden md:table-cell">Reference</th>
                <th className="px-3 py-3 text-right">Amount</th>
                <th className="px-3 py-3 text-right hidden lg:table-cell">Balance</th>
                <th className="px-3 py-3 text-center">Status</th>
                <th className="px-3 py-3 text-center hidden xl:table-cell">Method</th>
                <th className="px-3 py-3 text-center w-24">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y dark:divide-gray-700">
              {lines.map((line, idx) => (
                <tr
                  key={line.id}
                  className={`hover:bg-gray-50 dark:hover:bg-gray-700/30 transition-colors ${
                    selectedLine?.id === line.id ? 'ring-2 ring-blue-500 ring-inset' : ''
                  } ${
                    line.reconciliation_status === 'DUPLICATE' ? 'opacity-50 line-through' : ''
                  }`}
                  onClick={() => setSelectedLine(line)}
                >
                  <td className="px-3 py-2.5 text-xs text-gray-400 font-mono">
                    {line.line_number || idx + 1}
                  </td>
                  <td className="px-3 py-2.5 text-gray-700 dark:text-gray-300 whitespace-nowrap">
                    {line.transaction_date}
                  </td>
                  <td className="px-3 py-2.5">
                    <div className="text-gray-900 dark:text-white text-sm max-w-[200px] truncate">
                      {line.description || '-'}
                    </div>
                    {line.counterparty && (
                      <div className="text-xs text-gray-400 truncate">
                        {line.counterparty}
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-2.5 text-xs text-gray-500 dark:text-gray-400 font-mono hidden md:table-cell">
                    {line.reference || line.transaction_identifier || '-'}
                  </td>
                  <td
                    className={`px-3 py-2.5 text-right font-semibold whitespace-nowrap ${
                      line.amount >= 0
                        ? 'text-green-600 dark:text-green-400'
                        : 'text-red-600 dark:text-red-400'
                    }`}
                  >
                    {line.amount >= 0 ? '+' : ''}{formatCurrency(line.amount)}
                  </td>
                  <td className="px-3 py-2.5 text-right text-gray-500 dark:text-gray-400 text-xs font-mono hidden lg:table-cell">
                    {line.balance_after != null ? formatCurrency(line.balance_after) : '-'}
                  </td>
                  <td className="px-3 py-2.5 text-center">
                    <span
                      className={`px-2 py-0.5 rounded-full text-[10px] font-bold whitespace-nowrap ${
                        STATUS_STYLES[line.reconciliation_status] || 'bg-gray-100 text-gray-700'
                      }`}
                    >
                      {formatStatus(line.reconciliation_status)}
                    </span>
                  </td>
                  <td className="px-3 py-2.5 text-center hidden xl:table-cell">
                    {line.match_method ? (
                      <span className="text-[10px] text-gray-400 dark:text-gray-500">
                        {MATCH_METHOD_LABELS[line.match_method] || line.match_method}
                      </span>
                    ) : line.exclusion_reason ? (
                      <span className="text-[10px] text-gray-400 dark:text-gray-500" title={line.exclusion_reason}>
                        Excluded
                      </span>
                    ) : (
                      <span className="text-[10px] text-gray-300 dark:text-gray-600">-</span>
                    )}
                  </td>
                  <td className="px-3 py-2.5 text-center">
                    <div className="flex items-center justify-center gap-1">
                      {line.reconciliation_status === 'UNRECONCILED' && (
                        <>
                          <button
                            onClick={(e) => { e.stopPropagation(); handleExclude(line.id); }}
                            className="p-1 text-gray-400 hover:text-red-500 dark:hover:text-red-400 rounded transition-colors"
                            title="Exclude line"
                          >
                            <Ban className="w-3.5 h-3.5" />
                          </button>
                        </>
                      )}
                      {(line.reconciliation_status === 'MATCHED' || line.reconciliation_status === 'MANUAL_MATCH') && (
                        <button
                          onClick={(e) => { e.stopPropagation(); handleUnmatch(line.id); }}
                          className="p-1 text-gray-400 hover:text-orange-500 dark:hover:text-orange-400 rounded transition-colors"
                          title="Unmatch"
                        >
                          <Unlink className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}

              {lines.length === 0 && (
                <tr>
                  <td colSpan={9} className="px-4 py-12 text-center text-gray-400 dark:text-gray-500">
                    No statement lines found.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Reason Modal for Exclusion */}
      <ReasonModal
        open={reasonState.open}
        title={reasonState.title}
        description="Provide a reason for excluding this statement line. This action can be undone by unmatching."
        onConfirm={handleExcludeConfirm}
        onCancel={() => setReasonState({ open: false, title: '', action: '', id: '' })}
      />
    </div>
  );
}