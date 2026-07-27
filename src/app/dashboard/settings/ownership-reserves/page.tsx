'use client';
import { useState } from 'react';
import { useAuth } from '@/context/AuthContext';
import { usePermissions } from '@/hooks/usePermissions';
import { useOwners, useCreateOwner, useOwnershipHistory, useAddOwnershipEntry, useReservePolicies, useCreateReservePolicy, useUpdateReservePolicy } from '@/hooks/useTaxEquity';
import ReasonModal from '@/components/finance/ReasonModal';
import { Users, Shield, History, Plus, Loader2, AlertCircle } from 'lucide-react';

const POLICY_TYPES = [
  { value: 'DISABLED', label: 'Disabled (No Reserve)' },
  { value: 'FIXED_AMOUNT', label: 'Fixed Amount' },
  { value: 'PERCENT_OF_PROFIT', label: '% of Profit' },
  { value: 'PERCENT_OF_PAYOUT', label: '% of Payout' },
  { value: 'TARGET_BALANCE', label: 'Target Balance' },
  { value: 'HYBRID', label: 'Hybrid (Fixed + %)' },
];

const formatCurrency = (n: number) => new Intl.NumberFormat('en-PK', { style: 'currency', currency: 'PKR', minimumFractionDigits: 0 }).format(n || 0);
const inputCls = 'w-full px-3 py-2.5 border dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm outline-none focus:ring-2 focus:ring-blue-500';
const labelCls = 'block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1';

