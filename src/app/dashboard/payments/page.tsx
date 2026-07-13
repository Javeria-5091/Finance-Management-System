"use client";
import { useEffect, useState, useCallback } from "react";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/context/AuthContext";
import { Payment, PaymentFormData, Invoice, Project } from "@/types";
import { Plus, Pencil, Trash2, X } from "lucide-react";

export default function PaymentsPage() {
  const { user, hasPermission, isAdmin } = useAuth();
  const [payments, setPayments] = useState<Payment[]>([]);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [formLoading, setFormLoading] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [editingData, setEditingData] = useState<Payment | null>(null);

  const canModify = hasPermission("can_create_invoice") || isAdmin;

  const fetchData = useCallback(async () => {
    if (!user) return;
    const [payRes, invRes, projRes] = await Promise.all([
      supabase.from("payments").select("*").order("payment_date", { ascending: false }),
      supabase.from("invoices").select("*"),
      supabase.from("projects").select("*")
    ]);
    if (payRes.data) setPayments(payRes.data);
    if (invRes.data) setInvoices(invRes.data);
    if (projRes.data) setProjects(projRes.data);
    setLoading(false);
  }, [user]);

  useEffect(() => { fetchData(); }, [fetchData]);

  async function handleSubmit(data: PaymentFormData) {
    setFormLoading(true);
    if (editingData) {
      const { error } = await supabase.from("payments").update(data).eq("id", editingData.id);
      if (error) alert(error.message);
    } else {
      const { error } = await supabase.from("payments").insert({ ...data, user_id: user?.id });
      if (error) alert(error.message);
    }
    setFormLoading(false);
    setShowForm(false); setEditingData(null); fetchData();
  }

  function getStatusColor(s: string) {
    if (s === "Paid") return "bg-green-100 text-green-700 dark:bg-green-500/20 dark:text-green-400";
    if (s === "Pending") return "bg-yellow-100 text-yellow-700 dark:bg-yellow-500/20 dark:text-yellow-400";
    if (s === "Overdue") return "bg-red-100 text-red-700 dark:bg-red-500/20 dark:text-red-400";
    return "bg-blue-100 text-blue-700 dark:bg-blue-500/20 dark:text-blue-400"; // Partial
  }

  function formatCurrency(n: number) {
    return new Intl.NumberFormat("en-PK", { style: "currency", currency: "PKR", minimumFractionDigits: 0 }).format(n);
  }

  return (
    <div>
      <div className="flex justify-between items-center mb-6">
        <div>
          <h2 className="text-2xl font-bold text-gray-900 dark:text-white">Payment Tracking</h2>
          <p className="text-gray-500 dark:text-gray-400 text-sm">Record incoming and outgoing payments</p>
        </div>
        {canModify && (
          <button onClick={() => { setEditingData(null); setShowForm(true); }} className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-4 py-2.5 rounded-lg font-medium shadow-sm hover:shadow-md">
            <Plus size={18} /> Record Payment
          </button>
        )}
      </div>

      <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl overflow-hidden shadow-sm dark:shadow-none">
        <table className="w-full text-left">
          <thead className="bg-gray-100 dark:bg-gray-900/70 border-b border-gray-200 dark:border-gray-700">
            <tr>
              <th className="px-4 py-3 text-xs font-semibold text-gray-600 dark:text-gray-400 uppercase tracking-wider">Date</th>
              <th className="px-4 py-3 text-xs font-semibold text-gray-600 dark:text-gray-400 uppercase tracking-wider">Project/Invoice</th>
              <th className="px-4 py-3 text-xs font-semibold text-gray-600 dark:text-gray-400 uppercase tracking-wider">Method</th>
              <th className="px-4 py-3 text-xs font-semibold text-gray-600 dark:text-gray-400 uppercase tracking-wider text-right">Amount</th>
              <th className="px-4 py-3 text-xs font-semibold text-gray-600 dark:text-gray-400 uppercase tracking-wider">Status</th>
              {canModify && <th className="px-4 py-3 text-xs font-semibold text-gray-600 dark:text-gray-400 uppercase tracking-wider text-right">Actions</th>}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
            {loading ? <tr><td colSpan={canModify ? 6 : 5} className="px-4 py-8 text-center text-gray-500 dark:text-gray-400">Loading...</td></tr> :
             payments.map(p => (
              <tr key={p.id} className="hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors">
                <td className="px-4 py-3 text-gray-600 dark:text-gray-300">{new Date(p.payment_date).toLocaleDateString("en-PK")}</td>
                <td className="px-4 py-3 text-gray-900 dark:text-white">
                  {p.project_id ? projects.find(pr => pr.id === p.project_id)?.name : 
                   p.invoice_id ? `INV: ${invoices.find(inv => inv.id === p.invoice_id)?.invoice_number}` : 
                   "General"}
                </td>
                <td className="px-4 py-3 text-gray-500 dark:text-gray-400">{p.payment_method}</td>
                <td className="px-4 py-3 text-right font-semibold text-gray-900 dark:text-white">{formatCurrency(p.amount)}</td>
                <td className="px-4 py-3"><span className={`text-xs px-2 py-1 rounded font-medium ${getStatusColor(p.status)}`}>{p.status}</span></td>
                {canModify && (
                  <td className="px-4 py-3 text-right">
                    <button onClick={() => { setEditingData(p); setShowForm(true); }} className="p-1.5 text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-500/10 rounded transition-colors"><Pencil size={16} /></button>
                  </td>
                )}
              </tr>
            ))
            }
          </tbody>
        </table>
      </div>

      {showForm && (
        <PaymentFormModal 
          initialData={editingData} 
          onSubmit={handleSubmit} 
          onClose={() => { setShowForm(false); setEditingData(null); }} 
          loading={formLoading}
          invoices={invoices} 
          projects={projects} 
        />
      )}
    </div>
  );
}

