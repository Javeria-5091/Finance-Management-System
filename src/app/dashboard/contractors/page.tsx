'use client';
// ================================================================
// OSYSTIC Finance Management System — Contractors Page (P1)
// ================================================================
// Spec: Section 5.9 — Payroll, Contractors, Commissions, Team Payables
// Convention: React Query, STATUS_STYLES, react-hot-toast,
//              useAuth/usePermissions, logAudit object pattern
// Route: src/app/dashboard/contractors/page.tsx
// ================================================================

import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '@/context/AuthContext';
import { usePermissions } from '@/context/PermissionContext';
import { useTheme } from '@/context/ThemeContext';
import { logAudit } from '@/lib/logAction';
import {
  useContractorStats,
  useContractors,
  useExpiringContracts,
  useCostByRole,
  useCostByProject,
  useCreateContractor,
  useUpdateContractor,
  useDeleteContractor,
} from '@/hooks/useContractor';
import type {
  ContractorRow,
  ContractorExpirationRow,
  ContractorCostRow,
  ContractorProjectCostRow,
  ContractorFormData,
} from '@/types/contractor.types';
import { ROLES, RATE_TYPES, STATUSES, PAYMENT_TERMS } from '@/types/contractor.types';
import { formatCurrency, formatDate, formatNumber } from '@/lib/helpers';
import {
  Plus, Search, Edit2, Trash2, ChevronLeft, ChevronRight,
  Users, Clock, AlertTriangle, CalendarClock,
  TrendingDown, X, Loader2, Briefcase, UserCheck,
} from 'lucide-react';
import toast from 'react-hot-toast';
import { supabase } from '@/lib/supabase';

// ==========================================
// CONSTANTS
// ==========================================
const STATUS_STYLES: Record<string, string> = {
  ACTIVE: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400',
  ON_HOLD: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400',
  TERMINATED: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
  COMPLETED: 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300',
};

const ROLE_STYLES: Record<string, string> = {
  DEVELOPER: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
  DESIGNER: 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400',
  CONSULTANT: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
  PM: 'bg-cyan-100 text-cyan-700 dark:bg-cyan-900/30 dark:text-cyan-400',
  QA_TESTER: 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400',
  DEVOPS: 'bg-teal-100 text-teal-700 dark:bg-teal-900/30 dark:text-teal-400',
  DATA_ANALYST: 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-400',
  CONTENT_WRITER: 'bg-pink-100 text-pink-700 dark:bg-pink-900/30 dark:text-pink-400',
  OTHER: 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300',
};

const EXPIRY_BUCKET_LABELS: Record<string, string> = {
  EXPIRED: 'Expired',
  '7_DAYS': 'Expiring in 7 Days',
  '30_DAYS': 'Expiring in 30 Days',
  '60_DAYS': 'Expiring in 60 Days',
  '90_DAYS': 'Expiring in 90 Days',
  LATER: 'Later',
};

const EXPIRY_BUCKET_STYLES: Record<string, string> = {
  EXPIRED: 'border-red-300 dark:border-red-800 bg-red-50/50 dark:bg-red-900/10',
  '7_DAYS': 'border-orange-300 dark:border-orange-800 bg-orange-50/50 dark:bg-orange-900/10',
  '30_DAYS': 'border-yellow-300 dark:border-yellow-800 bg-yellow-50/50 dark:bg-yellow-900/10',
  '60_DAYS': 'border-blue-300 dark:border-blue-800 bg-blue-50/50 dark:bg-blue-900/10',
  '90_DAYS': 'border-gray-300 dark:border-gray-700 bg-gray-50/50 dark:bg-gray-900/10',
  LATER: 'border-gray-200 dark:border-gray-700 bg-gray-50/50 dark:bg-gray-900/10',
};

