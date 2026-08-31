"use client";
import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/context/AuthContext";
import { usePermissions } from "@/context/PermissionContext";
import { FileText, Plus, Pencil, Eye, X, Loader2, Repeat2 } from "lucide-react";
import LineItemsEditor from "@/components/finance/LineItemsEditor";
import StatusActions from "@/components/finance/StatusActions";
import ReasonModal from "@/components/finance/ReasonModal";
import { callWorkflow } from "@/lib/workflow";
import toast from "react-hot-toast";
import Link from "next/link";

/* ═══════════════════════════════════════════════════════
   SAFE HELPERS — Null/undefined/NaN protection
   ═══════════════════════════════════════════════════════ */
const safeDate = (val: string | null | undefined): string => {
  if (!val) return "";
  try {
    const str = typeof val === "string" ? val : new Date(val).toISOString();
    return str.split("T")[0];
  } catch {
    return "";
  }
};

const safeNum = (val: number | null | undefined, fallback: number = 0): number => {
  if (val === null || val === undefined || isNaN(Number(val))) return fallback;
  const num = Number(val);
  // ✅ Infinity aur -Infinity bhi catch kar lo
  if (!isFinite(num)) return fallback;
  return num;
};

const sv = (val: string | null | undefined): string => val ?? "";

const formatStatus = (status: string | null | undefined): string => {
  if (!status) return "Unknown";
  return status
    .replace(/_/g, " ")
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase());
};

const formatCurrency = (amount: number) =>
  new Intl.NumberFormat("en-PK", {
    style: "currency",
    currency: "PKR",
    minimumFractionDigits: 0,
  }).format(amount || 0);

/* ═══════════════════════════════════════════════════════
   STATUS STYLES — UPPERCASE keys matching DB enum
   ═══════════════════════════════════════════════════════ */
const STATUS_STYLES: Record<string, string> = {
  DRAFT: "bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300",
  SUBMITTED: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400",
  VERIFIED: "bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-400",
  APPROVED: "bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400",
  POSTED: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400",
  PARTIALLY_PAID: "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400",
  PAID: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400",
  REVERSED: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400",
  CANCELLED: "bg-gray-200 text-gray-500 dark:bg-gray-600 dark:text-gray-400 italic",
};

/* ═══════════════════════════════════════════════════════
   TYPES
   ═══════════════════════════════════════════════════════ */
interface VendorBill {
  id: string;
  bill_number: string | null;
  vendor_id: string;
  project_id: string | null;
  bill_date: string;
  due_date: string | null;
  currency: string;
  exchange_rate: number;
  subtotal: number;
  tax_amount: number;
  withholding_amount: number;
  discount_amount: number;
  total_amount: number;
  amount_paid: number;
  outstanding_amount: number;
  status: string;
  description: string | null;
  rejection_reason: string | null;
  submitted_by: string | null;
  submitted_at: string | null;
  verified_by: string | null;
  verified_at: string | null;
  approved_at: string | null;
  posted_at: string | null;
  created_at: string;
  vendors?: { name: string } | null;
}

interface PostableAccount {
  id: string;
  code: string;
  name: string;
  normal_balance: string;
  account_type: string;
  posting_allowed: boolean;
}

interface LineItem {
  id: string;
  account_id: string;
  description: string;
  quantity: number;
  unit_price: number;
  tax_rate: number;
  withholding_rate: number;
  tax_amount: number;
  withholding_amount: number;
  line_total: number;
  project_id: string | null;
}

const db = supabase.schema("finance");

const EMPTY_LINE = (): LineItem => ({
  id: crypto.randomUUID(),
  account_id: "",
  description: "",
  quantity: 1,
  unit_price: 0,
  tax_rate: 0,
  withholding_rate: 0,
  tax_amount: 0,
  withholding_amount: 0,
  line_total: 0,
  project_id: null,
});

/* ═══════════════════════════════════════════════════════
   COMPONENT
   ═══════════════════════════════════════════════════════ */
