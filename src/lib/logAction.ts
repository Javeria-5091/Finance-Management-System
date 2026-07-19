import { supabase } from "./supabase";

/**
 * LOG ACTION - UPDATED FOR ENTERPRISE ARCHITECTURE
 * 
 * MATHEEM: Audit log ab DATABASE TRIGGERS se automatic hota hai 
 * (audit.trigger_audit_log). Yeh function SIRF Notifications generate karta hai.
 * 
 * Phase 1 Tables (auto-audited via triggers):
 * - core.organization_config
 * - finance.chart_of_accounts
 * - finance.fiscal_years
 * - finance.accounting_periods
 * 
 * Phase 2 mein jab public.incomes/expenses update hongi, 
 * unpe bhi trigger lagayenge, phir woh bhi auto-audit honge.
 */

export async function logAction(action: string, module: string, details?: string) {
  try {
    // -------------------------------------------------
    // AUDIT LOG: No longer needed manually! 
    // Database trigger handles it automatically.
    // -------------------------------------------------

    let notify = false;
    let notifTitle = "";
    let notifMessage = "";

    if (action.includes("Created") || action.includes("Added")) {
      notify = true;
      notifTitle = `New ${module}`;
      notifMessage = details || `A new item was added in ${module}.`;
    } else if (action.includes("Deleted")) {
      notify = true;
      notifTitle = `${module} Deleted`;
      notifMessage = details || `An item was deleted from ${module}.`;
    }

    // -------------------------------------------------
    // NOTIFICATIONS: Still manual (until we add triggers)
    // -------------------------------------------------
    if (notify) {
      // Fallback to auth.uid() if no userId passed
      const { data: { user } } = await supabase.auth.getUser();
      
      if (user) {
        await supabase.from("notifications").insert({
          user_id: user.id,
          title: notifTitle,
          message: notifMessage,
        });
      }
    }
  } catch (error) {
    console.error("Failed to process action notification:", error);
  }
}