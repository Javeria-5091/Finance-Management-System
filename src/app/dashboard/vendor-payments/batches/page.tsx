"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Layers3, Loader2, Send, CheckCircle, Upload } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { usePermissions } from "@/context/PermissionContext";
import toast from "react-hot-toast";

type Bill = {
  id: string;
  bill_number: string;
  vendor_id: string;
  outstanding_amount: number;
  currency: string;
  due_date: string | null;
  vendors?: { name: string } | { name: string }[] | null;
};

type Account = {
  id: string;
  account_name: string;
  currency: string;
};

type Batch = {
  id: string;
  batch_number: string;
  payment_count: number;
  total_amount: number;
  status: string;
  risk_flags?: any[];
};

const PAYMENT_METHODS = [
  "BANK_TRANSFER",
  "CHEQUE",
  "CASH",
  "PLATFORM",
  "OTHER",
];

export default function VendorPaymentBatchesPage() {
  const { hasPermission } = usePermissions();
  const [batches, setBatches] = useState<Batch[]>([]);
  const [bills, setBills] = useState<Bill[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [account, setAccount] = useState("");
  const [paymentMethod, setPaymentMethod] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [batchRes, billRes, accRes] = await Promise.all([
        fetch("/api/finance/vendor-payments/batches", { credentials: "include" }),
        supabase
          .schema("finance")
          .from("vendor_bills")
          .select("id,bill_number,vendor_id,outstanding_amount,currency,due_date,vendors:vendor_id(name)")
          .in("status", ["POSTED", "PARTIALLY_PAID"])
          .gt("outstanding_amount", 0)
          .order("due_date"),
        supabase
          .schema("finance")
          .from("financial_accounts")
          .select("id,account_name,currency")
          .eq("is_active", true)
          .order("account_name"),
      ]);

      const batchJson = await batchRes.json().catch(() => ({}));
      if (!batchRes.ok) throw new Error(batchJson.error || "Failed to load payment batches");
      if (billRes.error) throw new Error(billRes.error.message);
      if (accRes.error) throw new Error(accRes.error.message);

      setBatches(batchJson.data || []);
      setBills(billRes.data || []);
      setAccounts(accRes.data || []);
    } catch (e: any) {
      toast.error(e.message || "Failed to load payment batches");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const selectedBills = bills.filter((bill) => selected.includes(bill.id));

  async function create() {
    if (!selectedBills.length) return toast.error("Select at least one bill");
    if (!account) return toast.error("Select a payment account");
    if (!paymentMethod) return toast.error("Select a payment method");

    setSaving(true);
    try {
      // The DB batch function accepts one payment group per vendor. Grouping
      // here lets a single batch contain multiple vendors while preserving
      // the same-vendor allocation invariant inside each child payment.
      const groups = new Map<string, Bill[]>();
      for (const bill of selectedBills) {
        const group = groups.get(bill.vendor_id) || [];
        group.push(bill);
        groups.set(bill.vendor_id, group);
      }

      const payload = {
        payment_date: new Date().toISOString().slice(0, 10),
        payment_method: paymentMethod,
        financial_account_id: account,
        payments: [...groups.entries()].map(([vendor_id, vendorBills]) => ({
          vendor_id,
          allocations: vendorBills.map((bill) => ({
            vendor_bill_id: bill.id,
            allocated_amount: Number(bill.outstanding_amount),
          })),
        })),
      };

      const response = await fetch("/api/finance/vendor-payments/batches", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || "Payment batch could not be created");

      toast.success(`Batch ${result.batch?.batch_number || ""} created`);
      setSelected([]);
      setPaymentMethod("");
      await load();
    } catch (e: any) {
      toast.error(e.message || "Payment batch could not be created");
    } finally {
      setSaving(false);
    }
  }

  async function action(id: string, actionName: "submit" | "approve" | "post") {
    try {
      const response = await fetch(`/api/finance/vendor-payments/batches/${id}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: actionName }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || `Batch ${actionName} failed`);

      toast.success(`Batch ${actionName} successful`);
      await load();
    } catch (e: any) {
      toast.error(e.message || `Batch ${actionName} failed`);
    }
  }

  const toggleBill = (id: string, checked: boolean) => {
    setSelected((current) =>
      checked ? (current.includes(id) ? current : [...current, id]) : current.filter((x) => x !== id)
    );
  };

  return (
    <div className="p-6 space-y-6">
      <Link
        href="/dashboard/vendor-payments"
        className="inline-flex gap-2 items-center text-sm text-blue-600 dark:text-blue-400"
      >
        <ArrowLeft size={16} /> Back to Vendor Payments
      </Link>

      <div>
        <h1 className="text-2xl font-bold flex gap-2 items-center text-gray-900 dark:text-white">
          <Layers3 /> Payment Batches
        </h1>
        <p className="text-sm text-gray-500 dark:text-gray-400">
          Build one approval-controlled batch from multiple outstanding vendor bills.
        </p>
      </div>

      {hasPermission("VENDOR_PAYMENT_CREATE") && (
        <div className="bg-white dark:bg-gray-800 rounded-xl border dark:border-gray-700 p-5 space-y-4">
          <div className="grid md:grid-cols-3 gap-3">
            <select className="input" value={account} onChange={(e) => setAccount(e.target.value)}>
              <option value="">Payment account</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.account_name} ({a.currency})
                </option>
              ))}
            </select>

            <select className="input" value={paymentMethod} onChange={(e) => setPaymentMethod(e.target.value)}>
              <option value="">Payment method</option>
              {PAYMENT_METHODS.map((method) => (
                <option key={method} value={method}>
                  {method.replace("_", " ")}
                </option>
              ))}
            </select>

            <button
              onClick={create}
              disabled={saving || !selected.length}
              className="bg-blue-600 text-white rounded-lg px-4 py-2 hover:bg-blue-700 disabled:opacity-50 transition-colors"
            >
              {saving ? "Creating..." : `Create Payment Batch (${selected.length})`}
            </button>
          </div>

          <div className="max-h-72 overflow-auto border dark:border-gray-700 rounded-lg">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 dark:bg-gray-900 text-gray-500 dark:text-gray-400">
                  <th className="p-2"></th>
                  <th className="p-2 text-left">Bill</th>
                  <th className="p-2 text-left">Vendor</th>
                  <th className="p-2 text-right">Outstanding</th>
                  <th className="p-2">Due</th>
                </tr>
              </thead>
              <tbody>
                {bills.map((bill) => (
                  <tr
                    key={bill.id}
                    className="border-t dark:border-gray-700 text-gray-700 dark:text-gray-300"
                  >
                    <td className="p-2 text-center">
                      <input
                        type="checkbox"
                        checked={selected.includes(bill.id)}
                        onChange={(e) => toggleBill(bill.id, e.target.checked)}
                      />
                    </td>
                    <td className="p-2">{bill.bill_number}</td>
                    <td className="p-2">{Array.isArray(bill.vendors) ? bill.vendors[0]?.name || bill.vendor_id : bill.vendors?.name || bill.vendor_id}</td>
                    <td className="p-2 text-right">
                      {Number(bill.outstanding_amount).toLocaleString()} {bill.currency || "PKR"}
                    </td>
                    <td className="p-2 text-center">{bill.due_date || "-"}</td>
                  </tr>
                ))}
                {!bills.length && (
                  <tr>
                    <td colSpan={5} className="p-8 text-center text-gray-500">
                      No outstanding vendor bills available for batching.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="bg-white dark:bg-gray-800 rounded-xl border dark:border-gray-700 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 dark:bg-gray-900">
            <tr>
              <th className="p-3 text-left">Batch</th>
              <th className="p-3">Payments</th>
              <th className="p-3 text-right">Total</th>
              <th className="p-3">Status</th>
              <th className="p-3"></th>
            </tr>
          </thead>
          <tbody className="divide-y dark:divide-gray-700">
            {loading ? (
              <tr>
                <td colSpan={5} className="p-8 text-center">
                  <Loader2 className="animate-spin mx-auto text-gray-400" />
                </td>
              </tr>
            ) : (
              batches.map((batch) => (
                <tr
                  key={batch.id}
                  className="border-t dark:border-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700/30"
                >
                  <td className="p-3 font-mono">{batch.batch_number}</td>
                  <td className="p-3 text-center">{batch.payment_count}</td>
                  <td className="p-3 text-right">{Number(batch.total_amount).toLocaleString()}</td>
                  <td className="p-3 text-center">{batch.status}</td>
                  <td className="p-3 text-right space-x-3">
                    {batch.status === "DRAFT" && hasPermission("VENDOR_PAYMENT_UPDATE") && (
                      <button
                        onClick={() => action(batch.id, "submit")}
                        className="text-blue-600 dark:text-blue-400 inline-flex gap-1"
                      >
                        <Send size={14} /> Submit
                      </button>
                    )}

                    {batch.status === "SUBMITTED" && hasPermission("VENDOR_PAYMENT_APPROVE") && (
                      <button
                        onClick={() => action(batch.id, "approve")}
                        className="text-green-600 dark:text-green-400 inline-flex gap-1"
                      >
                        <CheckCircle size={14} /> Approve
                      </button>
                    )}

                    {batch.status === "APPROVED" && hasPermission("VENDOR_PAYMENT_POST") && (
                      <button
                        onClick={() => action(batch.id, "post")}
                        className="text-purple-600 dark:text-purple-400 inline-flex gap-1"
                      >
                        <Upload size={14} /> Post
                      </button>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <style jsx>{`
        .input {
          width: 100%;
          padding: 0.65rem 0.8rem;
          border: 1px solid #d1d5db;
          border-radius: 0.5rem;
          background: transparent;
          color: inherit;
        }
        :global(.dark) .input {
          border-color: #4b5563;
        }
        .input option {
          color: #111827;
          background: #fff;
        }
        :global(.dark) .input option {
          color: #f3f4f6;
          background: #1f2937;
        }
      `}</style>
    </div>
  );
}
