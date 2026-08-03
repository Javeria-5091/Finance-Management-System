"use client";
import { useState } from "react";
import { useAuth } from "@/context/AuthContext";
import { usePermissions } from "@/context/PermissionContext";
import { Bell, Save, Mail, MessageSquare, Clock, AlertTriangle } from "lucide-react";
import toast from "react-hot-toast";

interface NotificationSetting {
  key: string;
  label: string;
  description: string;
  category: string;
  enabled: boolean;
}

const DEFAULT_SETTINGS: NotificationSetting[] = [
  // Invoices
  { key: "invoice_created", label: "Invoice Created", description: "When a new invoice is generated", category: "Invoices", enabled: true },
  { key: "invoice_overdue", label: "Invoice Overdue", description: "When an invoice passes its due date", category: "Invoices", enabled: true },
  { key: "payment_received", label: "Payment Received", description: "When a payment receipt is recorded", category: "Invoices", enabled: true },
  // Expenses
  { key: "expense_submitted", label: "Expense Submitted", description: "When a new expense is submitted", category: "Expenses", enabled: false },
  { key: "expense_approved", label: "Expense Approved", description: "When an expense is approved", category: "Expenses", enabled: true },
  // Budgets
  { key: "budget_threshold_80", label: "Budget 80% Used", description: "When a budget reaches 80% utilization", category: "Budgets", enabled: true },
  { key: "budget_threshold_100", label: "Budget Exceeded", description: "When a budget exceeds 100%", category: "Budgets", enabled: true },
  // Vendor
  { key: "vendor_bill_due", label: "Vendor Bill Due", description: "When a vendor bill is approaching due date", category: "Vendors", enabled: true },
  { key: "vendor_payment_made", label: "Vendor Payment Made", description: "When a vendor payment is processed", category: "Vendors", enabled: false },
  // Tax
  { key: "tax_filing_due", label: "Tax Filing Due", description: "When a tax filing deadline is approaching", category: "Tax", enabled: true },
  { key: "tax_filing_overdue", label: "Tax Filing Overdue", description: "When a tax filing deadline has passed", category: "Tax", enabled: true },
  // System
  { key: "user_role_changed", label: "User Role Changed", description: "When a user's role is modified", category: "System", enabled: true },
  { key: "new_user_registered", label: "New User Registered", description: "When a new user signs up", category: "System", enabled: true },
];

const CATEGORIES = ["Invoices", "Expenses", "Budgets", "Vendors", "Tax", "System"];
const CHANNEL_ICONS = { email: Mail, in_app: Bell, sms: MessageSquare };

export default function NotificationsPage() {
  const { user } = useAuth();
  const { hasPermission, isLoading: permLoading } = usePermissions();
  const [settings, setSettings] = useState<NotificationSetting[]>(DEFAULT_SETTINGS);
  const [channels, setChannels] = useState({ email: true, in_app: true, sms: false });
  const [saving, setSaving] = useState(false);

  const canModify = hasPermission ? hasPermission("SETTINGS_MANAGE") : false;

  function toggleSetting(key: string) {
    setSettings(prev => prev.map(s => s.key === key ? { ...s, enabled: !s.enabled } : s));
  }

  function toggleChannel(ch: "email" | "in_app" | "sms") {
    setChannels(prev => ({ ...prev, [ch]: !prev[ch] }));
  }

  function toggleCategory(cat: string, enabled: boolean) {
    setSettings(prev => prev.map(s => s.category === cat ? { ...s, enabled } : s));
  }

  async function handleSave() {
    setSaving(true);
    // Save to profiles.notification_settings or a dedicated table
    // For now, we save to local storage as a placeholder
    try {
      const payload = { notification_settings: settings, notification_channels: channels };
      if (user) {
        const { error } = await (await import("@/lib/supabase")).supabase
          .from("profiles")
          .update({ notification_settings: payload })
          .eq("id", user.id);
        if (error) {
          // Fallback: save to localStorage
          localStorage.setItem(`notif_${user.id}`, JSON.stringify(payload));
        }
      }
      toast.success("Notification preferences saved");
    } catch (err: any) {
      toast.error("Error saving: " + (err.message || "Unknown"));
    } finally {
      setSaving(false);
    }
  }

  if (permLoading) return <div className="p-8 text-center text-gray-500">Loading...</div>;

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h2 className="text-2xl font-bold text-gray-900 dark:text-white flex items-center gap-2"><Bell className="w-7 h-7 text-amber-600" /> Notification Preferences</h2>
          <p className="text-gray-500 dark:text-gray-400 text-sm">Configure which events trigger notifications and how you receive them</p>
        </div>
        {canModify && (
          <button onClick={handleSave} disabled={saving} className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-4 py-2.5 rounded-lg font-medium transition-colors w-fit shadow-sm disabled:opacity-50">
            <Save size={16} /> {saving ? "Saving..." : "Save Preferences"}
          </button>
        )}
      </div>

      {/* Delivery Channels */}
      <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-5">
        <h3 className="text-sm font-bold text-gray-900 dark:text-white mb-4">Delivery Channels</h3>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          {(["email", "in_app", "sms"] as const).map(ch => {
            const Icon = CHANNEL_ICONS[ch];
            const labels: Record<string, string> = { email: "Email", in_app: "In-App", sms: "SMS" };
            return (
              <label key={ch} className={`flex items-center gap-3 p-3 border rounded-lg cursor-pointer transition-colors ${channels[ch] ? "border-blue-500 bg-blue-50 dark:bg-blue-900/20" : "border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-700/50"}`}>
                <input type="checkbox" checked={channels[ch]} onChange={() => toggleChannel(ch)} className="w-4 h-4 rounded border-gray-300 text-blue-600" />
                <Icon size={18} className={channels[ch] ? "text-blue-600" : "text-gray-400"} />
                <span className="text-sm font-medium text-gray-900 dark:text-white">{labels[ch]}</span>
              </label>
            );
          })}
        </div>
      </div>

      {/* Notification Categories */}
      {CATEGORIES.map(cat => {
        const catSettings = settings.filter(s => s.category === cat);
        const allEnabled = catSettings.every(s => s.enabled);
        return (
          <div key={cat} className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-5">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-bold text-gray-900 dark:text-white">{cat}</h3>
              <button onClick={() => toggleCategory(cat, !allEnabled)} className={`text-xs font-medium px-2.5 py-1 rounded-lg transition-colors ${allEnabled ? "bg-gray-100 dark:bg-gray-700 text-gray-600 hover:bg-gray-200" : "bg-blue-100 dark:bg-blue-900/30 text-blue-600"}`}>{allEnabled ? "Disable All" : "Enable All"}</button>
            </div>
            <div className="space-y-2">
              {catSettings.map(s => (
                <label key={s.key} className="flex items-center justify-between p-2.5 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-700/30 cursor-pointer transition-colors">
                  <div>
                    <span className="text-sm font-medium text-gray-900 dark:text-white">{s.label}</span>
                    <p className="text-xs text-gray-500 dark:text-gray-400">{s.description}</p>
                  </div>
                  <input type="checkbox" checked={s.enabled} onChange={() => toggleSetting(s.key)} className="w-4 h-4 rounded border-gray-300 text-blue-600 flex-shrink-0" />
                </label>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}