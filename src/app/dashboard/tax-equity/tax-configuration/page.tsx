'use client';
import { useState, useEffect } from 'react';
import { useAuth } from '@/context/AuthContext';
import { usePermissions } from '@/hooks/usePermissions';
import {
  useTaxpayerProfile,
  useUpdateTaxpayerProfile,
  useTaxRuleSets,
  useCreateTaxRuleSet,
  useUpdateRuleSetStatus,
  useSaveTaxSlabs,
  useDeleteTaxSlab,
} from '@/hooks/useTaxEquity';
import {
  Plus,
  Pencil,
  Trash2,
  Lock,
  CheckCircle,
  X,
  Loader2,
  Shield,
} from 'lucide-react';

/* ═════════════════════════════════════════════════════
   CONSTANTS
   ═══════════════════════════════════════════════════════ */
const ENTITY_TYPES = [
  'SOLE_PROPRIETOR',
  'AOP',
  'COMPANY',
  'INDIVIDUAL',
];
const TAX_YEAR_BASES = ['JUL_JUN', 'JAN_DEC', 'APR_MAR'];
const TAXPAYER_TYPES = ['SOLE_PROPRIETOR', 'AOP', 'COMPANY', 'INDIVIDUAL'];

const STATUS_STYLES: Record<string, string> = {
  DRAFT: 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300',
  APPROVED: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
  LOCKED: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400',
  SUPERSEDED: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
};

/* ═══════════════════════════════════════════════════════
   HELPERS
   ═══════════════════════════════════════════════════════ */
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

const EMPTY_SLAB = {
  tax_rule_set_id: '',
  slab_name: '',
  income_from: 0,
  income_to: null,
  tax_rate: 0,
  fixed_amount: 0,
  slab_type: 'PROGRESSIVE' as const,
  sort_order: 0,
};

/* ═══════════════════════════════════════════════════════
   TOAST TYPES
   ═══════════════════════════════════════════════════════ */
type ToastType = 'success' | 'error';

interface Toast {
  id: number;
  message: string;
  type: ToastType;
  visible: boolean;
}

/* ═══════════════════════════════════════════════════════
   COMPONENT
   ═══════════════════════════════════════════════════════ */
