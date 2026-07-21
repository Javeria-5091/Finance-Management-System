"use client";
import { usePermissions as usePermContext } from "@/context/PermissionContext";

// Architecture ke mutabiq Context ko wrap karne ka tareeqa
export function usePermissions() {
  const context = usePermContext();
  
  // Shortcut for checking if user is at least an Accountant (Level >= 70)
  const isFinanceUser = context.permissions.some(p => 
    p.code === 'JOURNAL_POST' || p.code === 'INCOME_POST'
  );

  return {
    ...context,
    isFinanceUser,
  };
}