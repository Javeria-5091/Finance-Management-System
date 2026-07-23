"use client";
import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/context/AuthContext";
import { usePermissions } from "@/hooks/usePermissions";
import { FileText, Plus, Eye, X, Loader2 } from "lucide-react";
import LineItemsEditor from "@/components/finance/LineItemsEditor";
import StatusActions from "@/components/finance/StatusActions";
import ReasonModal from "@/components/finance/ReasonModal";

// ✅ FIX #4: Lowercase keys matching DB enum values
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

// ✅ FIX #5: Removed non-existent base_* columns
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
  total_amount: number;
  amount_paid: number;
  outstanding_amount: number;
  status: string;
  description: string | null;
  created_by: string;
  created_at: string;
  // Joined data
  vendors?: { vendor_name: string; name?: string } | null;
}

interface PostableAccount {
  id: string;
  code: string;
  name: string;
  normal_balance: string;
  account_type: string;
  posting_allowed: boolean;
}

// ✅ FIX: Finance schema reference at top
const db = supabase.schema("finance");

export default function VendorBillsPage() {
  const { user } = useAuth();
  const { hasPermission, isLoading: permLoading } = usePermissions();
  const [bills, setBills] = useState<VendorBill[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editingBill, setEditingBill] = useState<VendorBill | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Form state
  const [vendors, setVendors] = useState<any[]>([]);
  const [expenseAccounts, setExpenseAccounts] = useState<PostableAccount[]>([]);
  const [projects, setProjects] = useState<any[]>([]);
  const [lines, setLines] = useState<any[]>([]);
  const [form, setForm] = useState({
    vendor_id: "",
    project_id: "",
    currency: "PKR",
    exchange_rate: 1,
    description: "",
    due_date: "",
    bill_date: new Date().toISOString().split("T")[0],
  });

  // Reason Modal State
  const [reasonState, setReasonState] = useState({
    open: false,
    title: "",
    action: "",
    id: "",
  });

  // ✅ FIX #1: finance schema + proper join
  const fetchBills = useCallback(async () => {
    setLoading(true);
    const { data, error } = await db
      .from("vendor_bills")
      .select(`*, vendors(name)`)
      .order("bill_date", { ascending: false });

    if (error) {
      console.error("Failed to fetch bills:", error.message);
    }
    if (data) setBills(data as VendorBill[]);
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchBills();
  }, [fetchBills]);

  const openCreateModal = async () => {
    setEditingBill(null);
    setLines([
      {
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
      },
    ]);
    setForm({
      vendor_id: "",
      project_id: "",
      currency: "PKR",
      exchange_rate: 1,
      description: "",
      due_date: "",
      bill_date: new Date().toISOString().split("T")[0],
    });

    // ✅ FIX #2 & #11: finance schema + status filter
   const { data: vData } = await db
  .from("vendors")
  .select("*")
  .eq("is_active", true)
  .order("name");
    if (vData) setVendors(vData);

    const { data: projData } = await supabase
  .from("projects")
  .select("id, name, status")
  .neq("status", "cancelled")
  .order("name");
if (projData) setProjects(projData);

    // ✅ FIX #3: Use chart_of_accounts instead of non-existent postable_accounts
    const { data: accData } = await db
      .from("chart_of_accounts")
      .select("id, code, name, normal_balance, account_type, posting_allowed")
      .eq("posting_allowed", true)
      .in("account_type", [
        "OPERATING_EXPENSE",
        "COST_OF_SALES",
        "OTHER_EXPENSE",
      ])
      .order("code");
    if (accData) setExpenseAccounts(accData as PostableAccount[]);

    setShowForm(true);
  };

const openEditModal = async (bill: VendorBill) => {
    setEditingBill(bill);
    setForm({
      vendor_id: bill.vendor_id,
      project_id: bill.project_id || "",
      currency: bill.currency || "PKR",
      exchange_rate: bill.exchange_rate || 1,
      description: bill.description || "",
      due_date: bill.due_date || "",
      bill_date: bill.bill_date || new Date().toISOString().split("T")[0],
    });

    // Fetch existing line items
    const { data: lineData } = await db
      .from("vendor_bill_lines")
      .select("*")
      .eq("vendor_bill_id", bill.id)
      .order("line_number");

    if (lineData && lineData.length > 0) {
      setLines(
        lineData.map((l: any) => ({
          id: l.id,
          account_id: l.account_id,
          description: l.description,
          quantity: l.quantity,
          unit_price: l.unit_price,
          tax_rate: l.tax_rate,
          withholding_rate: l.withholding_rate,
          tax_amount: l.tax_amount,
          withholding_amount: l.withholding_amount,
          line_total: l.line_total,
          project_id: l.project_id,
        }))
      );
    } else {
      setLines([]);
    }

    // ✅✅✅ YEH ADD KARO — Edit pe dropdowns fill honge
    const { data: vData } = await db
      .from("vendors")
      .select("*")
      .eq("is_active", true)
      .order("name");
    if (vData) setVendors(vData);

    const { data: projData } = await supabase
      .from("projects")
      .select("id, name, status")
      .neq("status", "cancelled")
      .order("name");
    if (projData) setProjects(projData);

    const { data: accData } = await db
      .from("chart_of_accounts")
      .select("id, code, name, normal_balance, account_type, posting_allowed")
      .eq("posting_allowed", true)
      .in("account_type", ["OPERATING_EXPENSE", "COST_OF_SALES", "OTHER_EXPENSE"])
      .order("code");
    if (accData) setExpenseAccounts(accData as PostableAccount[]);

    setShowForm(true);
  };

  const handleLineChange = useCallback((newLines: any[]) => {
  setLines(prev => {
    if (JSON.stringify(prev) === JSON.stringify(newLines)) {
      return prev;
    }
    return newLines;
  });
}, []);

const handleSubmit = async () => {
    // ✅ Robust validations — pehle check, phir DB hit karo
    if (!form.vendor_id) {
      alert("Please select a vendor");
      return;
    }
    if (lines.length === 0) {
      alert("Add at least one line item");
      return;
    }

    // ✅ Check for invalid line data (NaN protection)
    const invalidLine = lines.find((l) => !l.account_id || isNaN(l.quantity * l.unit_price));
    if (invalidLine) {
      alert("Every line item must have an account and valid amount");
      return;
    }

    setSubmitting(true);

    try {
      const rate = form.exchange_rate || 1;
      
      // ✅ Safe calculation with NaN protection
      const subtotal = lines.reduce((sum, l) => sum + (Number(l.quantity) * Number(l.unit_price) || 0), 0);
      const taxTotal = lines.reduce((sum, l) => sum + (Number(l.tax_amount) || 0), 0);
      const whtTotal = lines.reduce((sum, l) => sum + (Number(l.withholding_amount) || 0), 0);
      const total = subtotal + taxTotal - whtTotal;

      const payload: any = {
        vendor_id: form.vendor_id,
        project_id: form.project_id || null,
        bill_date: form.bill_date,
        due_date: form.due_date || null,
        currency: form.currency,
        exchange_rate: rate,
        description: form.description || null,
        subtotal: subtotal,
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
        created_by: user?.id,
      };

      let billId = editingBill?.id;

      if (editingBill) {
        const { error } = await db
          .from("vendor_bills")
          .update(payload)
          .eq("id", editingBill.id);
        if (error) throw new Error(error.message);

        await db
          .from("vendor_bill_lines")
          .delete()
          .eq("vendor_bill_id", editingBill.id);
      } else {
        const { data: numData } = await db.rpc("get_next_number", {
          p_type: "VENDOR_BILL",
        });

        payload.bill_number = numData || `VB-${Date.now()}`;
        const { data, error } = await db
          .from("vendor_bills")
          .insert(payload)
          .select("id")
          .single();

        if (error) throw new Error(error.message);
        billId = data.id;
      }

      if (billId && lines.length > 0) {
        const linePayloads = lines.map((l, index) => ({
          vendor_bill_id: billId,
          line_number: index + 1,
          line_type: "item",
          description: l.description || "",
          account_id: l.account_id,
          quantity: Number(l.quantity) || 0,
          unit_price: Number(l.unit_price) || 0,
          amount_original: (Number(l.quantity) * Number(l.unit_price)) || 0,
          tax_rate: Number(l.tax_rate) || 0,
          tax_amount_original: Number(l.tax_amount) || 0,
          withholding_rate: Number(l.withholding_rate) || 0,
          withholding_amount_original: Number(l.withholding_amount) || 0,
          line_total: Number(l.line_total) || 0,
          project_id: l.project_id || null,
        }));

        const { error: lineError } = await db
          .from("vendor_bill_lines")
          .insert(linePayloads);

        if (lineError) throw new Error("Line items failed: " + lineError.message);
      }

      setShowForm(false);
      setEditingBill(null);
      fetchBills();
    } catch (err: any) {
      alert("Error: " + err.message);
    } finally {
      setSubmitting(false);
    }
  };

  // ✅ FIX #6: Lowercase status values
  const processAction = async (
    billId: string,
    action: string,
    reason: string
  ) => {
    const updates: any = {};

    if (action === "delete" || action === "cancel") {
      updates.status = "CANCELLED";
      updates.cancellation_reason = reason;
      updates.cancelled_by = user?.id;
      updates.cancelled_at = new Date().toISOString();
    } else if (action === "reject") {
      updates.status = "rejected";
      updates.rejection_reason = reason;
      updates.rejected_by = user?.id;
      updates.rejected_at = new Date().toISOString();
    } else {
      // submit, verify, approve, post — use lowercase
      updates.status = action.toLowerCase();
      if (reason) updates.rejection_reason = reason;

      // Set the appropriate user/timestamp fields
      const fieldMap: Record<string, string> = {
      submit: "SUBMITTED",
      verify: "VERIFIED",
      approve: "APPROVED",
      post: "POSTED",
      };
      const fieldPrefix = fieldMap[action.toLowerCase()];
      if (fieldPrefix) {
        updates[`${fieldPrefix}_by`] = user?.id;
        updates[`${fieldPrefix}_at`] = new Date().toISOString();
      }
    }

    const { error } = await db
      .from("vendor_bills")
      .update(updates)
      .eq("id", billId);

    if (error) alert("Action failed: " + error.message);
    else fetchBills();

    setReasonState({ open: false, title: "", action: "", id: "" });
  };

  const handleAction = (
    billId: string,
    action: string,
    needsReason?: boolean
  ) => {
    if (needsReason) {
      setReasonState({
        open: true,
        title: `Confirm ${action}`,
        action,
        id: billId,
      });
      return;
    }
    processAction(billId, action, "");
  };

  const formatCurrency = (amount: number) =>
    new Intl.NumberFormat("en-PK", {
      style: "currency",
      currency: "PKR",
      minimumFractionDigits: 0,
    }).format(amount || 0);

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
            <FileText className="w-7 h-7 text-blue-600" /> Vendor Bills
          </h1>
          <p className="text-sm text-gray-500 dark:text-gray-400">
            Record supplier expenses with line item breakdown and tax
          </p>
        </div>
        {hasPermission("EXPENSE_CREATE") && (
          <button
            onClick={openCreateModal}
            className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-4 py-2.5 rounded-lg text-sm font-medium shadow-sm transition-colors"
          >
            <Plus size={16} /> Create Bill
          </button>
        )}
      </div>

      {/* Table */}
      <div className="bg-white dark:bg-gray-800 border dark:border-gray-700 rounded-xl overflow-hidden shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 dark:bg-gray-900/50 border-b dark:border-gray-700 text-left text-xs uppercase text-gray-500">
              <tr>
                <th className="px-4 py-3">Bill #</th>
                <th className="px-4 py-3 hidden md:table-cell">Vendor</th>
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
                  <td
                    colSpan={7}
                    className="px-4 py-12 text-center text-gray-400"
                  >
                    <Loader2 className="w-5 h-5 animate-spin mx-auto mb-2" />
                    Loading...
                  </td>
                </tr>
              ) : bills.length === 0 ? (
                <tr>
                  <td
                    colSpan={7}
                    className="px-4 py-16 text-center text-gray-400"
                  >
                    No vendor bills yet.
                  </td>
                </tr>
              ) : (
                bills.map((bill) => (
                  <tr
                    key={bill.id}
                    className="hover:bg-gray-50 dark:hover:bg-gray-700/30 transition-colors"
                  >
                    <td className="px-4 py-3 font-mono text-xs text-blue-600 dark:text-blue-400">
                      {bill.bill_number || "N/A"}
                    </td>
                    {/* ✅ FIX #9: Handle both vendor_name and name */}
                    <td className="px-4 py-3 text-gray-900 dark:text-white truncate max-w-[150px] hidden md:table-cell">
                      {bill.vendors?.vendor_name ||
                        bill.vendors?.name ||
                        "N/A"}
                    </td>
                    {/* ✅ FIX #5: Use total_amount instead of base_total_amount */}
                    <td className="px-4 py-3 text-right font-semibold">
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
                          STATUS_STYLES[bill.status] ||
                          "bg-gray-100 text-gray-700"
                        }`}
                      >
                        {bill.status?.replace(/_/g, " ").toLowerCase().replace(/\b\w/g, c => c.toUpperCase())}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex items-center justify-end gap-1">
                        <button
                          onClick={() => openEditModal(bill)}
                          className="p-1.5 text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-500/10 rounded transition-colors"
                          title="View/Edit"
                        >
                          <Eye size={15} />
                        </button>
                        {bill.status === "draft" && (
                          <StatusActions
                            record={bill}
                            module="expense"
                            onAction={handleAction}
                          />
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

      {/* ==================== CREATE / EDIT MODAL ==================== */}
      {showForm && (
        <div
          className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4"
          onClick={(e) => {
            if (e.target === e.currentTarget) setShowForm(false);
          }}
        >
          <div className="bg-white dark:bg-gray-800 border dark:border-gray-700 rounded-2xl w-full max-w-4xl shadow-2xl max-h-[90vh] flex flex-col">
            {/* Header */}
            <div className="p-5 border-b dark:border-gray-700 flex justify-between items-center shrink-0">
              <h2 className="text-lg font-bold text-gray-900 dark:text-white">
                {editingBill
                  ? `Edit Bill: ${editingBill.bill_number}`
                  : "Create Vendor Bill"}
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
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                    Vendor *
                  </label>
                  <select
                    value={form.vendor_id}
                    onChange={(e) =>
                      setForm({ ...form, vendor_id: e.target.value })
                    }
                    className="w-full px-4 py-2.5 border dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm outline-none focus:ring-2 focus:ring-blue-500"
                  >
                    <option value="">Select Vendor...</option>
                    {vendors.map((v) => (
                      <option key={v.id} value={v.id}>
                        {v.vendor_name || v.name}{" "}
                        {v.ntn ? `(${v.ntn})` : ""}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                    Bill Date
                  </label>
                  <input
                    type="date"
                    value={form.bill_date}
                    onChange={(e) =>
                      setForm({ ...form, bill_date: e.target.value })
                    }
                    className="w-full px-4 py-2.5 border dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                    Due Date
                  </label>
                  <input
                    type="date"
                    value={form.due_date}
                    onChange={(e) =>
                      setForm({ ...form, due_date: e.target.value })
                    }
                    className="w-full px-4 py-2.5 border dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                    Project (Optional)
                  </label>
                  <select
                    value={form.project_id}
                    onChange={(e) =>
                      setForm({ ...form, project_id: e.target.value })
                    }
                    className="w-full px-4 py-2.5 border dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm outline-none focus:ring-2 focus:ring-blue-500"
                  >
                    <option value="">No Project</option>
                    {projects.map((p) => (
                    <option key={p.id} value={p.id}>
                    {p.name}
                    </option>
                    ))}

                  </select>
                </div>
                <div className="md:col-span-2">
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                    Description
                  </label>
                  <textarea
                    value={form.description}
                    onChange={(e) =>
                      setForm({ ...form, description: e.target.value })
                    }
                    rows={2}
                    className="w-full px-4 py-2.5 border dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm resize-none outline-none focus:ring-2 focus:ring-blue-500"
                    placeholder="Bill description..."
                  />
                </div>
              </div>

              {/* Multi-Currency */}
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                    Currency
                  </label>
                  <select
                    value={form.currency}
                    onChange={(e) =>
                      setForm({ ...form, currency: e.target.value })
                    }
                    className="w-full px-4 py-2.5 border dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm outline-none focus:ring-2 focus:ring-blue-500"
                  >
                    <option value="PKR">PKR</option>
                    <option value="USD">USD</option>
                    <option value="EUR">EUR</option>
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                    Exchange Rate
                  </label>
                  <input
                    type="number"
                    value={form.exchange_rate}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        exchange_rate: parseFloat(e.target.value) || 1,
                      })
                    }
                    step="0.01"
                    className="w-full px-4 py-2.5 border dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
              </div>

              {/* Line Items Editor */}
              <div className="border dark:border-gray-700 rounded-lg overflow-hidden">
                <LineItemsEditor
                  accounts={expenseAccounts}
                  initialLines={lines}
                  currency={form.currency}
                  exchangeRate={form.exchange_rate}
                  onChange={handleLineChange}
                />
              </div>
            </div>

            {/* Footer */}
            <div className="flex justify-end gap-3 p-5 border-t dark:border-gray-700 shrink-0 bg-white dark:bg-gray-800 rounded-b-2xl">
              <button
                onClick={() => setShowForm(false)}
                disabled={submitting}
                className="px-5 py-2.5 bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 dark:hover:bg-gray-600 text-gray-800 dark:text-white rounded-xl text-sm font-medium transition-colors disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={handleSubmit}
                disabled={
                  !form.vendor_id ||
                  lines.length === 0 ||
                  submitting ||
                  lines.some((l) => !l.account_id)
                }
                className="px-5 py-2.5 bg-blue-600 hover:bg-blue-700 text-white rounded-xl text-sm font-medium transition-colors disabled:opacity-50 flex items-center gap-2"
              >
                {submitting && (
                  <Loader2 size={14} className="animate-spin" />
                )}
                {editingBill ? "Update Bill" : "Create Bill"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* REASON MODAL */}
      <ReasonModal
        open={reasonState.open}
        title={reasonState.title}
        description={`Are you sure you want to ${reasonState.action} this bill?`}
        onConfirm={(reason: string) =>
          processAction(reasonState.id, reasonState.action, reason)
        }
        onCancel={() =>
          setReasonState({ open: false, title: "", action: "", id: "" })
        }
      />
    </div>
  );
}