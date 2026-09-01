'use client';
import { useState, useEffect } from 'react';
import { useAuth } from '@/context/AuthContext';
import { usePermissions } from "@/context/PermissionContext";
import {
  useProfitDistributions,
  useProfitDistributionDetail,
  useCreateProfitDistribution,
  useUpdateProfitDistribution,
  useSaveDistributionLines,
  usePostProfitDistribution,
  useOwners,
  useFiscalYears,
  useOpenPeriod,
  useCalculateReserve,
} from '@/hooks/useTaxEquity';
import ReasonModal from '@/components/finance/ReasonModal';
import { TrendingUp, Plus, Loader2, AlertCircle, CheckCircle } from 'lucide-react';

/* ═══════════════════════════════════════════════════════
   CONSTANTS
   ═════════════════════════════════════════════════════ */
const STATUS_STYLES: Record<string, string> = {
  DRAFT: 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300',
  DECLARED: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
  APPROVED: 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400',
  POSTED: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400',
  PAID: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400',
  CANCELLED: 'bg-gray-200 text-gray-500 dark:bg-gray-600 dark:text-gray-400 italic',
};

const PAYMENT_STATUS_STYLES: Record<string, string> = {
  PENDING: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400',
  PAID: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400',
  CANCELLED: 'bg-gray-200 text-gray-500 dark:bg-gray-600 dark:text-gray-400 italic',
};

const formatCurrency = (n: number) =>
  new Intl.NumberFormat('en-PK', {
    style: 'currency',
    currency: 'PKR',
    minimumFractionDigits: 0,
  }).format(n || 0);

const formatStatus = (s: string) =>
  s
    ?.replace(/_/g, ' ')
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase());

const inputCls =
  'w-full px-3 py-2.5 border dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm outline-none focus:ring-2 focus:ring-blue-500';
const labelCls =
  'block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1';

/* ═══════════════════════════════════════════════════════
   COMPONENT
   ═════════════════════════════════════════════════════ */
