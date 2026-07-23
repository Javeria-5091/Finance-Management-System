"use client";
import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/context/AuthContext";
import { usePermissions } from "@/hooks/usePermissions";
import { Plus, Pencil, Building2, Trash2, X, Loader2, Search } from "lucide-react";
import ReasonModal from "@/components/finance/ReasonModal";

/* ═══════════════════════════════════════════════════════
   TYPES — Exact match with finance.vendors SQL schema
   ═══════════════════════════════════════════════════════ */
interface Vendor {
  id: string;
  vendor_code: string | null;
  name: string;
  contact_person: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  city: string | null;
  country: string | null;
  tax_registration: string | null;
  tax_type: string | null;
  payment_terms: string | null;
  default_currency: string | null;
  bank_name: string | null;
  bank_account: string | null;
  is_active: boolean;
  notes: string | null;
  created_at: string;
  updated_at: string | null;
  created_by: string | null;
}

/* ═══════════════════════════════════════════════════════
   FORM — Every field is string, no undefined possible
   ═══════════════════════════════════════════════════════ */
interface VendorForm {
  name: string;
  contact_person: string;
  email: string;
  phone: string;
  address: string;
  city: string;
  country: string;
  tax_registration: string;
  tax_type: string;
  payment_terms: string;
  default_currency: string;
  bank_name: string;
  bank_account: string;
  notes: string;
}

const EMPTY_FORM: VendorForm = {
  name: "",
  contact_person: "",
  email: "",
  phone: "",
  address: "",
  city: "",
  country: "Pakistan",
  tax_registration: "",
  tax_type: "GST_REGISTERED",
  payment_terms: "NET_30",
  default_currency: "PKR",
  bank_name: "",
  bank_account: "",
  notes: "",
};

/* ═══════════════════════════════════════════════════════
   CONSTANTS — From spec Section 5.3 & 5.7
   ═══════════════════════════════════════════════════════ */
const PAYMENT_TERMS = [
  { value: "DUE_ON_RECEIPT", label: "Due on Receipt" },
  { value: "NET_15", label: "NET 15" },
  { value: "NET_30", label: "NET 30" },
  { value: "NET_45", label: "NET 45" },
  { value: "NET_60", label: "NET 60" },
  { value: "NET_90", label: "NET 90" },
];

const TAX_TYPES = [
  { value: "GST_REGISTERED", label: "GST Registered" },
  { value: "UNREGISTERED", label: "Unregistered" },
  { value: "NTN_ONLY", label: "NTN Only" },
  { value: "FILER", label: "Filer" },
  { value: "NON_FILER", label: "Non-Filer" },
];

const CURRENCIES = [
  { value: "PKR", label: "PKR" },
  { value: "USD", label: "USD" },
  { value: "EUR", label: "EUR" },
  { value: "GBP", label: "GBP" },
  { value: "AED", label: "AED" },
];

const db = supabase.schema("finance");

/* ═══════════════════════════════════════════════════════
   SAFE VALUE HELPER — Prevents undefined → uncontrolled
   ═══════════════════════════════════════════════════════ */
function sv(val: string | null | undefined): string {
  return val ?? "";
}

/* ═══════════════════════════════════════════════════════
   COMPONENT
   ═══════════════════════════════════════════════════════ */
