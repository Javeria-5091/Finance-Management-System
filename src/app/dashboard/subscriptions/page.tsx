'use client';
// ================================================================
// OSYSTIC Finance Management System — Subscriptions Page (P1)
// ================================================================
// Spec: Section 5.11 — Recurring Costs, Subscriptions, Commitments
// Convention: P0/P1 — React Query, STATUS_STYLES, react-hot-toast,
//              useAuth/usePermissions, logAudit object pattern
// Route: src/app/dashboard/subscriptions/page.tsx
// ================================================================

import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '@/context/AuthContext';
import { usePermissions } from '@/context/PermissionContext';
import { useTheme } from '@/context/ThemeContext';
import { logAudit } from '@/lib/logAction';
import {
  useSubscriptionStats,
  useSubscriptions,
  useUpcomingRenewals,
  useSpendSummary,
  useCreateSubscription,
  useUpdateSubscription,
  useDeleteSubscription,
} from '@/hooks/useSubscriptions';
import { getAnnualMultiplier } from '@/services/subscription.service';
import type {
  SubscriptionRow,
  SubscriptionRenewalRow,
  SubscriptionSpendRow,
  SubscriptionFormData,
} from '@/types/subscription.types';
import { formatCurrency, formatDate, formatNumber } from '@/lib/helpers';
import {
  Plus, Search, Edit2, Trash2, ChevronLeft, ChevronRight,
  CreditCard, Clock, AlertTriangle, CalendarClock,
  TrendingDown, X, Check, Loader2, Pause, Play, RefreshCw,
} from 'lucide-react';
import toast from 'react-hot-toast';
import { supabase } from '@/lib/supabase';

// ==========================================
// CONSTANTS
// ==========================================
const STATUS_STYLES: Record<string, string> = {
  ACTIVE: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400',
  PAUSED: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400',
  CANCELLED: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
  EXPIRED: 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300',
  PENDING_SETUP: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
};

const CATEGORY_STYLES: Record<string, string> = {
  HOSTING: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
  DOMAIN: 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400',
  AI_API: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
  DATABASE: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400',
  EMAIL: 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400',
  INTERNET: 'bg-cyan-100 text-cyan-700 dark:bg-cyan-900/30 dark:text-cyan-400',
  RENT: 'bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-400',
  UTILITIES: 'bg-teal-100 text-teal-700 dark:bg-teal-900/30 dark:text-teal-400',
  SOFTWARE: 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-400',
  HARDWARE: 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300',
  INSURANCE: 'bg-pink-100 text-pink-700 dark:bg-pink-900/30 dark:text-pink-400',
  MEMBERSHIP: 'bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-400',
  CLOUD_STORAGE: 'bg-sky-100 text-sky-700 dark:bg-sky-900/30 dark:text-sky-400',
  CRM: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400',
  PROJECT_MANAGEMENT: 'bg-lime-100 text-lime-700 dark:bg-lime-900/30 dark:text-lime-400',
  COMMUNICATION: 'bg-fuchsia-100 text-fuchsia-700 dark:bg-fuchsia-900/30 dark:text-fuchsia-400',
  SECURITY: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
  OTHER: 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300',
};

const RENEWAL_BUCKET_STYLES: Record<string, string> = {
  OVERDUE: 'border-l-4 border-red-500 bg-red-50 dark:bg-red-900/10',
  '7_DAYS': 'border-l-4 border-orange-500 bg-orange-50 dark:bg-orange-900/10',
  '30_DAYS': 'border-l-4 border-yellow-500 bg-yellow-50 dark:bg-yellow-900/10',
  '60_DAYS': 'border-l-4 border-blue-500 bg-blue-50 dark:bg-blue-900/10',
  '90_DAYS': 'border-l-4 border-gray-400 bg-gray-50 dark:bg-gray-800/50',
  LATER: 'border-l-4 border-gray-300 bg-white dark:bg-gray-800',
};

const RENEWAL_BUCKET_LABELS: Record<string, string> = {
  OVERDUE: 'Overdue',
  '7_DAYS': 'Within 7 Days',
  '30_DAYS': 'Within 30 Days',
  '60_DAYS': 'Within 60 Days',
  '90_DAYS': 'Within 90 Days',
  LATER: 'Later',
};

const CATEGORIES = [
  { value: 'HOSTING', label: 'Hosting' },
  { value: 'DOMAIN', label: 'Domain' },
  { value: 'AI_API', label: 'AI / API' },
  { value: 'DATABASE', label: 'Database' },
  { value: 'EMAIL', label: 'Email' },
  { value: 'INTERNET', label: 'Internet' },
  { value: 'RENT', label: 'Rent' },
  { value: 'UTILITIES', label: 'Utilities' },
  { value: 'SOFTWARE', label: 'Software' },
  { value: 'HARDWARE', label: 'Hardware' },
  { value: 'INSURANCE', label: 'Insurance' },
  { value: 'MEMBERSHIP', label: 'Membership' },
  { value: 'CLOUD_STORAGE', label: 'Cloud Storage' },
  { value: 'CRM', label: 'CRM' },
  { value: 'PROJECT_MANAGEMENT', label: 'Project Mgmt' },
  { value: 'COMMUNICATION', label: 'Communication' },
  { value: 'SECURITY', label: 'Security' },
  { value: 'OTHER', label: 'Other' },
];

