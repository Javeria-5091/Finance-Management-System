"use client";
import { useEffect, useState } from "react";
import { usePermissions } from "@/context/PermissionContext";
import { Bell, Save, Mail, MessageSquare, Loader2 } from "lucide-react";
import toast from "react-hot-toast";

// AUD-P1-007 FIX: this page used to render a hardcoded DEFAULT_SETTINGS
// array (per-event toggles like "invoice_created") and save it into
// profiles.notification_settings JSONB — a field nothing ever read back —
// falling back to localStorage on any DB error. Nothing loaded on mount, so
// every reload silently reset the UI to the hardcoded defaults while the
// "saved" state (DB or localStorage) sat unread.
//
// The real store is public.notification_preferences (one row per user +
// category + channel, see migration P1_034 / schema.sql), fronted by the
// already-hardened /api/notifications/preferences GET/POST route. That
// table's granularity is per-category-per-channel, not per individual
// event key, so this page now persists at that same granularity: each
// category below is still described by its underlying events (for
// context), but what is actually saved/loaded is an Email / In-App / SMS
// toggle per category, matching what the table and API can actually store.

type Channel = "EMAIL" | "IN_APP" | "SMS";
const CHANNELS: Channel[] = ["EMAIL", "IN_APP", "SMS"];
const CHANNEL_LABELS: Record<Channel, string> = { EMAIL: "Email", IN_APP: "In-App", SMS: "SMS" };
const CHANNEL_ICONS: Record<Channel, typeof Mail> = { EMAIL: Mail, IN_APP: Bell, SMS: MessageSquare };

interface CategoryInfo {
  category: string;
  events: { label: string; description: string }[];
}

// Descriptive only — which events fall under each category. Individual
// events are not separately configurable (the schema doesn't support that
// granularity); this is shown so the user knows what a category covers.
const CATEGORY_INFO: CategoryInfo[] = [
  {
    category: "Invoices",
    events: [
      { label: "Invoice Created", description: "When a new invoice is generated" },
      { label: "Invoice Overdue", description: "When an invoice passes its due date" },
      { label: "Payment Received", description: "When a payment receipt is recorded" },
    ],
  },
  {
    category: "Expenses",
    events: [
      { label: "Expense Submitted", description: "When a new expense is submitted" },
      { label: "Expense Approved", description: "When an expense is approved" },
    ],
  },
  {
    category: "Budgets",
    events: [
      { label: "Budget 80% Used", description: "When a budget reaches 80% utilization" },
      { label: "Budget Exceeded", description: "When a budget exceeds 100%" },
    ],
  },
  {
    category: "Vendors",
    events: [
      { label: "Vendor Bill Due", description: "When a vendor bill is approaching due date" },
      { label: "Vendor Payment Made", description: "When a vendor payment is processed" },
    ],
  },
  {
    category: "Tax",
    events: [
      { label: "Tax Filing Due", description: "When a tax filing deadline is approaching" },
      { label: "Tax Filing Overdue", description: "When a tax filing deadline has passed" },
    ],
  },
  {
    category: "System",
    events: [
      { label: "User Role Changed", description: "When a user's role is modified" },
      { label: "New User Registered", description: "When a new user signs up" },
    ],
  },
];

// enabled defaults to true for any (category, channel) pair with no row yet
// in notification_preferences — this matches that table's own column
// default (enabled boolean DEFAULT true).
type PrefMatrix = Record<string, Record<Channel, boolean>>;

function buildDefaultMatrix(): PrefMatrix {
  const matrix: PrefMatrix = {};
  for (const { category } of CATEGORY_INFO) {
    matrix[category] = { EMAIL: true, IN_APP: true, SMS: false };
  }
  return matrix;
}

