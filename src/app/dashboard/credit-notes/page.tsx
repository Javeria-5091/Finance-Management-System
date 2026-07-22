"use client";

import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/context/AuthContext";
import {
  Plus,
  FileText,
  AlertCircle,
  CheckCircle,
  Eye,
  RotateCcw,
  X,
  Loader2,
} from "lucide-react";

// ==========================================
// TYPES
// ==========================================
interface InvoiceOption {
  id: string;
  invoice_number: string | null;
  client_name: string | null;
  total_amount: number;
  outstanding_amount: number;
  currency: string;
}

interface CreditNoteRow {
  id: string;
  credit_note_number: string | null;
  invoice_id: string;
  reason: string;
  amount: number;
  currency: string | null;
  exchange_rate: number | null;
  base_amount: number | null;
  status: string;
  created_at: string;
  created_by: string | null;
  invoices: {
    invoice_number: string | null;
    client_name: string | null;
  } | null;
}

interface FormData {
  invoice_id: string;
  reason: string;
  amount: string;
}

// ==========================================
// HELPERS
// ==========================================
function formatCurrency(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: currency || "PKR",
      minimumFractionDigits: 0,
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    return `${currency || "PKR"} ${amount.toLocaleString()}`;
  }
}

function formatNumber(num: number): string {
  return num.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

const STATUS_STYLES: Record<string, string> = {
  DRAFT: "bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300",
  APPROVED: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400",
  POSTED: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400",
  REVERSED: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400",
};

function getStatusBadge(status: string): string {
  return STATUS_STYLES[status] || STATUS_STYLES.DRAFT;
}

// ==========================================
// MAIN COMPONENT
// ==========================================
export default function CreditNotesPage() {
  const { user } = useAuth();

  // Data States
  const [creditNotes, setCreditNotes] = useState<CreditNoteRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);

  // Modal States
  const [showModal, setShowModal] = useState(false);
  const [saving, setSaving] = useState(false);
  const [viewingNote, setViewingNote] = useState<CreditNoteRow | null>(null);

  // Invoice Dropdown States
  const [invoices, setInvoices] = useState<InvoiceOption[]>([]);
  const [invoicesLoading, setInvoicesLoading] = useState(false);

  // Form State
  const [form, setForm] = useState<FormData>({
    invoice_id: "",
    reason: "",
    amount: "",
  });

  // Form Error State
  const [formError, setFormError] = useState<string | null>(null);

  // ==========================================
  // DERIVED STATE
  // ==========================================
  const selectedInvoice = invoices.find((inv) => inv.id === form.invoice_id) ?? null;

  const maxAllowedAmount = selectedInvoice
    ? Math.min(
        parseFloat(String(selectedInvoice.outstanding_amount)),
        parseFloat(String(selectedInvoice.total_amount))
      )
    : 0;

  const isFormValid =
    form.invoice_id !== "" &&
    form.reason.trim().length > 0 &&
    form.amount !== "" &&
    parseFloat(form.amount) > 0 &&
    parseFloat(form.amount) <= maxAllowedAmount &&
    !!user?.id;

  // ==========================================
  // DATA FETCHING
  // ==========================================
  const fetchCreditNotes = useCallback(async () => {
    setLoading(true);
    setFetchError(null);

    const { data, error } = await supabase
      .from("credit_notes")
      .select("*, invoices(invoice_number, client_name)")
      .order("created_at", { ascending: false });

    if (error) {
      console.error("Fetch credit notes error:", error);
      setFetchError(error.message);
      setCreditNotes([]);
    } else if (data) {
      setCreditNotes(data as CreditNoteRow[]);
    }

    setLoading(false);
  }, []);

  useEffect(() => {
    fetchCreditNotes();
    return () => {
      // Cleanup: prevent state updates on unmounted component
      setCreditNotes([]);
      setFetchError(null);
    };
  }, [fetchCreditNotes]);

  // ==========================================
  // MODAL HANDLERS
  // ==========================================
  const openCreateModal = async () => {
    setFormError(null);
    setForm({ invoice_id: "", reason: "", amount: "" });
    setInvoices([]);
    setShowModal(true);
    setInvoicesLoading(true);

    const { data: invData, error: invError } = await supabase
      .from("invoices")
      .select(
        "id, invoice_number, client_name, total_amount, outstanding_amount, currency"
      )
      .in("status", ["ISSUED", "PARTIALLY_PAID", "PAID"])
      .gt("total_amount", 0)
      .order("issue_date", { ascending: false });

    setInvoicesLoading(false);

    if (invError) {
      console.error("Fetch invoices error:", invError);
      setFormError("Failed to load invoices. Please try again.");
      return;
    }

    if (invData) {
      setInvoices(invData as InvoiceOption[]);
    }
  };

  const closeCreateModal = () => {
    if (saving) return; // Prevent closing while saving
    setShowModal(false);
    setFormError(null);
    setInvoices([]);
  };

  const handleSubmit = async () => {
    // Reset error
    setFormError(null);

    // Validations
    if (!user?.id) {
      setFormError("User not authenticated. Please log in and try again.");
      return;
    }

    if (!form.invoice_id) {
      setFormError("Please select an invoice.");
      return;
    }

    if (!form.reason.trim()) {
      setFormError("Please provide a reason for the credit note.");
      return;
    }

    const amountNum = parseFloat(form.amount);

    if (isNaN(amountNum) || amountNum <= 0) {
      setFormError("Amount must be greater than 0.");
      return;
    }

    if (!selectedInvoice) {
      setFormError("Selected invoice not found. Please re-select.");
      return;
    }

    if (amountNum > maxAllowedAmount) {
      setFormError(
        `Amount cannot exceed the outstanding balance of ${formatCurrency(maxAllowedAmount, selectedInvoice.currency)}.`
      );
      return;
    }

    // Confirmation before destructive action
    const confirmed = window.confirm(
      `Are you sure you want to issue a credit note of ${formatCurrency(amountNum, selectedInvoice.currency)} for ${selectedInvoice.invoice_number || "this invoice"}?\n\nThis will reduce the invoice receivable.`
    );

    if (!confirmed) return;

    setSaving(true);

    try {
      // 1. Generate CN number BEFORE insert to avoid race condition
      const timestamp = Date.now();
      const randomSuffix = Math.floor(Math.random() * 1000)
        .toString()
        .padStart(3, "0");
      const cnNumber = `CN-${String(timestamp).slice(-6)}${randomSuffix}`;

      const currency = selectedInvoice.currency || "PKR";
      const exchangeRate = 1; // TODO: fetch actual rate in multi-currency setup
      const baseAmount = amountNum * exchangeRate;

      // 2. Insert Credit Note with pre-generated number
      const { data: cn, error: cnError } = await supabase
        .from("credit_notes")
        .insert({
          credit_note_number: cnNumber,
          invoice_id: form.invoice_id,
          reason: form.reason.trim(),
          amount: amountNum,
          currency: currency,
          exchange_rate: exchangeRate,
          base_amount: baseAmount,
          status: "DRAFT",
          created_by: user.id,
        })
        .select("*, invoices(invoice_number, client_name)")
        .single();

      if (cnError) throw cnError;

      // 3. Success — close modal and refresh
      alert(`Credit Note ${cnNumber} created successfully!`);
      setShowModal(false);
      fetchCreditNotes();
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : "Unknown error occurred";
      console.error("Credit Note creation error:", error);
      setFormError(`Failed to save credit note: ${message}`);
    } finally {
      setSaving(false);
    }
  };

  // ==========================================
  // RENDER HELPERS
  // ==========================================
  const renderEmptyState = () => (
    <tr>
      <td colSpan={6} className="px-4 py-16 text-center">
        <FileText className="w-12 h-12 mx-auto mb-3 text-gray-300 dark:text-gray-600" />
        <p className="text-gray-400 dark:text-gray-500 font-medium">
          No credit notes created yet.
        </p>
        <p className="text-xs text-gray-400 dark:text-gray-600 mt-1">
          Click "New Credit Note" to create your first adjustment.
        </p>
      </td>
    </tr>
  );

  const renderLoadingState = () => (
    <tr>
      <td colSpan={6} className="px-4 py-16 text-center">
        <Loader2 className="w-6 h-6 mx-auto mb-2 text-blue-500 animate-spin" />
        <p className="text-gray-500 dark:text-gray-400 text-sm">
          Loading credit notes...
        </p>
      </td>
    </tr>
  );

  const renderErrorState = () => (
    <tr>
      <td colSpan={6} className="px-4 py-12 text-center">
        <AlertCircle className="w-10 h-10 mx-auto mb-2 text-red-400" />
        <p className="text-red-500 dark:text-red-400 font-medium text-sm">
          Failed to load credit notes
        </p>
        <p className="text-xs text-gray-400 mt-1">{fetchError}</p>
        <button
          onClick={fetchCreditNotes}
          className="mt-3 px-4 py-1.5 text-xs font-medium bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 rounded-lg hover:bg-red-100 dark:hover:bg-red-900/30 transition-colors"
        >
          Try Again
        </button>
      </td>
    </tr>
  );

  const renderTableRow = (cn: CreditNoteRow) => (
    <tr
      key={cn.id}
      className="hover:bg-gray-50 dark:hover:bg-gray-700/30 transition-colors"
    >
      <td className="px-4 py-3 font-mono text-xs text-gray-600 dark:text-gray-300">
        {cn.credit_note_number || "—"}
      </td>
      <td className="px-4 py-3">
        <div className="font-medium text-gray-900 dark:text-white text-sm">
          {cn.invoices?.invoice_number || "Unknown Invoice"}
        </div>
        <div className="text-xs text-gray-500 dark:text-gray-400">
          {cn.invoices?.client_name || "Unknown Client"}
        </div>
      </td>
      <td
        className="px-4 py-3 text-gray-600 dark:text-gray-300 max-w-[200px] truncate text-sm"
        title={cn.reason}
      >
        {cn.reason || "—"}
      </td>
      <td className="px-4 py-3 text-right font-semibold text-red-600 dark:text-red-400 text-sm">
        -{formatCurrency(cn.amount, cn.currency || "PKR")}
      </td>
      <td className="px-4 py-3 text-center">
        <span
          className={`inline-block px-2.5 py-1 rounded-full text-xs font-semibold ${getStatusBadge(cn.status)}`}
        >
          {cn.status}
        </span>
      </td>
      <td className="px-4 py-3 text-right">
        <button
          onClick={() => setViewingNote(cn)}
          className="p-1.5 text-gray-400 hover:text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-500/10 rounded-lg transition-colors"
          title="View Details"
        >
          <Eye size={15} />
        </button>
      </td>
    </tr>
  );

  // ==========================================
  // MAIN RENDER
  // ==========================================
  return (
    <div className="p-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">
            Credit Notes
          </h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
            Adjustments and refunds against issued invoices
          </p>
        </div>
        <button
          onClick={openCreateModal}
          className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-4 py-2.5 rounded-lg text-sm font-medium transition-colors shadow-sm"
        >
          <Plus size={16} /> New Credit Note
        </button>
      </div>

      {/* Table */}
      <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl overflow-hidden shadow-sm">
        <table className="w-full text-left text-sm">
          <thead className="bg-gray-50 dark:bg-gray-900/50 border-b border-gray-200 dark:border-gray-700">
            <tr>
              <th className="px-4 py-3 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase">
                CN Number
              </th>
              <th className="px-4 py-3 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase">
                Invoice
              </th>
              <th className="px-4 py-3 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase">
                Reason
              </th>
              <th className="px-4 py-3 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase text-right">
                Amount
              </th>
              <th className="px-4 py-3 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase text-center">
                Status
              </th>
              <th className="px-4 py-3 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase text-right">
                Actions
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
            {loading
              ? renderLoadingState()
              : fetchError
                ? renderErrorState()
                : creditNotes.length === 0
                  ? renderEmptyState()
                  : creditNotes.map(renderTableRow)}
          </tbody>
        </table>
      </div>

      {/* ==========================================
          CREATE CREDIT NOTE MODAL
          ========================================== */}
      {showModal && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
          <div
            className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-2xl w-full max-w-lg shadow-2xl"
            style={{ animation: "modalFadeIn 0.2s ease-out" }}
          >
            {/* Modal Header */}
            <div className="flex items-center justify-between p-5 border-b border-gray-200 dark:border-gray-700">
              <h3 className="text-lg font-bold text-gray-900 dark:text-white flex items-center gap-2">
                <RotateCcw size={20} className="text-red-500" />
                Issue Credit Note
              </h3>
              <button
                onClick={closeCreateModal}
                disabled={saving}
                className="p-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors disabled:opacity-50"
              >
                <X size={20} className="text-gray-500" />
              </button>
            </div>

            {/* Warning Banner */}
            <div className="mx-5 mt-4 p-3 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-700/50 rounded-lg">
              <p className="text-xs text-amber-700 dark:text-amber-400 flex items-start gap-2">
                <AlertCircle
                  size={14}
                  className="flex-shrink-0 mt-0.5"
                />
                <span>
                  <strong>Accounting Impact:</strong> Issuing a credit note
                  will reduce the invoice receivable and recognized revenue.
                  This cannot be undone easily once posted.
                </span>
              </p>
            </div>

            {/* Form Error */}
            {formError && (
              <div className="mx-5 mt-3 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-700/50 rounded-lg">
                <p className="text-xs text-red-600 dark:text-red-400 flex items-start gap-2">
                  <AlertCircle
                    size={14}
                    className="flex-shrink-0 mt-0.5"
                  />
                  {formError}
                </p>
              </div>
            )}

            {/* Form Body */}
            <div className="p-5 space-y-4">
              {/* Invoice Selector */}
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">
                  Select Invoice <span className="text-red-500">*</span>
                </label>
                {invoicesLoading ? (
                  <div className="flex items-center gap-2 px-4 py-2.5 border border-gray-300 dark:border-gray-600 rounded-lg bg-gray-50 dark:bg-gray-700/50">
                    <Loader2
                      size={14}
                      className="animate-spin text-gray-400"
                    />
                    <span className="text-sm text-gray-400">
                      Loading invoices...
                    </span>
                  </div>
                ) : (
                  <select
                    value={form.invoice_id}
                    onChange={(e) => {
                      setForm({
                        ...form,
                        invoice_id: e.target.value,
                        amount: "", // Reset amount when invoice changes
                      });
                      setFormError(null);
                    }}
                    disabled={saving}
                    className="w-full px-4 py-2.5 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none disabled:opacity-50"
                  >
                    <option value="">
                      -- Select an invoice to adjust --
                    </option>
                    {invoices.length === 0 ? (
                      <option disabled>
                        No valid invoices found
                      </option>
                    ) : (
                      invoices.map((inv) => (
                        <option key={inv.id} value={inv.id}>
                          {inv.invoice_number || "No Number"} —{" "}
                          {inv.client_name || "Unknown"} (Outstanding:{" "}
                          {formatNumber(inv.outstanding_amount)}{" "}
                          {inv.currency})
                        </option>
                      ))
                    )}
                  </select>
                )}
              </div>

              {/* Amount Input */}
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">
                  Credit Note Amount <span className="text-red-500">*</span>
                </label>
                <div className="relative">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-sm pointer-events-none">
                    {selectedInvoice?.currency || "PKR"}
                  </span>
                  <input
                    type="number"
                    step="0.01"
                    min="1"
                    max={selectedInvoice ? maxAllowedAmount : undefined}
                    value={form.amount}
                    onChange={(e) => {
                      setForm({ ...form, amount: e.target.value });
                      setFormError(null);
                    }}
                    disabled={saving || !selectedInvoice}
                    className="w-full pl-16 pr-4 py-2.5 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none disabled:opacity-50 disabled:cursor-not-allowed"
                    placeholder="0.00"
                  />
                </div>
                {selectedInvoice && (
                  <p className="text-xs text-gray-500 mt-1.5">
                    Invoice Total: {formatCurrency(selectedInvoice.total_amount, selectedInvoice.currency)}
                    {" · "}
                    Outstanding: {formatCurrency(selectedInvoice.outstanding_amount, selectedInvoice.currency)}
                    {" · "}
                    <span className="font-medium text-gray-700 dark:text-gray-300">
                      Max refundable: {formatCurrency(maxAllowedAmount, selectedInvoice.currency)}
                    </span>
                  </p>
                )}
                {form.amount &&
                  parseFloat(form.amount) > maxAllowedAmount &&
                  maxAllowedAmount > 0 && (
                    <p className="text-xs text-red-500 mt-1">
                      Amount exceeds maximum allowed refundable balance.
                    </p>
                  )}
              </div>

              {/* Reason Textarea */}
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">
                  Reason for Credit Note{" "}
                  <span className="text-red-500">*</span>
                </label>
                <textarea
                  value={form.reason}
                  onChange={(e) => {
                    setForm({ ...form, reason: e.target.value });
                    setFormError(null);
                  }}
                  disabled={saving}
                  rows={3}
                  className="w-full px-4 py-2.5 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none resize-none disabled:opacity-50"
                  placeholder="E.g., Discount offered, Service adjustment, Billing error..."
                />
              </div>
            </div>

            {/* Modal Footer */}
            <div className="flex justify-end gap-3 p-5 border-t border-gray-200 dark:border-gray-700 bg-gray-50/50 dark:bg-gray-900/30 rounded-b-2xl">
              <button
                onClick={closeCreateModal}
                disabled={saving}
                className="px-5 py-2.5 bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 dark:hover:bg-gray-600 text-gray-700 dark:text-gray-300 rounded-xl text-sm font-medium transition-colors disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={handleSubmit}
                disabled={!isFormValid || saving}
                className="px-5 py-2.5 bg-red-600 hover:bg-red-700 text-white rounded-xl text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
              >
                {saving ? (
                  <>
                    <Loader2 size={16} className="animate-spin" />
                    Creating...
                  </>
                ) : (
                  <>
                    <CheckCircle size={16} />
                    Issue Credit Note
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ==========================================
          VIEW DETAIL MODAL
          ========================================== */}
      {viewingNote && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
          <div
            className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-2xl w-full max-w-md shadow-2xl"
            style={{ animation: "modalFadeIn 0.2s ease-out" }}
          >
            <div className="flex items-center justify-between p-5 border-b border-gray-200 dark:border-gray-700">
              <h3 className="text-lg font-bold text-gray-900 dark:text-white">
                Credit Note Details
              </h3>
              <button
                onClick={() => setViewingNote(null)}
                className="p-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
              >
                <X size={20} className="text-gray-500" />
              </button>
            </div>

            <div className="p-5 space-y-4 text-sm">
              <div className="flex justify-between border-b dark:border-gray-700 pb-3">
                <span className="text-gray-500 dark:text-gray-400">
                  CN Number:
                </span>
                <span className="font-mono font-semibold text-gray-900 dark:text-white">
                  {viewingNote.credit_note_number || "—"}
                </span>
              </div>
              <div className="flex justify-between border-b dark:border-gray-700 pb-3">
                <span className="text-gray-500 dark:text-gray-400">
                  Linked Invoice:
                </span>
                <span className="font-medium text-blue-600 dark:text-blue-400">
                  {viewingNote.invoices?.invoice_number || "—"}
                </span>
              </div>
              <div className="flex justify-between border-b dark:border-gray-700 pb-3">
                <span className="text-gray-500 dark:text-gray-400">
                  Client:
                </span>
                <span className="text-gray-900 dark:text-white font-medium">
                  {viewingNote.invoices?.client_name || "—"}
                </span>
              </div>
              <div className="flex justify-between border-b dark:border-gray-700 pb-3">
                <span className="text-gray-500 dark:text-gray-400">
                  Amount:
                </span>
                <span className="font-bold text-red-600 dark:text-red-400">
                  -{formatCurrency(viewingNote.amount, viewingNote.currency || "PKR")}
                </span>
              </div>
              {viewingNote.base_amount !== null &&
                viewingNote.exchange_rate !== null &&
                viewingNote.exchange_rate !== 1 && (
                  <div className="flex justify-between border-b dark:border-gray-700 pb-3">
                    <span className="text-gray-500 dark:text-gray-400">
                      Base Amount (PKR):
                    </span>
                    <span className="text-gray-900 dark:text-white font-medium">
                      {formatCurrency(viewingNote.base_amount, "PKR")}
                      <span className="text-xs text-gray-400 ml-1">
                        @ {viewingNote.exchange_rate}
                      </span>
                    </span>
                  </div>
                )}
              <div className="flex justify-between border-b dark:border-gray-700 pb-3">
                <span className="text-gray-500 dark:text-gray-400">
                  Status:
                </span>
                <span
                  className={`inline-block px-2.5 py-1 rounded-full text-xs font-semibold ${getStatusBadge(viewingNote.status)}`}
                >
                  {viewingNote.status}
                </span>
              </div>
              <div className="flex justify-between border-b dark:border-gray-700 pb-3">
                <span className="text-gray-500 dark:text-gray-400">
                  Created:
                </span>
                <span className="text-gray-700 dark:text-gray-300">
                  {new Date(viewingNote.created_at).toLocaleString()}
                </span>
              </div>
              <div>
                <span className="text-gray-500 dark:text-gray-400 block mb-1.5">
                  Reason:
                </span>
                <p className="text-gray-900 dark:text-white bg-gray-50 dark:bg-gray-700/50 p-3 rounded-lg whitespace-pre-wrap">
                  {viewingNote.reason || "—"}
                </p>
              </div>
            </div>

            <div className="flex justify-end p-5 border-t border-gray-200 dark:border-gray-700">
              <button
                onClick={() => setViewingNote(null)}
                className="px-5 py-2.5 bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 dark:hover:bg-gray-600 text-gray-700 dark:text-gray-300 rounded-xl text-sm font-medium transition-colors"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ==========================================
          INLINE KEYFRAME STYLE (replaces missing animate-scale-in)
          ========================================== */}
      <style jsx global>{`
        @keyframes modalFadeIn {
          from {
            opacity: 0;
            transform: scale(0.95) translateY(10px);
          }
          to {
            opacity: 1;
            transform: scale(1) translateY(0);
          }
        }
      `}</style>
    </div>
  );
}