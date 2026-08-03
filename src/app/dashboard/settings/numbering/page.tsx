"use client";
import { useEffect, useState, useCallback } from "react";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/context/AuthContext";
import { usePermissions } from "@/context/PermissionContext";
import { Hash, Save, RefreshCw } from "lucide-react";
import toast from "react-hot-toast";

interface NumberingConfig {
  id: string;
  document_type: string;
  prefix: string;
  next_number: number;
  pad_length: number;
  updated_at: string;
}

const DEFAULT_CONFIGS = [
  { document_type: "INVOICE", prefix: "INV", next_number: 1, pad_length: 5 },
  { document_type: "EXPENSE", prefix: "EXP", next_number: 1, pad_length: 5 },
  { document_type: "INCOME", prefix: "INC", next_number: 1, pad_length: 5 },
  { document_type: "VENDOR_BILL", prefix: "VB", next_number: 1, pad_length: 5 },
  { document_type: "VENDOR_PAYMENT", prefix: "VP", next_number: 1, pad_length: 5 },
  { document_type: "PAYMENT_RECEIPT", prefix: "PR", next_number: 1, pad_length: 5 },
  { document_type: "CREDIT_NOTE", prefix: "CN", next_number: 1, pad_length: 5 },
  { document_type: "JOURNAL_ENTRY", prefix: "JE", next_number: 1, pad_length: 5 },
  { document_type: "BUDGET", prefix: "BG", next_number: 1, pad_length: 5 },
];

export default function NumberingPage() {
  const { user } = useAuth();
  const { hasPermission } = usePermissions();
  const canUpdate = hasPermission("SETTINGS_UPDATE");
  const [configs, setConfigs] = useState<NumberingConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const fetchConfigs = useCallback(async () => {
    if (!user) return;
    const { data, error } = await supabase.from("numbering_sequences").select("*").order("document_type");
    if (error) {
      toast.error("Failed to load: " + error.message);
      setConfigs(DEFAULT_CONFIGS.map((c, i) => ({ ...c, id: `temp-${i}`, updated_at: "" })));
    } else {
      setConfigs(data && data.length > 0 ? data : DEFAULT_CONFIGS.map((c, i) => ({ ...c, id: `temp-${i}`, updated_at: "" })));
    }
    setLoading(false);
  }, [user]);

  useEffect(() => { fetchConfigs(); }, [fetchConfigs]);

  function updateConfig(id: string, field: string, value: any) {
    setConfigs((prev) => prev.map((c) => (c.id === id ? { ...c, [field]: value } : c)));
  }

  function previewNumber(config: NumberingConfig) {
    const num = String(config.next_number).padStart(config.pad_length, "0");
    return `${config.prefix}-${num}`;
  }

  async function handleSave() {
    if (!canUpdate) return;
    setSaving(true);
    for (const config of configs) {
      if (config.id.startsWith("temp-")) {
        const { error } = await supabase.from("numbering_sequences").insert({ document_type: config.document_type, prefix: config.prefix, next_number: config.next_number, pad_length: config.pad_length });
        if (error) toast.error(`Failed to save ${config.document_type}: ` + error.message);
      } else {
        const { error } = await supabase.from("numbering_sequences").update({ prefix: config.prefix, next_number: config.next_number, pad_length: config.pad_length }).eq("id", config.id);
        if (error) toast.error(`Failed to update ${config.document_type}: ` + error.message);
      }
    }
    setSaving(false);
    toast.success("Numbering sequences saved");
    fetchConfigs();
  }

  async function handleReset(id: string, docType: string) {
    if (!confirm(`Reset ${docType} counter to 1?`)) return;
    setConfigs((prev) => prev.map((c) => (c.id === id ? { ...c, next_number: 1 } : c)));
    toast.success(`${docType} counter reset`);
  }

  return (
    <div>
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3 mb-6">
        <div>
          <h2 className="text-2xl font-bold text-gray-900 dark:text-white">Numbering Sequences</h2>
          <p className="text-gray-500 text-sm">Configure auto-numbering for invoices, bills, and other documents</p>
        </div>
        {canUpdate && (
          <button onClick={handleSave} disabled={saving} className="flex items-center gap-2 bg-blue-600 text-white px-4 py-2.5 rounded-lg font-medium disabled:opacity-50">
            <Save size={18} /> {saving ? "Saving..." : "Save All"}
          </button>
        )}
      </div>

      <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl overflow-hidden">
        <table className="w-full text-left text-sm">
          <thead className="bg-gray-100 dark:bg-gray-900/70 border-b border-gray-200 dark:border-gray-700 text-xs text-gray-500 uppercase">
            <tr>
              <th className="px-4 py-3">Document Type</th>
              <th className="px-4 py-3">Prefix</th>
              <th className="px-4 py-3">Next Number</th>
              <th className="px-4 py-3 hidden sm:table-cell">Padding</th>
              <th className="px-4 py-3">Preview</th>
              {canUpdate && <th className="px-4 py-3 text-right">Actions</th>}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
            {loading && <tr><td colSpan={6} className="p-8 text-center text-gray-400">Loading...</td></tr>}
            {configs.map((c) => (
              <tr key={c.id} className="hover:bg-gray-50 dark:hover:bg-gray-700/50">
                <td className="px-4 py-3">
                  <div className="flex items-center gap-2">
                    <Hash size={14} className="text-gray-400" />
                    <span className="font-medium text-gray-900 dark:text-white">{c.document_type.replace(/_/g, " ")}</span>
                  </div>
                </td>
                <td className="px-4 py-3">
                  {canUpdate ? (
                    <input value={c.prefix} onChange={(e) => updateConfig(c.id, "prefix", e.target.value)} className="w-20 px-2 py-1.5 bg-gray-50 dark:bg-gray-900 border border-gray-300 dark:border-gray-700 rounded text-sm text-gray-900 dark:text-white text-center font-mono" />
                  ) : (
                    <span className="font-mono text-gray-900 dark:text-white">{c.prefix}</span>
                  )}
                </td>
                <td className="px-4 py-3">
                  {canUpdate ? (
                    <input type="number" value={c.next_number} onChange={(e) => updateConfig(c.id, "next_number", Number(e.target.value))} className="w-24 px-2 py-1.5 bg-gray-50 dark:bg-gray-900 border border-gray-300 dark:border-gray-700 rounded text-sm text-gray-900 dark:text-white" />
                  ) : (
                    <span className="text-gray-900 dark:text-white">{c.next_number}</span>
                  )}
                </td>
                <td className="px-4 py-3 hidden sm:table-cell">
                  {canUpdate ? (
                    <input type="number" min={1} max={10} value={c.pad_length} onChange={(e) => updateConfig(c.id, "pad_length", Number(e.target.value))} className="w-16 px-2 py-1.5 bg-gray-50 dark:bg-gray-900 border border-gray-300 dark:border-gray-700 rounded text-sm text-gray-900 dark:text-white text-center" />
                  ) : (
                    <span className="text-gray-500">{c.pad_length}</span>
                  )}
                </td>
                <td className="px-4 py-3">
                  <span className="bg-gray-100 dark:bg-gray-900 px-2.5 py-1 rounded font-mono text-xs text-blue-600 dark:text-blue-400 font-medium">{previewNumber(c)}</span>
                </td>
                {canUpdate && (
                  <td className="px-4 py-3 text-right">
                    <button onClick={() => handleReset(c.id, c.document_type)} className="p-1.5 rounded hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-500" title="Reset counter">
                      <RefreshCw size={15} />
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
