"use client";
import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/context/AuthContext";
import { usePermissions } from "@/context/PermissionContext";
import { Plus, CheckCircle, CreditCard, X, Loader2, Layers3 } from "lucide-react";
import ReasonModal from "@/components/finance/ReasonModal";
import Link from "next/link";

const STATUS_STYLES: Record<string, string> = {
  DRAFT: "bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300",
  APPROVED: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400",
  POSTED: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400",
  REVERSED: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400",
  CANCELLED: "bg-gray-200 text-gray-500 dark:bg-gray-600 dark:text-gray-400 italic",
};

const formatStatus = (status: string | null | undefined): string => {
  if (!status) return "Unknown";
  return status
    .replace(/_/g, " ")
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase());
};

interface VendorBillForAllocation {
  id: string;
  bill_number: string | null;
  vendor_id: string;
  outstanding_amount: number;
  due_date: string | null;
  status: string;
}

interface VendorPayment {
  id: string;
  payment_number: string | null;
  payment_date: string;
  amount: number;
  vendor_id: string;
  payment_method: string;
  status: string;
  description: string | null;
}

const db = supabase.schema("finance");

export default function VendorPaymentsPage() {
  const { user, profile } = useAuth();
  const { hasPermission, isLoading: permLoading } = usePermissions();
  
  const [payments, setPayments] = useState<VendorPayment[]>([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [successMsg, setSuccessMsg] = useState("");
  
  const [bills, setBills] = useState<VendorBillForAllocation[]>([]);
  const [vendors, setVendors] = useState<any[]>([]);
  const [allocations, setAllocations] = useState<Record<string, number>>({});
  const [form, setForm] = useState({
    vendor_id: "",
    amount: "",
    payment_method: "BANK_TRANSFER",
    reference: "",
    description: "",
  });

  const [reasonState, setReasonState] = useState({
    open: false,
    title: "",
    action: "",
    id: "",
  });

  const totalAllocated = Object.values(allocations).reduce(
    (sum, val) => sum + val,
    0
  );
  const unallocated = parseFloat(form.amount || "0") - totalAllocated;
  const isBalanced =
    unallocated >= -0.01 && unallocated <= 0.01 && totalAllocated > 0;

  // BUG-010 FIX: payments are now read through the permission-gated API
  // (VENDOR_PAYMENT_READ) instead of a raw client-side table select.
  const fetchPayments = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/finance/vendor-payments");
      const result = await res.json();
      if (!res.ok) throw new Error(result.error || "Failed to load payments");
      setPayments((result.data as VendorPayment[]) || []);
    } catch (err: any) {
      console.error("Failed to fetch payments:", err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchPayments();
  }, [fetchPayments]);

  const openCreateModal = async (selectedVendorId?: string) => {
    setAllocations({});
    setBills([]);
    setForm({
      vendor_id: selectedVendorId || "",
      amount: "",
      payment_method: "BANK_TRANSFER",
      reference: "",
      description: "",
    });

    const { data: vData } = await db
      .from("vendors")
      .select("*")
      .eq("is_active", true)
      .order("name");
    if (vData) setVendors(vData);

    if (selectedVendorId) {
      await fetchOutstandingBills(selectedVendorId);
    }

    setShowModal(true);
  };

  const fetchOutstandingBills = async (vendorId: string) => {
    try {
      const { data: billsData, error } = await db
        .from("vendor_bills")
        .select("id, bill_number, vendor_id, outstanding_amount, due_date, status")
        .eq("vendor_id", vendorId)
        .in("status", ["POSTED", "PARTIALLY_PAID"])
        .gt("outstanding_amount", 0)
        .order("due_date", { ascending: true });

      if (error) throw error;
      setBills((billsData as VendorBillForAllocation[]) || []);
    } catch (err: any) {
      console.error("Failed to fetch bills:", err.message);
      setBills([]);
    }
  };

  const handleVendorChange = (vendorId: string) => {
    setForm((prev) => ({ ...prev, vendor_id: vendorId }));
    setAllocations({});
    if (vendorId) {
      fetchOutstandingBills(vendorId);
    } else {
      setBills([]);
    }
  };

  const handleAllocate = (billId: string, amount: string) => {
    const val = parseFloat(amount) || 0;
    setAllocations((prev) => {
      const next = { ...prev };
      if (val > 0) next[billId] = val;
      else delete next[billId];
      return next;
    });
  };

  // BUG-010 FIX: creation now goes through the server API. The server
  // re-validates every allocation against the real (server-side)
  // outstanding balance of each bill — it never trusts the amounts this
  // component happens to be showing — and the record is created as DRAFT
  // only. Nothing here posts to the ledger anymore; posting requires a
  // separate APPROVE step (by someone other than the creator) followed by
  // a separate POST step, both permission-gated server-side.
  const handleSubmit = async () => {
    if (!isBalanced || !form.amount || !form.vendor_id) {
      return alert(
        "Please fill all required fields and fully allocate the amount."
      );
    }

    setSubmitting(true);
    try {
      const res = await fetch("/api/finance/vendor-payments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          vendor_id: form.vendor_id,
          payment_method: form.payment_method,
          reference: form.reference || undefined,
          description: form.description || undefined,
          allocations: Object.entries(allocations).map(([billId, amount]) => ({
            vendor_bill_id: billId,
            allocated_amount: amount,
          })),
        }),
      });
      const result = await res.json();
      if (!res.ok) throw new Error(result.error || "Failed to create payment");

      setShowModal(false);
      setSuccessMsg(
        "Payment of " +
          formatCurrency(parseFloat(form.amount || "0")) +
          " recorded as DRAFT. It now needs approval and posting before it affects the ledger."
      );

      try {
        await fetchPayments();
      } catch (e) {
        console.error(e);
      }

      setTimeout(() => setSuccessMsg(""), 5000);
    } catch (err: any) {
      alert("Error: " + err.message);
    } finally {
      setSubmitting(false);
    }
  };

  // BUG-010 FIX: approve/post/cancel now go through the permission-gated,
  // maker-checker-enforced PATCH endpoint instead of raw client-side
  // `.update()` calls. Bill status (PAID/PARTIALLY_PAID) is maintained
  // automatically by the DB trigger when allocations are posted/removed —
  // this page no longer touches vendor_bills directly.
  const processAction = async (payId: string, action: string, reason?: string) => {
    try {
      const res = await fetch(`/api/finance/vendor-payments/${payId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, reason }),
      });
      const result = await res.json();
      if (!res.ok) throw new Error(result.error || "Action failed");
      fetchPayments();
    } catch (err: any) {
      alert("Action failed: " + err.message);
    }
    setReasonState({ open: false, title: "", action: "", id: "" });
  };

  const handleAction = (payId: string, action: string, needsReason?: boolean) => {
    if (needsReason) {
      setReasonState({ open: true, title: `Confirm ${action}`, action, id: payId });
      return;
    }
    processAction(payId, action);
  };

  const formatCurrency = (amount: number) =>
    new Intl.NumberFormat("en-PK", {
      style: "currency",
      currency: "PKR",
      minimumFractionDigits: 0,
    }).format(amount || 0);

  const inputClass =
    "w-full p-2.5 border dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm outline-none focus:ring-2 focus:ring-blue-500";

  // BUG-010 FIX: this page was gated on EXPENSE_READ/EXPENSE_CREATE — the
  // wrong permission domain, meaning anyone with expense access (not
  // necessarily vendor-payment access) could view/create cash
  // disbursements. Gate on the correct VENDOR_PAYMENT_* permissions.
  if (permLoading || !hasPermission("VENDOR_PAYMENT_READ")) {
    return (
      <div className="p-6 flex items-center justify-center min-h-[60vh]">
        <p className="text-gray-500">Access Denied</p>
      </div>
    );
  }

  return (
    <div className="p-6">
      {/* HEADER */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white flex items-center gap-2">
            <CreditCard className="w-7 h-7 text-green-600" /> Vendor Payments
          </h1>
          <p className="text-sm text-gray-500 dark:text-gray-400">
            Pay vendors and allocate payments against multiple bills
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link href="/dashboard/vendor-payments/batches" className="flex items-center gap-2 border border-gray-300 dark:border-gray-600 px-4 py-2.5 rounded-lg text-sm font-medium hover:bg-gray-50 dark:hover:bg-gray-700">
            <Layers3 size={16} /> Payment Batches
          </Link>
        {hasPermission("VENDOR_PAYMENT_CREATE") && (
          <button
            onClick={() => openCreateModal()}
            className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-4 py-2.5 rounded-lg text-sm font-medium shadow-sm transition-colors"
          >
            <Plus size={16} /> Record Payment
          </button>
        )}
        </div>
      </div>

      {/* SUCCESS BANNER */}
      {successMsg && (
        <div className="mb-6 bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-xl p-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 bg-green-100 dark:bg-green-900/50 rounded-full flex items-center justify-center">
              <CheckCircle size={18} className="text-green-600 dark:text-green-400" />
            </div>
            <p className="text-sm font-medium text-green-800 dark:text-green-300">
              {successMsg}
            </p>
          </div>
          <button 
            onClick={() => setSuccessMsg("")}
            className="text-green-500 hover:text-green-700 dark:hover:text-green-300 transition-colors"
          >
            <X size={16} />
          </button>
        </div>
      )}

      {/* TABLE */}
      <div className="bg-white dark:bg-gray-800 border dark:border-gray-700 rounded-xl overflow-hidden shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 dark:bg-gray-900/50 border-b dark:border-gray-700 text-left text-xs uppercase text-gray-500">
              <tr>
                <th className="px-4 py-3">Payment #</th>
                <th className="px-4 py-3">Date</th>
                <th className="px-4 py-3 text-right">Amount (PKR)</th>
                <th className="px-4 py-3">Method</th>
                <th className="px-4 py-3 text-center">Status</th>
                <th className="px-4 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y dark:divide-gray-700">
              {loading ? (
                <tr>
                  <td colSpan={6} className="px-4 py-12 text-center text-gray-400">
                    <Loader2 className="w-5 h-5 animate-spin mx-auto mb-2" />
                    Loading...
                  </td>
                </tr>
              ) : payments.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-16 text-center text-gray-400">
                    No payments yet.
                  </td>
                </tr>
              ) : (
                payments.map((p) => (
                  <tr
                    key={p.id}
                    className="hover:bg-gray-50 dark:hover:bg-gray-700/30 transition-colors"
                  >
                    <td className="px-4 py-3 font-mono text-xs text-green-600 dark:text-green-400">
                      {p.payment_number || p.id.slice(0, 8)}
                    </td>
                    <td className="px-4 py-3 text-gray-600 dark:text-gray-300">
                      {p.payment_date
                        ? new Date(p.payment_date).toLocaleDateString()
                        : "N/A"}
                    </td>
                    <td className="px-4 py-3 text-right font-semibold">
                      {formatCurrency(p.amount)}
                    </td>
                    <td className="px-4 py-3 text-gray-500 text-xs">
                      {formatStatus(p.payment_method)}
                    </td>
                    <td className="px-4 py-3 text-center">
                      <span
                        className={`px-2.5 py-0.5 rounded-full text-[11px] font-bold ${
                          STATUS_STYLES[p.status?.toUpperCase()] ||
                          "bg-gray-100 text-gray-700"
                        }`}
                      >
                        {formatStatus(p.status)}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex items-center justify-end gap-1">
                        {p.status?.toUpperCase() === "DRAFT" && hasPermission("VENDOR_PAYMENT_APPROVE") && (
                          <button
                            onClick={() => handleAction(p.id, "approve")}
                            className="px-2 py-1 text-[10px] font-bold bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400 rounded hover:bg-blue-200 dark:hover:bg-blue-900/50 transition-colors"
                          >
                            ✓ Approve
                          </button>
                        )}
                        {p.status?.toUpperCase() === "APPROVED" && hasPermission("VENDOR_PAYMENT_POST") && (
                          <button
                            onClick={() => handleAction(p.id, "post")}
                            className="px-2 py-1 text-[10px] font-bold bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400 rounded hover:bg-green-200 dark:hover:bg-green-900/50 transition-colors"
                          >
                            ⇒ Post
                          </button>
                        )}
                        {["DRAFT", "APPROVED"].includes(p.status?.toUpperCase() || "") && hasPermission("VENDOR_PAYMENT_UPDATE") && (
                          <button
                            onClick={() => handleAction(p.id, "cancel", true)}
                            className="px-2 py-1 text-[10px] font-bold bg-red-100 text-red-600 dark:bg-red-900/30 dark:text-red-400 rounded hover:bg-red-200 dark:hover:bg-red-900/50 transition-colors"
                          >
                            ✕
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

      {/* PAYMENT ALLOCATION MODAL */}
      {showModal && (
        <div
          className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4"
          onClick={(e) => {
            if (e.target === e.currentTarget) setShowModal(false);
          }}
        >
          <div className="bg-white dark:bg-gray-800 border dark:border-gray-700 rounded-2xl w-full max-w-3xl shadow-2xl max-h-[90vh] flex flex-col">
            <div className="p-5 border-b dark:border-gray-700 flex justify-between items-center shrink-0">
              <div className="flex items-center gap-2">
                <CreditCard className="w-5 h-5 text-green-600" />
                <h2 className="text-lg font-bold text-gray-900 dark:text-white">
                  Allocate Payment
                </h2>
              </div>
              <button
                onClick={() => setShowModal(false)}
                className="p-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-500 transition-colors"
              >
                <X size={20} />
              </button>
            </div>

            <div className="p-5 space-y-4 overflow-y-auto flex-1">
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4 bg-gray-50 dark:bg-gray-900/30 p-4 rounded-lg">
                <div className="md:col-span-1">
                  <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">
                    Vendor *
                  </label>
                  <select
                    value={form.vendor_id}
                    onChange={(e) => handleVendorChange(e.target.value)}
                    className={inputClass}
                  >
                    <option value="">Select Vendor...</option>
                    {vendors.map((v) => (
                      <option key={v.id} value={v.id}>
                        {v.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">
                    Payment Amount (PKR) *
                  </label>
                  <input
                    type="number"
                    value={form.amount}
                    onChange={(e) =>
                      setForm({ ...form, amount: e.target.value })
                    }
                    className={`${inputClass} text-right text-lg font-bold`}
                    placeholder="0.00"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">
                    Payment Method
                  </label>
                  <select
                    value={form.payment_method}
                    onChange={(e) =>
                      setForm({ ...form, payment_method: e.target.value })
                    }
                    className={inputClass}
                  >
                    <option value="BANK_TRANSFER">Bank Transfer</option>
                    <option value="CHEQUE">Cheque</option>
                    <option value="CASH">Cash</option>
                    <option value="JAZZCASH">JazzCash</option>
                    <option value="EASYPAISA">EasyPaisa</option>
                    <option value="PLATFORM">Platform</option>
                    <option value="OTHER">Other</option>
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">
                    Reference / Cheque #
                  </label>
                  <input
                    type="text"
                    value={form.reference}
                    onChange={(e) =>
                      setForm({ ...form, reference: e.target.value })
                    }
                    className={inputClass}
                    placeholder="e.g., CHQ-123456"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">
                    Description
                  </label>
                  <input
                    type="text"
                    value={form.description}
                    onChange={(e) =>
                      setForm({ ...form, description: e.target.value })
                    }
                    className={inputClass}
                    placeholder="Payment details..."
                  />
                </div>
              </div>

              <div
                className={`p-3 rounded-lg border-2 flex justify-between items-center transition-colors ${
                  !form.amount
                    ? "bg-gray-50 border-gray-200 text-gray-500"
                    : isBalanced
                    ? "bg-green-50 border-green-200 text-green-700"
                    : "bg-red-50 border-red-200 text-red-700"
                }`}
              >
                <span className="text-sm font-medium">Unallocated Amount:</span>
                <span className="text-lg font-bold">{unallocated.toLocaleString()}</span>
              </div>

              <div className="space-y-2">
                <h3 className="text-sm font-bold text-gray-700 dark:text-gray-300">
                  {form.vendor_id
                    ? "Select bills to pay:"
                    : "Select a vendor first to see outstanding bills"}
                </h3>
                {!form.vendor_id ? (
                  <div className="text-sm text-gray-400 dark:text-gray-500 bg-gray-50 dark:bg-gray-900/50 p-8 rounded-lg text-center border-2 border-dashed dark:border-gray-700">
                    <p className="font-medium mb-1">No vendor selected</p>
                    <p className="text-xs">Select a vendor above to see outstanding bills</p>
                  </div>
                ) : bills.length === 0 ? (
                  <p className="text-sm text-gray-400 bg-gray-50 dark:bg-gray-900/50 p-4 rounded-lg text-center">
                    No outstanding bills found for this vendor.
                  </p>
                ) : (
                  bills.map((bill) => (
                    <div
                      key={bill.id}
                      className="flex items-center gap-4 p-3 border dark:border-gray-700 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-700/30 transition-colors"
                    >
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-gray-900 dark:text-white">
                          {bill.bill_number || "No Number"}
                        </p>
                        <p className="text-xs text-gray-500">
                          Due:{" "}
                          {bill.due_date
                            ? new Date(bill.due_date).toLocaleDateString()
                            : "N/A"}{" "}
                          <span className="mx-1">|</span>
                          Outstanding:{" "}
                          <span className="font-bold text-red-500">
                            {formatCurrency(bill.outstanding_amount)}
                          </span>
                        </p>
                      </div>
                      <input
                        type="number"
                        placeholder="0"
                        value={allocations[bill.id] || ""}
                        onChange={(e) => handleAllocate(bill.id, e.target.value)}
                        className="w-32 p-2 border dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm text-right outline-none focus:ring-2 focus:ring-green-500"
                        max={bill.outstanding_amount}
                        min={0}
                        step={0.01}
                      />
                    </div>
                  ))
                )}
              </div>
            </div>

            <div className="flex justify-end gap-3 p-5 border-t dark:border-gray-700 shrink-0 bg-white dark:bg-gray-800 rounded-b-2xl">
              <button
                onClick={() => setShowModal(false)}
                disabled={submitting}
                className="px-4 py-2.5 bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 dark:hover:bg-gray-600 text-gray-800 dark:text-white rounded-xl text-sm font-medium transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleSubmit}
                disabled={!isBalanced || !form.vendor_id || submitting}
                className="px-4 py-2.5 bg-green-600 hover:bg-green-700 text-white rounded-xl text-sm disabled:opacity-50 flex items-center gap-2 transition-colors"
              >
                {submitting && <Loader2 size={14} className="animate-spin" />}
                <CheckCircle size={16} /> Record Payment
              </button>
            </div>
          </div>
        </div>
      )}

      {/* REASON MODAL */}
      <ReasonModal
        open={reasonState.open}
        title={reasonState.title}
        description={`Are you sure you want to ${reasonState.action} this payment?`}
        onConfirm={(reason: string) => processAction(reasonState.id, reasonState.action, reason)}
        onCancel={() => setReasonState({ open: false, title: "", action: "", id: "" })}
      />
    </div>
  );
}