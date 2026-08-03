// =============================================================================
// API AUTH MIDDLEWARE — Server-side authentication + permission check for all API routes
// =============================================================================

import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { NextRequest, NextResponse } from 'next/server';

// ---------- Types ----------
export interface AuthResult {
  userId: string;
  email: string | null;
  role: string;
  orgId: string | null;
}

// ---------- Blocklist: SQL keywords that must NEVER appear in AI-generated queries ----------
export const DANGEROUS_SQL_KEYWORDS = [
  'DROP', 'ALTER', 'CREATE', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE',
  'GRANT', 'REVOKE', 'EXECUTE', 'COPY', 'REFRESH MATERIALIZED',
  'CREATEUSER', 'CREATEROLE', 'ALTER USER', 'SET PASSWORD',
  'pg_read_file', 'pg_write_file', 'pg_ls_dir', 'lo_import', 'lo_export',
];

// ---------- Role hierarchy for approval checks ----------
const APPROVAL_ROLES: Record<string, number> = {
  CEO: 100,
  FINANCE_HEAD: 80,
  ACCOUNTANT: 60,
  HOD: 40,
  PROJECT_MANAGER: 20,
  EMPLOYEE: 10,
  VIEWER: 0,
};

// ---------- Core: get authenticated user from session ----------
export async function getAuthUser(): Promise<AuthResult | NextResponse> {
  const cookieStore = await cookies();

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            );
          } catch {
            // Server Component — read-only cookies
          }
        },
      },
    }
  );

  const { data: { session }, error } = await supabase.auth.getSession();

  if (error || !session?.user) {
    return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
  }

  // Fetch role from profiles (fallback chain)
  let role = 'VIEWER';
  let orgId: string | null = null;

  // Method 1: RPC
  try {
    const { data: rpcData } = await supabase.rpc('get_my_user_roles');
    const arr = Array.isArray(rpcData) ? rpcData : rpcData ? [rpcData] : [];
    const today = new Date().toISOString().split('T')[0];
    const active = arr
      .filter((r: any) => r.is_active !== false && r.effective_from <= today && (!r.effective_to || r.effective_to >= today))
      .sort((a: any, b: any) => (b.effective_from || '').localeCompare(a.effective_from || ''))[0];
    if (active) role = active.role || active.role_name || role;
  } catch {}

  // Method 2: Profile fallback
  if (role === 'VIEWER') {
    const { data: profile } = await supabase
      .from('profiles')
      .select('role, organization_id')
      .eq('user_id', session.user.id)
      .maybeSingle();
    if (profile?.role) role = profile.role === 'Admin' ? 'CEO' : profile.role;
    orgId = profile?.organization_id || null;
  }

  return { userId: session.user.id, email: session.user.email ?? null, role, orgId };
}

// ---------- Require specific permission ----------
export async function requirePermission(requiredPerm: string): Promise<AuthResult | NextResponse> {
  const auth = await getAuthUser();
  if (auth instanceof NextResponse) return auth; // 401

  // CEO has all permissions
  if (auth.role === 'CEO' || auth.role === 'Admin') return auth;

  // Check against permission table via RPC
  try {
    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      { cookies: { getAll: async () => (await cookies()).getAll(), setAll: () => {} } }
    );

    // Try RPC first
    const { data: perms } = await supabase.rpc('get_my_permissions');
    if (perms) {
      const permObj = !Array.isArray(perms) && typeof perms === 'object' ? perms : null;
      if (permObj && permObj[requiredPerm] === true) return auth;
      if (Array.isArray(perms) && perms.some((p: any) => (p.permission_code || p.perm_code || p.code) === requiredPerm)) return auth;
    }
  } catch {}

  return NextResponse.json({ error: 'Insufficient permissions' }, { status: 403 });
}

// ---------- Maker-Checker: ensure approver is NOT the creator ----------
export function enforceMakerChecker(creatorId: string, approverId: string): boolean {
  return creatorId !== approverId;
}

// ---------- Approval amount limit check ----------
export function checkApprovalLimit(userRole: string, amount: number): { allowed: boolean; reason: string } {
  // Default limits by role (PKR) — can be overridden by DB config
  const LIMITS: Record<string, number> = {
    CEO: Infinity,
    FINANCE_HEAD: 500000,
    ACCOUNTANT: 100000,
    HOD: 50000,
    PROJECT_MANAGER: 25000,
  };

  const limit = LIMITS[userRole] ?? 0;
  if (amount <= limit) return { allowed: true, reason: '' };
  return {
    allowed: false,
    reason: `Amount PKR ${amount.toLocaleString()} exceeds your approval limit of PKR ${limit.toLocaleString()}. Requires ${getNextApproverRole(userRole)} approval.`,
  };
}

function getNextApproverRole(currentRole: string): string {
 const level = APPROVAL_ROLES[currentRole] ?? 0;
 for (const [role, lvl] of Object.entries(APPROVAL_ROLES)) {
    if (lvl > level && lvl !== 100) return role;
  }
  return 'CEO';
}

// ---------- SQL injection check for AI ----------
export function isSqlSafe(sql: string): { safe: boolean; reason: string } {
  const upper = sql.toUpperCase().replace(/'[^']*'/g, ''); // remove string literals
  // Check for dangerous keywords outside SELECT
  if (!upper.trim().startsWith('SELECT') && !upper.trim().startsWith('WITH')) {
    return { safe: false, reason: 'Only SELECT queries are allowed.' };
  }
  for (const kw of DANGEROUS_SQL_KEYWORDS) {
    if (upper.includes(kw)) {
      return { safe: false, reason: `Prohibited keyword detected: ${kw}. Only read-only queries are permitted.` };
    }
  }
  // Check for function calls that could execute writes
  const dangerousFunctions = ['pg_sleep', 'lo_import', 'lo_export', 'pg_read_file', 'pg_write_file', 'pg_ls_dir'];
  for (const fn of dangerousFunctions) {
    if (upper.includes(fn)) {
      return { safe: false, reason: `Prohibited function detected: ${fn}.` };
    }
  }
  return { safe: true, reason: '' };
}