export default function NotificationsPage() {
  const { hasPermission, isLoading: permLoading } = usePermissions();
  const [matrix, setMatrix] = useState<PrefMatrix>(buildDefaultMatrix());
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const canModify = hasPermission ? hasPermission("SETTINGS_MANAGE") : false;

  // AUD-P1-007 FIX: actually load the user's saved preferences on mount
  // instead of always starting from hardcoded defaults.
  useEffect(() => {
    let cancelled = false;
    async function loadPreferences() {
      setLoading(true);
      setLoadError(null);
      try {
        const res = await fetch("/api/notifications/preferences");
        const payload = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(payload?.error || "Failed to load notification preferences");
        if (cancelled) return;

        const next = buildDefaultMatrix();
        for (const row of payload?.preferences || []) {
          const category = String(row?.category || "");
          const channel = String(row?.channel || "").toUpperCase() as Channel;
          if (next[category] && CHANNELS.includes(channel)) {
            next[category][channel] = Boolean(row.enabled);
          }
        }
        setMatrix(next);
      } catch (err: any) {
        if (!cancelled) setLoadError(err.message || "Failed to load notification preferences");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    loadPreferences();
    return () => { cancelled = true; };
  }, []);

  function toggleCell(category: string, channel: Channel) {
    setMatrix(prev => ({
      ...prev,
      [category]: { ...prev[category], [channel]: !prev[category][channel] },
    }));
  }

  function toggleCategoryAll(category: string, enabled: boolean) {
    setMatrix(prev => ({
      ...prev,
      [category]: { EMAIL: enabled, IN_APP: enabled, SMS: enabled },
    }));
  }

  // Convenience bulk action: flip one channel across every category at
  // once (e.g. "turn off SMS everywhere"). Purely a local-state shortcut —
  // it still saves as individual per-category rows, there is no separate
  // "global channel" concept in the schema.
  function toggleChannelEverywhere(channel: Channel) {
    setMatrix(prev => {
      const allCurrentlyOn = CATEGORY_INFO.every(({ category }) => prev[category][channel]);
      const next: PrefMatrix = {};
      for (const { category } of CATEGORY_INFO) {
        next[category] = { ...prev[category], [channel]: !allCurrentlyOn };
      }
      return next;
    });
  }

  async function handleSave() {
    setSaving(true);
    try {
      const preferences = CATEGORY_INFO.flatMap(({ category }) =>
        CHANNELS.map(channel => ({ category, channel, enabled: matrix[category][channel] }))
      );

      const res = await fetch("/api/notifications/preferences", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ preferences }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload?.error || "Failed to save preferences");

      toast.success("Notification preferences saved");
    } catch (err: any) {
      toast.error("Error saving: " + (err.message || "Unknown"));
    } finally {
      setSaving(false);
    }
  }

  if (permLoading || loading) {
    return (
      <div className="p-8 flex items-center justify-center text-gray-500 gap-2">
        <Loader2 className="w-5 h-5 animate-spin" /> Loading...
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h2 className="text-2xl font-bold text-gray-900 dark:text-white flex items-center gap-2"><Bell className="w-7 h-7 text-amber-600" /> Notification Preferences</h2>
          <p className="text-gray-500 dark:text-gray-400 text-sm">Choose which categories notify you, and through which channel</p>
        </div>
        {canModify && (
          <button onClick={handleSave} disabled={saving} className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-4 py-2.5 rounded-lg font-medium transition-colors w-fit shadow-sm disabled:opacity-50">
            <Save size={16} /> {saving ? "Saving..." : "Save Preferences"}
          </button>
        )}
      </div>

      {loadError && (
        <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-300 text-sm rounded-xl p-4">
          Couldn't load your saved preferences ({loadError}). Showing defaults — saving will overwrite them.
        </div>
      )}

      {/* Delivery Channels — bulk shortcut, not separately stored */}
      <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-5">
        <h3 className="text-sm font-bold text-gray-900 dark:text-white mb-1">Delivery Channels</h3>
        <p className="text-xs text-gray-500 dark:text-gray-400 mb-4">Quickly turn a channel on or off across every category below</p>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          {CHANNELS.map(ch => {
            const Icon = CHANNEL_ICONS[ch];
            const allOn = CATEGORY_INFO.every(({ category }) => matrix[category][ch]);
            return (
              <button
                key={ch}
                type="button"
                onClick={() => toggleChannelEverywhere(ch)}
                className={`flex items-center gap-3 p-3 border rounded-lg transition-colors text-left ${allOn ? "border-blue-500 bg-blue-50 dark:bg-blue-900/20" : "border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-700/50"}`}
              >
                <Icon size={18} className={allOn ? "text-blue-600" : "text-gray-400"} />
                <span className="text-sm font-medium text-gray-900 dark:text-white">{CHANNEL_LABELS[ch]}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Notification Categories */}
      {CATEGORY_INFO.map(({ category, events }) => {
        const allEnabled = CHANNELS.every(ch => matrix[category][ch]);
        return (
          <div key={category} className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-5">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-bold text-gray-900 dark:text-white">{category}</h3>
              <button onClick={() => toggleCategoryAll(category, !allEnabled)} className={`text-xs font-medium px-2.5 py-1 rounded-lg transition-colors ${allEnabled ? "bg-gray-100 dark:bg-gray-700 text-gray-600 hover:bg-gray-200" : "bg-blue-100 dark:bg-blue-900/30 text-blue-600"}`}>{allEnabled ? "Disable All" : "Enable All"}</button>
            </div>

            <ul className="mb-4 space-y-1">
              {events.map(ev => (
                <li key={ev.label} className="text-xs text-gray-500 dark:text-gray-400">
                  <span className="font-medium text-gray-700 dark:text-gray-300">{ev.label}:</span> {ev.description}
                </li>
              ))}
            </ul>

            <div className="flex flex-wrap gap-2">
              {CHANNELS.map(ch => {
                const Icon = CHANNEL_ICONS[ch];
                const on = matrix[category][ch];
                return (
                  <label key={ch} className={`flex items-center gap-2 px-3 py-2 border rounded-lg cursor-pointer transition-colors ${on ? "border-blue-500 bg-blue-50 dark:bg-blue-900/20" : "border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-700/50"}`}>
                    <input type="checkbox" checked={on} onChange={() => toggleCell(category, ch)} className="w-4 h-4 rounded border-gray-300 text-blue-600" />
                    <Icon size={16} className={on ? "text-blue-600" : "text-gray-400"} />
                    <span className="text-sm font-medium text-gray-900 dark:text-white">{CHANNEL_LABELS[ch]}</span>
                  </label>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