function PaymentFormModal({ initialData, onSubmit, onClose, loading, invoices, projects }: any) {
  const [form, setForm] = useState<any>({
    invoice_id: initialData?.invoice_id || null,
    project_id: initialData?.project_id || null,
    amount: initialData?.amount || 0,
    payment_date: initialData?.payment_date || new Date().toISOString().split('T')[0],
    payment_method: initialData?.payment_method || "Bank Transfer",
    status: initialData?.status || "Pending",
    notes: initialData?.notes || "",
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60">
      <div className="relative bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-6 w-full max-w-md max-h-[90vh] overflow-y-auto shadow-xl">
        <button onClick={onClose} className="absolute top-4 right-4 p-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-500 dark:text-gray-400 transition-colors">
          <X size={20} />
        </button>
        
        <h2 className="text-xl font-bold text-gray-900 dark:text-white mb-4 pr-8">{initialData ? "Edit" : "Record"} Payment</h2>
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-600 dark:text-gray-400 mb-1">Link to Project (Optional)</label>
            <select value={form.project_id || ""} onChange={e => setForm({...form, project_id: e.target.value || null})} className="w-full px-3 py-2.5 bg-gray-50 dark:bg-gray-900 border border-gray-300 dark:border-gray-700 rounded-lg text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500 appearance-none">
              <option value="">None</option>
              {projects.map((p: Project) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-600 dark:text-gray-400 mb-1">Link to Invoice (Optional)</label>
            <select value={form.invoice_id || ""} onChange={e => setForm({...form, invoice_id: e.target.value || null})} className="w-full px-3 py-2.5 bg-gray-50 dark:bg-gray-900 border border-gray-300 dark:border-gray-700 rounded-lg text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500 appearance-none">
              <option value="">None</option>
              {invoices.map((inv: Invoice) => <option key={inv.id} value={inv.id}>{inv.invoice_number} - {inv.client_name}</option>)}
            </select>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-600 dark:text-gray-400 mb-1">Amount (PKR)</label>
              <input type="number" step="1" min="0" value={form.amount} onChange={e => setForm({...form, amount: Number(e.target.value)})} className="w-full px-3 py-2.5 bg-gray-50 dark:bg-gray-900 border border-gray-300 dark:border-gray-700 rounded-lg text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-600 dark:text-gray-400 mb-1">Payment Method</label>
              <select value={form.payment_method} onChange={e => setForm({...form, payment_method: e.target.value})} className="w-full px-3 py-2.5 bg-gray-50 dark:bg-gray-900 border border-gray-300 dark:border-gray-700 rounded-lg text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500 appearance-none">
                {["Bank Transfer", "JazzCash", "EasyPaisa", "Cheque", "Cash"].map(m => <option key={m} value={m}>{m}</option>)}
              </select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-600 dark:text-gray-400 mb-1">Date</label>
              <input type="date" value={form.payment_date} onChange={e => setForm({...form, payment_date: e.target.value})} className="w-full px-3 py-2.5 bg-gray-50 dark:bg-gray-900 border border-gray-300 dark:border-gray-700 rounded-lg text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-600 dark:text-gray-400 mb-1">Status</label>
              <select value={form.status} onChange={e => setForm({...form, status: e.target.value})} className="w-full px-3 py-2.5 bg-gray-50 dark:bg-gray-900 border border-gray-300 dark:border-gray-700 rounded-lg text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500 appearance-none">
                {["Pending", "Paid", "Partial Payment", "Overdue"].map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-600 dark:text-gray-400 mb-1">Notes (Optional)</label>
            <textarea value={form.notes || ""} onChange={e => setForm({...form, notes: e.target.value})} rows={3} className="w-full px-3 py-2.5 bg-gray-50 dark:bg-gray-900 border border-gray-300 dark:border-gray-700 rounded-lg text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none" />
          </div>
        </div>
        <div className="flex gap-3 mt-6 pt-2 border-t border-gray-200 dark:border-gray-700">
          <button onClick={onClose} className="flex-1 px-4 py-2.5 bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 text-gray-800 dark:text-white rounded-lg font-medium transition-colors">Cancel</button>
          <button onClick={() => onSubmit(form)} disabled={loading} className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-medium transition-colors disabled:opacity-50">
            {loading ? "Saving..." : "Save Payment"}
          </button>
        </div>
      </div>
    </div>
  );
}