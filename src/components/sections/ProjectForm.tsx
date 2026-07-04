"use client";
import { useState, useEffect, FormEvent } from "react";
import Button from "@/components/ui/Button";
import Input from "@/components/ui/Input";
import { ProjectFormData, PROJECT_STATUSES } from "@/types";
import { X } from "lucide-react";

interface ProjectFormProps {
  initialData: ProjectFormData | null;
  onSubmit: (data: ProjectFormData) => Promise<void>;
  onClose: () => void;
  loading: boolean;
}

export default function ProjectForm({ initialData, onSubmit, onClose, loading }: ProjectFormProps) {
  const isEdit = initialData !== null;
  
  const [form, setForm] = useState<ProjectFormData>({
    name: "",
    client_name: "",
    description: "",
    status: "Active",
    start_date: new Date().toISOString().split("T")[0],
    end_date: null,
  });

  useEffect(() => {
    if (initialData) setForm(initialData);
  }, [initialData]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    
    const finalData = {
      ...form,
      end_date: form.end_date === "" ? null : form.end_date
    };
    
    await onSubmit(finalData);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60">
      <div className="bg-gray-800 border border-gray-700 rounded-xl w-full max-w-lg p-6 relative">
        <button onClick={onClose} className="absolute top-4 right-4 text-gray-400 hover:text-white"><X size={20} /></button>
        
        <h2 className="text-xl font-bold text-white mb-6">{isEdit ? "Edit Project" : "Add New Project"}</h2>
        
        <form onSubmit={handleSubmit} className="space-y-4">
          <Input label="Project Name" placeholder="e.g. E-commerce Website" value={form.name} onChange={e => setForm({...form, name: e.target.value})} required />
          
          <Input label="Client Name" placeholder="e.g. XYZ Corp" value={form.client_name} onChange={e => setForm({...form, client_name: e.target.value})} required />

          <div>
            <label className="block text-sm font-medium text-gray-300 mb-1">Status</label>
            <select 
              value={form.status} 
              onChange={e => setForm({...form, status: e.target.value as "Active" | "Completed" | "On Hold"})}
              className="w-full px-3 py-2.5 bg-gray-900 border border-gray-700 rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              {PROJECT_STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <Input label="Start Date" type="date" value={form.start_date} onChange={e => setForm({...form, start_date: e.target.value})} required />
            <Input label="End Date (Optional)" type="date" value={form.end_date || ""} onChange={e => setForm({...form, end_date: e.target.value === "" ? null : e.target.value})} />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-300 mb-1">Description (Optional)</label>
            <textarea 
              value={form.description || ""} 
              onChange={e => setForm({...form, description: e.target.value})}
              rows={3} 
              placeholder="Project details..."
              className="w-full px-3 py-2.5 bg-gray-900 border border-gray-700 rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
            />
          </div>

          <div className="flex gap-3 pt-2">
            <button type="button" onClick={onClose} className="flex-1 px-4 py-2.5 bg-gray-700 hover:bg-gray-600 text-white rounded-lg transition-colors">Cancel</button>
            <Button type="submit" loading={loading}>{isEdit ? "Update" : "Add Project"}</Button>
          </div>
        </form>
      </div>
    </div>
  );
}