'use client';
import { useState, useEffect } from 'react';
import { useSearchParams } from 'next/navigation';
import { useAuth } from '@/context/AuthContext';
import { usePermissions } from "@/context/PermissionContext";
import { useFinancialAccounts, useBankStatements, useStatementLines, useAutoMatch, useManualMatch, useFinalizeReconciliation } from '@/hooks/useBanking';
import ReconciliationTable from '@/components/banking/ReconciliationTable';
import StatementImport from '@/components/banking/StatementImport';
import { FileText, Sparkles, ChevronLeft, Loader2, CheckCircle, Clock, AlertTriangle } from 'lucide-react';

const STATUS_STYLES: Record<string, string> = {
  PENDING: 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300',
  IN_PROGRESS: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400',
  PARTIAL: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
  COMPLETED: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400',
};

const formatStatus = (s: string) => s?.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
const formatCurrency = (n: number, c: string = 'PKR') => new Intl.NumberFormat('en-PK', { style: 'currency', currency: c, minimumFractionDigits: 0 }).format(n || 0);

export default function StatementsPage() {
  const { user } = useAuth();
  const { hasPermission, isLoading: permLoading } = usePermissions();
  const searchParams = useSearchParams();

  const [selectedAccountId, setSelectedAccountId] = useState<string | null>(null);
  const [selectedStatementId, setSelectedStatementId] = useState<string | null>(null);
  const [showImport, setShowImport] = useState(false);
  const [suggestions, setSuggestions] = useState<any[]>([]);

  const { data: accounts } = useFinancialAccounts();
  const { data: statements, isLoading: loadingStmts, refetch: refetchStmts } = useBankStatements(selectedAccountId || '');
  const { data: lines, isLoading: loadingLines } = useStatementLines(selectedStatementId || '');
  const autoMatch = useAutoMatch();
  const manualMatch = useManualMatch();
  const finalize = useFinalizeReconciliation();

  // Auto-select account from URL param
  useEffect(() => {
    const accId = searchParams.get('account');
    if (accId) setSelectedAccountId(accId);
  }, [searchParams]);

  // Permission guard
  if (permLoading) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
      </div>
    );
  }

  if (!hasPermission('BANK_READ')) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <p className="text-gray-500 dark:text-gray-400">Access Denied</p>
      </div>
    );
  }

  const selectedAccount = accounts?.find((a: any) => a.id === selectedAccountId);
  const selectedStatement = statements?.find((s: any) => s.id === selectedStatementId);

  const handleAutoMatch = () => {
    if (!selectedStatementId) return;
    autoMatch.mutate(selectedStatementId, {
      onSuccess: (data) => {
        setSuggestions((data as any[]) || []);
        alert(`${Array.isArray(data) ? data.length : 0} match suggestions generated. Nothing was posted or matched automatically.`);
      },
      onError: (e: any) => alert('Suggestion failed: ' + e.message),
    });
  };

  const confirmSuggestion = (row: any) => {
    manualMatch.mutate({ lineId: row.line_id, journalLineId: row.journal_line_id, reason: 'User confirmed automatic reconciliation suggestion' }, {
      onSuccess: () => setSuggestions(prev => prev.filter(x => x.line_id !== row.line_id)),
      onError: (e: any) => alert('Match failed: ' + e.message),
    });
  };

  const handleFinalize = () => {
    if (!selectedStatementId) return;
    if (!confirm('Finalize this reconciliation? All remaining unresolved lines must be matched, excluded, or duplicate first.')) return;
    finalize.mutate(selectedStatementId, { onSuccess: () => alert('Reconciliation finalized.'), onError: (e: any) => alert('Finalize failed: ' + e.message) });
  };

  const handleImportSuccess = () => {
    refetchStmts();
    setShowImport(false);
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white flex items-center gap-2">
            <FileText className="w-7 h-7 text-blue-600" /> Bank Reconciliation
          </h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
            Import statements, match transactions, and reconcile accounts
          </p>
        </div>
      </div>

      <div className="flex gap-5 h-[calc(100vh-200px)] min-h-[500px]">
        {/* ===== LEFT SIDEBAR: Accounts & Statements ===== */}
        <div className="w-72 bg-white dark:bg-gray-800 border dark:border-gray-700 rounded-xl overflow-hidden flex flex-col shrink-0">
          {/* Breadcrumb */}
          <div className="p-3 border-b dark:border-gray-700 text-xs">
            {!selectedAccountId && <span className="text-gray-500 dark:text-gray-400">Select Account</span>}
            {selectedAccountId && !selectedStatementId && (
              <button onClick={() => setSelectedAccountId(null)} className="flex items-center text-blue-600 dark:text-blue-400 hover:underline">
                <ChevronLeft className="w-3 h-3 mr-1" /> Back to Accounts
              </button>
            )}
            {selectedAccountId && selectedStatementId && (
              <button onClick={() => setSelectedStatementId(null)} className="flex items-center text-blue-600 dark:text-blue-400 hover:underline">
                <ChevronLeft className="w-3 h-3 mr-1" /> Back to Statements
              </button>
            )}
          </div>

          {/* Scrollable content */}
          <div className="flex-1 overflow-y-auto p-3">
            {/* Account List */}
            {!selectedAccountId && (
              <div className="space-y-1">
                {accounts?.map((acc: any) => (
                  <div
                    key={acc.id}
                    onClick={() => setSelectedAccountId(acc.id)}
                    className="p-2.5 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-700/50 cursor-pointer border border-transparent hover:border-gray-200 dark:hover:border-gray-600 transition-colors"
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-medium text-gray-900 dark:text-white truncate">{acc.account_name}</span>
                      <span className="text-[10px] font-mono bg-gray-100 dark:bg-gray-700 px-1.5 py-0.5 rounded text-gray-500">{acc.currency}</span>
                    </div>
                    <p className="text-xs text-gray-400 truncate mt-0.5">{acc.institution_name}</p>
                  </div>
                ))}
              </div>
            )}

            {/* Statements List */}
            {selectedAccountId && !selectedStatementId && (
              <div className="space-y-2">
                {/* Import button */}
                {hasPermission('BANK_CREATE') && (
                  <button
                    onClick={() => setShowImport(true)}
                    className="w-full p-2.5 border-2 border-dashed dark:border-gray-600 rounded-lg text-sm text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/20 transition-colors flex items-center justify-center gap-1.5"
                  >
                    + Import Statement
                  </button>
                )}

                {loadingStmts ? (
                  <div className="flex justify-center py-8"><Loader2 className="w-5 h-5 animate-spin text-gray-400" /></div>
                ) : !statements?.length ? (
                  <div className="text-center py-8 text-gray-400 text-sm">
                    <FileText className="w-8 h-8 mx-auto mb-2 opacity-30" />
                    No statements imported yet
                  </div>
                ) : (
                  statements.map((stmt: any) => (
                    <div
                      key={stmt.id}
                      onClick={() => setSelectedStatementId(stmt.id)}
                      className={`p-3 rounded-lg border cursor-pointer transition-colors ${
                        stmt.reconciliation_status === 'COMPLETED'
                          ? 'bg-green-50 dark:bg-green-900/20 border-green-200 dark:border-green-800/30'
                          : 'border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-700/50'
                      }`}
                    >
                      <div className="flex items-center justify-between">
                        <span className="text-sm font-medium text-gray-900 dark:text-white">{stmt.statement_date}</span>
                        <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${STATUS_STYLES[stmt.reconciliation_status] || ''}`}>
                          {formatStatus(stmt.reconciliation_status)}
                        </span>
                      </div>
                      <div className="flex items-center justify-between text-xs text-gray-500 dark:text-gray-400 mt-1">
                        <span>{stmt.line_count} lines</span>
                        <span>Closing: {formatCurrency(stmt.closing_balance, stmt.currency)}</span>
                      </div>
                      {stmt.file_name && (
                        <p className="text-[10px] text-gray-400 mt-1 truncate">📎 {stmt.file_name}</p>
                      )}
                    </div>
                  ))
                )}
              </div>
            )}
          </div>

          {/* Selected statement info */}
          {selectedStatementId && selectedStatement && (
            <div className="p-3 border-t dark:border-gray-700 bg-gray-50 dark:bg-gray-900/50 space-y-1.5">
              <div className="flex justify-between text-xs">
                <span className="text-gray-500 dark:text-gray-400">Statement</span>
                <span className="font-medium text-gray-900 dark:text-white">{selectedStatement.statement_date}</span>
              </div>
              <div className="flex justify-between text-xs">
                <span className="text-gray-500 dark:text-gray-400">Opening</span>
                <span className="text-gray-900 dark:text-white">{formatCurrency(selectedStatement.opening_balance, selectedStatement.currency)}</span>
              </div>
              <div className="flex justify-between text-xs">
                <span className="text-gray-500 dark:text-gray-400">Closing</span>
                <span className="text-gray-900 dark:text-white">{formatCurrency(selectedStatement.closing_balance, selectedStatement.currency)}</span>
              </div>
              <div className="flex justify-between text-xs">
                <span className="text-gray-500 dark:text-gray-400">Debits</span>
                <span className="text-green-600 dark:text-green-400">{formatCurrency(selectedStatement.total_debits)}</span>
              </div>
              <div className="flex justify-between text-xs">
                <span className="text-gray-500 dark:text-gray-400">Credits</span>
                <span className="text-red-600 dark:text-red-400">{formatCurrency(selectedStatement.total_credits)}</span>
              </div>
            </div>
          )}
        </div>

        {/* ===== MAIN CONTENT ===== */}
        <div className="flex-1 flex flex-col min-w-0">
          {/* Import panel */}
          {showImport && selectedAccountId && selectedAccount && (
            <StatementImport
              accountId={selectedAccountId}
              currency={selectedAccount.currency}
              onSuccess={handleImportSuccess}
            />
          )}

          {/* Statement lines table */}
          {selectedStatementId && !showImport && (
            <>
              {/* Toolbar */}
              <div className="flex justify-between items-center mb-4">
                <div className="flex items-center gap-2">
                  <h2 className="text-lg font-bold text-gray-900 dark:text-white">Statement Lines</h2>
                  {selectedStatement && (
                    <span className={`text-xs px-2.5 py-0.5 rounded-full font-bold ${STATUS_STYLES[selectedStatement.reconciliation_status] || ''}`}>
                      {formatStatus(selectedStatement.reconciliation_status)}
                    </span>
                  )}
                </div>
                {hasPermission('BANK_CREATE') && (
                  <button
                    onClick={handleAutoMatch}
                    disabled={autoMatch.isPending}
                    className="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2 rounded-lg text-sm font-medium disabled:opacity-50 transition-colors"
                  >
                    {autoMatch.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
                    Suggest Matches
                  </button>
                )}
                {hasPermission('BANK_RECONCILE') && selectedStatement && selectedStatement.reconciliation_status !== 'COMPLETED' && (
                  <button onClick={handleFinalize} disabled={finalize.isPending} className="flex items-center gap-2 bg-green-600 hover:bg-green-700 text-white px-4 py-2 rounded-lg text-sm font-medium disabled:opacity-50">
                    <CheckCircle className="w-4 h-4" /> {finalize.isPending ? 'Finalizing...' : 'Finalize'}
                  </button>
                )}
              </div>
              {suggestions.length > 0 && (
                <div className="mb-4 bg-indigo-50 dark:bg-indigo-900/20 border border-indigo-200 dark:border-indigo-800/40 rounded-xl p-4">
                  <div className="flex items-center justify-between mb-3">
                    <div><h3 className="font-semibold text-indigo-900 dark:text-indigo-200">Match Suggestions</h3><p className="text-xs text-indigo-700 dark:text-indigo-300">Suggestions never change the ledger until you confirm them.</p></div>
                    <button onClick={() => setSuggestions([])} className="text-xs text-gray-500 hover:underline">Dismiss</button>
                  </div>
                  <div className="space-y-2 max-h-48 overflow-auto">
                    {suggestions.map((row:any) => (
                      <div key={row.line_id} className="flex items-center justify-between gap-3 bg-white dark:bg-gray-800 rounded-lg p-2.5 border dark:border-gray-700">
                        <div className="min-w-0 text-xs"><div className="font-medium truncate">{row.journal_description || 'Journal line'} · {row.journal_date}</div><div className="text-gray-500">{row.match_method} · {Math.round(Number(row.confidence || 0)*100)}% confidence · {row.journal_amount}</div></div>
                        <button onClick={() => confirmSuggestion(row)} disabled={manualMatch.isPending} className="shrink-0 px-3 py-1.5 rounded-md bg-indigo-600 text-white text-xs disabled:opacity-50">Confirm</button>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div className="flex-1 overflow-hidden">
                {loadingLines ? (
                  <div className="flex items-center justify-center h-full"><Loader2 className="w-6 h-6 animate-spin text-gray-400" /></div>
                ) : (
                  <ReconciliationTable
                    lines={lines || []}
                    statementId={selectedStatementId}
                    currency={selectedAccount?.currency}
                  />
                )}
              </div>
            </>
          )}

          {/* Empty state */}
          {!selectedStatementId && !showImport && (
            <div className="flex-1 flex items-center justify-center text-gray-400 dark:text-gray-500">
              <div className="text-center">
                <FileText className="w-16 h-16 mx-auto mb-4 opacity-20" />
                <p className="text-lg font-medium">Select an account and statement</p>
                <p className="text-sm mt-1">to start reconciliation</p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}