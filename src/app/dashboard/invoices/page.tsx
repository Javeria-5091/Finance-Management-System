"use client";
import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/context/AuthContext";
import { usePermissions } from "@/context/PermissionContext";
import { 
  Plus, Pencil, Eye, Send, CheckCircle, XCircle, 
  AlertTriangle, ArrowUpCircle, FileText, RefreshCw, X, ShieldCheck
} from "lucide-react";
import ReasonModal from "@/components/finance/ReasonModal";
import { callWorkflow } from "@/lib/workflow";
import toast from "react-hot-toast";

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
  const { user, profile } = useAuth();
  const { hasPermission, isFinanceUser, role } = usePermissions();
  const [invoices, setInvoices] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [editingInvoice, setEditingInvoice] = useState<any>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [formData, setFormData] = useState({
    client_name: '',
    amount: '',
    tax_amount: '0',
    currency: 'PKR',
    exchange_rate: '1',
    due_date: '',
    notes: '',
  });
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

  // PERIOD CHECK STATE
  const [periodWarning, setPeriodWarning] = useState<string | null>(null);
  const [hasOpenPeriod, setHasOpenPeriod] = useState<boolean>(true);

  useEffect(() => {
    const checkPeriod = async () => {
      const { data: periodId } = await supabase.rpc('get_current_open_period_id');
      if (!periodId) {
        setPeriodWarning("No Open Accounting Period found. Go to Accounting > Fiscal Calendar to open current month.");
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
    if (error) {
      console.error('Invoices fetch error:', error);
      toast.error(`Failed to load invoices: ${error.message}`);
    }
    setLoading(false);
  }, []);

  useEffect(() => { fetchInvoices(); }, [fetchInvoices]);

  // ==========================================
  // APPROVAL LIMITS
  // ==========================================

  // ==========================================
  // STATUS CHANGE HANDLER with MAKER-CHECKER
  // ==========================================
  const handleStatusChange = async (invoiceId: string, newStatus: string, reason?: string) => {
    setSaving(invoiceId);

    try {
      // Map to workflow action
      const actionMap: Record<string, string> = {
        SUBMITTED: 'submit', APPROVED: 'approve', ISSUED: 'issue', REJECTED: 'reject',
      };
      const action = actionMap[newStatus];

      if (action) {
        const result = await callWorkflow('invoice', invoiceId, action as any, reason);
        if (result.success) {
          toast.success(result.message || `Invoice ${newStatus} successfully`);
          fetchInvoices();
        } else {
          toast.error(result.error || 'Action failed');
        }
      } else {
        // VOID etc - direct update
        const { error } = await supabase.from("invoices").update({ status: newStatus, void_reason: reason }).eq("id", invoiceId);
        if (error) throw error;
        toast.success(`Invoice ${newStatus} successfully`);
        fetchInvoices();
      }

      if (reason && reasonModal.recordId === invoiceId) {
        reasonModal.onConfirm(reason);
      }
    } catch (error: any) {
      toast.error(`Error: ${error.message}`);
    } finally {
      setSaving(null);
    }
  };

  const handleDelete = async () => {
    if (!deleteId) return;
    // Only DRAFT invoices can be deleted
    const { data: inv } = await supabase.from("invoices").select("status").eq("id", deleteId).single();
    if (inv?.status !== 'DRAFT') {
      toast.error("Only DRAFT invoices can be deleted.");
      setDeleteId(null);
      return;
    }
    setSaving(deleteId);
    try {
      const { error } = await supabase.from("invoices")
        .update({ status: 'VOID', void_reason: 'Deleted by user' })
        .eq("id", deleteId);
      if (error) throw error;
      toast.success("Invoice voided");
      setDeleteId(null);
      fetchInvoices();
    } catch (error: any) {
      toast.error(`Error: ${error.message}`);
    } finally {
      setSaving(null);
    }
  };

  const handleSubmit = async (formData: any) => {
    setSaving('submit');
    
    try {
      let result;
      
      if (editingInvoice) {
        if (editingInvoice.status !== 'DRAFT') {
          toast.error("Only DRAFT invoices can be edited.");
          setSaving(null);
          return;
        }
        result = await supabase.from("invoices")
          .update({ ...formData })
          .eq("id", editingInvoice.id)
          .select()
          .single();
      } else {
        result = await supabase.from("invoices")
          .insert({
            ...formData,
            status: 'DRAFT',
            outstanding_amount: formData.total_amount,
            base_outstanding_amount: formData.total_amount,
          })
          .select()
          .single();
      }

      const { data, error } = result;
      if (error) throw error;
      
      toast.success(editingInvoice ? "Invoice updated" : "Invoice created as DRAFT");
      setShowForm(false);
      setEditingInvoice(null);
      fetchInvoices();
      return data?.id;
    } catch (error: any) {
      toast.error(`Failed to save: ${error.message}`);
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

  const canCreate = hasPermission('INVOICE_CREATE');

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
            onClick={() => { setEditingInvoice(null); setFormData({ client_name: '', amount: '', tax_amount: '0', currency: 'PKR', exchange_rate: '1', due_date: '', notes: '' }); setShowForm(true); }} 
            className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-4 py-2.5 rounded-lg text-sm font-medium shadow-sm transition-colors"
          >
            <Plus size={16} /> Create Invoice
          </button>
        )}
      </div>

      {/* Period Warning */}
      {periodWarning && (
        <div className="mb-4 p-3 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-700 rounded-lg flex items-center gap-3">
          <AlertTriangle size={18} className="text-amber-600 dark:text-amber-400 flex-shrink-0" />
          <p className="text-sm font-semibold text-amber-800 dark:text-amber-300">{periodWarning}</p>
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
                <tr><td colSpan={8} className="p-12 text-center text-gray-400">No invoices yet.</td></tr>
              ) : (
                invoices.map(inv => {
                  const isCreator = (inv.created_by || inv.user_id) === user?.id;
                  const isDraft = inv.status === 'DRAFT';
                  const isVoid = inv.status === 'VOID';
                  
                  return (
                    <tr key={inv.id} className={`${isVoid ? 'opacity-50' : ''} hover:bg-gray-50 dark:hover:bg-gray-700/30 transition-colors`}>
                      <td className="p-3">
                        <span className="font-mono text-xs text-blue-600 dark:text-blue-400">{inv.invoice_number || 'N/A'}</span>
                      </td>
                      <td className="p-3 font-medium text-gray-900 dark:text-white">{inv.client_name || 'No Client'}</td>
                      <td className="p-3 text-right font-semibold text-gray-900 dark:text-white">{formatCurrency(inv.total_amount)}</td>
                      <td className="p-3 text-right text-green-600 dark:text-green-400">{formatCurrency(inv.amount_paid || 0)}</td>
                      <td className="p-3 text-right text-red-600 dark:text-red-400 font-semibold">{formatCurrency(inv.outstanding_amount || 0)}</td>
                      <td className="p-3 text-center">{getStatusBadge(inv.status)}</td>
                      <td className="p-3 text-gray-600 dark:text-gray-400 text-xs">{formatDate(inv.due_date)}</td>
                      <td className="p-3 text-right">
                        <div className="flex items-center justify-end gap-1">
                          {/* DRAFT actions */}
                          {isDraft && isCreator && hasPermission('INVOICE_UPDATE') && (
                            <button 
                              onClick={() => { setEditingInvoice(inv); setFormData({ client_name: inv.client_name || '', amount: String(inv.amount || ''), tax_amount: String(inv.tax_amount || '0'), currency: inv.currency || 'PKR', exchange_rate: String(inv.exchange_rate || '1'), due_date: inv.due_date || '', notes: inv.notes || '' }); setShowForm(true); }} 
                              title="Edit" 
                              className="p-1.5 text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-500/10 rounded-lg transition-colors"
                            >
                              <Pencil size={14} />
                            </button>
                          )}
                          {isDraft && isCreator && hasPermission('INVOICE_DELETE') && (
                            <button 
                              onClick={() => setDeleteId(inv.id)} 
                              title="Void" 
                              className="p-1.5 text-red-500 hover:bg-red-50 dark:hover:bg-red-500/10 rounded-lg transition-colors"
                            >
                              <XCircle size={14} />
                            </button>
                          )}
                          {isDraft && hasPermission('INVOICE_UPDATE') && (
                            <button 
                              onClick={() => handleStatusChange(inv.id, 'SUBMITTED')} 
                              title="Submit for Approval" 
                              className="p-1.5 text-blue-500 hover:bg-blue-50 dark:hover:bg-blue-500/10 rounded-lg transition-colors"
                            >
                              <Send size={14} />
                            </button>
                          )}
                          {/* SUBMITTED: approve/reject (not creator) */}
                          {inv.status === 'SUBMITTED' && !isCreator && hasPermission('APPROVE_INVOICE') && (
                            <button 
                              onClick={() => handleStatusChange(inv.id, 'APPROVED')} 
                              title="Approve" 
                              className="p-1.5 text-indigo-600 hover:bg-indigo-50 dark:hover:bg-indigo-500/10 rounded-lg transition-colors"
                            >
                              <ShieldCheck size={14} />
                            </button>
                          )}
                          {inv.status === 'SUBMITTED' && !isCreator && hasPermission('INVOICE_UPDATE') && (
                            <button 
                              onClick={() => {
                                setReasonModal({
                                  open: true, title: 'Reject Invoice', action: 'REJECTED', recordId: inv.id,
                                  onConfirm: (r) => handleStatusChange(inv.id, 'REJECTED', r),
                                });
                              }} 
                              title="Reject" 
                              className="p-1.5 text-red-500 hover:bg-red-50 dark:hover:bg-red-500/10 rounded-lg transition-colors"
                            >
                              <XCircle size={14} />
                            </button>
                          )}
                          {/* APPROVED: issue */}
                          {inv.status === 'APPROVED' && hasPermission('INVOICE_UPDATE') && (
                            <button 
                              onClick={() => handleStatusChange(inv.id, 'ISSUED', 'Issued to client')} 
                              title="Issue Invoice" 
                              className="p-1.5 text-cyan-600 hover:bg-cyan-50 dark:hover:bg-cyan-500/10 rounded-lg transition-colors"
                            >
                              <Send size={14} />
                            </button>
                          )}
                          {/* ISSUED → mark paid (via payment receipt, not direct) */}
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
                    value={formData.client_name}
                    onChange={(e) => setFormData({ ...formData, client_name: e.target.value })}
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
                </div>
              </div>

              <div className="grid grid-cols-3 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Amount *</label>
                  <input 
                    type="number" 
                    value={formData.amount}
                    onChange={(e) => setFormData({ ...formData, amount: e.target.value })}
                    placeholder="0.00" 
                    min="0"
                    className="w-full p-2.5 border dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Tax Amount</label>
                  <input 
                    type="number" 
                    value={formData.tax_amount}
                    onChange={(e) => setFormData({ ...formData, tax_amount: e.target.value })}
                    placeholder="0.00" 
                    min="0"
                    className="w-full p-2.5 border dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Currency *</label>
                  <input
                    type="text"
                    maxLength={3}
                    value={formData.currency}
                    onChange={(e) => setFormData({ ...formData, currency: e.target.value.toUpperCase() })}
                    placeholder="PKR"
                    className="w-full p-2.5 border dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Exchange Rate *</label>
                  <input
                    type="number"
                    min="0.000001"
                    step="0.000001"
                    value={formData.exchange_rate}
                    onChange={(e) => setFormData({ ...formData, exchange_rate: e.target.value })}
                    className="w-full p-2.5 border dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Due Date *</label>
                  <input 
                    type="date" 
                    value={formData.due_date}
                    onChange={(e) => setFormData({ ...formData, due_date: e.target.value })}
                    className="w-full p-2.5 border dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm"
                  />
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Description</label>
                <textarea 
                  value={formData.notes}
                  onChange={(e) => setFormData({ ...formData, notes: e.target.value })}
                  placeholder="Invoice details..." 
                  rows={3}
                  className="w-full p-2.5 border dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm resize-none"
                />
              </div>

              <div className="flex justify-end gap-3 pt-4 border-t dark:border-gray-700">
                <button 
                  onClick={() => { setShowForm(false); setEditingInvoice(null); }} 
                  className="px-5 py-2.5 bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 dark:hover:bg-gray-600 text-gray-800 dark:text-white rounded-xl text-sm font-medium"
                >
                  Cancel
                </button>
                <button 
                  onClick={() => {
                    // Validate form
                    if (!formData.client_name.trim()) { toast.error('Client name is required'); return; }
                    if (!formData.amount || parseFloat(formData.amount) <= 0) { toast.error('Valid amount is required'); return; }
                    if (!formData.due_date) { toast.error('Due date is required'); return; }
                    
                    const amount = parseFloat(formData.amount) || 0;
                    const taxAmount = parseFloat(formData.tax_amount) || 0;
                    const exchangeRate = parseFloat(formData.exchange_rate) || 0;
                    if (!/^[A-Z]{3}$/.test(formData.currency)) { toast.error('Currency must be a 3-letter ISO code'); return; }
                    if (exchangeRate <= 0 || (formData.currency === 'PKR' && Math.abs(exchangeRate - 1) > 0.000001)) { toast.error('Invalid exchange rate'); return; }
                    const totalAmount = amount + taxAmount;
                    const baseSubtotal = amount * exchangeRate;
                    const baseTaxAmount = taxAmount * exchangeRate;
                    const baseTotalAmount = totalAmount * exchangeRate;
                    
                    handleSubmit(editingInvoice ? 
                      { ...editingInvoice, client_name: formData.client_name, amount, subtotal: amount, tax_amount: taxAmount, currency: formData.currency, exchange_rate: exchangeRate, base_subtotal: baseSubtotal, base_tax_amount: baseTaxAmount, base_total_amount: baseTotalAmount, base_outstanding_amount: baseTotalAmount, due_date: formData.due_date, notes: formData.notes, total_amount: totalAmount } : {
                      client_name: formData.client_name,
                      amount,
                      subtotal: amount,
                      tax_amount: taxAmount,
                      currency: formData.currency,
                      exchange_rate: exchangeRate,
                      base_subtotal: baseSubtotal,
                      base_tax_amount: baseTaxAmount,
                      base_total_amount: baseTotalAmount,
                      total_amount: totalAmount,
                      due_date: formData.due_date,
                      notes: formData.notes,
                      outstanding_amount: totalAmount,
                      base_outstanding_amount: baseTotalAmount,
                      organization_id: profile?.organization_id,
                    }
                  );
                  }} 
                  disabled={!!saving}
                  className="px-5 py-2.5 bg-blue-600 hover:bg-blue-700 text-white rounded-xl text-sm font-medium disabled:opacity-50"
                >
                  {saving ? "Saving..." : "Save as Draft"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Delete Confirmation */}
      {deleteId && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4 backdrop-blur-sm">
          <div className="bg-white dark:bg-gray-800 border dark:border-gray-700 rounded-2xl w-full max-w-sm shadow-2xl p-6">
            <div className="text-center">
              <AlertTriangle size={24} className="text-red-600 dark:text-red-400 mx-auto mb-3" />
              <h3 className="text-lg font-bold text-gray-900 dark:text-white mb-2">Void DRAFT Invoice?</h3>
              <p className="text-sm text-gray-500 dark:text-gray-400 mb-6">This cannot be undone.</p>
              <div className="flex gap-3">
                <button onClick={() => setDeleteId(null)} className="flex-1 px-4 py-2.5 bg-gray-200 dark:bg-gray-700 rounded-xl text-sm font-medium">Cancel</button>
                <button onClick={handleDelete} disabled={!!saving} className="flex-1 px-4 py-2.5 bg-red-600 text-white rounded-xl text-sm font-medium disabled:opacity-50">Void</button>
              </div>
            </div>
          </div>
        </div>
      )}

      <ReasonModal 
        open={reasonModal.open}
        title={reasonModal.title}
        onConfirm={reasonModal.onConfirm}
        onCancel={() => setReasonModal({ ...reasonModal, open: false, title: '', recordId: '', onConfirm: () => {} })}
      />
    </div>
  );
}