export default function VendorBillsPage() {
  const { user } = useAuth();
  const { hasPermission, isLoading: permLoading } = usePermissions();

  /* ── State ── */
  const [bills, setBills] = useState<VendorBill[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  // Form modal
  const [showForm, setShowForm] = useState(false);
  const [editingBill, setEditingBill] = useState<VendorBill | null>(null);
  const [editorInitialLines, setEditorInitialLines] = useState<LineItem[]>([EMPTY_LINE()]);
  const [vendors, setVendors] = useState<any[]>([]);
  const [expenseAccounts, setExpenseAccounts] = useState<PostableAccount[]>([]);
  const [projects, setProjects] = useState<any[]>([]);
  const [lines, setLines] = useState<LineItem[]>([EMPTY_LINE()]);
  const [form, setForm] = useState({
    vendor_id: "",
    project_id: "",
    currency: "PKR",
    exchange_rate: 1,
    description: "",
    due_date: "",
    bill_date: new Date().toISOString().split("T")[0],
  });

  // View modal
  const [showView, setShowView] = useState(false);
  const [viewBill, setViewBill] = useState<VendorBill | null>(null);
  const [viewLines, setViewLines] = useState<any[]>([]);

  // Reason modal
  const [reasonState, setReasonState] = useState({
    open: false,
    title: "",
    action: "",
    id: "",
  });

  /* ═══════════════════════════════════════════════════════
     FETCH BILLS
     ═══════════════════════════════════════════════════════ */
  const fetchBills = useCallback(async () => {
    setLoading(true);
    try {
      const { data, error } = await db
        .from("vendor_bills")
        .select(`*, vendors(name)`)
        .order("bill_date", { ascending: false });

      if (error) throw error;
      setBills((data as VendorBill[]) || []);
    } catch (err: any) {
      console.error("fetchBills error:", err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchBills();
  }, [fetchBills]);

  /* ═══════════════════════════════════════════════════════
     FETCH DROPDOWNS — Shared by create & edit
     ═══════════════════════════════════════════════════════ */
  const fetchDropdowns = async () => {
    try {
      const [vRes, pRes, aRes] = await Promise.all([
        db.from("vendors").select("*").eq("is_active", true).order("name", { ascending: true }),
        supabase.from("projects").select("id, name, status").neq("status", "cancelled").order("name", { ascending: true }),
        db.from("chart_of_accounts").select("id, code, name, normal_balance, account_type, posting_allowed").eq("posting_allowed", true).in("account_type", ["OPERATING_EXPENSE", "COST_OF_SALES", "OTHER_EXPENSE"]).order("code", { ascending: true }),
      ]);

      if (vRes.data) setVendors(vRes.data);
      if (pRes.data) setProjects(pRes.data);
      if (aRes.data) setExpenseAccounts(aRes.data as PostableAccount[]);
    } catch (err: any) {
      console.error("fetchDropdowns error:", err.message);
    }
  };

  /* ═══════════════════════════════════════════════════════
     OPEN CREATE MODAL
     ═══════════════════════════════════════════════════════ */
  const openCreateModal = async () => {
  try {
    setEditingBill(null);
    const emptyLine = EMPTY_LINE();
    setLines([emptyLine]);
    setEditorInitialLines([emptyLine]); 
    setForm({
      vendor_id: "",
      project_id: "",
      currency: "PKR",
      exchange_rate: 1,
      description: "",
      due_date: "",
      bill_date: new Date().toISOString().split("T")[0],
    });
    await fetchDropdowns();
    setShowForm(true);
  } catch (err: any) {
    console.error("openCreateModal error:", err.message);
    alert("Failed to open form: " + err.message);
  }
};

  /* ═══════════════════════════════════════════════════════
     OPEN EDIT MODAL — FULLY FIXED
     ═══════════════════════════════════════════════════════ */
  const openEditModal = async (bill: VendorBill) => {
  try {
    setEditingBill(bill);

    setForm({
      vendor_id: bill.vendor_id || "",
      project_id: bill.project_id || "",
      currency: bill.currency || "PKR",
      exchange_rate: safeNum(bill.exchange_rate, 1),
      description: sv(bill.description),
      due_date: safeDate(bill.due_date),
      bill_date: safeDate(bill.bill_date) || new Date().toISOString().split("T")[0],
    });

    const { data: lineData, error: lineError } = await db
      .from("vendor_bill_lines")
      .select("*")
      .eq("vendor_bill_id", bill.id)
      .order("line_number", { ascending: true });

    if (lineError) {
      console.error("Line fetch error:", lineError.message);
      alert("Failed to load line items: " + lineError.message);
      setLines([EMPTY_LINE()]);
      setEditorInitialLines([EMPTY_LINE()]); // ✅ YEH LINE ADD KARO
    } else if (lineData && lineData.length > 0) {
      const mappedLines = lineData.map((l: any) => ({
        id: l.id || crypto.randomUUID(),
        account_id: l.account_id || "",
        description: sv(l.description),
        quantity: safeNum(l.quantity, 1),
        unit_price: safeNum(l.unit_price, 0),
        tax_rate: safeNum(l.tax_rate, 0),
        withholding_rate: safeNum(l.withholding_rate, 0),
        tax_amount: safeNum(l.tax_amount, 0),
        withholding_amount: safeNum(l.withholding_amount, 0),
        line_total: safeNum(l.line_total, 0),
        project_id: l.project_id || null,
      }));
      setLines(mappedLines);
      setEditorInitialLines(mappedLines); // ✅ YEH LINE ADD KARO
    } else {
      const emptyLine = EMPTY_LINE();
      setLines([emptyLine]);
      setEditorInitialLines([emptyLine]); // ✅ YEH LINE ADD KARO
    }

    await fetchDropdowns();
    setShowForm(true);
  } catch (err: any) {
    console.error("openEditModal error:", err);
    alert("Failed to load bill: " + (err.message || "Unknown error"));
  }
};
  /* ═══════════════════════════════════════════════════════
     OPEN VIEW MODAL — Read-only for POSTED/PAID
     ═══════════════════════════════════════════════════════ */
  const openViewModal = async (bill: VendorBill) => {
    try {
      setViewBill(bill);

      const { data: lineData, error } = await db
        .from("vendor_bill_lines")
        .select("*, chart_of_accounts(code, name)")
        .eq("vendor_bill_id", bill.id)
        .order("line_number", { ascending: true });

      if (error) {
        console.error("View lines error:", error.message);
        setViewLines([]);
      } else {
        setViewLines(lineData || []);
      }
      setShowView(true);
    } catch (err: any) {
      console.error("openViewModal error:", err.message);
    }
  };

  /* ═══════════════════════════════════════════════════════
     LINE CHANGE HANDLER
     ═══════════════════════════════════════════════════════ */
  // ✅ YEH SIMPLE VERSION — JSON.stringify hataya
const handleLineChange = useCallback((newLines: any[]) => {
  setLines(newLines);
}, []);

  /* ═══════════════════════════════════════════════════════
     SUBMIT — CREATE or UPDATE
     ═══════════════════════════════════════════════════════ */
  const handleSubmit = async () => {
    // Validations
    if (!form.vendor_id) {
      alert("Please select a vendor");
      return;
    }
    if (lines.length === 0) {
      alert("Add at least one line item");
      return;
    }
    const badLine = lines.find((l) => !l.account_id || isNaN(l.quantity * l.unit_price));
    if (badLine) {
      alert("Every line item must have an account and valid amount");
      return;
    }
    if (editingBill && !["DRAFT", "SUBMITTED", "VERIFIED", "APPROVED"].includes(editingBill.status?.toUpperCase())) {
      alert("Only DRAFT / SUBMITTED / VERIFIED / APPROVED bills can be edited");
      return;
    }

    setSubmitting(true);
    try {
      const rate = safeNum(form.exchange_rate, 1);
      const subtotal = lines.reduce((s, l) => s + (safeNum(l.quantity) * safeNum(l.unit_price)), 0);
      const taxTotal = lines.reduce((s, l) => s + safeNum(l.tax_amount), 0);
      const whtTotal = lines.reduce((s, l) => s + safeNum(l.withholding_amount), 0);
      const total = subtotal + taxTotal - whtTotal;

      const payload: any = {
        vendor_id: form.vendor_id,
        project_id: form.project_id || null,
        bill_date: form.bill_date,
        due_date: form.due_date || null,
        currency: form.currency,
        exchange_rate: rate,
        description: form.description || null,
        subtotal,
        tax_amount: taxTotal,
        withholding_amount: whtTotal,
        discount_amount: 0,
        total_amount: total,
        base_subtotal: subtotal,
        base_tax_amount: taxTotal,
        base_withholding_amount: whtTotal,
        base_discount_amount: 0,
        base_total_amount: total,
        amount_paid: 0,
        outstanding_amount: total,
        status: "DRAFT",
      };

      const response = await fetch('/api/finance/vendor-bills', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          id: editingBill?.id || null,
          bill: payload,
          lines: lines.map((l, idx) => ({
            line_number: idx + 1,
            account_id: l.account_id,
            description: l.description || '',
            quantity: safeNum(l.quantity, 1),
            unit_price: safeNum(l.unit_price),
            tax_code_id: null,
            tax_rate: safeNum(l.tax_rate),
            tax_amount: safeNum(l.tax_amount),
            withholding_rate: safeNum(l.withholding_rate),
            withholding_amount: safeNum(l.withholding_amount),
            line_total: safeNum(l.line_total),
            project_id: l.project_id || null,
          })),
        }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || 'Failed to save vendor bill');

      setShowForm(false);
      setEditingBill(null);
      fetchBills();
    } catch (err: any) {
      alert("Error: " + err.message);
    } finally {
      setSubmitting(false);
    }
  };

  /* ═══════════════════════════════════════════════════════
     PROCESS ACTION — ALL through SERVER-SIDE WORKFLOW API
     ═══════════════════════════════════════════════════════ */
  const processAction = async (billId: string, action: string, reason: string) => {
    try {
      const result = await callWorkflow('vendor_bill', billId, action.toLowerCase() as any, reason || undefined);
      if (result.success) {
        toast.success(result.message || `Bill ${action} successfully`);
        fetchBills();
      } else {
        toast.error(result.error || 'Action failed');
      }
    } catch (err: any) {
      toast.error('Action failed: ' + err.message);
    }
    setReasonState({ open: false, title: '', action: '', id: '' });
  };

  const handleAction = (billId: string, action: string, needsReason?: boolean) => {
    if (needsReason) {
      setReasonState({ open: true, title: `Confirm ${action}`, action, id: billId });
      return;
    }
    processAction(billId, action, "");
  };

  /* ═══════════════════════════════════════════════════════
     EDITABLE / LOCKED HELPERS
     ═══════════════════════════════════════════════════════ */
  const isEditable = (status: string | undefined) =>
    ["DRAFT", "SUBMITTED", "VERIFIED", "APPROVED"].includes(status?.toUpperCase() || "");

  const isLocked = (status: string | undefined) =>
    ["POSTED", "PARTIALLY_PAID", "PAID", "REVERSED", "CANCELLED"].includes(status?.toUpperCase() || "");

  /* ═══════════════════════════════════════════════════════
     INPUT STYLES
     ═══════════════════════════════════════════════════════ */
  const inputCls =
    "w-full px-4 py-2.5 border dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-shadow";
  const labelCls = "block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1";

  /* ═══════════════════════════════════════════════════════
     PERMISSION GUARD
     ═══════════════════════════════════════════════════════ */
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

  /* ═══════════════════════════════════════════════════════
     RENDER
     ═══════════════════════════════════════════════════════ */
  return (
    <div className="p-6 space-y-6">
      {/* ═══════ HEADER ═══════ */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white flex items-center gap-2">
            <FileText className="w-7 h-7 text-blue-600" /> Vendor Bills
          </h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
            Record supplier expenses with line item breakdown and tax
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link href="/dashboard/vendor-bills/recurring" className="flex items-center gap-2 border border-gray-300 dark:border-gray-600 px-4 py-2.5 rounded-lg text-sm font-medium hover:bg-gray-50 dark:hover:bg-gray-700">
            <Repeat2 size={16} /> Recurring Bills
          </Link>
        {hasPermission("EXPENSE_CREATE") && (
          <button
            onClick={openCreateModal}
            className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-4 py-2.5 rounded-lg text-sm font-medium shadow-sm transition-colors whitespace-nowrap"
          >
            <Plus size={16} /> Create Bill
          </button>
        )}
        </div>
      </div>

      {/* ═══════ TABLE ═══════ */}
      <div className="bg-white dark:bg-gray-800 border dark:border-gray-700 rounded-xl overflow-hidden shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 dark:bg-gray-900/50 border-b dark:border-gray-700 text-left text-xs uppercase text-gray-500 tracking-wider">
              <tr>
                <th className="px-4 py-3">Bill #</th>
                <th className="px-4 py-3 hidden md:table-cell">Vendor</th>
                <th className="px-4 py-3 hidden lg:table-cell">Date</th>
                <th className="px-4 py-3 text-right">Total (PKR)</th>
                <th className="px-4 py-3 text-right">Paid</th>
                <th className="px-4 py-3 text-right">Outstanding</th>
                <th className="px-4 py-3 text-center">Status</th>
                <th className="px-4 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y dark:divide-gray-700">
              {loading ? (
                <tr>
                  <td colSpan={8} className="px-4 py-12 text-center text-gray-400">
                    <Loader2 className="w-5 h-5 animate-spin mx-auto mb-2" />
                    Loading bills...
                  </td>
                </tr>
              ) : bills.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-4 py-16 text-center text-gray-400">
                    <FileText className="w-10 h-10 mx-auto mb-3 opacity-30" />
                    <p className="font-medium">No vendor bills yet</p>
                    <p className="text-xs mt-1">Click "Create Bill" to get started</p>
                  </td>
                </tr>
              ) : (
                bills.map((bill) => (
                  <tr
                    key={bill.id}
                    className="hover:bg-gray-50 dark:hover:bg-gray-700/30 transition-colors"
                  >
                    <td className="px-4 py-3 font-mono text-xs text-blue-600 dark:text-blue-400">
                      {sv(bill.bill_number) || "N/A"}
                    </td>
                    <td className="px-4 py-3 text-gray-900 dark:text-white truncate max-w-[150px] hidden md:table-cell">
                      {bill.vendors?.name || "N/A"}
                    </td>
                    <td className="px-4 py-3 text-gray-500 dark:text-gray-400 text-xs hidden lg:table-cell">
                      {safeDate(bill.bill_date) || "N/A"}
                    </td>
                    <td className="px-4 py-3 text-right font-semibold text-gray-900 dark:text-white">
                      {formatCurrency(bill.total_amount)}
                    </td>
                    <td className="px-4 py-3 text-right text-green-600 dark:text-green-400">
                      {formatCurrency(bill.amount_paid)}
                    </td>
                    <td className="px-4 py-3 text-right text-red-600 dark:text-red-400 font-medium">
                      {formatCurrency(bill.outstanding_amount)}
                    </td>
                    <td className="px-4 py-3 text-center">
                      <span
                        className={`px-2.5 py-0.5 rounded-full text-[11px] font-bold ${
                          STATUS_STYLES[bill.status?.toUpperCase()] || "bg-gray-100 text-gray-700"
                        }`}
                      >
                        {formatStatus(bill.status)}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex items-center justify-end gap-1">
                        {/* Edit button — only for editable statuses */}
                       {/* Edit button — only for editable statuses */}
{isEditable(bill.status) && hasPermission("EXPENSE_UPDATE") && (
  <button
    onClick={() => openEditModal(bill)}
    className="p-1.5 text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-500/10 rounded transition-colors"
    title="Edit bill"
  >
    <Pencil size={15} />
  </button>
)}

{/* View button — for locked statuses */}
{isLocked(bill.status) && (
  <button
    onClick={() => openViewModal(bill)}
    className="p-1.5 text-gray-500 hover:bg-gray-50 dark:hover:bg-gray-700/30 rounded transition-colors"
    title="View bill (read-only)"
  >
    <Eye size={15} />
  </button>
)}

{/* Inline workflow buttons — no duplicate pencil */}
        {isEditable(bill.status) && hasPermission("EXPENSE_UPDATE") && (
          <>
            {bill.status?.toUpperCase() === "DRAFT" && (
              <button
                onClick={() => handleAction(bill.id, "submit")}
                className="p-1.5 text-green-600 hover:bg-green-50 dark:hover:bg-green-500/10 rounded transition-colors"
                title="Submit"
              >
                <span className="text-[10px] font-bold leading-none">↑S</span>
              </button>
            )}
            {bill.status?.toUpperCase() === "SUBMITTED" && (
              <button
                onClick={() => handleAction(bill.id, "verify")}
                className="p-1.5 text-indigo-600 hover:bg-indigo-50 dark:hover:bg-indigo-500/10 rounded transition-colors"
                title="Verify"
              >
                <span className="text-[10px] font-bold leading-none">✓V</span>
              </button>
            )}
            {bill.status?.toUpperCase() === "VERIFIED" && (
              <button
                onClick={() => handleAction(bill.id, "approve")}
                className="p-1.5 text-purple-600 hover:bg-purple-50 dark:hover:bg-purple-500/10 rounded transition-colors"
                title="Approve"
              >
                <span className="text-[10px] font-bold leading-none">✓A</span>
              </button>
            )}
            {bill.status?.toUpperCase() === "APPROVED" && (
              <button
                onClick={() => handleAction(bill.id, "post")}
                className="p-1.5 text-emerald-600 hover:bg-emerald-50 dark:hover:bg-emerald-500/10 rounded transition-colors"
                title="Post"
              >
                <span className="text-[10px] font-bold leading-none">⇒P</span>
              </button>
            )}
            {bill.status?.toUpperCase() !== "DRAFT" && (
              <button
                onClick={() => handleAction(bill.id, "reject", true)}
                className="p-1.5 text-red-500 hover:bg-red-50 dark:hover:bg-red-500/10 rounded transition-colors"
                title="Reject"
              >
                <span className="text-[10px] font-bold leading-none">✕</span>
              </button>
            )}
            <button
              onClick={() => handleAction(bill.id, "cancel", true)}
              className="p-1.5 text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700/30 rounded transition-colors"
              title="Cancel"
            >
              <span className="text-[10px] font-bold leading-none">⊘</span>
            </button>
          </>
        )}
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {!loading && bills.length > 0 && (
          <div className="px-4 py-2.5 border-t dark:border-gray-700 bg-gray-50 dark:bg-gray-900/30 text-xs text-gray-500">
            Showing {bills.length} bill{bills.length !== 1 ? "s" : ""}
          </div>
        )}
      </div>

      {/* ═══════════════════════════════════════════════════
         CREATE / EDIT MODAL
         ═══════════════════════════════════════════════════ */}
      {showForm && (
        <div
          className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4"
          onClick={(e) => { if (e.target === e.currentTarget) setShowForm(false); }}
        >
          <div className="bg-white dark:bg-gray-800 border dark:border-gray-700 rounded-2xl w-full max-w-4xl shadow-2xl max-h-[90vh] flex flex-col">
            {/* Header */}
            <div className="p-5 border-b dark:border-gray-700 flex justify-between items-center shrink-0">
              <h2 className="text-lg font-bold text-gray-900 dark:text-white">
                {editingBill ? `Edit: ${sv(editingBill.bill_number)}` : "Create Vendor Bill"}
              </h2>
              <button
                onClick={() => setShowForm(false)}
                className="p-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-500 transition-colors"
              >
                <X size={20} />
              </button>
            </div>

            {/* Scrollable Body */}
            <div className="p-5 space-y-5 overflow-y-auto flex-1">
              {/* Header Fields */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 bg-gray-50 dark:bg-gray-900/30 p-4 rounded-lg">
                <div>
                  <label className={labelCls}>Vendor <span className="text-red-500">*</span></label>
                  <select
                    value={form.vendor_id}
                    onChange={(e) => setForm({ ...form, vendor_id: e.target.value })}
                    className={inputCls}
                  >
                    <option value="">Select Vendor...</option>
                    {vendors.map((v) => (
                      <option key={v.id} value={v.id}>
                        {v.name} {v.tax_registration ? `(${v.tax_registration})` : ""}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className={labelCls}>Bill Date</label>
                  <input
                    type="date"
                    value={form.bill_date}
                    onChange={(e) => setForm({ ...form, bill_date: e.target.value })}
                    className={inputCls}
                  />
                </div>
                <div>
                  <label className={labelCls}>Due Date</label>
                  <input
                    type="date"
                    value={form.due_date}
                    onChange={(e) => setForm({ ...form, due_date: e.target.value })}
                    className={inputCls}
                  />
                </div>
                <div>
                  <label className={labelCls}>Project (Optional)</label>
                  <select
                    value={form.project_id}
                    onChange={(e) => setForm({ ...form, project_id: e.target.value })}
                    className={inputCls}
                  >
                    <option value="">No Project</option>
                    {projects.map((p) => (
                      <option key={p.id} value={p.id}>{p.name}</option>
                    ))}
                  </select>
                </div>
                <div className="md:col-span-2">
                  <label className={labelCls}>Description</label>
                  <textarea
                    value={form.description}
                    onChange={(e) => setForm({ ...form, description: e.target.value })}
                    rows={2}
                    className={`${inputCls} resize-none`}
                    placeholder="Bill description..."
                  />
                </div>
              </div>

              {/* Multi-Currency */}
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className={labelCls}>Currency</label>
                  <select
                    value={form.currency}
                    onChange={(e) => setForm({ ...form, currency: e.target.value })}
                    className={inputCls}
                  >
                    <option value="PKR">PKR</option>
                    <option value="USD">USD</option>
                    <option value="EUR">EUR</option>
                    <option value="GBP">GBP</option>
                    <option value="AED">AED</option>
                  </select>
                </div>
                <div>
                  <label className={labelCls}>Exchange Rate</label>
                  <input
                    type="number"
                    value={form.exchange_rate}
                    onChange={(e) => setForm({ ...form, exchange_rate: parseFloat(e.target.value) || 1 })}
                    step="0.0001"
                    className={inputCls}
                  />
                </div>
              </div>

              {/* Line Items Editor */}
              <div className="border dark:border-gray-700 rounded-lg overflow-hidden">
                <LineItemsEditor
                  accounts={expenseAccounts}
                  initialLines={editorInitialLines}
                  currency={form.currency}
                  exchangeRate={form.exchange_rate}
                  onChange={handleLineChange}
                />
              </div>
            </div>

            {/* Footer */}
            <div className="flex justify-end gap-3 p-5 border-t dark:border-gray-700 shrink-0">
              <button
                onClick={() => setShowForm(false)}
                disabled={submitting}
                className="px-5 py-2.5 bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 dark:hover:bg-gray-600 text-gray-800 dark:text-white rounded-xl text-sm font-medium transition-colors disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={handleSubmit}
                disabled={!form.vendor_id || lines.length === 0 || submitting || lines.some((l) => !l.account_id)}
                className="px-5 py-2.5 bg-blue-600 hover:bg-blue-700 text-white rounded-xl text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
              >
                {submitting && <Loader2 size={14} className="animate-spin" />}
                {editingBill ? "Update Bill" : "Create Bill"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ═══════════════════════════════════════════════════
         VIEW-ONLY MODAL (for POSTED/PAID bills)
         ═══════════════════════════════════════════════════ */}
      {showView && viewBill && (
        <div
          className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4"
          onClick={(e) => { if (e.target === e.currentTarget) setShowView(false); }}
        >
          <div className="bg-white dark:bg-gray-800 border dark:border-gray-700 rounded-2xl w-full max-w-3xl shadow-2xl max-h-[85vh] flex flex-col">
            {/* Header */}
            <div className="p-5 border-b dark:border-gray-700 flex justify-between items-center shrink-0">
              <h2 className="text-lg font-bold text-gray-900 dark:text-white">
                Bill: {sv(viewBill.bill_number)}
              </h2>
              <button
                onClick={() => setShowView(false)}
                className="p-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-500 transition-colors"
              >
                <X size={20} />
              </button>
            </div>

            {/* Body */}
            <div className="p-5 space-y-4 overflow-y-auto flex-1">
              {/* Info Grid */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
                <div>
                  <p className="text-gray-500 dark:text-gray-400 text-xs">Status</p>
                  <span className={`inline-block mt-1 px-2.5 py-0.5 rounded-full text-[11px] font-bold ${STATUS_STYLES[viewBill.status?.toUpperCase()] || ""}`}>
                    {formatStatus(viewBill.status)}
                  </span>
                </div>
                <div>
                  <p className="text-gray-500 dark:text-gray-400 text-xs">Bill Date</p>
                  <p className="font-medium text-gray-900 dark:text-white">{safeDate(viewBill.bill_date) || "N/A"}</p>
                </div>
                <div>
                  <p className="text-gray-500 dark:text-gray-400 text-xs">Due Date</p>
                  <p className="font-medium text-gray-900 dark:text-white">{safeDate(viewBill.due_date) || "N/A"}</p>
                </div>
                <div>
                  <p className="text-gray-500 dark:text-gray-400 text-xs">Vendor</p>
                  <p className="font-medium text-gray-900 dark:text-white truncate">{viewBill.vendors?.name || "N/A"}</p>
                </div>
              </div>

              {/* Amounts */}
                            {/* Amounts — ✅ LINES SE CALCULATE KAREGA */}
              <div className="grid grid-cols-3 gap-3">
                {(() => {
                  const calcTotal = viewLines.reduce((s, l) => s + safeNum(l.line_total), 0);
                  const calcPaid = safeNum(viewBill.amount_paid);
                  const calcOutstanding = Math.max(0, calcTotal - calcPaid);
                  return (
                    <>
                      <div className="bg-gray-50 dark:bg-gray-900/30 rounded-lg p-3 text-center">
                        <p className="text-xs text-gray-500">Total</p>
                        <p className="text-lg font-bold text-gray-900 dark:text-white">{formatCurrency(calcTotal)}</p>
                      </div>
                      <div className="bg-green-50 dark:bg-green-900/20 rounded-lg p-3 text-center">
                        <p className="text-xs text-green-600">Paid</p>
                        <p className="text-lg font-bold text-green-700 dark:text-green-400">{formatCurrency(calcPaid)}</p>
                      </div>
                      <div className="bg-red-50 dark:bg-red-900/20 rounded-lg p-3 text-center">
                        <p className="text-xs text-red-600">Outstanding</p>
                        <p className="text-lg font-bold text-red-700 dark:text-red-400">{formatCurrency(calcOutstanding)}</p>
                      </div>
                    </>
                  );
                })()}
              </div>

              {/* Rejection Reason */}
              {viewBill.rejection_reason && (
                <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-3">
                  <p className="text-xs font-bold text-red-600 mb-1">Rejection Reason</p>
                  <p className="text-sm text-red-700 dark:text-red-400">{viewBill.rejection_reason}</p>
                </div>
              )}

              {/* Line Items Table */}
              <div className="border dark:border-gray-700 rounded-lg overflow-hidden">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 dark:bg-gray-900/50 text-xs uppercase text-gray-500">
                    <tr>
                      <th className="px-3 py-2 text-left">#</th>
                      <th className="px-3 py-2 text-left">Account</th>
                      <th className="px-3 py-2 text-left">Description</th>
                      <th className="px-3 py-2 text-right">Qty</th>
                      <th className="px-3 py-2 text-right">Price</th>
                      <th className="px-3 py-2 text-right">Tax</th>
                      <th className="px-3 py-2 text-right">WHT</th>
                      <th className="px-3 py-2 text-right">Total</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y dark:divide-gray-700">
                    {viewLines.length === 0 ? (
                      <tr>
                        <td colSpan={8} className="px-3 py-6 text-center text-gray-400">No line items</td>
                      </tr>
                    ) : (
                      viewLines.map((l: any, i: number) => (
                        <tr key={l.id} className="hover:bg-gray-50 dark:hover:bg-gray-700/20">
                          <td className="px-3 py-2 text-gray-500">{i + 1}</td>
                          <td className="px-3 py-2 font-mono text-xs">
                            {l.chart_of_accounts?.code || "-"} {l.chart_of_accounts?.name || ""}
                          </td>
                          <td className="px-3 py-2 text-gray-700 dark:text-gray-300">{sv(l.description)}</td>
                          <td className="px-3 py-2 text-right">{safeNum(l.quantity)}</td>
                          <td className="px-3 py-2 text-right">{formatCurrency(safeNum(l.unit_price))}</td>
                          <td className="px-3 py-2 text-right text-blue-600">{formatCurrency(safeNum(l.tax_amount))}</td>
                          <td className="px-3 py-2 text-right text-orange-600">{formatCurrency(safeNum(l.withholding_amount))}</td>
                          <td className="px-3 py-2 text-right font-semibold">{formatCurrency(safeNum(l.line_total))}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>

              {viewBill.description && (
                <div>
                  <p className="text-xs text-gray-500 mb-1">Description</p>
                  <p className="text-sm text-gray-700 dark:text-gray-300 bg-gray-50 dark:bg-gray-900/30 p-3 rounded-lg">
                    {viewBill.description}
                  </p>
                </div>
              )}
            </div>

            {/* Footer */}
            <div className="flex justify-end p-5 border-t dark:border-gray-700 shrink-0">
              <button
                onClick={() => setShowView(false)}
                className="px-5 py-2.5 bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 dark:hover:bg-gray-600 text-gray-800 dark:text-white rounded-xl text-sm font-medium transition-colors"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ═══════ REASON MODAL ═══════ */}
      <ReasonModal
        open={reasonState.open}
        title={reasonState.title}
        description={`Are you sure you want to ${reasonState.action} this bill?`}
        onConfirm={(reason: string) => processAction(reasonState.id, reasonState.action, reason)}
        onCancel={() => setReasonState({ open: false, title: "", action: "", id: "" })}
      />
    </div>
  );
}