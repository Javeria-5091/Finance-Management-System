'use client';

import { useState, useEffect, useMemo } from 'react';
import {
  Search,
  Filter,
  Plus,
  Edit2,
  Power,
  PowerOff,
  ChevronRight,
  ChevronDown,
  AlertTriangle,
  X,
} from 'lucide-react';
import { getCOATree, getPostableAccounts, createAccount, updateAccount, deactivateAccount, reactivateAccount } from '@/types/services/coa.service';
import { getParentAccounts } from '@/types/services/coa.service';
import type { ChartOfAccountTree, AccountType, NormalBalance, CreateAccountInput } from '@/types/accounting.types';

// ==========================================
// CONSTANTS (Dark Mode Ready)
// ==========================================

const ACCOUNT_TYPE_COLORS: Record<AccountType, string> = {
  ASSET: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
  LIABILITY: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
  EQUITY: 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400',
  REVENUE: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400',
  COST_OF_SALES: 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400',
  OPERATING_EXPENSE: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400',
  OTHER_INCOME: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400',
  OTHER_EXPENSE: 'bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-400',
};

const ACCOUNT_TYPES: AccountType[] = [
  'ASSET',
  'LIABILITY',
  'EQUITY',
  'REVENUE',
  'COST_OF_SALES',
  'OPERATING_EXPENSE',
  'OTHER_INCOME',
  'OTHER_EXPENSE',
];

const REPORT_MAPPINGS = [
  'BALANCE_SHEET_CURRENT_ASSETS',
  'BALANCE_SHEET_NON_CURRENT_ASSETS',
  'BALANCE_SHEET_NON_CURRENT_ASSETS_CONTRA',
  'BALANCE_SHEET_CURRENT_LIABILITIES',
  'BALANCE_SHEET_NON_CURRENT_LIABILITIES',
  'BALANCE_SHEET_EQUITY',
  'PROFIT_LOSS_REVENUE',
  'PROFIT_LOSS_COS',
  'PROFIT_LOSS_OP_EXPENSE',
  'PROFIT_LOSS_OTHER_INCOME',
  'PROFIT_LOSS_OTHER_EXPENSE',
  'PROFIT_LOSS_TAX',
];

// ==========================================
// MAIN COMPONENT
// ==========================================

