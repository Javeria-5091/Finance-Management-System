'use client';

import { createContext, useContext, useEffect, useState, ReactNode } from 'react';
import { supabase } from '@/lib/supabase';

interface UserPermission {
  code: string;
  module: string;
  action: string;
  data_scope: string;
  amount_limit: number | null;
}

interface PermissionContextType {
  permissions: UserPermission[];
  isLoading: boolean;
  hasPermission: (code: string) => boolean;
  hasPermissionWithLimit: (code: string, amount: number) => boolean;
  getScope: (code: string) => string;
}

const PermissionContext = createContext<PermissionContextType | undefined>(undefined);

// ✅ FALLBACK: Agar naya system fail ho, toh purane role ke base pe basic permissions de do
const FALLBACK_PERMS: Record<string, string[]> = {
  'CEO': ['INCOME_READ', 'EXPENSE_READ', 'JOURNAL_READ', 'COA_READ', 'PERIOD_READ', 'REPORT_READ', 'ADMIN_USERS', 'ADMIN_AUDIT', 'ADMIN_CONFIG'],
  'Admin': ['INCOME_READ', 'EXPENSE_READ', 'JOURNAL_READ', 'COA_READ', 'PERIOD_READ', 'REPORT_READ', 'ADMIN_USERS', 'ADMIN_AUDIT', 'ADMIN_CONFIG'],
  'FINANCE_HEAD': ['INCOME_READ', 'EXPENSE_READ', 'JOURNAL_READ', 'COA_READ', 'PERIOD_READ', 'REPORT_READ'],
  'ACCOUNTANT': ['INCOME_READ', 'EXPENSE_READ', 'JOURNAL_READ', 'COA_READ', 'REPORT_READ'],
  'HOD': ['INCOME_READ', 'EXPENSE_READ', 'REPORT_READ'],
  'PROJECT_MANAGER': ['INCOME_READ', 'EXPENSE_READ', 'REPORT_READ'],
  'EMPLOYEE': ['EXPENSE_CREATE', 'EXPENSE_READ'],
  'VIEWER': ['INCOME_READ', 'EXPENSE_READ', 'REPORT_READ'],
};

export function PermissionProvider({ children }: { children: ReactNode }) {
  const [permissions, setPermissions] = useState<UserPermission[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const fetchPermissions = async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) {
        setIsLoading(false);
        return;
      }

      try {
        // Naye System se try karo
         const { data, error } = await supabase.rpc('get_user_permissions', {
          p_user_id: user.id
        });

        if (error) {
          console.error("⚠️ Permission RPC Error:", error.message);
          throw new Error(error.message);
        }

        if (data && data.length > 0) {
          console.log(`✅ Loaded ${data.length} permissions from new RBAC system.`);
          setPermissions(data);
        } else {
          console.warn("⚠️ No permissions found in new system, triggering fallback.");
          throw new Error("Empty permissions");
        }
      } catch (err) {
        // ✅ FALLBACK SYSTEM: Purana role check karo
        console.log("🔄 Activating Fallback Permissions...");
        const { data: profile } = await supabase
          .from('profiles')
          .select('role')
          .eq('user_id', user.id)
          .single();

        const rolePerms = FALLBACK_PERMS[profile?.role] || FALLBACK_PERMS['VIEWER'];
        
        // Convert simple strings to permission objects
        const fallbackObjects = rolePerms.map(code => ({
          code,
          module: code.split('_')[0].toLowerCase(),
          action: code.split('_')[1].toLowerCase(),
          data_scope: 'ALL',
          amount_limit: null
        }));

        setPermissions(fallbackObjects);
        console.log(`🛡️ Fallback active: Loaded ${fallbackObjects.length} permissions for role '${profile?.role}'`);
      } finally {
        setIsLoading(false);
      }
    };

    fetchPermissions();
  }, []);

  const hasPermission = (code: string): boolean => {
    return permissions.some(p => p.code === code);
  };

  const hasPermissionWithLimit = (code: string, amount: number): boolean => {
    const perm = permissions.find(p => p.code === code);
    if (!perm) return false;
    return perm.amount_limit === null || perm.amount_limit >= amount;
  };

  const getScope = (code: string): string => {
    const perm = permissions.find(p => p.code === code);
    return perm?.data_scope || 'NONE';
  };

  return (
    <PermissionContext.Provider value={{ permissions, isLoading, hasPermission, hasPermissionWithLimit, getScope }}>
      {children}
    </PermissionContext.Provider>
  );
}

export function usePermissions() {
  const context = useContext(PermissionContext);
  if (context === undefined) {
    throw new Error('usePermissions must be used within a PermissionProvider');
  }
  return context;
}