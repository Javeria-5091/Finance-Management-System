'use client';
import { Building2, Wallet, CreditCard, Landmark, Banknote, Layers, Power } from 'lucide-react';
import type { ReconciliationSummary } from '../../services/bank.service';

const getIcon = (type: string) => {
  switch (type) {
    case 'BANK': return <Building2 className="w-7 h-7 text-blue-500" />;
    case 'CASH': return <Banknote className="w-7 h-7 text-yellow-600" />;
    case 'WALLET': return <Wallet className="w-7 h-7 text-green-500" />;
    case 'PLATFORM': return <Landmark className="w-7 h-7 text-orange-500" />;
    case 'PAYMENT_GATEWAY': return <CreditCard className="w-7 h-7 text-purple-500" />;
    case 'CARD': return <Layers className="w-7 h-7 text-pink-500" />;
    default: return <CreditCard className="w-7 h-7 text-gray-500" />;
  }
};

const formatCurrency = (amount: number, currency: string = 'PKR') =>
  new Intl.NumberFormat('en-PK', {
    style: 'currency',
    currency,
    minimumFractionDigits: 0,
  }).format(amount || 0);

export default function AccountCard({
  account,
  onClick,
  onDeactivate,
  canDeactivate = false,
}: {
  account: ReconciliationSummary;
  onClick: () => void;
  onDeactivate?: () => void;
  canDeactivate?: boolean;
}) {
  const hasDiff = Math.abs(account.difference) > 0.01;
  const pctColor =
    account.reconciliation_pct >= 100
      ? 'text-green-600 dark:text-green-400'
      : account.reconciliation_pct >= 70
      ? 'text-yellow-600 dark:text-yellow-400'
      : 'text-red-600 dark:text-red-400';

  return (
    <div
      onClick={onClick}
      className="bg-white dark:bg-gray-800 border dark:border-gray-700 rounded-xl p-4 hover:shadow-lg transition-all cursor-pointer group"
    >
      {/* Top row: icon + name */}
      <div className="flex items-start gap-3 mb-3">
        <div className="p-2.5 bg-gray-50 dark:bg-gray-700 rounded-lg group-hover:scale-105 transition-transform">
          {getIcon(account.institution_name?.includes('HBL') ? 'BANK' : 'BANK')}
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="font-semibold text-gray-900 dark:text-white truncate text-sm">
            {account.account_name}
          </h3>
          <p className="text-xs text-gray-500 dark:text-gray-400 truncate">
            {account.institution_name}
            {account.masked_identifier ? ` • ${account.masked_identifier}` : ''}
          </p>
        </div>
        <span className="text-xs font-mono bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 px-2 py-0.5 rounded">
          {account.currency}
        </span>
        {canDeactivate && onDeactivate && (
          <button
            type="button"
            title="Deactivate account"
            aria-label={`Deactivate ${account.account_name}`}
            onClick={(e) => { e.stopPropagation(); onDeactivate(); }}
            className="p-1.5 rounded-lg text-gray-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
          >
            <Power size={15} />
          </button>
        )}
      </div>

      {/* Balances */}
      <div className="grid grid-cols-2 gap-2 mb-3">
        <div>
          <p className="text-[10px] uppercase tracking-wider text-gray-400 dark:text-gray-500">Ledger</p>
          <p className="text-sm font-bold text-gray-900 dark:text-white">
            {formatCurrency(account.ledger_balance, account.currency)}
          </p>
        </div>
        <div>
          <p className="text-[10px] uppercase tracking-wider text-gray-400 dark:text-gray-500">Statement</p>
          <p className="text-sm font-bold text-gray-900 dark:text-white">
            {formatCurrency(account.statement_balance, account.currency)}
          </p>
        </div>
      </div>

      {/* Difference bar */}
      {hasDiff && (
        <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800/30 rounded-lg px-3 py-1.5 mb-3">
          <p className="text-xs text-red-600 dark:text-red-400 font-medium">
            Difference: {formatCurrency(Math.abs(account.difference), account.currency)}
            {account.difference > 0 ? ' (ledger higher)' : ' (statement higher)'}
          </p>
        </div>
      )}

      {/* Bottom row: reconciliation progress */}
      <div className="flex items-center justify-between">
        <div className="flex-1 mr-3">
          <div className="flex items-center justify-between text-[10px] text-gray-500 dark:text-gray-400 mb-1">
            <span>Reconciled</span>
            <span className={pctColor}>{account.reconciliation_pct}%</span>
          </div>
          <div className="w-full bg-gray-100 dark:bg-gray-700 rounded-full h-1.5">
            <div
              className={`h-1.5 rounded-full transition-all ${
                account.reconciliation_pct >= 100
                  ? 'bg-green-500'
                  : account.reconciliation_pct >= 70
                  ? 'bg-yellow-500'
                  : 'bg-red-500'
              }`}
              style={{ width: `${Math.min(account.reconciliation_pct, 100)}%` }}
            />
          </div>
        </div>
        <div className="text-right">
          <p className="text-[10px] text-gray-400 dark:text-gray-500">
            {account.unreconciled_lines} unmatched
          </p>
          {account.latest_statement_date && (
            <p className="text-[10px] text-gray-400 dark:text-gray-500">
              As of {account.latest_statement_date}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}