"use client";
import { useState, useEffect, FormEvent } from "react";
import Button from "@/components/ui/Button";
import Input from "@/components/ui/Input";
import { IncomeFormData } from "@/types";
import { X } from "lucide-react";

interface IncomeFormProps {
  initialData: IncomeFormData | null;
  onSubmit: (data: IncomeFormData) => Promise<void>;
  onClose: () => void;
  loading: boolean;
}

export default function IncomeForm({ initialData, onSubmit, onClose, loading }: IncomeFormProps) {
  const isEdit = initialData !== null;
  
  // Categories yahan define ki hain
  const CATEGORIES = ["Salary", "Freelance", "Business", "Investment", "Rental", "Other"];
  
  const [form, setForm] = useState<IncomeFormData>({
    title: "",
    amount: 0,
    category: "Salary",
    description: "",
    income_date: new Date().toISOString().split("T")[0],
  });

  useEffect(() => {
    if (initialData) {
      setForm(initialData);
    }
  }, [initialData]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    await onSubmit(form);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60">
      <div className="bg-gray-800 border border-gray-700 rounded-xl w-full max-w-lg p-6 relative">
        <button onClick={onClose} className="absolute top-4 right-4 text-gray-400 hover:text-white"><X size={20} /></button>
        
        <h2 className="text-xl font-bold text-white mb-6">{isEdit ? "Edit Income" : "Add New Income"}</h2>
        
        <form onSubmit={handleSubmit} className="space-y-4">
          <Input label="Title" placeholder="e.g. Monthly Salary" value={form.title} onChange={e => setForm({...form, title: e.target.value})} required />
          
          <Input label="Amount (PKR)" type="number" placeholder="0" value={form.amount || ""} onChange={e => setForm({...form, amount: parseFloat(e.target.value) || 0})} required min="0" step="1" />

          <div>
            <label className="block text-sm font-medium text-gray-300 mb-1">Category</label>
            <select 
              value={form.category} 
              onChange={e => setForm({...form, category: e.target.value})}
              className="w-full px-3 py-2.5 bg-gray-900 border border-gray-700 rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              {CATEGORIES.map(cat => <option key={cat} value={cat}>{cat}</option>)}
            </select>
          </div>

          <Input label="Date" type="date" value={form.income_date} onChange={e => setForm({...form, income_date: e.target.value})} required />

          <div>
            <label className="block text-sm font-medium text-gray-300 mb-1">Description (Optional)</label>
            <textarea 
              value={form.description || ""} 
              onChange={e => setForm({...form, description: e.target.value})}
              rows={3} 
              placeholder="Add a note..."
              className="w-full px-3 py-2.5 bg-gray-900 border border-gray-700 rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
            />
          </div>

          <div className="flex gap-3 pt-2">
            <button type="button" onClick={onClose} className="flex-1 px-4 py-2.5 bg-gray-700 hover:bg-gray-600 text-white rounded-lg transition-colors">Cancel</button>
            <Button type="submit" loading={loading}>{isEdit ? "Update" : "Add Income"}</Button>
          </div>
        </form>
      </div>
    </div>
  );
}