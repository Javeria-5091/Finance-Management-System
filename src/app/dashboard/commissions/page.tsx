'use client';
// ================================================================
// OSYSTIC Finance Management System — Commissions Page (P1)
// ================================================================

import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '@/context/AuthContext';
import { usePermissions } from '@/context/PermissionContext';
import { useTheme } from '@/context/ThemeContext';

import {
  useCommissionStats,
  useCommissions,
  useCommissionByPerson,
  useCommissionByProject,
  useCommissionByType,
  useCreateCommission,
  useUpdateCommission,
  useDeleteCommission,
  useApproveCommission,
  useMarkCommissionPaid,
} from '@/hooks/useCommissions';
import type {
  CommissionRow,
  CommissionByPersonRow,
  CommissionByProjectRow,
  CommissionByTypeRow,
  CommissionFormData,
} from '@/types/commission.types';
import {
  COMMISSION_TYPES,
  CALCULATION_BASES,
  COMMISSION_STATUSES,
  PERSON_TYPES,
} from '@/types/commission.types';
import { formatCurrency } from '@/lib/helpers';
import {
  Plus, Search, Edit2, Trash2, ChevronLeft, ChevronRight,
  Percent, CheckCircle, Clock,
  TrendingUp, AlertTriangle, X, Loader2, FileText,
  Users, FolderOpen, BarChart3, Ban, Banknote,
} from 'lucide-react';
import toast from 'react-hot-toast';
import { supabase } from '@/lib/supabase';

// ==========================================
// CONSTANTS
// ==========================================
const STATUS_STYLES: Record<string, string> = {
  PENDING: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400',
  APPROVED: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
  PAID: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400',
  CANCELLED: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
  HELD: 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300',
};

const COMMISSION_TYPE_STYLES: Record<string, string> = {
  PERCENTAGE: 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-400',
  FIXED_AMOUNT: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400',
  TIERED: 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400',
  FLAT_BONUS: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
  REFERRAL: 'bg-cyan-100 text-cyan-700 dark:bg-cyan-900/30 dark:text-cyan-400',
};

const PERSON_TYPE_STYLES: Record<string, string> = {
  CONTRACTOR: 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400',
  EMPLOYEE: 'bg-sky-100 text-sky-700 dark:bg-sky-900/30 dark:text-sky-400',
};

const EMPTY_FORM: CommissionFormData = {
  contractor_id: '',
  person_name: '',
  person_type: 'CONTRACTOR',
  commission_type: 'PERCENTAGE',
  calculation_basis: 'PROJECT_REVENUE',
  rate_or_amount: '',
  project_id: '',
  invoice_ref: '',
  milestone_ref: '',
  period_start: '',
  period_end: '',
  base_amount: '',
  commission_amount: '',
  currency: 'PKR',
  tax_withheld: '',
  status: 'PENDING',
  payment_date: '',
  payment_ref: '',
  notes: '',
};

