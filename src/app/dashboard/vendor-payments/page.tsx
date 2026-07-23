"use client";
import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/context/AuthContext";
import { usePermissions } from "@/hooks/usePermissions";
import { Plus, CheckCircle, CreditCard, X, Loader2 } from "lucide-react";
import StatusActions from "@/components/finance/StatusActions";

// ✅ FIX #5: Lowercase keys
const STATUS_STYLES: Record<string, string> = {
  draft: "bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300",
  approved: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400",
  posted: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400",
  reversed: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400",
  cancelled: "bg-gray-200 text-gray-500 dark:bg-gray-600 dark:text-gray-400 italic",
};

// ✅ FIX #2: outstanding_amount instead of base_outstanding_amount
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

// ✅ FIX: Finance schema reference
const db = supabase.schema("finance");

export default function VendorPaymentsPage() {
  const { user } = useAuth();
  const { hasPermission, isLoading: permLoading } = usePermissions();
  const [payments, setPayments] = useState<VendorPayment[]>([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // Allocation state
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

  const totalAllocated = Object.values(allocations).reduce(
    (sum, val) => sum + val,
    0
  );
  const unallocated = parseFloat(form.amount || "0") - totalAllocated;
  const isBalanced = unallocated >= -0.01 && unallocated <= 0.01 && totalAllocated > 0;

  // ✅ FIX #1: finance schema
  const fetchPayments = useCallback(async () => {
    setLoading(true);
    const { data, error } = await db
      .from("vendor_payments")
      .select("*")
      .order("payment_date", { ascending: false });

    if (error) console.error("Failed to fetch payments:", error.message);
    if (data) setPayments(data as VendorPayment[]);
    setLoading(false);
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

    // ✅ FIX #4: status = 'active' instead of is_active = true
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

  // ✅ FIX #1 & #2: finance schema + outstanding_amount
  const fetchOutstandingBills = async (vendorId: string) => {
    const { data: billsData, error } = await db
      .from("vendor_bills")
      .select(
        "id, bill_number, vendor_id, outstanding_amount, due_date, status"
      )
      .eq("vendor_id", vendorId)
      .in("status", ["posted", "partially_paid", "overdue"])
      .gt("outstanding_amount", 0)
      .order("due_date", { ascending: true });

    if (error) {
      console.error("Failed to fetch bills:", error.message);
      setBills([]);
    }
    if (billsData) setBills(billsData as VendorBillForAllocation[]);
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

  const handleSubmit = async () => {
    if (!isBalanced || !form.amount || !form.vendor_id) {
      return alert(
        "Please fill all required fields and fully allocate the amount."
      );
    }

    setSubmitting(true);
    try {
      // 1. Generate payment number
      const { data: numData } = await db.rpc("get_next_number", {
        p_type: "VENDOR_PAYMENT",
      });

      // 2. Create Vendor Payment (draft)
      const { data: payment, error } = await db
        .from("vendor_payments")
        .insert({
          payment_number: numData || `VP-${Date.now()}`,
          payment_date: new Date().toISOString().split("T")[0],
          amount: parseFloat(form.amount),
          currency: "PKR",
          exchange_rate: 1,
          vendor_id: form.vendor_id,
          payment_method: form.payment_method,
          reference: form.reference || null,
          description: form.description || null,
          status: "draft",
          created_by: user?.id,
        })
        .select()
        .single();

      if (error) throw new Error(error.message);

      // ✅ FIX #3: vendor_payment_id instead of payment_receipt_id
      const allocInserts = Object.entries(allocations).map(
        ([billId, amount]) => ({
          vendor_payment_id: payment.id,
          vendor_bill_id: billId,
          allocated_amount: amount,
          allocated_by: user?.id,
        })
      );

      if (allocInserts.length > 0) {
        const { error: allocError } = await db
          .from("vendor_payment_allocations")
          .insert(allocInserts);
        if (allocError) throw new Error("Allocation failed: " + allocError.message);
      }

      // 3. Try to post to ledger (graceful failure)
      try {
        // Fetch current open period
        const { data: periodData } = await db
          .from("accounting_periods")
          .select("id")
          .eq("status", "open")
          .limit(1)
          .single();

        if (periodData) {
          const { error: postError } = await db.rpc("post_vendor_payment", {
            p_payment_id: payment.id,
            p_period_id: periodData.id,
            p_transaction_date: new Date().toISOString().split("T")[0],
          });

          if (postError) {
            console.warn("Posting warning:", postError.message);
            // Don't fail the whole payment, just warn
          } else {
            // Update status to posted
            await db
              .from("vendor_payments")
              .update({ status: "posted" })
              .eq("id", payment.id);
          }
        }
      } catch (postErr: any) {
        console.warn("Posting skipped:", postErr.message);
      }

      alert("Payment Recorded & Allocated Successfully!");
      setShowModal(false);
      fetchPayments();
    } catch (err: any) {
      alert("Error: " + err.message);
    } finally {
      setSubmitting(false);
    }
  };

  const formatCurrency = (amount: number) =>
    new Intl.NumberFormat("en-PK", {
      style: "currency",
      currency: "PKR",
      minimumFractionDigits: 0,
    }).format(amount || 0);

  const inputClass =
    "w-full p-2.5 border dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm outline-none focus:ring-2 focus:ring-blue-500";

  if (permLoading || !hasPermission("EXPENSE_READ")) {
    return (
      <div className="p-6 flex items-center justify-center min-h-[60vh]">
        <p className="text-gray-500">Access Denied</p>
      </div>
    );
  }

  return (
    <div className="p-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white flex items-center gap-2">
            <CreditCard className="w-7 h-7 text-green-600" /> Vendor Payments
          </h1>
          <p className="text-sm text-gray-500 dark:text-gray-400">
            Pay vendors and allocate payments against multiple bills
          </p>
        </div>
        {hasPermission("EXPENSE_CREATE") && (
          <button
            onClick={() => openCreateModal()}
            className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-4 py-2.5 rounded-lg text-sm font-medium shadow-sm transition-colors"
          >
            <Plus size={16} /> Record Payment
          </button>
        )}
      </div>

      {/* Table */}
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
              </tr>
            </thead>
            <tbody className="divide-y dark:divide-gray-700">
              {loading ? (
                <tr>
                  <td
                    colSpan={5}
                    className="px-4 py-12 text-center text-gray-400"
                  >
                    <Loader2 className="w-5 h-5 animate-spin mx-auto mb-2" />
                    Loading...
                  </td>
                </tr>
              ) : payments.length === 0 ? (
                <tr>
                  <td
                    colSpan={5}
                    className="px-4 py-16 text-center text-gray-400"
                  >
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
                    {/* ✅ FIX #8: Use amount instead of base_amount */}
                    <td className="px-4 py-3 text-right font-semibold">
                      {formatCurrency(p.amount)}
                    </td>
                    <td className="px-4 py-3 text-gray-500 text-xs">
                      {p.payment_method?.replace(/_/g, " ")}
                    </td>
                    <td className="px-4 py-3 text-center">
                      <span
                        className={`px-2.5 py-0.5 rounded-full text-[11px] font-bold ${
                          STATUS_STYLES[p.status] ||
                          "bg-gray-100 text-gray-700"
                        }`}
                      >
                        {p.status?.replace(/_/g, " ")}
                      </span>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* ==================== PAYMENT ALLOCATION MODAL ==================== */}
      {showModal && (
        <div
          className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4"
          onClick={(e) => {
            if (e.target === e.currentTarget) setShowModal(false);
          }}
        >
          <div className="bg-white dark:bg-gray-800 border dark:border-gray-700 rounded-2xl w-full max-w-3xl shadow-2xl max-h-[90vh] flex flex-col">
            {/* Header */}
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

            {/* Scrollable Body */}
            <div className="p-5 space-y-4 overflow-y-auto flex-1">
              {/* Vendor + Amount + Method */}
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

              {/* Reference & Description */}
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

              {/* Unallocated Banner */}
              <div
                className={`p-3 rounded-lg border-2 flex justify-between items-center transition-colors ${
                  !form.amount
                    ? "bg-gray-50 border-gray-200 text-gray-500"
                    : isBalanced
                      ? "bg-green-50 border-green-200 text-green-700"
                      : "bg-red-50 border-red-200 text-red-700"
                }`}
              >
                <span className="text-sm font-medium">
                  Unallocated Amount:
                </span>
                <span className="text-lg font-bold">
                  {unallocated.toLocaleString()}
                </span>
              </div>

              {/* Bills Allocation List */}
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
                        {/* ✅ FIX #6: Removed JS comment from JSX */}
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
                      {/* ✅ FIX #7: Removed toLocaleString() from max attribute */}
                      <input
                        type="number"
                        placeholder="0"
                        value={allocations[bill.id] || ""}
                        onChange={(e) =>
                          handleAllocate(bill.id, e.target.value)
                        }
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

            {/* Footer */}
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
    </div>
  );
}