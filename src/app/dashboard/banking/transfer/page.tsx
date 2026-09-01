'use client';
import { useState } from 'react';
import { useAuth } from '@/context/AuthContext';
import { usePermissions } from "@/context/PermissionContext";
import { useBankTransfers, useFinancialAccounts, useCreateTransfer, useUpdateTransferStatus, usePostTransfer, useOpenPeriod, useReverseTransfer } from '@/hooks/useBanking';
import StatusActions from '@/components/finance/StatusActions';
import ReasonModal from '@/components/finance/ReasonModal';
import { Plus, ArrowLeftRight, Loader2, X, ShieldCheck, RotateCcw } from 'lucide-react';
import type { BankTransfer } from '../../../../services/bank.service';

const STATUS_STYLES: Record<string, string> = {
  DRAFT: 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300',
  SUBMITTED: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
  APPROVED: 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400',
  POSTED: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400',
  REVERSED: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
  REJECTED: 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400',
  CANCELLED: 'bg-gray-200 text-gray-500 dark:bg-gray-600 dark:text-gray-400 italic',
};

const PAYMENT_METHODS = [
  { value: 'BANK_TRANSFER', label: 'Bank Transfer' },
  { value: 'CHEQUE', label: 'Cheque' },
  { value: 'CASH', label: 'Cash' },
  { value: 'PLATFORM', label: 'Platform Transfer' },
  { value: 'OTHER', label: 'Other' },
];

const formatCurrency = (amount: number, currency: string = 'PKR') =>
  new Intl.NumberFormat('en-PK', { style: 'currency', currency, minimumFractionDigits: 0 }).format(amount || 0);

const formatStatus = (s: string) => s?.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());

