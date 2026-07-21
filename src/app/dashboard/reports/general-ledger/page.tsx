'use client';

import { useState, useEffect } from 'react';
import { List, Search } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { useAccounts } from '@/hooks/useAccounts'; 
import type { PostableAccount } from '@/types/accounting.types';

interface GLEntry {
  transaction_date: string;
  journal_reference: string;
  journal_description: string;
  line_description: string | null;
  account_code: string;
  account_name: string;
  debit_amount: number;
  credit_amount: number;
  running_balance: number;
}

export default function GeneralLedgerPage() {
  
  const { accounts, loading: loadingAccounts } = useAccounts();
  
  const [selectedAccountId, setSelectedAccountId] = useState<string>('');
  const [ledgerData, setLedgerData] = useState<GLEntry[]>([]);
  const [loading, setLoading] = useState(false);

  // Fetch Ledger data when account is selected
  useEffect(() => {
    if (!selectedAccountId) {
      setLedgerData([]);
      return;
    }

    const fetchLedger = async () => {
      setLoading(true);
      const { data, error } = await supabase
        .from('general_ledger')
        .select('*')
        .eq('account_id', selectedAccountId)
        .order('transaction_date', { ascending: true });

      if (!error && data) {
        setLedgerData(data as GLEntry[]);
      } else if (error) {
        console.error('GL Error:', error);
      }
      setLoading(false);
    };

    fetchLedger();
  }, [selectedAccountId]);

  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat('en-PK', {
      style: 'currency',
      currency: 'PKR',
      minimumFractionDigits: 2,
    }).format(amount);
  };

  const selectedAccount = accounts.find((a) => a.id === selectedAccountId);

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <List className="w-6 h-6 text-gray-500 dark:text-gray-400" />
          <div>
            <h1 className="text-2xl font-bold text-gray-900 dark:text-white">General Ledger</h1>
            <p className="text-sm text-gray-500 dark:text-gray-400">View detailed transactions for a specific account</p>
          </div>
        </div>
      </div>

      <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-4 mb-6 shadow-sm">
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
          Select Account to View Ledger
        </label>
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
          <select
            value={selectedAccountId}
            onChange={(e) => setSelectedAccountId(e.target.value)}
            className="w-full pl-10 pr-4 py-2.5 border border-gray-300 dark:border-gray-600 rounded-lg text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
            disabled={loadingAccounts} 
          >
            <option value="">{loadingAccounts ? "Loading accounts..." : "-- Choose an Account --"}</option>
            {accounts.map((acc) => (
              <option key={acc.id} value={acc.id}>
                {acc.code} - {acc.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      {selectedAccount && (
        <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl overflow-hidden shadow-sm">
          <div className="p-4 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-750">
            <h2 className="font-semibold text-gray-900 dark:text-white">
              {selectedAccount.code} - {selectedAccount.name}
            </h2>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
              Type: {selectedAccount.account_type.replace(/_/g, ' ')} | Normal Balance: {selectedAccount.normal_balance}
            </p>
          </div>

          {loading ? (
            <div className="p-10 text-center text-gray-400 dark:text-gray-500">Fetching ledger entries...</div>
          ) : ledgerData.length === 0 ? (
            <div className="p-10 text-center text-gray-400 dark:text-gray-500">
              No posted transactions found for this account.
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-gray-50 dark:bg-gray-700/50 text-left text-xs uppercase text-gray-500 dark:text-gray-400">
                <tr>
                  <th className="px-4 py-3">Date</th>
                  <th className="px-4 py-3">Ref</th>
                  <th className="px-4 py-3">Description</th>
                  <th className="px-4 py-3 text-right">Debit</th>
                  <th className="px-4 py-3 text-right">Credit</th>
                  <th className="px-4 py-3 text-right">Balance</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                {ledgerData.map((entry, index) => (
                  <tr key={index} className="hover:bg-gray-50 dark:hover:bg-gray-700/30 transition-colors">
                    <td className="px-4 py-3 text-gray-600 dark:text-gray-300 whitespace-nowrap">
                      {new Date(entry.transaction_date).toLocaleDateString('en-PK')}
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-blue-600 dark:text-blue-400">
                      {entry.journal_reference}
                    </td>
                    <td className="px-4 py-3 text-gray-900 dark:text-white">
                      <div className="font-medium">{entry.journal_description}</div>
                      {entry.line_description && (
                        <div className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">→ {entry.line_description}</div>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right font-medium text-gray-900 dark:text-white">
                      {entry.debit_amount > 0 ? formatCurrency(entry.debit_amount) : '-'}
                    </td>
                    <td className="px-4 py-3 text-right font-medium text-gray-900 dark:text-white">
                      {entry.credit_amount > 0 ? formatCurrency(entry.credit_amount) : '-'}
                    </td>
                    <td className={`px-4 py-3 text-right font-bold ${
                      entry.running_balance >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'
                    }`}>
                      {formatCurrency(entry.running_balance)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}