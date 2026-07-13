"use client";
import { useEffect, useState, useCallback } from "react";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/context/AuthContext";
import { Invoice, InvoiceFormData, Project } from "@/types";
import InvoiceForm from "@/components/sections/InvoiceForm";
import { Plus, Pencil, Trash2, Printer } from "lucide-react";

export default function InvoicesPage() {
  const { user, hasPermission, isAdmin } = useAuth(); 
  
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [formLoading, setFormLoading] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [editingData, setEditingData] = useState<Invoice | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [printId, setPrintId] = useState<string | null>(null);

  const canAdd = hasPermission("can_create_invoice") || isAdmin;
  const canModify = hasPermission("can_delete_invoice") || isAdmin;

  const fetchInvoices = useCallback(async () => {
    if (!user) return;
    const { data } = await supabase.from("invoices").select("*").order("created_at", { ascending: false });
    if (data) setInvoices(data);
    setLoading(false);
  }, [user]);

  const fetchProjects = useCallback(async () => {
    if (!user) return;
    const { data } = await supabase.from("projects").select("*").order("start_date", { ascending: false });
    if (data) setProjects(data);
  }, [user]);

  useEffect(() => { fetchInvoices(); fetchProjects(); }, [fetchInvoices, fetchProjects]);

  async function handleSubmit(data: InvoiceFormData) {
    setFormLoading(true);
    if (editingData) {
      await supabase.from("invoices").update(data).eq("id", editingData.id);
    } else {
      await supabase.from("invoices").insert({ ...data, user_id: user?.id });
    }
    setFormLoading(false);
    setShowForm(false);
    setEditingData(null);
    fetchInvoices();
  }

  async function handleDelete() {
    if (!deleteId) return;
    await supabase.from("invoices").delete().eq("id", deleteId);
    setDeleteId(null);
    fetchInvoices();
  }

  // ✅ NATIVE BROWSER PRINT FUNCTION
  function handlePrint(inv: Invoice) {
    setPrintId(inv.id);
    setTimeout(() => window.print(), 100);
  }

  function getStatusColor(status: string) {
    if (status === "Paid") return "bg-green-100 text-green-700 dark:bg-green-500/20 dark:text-green-400";
    if (status === "Pending") return "bg-yellow-100 text-yellow-700 dark:bg-yellow-500/20 dark:text-yellow-400";
    if (status === "Overdue") return "bg-red-100 text-red-700 dark:bg-red-500/20 dark:text-red-400";
    return "bg-gray-100 text-gray-700 dark:bg-gray-500/20 dark:text-gray-400";
  }

  function formatCurrency(amount: number) {
    return new Intl.NumberFormat("en-PK", { style: "currency", currency: "PKR", minimumFractionDigits: 0 }).format(amount);
  }

  // ✅ JO INVOICE PRINT HO RAHA HAI, SIRF WOHI DIKHEGA
  const printInvoice = printId ? invoices.find(i => i.id === printId) : null;

  return (
    <div>
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-6">
        <div>
          <h2 className="text-2xl font-bold text-gray-900 dark:text-white">Invoices</h2>
          <p className="text-gray-500 dark:text-gray-400 text-sm">Manage client invoices and payments</p>
        </div>
        {canAdd && (
          <button onClick={() => { setEditingData(null); setShowForm(true); }} className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-4 py-2.5 rounded-lg font-medium shadow-sm hover:shadow-md">
            <Plus size={18} /> Create Invoice
          </button>
        )}
      </div>

      {/* ✅ PRINT VIEW (Screen pe dikhega, Print mein nahi) */}
      {printInvoice && (
        <div className="fixed inset-0 z-[9999] bg-white text-black p-10 print:block">
          <div className="max-w-3xl mx-auto border border-gray-300 p-8 rounded-lg">
            <div className="flex justify-between items-start mb-8 pb-4 border-b-2 border-gray-200">
              <div>
                <h1 className="text-3xl font-extrabold text-blue-600">Osystic</h1>
                <p className="text-gray-600">Finance Management System</p>
              </div>
              <div className="text-right">
                <h2 className="text-2xl font-bold">INVOICE</h2>
                <p className="text-gray-600 font-mono">{printInvoice.invoice_number}</p>
              </div>
            </div>
            
            <div className="mb-6">
              <p className="font-bold text-gray-800">BILL TO:</p>
              <p className="text-lg text-gray-900">{printInvoice.client_name}</p>
            </div>

            <div className="grid grid-cols-2 gap-4 mb-6 text-sm">
              <div>
                <p className="text-gray-600">Issue Date</p>
                <p className="font-medium">{new Date(printInvoice.issue_date).toLocaleDateString("en-PK", { day: 'numeric', month: 'long', year: 'numeric' })}</p>
              </div>
              <div>
                <p className="text-gray-600">Due Date</p>
                <p className="font-medium">{new Date(printInvoice.due_date).toLocaleDateString("en-PK", { day: 'numeric', month: 'long', year: 'numeric' })}</p>
              </div>
              <div>
                <p className="text-gray-600">Status</p>
                <span className={`px-3 py-1 rounded-full text-sm font-bold ${printInvoice.status === "Paid" ? "bg-green-100 text-green-700" : printInvoice.status === "Overdue" ? "bg-red-100 text-red-700" : "bg-yellow-100 text-yellow-700"}`}>
                  {printInvoice.status}
                </span>
              </div>
              <div className="text-right">
                <p className="text-gray-600">Amount</p>
                <p className="text-2xl font-bold">{formatCurrency(printInvoice.amount)}</p>
              </div>
            </div>

            <table className="w-full text-left mb-6 border border-gray-300">
              <thead>
                <tr className="bg-gray-100">
                  <th className="px-4 py-2 text-left text-sm font-bold text-gray-700">DESCRIPTION</th>
                  <th className="px-4 py-2 text-center text-sm font-bold text-gray-700">QTY</th>
                  <th className="px-4 py-2 text-right text-sm font-bold text-gray-700">RATE (PKR)</th>
                  <th className="px-4 py-2 text-right text-sm font-bold text-gray-700">TOTAL (PKR)</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td className="px-4 py-3 border-t border-gray-200">Service / Project Payment</td>
                  <td className="px-4 py-3 border-t border-gray-200 text-center">1</td>
                  <td className="px-4 py-3 border-t border-gray-200 text-right">{printInvoice.amount.toLocaleString()}</td>
                  <td className="px-4 py-3 border-t border-gray-200 text-right font-bold">{printInvoice.amount.toLocaleString()}</td>
                </tr>
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-gray-200">
                  <td colSpan={3} className="px-4 py-2 text-right font-bold">GRAND TOTAL:</td>
                  <td className="px-4 py-2 text-right font-bold text-blue-600">{printInvoice.amount.toLocaleString()}</td>
                </tr>
              </tfoot>
            </table>

            <div className="mt-10 pt-6 border-t-2 border-gray-200 text-sm text-gray-600 bg-gray-50 p-4 rounded">
              <p className="font-bold text-gray-800 mb-1">BANK DETAILS / TERMS & CONDITIONS</p>
              <p>{printInvoice.notes || "Bank: HBL | Account Title: Osystic Tech | IBAN: PK36HABB0012345678901234. Please make the payment before the due date."}</p>
            </div>

            <p className="text-xs text-gray-500 text-center mt-8">This is a computer-generated invoice.</p>
          </div>
        </div>
      )}

      {/* ✅ NORMAL VIEW (Print mein yeh nahi dikhega) */}
      {!printInvoice && (
        <div className="print:hidden">
          <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl overflow-hidden shadow-sm dark:shadow-none">
            <table className="w-full text-left">
              <thead className="bg-gray-100 dark:bg-gray-900/70 border-b border-gray-200 dark:border-gray-700">
                <tr>
                  <th className="px-4 py-3 text-xs font-semibold text-gray-600 dark:text-gray-400 uppercase tracking-wider">Invoice #</th>
                  <th className="px-4 py-3 text-xs font-semibold text-gray-600 dark:text-gray-400 uppercase hidden sm:table-cell">Client</th>
                  <th className="px-4 py-3 text-xs font-semibold text-gray-600 dark:text-gray-400 uppercase">Status</th>
                  <th className="px-4 py-3 text-xs font-semibold text-gray-600 dark:text-gray-400 uppercase text-right">Amount</th>
                  <th className="px-4 py-3 text-xs font-semibold text-gray-600 dark:text-gray-400 uppercase text-right hidden md:table-cell">Due Date</th>
                  {canModify && <th className="px-4 py-3 text-xs font-semibold text-gray-600 dark:text-gray-400 uppercase text-right">Actions</th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
                {loading && <tr><td colSpan={6} className="px-4 py-8 text-center text-gray-500 dark:text-gray-400">Loading...</td></tr>}
                {!loading && invoices.length === 0 && <tr><td colSpan={6} className="px-4 py-12 text-center text-gray-500 dark:text-gray-400">No invoices yet.</td></tr>}
                
                {invoices.map(inv => (
                  <tr key={inv.id} className="hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors">
                    <td className="px-4 py-3 font-mono text-sm text-blue-600 dark:text-blue-400">{inv.invoice_number}</td>
                    <td className="px-4 py-3 text-gray-700 dark:text-gray-300 hidden sm:table-cell">{inv.client_name}</td>
                    <td className="px-4 py-3"><span className={`text-xs px-2 py-1 rounded font-medium ${getStatusColor(inv.status)}`}>{inv.status}</span></td>
                    <td className="px-4 py-3 text-right font-semibold text-gray-900 dark:text-white">{formatCurrency(inv.amount)}</td>
                    <td className="px-4 py-3 text-gray-500 dark:text-gray-400 text-right hidden md:table-cell">{new Date(inv.due_date).toLocaleDateString("en-PK")}</td>
                    
                    {canModify && (
                      <td className="px-4 py-3 text-right">
                        <div className="flex items-center justify-end gap-1">
                          <button onClick={() => handlePrint(inv)} className="p-1.5 text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-500/10 rounded transition-colors" title="Print / Save as PDF"><Printer size={16} /></button>
                          <button onClick={() => { setEditingData(inv); setShowForm(true); }} className="p-1.5 text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-500/10 rounded transition-colors" title="Edit"><Pencil size={16} /></button>
                          <button onClick={() => setDeleteId(inv.id)} className="p-1.5 text-gray-400 hover:text-red-600 dark:hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-500/10 rounded transition-colors" title="Delete"><Trash2 size={16} /></button>
                        </div>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {showForm && <InvoiceForm initialData={editingData} onSubmit={handleSubmit} onClose={() => { setShowForm(false); setEditingData(null); }} loading={formLoading} projects={projects} />}

      {deleteId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 print:hidden">
          <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-6 w-full max-w-sm text-center shadow-xl">
            <h3 className="text-lg font-bold text-gray-900 dark:text-white mb-2">Delete Invoice?</h3>
            <p className="text-gray-500 dark:text-gray-400 text-sm mb-6">This action cannot be undone.</p>
            <div className="flex gap-3">
              <button onClick={() => setDeleteId(null)} className="flex-1 px-4 py-2.5 bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 text-gray-800 dark:text-white rounded-lg font-medium transition-colors">Cancel</button>
              <button onClick={handleDelete} className="flex-1 px-4 py-2.5 bg-red-600 hover:bg-red-700 text-white rounded-lg font-medium transition-colors">Delete</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}