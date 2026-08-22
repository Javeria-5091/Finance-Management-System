'use client';
import { useState } from 'react';
import { useAuth } from '@/context/AuthContext';
import { usePermissions } from "@/context/PermissionContext";
import { useFinancialAccounts, useReconciliationSummary, useAssetAccounts, useCreateAccount } from '@/hooks/useBanking';
import AccountCard from '@/components/banking/AccountCard';
import ReasonModal from '@/components/finance/ReasonModal';
import { Plus, Building2, Loader2, X, Pencil, Trash2 } from 'lucide-react';

const INSTITUTION_TYPES = [
  { value: 'BANK', label: 'Bank Account' },
  { value: 'CASH', label: 'Cash / Petty Cash' },
  { value: 'WALLET', label: 'Mobile Wallet' },
  { value: 'PLATFORM', label: 'Platform Balance' },
  { value: 'PAYMENT_GATEWAY', label: 'Payment Gateway' },
  { value: 'CARD', label: 'Card' },
  { value: 'CLEARING', label: 'Clearing Account' },
];

const ACCOUNT_TYPES = {
  BANK: ['CURRENT', 'SAVINGS'] as const,
  CASH: ['PETTY_CASH'] as const,
  WALLET: ['DIGITAL_WALLET'] as const,
  PLATFORM: ['PLATFORM_BALANCE'] as const,
  PAYMENT_GATEWAY: ['DIGITAL_WALLET'] as const,
  CARD: ['DIGITAL_WALLET'] as const,
  CLEARING: ['CLEARING'] as const,
};

const RECON_METHODS = [
  { value: 'MANUAL', label: 'Manual' },
  { value: 'IMPORT', label: 'CSV Import' },
  { value: 'AUTO', label: 'Auto (Future)' },
];

const CURRENCIES = ['PKR', 'USD', 'EUR', 'GBP', 'AED'];

const formatCurrency = (amount: number, currency: string = 'PKR') =>
  new Intl.NumberFormat('en-PK', { style: 'currency', currency, minimumFractionDigits: 0 }).format(amount || 0);

const EMPTY_FORM = {
  account_name: '',
  institution_name: '',
  institution_type: 'BANK' as const,
  account_type: 'CURRENT' as 'CURRENT' | 'SAVINGS' | 'PETTY_CASH' | 'DIGITAL_WALLET' | 'PLATFORM_BALANCE' | 'CLEARING', 
  currency: 'PKR',
  masked_identifier: '',
  opening_balance: '0',
  opening_date: new Date().toISOString().split('T')[0],
  linked_ledger_account_id: '',
  reconciliation_method: 'MANUAL' as const,
  requires_dual_approval: false,
  min_dual_approval_amount: '',
  is_default: false,
  notes: '',
};

