import { supabase } from "./supabase";

export async function logAction(userId: string, action: string, module: string, details?: string) {
  try {
    
    await supabase.from("audit_logs").insert({
      user_id: userId,
      action,
      module,
      details: details || null,
    });

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

    if (notify) {
      await supabase.from("notifications").insert({
        user_id: userId,
        title: notifTitle,
        message: notifMessage,
      });
    }
  } catch (error) {
    console.error("Failed to log action:", error);
  }
}