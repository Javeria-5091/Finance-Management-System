"use client";
import { useEffect, useState, useCallback } from "react";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/context/AuthContext";
import { Invoice, InvoiceFormData, Project } from "@/types";
import InvoiceForm from "@/components/sections/InvoiceForm";
import { Plus, Pencil, Trash2, Download } from "lucide-react";
import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";

export default function InvoicesPage() {
  const { user, hasPermission } = useAuth(); // isAdmin ki zaroorat nahi ab
  
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [formLoading, setFormLoading] = useState(false);
  
  const [showForm, setShowForm] = useState(false);
  const [editingData, setEditingData] = useState<Invoice | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);

  // ✅ EXACT ALAG ALAG PERMISSIONS
  const canAdd = hasPermission("can_create_invoice");
  const canEdit = hasPermission("can_edit_invoice");
  const canDelete = hasPermission("can_delete_invoice");

  const fetchInvoices = useCallback(async () => {
    if (!user) return;
    const { data } = await supabase
      .from("invoices")
      .select("*")
      .order("created_at", { ascending: false });
    if (data) setInvoices(data);
    setLoading(false);
  }, [user]);

  const fetchProjects = useCallback(async () => {
    if (!user) return;
    const { data } = await supabase
      .from("projects")
      .select("*")
      .order("start_date", { ascending: false });
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

  // PDF FUNCTION
  function handleDownloadPDF(inv: Invoice) {
    const doc = new jsPDF();
    const pageWidth = doc.internal.pageSize.getWidth();
    
    doc.setFillColor(17, 24, 39);
    doc.rect(0, 0, pageWidth, 45, 'F');
    
    doc.setFontSize(26);
    doc.setTextColor(59, 130, 246);
    doc.text("Osystic", 14, 25);
    
    doc.setFontSize(10);
    doc.setTextColor(200);
    doc.text("Finance Management System", 14, 32);
    
    doc.setFontSize(18);
    doc.setTextColor(255);
    doc.text("INVOICE", pageWidth - 14, 25, { align: "right" });
    
    doc.setFontSize(10);
    doc.text(inv.invoice_number, pageWidth - 14, 32, { align: "right" });

    let y = 60;
    doc.setTextColor(50);
    doc.setFontSize(11);
    
    doc.setFont("helvetica", 'bold');
    doc.text("BILL TO:", 14, y);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(12);
    doc.text(inv.client_name, 14, y + 8);
    
    doc.setFontSize(10);
    doc.setTextColor(100);
    doc.text(`Issue Date:`, 120, y);
    doc.text(`${new Date(inv.issue_date).toLocaleDateString("en-PK", { day: 'numeric', month: 'long', year: 'numeric' })}`, 120, y + 6);
    doc.text(`Due Date:`, 120, y + 16);
    doc.text(`${new Date(inv.due_date).toLocaleDateString("en-PK", { day: 'numeric', month: 'long', year: 'numeric' })}`, 120, y + 22);
    doc.text(`Status:`, 120, y + 32);
    doc.setTextColor(inv.status === "Paid" ? "#10b981" : inv.status === "Overdue" ? "#ef4444" : "#f59e0b");
    doc.setFont("helvetica", "bold");
    doc.text(inv.status.toUpperCase(), 120, y + 38);

    const tableTop = y + 50;
    autoTable(doc, {
      startY: tableTop,
      margin: { left: 14, right: 14 },
      head: [["DESCRIPTION", "QTY", "RATE (PKR)", "TOTAL (PKR)"]],
      body: [
        ["Service / Project Payment", "1", `${inv.amount.toLocaleString()}`, `${inv.amount.toLocaleString()}`]
      ],
      theme: "plain",
      headStyles: { fillColor: [241, 245, 249], textColor: [30, 41, 59], fontStyle: 'bold', fontSize: 10 },
      bodyStyles: { textColor: [50, 50, 50], fontSize: 10, cellPadding: 8 },
      columnStyles: { 0: { cellWidth: 'auto' }, 1: { cellWidth: 25, halign: 'center' }, 2: { cellWidth: 45, halign: 'right' }, 3: { cellWidth: 45, halign: 'right', fontStyle: 'bold' } },
      didDrawCell: (data) => { doc.setDrawColor(229, 231, 235); doc.setLineWidth(0.2); doc.rect(data.cell.x, data.cell.y, data.cell.width, data.cell.height); }
    });

    let finalY = (doc as any).lastAutoTable.finalY + 10;
    const totalsX = 120;
    doc.setDrawColor(229, 231, 235);
    doc.line(totalsX, finalY, pageWidth - 14, finalY);
    doc.setFontSize(10); doc.setTextColor(100); doc.text("Subtotal:", totalsX, finalY + 8);
    doc.setTextColor(50); doc.setFont("helvetica", "bold"); doc.text(`${inv.amount.toLocaleString()} PKR`, pageWidth - 14, finalY + 8, { align: "right" });
    doc.setFont("helvetica", "normal"); doc.setTextColor(100); doc.text("Tax (0%):", totalsX, finalY + 16);
    doc.setTextColor(50); doc.text("0 PKR", pageWidth - 14, finalY + 16, { align: "right" });

    doc.setFillColor(17, 24, 39);
    doc.rect(totalsX - 5, finalY + 22, pageWidth - totalsX + 5 - 9, 12, 'F');
    doc.setFontSize(12); doc.setTextColor(255); doc.text("GRAND TOTAL:", totalsX, finalY + 31);
    doc.text(`${inv.amount.toLocaleString()} PKR`, pageWidth - 14, finalY + 31, { align: "right" });

    let footerY = finalY + 50;
    if (footerY > 250) { doc.addPage(); footerY = 20; }
    doc.setFillColor(249, 250, 251); doc.rect(14, footerY, pageWidth - 28, 35, 'F');
    doc.setFontSize(10); doc.setTextColor(50); doc.setFont("helvetica", "bold"); doc.text("BANK DETAILS / TERMS & CONDITIONS", 20, footerY + 8);
    doc.setFont("helvetica", "normal"); doc.setFontSize(9); doc.setTextColor(100);
    const bankText = inv.notes || "Bank: HBL | Account Title: Osystic Tech | IBAN: PK36HABB0012345678901234\nPlease make the payment before the due date to avoid late fees. Thank you for your business!";
    doc.text(bankText, 20, footerY + 16, { maxWidth: pageWidth - 40 });

    doc.setFontSize(8); doc.setTextColor(150);
    doc.text("This is a computer-generated invoice. No signature is required.", 14, doc.internal.pageSize.height - 15);
    doc.text("Generated by Osystic Finance Management System", 14, doc.internal.pageSize.height - 10);
    doc.save(`${inv.invoice_number}.pdf`);
  }

  function getStatusColor(status: string) {
    if (status === "Paid") return "bg-green-500/20 text-green-400";
    if (status === "Pending") return "bg-yellow-500/20 text-yellow-400";
    if (status === "Overdue") return "bg-red-500/20 text-red-400";
    return "bg-gray-500/20 text-gray-400";
  }

  function formatCurrency(amount: number) {
    return new Intl.NumberFormat("en-PK", { style: "currency", currency: "PKR", minimumFractionDigits: 0 }).format(amount);
  }

  return (
    <div>
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-6">
        <div>
          <h2 className="text-2xl font-bold text-white">Invoices</h2>
          <p className="text-gray-400 text-sm">Manage client invoices and payments</p>
        </div>
        
        {/* ✅ ADD BUTTON SIRF canAdd HONE PE */}
        {canAdd && (
          <button onClick={() => { setEditingData(null); setShowForm(true); }} className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-4 py-2.5 rounded-lg font-medium transition-colors w-fit">
            <Plus size={18} /> Create Invoice
          </button>
        )}
      </div>

      <div className="bg-gray-800 border border-gray-700 rounded-xl overflow-hidden">
        <table className="w-full text-left">
          <thead className="border-b border-gray-700 bg-gray-900/50">
            <tr>
              <th className="px-4 py-3 text-xs font-medium text-gray-400 uppercase">Invoice #</th>
              <th className="px-4 py-3 text-xs font-medium text-gray-400 uppercase hidden sm:table-cell">Client</th>
              <th className="px-4 py-3 text-xs font-medium text-gray-400 uppercase">Status</th>
              <th className="px-4 py-3 text-xs font-medium text-gray-400 uppercase text-right">Amount</th>
              <th className="px-4 py-3 text-xs font-medium text-gray-400 uppercase text-right hidden md:table-cell">Due Date</th>
              {/* ✅ ACTIONS COLUMN HAMESHA DIKHEGA (Kyunke Download sab ko chahiye) */}
              <th className="px-4 py-3 text-xs font-medium text-gray-400 uppercase text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-700">
            {loading && <tr><td colSpan={6} className="px-4 py-8 text-center text-gray-400">Loading...</td></tr>}
            {!loading && invoices.length === 0 && <tr><td colSpan={6} className="px-4 py-12 text-center text-gray-400">No invoices yet.</td></tr>}
            
            {invoices.map(inv => (
              <tr key={inv.id} className="hover:bg-gray-700/50 transition-colors">
                <td className="px-4 py-3 font-mono text-sm text-blue-400">{inv.invoice_number}</td>
                <td className="px-4 py-3 text-gray-300 hidden sm:table-cell">{inv.client_name}</td>
                <td className="px-4 py-3"><span className={`text-xs px-2 py-1 rounded ${getStatusColor(inv.status)}`}>{inv.status}</span></td>
                <td className="px-4 py-3 text-right font-semibold text-white">{formatCurrency(inv.amount)}</td>
                <td className="px-4 py-3 text-right text-gray-400 hidden md:table-cell">{new Date(inv.due_date).toLocaleDateString("en-PK")}</td>
                
                {/* ✅ ACTIONS: DOWNLOAD HAMESHA, EDIT/DELETE PERMISSIONS KE MUTABIQ */}
                <td className="px-4 py-3 text-right">
                  <div className="flex items-center justify-end gap-1">
                    <button onClick={() => handleDownloadPDF(inv)} className="p-1.5 text-gray-400 hover:text-green-400 hover:bg-green-500/10 rounded transition-colors" title="Download PDF"><Download size={16} /></button>
                    
                    {canEdit && (
                      <button onClick={() => { setEditingData(inv); setShowForm(true); }} className="p-1.5 text-gray-400 hover:text-blue-400 hover:bg-blue-500/10 rounded transition-colors" title="Edit"><Pencil size={16} /></button>
                    )}
                    
                    {canDelete && (
                      <button onClick={() => setDeleteId(inv.id)} className="p-1.5 text-gray-400 hover:text-red-400 hover:bg-red-500/10 rounded transition-colors" title="Delete"><Trash2 size={16} /></button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* ✅ FORM MODAL (canAdd ya canEdit se hi aayega, yahan condition ki zaroorat nahi) */}
      {showForm && (
        <InvoiceForm initialData={editingData} onSubmit={handleSubmit} onClose={() => { setShowForm(false); setEditingData(null); }} loading={formLoading} projects={projects} />
      )}

      {deleteId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60">
          <div className="bg-gray-800 border border-gray-700 rounded-xl p-6 w-full max-w-sm text-center">
            <h3 className="text-lg font-bold text-white mb-2">Delete Invoice?</h3>
            <p className="text-gray-400 text-sm mb-6">This action cannot be undone.</p>
            <div className="flex gap-3">
              <button onClick={() => setDeleteId(null)} className="flex-1 px-4 py-2.5 bg-gray-700 hover:bg-gray-600 text-white rounded-lg transition-colors">Cancel</button>
              <button onClick={handleDelete} className="flex-1 px-4 py-2.5 bg-red-600 hover:bg-red-700 text-white rounded-lg transition-colors">Delete</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}