export default function OwnershipReservesPage() {
  const { user } = useAuth();
  const { hasPermission, isLoading: permLoading } = usePermissions();
  const [tab, setTab] = useState<'owners' | 'reserve' | 'history'>('owners');

  const { data: owners, isLoading: loadingOwners } = useOwners();
  const createOwner = useCreateOwner();
  const [showOwnerModal, setShowOwnerModal] = useState(false);
  // ✅ FIXED: contact_info instead of contact_email/contact_phone
  const [ownerForm, setOwnerForm] = useState({ name: '', partner_class: '', cnic_number: '', contact_info: '' });

  const { data: history, isLoading: loadingHistory } = useOwnershipHistory();
  const addHistory = useAddOwnershipEntry();
  const [showHistoryModal, setShowHistoryModal] = useState(false);
  const [historyForm, setHistoryForm] = useState({ owner_id: '', ownership_percentage: '', effective_from: new Date().toISOString().split('T')[0], effective_to: '', change_reason: '' });

  const { data: policies, isLoading: loadingPolicies } = useReservePolicies();
  const createPolicy = useCreateReservePolicy();
  const updatePolicy = useUpdateReservePolicy();
  const [policyForm, setPolicyForm] = useState({ policy_type: 'PERCENT_OF_PROFIT', fixed_amount: '0', percentage: '25', target_balance: '0', effective_from: new Date().toISOString().split('T')[0], notes: '' });

  const [reasonState, setReasonState] = useState({ open: false, title: '', action: '', id: '' });

  if (permLoading || !hasPermission('SETTINGS_READ')) {
    return (
      <div className="p-6 flex items-center justify-center min-h-[60vh]">
        <p className="text-gray-500 dark:text-gray-400">Access Denied</p>
      </div>
    );
  }

  const totalPct = owners?.reduce((sum, o) => sum + (o.current_percentage || 0), 0) || 0;
  const activePolicy = policies?.find(p => !p.effective_to || new Date(p.effective_to) >= new Date());

  const handleCreateOwner = () => {
    if (!ownerForm.name) { alert('Name required'); return; }
    createOwner.mutate({ ...ownerForm, status: 'ACTIVE', created_by: user?.id }, { onSuccess: () => { setShowOwnerModal(false); setOwnerForm({ name: '', partner_class: '', cnic_number: '', contact_info: '' }); } });
  };

  const handleAddHistory = (reason?: string) => {
    if (!historyForm.owner_id || !historyForm.ownership_percentage || !historyForm.effective_from || !historyForm.change_reason) { alert('All fields required'); return; }
    addHistory.mutate({ ...historyForm, ownership_percentage: parseFloat(historyForm.ownership_percentage), changed_by: user?.id || '' }, { onSuccess: () => { setShowHistoryModal(false); setHistoryForm({ owner_id: '', ownership_percentage: '', effective_from: new Date().toISOString().split('T')[0], effective_to: '', change_reason: '' }); } });
  };

  const handleSavePolicy = () => {
    if (activePolicy?.id) {
      updatePolicy.mutate({ id: activePolicy.id, ...policyForm, fixed_amount: parseFloat(policyForm.fixed_amount) || 0, percentage: parseFloat(policyForm.percentage) || 0, target_balance: parseFloat(policyForm.target_balance) || 0 });
    } else {
      createPolicy.mutate({ ...policyForm, fixed_amount: parseFloat(policyForm.fixed_amount) || 0, percentage: parseFloat(policyForm.percentage) || 0, target_balance: parseFloat(policyForm.target_balance) || 0, approved_by: user?.id, created_by: user?.id });
    }
  };

  const tabs = [
    { key: 'owners' as const, label: 'Owners', icon: Users },
    { key: 'reserve' as const, label: 'Reserve Policy', icon: Shield },
    { key: 'history' as const, label: 'Change History', icon: History },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white flex items-center gap-2">
          <Shield className="w-7 h-7 text-purple-600" /> Ownership & Reserves
        </h1>
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">Configure ownership percentages and reserve policies</p>
      </div>

      <div className="flex gap-1 bg-gray-100 dark:bg-gray-800 p-1 rounded-lg w-fit">
        {tabs.map(t => (
          <button key={t.key} onClick={() => setTab(t.key)} className={`flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium transition-colors ${tab === t.key ? 'bg-white dark:bg-gray-700 text-gray-900 dark:text-white shadow-sm' : 'text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'}`}>
            <t.icon size={16} /> {t.label}
          </button>
        ))}
      </div>

      {/* Tab: Owners */}
      {tab === 'owners' && (
        <div className="space-y-4">
          <div className="flex justify-between items-center">
            <div className={`text-sm font-medium ${Math.abs(totalPct - 100) < 0.01 ? 'text-green-600' : 'text-red-600'}`}>
              Total Ownership: {totalPct.toFixed(2)}% {Math.abs(totalPct - 100) >= 0.01 && <span className="ml-2 text-xs">(Must equal 100%)</span>}
            </div>
            {hasPermission('SETTINGS_MANAGE') && <button onClick={() => setShowOwnerModal(true)} className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg text-sm"><Plus size={14} /> Add Owner</button>}
          </div>
          <div className="bg-white dark:bg-gray-800 border dark:border-gray-700 rounded-xl overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 dark:bg-gray-900/50 text-xs uppercase text-gray-500"><tr><th className="px-4 py-3 text-left">Name</th><th className="px-4 py-3">Class</th><th className="px-4 py-3">CNIC</th><th className="px-4 py-3 text-center">Ownership %</th><th className="px-4 py-3 text-center">Status</th></tr></thead>
              <tbody className="divide-y dark:divide-gray-700">
                {loadingOwners ? <tr><td colSpan={5} className="px-4 py-8 text-center"><Loader2 className="w-5 h-5 animate-spin mx-auto" /></td></tr> : owners?.map(o => (
                  <tr key={o.id} className="hover:bg-gray-50 dark:hover:bg-gray-700/30"><td className="px-4 py-3 font-medium text-gray-900 dark:text-white">{o.name}</td><td className="px-4 py-3 text-gray-500 text-center text-xs">{o.partner_class?.replace(/_/g, ' ') || '-'}</td><td className="px-4 py-3 text-gray-500 font-mono text-xs text-center">{o.cnic_number || '-'}</td><td className="px-4 py-3 text-center font-bold text-lg text-gray-900 dark:text-white">{(o.current_percentage || 0).toFixed(2)}%</td><td className="px-4 py-3 text-center"><span className={`px-2.5 py-0.5 rounded-full text-[11px] font-bold ${o.status === 'ACTIVE' ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400' : 'bg-gray-100 text-gray-500'}`}>{o.status}</span></td></tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="bg-white dark:bg-gray-800 border dark:border-gray-700 rounded-xl p-5">
            <h3 className="text-sm font-bold text-gray-900 dark:text-white mb-3">Update Ownership Percentage</h3>
            <div className="grid grid-cols-1 md:grid-cols-4 gap-3 items-end">
              <div><label className={labelCls}>Owner</label><select value={historyForm.owner_id} onChange={e => setHistoryForm(p => ({ ...p, owner_id: e.target.value }))} className={inputCls}><option value="">Select...</option>{owners?.filter(o => o.status === 'ACTIVE').map(o => <option key={o.id} value={o.id}>{o.name}</option>)}</select></div>
              <div><label className={labelCls}>New %</label><input type="number" step="0.01" value={historyForm.ownership_percentage} onChange={e => setHistoryForm(p => ({ ...p, ownership_percentage: e.target.value }))} className={inputCls} placeholder="70.00" /></div>
              <div><label className={labelCls}>Effective From</label><input type="date" value={historyForm.effective_from} onChange={e => setHistoryForm(p => ({ ...p, effective_from: e.target.value }))} className={inputCls} /></div>
              <div><label className={labelCls}>Reason *</label><input value={historyForm.change_reason} onChange={e => setHistoryForm(p => ({ ...p, change_reason: e.target.value }))} className={inputCls} placeholder="Why changing?" /></div>
              <button onClick={() => handleAddHistory()} disabled={addHistory.isPending} className="px-4 py-2.5 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm disabled:opacity-50 flex items-center justify-center gap-1">{addHistory.isPending && <Loader2 size={14} className="animate-spin" />} Update</button>
            </div>
            {Math.abs(totalPct - 100) >= 0.01 && <div className="flex items-center gap-2 mt-3 text-xs text-red-600"><AlertCircle size={14} /> Total must equal 100% before distribution can be calculated.</div>}
          </div>
        </div>
      )}

      {/* Tab: Reserve Policy */}
      {tab === 'reserve' && (
        <div className="bg-white dark:bg-gray-800 border dark:border-gray-700 rounded-xl p-5 space-y-4">
          <h3 className="text-sm font-bold text-gray-900 dark:text-white">Reserve Policy Configuration</h3>
          <p className="text-xs text-gray-500 dark:text-gray-400">This determines how much profit is reserved before distribution. These are configuration values, not hardcoded logic.</p>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            {POLICY_TYPES.map(pt => (
              <label key={pt.value} className={`flex items-center gap-3 p-3 border dark:border-gray-700 rounded-lg cursor-pointer transition-colors ${policyForm.policy_type === pt.value ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20' : 'hover:bg-gray-50 dark:hover:bg-gray-700/50'}`}>
                <input type="radio" name="policy_type" value={pt.value} checked={policyForm.policy_type === pt.value} onChange={e => setPolicyForm(p => ({ ...p, policy_type: e.target.value }))} className="w-4 h-4 text-blue-600" />
                <span className="text-sm text-gray-900 dark:text-white">{pt.label}</span>
              </label>
            ))}
          </div>
          <div className="grid grid-cols-3 gap-4">
            {(policyForm.policy_type === 'FIXED_AMOUNT' || policyForm.policy_type === 'HYBRID') && <div><label className={labelCls}>Fixed Amount (PKR)</label><input type="number" value={policyForm.fixed_amount} onChange={e => setPolicyForm(p => ({ ...p, fixed_amount: e.target.value }))} className={inputCls} /></div>}
            {(policyForm.policy_type === 'PERCENT_OF_PROFIT' || policyForm.policy_type === 'PERCENT_OF_PAYOUT' || policyForm.policy_type === 'HYBRID') && <div><label className={labelCls}>Percentage (%)</label><input type="number" step="0.01" value={policyForm.percentage} onChange={e => setPolicyForm(p => ({ ...p, percentage: e.target.value }))} className={inputCls} /></div>}
            {policyForm.policy_type === 'TARGET_BALANCE' && <div><label className={labelCls}>Target Balance (PKR)</label><input type="number" value={policyForm.target_balance} onChange={e => setPolicyForm(p => ({ ...p, target_balance: e.target.value }))} className={inputCls} /></div>}
            <div><label className={labelCls}>Effective From</label><input type="date" value={policyForm.effective_from} onChange={e => setPolicyForm(p => ({ ...p, effective_from: e.target.value }))} className={inputCls} /></div>
          </div>
          <div><label className={labelCls}>Notes</label><textarea value={policyForm.notes} onChange={e => setPolicyForm(p => ({ ...p, notes: e.target.value }))} className={`${inputCls} resize-none`} rows={2} /></div>
          <div className="flex justify-end"><button onClick={handleSavePolicy} disabled={updatePolicy.isPending || createPolicy.isPending} className="px-5 py-2.5 bg-blue-600 hover:bg-blue-700 text-white rounded-xl text-sm disabled:opacity-50 flex items-center gap-2">{(updatePolicy.isPending || createPolicy.isPending) && <Loader2 size={14} className="animate-spin" />} Save Policy</button></div>
        </div>
      )}

      {/* Tab: History */}
      {tab === 'history' && (
        <div className="bg-white dark:bg-gray-800 border dark:border-gray-700 rounded-xl overflow-hidden">
          <div className="p-4 border-b dark:border-gray-700"><h3 className="text-sm font-bold text-gray-900 dark:text-white">Ownership Change History</h3></div>
          {loadingHistory ? <div className="p-8 flex justify-center"><Loader2 className="w-5 h-5 animate-spin" /></div> : !history?.length ? <div className="p-8 text-center text-gray-400 text-sm">No changes recorded</div> : (
            <div className="divide-y dark:divide-gray-700">
              {history.map(h => (
                <div key={h.id} className="px-4 py-3 flex items-center justify-between">
                  <div><span className="text-sm font-medium text-gray-900 dark:text-white">{h.owners?.name || 'Unknown'}</span><span className="ml-3 text-lg font-bold text-blue-600">{h.ownership_percentage}%</span></div>
                  <div className="text-right text-xs text-gray-500"><div>From: {h.effective_from} {h.effective_to && `To: ${h.effective_to}`}</div><div>{h.change_reason}</div></div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Add Owner Modal */}
      {showOwnerModal && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" onClick={e => { if (e.target === e.currentTarget) setShowOwnerModal(false); }}>
          <div className="bg-white dark:bg-gray-800 border dark:border-gray-700 rounded-2xl w-full max-w-md shadow-2xl p-5 space-y-4">
            <h2 className="text-lg font-bold text-gray-900 dark:text-white">Add Owner</h2>
            <div><label className={labelCls}>Name *</label><input value={ownerForm.name} onChange={e => setOwnerForm(p => ({ ...p, name: e.target.value }))} className={inputCls} /></div>
            <div className="grid grid-cols-2 gap-3">
              <div><label className={labelCls}>Partner Class</label><input value={ownerForm.partner_class} onChange={e => setOwnerForm(p => ({ ...p, partner_class: e.target.value }))} className={inputCls} placeholder="e.g., FOUNDING_PARTNER" /></div>
              <div><label className={labelCls}>CNIC</label><input value={ownerForm.cnic_number} onChange={e => setOwnerForm(p => ({ ...p, cnic_number: e.target.value }))} className={`${inputCls} font-mono`} /></div>
            </div>
            {/* ✅ FIXED: contact_info instead of separate fields */}
            <div><label className={labelCls}>Contact Info</label><input value={ownerForm.contact_info} onChange={e => setOwnerForm(p => ({ ...p, contact_info: e.target.value }))} className={inputCls} placeholder="Email, phone, or any contact info" /></div>
            <div className="flex justify-end gap-3"><button onClick={() => setShowOwnerModal(false)} className="px-4 py-2.5 bg-gray-200 dark:bg-gray-700 text-gray-800 dark:text-white rounded-xl text-sm">Cancel</button><button onClick={handleCreateOwner} disabled={createOwner.isPending} className="px-4 py-2.5 bg-blue-600 hover:bg-blue-700 text-white rounded-xl text-sm disabled:opacity-50">{createOwner.isPending ? 'Saving...' : 'Add Owner'}</button></div>
          </div>
        </div>
      )}

      <ReasonModal open={reasonState.open} title={reasonState.title} description="Provide a reason." onConfirm={(reason:any) => { setReasonState({ open: false, title: '', action: '', id: '' }); }} onCancel={() => setReasonState({ open: false, title: '', action: '', id: '' })} />
    </div>
  );
}