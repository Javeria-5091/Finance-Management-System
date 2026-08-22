import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';

type RoleType = 'CEO' | 'FINANCE_HEAD' | 'ACCOUNTANT' | 'PROJECT_MANAGER' | 'EMPLOYEE' | 'VIEWER';

// FIX (bug: CEO seeing wrong dashboard):
// This hook used to query `.from('user_roles')` and `.from('roles')` with no
// schema qualifier. Those tables were moved to the `core` schema (they no
// longer exist in `public`), so STEP 1 always returned a PostgREST "relation
// does not exist" error — and the code returned early on that error instead
// of falling through to the profiles.role fallback. The role therefore never
// resolved past its initial default ('EMPLOYEE'), which is why the CEO saw
// the generic/Employee dashboard instead of the CEO dashboard.
//
// Fix: use the `public.v_user_roles` view, which already joins
// core.user_roles + core.roles correctly and is exposed via PostgREST
// (security_invoker, so it still respects RLS for the calling user). Also:
// never return early on a query error — always fall through to the
// profiles.role fallback so the user still gets *a* role instead of being
// stuck on the loading default.
export function useUserRole() {
  const [role, setRole] = useState<RoleType>('EMPLOYEE');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchRole = async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) { setLoading(false); return; }

      try {
        const today = new Date().toISOString().split('T')[0];

        // STEP 1: Resolve the active role via public.v_user_roles
        // (core.user_roles JOIN core.roles — public view, PostgREST-exposed).
        const { data: userRoles, error: roleError } = await supabase
          .from('v_user_roles')
          .select('role, role_display_name, role_level, is_active, effective_from, effective_to')
          .eq('user_id', user.id)
          .eq('is_active', true)
          .lte('effective_from', today)
          .or(`effective_to.is.null,effective_to.gte.${today}`)
          .order('effective_from', { ascending: false })
          .limit(1);

        if (roleError) {
          console.error('Role fetch error (v_user_roles):', roleError);
          // Do NOT return here — fall through to STEP 2 fallback below.
        }

        if (!roleError && userRoles && userRoles.length > 0) {
          setRole(userRoles[0].role as RoleType);
          setLoading(false);
          return;
        }

        // STEP 2: Fallback to profiles.role if no active role assignment
        // was found (or the view lookup itself failed).
        const { data: profile } = await supabase
          .from('profiles')
          .select('role')
          .eq('user_id', user.id)
          .maybeSingle();

        if (profile?.role) {
          const roleMap: Record<string, RoleType> = {
            'CEO': 'CEO',
            'Admin': 'CEO',
            'HOD': 'FINANCE_HEAD',
            'FINANCE_HEAD': 'FINANCE_HEAD',
            'Program Manager': 'ACCOUNTANT',
            'ACCOUNTANT': 'ACCOUNTANT',
            'Project Manager': 'PROJECT_MANAGER',
            'PROJECT_MANAGER': 'PROJECT_MANAGER',
          };
          setRole(roleMap[profile.role] || 'EMPLOYEE');
        }
      } catch (err) {
        console.error('Critical error fetching role:', err);
      } finally {
        setLoading(false);
      }
    };
    fetchRole();
  }, []);

  return { role, loading };
}
