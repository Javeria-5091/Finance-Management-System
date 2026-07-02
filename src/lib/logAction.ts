import { supabase } from "./supabase";

export async function logAction(userId: string, action: string, module: string, details?: string) {
  try {
    await supabase.from("audit_logs").insert({
      user_id: userId, 
      action,
      module,
      details: details || null,
    });
  } catch (error) {
    console.error("Failed to log action:", error);
  }
}