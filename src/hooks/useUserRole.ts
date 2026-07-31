import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';

type RoleType = 'CEO' | 'FINANCE_HEAD' | 'ACCOUNTANT' | 'PROJECT_MANAGER' | 'EMPLOYEE' | 'VIEWER';

export function useUserRole() {
  const [role, setRole] = useState<RoleType>('EMPLOYEE');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchRole = async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) { setLoading(false); return; }

      try {
        // STEP 1: Get role_id from user_roles table
        const { data: userRoles, error: roleError } = await supabase
          .from('user_roles')
          .select('role_id')
          .eq('user_id', user.id)
          .eq('is_active', true)
          .order('created_at', { ascending: false })
          .limit(1);

        if (roleError) {
          console.error("Role fetch error:", roleError);
          setLoading(false);
          return;
        }

        // STEP 2: If role found, get the actual name from roles table (Safe Join)
        if (userRoles && userRoles.length > 0) {
          const { data: roleData } = await supabase
            .from('roles')
            .select('name')
            .eq('id', userRoles[0].role_id)
            .single();

          if (roleData) {
            setRole(roleData.name as RoleType);
          }
        } else {
          // STEP 3: Fallback to old profiles table if new table is empty
          const { data: profile } = await supabase
            .from('profiles')
            .select('role')
            .eq('user_id', user.id)
            .single();

          if (profile?.role) {
            // Map old roles to new standard roles
            const roleMap: Record<string, RoleType> = {
              'CEO': 'CEO',
              'HOD': 'FINANCE_HEAD',
              'Program Manager': 'ACCOUNTANT',
              'Project Manager': 'PROJECT_MANAGER'
            };
            setRole(roleMap[profile.role] || 'EMPLOYEE');
          }
        }
      } catch (err) {
        console.error("Critical error fetching role:", err);
      } finally {
        setLoading(false);
      }
    };
    fetchRole();
  }, []);

  return { role, loading };
}