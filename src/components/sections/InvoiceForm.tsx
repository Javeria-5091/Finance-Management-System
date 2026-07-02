"use client";
import { useState, useEffect, FormEvent } from "react";
import Button from "@/components/ui/Button";
import Input from "@/components/ui/Input";
import { InvoiceFormData, INVOICE_STATUSES } from "@/types";
import type { Project } from "@/types";
import { X } from "lucide-react";

interface InvoiceFormProps {
  initialData: InvoiceFormData | null;
  onSubmit: (data: InvoiceFormData) => Promise<void>;
  onClose: () => void;
  loading: boolean;
  projects: Project[];
}

export default function InvoiceForm({ initialData, onSubmit, onClose, loading, projects }: InvoiceFormProps) {
  const isEdit = initialData !== null;
  
  // Auto Generate Invoice Number
  const generateInvoiceNumber = () => {
    const year = new Date().getFullYear();
    const randomNum = Math.floor(1000 + Math.random() * 9000);
    return `INV-${year}-${randomNum}`;
  };

  const [form, setForm] = useState<InvoiceFormData>({
    invoice_number: generateInvoiceNumber(),
    client_name: "",
    amount: 0,
    status: "Pending",
    issue_date: new Date().toISOString().split("T")[0],
    due_date: "",
    project_id: null,
    notes: "",
  });

  const [projectError, setProjectError] = useState("");

  useEffect(() => {
    if (initialData) setForm(initialData);
  }, [initialData]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    
    if (!form.project_id) {
      setProjectError("Please select any project");
      return;
    }

    const safeData = {
      ...form,
      due_date: form.due_date === "" ? null : form.due_date
    };

    await onSubmit(safeData);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60">
      <div className="bg-gray-800 border border-gray-700 rounded-xl w-full max-w-lg p-6 relative max-h-[90vh] overflow-y-auto">
        <button onClick={onClose} className="absolute top-4 right-4 text-gray-400 hover:text-white"><X size={20} /></button>
        
        <h2 className="text-xl font-bold text-white mb-6">{isEdit ? "Edit Invoice" : "Create New Invoice"}</h2>
        
        <form onSubmit={handleSubmit} className="space-y-4">
          <Input 
            label="Invoice Number" 
            value={form.invoice_number} 
            onChange={e => setForm({...form, invoice_number: e.target.value})} 
            required 
          />

          <Input label="Client Name" placeholder="e.g. XYZ Corp" value={form.client_name} onChange={e => setForm({...form, client_name: e.target.value})} required />
          
          <Input label="Amount (PKR)" type="number" placeholder="0" value={form.amount || ""} onChange={e => setForm({...form, amount: parseFloat(e.target.value) || 0})} required min="0" step="1" />

          <div>
            <label className="block text-sm font-medium text-gray-300 mb-1">Status</label>
            <select 
              value={form.status} 
              onChange={e => setForm({...form, status: e.target.value as any})}
              className="w-full px-3 py-2.5 bg-gray-900 border border-gray-700 rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              {INVOICE_STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-300 mb-1">Related Project *</label>
            <select 
              value={form.project_id || ""} 
              onChange={e => {
                setForm({...form, project_id: e.target.value || null});
                if (e.target.value) setProjectError("");
              }}
              className="w-full px-3 py-2.5 bg-gray-900 border border-gray-700 rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="">-- Select Project --</option>
              {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            {projectError && <p className="mt-1 text-xs text-red-400">{projectError}</p>}
          </div>

          <div className="grid grid-cols-2 gap-4">
            <Input label="Issue Date" type="date" value={form.issue_date} onChange={e => setForm({...form, issue_date: e.target.value})} required />
            <Input label="Due Date" type="date" value={form.due_date || ""} onChange={e => setForm({...form, due_date: e.target.value})} required />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-300 mb-1">Notes (Optional)</label>
            <textarea 
              value={form.notes || ""} 
              onChange={e => setForm({...form, notes: e.target.value})}
              rows={3} 
              placeholder="Payment instructions..."
              className="w-full px-3 py-2.5 bg-gray-900 border border-gray-700 rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
            />
          </div>

          <div className="flex gap-3 pt-2">
            <button type="button" onClick={onClose} className="flex-1 px-4 py-2.5 bg-gray-700 hover:bg-gray-600 text-white rounded-lg transition-colors">Cancel</button>
            <Button type="submit" loading={loading}>{isEdit ? "Update" : "Create Invoice"}</Button>
          </div>
        </form>
      </div>
    </div>
  );
}