export default function VendorsPage() {
  const { user } = useAuth();
  const { hasPermission, isLoading: permLoading } = usePermissions();

  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [showModal, setShowModal] = useState(false);
  const [editingVendor, setEditingVendor] = useState<Vendor | null>(null);

  // Search state
  const [search, setSearch] = useState("");

  // Reason modal state
  const [reasonState, setReasonState] = useState({
    open: false,
    title: "",
    action: "",
    id: "",
  });

  const [form, setForm] = useState<VendorForm>({ ...EMPTY_FORM });

  /* ── Fetch ── */
  const fetchVendors = useCallback(async () => {
    setLoading(true);
    let query = db
      .from("vendors")
      .select("*")
      .order("name", { ascending: true });

    if (search.trim()) {
      query = query.or(
        `name.ilike.%${search.trim()}%,contact_person.ilike.%${search.trim()}%,email.ilike.%${search.trim()}%,tax_registration.ilike.%${search.trim()}%`
      );
    }

    const { data, error } = await query;
    if (error) {
      console.error("Failed to fetch vendors:", error.message);
    } else if (data) {
      setVendors(data as Vendor[]);
    }
    setLoading(false);
  }, [search]);

  useEffect(() => {
    fetchVendors();
  }, [fetchVendors]);

  /* ── Form helpers ── */
  const set = useCallback((field: keyof VendorForm, value: string) => {
    setForm((prev) => ({ ...prev, [field]: value }));
  }, []);

  const resetAndClose = useCallback(() => {
    setShowModal(false);
    setEditingVendor(null);
    setForm({ ...EMPTY_FORM });
  }, []);

  /* ── Submit ── */
  const handleSubmit = async () => {
    if (!form.name.trim()) {
      alert("Vendor name is required");
      return;
    }

    setSubmitting(true);
    try {
      const payload = {
        name: form.name.trim(),
        contact_person: form.contact_person.trim() || null,
        email: form.email.trim() || null,
        phone: form.phone.trim() || null,
        address: form.address.trim() || null,
        city: form.city.trim() || null,
        country: form.country.trim() || "Pakistan",
        tax_registration: form.tax_registration.trim() || null,
        tax_type: form.tax_type || "GST_REGISTERED",
        payment_terms: form.payment_terms || "NET_30",
        default_currency: form.default_currency || "PKR",
        bank_name: form.bank_name.trim() || null,
        bank_account: form.bank_account.trim() || null,
        notes: form.notes.trim() || null,
      };

      if (editingVendor) {
        const { error } = await db
          .from("vendors")
          .update({ ...payload, updated_at: new Date().toISOString() })
          .eq("id", editingVendor.id);
        if (error) throw error;
      } else {
        const { error } = await db.from("vendors").insert({
          ...payload,
          vendor_code: `VND-${Date.now().toString().slice(-5)}`,
          is_active: true,
          created_by: user?.id,
        });
        if (error) throw error;
      }

      resetAndClose();
      fetchVendors();
    } catch (err: any) {
      alert("Error: " + (err.message || "Something went wrong"));
    } finally {
      setSubmitting(false);
    }
  };

  /* ── Deactivate ── */
  const handleDeactivate = useCallback(
    (reason: string) => {
      if (!reasonState.id) return;
      db.from("vendors")
        .update({
          is_active: false,
          notes: `Deactivated: ${reason}`,
          updated_at: new Date().toISOString(),
        })
        .eq("id", reasonState.id)
        .then(({ error }) => {
          if (error) {
            alert(error.message);
            return;
          }
          setReasonState({ open: false, title: "", action: "", id: "" });
          fetchVendors();
        });
    },
    [reasonState.id, fetchVendors]
  );

  /* ── Edit — uses sv() helper to guarantee string ── */
  const openEdit = useCallback((v: Vendor) => {
    setEditingVendor(v);
    setForm({
      name: sv(v.name),
      contact_person: sv(v.contact_person),
      email: sv(v.email),
      phone: sv(v.phone),
      address: sv(v.address),
      city: sv(v.city),
      country: sv(v.country) || "Pakistan",
      tax_registration: sv(v.tax_registration),
      tax_type: sv(v.tax_type) || "GST_REGISTERED",
      payment_terms: sv(v.payment_terms) || "NET_30",
      default_currency: sv(v.default_currency) || "PKR",
      bank_name: sv(v.bank_name),
      bank_account: sv(v.bank_account),
      notes: sv(v.notes),
    });
    setShowModal(true);
  }, []);

  const openAdd = useCallback(() => {
    setEditingVendor(null);
    setForm({ ...EMPTY_FORM });
    setShowModal(true);
  }, []);

  /* ── Stats ── */
  const activeCount = vendors.filter((v) => v.is_active).length;
  const totalCount = vendors.length;

  /* ── Styles ── */
  const inputCls =
    "w-full px-4 py-2.5 border dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 focus:border-transparent text-sm outline-none transition-shadow";
  const labelCls =
    "block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1";

  /* ── Permission guard ── */
  if (permLoading) {
    return (
      <div className="p-6 flex items-center justify-center min-h-[60vh]">
        <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
      </div>
    );
  }

  if (!hasPermission("EXPENSE_READ")) {
    return (
      <div className="p-6 flex items-center justify-center min-h-[60vh]">
        <p className="text-gray-500">Access Denied</p>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6">
      {/* ═══════ HEADER ═══════ */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white flex items-center gap-2">
            <Building2 className="w-7 h-7 text-blue-600" /> Vendors
          </h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
            Manage supplier and vendor master data
          </p>
        </div>

        <div className="flex items-center gap-3">
          {/* Search */}
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search vendors..."
              className="pl-9 pr-4 py-2.5 border dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm outline-none focus:ring-2 focus:ring-blue-500 w-60"
            />
          </div>

          {hasPermission("EXPENSE_CREATE") && (
            <button
              onClick={openAdd}
              className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-4 py-2.5 rounded-lg text-sm font-medium shadow-sm transition-colors whitespace-nowrap"
            >
              <Plus size={16} /> Add Vendor
            </button>
          )}
        </div>
      </div>

      {/* ═══════ STATS CARDS ═══════ */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="bg-white dark:bg-gray-800 border dark:border-gray-700 rounded-xl p-4">
          <p className="text-xs text-gray-500 dark:text-gray-400 uppercase tracking-wider">Total Vendors</p>
          <p className="text-2xl font-bold text-gray-900 dark:text-white mt-1">{totalCount}</p>
        </div>
        <div className="bg-white dark:bg-gray-800 border dark:border-gray-700 rounded-xl p-4">
          <p className="text-xs text-gray-500 dark:text-gray-400 uppercase tracking-wider">Active</p>
          <p className="text-2xl font-bold text-green-600 mt-1">{activeCount}</p>
        </div>
        <div className="bg-white dark:bg-gray-800 border dark:border-gray-700 rounded-xl p-4">
          <p className="text-xs text-gray-500 dark:text-gray-400 uppercase tracking-wider">Inactive</p>
          <p className="text-2xl font-bold text-red-500 mt-1">{totalCount - activeCount}</p>
        </div>
      </div>

      {/* ═══════ TABLE ═══════ */}
      <div className="bg-white dark:bg-gray-800 border dark:border-gray-700 rounded-xl overflow-hidden shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 dark:bg-gray-900/50 border-b dark:border-gray-700 text-left text-xs uppercase text-gray-500 tracking-wider">
              <tr>
                <th className="px-4 py-3">Code</th>
                <th className="px-4 py-3">Vendor Name</th>
                <th className="px-4 py-3 hidden md:table-cell">Contact</th>
                <th className="px-4 py-3 hidden lg:table-cell">Tax Reg</th>
                <th className="px-4 py-3 hidden sm:table-cell">Terms</th>
                <th className="px-4 py-3 text-center">Status</th>
                <th className="px-4 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y dark:divide-gray-700">
              {loading ? (
                <tr>
                  <td colSpan={7} className="px-4 py-12 text-center text-gray-400">
                    <Loader2 className="w-5 h-5 animate-spin mx-auto mb-2" />
                    Loading vendors...
                  </td>
                </tr>
              ) : vendors.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-16 text-center text-gray-400">
                    <Building2 className="w-10 h-10 mx-auto mb-3 opacity-30" />
                    <p className="font-medium">No vendors found</p>
                    <p className="text-xs mt-1">
                      {search ? "Try a different search term" : 'Click "Add Vendor" to get started'}
                    </p>
                  </td>
                </tr>
              ) : (
                vendors.map((v) => (
                  <tr
                    key={v.id}
                    className={`hover:bg-gray-50 dark:hover:bg-gray-700/30 transition-colors ${
                      !v.is_active ? "opacity-50" : ""
                    }`}
                  >
                    <td className="px-4 py-3 font-mono text-xs text-gray-500 dark:text-gray-400">
                      {sv(v.vendor_code) || "-"}
                    </td>
                    <td className="px-4 py-3 font-medium text-gray-900 dark:text-white">
                      {sv(v.name)}
                    </td>
                    <td className="px-4 py-3 text-gray-500 dark:text-gray-400 hidden md:table-cell">
                      <div className="text-sm">{sv(v.contact_person) || "-"}</div>
                      {v.phone && (
                        <div className="text-xs text-gray-400">{sv(v.phone)}</div>
                      )}
                    </td>
                    <td className="px-4 py-3 text-gray-500 dark:text-gray-400 font-mono text-xs hidden lg:table-cell">
                      {sv(v.tax_registration) || "-"}
                    </td>
                    <td className="px-4 py-3 hidden sm:table-cell">
                      <span className="bg-gray-100 dark:bg-gray-700 px-2.5 py-0.5 rounded text-xs font-medium">
                        {sv(v.payment_terms) || "NET_30"}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-center">
                      <span
                        className={`inline-block px-2.5 py-0.5 rounded text-xs font-medium ${
                          v.is_active
                            ? "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400"
                            : "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400"
                        }`}
                      >
                        {v.is_active ? "Active" : "Inactive"}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex items-center justify-end gap-1">
                        <button
                          onClick={() => openEdit(v)}
                          className="p-1.5 text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-500/10 rounded transition-colors"
                          title="Edit vendor"
                        >
                          <Pencil size={15} />
                        </button>
                        {v.is_active && hasPermission("EXPENSE_DELETE") && (
                          <button
                            onClick={() =>
                              setReasonState({
                                open: true,
                                title: "Deactivate Vendor",
                                action: "deactivate",
                                id: v.id,
                              })
                            }
                            className="p-1.5 text-red-500 hover:bg-red-50 dark:hover:bg-red-500/10 rounded transition-colors"
                            title="Deactivate vendor"
                          >
                            <Trash2 size={15} />
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

        {!loading && vendors.length > 0 && (
          <div className="px-4 py-2.5 border-t dark:border-gray-700 bg-gray-50 dark:bg-gray-900/30 text-xs text-gray-500">
            Showing {vendors.length} vendor{vendors.length !== 1 ? "s" : ""} ({activeCount} active)
          </div>
        )}
      </div>

      {/* ═══════ CREATE / EDIT MODAL ═══════ */}
      {showModal && (
        <div
          className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4"
          onClick={(e) => {
            if (e.target === e.currentTarget) resetAndClose();
          }}
        >
          <div className="bg-white dark:bg-gray-800 border dark:border-gray-700 rounded-2xl w-full max-w-2xl shadow-2xl max-h-[85vh] flex flex-col">
            {/* Header */}
            <div className="p-5 border-b dark:border-gray-700 flex justify-between items-center shrink-0">
              <h2 className="text-lg font-bold text-gray-900 dark:text-white">
                {editingVendor ? `Edit: ${sv(editingVendor.name)}` : "Add New Vendor"}
              </h2>
              <button
                onClick={resetAndClose}
                className="p-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-500 transition-colors"
              >
                <X size={20} />
              </button>
            </div>

            {/* Scrollable Body */}
            <div className="p-5 space-y-4 overflow-y-auto flex-1">
              {/* ── Vendor Name ── */}
              <div>
                <label className={labelCls}>
                  Vendor Name <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  value={form.name}
                  onChange={(e) => set("name", e.target.value)}
                  className={inputCls}
                  placeholder="e.g., Techlogix"
                  autoFocus
                />
              </div>

              {/* ── Contact + Email ── */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className={labelCls}>Contact Person</label>
                  <input
                    type="text"
                    value={form.contact_person}
                    onChange={(e) => set("contact_person", e.target.value)}
                    className={inputCls}
                    placeholder="e.g., Ahmed Ali"
                  />
                </div>
                <div>
                  <label className={labelCls}>Email</label>
                  <input
                    type="email"
                    value={form.email}
                    onChange={(e) => set("email", e.target.value)}
                    className={inputCls}
                    placeholder="vendor@example.com"
                  />
                </div>
              </div>

              {/* ── Phone + Tax Registration ── */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className={labelCls}>Phone</label>
                  <input
                    type="text"
                    value={form.phone}
                    onChange={(e) => set("phone", e.target.value)}
                    className={inputCls}
                    placeholder="0312-1234567"
                  />
                </div>
                <div>
                  <label className={labelCls}>NTN / Tax Registration</label>
                  <input
                    type="text"
                    value={form.tax_registration}
                    onChange={(e) => set("tax_registration", e.target.value)}
                    className={`${inputCls} font-mono uppercase`}
                    placeholder="0000000-0"
                  />
                </div>
              </div>

              {/* ── Tax Type + Payment Terms ── */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className={labelCls}>Tax Type</label>
                  <select
                    value={form.tax_type}
                    onChange={(e) => set("tax_type", e.target.value)}
                    className={inputCls}
                  >
                    {TAX_TYPES.map((t) => (
                      <option key={t.value} value={t.value}>{t.label}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className={labelCls}>Payment Terms</label>
                  <select
                    value={form.payment_terms}
                    onChange={(e) => set("payment_terms", e.target.value)}
                    className={inputCls}
                  >
                    {PAYMENT_TERMS.map((p) => (
                      <option key={p.value} value={p.value}>{p.label}</option>
                    ))}
                  </select>
                </div>
              </div>

              {/* ── City + Country ── */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className={labelCls}>City</label>
                  <input
                    type="text"
                    value={form.city}
                    onChange={(e) => set("city", e.target.value)}
                    className={inputCls}
                    placeholder="Lahore"
                  />
                </div>
                <div>
                  <label className={labelCls}>Country</label>
                  <input
                    type="text"
                    value={form.country}
                    onChange={(e) => set("country", e.target.value)}
                    className={inputCls}
                    placeholder="Pakistan"
                  />
                </div>
              </div>

              {/* ── Default Currency ── */}
              <div>
                <label className={labelCls}>Default Currency</label>
                <select
                  value={form.default_currency}
                  onChange={(e) => set("default_currency", e.target.value)}
                  className={inputCls}
                >
                  {CURRENCIES.map((c) => (
                    <option key={c.value} value={c.value}>{c.value}</option>
                  ))}
                </select>
              </div>

              {/* ── Address ── */}
              <div>
                <label className={labelCls}>Address</label>
                <textarea
                  value={form.address}
                  onChange={(e) => set("address", e.target.value)}
                  className={`${inputCls} resize-none`}
                  rows={2}
                  placeholder="Office / warehouse address"
                />
              </div>

              {/* ── Bank Details ── */}
              <div className="border-t dark:border-gray-700 pt-4">
                <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-3">
                  Bank Details
                </h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label className={labelCls}>Bank Name</label>
                    <input
                      type="text"
                      value={form.bank_name}
                      onChange={(e) => set("bank_name", e.target.value)}
                      className={inputCls}
                      placeholder="HBL, Meezan Bank"
                    />
                  </div>
                  <div>
                    <label className={labelCls}>Bank Account / IBAN</label>
                    <input
                      type="text"
                      value={form.bank_account}
                      onChange={(e) => set("bank_account", e.target.value)}
                      className={`${inputCls} font-mono`}
                      placeholder="Account Number or IBAN"
                    />
                  </div>
                </div>
              </div>

              {/* ── Notes ── */}
              <div>
                <label className={labelCls}>Internal Notes</label>
                <textarea
                  value={form.notes}
                  onChange={(e) => set("notes", e.target.value)}
                  className={`${inputCls} resize-none`}
                  rows={2}
                  placeholder="Internal notes (not visible to vendor)"
                />
              </div>
            </div>

            {/* Footer */}
            <div className="flex justify-end gap-3 p-5 border-t dark:border-gray-700 shrink-0">
              <button
                onClick={resetAndClose}
                disabled={submitting}
                className="px-5 py-2.5 bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 dark:hover:bg-gray-600 text-gray-800 dark:text-white rounded-xl text-sm font-medium transition-colors disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={handleSubmit}
                disabled={submitting || !form.name.trim()}
                className="px-5 py-2.5 bg-blue-600 hover:bg-blue-700 text-white rounded-xl text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
              >
                {submitting && <Loader2 size={14} className="animate-spin" />}
                {editingVendor ? "Update Vendor" : "Add Vendor"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ═══════ REASON MODAL ═══════ */}
      <ReasonModal
        open={reasonState.open}
        title={reasonState.title}
        description="Deactivating a vendor will hide them from dropdowns but keeps all historical data intact."
        onConfirm={handleDeactivate}
        onCancel={() =>
          setReasonState({ open: false, title: "", action: "", id: "" })
        }
      />
    </div>
  );
}