export default function TransfersPage() {
  const { user } = useAuth();
  const { hasPermission, isLoading: permLoading } = usePermissions();
  const { data: transfers, isLoading } = useBankTransfers();
  const { data: accounts } = useFinancialAccounts();
  const { data: openPeriod } = useOpenPeriod();
  const createTransfer = useCreateTransfer();
  const updateStatus = useUpdateTransferStatus();
  const postTransfer = usePostTransfer();
  const reverseTransfer = useReverseTransfer();

  const [showModal, setShowModal] = useState(false);
  const [reasonState, setReasonState] = useState({ open: false, title: '', action: '', id: '' });

  const [form, setForm] = useState({
    from_account_id: '',
    to_account_id: '',
    from_amount: '',
    to_amount: '',
    exchange_rate: '1',
    fx_rate_date: new Date().toISOString().split('T')[0],
    transfer_date: new Date().toISOString().split('T')[0],
    description: '',
    reference: '',
    payment_method: 'BANK_TRANSFER',
  });

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

  const getAccount = (id: string) => accounts?.find((a: any) => a.id === id);
  const getCurrency = (id: string) => getAccount(id)?.currency || 'PKR';

  // Auto-calculate to_amount
  const handleAmountOrRateChange = (field: 'from_amount' | 'exchange_rate', value: string) => {
    const fromAmt = field === 'from_amount' ? parseFloat(value) || 0 : parseFloat(form.from_amount) || 0;
    const rate = field === 'exchange_rate' ? parseFloat(value) || 1 : parseFloat(form.exchange_rate) || 1;
    setForm((prev) => ({
      ...prev,
      [field]: value,
      to_amount: (fromAmt * rate).toFixed(2),
    }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (form.from_account_id === form.to_account_id) {
      alert('From and To accounts cannot be the same.');
      return;
    }
    if (!form.from_amount || parseFloat(form.from_amount) <= 0) {
      alert('Enter a valid amount.');
      return;
    }

    const fromCurrency = getCurrency(form.from_account_id);
    const toCurrency = getCurrency(form.to_account_id);

    createTransfer.mutate(
      {
        description: form.description || null,
        from_account_id: form.from_account_id,
        from_currency: fromCurrency,
        from_amount: parseFloat(form.from_amount),
        to_account_id: form.to_account_id,
        to_currency: toCurrency,
        to_amount: parseFloat(form.to_amount),
        exchange_rate: parseFloat(form.exchange_rate) || 1,
        fx_rate_date: form.fx_rate_date || null,
        transfer_date: form.transfer_date,
        status: 'DRAFT',
        created_by: user?.id || '',
      },
      {
        onSuccess: () => {
          setShowModal(false);
          setForm({
            from_account_id: '',
            to_account_id: '',
            from_amount: '',
            to_amount: '',
            exchange_rate: '1',
            fx_rate_date: new Date().toISOString().split('T')[0],
            transfer_date: new Date().toISOString().split('T')[0],
            description: '',
            reference: '',
            payment_method: 'BANK_TRANSFER',
          });
        },
      }
    );
  };

  const useReverseTransferAction = async (transferId: string, reason: string) => {
    return await reverseTransfer.mutateAsync({ transferId, reversalDate: new Date().toISOString().slice(0,10), reason });
  };

  // Workflow actions
  const processAction = async (transferId: string, action: string, reason: string) => {
    const updates: any = {};
    const now = new Date().toISOString();

    switch (action.toLowerCase()) {
      case 'submit':
        updates.status = 'SUBMITTED';
        break;
      case 'approve':
        updates.status = 'APPROVED';
        updates.approved_by = user?.id;
        updates.approved_at = now;
        break;
      case 'reject':
        updates.status = 'REJECTED';
        updates.rejected_by = user?.id;
        updates.rejected_at = now;
        updates.rejection_reason = reason;
        break;
      case 'cancel':
        updates.status = 'CANCELLED';
        updates.rejection_reason = reason;
        break;
      case 'reverse':
        const reverseResult = await useReverseTransferAction(transferId, reason);
        if (reverseResult?.error) alert('Reversal failed: ' + reverseResult.error.message);
        return;
      case 'post':
        if (!openPeriod) {
          alert('No open accounting period found. Cannot post.');
          return;
        }
        // FND-BANK-01 FIX: status/period_id/posted_by/posted_at are no
        // longer set here — they never reached the database anyway,
        // since the code path below returns before the
        // updateStatus.mutateAsync() call further down, and
        // update_bank_transfer_status() doesn't even accept 'POSTED' as
        // a transition. finance.post_bank_transfer() now sets all of
        // these columns itself, atomically, alongside the journal it
        // creates — see schema.sql / P2_008 migration. Leaving the dead
        // assignments here previously made it look like this page was
        // finalizing the transfer, masking the real bug.
        const transfer = (transfers as BankTransfer[] | undefined)?.find(t => t.id === transferId);
        if (!transfer) { alert('Transfer record could not be loaded. Refresh and try again.'); return; }
        const { error: postErr } = await postTransfer.mutateAsync({
          transferId, periodId: openPeriod.id, date: transfer.transfer_date,
        });
        if (postErr) {
          alert('Posting failed: ' + postErr.message);
          return;
        }
        break;
    }

    if (action.toLowerCase() !== 'post') {
      await updateStatus.mutateAsync({ id: transferId, updates });
    }
  };

  const handleAction = (transferId: string, action: string, needsReason?: boolean) => {
    if (needsReason) {
      setReasonState({ open: true, title: `Confirm ${action}`, action, id: transferId });
      return;
    }
    processAction(transferId, action, '');
  };

  const inputCls = 'w-full px-3 py-2.5 border dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm outline-none focus:ring-2 focus:ring-blue-500';
  const labelCls = 'block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1';

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white flex items-center gap-2">
            <ArrowLeftRight className="w-7 h-7 text-blue-600" /> Bank Transfers
          </h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
            Transfer funds between financial accounts with FX support
          </p>
        </div>
        {hasPermission('BANK_CREATE') && (
          <button onClick={() => setShowModal(true)} className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-4 py-2.5 rounded-lg text-sm font-medium shadow-sm transition-colors">
            <Plus size={16} /> New Transfer
          </button>
        )}
      </div>

      {/* Table */}
      <div className="bg-white dark:bg-gray-800 border dark:border-gray-700 rounded-xl overflow-hidden shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 dark:bg-gray-900/50 border-b dark:border-gray-700 text-left text-xs uppercase text-gray-500 dark:text-gray-400">
              <tr>
                <th className="px-4 py-3">Transfer #</th>
                <th className="px-4 py-3">From</th>
                <th className="px-4 py-3">To</th>
                <th className="px-4 py-3 text-right">Amount</th>
                <th className="px-4 py-3 hidden md:table-cell">Rate</th>
                <th className="px-4 py-3">Date</th>
                <th className="px-4 py-3 text-center">Dual</th>
                <th className="px-4 py-3 text-center">Status</th>
                <th className="px-4 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y dark:divide-gray-700">
              {isLoading ? (
                <tr>
                  <td colSpan={9} className="px-4 py-12 text-center text-gray-400">
                    <Loader2 className="w-5 h-5 animate-spin mx-auto mb-2" /> Loading...
                  </td>
                </tr>
              ) : !(transfers as BankTransfer[])?.length ? (
                <tr>
                  <td colSpan={9} className="px-4 py-16 text-center text-gray-400">No transfers yet.</td>
                </tr>
              ) : (
                (transfers as BankTransfer[]).map((t) => (
                  <tr key={t.id} className="hover:bg-gray-50 dark:hover:bg-gray-700/30 transition-colors">
                    <td className="px-4 py-3 font-mono text-xs text-blue-600 dark:text-blue-400">{t.transfer_number || 'N/A'}</td>
                    <td className="px-4 py-3 text-gray-900 dark:text-white text-sm">
                      <div>{t.from_account?.account_name || 'Unknown'}</div>
                      <div className="text-xs text-gray-400">{t.from_currency}</div>
                    </td>
                    <td className="px-4 py-3 text-gray-900 dark:text-white text-sm">
                      <div>{t.to_account?.account_name || 'Unknown'}</div>
                      <div className="text-xs text-gray-400">{t.to_currency}</div>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="font-semibold text-gray-900 dark:text-white">{formatCurrency(t.from_amount, t.from_currency)}</div>
                      {t.from_currency !== t.to_currency && (
                        <div className="text-xs text-gray-500">→ {formatCurrency(t.to_amount, t.to_currency)}</div>
                      )}
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-500 font-mono hidden md:table-cell">
                      {t.exchange_rate !== 1 ? t.exchange_rate.toFixed(4) : '-'}
                    </td>
                    <td className="px-4 py-3 text-gray-600 dark:text-gray-300 text-sm">{t.transfer_date}</td>
                    <td className="px-4 py-3 text-center">
                      {t.requires_dual_approval ? (
                        <span title="Requires dual approval" className="flex justify-center">
                        <ShieldCheck className="w-4 h-4 text-orange-500" />
                        </span>
                      ) : (
                        <span className="text-gray-300 dark:text-gray-600">-</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-center">
                      <span className={`px-2.5 py-0.5 rounded-full text-[11px] font-bold ${STATUS_STYLES[t.status] || 'bg-gray-100 text-gray-700'}`}>
                        {formatStatus(t.status)}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right">
                      {['DRAFT', 'SUBMITTED', 'APPROVED'].includes(t.status) && (
                        <StatusActions record={t} module="banking" onAction={handleAction} isPosting={postTransfer.isPending} />
                      )}
                      {t.status === 'POSTED' && hasPermission('BANK_TRANSFER_APPROVE') && (
                        <button onClick={() => handleAction(t.id, 'reverse', true)} className="inline-flex items-center gap-1 text-xs text-red-600 hover:text-red-700" title="Reverse posted transfer">
                          <RotateCcw size={14} /> Reverse
                        </button>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* ==================== CREATE TRANSFER MODAL ==================== */}
      {showModal && (
        <div
          className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4"
          onClick={(e) => { if (e.target === e.currentTarget) setShowModal(false); }}
        >
          <form onSubmit={handleSubmit} className="bg-white dark:bg-gray-800 border dark:border-gray-700 rounded-2xl w-full max-w-lg shadow-2xl max-h-[85vh] flex flex-col">
            <div className="p-5 border-b dark:border-gray-700 flex justify-between items-center shrink-0">
              <h2 className="text-lg font-bold text-gray-900 dark:text-white">New Bank Transfer</h2>
              <button type="button" onClick={() => setShowModal(false)} className="p-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-500">
                <X size={20} />
              </button>
            </div>

            <div className="p-5 space-y-4 overflow-y-auto flex-1">
              {/* From Account */}
              <div>
                <label className={labelCls}>From Account <span className="text-red-500">*</span></label>
                <select required value={form.from_account_id} onChange={(e) => setForm((p) => ({ ...p, from_account_id: e.target.value }))} className={inputCls}>
                  <option value="">Select source account...</option>
                  {accounts?.map((a: any) => (
                    <option key={a.id} value={a.id}>{a.account_name} ({a.currency})</option>
                  ))}
                </select>
              </div>

              {/* Arrow indicator */}
              <div className="flex justify-center">
                <div className="p-2 bg-gray-100 dark:bg-gray-700 rounded-full"><ArrowLeftRight className="w-5 h-5 text-gray-400" /></div>
              </div>

              {/* To Account */}
              <div>
                <label className={labelCls}>To Account <span className="text-red-500">*</span></label>
                <select required value={form.to_account_id} onChange={(e) => setForm((p) => ({ ...p, to_account_id: e.target.value }))} className={inputCls}>
                  <option value="">Select destination account...</option>
                  {accounts?.map((a: any) => (
                    <option key={a.id} value={a.id}>{a.account_name} ({a.currency})</option>
                  ))}
                </select>
                {form.from_account_id && form.to_account_id && form.from_account_id === form.to_account_id && (
                  <p className="text-xs text-red-500 mt-1">Same account selected — this is not allowed.</p>
                )}
              </div>

              {/* Amount + Rate */}
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className={labelCls}>Amount <span className="text-red-500">*</span></label>
                  <input
                    type="number"
                    step="0.01"
                    required
                    value={form.from_amount}
                    onChange={(e) => handleAmountOrRateChange('from_amount', e.target.value)}
                    className={`${inputCls} text-right text-lg font-bold`}
                    placeholder="0.00"
                  />
                </div>
                <div>
                  <label className={labelCls}>FX Rate</label>
                  <input
                    type="number"
                    step="0.0001"
                    value={form.exchange_rate}
                    onChange={(e) => handleAmountOrRateChange('exchange_rate', e.target.value)}
                    className={inputCls}
                  />
                </div>
              </div>

              {/* Converted amount preview */}
              {form.from_amount && parseFloat(form.exchange_rate) !== 1 && (
                <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800/30 rounded-lg px-3 py-2">
                  <p className="text-sm text-blue-700 dark:text-blue-300">
                    Converted: <span className="font-bold">{formatCurrency(parseFloat(form.to_amount) || 0, getCurrency(form.to_account_id))}</span>
                  </p>
                </div>
              )}

              {/* Date + Method */}
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className={labelCls}>Transfer Date</label>
                  <input type="date" value={form.transfer_date} onChange={(e) => setForm((p) => ({ ...p, transfer_date: e.target.value }))} className={inputCls} />
                </div>
                <div>
                  <label className={labelCls}>Method</label>
                  <select value={form.payment_method} onChange={(e) => setForm((p) => ({ ...p, payment_method: e.target.value }))} className={inputCls}>
                    {PAYMENT_METHODS.map((m) => (
                      <option key={m.value} value={m.value}>{m.label}</option>
                    ))}
                  </select>
                </div>
              </div>

              {/* Reference + Description */}
              <div>
                <label className={labelCls}>Reference</label>
                <input type="text" value={form.reference} onChange={(e) => setForm((p) => ({ ...p, reference: e.target.value }))} className={inputCls} placeholder="e.g., TRF-REF-123" />
              </div>
              <div>
                <label className={labelCls}>Description</label>
                <textarea value={form.description} onChange={(e) => setForm((p) => ({ ...p, description: e.target.value }))} className={`${inputCls} resize-none`} rows={2} placeholder="Transfer purpose..." />
              </div>
            </div>

            <div className="flex justify-end gap-3 p-5 border-t dark:border-gray-700 shrink-0">
              <button type="button" onClick={() => setShowModal(false)} className="px-5 py-2.5 bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 dark:hover:bg-gray-600 text-gray-800 dark:text-white rounded-xl text-sm font-medium">
                Cancel
              </button>
              <button
                type="submit"
                disabled={createTransfer.isPending || !form.from_account_id || !form.to_account_id || !form.from_amount || form.from_account_id === form.to_account_id}
                className="px-5 py-2.5 bg-blue-600 hover:bg-blue-700 text-white rounded-xl text-sm font-medium disabled:opacity-50 flex items-center gap-2"
              >
                {createTransfer.isPending && <Loader2 size={14} className="animate-spin" />}
                Create Transfer
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
          processAction(reasonState.id, reasonState.action, reason);
          setReasonState({ open: false, title: '', action: '', id: '' });
        }}
        onCancel={() => setReasonState({ open: false, title: '', action: '', id: '' })}
      />
    </div>
  );
}