const BILLING_FREQUENCIES = [
  { value: 'WEEKLY', label: 'Weekly' },
  { value: 'MONTHLY', label: 'Monthly' },
  { value: 'QUARTERLY', label: 'Quarterly' },
  { value: 'SEMI_ANNUALLY', label: 'Semi-Annually' },
  { value: 'ANNUALLY', label: 'Annually' },
  { value: 'BIENNIAL', label: 'Biennial' },
  { value: 'ONE_TIME', label: 'One-Time' },
];

const STATUSES = [
  { value: 'ACTIVE', label: 'Active' },
  { value: 'PAUSED', label: 'Paused' },
  { value: 'CANCELLED', label: 'Cancelled' },
  { value: 'EXPIRED', label: 'Expired' },
  { value: 'PENDING_SETUP', label: 'Pending Setup' },
];

// ==========================================
// MAIN COMPONENT
// ==========================================
export default function SubscriptionsPage() {
  const { user } = useAuth();
  const { hasPermission } = usePermissions();
  const { isDark } = useTheme();
  const canAdd = hasPermission('SUBSCRIPTION_CREATE');
  const canUpdate = hasPermission('SUBSCRIPTION_UPDATE');
  const canDelete = hasPermission('SUBSCRIPTION_DELETE');

  // ─── Tab ───
  const [activeTab, setActiveTab] = useState<'all' | 'renewals' | 'spend'>('all');

  // ─── Filters ───
  const [search, setSearch] = useState('');
  const [filterCategory, setFilterCategory] = useState('');
  const [filterStatus, setFilterStatus] = useState('');
  const [page, setPage] = useState(1);
  const perPage = 10;

  // ─── Dialogs ───
  const [showForm, setShowForm] = useState(false);
  const [editingSub, setEditingSub] = useState<SubscriptionRow | null>(null);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null);

  // ─── Projects ───
  const [projects, setProjects] = useState<{ id: string; name: string }[]>([]);

  // ==========================================
  // HOOKS
  // ==========================================
  const { data: stats } = useSubscriptionStats();
  const { data: subscriptions = [], isLoading: subLoading } = useSubscriptions({
    search: search || undefined,
    category: filterCategory || undefined,
    status: filterStatus || undefined,
  });
  const { data: renewals = [], isLoading: renLoading } = useUpcomingRenewals();
  const { data: spendData = [], isLoading: spendLoading } = useSpendSummary();

  const createMut = useCreateSubscription();
  const updateMut = useUpdateSubscription();
  const deleteMut = useDeleteSubscription();

  // ─── Fetch projects ───
  const fetchProjects = useCallback(async () => {
    const { data } = await supabase.from('projects').select('id, name').order('name');
    setProjects(data || []);
  }, []);

  useEffect(() => { fetchProjects(); }, [fetchProjects]);
  useEffect(() => { setPage(1); }, [search, filterCategory, filterStatus]);

  // ==========================================
  // PAGINATION
  // ==========================================
  const totalPages = Math.max(1, Math.ceil(subscriptions.length / perPage));
  const paginated = subscriptions.slice((page - 1) * perPage, page * perPage);

  // ─── Renewal buckets ───
  const bucketOrder = ['OVERDUE', '7_DAYS', '30_DAYS', '60_DAYS', '90_DAYS', 'LATER'];
  const grouped: Record<string, SubscriptionRenewalRow[]> = {};
  for (const bucket of bucketOrder) { grouped[bucket] = []; }
  for (const r of renewals) {
    const b = r.renewal_bucket || 'LATER';
    if (grouped[b]) grouped[b].push(r);
  }

  // ─── Spend totals ───
  const totalAnnualSpend = spendData.reduce((s, r) => s + Number(r.annualized_amount), 0);
  const totalMonthlyNormalized = spendData.reduce((s, r) => s + Number(r.normalized_monthly), 0);

  // ─── Primary currency detection (most common currency in active subs) ───
  const primaryCurrency = (() => {
    const counts: Record<string, number> = {};
    for (const sub of subscriptions) {
      if (sub.status === 'ACTIVE' && sub.currency) {
        counts[sub.currency] = (counts[sub.currency] || 0) + 1;
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
  const emptyForm: SubscriptionFormData = {
    name: '', vendor: '', category: 'SOFTWARE', amount: '',
    currency: 'PKR', billing_frequency: 'MONTHLY',
    start_date: new Date().toISOString().split('T')[0],
    renewal_date: '', cancellation_notice_days: '30',
    auto_renew: true, project_id: '', owner: '',
    status: 'ACTIVE', notes: '',
  };
  const [form, setForm] = useState<SubscriptionFormData>(emptyForm);

  function resetForm() {
    setForm(emptyForm);
  }

  function openCreate() {
    setEditingSub(null);
    resetForm();
    setShowForm(true);
  }

  function openEdit(sub: SubscriptionRow) {
    setEditingSub(sub);
    setForm({
      name: sub.name,
      vendor: sub.vendor || '',
      category: sub.category,
      amount: String(sub.amount),
      currency: sub.currency,
      billing_frequency: sub.billing_frequency,
      start_date: sub.start_date,
      renewal_date: sub.renewal_date || '',
      cancellation_notice_days: String(sub.cancellation_notice_days),
      auto_renew: sub.auto_renew,
      project_id: sub.project_id || '',
      owner: sub.owner || '',
      status: sub.status,
      notes: sub.notes || '',
    });
    setShowForm(true);
  }

  // ==========================================
  // CRUD HANDLERS
  // FIX #3: Use logAudit object methods directly, not the broken safeAudit wrapper
  // ==========================================
  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    try {
      if (editingSub) {
        await updateMut.mutateAsync({ id: editingSub.id, updates: { ...form } });
        logAudit.update('subscriptions', editingSub.id, `Updated subscription: ${form.name}`);
        toast.success('Subscription updated');
      } else {
        await createMut.mutateAsync({ ...form, created_by: user?.id });
        logAudit.create('subscriptions', '', `Created subscription: ${form.name}`);
        toast.success('Subscription created');
      }
      setShowForm(false);
      setEditingSub(null);
      resetForm();
    } catch (err: any) {
      toast.error('Error: ' + (err.message || 'Unknown'));
    }
  }

  async function handleTogglePause(sub: SubscriptionRow) {
    const newStatus = sub.status === 'PAUSED' ? 'ACTIVE' : 'PAUSED';
    try {
      await updateMut.mutateAsync({ id: sub.id, updates: { status: newStatus } });
      logAudit.update('subscriptions', sub.id, `${newStatus === 'PAUSED' ? 'Paused' : 'Resumed'}: ${sub.name}`);
      toast.success(`Subscription ${newStatus === 'PAUSED' ? 'paused' : 'resumed'}`);
    } catch (err: any) {
      toast.error('Error: ' + (err.message || 'Unknown'));
    }
  }

  async function handleMarkRenewed(sub: SubscriptionRenewalRow) {
    const freq = sub.billing_frequency;
    let nextDate: Date | null = null;
    if (sub.renewal_date) {
      const current = new Date(sub.renewal_date);
      switch (freq) {
        case 'WEEKLY':
          nextDate = new Date(current.getTime() + 7 * 86400000);
          break;
        case 'MONTHLY':
          nextDate = new Date(current.getFullYear(), current.getMonth() + 1, current.getDate());
          break;
        case 'QUARTERLY':
          nextDate = new Date(current.getFullYear(), current.getMonth() + 3, current.getDate());
          break;
        case 'SEMI_ANNUALLY':
          nextDate = new Date(current.getFullYear(), current.getMonth() + 6, current.getDate());
          break;
        case 'ANNUALLY':
          nextDate = new Date(current.getFullYear() + 1, current.getMonth(), current.getDate());
          break;
        case 'BIENNIAL':
          nextDate = new Date(current.getFullYear() + 2, current.getMonth(), current.getDate());
          break;
        default:
          nextDate = null;
      }
    }
    try {
      await updateMut.mutateAsync({
        id: sub.id,
        updates: { renewal_date: nextDate ? nextDate.toISOString().split('T')[0] : null },
      });
      logAudit.update('subscriptions', sub.id, `Marked as renewed: ${sub.name}`);
      toast.success('Renewal date updated');
    } catch (err: any) {
      toast.error('Error: ' + (err.message || 'Unknown'));
    }
  }

  function confirmDelete() {
    if (!deleteTarget) return;
    deleteMut.mutate(deleteTarget.id, {
      onSuccess: () => {
        logAudit.delete('subscriptions', deleteTarget.id, `Deleted: ${deleteTarget.name}`);
        toast.success(`${deleteTarget.name} deleted`);
        setShowDeleteModal(false);
        setDeleteTarget(null);
      },
      onError: (err: any) => toast.error('Delete failed: ' + (err.message || 'Unknown')),
    });
  }

  // ==========================================
  // RENDER
  // ==========================================
  const isMutLoading = createMut.isPending || updateMut.isPending;
  const isLoading = subLoading || renLoading || spendLoading;

  return (
    <div className="space-y-6">
      {/* ─── HEADER ─── */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className={`text-2xl font-bold ${isDark ? 'text-white' : 'text-gray-900'}`}>Subscriptions & Recurring Costs</h1>
          <p className={`text-sm mt-1 ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
            Track renewals, prevent missed payments, monitor annualized spend
          </p>
        </div>
        {canAdd && (
          <button onClick={openCreate}
            className="flex items-center gap-2 bg-blue-600 text-white px-4 py-2.5 rounded-lg font-medium text-sm hover:bg-blue-700 transition-colors">
            <Plus className="w-4 h-4" /> Add Subscription
          </button>
        )}
      </div>

      {/* ─── STATS CARDS ─── */}
      {/* FIX #5: Inline stat cards matching the project's visual style, not a non-existent StatCard component */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
        {[
          { icon: <CreditCard className="w-5 h-5" />, label: 'Active Subscriptions', value: String(stats?.activeCount ?? 0), color: 'text-blue-600 dark:text-blue-400', bg: 'bg-blue-100 dark:bg-blue-900/30' },
          { icon: <TrendingDown className="w-5 h-5" />, label: 'Monthly (Normalized)', value: formatCurrency(stats?.normalizedMonthly ?? 0, primaryCurrency), color: 'text-green-600 dark:text-green-400', bg: 'bg-green-100 dark:bg-green-900/30' },
          { icon: <Clock className="w-5 h-5" />, label: 'Annualized Total', value: formatCurrency(stats?.annualizedTotal ?? 0, primaryCurrency), color: 'text-purple-600 dark:text-purple-400', bg: 'bg-purple-100 dark:bg-purple-900/30' },
          { icon: <CalendarClock className="w-5 h-5" />, label: 'Renewals (30 Days)', value: String(stats?.upcoming30Days ?? 0), color: 'text-amber-600 dark:text-amber-400', bg: 'bg-amber-100 dark:bg-amber-900/30' },
          { icon: <AlertTriangle className="w-5 h-5" />, label: 'Overdue', value: String(stats?.overdueCount ?? 0), color: 'text-red-600 dark:text-red-400', bg: 'bg-red-100 dark:bg-red-900/30' },
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
          { key: 'all' as const, label: 'All Subscriptions' },
          { key: 'renewals' as const, label: 'Upcoming Renewals' },
          { key: 'spend' as const, label: 'Spend Summary' },
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
          TAB: ALL SUBSCRIPTIONS
         ════════════════════════════════════════════════════════════════════════ */}
      {activeTab === 'all' && (
        <div className="space-y-4">
          {/* ─── Filters ─── */}
          <div className={`flex flex-wrap gap-3 p-4 rounded-xl border ${isDark ? 'bg-gray-900/60 border-gray-800' : 'bg-white border-gray-200'}`}>
            <div className="relative flex-1 min-w-[200px]">
              <Search className={`absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 ${isDark ? 'text-gray-500' : 'text-gray-400'}`} />
              <input type="text" placeholder="Search name, vendor..." value={search} onChange={(e) => setSearch(e.target.value)}
                className={`w-full pl-10 pr-4 py-2 rounded-lg text-sm border ${isDark ? 'bg-gray-800 border-gray-700 text-white placeholder-gray-500' : 'bg-gray-50 border-gray-200 text-gray-900 placeholder-gray-400'} focus:outline-none focus:ring-2 focus:ring-blue-500`} />
            </div>
            <select value={filterCategory} onChange={(e) => setFilterCategory(e.target.value)}
              className={`px-3 py-2 rounded-lg text-sm border ${isDark ? 'bg-gray-800 border-gray-700 text-white' : 'bg-gray-50 border-gray-200 text-gray-900'} focus:outline-none focus:ring-2 focus:ring-blue-500`}>
              <option value="">All Categories</option>
              {CATEGORIES.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
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
          ) : subscriptions.length === 0 ? (
            <div className={`text-center py-12 rounded-xl border ${isDark ? 'bg-gray-900/40 border-gray-800 text-gray-500' : 'bg-gray-50 border-gray-200 text-gray-400'}`}>
              <CreditCard className="w-12 h-12 mx-auto mb-3 opacity-30" />
              <p className="text-sm">No subscriptions found</p>
            </div>
          ) : (
            <>
              <div className={`overflow-x-auto rounded-xl border ${isDark ? 'border-gray-800' : 'border-gray-200'}`}>
                <table className="w-full text-sm">
                  <thead>
                    <tr className={isDark ? 'bg-gray-900' : 'bg-gray-50'}>
                      {['Name', 'Vendor', 'Category', 'Amount', 'Frequency', 'Renewal', 'Owner', 'Status', ''].map(h => (
                        <th key={h} className={`px-4 py-3 text-left font-semibold text-xs uppercase tracking-wider ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className={`divide-y ${isDark ? 'divide-gray-800' : 'divide-gray-100'}`}>
                    {paginated.map((sub) => {
                      const mult = getAnnualMultiplier(sub.billing_frequency);
                      const annualized = Number(sub.amount) * mult;
                      return (
                        <tr key={sub.id} className={`${isDark ? 'hover:bg-gray-900/60' : 'hover:bg-gray-50'} transition-colors`}>
                          <td className={`px-4 py-3 font-medium ${isDark ? 'text-white' : 'text-gray-900'}`}>{sub.name}</td>
                          <td className={`px-4 py-3 ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>{sub.vendor || '—'}</td>
                          <td className="px-4 py-3">
                            <span className={`px-2.5 py-1 rounded-full text-xs font-medium ${CATEGORY_STYLES[sub.category] || CATEGORY_STYLES.OTHER}`}>{sub.category.replace(/_/g, ' ')}</span>
                          </td>
                          <td className={`px-4 py-3 font-medium ${isDark ? 'text-white' : 'text-gray-900'}`}>{formatCurrency(Number(sub.amount), sub.currency)}</td>
                          <td className={`px-4 py-3 ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>{sub.billing_frequency.replace(/_/g, ' ')}</td>
                          <td className={`px-4 py-3 ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>{formatDate(sub.renewal_date)}</td>
                          <td className={`px-4 py-3 ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>{sub.owner || '—'}</td>
                          <td className="px-4 py-3">
                            <span className={`px-2.5 py-1 rounded-full text-xs font-medium ${STATUS_STYLES[sub.status] || ''}`}>{sub.status.replace(/_/g, ' ')}</span>
                          </td>
                          <td className="px-4 py-3">
                            <div className="flex items-center gap-1">
                              {canUpdate && (
                                <>
                                  <button onClick={() => openEdit(sub)} title="Edit" className={`p-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors ${isDark ? 'text-gray-400 hover:text-blue-400' : 'text-gray-500 hover:text-blue-600'}`}><Edit2 className="w-3.5 h-3.5" /></button>
                                  <button onClick={() => handleTogglePause(sub)} title={sub.status === 'PAUSED' ? 'Resume' : 'Pause'} className={`p-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors ${isDark ? 'text-gray-400 hover:text-amber-400' : 'text-gray-500 hover:text-amber-600'}`}>
                                    {sub.status === 'PAUSED' ? <Play className="w-3.5 h-3.5" /> : <Pause className="w-3.5 h-3.5" />}
                                  </button>
                                </>
                              )}
                              {canDelete && (
                                <button onClick={() => { setDeleteTarget({ id: sub.id, name: sub.name }); setShowDeleteModal(true); }} title="Delete" className={`p-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors ${isDark ? 'text-gray-400 hover:text-red-400' : 'text-gray-500 hover:text-red-600'}`}><Trash2 className="w-3.5 h-3.5" /></button>
                              )}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {/* ─── Pagination ─── */}
              {totalPages > 1 && (
                <div className="flex items-center justify-between">
                  <p className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>Showing {(page - 1) * perPage + 1}–{Math.min(page * perPage, subscriptions.length)} of {subscriptions.length}</p>
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
          TAB: UPCOMING RENEWALS
         ════════════════════════════════════════════════════════════════════════ */}
      {activeTab === 'renewals' && (
        <div className="space-y-4">
          {isLoading ? (
            <div className="flex justify-center py-12"><Loader2 className="w-8 h-8 animate-spin text-blue-500" /></div>
          ) : renewals.length === 0 ? (
            <div className={`text-center py-12 rounded-xl border ${isDark ? 'bg-gray-900/40 border-gray-800 text-gray-500' : 'bg-gray-50 border-gray-200 text-gray-400'}`}>
              <CalendarClock className="w-12 h-12 mx-auto mb-3 opacity-30" />
              <p className="text-sm">No upcoming renewals</p>
            </div>
          ) : (
            bucketOrder.map((bucket) => {
              const items = grouped[bucket];
              if (!items || items.length === 0) return null;
              return (
                <div key={bucket} className="space-y-2">
                  <h3 className={`text-sm font-bold uppercase tracking-wider ${
                    bucket === 'OVERDUE' ? 'text-red-600 dark:text-red-400' :
                    bucket === '7_DAYS' ? 'text-orange-600 dark:text-orange-400' :
                    bucket === '30_DAYS' ? 'text-yellow-600 dark:text-yellow-400' :
                    isDark ? 'text-gray-400' : 'text-gray-500'
                  }`}>{RENEWAL_BUCKET_LABELS[bucket]} ({items.length})</h3>
                  <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
                    {items.map((r) => (
                      <div key={r.id} className={`rounded-xl p-4 ${RENEWAL_BUCKET_STYLES[bucket]} ${isDark ? 'dark:border-gray-700' : ''}`}>
                        <div className="flex items-start justify-between mb-2">
                          <div>
                            <p className={`font-semibold text-sm ${isDark ? 'text-white' : 'text-gray-900'}`}>{r.name}</p>
                            <p className={`text-xs mt-0.5 ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>{r.vendor || 'No vendor'}</p>
                          </div>
                          <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${CATEGORY_STYLES[r.category] || ''}`}>{r.category.replace(/_/g, ' ')}</span>
                        </div>
                        <div className={`text-sm space-y-1 ${isDark ? 'text-gray-300' : 'text-gray-600'}`}>
                          <p>{formatCurrency(Number(r.amount), r.currency)} / {r.billing_frequency.replace(/_/g, ' ')}</p>
                          <p>Renewal: {formatDate(r.renewal_date)}</p>
                          {r.days_until_renewal != null && (
                            <p className={r.days_until_renewal < 0 ? 'text-red-600 dark:text-red-400 font-medium' : ''}>
                              {r.days_until_renewal < 0 ? `${Math.abs(r.days_until_renewal)} days overdue` : `${r.days_until_renewal} days remaining`}
                            </p>
                          )}
                          {r.notice_date && (
                            <p className="text-xs opacity-70">Notice by: {formatDate(r.notice_date)}</p>
                          )}
                        </div>
                        {canUpdate && r.days_until_renewal !== null && r.days_until_renewal <= 0 && (
                          <button onClick={() => handleMarkRenewed(r)}
                            className="mt-3 flex items-center gap-1.5 text-xs font-medium text-blue-600 dark:text-blue-400 hover:underline">
                            <RefreshCw className="w-3 h-3" /> Mark as Renewed
                          </button>
                        )}
                        {r.auto_renew && (
                          <p className={`mt-2 text-xs ${isDark ? 'text-green-400' : 'text-green-600'}`}>Auto-renew ON</p>
                        )}
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
          TAB: SPEND SUMMARY
         ════════════════════════════════════════════════════════════════════════ */}
      {activeTab === 'spend' && (
        <div className="space-y-4">
          {isLoading ? (
            <div className="flex justify-center py-12"><Loader2 className="w-8 h-8 animate-spin text-blue-500" /></div>
          ) : spendData.length === 0 ? (
            <div className={`text-center py-12 rounded-xl border ${isDark ? 'bg-gray-900/40 border-gray-800 text-gray-500' : 'bg-gray-50 border-gray-200 text-gray-400'}`}>
              <TrendingDown className="w-12 h-12 mx-auto mb-3 opacity-30" />
              <p className="text-sm">No spend data yet</p>
            </div>
          ) : (
            <>
              {/* ─── Summary Cards ─── */}
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div className={`rounded-xl p-5 border ${isDark ? 'bg-gray-900/60 border-gray-800' : 'bg-white border-gray-200'}`}>
                  <p className={`text-xs uppercase tracking-wider font-bold mb-1 ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>Total Active Subscriptions</p>
                  <p className={`text-2xl font-extrabold ${isDark ? 'text-white' : 'text-gray-900'}`}>{spendData.reduce((s, r) => s + r.subscription_count, 0)}</p>
                </div>
                <div className={`rounded-xl p-5 border ${isDark ? 'bg-gray-900/60 border-gray-800' : 'bg-white border-gray-200'}`}>
                  <p className={`text-xs uppercase tracking-wider font-bold mb-1 ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>Annualized Spend</p>
                  <p className={`text-2xl font-extrabold text-red-600 dark:text-red-400`}>{formatCurrency(totalAnnualSpend, primaryCurrency)}</p>
                </div>
                <div className={`rounded-xl p-5 border ${isDark ? 'bg-gray-900/60 border-gray-800' : 'bg-white border-gray-200'}`}>
                  <p className={`text-xs uppercase tracking-wider font-bold mb-1 ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>Normalized Monthly</p>
                  <p className={`text-2xl font-extrabold text-green-600 dark:text-green-400`}>{formatCurrency(totalMonthlyNormalized, primaryCurrency)}</p>
                </div>
              </div>

              {/* ─── Category Breakdown Table ─── */}
              <div className={`overflow-x-auto rounded-xl border ${isDark ? 'border-gray-800' : 'border-gray-200'}`}>
                <table className="w-full text-sm">
                  <thead>
                    <tr className={isDark ? 'bg-gray-900' : 'bg-gray-50'}>
                      {['Category', 'Count', 'Raw Total', 'Annualized', 'Monthly (Norm)'].map(h => (
                        <th key={h} className={`px-4 py-3 text-left font-semibold text-xs uppercase tracking-wider ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className={`divide-y ${isDark ? 'divide-gray-800' : 'divide-gray-100'}`}>
                    {spendData.map((row) => (
                      <tr key={row.category} className={`${isDark ? 'hover:bg-gray-900/60' : 'hover:bg-gray-50'} transition-colors`}>
                        <td className="px-4 py-3">
                          <span className={`px-2.5 py-1 rounded-full text-xs font-medium ${CATEGORY_STYLES[row.category] || CATEGORY_STYLES.OTHER}`}>{row.category.replace(/_/g, ' ')}</span>
                        </td>
                        <td className={`px-4 py-3 ${isDark ? 'text-gray-300' : 'text-gray-700'}`}>{row.subscription_count}</td>
                        <td className={`px-4 py-3 ${isDark ? 'text-gray-300' : 'text-gray-700'}`}>{formatCurrency(Number(row.raw_total), primaryCurrency)}</td>
                        <td className={`px-4 py-3 font-medium ${isDark ? 'text-white' : 'text-gray-900'}`}>{formatCurrency(Number(row.annualized_amount), primaryCurrency)}</td>
                        <td className={`px-4 py-3 font-medium ${isDark ? 'text-white' : 'text-gray-900'}`}>{formatCurrency(Number(row.normalized_monthly), primaryCurrency)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      )}

      {/* ════════════════════════════════════════════════════════════════════════
          CREATE / EDIT FORM MODAL
         ════════════════════════════════════════════════════════════════════════ */}
      {showForm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50" onClick={() => { setShowForm(false); setEditingSub(null); }}>
          <div className={`w-full max-w-2xl max-h-[90vh] overflow-y-auto rounded-2xl shadow-xl ${isDark ? 'bg-gray-900 border border-gray-800' : 'bg-white'}`} onClick={(e) => e.stopPropagation()}>
            <div className={`flex items-center justify-between p-6 border-b ${isDark ? 'border-gray-800' : 'border-gray-200'}`}>
              <h2 className={`text-lg font-bold ${isDark ? 'text-white' : 'text-gray-900'}`}>{editingSub ? 'Edit Subscription' : 'Add Subscription'}</h2>
              <button onClick={() => { setShowForm(false); setEditingSub(null); }} className={`p-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 ${isDark ? 'text-gray-400' : 'text-gray-500'}`}><X className="w-5 h-5" /></button>
            </div>
            <form onSubmit={handleSubmit} className="p-6 space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {/* Name */}
                <div className="md:col-span-2">
                  <label className={`block text-xs font-semibold uppercase tracking-wider mb-1.5 ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>Subscription Name *</label>
                  <input type="text" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })}
                    className={`w-full px-3 py-2 rounded-lg text-sm border ${isDark ? 'bg-gray-800 border-gray-700 text-white' : 'bg-gray-50 border-gray-200 text-gray-900'} focus:outline-none focus:ring-2 focus:ring-blue-500`} placeholder="e.g. AWS Hosting" />
                </div>
                {/* Vendor */}
                <div>
                  <label className={`block text-xs font-semibold uppercase tracking-wider mb-1.5 ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>Vendor</label>
                  <input type="text" value={form.vendor} onChange={(e) => setForm({ ...form, vendor: e.target.value })}
                    className={`w-full px-3 py-2 rounded-lg text-sm border ${isDark ? 'bg-gray-800 border-gray-700 text-white' : 'bg-gray-50 border-gray-200 text-gray-900'} focus:outline-none focus:ring-2 focus:ring-blue-500`} placeholder="e.g. Amazon" />
                </div>
                {/* Category */}
                <div>
                  <label className={`block text-xs font-semibold uppercase tracking-wider mb-1.5 ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>Category *</label>
                  <select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}
                    className={`w-full px-3 py-2 rounded-lg text-sm border ${isDark ? 'bg-gray-800 border-gray-700 text-white' : 'bg-gray-50 border-gray-200 text-gray-900'} focus:outline-none focus:ring-2 focus:ring-blue-500`}>
                    {CATEGORIES.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
                  </select>
                </div>
                {/* Amount */}
                <div>
                  <label className={`block text-xs font-semibold uppercase tracking-wider mb-1.5 ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>Amount *</label>
                  <input type="number" step="0.01" min="0" required value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })}
                    className={`w-full px-3 py-2 rounded-lg text-sm border ${isDark ? 'bg-gray-800 border-gray-700 text-white' : 'bg-gray-50 border-gray-200 text-gray-900'} focus:outline-none focus:ring-2 focus:ring-blue-500`} placeholder="0.00" />
                </div>
                {/* Currency */}
                <div>
                  <label className={`block text-xs font-semibold uppercase tracking-wider mb-1.5 ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>Currency</label>
                  <select value={form.currency} onChange={(e) => setForm({ ...form, currency: e.target.value })}
                    className={`w-full px-3 py-2 rounded-lg text-sm border ${isDark ? 'bg-gray-800 border-gray-700 text-white' : 'bg-gray-50 border-gray-200 text-gray-900'} focus:outline-none focus:ring-2 focus:ring-blue-500`}>
                    <option value="PKR">PKR</option>
                    <option value="USD">USD</option>
                    <option value="EUR">EUR</option>
                    <option value="GBP">GBP</option>
                  </select>
                </div>
                {/* Billing Frequency */}
                <div>
                  <label className={`block text-xs font-semibold uppercase tracking-wider mb-1.5 ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>Billing Frequency *</label>
                  <select value={form.billing_frequency} onChange={(e) => setForm({ ...form, billing_frequency: e.target.value })}
                    className={`w-full px-3 py-2 rounded-lg text-sm border ${isDark ? 'bg-gray-800 border-gray-700 text-white' : 'bg-gray-50 border-gray-200 text-gray-900'} focus:outline-none focus:ring-2 focus:ring-blue-500`}>
                    {BILLING_FREQUENCIES.map(f => <option key={f.value} value={f.value}>{f.label}</option>)}
                  </select>
                </div>
                {/* Start Date */}
                <div>
                  <label className={`block text-xs font-semibold uppercase tracking-wider mb-1.5 ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>Start Date *</label>
                  <input type="date" required value={form.start_date} onChange={(e) => setForm({ ...form, start_date: e.target.value })}
                    className={`w-full px-3 py-2 rounded-lg text-sm border ${isDark ? 'bg-gray-800 border-gray-700 text-white' : 'bg-gray-50 border-gray-200 text-gray-900'} focus:outline-none focus:ring-2 focus:ring-blue-500`} />
                </div>
                {/* Renewal Date */}
                <div>
                  <label className={`block text-xs font-semibold uppercase tracking-wider mb-1.5 ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>Renewal Date</label>
                  <input type="date" value={form.renewal_date} onChange={(e) => setForm({ ...form, renewal_date: e.target.value })}
                    className={`w-full px-3 py-2 rounded-lg text-sm border ${isDark ? 'bg-gray-800 border-gray-700 text-white' : 'bg-gray-50 border-gray-200 text-gray-900'} focus:outline-none focus:ring-2 focus:ring-blue-500`} />
                </div>
                {/* Cancellation Notice Days */}
                <div>
                  <label className={`block text-xs font-semibold uppercase tracking-wider mb-1.5 ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>Notice Days</label>
                  <input type="number" min="0" value={form.cancellation_notice_days} onChange={(e) => setForm({ ...form, cancellation_notice_days: e.target.value })}
                    className={`w-full px-3 py-2 rounded-lg text-sm border ${isDark ? 'bg-gray-800 border-gray-700 text-white' : 'bg-gray-50 border-gray-200 text-gray-900'} focus:outline-none focus:ring-2 focus:ring-blue-500`} />
                </div>
                {/* Auto-Renew */}
                <div className="flex items-center gap-3 pt-6">
                  <button type="button" onClick={() => setForm({ ...form, auto_renew: !form.auto_renew })}
                    className={`relative w-11 h-6 rounded-full transition-colors ${form.auto_renew ? 'bg-blue-600' : isDark ? 'bg-gray-700' : 'bg-gray-300'}`}>
                    <span className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${form.auto_renew ? 'translate-x-5' : ''}`} />
                  </button>
                  <span className={`text-sm ${isDark ? 'text-gray-300' : 'text-gray-700'}`}>Auto-renew</span>
                </div>
                {/* Project */}
                <div>
                  <label className={`block text-xs font-semibold uppercase tracking-wider mb-1.5 ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>Project</label>
                  <select value={form.project_id} onChange={(e) => setForm({ ...form, project_id: e.target.value })}
                    className={`w-full px-3 py-2 rounded-lg text-sm border ${isDark ? 'bg-gray-800 border-gray-700 text-white' : 'bg-gray-50 border-gray-200 text-gray-900'} focus:outline-none focus:ring-2 focus:ring-blue-500`}>
                    <option value="">None</option>
                    {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                </div>
                {/* Owner */}
                <div>
                  <label className={`block text-xs font-semibold uppercase tracking-wider mb-1.5 ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>Owner</label>
                  <input type="text" value={form.owner} onChange={(e) => setForm({ ...form, owner: e.target.value })}
                    className={`w-full px-3 py-2 rounded-lg text-sm border ${isDark ? 'bg-gray-800 border-gray-700 text-white' : 'bg-gray-50 border-gray-200 text-gray-900'} focus:outline-none focus:ring-2 focus:ring-blue-500`} placeholder="Person responsible" />
                </div>
                {/* Status (edit only) */}
                {editingSub && (
                  <div>
                    <label className={`block text-xs font-semibold uppercase tracking-wider mb-1.5 ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>Status</label>
                    <select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}
                      className={`w-full px-3 py-2 rounded-lg text-sm border ${isDark ? 'bg-gray-800 border-gray-700 text-white' : 'bg-gray-50 border-gray-200 text-gray-900'} focus:outline-none focus:ring-2 focus:ring-blue-500`}>
                      {STATUSES.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
                    </select>
                  </div>
                )}
                {/* Notes */}
                <div className="md:col-span-2">
                  <label className={`block text-xs font-semibold uppercase tracking-wider mb-1.5 ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>Notes</label>
                  <textarea value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} rows={2}
                    className={`w-full px-3 py-2 rounded-lg text-sm border ${isDark ? 'bg-gray-800 border-gray-700 text-white' : 'bg-gray-50 border-gray-200 text-gray-900'} focus:outline-none focus:ring-2 focus:ring-blue-500`} placeholder="Optional notes..." />
                </div>
              </div>
              {/* ─── Form Actions ─── */}
              <div className="flex items-center justify-end gap-3 pt-4 border-t ${isDark ? 'border-gray-800' : 'border-gray-200'}">
                <button type="button" onClick={() => { setShowForm(false); setEditingSub(null); }}
                  className={`px-4 py-2 rounded-lg text-sm font-medium ${isDark ? 'text-gray-300 hover:bg-gray-800' : 'text-gray-700 hover:bg-gray-100'} transition-colors`}>
                  Cancel
                </button>
                <button type="submit" disabled={isMutLoading}
                  className="flex items-center gap-2 px-5 py-2 rounded-lg text-sm font-medium bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 transition-colors">
                  {isMutLoading && <Loader2 className="w-4 h-4 animate-spin" />}
                  {editingSub ? 'Update' : 'Create'}
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
              <h3 className={`text-lg font-bold ${isDark ? 'text-white' : 'text-gray-900'}`}>Delete Subscription</h3>
            </div>
            <p className={`text-sm mb-6 ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
              Are you sure you want to delete <strong>{deleteTarget.name}</strong>? This action cannot be undone.
            </p>
            <div className="flex justify-end gap-3">
              <button onClick={() => { setShowDeleteModal(false); setDeleteTarget(null); }}
                className={`px-4 py-2 rounded-lg text-sm font-medium ${isDark ? 'text-gray-300 hover:bg-gray-800' : 'text-gray-700 hover:bg-gray-100'} transition-colors`}>
                Cancel
              </button>
              <button onClick={confirmDelete} disabled={deleteMut.isPending}
                className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium bg-red-600 text-white hover:bg-red-700 disabled:opacity-50 transition-colors">
                {deleteMut.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
                <Trash2 className="w-4 h-4" /> Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
