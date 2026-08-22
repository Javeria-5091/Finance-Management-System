"use client";
import { useEffect, useState, useCallback } from "react";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/context/AuthContext";
import { usePermissions } from "@/context/PermissionContext";
import { Hash, Save, RefreshCw } from "lucide-react";
import toast from "react-hot-toast";

interface NumberingConfig {
  id: string;
  sequence_type: string;
  prefix: string;
  current_number: number;
  padding: number;
  format: string;
  reset_per_period: boolean;
  updated_at: string;
}

const DEFAULT_CONFIGS = [
  { sequence_type: "INVOICE", prefix: "INV", current_number: 0, padding: 5, format: "{PREFIX}-{NUMBER}" },
  { sequence_type: "EXPENSE", prefix: "EXP", current_number: 0, padding: 5, format: "{PREFIX}-{NUMBER}" },
  { sequence_type: "INCOME", prefix: "INC", current_number: 0, padding: 5, format: "{PREFIX}-{NUMBER}" },
  { sequence_type: "VENDOR_BILL", prefix: "VB", current_number: 0, padding: 5, format: "{PREFIX}-{NUMBER}" },
  { sequence_type: "VENDOR_PAYMENT", prefix: "VP", current_number: 0, padding: 5, format: "{PREFIX}-{NUMBER}" },
  { sequence_type: "PMT-RC", prefix: "PR", current_number: 0, padding: 5, format: "{PREFIX}-{NUMBER}" },
  { sequence_type: "CN", prefix: "CN", current_number: 0, padding: 5, format: "{PREFIX}-{NUMBER}" },
  { sequence_type: "JOURNAL_ENTRY", prefix: "JE", current_number: 0, padding: 5, format: "{PREFIX}-{NUMBER}" },
  { sequence_type: "OBI", prefix: "OBI", current_number: 0, padding: 5, format: "{PREFIX}-{NUMBER}" },
  { sequence_type: "BANK_TRANSFER", prefix: "BT", current_number: 0, padding: 5, format: "{PREFIX}-{NUMBER}" },
  { sequence_type: "PRJ", prefix: "PRJ", current_number: 0, padding: 5, format: "{PREFIX}-{NUMBER}" },
  { sequence_type: "CLT", prefix: "CLT", current_number: 0, padding: 5, format: "{PREFIX}-{NUMBER}" },
];

export default function NumberingPage() {
  const { user } = useAuth();
  const { hasPermission } = usePermissions();
  const canUpdate = hasPermission("SETTINGS_MANAGE");
  const [configs, setConfigs] = useState<NumberingConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const fetchConfigs = useCallback(async () => {
    if (!user) return;
    try {
      const res = await fetch("/api/admin/numbering-sequences", { cache: "no-store" });
      const payload = await res.json();
      if (!res.ok) throw new Error(payload?.error || "Failed to load numbering sequences");
      const data = Array.isArray(payload?.data) ? payload.data : [];
      setConfigs(data.length ? data : DEFAULT_CONFIGS.map((c, i) => ({
        ...c, id: `temp-${i}`, reset_per_period: false, updated_at: "",
      })));
    } catch (error: any) {
      toast.error("Failed to load: " + (error?.message || "Unknown error"));
      setConfigs(DEFAULT_CONFIGS.map((c, i) => ({
        ...c, id: `temp-${i}`, reset_per_period: false, updated_at: "",
      })));
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => { fetchConfigs(); }, [fetchConfigs]);

  function updateConfig(id: string, field: string, value: any) {
    setConfigs((prev) => prev.map((c) => (c.id === id ? { ...c, [field]: value } : c)));
  }

  function previewNumber(config: NumberingConfig) {
    const num = String(config.current_number + 1).padStart(config.padding, "0");
    return config.format
      .replaceAll("{PREFIX}", config.prefix)
      .replaceAll("{NUMBER}", num);
  }

  async function handleSave() {
    if (!canUpdate) return;
    setSaving(true);
    try {
      for (const config of configs) {
        const action = config.id.startsWith("temp-") ? "create" : "update";
        const body = {
          action,
          sequence_code: config.sequence_type,
          prefix: config.prefix,
          description: `Auto-numbering for ${config.sequence_type}`,
          current_number: config.current_number,
          padding: config.padding,
          reset_period: config.reset_per_period ? "PERIOD" : "YEARLY",
          format: config.format,
        };
        const res = await fetch("/api/admin/numbering-sequences", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const payload = await res.json();
        if (!res.ok) throw new Error(`${config.sequence_type}: ${payload?.error || "Save failed"}`);
      }
      toast.success("Numbering sequences saved");
      await fetchConfigs();
    } catch (error: any) {
      toast.error(error?.message || "Failed to save numbering sequences");
    } finally {
      setSaving(false);
    }
  }

  async function handleReset(id: string, sequenceType: string) {
    if (!canUpdate) return;
    if (!confirm(`Reset ${sequenceType} counter to 0?`)) return;
    try {
      const res = await fetch("/api/admin/numbering-sequences", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "reset", sequence_code: sequenceType }),
      });
      const payload = await res.json();
      if (!res.ok) throw new Error(payload?.error || "Reset failed");
      setConfigs((prev) => prev.map((c) => (c.id === id ? { ...c, current_number: 0 } : c)));
      toast.success(`${sequenceType} counter reset`);
    } catch (error: any) {
      toast.error(error?.message || "Failed to reset sequence");
    }
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
                    <span className="font-medium text-gray-900 dark:text-white">{c.sequence_type.replace(/_/g, " ")}</span>
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
                    <input type="number" value={c.current_number} onChange={(e) => updateConfig(c.id, "current_number", Number(e.target.value))} className="w-24 px-2 py-1.5 bg-gray-50 dark:bg-gray-900 border border-gray-300 dark:border-gray-700 rounded text-sm text-gray-900 dark:text-white" />
                  ) : (
                    <span className="text-gray-900 dark:text-white">{c.current_number}</span>
                  )}
                </td>
                <td className="px-4 py-3 hidden sm:table-cell">
                  {canUpdate ? (
                    <input type="number" min={1} max={10} value={c.padding} onChange={(e) => updateConfig(c.id, "padding", Number(e.target.value))} className="w-16 px-2 py-1.5 bg-gray-50 dark:bg-gray-900 border border-gray-300 dark:border-gray-700 rounded text-sm text-gray-900 dark:text-white text-center" />
                  ) : (
                    <span className="text-gray-500">{c.padding}</span>
                  )}
                </td>
                <td className="px-4 py-3">
                  <span className="bg-gray-100 dark:bg-gray-900 px-2.5 py-1 rounded font-mono text-xs text-blue-600 dark:text-blue-400 font-medium">{previewNumber(c)}</span>
                </td>
                {canUpdate && (
                  <td className="px-4 py-3 text-right">
                    <button onClick={() => handleReset(c.id, c.sequence_type)} className="p-1.5 rounded hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-500" title="Reset counter">
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
