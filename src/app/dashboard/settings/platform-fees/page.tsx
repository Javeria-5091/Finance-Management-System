"use client";
import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/context/AuthContext";
import { usePermissions } from "@/context/PermissionContext";
import { Plus, Pencil, X, Trash2, Save, Building2 } from "lucide-react";
import toast from "react-hot-toast";

const PLATFORM_TYPES = ['PAYMENT_GATEWAY', 'BANK_TRANSFER', 'MARKETPLACE', 'WALLET', 'OTHER'];
const FEE_TYPES = ['PERCENTAGE', 'FIXED', 'TIERED', 'SLAB'];
const APPLIES_TO = ['EXPENSE', 'INVOICE', 'VENDOR_BILL', 'PAYMENT_RECEIPT', 'ALL'];

export default function PlatformFeesPage() {
  const { hasPermission } = usePermissions();
  // FND-ADMIN-PLATFEE-002 FIX: finance.platforms and finance.fee_rules both
  // CHECK (organization_id IS NOT NULL). This page inserts directly via the
  // Supabase client (bypassing the API route), so it must supply
  // organization_id itself — it never did, so every insert here failed.
  const { profile } = useAuth();
  const [platforms, setPlatforms] = useState<any[]>([]);
  const [feeRules, setFeeRules] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [showPlatformForm, setShowPlatformForm] = useState(false);
  const [showFeeForm, setShowFeeForm] = useState(false);
  const [editingPlatform, setEditingPlatform] = useState<any>(null);
  const [editingFee, setEditingFee] = useState<any>(null);
  const [selectedPlatform, setSelectedPlatform] = useState<string | null>(null);

  // Platform form
  const [platForm, setPlatForm] = useState({ name: '', code: '', platform_type: 'PAYMENT_GATEWAY', description: '' });
  // Fee form
  const [feeFormData, setFeeFormData] = useState({ name: '', fee_type: 'PERCENTAGE', fee_value: '', min_fee: '', max_fee: '', applies_to: 'ALL', priority: 0, effective_from: '', effective_to: '' });

  const fetchPlatforms = useCallback(async () => {
    const { data } = await supabase.schema('finance').from('platforms').select('*').order('name');
    if (data) setPlatforms(data);
    setLoading(false);
  }, []);

  const fetchFeeRules = useCallback(async () => {
    if (!selectedPlatform) { setFeeRules([]); return; }
    const { data } = await supabase.schema('finance').from('fee_rules').select('*').eq('platform_id', selectedPlatform).order('priority', { ascending: false });
    if (data) setFeeRules(data);
  }, [selectedPlatform]);

  useEffect(() => { fetchPlatforms(); }, [fetchPlatforms]);
  useEffect(() => { fetchFeeRules(); }, [fetchFeeRules]);

  const canManage = hasPermission('ADMIN_CONFIG') || hasPermission('JOURNAL_UPDATE');

  // ─── Platform CRUD ───
  async function savePlatform() {
    if (!platForm.name.trim() || !platForm.code.trim()) { toast.error('Name and Code required'); return; }
    try {
      if (editingPlatform) {
        const { error } = await supabase.schema('finance').from('platforms').update(platForm).eq('id', editingPlatform.id);
        if (error) throw error;
      } else {
        const { error } = await supabase.schema('finance').from('platforms').insert({ ...platForm, organization_id: profile?.organization_id });
        if (error) throw error;
      }
      toast.success(editingPlatform ? 'Platform updated' : 'Platform created');
      setShowPlatformForm(false); setEditingPlatform(null); setPlatForm({ name: '', code: '', platform_type: 'PAYMENT_GATEWAY', description: '' });
      fetchPlatforms();
    } catch (err: any) { toast.error(err.message); }
  }

  async function togglePlatform(plat: any) {
    const { error } = await supabase.schema('finance').from('platforms').update({ is_active: !plat.is_active }).eq('id', plat.id);
    if (!error) fetchPlatforms(); else toast.error(error.message);
  }

  // ─── Fee Rule CRUD ───
  async function saveFeeRule() {
    if (!feeFormData.name.trim() || !selectedPlatform) { toast.error('Rule name required'); return; }
    try {
      const payload = { ...feeFormData, platform_id: selectedPlatform, fee_value: parseFloat(feeFormData.fee_value) || 0, min_fee: parseFloat(feeFormData.min_fee) || 0, max_fee: parseFloat(feeFormData.max_fee) || 0 };
      if (editingFee) {
        const { error } = await supabase.schema('finance').from('fee_rules').update(payload).eq('id', editingFee.id);
        if (error) throw error;
      } else {
        const { error } = await supabase.schema('finance').from('fee_rules').insert({ ...payload, organization_id: profile?.organization_id });
        if (error) throw error;
      }
      toast.success(editingFee ? 'Fee rule updated' : 'Fee rule created');
      setShowFeeForm(false); setEditingFee(null); setFeeFormData({ name: '', fee_type: 'PERCENTAGE', fee_value: '', min_fee: '', max_fee: '', applies_to: 'ALL', priority: 0, effective_from: '', effective_to: '' });
      fetchFeeRules();
    } catch (err: any) { toast.error(err.message); }
  }

  async function deleteFeeRule(id: string) {
    if (!confirm('Delete this fee rule?')) return;
    const { error } = await supabase.schema('finance').from('fee_rules').delete().eq('id', id);
    if (!error) { toast.success('Deleted'); fetchFeeRules(); } else toast.error(error.message);
  }

  const inputCls = "w-full p-2.5 border dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm";

  return (
    <div className="p-6">
      <div className="flex justify-between mb-6">
        <div>
          <h2 className="text-2xl font-bold text-gray-900 dark:text-white flex items-center gap-2">
            <Building2 className="w-7 h-7 text-blue-600" /> Platform & Fee Directory
          </h2>
          <p className="text-sm text-gray-500 mt-1">Manage payment channels and their fee rules</p>
        </div>
        {canManage && (
          <button onClick={() => { setEditingPlatform(null); setPlatForm({ name: '', code: '', platform_type: 'PAYMENT_GATEWAY', description: '' }); setShowPlatformForm(true); }}
            className="flex items-center gap-2 bg-blue-600 text-white px-4 py-2.5 rounded-lg font-medium">
            <Plus size={18} /> Add Platform
          </button>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* LEFT: Platform List */}
        <div className="bg-white dark:bg-gray-800 border dark:border-gray-700 rounded-xl overflow-hidden">
          <div className="p-4 border-b dark:border-gray-700 font-semibold text-gray-700 dark:text-gray-300">Payment Channels ({platforms.length})</div>
          <div className="divide-y dark:divide-gray-700 max-h-[500px] overflow-y-auto">
            {loading ? <div className="p-8 text-center text-gray-400">Loading...</div> :
              platforms.length === 0 ? <div className="p-8 text-center text-gray-400">No platforms</div> :
              platforms.map(p => (
                <div key={p.id} onClick={() => setSelectedPlatform(p.id)}
                  className={`p-4 cursor-pointer transition-colors flex items-center justify-between ${selectedPlatform === p.id ? 'bg-blue-50 dark:bg-blue-500/10 border-l-4 border-l-blue-600' : 'hover:bg-gray-50 dark:hover:bg-gray-700/50'}`}>
                  <div>
                    <div className="font-medium text-gray-900 dark:text-white">{p.name}</div>
                    <div className="text-xs text-gray-500 mt-0.5">{p.code} &middot; {p.platform_type}</div>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className={`px-2 py-0.5 rounded text-xs ${p.is_active ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'}`}>{p.is_active ? 'Active' : 'Inactive'}</span>
                    {canManage && <>
                      <button onClick={e => { e.stopPropagation(); togglePlatform(p); }} className="p-1 text-gray-400 hover:text-yellow-600 rounded"><Pencil size={14} /></button>
                      <button onClick={e => { e.stopPropagation(); setEditingPlatform(p); setPlatForm(p); setShowPlatformForm(true); }} className="p-1 text-gray-400 hover:text-blue-600 rounded"><Pencil size={14} /></button>
                    </>}
                  </div>
                </div>
              ))}
          </div>
        </div>

        {/* RIGHT: Fee Rules for selected platform */}
        <div className="bg-white dark:bg-gray-800 border dark:border-gray-700 rounded-xl overflow-hidden">
          <div className="p-4 border-b dark:border-gray-700 flex items-center justify-between">
            <div className="font-semibold text-gray-700 dark:text-gray-300">
              Fee Rules {selectedPlatform ? `(${feeRules.length})` : ''}
            </div>
            {canManage && selectedPlatform && (
              <button onClick={() => { setEditingFee(null); setFeeFormData({ name: '', fee_type: 'PERCENTAGE', fee_value: '', min_fee: '', max_fee: '', applies_to: 'ALL', priority: 0, effective_from: '', effective_to: '' }); setShowFeeForm(true); }}
                className="text-xs text-blue-600 hover:underline">+ Add Rule</button>
            )}
          </div>
          {!selectedPlatform ? <div className="p-8 text-center text-gray-400">Select a platform to view fee rules</div> :
            feeRules.length === 0 ? <div className="p-8 text-center text-gray-400">No fee rules for this platform</div> :
            <div className="divide-y dark:divide-gray-700 max-h-[500px] overflow-y-auto">
              {feeRules.map(r => (
                <div key={r.id} className="p-4">
                  <div className="flex items-center justify-between">
                    <div className="font-medium text-gray-900 dark:text-white text-sm">{r.name}</div>
                    <div className="flex items-center gap-2">
                      <span className={`px-2 py-0.5 rounded text-xs ${r.is_active ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'}`}>{r.is_active ? 'Active' : 'Inactive'}</span>
                      {canManage && (
                        <button onClick={() => deleteFeeRule(r.id)} className="p-1 text-gray-400 hover:text-red-600 rounded"><Trash2 size={14} /></button>
                      )}
                    </div>
                  </div>
                  <div className="text-xs text-gray-500 mt-1">
                    Type: <strong>{r.fee_type}</strong> &middot; Value: <strong>{r.fee_type === 'PERCENTAGE' ? r.fee_value + '%' : 'PKR ' + r.fee_value}</strong>
                    {r.min_fee > 0 && <> &middot; Min: PKR {r.min_fee}</>}
                    {r.max_fee > 0 && <> &middot; Cap: PKR {r.max_fee}</>}
                    &middot; Applies: {r.applies_to}
                  </div>
                </div>
              ))}
            </div>
          }
        </div>
      </div>

      {/* Platform Form Modal */}
      {showPlatformForm && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
          <div className="bg-white dark:bg-gray-800 rounded-xl w-full max-w-md p-6 border dark:border-gray-700">
            <div className="flex justify-between mb-4">
              <h3 className="text-lg font-bold text-gray-900 dark:text-white">{editingPlatform ? 'Edit' : 'Add'} Platform</h3>
              <button onClick={() => setShowPlatformForm(false)}><X size={18} className="text-gray-500" /></button>
            </div>
            <div className="space-y-3">
              <input placeholder="Name *" value={platForm.name} onChange={e => setPlatForm({ ...platForm, name: e.target.value })} className={inputCls} />
              <input placeholder="Code * (e.g., JAZZCASH)" value={platForm.code} onChange={e => setPlatForm({ ...platForm, code: e.target.value.toUpperCase().replace(/\s/g, '_') })} className={inputCls} disabled={!!editingPlatform} />
              <select value={platForm.platform_type} onChange={e => setPlatForm({ ...platForm, platform_type: e.target.value })} className={inputCls}>
                {PLATFORM_TYPES.map(t => <option key={t} value={t}>{t.replace(/_/g, ' ')}</option>)}
              </select>
              <textarea placeholder="Description" value={platForm.description} onChange={e => setPlatForm({ ...platForm, description: e.target.value })} className={inputCls + ' resize-none'} rows={2} />
            </div>
            <div className="flex justify-end gap-2 mt-4">
              <button onClick={() => setShowPlatformForm(false)} className="px-4 py-2 bg-gray-200 dark:bg-gray-700 rounded-lg text-sm">Cancel</button>
              <button onClick={savePlatform} className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm">Save</button>
            </div>
          </div>
        </div>
      )}

      {/* Fee Rule Form Modal */}
      {showFeeForm && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
          <div className="bg-white dark:bg-gray-800 rounded-xl w-full max-w-md p-6 border dark:border-gray-700 max-h-[90vh] overflow-y-auto">
            <div className="flex justify-between mb-4">
              <h3 className="text-lg font-bold text-gray-900 dark:text-white">{editingFee ? 'Edit' : 'Add'} Fee Rule</h3>
              <button onClick={() => setShowFeeForm(false)}><X size={18} className="text-gray-500" /></button>
            </div>
            <div className="space-y-3">
              <input placeholder="Rule Name *" value={feeFormData.name} onChange={e => setFeeFormData({ ...feeFormData, name: e.target.value })} className={inputCls} />
              <div className="grid grid-cols-2 gap-3">
                <select value={feeFormData.fee_type} onChange={e => setFeeFormData({ ...feeFormData, fee_type: e.target.value })} className={inputCls}>
                  {FEE_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                </select>
                <select value={feeFormData.applies_to} onChange={e => setFeeFormData({ ...feeFormData, applies_to: e.target.value })} className={inputCls}>
                  {APPLIES_TO.map(a => <option key={a} value={a}>{a}</option>)}
                </select>
              </div>
              <div className="grid grid-cols-3 gap-3">
                <input type="number" placeholder="Fee Value *" value={feeFormData.fee_value} onChange={e => setFeeFormData({ ...feeFormData, fee_value: e.target.value })} className={inputCls} />
                <input type="number" placeholder="Min Fee" value={feeFormData.min_fee} onChange={e => setFeeFormData({ ...feeFormData, min_fee: e.target.value })} className={inputCls} />
                <input type="number" placeholder="Max Cap" value={feeFormData.max_fee} onChange={e => setFeeFormData({ ...feeFormData, max_fee: e.target.value })} className={inputCls} />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <input type="number" placeholder="Priority" value={feeFormData.priority} onChange={e => setFeeFormData({ ...feeFormData, priority: parseInt(e.target.value) || 0 })} className={inputCls} />
                <input type="date" placeholder="Effective From" value={feeFormData.effective_from} onChange={e => setFeeFormData({ ...feeFormData, effective_from: e.target.value })} className={inputCls} />
              </div>
            </div>
            <div className="flex justify-end gap-2 mt-4">
              <button onClick={() => setShowFeeForm(false)} className="px-4 py-2 bg-gray-200 dark:bg-gray-700 rounded-lg text-sm">Cancel</button>
              <button onClick={saveFeeRule} className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm flex items-center gap-1"><Save size={14} /> Save</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}