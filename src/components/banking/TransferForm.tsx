'use client';

import { useState, useEffect } from 'react';
import { useFinancialAccounts, useCreateTransfer } from '@/hooks/useBanking';
import { Loader2, X } from 'lucide-react';

interface TransferFormProps {
  isOpen: boolean;
  onClose: () => void;
}

export default function TransferForm({ isOpen, onClose }: TransferFormProps) {
  const { data: accounts } = useFinancialAccounts();
  const createTransfer = useCreateTransfer();

  const [form, setForm] = useState({
    from_account_id: '',
    to_account_id: '',
    from_amount: '',
    to_amount: '',
    exchange_rate: '1.000000',
    transfer_date: new Date().toISOString().split('T')[0],
  });

  // Jab same currency ho toh rate auto 1 ho
  useEffect(() => {
    const fromAcc = accounts?.find((a: any) => a.id === form.from_account_id);
    const toAcc = accounts?.find((a: any) => a.id === form.to_account_id);

    if (fromAcc && toAcc && fromAcc.currency === toAcc.currency) {
      setForm((prev) => ({ ...prev, exchange_rate: '1.000000', to_amount: prev.from_amount }));
    }
  }, [form.from_account_id, form.to_account_id, accounts]);

  // From amount change -> To amount calculate
  useEffect(() => {
    const rate = parseFloat(form.exchange_rate) || 1;
    const fromAmt = parseFloat(form.from_amount) || 0;
    const fromAcc = accounts?.find((a: any) => a.id === form.from_account_id);
    const toAcc = accounts?.find((a: any) => a.id === form.to_account_id);

    if (fromAcc && toAcc && fromAcc.currency !== toAcc.currency) {
      setForm((prev) => ({ ...prev, to_amount: (fromAmt * rate).toFixed(2) }));
    }
  }, [form.from_amount, form.exchange_rate, form.from_account_id, form.to_account_id, accounts]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (form.from_account_id === form.to_account_id) {
      alert('From and To accounts cannot be the same!');
      return;
    }

    const fromAcc = accounts?.find((a: any) => a.id === form.from_account_id);
    const toAcc = accounts?.find((a: any) => a.id === form.to_account_id);

    createTransfer.mutate(
      {
        ...form,
        from_amount: parseFloat(form.from_amount),
        to_amount: parseFloat(form.to_amount),
        from_currency: fromAcc?.currency || 'PKR',
        to_currency: toAcc?.currency || 'PKR',
        exchange_rate: parseFloat(form.exchange_rate),
      },
      {
        onSuccess: () => {
          onClose();
          setForm({
            from_account_id: '',
            to_account_id: '',
            from_amount: '',
            to_amount: '',
            exchange_rate: '1.000000',
            transfer_date: new Date().toISOString().split('T')[0],
          });
        },
      }
    );
  };

  if (!isOpen) return null;

  const fromAcc = accounts?.find((a: any) => a.id === form.from_account_id);
  const toAcc = accounts?.find((a: any) => a.id === form.to_account_id);

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
        {/* Header */}
        <div className="flex items-center justify-between p-5 border-b">
          <h2 className="text-lg font-bold text-gray-900">New Bank Transfer</h2>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-400">
            <X size={20} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-5 space-y-4">
          {/* From Account */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">From Account</label>
            <select
              required
              value={form.from_account_id}
              onChange={(e) => setForm({ ...form, from_account_id: e.target.value })}
              className="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
            >
              <option value="">Select source account...</option>
              {accounts?.map((acc: any) => (
                <option key={acc.id} value={acc.id}>
                  {acc.account_name} ({acc.currency}) — {acc.institution_name}
                </option>
              ))}
            </select>
          </div>

          {/* To Account */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">To Account</label>
            <select
              required
              value={form.to_account_id}
              onChange={(e) => setForm({ ...form, to_account_id: e.target.value })}
              className="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
            >
              <option value="">Select destination account...</option>
              {accounts?.map((acc: any) => (
                <option key={acc.id} value={acc.id}>
                  {acc.account_name} ({acc.currency}) — {acc.institution_name}
                </option>
              ))}
            </select>
          </div>

          {/* Amounts Row */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Amount ({fromAcc?.currency || '---'})
              </label>
              <input
                type="number"
                step="0.01"
                required
                value={form.from_amount}
                onChange={(e) => setForm({ ...form, from_amount: e.target.value })}
                className="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
                placeholder="0.00"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Amount ({toAcc?.currency || '---'})
              </label>
              <input
                type="number"
                step="0.01"
                required
                value={form.to_amount}
                onChange={(e) => setForm({ ...form, to_amount: e.target.value })}
                className="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
                placeholder="0.00"
              />
            </div>
          </div>

          {/* FX Rate (only show if different currencies) */}
          {fromAcc && toAcc && fromAcc.currency !== toAcc.currency && (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Exchange Rate (1 {fromAcc.currency} = ? {toAcc.currency})
              </label>
              <input
                type="number"
                step="0.000001"
                value={form.exchange_rate}
                onChange={(e) => setForm({ ...form, exchange_rate: e.target.value })}
                className="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
              />
            </div>
          )}

          {/* Date */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Transfer Date</label>
            <input
              type="date"
              required
              value={form.transfer_date}
              onChange={(e) => setForm({ ...form, transfer_date: e.target.value })}
              className="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
            />
          </div>

          {/* Actions */}
          <div className="flex justify-end gap-3 pt-3 border-t">
            <button
              type="button"
              onClick={onClose}
              className="px-5 py-2.5 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={createTransfer.isPending}
              className="px-5 py-2.5 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 disabled:opacity-50 flex items-center gap-2"
            >
              {createTransfer.isPending ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" /> Saving...
                </>
              ) : (
                'Create Transfer'
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}