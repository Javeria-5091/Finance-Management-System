// =============================================================================
// API AUTH MIDDLEWARE — Server-side authentication + permission check for all API routes
// =============================================================================

import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

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
  AUDITOR: 55,           
  HOD: 40,
  PROJECT_MANAGER: 20,
  TECHNICAL_ADMIN: 15,
  EMPLOYEE: 10,
  VIEWER: 0,
  Admin: 100, 
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
  // NOTE: 'profiles' is confirmed to live in the PUBLIC schema — keep unqualified.
  if (role === 'VIEWER') {
    const { data: profile } = await supabase
      .from('profiles')
      .select('role, organization_id')
      .eq('user_id', session.user.id)
      .maybeSingle();
    if (profile?.role) role = profile.role;
    orgId = profile?.organization_id || null;
  }

  return { userId: session.user.id, email: session.user.email ?? null, role, orgId };
}

// ---------- Unified auth for API routes: Cookie session + Bearer token fallback ----------
// Fixes "Unauthorized" for logged-in users whose browser client stores session in localStorage
export async function getAuthSupabase(req?: Request) {
  const cookieStore = await cookies();
  const header = req?.headers.get('authorization');
  const bearer = header?.startsWith('Bearer ') ? header.slice(7) : null;

  const supabase = bearer
    ? createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
        global: { headers: { Authorization: `Bearer ${bearer}` } },
      })
    : createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
        cookies: { getAll: () => cookieStore.getAll(), setAll: () => {} },
      });

  const { data, error } = await supabase.auth.getUser();
  return { supabase, user: data.user ?? null, authError: error };
}

// ---------- Require specific permission ----------
export async function requirePermission(requiredPerm: string): Promise<AuthResult | NextResponse> {
  const auth = await getAuthUser();
  if (auth instanceof NextResponse) return auth; // 401

  // CEO and Admin have all permissions
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
  const LIMITS: Record<string, number> = {
    CEO: Infinity,
    FINANCE_HEAD: 500000,
    ACCOUNTANT: 100000,
    HOD: 100000,
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

// ---------- Blocklist: Schemas that AI must NEVER query directly ----------
const BLOCKED_SCHEMAS = ['core.', 'auth.', 'storage.', 'audit.', 'ai.', 'information_schema.', 'pg_'];
const ALLOWED_SCHEMAS = ['reporting.', 'finance.', 'public.'];

// ---------- SQL injection & Schema check for AI (Spec 9.5) ----------
export function isSqlSafe(sql: string): { safe: boolean; reason: string } {
  const upper = sql.toUpperCase().replace(/'[^']*'/g, '');
  if (!upper.trim().startsWith('SELECT') && !upper.trim().startsWith('WITH')) {
    return { safe: false, reason: 'Only SELECT/WITH queries are allowed.' };
  }
  
  // Block dangerous keywords
  for (const kw of DANGEROUS_SQL_KEYWORDS) {
    if (upper.includes(kw)) return { safe: false, reason: `Prohibited keyword: ${kw}` };
  }

  // Spec 9.5: Block multi-statement and comments
  if ((sql.match(/;/g) || []).length > 1) return { safe: false, reason: 'Multiple statements blocked.' };
  if (/\/\*.*\*\//.test(sql) || /--/.test(sql)) return { safe: false, reason: 'SQL comments blocked.' };

  // Spec 9.5: Schema Allowlist enforcement
  const lowerSql = sql.toLowerCase();
  for (const blocked of BLOCKED_SCHEMAS) {
    const regex = new RegExp(`\\b${blocked.replace('.', '\\.')}`);
    if (regex.test(lowerSql)) {
      return { safe: false, reason: `Access to schema '${blocked}' is prohibited. Use reporting views.` };
    }
  }

  return { safe: true, reason: '' };
}

// ---------- Spec 9.5: Inject Scope Programmatically ----------
export function injectScope(sql: string, orgId: string, userId: string, enforceUserScope: boolean): string {
  const cleanSql = sql.replace(/;\s*$/, '').trim();

  // ✅ FIX: execute_ai_readonly_query does `EXECUTE query_string INTO result`
  // into a `jsonb` variable, so the final query MUST return a single jsonb
  // value (one row, one column) — never a raw multi-column/multi-row SELECT.
  // Without the jsonb_agg wrapper this always failed with
  // "Query execution failed", regardless of whether the underlying
  // view/table existed or had data.
  return `
    SELECT COALESCE(jsonb_agg(t), '[]'::jsonb) FROM (
      WITH llm_query AS (
        ${cleanSql}
      )
      SELECT * FROM llm_query
      WHERE 1=1
      ${enforceUserScope ? `AND user_id = '${userId}'` : ''}
      LIMIT 200
    ) t;
  `;
}

// ---------- AI Daily Limit Check (Spec 9.11) ----------
export async function checkAiDailyLimit(
  supabase: any,
  userId: string,
  orgId: string,
  maxRequests: number = 200,
  maxCost: number = 2.0
): Promise<{ allowed: boolean; reason: string }> {
  try {
    const today = new Date().toISOString().split('T')[0];
    // ✅ FIX: ai_user_cost_tracking lives in the 'ai' schema.
    // .from('ai.ai_user_cost_tracking') is invalid supabase-js syntax — must use
    // .schema('ai').from('ai_user_cost_tracking'). Previously this silently
    // failed every time and fell through to the catch block below (which returns
    // { allowed: true }), so cost/rate limiting was effectively never enforced —
    // a separate but real bug worth knowing about even though it didn't block responses.
    const { data: existing, error } = await supabase
      .schema('ai')
      .from('ai_user_cost_tracking')
      .select('request_count, estimated_cost')
      .eq('user_id', userId)
      .eq('organization_id', orgId)
      .eq('period_date', today)
      .maybeSingle();

    if (error) {
      console.error('checkAiDailyLimit fetch error:', error.message);
    }

    const requests = existing?.request_count || 0;
    const cost = parseFloat(existing?.estimated_cost || '0');

    if (requests >= maxRequests) {
      return { allowed: false, reason: `Daily AI request limit (${maxRequests}) reached.` };
    }
    if (cost >= maxCost) {
      return { allowed: false, reason: 'Daily AI cost limit reached. Contact administrator.' };
    }
    return { allowed: true, reason: '' };
  } catch (err: any) {
    console.error('checkAiDailyLimit unexpected error:', err.message);
    return { allowed: true, reason: '' };
  }
}