export default function AccountsPage() {
  const { user } = useAuth();
  const { hasPermission, isLoading: permLoading } = usePermissions();
  const { data: summaries, isLoading: loadingSummary } = useReconciliationSummary();
  const { data: accounts, isLoading: loadingAccounts } = useFinancialAccounts();
  const { data: assetAccounts } = useAssetAccounts();
  const createAccount = useCreateAccount();

  const [showModal, setShowModal] = useState(false);
  const [form, setForm] = useState({ ...EMPTY_FORM });
  const [reasonState, setReasonState] = useState({ open: false, title: '', action: '', id: '' });

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

  const isLoading = loadingSummary || loadingAccounts;

  const set = (field: string, value: any) => {
  setForm((prev) => {
    const next = { ...prev, [field]: value };
    if (field === 'institution_type') {
      //  "as keyof typeof ACCOUNT_TYPES" lagao
      const types = ACCOUNT_TYPES[value as keyof typeof ACCOUNT_TYPES] || ['CURRENT' as const];
      next.account_type = types[0];
    }
    return next;
  });
};

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.account_name.trim() || !form.institution_name.trim() || !form.linked_ledger_account_id) {
      alert('Account name, institution name, and linked ledger account are required.');
      return;
    }

    createAccount.mutate(
      {
        account_name: form.account_name.trim(),
        institution_name: form.institution_name.trim(),
        institution_type: form.institution_type,
        account_type: form.account_type,
        currency: form.currency,
        masked_identifier: form.masked_identifier.trim() || null,
        opening_balance: parseFloat(form.opening_balance) || 0,
        opening_date: form.opening_date || null,
        linked_ledger_account_id: form.linked_ledger_account_id,
        reconciliation_method: form.reconciliation_method,
        requires_dual_approval: form.requires_dual_approval,
        min_dual_approval_amount: form.min_dual_approval_amount ? parseFloat(form.min_dual_approval_amount) : null,
        is_default: form.is_default,
        notes: form.notes.trim() || null,
      },
      {
        onSuccess: () => {
          setShowModal(false);
          setForm({ ...EMPTY_FORM });
        },
      }
    );
  };

  const inputCls = 'w-full px-3 py-2.5 border dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm outline-none focus:ring-2 focus:ring-blue-500';
  const labelCls = 'block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1';

  // Aggregate stats
  const pkrBalance = summaries?.filter((s) => s.currency === 'PKR').reduce((sum, s) => sum + s.ledger_balance, 0) || 0;
  const usdBalance = summaries?.filter((s) => s.currency === 'USD').reduce((sum, s) => sum + s.ledger_balance, 0) || 0;
  const needRecon = summaries?.filter((s) => Math.abs(s.difference) > 0.01).length || 0;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white flex items-center gap-2">
            <Building2 className="w-7 h-7 text-blue-600" /> Financial Accounts
          </h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
            Manage bank accounts, wallets, and platform balances with reconciliation status
          </p>
        </div>
        {hasPermission('BANK_CREATE') && (
          <button
            onClick={() => setShowModal(true)}
            className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-4 py-2.5 rounded-lg text-sm font-medium shadow-sm transition-colors"
          >
            <Plus size={16} /> Add Account
          </button>
        )}
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <div className="bg-white dark:bg-gray-800 border dark:border-gray-700 rounded-xl p-4">
          <p className="text-[10px] uppercase tracking-wider text-gray-400 dark:text-gray-500">Total Accounts</p>
          <p className="text-2xl font-bold text-gray-900 dark:text-white mt-1">{summaries?.length || 0}</p>
        </div>
        <div className="bg-white dark:bg-gray-800 border dark:border-gray-700 rounded-xl p-4">
          <p className="text-[10px] uppercase tracking-wider text-gray-400 dark:text-gray-500">PKR Balance</p>
          <p className="text-2xl font-bold text-green-600 dark:text-green-400 mt-1">{formatCurrency(pkrBalance)}</p>
        </div>
        <div className="bg-white dark:bg-gray-800 border dark:border-gray-700 rounded-xl p-4">
          <p className="text-[10px] uppercase tracking-wider text-gray-400 dark:text-gray-500">USD Balance</p>
          <p className="text-2xl font-bold text-blue-600 dark:text-blue-400 mt-1">{formatCurrency(usdBalance, 'USD')}</p>
        </div>
        <div className="bg-white dark:bg-gray-800 border dark:border-gray-700 rounded-xl p-4">
          <p className="text-[10px] uppercase tracking-wider text-gray-400 dark:text-gray-500">Need Reconciliation</p>
          <p className="text-2xl font-bold text-orange-500 mt-1">{needRecon}</p>
        </div>
      </div>

      {/* Account Cards Grid */}
      {isLoading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="w-8 h-8 animate-spin text-gray-400" />
        </div>
      ) : !summaries?.length ? (
        <div className="bg-white dark:bg-gray-800 border dark:border-gray-700 rounded-xl p-16 text-center">
          <Building2 className="w-12 h-12 mx-auto mb-3 text-gray-300 dark:text-gray-600" />
          <p className="font-medium text-gray-500 dark:text-gray-400">No financial accounts yet</p>
          <p className="text-sm text-gray-400 dark:text-gray-500 mt-1">Click &quot;Add Account&quot; to set up your first account</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {summaries.map((acct) => (
            <AccountCard
              key={acct.financial_account_id}
              account={acct}
              onClick={() => {
                // TODO: Navigate to statements for this account
                window.location.href = `/banking/statements?account=${acct.financial_account_id}`;
              }}
            />
          ))}
        </div>
      )}

      {/* ==================== ADD ACCOUNT MODAL ==================== */}
      {showModal && (
        <div
          className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4"
          onClick={(e) => { if (e.target === e.currentTarget) setShowModal(false); }}
        >
          <form
            onSubmit={handleSubmit}
            className="bg-white dark:bg-gray-800 border dark:border-gray-700 rounded-2xl w-full max-w-2xl shadow-2xl max-h-[85vh] flex flex-col"
          >
            <div className="p-5 border-b dark:border-gray-700 flex justify-between items-center shrink-0">
              <h2 className="text-lg font-bold text-gray-900 dark:text-white">Add Financial Account</h2>
              <button type="button" onClick={() => setShowModal(false)} className="p-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-500">
                <X size={20} />
              </button>
            </div>

            <div className="p-5 space-y-4 overflow-y-auto flex-1">
              {/* Name + Institution */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className={labelCls}>Account Name <span className="text-red-500">*</span></label>
                  <input type="text" required value={form.account_name} onChange={(e) => set('account_name', e.target.value)} className={inputCls} placeholder="e.g., HBL Current Account" />
                </div>
                <div>
                  <label className={labelCls}>Institution Name <span className="text-red-500">*</span></label>
                  <input type="text" required value={form.institution_name} onChange={(e) => set('institution_name', e.target.value)} className={inputCls} placeholder="e.g., HBL, Meezan, JazzCash" />
                </div>
              </div>

              {/* Type + Account Type */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className={labelCls}>Institution Type</label>
                  <select value={form.institution_type} onChange={(e) => set('institution_type', e.target.value)} className={inputCls}>
                    {INSTITUTION_TYPES.map((t) => (
                      <option key={t.value} value={t.value}>{t.label}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className={labelCls}>Account Type</label>
                  <select value={form.account_type} onChange={(e) => set('account_type', e.target.value)} className={inputCls}>
                    {(ACCOUNT_TYPES[form.institution_type] || ['CURRENT']).map((t) => (
                      <option key={t} value={t}>{t.replace(/_/g, ' ')}</option>
                    ))}
                  </select>
                </div>
              </div>

              {/* Currency + Masked ID */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className={labelCls}>Currency</label>
                  <select value={form.currency} onChange={(e) => set('currency', e.target.value)} className={inputCls}>
                    {CURRENCIES.map((c) => (
                      <option key={c} value={c}>{c}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className={labelCls}>Masked Identifier</label>
                  <input type="text" value={form.masked_identifier} onChange={(e) => set('masked_identifier', e.target.value)} className={`${inputCls} font-mono`} placeholder="e.g., ****1234" />
                </div>
              </div>

              {/* Ledger Account — CRITICAL: must be Asset (1xxx) */}
              <div>
                <label className={labelCls}>Linked Ledger Account <span className="text-red-500">*</span></label>
                <select value={form.linked_ledger_account_id} onChange={(e) => set('linked_ledger_account_id', e.target.value)} className={inputCls} required>
                  <option value="">Select Asset Account (1xxx)...</option>
                  {assetAccounts?.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.code} — {a.name}
                    </option>
                  ))}
                </select>
                <p className="text-[10px] text-gray-400 mt-1">Must be an Asset account (code starts with 1). This is where transactions post to the ledger.</p>
              </div>

              {/* Opening Balance + Date */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className={labelCls}>Opening Balance</label>
                  <input type="number" step="0.01" value={form.opening_balance} onChange={(e) => set('opening_balance', e.target.value)} className={`${inputCls} text-right`} />
                </div>
                <div>
                  <label className={labelCls}>Opening Date</label>
                  <input type="date" value={form.opening_date} onChange={(e) => set('opening_date', e.target.value)} className={inputCls} />
                </div>
              </div>

              {/* Reconciliation Method */}
              <div>
                <label className={labelCls}>Reconciliation Method</label>
                <select value={form.reconciliation_method} onChange={(e) => set('reconciliation_method', e.target.value)} className={inputCls}>
                  {RECON_METHODS.map((m) => (
                    <option key={m.value} value={m.value}>{m.label}</option>
                  ))}
                </select>
              </div>

              {/* Dual Approval + Default */}
              <div className="flex flex-wrap gap-6">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={form.requires_dual_approval}
                    onChange={(e) => set('requires_dual_approval', e.target.checked)}
                    className="w-4 h-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                  />
                  <span className="text-sm text-gray-700 dark:text-gray-300">Requires Dual Approval</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={form.is_default}
                    onChange={(e) => set('is_default', e.target.checked)}
                    className="w-4 h-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                  />
                  <span className="text-sm text-gray-700 dark:text-gray-300">Default for {form.currency}</span>
                </label>
              </div>

              {form.requires_dual_approval && (
                <div>
                  <label className={labelCls}>Min Dual Approval Amount</label>
                  <input
                    type="number"
                    step="0.01"
                    value={form.min_dual_approval_amount}
                    onChange={(e) => set('min_dual_approval_amount', e.target.value)}
                    className={inputCls}
                    placeholder="e.g., 500000"
                  />
                </div>
              )}

              {/* Notes */}
              <div>
                <label className={labelCls}>Notes</label>
                <textarea value={form.notes} onChange={(e) => set('notes', e.target.value)} className={`${inputCls} resize-none`} rows={2} placeholder="Internal notes..." />
              </div>
            </div>

            <div className="flex justify-end gap-3 p-5 border-t dark:border-gray-700 shrink-0">
              <button type="button" onClick={() => setShowModal(false)} className="px-5 py-2.5 bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 dark:hover:bg-gray-600 text-gray-800 dark:text-white rounded-xl text-sm font-medium">
                Cancel
              </button>
              <button
                type="submit"
                disabled={createAccount.isPending || !form.account_name || !form.institution_name || !form.linked_ledger_account_id}
                className="px-5 py-2.5 bg-blue-600 hover:bg-blue-700 text-white rounded-xl text-sm font-medium disabled:opacity-50 flex items-center gap-2"
              >
                {createAccount.isPending && <Loader2 size={14} className="animate-spin" />}
                Add Account
              </button>
            </div>
          </form>
        </div>
      )}

      <ReasonModal
        open={reasonState.open}
        title={reasonState.title}
        description="Provide a reason for this action."
        onConfirm={(reason:any) => {
          // TODO: Handle deactivate
          setReasonState({ open: false, title: '', action: '', id: '' });
        }}
        onCancel={() => setReasonState({ open: false, title: '', action: '', id: '' })}
      />
    </div>
  );
}