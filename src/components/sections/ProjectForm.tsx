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

type FormState = {
  name: string;
  client_id: string;
  client_name: string;
  manager_id: string;
  platform: string;
  contract_value: number;
  currency: string;
  description: string;
  budget_amount: number;
  department: string;
  cost_center: string;
  is_confidential: boolean;
  status: ProjectFormData["status"];
  start_date: string;
  end_date: string;
  budget_id: string;
  closure_reason: string;
  override_reason: string;
};

const today = () => new Date().toISOString().split("T")[0];

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
  const [form, setForm] = useState<FormState>({
    name: initialData?.name ?? "",
    client_id: initialData?.client_id ?? initialData?.client?.id ?? "",
    client_name: initialData?.client_name ?? initialData?.client?.name ?? "",
    manager_id: initialData?.manager_id ?? initialData?.manager?.user_id ?? "",
    platform: initialData?.platform ?? "",
    contract_value: Number(initialData?.contract_value ?? 0),
    currency: String(initialData?.currency ?? "PKR").toUpperCase(),
    description: initialData?.description ?? "",
    budget_amount: Number(initialData?.budget_amount ?? 0),
    department: initialData?.department ?? "",
    cost_center: initialData?.cost_center ?? "",
    is_confidential: Boolean(initialData?.is_confidential),
    status: initialData?.status ?? "ACTIVE",
    start_date: initialData?.start_date ?? today(),
    end_date: initialData?.end_date ?? "",
    budget_id: initialData?.budget_id ?? "",
    closure_reason: initialData?.closure_reason ?? "",
    override_reason: "",
  });

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();

    const selectedClient = clients.find((client) => client.id === form.client_id);
    const submitData: ProjectFormData = {
      name: form.name.trim(),
      client_id: form.client_id || null,
      client_name: (selectedClient?.name ?? form.client_name.trim()) || null,
      manager_id: form.manager_id || null,
      platform: form.platform.trim() || null,
      contract_value: form.contract_value,
      currency: form.currency.trim().toUpperCase() || "PKR",
      description: form.description.trim() || null,
      budget_amount: form.budget_amount,
      department: form.department.trim() || null,
      cost_center: form.cost_center.trim() || null,
      is_confidential: form.is_confidential,
      status: form.status,
      start_date: form.start_date || null,
      end_date: form.end_date || null,
      budget_id: form.budget_id || null,
      override_reason: form.override_reason.trim() || undefined,
    };

    // Contract/budget/confidential project-rate data is permission restricted.
    // The API performs the authoritative permission check as well.
    if (!canViewRates) {
      delete (submitData as Partial<ProjectFormData>).contract_value;
      delete (submitData as Partial<ProjectFormData>).budget_amount;
      delete (submitData as Partial<ProjectFormData>).is_confidential;
    }

    onSubmit(submitData);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60">
      <div className="relative w-full max-w-3xl bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-6 max-h-[90vh] overflow-y-auto shadow-xl">
        <button
          type="button"
          onClick={onClose}
          className="absolute top-4 right-4 p-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-500"
          aria-label="Close project form"
        >
          <X size={20} />
        </button>

        <h2 className="text-lg font-bold text-gray-900 dark:text-white mb-5">
          {initialData ? "Edit" : "Add"} Project
        </h2>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Field label="Project Name" required>
              <input
                required
                maxLength={255}
                value={form.name}
                onChange={(e) => set("name", e.target.value)}
                className={inputClass}
              />
            </Field>

            <Field label="Client">
              <select value={form.client_id} onChange={(e) => set("client_id", e.target.value)} className={inputClass}>
                <option value="">Select client</option>
                {clients.map((client) => (
                  <option key={client.id} value={client.id}>{client.name}</option>
                ))}
              </select>
            </Field>

            <Field label="Project Manager">
              <select value={form.manager_id} onChange={(e) => set("manager_id", e.target.value)} className={inputClass}>
                <option value="">No manager assigned</option>
                {managers.map((manager) => (
                  <option key={manager.user_id} value={manager.user_id}>
                    {manager.full_name || manager.user_id}
                  </option>
                ))}
              </select>
            </Field>

            <Field label="Platform">
              <input
                maxLength={100}
                value={form.platform}
                onChange={(e) => set("platform", e.target.value)}
                placeholder="Upwork, Direct, Fiverr..."
                className={inputClass}
              />
            </Field>
          </div>

          {canViewRates && (
            <div className="rounded-lg border border-blue-200 dark:border-blue-900 p-4 space-y-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-blue-700 dark:text-blue-300">
                Confidential project rates
              </p>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <Field label="Contract Value">
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={form.contract_value}
                    onChange={(e) => set("contract_value", Number(e.target.value))}
                    className={inputClass}
                  />
                </Field>
                <Field label="Currency">
                  <input
                    required
                    minLength={3}
                    maxLength={3}
                    value={form.currency}
                    onChange={(e) => set("currency", e.target.value.toUpperCase())}
                    className={inputClass}
                  />
                </Field>
                <Field label="Budget Amount">
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={form.budget_amount}
                    onChange={(e) => set("budget_amount", Number(e.target.value))}
                    className={inputClass}
                  />
                </Field>
              </div>

              <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
                <input
                  type="checkbox"
                  checked={form.is_confidential}
                  onChange={(e) => set("is_confidential", e.target.checked)}
                />
                Confidential project
              </label>
            </div>
          )}

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Field label="Department">
              <input maxLength={100} value={form.department} onChange={(e) => set("department", e.target.value)} className={inputClass} />
            </Field>
            <Field label="Cost Center">
              <input maxLength={100} value={form.cost_center} onChange={(e) => set("cost_center", e.target.value)} className={inputClass} />
            </Field>
            <Field label="Start Date">
              <input required type="date" value={form.start_date} onChange={(e) => set("start_date", e.target.value)} className={inputClass} />
            </Field>
            <Field label="End Date">
              <input type="date" value={form.end_date} onChange={(e) => set("end_date", e.target.value)} className={inputClass} />
            </Field>
          </div>

          <Field label="Link to Budget (Optional)">
            <select value={form.budget_id} onChange={(e) => set("budget_id", e.target.value)} className={inputClass}>
              <option value="">No Budget Assigned</option>
              {budgets.map((budget) => (
                <option key={budget.id} value={budget.id}>
                  {budget.name} (PKR {Number(budget.total_amount).toLocaleString()})
                </option>
              ))}
            </select>
          </Field>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Field label="Status">
              <select
                value={form.status}
                onChange={(e) => set("status", e.target.value as ProjectFormData["status"])}
                className={inputClass}
              >
                {PROJECT_STATUSES.map((status) => (
                  <option key={status} value={status}>{status.replaceAll("_", " ")}</option>
                ))}
              </select>
            </Field>

            {form.status === "CLOSED" && (
              <Field label="Closure / Override Reason">
                <input
                  maxLength={1000}
                  value={form.override_reason || form.closure_reason}
                  onChange={(e) => set("override_reason", e.target.value)}
                  placeholder="Required if unresolved items remain"
                  className={inputClass}
                />
              </Field>
            )}
          </div>

          <Field label="Description">
            <textarea
              maxLength={5000}
              value={form.description}
              onChange={(e) => set("description", e.target.value)}
              rows={3}
              className={inputClass}
            />
          </Field>

          <div className="flex gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 px-4 py-2.5 bg-gray-100 dark:bg-gray-700 text-gray-800 dark:text-white rounded-lg font-medium"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading || !form.name.trim()}
              className="flex-1 px-4 py-2.5 bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-medium disabled:opacity-50"
            >
              {loading ? "Saving..." : "Save Project"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

const inputClass = "w-full px-3 py-2.5 bg-gray-50 dark:bg-gray-900 border border-gray-300 dark:border-gray-700 rounded-lg text-gray-900 dark:text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500";

function Field({
  label,
  required,
  children,
}: {
  label: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
        {label}{required ? " *" : ""}
      </label>
      {children}
    </div>
  );
}
