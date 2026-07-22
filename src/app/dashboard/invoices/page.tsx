"use client";
import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/context/AuthContext";
import { usePermissions } from "@/hooks/usePermissions";
import { 
  Plus, Pencil, Eye, Send, CheckCircle, XCircle, 
  AlertTriangle, ArrowUpCircle, FileText, RefreshCw, X 
} from "lucide-react";
import ReasonModal from "@/components/finance/ReasonModal";

// ==========================================
// STATUS STYLES & CONSTANTS
// ==========================================
const STATUS_CONFIG = {
  DRAFT: { color: 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300', label: 'Draft' },
  SUBMITTED: { color: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400', label: 'Submitted' },
  APPROVED: { color: 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-400', label: 'Approved' },
  ISSUED: { color: 'bg-cyan-100 text-cyan-700 dark:bg-cyan-900/30 dark:text-cyan-400', label: 'Issued' },
  PARTIALLY_PAID: { color: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400', label: 'Partially Paid' },
  PAID: { color: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400', label: 'Paid' },
  OVERDUE: { color: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400', label: 'Overdue' },
  VOID: { color: 'bg-gray-200 text-gray-600 dark:bg-gray-600 dark:text-gray-400 line-through', label: 'Void' },
};

type InvoiceStatus = keyof typeof STATUS_CONFIG;

export default function InvoicesPage() {
  const { user } = useAuth();
  const { hasPermission, isFinanceUser } = usePermissions();
  const [invoices, setInvoices] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [editingInvoice, setEditingInvoice] = useState<any>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [reasonModal, setReasonModal] = useState<{
    open: boolean; 
    title: string; 
    action: string; 
    recordId: string; 
    onConfirm: (reason: string) => void
  }>({ 
    open: false, 
    title: '', 
    action: '', 
    recordId: '', 
    onConfirm: () => {} 
  });

  // ✅ PERIOD CHECK STATE
  const [periodWarning, setPeriodWarning] = useState<string | null>(null);
  const [hasOpenPeriod, setHasOpenPeriod] = useState<boolean>(true);

  // Check for open period on mount
  useEffect(() => {
    const checkPeriod = async () => {
      const { data: periodId } = await supabase.rpc('get_current_open_period_id');
      if (!periodId) {
        setPeriodWarning("⚠️ No Open Accounting Period found for today. Please open Fiscal Calendar to create invoices.");
        setHasOpenPeriod(false);
      } else {
        setPeriodWarning(null);
        setHasOpenPeriod(true);
      }
    };
    checkPeriod();
  }, []);

  const fetchInvoices = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from("invoices")
      .select("*")
      .order("created_at", { ascending: false });
    
    if (data) setInvoices(data);
    if (error) console.error(error);
    setLoading(false);
  }, []);

  useEffect(() => { fetchInvoices(); }, [fetchInvoices]);

  // ==========================================
  // STATUS CHANGE HANDLER
  // ==========================================
  const handleStatusChange = async (invoiceId: string, newStatus: string, reason?: string) => {
    setSaving(invoiceId);
    
    const updateData: any = { status: newStatus };
    
    if (reason) updateData.rejection_reason = reason;
    if (reason && newStatus === 'VOID') updateData.void_reason = reason;
    if (newStatus === 'ISSUED') {
      updateData.issue_date = new Date().toISOString().split("T")[0];
      updateData.issued_by = user?.id;
      updateData.issued_at = new Date().toISOString();
    }

    try {
      const { error } = await supabase.from("invoices")
        .update(updateData)
        .eq("id", invoiceId);
      
      if (error) throw error;
      
      // ✅ FIX 1: Check reason exists before calling onConfirm
      if (reason && reasonModal.recordId === invoiceId) {
        reasonModal.onConfirm(reason);
      }
      
      fetchInvoices();
    } catch (error: any) {
      alert(`Error: ${error.message}`);
    } finally {
      setSaving(null);
    }
  };

  const handleDelete = async () => {
    if (!deleteId) return;
    setSaving(deleteId);
    try {
      const { error } = await supabase.from("invoices")
        .update({ status: 'VOID', void_reason: 'Deleted by user' })
        .eq("id", deleteId);
      if (error) throw error;
      setDeleteId(null);
      fetchInvoices();
    } catch (error: any) {
      alert(`Error: ${error.message}`);
    } finally {
      setSaving(null);
    }
  };

  const handleSubmit = async (formData: any) => {
    setSaving('submit'); // Temporary ID for saving state
    
    try {
      // ✅ FIX 2: Separate insert and update queries (can't chain .update() on .insert())
      let result;
      
      if (editingInvoice) {
        result = await supabase.from("invoices")
          .update({ ...formData })
          .eq("id", editingInvoice.id)
          .select()
          .single();
      } else {
        result = await supabase.from("invoices")
          .insert({
            ...formData,
            user_id: user?.id,
            status: 'DRAFT',
            outstanding_amount: formData.total_amount,
            base_outstanding_amount: formData.total_amount,
            created_by: user?.id,
          })
          .select()
          .single();
      }

      const { data, error } = result;
      if (error) throw error;
      
      setShowForm(false);
      setEditingInvoice(null);
      fetchInvoices();
      return data?.id;
    } catch (error: any) {
      alert(`Failed to save: ${error.message}`);
    } finally {
      setSaving(null);
    }
  };

  const formatCurrency = (amount: number, currency: string = 'PKR') => {
    return new Intl.NumberFormat("en-PK", { style: "currency", currency, minimumFractionDigits: 0 }).format(amount);
  };

  const formatDate = (dateStr: string) => {
    if (!dateStr) return '-';
    return new Date(dateStr).toLocaleDateString("en-PK", { day: "2-digit", month: "short", year: "numeric" });
  };

  const getStatusBadge = (status: string) => {
    const config = STATUS_CONFIG[status as InvoiceStatus];
    if (!config) return <span className="px-2 py-0.5 rounded text-xs font-medium bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-400">{status}</span>;
    return <span className={`px-2.5 py-1 rounded-full text-xs font-semibold ${config.color}`}>{config.label}</span>;
  };

  const canCreate = hasPermission('INCOME_CREATE');
  const canEdit = isFinanceUser;

  // ==========================================
  // UI RENDER
  // ==========================================
  return (
    <div className="p-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Invoices</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400">Manage client invoices and receivables</p>
        </div>
        {canCreate && (
          <button 
            onClick={() => { setEditingInvoice(null); setShowForm(true); }} 
            className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-4 py-2.5 rounded-lg text-sm font-medium shadow-sm transition-colors"
          >
            <Plus size={16} /> Create Invoice
          </button>
        )}
      </div>

      {/* ⚠️ NO OPEN PERIOD WARNING */}
      {periodWarning && (
        <div className="mb-4 p-3 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-700 rounded-lg flex items-center gap-3">
          <AlertTriangle size={18} className="text-amber-600 dark:text-amber-400 flex-shrink-0" />
          <div>
            <p className="text-sm font-semibold text-amber-800 dark:text-amber-300">{periodWarning}</p>
            <p className="text-xs text-amber-600 dark:text-amber-400 mt-0.5">Go to Accounting → Fiscal Calendar to open current month.</p>
          </div>
        </div>
      )}

      {/* Invoices Table */}
      <div className="bg-white dark:bg-gray-800 border dark:border-gray-700 rounded-xl overflow-hidden shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full text-sm text-left min-w-[800px]">
            <thead className="bg-gray-50 dark:bg-gray-900/50 border-b dark:border-gray-700 text-xs uppercase text-gray-500 dark:text-gray-400">
              <tr>
                <th className="p-3">Invoice #</th>
                <th className="p-3">Client</th>
                <th className="p-3 text-right">Total</th>
                <th className="p-3 text-right">Paid</th>
                <th className="p-3 text-right">Outstanding</th>
                <th className="p-3 text-center">Status</th>
                <th className="p-3">Due Date</th>
                <th className="p-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y dark:divide-gray-700">
              {loading ? (
                <tr><td colSpan={8} className="p-12 text-center text-gray-400">Loading...</td></tr>
              ) : invoices.length === 0 ? (
                <tr><td colSpan={8} className="p-12 text-center text-gray-400">No invoices yet. Click "Create Invoice" to start.</td></tr>
              ) : (
                invoices.map(inv => {
                  const isOwner = inv.user_id === user?.id;
                  const isDraft = inv.status === 'DRAFT';
                  const isVoid = inv.status === 'VOID';
                  
                  return (
                    <tr key={inv.id} className={`${isVoid ? 'opacity-50' : ''} hover:bg-gray-50 dark:hover:bg-gray-700/30 transition-colors`}>
                      <td className="p-3">
                        <span className="font-mono text-xs text-blue-600 dark:text-blue-400">{inv.invoice_number || 'N/A'}</span>
                      </td>
                      <td className="p-3 font-medium text-gray-900 dark:text-white">{inv.client_name || 'No Client'}</td>
                      <td className="p-3 text-right font-semibold text-gray-900 dark:text-white">{formatCurrency(inv.total_amount)}</td>
                      <td className="p-3 text-right text-green-600 dark:text-green-400">{formatCurrency(inv.amount_paid)}</td>
                      <td className="p-3 text-right text-red-600 dark:text-red-400 font-semibold">{formatCurrency(inv.outstanding_amount)}</td>
                      <td className="p-3 text-center">{getStatusBadge(inv.status)}</td>
                      <td className="p-3 text-gray-600 dark:text-gray-400 text-xs">{formatDate(inv.due_date)}</td>
                      <td className="p-3 text-right">
                        <div className="flex items-center justify-end gap-1">
                          {isDraft && canEdit && (
                            <button 
                              onClick={() => { setEditingInvoice(inv); setShowForm(true); }} 
                              title="Edit Invoice" 
                              className="p-1.5 text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-500/10 rounded-lg transition-colors"
                            >
                              <Pencil size={14} />
                            </button>
                          )}
                          {isDraft && (
                            <button 
                              onClick={() => setDeleteId(inv.id)} 
                              title="Delete (Void)" 
                              className="p-1.5 text-red-500 hover:bg-red-50 dark:hover:bg-red-500/10 rounded-lg transition-colors"
                            >
                              <XCircle size={14} />
                            </button>
                          )}
                          {!isDraft && !isVoid && (
                            <button 
                              onClick={() => handleStatusChange(inv.id, 'ISSUED', 'Issued to client')} 
                              title="Issue Invoice" 
                              className="p-1.5 text-cyan-600 hover:bg-cyan-50 dark:hover:bg-cyan-500/10 rounded-lg transition-colors"
                            >
                              <Send size={14} />
                            </button>
                          )}
                          {inv.status === 'ISSUED' && (
                            <button 
                              onClick={() => handleStatusChange(inv.id, 'PAID', 'Mark as paid')} 
                              title="Mark as Paid" 
                              className="p-1.5 text-green-600 hover:bg-green-50 dark:hover:bg-green-500/10 rounded-lg transition-colors"
                            >
                              <CheckCircle size={14} />
                            </button>
                          )}
                          {inv.status === 'OVERDUE' && (
                            <button 
                              onClick={() => handleStatusChange(inv.id, 'ISSUED', 'Re-activate invoice')} 
                              title="Mark as Issued (Not overdue)" 
                              className="p-1.5 text-amber-600 hover:bg-amber-50 dark:hover:bg-amber-500/10 rounded-lg transition-colors"
                            >
                              <RefreshCw size={14} />
                            </button>
                          )}
                          {saving === inv.id && <div className="w-4 h-4 border-2 border-blue-500 border-t-transparent border-b-transparent animate-spin rounded-full" />}
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Invoice Form Modal */}
      {showForm && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4 backdrop-blur-sm">
          <div className="bg-white dark:bg-gray-800 border dark:border-gray-700 rounded-2xl w-full max-w-2xl shadow-2xl max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between p-5 border-b dark:border-gray-700">
              <h3 className="text-lg font-bold text-gray-900 dark:text-white">
                {editingInvoice ? 'Edit Invoice' : 'Create Invoice'}
              </h3>
              <button 
                onClick={() => { setShowForm(false); setEditingInvoice(null); }} 
                className="p-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-500"
              >
                <X size={18} />
              </button>
            </div>

            <div className="p-5 space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Client Name *</label>
                  <input 
                    type="text" 
                    defaultValue={editingInvoice?.client_name || ''} 
                    placeholder="e.g., Tech Corp" 
                    className="w-full p-2.5 border dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Invoice Number</label>
                  <input 
                    type="text" 
                    defaultValue={editingInvoice?.invoice_number || ''} 
                    placeholder="AUTO-GENERATED" 
                    disabled
                    className="w-full p-2.5 border dark:border-gray-600 rounded-lg bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400 text-sm cursor-not-allowed"
                  />
                  <p className="text-[10px] text-gray-400 mt-1">Auto-generated when issued</p>
                </div>
              </div>

              <div className="grid grid-cols-3 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Amount *</label>
                  <input 
                    type="number" 
                    defaultValue={editingInvoice?.amount || ''} 
                    placeholder="0.00" 
                    min ="0"
                    className="w-full p-2.5 border dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Tax Amount</label>
                  <input 
                    type="number" 
                    defaultValue={editingInvoice?.tax_amount || '0'} 
                    placeholder="0.00" 
                    min ="0"
                    className="w-full p-2.5 border dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Due Date *</label>
                  <input 
                    type="date" 
                    defaultValue={editingInvoice?.due_date || ''} 
                    className="w-full p-2.5 border dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm"
                  />
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Description</label>
                <textarea 
                  defaultValue={editingInvoice?.notes || ''} 
                  placeholder="Invoice details, terms, conditions..." 
                  rows={3}
                  className="w-full p-2.5 border dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm resize-none"
                />
              </div>

              <div className="flex justify-end gap-3 pt-4 border-t dark:border-gray-700 bg-gray-50/50 dark:bg-gray-900/30 rounded-b-2xl">
                <button 
                  onClick={() => { setShowForm(false); setEditingInvoice(null); }} 
                  className="px-5 py-2.5 bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 dark:hover:bg-gray-600 text-gray-800 dark:text-white rounded-xl text-sm font-medium"
                >
                  Cancel
                </button>
                <button 
                  onClick={() => handleSubmit(editingInvoice ? 
                    { ...editingInvoice, total_amount: parseFloat(editingInvoice.amount || 0) + parseFloat(editingInvoice.tax_amount || 0) } : {
                      client_name: '', 
                      amount: 0, 
                      tax_amount: 0, 
                      outstanding_amount: 0, 
                      base_outstanding_amount: 0 
                    }
                  )} 
                  // ✅ FIX 3: Convert string | null to boolean using !!
                  disabled={!!saving}
                  className="px-5 py-2.5 bg-blue-600 hover:bg-blue-700 text-white rounded-xl text-sm font-medium disabled:opacity-50 flex items-center gap-2"
                >
                  {saving ? "Saving..." : "Save as Draft"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Delete Confirmation Modal */}
      {deleteId && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4 backdrop-blur-sm">
          <div className="bg-white dark:bg-gray-800 border dark:border-gray-700 rounded-2xl w-full max-w-sm shadow-2xl p-6">
            <div className="text-center">
              <div className="mx-auto w-12 h-12 bg-red-100 dark:bg-red-900/30 rounded-full flex items-center justify-center mb-4">
                <AlertTriangle size={24} className="text-red-600 dark:text-red-400" />
              </div>
              <h3 className="text-lg font-bold text-gray-900 dark:text-white mb-2">Delete Invoice?</h3>
              <p className="text-sm text-gray-500 dark:text-gray-400 mb-6">
                This will void the invoice. This action cannot be undone.
              </p>
              <div className="flex gap-3">
                <button 
                  onClick={() => setDeleteId(null)} 
                  className="flex-1 px-4 py-2.5 bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 dark:hover:bg-gray-600 text-gray-800 dark:text-white rounded-xl text-sm font-medium"
                >
                  Cancel
                </button>
                <button 
                  onClick={handleDelete} 
                  disabled={!!saving}
                  className="flex-1 px-4 py-2.5 bg-red-600 hover:bg-red-700 text-white rounded-xl text-sm font-medium disabled:opacity-50"
                >
                  {saving ? "Deleting..." : "Delete"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Reason Modal (For Void/Re-activate) */}
      <ReasonModal 
        open={reasonModal.open}
        title={reasonModal.title}
        onConfirm={reasonModal.onConfirm}
        onCancel={() => setReasonModal({ ...reasonModal, open: false, title: '', recordId: '', onConfirm: () => {} })}
      />
    </div>
  );
}