// ==========================================
// MAIN COMPONENT
// ==========================================
export default function ContractorsPage() {
  const { user } = useAuth();
  const { hasPermission } = usePermissions();
  const { isDark } = useTheme();
  const canAdd = hasPermission('CONTRACTOR_CREATE');
  const canUpdate = hasPermission('CONTRACTOR_UPDATE');
  const canDelete = hasPermission('CONTRACTOR_DELETE');

  // ─── Tab ───
  const [activeTab, setActiveTab] = useState<'all' | 'expiring' | 'costs'>('all');

  // ─── Filters ───
  const [search, setSearch] = useState('');
  const [filterRole, setFilterRole] = useState('');
  const [filterStatus, setFilterStatus] = useState('');
  const [page, setPage] = useState(1);
  const perPage = 10;

  // ─── Dialogs ───
  const [showForm, setShowForm] = useState(false);
  const [editingCon, setEditingCon] = useState<ContractorRow | null>(null);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null);

  // ─── Cost sub-tab ───
  const [costView, setCostView] = useState<'role' | 'project'>('role');

  // ─── Projects ───
  const [projects, setProjects] = useState<{ id: string; name: string }[]>([]);

  // ==========================================
  // HOOKS
  // ==========================================
  const { data: stats } = useContractorStats();
  const { data: contractors = [], isLoading: conLoading } = useContractors({
    search: search || undefined,
    role: filterRole || undefined,
    status: filterStatus || undefined,
  });
  const { data: expirations = [], isLoading: expLoading } = useExpiringContracts();
  const { data: costByRole = [] } = useCostByRole();
  const { data: costByProject = [] } = useCostByProject();

  const createMut = useCreateContractor();
  const updateMut = useUpdateContractor();
  const deleteMut = useDeleteContractor();

  // ─── Fetch projects ───
  const fetchProjects = useCallback(async () => {
    const { data } = await supabase.from('projects').select('id, name').order('name');
    setProjects(data || []);
  }, []);

  useEffect(() => { fetchProjects(); }, [fetchProjects]);
  useEffect(() => { setPage(1); }, [search, filterRole, filterStatus]);

  // ==========================================
  // PAGINATION
  // ==========================================
  const totalPages = Math.max(1, Math.ceil(contractors.length / perPage));
  const paginated = contractors.slice((page - 1) * perPage, page * perPage);

  // ─── Expiry buckets ───
  const bucketOrder = ['EXPIRED', '7_DAYS', '30_DAYS', '60_DAYS', '90_DAYS', 'LATER'];
  const grouped: Record<string, ContractorExpirationRow[]> = {};
  for (const bucket of bucketOrder) { grouped[bucket] = []; }
  for (const r of expirations) {
    const b = r.expiry_bucket || 'LATER';
    if (grouped[b]) grouped[b].push(r);
  }

  // ─── Primary currency detection ───
  const primaryCurrency = (() => {
    const counts: Record<string, number> = {};
    for (const c of contractors) {
      if (c.status === 'ACTIVE' && c.currency) {
        counts[c.currency] = (counts[c.currency] || 0) + 1;
      }
    }
    let max = 'PKR', maxCount = 0;
    for (const [cur, cnt] of Object.entries(counts)) {
      if (cnt > maxCount) { max = cur; maxCount = cnt; }
    }
    return max;
  })();

  // ==========================================
  // FORM STATE
  // ==========================================
  const emptyForm: ContractorFormData = {
    name: '', email: '', phone: '', company: '',
    role: 'DEVELOPER', specialization: '',
    rate_type: 'MONTHLY', rate: '', currency: 'PKR',
    contract_start: new Date().toISOString().split('T')[0],
    contract_end: '', project_id: '',
    status: 'ACTIVE', tax_withholding_pct: '0',
    payment_terms: 'NET_30',
    bank_name: '', bank_account: '', notes: '',
  };
  const [form, setForm] = useState<ContractorFormData>(emptyForm);

  function resetForm() { setForm(emptyForm); }

  function openCreate() {
    setEditingCon(null);
    resetForm();
    setShowForm(true);
  }

  function openEdit(con: ContractorRow) {
    setEditingCon(con);
    setForm({
      name: con.name,
      email: con.email || '',
      phone: con.phone || '',
      company: con.company || '',
      role: con.role,
      specialization: con.specialization || '',
      rate_type: con.rate_type,
      rate: String(con.rate),
      currency: con.currency,
      contract_start: con.contract_start || '',
      contract_end: con.contract_end || '',
      project_id: con.project_id || '',
      status: con.status,
      tax_withholding_pct: String(con.tax_withholding_pct),
      payment_terms: con.payment_terms,
      bank_name: con.bank_name || '',
      bank_account: con.bank_account || '',
      notes: con.notes || '',
    });
    setShowForm(true);
  }

  // ==========================================
  // CRUD HANDLERS
  // ==========================================
  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    try {
      if (editingCon) {
        await updateMut.mutateAsync({ id: editingCon.id, updates: form });
        await logAudit.update('contractors', editingCon.id, `Updated contractor: ${form.name}`);
        toast.success('Contractor updated');
      } else {
        await createMut.mutateAsync({ ...form, created_by: user?.id });
        await logAudit.create('contractors', '', `Created contractor: ${form.name}`);
        toast.success('Contractor added');
      }
      setShowForm(false);
      setEditingCon(null);
    } catch (err: any) {
      toast.error(err.message || 'Unknown error');
    }
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    try {
      await deleteMut.mutateAsync(deleteTarget.id);
      await logAudit.delete('contractors', deleteTarget.id, `Deleted contractor: ${deleteTarget.name}`);
      toast.success('Contractor deleted');
    } catch (err: any) {
      toast.error(err.message || 'Unknown error');
    } finally {
      setShowDeleteModal(false);
      setDeleteTarget(null);
    }
  }

  const isLoading = conLoading;

  // ==========================================
  // RENDER
  // ==========================================
  return (
    <div className="space-y-6">
      {/* ─── PAGE HEADER ─── */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className={`text-2xl font-bold ${isDark ? 'text-white' : 'text-gray-900'}`}>Contractors</h1>
          <p className={`text-sm mt-1 ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>Manage contractor engagements, rates, and contract periods</p>
        </div>
        {canAdd && (
          <button onClick={openCreate}
            className="flex items-center gap-2 bg-blue-600 text-white px-4 py-2.5 rounded-lg font-medium text-sm hover:bg-blue-700 transition-colors">
            <Plus className="w-4 h-4" /> Add Contractor
          </button>
        )}
      </div>

      {/* ─── STATS CARDS ─── */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
        {[
          { icon: <Users className="w-5 h-5" />, label: 'Active Contractors', value: String(stats?.activeCount ?? 0), color: 'text-blue-600 dark:text-blue-400', bg: 'bg-blue-100 dark:bg-blue-900/30' },
          { icon: <TrendingDown className="w-5 h-5" />, label: 'Monthly Cost', value: formatCurrency(stats?.normalizedMonthly ?? 0, stats?.topCurrency ?? primaryCurrency), color: 'text-green-600 dark:text-green-400', bg: 'bg-green-100 dark:bg-green-900/30' },
          { icon: <Clock className="w-5 h-5" />, label: 'Annualized Cost', value: formatCurrency(stats?.annualizedTotal ?? 0, stats?.topCurrency ?? primaryCurrency), color: 'text-purple-600 dark:text-purple-400', bg: 'bg-purple-100 dark:bg-purple-900/30' },
          { icon: <CalendarClock className="w-5 h-5" />, label: 'Expiring (30d)', value: String(stats?.expiring30Days ?? 0), color: 'text-amber-600 dark:text-amber-400', bg: 'bg-amber-100 dark:bg-amber-900/30' },
          { icon: <AlertTriangle className="w-5 h-5" />, label: 'Expired', value: String(stats?.expiredCount ?? 0), color: 'text-red-600 dark:text-red-400', bg: 'bg-red-100 dark:bg-red-900/30' },
        ].map((s, i) => (
          <div key={i} className={`rounded-xl p-4 border transition-all ${isDark ? 'bg-gray-900/60 border-gray-800' : 'bg-white border-gray-200 shadow-sm'}`}>
            <div className="flex items-center justify-between mb-2">
              <p className={`text-[10px] uppercase tracking-wider font-bold ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>{s.label}</p>
              <div className={`p-1.5 rounded-lg ${s.bg}`}>{s.icon}</div>
            </div>
            <p className={`text-lg font-extrabold tracking-tight ${s.color}`}>{s.value}</p>
          </div>
        ))}
      </div>

      {/* ─── TABS ─── */}
      <div className={`flex flex-wrap gap-2 border-b pb-2 ${isDark ? 'border-gray-700' : 'border-gray-200'}`}>
        {([
          { key: 'all' as const, label: 'All Contractors' },
          { key: 'expiring' as const, label: 'Expiring Contracts' },
          { key: 'costs' as const, label: 'Cost Summary' },
        ]).map((tab) => (
          <button key={tab.key} onClick={() => setActiveTab(tab.key)}
            className={`px-4 py-2.5 rounded-t-lg text-sm font-medium transition-colors ${
              activeTab === tab.key
                ? isDark ? 'bg-gray-800 text-white border-b-2 border-blue-500' : 'bg-white text-blue-700 border-b-2 border-blue-600'
                : isDark ? 'text-gray-400 hover:text-gray-200' : 'text-gray-500 hover:text-gray-700'
            }`}>
            {tab.label}
          </button>
        ))}
      </div>

      {/* ════════════════════════════════════════════════════════════════════════
          TAB: ALL CONTRACTORS
         ════════════════════════════════════════════════════════════════════════ */}
      {activeTab === 'all' && (
        <div className="space-y-4">
          {/* ─── Filters ─── */}
          <div className={`flex flex-wrap gap-3 p-4 rounded-xl border ${isDark ? 'bg-gray-900/60 border-gray-800' : 'bg-white border-gray-200'}`}>
            <div className="relative flex-1 min-w-[200px]">
              <Search className={`absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 ${isDark ? 'text-gray-500' : 'text-gray-400'}`} />
              <input type="text" placeholder="Search name, company, email..." value={search} onChange={(e) => setSearch(e.target.value)}
                className={`w-full pl-10 pr-4 py-2 rounded-lg text-sm border ${isDark ? 'bg-gray-800 border-gray-700 text-white placeholder-gray-500' : 'bg-gray-50 border-gray-200 text-gray-900 placeholder-gray-400'} focus:outline-none focus:ring-2 focus:ring-blue-500`} />
            </div>
            <select value={filterRole} onChange={(e) => setFilterRole(e.target.value)}
              className={`px-3 py-2 rounded-lg text-sm border ${isDark ? 'bg-gray-800 border-gray-700 text-white' : 'bg-gray-50 border-gray-200 text-gray-900'} focus:outline-none focus:ring-2 focus:ring-blue-500`}>
              <option value="">All Roles</option>
              {ROLES.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
            </select>
            <select value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)}
              className={`px-3 py-2 rounded-lg text-sm border ${isDark ? 'bg-gray-800 border-gray-700 text-white' : 'bg-gray-50 border-gray-200 text-gray-900'} focus:outline-none focus:ring-2 focus:ring-blue-500`}>
              <option value="">All Statuses</option>
              {STATUSES.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
            </select>
          </div>

          {/* ─── Table ─── */}
          {isLoading ? (
            <div className="flex justify-center py-12"><Loader2 className="w-8 h-8 animate-spin text-blue-500" /></div>
          ) : contractors.length === 0 ? (
            <div className={`text-center py-12 rounded-xl border ${isDark ? 'bg-gray-900/40 border-gray-800 text-gray-500' : 'bg-gray-50 border-gray-200 text-gray-400'}`}>
              <Users className="w-12 h-12 mx-auto mb-3 opacity-30" />
              <p className="text-sm">No contractors found</p>
            </div>
          ) : (
            <>
              <div className={`overflow-x-auto rounded-xl border ${isDark ? 'border-gray-800' : 'border-gray-200'}`}>
                <table className="w-full text-sm">
                  <thead>
                    <tr className={isDark ? 'bg-gray-900' : 'bg-gray-50'}>
                      {['Name', 'Role', 'Rate', 'Type', 'Contract', 'Company', 'Status', ''].map(h => (
                        <th key={h} className={`px-4 py-3 text-left font-semibold text-xs uppercase tracking-wider ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className={`divide-y ${isDark ? 'divide-gray-800' : 'divide-gray-100'}`}>
                    {paginated.map((con:any) => (
                      <tr key={con.id} className={`${isDark ? 'hover:bg-gray-900/60' : 'hover:bg-gray-50'} transition-colors`}>
                        <td className={`px-4 py-3 font-medium ${isDark ? 'text-white' : 'text-gray-900'}`}>
                          {con.name}
                          {con.email && <p className={`text-xs mt-0.5 ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>{con.email}</p>}
                        </td>
                        <td className="px-4 py-3">
                          <span className={`px-2.5 py-1 rounded-full text-xs font-medium ${ROLE_STYLES[con.role] || ROLE_STYLES.OTHER}`}>{con.role.replace(/_/g, ' ')}</span>
                        </td>
                        <td className={`px-4 py-3 font-medium ${isDark ? 'text-white' : 'text-gray-900'}`}>{formatCurrency(Number(con.rate), con.currency)}</td>
                        <td className={`px-4 py-3 ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>{con.rate_type.replace(/_/g, ' ')}</td>
                        <td className={`px-4 py-3 ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
                          <p>{con.contract_start ? formatDate(con.contract_start) : '—'}</p>
                          {con.contract_end && <p className={`text-xs ${con.contract_end < new Date().toISOString().split('T')[0] ? 'text-red-500' : 'opacity-70'}`}>→ {formatDate(con.contract_end)}</p>}
                        </td>
                        <td className={`px-4 py-3 ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>{con.company || '—'}</td>
                        <td className="px-4 py-3">
                          <span className={`px-2.5 py-1 rounded-full text-xs font-medium ${STATUS_STYLES[con.status] || ''}`}>{con.status.replace(/_/g, ' ')}</span>
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-1">
                            {canUpdate && (
                              <button onClick={() => openEdit(con)} title="Edit" className={`p-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors ${isDark ? 'text-gray-400 hover:text-blue-400' : 'text-gray-500 hover:text-blue-600'}`}><Edit2 className="w-3.5 h-3.5" /></button>
                            )}
                            {canDelete && (
                              <button onClick={() => { setDeleteTarget({ id: con.id, name: con.name }); setShowDeleteModal(true); }} title="Delete" className={`p-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors ${isDark ? 'text-gray-400 hover:text-red-400' : 'text-gray-500 hover:text-red-600'}`}><Trash2 className="w-3.5 h-3.5" /></button>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* ─── Pagination ─── */}
              {totalPages > 1 && (
                <div className="flex items-center justify-between">
                  <p className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>Showing {(page - 1) * perPage + 1}–{Math.min(page * perPage, contractors.length)} of {contractors.length}</p>
                  <div className="flex gap-1">
                    <button disabled={page <= 1} onClick={() => setPage(page - 1)} className={`p-2 rounded-lg border text-sm ${isDark ? 'border-gray-700 text-gray-300' : 'border-gray-200 text-gray-600'} disabled:opacity-40 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors`}><ChevronLeft className="w-4 h-4" /></button>
                    <span className={`px-3 py-2 text-sm ${isDark ? 'text-gray-300' : 'text-gray-700'}`}>Page {page} of {totalPages}</span>
                    <button disabled={page >= totalPages} onClick={() => setPage(page + 1)} className={`p-2 rounded-lg border text-sm ${isDark ? 'border-gray-700 text-gray-300' : 'border-gray-200 text-gray-600'} disabled:opacity-40 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors`}><ChevronRight className="w-4 h-4" /></button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* ════════════════════════════════════════════════════════════════════════
          TAB: EXPIRING CONTRACTS
         ════════════════════════════════════════════════════════════════════════ */}
      {activeTab === 'expiring' && (
        <div className="space-y-4">
          {expLoading ? (
            <div className="flex justify-center py-12"><Loader2 className="w-8 h-8 animate-spin text-blue-500" /></div>
          ) : expirations.length === 0 ? (
            <div className={`text-center py-12 rounded-xl border ${isDark ? 'bg-gray-900/40 border-gray-800 text-gray-500' : 'bg-gray-50 border-gray-200 text-gray-400'}`}>
              <CalendarClock className="w-12 h-12 mx-auto mb-3 opacity-30" />
              <p className="text-sm">No contracts expiring soon</p>
            </div>
          ) : (
            bucketOrder.map((bucket) => {
              const items = grouped[bucket];
              if (!items || items.length === 0) return null;
              return (
                <div key={bucket} className="space-y-2">
                  <h3 className={`text-sm font-bold uppercase tracking-wider ${
                    bucket === 'EXPIRED' ? 'text-red-600 dark:text-red-400' :
                    bucket === '7_DAYS' ? 'text-orange-600 dark:text-orange-400' :
                    bucket === '30_DAYS' ? 'text-yellow-600 dark:text-yellow-400' :
                    isDark ? 'text-gray-400' : 'text-gray-500'
                  }`}>{EXPIRY_BUCKET_LABELS[bucket]} ({items.length})</h3>
                  <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
                    {items.map((r) => (
                      <div key={r.id} className={`rounded-xl p-4 border ${EXPIRY_BUCKET_STYLES[bucket] || EXPIRY_BUCKET_STYLES.LATER}`}>
                        <div className="flex items-start justify-between mb-2">
                          <div>
                            <p className={`font-semibold text-sm ${isDark ? 'text-white' : 'text-gray-900'}`}>{r.name}</p>
                            <p className={`text-xs mt-0.5 ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>{r.company || 'No company'}</p>
                          </div>
                          <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${ROLE_STYLES[r.role] || ''}`}>{r.role.replace(/_/g, ' ')}</span>
                        </div>
                        <div className={`text-sm space-y-1 ${isDark ? 'text-gray-300' : 'text-gray-600'}`}>
                          <p>{formatCurrency(Number(r.rate), r.currency)} / {r.rate_type.replace(/_/g, ' ')}</p>
                          <p>Contract End: {formatDate(r.contract_end)}</p>
                          {r.days_until_expiry != null && (
                            <p className={r.days_until_expiry < 0 ? 'text-red-600 dark:text-red-400 font-medium' : ''}>
                              {r.days_until_expiry < 0 ? `${Math.abs(r.days_until_expiry)} days expired` : `${r.days_until_expiry} days remaining`}
                            </p>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })
          )}
        </div>
      )}

      {/* ════════════════════════════════════════════════════════════════════════
          TAB: COST SUMMARY
         ════════════════════════════════════════════════════════════════════════ */}
      {activeTab === 'costs' && (
        <div className="space-y-4">
          {/* Sub-tabs */}
          <div className="flex gap-2">
            <button onClick={() => setCostView('role')} className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${costView === 'role' ? (isDark ? 'bg-blue-900/40 text-blue-400 border border-blue-700' : 'bg-blue-100 text-blue-700 border border-blue-300') : (isDark ? 'text-gray-400 hover:text-gray-200' : 'text-gray-500 hover:text-gray-700')}`}>
              <Briefcase className="w-3.5 h-3.5 inline mr-1.5" />By Role
            </button>
            <button onClick={() => setCostView('project')} className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${costView === 'project' ? (isDark ? 'bg-blue-900/40 text-blue-400 border border-blue-700' : 'bg-blue-100 text-blue-700 border border-blue-300') : (isDark ? 'text-gray-400 hover:text-gray-200' : 'text-gray-500 hover:text-gray-700')}`}>
              <UserCheck className="w-3.5 h-3.5 inline mr-1.5" />By Project
            </button>
          </div>

          {costView === 'role' && (
            <div className={`overflow-x-auto rounded-xl border ${isDark ? 'border-gray-800' : 'border-gray-200'}`}>
              <table className="w-full text-sm">
                <thead>
                  <tr className={isDark ? 'bg-gray-900' : 'bg-gray-50'}>
                    {['Role', 'Count', 'Monthly (Norm)', 'Annualized Cost'].map(h => (
                      <th key={h} className={`px-4 py-3 text-left font-semibold text-xs uppercase tracking-wider ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className={`divide-y ${isDark ? 'divide-gray-800' : 'divide-gray-100'}`}>
                  {costByRole.map((row:any) => (
                    <tr key={row.role} className={`${isDark ? 'hover:bg-gray-900/60' : 'hover:bg-gray-50'} transition-colors`}>
                      <td className="px-4 py-3">
                        <span className={`px-2.5 py-1 rounded-full text-xs font-medium ${ROLE_STYLES[row.role] || ROLE_STYLES.OTHER}`}>{row.role.replace(/_/g, ' ')}</span>
                      </td>
                      <td className={`px-4 py-3 ${isDark ? 'text-gray-300' : 'text-gray-700'}`}>{row.contractor_count}</td>
                      <td className={`px-4 py-3 font-medium ${isDark ? 'text-white' : 'text-gray-900'}`}>{formatCurrency(Number(row.normalized_monthly), primaryCurrency)}</td>
                      <td className={`px-4 py-3 font-medium ${isDark ? 'text-white' : 'text-gray-900'}`}>{formatCurrency(Number(row.annualized_cost), primaryCurrency)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {costView === 'project' && (
            <div className={`overflow-x-auto rounded-xl border ${isDark ? 'border-gray-800' : 'border-gray-200'}`}>
              <table className="w-full text-sm">
                <thead>
                  <tr className={isDark ? 'bg-gray-900' : 'bg-gray-50'}>
                    {['Project', 'Contractors', 'Monthly (Norm)', 'Annualized Cost'].map(h => (
                      <th key={h} className={`px-4 py-3 text-left font-semibold text-xs uppercase tracking-wider ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className={`divide-y ${isDark ? 'divide-gray-800' : 'divide-gray-100'}`}>
                  {costByProject.map((row:any) => (
                    <tr key={row.project_id} className={`${isDark ? 'hover:bg-gray-900/60' : 'hover:bg-gray-50'} transition-colors`}>
                      <td className={`px-4 py-3 font-medium ${isDark ? 'text-white' : 'text-gray-900'}`}>{row.project_name}</td>
                      <td className={`px-4 py-3 ${isDark ? 'text-gray-300' : 'text-gray-700'}`}>{row.contractor_count}</td>
                      <td className={`px-4 py-3 font-medium ${isDark ? 'text-white' : 'text-gray-900'}`}>{formatCurrency(Number(row.normalized_monthly), primaryCurrency)}</td>
                      <td className={`px-4 py-3 font-medium ${isDark ? 'text-white' : 'text-gray-900'}`}>{formatCurrency(Number(row.annualized_cost), primaryCurrency)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* ════════════════════════════════════════════════════════════════════════
          CREATE / EDIT FORM MODAL
         ════════════════════════════════════════════════════════════════════════ */}
      {showForm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50" onClick={() => { setShowForm(false); setEditingCon(null); }}>
          <div className={`w-full max-w-2xl max-h-[90vh] overflow-y-auto rounded-2xl shadow-xl ${isDark ? 'bg-gray-900 border border-gray-800' : 'bg-white'}`} onClick={(e) => e.stopPropagation()}>
            <div className={`flex items-center justify-between p-6 border-b ${isDark ? 'border-gray-800' : 'border-gray-200'}`}>
              <h2 className={`text-lg font-bold ${isDark ? 'text-white' : 'text-gray-900'}`}>{editingCon ? 'Edit Contractor' : 'Add Contractor'}</h2>
              <button onClick={() => { setShowForm(false); setEditingCon(null); }} className={`p-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 ${isDark ? 'text-gray-400' : 'text-gray-500'}`}><X className="w-5 h-5" /></button>
            </div>
            <form onSubmit={handleSubmit} className="p-6 space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {/* Name */}
                <div className="md:col-span-2">
                  <label className={`block text-xs font-semibold uppercase tracking-wider mb-1.5 ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>Contractor Name *</label>
                  <input type="text" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })}
                    className={`w-full px-3 py-2 rounded-lg text-sm border ${isDark ? 'bg-gray-800 border-gray-700 text-white' : 'bg-gray-50 border-gray-200 text-gray-900'} focus:outline-none focus:ring-2 focus:ring-blue-500`} placeholder="e.g. Ahmed Khan" />
                </div>
                {/* Email */}
                <div>
                  <label className={`block text-xs font-semibold uppercase tracking-wider mb-1.5 ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>Email</label>
                  <input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })}
                    className={`w-full px-3 py-2 rounded-lg text-sm border ${isDark ? 'bg-gray-800 border-gray-700 text-white' : 'bg-gray-50 border-gray-200 text-gray-900'} focus:outline-none focus:ring-2 focus:ring-blue-500`} placeholder="ahmed@example.com" />
                </div>
                {/* Phone */}
                <div>
                  <label className={`block text-xs font-semibold uppercase tracking-wider mb-1.5 ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>Phone</label>
                  <input type="text" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })}
                    className={`w-full px-3 py-2 rounded-lg text-sm border ${isDark ? 'bg-gray-800 border-gray-700 text-white' : 'bg-gray-50 border-gray-200 text-gray-900'} focus:outline-none focus:ring-2 focus:ring-blue-500`} placeholder="+92 300 1234567" />
                </div>
                {/* Company */}
                <div>
                  <label className={`block text-xs font-semibold uppercase tracking-wider mb-1.5 ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>Company</label>
                  <input type="text" value={form.company} onChange={(e) => setForm({ ...form, company: e.target.value })}
                    className={`w-full px-3 py-2 rounded-lg text-sm border ${isDark ? 'bg-gray-800 border-gray-700 text-white' : 'bg-gray-50 border-gray-200 text-gray-900'} focus:outline-none focus:ring-2 focus:ring-blue-500`} placeholder="e.g. TechVentures" />
                </div>
                {/* Role */}
                <div>
                  <label className={`block text-xs font-semibold uppercase tracking-wider mb-1.5 ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>Role *</label>
                  <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}
                    className={`w-full px-3 py-2 rounded-lg text-sm border ${isDark ? 'bg-gray-800 border-gray-700 text-white' : 'bg-gray-50 border-gray-200 text-gray-900'} focus:outline-none focus:ring-2 focus:ring-blue-500`}>
                    {ROLES.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
                  </select>
                </div>
                {/* Specialization */}
                <div>
                  <label className={`block text-xs font-semibold uppercase tracking-wider mb-1.5 ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>Specialization</label>
                  <input type="text" value={form.specialization} onChange={(e) => setForm({ ...form, specialization: e.target.value })}
                    className={`w-full px-3 py-2 rounded-lg text-sm border ${isDark ? 'bg-gray-800 border-gray-700 text-white' : 'bg-gray-50 border-gray-200 text-gray-900'} focus:outline-none focus:ring-2 focus:ring-blue-500`} placeholder="e.g. React, Next.js" />
                </div>
                {/* Rate */}
                <div>
                  <label className={`block text-xs font-semibold uppercase tracking-wider mb-1.5 ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>Rate *</label>
                  <input type="number" required min="0" step="0.01" value={form.rate} onChange={(e) => setForm({ ...form, rate: e.target.value })}
                    className={`w-full px-3 py-2 rounded-lg text-sm border ${isDark ? 'bg-gray-800 border-gray-700 text-white' : 'bg-gray-50 border-gray-200 text-gray-900'} focus:outline-none focus:ring-2 focus:ring-blue-500`} placeholder="50000" />
                </div>
                {/* Rate Type + Currency */}
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className={`block text-xs font-semibold uppercase tracking-wider mb-1.5 ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>Rate Type *</label>
                    <select value={form.rate_type} onChange={(e) => setForm({ ...form, rate_type: e.target.value })}
                      className={`w-full px-3 py-2 rounded-lg text-sm border ${isDark ? 'bg-gray-800 border-gray-700 text-white' : 'bg-gray-50 border-gray-200 text-gray-900'} focus:outline-none focus:ring-2 focus:ring-blue-500`}>
                      {RATE_TYPES.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className={`block text-xs font-semibold uppercase tracking-wider mb-1.5 ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>Currency *</label>
                    <select value={form.currency} onChange={(e) => setForm({ ...form, currency: e.target.value })}
                      className={`w-full px-3 py-2 rounded-lg text-sm border ${isDark ? 'bg-gray-800 border-gray-700 text-white' : 'bg-gray-50 border-gray-200 text-gray-900'} focus:outline-none focus:ring-2 focus:ring-blue-500`}>
                      <option value="PKR">PKR</option>
                      <option value="USD">USD</option>
                      <option value="EUR">EUR</option>
                      <option value="GBP">GBP</option>
                    </select>
                  </div>
                </div>
                {/* Contract Start + End */}
                <div>
                  <label className={`block text-xs font-semibold uppercase tracking-wider mb-1.5 ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>Contract Start</label>
                  <input type="date" value={form.contract_start} onChange={(e) => setForm({ ...form, contract_start: e.target.value })}
                    className={`w-full px-3 py-2 rounded-lg text-sm border ${isDark ? 'bg-gray-800 border-gray-700 text-white' : 'bg-gray-50 border-gray-200 text-gray-900'} focus:outline-none focus:ring-2 focus:ring-blue-500`} />
                </div>
                <div>
                  <label className={`block text-xs font-semibold uppercase tracking-wider mb-1.5 ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>Contract End</label>
                  <input type="date" value={form.contract_end} onChange={(e) => setForm({ ...form, contract_end: e.target.value })}
                    className={`w-full px-3 py-2 rounded-lg text-sm border ${isDark ? 'bg-gray-800 border-gray-700 text-white' : 'bg-gray-50 border-gray-200 text-gray-900'} focus:outline-none focus:ring-2 focus:ring-blue-500`} />
                </div>
                {/* Project */}
                <div>
                  <label className={`block text-xs font-semibold uppercase tracking-wider mb-1.5 ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>Project</label>
                  <select value={form.project_id} onChange={(e) => setForm({ ...form, project_id: e.target.value })}
                    className={`w-full px-3 py-2 rounded-lg text-sm border ${isDark ? 'bg-gray-800 border-gray-700 text-white' : 'bg-gray-50 border-gray-200 text-gray-900'} focus:outline-none focus:ring-2 focus:ring-blue-500`}>
                    <option value="">No Project</option>
                    {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                </div>
                {/* Status + Payment Terms */}
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className={`block text-xs font-semibold uppercase tracking-wider mb-1.5 ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>Status *</label>
                    <select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}
                      className={`w-full px-3 py-2 rounded-lg text-sm border ${isDark ? 'bg-gray-800 border-gray-700 text-white' : 'bg-gray-50 border-gray-200 text-gray-900'} focus:outline-none focus:ring-2 focus:ring-blue-500`}>
                      {STATUSES.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className={`block text-xs font-semibold uppercase tracking-wider mb-1.5 ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>Payment Terms</label>
                    <select value={form.payment_terms} onChange={(e) => setForm({ ...form, payment_terms: e.target.value })}
                      className={`w-full px-3 py-2 rounded-lg text-sm border ${isDark ? 'bg-gray-800 border-gray-700 text-white' : 'bg-gray-50 border-gray-200 text-gray-900'} focus:outline-none focus:ring-2 focus:ring-blue-500`}>
                      {PAYMENT_TERMS.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
                    </select>
                  </div>
                </div>
                {/* Tax Withholding */}
                <div>
                  <label className={`block text-xs font-semibold uppercase tracking-wider mb-1.5 ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>Tax Withholding %</label>
                  <input type="number" min="0" max="100" step="0.01" value={form.tax_withholding_pct} onChange={(e) => setForm({ ...form, tax_withholding_pct: e.target.value })}
                    className={`w-full px-3 py-2 rounded-lg text-sm border ${isDark ? 'bg-gray-800 border-gray-700 text-white' : 'bg-gray-50 border-gray-200 text-gray-900'} focus:outline-none focus:ring-2 focus:ring-blue-500`} />
                </div>
                {/* Bank Name */}
                <div>
                  <label className={`block text-xs font-semibold uppercase tracking-wider mb-1.5 ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>Bank Name</label>
                  <input type="text" value={form.bank_name} onChange={(e) => setForm({ ...form, bank_name: e.target.value })}
                    className={`w-full px-3 py-2 rounded-lg text-sm border ${isDark ? 'bg-gray-800 border-gray-700 text-white' : 'bg-gray-50 border-gray-200 text-gray-900'} focus:outline-none focus:ring-2 focus:ring-blue-500`} placeholder="HBL, Meezan, etc." />
                </div>
                {/* Bank Account */}
                <div>
                  <label className={`block text-xs font-semibold uppercase tracking-wider mb-1.5 ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>Bank Account / IBAN</label>
                  <input type="text" value={form.bank_account} onChange={(e) => setForm({ ...form, bank_account: e.target.value })}
                    className={`w-full px-3 py-2 rounded-lg text-sm border ${isDark ? 'bg-gray-800 border-gray-700 text-white' : 'bg-gray-50 border-gray-200 text-gray-900'} focus:outline-none focus:ring-2 focus:ring-blue-500`} placeholder="Account number or IBAN" />
                </div>
                {/* Notes */}
                <div className="md:col-span-2">
                  <label className={`block text-xs font-semibold uppercase tracking-wider mb-1.5 ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>Notes</label>
                  <textarea rows={3} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })}
                    className={`w-full px-3 py-2 rounded-lg text-sm border ${isDark ? 'bg-gray-800 border-gray-700 text-white' : 'bg-gray-50 border-gray-200 text-gray-900'} focus:outline-none focus:ring-2 focus:ring-blue-500`} placeholder="Any additional notes..." />
                </div>
              </div>

              {/* Actions */}
              <div className="flex justify-end gap-3 pt-4 border-t ${isDark ? 'border-gray-800' : 'border-gray-200'}">
                <button type="button" onClick={() => { setShowForm(false); setEditingCon(null); }}
                  className={`px-4 py-2 rounded-lg text-sm font-medium border ${isDark ? 'border-gray-700 text-gray-300 hover:bg-gray-800' : 'border-gray-200 text-gray-600 hover:bg-gray-50'} transition-colors`}>
                  Cancel
                </button>
                <button type="submit" disabled={createMut.isPending || updateMut.isPending}
                  className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 transition-colors">
                  {(createMut.isPending || updateMut.isPending) && <Loader2 className="w-4 h-4 animate-spin" />}
                  {editingCon ? 'Update Contractor' : 'Add Contractor'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ════════════════════════════════════════════════════════════════════════
          DELETE CONFIRMATION MODAL
         ════════════════════════════════════════════════════════════════════════ */}
      {showDeleteModal && deleteTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50" onClick={() => { setShowDeleteModal(false); setDeleteTarget(null); }}>
          <div className={`w-full max-w-md rounded-2xl shadow-xl p-6 ${isDark ? 'bg-gray-900 border border-gray-800' : 'bg-white'}`} onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-3 mb-4">
              <div className="p-2 rounded-full bg-red-100 dark:bg-red-900/30"><AlertTriangle className="w-5 h-5 text-red-600 dark:text-red-400" /></div>
              <h3 className={`text-lg font-bold ${isDark ? 'text-white' : 'text-gray-900'}`}>Delete Contractor</h3>
            </div>
            <p className={`text-sm mb-6 ${isDark ? 'text-gray-300' : 'text-gray-600'}`}>
              Are you sure you want to delete <strong>{deleteTarget.name}</strong>? This action cannot be undone.
            </p>
            <div className="flex justify-end gap-3">
              <button onClick={() => { setShowDeleteModal(false); setDeleteTarget(null); }}
                className={`px-4 py-2 rounded-lg text-sm font-medium border ${isDark ? 'border-gray-700 text-gray-300 hover:bg-gray-800' : 'border-gray-200 text-gray-600 hover:bg-gray-50'} transition-colors`}>
                Cancel
              </button>
              <button onClick={handleDelete} disabled={deleteMut.isPending}
                className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium bg-red-600 text-white hover:bg-red-700 disabled:opacity-50 transition-colors">
                {deleteMut.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}