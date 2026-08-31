"use client";
import { useState } from "react";
import { ProjectFormData, Budget, PROJECT_STATUSES } from "@/types";
import { X } from "lucide-react";

interface ProjectFormProps {
  initialData: any;
  onSubmit: (data: ProjectFormData) => void;
  onClose: () => void;
  loading: boolean;
  budgets?: Budget[];
  clients?: { id: string; name: string }[];
  managers?: { user_id: string; full_name: string }[];
  canViewRates?: boolean;
}

export default function ProjectForm({
  initialData,
  onSubmit,
  onClose,
  loading,
  budgets = [],
  clients = [],
  managers = [],
  canViewRates = false,
}: ProjectFormProps) {
  const [form, setForm] = useState<any>({
    name: initialData?.name || "",
    client_id: initialData?.client_id || initialData?.client?.id || "",
    client_name: initialData?.client_name || initialData?.client?.name || "",
    manager_id: initialData?.manager_id || initialData?.manager?.user_id || "",
    platform: initialData?.platform || "",
    contract_value: initialData?.contract_value ?? 0,
    currency: initialData?.currency || "PKR",
    description: initialData?.description || "",
    budget_amount: initialData?.budget_amount ?? 0,
    department: initialData?.department || "",
    cost_center: initialData?.cost_center || "",
    is_confidential: Boolean(initialData?.is_confidential),
    status: initialData?.status || "ACTIVE",
    start_date: initialData?.start_date || new Date().toISOString().split("T")[0],
    end_date: initialData?.end_date || "",
    budget_id: initialData?.budget_id || "",
    closure_reason: initialData?.closure_reason || "",
    override_reason: "",
  });

  const set = (key: string, value: any) => setForm((prev: any) => ({ ...prev, [key]: value }));

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const selectedClient = clients.find(c => c.id === form.client_id);
    const submitData: any = {
      ...form,
      client_id: form.client_id || null,
      client_name: selectedClient?.name || form.client_name || null,
      manager_id: form.manager_id || null,
      end_date: form.end_date === "" ? null : form.end_date,
      budget_id: form.budget_id === "" ? null : form.budget_id,
      platform: form.platform || null,
      department: form.department || null,
      cost_center: form.cost_center || null,
      description: form.description || null,
      closure_reason: form.closure_reason || null,
    };
    if (!form.override_reason) delete submitData.override_reason;
    if (!canViewRates) {
      delete submitData.contract_value;
      delete submitData.budget_amount;
      delete submitData.is_confidential;
    }
    onSubmit(submitData as ProjectFormData);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60">
      <div className="relative w-full max-w-2xl bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-6 max-h-[90vh] overflow-y-auto shadow-xl">
        <button onClick={onClose} className="absolute top-4 right-4 p-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-500">
          <X size={20} />
        </button>
        <h2 className="text-lg font-bold text-gray-900 dark:text-white mb-5">{initialData ? "Edit" : "Add"} Project</h2>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Field label="Project Name" required>
              <input required value={form.name} onChange={e => set("name", e.target.value)} className={inputClass} />
            </Field>
            <Field label="Client">
              <select value={form.client_id} onChange={e => set("client_id", e.target.value)} className={inputClass}>
                <option value="">Select client</option>
                {clients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </Field>
            <Field label="Project Manager">
              <select value={form.manager_id} onChange={e => set("manager_id", e.target.value)} className={inputClass}>
                <option value="">No manager assigned</option>
                {managers.map(m => <option key={m.user_id} value={m.user_id}>{m.full_name || m.user_id}</option>)}
              </select>
            </Field>
            <Field label="Platform">
              <input value={form.platform} onChange={e => set("platform", e.target.value)} placeholder="Upwork, Direct, Fiverr..." className={inputClass} />
            </Field>
          </div>

          {canViewRates && (
            <div className="rounded-lg border border-blue-200 dark:border-blue-900 p-4 space-y-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-blue-700 dark:text-blue-300">Confidential project rates</p>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <Field label="Contract Value">
                  <input type="number" min="0" step="0.01" value={form.contract_value} onChange={e => set("contract_value", Number(e.target.value))} className={inputClass} />
                </Field>
                <Field label="Currency">
                  <input maxLength={3} value={form.currency} onChange={e => set("currency", e.target.value.toUpperCase())} className={inputClass} />
                </Field>
                <Field label="Budget Amount">
                  <input type="number" min="0" step="0.01" value={form.budget_amount} onChange={e => set("budget_amount", Number(e.target.value))} className={inputClass} />
                </Field>
              </div>
              <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
                <input type="checkbox" checked={form.is_confidential} onChange={e => set("is_confidential", e.target.checked)} /> Confidential project
              </label>
            </div>
          )}

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Field label="Department"><input value={form.department} onChange={e => set("department", e.target.value)} className={inputClass} /></Field>
            <Field label="Cost Center"><input value={form.cost_center} onChange={e => set("cost_center", e.target.value)} className={inputClass} /></Field>
            <Field label="Start Date"><input required type="date" value={form.start_date || ""} onChange={e => set("start_date", e.target.value)} className={inputClass} /></Field>
            <Field label="End Date"><input type="date" value={form.end_date || ""} onChange={e => set("end_date", e.target.value)} className={inputClass} /></Field>
          </div>

          <Field label="Link to Budget (Optional)">
            <select value={form.budget_id} onChange={e => set("budget_id", e.target.value)} className={inputClass}>
              <option value="">No Budget Assigned</option>
              {budgets.map(b => <option key={b.id} value={b.id}>{b.name} (PKR {Number(b.total_amount).toLocaleString()})</option>)}
            </select>
          </Field>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Field label="Status">
              <select value={form.status} onChange={e => set("status", e.target.value)} className={inputClass}>
                {PROJECT_STATUSES.map(s => <option key={s} value={s}>{s.replaceAll("_", " ")}</option>)}
                {![...PROJECT_STATUSES].includes(form.status) && <option value={form.status}>{form.status}</option>}
                {form.status === "Active" && <option value="Active">Active</option>}
                {form.status === "Completed" && <option value="Completed">Completed</option>}
                {form.status === "On Hold" && <option value="On Hold">On Hold</option>}
              </select>
            </Field>
            {form.status === "CLOSED" && (
              <Field label="Closure / Override Reason">
                <input value={form.override_reason || form.closure_reason} onChange={e => set("override_reason", e.target.value)} placeholder="Required if unresolved items remain" className={inputClass} />
              </Field>
            )}
          </div>

          <Field label="Description">
            <textarea value={form.description} onChange={e => set("description", e.target.value)} rows={3} className={inputClass} />
          </Field>

          <div className="flex gap-3 pt-2">
            <button type="button" onClick={onClose} className="flex-1 px-4 py-2.5 bg-gray-100 dark:bg-gray-700 text-gray-800 dark:text-white rounded-lg font-medium">Cancel</button>
            <button type="submit" disabled={loading || !form.name} className="flex-1 px-4 py-2.5 bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-medium disabled:opacity-50">{loading ? "Saving..." : "Save Project"}</button>
          </div>
        </form>
      </div>
    </div>
  );
}

const inputClass = "w-full px-3 py-2.5 bg-gray-50 dark:bg-gray-900 border border-gray-300 dark:border-gray-700 rounded-lg text-gray-900 dark:text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500";
function Field({ label, required, children }: { label: string; required?: boolean; children: React.ReactNode }) {
  return <div><label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">{label}{required ? " *" : ""}</label>{children}</div>;
}