// ==========================================
// MAIN COMPONENT
// ==========================================
export default function CommissionsPage() {
  const { user } = useAuth();
  const { hasPermission } = usePermissions();
  const { isDark } = useTheme();
  const canAdd = hasPermission('COMMISSION_CREATE');
  const canUpdate = hasPermission('COMMISSION_UPDATE');
  const canDelete = hasPermission('COMMISSION_DELETE');
  const canApprove = hasPermission('COMMISSION_APPROVE');

  // ─── Tab ───
  const [activeTab, setActiveTab] = useState<'all' | 'summary'>('all');

  // ─── Filters ───
  const [search, setSearch] = useState('');
  const [filterStatus, setFilterStatus] = useState('');
  const [filterType, setFilterType] = useState('');
  const [filterPersonType, setFilterPersonType] = useState('');
  const [filterProject, setFilterProject] = useState('');

  // ─── Pagination ───
  const [page, setPage] = useState(1);
  const perPage = 10;

  // ─── Dialogs ───
  const [showForm, setShowForm] = useState(false);
  const [editingCom, setEditingCom] = useState<CommissionRow | null>(null);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null);
  const [showPayModal, setShowPayModal] = useState(false);
  const [payTarget, setPayTarget] = useState<CommissionRow | null>(null);
  const [payDate, setPayDate] = useState('');
  const [payRef, setPayRef] = useState('');

  // ─── Summary sub-tab ───
  const [summaryView, setSummaryView] = useState<'person' | 'project' | 'type'>('person');

  // ─── Dropdowns ───
  const [projects, setProjects] = useState<{ id: string; name: string }[]>([]);
  const [contractors, setContractors] = useState<{ id: string; name: string }[]>([]);

  // ==========================================
  // HOOKS
  // ==========================================
  const { data: stats } = useCommissionStats();
  const { data: commissions = [], isLoading: comLoading } = useCommissions({
    search: search || undefined,
    status: filterStatus || undefined,
    commission_type: filterType || undefined,
    person_type: filterPersonType || undefined,
    project_id: filterProject || undefined,
  });
  const { data: byPerson = [] } = useCommissionByPerson();
  const { data: byProject = [] } = useCommissionByProject();
  const { data: byType = [] } = useCommissionByType();

  const createMut = useCreateCommission();
  const updateMut = useUpdateCommission();
  const deleteMut = useDeleteCommission();
  const approveMut = useApproveCommission();
  const paidMut = useMarkCommissionPaid();

  // ─── Fetch dropdowns ───
  const fetchDropdowns = useCallback(async () => {
    const [projRes, conRes] = await Promise.all([
      supabase.from('projects').select('id, name').eq('status', 'ACTIVE').order('name'),
      supabase.from('contractors').select('id, name').eq('status', 'ACTIVE').order('name'),
    ]);
    setProjects(projRes.data || []);
    setContractors(conRes.data || []);
  }, []);

  useEffect(() => { fetchDropdowns(); }, [fetchDropdowns]);
  useEffect(() => { setPage(1); }, [search, filterStatus, filterType, filterPersonType, filterProject]);

  // ==========================================
  // PAGINATION
  // ==========================================
  const totalPages = Math.ceil(commissions.length / perPage);
  const paginated = commissions.slice((page - 1) * perPage, page * perPage);

  // ==========================================
  // COMMISSION CALCULATION PREVIEW
  // ==========================================
  const [form, setForm] = useState<CommissionFormData>(EMPTY_FORM);

  const previewCommission = useCallback((): number => {
    const base = parseFloat(form.base_amount) || 0;
    const rate = parseFloat(form.rate_or_amount) || 0;
    if (form.commission_type === 'PERCENTAGE') {
      return Math.round((base * rate) / 100 * 100) / 100;
    }
    return Math.round(rate * 100) / 100;
  }, [form.commission_type, form.base_amount, form.rate_or_amount]);

  // ==========================================
  // FORM HANDLERS
  // ==========================================
  const openCreate = () => {
    setEditingCom(null);
    setForm(EMPTY_FORM);
    setShowForm(true);
  };

  const openEdit = (com: CommissionRow) => {
    setEditingCom(com);
    setForm({
      contractor_id: com.contractor_id || '',
      person_name: com.person_name || '',
      person_type: com.person_type || 'CONTRACTOR',
      commission_type: com.commission_type || 'PERCENTAGE',
      calculation_basis: com.calculation_basis || 'PROJECT_REVENUE',
      rate_or_amount: String(com.rate_or_amount),
      project_id: com.project_id || '',
      invoice_ref: com.invoice_ref || '',
      milestone_ref: com.milestone_ref || '',
      period_start: com.period_start || '',
      period_end: com.period_end || '',
      base_amount: String(com.base_amount),
      commission_amount: String(com.commission_amount),
      currency: com.currency || 'PKR',
      tax_withheld: String(com.tax_withheld),
      status: com.status || 'PENDING',
      payment_date: com.payment_date || '',
      payment_ref: com.payment_ref || '',
      notes: com.notes || '',
    });
    setShowForm(true);
  };

  const handleSave = async () => {
    if (!form.person_name.trim()) {
      toast.error('Person name is required');
      return;
    }
    if (!form.base_amount || parseFloat(form.base_amount) <= 0) {
      toast.error('Base amount is required and must be greater than 0');
      return;
    }
    if (!form.rate_or_amount || parseFloat(form.rate_or_amount) <= 0) {
      toast.error('Rate or amount is required and must be greater than 0');
      return;
    }

    const payload: Record<string, any> = {
      ...form,
      contractor_id: form.contractor_id || null,
      project_id: form.project_id || null,
    };

    try {
      if (editingCom) {
        await updateMut.mutateAsync({ id: editingCom.id, updates: payload });
        toast.success('Commission updated');
      } else {
        await createMut.mutateAsync({ ...payload, created_by: user?.id });
        toast.success('Commission created');
      }
      setShowForm(false);
      setEditingCom(null);
    } catch (err: any) {
      toast.error(err.message || 'Failed to save commission');
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    try {
      await deleteMut.mutateAsync(deleteTarget.id);
      toast.success('Commission deleted');
      setShowDeleteModal(false);
      setDeleteTarget(null);
    } catch (err: any) {
      toast.error(err.message || 'Failed to delete');
    }
  };

  const handleApprove = async (com: CommissionRow) => {
    if (!canApprove) {
      toast.error('You do not have approval permission');
      return;
    }
    if (com.status !== 'PENDING') {
      toast.error('Only PENDING commissions can be approved');
      return;
    }
    try {
      await approveMut.mutateAsync({ id: com.id, approvedBy: user?.id || '' });
      toast.success('Commission approved');
    } catch (err: any) {
      toast.error(err.message || 'Failed to approve');
    }
  };

  const openPayModal = (com: CommissionRow) => {
    if (com.status !== 'APPROVED') {
      toast.error('Only APPROVED commissions can be marked as paid');
      return;
    }
    setPayTarget(com);
    setPayDate(new Date().toISOString().split('T')[0]);
    setPayRef('');
    setShowPayModal(true);
  };

  const handleMarkPaid = async () => {
    if (!payTarget) return;
    if (!payDate) {
      toast.error('Payment date is required');
      return;
    }
    try {
      await paidMut.mutateAsync({ id: payTarget.id, paymentDate: payDate, paymentRef: payRef });
      toast.success('Commission marked as paid');
      setShowPayModal(false);
      setPayTarget(null);
    } catch (err: any) {
      toast.error(err.message || 'Failed to mark as paid');
    }
  };

  const handleCancel = async (com: CommissionRow) => {
    if (!canUpdate) return;
    try {
      await updateMut.mutateAsync({ id: com.id, updates: { status: 'CANCELLED' } });
      toast.success('Commission cancelled');
    } catch (err: any) {
      toast.error(err.message || 'Failed to cancel');
    }
  };

  // ==========================================
  // FIELD HELPER
  // ==========================================
  const inputCls = `w-full rounded-lg border px-3 py-2 text-sm transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500/40 ${isDark ? 'border-gray-600 bg-gray-700 text-white placeholder-gray-400' : 'border-gray-300 bg-white text-gray-900 placeholder-gray-400'}`;
  const labelCls = 'block text-sm font-medium mb-1';
  const cardCls = `rounded-xl border p-6 ${isDark ? 'bg-gray-800 border-gray-700' : 'bg-white border-gray-200'}`;
  const modalOverlay = 'fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm';
  const modalBox = `w-full max-w-2xl max-h-[90vh] overflow-y-auto rounded-2xl border p-6 shadow-2xl ${isDark ? 'bg-gray-800 border-gray-700' : 'bg-white border-gray-200'}`;
  const modalBoxSm = `w-full max-w-md rounded-2xl border p-6 shadow-2xl ${isDark ? 'bg-gray-800 border-gray-700' : 'bg-white border-gray-200'}`;

  const getLabel = (arr: readonly { value: string; label: string }[], val: string) =>
    arr.find((i) => i.value === val)?.label || val;

  // ==========================================
  // RENDER: STATS CARDS
  // ==========================================
  const renderStats = () => (
    <div className="grid grid-cols-2 lg:grid-cols-5 gap-4 mb-6">
      <div className={cardCls}>
        <div className="flex items-center gap-3">
          <div className={`p-2.5 rounded-xl ${isDark ? 'bg-indigo-900/40' : 'bg-indigo-50'}`}>
            <FileText className="w-5 h-5 text-indigo-500" />
          </div>
          <div>
            <p className={`text-xs ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>Total Records</p>
            <p className={`text-xl font-bold ${isDark ? 'text-white' : 'text-gray-900'}`}>{stats?.totalRecords || 0}</p>
          </div>
        </div>
      </div>
      <div className={cardCls}>
        <div className="flex items-center gap-3">
          <div className={`p-2.5 rounded-xl ${isDark ? 'bg-yellow-900/40' : 'bg-yellow-50'}`}>
            <Clock className="w-5 h-5 text-yellow-500" />
          </div>
          <div>
            <p className={`text-xs ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>Pending</p>
            <p className={`text-xl font-bold ${isDark ? 'text-white' : 'text-gray-900'}`}>{stats?.pendingCount || 0}</p>
            <p className={`text-xs ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>{formatCurrency(stats?.pendingAmount || 0, stats?.topCurrency || 'PKR')}</p>
          </div>
        </div>
      </div>
      <div className={cardCls}>
        <div className="flex items-center gap-3">
          <div className={`p-2.5 rounded-xl ${isDark ? 'bg-blue-900/40' : 'bg-blue-50'}`}>
            <CheckCircle className="w-5 h-5 text-blue-500" />
          </div>
          <div>
            <p className={`text-xs ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>Approved</p>
            <p className={`text-xl font-bold ${isDark ? 'text-white' : 'text-gray-900'}`}>{stats?.approvedCount || 0}</p>
            <p className={`text-xs ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>{formatCurrency(stats?.approvedAmount || 0, stats?.topCurrency || 'PKR')}</p>
          </div>
        </div>
      </div>
      <div className={cardCls}>
        <div className="flex items-center gap-3">
          <div className={`p-2.5 rounded-xl ${isDark ? 'bg-green-900/40' : 'bg-green-50'}`}>
            <Banknote className="w-5 h-5 text-green-500" />
          </div>
          <div>
            <p className={`text-xs ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>Paid</p>
            <p className={`text-xl font-bold ${isDark ? 'text-white' : 'text-gray-900'}`}>{stats?.paidCount || 0}</p>
            <p className={`text-xs ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>{formatCurrency(stats?.paidAmount || 0, stats?.topCurrency || 'PKR')}</p>
          </div>
        </div>
      </div>
      <div className={cardCls}>
        <div className="flex items-center gap-3">
          <div className={`p-2.5 rounded-xl ${isDark ? 'bg-emerald-900/40' : 'bg-emerald-50'}`}>
            <TrendingUp className="w-5 h-5 text-emerald-500" />
          </div>
          <div>
            <p className={`text-xs ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>Total Commission</p>
            <p className={`text-xl font-bold ${isDark ? 'text-white' : 'text-gray-900'}`}>{formatCurrency(stats?.totalCommission || 0, stats?.topCurrency || 'PKR')}</p>
          </div>
        </div>
      </div>
    </div>
  );

  // ==========================================
  // RENDER: FILTERS
  // ==========================================
  const renderFilters = () => (
    <div className={`rounded-xl border p-4 mb-6 ${isDark ? 'bg-gray-800 border-gray-700' : 'bg-white border-gray-200'}`}>
      <div className="flex flex-wrap gap-3 items-end">
        {/* Search */}
        <div className="flex-1 min-w-[200px]">
          <label className={labelCls + ` ${isDark ? 'text-gray-300' : 'text-gray-700'}`}>Search</label>
          <div className="relative">
            <Search className={`absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 ${isDark ? 'text-gray-400' : 'text-gray-400'}`} />
            <input
              type="text"
              placeholder="Name, invoice ref, milestone..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className={`${inputCls} pl-9`}
            />
          </div>
        </div>
        {/* Status */}
        <div className="min-w-[150px]">
          <label className={labelCls + ` ${isDark ? 'text-gray-300' : 'text-gray-700'}`}>Status</label>
          <select value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)} className={inputCls}>
            <option value="">All Statuses</option>
            {COMMISSION_STATUSES.map((s) => (
              <option key={s.value} value={s.value}>{s.label}</option>
            ))}
          </select>
        </div>
        {/* Commission Type */}
        <div className="min-w-[160px]">
          <label className={labelCls + ` ${isDark ? 'text-gray-300' : 'text-gray-700'}`}>Type</label>
          <select value={filterType} onChange={(e) => setFilterType(e.target.value)} className={inputCls}>
            <option value="">All Types</option>
            {COMMISSION_TYPES.map((t) => (
              <option key={t.value} value={t.value}>{t.label}</option>
            ))}
          </select>
        </div>
        {/* Person Type */}
        <div className="min-w-[140px]">
          <label className={labelCls + ` ${isDark ? 'text-gray-300' : 'text-gray-700'}`}>Person Type</label>
          <select value={filterPersonType} onChange={(e) => setFilterPersonType(e.target.value)} className={inputCls}>
            <option value="">All</option>
            {PERSON_TYPES.map((p) => (
              <option key={p.value} value={p.value}>{p.label}</option>
            ))}
          </select>
        </div>
        {/* Project */}
        <div className="min-w-[160px]">
          <label className={labelCls + ` ${isDark ? 'text-gray-300' : 'text-gray-700'}`}>Project</label>
          <select value={filterProject} onChange={(e) => setFilterProject(e.target.value)} className={inputCls}>
            <option value="">All Projects</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </div>
        {(search || filterStatus || filterType || filterPersonType || filterProject) && (
          <button
            onClick={() => { setSearch(''); setFilterStatus(''); setFilterType(''); setFilterPersonType(''); setFilterProject(''); }}
            className={`px-3 py-2 rounded-lg text-sm font-medium ${isDark ? 'bg-gray-700 text-gray-300 hover:bg-gray-600' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}
          >
            Clear
          </button>
        )}
      </div>
    </div>
  );

  // ==========================================
  // RENDER: TABLE
  // ==========================================
  const renderTable = () => {
    if (comLoading) {
      return (
        <div className={`rounded-xl border p-12 text-center ${isDark ? 'bg-gray-800 border-gray-700' : 'bg-white border-gray-200'}`}>
          <Loader2 className={`w-8 h-8 animate-spin mx-auto mb-3 ${isDark ? 'text-gray-400' : 'text-gray-300'}`} />
          <p className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>Loading commissions...</p>
        </div>
      );
    }

    if (commissions.length === 0) {
      return (
        <div className={`rounded-xl border p-12 text-center ${isDark ? 'bg-gray-800 border-gray-700' : 'bg-white border-gray-200'}`}>
          <Percent className={`w-12 h-12 mx-auto mb-3 ${isDark ? 'text-gray-600' : 'text-gray-300'}`} />
          <p className={`text-sm font-medium ${isDark ? 'text-gray-300' : 'text-gray-600'}`}>No commissions found</p>
          <p className={`text-xs mt-1 ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>{canAdd ? 'Click "Add Commission" to create your first commission record' : 'No commission records match your filters'}</p>
        </div>
      );
    }

    return (
      <>
        <div className={`rounded-xl border overflow-hidden ${isDark ? 'bg-gray-800 border-gray-700' : 'bg-white border-gray-200'}`}>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className={isDark ? 'bg-gray-900/50' : 'bg-gray-50'}>
                  <th className={`px-4 py-3 text-left font-semibold ${isDark ? 'text-gray-300' : 'text-gray-600'}`}>Person</th>
                  <th className={`px-4 py-3 text-left font-semibold ${isDark ? 'text-gray-300' : 'text-gray-600'}`}>Type</th>
                  <th className={`px-4 py-3 text-right font-semibold ${isDark ? 'text-gray-300' : 'text-gray-600'}`}>Base</th>
                  <th className={`px-4 py-3 text-right font-semibold ${isDark ? 'text-gray-300' : 'text-gray-600'}`}>Commission</th>
                  <th className={`px-4 py-3 text-right font-semibold ${isDark ? 'text-gray-300' : 'text-gray-600'}`}>Tax</th>
                  <th className={`px-4 py-3 text-right font-semibold ${isDark ? 'text-gray-300' : 'text-gray-600'}`}>Net</th>
                  <th className={`px-4 py-3 text-center font-semibold ${isDark ? 'text-gray-300' : 'text-gray-600'}`}>Status</th>
                  <th className={`px-4 py-3 text-center font-semibold ${isDark ? 'text-gray-300' : 'text-gray-600'}`}>Actions</th>
                </tr>
              </thead>
              <tbody className={`divide-y ${isDark ? 'divide-gray-700' : 'divide-gray-100'}`}>
                {paginated.map((com) => (
                  <tr key={com.id} className={`transition-colors ${isDark ? 'hover:bg-gray-700/50' : 'hover:bg-gray-50'}`}>
                    <td className="px-4 py-3">
                      <div>
                        <p className={`font-medium ${isDark ? 'text-white' : 'text-gray-900'}`}>{com.person_name}</p>
                        <span className={`inline-block text-[10px] font-medium px-1.5 py-0.5 rounded mt-0.5 ${PERSON_TYPE_STYLES[com.person_type] || ''}`}>
                          {getLabel(PERSON_TYPES, com.person_type)}
                        </span>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <div>
                        <span className={`inline-block text-[10px] font-medium px-1.5 py-0.5 rounded ${COMMISSION_TYPE_STYLES[com.commission_type] || ''}`}>
                          {getLabel(COMMISSION_TYPES, com.commission_type)}
                        </span>
                        <p className={`text-[11px] mt-0.5 ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                          {com.commission_type === 'PERCENTAGE' ? `${com.rate_or_amount}% of ${getLabel(CALCULATION_BASES, com.calculation_basis)}` : formatCurrency(com.commission_amount, com.currency)}
                        </p>
                      </div>
                    </td>
                    <td className={`px-4 py-3 text-right font-mono text-xs ${isDark ? 'text-gray-300' : 'text-gray-700'}`}>
                      {formatCurrency(com.base_amount, com.currency)}
                    </td>
                    <td className={`px-4 py-3 text-right font-mono text-xs font-semibold ${isDark ? 'text-white' : 'text-gray-900'}`}>
                      {formatCurrency(com.commission_amount, com.currency)}
                    </td>
                    <td className={`px-4 py-3 text-right font-mono text-xs ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                      {com.tax_withheld > 0 ? formatCurrency(com.tax_withheld, com.currency) : '-'}
                    </td>
                    <td className={`px-4 py-3 text-right font-mono text-xs font-semibold ${isDark ? 'text-emerald-400' : 'text-emerald-700'}`}>
                      {formatCurrency(com.net_amount, com.currency)}
                    </td>
                    <td className="px-4 py-3 text-center">
                      <span className={`inline-block text-[11px] font-medium px-2 py-0.5 rounded-full ${STATUS_STYLES[com.status] || ''}`}>
                        {getLabel(COMMISSION_STATUSES, com.status)}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-center gap-1">
                        {canApprove && com.status === 'PENDING' && (
                          <button
                            onClick={() => handleApprove(com)}
                            title="Approve"
                            className={`p-1.5 rounded-lg transition-colors ${isDark ? 'hover:bg-green-900/30 text-green-400' : 'hover:bg-green-50 text-green-600'}`}
                          >
                            <CheckCircle className="w-4 h-4" />
                          </button>
                        )}
                        {com.status === 'APPROVED' && (
                          <button
                            onClick={() => openPayModal(com)}
                            title="Mark as Paid"
                            className={`p-1.5 rounded-lg transition-colors ${isDark ? 'hover:bg-emerald-900/30 text-emerald-400' : 'hover:bg-emerald-50 text-emerald-600'}`}
                          >
                            <Banknote className="w-4 h-4" />
                          </button>
                        )}
                        {canUpdate && (com.status === 'PENDING' || com.status === 'HELD') && (
                          <button
                            onClick={() => handleCancel(com)}
                            title="Cancel"
                            className={`p-1.5 rounded-lg transition-colors ${isDark ? 'hover:bg-red-900/30 text-red-400' : 'hover:bg-red-50 text-red-600'}`}
                          >
                            <Ban className="w-4 h-4" />
                          </button>
                        )}
                        {canUpdate && (
                          <button
                            onClick={() => openEdit(com)}
                            title="Edit"
                            className={`p-1.5 rounded-lg transition-colors ${isDark ? 'hover:bg-blue-900/30 text-blue-400' : 'hover:bg-blue-50 text-blue-600'}`}
                          >
                            <Edit2 className="w-4 h-4" />
                          </button>
                        )}
                        {canDelete && (com.status === 'PENDING' || com.status === 'CANCELLED' || com.status === 'HELD') && (
                          <button
                            onClick={() => { setDeleteTarget({ id: com.id, name: com.person_name }); setShowDeleteModal(true); }}
                            title="Delete"
                            className={`p-1.5 rounded-lg transition-colors ${isDark ? 'hover:bg-red-900/30 text-red-400' : 'hover:bg-red-50 text-red-600'}`}
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="flex items-center justify-between mt-4">
            <p className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
              Showing {(page - 1) * perPage + 1}-{Math.min(page * perPage, commissions.length)} of {commissions.length}
            </p>
            <div className="flex gap-1">
              <button
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page === 1}
                className={`px-3 py-1.5 rounded-lg text-sm ${page === 1 ? 'opacity-40 cursor-not-allowed' : isDark ? 'hover:bg-gray-700 text-gray-300' : 'hover:bg-gray-100 text-gray-600'}`}
              >
                <ChevronLeft className="w-4 h-4" />
              </button>
              {Array.from({ length: totalPages }, (_, i) => i + 1).map((p) => (
                <button
                  key={p}
                  onClick={() => setPage(p)}
                  className={`px-3 py-1.5 rounded-lg text-sm font-medium ${p === page ? 'bg-blue-600 text-white' : isDark ? 'hover:bg-gray-700 text-gray-300' : 'hover:bg-gray-100 text-gray-600'}`}
                >
                  {p}
                </button>
              ))}
              <button
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                disabled={page === totalPages}
                className={`px-3 py-1.5 rounded-lg text-sm ${page === totalPages ? 'opacity-40 cursor-not-allowed' : isDark ? 'hover:bg-gray-700 text-gray-300' : 'hover:bg-gray-100 text-gray-600'}`}
              >
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>
          </div>
        )}
      </>
    );
  };

  // ==========================================
  // RENDER: SUMMARY TABS
  // ==========================================
  const renderSummary = () => {
    const summaryCardCls = `rounded-xl border p-6 ${isDark ? 'bg-gray-800 border-gray-700' : 'bg-white border-gray-200'}`;

    const renderPersonTable = (rows: CommissionByPersonRow[]) => (
      <div className={summaryCardCls}>
        <h3 className={`text-lg font-semibold mb-4 ${isDark ? 'text-white' : 'text-gray-900'}`}>Commission by Person</h3>
        {rows.length === 0 ? (
          <p className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>No data</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className={isDark ? 'bg-gray-900/50' : 'bg-gray-50'}>
                  <th className={`px-4 py-2 text-left font-semibold ${isDark ? 'text-gray-300' : 'text-gray-600'}`}>Person</th>
                  <th className={`px-4 py-2 text-center font-semibold ${isDark ? 'text-gray-300' : 'text-gray-600'}`}>Type</th>
                  <th className={`px-4 py-3 text-center font-semibold ${isDark ? 'text-gray-300' : 'text-gray-600'}`}>Count</th>
                  <th className={`px-4 py-2 text-right font-semibold ${isDark ? 'text-gray-300' : 'text-gray-600'}`}>Base Total</th>
                  <th className={`px-4 py-2 text-right font-semibold ${isDark ? 'text-gray-300' : 'text-gray-600'}`}>Commission</th>
                  <th className={`px-4 py-2 text-right font-semibold ${isDark ? 'text-gray-300' : 'text-gray-600'}`}>Tax</th>
                  <th className={`px-4 py-2 text-right font-semibold ${isDark ? 'text-gray-300' : 'text-gray-600'}`}>Net</th>
                </tr>
              </thead>
              <tbody className={`divide-y ${isDark ? 'divide-gray-700' : 'divide-gray-100'}`}>
                {rows.map((r, i) => (
                  <tr key={i} className={isDark ? 'hover:bg-gray-700/50' : 'hover:bg-gray-50'}>
                    <td className={`px-4 py-2 font-medium ${isDark ? 'text-white' : 'text-gray-900'}`}>{r.person_name}</td>
                    <td className="px-4 py-2 text-center">
                      <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${PERSON_TYPE_STYLES[r.person_type] || ''}`}>
                        {r.person_type}
                      </span>
                    </td>
                    <td className={`px-4 py-2 text-center ${isDark ? 'text-gray-300' : 'text-gray-700'}`}>{r.commission_count}</td>
                    <td className={`px-4 py-2 text-right font-mono text-xs ${isDark ? 'text-gray-300' : 'text-gray-700'}`}>{formatCurrency(r.total_base_amount, r.currency)}</td>
                    <td className={`px-4 py-2 text-right font-mono text-xs font-semibold ${isDark ? 'text-white' : 'text-gray-900'}`}>{formatCurrency(r.total_commission, r.currency)}</td>
                    <td className={`px-4 py-2 text-right font-mono text-xs ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>{formatCurrency(r.total_tax_withheld, r.currency)}</td>
                    <td className={`px-4 py-2 text-right font-mono text-xs font-semibold ${isDark ? 'text-emerald-400' : 'text-emerald-700'}`}>{formatCurrency(r.total_net_amount, r.currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    );

    const renderProjectTable = (rows: CommissionByProjectRow[]) => (
      <div className={summaryCardCls}>
        <h3 className={`text-lg font-semibold mb-4 ${isDark ? 'text-white' : 'text-gray-900'}`}>Commission by Project</h3>
        {rows.length === 0 ? (
          <p className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>No data</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className={isDark ? 'bg-gray-900/50' : 'bg-gray-50'}>
                  <th className={`px-4 py-2 text-left font-semibold ${isDark ? 'text-gray-300' : 'text-gray-600'}`}>Project</th>
                  <th className={`px-4 py-2 text-center font-semibold ${isDark ? 'text-gray-300' : 'text-gray-600'}`}>Count</th>
                  <th className={`px-4 py-2 text-right font-semibold ${isDark ? 'text-gray-300' : 'text-gray-600'}`}>Base Total</th>
                  <th className={`px-4 py-2 text-right font-semibold ${isDark ? 'text-gray-300' : 'text-gray-600'}`}>Commission</th>
                  <th className={`px-4 py-2 text-right font-semibold ${isDark ? 'text-gray-300' : 'text-gray-600'}`}>Tax</th>
                  <th className={`px-4 py-2 text-right font-semibold ${isDark ? 'text-gray-300' : 'text-gray-600'}`}>Net</th>
                </tr>
              </thead>
              <tbody className={`divide-y ${isDark ? 'divide-gray-700' : 'divide-gray-100'}`}>
                {rows.map((r, i) => (
                  <tr key={i} className={isDark ? 'hover:bg-gray-700/50' : 'hover:bg-gray-50'}>
                    <td className={`px-4 py-2 font-medium ${isDark ? 'text-white' : 'text-gray-900'}`}>{r.project_name}</td>
                    <td className={`px-4 py-2 text-center ${isDark ? 'text-gray-300' : 'text-gray-700'}`}>{r.commission_count}</td>
                    <td className={`px-4 py-2 text-right font-mono text-xs ${isDark ? 'text-gray-300' : 'text-gray-700'}`}>{formatCurrency(r.total_base_amount, r.currency)}</td>
                    <td className={`px-4 py-2 text-right font-mono text-xs font-semibold ${isDark ? 'text-white' : 'text-gray-900'}`}>{formatCurrency(r.total_commission, r.currency)}</td>
                    <td className={`px-4 py-2 text-right font-mono text-xs ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>{formatCurrency(r.total_tax_withheld, r.currency)}</td>
                    <td className={`px-4 py-2 text-right font-mono text-xs font-semibold ${isDark ? 'text-emerald-400' : 'text-emerald-700'}`}>{formatCurrency(r.total_net_amount, r.currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    );

    const renderTypeTable = (rows: CommissionByTypeRow[]) => (
      <div className={summaryCardCls}>
        <h3 className={`text-lg font-semibold mb-4 ${isDark ? 'text-white' : 'text-gray-900'}`}>Commission by Type</h3>
        {rows.length === 0 ? (
          <p className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>No data</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className={isDark ? 'bg-gray-900/50' : 'bg-gray-50'}>
                  <th className={`px-4 py-2 text-left font-semibold ${isDark ? 'text-gray-300' : 'text-gray-600'}`}>Type</th>
                  <th className={`px-4 py-2 text-left font-semibold ${isDark ? 'text-gray-300' : 'text-gray-600'}`}>Basis</th>
                  <th className={`px-4 py-2 text-center font-semibold ${isDark ? 'text-gray-300' : 'text-gray-600'}`}>Count</th>
                  <th className={`px-4 py-2 text-right font-semibold ${isDark ? 'text-gray-300' : 'text-gray-600'}`}>Commission</th>
                  <th className={`px-4 py-2 text-right font-semibold ${isDark ? 'text-gray-300' : 'text-gray-600'}`}>Tax</th>
                  <th className={`px-4 py-2 text-right font-semibold ${isDark ? 'text-gray-300' : 'text-gray-600'}`}>Net</th>
                </tr>
              </thead>
              <tbody className={`divide-y ${isDark ? 'divide-gray-700' : 'divide-gray-100'}`}>
                {rows.map((r, i) => (
                  <tr key={i} className={isDark ? 'hover:bg-gray-700/50' : 'hover:bg-gray-50'}>
                    <td className="px-4 py-2">
                      <span className={`inline-block text-[10px] font-medium px-1.5 py-0.5 rounded ${COMMISSION_TYPE_STYLES[r.commission_type] || ''}`}>
                        {getLabel(COMMISSION_TYPES, r.commission_type)}
                      </span>
                    </td>
                    <td className={`px-4 py-2 text-xs ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>{getLabel(CALCULATION_BASES, r.calculation_basis)}</td>
                    <td className={`px-4 py-2 text-center ${isDark ? 'text-gray-300' : 'text-gray-700'}`}>{r.commission_count}</td>
                    <td className={`px-4 py-2 text-right font-mono text-xs font-semibold ${isDark ? 'text-white' : 'text-gray-900'}`}>{formatCurrency(r.total_commission, stats?.topCurrency || 'PKR')}</td>
                    <td className={`px-4 py-2 text-right font-mono text-xs ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>{formatCurrency(r.total_tax_withheld, stats?.topCurrency || 'PKR')}</td>
                    <td className={`px-4 py-2 text-right font-mono text-xs font-semibold ${isDark ? 'text-emerald-400' : 'text-emerald-700'}`}>{formatCurrency(r.total_net_amount, stats?.topCurrency || 'PKR')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    );

    return (
      <div>
        {/* Sub-tabs */}
        <div className="flex gap-2 mb-4">
          {([
            { key: 'person' as const, label: 'By Person', icon: Users },
            { key: 'project' as const, label: 'By Project', icon: FolderOpen },
            { key: 'type' as const, label: 'By Type', icon: BarChart3 },
          ]).map((tab) => (
            <button
              key={tab.key}
              onClick={() => setSummaryView(tab.key)}
              className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                summaryView === tab.key
                  ? 'bg-blue-600 text-white'
                  : isDark ? 'bg-gray-700 text-gray-300 hover:bg-gray-600' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
              }`}
            >
              <tab.icon className="w-4 h-4" />
              {tab.label}
            </button>
          ))}
        </div>

        {summaryView === 'person' && renderPersonTable(byPerson)}
        {summaryView === 'project' && renderProjectTable(byProject)}
        {summaryView === 'type' && renderTypeTable(byType)}
      </div>
    );
  };

  // ==========================================
  // RENDER: FORM MODAL
  // ==========================================
  const renderFormModal = () => {
    if (!showForm) return null;
    const isEdit = !!editingCom;
    const isPercentage = form.commission_type === 'PERCENTAGE';
    const preview = previewCommission();

    const onContractorSelect = (contractorId: string) => {
      const sel = contractors.find((c) => c.id === contractorId);
      setForm({
        ...form,
        contractor_id: contractorId,
        person_name: sel?.name || form.person_name,
        person_type: 'CONTRACTOR',
      });
    };

    return (
      <div className={modalOverlay} onClick={() => setShowForm(false)}>
        <div className={modalBox} onClick={(e) => e.stopPropagation()}>
          <div className="flex items-center justify-between mb-6">
            <h2 className={`text-lg font-bold ${isDark ? 'text-white' : 'text-gray-900'}`}>
              {isEdit ? 'Edit Commission' : 'Add Commission'}
            </h2>
            <button onClick={() => setShowForm(false)} className={`p-1 rounded-lg ${isDark ? 'hover:bg-gray-700 text-gray-400' : 'hover:bg-gray-100 text-gray-500'}`}>
              <X className="w-5 h-5" />
            </button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Person Name */}
            <div>
              <label className={labelCls + ` ${isDark ? 'text-gray-300' : 'text-gray-700'}`}>Person Name *</label>
              <input
                type="text"
                value={form.person_name}
                onChange={(e) => setForm({ ...form, person_name: e.target.value })}
                placeholder="Name of the person"
                className={inputCls}
              />
            </div>

            {/* Link to Contractor (optional) */}
            <div>
              <label className={labelCls + ` ${isDark ? 'text-gray-300' : 'text-gray-700'}`}>Link Contractor (optional)</label>
              <select
                value={form.contractor_id}
                onChange={(e) => onContractorSelect(e.target.value)}
                className={inputCls}
              >
                <option value="">-- None --</option>
                {contractors.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            </div>

            {/* Person Type */}
            <div>
              <label className={labelCls + ` ${isDark ? 'text-gray-300' : 'text-gray-700'}`}>Person Type</label>
              <select value={form.person_type} onChange={(e) => setForm({ ...form, person_type: e.target.value })} className={inputCls}>
                {PERSON_TYPES.map((p) => (
                  <option key={p.value} value={p.value}>{p.label}</option>
                ))}
              </select>
            </div>

            {/* Commission Type */}
            <div>
              <label className={labelCls + ` ${isDark ? 'text-gray-300' : 'text-gray-700'}`}>Commission Type *</label>
              <select value={form.commission_type} onChange={(e) => setForm({ ...form, commission_type: e.target.value })} className={inputCls}>
                {COMMISSION_TYPES.map((t) => (
                  <option key={t.value} value={t.value}>{t.label}</option>
                ))}
              </select>
            </div>

            {/* Calculation Basis */}
            <div>
              <label className={labelCls + ` ${isDark ? 'text-gray-300' : 'text-gray-700'}`}>Calculation Basis</label>
              <select value={form.calculation_basis} onChange={(e) => setForm({ ...form, calculation_basis: e.target.value })} className={inputCls}>
                {CALCULATION_BASES.map((b) => (
                  <option key={b.value} value={b.value}>{b.label}</option>
                ))}
              </select>
            </div>

            {/* Rate or Amount */}
            <div>
              <label className={labelCls + ` ${isDark ? 'text-gray-300' : 'text-gray-700'}`}>{isPercentage ? 'Rate (%) *' : 'Amount *'}</label>
              <input
                type="number"
                step="0.01"
                min="0"
                value={form.rate_or_amount}
                onChange={(e) => setForm({ ...form, rate_or_amount: e.target.value })}
                placeholder={isPercentage ? 'e.g. 10.5' : 'e.g. 5000'}
                className={inputCls}
              />
            </div>

            {/* Base Amount */}
            <div>
              <label className={labelCls + ` ${isDark ? 'text-gray-300' : 'text-gray-700'}`}>Base Amount *</label>
              <input
                type="number"
                step="0.01"
                min="0"
                value={form.base_amount}
                onChange={(e) => setForm({ ...form, base_amount: e.target.value })}
                placeholder="Revenue / Invoice / Milestone value"
                className={inputCls}
              />
            </div>

            {/* Commission Amount (auto-calculated for %) */}
            <div>
              <label className={labelCls + ` ${isDark ? 'text-gray-300' : 'text-gray-700'}`}>Commission Amount</label>
              <input
                type="number"
                step="0.01"
                min="0"
                value={isPercentage ? String(preview) : form.commission_amount}
                onChange={(e) => setForm({ ...form, commission_amount: e.target.value })}
                placeholder={isPercentage ? 'Auto-calculated' : 'Enter amount'}
                className={`${inputCls} ${isPercentage ? 'opacity-70' : ''}`}
                readOnly={isPercentage}
              />
              {isPercentage && (
                <p className={`text-[11px] mt-1 ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
                  Auto: {form.base_amount} x {form.rate_or_amount}% = {formatCurrency(preview, form.currency)}
                </p>
              )}
            </div>

            {/* Currency */}
            <div>
              <label className={labelCls + ` ${isDark ? 'text-gray-300' : 'text-gray-700'}`}>Currency</label>
              <select value={form.currency} onChange={(e) => setForm({ ...form, currency: e.target.value })} className={inputCls}>
                <option value="PKR">PKR</option>
                <option value="USD">USD</option>
                <option value="EUR">EUR</option>
                <option value="GBP">GBP</option>
                <option value="SAR">SAR</option>
                <option value="AED">AED</option>
              </select>
            </div>

            {/* Tax Withheld */}
            <div>
              <label className={labelCls + ` ${isDark ? 'text-gray-300' : 'text-gray-700'}`}>Tax Withheld</label>
              <input
                type="number"
                step="0.01"
                min="0"
                value={form.tax_withheld}
                onChange={(e) => setForm({ ...form, tax_withheld: e.target.value })}
                placeholder="0"
                className={inputCls}
              />
            </div>

            {/* Project */}
            <div>
              <label className={labelCls + ` ${isDark ? 'text-gray-300' : 'text-gray-700'}`}>Project (optional)</label>
              <select value={form.project_id} onChange={(e) => setForm({ ...form, project_id: e.target.value })} className={inputCls}>
                <option value="">-- None --</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            </div>

            {/* Invoice Ref */}
            <div>
              <label className={labelCls + ` ${isDark ? 'text-gray-300' : 'text-gray-700'}`}>Invoice Reference</label>
              <input
                type="text"
                value={form.invoice_ref}
                onChange={(e) => setForm({ ...form, invoice_ref: e.target.value })}
                placeholder="INV-001"
                className={inputCls}
              />
            </div>

            {/* Milestone Ref */}
            <div>
              <label className={labelCls + ` ${isDark ? 'text-gray-300' : 'text-gray-700'}`}>Milestone Reference</label>
              <input
                type="text"
                value={form.milestone_ref}
                onChange={(e) => setForm({ ...form, milestone_ref: e.target.value })}
                placeholder="M1, M2..."
                className={inputCls}
              />
            </div>

            {/* Period Start */}
            <div>
              <label className={labelCls + ` ${isDark ? 'text-gray-300' : 'text-gray-700'}`}>Period Start</label>
              <input
                type="date"
                value={form.period_start}
                onChange={(e) => setForm({ ...form, period_start: e.target.value })}
                className={inputCls}
              />
            </div>

            {/* Period End */}
            <div>
              <label className={labelCls + ` ${isDark ? 'text-gray-300' : 'text-gray-700'}`}>Period End</label>
              <input
                type="date"
                value={form.period_end}
                onChange={(e) => setForm({ ...form, period_end: e.target.value })}
                className={inputCls}
              />
            </div>

            {/* Status (edit only) */}
            {isEdit && (
              <div>
                <label className={labelCls + ` ${isDark ? 'text-gray-300' : 'text-gray-700'}`}>Status</label>
                <select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })} className={inputCls}>
                  {COMMISSION_STATUSES.map((s) => (
                    <option key={s.value} value={s.value}>{s.label}</option>
                  ))}
                </select>
              </div>
            )}

            {/* Payment Date (edit only) */}
            {isEdit && (
              <div>
                <label className={labelCls + ` ${isDark ? 'text-gray-300' : 'text-gray-700'}`}>Payment Date</label>
                <input
                  type="date"
                  value={form.payment_date}
                  onChange={(e) => setForm({ ...form, payment_date: e.target.value })}
                  className={inputCls}
                />
              </div>
            )}

            {/* Payment Ref (edit only) */}
            {isEdit && (
              <div>
                <label className={labelCls + ` ${isDark ? 'text-gray-300' : 'text-gray-700'}`}>Payment Reference</label>
                <input
                  type="text"
                  value={form.payment_ref}
                  onChange={(e) => setForm({ ...form, payment_ref: e.target.value })}
                  placeholder="TXN-001"
                  className={inputCls}
                />
              </div>
            )}

            {/* Notes */}
            <div className="md:col-span-2">
              <label className={labelCls + ` ${isDark ? 'text-gray-300' : 'text-gray-700'}`}>Notes</label>
              <textarea
                value={form.notes}
                onChange={(e) => setForm({ ...form, notes: e.target.value })}
                placeholder="Additional notes..."
                rows={3}
                className={inputCls}
              />
            </div>
          </div>

          {/* Actions */}
          <div className="flex items-center justify-end gap-3 mt-6 pt-4 border-t ${isDark ? 'border-gray-700' : 'border-gray-200'}">
            <button
              onClick={() => setShowForm(false)}
              className={`px-4 py-2 rounded-lg text-sm font-medium ${isDark ? 'bg-gray-700 text-gray-300 hover:bg-gray-600' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              disabled={createMut.isPending || updateMut.isPending}
              className="px-4 py-2 rounded-lg text-sm font-medium bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 flex items-center gap-2"
            >
              {(createMut.isPending || updateMut.isPending) && <Loader2 className="w-4 h-4 animate-spin" />}
              {isEdit ? 'Update' : 'Create'}
            </button>
          </div>
        </div>
      </div>
    );
  };

  // ==========================================
  // RENDER: DELETE MODAL
  // ==========================================
  const renderDeleteModal = () => {
    if (!showDeleteModal || !deleteTarget) return null;
    return (
      <div className={modalOverlay} onClick={() => setShowDeleteModal(false)}>
        <div className={modalBoxSm} onClick={(e) => e.stopPropagation()}>
          <div className="text-center">
            <div className={`mx-auto mb-4 w-14 h-14 rounded-full flex items-center justify-center ${isDark ? 'bg-red-900/30' : 'bg-red-50'}`}>
              <AlertTriangle className="w-7 h-7 text-red-500" />
            </div>
            <h3 className={`text-lg font-bold mb-2 ${isDark ? 'text-white' : 'text-gray-900'}`}>Delete Commission?</h3>
            <p className={`text-sm mb-6 ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
              Are you sure you want to delete the commission for <strong className={isDark ? 'text-white' : 'text-gray-900'}>{deleteTarget.name}</strong>? This action cannot be undone.
            </p>
            <div className="flex items-center justify-center gap-3">
              <button
                onClick={() => setShowDeleteModal(false)}
                className={`px-4 py-2 rounded-lg text-sm font-medium ${isDark ? 'bg-gray-700 text-gray-300 hover:bg-gray-600' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}
              >
                Cancel
              </button>
              <button
                onClick={handleDelete}
                disabled={deleteMut.isPending}
                className="px-4 py-2 rounded-lg text-sm font-medium bg-red-600 text-white hover:bg-red-700 disabled:opacity-50 flex items-center gap-2"
              >
                {deleteMut.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
                Delete
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  };

  // ==========================================
  // RENDER: MARK PAID MODAL
  // ==========================================
  const renderPayModal = () => {
    if (!showPayModal || !payTarget) return null;
    return (
      <div className={modalOverlay} onClick={() => setShowPayModal(false)}>
        <div className={modalBoxSm} onClick={(e) => e.stopPropagation()}>
          <div className="flex items-center justify-between mb-4">
            <h3 className={`text-lg font-bold ${isDark ? 'text-white' : 'text-gray-900'}`}>Mark as Paid</h3>
            <button onClick={() => setShowPayModal(false)} className={`p-1 rounded-lg ${isDark ? 'hover:bg-gray-700 text-gray-400' : 'hover:bg-gray-100 text-gray-500'}`}>
              <X className="w-5 h-5" />
            </button>
          </div>

          <div className={`rounded-lg p-3 mb-4 ${isDark ? 'bg-gray-900/50' : 'bg-gray-50'}`}>
            <p className={`text-xs ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>Person</p>
            <p className={`font-medium ${isDark ? 'text-white' : 'text-gray-900'}`}>{payTarget.person_name}</p>
            <p className={`text-xs mt-2 ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>Net Amount</p>
            <p className={`text-lg font-bold ${isDark ? 'text-emerald-400' : 'text-emerald-700'}`}>{formatCurrency(payTarget.net_amount, payTarget.currency)}</p>
          </div>

          <div className="space-y-4">
            <div>
              <label className={labelCls + ` ${isDark ? 'text-gray-300' : 'text-gray-700'}`}>Payment Date *</label>
              <input
                type="date"
                value={payDate}
                onChange={(e) => setPayDate(e.target.value)}
                className={inputCls}
              />
            </div>
            <div>
              <label className={labelCls + ` ${isDark ? 'text-gray-300' : 'text-gray-700'}`}>Payment Reference</label>
              <input
                type="text"
                value={payRef}
                onChange={(e) => setPayRef(e.target.value)}
                placeholder="TXN-001, CHK-123..."
                className={inputCls}
              />
            </div>
          </div>

          <div className="flex items-center justify-end gap-3 mt-6 pt-4 border-t ${isDark ? 'border-gray-700' : 'border-gray-200'}">
            <button
              onClick={() => setShowPayModal(false)}
              className={`px-4 py-2 rounded-lg text-sm font-medium ${isDark ? 'bg-gray-700 text-gray-300 hover:bg-gray-600' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}
            >
              Cancel
            </button>
            <button
              onClick={handleMarkPaid}
              disabled={paidMut.isPending}
              className="px-4 py-2 rounded-lg text-sm font-medium bg-green-600 text-white hover:bg-green-700 disabled:opacity-50 flex items-center gap-2"
            >
              {paidMut.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
              Confirm Payment
            </button>
          </div>
        </div>
      </div>
    );
  };

  // ==========================================
  // MAIN RENDER
  // ==========================================
  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className={`text-2xl font-bold ${isDark ? 'text-white' : 'text-gray-900'}`}>Commissions</h1>
          <p className={`text-sm mt-1 ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>Track contractor and employee commission earnings, approvals, and payments</p>
        </div>
        {canAdd && (
          <button
            onClick={openCreate}
            className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium bg-blue-600 text-white hover:bg-blue-700 transition-colors shadow-sm"
          >
            <Plus className="w-4 h-4" />
            Add Commission
          </button>
        )}
      </div>

      {/* Tabs */}
      <div className="flex gap-2">
        {([
          { key: 'all' as const, label: 'All Commissions', icon: Percent },
          { key: 'summary' as const, label: 'Summary', icon: BarChart3 },
        ]).map((tab) => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
              activeTab === tab.key
                ? 'bg-blue-600 text-white'
                : isDark ? 'bg-gray-800 text-gray-300 hover:bg-gray-700' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
            }`}
          >
            <tab.icon className="w-4 h-4" />
            {tab.label}
          </button>
        ))}
      </div>

      {/* Stats */}
      {renderStats()}

      {/* Content */}
      {activeTab === 'all' && (
        <>
          {renderFilters()}
          {renderTable()}
        </>
      )}

      {activeTab === 'summary' && renderSummary()}

      {/* Modals */}
      {renderFormModal()}
      {renderDeleteModal()}
      {renderPayModal()}
    </div>
  );
}
