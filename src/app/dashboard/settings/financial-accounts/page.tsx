"use client";
import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/context/AuthContext";
import { usePermissions } from "@/context/PermissionContext";
import { Plus, Pencil, Landmark, Trash2, X, Loader2, Search, Wallet, CreditCard, Globe, CheckCircle2 } from "lucide-react";
import toast from "react-hot-toast";
import ReasonModal from "@/components/finance/ReasonModal";

interface FinancialAccount {
  id: string;
  account_name: string;
  account_type: string;
  currency: string;
  bank_name: string | null;
  account_number: string | null;
  routing_number: string | null;
  platform_name: string | null;
  ledger_account_id: string | null;
  current_balance: number | null;
  pkr_equivalent: number | null;
  is_active: boolean;
  last_reconciled: string | null;
  notes: string | null;
  created_at: string;
}

interface AccountForm {
  account_name: string;
  account_type: string;
  currency: string;
  bank_name: string;
  account_number: string;
  routing_number: string;
  platform_name: string;
  ledger_account_id: string;
  notes: string;
}

const emptyForm: AccountForm = {
  account_name: "",
  account_type: "bank",
  currency: "PKR",
  bank_name: "",
  account_number: "",
  routing_number: "",
  platform_name: "",
  ledger_account_id: "",
  notes: "",
};

const ACCOUNT_TYPES = [
  { value: "bank", label: "Bank Account", icon: Landmark },
  { value: "cash", label: "Cash", icon: Wallet },
  { value: "wallet", label: "Digital Wallet", icon: CreditCard },
  { value: "platform", label: "Platform Balance", icon: Globe },
  { value: "gateway", label: "Payment Gateway", icon: CreditCard },
  { value: "clearing", label: "Clearing Account", icon: CheckCircle2 },
];

const CURRENCIES = ["PKR", "USD", "EUR", "GBP", "AUD", "CAD", "AED"];

