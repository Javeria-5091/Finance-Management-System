"use client";
import { useEffect, useState, useCallback } from "react";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/context/AuthContext";
import { Payment, PaymentFormData, Invoice, Project } from "@/types";
import { Plus, Pencil, Trash2 } from "lucide-react";

export default function PaymentsPage() {
  const { user, hasPermission, isAdmin } = useAuth();
  const [payments, setPayments] = useState<Payment[]>([]);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editingData, setEditingData] = useState<Payment | null>(null);

  const canModify = hasPermission("can_create_invoice") || isAdmin; // Re-using invoice permission

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
    if (editingData) {
      await supabase.from("payments").update(data).eq("id", editingData.id);
    } else {
      await supabase.from("payments").insert({ ...data, user_id: user?.id });
    }
    setShowForm(false); setEditingData(null); fetchData();
  }

  function getStatusColor(s: string) {
    if (s === "Paid") return "bg-green-500/20 text-green-400";
    if (s === "Pending") return "bg-yellow-500/20 text-yellow-400";
    if (s === "Overdue") return "bg-red-500/20 text-red-400";
    return "bg-blue-500/20 text-blue-400"; // Partial
  }

  function formatCurrency(n: number) {
    return new Intl.NumberFormat("en-PK", { style: "currency", currency: "PKR", minimumFractionDigits: 0 }).format(n);
  }

  return (
    <div>
      <div className="flex justify-between items-center mb-6">
        <div>
          <h2 className="text-2xl font-bold text-white">Payment Tracking</h2>
          <p className="text-gray-400 text-sm">Record incoming and outgoing payments</p>
        </div>
        {canModify && (
          <button onClick={() => { setEditingData(null); setShowForm(true); }} className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-4 py-2.5 rounded-lg font-medium">
            <Plus size={18} /> Record Payment
          </button>
        )}
      </div>

      <div className="bg-gray-800 border border-gray-700 rounded-xl overflow-hidden">
        <table className="w-full text-left">
          <thead className="bg-gray-900/50 text-xs text-gray-400 uppercase">
            <tr>
              <th className="px-4 py-3">Date</th>
              <th className="px-4 py-3">Project/Invoice</th>
              <th className="px-4 py-3">Method</th>
              <th className="px-4 py-3 text-right">Amount</th>
              <th className="px-4 py-3">Status</th>
              {canModify && <th className="px-4 py-3 text-right">Actions</th>}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-700">
            {loading ? <tr><td colSpan={6} className="p-8 text-center text-gray-400">Loading...</td></tr> :
             payments.map(p => (
              <tr key={p.id} className="hover:bg-gray-700/50">
                <td className="px-4 py-3 text-gray-300">{new Date(p.payment_date).toLocaleDateString("en-PK")}</td>
                <td className="px-4 py-3 text-white">
                  {p.project_id ? projects.find(pr => pr.id === p.project_id)?.name : 
                   p.invoice_id ? `INV: ${invoices.find(inv => inv.id === p.invoice_id)?.invoice_number}` : 
                   "General"}
                </td>
                <td className="px-4 py-3 text-gray-400">{p.payment_method}</td>
                <td className="px-4 py-3 text-right font-semibold text-white">{formatCurrency(p.amount)}</td>
                <td className="px-4 py-3"><span className={`text-xs px-2 py-1 rounded ${getStatusColor(p.status)}`}>{p.status}</span></td>
                {canModify && (
                  <td className="px-4 py-3 text-right">
                    <button onClick={() => { setEditingData(p); setShowForm(true); }} className="p-1.5 text-gray-400 hover:text-blue-400"><Pencil size={16}/></button>
                  </td>
                )}
              </tr>
            ))
            }
          </tbody>
        </table>
      </div>

      {showForm && (
        <PaymentFormModal initialData={editingData} onSubmit={handleSubmit} onClose={() => { setShowForm(false); setEditingData(null); }} invoices={invoices} projects={projects} />
      )}
    </div>
  );
}

function PaymentFormModal({ initialData, onSubmit, onClose, invoices, projects }: any) {
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
      <div className="bg-gray-800 border border-gray-700 rounded-xl p-6 w-full max-w-md max-h-[90vh] overflow-y-auto">
        <h2 className="text-xl font-bold text-white mb-4">{initialData ? "Edit" : "Record"} Payment</h2>
        <div className="space-y-4">
          <div>
            <label className="block text-sm text-gray-400 mb-1">Link to Project (Optional)</label>
            <select value={form.project_id || ""} onChange={e => setForm({...form, project_id: e.target.value || null})} className="w-full px-3 py-2 bg-gray-900 border border-gray-700 rounded-lg text-white">
              <option value="">None</option>
              {projects.map((p: Project) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-sm text-gray-400 mb-1">Link to Invoice (Optional)</label>
            <select value={form.invoice_id || ""} onChange={e => setForm({...form, invoice_id: e.target.value || null})} className="w-full px-3 py-2 bg-gray-900 border border-gray-700 rounded-lg text-white">
              <option value="">None</option>
              {invoices.map((inv: Invoice) => <option key={inv.id} value={inv.id}>{inv.invoice_number} - {inv.client_name}</option>)}
            </select>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm text-gray-400 mb-1">Amount (PKR)</label>
              <input type="number"step="1" min="0" value={form.amount} onChange={e => setForm({...form, amount: Number(e.target.value)})} className="w-full px-3 py-2 bg-gray-900 border border-gray-700 rounded-lg text-white" />
            </div>
            <div>
              <label className="block text-sm text-gray-400 mb-1">Payment Method</label>
              <select value={form.payment_method} onChange={e => setForm({...form, payment_method: e.target.value})} className="w-full px-3 py-2 bg-gray-900 border border-gray-700 rounded-lg text-white">
                {["Bank Transfer", "JazzCash", "EasyPaisa", "Cheque", "Cash"].map(m => <option key={m} value={m}>{m}</option>)}
              </select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm text-gray-400 mb-1">Date</label>
              <input type="date" value={form.payment_date} onChange={e => setForm({...form, payment_date: e.target.value})} className="w-full px-3 py-2 bg-gray-900 border border-gray-700 rounded-lg text-white" />
            </div>
            <div>
              <label className="block text-sm text-gray-400 mb-1">Status</label>
              <select value={form.status} onChange={e => setForm({...form, status: e.target.value})} className="w-full px-3 py-2 bg-gray-900 border border-gray-700 rounded-lg text-white">
                {["Pending", "Paid", "Partial Payment", "Overdue"].map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
          </div>
        </div>
        <div className="flex gap-3 mt-6">
          <button onClick={onClose} className="flex-1 px-4 py-2.5 bg-gray-700 text-white rounded-lg">Cancel</button>
          <button onClick={() => onSubmit(form)} className="flex-1 px-4 py-2.5 bg-blue-600 text-white rounded-lg">Save</button>
        </div>
      </div>
    </div>
  );
}