export default function TaxConfigurationPage() {
  const { user } = useAuth();
  const { hasPermission, isLoading: permLoading } = usePermissions();

  // ── Toast state ──
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toastCounter = useState(0);

  const showToast = (message: string, type: ToastType = 'success') => {
    const id = toastCounter[0] + 1;
    toastCounter[1](id);

    const newToast: Toast = { id, message, type, visible: true };
    setToasts((prev) => [...prev, newToast]);

    // Auto remove after 3.5s
    setTimeout(() => {
      setToasts((prev) =>
        prev.map((t) => (t.id === id ? { ...t, visible: false } : t))
      );
      // Fully remove after fade-out animation
      setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== id));
      }, 400);
    }, 3500);
  };

  // ── Data queries ──
  const { data: profile, isLoading: loadingProfile } = useTaxpayerProfile();
  const updateProfile = useUpdateTaxpayerProfile();
  const {
    data: ruleSets,
    isLoading: loadingRules,
    refetch: refetchRuleSets,
  } = useTaxRuleSets();
  const createRuleSet = useCreateTaxRuleSet();
  const updateRuleStatus = useUpdateRuleSetStatus();
  const saveTaxSlabs = useSaveTaxSlabs();
  const deleteTaxSlab = useDeleteTaxSlab();

  // ── Profile state ──
  const [editingProfile, setEditingProfile] = useState(false);
  const [profileForm, setProfileForm] = useState({
    legal_entity_type: 'AOP',
    ntn_number: '',
    cnic_number: '',
    filing_jurisdiction: 'PAKISTAN',
    default_tax_year_basis: 'JUL_JUN',
    registered_address: '',
    contact_phone: '',
  });

  // ── Rule set state ──
  const [showRuleModal, setShowRuleModal] = useState(false);
  const [editingRuleId, setEditingRuleId] = useState<string | null>(null);
  const [ruleForm, setRuleForm] = useState({
    name: '',
    tax_year: '',
    taxpayer_type: 'AOP',
    jurisdiction: 'PAKISTAN',
  });
  const [slabs, setSlabs] = useState<any[]>([{ ...EMPTY_SLAB }]);
  const [savingSlabs, setSavingSlabs] = useState(false);
  const [ruleSetError, setRuleSetError] = useState('');

  // ── Permission guard ──
  if (permLoading || !hasPermission('TAX_READ')) {
    return (
      <div className="p-6 flex items-center justify-center min-h-[60vh]">
        <p className="text-gray-500 dark:text-gray-400">Access Denied</p>
      </div>
    );
  }

  /* ═════════════════════════════════════════════════════
     PROFILE: Save
     ═════════════════════════════════════════════════════ */
  const handleSaveProfile = () => {
    if (!profile?.id) return;
    updateProfile.mutate(
      { id: profile.id, ...profileForm },
      {
        onSuccess: () => {
          setEditingProfile(false);
          showToast('Taxpayer profile updated successfully');
        },
        onError: (err) => {
          showToast('Failed to update profile: ' + (err.message || 'Unknown error'), 'error');
        },
      }
    );
  };

  /* ═════════════════════════════════════════════════════
     RULE SET: Save (Create + Slabs together)
     ═════════════════════════════════════════════════════ */
  const handleSaveRuleSet = async () => {
    setRuleSetError('');

    if (!ruleForm.name.trim()) {
      setRuleSetError('Rule set name is required');
      return;
    }
    if (!ruleForm.tax_year.trim()) {
      setRuleSetError('Tax year is required');
      return;
    }

    setSavingSlabs(true);

    try {
      let newRuleSetId: string | null = editingRuleId;

      if (!editingRuleId) {
        const { data, error } = await createRuleSet.mutateAsync({
          name: ruleForm.name.trim(),
          tax_year: ruleForm.tax_year.trim(),
          taxpayer_type: ruleForm.taxpayer_type,
          jurisdiction: ruleForm.jurisdiction,
          status: 'DRAFT',
          version: 1,
          created_by: user?.id || '',
        });

        if (error) throw new Error(error.message);
        if (!data) throw new Error('Failed to create rule set');

        newRuleSetId = data.id;
      }

      const validSlabs = slabs.filter(
        (s) => s.income_from > 0 || s.tax_rate > 0
      );

      if (newRuleSetId && validSlabs.length > 0) {
        const slabPayloads = validSlabs.map((s, i) => ({
          tax_rule_set_id: newRuleSetId,
          slab_name: s.slab_name || null,
          income_from: s.income_from,
          income_to: s.income_to || null,
          tax_rate: s.tax_rate,
          fixed_amount: s.fixed_amount,
          slab_type: s.slab_type,
          sort_order: i,
        }));

        const { error: slabError } = await saveTaxSlabs.mutateAsync(slabPayloads);
        if (slabError) throw new Error('Failed to save slabs: ' + slabError.message);
      }

      // ✅ Refetch rule sets so new entry appears immediately
      refetchRuleSets();

      setShowRuleModal(false);
      setSlabs([{ ...EMPTY_SLAB }]);
      setRuleForm({
        name: '',
        tax_year: '',
        taxpayer_type: 'AOP',
        jurisdiction: 'PAKISTAN',
      });

      showToast('Tax rule set saved successfully');
    } catch (err: any) {
      setRuleSetError(err.message || 'Failed to save rule set');
    } finally {
      setSavingSlabs(false);
    }
  };

  /* ═══════════════════════════════════════════════════
     SLAB BUILDER HELPERS
     ═════════════════════════════════════════════════════ */
  const addSlab = () =>
    setSlabs((prev) => [
      ...prev,
      { ...EMPTY_SLAB, sort_order: prev.length },
    ]);

  const removeSlab = (idx: number) => {
    if (slabs.length <= 1) return;
    setSlabs((prev) => prev.filter((_, i) => i !== idx));
  };

  const updateSlab = (idx: number, field: string, value: any) => {
    setSlabs((prev) =>
      prev.map((s, i) => (i === idx ? { ...s, [field]: value } : s))
    );
  };

  /* ═════════════════════════════════════════════════════
     APPROVE / LOCK BUTTON HANDLERS
     ═════════════════════════════════════════════════════ */
  const handleApprove = (rsId: string) => {
    updateRuleStatus.mutate(
      { id: rsId, status: 'APPROVED', userId: user?.id },
      {
        onSuccess: () => {
          // ✅ Refetch to update status from DRAFT → APPROVED
          refetchRuleSets();
          showToast('Rule set approved successfully');
        },
        onError: (err) => {
          console.error('Approve failed:', err);
          showToast('Approve failed: ' + (err.message || 'Unknown error'), 'error');
        },
      }
    );
  };

  const handleLock = (rsId: string) => {
    updateRuleStatus.mutate(
      { id: rsId, status: 'LOCKED', userId: user?.id },
      {
        onSuccess: () => {
          // ✅ Refetch to update status from APPROVED → LOCKED
          refetchRuleSets();
          showToast('Rule set locked — now usable in tax reconciliation');
        },
        onError: (err) => {
          console.error('Lock failed:', err);
          showToast('Lock failed: ' + (err.message || 'Unknown error'), 'error');
        },
      }
    );
  };

  /* ═════════════════════════════════════════════════════
     RENDER
     ═════════════════════════════════════════════════════ */
  return (
    <div className="space-y-6">
      {/* ══════════ TOAST NOTIFICATIONS ══════════ */}
      <div className="fixed bottom-6 right-6 z-[100] flex flex-col gap-3 pointer-events-none">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className={`
              pointer-events-auto flex items-start gap-3 px-5 py-3.5 rounded-xl shadow-2xl border
              max-w-sm backdrop-blur-sm
              transition-all duration-400 ease-out
              ${toast.visible
                ? 'opacity-100 translate-y-0 scale-100'
                : 'opacity-0 translate-y-3 scale-95'
              }
              ${toast.type === 'success'
                ? 'bg-emerald-50 dark:bg-emerald-950/80 border-emerald-200 dark:border-emerald-800/50 text-emerald-800 dark:text-emerald-200'
                : 'bg-red-50 dark:bg-red-950/80 border-red-200 dark:border-red-800/50 text-red-800 dark:text-red-200'
              }
            `}
          >
            <div className={`mt-0.5 flex-shrink-0 ${toast.type === 'success' ? 'text-emerald-500' : 'text-red-500'}`}>
              {toast.type === 'success' ? (
                <CheckCircle size={18} />
              ) : (
                <X size={18} />
              )}
            </div>
            <p className="text-sm font-medium leading-snug">{toast.message}</p>
            <button
              onClick={() => {
                setToasts((prev) =>
                  prev.map((t) => (t.id === toast.id ? { ...t, visible: false } : t))
                );
                setTimeout(() => {
                  setToasts((prev) => prev.filter((t) => t.id !== toast.id));
                }, 400);
              }}
              className="ml-2 mt-0.5 opacity-50 hover:opacity-100 transition-opacity flex-shrink-0"
            >
              <X size={14} />
            </button>
          </div>
        ))}
      </div>

      {/* ── HEADER ── */}
      <div>
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white flex items-center gap-2">
          <Shield className="w-7 h-7 text-purple-600" /> Tax Configuration
        </h1>
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
          Taxpayer profile, rule sets, and tax slab definitions
        </p>
      </div>

      {/* ── TAXPAYER PROFILE CARD ── */}
      <div className="bg-white dark:bg-gray-800 border dark:border-gray-700 rounded-xl p-5">
        <div className="flex justify-between items-center mb-4">
          <h2 className="text-lg font-bold text-gray-900 dark:text-white">
            Taxpayer Profile
          </h2>
          {hasPermission('TAX_MANAGE') && !editingProfile && (
            <button
              onClick={() => {
                setProfileForm({
                  legal_entity_type: profile?.legal_entity_type || 'AOP',
                  ntn_number: profile?.ntn_number || '',
                  cnic_number: profile?.cnic_number || '',
                  filing_jurisdiction: profile?.filing_jurisdiction || 'PAKISTAN',
                  default_tax_year_basis: profile?.default_tax_year_basis || 'JUL_JUN',
                  registered_address: profile?.registered_address || '',
                  contact_phone: profile?.contact_phone || '',
                });
                setEditingProfile(true);
              }}
              className="text-sm text-blue-600 dark:text-blue-400 hover:underline flex items-center gap-1"
            >
              <Pencil size={14} /> Edit
            </button>
          )}
        </div>

        {loadingProfile ? (
          <Loader2 className="w-5 h-5 animate-spin" />
        ) : editingProfile ? (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <label className={labelCls}>Entity Type</label>
              <select
                value={profileForm.legal_entity_type}
                onChange={(e) =>
                  setProfileForm((p) => ({ ...p, legal_entity_type: e.target.value }))
                }
                className={inputCls}
              >
                {ENTITY_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className={labelCls}>NTN Number</label>
              <input
                value={profileForm.ntn_number}
                onChange={(e) =>
                  setProfileForm((p) => ({ ...p, ntn_number: e.target.value }))
                }
                className={`${inputCls} font-mono`}
                placeholder="0000000-0"
              />
            </div>
            <div>
              <label className={labelCls}>CNIC Number</label>
              <input
                value={profileForm.cnic_number}
                onChange={(e) =>
                  setProfileForm((p) => ({ ...p, cnic_number: e.target.value }))
                }
                className={`${inputCls} font-mono`}
                placeholder="00000-0000000-0"
              />
            </div>
            <div>
              <label className={labelCls}>Filing Jurisdiction</label>
              <input
                value={profileForm.filing_jurisdiction}
                onChange={(e) =>
                  setProfileForm((p) => ({ ...p, filing_jurisdiction: e.target.value }))
                }
                className={inputCls}
              />
            </div>
            <div>
              <label className={labelCls}>Tax Year Basis</label>
              <select
                value={profileForm.default_tax_year_basis}
                onChange={(e) =>
                  setProfileForm((p) => ({ ...p, default_tax_year_basis: e.target.value }))
                }
                className={inputCls}
              >
                {TAX_YEAR_BASES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex items-end gap-2">
              <button
                onClick={handleSaveProfile}
                disabled={updateProfile.isPending}
                className="px-4 py-2.5 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm disabled:opacity-50 flex items-center gap-1"
              >
                {updateProfile.isPending && (
                  <Loader2 size={14} className="animate-spin" />
                )}
                Save
              </button>
              <button
                onClick={() => setEditingProfile(false)}
                className="px-4 py-2.5 bg-gray-200 dark:bg-gray-700 text-gray-800 dark:text-white rounded-lg text-sm"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {[
              { label: 'Entity Type', value: profile?.legal_entity_type },
              { label: 'NTN', value: profile?.ntn_number || 'Not set' },
              { label: 'CNIC', value: profile?.cnic_number || 'Not set' },
              { label: 'Tax Year Basis', value: profile?.default_tax_year_basis },
              { label: 'Jurisdiction', value: profile?.filing_jurisdiction },
              { label: 'Tax Status', value: profile?.tax_status },
              { label: 'Approved By', value: profile?.approved_by ? 'Yes' : 'No' },
              {
                label: 'Approved At',
                value: profile?.approved_at
                  ? new Date(profile.approved_at).toLocaleDateString()
                  : 'N/A',
              },
            ].map((item) => (
              <div key={item.label}>
                <p className="text-[10px] uppercase tracking-wider text-gray-400 dark:text-gray-500">
                  {item.label}
                </p>
                <p className="text-sm font-medium text-gray-900 dark:text-white mt-0.5">
                  {item.value}
                </p>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── TAX RULE SETS TABLE ── */}
      <div className="bg-white dark:bg-gray-800 border dark:border-gray-700 rounded-xl overflow-hidden">
        <div className="p-5 border-b dark:border-gray-700 flex justify-between items-center">
          <h2 className="text-lg font-bold text-gray-900 dark:text-white">
            Tax Rule Sets
          </h2>
          {hasPermission('TAX_MANAGE') && (
            <button
              onClick={() => {
                setEditingRuleId(null);
                setRuleForm({
                  name: '',
                  tax_year: '',
                  taxpayer_type: 'AOP',
                  jurisdiction: 'PAKISTAN',
                });
                setSlabs([{ ...EMPTY_SLAB }]);
                setShowRuleModal(true);
              }}
              className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg text-sm font-medium"
            >
              <Plus size={14} /> New Rule Set
            </button>
          )}
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 dark:bg-gray-900/50 text-left text-xs uppercase text-gray-500">
              <tr>
                <th className="px-4 py-3">Name</th>
                <th className="px-4 py-3">Tax Year</th>
                <th className="px-4 py-3">Type</th>
                <th className="px-4 py-3">Version</th>
                <th className="px-4 py-3 text-center">Status</th>
                <th className="px-4 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y dark:divide-gray-700">
              {loadingRules ? (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center">
                    <Loader2 className="w-5 h-5 animate-spin mx-auto" />
                  </td>
                </tr>
              ) : !ruleSets?.length ? (
                <tr>
                  <td colSpan={6} className="px-4 py-12 text-center text-gray-400">
                    No rule sets configured
                  </td>
                </tr>
              ) : (
                ruleSets.map((rs: any) => (
                  <tr
                    key={rs.id}
                    className="hover:bg-gray-50 dark:hover:bg-gray-700/30 transition-colors"
                  >
                    <td className="px-4 py-3 font-medium text-gray-900 dark:text-white">
                      {rs.name}
                    </td>
                    <td className="px-4 py-3 font-mono text-sm">
                      {rs.tax_year}
                    </td>
                    <td className="px-4 py-3 text-gray-500">
                      {rs.taxpayer_type}
                    </td>
                    <td className="px-4 py-3 text-gray-500">
                      v{rs.version}
                    </td>
                    <td className="px-4 py-3 text-center">
                      <span
                        className={`px-2.5 py-0.5 rounded-full text-[11px] font-bold ${
                          STATUS_STYLES[rs.status] || 'bg-gray-100 text-gray-700'
                        }`}
                      >
                        {formatStatus(rs.status)}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex items-center justify-end gap-1">
                        {rs.status === 'DRAFT' && hasPermission('TAX_MANAGE') && (
                          <button
                            onClick={() => handleApprove(rs.id)}
                            disabled={updateRuleStatus.isPending}
                            className="p-1.5 text-green-600 hover:bg-green-50 dark:hover:bg-green-900/20 rounded disabled:opacity-50 flex items-center justify-center"
                            title="Approve this rule set"
                          >
                            {updateRuleStatus.isPending ? (
                              <Loader2 size={15} className="animate-spin" />
                            ) : (
                              <CheckCircle size={15} />
                            )}
                          </button>
                        )}
                        {rs.status === 'APPROVED' && hasPermission('TAX_MANAGE') && (
                          <button
                            onClick={() => handleLock(rs.id)}
                            disabled={updateRuleStatus.isPending}
                            className="p-1.5 text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-900/20 rounded disabled:opacity-50 flex items-center justify-center"
                            title="Lock — prevent further edits"
                          >
                            {updateRuleStatus.isPending ? (
                              <Loader2 size={15} className="animate-spin" />
                            ) : (
                              <Lock size={15} />
                            )}
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* ── RULE SET MODAL WITH SLAB BUILDER ── */}
      {showRuleModal && (
        <div
          className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4"
          onClick={(e) => {
            if (e.target === e.currentTarget) setShowRuleModal(false);
          }}
        >
          <div className="bg-white dark:bg-gray-800 border dark:border-gray-700 rounded-2xl w-full max-w-4xl shadow-2xl max-h-[85vh] flex flex-col">
            {/* Header */}
            <div className="p-5 border-b dark:border-gray-700 flex justify-between items-center shrink-0">
              <h2 className="text-lg font-bold text-gray-900 dark:text-white">
                {editingRuleId ? 'Edit' : 'New'} Tax Rule Set
              </h2>
              <button
                onClick={() => setShowRuleModal(false)}
                className="p-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-500"
              >
                <X size={20} />
              </button>
            </div>

            {/* Body - Scrollable */}
            <div className="p-5 space-y-4 overflow-y-auto flex-1">
              {/* Header fields */}
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div>
                  <label className={labelCls}>
                    Rule Set Name <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="text"
                    value={ruleForm.name}
                    onChange={(e) =>
                      setRuleForm((p) => ({ ...p, name: e.target.value }))
                    }
                    className={inputCls}
                    placeholder="e.g., FY2024-25 AOP Tax Rules"
                  />
                </div>
                <div>
                  <label className={labelCls}>
                    Tax Year <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="text"
                    value={ruleForm.tax_year}
                    onChange={(e) =>
                      setRuleForm((p) => ({ ...p, tax_year: e.target.value }))
                    }
                    className={inputCls}
                    placeholder="2024-25"
                  />
                </div>
                <div>
                  <label className={labelCls}>Taxpayer Type</label>
                  <select
                    value={ruleForm.taxpayer_type}
                    onChange={(e) =>
                      setRuleForm((p) => ({ ...p, taxpayer_type: e.target.value }))
                    }
                    className={inputCls}
                  >
                    {TAXPAYER_TYPES.map((t) => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              {/* Slab Builder */}
              <div>
                <div className="flex justify-between items-center mb-3">
                  <h3 className="font-semibold text-gray-900 dark:text-white">
                    Tax Slabs
                  </h3>
                  <button
                    onClick={addSlab}
                    className="text-sm text-blue-600 dark:text-blue-400 hover:underline flex items-center gap-1"
                  >
                    <Plus size={14} /> Add Slab
                  </button>
                </div>

                {/* Error banner */}
                {ruleSetError && (
                  <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800/30 rounded-lg px-4 py-3 mb-4">
                    <div className="flex items-start gap-2 text-red-600 dark:text-red-400">
                      <X className="w-4 h-4 flex-shrink-0" />
                      <div>
                        <p className="text-sm font-medium">Save Failed</p>
                        <p className="text-xs text-red-500">{ruleSetError}</p>
                      </div>
                    </div>
                  </div>
                )}

                {/* Slab rows */}
                <div className="space-y-2">
                  {slabs.map((slab, idx) => (
                    <div
                      key={idx}
                      className="grid grid-cols-12 gap-2 items-end bg-gray-50 dark:bg-gray-900/30 p-3 rounded-lg"
                    >
                      <div className="col-span-2">
                        <label className="text-[10px] text-gray-400">From</label>
                        <input
                          type="number"
                          min={0}
                          value={slab.income_from}
                          onChange={(e) =>
                            updateSlab(idx, 'income_from', parseFloat(e.target.value) || 0)
                          }
                          className={inputCls}
                        />
                      </div>
                      <div className="col-span-2">
                        <label className="text-[10px] text-gray-400">To (blank=∞)</label>
                        <input
                          type="number"
                          min={0}
                          value={slab.income_to || ''}
                          onChange={(e) =>
                            updateSlab(idx, 'income_to', e.target.value ? parseFloat(e.target.value) : null)
                          }
                          className={inputCls}
                        />
                      </div>
                      <div className="col-span-2">
                        <label className="text-[10px] text-gray-400">Rate %</label>
                        <input
                          type="number"
                          min={0}
                          step="0.01"
                          value={slab.tax_rate}
                          onChange={(e) =>
                            updateSlab(idx, 'tax_rate', parseFloat(e.target.value) || 0)
                          }
                          className={inputCls}
                        />
                      </div>
                      <div className="col-span-2">
                        <label className="text-[10px] text-gray-400">Fixed Amt</label>
                        <input
                          type="number"
                          value={slab.fixed_amount}
                          onChange={(e) =>
                            updateSlab(idx, 'fixed_amount', parseFloat(e.target.value) || 0)
                          }
                          className={inputCls}
                        />
                      </div>
                      <div className="col-span-3">
                        <label className="text-[10px] text-gray-400">Slab Name</label>
                        <input
                          value={slab.slab_name || ''}
                          onChange={(e) => updateSlab(idx, 'slab_name', e.target.value)}
                          className={inputCls}
                          placeholder="e.g., First slab"
                        />
                      </div>
                      <div className="col-span-1 flex justify-center">
                        <button
                          onClick={() => removeSlab(idx)}
                          disabled={slabs.length <= 1}
                          className="p-2 text-red-400 hover:text-red-600 disabled:opacity-30"
                        >
                          <Trash2 size={16} />
                        </button>
                      </div>
                    </div>
                  ))}

                  {/* Total summary */}
                  {slabs.length > 0 && (
                    <div className="bg-gray-50 dark:bg-gray-900/50 border-t dark:border-gray-700 rounded-lg px-4 py-2 mt-3">
                      <div className="flex justify-between text-xs text-gray-500 dark:text-gray-400">
                        <span>Taxable range:</span>
                        <span className="font-mono font-bold text-gray-900 dark:text-white">
                          {formatCurrency(
                            Math.max(...slabs.map((s) => s.income_to || 999999999999)) + 1
                          )}
                        </span>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* Footer */}
            <div className="flex justify-end gap-3 p-5 border-t dark:border-gray-700 shrink-0 bg-white dark:bg-gray-800 rounded-b-2xl">
              <button
                onClick={() => setShowRuleModal(false)}
                className="px-5 py-2.5 bg-gray-200 dark:bg-gray-700 text-gray-800 dark:text-white rounded-xl text-sm font-medium"
              >
                Cancel
              </button>
              <button
                onClick={handleSaveRuleSet}
                disabled={savingSlabs || !ruleForm.name.trim() || !ruleForm.tax_year.trim()}
                className="px-5 py-2.5 bg-blue-600 hover:bg-blue-700 text-white rounded-xl text-sm disabled:opacity-50 flex items-center gap-2"
              >
                {savingSlabs && <Loader2 size={14} className="animate-spin" />}
                Save Rule Set
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}