export default function FinancialAccountsPage() {
  const { user } = useAuth();
  const { hasPermission } = usePermissions();
  const canCreate = hasPermission("SETTINGS_MANAGE");
  const canEdit = hasPermission("SETTINGS_MANAGE");
  const canDelete = hasPermission("SETTINGS_MANAGE");

  const [accounts, setAccounts] = useState<FinancialAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [filterType, setFilterType] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<FinancialAccount | null>(null);
  const [form, setForm] = useState<AccountForm>(emptyForm);
  const [saving, setSaving] = useState(false);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<FinancialAccount | null>(null);

  const fetchAccounts = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from("financial_accounts")
      .select("*")
      .order("account_name", { ascending: true });
    if (!error && data) setAccounts(data as FinancialAccount[]);
    else if (error) toast.error("Failed to load: " + error.message);
    setLoading(false);
  }, []);

  useEffect(() => { fetchAccounts(); }, [fetchAccounts]);

  const filtered = accounts.filter((a) => {
    const q = search.toLowerCase();
    const matchesSearch =
      a.account_name.toLowerCase().includes(q) ||
      (a.bank_name || "").toLowerCase().includes(q) ||
      (a.account_number || "").toLowerCase().includes(q);
    const matchesType = !filterType || a.account_type === filterType;
    return matchesSearch && matchesType;
  });

  const handleSave = async () => {
    if (!form.account_name.trim()) { toast.error("Account name is required"); return; }
    setSaving(true);
    const payload: Record<string, any> = {
      ...form,
      account_name: form.account_name.trim(),
      updated_by: user?.id,
    };
    if (editing) {
      const { error } = await supabase.from("financial_accounts").update(payload).eq("id", editing.id);
      if (error) toast.error("Update failed: " + error.message); else toast.success("Account updated");
    } else {
      payload.created_by = user?.id;
      payload.current_balance = 0;
      const { error } = await supabase.from("financial_accounts").insert(payload);
      if (error) toast.error("Create failed: " + error.message); else toast.success("Account created");
    }
    setSaving(false);
    setShowForm(false);
    setEditing(null);
    setForm(emptyForm);
    fetchAccounts();
  };

  const handleDeleteConfirm = async (reason: string) => {
    if (!deleteTarget || !reason.trim()) return;
    const { error } = await supabase
      .from("financial_accounts")
      .update({ is_active: false, notes: `[DEACTIVATED] ${reason}`, updated_by: user?.id })
      .eq("id", deleteTarget.id);
    if (error) toast.error("Deactivation failed: " + error.message);
    else toast.success("Account deactivated");
    setShowDeleteModal(false);
    setDeleteTarget(null);
    fetchAccounts();
  };

  const openEdit = (acc: FinancialAccount) => {
    setEditing(acc);
    setForm({
      account_name: acc.account_name,
      account_type: acc.account_type,
      currency: acc.currency || "PKR",
      bank_name: acc.bank_name || "",
      account_number: acc.account_number || "",
      routing_number: acc.routing_number || "",
      platform_name: acc.platform_name || "",
      ledger_account_id: acc.ledger_account_id || "",
      notes: acc.notes || "",
    });
    setShowForm(true);
  };

  const formatPKR = (amount: number | null) => {
    if (amount === null) return "—";
    return new Intl.NumberFormat("en-PK", { style: "currency", currency: "PKR", minimumFractionDigits: 0 }).format(amount);
  };

  const getTypeConfig = (type: string) =>
    ACCOUNT_TYPES.find((t) => t.value === type) || ACCOUNT_TYPES[0];

  const inputCls =
    "w-full px-3 py-2.5 bg-gray-50 dark:bg-gray-900 border border-gray-300 dark:border-gray-700 rounded-lg text-gray-900 dark:text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 transition-colors";
  const labelCls = "block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1";

  const totalPKR = accounts.filter((a) => a.is_active).reduce((s, a) => s + (a.pkr_equivalent || 0), 0);
  const activeCount = accounts.filter((a) => a.is_active).length;

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <Landmark className="w-6 h-6 text-blue-600 dark:text-blue-400" />
          <div>
            <h2 className="text-2xl font-bold text-gray-900 dark:text-white">Financial Accounts</h2>
            <p className="text-gray-500 dark:text-gray-400 text-sm">
              Banks, wallets, platforms, clearing accounts — original currency + PKR
            </p>
          </div>
        </div>
        {canCreate && (
          <button
            onClick={() => { setEditing(null); setForm(emptyForm); setShowForm(true); }}
            className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-4 py-2.5 rounded-lg text-sm font-medium transition-colors shadow-sm"
          >
            <Plus size={16} /> Add Account
          </button>
        )}
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-6">
        <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-4 shadow-sm">
          <p className="text-xs text-gray-500 dark:text-gray-400">Active Accounts</p>
          <p className="text-xl font-bold text-gray-900 dark:text-white mt-1">{activeCount}</p>
        </div>
        <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-4 shadow-sm">
          <p className="text-xs text-gray-500 dark:text-gray-400">Total PKR Equivalent</p>
          <p className="text-xl font-bold text-green-600 dark:text-green-400 mt-1">{formatPKR(totalPKR)}</p>
        </div>
        <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-4 shadow-sm">
          <p className="text-xs text-gray-500 dark:text-gray-400">Multi-Currency</p>
          <p className="text-xl font-bold text-blue-600 dark:text-blue-400 mt-1">
            {new Set(accounts.filter(a => a.is_active).map(a => a.currency)).size} currencies
          </p>
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3 mb-4">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
          <input
            type="text"
            placeholder="Search accounts..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-10 pr-4 py-2.5 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg text-sm text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
        <select
          value={filterType}
          onChange={(e) => setFilterType(e.target.value)}
          className="px-3 py-2.5 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg text-sm text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
          <option value="">All Types</option>
          {ACCOUNT_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
        </select>
      </div>

      {/* Table */}
      <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl overflow-hidden shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="bg-gray-50 dark:bg-gray-900/70 text-xs text-gray-600 dark:text-gray-400 uppercase tracking-wider">
              <tr>
                <th className="px-4 py-3 font-semibold">Account</th>
                <th className="px-4 py-3 font-semibold hidden md:table-cell">Type</th>
                <th className="px-4 py-3 font-semibold hidden lg:table-cell">Bank / Platform</th>
                <th className="px-4 py-3 font-semibold text-right">Balance (Original)</th>
                <th className="px-4 py-3 font-semibold text-right">PKR Equivalent</th>
                <th className="px-4 py-3 font-semibold text-center">Reconciled</th>
                {canEdit && <th className="px-4 py-3 font-semibold text-center">Actions</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
              {loading ? (
                <tr><td colSpan={7} className="px-4 py-12 text-center"><Loader2 className="w-6 h-6 animate-spin mx-auto text-blue-500" /></td></tr>
              ) : filtered.length === 0 ? (
                <tr><td colSpan={7} className="px-4 py-12 text-center text-gray-400">No financial accounts found.</td></tr>
              ) : (
                filtered.map((a) => {
                  const typeCfg = getTypeConfig(a.account_type);
                  const Icon = typeCfg.icon;
                  return (
                    <tr key={a.id} className="hover:bg-gray-50 dark:hover:bg-gray-700/30 transition-colors">
                      <td className="px-4 py-3">
                        <div className="font-medium text-gray-900 dark:text-white">{a.account_name}</div>
                        <div className="text-xs text-gray-500">{a.account_number || "—"} · {a.currency}</div>
                      </td>
                      <td className="px-4 py-3 hidden md:table-cell">
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-bold uppercase rounded bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-400">
                          {typeCfg.label}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-gray-600 dark:text-gray-400 hidden lg:table-cell">{a.bank_name || a.platform_name || "—"}</td>
                      <td className="px-4 py-3 text-right font-medium text-gray-900 dark:text-white">{formatPKR(a.current_balance)}</td>
                      <td className="px-4 py-3 text-right font-semibold text-green-600 dark:text-green-400">{formatPKR(a.pkr_equivalent)}</td>
                      <td className="px-4 py-3 text-center">
                        {a.last_reconciled ? (
                          <span className="text-green-600 dark:text-green-400" title={a.last_reconciled}><CheckCircle2 size={16} /></span>
                        ) : (
                          <span className="text-gray-300 dark:text-gray-600" title="Not reconciled"><CheckCircle2 size={16} /></span>
                        )}
                      </td>
                      {canEdit && (
                        <td className="px-4 py-3">
                          <div className="flex items-center justify-center gap-1">
                            <button onClick={() => openEdit(a)} className="p-1.5 rounded-lg hover:bg-blue-50 dark:hover:bg-blue-900/20 text-blue-600 dark:text-blue-400"><Pencil size={14} /></button>
                            {canDelete && a.is_active && (
                              <button onClick={() => { setDeleteTarget(a); setShowDeleteModal(true); }} className="p-1.5 rounded-lg hover:bg-red-50 dark:hover:bg-red-900/20 text-red-600 dark:text-red-400"><Trash2 size={14} /></button>
                            )}
                          </div>
                        </td>
                      )}
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* ADD/EDIT MODAL */}
      {showForm && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4 backdrop-blur-sm">
          <div className="bg-white dark:bg-gray-800 rounded-2xl w-full max-w-lg max-h-[90vh] overflow-y-auto shadow-2xl">
            <div className="flex items-center justify-between p-5 border-b border-gray-200 dark:border-gray-700">
              <h3 className="text-lg font-bold text-gray-900 dark:text-white">{editing ? "Edit Financial Account" : "Add Financial Account"}</h3>
              <button onClick={() => { setShowForm(false); setEditing(null); }} className="p-1 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-500"><X size={18} /></button>
            </div>
            <div className="p-5 space-y-4">
              <div><label className={labelCls}>Account Name *</label><input className={inputCls} value={form.account_name} onChange={(e) => setForm({ ...form, account_name: e.target.value })} placeholder="e.g. HBL Business Account" /></div>
              <div className="grid grid-cols-2 gap-4">
                <div><label className={labelCls}>Account Type</label><select className={inputCls} value={form.account_type} onChange={(e) => setForm({ ...form, account_type: e.target.value })}>{ACCOUNT_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}</select></div>
                <div><label className={labelCls}>Currency</label><select className={inputCls} value={form.currency} onChange={(e) => setForm({ ...form, currency: e.target.value })}>{CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}</select></div>
              </div>
              {(form.account_type === "bank" || form.account_type === "gateway") && (
                <div className="grid grid-cols-2 gap-4">
                  <div><label className={labelCls}>Bank Name</label><input className={inputCls} value={form.bank_name} onChange={(e) => setForm({ ...form, bank_name: e.target.value })} placeholder="Habib Bank" /></div>
                  <div><label className={labelCls}>Account Number</label><input className={inputCls} value={form.account_number} onChange={(e) => setForm({ ...form, account_number: e.target.value })} placeholder="0022-XXXXXXX-XXX" /></div>
                </div>
              )}
              {(form.account_type === "platform" || form.account_type === "wallet" || form.account_type === "gateway") && (
                <div><label className={labelCls}>Platform Name</label><input className={inputCls} value={form.platform_name} onChange={(e) => setForm({ ...form, platform_name: e.target.value })} placeholder="e.g. Payoneer, Wise, Stripe" /></div>
              )}
              <div><label className={labelCls}>Notes</label><textarea className={inputCls} rows={2} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} placeholder="Internal notes..." /></div>
            </div>
            <div className="flex justify-end gap-3 p-5 border-t border-gray-200 dark:border-gray-700">
              <button onClick={() => { setShowForm(false); setEditing(null); }} className="px-4 py-2.5 rounded-lg text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700">Cancel</button>
              <button onClick={handleSave} disabled={saving || !form.account_name.trim()} className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 text-white px-5 py-2.5 rounded-lg text-sm font-medium">
                {saving && <Loader2 size={14} className="animate-spin" />}{editing ? "Update" : "Create"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* DELETE MODAL — uses ReasonModal's actual props: open, title, description, onConfirm(reason), onCancel */}
      <ReasonModal
        open={showDeleteModal}
        title="Deactivate Account"
        description={deleteTarget ? `Deactivate "${deleteTarget.account_name}"? Balance history will be preserved.` : ""}
        onConfirm={handleDeleteConfirm}
        onCancel={() => { setShowDeleteModal(false); setDeleteTarget(null); }}
      />
    </div>
  );
}