export default function ChartOfAccountsPage() {
  const [tree, setTree] = useState<ChartOfAccountTree[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [filterType, setFilterType] = useState<AccountType | 'ALL'>('ALL');
  const [filterStatus, setFilterStatus] = useState<'all' | 'active' | 'inactive'>('all');
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

  // Modal states
  const [showModal, setShowModal] = useState(false);
  const [editingAccount, setEditingAccount] = useState<ChartOfAccountTree | null>(null);
  const [parentAccounts, setParentAccounts] = useState<any[]>([]);
  const [saving, setSaving] = useState(false);

  // Form state
  const [form, setForm] = useState<CreateAccountInput & { is_active?: boolean }>({
    code: '',
    name: '',
    parent_id: null,
    account_type: 'ASSET',
    normal_balance: 'DEBIT',
    currency: 'PKR',
    posting_allowed: true,
    is_control_account: false,
    report_mapping: null,
    description: null,
  });

  // ==========================================
  // DATA FETCHING
  // ==========================================

  useEffect(() => {
    loadTree();
  }, []);

  const loadTree = async () => {
    try {
      setLoading(true);
      const data = await getCOATree();
      setTree(data);
      // Auto-expand root level
      const rootIds = new Set(data.filter((n) => n.depth === 0).map((n) => n.id));
      setExpandedIds(rootIds);
    } catch (error) {
      console.error('Failed to load COA:', error);
    } finally {
      setLoading(false);
    }
  };

  const loadParentAccounts = async () => {
    try {
      const data = await getParentAccounts();
      setParentAccounts(data);
    } catch (error) {
      console.error('Failed to load parent accounts:', error);
    }
  };

  // ==========================================
  // TREE OPERATIONS
  // ==========================================

  const toggleExpand = (id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const filterTree = useMemo(() => {
    if (!search && filterType === 'ALL' && filterStatus === 'all') {
      return tree;
    }

    const matchesFilter = (node: ChartOfAccountTree): boolean => {
      const matchesSearch =
        !search ||
        node.code.toLowerCase().includes(search.toLowerCase()) ||
        node.name.toLowerCase().includes(search.toLowerCase());

      const matchesType = filterType === 'ALL' || node.account_type === filterType;
      const matchesStatus =
        filterStatus === 'all' ||
        (filterStatus === 'active' && node.is_active) ||
        (filterStatus === 'inactive' && !node.is_active);

      return matchesSearch && matchesType && matchesStatus;
    };

    // Recursive filter - keep parent if any child matches
    const filterNode = (node: ChartOfAccountTree): ChartOfAccountTree | null => {
      const selfMatch = matchesFilter(node);
      const filteredChildren = (node.children || [])
        .map(filterNode)
        .filter(Boolean) as ChartOfAccountTree[];

      if (selfMatch || filteredChildren.length > 0) {
        return {
          ...node,
          children: filteredChildren,
        };
      }
      return null;
    };

    return tree.map(filterNode).filter(Boolean) as ChartOfAccountTree[];
  }, [tree, search, filterType, filterStatus]);

  // ==========================================
  // MODAL OPERATIONS
  // ==========================================

  const openCreateModal = async () => {
    setEditingAccount(null);
    setForm({
      code: '',
      name: '',
      parent_id: null,
      account_type: 'ASSET',
      normal_balance: 'DEBIT',
      currency: 'PKR',
      posting_allowed: true,
      is_control_account: false,
      report_mapping: null,
      description: null,
    });
    await loadParentAccounts();
    setShowModal(true);
  };

  const openEditModal = async (account: ChartOfAccountTree) => {
    setEditingAccount(account);
    setForm({
      code: account.code,
      name: account.name,
      parent_id: account.parent_id,
      account_type: account.account_type,
      normal_balance: account.normal_balance,
      currency: account.currency,
      posting_allowed: account.posting_allowed,
      is_control_account: account.is_control_account,
      report_mapping: account.report_mapping,
      description: account.description,
      is_active: account.is_active,
    });
    await loadParentAccounts();
    setShowModal(true);
  };

  const handleSave = async () => {
    if (!form.code.trim() || !form.name.trim()) return;

    try {
      setSaving(true);
      if (editingAccount) {
        await updateAccount(editingAccount.id, form);
      } else {
        await createAccount(form);
      }
      setShowModal(false);
      await loadTree();
    } catch (error) {
      console.error('Failed to save account:', error);
      alert('Failed to save account. Check console for details.');
    } finally {
      setSaving(false);
    }
  };

  const handleToggleActive = async (account: ChartOfAccountTree) => {
    if (!confirm(`Are you sure you want to ${account.is_active ? 'deactivate' : 'reactivate'} "${account.name}"?`)) {
      return;
    }

    try {
      if (account.is_active) {
        await deactivateAccount(account.id);
      } else {
        await reactivateAccount(account.id);
      }
      await loadTree();
    } catch (error) {
      console.error('Failed to toggle account:', error);
    }
  };

  // Auto-set normal balance when account type changes
  const handleAccountTypeChange = (type: AccountType) => {
    const debitTypes: AccountType[] = ['ASSET', 'COST_OF_SALES', 'OPERATING_EXPENSE', 'OTHER_EXPENSE'];
    setForm({
      ...form,
      account_type: type,
      normal_balance: debitTypes.includes(type) ? 'DEBIT' : 'CREDIT',
    });
  };

  // ==========================================
  // RENDER HELPERS
  // ==========================================

  const renderTreeNode = (node: ChartOfAccountTree, depth: number = 0) => {
    const hasChildren = node.children && node.children.length > 0;
    const isExpanded = expandedIds.has(node.id);
    const isPostable = node.posting_allowed && node.level >= 2;

    return (
      <div key={node.id}>
        <div
          className={`
            flex items-center gap-2 px-3 py-2 hover:bg-gray-50 dark:hover:bg-gray-700/30 
            border-b border-gray-100 dark:border-gray-700/50
            ${!node.is_active ? 'opacity-50' : ''}
          `}
          style={{ paddingLeft: `${depth * 24 + 12}px` }}
        >
          {/* Expand/Collapse */}
          <button
            onClick={() => hasChildren && toggleExpand(node.id)}
            className={`w-5 h-5 flex items-center justify-center flex-shrink-0 ${
              hasChildren ? 'text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300' : 'text-transparent'
            }`}
          >
            {hasChildren ? (
              isExpanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />
            ) : (
              <span className="w-2 h-2 rounded-full bg-gray-300 dark:bg-gray-600" />
            )}
          </button>

          {/* Code */}
          <span className="font-mono text-sm text-gray-500 dark:text-gray-400 w-20 flex-shrink-0">
            {node.code}
          </span>

          {/* Name */}
          <span className="text-sm text-gray-900 dark:text-white flex-1 truncate">{node.name}</span>

          {/* Type Badge */}
          <span
            className={`px-2 py-0.5 rounded text-xs font-medium ${
              ACCOUNT_TYPE_COLORS[node.account_type]
            }`}
          >
            {node.account_type.replace(/_/g, ' ')}
          </span>

          {/* Normal Balance */}
          <span
            className={`text-xs font-medium px-1.5 py-0.5 rounded bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300`}
          >
            {node.normal_balance}
          </span>

          {/* Status */}
          {node.level >= 2 && (
            <span
              className={`text-xs px-1.5 py-0.5 rounded ${
                node.is_active
                  ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
                  : 'bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-400'
              }`}
            >
              {node.is_active ? 'Active' : 'Inactive'}
            </span>
          )}

          {/* Control Account Badge */}
          {node.is_control_account && (
            <span className="text-xs px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400">
              Control
            </span>
          )}

          {/* Actions (only for detail accounts) */}
          {isPostable && (
            <div className="flex items-center gap-1 ml-2">
              <button
                onClick={() => openEditModal(node)}
                className="p-1 rounded hover:bg-gray-200 dark:hover:bg-gray-600 text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-200 transition-colors"
                title="Edit"
              >
                <Edit2 className="w-3.5 h-3.5" />
              </button>
              <button
                onClick={() => handleToggleActive(node)}
                className={`p-1 rounded hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors ${
                  node.is_active
                    ? 'text-orange-400 dark:text-orange-500 hover:text-orange-600 dark:hover:text-orange-300'
                    : 'text-green-400 dark:text-green-500 hover:text-green-600 dark:hover:text-green-300'
                }`}
                title={node.is_active ? 'Deactivate' : 'Reactivate'}
              >
                {node.is_active ? (
                  <PowerOff className="w-3.5 h-3.5" />
                ) : (
                  <Power className="w-3.5 h-3.5" />
                )}
              </button>
            </div>
          )}
        </div>

        {/* Children */}
        {hasChildren && isExpanded && (
          <div>
            {node.children!.map((child) => renderTreeNode(child, depth + 1))}
          </div>
        )}
      </div>
    );
  };

  // ==========================================
  // MAIN RENDER (FULL DARK MODE)
  // ==========================================

  return (
    <div className="p-6 max-w-full">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Chart of Accounts</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
            Manage your organization&apos;s account structure
          </p>
        </div>
        <button
          onClick={openCreateModal}
          className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 dark:hover:bg-blue-800 transition-colors"
        >
          <Plus className="w-4 h-4" />
          Add New Account
        </button>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3 mb-4 p-4 bg-gray-50 dark:bg-gray-900/50 rounded-lg border border-gray-200 dark:border-gray-700/50">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 dark:text-gray-500" />
          <input
            type="text"
            placeholder="Search by code or name..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-10 pr-4 py-2 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded-lg text-sm text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500 dark:focus:ring-blue-600 focus:border-transparent"
          />
        </div>

        <div className="flex items-center gap-2">
          <Filter className="w-4 h-4 text-gray-400 dark:text-gray-500" />
          <select
            value={filterType}
            onChange={(e) => setFilterType(e.target.value as AccountType | 'ALL')}
            className="px-3 py-2 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded-lg text-sm text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500 dark:focus:ring-blue-600"
          >
            <option value="ALL">All Types</option>
            {ACCOUNT_TYPES.map((type) => (
              <option key={type} value={type}>
                {type.replace(/_/g, ' ')}
              </option>
            ))}
          </select>

          <select
            value={filterStatus}
            onChange={(e) => setFilterStatus(e.target.value as 'all' | 'active' | 'inactive')}
            className="px-3 py-2 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded-lg text-sm text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500 dark:focus:ring-blue-600"
          >
            <option value="all">All Status</option>
            <option value="active">Active</option>
            <option value="inactive">Inactive</option>
          </select>
        </div>
      </div>

      {/* Tree Table */}
      <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden">
        {/* Column Headers */}
        <div className="flex items-center gap-2 px-3 py-2.5 bg-gray-50 dark:bg-gray-900/50 border-b border-gray-200 dark:border-gray-700 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase">
          <span className="w-5" />
          <span className="w-20">Code</span>
          <span className="flex-1">Name</span>
          <span className="w-36">Type</span>
          <span className="w-16">Balance</span>
          <span className="w-16">Status</span>
          <span className="w-16" />
          <span className="w-16" />
        </div>

        {/* Tree Rows */}
        {loading ? (
          <div className="flex items-center justify-center py-20 bg-white dark:bg-gray-800">
            <div className="text-gray-400 dark:text-gray-500">Loading chart of accounts...</div>
          </div>
        ) : filterTree.length === 0 ? (
          <div className="flex items-center justify-center py-20 bg-white dark:bg-gray-800">
            <div className="text-gray-400 dark:text-gray-500">No accounts found</div>
          </div>
        ) : (
          <div className="max-h-[calc(100vh-300px)] overflow-y-auto bg-white dark:bg-gray-800">
            {filterTree.map((node) => renderTreeNode(node))}
          </div>
        )}
      </div>

      {/* ==========================================
          CREATE/EDIT MODAL (FULL DARK MODE)
          ========================================== */}
      {showModal && (
        <div className="fixed inset-0 bg-black/50 dark:bg-black/70 z-50 flex items-center justify-center p-4">
          <div className="bg-white dark:bg-gray-800 rounded-xl w-full max-w-lg max-h-[90vh] overflow-y-auto shadow-xl border border-gray-200 dark:border-gray-700">
            {/* Modal Header */}
            <div className="flex items-center justify-between p-4 border-b border-gray-200 dark:border-gray-700">
              <h2 className="text-lg font-semibold text-gray-900 dark:text-white">
                {editingAccount ? 'Edit Account' : 'Create New Account'}
              </h2>
              <button
                onClick={() => setShowModal(false)}
                className="p-1 rounded hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-500 dark:text-gray-400 transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Modal Body */}
            <div className="p-4 space-y-4">
              {/* Code & Name */}
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                    Code <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="text"
                    value={form.code}
                    onChange={(e) => setForm({ ...form, code: e.target.value })}
                    className="w-full px-3 py-2 bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-600 rounded-lg text-sm text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500 dark:focus:ring-blue-600"
                    placeholder="e.g., 1110"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                    Name <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="text"
                    value={form.name}
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                    className="w-full px-3 py-2 bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-600 rounded-lg text-sm text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500 dark:focus:ring-blue-600"
                    placeholder="e.g., Bank Account - PKR"
                  />
                </div>
              </div>

              {/* Parent Account */}
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  Parent Account
                </label>
                <select
                  value={form.parent_id || ''}
                  onChange={(e) =>
                    setForm({ ...form, parent_id: e.target.value || null })
                  }
                  className="w-full px-3 py-2 bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-600 rounded-lg text-sm text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500 dark:focus:ring-blue-600"
                >
                  <option value="">-- None (Root Account) --</option>
                  {parentAccounts.map((parent) => (
                    <option key={parent.id} value={parent.id}>
                      {parent.code} - {parent.name}
                    </option>
                  ))}
                </select>
              </div>

              {/* Account Type & Normal Balance */}
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                    Account Type
                  </label>
                  <select
                    value={form.account_type}
                    onChange={(e) =>
                      handleAccountTypeChange(e.target.value as AccountType)
                    }
                    className="w-full px-3 py-2 bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-600 rounded-lg text-sm text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500 dark:focus:ring-blue-600"
                  >
                    {ACCOUNT_TYPES.map((type) => (
                      <option key={type} value={type}>
                        {type.replace(/_/g, ' ')}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                    Normal Balance
                  </label>
                  <select
                    value={form.normal_balance}
                    onChange={(e) =>
                      setForm({ ...form, normal_balance: e.target.value as NormalBalance })
                    }
                    className="w-full px-3 py-2 bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-600 rounded-lg text-sm text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500 dark:focus:ring-blue-600"
                  >
                    <option value="DEBIT">Debit</option>
                    <option value="CREDIT">Credit</option>
                  </select>
                </div>
              </div>

              {/* Currency */}
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  Currency
                </label>
                <select
                  value={form.currency}
                  onChange={(e) => setForm({ ...form, currency: e.target.value })}
                  className="w-full px-3 py-2 bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-600 rounded-lg text-sm text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500 dark:focus:ring-blue-600"
                >
                  <option value="PKR">PKR</option>
                  <option value="USD">USD</option>
                  <option value="EUR">EUR</option>
                </select>
              </div>

              {/* Toggles */}
              <div className="flex items-center gap-6">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={form.posting_allowed}
                    onChange={(e) =>
                      setForm({ ...form, posting_allowed: e.target.checked })
                    }
                    className="w-4 h-4 text-blue-600 rounded focus:ring-blue-500 dark:bg-gray-900 dark:border-gray-600"
                  />
                  <span className="text-sm text-gray-700 dark:text-gray-300">Posting Allowed</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={form.is_control_account}
                    onChange={(e) =>
                      setForm({ ...form, is_control_account: e.target.checked })
                    }
                    className="w-4 h-4 text-blue-600 rounded focus:ring-blue-500 dark:bg-gray-900 dark:border-gray-600"
                  />
                  <span className="text-sm text-gray-700 dark:text-gray-300">Control Account</span>
                </label>
              </div>

              {/* Report Mapping */}
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  Report Mapping
                </label>
                <select
                  value={form.report_mapping || ''}
                  onChange={(e) =>
                    setForm({ ...form, report_mapping: e.target.value || null })
                  }
                  className="w-full px-3 py-2 bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-600 rounded-lg text-sm text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500 dark:focus:ring-blue-600"
                >
                  <option value="">-- None --</option>
                  {REPORT_MAPPINGS.map((mapping) => (
                    <option key={mapping} value={mapping}>
                      {mapping.replace(/_/g, ' ')}
                    </option>
                  ))}
                </select>
              </div>

              {/* Description */}
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  Description
                </label>
                <textarea
                  value={form.description || ''}
                  onChange={(e) => setForm({ ...form, description: e.target.value })}
                  rows={3}
                  className="w-full px-3 py-2 bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-600 rounded-lg text-sm text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500 dark:focus:ring-blue-600 resize-none"
                  placeholder="Optional description..."
                />
              </div>
            </div>

            {/* Modal Footer */}
            <div className="flex items-center justify-end gap-3 p-4 border-t border-gray-200 dark:border-gray-700">
              <button
                onClick={() => setShowModal(false)}
                className="px-4 py-2 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleSave}
                disabled={saving || !form.code.trim() || !form.name.trim()}
                className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 dark:hover:bg-blue-800 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {saving ? 'Saving...' : editingAccount ? 'Update Account' : 'Create Account'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}