export default function ProfitDistributionPage() {
  const { user } = useAuth();
  const { hasPermission, isLoading: permLoading } = usePermissions();
  const { data: distributions, isLoading: loadingList } = useProfitDistributions();
  const { data: owners } = useOwners();
  const { data: fiscalYears } = useFiscalYears();
  const { data: openPeriod } = useOpenPeriod();
  const createDist = useCreateProfitDistribution();
  const updateDist = useUpdateProfitDistribution();
  const saveLines = useSaveDistributionLines();
  const postDist = usePostProfitDistribution();
  const calcReserve = useCalculateReserve();

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [createForm, setCreateForm] = useState({
    fiscal_year_id: '',
    total_available_profit: '',
  });
  const [reasonState, setReasonState] = useState({
    open: false,
    title: '',
    action: '',
    id: '',
  });

  // Detail
  const { data: detail, isLoading: loadingDetail, refetch } =
    useProfitDistributionDetail(selectedId || '');
  const [lines, setLines] = useState<any[]>([]);

  /* ── When detail loads, populate lines from owners ── */
  useEffect(() => {
    if (detail?.lines && detail.lines.length > 0) {
      setLines(
        detail.lines.map((l: any) => ({
          ...l,
          tempOverride: l.overridden_amount ? String(l.overridden_amount) : '',
        }))
      );
    } else if (detail && (!detail.lines || detail.lines.length === 0) && owners) {
      const activeOwners = owners.filter((o) => o.status === 'ACTIVE');
      const distAmt = detail.distributable_amount || 0;
      const totalPct =
        activeOwners.reduce((s, o) => s + (o.current_percentage || 0), 0) || 1;
      setLines(
        activeOwners.map((o) => {
          const calc = Math.round((distAmt * ((o.current_percentage || 0) / totalPct) * 100) / 100);
          return {
            profit_distribution_id: detail.id,
            owner_id: o.id,
            ownership_percentage: o.current_percentage || 0,
            calculated_amount: calc,
            overridden_amount: null,
            final_amount: calc,
            payment_status: 'PENDING',
            paid_amount: 0,
            owners: { name: o.name },
          };
        })
      );
    }
  }, [detail?.id, detail?.distributable_amount, owners]);

  /* ── Permission guard ── */
  if (permLoading || !hasPermission('EQUITY_READ')) {
    return (
      <div className="p-6 flex items-center justify-center min-h-[60vh]">
        <p className="text-gray-500 dark:text-gray-400">Access Denied</p>
      </div>
    );
  }

  /* ── Create distribution ── */
  const handleCreate = async () => {
    if (!createForm.fiscal_year_id || !createForm.total_available_profit) {
      alert('All fields required');
      return;
    }
    const profit = parseFloat(createForm.total_available_profit) || 0;

    let reserve = 0;
    try {
      const result = await calcReserve.mutateAsync({ profit });
      reserve = (result as any)?.data ?? (result as any) ?? 0;
    } catch {
      /* fallback 0 */
    }

    createDist.mutate(
      {
        fiscal_year_id: createForm.fiscal_year_id,
        total_available_profit: profit,
        reserve_amount: reserve,
        distributable_amount: profit - reserve,
        status: 'DRAFT',
        created_by: user?.id,
      },
      {
        onSuccess: () => {
          setShowCreate(false);
          setCreateForm({ fiscal_year_id: '', total_available_profit: '' });
        },
      }
    );
  };

  /* ── Override amount per owner ── */
  const handleOverride = (idx: number, value: string) => {
    setLines((prev) =>
      prev.map((l, i) => {
        if (i !== idx) return l;
        const override = value ? parseFloat(value) : null;
        return {
          ...l,
          tempOverride: value,
          overridden_amount: override,
          final_amount: override ?? l.calculated_amount,
        };
      })
    );
  };

  /* ── Save distribution lines ── */
  const handleSaveLines = () => {
    if (!detail?.id) return;
    const payload = lines.map((l) => ({
      ...l,
      overridden_amount: l.tempOverride ? parseFloat(l.tempOverride) : null,
      final_amount: l.final_amount,
    }));
    saveLines.mutate(payload, { onSuccess: () => refetch() });
  };

  /* ── Status transitions ── */
  const handleStatusChange = (status: string, reason?: string) => {
    if (!selectedId || !detail) return;
    const now = new Date().toISOString();
    const updates: Record<string, any> = { status };
    if (status === 'DECLARED') {
      updates.declared_by = user?.id;
      updates.declared_at = now;
    }
    if (status === 'APPROVED') {
      updates.approved_by = user?.id;
      updates.approved_at = now;
    }
    if (status === 'CANCELLED') {
      updates.notes = [detail.notes, reason ? `Cancelled: ${reason}` : 'Cancelled'].filter(Boolean).join('\n');
      updates.reason = reason || null;
    }
    updateDist.mutate({ id: selectedId, ...updates }, { onSuccess: () => refetch() });
  };

  /* ── Post to ledger ── */
  const handlePost = () => {
    if (!selectedId || !openPeriod) {
      alert('No open accounting period found');
      return;
    }
    postDist.mutate(
      {
        distId: selectedId,
        periodId: openPeriod.id,
        date: new Date().toISOString().split('T')[0],
      },
      { onSuccess: () => refetch() }
    );
  };

  /* ── List action handler ── */
  const handleAction = (id: string, action: string, needsReason?: boolean) => {
    setSelectedId(id);
    if (needsReason) {
      setReasonState({ open: true, title: `Confirm ${action}`, action, id });
      return;
    }
    handleStatusChange(action);
  };

  /* ── Reason modal confirm ── */
  const handleReasonConfirm = (reason: string) => {
    handleStatusChange(reasonState.action, reason);
    setReasonState({ open: false, title: '', action: '', id: '' });
  };

  /* ── Balance check ── */
  const totalOverride = lines.reduce((s, l) => s + (l.overridden_amount ?? l.calculated_amount), 0);
  const balanced = Math.abs(totalOverride - (detail?.distributable_amount || 0)) < 0.01;

  return (
    <div className="space-y-6">
      {/* ═══════ HEADER ═══════ */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white flex items-center gap-2">
            <TrendingUp className="w-7 h-7 text-green-600" /> Profit Distribution
          </h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
            Reserve allocation and owner profit distribution workflow
          </p>
        </div>
        {hasPermission('EQUITY_MANAGE') && (
          <button
            onClick={() => setShowCreate(true)}
            className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-4 py-2.5 rounded-lg text-sm font-medium shadow-sm transition-colors"
          >
            <Plus size={16} /> New Distribution
          </button>
        )}
      </div>

      {/* ═══════ LIST + DETAIL LAYOUT ═══════ */}
      <div className="flex gap-5 min-h-[calc(100vh-200px)]">
        {/* ===== LEFT: Distributions List ===== */}
        <div className="w-80 bg-white dark:bg-gray-800 border dark:border-gray-700 rounded-xl overflow-hidden flex flex-col shrink-0">
          <div className="p-3 border-b dark:border-gray-700">
            <h3 className="text-xs font-bold uppercase text-gray-500 dark:text-gray-400">Distributions</h3>
          </div>
          <div className="flex-1 overflow-y-auto">
            {loadingList ? (
              <div className="p-8 flex justify-center">
                <Loader2 className="w-5 h-5 animate-spin" />
              </div>
            ) : !distributions?.length ? (
              <div className="p-8 text-center text-gray-400 text-sm">No distributions yet</div>
            ) : (
              distributions.map((d: any) => (
                <div
                  key={d.id}
                  onClick={() => setSelectedId(d.id)}
                  className={`p-3 border-b dark:border-gray-700 cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors ${
                    selectedId === d.id ? 'bg-blue-50 dark:bg-blue-900/20 border-l-4 border-l-blue-500' : ''
                  }`}
                >
                  <div className="flex justify-between items-center">
                    <span className="text-sm font-medium text-gray-900 dark:text-white">
                      {d.fiscal_year_id?.slice(0, 8)}...
                    </span>
                    <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${STATUS_STYLES[d.status] || ''}`}>
                      {formatStatus(d.status)}
                    </span>
                  </div>
                  <div className="text-xs text-gray-500 mt-1">
                    Profit: {formatCurrency(d.total_available_profit)} | Dist: {formatCurrency(d.distributable_amount)}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        {/* ===== RIGHT: Detail ===== */}
        <div className="flex-1 min-w-0 space-y-4 overflow-y-auto">
          {!selectedId && (
            <div className="flex items-center justify-center h-full text-gray-400">
              <div className="text-center">
                <TrendingUp className="w-16 h-16 mx-auto mb-4 opacity-20" />
                <p className="text-lg font-medium">Select a distribution</p>
                <p className="text-sm mt-1">or create a new one</p>
              </div>
            </div>
          )}

          {selectedId && loadingDetail && (
            <div className="flex justify-center py-16">
              <Loader2 className="w-8 h-8 animate-spin" />
            </div>
          )}

          {selectedId && detail && (
            <>
              {/* ── Summary Cards ── */}
              <div className="grid grid-cols-3 gap-4">
                <div className="bg-white dark:bg-gray-800 border dark:border-gray-700 rounded-xl p-4">
                  <p className="text-[10px] uppercase tracking-wider text-gray-400 dark:text-gray-500">Total Profit</p>
                  <p className="text-xl font-bold text-gray-900 dark:text-white mt-1">
                    {formatCurrency(detail.total_available_profit)}
                  </p>
                </div>
                <div className="bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800/30 rounded-xl p-4">
                  <p className="text-[10px] uppercase tracking-wider text-yellow-600 dark:text-yellow-400">Reserve</p>
                  <p className="text-xl font-bold text-yellow-700 dark:text-yellow-400 mt-1">
                    {formatCurrency(detail.reserve_amount)}
                  </p>
                  {detail.reserve_amount > 0 && (
                    <p className="text-[10px] text-yellow-500 dark:text-yellow-400 mt-1">
                      {((detail.reserve_amount / (detail.total_available_profit || 1)) * 100).toFixed(1)}% of profit
                    </p>
                  )}
                </div>
                <div className="bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800/30 rounded-xl p-4">
                  <p className="text-[10px] uppercase tracking-wider text-green-600 dark:text-green-400">Distributable</p>
                  <p className="text-xl font-bold text-green-700 dark:text-green-400 mt-1">
                    {formatCurrency(detail.distributable_amount)}
                  </p>
                </div>
              </div>

              {/* ── Status Banner ── */}
              <div className="bg-white dark:bg-gray-800 border dark:border-gray-700 rounded-xl px-5 py-3 flex justify-between items-center">
                <div className="flex items-center gap-3">
                  <span className="text-sm font-medium text-gray-700 dark:text-gray-300">Status:</span>
                  <span className={`px-3 py-1 rounded-full text-xs font-bold ${STATUS_STYLES[detail.status] || ''}`}>
                    {formatStatus(detail.status)}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  {detail.status === 'DRAFT' && hasPermission('EQUITY_MANAGE') && (
                    <button
                      onClick={() => handleStatusChange('DECLARED')}
                      className="px-3 py-1.5 bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400 rounded-lg text-xs font-medium hover:bg-blue-200 transition-colors"
                    >
                      Declare
                    </button>
                  )}
                  {detail.status === 'DECLARED' && hasPermission('EQUITY_APPROVE') && (
                    <button
                      onClick={() => handleStatusChange('APPROVED')}
                      className="px-3 py-1.5 bg-purple-100 dark:bg-purple-900/30 text-purple-700 dark:text-purple-400 rounded-lg text-xs font-medium hover:bg-purple-200 transition-colors"
                    >
                      CEO Approve
                    </button>
                  )}
                  {detail.status === 'APPROVED' && hasPermission('EQUITY_POST') && (
                    <button
                      onClick={handlePost}
                      disabled={postDist.isPending || !balanced}
                      className="px-3 py-1.5 bg-green-600 hover:bg-green-700 text-white rounded-lg text-xs font-medium disabled:opacity-50 flex items-center gap-1 transition-colors"
                    >
                      {postDist.isPending && <Loader2 size={12} className="animate-spin" />}
                      Post to Ledger
                    </button>
                  )}
                  {['DRAFT', 'DECLARED'].includes(detail.status) && hasPermission('EQUITY_MANAGE') && (
                    <button
                      onClick={() => handleAction(detail.id, 'CANCEL', true)}
                      className="px-3 py-1.5 bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400 rounded-lg text-xs font-medium hover:bg-red-200 transition-colors"
                    >
                      Cancel
                    </button>
                  )}
                </div>
              </div>

              {/* ── Distribution Table ── */}
              <div className="bg-white dark:bg-gray-800 border dark:border-gray-700 rounded-xl overflow-hidden">
                <div className="p-4 border-b dark:border-gray-700 flex justify-between items-center">
                  <h3 className="text-sm font-bold text-gray-900 dark:text-white">Distribution to Owners</h3>
                  {hasPermission('EQUITY_MANAGE') && detail.status === 'DRAFT' && (
                    <button
                      onClick={handleSaveLines}
                      disabled={saveLines.isPending || !balanced}
                      className="text-sm text-blue-600 dark:text-blue-400 hover:underline disabled:opacity-50 flex items-center gap-1"
                    >
                      {saveLines.isPending && <Loader2 size={14} className="animate-spin" />}
                      Save Lines
                    </button>
                  )}
                </div>

                {!balanced && (
                  <div className="bg-red-50 dark:bg-red-900/20 border-b border-red-200 dark:border-red-800/30 px-4 py-2 text-xs text-red-600 dark:text-red-400 flex items-center gap-1">
                    <AlertCircle size={14} />
                    Override total ({formatCurrency(totalOverride)}) must equal distributable ({formatCurrency(detail.distributable_amount)})
                  </div>
                )}

                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-gray-50 dark:bg-gray-900/50 text-xs uppercase text-gray-500 dark:text-gray-400">
                      <tr>
                        <th className="px-4 py-2.5 text-left">Owner</th>
                        <th className="px-4 py-2.5 text-center">Ownership %</th>
                        <th className="px-4 py-2.5 text-right">Calculated</th>
                        <th className="px-4 py-2.5 text-right">Override</th>
                        <th className="px-4 py-2.5 text-right">Final Amount</th>
                        <th className="px-4 py-2.5 text-center">Payment</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y dark:divide-gray-700">
                      {lines.map((l, idx) => (
                        <tr key={l.id || idx} className="hover:bg-gray-50 dark:hover:bg-gray-700/30 transition-colors">
                          <td className="px-4 py-2.5 font-medium text-gray-900 dark:text-white">
                            {l.owners?.name || 'Unknown'}
                          </td>
                          <td className="px-4 py-2.5 text-center text-gray-500">
                            {l.ownership_percentage.toFixed(2)}%
                          </td>
                          <td className="px-4 py-2.5 text-right text-gray-600 dark:text-gray-400">
                            {formatCurrency(l.calculated_amount)}
                          </td>
                          <td className="px-4 py-2.5 text-right">
                            {detail.status === 'DRAFT' ? (
                              <input
                                type="number"
                                step="0.01"
                                value={l.tempOverride}
                                onChange={(e) => handleOverride(idx, e.target.value)}
                                className="w-32 px-2 py-1.5 border dark:border-gray-600 rounded bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm text-right outline-none focus:ring-2 focus:ring-blue-500"
                                placeholder={formatCurrency(l.calculated_amount)}
                              />
                            ) : l.overridden_amount ? (
                              <span className="text-orange-600 dark:text-orange-400 font-medium">
                                {formatCurrency(l.overridden_amount)}
                              </span>
                            ) : (
                              <span className="text-gray-300 dark:text-gray-600">-</span>
                            )}
                          </td>
                          <td className="px-4 py-2.5 text-right font-bold text-gray-900 dark:text-white">
                            {formatCurrency(l.final_amount)}
                          </td>
                          <td className="px-4 py-2.5 text-center">
                            <span className={`px-2.5 py-0.5 rounded-full text-[10px] font-bold ${PAYMENT_STATUS_STYLES[l.payment_status] || 'bg-gray-100 text-gray-700'}`}>
                              {formatStatus(l.payment_status)}
                            </span>
                            {l.paid_amount > 0 && (
                              <p className="text-[10px] text-gray-400 mt-0.5">Paid: {formatCurrency(l.paid_amount)}</p>
                            )}
                          </td>
                        </tr>
                      ))}

                      {lines.length === 0 && (
                        <tr>
                          <td colSpan={6} className="px-4 py-8 text-center text-gray-400 text-sm">
                            No owners configured. Go to Settings → Ownership & Reserves.
                          </td>
                        </tr>
                      )}
                    </tbody>

                    {lines.length > 0 && (
                      <tfoot className="border-t dark:border-gray-700 bg-gray-50 dark:bg-gray-900/30">
                        <tr>
                          <td colSpan={4} className="px-4 py-2.5 text-sm font-bold text-gray-900 dark:text-white text-right">
                            Total
                          </td>
                          <td className="px-4 py-2.5 text-right font-bold text-gray-900 dark:text-white">
                            {formatCurrency(totalOverride)}
                          </td>
                          <td />
                        </tr>
                      </tfoot>
                    )}
                  </table>
                </div>
              </div>

              {/* ── Journal Entry Info (if posted) ── */}
              {detail.journal_entry_id && (
                <div className="bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800/30 rounded-xl p-4 flex items-center gap-3">
                  <CheckCircle className="w-5 h-5 text-green-600" />
                  <div>
                    <p className="text-sm font-medium text-green-700 dark:text-green-400">Posted to Ledger</p>
                    <p className="text-xs text-green-600 dark:text-green-400 font-mono">
                      Journal Entry: {detail.journal_entry_id.slice(0, 8)}...
                    </p>
                    {detail.posted_at && (
                      <p className="text-[10px] text-green-500 dark:text-green-400">
                        Posted at: {new Date(detail.posted_at).toLocaleString()}
                      </p>
                    )}
                  </div>
                </div>
              )}

              {/* ── Notes ── */}
              {detail.notes && (
                <div className="bg-white dark:bg-gray-800 border dark:border-gray-700 rounded-xl p-4">
                  <p className="text-xs text-gray-400 mb-1">Notes</p>
                  <p className="text-sm text-gray-700 dark:text-gray-300">{detail.notes}</p>
                </div>
              )}
            </>
          )}

          {/* ═══════ CREATE MODAL ═══════ */}
          {showCreate && (
            <div
              className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4"
              onClick={(e) => { if (e.target === e.currentTarget) setShowCreate(false); }}
            >
              <div className="bg-white dark:bg-gray-800 border dark:border-gray-700 rounded-2xl w-full max-w-md shadow-2xl p-5 space-y-4">
                <h2 className="text-lg font-bold text-gray-900 dark:text-white">New Profit Distribution</h2>
                <p className="text-xs text-gray-500 dark:text-gray-400">
                  Reserve will be automatically calculated based on the active reserve policy.
                </p>
                <div>
                  <label className={labelCls}>Fiscal Year *</label>
                  <select
                    value={createForm.fiscal_year_id}
                    onChange={(e) => setCreateForm((p) => ({ ...p, fiscal_year_id: e.target.value }))}
                    className={inputCls}
                  >
                    <option value="">Select fiscal year...</option>
                    {fiscalYears?.map((fy: any) => (
                      <option key={fy.name} value={fy.name}>{fy.year_label || fy.name}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className={labelCls}>Total Available Profit (PKR) *</label>
                  <input
                    type="number"
                    step="0.01"
                    value={createForm.total_available_profit}
                    onChange={(e) => setCreateForm((p) => ({ ...p, total_available_profit: e.target.value }))}
                    className={`${inputCls} text-right text-lg font-bold`}
                    placeholder="0.00"
                  />
                </div>
                {createForm.total_available_profit && (
                  <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800/30 rounded-lg p-3 text-xs text-blue-600 dark:text-blue-400">
                    <p>
                      Note: This should be the Profit Before Tax minus actual tax paid for the selected fiscal year.
                      The system will calculate reserve based on the active policy and show distributable amount.
                    </p>
                  </div>
                )}
                <div className="flex justify-end gap-3 pt-2">
                  <button
                    onClick={() => setShowCreate(false)}
                    className="px-4 py-2.5 bg-gray-200 dark:bg-gray-700 text-gray-800 dark:text-white rounded-xl text-sm font-medium"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleCreate}
                    disabled={createDist.isPending || !createForm.fiscal_year_id || !createForm.total_available_profit}
                    className="px-4 py-2.5 bg-blue-600 hover:bg-blue-700 text-white rounded-xl text-sm font-medium disabled:opacity-50 flex items-center gap-2"
                  >
                    {createDist.isPending && <Loader2 size={14} className="animate-spin" />}
                    Create Distribution
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* ═══════ REASON MODAL ═══════ */}
          <ReasonModal
            open={reasonState.open}
            title={reasonState.title}
            description="Provide a reason for this action. This will be recorded in the audit trail."
            onConfirm={handleReasonConfirm}
            onCancel={() => setReasonState({ open: false, title: '', action: '', id: '' })}
          />
        </div>
      </div>
    </div>
  );
}