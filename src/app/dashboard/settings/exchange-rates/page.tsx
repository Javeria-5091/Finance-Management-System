'use client';

import { ArrowUpDown, Construction } from 'lucide-react';

export default function ExchangeRatesPage() {
  return (
    <div className="p-6 max-w-3xl mx-auto">
      <div className="flex items-center gap-3 mb-6">
        <ArrowUpDown className="w-6 h-6 text-gray-500 dark:text-gray-400" />
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Exchange Rates</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400">Manage multi-currency conversion rates</p>
        </div>
      </div>

      {/* Placeholder UI */}
      <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-8 text-center shadow-sm">
        <div className="w-16 h-16 bg-amber-100 dark:bg-amber-500/20 rounded-full flex items-center justify-center mx-auto mb-4">
          <Construction className="w-8 h-8 text-amber-600 dark:text-amber-400" />
        </div>
        <h2 className="text-xl font-semibold text-gray-900 dark:text-white mb-2">
          Module Under Development
        </h2>
        <p className="text-gray-500 dark:text-gray-400 max-w-md mx-auto mb-6">
          The full Exchange Rates management module (including automated rate fetching, historical rates, and multi-currency ledger adjustments) is scheduled for <strong>Phase 4: AR & Multi-Currency</strong>.
        </p>
        
        <div className="bg-gray-50 dark:bg-gray-700/50 rounded-lg p-4 text-left max-w-sm mx-auto">
          <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2">Current Workaround:</h3>
          <p className="text-xs text-gray-500 dark:text-gray-400">
            Until Phase 4 is implemented, you can manually enter the exchange rate when creating Journal Entries or posting Incomes/Expenses in foreign currency (e.g., USD). The system will automatically calculate the base PKR amount using that manual rate.
          </p>
        </div>
      </div>
    </div>
  );
}